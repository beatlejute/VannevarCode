import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
    createProgressBroker,
    PROTOCOL,
    MAX_FRAME_BYTES,
    MAX_BUFFER_BYTES,
} = require('../runtime/progress-broker.js');

const IS_WIN = process.platform === 'win32';
const ROOT = mkdtempSync(join(tmpdir(), 'ccx-progress-security-'));
let seq = 0;
const openSockets = new Set();
const brokers = new Set();

function endpoint() {
    const id = `${process.pid}-${++seq}`;
    return IS_WIN ? `\\\\.\\pipe\\vpr-sec-${id}` : join(ROOT, `vpr-sec-${id}.sock`);
}

function sha256(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function waitFor(pred, timeoutMs, stepMs = 25) {
    return new Promise((res, rej) => {
        const started = Date.now();
        const tick = () => {
            let value;
            try { value = pred(); } catch (e) { return rej(e); }
            if (value) return res(value);
            if (Date.now() - started > timeoutMs) return rej(new Error('waitFor timeout'));
            setTimeout(tick, stepMs);
        };
        tick();
    });
}

function startBroker() {
    const b = createProgressBroker({ endpoint: endpoint() });
    brokers.add(b);
    return b;
}

function closeBroker(b) {
    b.close();
    brokers.delete(b);
}

function track(conn) {
    openSockets.add(conn);
    conn.on('error', () => {});
    return conn;
}

function untrack(conn) {
    openSockets.delete(conn);
}

function connect(broker) {
    return new Promise((res, rej) => {
        const conn = net.createConnection(broker.info().endpoint);
        conn.setEncoding('utf8');
        track(conn);
        conn.once('connect', () => res(conn));
        conn.once('error', (e) => rej(e));
    });
}

async function connectReady(broker, attempts = 40) {
    let last;
    for (let i = 0; i < attempts; i++) {
        try { return await connect(broker); } catch (e) { last = e; await sleep(50); }
    }
    throw last;
}

function sendLine(conn, obj) {
    conn.write(JSON.stringify(obj) + '\n');
}

function recvMessage(conn, timeoutMs = 1500) {
    return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error('recv timeout')), timeoutMs);
        const onData = (chunk) => {
            for (const line of chunk.split('\n')) {
                if (!line.trim()) continue;
                clearTimeout(timer);
                conn.removeListener('data', onData);
                try { res(JSON.parse(line)); } catch (e) { rej(e); }
                return;
            }
        };
        conn.on('data', onData);
    });
}

function expectClose(conn, timeoutMs = 1500) {
    return new Promise((res, rej) => {
        if (conn.destroyed) return res(true);
        const timer = setTimeout(() => rej(new Error('socket was not closed by broker')), timeoutMs);
        conn.once('close', () => { clearTimeout(timer); res(true); });
    });
}

async function hello(broker, cap, protocol = PROTOCOL) {
    const conn = await connectReady(broker);
    sendLine(conn, { type: 'hello', protocol, cap });
    const ack = await recvMessage(conn);
    return { conn, ack };
}

async function helloSession(broker, cap) {
    const { conn, ack } = await hello(broker, cap);
    assert.strictEqual(ack.type, 'helloAck', `expected helloAck, got ${JSON.stringify(ack)}`);
    return { conn, ack };
}

// 1. Cross-session: client-supplied ownerSession is ignored, report lands in the
// capability's own principal; foreign root generation is rejected as stale.
{
    const b = startBroker();
    const capA = b.issueSessionCapability('sessA').capability;
    const capB = b.issueSessionCapability('sessB').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessA', rootId: 'rootA', generation: 'genA' }));
    assert.ok(b.observeRoot({ sessionId: 'sessB', rootId: 'rootB', generation: 'genB' }));

    const { conn: foreignGenConn, ack: foreignGenAck } = await helloSession(b, capA);
    sendLine(foreignGenConn, { session: 'sessA', rootGeneration: 'genB', done: 1, total: 2 });
    const staleAck = await recvMessage(foreignGenConn);
    assert.strictEqual(staleAck.type, 'ack');
    assert.strictEqual(staleAck.accepted, false, 'report with foreign root generation must be rejected');
    assert.strictEqual(staleAck.reason, 'stale_generation');
    foreignGenConn.destroy(); untrack(foreignGenConn);

    const { conn: conn, ack } = await helloSession(b, capA);
    assert.strictEqual(ack.ownerSession, 'sessA', 'helloAck must bind to the token principal, not client fields');
    sendLine(conn, { session: 'sessB', ownerSession: 'sessB', rootGeneration: 'genA', done: 1, total: 2 });
    const okAck = await recvMessage(conn);
    assert.strictEqual(okAck.accepted, true, 'own-principal report must be accepted');
    conn.destroy(); untrack(conn);

    await waitFor(() => b.snapshot('sessA').root && b.snapshot('sessA').root.semantic, 1000);
    assert.strictEqual(b.snapshot('sessA').root.semantic.done, 1, 'report must land in sessA root');
    assert.strictEqual(b.snapshot('sessB').root.semantic, null, 'client-supplied sessB must not receive foreign report');
    assert.strictEqual(b.snapshot('sessB').root.rootId, 'rootB', 'sessB root must stay untouched');
    assert.ok(capB, 'session B capability unaffected');

    closeBroker(b);
}

// 2. Cross-scope: scope X capability writing under scope Y id is rejected as
// scope_mismatch; scope report never mutates the owner session root.
{
    const b = startBroker();
    b.issueSessionCapability('sessX');
    assert.ok(b.observeRoot({ sessionId: 'sessX', rootId: 'rootX', generation: 'genX' }));
    const capX = b.issueScopeCapability('scopeX', 'sessX').capability;
    b.issueScopeCapability('scopeY', 'sessX');

    const { conn, ack } = await hello(b, capX);
    assert.strictEqual(ack.type, 'helloAck');
    assert.strictEqual(ack.scope, 'scopeX', 'scope helloAck must carry the token scope');

    sendLine(conn, { scope: 'scopeY', done: 1, total: 2 });
    const mismatch = await recvMessage(conn);
    assert.strictEqual(mismatch.accepted, false, 'scope X cap must not write under scope Y id');
    assert.strictEqual(mismatch.reason, 'scope_mismatch');

    sendLine(conn, { done: 2, total: 4 });
    const own = await recvMessage(conn);
    assert.strictEqual(own.accepted, true, 'scope X cap writes its own scope');
    conn.destroy(); untrack(conn);

    await waitFor(() => b.snapshot('sessX').semanticByScope.scopeX, 1000);
    assert.strictEqual(b.snapshot('sessX').semanticByScope.scopeX.done, 2, 'semantic lands in own scope');
    assert.strictEqual(b.snapshot('sessX').semanticByScope.scopeY, undefined, 'scopeY untouched by scope X cap');
    assert.strictEqual(b.snapshot('sessX').root.semantic, null, 'scope cap must not mutate session root semantic');

    closeBroker(b);
}

// 3. Unauthorized family: forged, revoked, prior-instance caps and protocol
// mismatch are rejected at hello; broker survives and serves a legit client.
{
    const b = startBroker();
    const legitCap = b.issueSessionCapability('sessL').capability;

    const forged = await hello(b, crypto.randomBytes(32).toString('base64url'));
    assert.strictEqual(forged.ack.type, 'ack');
    assert.strictEqual(forged.ack.accepted, false, 'forged token must be rejected');
    assert.strictEqual(forged.ack.reason, 'unauthorized');
    await expectClose(forged.conn);
    untrack(forged.conn);

    const revokedToken = b.issueSessionCapability('sessR').capability;
    assert.strictEqual(b.revokeCapability(sha256(revokedToken)), true, 'revocation of live capability must succeed');
    const revoked = await hello(b, revokedToken);
    assert.strictEqual(revoked.ack.accepted, false, 'revoked token must be rejected');
    assert.strictEqual(revoked.ack.reason, 'unauthorized');
    await expectClose(revoked.conn);
    untrack(revoked.conn);

    const other = startBroker();
    const staleInstanceCap = b.issueSessionCapability('sessI').capability;
    const priorInstance = await hello(other, staleInstanceCap);
    assert.strictEqual(priorInstance.ack.accepted, false, 'capability of another broker instance must be rejected');
    assert.strictEqual(priorInstance.ack.reason, 'unauthorized');
    await expectClose(priorInstance.conn);
    untrack(priorInstance.conn);

    const proto = await hello(b, legitCap, PROTOCOL + 1);
    assert.strictEqual(proto.ack.accepted, false, 'protocol mismatch must be rejected');
    assert.strictEqual(proto.ack.reason, 'unsupported_protocol');
    await expectClose(proto.conn);
    untrack(proto.conn);

    const { conn: legitConn, ack: legitAck } = await helloSession(b, legitCap);
    assert.strictEqual(legitAck.type, 'helloAck', 'legit client must still be served after abusive hellos');
    legitConn.destroy(); untrack(legitConn);
    assert.strictEqual(b.metrics().circuitOpen, false, 'rejections are not broker crashes');

    closeBroker(b); closeBroker(other);
}

// 4. Flood: more than 2 concurrent connections per capability are cut; report
// burst hits rate_limited; broker stays responsive and refills the budget.
{
    const b = startBroker();
    const cap = b.issueSessionCapability('sessF').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessF', rootId: 'rootF', generation: 'genF' }));

    const all = [];
    let helloAcks = 0;
    for (let i = 0; i < 12; i++) {
        const conn = await connectReady(b);
        all.push(conn);
        sendLine(conn, { type: 'hello', protocol: PROTOCOL, cap });
    }
    for (const conn of all) {
        const result = await Promise.race([
            recvMessage(conn, 1200).then((m) => ({ kind: 'msg', m })).catch(() => null),
            sleep(1300).then(() => null),
        ]);
        if (result && result.m && result.m.type === 'helloAck') helloAcks++;
    }
    assert.strictEqual(helloAcks, 2, `exactly 2 connections per capability may pass hello, got ${helloAcks}`);
    for (const conn of all) { conn.destroy(); untrack(conn); }

    const { conn: reportConn, ack: reportAck } = await helloSession(b, cap);
    const ackLines = [];
    const collector = (chunk) => {
        for (const line of chunk.split('\n')) if (line.trim()) ackLines.push(line);
    };
    reportConn.on('data', collector);
    for (let i = 0; i < 15; i++) {
        sendLine(reportConn, { rootGeneration: 'genF', done: Math.min(i + 1, 5), total: 5 });
    }
    await sleep(1200);
    reportConn.removeListener('data', collector);
    const acks = ackLines.map((line) => JSON.parse(line));
    let accepted = 0;
    let limited = 0;
    assert.strictEqual(acks.length, 15, `every flooded report must get exactly one ack, got ${acks.length}`);
    for (const ack2 of acks) {
        assert.strictEqual(ack2.type, 'ack');
        if (ack2.accepted) accepted++;
        else { assert.strictEqual(ack2.reason, 'rate_limited', `unexpected rejection: ${ack2.reason}`); limited++; }
    }
    assert.ok(accepted >= 1, 'burst within budget must be accepted');
    assert.ok(limited >= 1, 'reports beyond burst budget must be rate limited');
    reportConn.destroy(); untrack(reportConn);

    await sleep(1600);
    const { conn: afterConn } = await helloSession(b, cap);
    sendLine(afterConn, { rootGeneration: 'genF', done: 5, total: 5 });
    const afterAck = await recvMessage(afterConn);
    assert.strictEqual(afterAck.accepted, true, 'budget refill: legit report accepted after flood');
    afterConn.destroy(); untrack(afterConn);
    assert.strictEqual(b.metrics().circuitOpen, false, 'flood must not open crash circuit');

    closeBroker(b);
}

// 5. Bounds: absurd counters are invalid_report; valid bounds still accepted.
{
    const b = startBroker();
    const cap = b.issueSessionCapability('sessBound').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessBound', rootId: 'rootBound', generation: 'genBound' }));
    const { conn, ack } = await helloSession(b, cap);

    sendLine(conn, { rootGeneration: 'genBound', done: 999999, total: 1000000 });
    const absurd = await recvMessage(conn);
    assert.strictEqual(absurd.accepted, false, 'done=999999/total=1000000 must be rejected');
    assert.strictEqual(absurd.reason, 'invalid_report');

    sendLine(conn, { rootGeneration: 'genBound', done: 0, total: 0 });
    assert.strictEqual((await recvMessage(conn)).reason, 'invalid_report', 'total=0 must be rejected');

    sendLine(conn, { rootGeneration: 'genBound', done: 0, total: 51 });
    assert.strictEqual((await recvMessage(conn)).reason, 'invalid_report', 'total=51 must be rejected');

    sendLine(conn, { rootGeneration: 'genBound', done: 5, total: 50 });
    assert.strictEqual((await recvMessage(conn)).accepted, true, 'upper valid bound 50 must be accepted');

    sendLine(conn, { rootGeneration: 'genBound', done: 4, total: 50 });
    assert.strictEqual((await recvMessage(conn)).reason, 'progress_decreased', 'done cannot decrease within a plan version');
    conn.destroy(); untrack(conn);
    closeBroker(b);
}

// 6. Oversize frame and receive buffer overflow close the abusive connection.
{
    const b = startBroker();
    const cap = b.issueSessionCapability('sessBig').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessBig', rootId: 'rootBig', generation: 'genBig' }));

    const { conn: frameConn } = await helloSession(b, cap);
    const bigFrame = JSON.stringify({ rootGeneration: 'genBig', done: 1, total: 2, note: 'X'.repeat(MAX_FRAME_BYTES + 2048) }) + '\n';
    assert.ok(Buffer.byteLength(bigFrame) > MAX_FRAME_BYTES, 'fixture must exceed the frame bound');
    frameConn.write(bigFrame);
    await expectClose(frameConn);
    untrack(frameConn);

    const { conn: bufConn } = await helloSession(b, cap);
    bufConn.write('A'.repeat(MAX_BUFFER_BYTES + 1024));
    await expectClose(bufConn);
    untrack(bufConn);

    const { conn: afterConn } = await helloSession(b, cap);
    sendLine(afterConn, { rootGeneration: 'genBig', done: 1, total: 2 });
    assert.strictEqual((await recvMessage(afterConn)).accepted, true, 'broker serves legit client after oversize abuse');
    afterConn.destroy(); untrack(afterConn);
    closeBroker(b);
}

// 7. Malformed JSON frame closes the connection; broker keeps serving.
{
    const b = startBroker();
    const cap = b.issueSessionCapability('sessBad').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessBad', rootId: 'rootBad', generation: 'genBad' }));
    const { conn } = await helloSession(b, cap);
    conn.write('not-json{]\n');
    await expectClose(conn);
    untrack(conn);

    const { conn: afterConn } = await helloSession(b, cap);
    sendLine(afterConn, { rootGeneration: 'genBad', done: 1, total: 2 });
    assert.strictEqual((await recvMessage(afterConn)).accepted, true, 'broker survives malformed frames');
    afterConn.destroy(); untrack(afterConn);
    closeBroker(b);
}

// 8. XSS payload is stored bounded and inert at the transport layer; service continues.
{
    const b = startBroker();
    const cap = b.issueSessionCapability('sessHtml').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessHtml', rootId: 'rootHtml', generation: 'genHtml' }));
    const { conn } = await helloSession(b, cap);
    const payload = 'a<script>alert(1)</script>'.repeat(20);
    const planPayload = ['<img src=x onerror=alert(2)>'.repeat(10)];
    sendLine(conn, { rootGeneration: 'genHtml', done: 1, total: 2, note: payload, plan: planPayload });
    const ack = await recvMessage(conn);
    assert.strictEqual(ack.accepted, true, 'transport accepts bounded payload instead of crashing');

    await waitFor(() => b.snapshot('sessHtml').root && b.snapshot('sessHtml').root.semantic, 1000);
    const semantic = b.snapshot('sessHtml').root.semantic;
    assert.strictEqual(semantic.note.length, 240, 'note must be bounded to 240 units');
    assert.ok(semantic.note.includes('<script>'), 'payload prefix preserved for UI-side escaping');
    assert.strictEqual(semantic.plan[0].length, 160, 'plan item must be bounded to 160 units');

    sendLine(conn, { rootGeneration: 'genHtml', done: 2, total: 2, note: 'ok' });
    assert.strictEqual((await recvMessage(conn)).accepted, true, 'legitimate report accepted after XSS payload');
    conn.destroy(); untrack(conn);
    closeBroker(b);
}

// 9. Raw capability secrets never appear in snapshot, metrics or change events.
{
    const b = startBroker();
    const events = [];
    b.onChange((event) => events.push(event));
    const capSession = b.issueSessionCapability('sessSecret').capability;
    const capScope = b.issueScopeCapability('scopeSecret', 'sessSecret').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessSecret', rootId: 'rootSecret', generation: 'genSecret' }));

    const { conn } = await helloSession(b, capSession);
    sendLine(conn, { rootGeneration: 'genSecret', done: 1, total: 3, note: 'working' });
    assert.strictEqual((await recvMessage(conn)).accepted, true);
    conn.destroy(); untrack(conn);

    const scopeConn = await connectReady(b);
    sendLine(scopeConn, { type: 'hello', protocol: PROTOCOL, cap: capScope });
    assert.strictEqual((await recvMessage(scopeConn)).type, 'helloAck');
    sendLine(scopeConn, { done: 2, total: 3 });
    assert.strictEqual((await recvMessage(scopeConn)).accepted, true);
    scopeConn.destroy(); untrack(scopeConn);

    await sleep(100);
    const surface = JSON.stringify({
        rootSnapshot: b.snapshot('sessSecret'),
        events,
        metrics: b.metrics(),
    });
    assert.ok(!surface.includes(capSession), 'raw session capability must not leak into snapshot/metrics/events');
    assert.ok(!surface.includes(capScope), 'raw scope capability must not leak into snapshot/metrics/events');
    closeBroker(b);
}

// 10. Continued legitimate service: a fresh client completes a full report cycle
// after all abusive traffic above.
{
    const b = startBroker();
    const cap = b.issueSessionCapability('sessLegit').capability;
    assert.ok(b.observeRoot({ sessionId: 'sessLegit', rootId: 'rootLegit', generation: 'genLegit' }));
    const { conn, ack } = await helloSession(b, cap);
    assert.strictEqual(ack.rootId, 'rootLegit', 'helloAck returns the live root');
    sendLine(conn, { rootGeneration: 'genLegit', done: 3, total: 5, note: 'ok', plan: ['a', 'b'] });
    const report = await recvMessage(conn);
    assert.strictEqual(report.accepted, true, 'legitimate report after abusive suite traffic must be accepted');
    assert.ok(b.observeRoot({ sessionId: 'sessLegit', rootId: 'rootLegit2', generation: 'genLegit2' }));
    const changed = await recvMessage(conn, 2000);
    assert.strictEqual(changed.type, 'rootChanged', 'session connection must receive rootChanged broadcast');
    assert.strictEqual(changed.rootGeneration, 'genLegit2');
    conn.destroy(); untrack(conn);
    closeBroker(b);
}

try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
console.log(`SECURITY_SUITE_OK cases=10 maxFrame=${MAX_FRAME_BYTES} maxBuffer=${MAX_BUFFER_BYTES} protocol=${PROTOCOL} socketsLeft=${openSockets.size} brokersLeft=${brokers.size}`);

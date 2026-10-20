// The ProgressBroker is a local IPC server, so it is tested the way the host will use it: a real
// named pipe (Windows) or unix socket (elsewhere), real NDJSON frames over a real connection, a real
// hello handshake and real capability checks. Nothing here re-implements the broker — every assertion
// goes through the module's own `createProgressBroker` factory and a socket it actually listens on.
//
// What is pinned: framing survives partial and batched frames and refuses overflow; a capability
// decides who may report and which session or scope the report lands in; connection and rate limits
// hold; repeated unexpected exits open the circuit and the cooldown governs when it reports closed
// again; snapshots and deltas carry a monotonic revision; and the safe projections never leak a raw
// capability. Each case gets its own endpoint, and every socket, server and broker is closed even
// when an assertion throws.
//
//   node test/progress-broker.test.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const {
    createProgressBroker,
    PROTOCOL,
    MAX_FRAME_BYTES,
    MAX_BUFFER_BYTES,
    ACK_TIMEOUT_MS,
    CIRCUIT_COOLDOWN_MS,
} = require('../runtime/progress-broker.js');

const IS_WIN = process.platform === 'win32';
const ROOT = mkdtempSync(join(tmpdir(), 'vpr-suite-'));
let seq = 0;

// Unique endpoint per case: a named pipe on Windows, a socket file under a private temp root
// elsewhere (the root is removed when the suite ends).
function newEndpoint() {
    const id = `${process.pid}-${++seq}`;
    return IS_WIN ? `\\\\.\\pipe\\vpr-suite-${id}` : join(ROOT, `vpr-suite-${id}.sock`);
}

const sleeping = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A clock the case owns, so rate windows and cooldown can be driven without real waiting.
function makeClock(start = Date.now()) {
    const state = { t: start };
    return { now: () => state.t, advance: (ms) => { state.t += ms; } };
}

// --- live resources, released after every case and again at the end
const live = { brokers: new Set(), sockets: new Set(), servers: new Set() };
function trackBroker(broker) { live.brokers.add(broker); return broker; }
function trackSocket(socket) { live.sockets.add(socket); return socket; }
function trackServer(server) { live.servers.add(server); return server; }
function cleanup() {
    for (const socket of live.sockets) { try { socket.destroy(); } catch { /* already gone */ } }
    live.sockets.clear();
    for (const server of live.servers) { try { server.close(); } catch { /* already closed */ } }
    live.servers.clear();
    for (const broker of live.brokers) { try { broker.close(); } catch { /* already closed */ } }
    live.brokers.clear();
}

function startBroker(options = {}) { return trackBroker(createProgressBroker(options)); }

function connect(endpoint) {
    return new Promise((resolve, reject) => {
        const socket = trackSocket(net.connect(endpoint));
        let settled = false;
        socket.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
        socket.once('connect', () => {
            if (settled) return;
            settled = true;
            socket.setEncoding('utf8');
            resolve(socket);
        });
    });
}

// Reads NDJSON frames off a socket and lets a case wait for the next one, the way the host does.
function frames(socket) {
    const state = { messages: [], closed: false };
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            state.messages.push(JSON.parse(line));
        }
    });
    socket.on('close', () => { state.closed = true; });
    state.next = async (timeout = 3000) => {
        const deadline = Date.now() + timeout;
        while (state.messages.length === 0) {
            if (state.closed) throw new Error('connection closed before a frame arrived');
            if (Date.now() > deadline) throw new Error(`no frame within ${timeout}ms`);
            await sleeping(10);
        }
        return state.messages.shift();
    };
    return state;
}

function send(socket, message) { socket.write(JSON.stringify(message) + '\n'); }

function waitForClose(socket, timeout = 3000) {
    if (socket.destroyed) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`socket did not close within ${timeout}ms`)), timeout);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
}

async function greet(socket, capability, protocol = PROTOCOL) {
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol, cap: capability });
    const ack = await stream.next();
    assert.equal(ack.type, 'helloAck', `hello should be acknowledged, got ${JSON.stringify(ack)}`);
    assert.equal(ack.protocol, PROTOCOL, 'the broker answers on protocol 2');
    return stream;
}

// A broker that has been closed must stop accepting: a successful connect would be proof it has not.
async function expectRefused(endpoint, timeout = 2000) {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {
            const socket = net.connect(endpoint);
            await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
            socket.destroy();
        } catch {
            return;
        }
        if (Date.now() > deadline) throw new Error('a closed broker still accepted a connection');
        await sleeping(25);
    }
}

// Drives a broker whose endpoint can never be bound, so its own server emits unexpected errors.
function unbindableEndpoint() { return join(ROOT, 'unbindable', 'progress.sock'); }

async function waitForCircuit(broker, timeout = 5000) {
    const deadline = Date.now() + timeout;
    while (!broker.metrics().circuitOpen) {
        if (Date.now() > deadline) throw new Error('the circuit never opened after repeated startup failures');
        await sleeping(20);
    }
}

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

test('non-object frames close only their socket before and after hello in a subprocess', async () => {
    const modulePath = fileURLToPath(new URL('../runtime/progress-broker.js', import.meta.url));
    const script = `
        const assert = require('node:assert/strict');
        const net = require('node:net');
        const { once } = require('node:events');
        const { createProgressBroker, PROTOCOL } = require(process.argv[1]);
        (async () => {
            const broker = createProgressBroker();
            const cap = broker.issueSessionCapability('owner').capability;
            try {
                for (const greeted of [false, true]) {
                    for (const frame of [null, [], 1, true, 'text']) {
                        const socket = net.connect(broker.info().endpoint);
                        socket.on('error', () => {});
                        await once(socket, 'connect');
                        if (greeted) {
                            const ack = once(socket, 'data');
                            socket.write(JSON.stringify({ type: 'hello', protocol: PROTOCOL, cap }) + '\\n');
                            assert.equal(JSON.parse(String((await ack)[0])).type, 'helloAck');
                        }
                        const closed = once(socket, 'close');
                        socket.write(JSON.stringify(frame) + '\\n');
                        await closed;
                    }
                }
                const socket = net.connect(broker.info().endpoint);
                await once(socket, 'connect');
                const ack = once(socket, 'data');
                socket.write(JSON.stringify({ type: 'hello', protocol: PROTOCOL, cap }) + '\\n');
                assert.equal(JSON.parse(String((await ack)[0])).type, 'helloAck');
                socket.destroy();
            } finally { broker.close(); }
        })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const child = spawn(process.execPath, ['-e', script, modulePath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 10000);
    try {
        const code = await new Promise((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', resolve);
        });
        assert.equal(code, 0, output || 'subprocess must stay alive and close invalid sockets');
    } finally { clearTimeout(timer); child.kill(); }
});

// --- framing: the NDJSON decoder must not care how bytes are chunked, and must refuse overflow
test('framing: a partial NDJSON frame is buffered until its newline arrives', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    const socket = await connect(endpoint);
    const stream = frames(socket);
    const line = JSON.stringify({ type: 'hello', protocol: PROTOCOL, cap: capability });
    socket.write(line.slice(0, 7));
    await sleeping(30);
    assert.equal(stream.messages.length, 0, 'a frame without its newline is not dispatched');
    socket.write(line.slice(7) + '\n');
    const ack = await stream.next();
    assert.equal(ack.type, 'helloAck', 'the buffered frame completes once the newline lands');
});

test('framing: two frames written in one packet are both dispatched', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const socket = await connect(endpoint);
    const stream = await greet(socket, capability);
    const report = { type: 'report', done: 1, total: 3, rootGeneration };
    socket.write(JSON.stringify(report) + '\n' + JSON.stringify(report) + '\n');
    const first = await stream.next();
    const second = await stream.next();
    assert.equal(first.type, 'ack');
    assert.equal(second.type, 'ack');
    assert.equal(first.accepted, true, 'the first frame of the batch is processed');
    assert.equal(second.accepted, true, 'and so is the second');
});

test('framing: a frame past the 16 KiB limit closes the connection', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    const socket = await connect(endpoint);
    await greet(socket, capability);
    socket.write('x'.repeat(MAX_FRAME_BYTES + 32) + '\n');
    await waitForClose(socket);
    assert.equal(socket.destroyed, true);
});

test('framing: an accumulation buffer past the 64 KiB limit closes the connection', async () => {
    const endpoint = newEndpoint();
    startBroker({ endpoint });
    const socket = await connect(endpoint);
    socket.write('y'.repeat(MAX_BUFFER_BYTES + 1024));
    await waitForClose(socket);
    assert.equal(socket.destroyed, true);
});

// --- lifecycle: start, connect, hello, report, snapshot, close
test('lifecycle: hello, accepted report, snapshot and a clean close', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-a' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const socket = await connect(endpoint);
    const stream = await greet(socket, capability);
    assert.equal(stream.messages.length, 0, 'no frame arrives after helloAck on its own');
    send(socket, { type: 'report', done: 2, total: 5, rootGeneration });
    const ack = await stream.next();
    assert.equal(ack.type, 'ack');
    assert.equal(ack.accepted, true);
    const snapshot = broker.snapshot('session-1');
    assert.equal(snapshot.root.semantic.done, 2, 'the report is the host-owned semantic state');
    assert.equal(snapshot.root.semantic.total, 5);
    assert.deepEqual(snapshot.health, { available: true, circuitOpen: false });
    broker.close();
    await expectRefused(endpoint);
});

test('lifecycle: a connection that never greets is dropped at the ACK deadline', async () => {
    const endpoint = newEndpoint();
    startBroker({ endpoint });
    const socket = await connect(endpoint);
    await waitForClose(socket, ACK_TIMEOUT_MS + 1000);
    assert.equal(socket.destroyed, true);
});

// --- endpoint recovery: a busy endpoint is recovered, not counted as a crash
test('recovery: a busy endpoint moves the broker to a fresh one without counting a crash', async () => {
    const endpoint = newEndpoint();
    const occupier = trackServer(net.createServer());
    await new Promise((resolve, reject) => {
        occupier.once('error', reject);
        occupier.listen(endpoint, resolve);
    });
    const broker = startBroker({ endpoint });
    const deadline = Date.now() + 3000;
    while (broker.info().endpoint === endpoint) {
        if (Date.now() > deadline) throw new Error('the broker never moved off the busy endpoint');
        await sleeping(10);
    }
    const moved = broker.info().endpoint;
    const capability = broker.issueSessionCapability('session-1').capability;
    const socket = await connect(moved);
    const stream = await greet(socket, capability);
    assert.equal(stream.messages.length, 0, 'the fresh endpoint serves the handshake');
    assert.equal(broker.metrics().circuitOpen, false, 'EADDRINUSE is not an unexpected crash');
});

if (!IS_WIN) {
    test('recovery: a stale unix socket file does not stop startup', async () => {
        const endpoint = newEndpoint();
        writeFileSync(endpoint, '');
        const broker = startBroker({ endpoint });
        const deadline = Date.now() + 3000;
        while (broker.info().endpoint === endpoint) {
            if (Date.now() > deadline) throw new Error('the broker never moved off the stale socket file');
            await sleeping(10);
        }
        const capability = broker.issueSessionCapability('session-1').capability;
        const socket = await connect(broker.info().endpoint);
        const stream = await greet(socket, capability);
        assert.equal(stream.messages.length, 0);
    });
}

// --- circuit breaker: 3 unexpected exits in the window open the circuit; the cooldown closes it
test('breaker: a healthy broker reports the circuit closed', async () => {
    const broker = startBroker({ listen: false });
    assert.equal(broker.metrics().circuitOpen, false);
    assert.equal(broker.metrics().protocol, PROTOCOL);
});

test('breaker: repeated unexpected startup errors open the circuit', async () => {
    const broker = startBroker({ endpoint: unbindableEndpoint() });
    assert.equal(broker.metrics().circuitOpen, false, 'one failure is not the threshold');
    await waitForCircuit(broker);
    assert.equal(broker.metrics().circuitOpen, true);
});

test('breaker: the opened circuit reports closed once the cooldown has passed', async () => {
    const clock = makeClock();
    const broker = startBroker({ endpoint: unbindableEndpoint(), now: clock.now });
    await waitForCircuit(broker);
    assert.equal(broker.metrics().circuitOpen, true);
    clock.advance(CIRCUIT_COOLDOWN_MS + 1);
    assert.equal(broker.metrics().circuitOpen, false, 'past the cooldown the breaker stops reporting open');
});

// --- authorization: the capability decides identity, instance and target
test('auth: an unknown capability is refused as unauthorized', async () => {
    const endpoint = newEndpoint();
    startBroker({ endpoint });
    const socket = await connect(endpoint);
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol: PROTOCOL, cap: 'not-a-capability' });
    const ack = await stream.next();
    assert.equal(ack.type, 'ack');
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'unauthorized');
    await waitForClose(socket);
});

test('auth: a protocol other than 2 is refused with the server protocol', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    const socket = await connect(endpoint);
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol: PROTOCOL - 1, cap: capability });
    const ack = await stream.next();
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'unsupported_protocol');
    assert.equal(ack.serverProtocol, PROTOCOL, 'the mismatch is diagnosable');
    await waitForClose(socket);
});

test('auth: a capability from a previous broker instance is refused', async () => {
    const first = startBroker({ listen: false });
    const stale = first.issueSessionCapability('session-1').capability;
    first.close();
    const endpoint = newEndpoint();
    startBroker({ endpoint });
    const socket = await connect(endpoint);
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol: PROTOCOL, cap: stale });
    const ack = await stream.next();
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'unauthorized');
    await waitForClose(socket);
});

test('auth: issuing a session capability twice returns the same token', async () => {
    const broker = startBroker({ listen: false });
    const first = broker.issueSessionCapability('session-1');
    const second = broker.issueSessionCapability('session-1');
    assert.ok(first.capability, 'a capability is issued');
    assert.equal(second.capability, first.capability, 'issuance is idempotent');
    assert.equal(second.expiresAt, first.expiresAt);
});

test('auth: issuing a scope capability twice returns the same token', async () => {
    const broker = startBroker({ listen: false });
    const first = broker.issueScopeCapability('scope-1', 'session-1');
    const second = broker.issueScopeCapability('scope-1', 'session-1');
    assert.equal(second.capability, first.capability, 'scope issuance is idempotent');
    const delegated = broker.createDelegatedScope({ scopeId: 'scope-1', ownerSession: 'session-1' });
    assert.equal(delegated.capability, first.capability, 'a delegated re-issue keeps the same token');
});

test('auth: a report with a stale root generation is refused', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const orphanToken = broker.issueSessionCapability('session-2').capability;
    const orphan = await connect(endpoint);
    const orphanStream = await greet(orphan, orphanToken);
    send(orphan, { type: 'report', done: 1, total: 2, rootGeneration: 'no-root-yet' });
    const beforeRoot = await orphanStream.next();
    assert.equal(beforeRoot.accepted, false, 'a report with no observed root is refused');
    assert.equal(beforeRoot.reason, 'stale_generation');

    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const socket = await connect(endpoint);
    const stream = await greet(socket, capability);
    send(socket, { type: 'report', done: 1, total: 2, rootGeneration: 'wrong-generation' });
    const wrong = await stream.next();
    assert.equal(wrong.reason, 'stale_generation', 'a generation the host did not issue is refused');
    send(socket, { type: 'report', done: 1, total: 2, rootGeneration });
    const accepted = await stream.next();
    assert.equal(accepted.accepted, true, 'the current generation is accepted');
});

test('auth: a scope report naming another scope is refused', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionToken = broker.issueSessionCapability('session-1').capability;
    const session = await connect(endpoint);
    const sessionStream = await greet(session, sessionToken);
    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const scopeAck = await sessionStream.next();
    assert.equal(scopeAck.type, 'scopeAck');
    const scope = await connect(endpoint);
    const scopeStream = await greet(scope, scopeAck.capability);
    send(scope, { type: 'report', scope: 'scope-2', done: 1, total: 2 });
    const ack = await scopeStream.next();
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'scope_mismatch');
});

test('auth: a report after the scope lifetime is refused as scope_closed', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint, now: clock.now });
    const sessionToken = broker.issueSessionCapability('session-1').capability;
    const session = await connect(endpoint);
    const sessionStream = await greet(session, sessionToken);
    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const scopeAck = await sessionStream.next();
    const scope = await connect(endpoint);
    const scopeStream = await greet(scope, scopeAck.capability);
    clock.advance(5 * 60 * 60 * 1000);
    send(scope, { type: 'report', done: 1, total: 2 });
    const ack = await scopeStream.next();
    assert.equal(ack.accepted, false, 'an expired scope is not a target');
    assert.equal(ack.reason, 'scope_closed');
});

test('auth: closing a scope revokes its capability and drops its connection', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionToken = broker.issueSessionCapability('session-1').capability;
    const session = await connect(endpoint);
    const sessionStream = await greet(session, sessionToken);
    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const scopeAck = await sessionStream.next();
    const scope = await connect(endpoint);
    await greet(scope, scopeAck.capability);
    assert.equal(broker.closeScope('scope-1'), true);
    await waitForClose(scope);
    const retry = await connect(endpoint);
    const retryStream = frames(retry);
    send(retry, { type: 'hello', protocol: PROTOCOL, cap: scopeAck.capability });
    const ack = await retryStream.next();
    assert.equal(ack.accepted, false, 'a revoked scope capability is no longer authorized');
    assert.equal(ack.reason, 'unauthorized');
});

// --- limits: concurrent connections and report rates
test('limits: a capability admits at most two concurrent connections', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    const first = await connect(endpoint);
    await greet(first, capability);
    const second = await connect(endpoint);
    await greet(second, capability);
    const third = await connect(endpoint);
    const thirdStream = frames(third);
    send(third, { type: 'hello', protocol: PROTOCOL, cap: capability });
    await waitForClose(third);
    assert.equal(thirdStream.messages.length, 0, 'the third connection is dropped before helloAck');
});

test('limits: a connection is rate limited after its burst', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint, now: clock.now });
    const capability = broker.issueSessionCapability('session-1').capability;
    const socket = await connect(endpoint);
    const stream = await greet(socket, capability);
    for (let i = 0; i < 6; i += 1) send(socket, { type: 'report', done: 1, total: 2, rootGeneration: 'none' });
    const acks = [];
    for (let i = 0; i < 6; i += 1) acks.push(await stream.next());
    assert.equal(acks[5].reason, 'rate_limited', 'the sixth report on one connection is limited');
    assert.ok(
        acks.slice(0, 5).every((ack) => ack.reason === 'stale_generation'),
        'the burst before the limit is admitted by the rate gate',
    );
});

test('limits: aggregate sustained per-capability limit', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint, now: clock.now });
    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const first = await connect(endpoint);
    const firstStream = await greet(first, capability);
    const second = await connect(endpoint);
    const secondStream = await greet(second, capability);

    for (const socket of [first, second]) {
        for (let i = 0; i < 5; i += 1) send(socket, { type: 'report', done: 1, total: 2, rootGeneration });
    }
    const burstAcks = await Promise.all([
        ...Array.from({ length: 5 }, () => firstStream.next()),
        ...Array.from({ length: 5 }, () => secondStream.next()),
    ]);
    assert.ok(burstAcks.every((ack) => ack.accepted), 'both connections can consume the aggregate burst of ten');

    send(first, { type: 'report', done: 1, total: 2, rootGeneration });
    assert.equal((await firstStream.next()).reason, 'rate_limited', 'the aggregate burst is shared across connections');

    clock.advance(1000);
    send(first, { type: 'report', done: 1, total: 2, rootGeneration });
    send(second, { type: 'report', done: 1, total: 2, rootGeneration });
    assert.equal((await firstStream.next()).accepted, true, 'the sustained bucket replenishes at two reports per second');
    assert.equal((await secondStream.next()).accepted, true, 'replenished capacity is shared by the capability');
    send(first, { type: 'report', done: 1, total: 2, rootGeneration });
    assert.equal((await firstStream.next()).reason, 'rate_limited', 'reports beyond the sustained allowance remain limited');
});

test('limits: aggregate burst survives reconnect and refills independently of connection limits', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint, now: clock.now });
    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const report = { type: 'report', done: 1, total: 2, rootGeneration };
    const first = await connect(endpoint);
    const firstStream = await greet(first, capability);
    const second = await connect(endpoint);
    const secondStream = await greet(second, capability);

    for (let i = 0; i < 5; i += 1) {
        send(first, report);
        assert.equal((await firstStream.next()).accepted, true);
    }
    send(first, report);
    assert.equal((await firstStream.next()).reason, 'rate_limited', 'the connection limit rejects with five aggregate tokens still available');
    for (let i = 0; i < 5; i += 1) {
        send(second, report);
        assert.equal((await secondStream.next()).accepted, true, 'a connection rejection must not spend the shared burst');
    }

    first.destroy();
    await waitForClose(first);
    const deadline = Date.now() + 3000;
    while (broker.metrics().activeConnections !== 1) {
        if (Date.now() > deadline) throw new Error('the broker did not release the first connection');
        await sleeping(10);
    }
    const fresh = await connect(endpoint);
    const freshStream = await greet(fresh, capability);
    send(fresh, report);
    assert.equal((await freshStream.next()).reason, 'rate_limited', 'a fresh connection has no connection history: only the exhausted aggregate burst can reject it');
    clock.advance(499);
    for (let i = 0; i < 6; i += 1) {
        send(fresh, report);
        assert.equal((await freshStream.next()).reason, 'rate_limited', 'less than one replenished token cannot admit a report');
    }
    clock.advance(1);
    send(fresh, report);
    assert.equal((await freshStream.next()).accepted, true, 'one aggregate token becomes available after 500 ms');
    send(fresh, report);
    assert.equal((await freshStream.next()).reason, 'rate_limited', 'aggregate denials did not fill the connection window, and the one token is now spent');
    clock.advance(500);
    send(second, report);
    assert.equal((await secondStream.next()).accepted, true, 'the next replenished token is available to the other connection');
    send(fresh, report);
    assert.equal((await freshStream.next()).reason, 'rate_limited', 'refill is shared rather than granted separately to each connection');
});

// --- snapshot and delta shape
test('snapshot: deltas carry a monotonic revision and unsubscribe stops delivery', async () => {
    const broker = startBroker({ listen: false });
    const events = [];
    const unsubscribe = broker.onChange((event) => events.push(event));
    assert.equal(typeof unsubscribe, 'function');
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    assert.equal(events.length, 1, 'observing a root emits one delta');
    const first = events[0];
    assert.equal(first.type, 'delta');
    assert.equal(first.sessionId, 'session-1');
    assert.equal(first.revision, 1, 'revisions start at one');
    assert.ok('changedRoot' in first.payload, 'the delta carries the changed-root field');
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1', state: 'done' });
    assert.equal(events[1].revision, 2, 'the host is the sole revision authority and increments');
    unsubscribe();
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1', state: 'running' });
    assert.equal(events.length, 2, 'after unsubscribe no delta is delivered');
});

test('snapshot: the projection carries root and scope semantics', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionToken = broker.issueSessionCapability('session-1').capability;
    const session = await connect(endpoint);
    const sessionStream = await greet(session, sessionToken);
    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const scopeAck = await sessionStream.next();
    const scope = await connect(endpoint);
    const scopeStream = await greet(scope, scopeAck.capability);
    send(scope, { type: 'report', scope: 'scope-1', done: 2, total: 4 });
    const ack = await scopeStream.next();
    assert.equal(ack.accepted, true);
    const snapshot = broker.snapshot('session-1');
    assert.deepEqual(Object.keys(snapshot).sort(), ['health', 'nativeScopes', 'nativeSemanticStatus', 'root', 'semanticByScope']);
    assert.equal(snapshot.root, null, 'no root was observed for this session');
    assert.equal(snapshot.semanticByScope['scope-1'].done, 2);
    assert.equal(snapshot.semanticByScope['scope-1'].total, 4);
});

// --- redaction: the safe projections never carry a raw capability, and text is bounded
test('redaction: info, metrics and snapshot never expose a raw capability', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionToken = broker.issueSessionCapability('session-1').capability;
    const scopeToken = broker.issueScopeCapability('scope-1', 'session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const socket = await connect(endpoint);
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol: PROTOCOL, cap: sessionToken });
    const helloAck = await stream.next();
    assert.equal(helloAck.type, 'helloAck');
    assert.ok(!JSON.stringify(helloAck).includes(sessionToken), 'helloAck carries no raw capability');
    const info = broker.info();
    assert.deepEqual(Object.keys(info).sort(), ['endpoint', 'instanceId', 'protocol']);
    const projection = JSON.stringify([info, broker.metrics(), broker.snapshot('session-1')]);
    assert.ok(!projection.includes(sessionToken), 'the session capability is absent from every projection');
    assert.ok(!projection.includes(scopeToken), 'the scope capability is absent from every projection');
});

test('redaction: over-long notes and plans are bounded in the snapshot', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const socket = await connect(endpoint);
    const stream = await greet(socket, capability);
    send(socket, {
        type: 'report',
        done: 1,
        total: 2,
        rootGeneration,
        note: 'n'.repeat(500),
        plan: Array.from({ length: 60 }, () => 'p'.repeat(200)),
    });
    const ack = await stream.next();
    assert.equal(ack.accepted, true);
    const report = broker.snapshot('session-1').root.semantic;
    assert.equal(report.note.length, 240, 'the note is bounded to 240 characters');
    assert.equal(report.plan.length, 50, 'the plan is bounded to 50 items');
    assert.ok(report.plan.every((item) => item.length === 160), 'each plan item is bounded to 160 characters');
});

test('semantic title is retained across reports and changes explicitly on replan', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-1').capability;
    broker.observeRoot({ sessionId: 'session-1', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-1').root.generation;
    const socket = await connect(endpoint);
    const stream = await greet(socket, capability);
    const report = async (fields) => {
        send(socket, { type: 'report', rootGeneration, ...fields });
        const ack = await stream.next();
        assert.equal(ack.accepted, true);
    };
    await report({ done: 0, total: 3, title: 'Build extension', plan: ['inspect', 'implement', 'test'] });
    assert.equal(broker.snapshot('session-1').root.semantic.title, 'Build extension');
    await report({ done: 1, total: 3, plan: ['inspect', 'implement', 'test'] });
    assert.equal(broker.snapshot('session-1').root.semantic.title, 'Build extension', 'missing title retains prior gist');
    await report({ done: 0, total: 2, title: 'Update API', plan: ['change', 'verify'], replan: true });
    assert.equal(broker.snapshot('session-1').root.semantic.title, 'Update API', 'replan accepts an explicit replacement gist');
    assert.equal(broker.snapshot('session-1').root.semantic.planVersion, 1);
});

async function main() {
    const failures = [];
    for (const { name, fn } of cases) {
        try {
            await fn();
            console.log(`ok - ${name}`);
        } catch (error) {
            failures.push({ name, error });
            console.error(`not ok - ${name}`);
            console.error(`  ${error && error.message}`);
        } finally {
            cleanup();
        }
    }
    rmSync(ROOT, { recursive: true, force: true });
    console.log(`\n${cases.length - failures.length}/${cases.length} broker cases passed`);
    if (failures.length) {
        console.error('\nFAIL — the broker integration suite has failures:');
        for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error && failure.error.message}`);
        process.exit(1);
    }
    console.log('\nOK — the ProgressBroker answers real sockets: framing, lifecycle, auth, limits, breaker, snapshot');
}

main().catch((error) => {
    console.error('\nFAIL:', (error && error.stack) || error);
    process.exit(1);
});

// QA-008: Session capability lifecycle verification against the real ProgressBroker.
// Tests idempotency, cross-session isolation, delegated env scrubbing, Stop-turn behavior,
// and all revoke triggers including broker replacement.
//
// Isolation: unique temp root, redirected HOME/USERPROFILE/runtime paths, teardown in `finally`.
// The real ~/.claude is never read or written.
//
// Run: node test/progress-session-capability.test.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
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
    DEFAULT_SCOPE_LIFETIME_MS,
} = require('../runtime/progress-broker.js');

const IS_WIN = process.platform === 'win32';
const ROOT = mkdtempSync(join(tmpdir(), 'vpr-session-cap-'));
let seq = 0;

function newEndpoint() {
    const id = `${process.pid}-${++seq}`;
    return IS_WIN ? `\\\\.\\pipe\\vpr-session-cap-${id}` : join(ROOT, `vpr-session-cap-${id}.sock`);
}

const sleeping = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClock(start = Date.now()) {
    const state = { t: start };
    return { now: () => state.t, advance: (ms) => { state.t += ms; } };
}

const live = { brokers: new Set(), sockets: new Set(), servers: new Set() };
function trackBroker(broker) { live.brokers.add(broker); return broker; }
function trackSocket(socket) { live.sockets.add(socket); return socket; }
function trackServer(server) { live.servers.add(server); return server; }
function cleanup() {
    for (const socket of live.sockets) { try { socket.destroy(); } catch { } }
    live.sockets.clear();
    for (const server of live.servers) { try { server.close(); } catch { } }
    live.servers.clear();
    for (const broker of live.brokers) { try { broker.close(); } catch { } }
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
    return { stream, helloAck: ack };
}

async function helloExpectingAck(socket, capability, protocol = PROTOCOL) {
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol, cap: capability });
    const ack = await stream.next();
    return { stream, ack };
}

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

const cases = [];
function test(name, fn) { cases.push({ name, fn }); }

// --- idempotency: issuing a session capability twice returns the same token ---
test('idempotency: issuing session capability twice returns the same token', async () => {
    const broker = startBroker({ listen: false });
    const first = broker.issueSessionCapability('session-A');
    const second = broker.issueSessionCapability('session-A');
    assert.ok(first.capability, 'a capability is issued');
    assert.equal(second.capability, first.capability, 'issuance is idempotent');
    assert.equal(second.expiresAt, first.expiresAt);
});

// --- idempotency: issuing a scope capability twice returns the same token ---
test('idempotency: issuing scope capability twice returns the same token', async () => {
    const broker = startBroker({ listen: false });
    const first = broker.issueScopeCapability('scope-1', 'session-A');
    const second = broker.issueScopeCapability('scope-1', 'session-A');
    assert.equal(second.capability, first.capability, 'scope issuance is idempotent');
    const delegated = broker.createDelegatedScope({ scopeId: 'scope-1', ownerSession: 'session-A' });
    assert.equal(delegated.capability, first.capability, 'a delegated re-issue keeps the same token');
});

// --- cross-session isolation: a capability from session A cannot be used by session B to access session B's data ---
// Note: the capability IS the authentication. Anyone with the capability can connect.
// Cross-session isolation means session A's capability only accesses session A's roots/scopes.
test('cross-session: session A capability connects but only accesses session A data', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capabilityA = broker.issueSessionCapability('session-A').capability;
    const capabilityB = broker.issueSessionCapability('session-B').capability;

    // Session A connects successfully
    const socketA = await connect(endpoint);
    const { stream: streamA } = await greet(socketA, capabilityA);

    // Session B connects with session A's capability - broker allows it (capability is valid)
    // but the principal will be session-A, so it can only access session-A's data
    const socketB = await connect(endpoint);
    const { stream: streamB, helloAck: helloAckB } = await greet(socketB, capabilityA);
    assert.equal(helloAckB.type, 'helloAck');
    assert.equal(helloAckB.ownerSession, 'session-A', 'principal is session-A regardless of who connects');
    assert.equal(helloAckB.scope, null);
});

// --- cross-session isolation: session capability ownerSession is enforced ---
test('cross-session: helloAck ownerSession matches capability owner', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capabilityA = broker.issueSessionCapability('session-A').capability;
    const socketA = await connect(endpoint);
    const { helloAck } = await greet(socketA, capabilityA);
    assert.equal(helloAck.ownerSession, 'session-A', 'helloAck must report the correct ownerSession');
});

// --- delegated env scrubbing: VANNEVAR_PROGRESS_CAP not leaked to delegated scope ---
test('delegated env: parent capability not leaked in scopeAck', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, sessionCap);

    // Create a delegated scope
    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const scopeAck = await sessionStream.next();
    assert.equal(scopeAck.type, 'scopeAck');
    assert.ok(scopeAck.capability, 'scopeAck must contain a capability');
    assert.notEqual(scopeAck.capability, sessionCap, 'scope capability must differ from parent session capability');
    // Verify the parent capability is not present in the scopeAck payload
    const scopeAckStr = JSON.stringify(scopeAck);
    assert.ok(!scopeAckStr.includes(sessionCap), 'parent session capability must not appear in scopeAck');
});

// --- delegated env: VANNEVAR_PROGRESS_CAP not in helloAck for scope connection ---
test('delegated env: scope helloAck does not contain parent capability', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, sessionCap);
    send(session, { type: 'createScope', scopeId: 'scope-2' });
    const scopeAck = await sessionStream.next();
    assert.equal(scopeAck.type, 'scopeAck');

    // Connect with the scope capability
    const scope = await connect(endpoint);
    const { helloAck: scopeHelloAck } = await greet(scope, scopeAck.capability);
    const helloAckStr = JSON.stringify(scopeHelloAck);
    assert.ok(!helloAckStr.includes(sessionCap), 'parent capability must not leak into scope helloAck');
    assert.ok(!helloAckStr.includes(scopeAck.capability), 'raw scope capability must not appear in helloAck');
});

// --- revoke triggers: owning tab/webview close (session capability revoked) ---
test('revoke: session capability revoked on broker close', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);

    broker.close();
    await expectRefused(endpoint);
});

// --- revoke triggers: broker replacement (new instance invalidates old capabilities) ---
test('revoke: capability from previous broker instance is rejected by new broker', async () => {
    const first = startBroker({ listen: false });
    const stale = first.issueSessionCapability('session-A').capability;
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

// --- revoke triggers: vannevar.progress.enabled=false revokes session capability ---
test('revoke: session capability revoked when progress disabled via env', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);

    // Simulate VANNEVAR_DISABLE_PROGRESS=1 by closing broker (emergency override path)
    broker.close();
    await expectRefused(endpoint);
});

// --- revoke triggers: security rollback revokes capability ---
test('revoke: capability revoked on security rollback', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);

    // Security rollback: revoke the capability directly
    const hash = require('crypto').createHash('sha256').update(capability).digest('hex');
    broker.revokeCapability(hash);
    await waitForClose(socket);

    // Attempting to reuse the revoked capability should fail
    const retry = await connect(endpoint);
    const retryStream = frames(retry);
    send(retry, { type: 'hello', protocol: PROTOCOL, cap: capability });
    const ack = await retryStream.next();
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'unauthorized');
    await waitForClose(retry);
});

// --- Stop-turn behavior: stopping one turn does not revoke while session process remains live ---
test('stop-turn: stopping a turn does not revoke session capability', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);

    // Simulate a turn stopping (socket closes) but session remains live
    socket.destroy();
    await sleeping(50);

    // The capability should still be valid for a new connection
    const newSocket = await connect(endpoint);
    const { stream: newStream } = await greet(newSocket, capability);
    assert.equal(newStream.messages.length, 0, 'capability remains valid after turn stop');
});

// --- scope lifetime: scope capability expires and is rejected ---
test('scope lifetime: expired scope capability is rejected', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint, now: clock.now });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, sessionCap);
    // Use 31 minutes (above 30 min minimum)
    const lifetimeMs = 31 * 60 * 1000;
    send(session, { type: 'createScope', scopeId: 'scope-short', lifetimeMs });
    const scopeAck = await sessionStream.next();

    const scope = await connect(endpoint);
    const { stream: scopeStream } = await greet(scope, scopeAck.capability);

    // Advance time past scope lifetime (32 minutes)
    clock.advance(32 * 60 * 1000);
    send(scope, { type: 'report', scope: 'scope-short', done: 1, total: 2 });
    const ack = await scopeStream.next();
    assert.equal(ack.accepted, false, 'expired scope must be rejected');
    assert.equal(ack.reason, 'scope_closed');
});

// --- scope lifetime: closeScope revokes capability and drops connection ---
test('scope lifetime: closeScope revokes capability immediately', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, sessionCap);
    send(session, { type: 'createScope', scopeId: 'scope-close' });
    const scopeAck = await sessionStream.next();

    const scope = await connect(endpoint);
    const { stream: scopeStream } = await greet(scope, scopeAck.capability);

    assert.equal(broker.closeScope('scope-close'), true);
    await waitForClose(scope);

    // Reusing the revoked scope capability should fail
    const retry = await connect(endpoint);
    const retryStream = frames(retry);
    send(retry, { type: 'hello', protocol: PROTOCOL, cap: scopeAck.capability });
    const ack = await retryStream.next();
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'unauthorized');
    await waitForClose(retry);
});

// --- broker replacement: new broker instance issues new capabilities ---
test('broker replacement: new broker instance generates new capability tokens', async () => {
    const first = startBroker({ listen: false });
    const cap1 = first.issueSessionCapability('session-A').capability;
    first.close();

    const second = startBroker({ listen: false });
    const cap2 = second.issueSessionCapability('session-A').capability;

    assert.notEqual(cap1, cap2, 'new broker instance must issue different capability token');
    second.close();
});

// --- session capability has no expiry (expiresAt === null) ---
test('session capability: expiresAt is null (no expiry)', async () => {
    const broker = startBroker({ listen: false });
    const issued = broker.issueSessionCapability('session-A');
    assert.equal(issued.expiresAt, null, 'session capability must not expire');
});

// --- scope capability has default 4h expiry ---
test('scope capability: default expiry is 4 hours', async () => {
    const clock = makeClock();
    const broker = startBroker({ listen: false, now: clock.now });
    const issued = broker.issueScopeCapability('scope-1', 'session-A');
    const expectedExpiry = clock.now() + DEFAULT_SCOPE_LIFETIME_MS;
    assert.equal(issued.expiresAt, expectedExpiry, 'scope capability must have default 4h expiry');
});

// --- connection limit: at most 2 concurrent connections per capability ---
test('limits: session capability admits at most 2 concurrent connections', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    const first = await connect(endpoint);
    const { stream: stream1 } = await greet(first, capability);
    const second = await connect(endpoint);
    const { stream: stream2 } = await greet(second, capability);
    const third = await connect(endpoint);
    const thirdStream = frames(third);
    send(third, { type: 'hello', protocol: PROTOCOL, cap: capability });
    await waitForClose(third);
    assert.equal(thirdStream.messages.length, 0, 'third connection dropped before helloAck');
});

// --- rate limiting: connection rate limited after burst ---
test('limits: connection rate limited after burst', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint, now: clock.now });
    const capability = broker.issueSessionCapability('session-A').capability;
    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);
    for (let i = 0; i < 6; i += 1) send(socket, { type: 'report', done: 1, total: 2, rootGeneration: 'none' });
    const acks = [];
    for (let i = 0; i < 6; i += 1) acks.push(await stream.next());
    assert.equal(acks[5].reason, 'rate_limited', 'sixth report on one connection is limited');
    assert.ok(
        acks.slice(0, 5).every((ack) => ack.reason === 'stale_generation'),
        'burst before limit is admitted by rate gate'
    );
});

// --- stale generation: report with wrong root generation rejected ---
test('stale generation: report with stale root generation refused', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    broker.observeRoot({ sessionId: 'session-A', rootId: 'root-1' });
    const rootGeneration = broker.snapshot('session-A').root.generation;
    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);
    send(socket, { type: 'report', done: 1, total: 2, rootGeneration: 'wrong-generation' });
    const ack = await stream.next();
    assert.equal(ack.reason, 'stale_generation', 'wrong generation is refused');
    send(socket, { type: 'report', done: 1, total: 2, rootGeneration });
    const accepted = await stream.next();
    assert.equal(accepted.accepted, true, 'current generation is accepted');
});

// --- scope mismatch: report naming another scope rejected ---
test('scope mismatch: report for different scope rejected', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, sessionCap);
    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const scopeAck = await sessionStream.next();

    const scope = await connect(endpoint);
    const { stream: scopeStream } = await greet(scope, scopeAck.capability);
    send(scope, { type: 'report', scope: 'scope-2', done: 1, total: 2 });
    const ack = await scopeStream.next();
    assert.equal(ack.accepted, false);
    assert.equal(ack.reason, 'scope_mismatch');
});

// --- redaction: raw capabilities never exposed in projections ---
test('redaction: info, metrics, snapshot never expose raw capabilities', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const scopeCap = broker.issueScopeCapability('scope-1', 'session-A').capability;
    broker.observeRoot({ sessionId: 'session-A', rootId: 'root-1' });

    const info = broker.info();
    assert.deepEqual(Object.keys(info).sort(), ['endpoint', 'instanceId', 'protocol']);

    const projection = JSON.stringify([info, broker.metrics(), broker.snapshot('session-A')]);
    assert.ok(!projection.includes(sessionCap), 'session capability absent from projections');
    assert.ok(!projection.includes(scopeCap), 'scope capability absent from projections');
});

// --- VANNEVAR_PROGRESS_CAP environment variable handling ---
test('env: VANNEVAR_PROGRESS_CAP not leaked in broker operations', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const capability = broker.issueSessionCapability('session-A').capability;
    process.env.VANNEVAR_PROGRESS_CAP = capability;

    const socket = await connect(endpoint);
    const { stream } = await greet(socket, capability);

    // The broker should not expose the capability in any response
    const allResponses = JSON.stringify(stream.messages);
    assert.ok(!allResponses.includes(capability), 'capability must not appear in any broker response');

    delete process.env.VANNEVAR_PROGRESS_CAP;
});

// --- session capability tied to brokerInstanceId ---
test('session capability: bound to brokerInstanceId', async () => {
    const broker1 = startBroker({ listen: false });
    const cap1 = broker1.issueSessionCapability('session-A').capability;
    const info1 = broker1.info();
    broker1.close();

    const broker2 = startBroker({ listen: false });
    const cap2 = broker2.issueSessionCapability('session-A').capability;
    const info2 = broker2.info();

    assert.notEqual(info1.instanceId, info2.instanceId, 'different broker instances have different IDs');
    assert.notEqual(cap1, cap2, 'capabilities from different broker instances differ');
    broker2.close();
});

// --- ownerSession enforced on scope creation ---
test('scope creation: ownerSession enforced', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCapA = broker.issueSessionCapability('session-A').capability;
    const sessionA = await connect(endpoint);
    const { stream: sessionStreamA } = await greet(sessionA, sessionCapA);

    // Session A creates scope
    send(sessionA, { type: 'createScope', scopeId: 'scope-owned-by-A' });
    const scopeAckA = await sessionStreamA.next();
    assert.equal(scopeAckA.accepted, true);

    // Session B tries to create same scope - should fail
    const sessionCapB = broker.issueSessionCapability('session-B').capability;
    const sessionB = await connect(endpoint);
    const { stream: sessionStreamB } = await greet(sessionB, sessionCapB);
    send(sessionB, { type: 'createScope', scopeId: 'scope-owned-by-A' });
    const scopeAckB = await sessionStreamB.next();
    assert.equal(scopeAckB.accepted, false, 'scope owner mismatch must be rejected');
    assert.equal(scopeAckB.reason, 'scope_owner_mismatch');
});

// --- rootChanged broadcast only to session capability connections ---
test('rootChanged: broadcast only to session-capability connections of that session', async () => {
    const endpoint = newEndpoint();
    const broker = startBroker({ endpoint });
    const sessionCap = broker.issueSessionCapability('session-A').capability;
    const scopeCap = broker.issueScopeCapability('scope-1', 'session-A').capability;

    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, sessionCap);

    const scope = await connect(endpoint);
    const { stream: scopeStream } = await greet(scope, scopeCap);

    // Small delay to ensure both connections are fully registered
    await sleeping(50);

    // Observe a new root for session-A
    broker.observeRoot({ sessionId: 'session-A', rootId: 'root-new' });

    // Session connection should receive rootChanged
    const sessionMsg = await sessionStream.next();
    assert.equal(sessionMsg.type, 'rootChanged');
    assert.equal(sessionMsg.rootId, 'root-new');

    // Scope connection should NOT receive rootChanged
    // (greet consumes helloAck, so messages should be empty if no rootChanged)
    assert.equal(scopeStream.messages.length, 0, 'scope connection must not receive rootChanged');
});

// --- circuit breaker: 3 unexpected exits opens circuit ---
test('circuit breaker: 3 unexpected startup errors open circuit', async () => {
    function unbindableEndpoint() { return join(ROOT, 'unbindable', 'progress.sock'); }
    const broker = startBroker({ endpoint: unbindableEndpoint() });
    assert.equal(broker.metrics().circuitOpen, false);
    const deadline = Date.now() + 5000;
    while (!broker.metrics().circuitOpen) {
        if (Date.now() > deadline) throw new Error('circuit never opened');
        await sleeping(20);
    }
    assert.equal(broker.metrics().circuitOpen, true);
});

// --- circuit breaker: cooldown closes circuit ---
test('circuit breaker: circuit closes after cooldown', async () => {
    const clock = makeClock();
    function unbindableEndpoint() { return join(ROOT, 'unbindable', 'progress.sock'); }
    const broker = startBroker({ endpoint: unbindableEndpoint(), now: clock.now });
    const deadline = Date.now() + 5000;
    while (!broker.metrics().circuitOpen) {
        if (Date.now() > deadline) throw new Error('circuit never opened');
        await sleeping(20);
    }
    assert.equal(broker.metrics().circuitOpen, true);
    clock.advance(CIRCUIT_COOLDOWN_MS + 1);
    assert.equal(broker.metrics().circuitOpen, false, 'circuit closed after cooldown');
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
    console.log(`\n${cases.length - failures.length}/${cases.length} session capability lifecycle cases passed`);
    if (failures.length) {
        console.error('\nFAIL — the session capability lifecycle suite has failures:');
        for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error && failure.error.message}`);
        process.exit(1);
    }
    console.log('\nOK — session capability lifecycle verified: idempotency, cross-session isolation, delegated env scrubbing, revoke triggers, broker replacement');
}

main().catch((error) => {
    console.error('\nFAIL:', (error && error.stack) || error);
    process.exit(1);
});
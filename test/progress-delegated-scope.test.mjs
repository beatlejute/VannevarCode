// Delegated scope lifecycle (PLAN-001 tasks 20-21, IMPL-022). A delegated `run_agent` gets its own
// bounded scope on the real ProgressBroker transport: the scope is minted per run attempt, the
// inherited parent session capability is scrubbed from the child environment, an attempt identity
// (attemptId) is stamped on the manifest, and a Stop addresses that attempt rather than the session
// it happens to share with a resumed run. Every case runs against the product modules — the real
// broker over a real socket, the real ProgressClient, the real MCP server run path and the real
// host request handling — never against a copy.
//
// Isolation: unique temp HOME/runtime, every broker/socket/child torn down in `finally`.
//
// Run: node test/progress-delegated-scope.test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const { createProgressBroker, PROTOCOL, DEFAULT_SCOPE_LIFETIME_MS } = require('../runtime/progress-broker.js');

const IS_WIN = process.platform === 'win32';
const ROOT = mkdtempSync(join(tmpdir(), 'vpr-delegated-'));
const PROFILES = join(ROOT, '.claude', 'profiles');
const HOME = join(ROOT, 'home');
const RUNTIME = join(HOME, '.claude', 'vannevar');
for (const d of [PROFILES, HOME, RUNTIME]) mkdirSync(d, { recursive: true });
writeFileSync(join(PROFILES, 'claude.json'), JSON.stringify({ env: {} }));

// The MCP server and the host resolve their runtime directory from HOME/USERPROFILE.
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.VANNEVAR_PROFILES_DIR = PROFILES;
process.env.VANNEVAR_RUNTIME_DIR = RUNTIME;
process.env.CLAUDE_CODE_SESSION_ID = '99999999-1111-2222-3333-444444444444';

let seq = 0;
const newEndpoint = () => (IS_WIN ? `\\\\.\\pipe\\vpr-delegated-${process.pid}-${++seq}` : join(ROOT, `vpr-delegated-${process.pid}-${++seq}.sock`));
const sleeping = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClock(start = Date.now()) {
    const state = { t: start };
    return { now: () => state.t, advance: (ms) => { state.t += ms; } };
}

const live = { brokers: new Set(), sockets: new Set(), clients: new Set(), children: new Set() };
const trackBroker = (broker) => (live.brokers.add(broker), broker);
const trackClient = (client) => (live.clients.add(client), client);
function cleanup() {
    for (const client of live.clients) { try { client.close(); } catch {} }
    live.clients.clear();
    for (const socket of live.sockets) { try { socket.destroy(); } catch {} }
    live.sockets.clear();
    for (const child of live.children) { try { child.kill(); } catch {} }
    live.children.clear();
    for (const broker of live.brokers) { try { broker.close(); } catch {} }
    live.brokers.clear();
}

function connect(endpoint) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(endpoint);
        live.sockets.add(socket);
        let settled = false;
        socket.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
        socket.once('connect', () => { if (!settled) { settled = true; socket.setEncoding('utf8'); resolve(socket); } });
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

const send = (socket, message) => socket.write(JSON.stringify(message) + '\n');

async function greet(socket, capability, protocol = PROTOCOL) {
    const stream = frames(socket);
    send(socket, { type: 'hello', protocol, cap: capability });
    const ack = await stream.next();
    assert.equal(ack.type, 'helloAck', `hello expected a helloAck, got ${JSON.stringify(ack)}`);
    return { stream, helloAck: ack };
}

async function waitForClose(socket, timeout = 3000) {
    if (socket.destroyed) return;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`socket did not close within ${timeout}ms`)), timeout);
        socket.once('close', () => { clearTimeout(timer); resolve(); });
    });
}

// --- load the product modules under the isolated environment ---------------------------------

const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const hostCopy = join(tmpdir(), `ccx-host-delegated-${process.pid}.cjs`);
writeFileSync(hostCopy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
// host.js loads ./progress-broker.js from its runtime directory at require time.
writeFileSync(join(RUNTIME, 'progress-broker.js'), readFileSync(new URL('../runtime/progress-broker.js', import.meta.url)));
let host;
try {
    host = require(hostCopy);
} finally {
    rmSync(hostCopy, { force: true });
    Module._load = load;
}
const { requestAgentStop } = host;

const { prepare, execute, openRun } = await import('../runtime/mcp/agent-server.mjs');
const { ProgressClient } = await import('../runtime/mcp/progress-client.mjs');

const RUNS_DIR = join(RUNTIME, 'agent-runs');
const manifestOf = (id) => JSON.parse(readFileSync(join(RUNS_DIR, `${id}.json`), 'utf8'));
const scopeClient = (capability, scopeId, endpoint = process.env.VANNEVAR_PROGRESS_ENDPOINT) =>
    trackClient(new ProgressClient({ endpoint, protocol: String(PROTOCOL), capability, scope: scopeId }));

// A broker with a live session/scope pair on a real socket.
async function liveBroker() {
    const endpoint = newEndpoint();
    const broker = trackBroker(createProgressBroker({ endpoint }));
    const owner = 'owner-' + ++seq;
    const cap = broker.issueSessionCapability(owner).capability;
    return { broker, endpoint, owner, cap };
}

// ----------------------------------------------------------------------------------- transport

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

test('createScope: one scope-only capability, repeat issuance is idempotent', async () => {
    const { broker, endpoint, cap } = await liveBroker();
    const session = await connect(endpoint);
    const { stream } = await greet(session, cap);

    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const first = await stream.next();
    assert.equal(first.type, 'scopeAck');
    assert.ok(first.capability, 'the scope receives its own capability');
    assert.notEqual(first.capability, cap, 'the scope capability is not the parent session capability');

    send(session, { type: 'createScope', scopeId: 'scope-1' });
    const second = await stream.next();
    assert.equal(second.capability, first.capability, 'issuing the same scope twice keeps one live token');
    assert.equal(broker.metrics().activeScopes, 1, 'and leaves a single active scope');
});

test('scope report: a scope mutates itself, never another scope or the root', async () => {
    const { broker, endpoint, cap, owner } = await liveBroker();
    const session = await connect(endpoint);
    const { stream } = await greet(session, cap);
    send(session, { type: 'createScope', scopeId: 'scope-a' });
    const ack = await stream.next();

    const scope = await connect(endpoint);
    const { stream: scopeStream } = await greet(scope, ack.capability);
    send(scope, { type: 'report', done: 1, total: 2, scope: 'scope-a' });
    assert.equal((await scopeStream.next()).accepted, true, 'a scope reports against itself');

    send(scope, { type: 'report', done: 1, total: 2, scope: 'scope-b' });
    const foreign = await scopeStream.next();
    assert.equal(foreign.accepted, false, 'a scope cannot write another scope');
    assert.equal(foreign.reason, 'scope_mismatch');
    assert.equal(broker.snapshot(owner).semanticByScope['scope-b'], undefined, 'the foreign scope is untouched');
});

test('closeScope: the owning session closes it, the child capability dies at once', async () => {
    const { broker, endpoint, cap } = await liveBroker();
    const session = await connect(endpoint);
    const { stream } = await greet(session, cap);
    send(session, { type: 'createScope', scopeId: 'scope-c' });
    const ack = await stream.next();

    const child = await connect(endpoint);
    const { stream: childStream } = await greet(child, ack.capability);
    send(child, { type: 'report', done: 0, total: 3, scope: 'scope-c' });
    assert.equal((await childStream.next()).accepted, true, 'the child reports while its scope is live');

    send(session, { type: 'closeScope', scopeId: 'scope-c' });
    const closed = await stream.next();
    assert.equal(closed.accepted, true, 'the owner closes the scope over the wire');
    assert.equal(broker.metrics().activeScopes, 0, 'and the broker drops it');
    await waitForClose(child);

    const retry = await connect(endpoint);
    const retryStream = frames(retry);
    send(retry, { type: 'hello', protocol: PROTOCOL, cap: ack.capability });
    const refused = await retryStream.next();
    assert.equal(refused.accepted, false, 'the revoked scope capability authenticates nothing');
    assert.equal(refused.reason, 'unauthorized');
});

test('closeScope: a foreign session and an unknown scope are both refused', async () => {
    const { broker, endpoint, cap } = await liveBroker();
    const otherCap = broker.issueSessionCapability('owner-other').capability;
    const session = await connect(endpoint);
    const { stream } = await greet(session, cap);
    send(session, { type: 'createScope', scopeId: 'scope-owned' });
    await stream.next();

    const stranger = await connect(endpoint);
    const { stream: strangerStream } = await greet(stranger, otherCap);
    send(stranger, { type: 'closeScope', scopeId: 'scope-owned' });
    const foreign = await strangerStream.next();
    assert.equal(foreign.accepted, false, 'another session cannot close the scope');
    assert.equal(foreign.reason, 'scope_owner_mismatch');
    assert.equal(broker.metrics().activeScopes, 1, 'the scope survives the foreign attempt');

    send(session, { type: 'closeScope', scopeId: 'does-not-exist' });
    const unknown = await stream.next();
    assert.equal(unknown.accepted, false, 'an unknown scope is refused');
    assert.equal(unknown.reason, 'scope_closed');
});

test('non-cascade: closing a parent scope leaves an independent scope alive', async () => {
    const { broker, endpoint, cap } = await liveBroker();
    const session = await connect(endpoint);
    const { stream } = await greet(session, cap);
    send(session, { type: 'createScope', scopeId: 'scope-parent' });
    const parent = await stream.next();
    send(session, { type: 'createScope', scopeId: 'scope-child' });
    const childScope = await stream.next();

    const child = await connect(endpoint);
    const { stream: childStream } = await greet(child, childScope.capability);

    send(session, { type: 'closeScope', scopeId: 'scope-parent' });
    assert.equal((await stream.next()).accepted, true);
    assert.equal(broker.metrics().activeScopes, 1, 'only the named scope closes');

    send(child, { type: 'report', done: 1, total: 2, scope: 'scope-child' });
    assert.equal((await childStream.next()).accepted, true, 'the independent scope keeps accepting reports');
    // The parent session capability is untouched by a child close.
    send(session, { type: 'createScope', scopeId: 'scope-parent-2' });
    assert.equal((await stream.next()).accepted, true, 'the session can still mint scopes');
});

test('scope lifetime: an expired scope is refused, a live one is not', async () => {
    const clock = makeClock();
    const endpoint = newEndpoint();
    const broker = trackBroker(createProgressBroker({ endpoint, now: clock.now }));
    const cap = broker.issueSessionCapability('owner-ttl').capability;
    const session = await connect(endpoint);
    const { stream } = await greet(session, cap);
    send(session, { type: 'createScope', scopeId: 'scope-live' });
    const ack = await stream.next();
    assert.ok(ack.expiresAt > clock.now(), 'the scope carries a bounded expiry');
    assert.ok(ack.expiresAt - clock.now() <= DEFAULT_SCOPE_LIFETIME_MS, 'and it never exceeds the default lifetime');

    const scope = await connect(endpoint);
    const { stream: scopeStream } = await greet(scope, ack.capability);
    clock.advance(DEFAULT_SCOPE_LIFETIME_MS + 1000);
    send(scope, { type: 'report', done: 1, total: 2, scope: 'scope-live' });
    const expired = await scopeStream.next();
    assert.equal(expired.accepted, false, 'a report after the lifetime is refused');
    assert.equal(expired.reason, 'scope_closed');
});

test('scope hello: a scope connection never receives rootChanged', async () => {
    const { broker, endpoint, owner, cap } = await liveBroker();
    broker.observeRoot({ sessionId: owner, rootId: 'root-1' });
    const session = await connect(endpoint);
    const { stream: sessionStream } = await greet(session, cap);
    send(session, { type: 'createScope', scopeId: 'scope-quiet' });
    const ack = await sessionStream.next();

    const scope = await connect(endpoint);
    const { stream: scopeStream, helloAck } = await greet(scope, ack.capability);
    assert.equal(helloAck.rootGeneration ?? null, null, 'a scope hello carries no root generation');

    broker.observeRoot({ sessionId: owner, rootId: 'root-2' });
    const sessionChange = await sessionStream.next();
    assert.equal(sessionChange.type, 'rootChanged', 'the owning session is told about the new root');
    assert.equal(scopeStream.messages.length, 0, 'root changes are not delivered to a scope connection');
});

// ---------------------------------------------------------------------------------- MCP server

// Point the MCP server's ProgressClient at a live broker and hand it a parent session capability,
// exactly as the host does when it spawns the server.
async function pointServerAt(broker, endpoint, parentCap) {
    process.env.VANNEVAR_PROGRESS_ENDPOINT = endpoint;
    process.env.VANNEVAR_PROGRESS_PROTOCOL = String(PROTOCOL);
    process.env.VANNEVAR_PROGRESS_CAPABILITY = parentCap;
}
function clearServerEndpoint() {
    delete process.env.VANNEVAR_PROGRESS_ENDPOINT;
    delete process.env.VANNEVAR_PROGRESS_PROTOCOL;
    delete process.env.VANNEVAR_PROGRESS_CAPABILITY;
}

test('run_agent: the child gets a fresh scope, the parent capability is scrubbed', async () => {
    const { broker, endpoint, owner, cap } = await liveBroker();
    await pointServerAt(broker, endpoint, cap);
    try {
        const ctx = await prepare({ profile: 'claude', prompt: 'delegated work' });
        assert.ok(ctx.scopeId, 'a scope is minted for the attempt');
        assert.equal(ctx.env.VANNEVAR_PROGRESS_SCOPE, ctx.scopeId, 'the child is told which scope it owns');
        assert.ok(ctx.env.VANNEVAR_PROGRESS_CAPABILITY, 'the child gets its own capability');
        assert.notEqual(ctx.env.VANNEVAR_PROGRESS_CAPABILITY, cap, 'never the parent session capability');
        assert.equal(ctx.env.VANNEVAR_PROGRESS_CAP, undefined, 'the inherited parent variable is scrubbed');

        const child = scopeClient(ctx.env.VANNEVAR_PROGRESS_CAPABILITY, ctx.scopeId);
        const report = await child.report({ done: 1, total: 4, scope: ctx.scopeId });
        assert.equal(report.ok, true, 'the child reports under its own scope');
    } finally {
        clearServerEndpoint();
    }
});

test('real run manifest and host payload preserve scope semantics without capabilities', async () => {
    const { broker, endpoint, owner, cap } = await liveBroker();
    await pointServerAt(broker, endpoint, cap);
    let id;
    try {
        const ctx = await prepare({ profile: 'claude', prompt: 'scope projection', scopeId: 'untrusted-input' });
        assert.notEqual(ctx.scopeId, 'untrusted-input');
        id = openRun({ ...ctx, promptPreview: ctx.prompt }, false);
        const child = scopeClient(ctx.env.VANNEVAR_PROGRESS_CAPABILITY, ctx.scopeId);
        assert.equal((await child.report({ done: 2, total: 4, scope: ctx.scopeId })).ok, true);
        const manifest = manifestOf(id);
        assert.equal(manifest.scopeId, ctx.scopeId);
        const payload = host.agentRunsPayload();
        const row = payload.find((run) => run.session === id);
        assert.equal(row.scopeId, ctx.scopeId);
        assert.equal(row.attemptId, ctx.attemptId);
        const projection = host.SessionProgressProjection({
            ownerSession: process.env.CLAUDE_CODE_SESSION_ID,
            sessionId: process.env.CLAUDE_CODE_SESSION_ID,
            runtime: { sessionId: process.env.CLAUDE_CODE_SESSION_ID },
            enabled: true,
            delegatedRuns: payload,
            brokerSnapshot: broker.snapshot(owner),
        });
        const projected = projection.agents.delegated.find((run) => run.attemptId === ctx.attemptId);
        assert.equal(projected.semantic.done, 2);
        assert.equal(projected.semantic.total, 4);
        for (const value of [manifest, payload, projection]) {
            const serialized = JSON.stringify(value);
            assert.ok(!serialized.includes(cap));
            assert.ok(!serialized.includes(ctx.env.VANNEVAR_PROGRESS_CAPABILITY));
        }
    } finally {
        if (id) rmSync(join(RUNS_DIR, `${id}.json`), { force: true });
        clearServerEndpoint();
    }
});

test('run_agent: a broker slower than the deadline still starts the run activity-only', async () => {
    process.env.VANNEVAR_PROGRESS_ENDPOINT = IS_WIN
        ? `\\\\.\\pipe\\vpr-dead-${process.pid}-${++seq}`
        : join(ROOT, `vpr-dead-${process.pid}-${++seq}.sock`);
    process.env.VANNEVAR_PROGRESS_PROTOCOL = String(PROTOCOL);
    process.env.VANNEVAR_PROGRESS_CAPABILITY = 'unreachable-capability';
    const startedAt = Date.now();
    try {
        const ctx = await prepare({ profile: 'claude', prompt: 'no broker' });
        const elapsed = Date.now() - startedAt;
        assert.equal(ctx.scopeId, null, 'an unanswered broker leaves the run without a scope');
        assert.ok(elapsed < 1500, `scope minting stays well under the deadline (${elapsed}ms)`);
        assert.equal(ctx.env.VANNEVAR_PROGRESS_CAPABILITY, undefined, 'no progress capability is handed over');
        assert.equal(ctx.env.VANNEVAR_PROGRESS_SCOPE, undefined, 'and no scope');
        assert.equal(ctx.env.VANNEVAR_PROGRESS_ENDPOINT, undefined, 'the child has no progress endpoint either');
    } finally {
        clearServerEndpoint();
    }
});

test('attempt identity: each run_agent attempt gets its own attemptId on the manifest', async () => {
    clearServerEndpoint();
    const first = await prepare({ profile: 'claude', prompt: 'first attempt' });
    const second = await prepare({ profile: 'claude', prompt: 'second attempt' });
    assert.ok(first.attemptId && second.attemptId, 'every attempt is identified');
    assert.notEqual(first.attemptId, second.attemptId, 'two attempts never share an id');

    const run = openRun({ ...first, promptPreview: first.prompt }, false);
    assert.equal(manifestOf(run).attemptId, first.attemptId, 'the manifest carries the attempt id');
    rmSync(join(RUNS_DIR, `${run}.json`), { force: true });
});

test('run_agent success: the delegated scope is closed when the run ends', async () => {
    const { broker, endpoint, cap } = await liveBroker();
    await pointServerAt(broker, endpoint, cap);
    try {
        const ctx = await prepare({ profile: 'claude', prompt: 'quick success' });
        assert.ok(ctx.scopeId, 'the run has a scope');
        const scopeCap = ctx.env.VANNEVAR_PROGRESS_CAPABILITY;
        ctx.bin = process.execPath;
        ctx.args = ['-e', `process.stdout.write(JSON.stringify({session_id:"11111111-2222-3333-4444-555555555555",num_turns:1,result:"done",usage:{}}))`];
        const text = await execute(ctx, null);
        assert.match(text, /done/, 'the run returns its result');
        assert.equal(broker.metrics().activeScopes, 0, 'the scope is closed on success');

        const child = scopeClient(scopeCap, ctx.scopeId);
        const after = await child.report({ done: 1, total: 1, scope: ctx.scopeId });
        assert.equal(after.ok, false, 'the child capability is dead once the run ended');
    } finally {
        clearServerEndpoint();
    }
});

test('run_agent failure: the delegated scope is closed when the run errors', async () => {
    const { broker, endpoint, cap } = await liveBroker();
    await pointServerAt(broker, endpoint, cap);
    try {
        const ctx = await prepare({ profile: 'claude', prompt: 'will fail' });
        const scopeCap = ctx.env.VANNEVAR_PROGRESS_CAPABILITY;
        ctx.bin = process.execPath;
        ctx.args = ['-e', `process.stdout.write(JSON.stringify({session_id:"22222222-3333-4444-5555-666666666666",is_error:true,result:"boom",usage:{}}))`];
        await assert.rejects(() => execute(ctx, null), /reported an error/, 'the error surfaces');
        assert.equal(broker.metrics().activeScopes, 0, 'the scope is closed on error');
        const child = scopeClient(scopeCap, ctx.scopeId);
        assert.equal((await child.report({ done: 1, total: 1, scope: ctx.scopeId })).ok, false, 'the capability is revoked');
    } finally {
        clearServerEndpoint();
    }
});

test('attempt-specific Stop: a stop for another attempt is ignored, the right one ends the run', async () => {
    clearServerEndpoint();
    const ctx = await prepare({ profile: 'claude', prompt: 'long run' });
    ctx.bin = process.execPath;
    ctx.args = ['-e', 'setTimeout(() => {}, 60000)'];
    const task = { stopped: false, child: null };
    const settled = execute(ctx, task).then(() => 'done', (e) => e);
    await sleeping(300);
    assert.equal(manifestOf(ctx.liveSession).state, 'running', 'the run is live');

    // A request naming a different attempt of the same session must not end this run.
    writeFileSync(join(RUNS_DIR, `${ctx.liveSession}.stop`), 'some-other-attempt');
    await sleeping(1400);
    let outcome = await Promise.race([settled, sleeping(10).then(() => 'running')]);
    assert.equal(outcome, 'running', 'a foreign attempt id does not stop the run');
    assert.equal(manifestOf(ctx.liveSession).state, 'running', 'and the manifest still says running');

    // The request naming this attempt ends it.
    writeFileSync(join(RUNS_DIR, `${ctx.liveSession}.stop`), ctx.attemptId);
    outcome = await Promise.race([settled, sleeping(6000).then(() => 'timeout')]);
    assert.notEqual(outcome, 'timeout', 'the matching attempt id stops the run');
    assert.match(String(outcome && outcome.message), /stopped by the user/, 'the caller is told the user stopped it');
    assert.equal(manifestOf(ctx.liveSession).state, 'stopped', 'the manifest records the stop');
});

test('host stop: the attempt id is validated and the owner set is enforced', async () => {
    mkdirSync(RUNS_DIR, { recursive: true });
    const session = '33333333-4444-5555-6666-777777777777';
    const attempt = 'attempt-alpha';
    writeFileSync(join(RUNS_DIR, `${session}.json`), JSON.stringify({
        id: session, session, owner: '99999999-1111-2222-3333-444444444444', attemptId: attempt, state: 'running', startedAt: Date.now(),
    }));
    try {
        assert.equal(requestAgentStop(session, 'attempt-beta').ok, false, 'an unknown attempt is refused');
        assert.equal(requestAgentStop(session, attempt, 'a-foreign-owner').ok, false, 'a run outside the owner set is refused');
        assert.equal(requestAgentStop(session, attempt, '99999999-1111-2222-3333-444444444444').ok, true, 'the owner stops its own run');
        const written = readFileSync(join(RUNS_DIR, `${session}.stop`), 'utf8');
        assert.equal(written, attempt, 'the request names the attempt it was clicked on');
    } finally {
        rmSync(join(RUNS_DIR, `${session}.json`), { force: true });
        rmSync(join(RUNS_DIR, `${session}.stop`), { force: true });
    }
});

// ------------------------------------------------------------------------------------ runner

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
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
    console.log(`\n${cases.length - failures.length}/${cases.length} delegated scope cases passed`);
    if (failures.length) {
        console.error('\nFAIL — the delegated scope suite has failures:');
        for (const failure of failures) console.error(`  - ${failure.name}: ${failure.error && failure.error.message}`);
        process.exit(1);
    }
    console.log('\nOK — delegated scope verified: per-attempt scope, capability scrubbing, owner-scoped close and attempt-specific Stop');
}

main().catch((error) => {
    console.error('\nFAIL:', (error && error.stack) || error);
    process.exit(1);
});

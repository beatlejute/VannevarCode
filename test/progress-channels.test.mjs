// Behavior tests: Channels progress commands — PLAN-001 task 30.
// Fake relay, no network and no channel plugin: the real host command router
// (`relayCommand`, exposed with the append-export pattern from
// test/channel-approvals.test.mjs) is driven against a fake channel relay and
// fake tabs over an isolated temp HOME, while the real broker answers over a
// real local pipe/socket. Every asserted value is read from product output.
//
// Covered: output of the three commands, response-budget normalization,
// truncation with a stable tab index, owner isolation, native-capability
// fallback, disabled rollback and ASCII mode.
//
//   node test/progress-channels.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert';

const home = mkdtempSync(join(tmpdir(), 'ccx-progress-channels-'));
const runtimeDir = join(home, '.claude', 'vannevar');
mkdirSync(runtimeDir, { recursive: true });
copyFileSync(new URL('../runtime/host.js', import.meta.url), join(runtimeDir, 'host.js'));
copyFileSync(new URL('../runtime/progress-broker.js', import.meta.url), join(runtimeDir, 'progress-broker.js'));
writeFileSync(join(runtimeDir, 'webview.js'), '// placeholder webview runtime (never executed)');
process.env.HOME = home;
process.env.USERPROFILE = home;

// The reply budget is read from vscode configuration at format time, so the stub
// owns the raw value the real clamp normalizes.
const config = { 'channels.responseBudget': undefined };
const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }) },
    window: { showWarningMessage() {}, showErrorMessage() {} },
    workspace: { getConfiguration: () => ({ get: (key, fallback) => (config[key] !== undefined ? config[key] : fallback) }) },
};

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) => (request === 'vscode' ? vscodeStub : load(request, ...rest));
const hostCopy = join(tmpdir(), `ccx-host-channels-${process.pid}.cjs`);
writeFileSync(
    hostCopy,
    readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8') +
        '\nmodule.exports.__relayCommand = relayCommand;\n',
);
let host;
try {
    host = require(hostCopy);
} finally {
    rmSync(hostCopy, { force: true });
    Module._load = load;
}
const { createProgressBroker, PROTOCOL } = require('../runtime/progress-broker.js');

// --- fake channel and tabs ---------------------------------------------------------------------
const state = globalThis.__ccxState;
const replies = [];
state.relay = {
    relay: {
        send: async (chat, text, extra) => {
            replies.push({ chat, text, extra });
            return { text: 'ok' };
        },
    },
};
const delivered = [];
const mkTab = (id, title) => ({
    __ccxSessionId: id,
    __ccxTitle: title,
    postMessage: (message) => {
        delivered.push(message);
        return Promise.resolve(true);
    },
});
const tabA = mkTab('session-one', 'First tab');
const tabB = mkTab('session-two', 'Second tab');
const tabC = mkTab('session-three', 'Third tab');
state.webviews = new Set([tabA, tabB, tabC]);
state.lastActiveWebview = tabB;

function setTabs(tabs) {
    state.webviews = new Set(tabs);
    state.lastActiveWebview = tabs.find((tab) => tab.__ccxSessionId === 'session-two') || null;
}

function command(text) {
    const before = replies.length;
    assert.equal(host.__relayCommand({ chatId: '777', messageId: 'm' + before }, text), true, 'relayCommand claims ' + text);
    assert.equal(replies.length, before + 1, 'one reply per command: ' + text);
    return replies.at(-1).text;
}

const longTitle = (n) => 'Tab ' + n + ' ' + 'x'.repeat(120);
const manyTabs = (count) => Array.from({ length: count }, (_, i) => mkTab('many-' + (i + 1), longTitle(i + 1)));

// --- command-level cases -----------------------------------------------------------------------

function testNoTab() {
    setTabs([tabA, tabB, tabC]);
    state.lastActiveWebview = null;
    rmSync(join(runtimeDir, 'relay-target.json'), { force: true });
    assert.equal(command('/agents'), 'No receiving tab. Run /tabs, then /tab <number>.');
    state.lastActiveWebview = tabB;
}

// The correct enriched shape of /session is pinned here. The case caught a product defect:
// relayCommand built the enriched reply but a later generic branch overwrote it before send
// (fixed in runtime/host.js — the enriched reply is kept; see the ticket's «Найденные дефекты»).
function testSessionEnrichedOutput() {
    setTabs([tabA, tabB, tabC]);
    const text = command('/session');
    const lines = text.split('\n');
    assert.equal(lines[0], 'Second tab', 'the title line names the receiving tab');
    assert.match(text, /No progress data yet\./, 'activity-only without semantic shows the idle status line');
    assert.match(text, /unknown\/\?/, 'provider/model degrade to unknown without evidence');
    assert.match(text, /0 agents/, 'child count is 0 without runs');
}

function testTabsEnrichedNoTruncation() {
    setTabs([tabA, tabB, tabC]);
    const text = command('/tabs');
    const lines = text.split('\n');
    assert.equal(lines.length, 3, 'one row per tab');
    assert.match(lines[0], /^1\. First tab /, 'row 1 numbered and enriched');
    assert.match(lines[1], /^2\. Second tab /, 'row 2 numbered and enriched');
    assert.match(lines[2], /^3\. Third tab /, 'row 3 numbered and enriched');
    assert.ok(!text.includes('more'), 'nothing truncated within the default budget');
}

function testBudgetNormalizationAndTruncation() {
    const tabs = manyTabs(40);
    setTabs(tabs);

    // Invalid raw value falls back to the default 3500: the reply truncates below it.
    config['channels.responseBudget'] = 'not-a-number';
    const truncated = command('/tabs');
    assert.ok(truncated.length <= 3500, 'default budget caps at 3500, got ' + truncated.length);
    assert.match(truncated, /\n… \+\d+ more$/, 'truncation carries the dropped-count suffix');

    // Whole head rows keep their numbering: the visible indices stay the mapping indices.
    const lines = truncated.split('\n');
    const nums = lines.filter((l) => /^\d+\. /.test(l)).map((l) => parseInt(l, 10));
    assert.deepEqual(nums, nums.map((_, i) => i + 1), 'visible rows are numbered 1..k without renumbering');
    const suffix = /… \+(\d+) more$/.exec(truncated);
    assert.equal(Number(suffix[1]), 40 - nums.length, 'the suffix counts exactly the dropped rows');

    // An index truncated away still selects through the stored full mapping.
    const awayIndex = nums.length + 1;
    const away = command('/tab ' + awayIndex);
    assert.ok(
        away.startsWith('Receiving tab: ' + tabs[awayIndex - 1].__ccxTitle),
        'selection survives truncation for rows beyond the visible tail: ' + JSON.stringify(away.slice(0, 60)),
    );
    assert.ok(
        command('/tab 40').startsWith('Receiving tab: ' + tabs[39].__ccxTitle),
        'the last full-mapping index still resolves',
    );
    assert.match(command('/tab 99'), /Invalid or closed tab/, 'an index beyond the mapping is refused');

    // 100 clamps up to 500: the reply shrinks under the default-cased one.
    config['channels.responseBudget'] = 100;
    const small = command('/tabs');
    assert.ok(small.length <= 500, 'budget 100 clamps to the 500 minimum, got ' + small.length);

    // 99999 clamps down to 16000: 40 long rows (~8k chars) fit without truncation.
    config['channels.responseBudget'] = 99999;
    const large = command('/tabs');
    assert.ok(!/more$/.test(large), 'the 16000 maximum keeps all rows visible');
    assert.ok(large.length > 3500, 'an over-default reply proves the clamp is not the 3500 default');

    config['channels.responseBudget'] = undefined;
    rmSync(join(runtimeDir, 'relay-target.json'), { force: true });
    setTabs([tabA, tabB, tabC]);
}

function testAgentsOwnerIsolation() {
    setTabs([tabA, tabB, tabC]);
    const runsDir = join(runtimeDir, 'agent-runs');
    mkdirSync(runsDir, { recursive: true });
    writeFileSync(join(runsDir, 'run-root.json'), JSON.stringify({ session: 'run-root', owner: 'session-two', description: 'Root task', state: 'running', startedAt: 1, profile: 'glm' }));
    writeFileSync(join(runsDir, 'run-child.json'), JSON.stringify({ session: 'run-child', parent: 'run-root', description: 'Nested task', state: 'running', startedAt: 2, profile: 'glm' }));
    writeFileSync(join(runsDir, 'run-other.json'), JSON.stringify({ session: 'run-other', owner: 'session-one', description: 'Other tab task', state: 'running', startedAt: 3, profile: 'glm' }));
    writeFileSync(join(runsDir, 'run-done.json'), JSON.stringify({ session: 'run-done', owner: 'session-two', description: 'Completed task', state: 'done', startedAt: 4, profile: 'glm' }));
    const text = command('/agents');
    assert.match(text, /Agents for Second tab/, 'the reply names the receiving tab');
    assert.match(text, /Root task/, 'the owner session run is projected');
    assert.match(text, /Nested task/, 'a descendant of the owner is included through the parent closure');
    assert.doesNotMatch(text, /Other tab task/, 'a run owned by another tab is excluded');
    assert.doesNotMatch(text, /Completed task/, 'a terminal run is excluded');
}

function testNativeCapabilityFallback() {
    // No runtime projection was posted for this session: the page capability is absent, so the
    // command says so instead of showing half the picture.
    const text = command('/agents');
    assert.ok(
        text.endsWith('(Note: native agent status unavailable for this Claude Code version)'),
        'missing native capability appends the bounded note, got: ' + JSON.stringify(text.slice(-120)),
    );
    // The same branch both ways in the exported pure projection.
    const withNative = host.SessionProgressProjection({
        sessionId: 's',
        runtime: { nativeAgents: [{ id: 'n1', title: 'Native', state: 'running', startedAt: 1, currentTool: 'Bash', tokens: 1, toolCalls: 1, execution: {} }] },
        brokerSnapshot: null,
        delegatedRuns: [],
        ownerSession: 's',
        now: 10,
        enabled: true,
    });
    assert.equal(withNative.capabilities.nativeSubagentTasks, true, 'a nativeAgents array marks the capability present');
    assert.equal(withNative.agents.native.length, 1, 'a running native row is projected');
    const withoutNative = host.SessionProgressProjection({
        sessionId: 's',
        runtime: { root: null },
        brokerSnapshot: null,
        delegatedRuns: [],
        ownerSession: 's',
        now: 10,
        enabled: true,
    });
    assert.equal(withoutNative.capabilities.nativeSubagentTasks, false, 'no nativeAgents array marks the capability absent');
    assert.equal(withoutNative.agents.native.length, 0, 'absent capability projects no native rows');
}

function testDisabledRollbackCommands() {
    process.env.VANNEVAR_DISABLE_PROGRESS = '1';
    try {
        setTabs([tabA, tabB, tabC]);
        assert.equal(
            command('/tabs'),
            '1. First tab\n2. Second tab\n3. Third tab',
            'with progress disabled /tabs returns the exact pre-feature list',
        );
        const agentsLegacy = command('/agents');
        assert.match(agentsLegacy, /Active delegated agents for Second tab/, 'with progress disabled /agents keeps the pre-feature delegated-only shape');
        assert.doesNotMatch(agentsLegacy, /No progress data yet/, 'no enriched line leaks into the disabled reply');
        const before = replies.length;
        assert.equal(host.__relayCommand({ chatId: '777', messageId: 'm-dis' }, '/session'), true);
        assert.equal(replies.length, before, 'disabled /session does not answer from the projection');
        assert.equal(delivered.at(-1).command, 'session', 'it falls through to the pre-feature webview control');
        assert.equal(delivered.at(-1).sessionId, 'session-two');
        // Enabled again: the enriched behavior returns (the rollback is not sticky).
        delete process.env.VANNEVAR_DISABLE_PROGRESS;
        assert.match(command('/tabs'), /No progress data yet\./, 're-enabling restores the enriched reply');
    } finally {
        delete process.env.VANNEVAR_DISABLE_PROGRESS;
    }
}

function testAsciiMode() {
    process.env.VANNEVAR_CHANNELS_ASCII = '1';
    try {
        setTabs(manyTabs(40));
        config['channels.responseBudget'] = 'not-a-number';
        const text = command('/tabs');
        assert.ok(!text.includes('…'), 'no Unicode ellipsis in ASCII mode');
        assert.match(text, /\n\.\.\. \+\d+ more$/, 'the truncation suffix uses ASCII marks');
        setTabs([tabA, tabB, tabC]);
        const idle = command('/tabs');
        assert.match(idle, /\[Idle\] No progress data yet\./, 'ASCII marks replace the Unicode idle mark');
        assert.ok(!idle.includes('○'), 'no Unicode idle mark survives in ASCII mode');
    } finally {
        delete process.env.VANNEVAR_CHANNELS_ASCII;
        config['channels.responseBudget'] = undefined;
        rmSync(join(runtimeDir, 'relay-target.json'), { force: true });
        setTabs([tabA, tabB, tabC]);
    }
}

// --- broker-level cases (real local pipe/socket) -----------------------------------------------

const sleeping = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connect(endpoint) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(endpoint);
        socket.on('error', reject);
        socket.once('connect', () => {
            socket.setEncoding('utf8');
            resolve(socket);
        });
    });
}

function frames(socket) {
    const stream = { messages: [], closed: false };
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf('\n')) >= 0) {
            stream.messages.push(JSON.parse(buffer.slice(0, at)));
            buffer = buffer.slice(at + 1);
        }
    });
    socket.on('close', () => {
        stream.closed = true;
    });
    stream.next = async (timeout = 3000) => {
        const deadline = Date.now() + timeout;
        while (stream.messages.length === 0) {
            if (stream.closed) throw new Error('connection closed before a frame arrived');
            if (Date.now() > deadline) throw new Error('no frame within ' + timeout + 'ms');
            await sleeping(10);
        }
        return stream.messages.shift();
    };
    return stream;
}

const send = (socket, message) => socket.write(JSON.stringify(message) + '\n');

async function testBrokerDisabledRollback() {
    const broker = createProgressBroker({ listen: true });
    try {
        const { capability, expiresAt } = broker.issueSessionCapability('s-own');
        assert.equal(expiresAt, null, 'a session capability does not expire');
        const hash = crypto.createHash('sha256').update(capability).digest('hex');
        assert.equal(broker.revokeCapability(hash), true, 'revoking a live capability reports success');
        assert.equal(broker.revokeCapability(hash), false, 'revoking twice is a no-op');
        const socket = await connect(broker.info().endpoint);
        const stream = frames(socket);
        send(socket, { type: 'hello', protocol: PROTOCOL, cap: capability });
        const ack = await stream.next();
        assert.equal(ack.type, 'ack', 'a revoked token is refused at hello');
        assert.equal(ack.accepted, false);
        assert.equal(ack.reason, 'unauthorized');
        socket.destroy();
        const reissued = broker.issueSessionCapability('s-own');
        assert.notEqual(reissued.capability, capability, 'reissue after revoke mints a fresh token');
    } finally {
        broker.close();
    }
}

async function testBrokerOwnerIsolation() {
    const clock = { t: 1_000_000 };
    const broker = createProgressBroker({ listen: true, now: () => clock.t });
    try {
        broker.issueSessionCapability('s-own');
        broker.issueScopeCapability('scope-iso', 's-own');
        assert.throws(() => broker.issueScopeCapability('scope-iso', 's-other'), /scope owner mismatch/, 'a scope cannot be re-owned by another session');
        assert.equal(broker.observeRoot({ sessionId: 's-own', rootId: 'r-own' }), true, 'the owner observes its own root');

        const events = [];
        broker.onChange((event) => events.push(event));
        const scopeCap = broker.issueScopeCapability('scope-iso', 's-own').capability;
        const socket = await connect(broker.info().endpoint);
        const stream = frames(socket);
        send(socket, { type: 'hello', protocol: PROTOCOL, cap: scopeCap });
        const helloAck = await stream.next();
        assert.equal(helloAck.type, 'helloAck');
        assert.equal(helloAck.scope, 'scope-iso', 'the scope hello names its scope');
        assert.equal(helloAck.rootId, null, 'a scope principal is never shown the root');
        send(socket, { done: 1, total: 2 });
        const ack = await stream.next();
        assert.equal(ack.accepted, true, 'a scope report lands in its own scope');
        const event = events.at(-1);
        assert.equal(event.payload.changedScopes['scope-iso'].done, 1, 'the change is a scope change');
        assert.equal(event.payload.changedRoot, undefined, 'a scope report never emits a root change');
        const snapshot = broker.snapshot('s-own');
        assert.equal(snapshot.root.semantic, null, 'the root semantic stays untouched by the scope report');
        assert.equal(snapshot.semanticByScope['scope-iso'].done, 1, 'the scope semantic is visible to its owner');
        clock.t += 1001; // clear the per-connection report window before the next send
        send(socket, { done: 1, total: 1, scope: 'other-scope' });
        const mismatch = await stream.next();
        assert.equal(mismatch.accepted, false, 'reporting a foreign scope is refused');
        assert.equal(mismatch.reason, 'scope_mismatch');
        socket.destroy();
    } finally {
        broker.close();
    }
}

async function testBrokerBudgetNormalization() {
    const clock = { t: 2_000_000 };
    const broker = createProgressBroker({ listen: true, now: () => clock.t });
    try {
        const { capability } = broker.issueSessionCapability('s-own');
        assert.equal(broker.observeRoot({ sessionId: 's-own', rootId: 'r-own' }), true);
        const socket = await connect(broker.info().endpoint);
        const stream = frames(socket);
        send(socket, { type: 'hello', protocol: PROTOCOL, cap: capability });
        const helloAck = await stream.next();
        const gen = helloAck.rootGeneration;
        assert.ok(gen, 'the session hello returns the current root generation');
        for (const bad of [{ done: 5, total: 3 }, { done: 0, total: 0 }, { done: 0, total: 51 }, { done: -1, total: 3 }, { done: 0.5, total: 3 }]) {
            send(socket, { ...bad, rootGeneration: gen });
            const ack = await stream.next();
            assert.equal(ack.accepted, false, 'an out-of-range report is refused: ' + JSON.stringify(bad));
            assert.equal(ack.reason, 'invalid_report');
            clock.t += 1001; // the per-connection window allows 5 reports per second
        }
        send(socket, { done: 2, total: 3, rootGeneration: gen });
        assert.equal((await stream.next()).accepted, true, 'an in-range report is accepted');
        clock.t += 1001;
        send(socket, { done: 1, total: 3, rootGeneration: gen });
        const decrease = await stream.next();
        assert.equal(decrease.accepted, false, 'done cannot decrease within a plan version');
        assert.equal(decrease.reason, 'progress_decreased');
        clock.t += 1001;
        send(socket, { done: 3, total: 3, rootGeneration: 'stale' });
        const stale = await stream.next();
        assert.equal(stale.accepted, false, 'a report against a stale generation is dropped');
        assert.equal(stale.reason, 'stale_generation');
        socket.destroy();
    } finally {
        broker.close();
    }
}

// --- runner ------------------------------------------------------------------------------------

const cases = [
    ['noTab', testNoTab],
    ['sessionEnrichedOutput', testSessionEnrichedOutput],
    ['tabsEnrichedNoTruncation', testTabsEnrichedNoTruncation],
    ['budgetNormalizationAndTruncation', testBudgetNormalizationAndTruncation],
    ['agentsOwnerIsolation', testAgentsOwnerIsolation],
    ['nativeCapabilityFallback', testNativeCapabilityFallback],
    ['disabledRollbackCommands', testDisabledRollbackCommands],
    ['asciiMode', testAsciiMode],
    ['brokerDisabledRollback', testBrokerDisabledRollback],
    ['brokerOwnerIsolation', testBrokerOwnerIsolation],
    ['brokerBudgetNormalization', testBrokerBudgetNormalization],
];

let failed = 0;
try {
    for (const [name, fn] of cases) {
        try {
            await fn();
            console.log('PASS:', name);
        } catch (error) {
            failed++;
            console.error('FAIL:', name, '-', error.message);
        }
    }
} finally {
    try {
        host.closeProgressBroker();
    } catch {}
    rmSync(home, { recursive: true, force: true });
}
if (failed) {
    console.error(`\nResults: ${cases.length - failed}/${cases.length} passed`);
    process.exit(1);
}
console.log(`\nResults: ${cases.length}/${cases.length} passed`);
console.log('OK progress-channels exit 0');

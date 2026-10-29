// FIX-021: full snapshot contract — every transferred field carries only
// simple contract values; functions/accessors are dropped; unknown values
// get an explicit fallback. Loads the real product source into an isolated VM.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const ISOLATED_ROOT = mkdtempSync(join(tmpdir(), 'ccx-progress-snapshot-contract-'));
process.env.HOME = ISOLATED_ROOT;
process.env.USERPROFILE = ISOLATED_ROOT;
process.env.VANNEVAR_RUNTIME_DIR = join(ISOLATED_ROOT, 'vannevar');
process.env.VANNEVAR_PROFILES_DIR = join(ISOLATED_ROOT, 'profiles');

function loadAdapter() {
    class El {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.className = '';
            this.textContent = '';
            this.dataset = {};
            this.style = {};
        }
        setAttribute() {}
        getAttribute() { return null; }
        appendChild(n) { this.children.push(n); return n; }
        addEventListener() {}
        querySelector() { return null; }
        querySelectorAll() { return []; }
    }
    const pageDocument = {
        body: new El('body'),
        head: new El('head'),
        createElement: (t) => new El(t),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    const pageWindow = {
        document: pageDocument,
        removeEventListener() {},
        getSelection: () => null,
        setTimeout: (fn) => ({ fn }),
        clearTimeout: () => {},
    };
    pageWindow.window = pageWindow;
    pageWindow.addEventListener = () => {};
    const posted = [];
    const pageContext = {
        window: pageWindow,
        document: pageDocument,
        console,
        setTimeout: pageWindow.setTimeout,
        clearTimeout: pageWindow.clearTimeout,
        setInterval: () => ({}),
        clearInterval: () => {},
        navigator: {},
        MutationObserver: class { observe() {} },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({ postMessage: (message) => { posted.push(structuredClone(message)); }, getState: () => ({}), setState() {} }),
    };
    pageContext.globalThis = pageContext;
    vm.createContext(pageContext);
    vm.runInContext(
        readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'),
        pageContext,
    );
    const build = pageContext.buildNormalizedRuntimeSnapshot;
    build.onRegistry = pageWindow.__ccx.onRegistry;
    build.posted = posted;
    return build;
}

const nativeTask = (over = {}) => ({
    toolUseId: 'toolu_1',
    description: 'Implement backend',
    status: 'working',
    startTime: 1791912240000,
    recentTools: ['Read', 'Grep'],
    summary: 'editing host.js',
    usage: { toolUses: 17, totalTokens: 38400, durationMs: 48000 },
    ...over,
});

const session = (over = {}) => ({
    id: 'sess-1',
    runtimeRevision: 0,
    activityHealth: 'healthy',
    providerGeneration: 7,
    taskSnapshots: {},
    subagentTasks: new Map(),
    ...over,
});

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// === providerGeneration — root level ===

test('providerGeneration root: simple number transfers', (build) => {
    const snap = build(session({ id: 'sess-pg-root', providerGeneration: 42 }));
    assert.equal(snap.providerGeneration, 42);
});

test('providerGeneration root: function is dropped to null', (build) => {
    const snap = build(session({ id: 'sess-pg-root-fn', providerGeneration: () => 42 }));
    assert.equal(snap.providerGeneration, null);
});

test('providerGeneration root: reactive accessor returning non-number is dropped to null', (build) => {
    const accessor = { get value() { return 'not-a-number'; } };
    const snap = build(session({ id: 'sess-pg-root-acc', providerGeneration: accessor }));
    assert.equal(snap.providerGeneration, null);
});

test('providerGeneration root: undefined transfers as null', (build) => {
    const snap = build(session({ id: 'sess-pg-root-undef', providerGeneration: undefined }));
    assert.equal(snap.providerGeneration, null);
});

test('providerGeneration root: structuredClone does not throw', (build) => {
    const snap = build(session({ id: 'sess-pg-root-clone', providerGeneration: 42 }));
    assert.doesNotThrow(() => structuredClone(snap));
});

// === execution.providerGeneration ===

test('execution.providerGeneration: simple number transfers', (build) => {
    const snap = build(session({ id: 'sess-ex-pg', providerGeneration: 11 }));
    assert.ok(snap.execution, 'execution must be present');
    assert.equal(snap.execution.providerGeneration, 11);
});

test('execution.providerGeneration: function is dropped to null', (build) => {
    const snap = build(session({ id: 'sess-ex-pg-fn', providerGeneration: () => 11 }));
    assert.ok(snap.execution, 'execution must be present');
    assert.equal(snap.execution.providerGeneration, null);
});

test('execution.providerGeneration: structuredClone does not throw', (build) => {
    const snap = build(session({ id: 'sess-ex-pg-clone', providerGeneration: 11 }));
    assert.doesNotThrow(() => structuredClone(snap));
});

// === execution.servedModelGeneration ===

test('execution.servedModelGeneration: simple number transfers', (build) => {
    const snap = build(session({ id: 'sess-ex-smg', servedModelGeneration: 99 }));
    assert.ok(snap.execution, 'execution must be present');
    assert.equal(snap.execution.servedModelGeneration, 99);
});

test('execution.servedModelGeneration: function is dropped to null', (build) => {
    const snap = build(session({ id: 'sess-ex-smg-fn', servedModelGeneration: () => 99 }));
    assert.ok(snap.execution, 'execution must be present');
    assert.equal(snap.execution.servedModelGeneration, null);
});

test('execution.servedModelGeneration: reactive accessor returning non-number is dropped to null', (build) => {
    const accessor = { get value() { return 'not-a-number'; } };
    const snap = build(session({ id: 'sess-ex-smg-acc', servedModelGeneration: accessor }));
    assert.ok(snap.execution, 'execution must be present');
    assert.equal(snap.execution.servedModelGeneration, null);
});

test('execution.servedModelGeneration: structuredClone does not throw', (build) => {
    const snap = build(session({ id: 'sess-ex-smg-clone', servedModelGeneration: 99 }));
    assert.doesNotThrow(() => structuredClone(snap));
});

// === nativeAgents[].execution.providerGeneration ===

test('native agent execution.providerGeneration: simple number transfers', (build) => {
    const tasks = new Map([['toolu_1', nativeTask({ providerGeneration: 5 })]]);
    const snap = build(session({ id: 'sess-na-pg', providerGeneration: 5, subagentTasks: tasks }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent && agent.execution, 'native agent execution must be present');
    assert.equal(agent.execution.providerGeneration, 5);
});

test('native agent execution.providerGeneration: function at session level is dropped to null', (build) => {
    const tasks = new Map([['toolu_1', nativeTask()]]);
    const snap = build(session({ id: 'sess-na-pg-fn', providerGeneration: () => 5, subagentTasks: tasks }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent && agent.execution, 'native agent execution must be present');
    assert.equal(agent.execution.providerGeneration, null);
});

test('native agent execution.providerGeneration: structuredClone does not throw', (build) => {
    const tasks = new Map([['toolu_1', nativeTask({ providerGeneration: 5 })]]);
    const snap = build(session({ id: 'sess-na-pg-clone', subagentTasks: tasks }));
    assert.doesNotThrow(() => structuredClone(snap));
});

// === nativeAgents[].execution.servedModelGeneration ===

test('native agent execution.servedModelGeneration: simple number transfers', (build) => {
    const tasks = new Map([['toolu_1', nativeTask({ servedModelGeneration: 3 })]]);
    const snap = build(session({ id: 'sess-na-smg', subagentTasks: tasks }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent && agent.execution, 'native agent execution must be present');
    assert.equal(agent.execution.servedModelGeneration, 3);
});

test('native agent execution.servedModelGeneration: function is dropped to null', (build) => {
    const tasks = new Map([['toolu_1', nativeTask({ servedModelGeneration: () => 3 })]]);
    const snap = build(session({ id: 'sess-na-smg-fn', subagentTasks: tasks }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent && agent.execution, 'native agent execution must be present');
    assert.equal(agent.execution.servedModelGeneration, null);
});

test('native agent execution.servedModelGeneration: object/accessor is dropped to null', (build) => {
    const accessor = { get value() { return 3; } };
    const tasks = new Map([['toolu_1', nativeTask({ servedModelGeneration: accessor })]]);
    const snap = build(session({ id: 'sess-na-smg-acc', subagentTasks: tasks }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent && agent.execution, 'native agent execution must be present');
    assert.equal(agent.execution.servedModelGeneration, null);
});

test('native agent execution.servedModelGeneration: structuredClone does not throw', (build) => {
    const tasks = new Map([['toolu_1', nativeTask({ servedModelGeneration: 3 })]]);
    const snap = build(session({ id: 'sess-na-smg-clone', subagentTasks: tasks }));
    assert.doesNotThrow(() => structuredClone(snap));
});

// === reactive signals and structuredClone (as in progress-runtime.test.mjs:133-150) ===

test('reactive accessor in servedModel is dropped without throwing', (build) => {
    const servedModelFn = function () { return this.connection.value?.claudeConfig.value; };
    const snap = build(session({
        id: 'sess-reactive-agent',
        providerGeneration: 7,
        servedModel: servedModelFn,
        servedModelGeneration: 7,
    }));
    assert.doesNotThrow(() => structuredClone(snap));
    assert.equal(snap.execution.servedModel, null);
    assert.equal(snap.execution.servedModelGeneration, 7);
});

test('reactive accessor in recentTools is dropped, strings kept', (build) => {
    const servedModelFn = function () { return this.connection.value?.claudeConfig.value; };
    const tasks = new Map([['toolu_1', nativeTask({ recentTools: ['Read', servedModelFn] })]]);
    const snap = build(session({ id: 'sess-reactive-tools', subagentTasks: tasks }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent, 'native agent must be present');
    assert.equal(agent.recentTools.length, 1);
    assert.equal(agent.recentTools[0], 'Read');
    assert.ok(!agent.recentTools.some((t) => typeof t !== 'string'));
    assert.doesNotThrow(() => structuredClone(snap));
});

// === root times and counters ===

test('root startedAt transfers as number', (build) => {
    const snap = build(session({
        id: 'sess-root-start',
        providerGeneration: 1,
        messages: { value: [{ type: 'user', content: 'hello' }] },
    }));
    assert.ok(snap.root, 'root must be present');
    assert.equal(typeof snap.root.startedAt, 'number');
    assert.doesNotThrow(() => structuredClone(snap));
});

test('root lastActivityAt transfers as number', (build) => {
    const snap = build(session({
        id: 'sess-root-last',
        providerGeneration: 1,
        messages: { value: [{ type: 'user', content: 'hello' }] },
    }));
    assert.ok(snap.root, 'root must be present');
    assert.equal(typeof snap.root.lastActivityAt, 'number');
    assert.doesNotThrow(() => structuredClone(snap));
});

// === runner ---------------------------------------------------------------------------------------
let failed = 0;
try {
    const build = loadAdapter();
    cases.forEach(([name, fn], i) => {
        try {
            fn(build);
            console.log(`ok ${i + 1} - ${name}`);
        } catch (err) {
            failed++;
            console.log(`not ok ${i + 1} - ${name}`);
            console.log(`        ${err && err.message ? err.message : err}`);
        }
    });
    console.log(`${cases.length - failed}/${cases.length} progress-snapshot-contract cases passed`);
} finally {
    rmSync(ISOLATED_ROOT, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

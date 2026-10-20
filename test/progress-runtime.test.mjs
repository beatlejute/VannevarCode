// QA-001: the normalized runtime snapshot adapter (`buildNormalizedRuntimeSnapshot` in
// runtime/webview.js) is exercised here against the real product source, loaded into an isolated
// VM — no copy of the product and no simulation of its behaviour. Required cases come from
// PLAN-001 task 3: root lifecycle, synthetic message skip, revision ordering, activityHealth,
// currentTool, native title/start/generation pinning, served-model invalidation, retention.
//
// Isolation follows PLAN-001 "Test hygiene": a unique temp root, redirected HOME/USERPROFILE/runtime
// paths, and teardown in `finally`. The real ~/.claude is never read or written.
//
// Run: node test/progress-runtime.test.mjs

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const ISOLATED_ROOT = mkdtempSync(join(tmpdir(), 'ccx-progress-runtime-'));
process.env.HOME = ISOLATED_ROOT;
process.env.USERPROFILE = ISOLATED_ROOT;
process.env.VANNEVAR_RUNTIME_DIR = join(ISOLATED_ROOT, 'vannevar');
process.env.VANNEVAR_PROFILES_DIR = join(ISOLATED_ROOT, 'profiles');

// --- the page, minimally mocked, exactly as runtime/webview.js expects on load --------------------
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

// --- fixtures built from the shapes the page really receives --------------------------------------
// A native task entry as `subagentTasks` holds it (runtime/webview.js:1605-1629, :1841-1894).
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

test('snapshot transport excludes callable config values and reads modelSelection', (build) => {
    const config = () => { throw new Error('config accessor must not be invoked'); };
    const snap = build(session({
        id: 'sess-callable-config',
        messages: { value: [{ type: 'user', content: 'check progress' }] },
        model: config,
        modelSelection: { value: 'sonnet' },
    }));
    assert.doesNotThrow(() => structuredClone(snap));
    assert.equal(snap.execution.requestedModel, 'sonnet');
});

test('task snapshots do not transport live session objects', (build) => {
    const task = nativeTask({ session: { claudeConfig: { x: () => ({}) } } });
    const snap = build(session({ id: 'sess-live-task', subagentTasks: new Map([['a', task]]), taskSnapshots: { a: task } }));
    assert.doesNotThrow(() => structuredClone(snap));
    assert.equal(snap.taskSnapshots.a.session, undefined);
    assert.equal(snap.taskSnapshots.a.toolUseId, task.toolUseId);
});

test('session identity unwraps a signal without transporting its reactive graph', (build) => {
    const signal = { v: 'sess-reactive', dependency: { x: () => ({}) } };
    Object.defineProperty(signal, 'value', { get() { return this.v; } });
    const snap = build(session({ id: undefined, sessionId: signal,
        messages: { value: [{ type: 'user', content: 'real signal' }] } }));
    assert.doesNotThrow(() => structuredClone(snap));
    assert.equal(snap.sessionId, 'sess-reactive');
    assert.equal(snap.root.sessionId, 'sess-reactive');
});

test('registry mount transports only the session identity, not a signal graph', (build) => {
    const signal = { dependency: { x: () => ({}) } };
    Object.defineProperty(signal, 'value', { get() { return 'sess-mounted'; } });
    assert.doesNotThrow(() => build.onRegistry(null, null, session({ id: undefined, sessionId: signal })));
    assert.ok(build.posted.some((message) => message.type === 'ccx:session' && message.sessionId === 'sess-mounted'));
});

test('SDK message envelopes create a root and expose the running tool', (build) => {
    const snap = build(session({ id: 'sess-sdk-envelope', busy: { value: true }, messages: { value: [
        { type: 'user', uuid: 'user-envelope', message: { role: 'user', content: 'check progress' } },
        { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-envelope', name: 'Bash' }] } },
    ] } }));
    assert.ok(snap.root, 'SDK message.content must create the root');
    assert.equal(snap.root.title, 'check progress');
    assert.equal(snap.root.currentTool, 'Bash');
    assert.equal(snap.root.state, 'running');
});

test('nested and internal user turns preserve root and semantic identity', (build) => {
    const rootTurn = { type: 'user', uuid: 'root-owner', content: 'Root request' };
    const source = session({ id: 'sess-nested', busy: true, messages: [rootTurn] });
    const first = build(source);
    const semanticByRoot = new Map([[first.root.rootId, { done: 1, total: 3 }]]);
    const excluded = [
        { parentToolUseId: 'child' }, { sdkParentToolUseId: 'child' }, { parent_tool_use_id: 'child' },
        { notAPrompt: true }, { isInternal: true }, { internal: true },
        { isMeta: true }, { isSynthetic: true }, { synthetic: true },
    ];
    for (const [index, flags] of excluded.entries()) {
        source.messages.push({ type: 'user', uuid: `excluded-${index}`, message: { content: 'Nested feedback' }, ...flags });
        const next = build(source);
        assert.equal(next.root.rootId, first.root.rootId);
        assert.equal(next.root.startedAt, first.root.startedAt);
        assert.equal(next.root.title, 'Root request');
        assert.equal(semanticByRoot.get(next.root.rootId).done, 1);
    }
    source.messages.push({ type: 'user', uuid: 'next-root', content: 'Next request', parent_tool_use_id: null });
    assert.equal(build(source).root.rootId, 'next-root');
});

test('task notifications do not replace the human root, but mixed human text does', (build) => {
    const source = session({ id: 'sess-notification-title', busy: true, messages: [
        { type: 'user', uuid: 'human-root', content: 'Original request' },
    ] });
    const original = build(source).root;
    source.messages.push({ type: 'user', uuid: 'plain-notification', content:
        '<task-notification>Task completed</task-notification>' });
    let root = build(source).root;
    assert.equal(root.rootId, original.rootId);
    assert.equal(root.title, 'Original request');

    source.messages.push({ type: 'user', uuid: 'wrapped-notification', content:
        '<system-reminder>Internal notice</system-reminder>\n<task-notification>Task completed</task-notification>' });
    root = build(source).root;
    assert.equal(root.rootId, original.rootId);
    assert.equal(root.title, 'Original request');

    source.messages.push({ type: 'user', uuid: 'mixed-human-request', content:
        '<system-reminder>Internal notice</system-reminder>\nImplement the requested change' });
    root = build(source).root;
    assert.equal(root.rootId, 'mixed-human-request');
    assert.equal(root.title, 'Implement the requested change');

    source.messages.push({ type: 'user', uuid: 'tag-discussion', content:
        'Please explain the <task-notification> markup.' });
    root = build(source).root;
    assert.equal(root.rootId, 'tag-discussion');
    assert.equal(root.title, 'Please explain the <task-notification> markup.');
});

test('rendered message text wrappers create a root', (build) => {
    const snap = build(session({ id: 'sess-rendered-wrapper', busy: { value: true }, messages: { value: [
        { type: 'user', uuid: 'wrapped-user', content: [{ content: { type: 'text', text: 'check wrapped progress' } }] },
    ] } }));
    assert.ok(snap.root);
    assert.equal(snap.root.title, 'check wrapped progress');
});

test('adapter buildNormalizedRuntimeSnapshot is exposed by runtime/webview.js', (build) => {
    assert.equal(typeof build, 'function');
});

test('1. a real user turn creates a new root', (build) => {
    const snap = build(session({ id: 'sess-real', messages: { value: [{ type: 'user', content: 'do the thing' }] } }));
    assert.ok(snap && snap.root, 'snapshot must carry a root task object for a real user turn');
    assert.equal(snap.root.rootId, 'sess-real');
});

test('2. a synthetic/internal message creates no root', (build) => {
    const snap = build(session({ id: 'sess-synth', messages: { value: [{ type: 'user', isMeta: true, content: 'tool feedback' }] } }));
    const rootId = snap && snap.root ? snap.root.rootId : (snap ? snap.rootLifecycle : undefined);
    assert.equal(rootId == null ? null : rootId, null, 'a synthetic turn must not open a root');
});

test('3. runtimeRevision is monotonic per session', (build) => {
    const s = session({ id: 'sess-rev', runtimeRevision: 0 });
    const first = build(s);
    const second = build(s);
    assert.ok(
        second.runtimeRevision > first.runtimeRevision,
        `revision must advance per session: ${first.runtimeRevision} -> ${second.runtimeRevision}`,
    );
});

test('4. "stale" belongs to activityHealth, never to RuntimeState', (build) => {
    const validState = ['starting', 'running', 'cancelling', 'done', 'failed', 'stopped', 'unknown'];
    const snap = build(session({ id: 'sess-h', activityHealth: 'stale' }));
    assert.equal(snap.activityHealth, 'stale', 'activityHealth keeps the staleness signal');
    assert.ok(
        validState.includes(snap.state),
        `runtime state must be one of ${validState.join('/')}, got ${JSON.stringify(snap.state)}`,
    );
});

test('5. currentTool is null while thinking and names the running tool', (build) => {
    const thinking = build(session({ id: 'sess-t', messages: { value: [{ type: 'user', content: 'go' }] } }));
    assert.equal(thinking.currentTool, null, 'no tool call => currentTool null');
    const running = build(session({
        id: 'sess-t',
        messages: { value: [{ type: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash' }] }] },
    }));
    assert.equal(running.currentTool, 'Bash', 'an in-flight tool call must be reported');
});

test('6. native title comes from subagentTasks.description, fallback "Agent"', (build) => {
    const named = build(session({ id: 'sess-n', subagentTasks: new Map([['toolu_1', nativeTask()]]) }));
    const agents = (named && named.nativeAgents) || [];
    assert.equal(agents.length, 1, `expected 1 native agent, got ${agents.length}`);
    assert.equal(agents[0].title, 'Implement backend');
    const unnamed = build(session({
        id: 'sess-n2',
        subagentTasks: new Map([['toolu_2', nativeTask({ toolUseId: 'toolu_2', description: undefined })]]),
    }));
    assert.equal(((unnamed && unnamed.nativeAgents) || [])[0] && unnamed.nativeAgents[0].title, 'Agent');
});

test('7. native startedAt comes from the task source', (build) => {
    const started = 1791912240000;
    const snap = build(session({ id: 'sess-s', subagentTasks: new Map([['toolu_1', nativeTask({ startTime: started })]]) }));
    const agent = ((snap && snap.nativeAgents) || [])[0];
    assert.ok(agent, 'native agent must be present');
    assert.equal(agent.startedAt, started);
});

test('8. native providerGeneration is pinned at first observation', (build) => {
    const tasks = new Map([['toolu_1', nativeTask()]]);
    const first = ((build(session({ id: 'sess-g', providerGeneration: 7, subagentTasks: tasks })) || {}).nativeAgents || [])[0];
    assert.ok(first && first.execution, 'native agent must carry execution identity');
    assert.equal(first.execution.providerGeneration, 7);
    const later = ((build(session({ id: 'sess-g', providerGeneration: 8, subagentTasks: tasks })) || {}).nativeAgents || [])[0];
    assert.equal(later.execution.providerGeneration, 7, 'a root switch must not rewrite the pinned child generation');
});

test('9. a root provider switch invalidates a stale served model', (build) => {
    const before = build(session({ id: 'sess-p', providerGeneration: 7, servedModel: 'GLM-5.3' }));
    assert.ok(before.execution, 'root execution identity must be present');
    assert.equal(before.execution.servedModel, 'GLM-5.3');
    const after = build(session({ id: 'sess-p', providerGeneration: 8, servedModel: 'GLM-5.3' }));
    assert.equal(after.execution.servedModel, null, 'the previous generation served model is stale');
});

test('10. native served model is compared against the child generation', (build) => {
    const tasks = new Map([['toolu_1', nativeTask({ servedModel: 'GLM-5.3', servedModelGeneration: 7 })]])
    const stale = ((build(session({ id: 'sess-c', providerGeneration: 7, subagentTasks: tasks })) || {}).nativeAgents || [])[0];
    assert.ok(stale && stale.execution, 'native execution identity must be present');
    const switched = ((build(session({ id: 'sess-c', providerGeneration: 8, subagentTasks: tasks })) || {}).nativeAgents || [])[0];
    assert.equal(switched.execution.servedModel, 'GLM-5.3', 'child generation still matches its served model');
});

test('11. snapshot retention keeps the active run plus at most 100 terminal runs', (build) => {
    const snapshots = {};
    for (let i = 0; i < 150; i++) snapshots['done-' + i] = nativeTask({ toolUseId: 'done-' + i, status: 'completed' });
    snapshots['active'] = nativeTask({ toolUseId: 'active', status: 'working' });
    const snap = build(session({ id: 'sess-r', taskSnapshots: snapshots }));
    const keys = Object.keys(snap.taskSnapshots || {});
    assert.ok(keys.includes('active'), 'the active run must survive retention');
    assert.equal(keys.length, 101, `active + 100 terminal runs are kept, got ${keys.length}`);
});

// --- runner ---------------------------------------------------------------------------------------
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
    console.log(`${cases.length - failed}/${cases.length} progress-runtime adapter cases passed`);
} finally {
    rmSync(ISOLATED_ROOT, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;

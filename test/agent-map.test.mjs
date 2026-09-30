// Claude Code's agent map lists the tab's own subagents; a run started through run_agent is not one
// of them, so it never appeared there. Three pieces put it there, and each is checked here:
//
//   1. the MCP server records what the map needs — whose session started the run, a short label,
//      foreground or background — and ends a run when the map asks it to;
//   2. host.js adds what only the run's transcript knows (the model that answered, the context, the
//      tool count), hands the transcript over for "Open transcript", and turns "Stop agent" into a
//      request the server picks up;
//   3. the page writes the runs into the session's `agentMapAgents` Map — beside the app's own
//      entries, put back when the app rewrites the Map, never written twice for nothing — and routes
//      the card's two buttons for its own ids to the host instead of the CLI.
//
//   node test/agent-map.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-map-${process.pid}`);
const profiles = join(home, '.claude', 'profiles');
const runtime = join(home, '.claude', 'vannevar');
const slug = join(home, '.claude', 'projects', 'c--somewhere');
for (const d of [profiles, runtime, slug]) mkdirSync(d, { recursive: true });
writeFileSync(join(profiles, 'claude.json'), JSON.stringify({ env: {} }));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.VANNEVAR_PROFILES_DIR = profiles;
process.env.VANNEVAR_RUNTIME_DIR = runtime;
process.env.CLAUDE_CODE_SESSION_ID = '99999999-1111-2222-3333-444444444444';

const { prepare, execute, TOOLS } = await import('../runtime/mcp/agent-server.mjs');

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-map-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
let host;
try {
    host = require(copy);
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
}
const { agentRunsPayload, agentTranscript, requestAgentStop } = host;
assert.ok(typeof agentTranscript === 'function' && typeof requestAgentStop === 'function', 'host.js must expose both map requests');

const runsDir = join(runtime, 'agent-runs');
const manifestOf = (id) => JSON.parse(readFileSync(join(runsDir, `${id}.json`), 'utf8'));

// --- 1. the manifest, and a stop the map asked for ---------------------------------------------

const schema = TOOLS.find((t) => t.name === 'run_agent').inputSchema;
assert.ok(schema.properties.description, 'run_agent takes a label for the map, or additionalProperties refuses it');
assert.ok(!schema.required.includes('description'), 'and it stays optional');

// A real child that would run for a minute: the stop is what ends it, not the child finishing.
const ctx = await prepare({ profile: 'claude', prompt: 'take your time', description: '  Slow probe  ', background: true });
assert.equal(ctx.description, 'Slow probe', 'the label is trimmed');
ctx.bin = process.execPath;
ctx.args = ['-e', 'setTimeout(() => {}, 60000)'];
const task = { stopped: false, child: null };
const settled = execute(ctx, task).then(
    () => null,
    (e) => e,
);

const live = manifestOf(ctx.liveSession);
assert.equal(live.state, 'running');
assert.equal(live.owner, '99999999-1111-2222-3333-444444444444', "the owner is the session of the CLI that spawned this server");
assert.equal(live.description, 'Slow probe');
assert.equal(live.background, true, 'a run started for a background task says so');

assert.equal(requestAgentStop('not-a-session').ok, false, 'an id that is not a session is refused');
assert.equal(requestAgentStop('00000000-1111-2222-3333-444444444444').ok, false, 'so is a run with no manifest');
assert.equal(requestAgentStop(ctx.liveSession).ok, true, 'a running run is asked to stop');
assert.ok(existsSync(join(runsDir, `${ctx.liveSession}.stop`)), 'the request is a file beside the manifest');

const stopped = await Promise.race([settled, new Promise((r) => setTimeout(() => r('timeout'), 15000))]);
assert.notEqual(stopped, 'timeout', 'the server did not act on the stop request');
assert.match(String(stopped && stopped.message), /stopped by the user/, 'the calling agent is told the user stopped it');
assert.equal(task.stopped, true, 'a background task is marked stopped, as stop_agent marks it');
assert.equal(manifestOf(ctx.liveSession).state, 'stopped', 'and the manifest says so, which is what the map then shows');
assert.ok(!existsSync(join(runsDir, `${ctx.liveSession}.stop`)), 'the request is consumed, so a resumed run is not stopped by it');
assert.equal(requestAgentStop(ctx.liveSession).ok, false, 'a run that has ended cannot be asked again');

// --- 2. what the host adds from the transcript --------------------------------------------------

const transcript = join(slug, `${ctx.liveSession}.jsonl`);
const line = (o) => JSON.stringify(o) + '\n';
writeFileSync(
    transcript,
    line({ type: 'user', uuid: 'u1', timestamp: '2026-09-29T10:00:00Z', message: { role: 'user', content: 'take your time' } }) +
        line({ type: 'user', uuid: 'u0', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: '<caveat>' }] } }) +
        line({
            type: 'assistant',
            uuid: 'a1',
            message: {
                id: 'msg_1',
                model: 'deepseek-v4-pro',
                role: 'assistant',
                content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.js' } }],
                usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 },
            },
        }) +
        line({ type: 'assistant', uuid: 's1', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'side' }] } }) +
        line({ type: 'system', uuid: 'x1', content: 'not a message' }) +
        line({
            type: 'assistant',
            uuid: 'a2',
            message: {
                id: 'msg_2',
                model: '<synthetic>',
                role: 'assistant',
                content: [{ type: 'text', text: 'all done' }],
            },
        }),
);

const run = agentRunsPayload().find((r) => r.session === ctx.liveSession);
assert.equal(run.servedModel, 'deepseek-v4-pro', 'the model that answered, not a synthetic placeholder after it');
assert.equal(run.contextTokens, 3250, "the context is the last turn's input, cache and output — Claude Code's own measure");
assert.equal(run.toolUses, 1);
assert.equal(run.owner, '99999999-1111-2222-3333-444444444444');
assert.equal(run.description, 'Slow probe');
assert.equal(run.background, true);

const read = agentTranscript(ctx.liveSession);
assert.equal(read.ok, true);
assert.deepStrictEqual(
    read.messages.map((m) => `${m.type}:${m.uuid}`),
    ['user:u1', 'user:u0', 'assistant:a1', 'assistant:a2'],
    'user and assistant turns only, sidechains left out',
);
assert.equal(read.messages[1].is_meta, true, 'a meta turn is marked the way the SDK marks it, so the dialog hides it');
assert.equal(read.messages[0].parent_tool_use_id, null, 'every message is a top-level turn of that run');
assert.equal(agentTranscript('00000000-1111-2222-3333-444444444444').ok, false, 'a run with no transcript says so');

// --- 3. the page -------------------------------------------------------------------------------

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
let onMessage = null;
pageWindow.addEventListener = (type, fn) => {
    if (type === 'message') onMessage = fn;
};
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
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
pageContext.globalThis = pageContext;
vm.createContext(pageContext);
vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), pageContext);
const fromHost = (m) => onMessage({ data: m });

// The session as the app builds it: signals read through .value, one of them the agent map's Map.
const native = { taskId: 'a1b2c3', toolUseId: 'toolu_native', parentToolUseId: null, description: 'Native one', status: 'working' };
let mapValue = new Map([[native.taskId, native]]);
let writes = 0;
const agentMapAgents = {
    get value() {
        return mapValue;
    },
    set value(v) {
        writes++;
        mapValue = v;
    },
};
const stockCalls = [];
const call = (id, input, extra = {}) => ({
    type: 'assistant',
    createdAt: extra.at ?? Date.now() - 10000,
    sdkParentToolUseId: extra.parent,
    content: [
        {
            content: { type: 'tool_use', id, name: 'mcp__vannevar-agents__run_agent', input },
            toolResult: { value: extra.result },
        },
    ],
});
const messages = {
    value: [
        call('toolu_live', { profile: 'deepseek', prompt: 'review src/host.js\nthen report', description: 'Review host' }),
        call('toolu_under_native', { profile: 'codex', prompt: 'count the tests' }, { parent: 'toolu_native' }),
        // A call whose run is long gone: the result is all that is left of it.
        call(
            'toolu_old',
            { profile: 'gemini', prompt: 'an old question', model: 'opus' },
            {
                at: Date.now() - 86400000,
                result: {
                    type: 'tool_result',
                    content: [
                        {
                            type: 'text',
                            text: 'the old answer\n\n---\nprofile: gemini · mode: read\nsession: 12345678-aaaa-bbbb-cccc-1234567890ab · continue it with run_agent({ session: "12345678-aaaa-bbbb-cccc-1234567890ab", prompt: … })',
                        },
                    ],
                },
            },
        ),
    ],
};
const session = {
    messages,
    busy: { value: true },
    sessionId: { value: 'tab00000-1111-2222-3333-444444444444' },
    subagentTasks: { value: new Map() },
    agentMapAgents,
    getSubagentTranscript(id) {
        stockCalls.push(['transcript', id]);
        return Promise.resolve(['stock']);
    },
    stopSubagent(id) {
        stockCalls.push(['stop', id]);
        return Promise.resolve();
    },
};
pageContext.window.__ccx.onRegistry(null, null, session);

const now = Date.now();
const liveRun = {
    session: 'aaaaaaaa-1111-2222-3333-444444444444',
    parent: null,
    owner: 'tab00000-1111-2222-3333-444444444444',
    description: 'Review host',
    profile: 'deepseek',
    model: 'sonnet',
    servedModel: 'deepseek-v4-pro',
    contextTokens: 41000,
    toolUses: 7,
    prompt: 'review src/host.js\nthen report',
    state: 'running',
    startedAt: now - 5000,
    events: [{ k: 'text', t: 'reading' }],
};
const underNative = { ...liveRun, session: 'bbbbbbbb-1111-2222-3333-444444444444', description: null, profile: 'codex', prompt: 'count the tests' };
// Started by a subagent whose turns never reach this page: no call here explains it, the owner does.
const orphan = { ...liveRun, session: 'cccccccc-1111-2222-3333-444444444444', description: 'From a task', prompt: 'something a task asked' };
// Started by the orphan in its turn.
const nested = { ...liveRun, session: 'dddddddd-1111-2222-3333-444444444444', parent: orphan.session, owner: orphan.session, description: 'Nested' };
// Another tab's run: neither a call here nor this tab's owner.
const foreign = { ...liveRun, session: 'eeeeeeee-1111-2222-3333-444444444444', owner: 'other000-1111-2222-3333-444444444444', prompt: 'not ours' };

fromHost({ type: 'ccx:agentRuns', runs: [liveRun, underNative, orphan, nested, foreign] });

const entry = (taskId) => mapValue.get(taskId);
assert.equal(entry('a1b2c3'), native, "the app's own entries are kept, as the same objects");
const mine = entry('ccx:toolu_live');
assert.ok(mine, 'a run_agent call with a live run gets an entry, keyed by its call');
assert.equal(mine.toolUseId, 'toolu_live', 'the tool_use id is what the map selects an agent by');
assert.equal(mine.parentToolUseId, null, 'a call the main agent made sits at the top');
assert.equal(mine.description, 'deepseek · Review host', 'the row names the provider and the label');
assert.equal(mine.status, 'working');
assert.equal(mine.subagentType, 'deepseek-v4-pro', 'the card names the model that answered, not the alias');
assert.equal(mine.usage.totalTokens, 41000);
assert.equal(mine.startTime, liveRun.startedAt);
assert.equal(mine.endTime, undefined, 'a working run has no end yet');

assert.equal(entry('ccx:toolu_under_native').parentToolUseId, 'toolu_native', 'a call a subagent made hangs under that subagent');
assert.equal(entry('ccx:toolu_under_native').description, 'codex · count the tests', 'with no label the first line of the prompt stands in');

const orphanEntry = entry('ccx:run:' + orphan.session);
assert.ok(orphanEntry, "a run this tab's session owns is shown even with no call to explain it");
assert.equal(orphanEntry.parentToolUseId, null);
assert.equal(entry('ccx:run:' + nested.session).parentToolUseId, orphanEntry.toolUseId, 'a nested run hangs under the run that started it');
assert.ok(![...mapValue.keys()].some((k) => k.includes(foreign.session)), "another tab's run is not this tab's agent");

const old = entry('ccx:toolu_old');
assert.equal(old.status, 'finished', 'a call with no run left is built from its result');
assert.equal(old.result, 'the old answer', "the answer, without the server's report under it");
assert.equal(old.ccxSession, '12345678-aaaa-bbbb-cccc-1234567890ab', 'the report still names the transcript');
assert.equal(old.subagentType, 'opus');

// Nothing changed, nothing written: a write re-renders, and a re-render is the next pass.
const before = writes;
fromHost({ type: 'ccx:agentRuns', runs: [liveRun, underNative, orphan, nested, foreign] });
fromHost({ type: 'ccx:state' });
assert.equal(writes, before, 'an intact map is left alone');

// The app rebuilds the Map from the transcript when a session loads — ours go, and come back.
mapValue = new Map([[native.taskId, native]]);
fromHost({ type: 'ccx:agentRuns', runs: [liveRun, underNative, orphan, nested, foreign] });
assert.equal(entry('ccx:toolu_live'), mine, 'a rebuilt map gets the same entries back');
assert.equal(entry('a1b2c3'), native);

// The app marks every working entry stopped when the tab's process ends — ours are not the app's to stop.
mapValue = new Map([...mapValue].map(([k, v]) => [k, k.startsWith('ccx:') ? { ...v, status: 'stopped' } : v]));
fromHost({ type: 'ccx:agentRuns', runs: [liveRun, underNative, orphan, nested, foreign] });
assert.equal(entry('ccx:toolu_live').status, 'working', 'a run still going reads as going');

// The run ends: its entry says so, with the last thing it said as the result.
const doneRun = { ...liveRun, state: 'done', finishedAt: now, events: [{ k: 'text', t: 'reading' }, { k: 'tool', n: 'Read' }, { k: 'text', t: 'three bugs' }] };
fromHost({ type: 'ccx:agentRuns', runs: [doneRun, underNative] });
const done = entry('ccx:toolu_live');
assert.equal(done.status, 'finished');
assert.equal(done.result, 'three bugs');
assert.equal(done.endTime, now);
assert.equal(done.usage.durationMs, 5000);
assert.ok(!entry('ccx:run:' + orphan.session), 'a run whose manifest is gone and that no call explains leaves the map');
fromHost({ type: 'ccx:agentRuns', runs: [{ ...liveRun, state: 'timeout', finishedAt: now, error: null }] });
assert.equal(entry('ccx:toolu_live').status, 'failed', 'a run killed on its timeout failed');
assert.match(entry('ccx:toolu_live').error, /time ran out/);

// --- the card's buttons ----------------------------------------------------------------------------

fromHost({ type: 'ccx:agentRuns', runs: [liveRun, underNative, orphan, nested] });

const stock = await session.getSubagentTranscript('a1b2c3');
assert.deepStrictEqual(stock, ['stock'], "the app's own agents still go the app's way");
assert.deepStrictEqual(stockCalls, [['transcript', 'a1b2c3']]);

const pending = session.getSubagentTranscript('ccx:toolu_live');
const asked = posted.filter((m) => m.type === 'ccx:agentTranscript');
assert.equal(asked.length, 1, 'ours asks the host instead');
assert.equal(asked[0].session, liveRun.session, 'for the transcript of the run behind the call');
fromHost({ type: 'ccx:agentReply', seq: asked[0].seq, ok: true, messages: [{ type: 'user', uuid: 'u1' }] });
assert.deepStrictEqual(
    (await pending).map((m) => m.uuid),
    ['u1'],
    'and hands the dialog the messages it got back',
);

const fromOld = session.getSubagentTranscript('ccx:toolu_old');
assert.equal(posted.at(-1).session, '12345678-aaaa-bbbb-cccc-1234567890ab', 'a call with no run left still opens the session its report names');
fromHost({ type: 'ccx:agentReply', seq: posted.at(-1).seq, ok: false, error: 'this run left no transcript' });
await assert.rejects(fromOld, /no transcript/, 'a failure reaches the dialog, which words it and still shows the prompt');

const stopping = session.stopSubagent('ccx:toolu_live');
const stopAsk = posted.at(-1);
assert.equal(stopAsk.type, 'ccx:stopAgent');
assert.equal(stopAsk.session, liveRun.session);
fromHost({ type: 'ccx:agentReply', seq: stopAsk.seq, ok: true });
await stopping;

const sent = posted.length;
await assert.rejects(session.stopSubagent('ccx:toolu_old'), /not running/, 'a finished run cannot be stopped');
assert.equal(posted.length, sent, 'and nothing is asked of the host for it');
assert.equal(stockCalls.length, 1, 'none of this reached the CLI');

// From 2.1.285 the dialog reads a transcript in pages: the stock method takes a cursor and resolves
// to { frames, from }, and the dialog destructures it. A bare array there leaves it on "Loading…".
const paged = {
    messages,
    busy: { value: true },
    sessionId: { value: 'tab00000-1111-2222-3333-444444444444' },
    subagentTasks: { value: new Map() },
    agentMapAgents,
    getSubagentTranscript(id, after) {
        return Promise.resolve({ frames: ['stock'], ...(after !== undefined && { from: after.count }) });
    },
    stopSubagent() {
        return Promise.resolve();
    },
};
pageContext.window.__ccx.onRegistry(null, null, paged);
fromHost({ type: 'ccx:agentRuns', runs: [liveRun] });
assert.deepStrictEqual(await paged.getSubagentTranscript('a1b2c3'), { frames: ['stock'] }, "the app's own agents still get the app's answer");
const framed = paged.getSubagentTranscript('ccx:toolu_live', { count: 1, uuid: 'u1' });
const framedAsk = posted.at(-1);
assert.equal(framedAsk.type, 'ccx:agentTranscript', 'ours still asks the host');
fromHost({ type: 'ccx:agentReply', seq: framedAsk.seq, ok: true, messages: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }] });
const { frames, from } = await framed;
assert.deepStrictEqual(frames.map((m) => m.uuid), ['u1', 'a1'], 'and answers in the shape this release reads');
assert.equal(from, undefined, 'claiming no cursor, so the dialog keeps only the frames it has not drawn yet');

// A session without an agent map (an older Claude Code) is left exactly as it was.
const bare = { messages, sessionId: { value: 'x' } };
pageContext.window.__ccx.onRegistry(null, null, bare);
fromHost({ type: 'ccx:agentRuns', runs: [liveRun] });
assert.deepStrictEqual(Object.keys(bare), ['messages', 'sessionId'], 'nothing is added to a session that has no map');

console.log('OK — delegated runs sit in the agent map beside the app’s own, and its buttons reach them');

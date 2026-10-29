import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { ProgressClient } from '../runtime/mcp/progress-client.mjs';

const require = createRequire(import.meta.url);
const { createProgressBroker } = require('../runtime/progress-broker.js');
const { createNativeProgressBridge, bindNativeProducer, observeNativeFrame } = require('../runtime/native-progress.js');
const patcher = readFileSync(new URL('../runtime/apply-patch.mjs', import.meta.url), 'utf8');
// Read the actual patch records, not a test's independent copy of their replacements.
const patchContext = vm.createContext({ require, console });
vm.runInContext(patcher.slice(patcher.indexOf('const HOST_REQUIRE'), patcher.indexOf('// Things the injected code drives')) +
    '\nglobalThis.patches = PATCHES;', patchContext);
const rawPatch = patchContext.patches.find((p) => p.find.source.includes('async readMessages'));
const queryPatch = patchContext.patches.find((p) => p.find.source.includes('trackClaudeProcess'));
assert.ok(rawPatch && queryPatch);
// Level B signature checks require an explicit pristine input, not home discovery.
const bundleDir = process.env.VANNEVAR_TEST_BUNDLE_DIR;
if (bundleDir) assert.ok(path.isAbsolute(bundleDir), 'VANNEVAR_TEST_BUNDLE_DIR must be an absolute pristine bundle path');
const installed = bundleDir ? readFileSync(path.join(bundleDir, 'extension.js'), 'utf8') : null;
// Exercise the patch contract even on clean runners with no editor installation.
const fixtureReader = 'async readMessages(){try{for await(let frame of this.transport.readMessages()){if(frame.type==="control_request"){this.handleControlRequest(frame);continue}this.inputStream.enqueue(frame)}this.inputStream.done();this.cleanup()}catch(error){this.inputStream.error(error)}}';
const fixtureQuery = 'let query=(await factory({options:options})).query(input);return this.trackClaudeProcess(query),query';
const source = installed || fixtureReader + 'async handleControlRequest(){}' + fixtureQuery;
assert.equal([...source.matchAll(new RegExp(rawPatch.find.source, 'g'))].length, 1);
assert.equal([...source.matchAll(new RegExp(queryPatch.find.source, 'g'))].length, 1);
assert.match(source.replace(queryPatch.find, queryPatch.replace), /bindNativeProducer\(/);
const patched = source.replace(rawPatch.find, rawPatch.replace);
const start = patched.indexOf('async readMessages(){try{for await');
const end = patched.indexOf('async handleControlRequest(', start);
assert.ok(start >= 0 && end > start);
const method = patched.slice(start, end);
if (process.env.VANNEVAR_TEST_INSTALLED_READER === '1') assert.ok(installed, 'explicit installed-reader verification requires the editor bundle');
if (!installed) console.log('SKIP installed signature comparison: editor bundle absent; repository transport and query fixtures verified');
const hostApi = { observeNativeFrame };
const fakeRequire = (id) => id.endsWith('host.js') ? hostApi : require(id);
// Executing the installed bundle requires separate permission. The default suite
// executes only this repository-owned transport fixture with the actual patch.
const localReader = 'async readMessages(){try{for await(let frame of this.transport.readMessages()){if(frame.type==="control_request"){this.handleControlRequest(frame);continue}this.inputStream.enqueue(frame)}this.inputStream.done();this.cleanup()}catch(error){this.inputStream.error(error)}}';
const executableMethod = process.env.VANNEVAR_TEST_INSTALLED_READER === '1' ? method : localReader.replace(rawPatch.find, rawPatch.replace);
const Reader = vm.runInNewContext('(class {' + executableMethod + '})', { require: fakeRequire, console });
if (process.env.VANNEVAR_TEST_INSTALLED_READER !== '1') console.log('SKIP installed reader execution: requires explicit external-source execution permission; installed signatures checked statically');

const broker = createProgressBroker();
const clients = [];
const ownerSession = 'owner';
const cap = broker.issueSessionCapability(ownerSession).capability;
broker.observeRoot({ sessionId: ownerSession, rootId: 'real-root', generation: 'generation' });
const client = (credentials) => { const c = new ProgressClient(credentials); clients.push(c); return c; };
const sessionClient = client({ ...broker.info(), capability: cap });
const bridge = createNativeProgressBridge({ broker, ownerSession, createClient: client });
broker.setNativeClassifier(ownerSession, bridge.classify);
const controls = [];
const publicQueue = [];
const task = { type: 'system', subtype: 'task_started', session_id: ownerSession,
    task_id: 'child', run_id: 'initial', tool_use_id: 'agent-invocation' };
const input = (id, agentId) => ({ hook_event_name: 'PreToolUse', session_id: ownerSession,
    tool_name: 'mcp__vannevar__progress', tool_use_id: id, ...(agentId ? { agent_id: agentId } : {}),
    tool_input: { done: 0, total: 2, title: 'Native task', plan: ['Read', 'Implement'] } });
const pre = input('child-progress', 'child');
const reader = new Reader();
reader.transport = { async *readMessages() {
    yield task;
    yield { type: 'control_request', request: { subtype: 'hook_callback', input: pre } };
} };
reader.handleControlRequest = (frame) => { controls.push(frame); bridge.pre(frame.request.input, pre.tool_use_id); };
reader.inputStream = { enqueue: (frame) => publicQueue.push(frame), done() {}, error(error) { throw error; } };
reader.cleanup = () => {};
bindNativeProducer(reader, bridge);
try {
    await reader.readMessages();
    assert.equal(controls.length, 1);
    assert.equal(publicQueue.length, 1, 'no public iterator consumption was needed for attribution');
    // Real CLI metadata is claudecode/toolUseId, outside model arguments.
    const metadata = { 'claudecode/toolUseId': pre.tool_use_id };
    const pending = await sessionClient.report({ ...pre.tool_input, engine: 'claudecode', toolUseId: metadata['claudecode/toolUseId'] });
    assert.equal(pending.accepted, true);
    assert.equal(broker.snapshot(ownerSession).root.semantic, null, 'child MCP must not write root');
    assert.deepEqual(broker.snapshot(ownerSession).semanticByScope, {}, 'no fake semantic seed');
    await bridge.post({ ...pre, hook_event_name: 'PostToolUse', tool_response: {} }, pre.tool_use_id);
    let snapshot = broker.snapshot(ownerSession);
    const binding = snapshot.nativeScopes['agent-invocation'];
    assert.ok(binding?.scopeId);
    assert.equal(binding.runId, 'initial');
    assert.equal(snapshot.semanticByScope[binding.scopeId].done, 0);
    assert.equal(snapshot.semanticByScope[binding.scopeId].title, 'Native task', 'native bridge forwards semantic title');
    assert.equal(snapshot.root.semantic, null);
    assert.equal((await sessionClient.report({ done: 1, total: 2, engine: 'claudecode', toolUseId: 'unknown' })).accepted, false);
    assert.equal((await sessionClient.report({ done: 1, total: 2 })).reason, 'unattributed_call',
        'a session report without engine metadata is refused, never root');
    const orphan = input('orphan-progress', 'unannounced');
    bridge.pre(orphan);
    assert.equal(bridge.classify(orphan.tool_use_id).pending, true,
        'a live hook inside an unannounced child binds its own scope');
    await bridge.post({ ...orphan, hook_event_name: 'PostToolUse', tool_response: {} }, orphan.tool_use_id);
    const orphanSnapshot = broker.snapshot(ownerSession);
    const orphanScopeIds = Object.keys(orphanSnapshot.semanticByScope)
        .filter((id) => !Object.values(orphanSnapshot.nativeScopes).some((b) => b.scopeId === id));
    assert.equal(orphanScopeIds.length, 1, 'the unannounced child owns a scope with no card binding');
    assert.equal(orphanSnapshot.semanticByScope[orphanScopeIds[0]].done, 0);
    const root = input('root-progress');
    bridge.pre(root);
    assert.equal((await sessionClient.report({ ...root.tool_input, engine: 'claudecode', toolUseId: root.tool_use_id })).accepted, true);
    assert.equal(broker.snapshot(ownerSession).root.semantic.done, 0);
    const abort = new AbortController();
    const aborted = input('aborted', 'child');
    bridge.pre(aborted, undefined, { signal: abort.signal });
    abort.abort();
    assert.equal(bridge.classify('aborted').accepted, false);
    const failed = input('failed', 'child');
    bridge.pre(failed);
    assert.equal(bridge.classify('failed').pending, true);
    bridge.failure(failed);
    await bridge.post(failed);
    assert.equal(broker.snapshot(ownerSession).semanticByScope[binding.scopeId].done, 0);
    const late = input('late', 'child');
    const keysBeforeLate = new Set(Object.keys(broker.snapshot(ownerSession).semanticByScope));
    bridge.pre(late);
    bridge.classify('late');
    bridge.observe({ ...task, subtype: 'task_notification', status: 'completed' });
    await bridge.post(late);
    const afterLate = broker.snapshot(ownerSession).semanticByScope;
    assert.ok(Object.keys(afterLate).every((id) => keysBeforeLate.has(id)), 'a closed attempt never commits');
    assert.equal(afterLate[orphanScopeIds[0]]?.done, 0);
    bridge.observe({ ...task, run_id: 'resumed' });
    bridge.pre(input('resumed-call', 'child'));
    assert.equal(bridge.classify('resumed-call').accepted, false);
    const resumeBridge = createNativeProgressBridge({ broker, ownerSession, resumed: true, createClient: client });
    resumeBridge.observe(task);
    resumeBridge.pre(input('resume-root'));
    assert.equal(resumeBridge.classify('resume-root').root, true,
        'trusted root progress remains supported after resuming a session');
    resumeBridge.pre(input('resume-child', 'child'));
    assert.equal(resumeBridge.classify('resume-child').reason, 'unsupported_resume');
    resumeBridge.pre({ hook_event_name: 'PreToolUse', session_id: ownerSession,
        tool_name: 'Agent', tool_use_id: 'fresh-invocation', tool_input: {} });
    const freshTask = { ...task, task_id: 'fresh-child', run_id: 'fresh-run', tool_use_id: 'fresh-invocation' };
    resumeBridge.observe(freshTask);
    resumeBridge.pre({ hook_event_name: 'PreToolUse', session_id: ownerSession,
        tool_name: 'mcp__vannevar__progress', tool_use_id: 'planless-progress', agent_id: 'fresh-child',
        tool_input: { done: 0, total: 2 } });
    assert.equal(resumeBridge.classify('planless-progress').reason, 'invalid_report',
        'a first child report without a plan is refused instead of silently dropped');
    resumeBridge.pre(input('fresh-child-progress', 'fresh-child'));
    assert.equal(resumeBridge.classify('fresh-child-progress').pending, true,
        'a fresh child with a trusted Agent invocation is supported in a resumed parent');
    await resumeBridge.post({ ...input('fresh-child-progress', 'fresh-child'),
        hook_event_name: 'PostToolUse', tool_response: {} });
    const freshScope = broker.snapshot(ownerSession).nativeScopes['fresh-invocation'];
    assert.ok(freshScope?.scopeId);
    assert.equal(broker.snapshot(ownerSession).semanticByScope[freshScope.scopeId].total, 2);
    resumeBridge.pre({ hook_event_name: 'PreToolUse', session_id: ownerSession,
        tool_name: 'Agent', tool_use_id: 'sibling-invocation', tool_input: {} });
    resumeBridge.observe({ ...task, task_id: 'sibling', run_id: 'sibling-run', tool_use_id: 'sibling-invocation' });
    resumeBridge.observe({ ...freshTask, run_id: 'resumed-fresh-run' });
    resumeBridge.pre(input('unsupported-resumed-child', 'fresh-child'));
    assert.equal(resumeBridge.classify('unsupported-resumed-child').reason, 'unsupported_resume');
    resumeBridge.pre(input('sibling-progress', 'sibling'));
    assert.equal(resumeBridge.classify('sibling-progress').pending, true,
        'resuming one child must not disable a different fresh child');
    const cancelledLaunch = new AbortController();
    resumeBridge.pre({ hook_event_name: 'PreToolUse', session_id: ownerSession,
        tool_name: 'Agent', tool_use_id: 'cancelled-invocation', tool_input: {} }, undefined,
        { signal: cancelledLaunch.signal });
    cancelledLaunch.abort();
    resumeBridge.observe({ ...task, task_id: 'cancelled-child', run_id: 'cancelled-run', tool_use_id: 'cancelled-invocation' });
    resumeBridge.pre(input('cancelled-progress', 'cancelled-child'));
    assert.equal(resumeBridge.classify('cancelled-progress').accepted, false);
    resumeBridge.dispose();
    const foreign = new Reader();
    observeNativeFrame(foreign, { ...task, task_id: 'foreign' });
    assert.equal(broker.snapshot(ownerSession).nativeScopes['foreign-invocation'], undefined,
        'frames observed through an unbound producer never create a card binding');
    bridge.pre(input('foreign-call', 'foreign'));
    assert.equal(bridge.classify('foreign-call').pending, true,
        'a live hook binds the unannounced child to its own scope, never to root');
    assert.equal(broker.snapshot(ownerSession).nativeScopes['foreign-invocation'], undefined,
        'the unbound producer frame contributed no card binding');
    console.log('native progress: patched reader ordering, broker protocol, child/root separation, failure/abort/terminal/resume guards passed');
} finally {
    bridge.dispose();
    for (const c of clients) c.close();
    broker.close();
}

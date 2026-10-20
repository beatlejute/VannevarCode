import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const os = require('node:os');
const home = mkdtempSync(path.join(tmpdir(), 'native-progress-integration-'));
const runtime = path.join(home, '.claude', 'vannevar');
mkdirSync(runtime, { recursive: true });
cpSync(new URL('../runtime/', import.meta.url), runtime, { recursive: true });
const config = {};
const originalLoad = Module._load;
let host;
try {
    Module._load = function (id, ...args) {
        if (id === 'vscode') return {
            workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'progress.nativeSemantic' && config.native !== undefined ? config.native : fallback }) },
            Uri: { file: (file) => ({ fsPath: file }) },
        };
        if (id === 'os') return { ...os, homedir: () => home };
        return originalLoad.call(this, id, ...args);
    };
    host = require(path.join(runtime, 'host.js'));
} finally { Module._load = originalLoad; }
const messages = [];
const webview = {
    __ccxChannelId: 'channel',
    postMessage: (message) => { messages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler) => { webview.receive = handler; return { dispose() {} }; },
};
let bridge;
try {
    host.renderScript(webview, 'nonce');
    const input = {};
    const context = { manager: { pendingChannels: new Map([['channel', { in: input }]]) }, input };
    const opts = { permissionMode: 'plan', allowedTools: ['Read'], disallowedTools: ['Bash'] };
    const env = host.envFor({}, undefined, opts, context);
    assert.ok(context.nativeBridge, 'default launch options install the supported host bridge');
    assert.deepEqual(opts.allowedTools, ['Read', 'mcp__vannevar__progress']);
    assert.deepEqual(opts.disallowedTools, ['Bash']);
    assert.equal(opts.permissionMode, 'plan', 'progress allowance does not change plan mode');
    const promptHook = opts.hooks.UserPromptSubmit.at(-1).hooks[0];
    const startHook = opts.hooks.SubagentStart.at(-1).hooks[0];
    const rootBrief = promptHook({ hook_event_name: 'UserPromptSubmit', session_id: opts.sessionId });
    assert.match(rootBrief.hookSpecificOutput.additionalContext, /mcp__vannevar__progress/);
    assert.deepEqual(promptHook({ session_id: opts.sessionId }), {});
    const childBrief = startHook({ hook_event_name: 'SubagentStart', session_id: opts.sessionId, agent_id: 'native-task' });
    assert.match(childBrief.hookSpecificOutput.additionalContext, /only your own work/);
    assert.equal(childBrief.hookSpecificOutput.permissionDecision, undefined);
    bridge = context.nativeBridge;
    const broker = globalThis.__ccxState.progress.broker;
    broker.observeRoot({ sessionId: opts.sessionId, rootId: 'turn', generation: 'generation' });
    const query = {};
    host.bindNativeProducer(query, context);
    host.observeNativeFrame(query, { type: 'system', subtype: 'task_started', session_id: opts.sessionId,
        task_id: 'native-task', run_id: 'native-initial', tool_use_id: 'native-invocation' });
    const pre = { hook_event_name: 'PreToolUse', session_id: opts.sessionId, agent_id: 'native-task',
        tool_use_id: 'progress-call', tool_name: 'mcp__vannevar__progress',
        tool_input: { done: 1, total: 2, plan: ['Inspect', 'Implement'] } };
    const callback = (event) => opts.hooks[event].find((entry) => new RegExp(entry.matcher).test('mcp__vannevar__progress')).hooks[0];
    await callback('PreToolUse')(pre, pre.tool_use_id, { signal: new AbortController().signal });
    const savedEnv = { ...process.env };
    Object.assign(process.env, env, { HOME: home, USERPROFILE: home,
        VANNEVAR_PROFILES_DIR: path.join(home, 'profiles'), VANNEVAR_RUNTIME_DIR: runtime });
    const { handle } = await import('../runtime/mcp/agent-server.mjs');
    let output = '';
    const stdoutWrite = process.stdout.write;
    try {
        process.stdout.write = (chunk) => { output += chunk; return true; };
        await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
            name: 'progress', arguments: { ...pre.tool_input, scope: 'forged-root', toolUseId: 'forged' },
            _meta: { 'claudecode/toolUseId': pre.tool_use_id },
        } });
    } finally {
        process.stdout.write = stdoutWrite;
        for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
        Object.assign(process.env, savedEnv);
    }
    assert.match(output, /accepted/);
    assert.equal(broker.snapshot(opts.sessionId).root.semantic, null, 'actual MCP handler classifies before root write');
    assert.deepEqual(broker.snapshot(opts.sessionId).semanticByScope, {}, 'Post hook alone commits child semantics');
    await callback('PostToolUse')({ ...pre, hook_event_name: 'PostToolUse', tool_response: {} }, pre.tool_use_id);
    const snapshot = broker.snapshot(opts.sessionId);
    const binding = snapshot.nativeScopes['native-invocation'];
    assert.ok(binding?.scopeId);
    assert.equal(snapshot.semanticByScope[binding.scopeId].done, 1);
    assert.equal(snapshot.root.semantic, null);
    assert.ok(messages.some((message) => message.payload?.nativeScopes?.['native-invocation']?.scopeId === binding.scopeId));
    assert.ok(messages.some((message) => message.payload?.changedScopes?.[binding.scopeId]?.done === 1));
    const source = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');
    const start = source.indexOf('    function nativeMeta(');
    const end = source.indexOf('    function runMeta(', start);
    const nativeMeta = vm.runInNewContext('(' + source.slice(start, end).trim() + ')', {
        nativeScopes: snapshot.nativeScopes, scopeSemantic: snapshot.semanticByScope,
        nativeSemanticStatus: snapshot.nativeSemanticStatus, nativeGenerations: new Map(),
        span: () => 'elapsed', progressSessionId: () => opts.sessionId, sessionObj: {},
    });
    const meta = nativeMeta({ id: 'native-invocation', input: {} }, true, [], { startTime: Date.now(), status: 'running' });
    assert.match(meta.note, /1\/2/);
    assert.doesNotMatch(nativeMeta({ id: 'foreign-invocation', input: {} }, true, [], {}).note, /1\/2/);
    const projection = host.SessionProgressProjection({ sessionId: opts.sessionId, ownerSession: opts.sessionId,
        runtime: { nativeAgents: [{ id: 'native-invocation', state: 'running' }] }, brokerSnapshot: snapshot, enabled: true });
    assert.equal(projection.agents.native[0].semantic.done, 1);
    config.native = false;
    assert.equal(bridge.classify('progress-call').accepted, false);
    console.log('native progress: real launch hooks, opaque query binding, MCP metadata, broker scope, host delivery and page semantic mapping passed');
} finally {
    bridge?.dispose();
    host?.closeProgressBroker();
    const state = globalThis.__ccxState;
    if (state) {
        for (const key of ['extensionsWatcher', 'agentRunsWatcher', 'settingsWatcher', 'bindingsWatcher', 'defaultWatcher', 'profilesWatcher', 'healthWatcher']) state[key]?.close();
        for (const timer of state.pollTimers?.values?.() || []) clearInterval(timer);
    }
    rmSync(home, { recursive: true, force: true });
}

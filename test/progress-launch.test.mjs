import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import net from 'node:net';
import { ProgressClient } from '../runtime/mcp/progress-client.mjs';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const os = require('node:os');
const home = mkdtempSync(path.join(tmpdir(), 'vannevar-progress-launch-'));
const runtime = path.join(home, '.claude', 'vannevar');
mkdirSync(runtime, { recursive: true });
cpSync(new URL('../runtime/host.js', import.meta.url), path.join(runtime, 'host.cjs'));
cpSync(new URL('../runtime/progress-broker.js', import.meta.url), path.join(runtime, 'progress-broker.js'));
cpSync(new URL('../runtime/progress-reporting.js', import.meta.url), path.join(runtime, 'progress-reporting.js'));
cpSync(new URL('../runtime/native-progress.js', import.meta.url), path.join(runtime, 'native-progress.js'));
writeFileSync(path.join(runtime, 'webview.js'), '// isolated page');
const load = Module._load;
const config = { enabled: true };
let host;
const clients = [];
const sockets = [];
function loadHost() {
    Module._load = function (id, ...args) {
        if (id === 'vscode') return {
            workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'progress.enabled' ? config.enabled : key === 'progress.nativeSemantic' ? false : fallback }) },
            Uri: { file: (file) => ({ fsPath: file }) },
        };
        if (id === 'os') return { ...os, homedir: () => home };
        return load.call(this, id, ...args);
    };
    try {
        delete require.cache[require.resolve(path.join(runtime, 'host.cjs'))];
        return require(path.join(runtime, 'host.cjs'));
    } finally { Module._load = load; }
}

function loadPage(webview, sent) {
    class El {
        constructor() { this.children = []; this.dataset = {}; this.style = {}; }
        setAttribute() {}
        getAttribute() { return null; }
        appendChild(child) { this.children.push(child); return child; }
        addEventListener() {}
        querySelector() { return null; }
        querySelectorAll() { return []; }
    }
    const document = {
        body: new El(), head: new El(), createElement: () => new El(),
        querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    const listeners = [];
    const window = {
        document, addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
        removeEventListener() {}, getSelection: () => null,
        setTimeout: (fn) => ({ fn }), clearTimeout() {},
    };
    const posted = [];
    const context = vm.createContext({
        window, document, console, setTimeout: window.setTimeout, clearTimeout() {},
        setInterval: () => ({}), clearInterval() {}, navigator: {},
        MutationObserver: class { observe() {} disconnect() {} },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 }, NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({
            postMessage(message) { const copy = structuredClone(message); posted.push(copy); webview.receive(copy); },
            getState: () => ({}), setState() {},
        }),
    });
    vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), context);
    const deliver = (message) => { for (const fn of listeners) fn({ data: structuredClone(message) }); };
    webview.postMessage = (message) => { sent.push(message); deliver(message); return Promise.resolve(true); };
    for (const message of [...sent]) deliver(message);
    return { posted, mount: (session) => window.__ccx.onRegistry(null, null, session) };
}

try {
    host = loadHost();
    function view(channelId) {
        const sent = [];
        const webview = {
            __ccxChannelId: channelId,
            postMessage: (m) => { sent.push(m); return Promise.resolve(true); },
            onDidReceiveMessage: (handler) => { webview.receive = handler; return { dispose() {} }; },
        };
        host.renderScript(webview, 'nonce');
        return { webview, sent };
    }
    const first = view('one');
    const second = view('two');
    const input1 = {};
    const input2 = {};
    const manager = { pendingChannels: new Map([['one', { in: input1 }], ['two', { in: input2 }]]) };
    const opts1 = {};
    const opts2 = {};
    const ambient = { ...process.env, VANNEVAR_PROGRESS_CAP: 'inherited-invalid', VANNEVAR_PROGRESS_ENDPOINT: 'inherited-invalid' };
    const attachedHost = host;
    host = loadHost();
    const env1 = host.envFor(ambient, undefined, opts1, { manager, input: input1 });
    const env2 = host.envFor(ambient, undefined, opts2, { manager, input: input2 });
    assert.match(opts1.sessionId, /^[0-9a-f-]{36}$/);
    assert.notEqual(opts1.sessionId, opts2.sessionId);
    assert.notEqual(env1.VANNEVAR_PROGRESS_CAP, env2.VANNEVAR_PROGRESS_CAP);
    assert.equal(first.webview.__ccxSessionId, opts1.sessionId);
    assert.equal(second.webview.__ccxSessionId, opts2.sessionId);
    assert.ok(env1.VANNEVAR_PROGRESS_ENDPOINT);
    assert.notEqual(env1.VANNEVAR_PROGRESS_CAP, 'inherited-invalid');
    const repeated = host.envFor(ambient, undefined, opts1, { manager, input: input1 });
    assert.equal(repeated.VANNEVAR_PROGRESS_CAP, env1.VANNEVAR_PROGRESS_CAP);
    const probe = host.envFor(ambient, undefined, {}, { manager, input: {} });
    assert.equal(Object.keys(probe).some((key) => key.startsWith('VANNEVAR_PROGRESS_')), false);
    const unmatched = host.envFor(ambient, undefined, {});
    assert.equal(Object.keys(unmatched).some((key) => key.startsWith('VANNEVAR_PROGRESS_')), false);
    const clientPath = new URL('../runtime/mcp/progress-client.mjs', import.meta.url).href;
    const code = `import {createProgressClient} from ${JSON.stringify(clientPath)}; const c=createProgressClient(); const r=await c.report({done:0,total:3,plan:['one','two','three']}); c.close(); if(!r.accepted) { console.error(r.reason);process.exitCode=1; }`;
    const snapshot = first.sent.find((m) => m.type === 'ccx:progressSnapshot');
    assert.ok(snapshot?.runtimeEpoch);
    const page = loadPage(first.webview, first.sent);
    const session = {
        id: opts1.sessionId, busy: { value: true }, subagentTasks: new Map(),
        messages: { value: [{ type: 'user', uuid: 'user-one',
            content: [{ content: { type: 'text', text: 'check launch progress' } }] }] },
    };
    page.mount(session);
    const projection = page.posted.findLast((m) => m.type === 'ccx:progressRuntime' && m.projection?.root);
    assert.ok(projection, 'the real page must publish a rendered user turn');
    const owner = globalThis.__ccxState.progress;
    assert.equal(owner.sessionProjections.get(opts1.sessionId).root.rootId, projection.projection.root.rootId);
    const client = new ProgressClient(env1);
    clients.push(client);
    const result = await client.report({ done: 0, total: 3, plan: ['one', 'two', 'three'] });
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.ok(first.sent.some((m) => m.type === 'ccx:progressDelta' && m.payload.changedRoot?.semantic?.total === 3));
    const broker = owner.broker;
    const subscription = owner.brokerSubscription;
    const thirdHost = loadHost();
    const thirdEnv = thirdHost.envFor(ambient, undefined, opts1, { manager, input: input1 });
    assert.equal(globalThis.__ccxState.progress, owner);
    assert.equal(owner.broker, broker);
    assert.equal(owner.brokerSubscription, subscription);
    assert.equal(thirdEnv.VANNEVAR_PROGRESS_CAP, env1.VANNEVAR_PROGRESS_CAP);
    assert.equal(thirdEnv.VANNEVAR_PROGRESS_ENDPOINT, env1.VANNEVAR_PROGRESS_ENDPOINT);
    // Hold a connection across the real page's root switch to send an old generation once.
    const socket = net.createConnection(env1.VANNEVAR_PROGRESS_ENDPOINT);
    sockets.push(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    const frames = [];
    let wake;
    socket.on('data', (chunk) => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
            frames.push(JSON.parse(buffer.slice(0, newline)));
            buffer = buffer.slice(newline + 1);
        }
        wake?.();
    });
    async function frame(type) {
        const deadline = setTimeout(() => { socket.destroy(new Error('frame timeout')); }, 3000);
        try {
            while (!frames.some((m) => m.type === type)) {
                await new Promise((resolve, reject) => {
                    wake = resolve;
                    socket.once('error', reject);
                });
            }
            return frames.splice(frames.findIndex((m) => m.type === type), 1)[0];
        } finally { clearTimeout(deadline); wake = null; }
    }
    socket.write(JSON.stringify({ type: 'hello', protocol: 2, cap: env1.VANNEVAR_PROGRESS_CAP, pid: process.pid }) + '\n');
    const hello = await frame('helloAck');
    session.messages.value.push({ type: 'user', uuid: 'user-two',
        content: [{ content: { type: 'text', text: 'check next turn' } }] });
    page.mount(session);
    // The page coalesces rapid remounts; its own clock, not host ordering, gates this publish.
    await new Promise((resolve) => setTimeout(resolve, 110));
    page.mount(session);
    assert.notEqual(owner.broker.snapshot(opts1.sessionId).root.generation, hello.rootGeneration);
    socket.write(JSON.stringify({ type: 'report', rootGeneration: hello.rootGeneration, done: 1, total: 3 }) + '\n');
    const stale = await frame('ack');
    assert.equal(stale.accepted, false);
    assert.equal(stale.reason, 'stale_generation');
    socket.destroy();
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: env1, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.on('data', (data) => { output += data; });
    const status = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    assert.equal(status, 0, output);
    config.enabled = false;
    const disabled = host.envFor(ambient, undefined, {}, { manager, input: input1 });
    assert.equal(Object.keys(disabled).some((key) => key.startsWith('VANNEVAR_PROGRESS_')), false);
    assert.equal(owner.broker, null);
    assert.equal(owner.brokerSubscription, null);
    assert.equal(owner.runtimeEpochs.size, 0);
    assert.equal(owner.sessionProjections.size, 0);
    assert.equal(owner.inactiveSessionTimers.size, 0);
    assert.equal(owner.disableLatched, true);
    const disabledCount = first.sent.filter((m) => m.disabled).length;
    loadHost().envFor(ambient, undefined, {}, { manager, input: input1 });
    assert.equal(first.sent.filter((m) => m.disabled).length, disabledCount);
    assert.equal(globalThis.__ccxState.progress, owner);
    attachedHost.closeProgressBroker();
    console.log('OK — reloads share progress ownership, real page reports reach the launch broker, stale generations stay rejected');
} finally {
    Module._load = load;
    for (const client of clients) client.close();
    for (const socket of sockets) socket.destroy();
    host?.closeProgressBroker();
    const state = globalThis.__ccxState;
    if (state) {
        for (const key of ['extensionsWatcher', 'agentRunsWatcher', 'settingsWatcher', 'bindingsWatcher', 'defaultWatcher', 'profilesWatcher', 'healthWatcher']) state[key]?.close();
        clearTimeout(state.agentRunsTimer);
    }
    rmSync(home, { recursive: true, force: true });
}

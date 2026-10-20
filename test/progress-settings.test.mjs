// Progress settings are declared in the extension manifest and enforced by the host.
// Keep the host, runtime files, home directory and emergency-disable variable isolated.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createProgressClient } from '../runtime/mcp/progress-client.mjs';

const require = createRequire(import.meta.url);
const manifest = require('../package.json');
const properties = manifest.contributes.configuration.properties;
const home = join(tmpdir(), `ccx-progress-settings-${process.pid}`);
const runtime = join(home, '.claude', 'vannevar');
const profiles = join(home, '.claude', 'profiles');
const envKeys = ['HOME', 'USERPROFILE', 'VANNEVAR_DISABLE_PROGRESS'];
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
const failures = [];
let host;
let watchers = [];
let config = { 'progress.enabled': true, 'progress.channels': false };
let configListener;
let staleRuntimeEpoch;
let staleScopeCapability;
let staleBrokerEndpoint;
let staleBrokerProtocol;
const posted = [];
const handlers = [];

async function test(name, run) {
    try {
        await run();
        console.log(`ok - ${name}`);
    } catch (error) {
        console.error(`not ok - ${name}: ${error.message}`);
        failures.push({ name, error });
    }
}

function setEnabled(enabled) {
    config['progress.enabled'] = enabled;
    configListener?.({ affectsConfiguration: (key) => key === 'vannevar.progress.enabled' });
}

function makeWebview() {
    return {
        postMessage(message) { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage(handler) { handlers.push(handler); },
        onDidDispose() {},
    };
}

function send(message) {
    for (const handler of handlers) handler(message);
}

function progressMessages() {
    return posted.filter((message) => (message.type === 'ccx:progressSnapshot' || message.type === 'ccx:progressDelta') && message.disabled !== true);
}

function loadProgressPage() {
    class Element {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.parentElement = null;
            this.attributes = {};
            this.dataset = {};
            this.style = {};
            this.className = '';
            this.id = '';
            this._text = '';
        }
        set textContent(value) {
            this._text = String(value);
            if (value === '') this.children = [];
        }
        get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
        setAttribute(name, value) { this.attributes[name] = String(value); }
        getAttribute(name) { return this.attributes[name] ?? null; }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        insertBefore(child, sibling) {
            const index = this.children.indexOf(sibling);
            child.parentElement = this;
            this.children.splice(index < 0 ? this.children.length : index, 0, child);
            return child;
        }
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
            this.parentElement = null;
        }
        addEventListener() {}
        removeEventListener() {}
        querySelector() { return null; }
        querySelectorAll() { return []; }
    }
    const body = new Element('body');
    const head = new Element('head');
    const composer = new Element('div');
    composer.id = 'composer';
    body.appendChild(composer);
    const listeners = {};
    const document = {
        body,
        head,
        createElement: (tag) => new Element(tag),
        getElementById(id) {
            const visit = (node) => node.id === id ? node : node.children.map(visit).find(Boolean) || null;
            return visit(body);
        },
        querySelector: (selector) => selector === '#composer' ? composer : null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    const window = {
        document,
        addEventListener: (type, callback) => { (listeners[type] ||= []).push(callback); },
        removeEventListener() {},
        getSelection: () => null,
        setTimeout: (fn) => ({ fn }),
        clearTimeout() {},
    };
    window.window = window;
    const context = {
        window, document, console, Date, Math, JSON, Intl,
        setTimeout: window.setTimeout,
        clearTimeout: window.clearTimeout,
        setInterval: () => ({}),
        clearInterval() {},
        navigator: {},
        matchMedia: () => ({ matches: false }),
        MutationObserver: class { observe() {} disconnect() {} },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({ postMessage() {}, getState: () => ({}), setState() {} }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), context);
    return {
        send(message) { for (const callback of listeners.message || []) callback({ data: message }); },
        progress() { return document.getElementById('ccx-root-progress'); },
    };
}

try {
    mkdirSync(runtime, { recursive: true });
    mkdirSync(profiles, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.VANNEVAR_DISABLE_PROGRESS;
    copyFileSync(new URL('../runtime/host.js', import.meta.url), join(runtime, 'host.js'));
    copyFileSync(new URL('../runtime/webview.js', import.meta.url), join(runtime, 'webview.js'));
    copyFileSync(new URL('../runtime/progress-broker.js', import.meta.url), join(runtime, 'progress-broker.js'));
    copyFileSync(new URL('../runtime/progress-reporting.js', import.meta.url), join(runtime, 'progress-reporting.js'));
    copyFileSync(new URL('../runtime/native-progress.js', import.meta.url), join(runtime, 'native-progress.js'));
    writeFileSync(join(profiles, 'test.json'), JSON.stringify({ env: {
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        VANNEVAR_PROGRESS_CAP: 'profile-cap',
        VANNEVAR_PROGRESS_CAPABILITY: 'profile-delegated-cap',
        VANNEVAR_PROGRESS_SCOPE: 'profile-scope',
        VANNEVAR_PROGRESS_ENDPOINT: 'profile-endpoint',
        VANNEVAR_PROGRESS_PROTOCOL: '2',
    } }));
    writeFileSync(join(runtime, 'default-profile.json'), JSON.stringify({ name: 'test' }));
    writeFileSync(join(home, '.claude', 'bindings.json'), JSON.stringify({ 'sess-progress': 'test' }));

    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function (request, ...args) {
        if (request === 'vscode') return {
            Uri: { file: (value) => ({ fsPath: value }) },
            workspace: {
                getConfiguration: () => ({ get: (key, fallback) => key in config ? config[key] : fallback }),
                onDidChangeConfiguration: (listener) => {
                    configListener = listener;
                    return { dispose() { if (configListener === listener) configListener = null; } };
                },
            },
            window: { showWarningMessage() {}, showErrorMessage() {} },
            extensions: { getExtension: () => null },
        };
        return originalLoad.call(this, request, ...args);
    };
    try {
        host = require(join(runtime, 'host.js'));
    } finally {
        Module._load = originalLoad;
    }

    const webview = makeWebview();
    host.renderScript(webview, 'nonce');
    function sessionEnvironment() {
        const input = {};
        const manager = { pendingChannels: new Map([[webview.__ccxChannelId, { in: input }]]) };
        return host.envFor({ PATH: 'test' }, undefined, { sessionId: 'sess-progress' }, { manager, input });
    }
    const scoped = globalThis.__ccxState || {};
    watchers = Object.values(scoped).filter((value) => value && typeof value.close === 'function');

    await test('webview clears disabled progress and ignores callbacks from the closed broker', () => {
        const page = loadProgressPage();
        page.send({ type: 'ccx:progressSnapshot', brokerInstanceId: 'broker-old', runtimeEpoch: 'epoch-old', revision: 1,
            root: { state: 'running', semantic: { done: 0, total: 3 }, title: 'Before disable' } });
        assert.ok(page.progress(), 'enabled snapshot renders root progress');
        page.send({ type: 'ccx:progressSnapshot', disabled: true, root: null });
        assert.equal(page.progress(), null, 'disable removes the progress surface');
        page.send({ type: 'ccx:progressSnapshot', brokerInstanceId: 'broker-new', runtimeEpoch: 'epoch-new', revision: 0, root: null });
        page.send({ type: 'ccx:progressDelta', brokerInstanceId: 'broker-old', revision: 2,
            payload: { changedRoot: { state: 'running', semantic: { done: 0, total: 3 }, title: 'Late old delta' } } });
        page.send({ type: 'ccx:progressSnapshot', brokerInstanceId: 'broker-old', runtimeEpoch: 'epoch-old', revision: 2,
            root: { state: 'running', semantic: { done: 0, total: 3 }, title: 'Late old snapshot' } });
        assert.equal(page.progress(), null, 'old broker callbacks cannot restore the progress surface');
    });

    await test('manifest declares progress and response budget settings with expected defaults', () => {
        const expectedDefaults = {
            'vannevar.progress.enabled': true,
            'vannevar.progress.semantic': true,
            'vannevar.progress.channels': true,
            'vannevar.progress.nativeSemantic': true,
            'vannevar.progress.expandedView': false,
            'vannevar.progress.debug': false,
            'vannevar.channels.responseBudget': 3500,
        };
        for (const [key, value] of Object.entries(expectedDefaults)) {
            assert.ok(properties[key], `missing setting ${key}`);
            assert.equal(properties[key].default, value, `${key} default`);
        }
    });

    await test('disabled launch still processes the ordinary channel but starts no progress transport', () => {
        config['progress.enabled'] = false;
        posted.length = 0;
        send({ type: 'launch_claude', channelId: 'channel-disabled', resume: 'sess-progress' });
        assert.equal(webview.__ccxChannelId, 'channel-disabled');
        assert.deepEqual(progressMessages(), []);
    });

    await test('enabled launch issues session and delegated capabilities with transport environment', async () => {
        setEnabled(true);
        posted.length = 0;
        send({ type: 'launch_claude', channelId: 'channel-enabled', resume: 'sess-progress' });
        const snapshot = progressMessages().find((message) => message.type === 'ccx:progressSnapshot');
        assert.ok(snapshot, 'enabled launch starts progress transport');
        staleRuntimeEpoch = snapshot.runtimeEpoch;
        const env = sessionEnvironment();
        assert.ok(env.VANNEVAR_PROGRESS_CAP, 'enabled session receives a capability');
        assert.ok(env.VANNEVAR_PROGRESS_ENDPOINT, 'enabled session receives a broker endpoint');
        staleBrokerEndpoint = env.VANNEVAR_PROGRESS_ENDPOINT;
        staleBrokerProtocol = env.VANNEVAR_PROGRESS_PROTOCOL;
        const parent = createProgressClient({ endpoint: staleBrokerEndpoint, protocol: staleBrokerProtocol, capability: env.VANNEVAR_PROGRESS_CAP });
        const scope = await parent.request({ type: 'createScope', scopeId: 'delegated-progress-scope' });
        parent.close();
        assert.equal(scope.ok, true, 'session capability can create its delegated scope');
        staleScopeCapability = scope.capability;
        const child = createProgressClient({ endpoint: staleBrokerEndpoint, protocol: staleBrokerProtocol, capability: staleScopeCapability, scope: 'delegated-progress-scope' });
        const report = await child.report({ done: 0, total: 1, scope: 'delegated-progress-scope' });
        child.close();
        assert.equal(report.ok, true, 'delegated capability is live before disable');
    });

    await test('disabling revokes delegated capabilities, clears UI and rejects stale callbacks after re-enable', async () => {
        posted.length = 0;
        setEnabled(false);
        assert.ok(posted.some((message) => message.type === 'ccx:progressSnapshot' && message.disabled === true && message.root === null),
            'disable sends a clearing snapshot');
        const deadChild = createProgressClient({ endpoint: staleBrokerEndpoint, protocol: staleBrokerProtocol, capability: staleScopeCapability, scope: 'delegated-progress-scope' });
        const deadReport = await deadChild.report({ done: 1, total: 1, scope: 'delegated-progress-scope' });
        deadChild.close();
        assert.equal(deadReport.ok, false, 'closed broker rejects an already-issued delegated capability');

        setEnabled(true);
        posted.length = 0;
        send({ type: 'ccx:session', sessionId: 'sess-progress' });
        send({ type: 'launch_claude', channelId: 'channel-restored', resume: 'sess-progress' });
        send({
            type: 'ccx:progressRuntime',
            sessionId: 'sess-progress',
            runtimeEpoch: staleRuntimeEpoch,
            runtimeRevision: 1,
            root: { rootId: 'late-root', state: 'running' },
            projection: { root: { rootId: 'late-root', state: 'running' } },
        });
        send({ type: 'ccx:rootTaskObserved', sessionId: 'sess-progress', root: { rootId: 'late-root', state: 'running' } });
        send({ type: 'ccx:requestProgressSnapshot', sessionId: 'sess-progress' });
        const current = progressMessages().filter((message) => message.type === 'ccx:progressSnapshot').pop();
        assert.equal(current.root, null, 'a callback from the closed epoch cannot restore the old root');
        const currentEnv = sessionEnvironment();
        assert.notEqual(currentEnv.VANNEVAR_PROGRESS_CAP, undefined, 'new enabled session receives a fresh capability');
        const staleParent = createProgressClient({
            endpoint: currentEnv.VANNEVAR_PROGRESS_ENDPOINT,
            protocol: currentEnv.VANNEVAR_PROGRESS_PROTOCOL,
            capability: staleScopeCapability,
        });
        const staleScope = await staleParent.request({ type: 'createScope', scopeId: 'stale-after-reenable' });
        staleParent.close();
        assert.equal(staleScope.ok, false, 'the new broker rejects a delegated capability from the closed instance');
    });

    await test('disabled environment removes all progress transport capabilities', () => {
        setEnabled(false);
        const env = host.envFor({
            PATH: 'test',
            VANNEVAR_PROGRESS_CAP: 'ambient-cap',
            VANNEVAR_PROGRESS_CAPABILITY: 'delegated-cap',
            VANNEVAR_PROGRESS_SCOPE: 'delegated-scope',
            VANNEVAR_PROGRESS_ENDPOINT: 'ambient-endpoint',
            VANNEVAR_PROGRESS_PROTOCOL: '2',
        }, 'sess-progress');
        for (const key of ['VANNEVAR_PROGRESS_CAP', 'VANNEVAR_PROGRESS_CAPABILITY', 'VANNEVAR_PROGRESS_SCOPE',
            'VANNEVAR_PROGRESS_ENDPOINT', 'VANNEVAR_PROGRESS_PROTOCOL']) {
            assert.equal(env[key], undefined, `${key} is removed while disabled`);
        }
        assert.equal(env.PATH, 'test', 'ordinary launch environment remains intact');
    });

    await test('disabled ccx:get and ccx:session cannot restart transport or issue a capability', () => {
        posted.length = 0;
        send({ type: 'ccx:get' });
        send({ type: 'ccx:session', sessionId: 'sess-progress' });
        send({ type: 'launch_claude', channelId: 'channel-late', resume: 'sess-progress' });
        assert.deepEqual(progressMessages(), []);
    });

    await test('re-enabling restores the open session without another launch or session message', () => {
        posted.length = 0;
        setEnabled(true);
        assert.ok(progressMessages().some((message) => message.type === 'ccx:progressSnapshot'),
            'setting transition resumes progress transport immediately');
        const env = sessionEnvironment();
        assert.ok(env.VANNEVAR_PROGRESS_CAP && env.VANNEVAR_PROGRESS_CAP !== 'profile-cap',
            'setting transition issues a fresh session capability');
        assert.equal(config['progress.channels'], false, 'channels preference remains independently disabled');
    });

    await test('emergency disable takes priority and sanitizes inherited transport variables', () => {
        process.env.VANNEVAR_DISABLE_PROGRESS = '1';
        posted.length = 0;
        send({ type: 'launch_claude', channelId: 'channel-emergency', resume: 'sess-progress' });
        send({ type: 'ccx:get' });
        send({ type: 'ccx:session', sessionId: 'sess-progress' });
        assert.deepEqual(progressMessages(), []);
        const env = host.envFor({ PATH: 'test', VANNEVAR_PROGRESS_CAP: 'ambient-cap', VANNEVAR_PROGRESS_ENDPOINT: 'ambient' }, 'sess-progress');
        assert.equal(env.VANNEVAR_PROGRESS_CAP, undefined);
        assert.equal(env.VANNEVAR_PROGRESS_ENDPOINT, undefined);
        assert.equal(env.PATH, 'test');
    });

    await test('channels preference does not block ordinary channel plugin startup', async () => {
        process.env.VANNEVAR_DISABLE_PROGRESS = '1';
        let started;
        host.onChannelReady({ channels: new Map([['channel-emergency', { query: { enableChannel: async (name) => { started = name; } } }]]) }, 'channel-emergency');
        send({ type: 'ccx:channelStart', channelId: 'channel-emergency', server: 'plugin:demo:events' });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(started, 'plugin:demo:events');
        assert.equal(config['progress.channels'], false);
    });

    await test('response budget accepts the supported lower and upper boundary values', () => {
        const setting = properties['vannevar.channels.responseBudget'];
        assert.equal(setting.minimum, 500);
        assert.equal(setting.maximum, 16000);
        assert.ok(499 < setting.minimum && 500 === setting.minimum);
        assert.ok(16000 === setting.maximum && 16001 > setting.maximum);
    });

    await test('native subagent progress defaults to enabled while expanded view stays opt-in', () => {
        assert.equal(properties['vannevar.progress.nativeSemantic'].default, true);
        assert.equal(properties['vannevar.progress.expandedView'].default, false);
    });
} finally {
    try { host?.closeProgressBroker(); } catch {}
    for (const watcher of watchers) {
        try { watcher.close(); } catch {}
    }
    for (const key of envKeys) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
    rmSync(home, { recursive: true, force: true });
}

console.log(`\n${12 - failures.length}/12 progress settings cases passed`);
if (failures.length) process.exitCode = 1;

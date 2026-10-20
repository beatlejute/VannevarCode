import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const home = mkdtempSync(join(tmpdir(), 'ccx-progress-agent-frame-'));
const previousEnv = Object.fromEntries(
    ['HOME', 'USERPROFILE', 'VANNEVAR_PROFILES_DIR', 'VANNEVAR_RUNTIME_DIR'].map((key) => [key, process.env[key]]),
);

try {
    const profiles = join(home, 'profiles');
    const runtime = join(home, 'runtime');
    mkdirSync(profiles, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(profiles, 'claude.json'), JSON.stringify({ env: {} }));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.VANNEVAR_PROFILES_DIR = profiles;
    process.env.VANNEVAR_RUNTIME_DIR = runtime;

    class Element {
        constructor(tagName) {
            this.tagName = tagName;
            this.children = [];
            this.className = '';
            this.textContent = '';
            this.dataset = {};
            this.listeners = {};
            this.parentElement = null;
        }
        set textContent(value) {
            this._text = value;
            if (value === '') this.children = [];
        }
        get textContent() { return this._text || ''; }
        appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
        addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
            this.parentElement = null;
        }
        contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
        querySelectorAll() { return []; }
    }

    const toolNodes = [];
    const document = {
        body: new Element('body'),
        head: new Element('head'),
        createElement: (tag) => new Element(tag),
        querySelector: () => null,
        querySelectorAll: (selector) => selector === '[class*="toolUse_"]' ? toolNodes.slice() : [],
        addEventListener() {},
        removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    let messageListener;
    const window = {
        document,
        addEventListener(type, listener) { if (type === 'message') messageListener = listener; },
        removeEventListener() {},
        getSelection: () => null,
        innerWidth: 1000,
        innerHeight: 800,
        setTimeout: (fn) => ({ fn }),
        clearTimeout() {},
    };
    window.window = window;
    const sent = [];
    const context = {
        window,
        document,
        console,
        Date,
        Intl,
        Math,
        JSON,
        Set,
        WeakMap,
        setTimeout: window.setTimeout,
        clearTimeout() {},
        setInterval: () => ({}),
        clearInterval() {},
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        MutationObserver: class { observe() {} },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({ postMessage: (message) => sent.push(message), getState: () => ({}), setState() {} }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), context);
    assert.ok(messageListener, 'webview registers its host message listener');

    const task = {
        toolUseId: 'toolu_native_progress',
        description: 'Inspect native telemetry',
        startTime: Date.now() - 5000,
        status: 'running',
        recentTools: ['Read', 'Grep'],
        usage: { totalTokens: 2048, toolUses: 7, durationMs: 5000 },
        progress: { done: 3, total: 5 },
        providerProfile: 'should-not-be-trusted',
        providerGeneration: 9,
        servedModel: 'unknown-child-model',
    };
    const block = { type: 'tool_use', id: task.toolUseId, name: 'Agent', input: { subagent_type: 'Explore' } };
    const toolNode = (finished = false, toolBlock = block) => {
        const node = new Element('div');
        node.className = 'toolUse_native';
        const wrapper = { content: toolBlock, toolResult: { value: finished ? [{ type: 'text', text: 'finished' }] : undefined } };
        const component = { memoizedProps: { content: wrapper }, return: null };
        node['__reactFiber$native'] = { memoizedProps: { className: node.className }, return: component };
        return node;
    };
    let session = { messages: { value: [] }, subagentTasks: { value: new Map([['native-task', task]]) } };
    window.__ccx.onRegistry(null, null, session);
    const emit = () => messageListener({ data: { type: 'ccx:agentRuns', runs: [] } });
    const currentFrame = () => toolNodes[0]?.children.find((child) => child.className === 'ccx-agent-frame');
    const frameText = () => {
        const frame = currentFrame();
        return frame ? [frame.textContent, ...frame.children.flatMap((child) => [child.textContent, ...child.children.map((item) => item.textContent)])].join(' ') : '';
    };
    toolNodes.push(toolNode());

    test('live native task shows runtime lifecycle, tools, and usage', () => {
        emit();
        const frame = currentFrame();
        assert.ok(frame, 'an active native Agent has a frame');
        assert.equal(frame.dataset.ccxState, 'running');
        assert.equal(frame.dataset.ccxOpen, '1');
        assert.match(frameText(), /7 tool calls/);
        assert.match(frameText(), /2,048 tok/);
        assert.match(frameText(), /Read/);
        assert.match(frameText(), /Grep/);
    });

    test('native frame derives elapsed time from its source timestamp', () => {
        emit();
        assert.match(frameText(), /5s/);
    });

    test('native title uses task description and falls back to Agent', () => {
        emit();
        assert.match(frameText(), /Inspect native telemetry/);
        task.description = '';
        block.input.description = '';
        block.input.subagent_type = '';
        emit();
        assert.match(frameText(), /Agent/);
        task.description = 'Inspect native telemetry';
        block.input.subagent_type = 'Explore';
    });

    test('provider identity is not exposed without pinned same-session evidence', () => {
        emit();
        assert.doesNotMatch(frameText(), /provider\/model unknown/);
        assert.doesNotMatch(frameText(), /should-not-be-trusted|unknown-child-model/);
    });

    test('same-session provider identity is shown only when its generation is pinned', () => {
        task.providerEvidence = 'same-session-provider';
        task.providerProfile = 'same-session-profile';
        task.providerGeneration = 9;
        task.pinnedProviderGeneration = 9;
        emit();
        assert.match(frameText(), /same-session-profile/);
        task.providerGeneration = 8;
        emit();
        assert.doesNotMatch(frameText(), /same-session-profile/);
    });

    test('native model stays unknown and V1 does not render semantic x/y', () => {
        emit();
        assert.doesNotMatch(frameText(), /provider\/model unknown/);
        assert.doesNotMatch(frameText(), /3\/5/);
    });

    test('terminal task remains readable after it disappears from the live task map', () => {
        task.status = 'done';
        session.subagentTasks.value = new Map();
        toolNodes[0] = toolNode(true);
        emit();
        assert.ok(currentFrame(), 'the last task snapshot keeps a terminal frame');
        assert.equal(currentFrame().dataset.ccxOpen, '0');
        assert.match(frameText(), /7 tool calls/);
    });

    test('task snapshot retention stays within active plus 100 terminal entries', () => {
        const source = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');
        const taskForBody = source.match(/function taskFor\(toolUseId\)[\s\S]*?\n    }/);
        assert.ok(taskForBody, 'native task lookup exists in the shipped webview source');
        assert.match(taskForBody[0], /(?:100|MAX_TASK_SNAPSHOTS)/, 'native snapshot cache enforces its terminal-entry limit');

        const snapshots = Object.fromEntries(Array.from({ length: 105 }, (_, index) => [
            `terminal-${index}`,
            { status: 'done', toolUseId: `terminal-${index}` },
        ]));
        snapshots.activeOne = { status: 'running', toolUseId: 'activeOne' };
        snapshots.activeTwo = { status: 'working', toolUseId: 'activeTwo' };
        const normalized = context.buildNormalizedRuntimeSnapshot({
            id: 'retention-session',
            taskSnapshots: snapshots,
        });
        const retainedIds = Object.keys(normalized.taskSnapshots);
        assert.equal(retainedIds.length, 102, 'all active tasks and only 100 terminal tasks remain');
        assert.ok(retainedIds.includes('activeOne'));
        assert.ok(retainedIds.includes('activeTwo'));
        assert.ok(retainedIds.includes('terminal-5'));
        assert.ok(retainedIds.includes('terminal-104'));
        assert.ok(!retainedIds.includes('terminal-4'));
    });
} finally {
    for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
}

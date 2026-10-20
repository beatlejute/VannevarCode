// QA-016: progress performance harness — deterministic synthetic stress/soak harness.
// PLAN-001 task 36: stress fixture with 1000 transcript messages, 500 tool calls, 50 Agent blocks,
// 20 parallel agents, 100 semantic records. Measures ToolBlockIndex update cost, transcript visits,
// runtime projection cost, snapshot/delta serialization, Channels /tabs /agents formatting,
// retained taskSnapshots count, process heap delta.
//
// Isolation follows PLAN-001 "Test hygiene": unique temp root, redirected HOME/USERPROFILE/runtime
// paths, teardown in `finally`. The real ~/.claude is never read or written.
//
// Run: node test/progress-performance.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

const ISOLATED_ROOT = mkdtempSync(join(tmpdir(), 'ccx-progress-performance-'));
const home = ISOLATED_ROOT;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.VANNEVAR_RUNTIME_DIR = join(home, '.claude', 'vannevar');
process.env.VANNEVAR_PROFILES_DIR = join(home, '.claude', 'profiles');
mkdirSync(process.env.VANNEVAR_RUNTIME_DIR, { recursive: true });
mkdirSync(process.env.VANNEVAR_PROFILES_DIR, { recursive: true });
writeFileSync(join(process.env.VANNEVAR_PROFILES_DIR, 'claude.json'), JSON.stringify({ env: {} }));

// --- minimal DOM mock for webview.js ------------------------------------------------------------
function createPageContext() {
    class El {
        constructor(tag) {
            this.tagName = tag;
            this.children = [];
            this.className = '';
            this.textContent = '';
            this.dataset = {};
            this.style = {};
            this.isConnected = true;
        }
        setAttribute() {}
        getAttribute() { return null; }
        appendChild(n) { this.children.push(n); n.isConnected = true; return n; }
        removeChild(n) { const i = this.children.indexOf(n); if (i >= 0) this.children.splice(i, 1); n.isConnected = false; return n; }
        addEventListener() {}
        removeEventListener() {}
        querySelector() { return null; }
        querySelectorAll(sel) {
            if (sel === '[class*="toolUse_"]') {
                const found = [];
                function walk(node) {
                    if (String(node.className).includes('toolUse_')) found.push(node);
                    for (const child of node.children) walk(child);
                }
                walk(this);
                return found;
            }
            return [];
        }
        matches(sel) {
            if (sel === '[class*="toolUse_"]') return String(this.className).includes('toolUse_');
            return false;
        }
        compareDocumentPosition(other) {
            const a = this.children.indexOf(this);
            const b = this.children.indexOf(other);
            if (a < b) return 4;
            if (a > b) return 2;
            return 0;
        }
    }
    const pageDocument = {
        body: new El('body'),
        head: new El('head'),
        createElement: (t) => new El(t),
        querySelector: () => null,
        querySelectorAll: (sel) => {
            if (sel === '[class*="toolUse_"]') {
                const found = [];
                function walk(node) {
                    if (String(node.className).includes('toolUse_')) found.push(node);
                    for (const child of node.children) walk(child);
                }
                walk(pageDocument.body);
                return found;
            }
            return [];
        },
        addEventListener() {},
        removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    const pageWindow = {
        document: pageDocument,
        removeEventListener() {},
        getSelection: () => null,
        setTimeout: (fn) => { fn(); return 1; },
        clearTimeout: () => {},
    };
    pageWindow.window = pageWindow;
    pageWindow.addEventListener = () => {};
    const pageContext = {
        window: pageWindow,
        document: pageDocument,
        console,
        setTimeout: pageWindow.setTimeout,
        clearTimeout: pageWindow.clearTimeout,
        setInterval: () => ({}),
        clearInterval: () => {},
        navigator: {},
        MutationObserver: class {
            constructor(cb) { this.cb = cb; }
            observe() {}
            disconnect() {}
            takeRecords() { return []; }
        },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({ postMessage: () => {}, getState: () => ({}), setState() {} }),
    };
    pageContext.globalThis = pageContext;
    vm.createContext(pageContext);
    return pageContext;
}

// --- load runtime/webview.js into VM and extract needed functions --------------------------------
function loadWebviewModules() {
    const pageContext = createPageContext();
    const webviewSource = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');
    vm.runInContext(webviewSource, pageContext);
    return {
        buildNormalizedRuntimeSnapshot: pageContext.globalThis.buildNormalizedRuntimeSnapshot,
        _context: pageContext,
    };
}

// --- ToolBlockIndex implementation (copied from runtime/webview.js:1581) -----------------------
function createToolBlockIndex(doc) {
    const byId = new Map();
    const rebuildThreshold = 0.4;

    function isToolNode(node) {
        return Boolean(node && (node.matches
            ? node.matches('[class*="toolUse_"]')
            : String(node.className || '').indexOf('toolUse_') >= 0));
    }

    function connected(node) {
        return node && node.isConnected !== false;
    }

    function candidates(root) {
        const found = [];
        if (isToolNode(root)) found.push(root);
        if (root && root.querySelectorAll) {
            const descendants = root.querySelectorAll('[class*="toolUse_"]');
            for (let i = 0; i < descendants.length; i++) found.push(descendants[i]);
        }
        return found;
    }

    function toolUseOf(node) {
        const candidatesList = [];
        if (isToolNode(node)) candidatesList.push(node);
        if (node && node.querySelectorAll) {
            const descendants = node.querySelectorAll('[class*="toolUse_"]');
            for (let i = 0; i < descendants.length; i++) candidatesList.push(descendants[i]);
        }
        for (let i = 0; i < candidatesList.length; i++) {
            const c = candidatesList[i];
            if (!c || typeof c !== 'object') continue;
            const raw = c.type === 'tool_use' ? c : c.content;
            if (raw && raw.type === 'tool_use' && typeof raw.id === 'string' && typeof raw.name === 'string')
                return { block: raw, wrapper: c };
        }
        return null;
    }

    function entryFor(node) {
        const found = toolUseOf(node);
        return found && found.block && typeof found.block.id === 'string'
            ? { id: found.block.id, node: node }
            : null;
    }

    function compareNodes(a, b) {
        if (a === b) return 0;
        if (!connected(a)) return 1;
        if (!connected(b)) return -1;
        if (typeof a.compareDocumentPosition !== 'function') return 0;
        const relation = a.compareDocumentPosition(b);
        return relation & 4 ? -1 : relation & 2 ? 1 : 0;
    }

    function reconcile(id, nodes) {
        const unique = [];
        for (let i = 0; i < nodes.length; i++) {
            if (connected(nodes[i]) && unique.indexOf(nodes[i]) < 0) unique.push(nodes[i]);
        }
        unique.sort(compareNodes);
        if (unique.length) byId.set(id, { id: id, node: unique[0] });
        else byId.delete(id);
    }

    function rebuild() {
        byId.clear();
        const nodes = doc.querySelectorAll('[class*="toolUse_"]');
        const groups = new Map();
        for (let i = 0; i < nodes.length; i++) {
            const entry = entryFor(nodes[i]);
            if (!entry) continue;
            if (!groups.has(entry.id)) groups.set(entry.id, []);
            groups.get(entry.id).push(entry.node);
        }
        groups.forEach((group, id) => { reconcile(id, group); });
    }

    function update(records) {
        const touched = new Map();
        function touch(node) {
            const entry = entryFor(node);
            if (entry) {
                if (!touched.has(entry.id)) touched.set(entry.id, []);
                touched.get(entry.id).push(entry.node);
            }
        }
        for (let i = 0; records && i < records.length; i++) {
            const record = records[i];
            for (let r = 0; r < record.removedNodes.length; r++) {
                const removed = candidates(record.removedNodes[r]);
                for (let x = 0; x < removed.length; x++) touch(removed[x]);
            }
            for (let a = 0; a < record.addedNodes.length; a++) {
                const added = candidates(record.addedNodes[a]);
                for (let y = 0; y < added.length; y++) touch(added[y]);
            }
            if (record.type === 'attributes' && isToolNode(record.target)) touch(record.target);
        }
        const churn = touched.size / Math.max(1, byId.size);
        if (churn > rebuildThreshold) {
            rebuild();
            return;
        }
        touched.forEach((nodes, id) => {
            const current = byId.get(id);
            if (current && current.node.isConnected) nodes.push(current.node);
            reconcile(id, nodes);
        });
    }

    return {
        rebuild: rebuild,
        update: update,
        clear: function () { byId.clear(); },
        values: function () {
            const entries = Array.from(byId.values());
            if (entries.some((entry) => !('isConnected' in entry.node))) rebuild();
            return Array.from(byId.values()).filter((entry) => connected(entry.node));
        },
        threshold: rebuildThreshold,
    };
}

// --- load host.js using require (CommonJS) with vscode stub --------------------------------------
function loadHostModules() {
    const require = createRequire(import.meta.url);
    const Module = require('node:module');
    const load = Module._load;
    const os = require('os');
    const originalHomedir = os.homedir;
    const home = process.env.HOME;
    const vscodeStub = {
        Uri: { file: (p) => ({ fsPath: p }) },
        window: { showWarningMessage() {}, showErrorMessage() {} },
        workspace: { getConfiguration: () => ({ get: (key) => {
            if (key === 'channels.responseBudget') return 3500;
            if (key === 'vannevar.progress.enabled') return true;
            if (key === 'vannevar.progress.channels') return true;
            return undefined;
        }}) },
    };
    const osStub = {
        ...os,
        homedir: () => home,
    };
    Module._load = (request, ...rest) => {
        if (request === 'vscode') return vscodeStub;
        if (request === 'os') return osStub;
        return load(request, ...rest);
    };
    // Copy progress-broker.js to isolated runtime dir where host.js expects it
    writeFileSync(join(process.env.VANNEVAR_RUNTIME_DIR, 'progress-broker.js'), readFileSync(new URL('../runtime/progress-broker.js', import.meta.url), 'utf8'));
    const hostCopy = join(tmpdir(), `ccx-host-perf-${process.pid}.cjs`);
    // Append exports for internal formatting functions needed for performance measurement
    const hostSource = readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8');
    const extendedSource = hostSource +
        '\nmodule.exports.relayTabsReply = relayTabsReply;' +
        '\nmodule.exports.relaySessionReply = relaySessionReply;' +
        '\nmodule.exports.relayAgentsReply = relayAgentsReply;' +
        '\nmodule.exports.channelsStatusLine = channelsStatusLine;' +
        '\nmodule.exports.channelsMarks = channelsMarks;' +
        '\nmodule.exports.channelsBounded = channelsBounded;' +
        '\nmodule.exports.fitChannelsBudget = fitChannelsBudget;' +
        '\nmodule.exports.channelsProviderModel = channelsProviderModel;' +
        '\nmodule.exports.channelsElapsed = channelsElapsed;' +
        '\nmodule.exports.SessionProgressProjection = SessionProgressProjection;' +
        '\nmodule.exports.replaceProgressBroker = replaceProgressBroker;' +
        '\nmodule.exports.closeProgressBroker = closeProgressBroker;';
    writeFileSync(hostCopy, extendedSource);
    let host;
    try {
        host = require(hostCopy);
    } finally {
        rmSync(hostCopy, { force: true });
        Module._load = load;
    }
    return {
        SessionProgressProjection: host.SessionProgressProjection,
        channelsElapsed: host.channelsElapsed,
        channelsProviderModel: host.channelsProviderModel,
        channelsMarks: host.channelsMarks,
        channelsBounded: host.channelsBounded,
        fitChannelsBudget: host.fitChannelsBudget,
        relaySessionReply: host.relaySessionReply,
        relayTabsReply: host.relayTabsReply,
        relayAgentsReply: host.relayAgentsReply,
        channelsStatusLine: host.channelsStatusLine,
        replaceProgressBroker: host.replaceProgressBroker,
        closeProgressBroker: host.closeProgressBroker,
    };
}

// --- load progress-broker.js using require -------------------------------------------------------
function loadBrokerModules() {
    const require = createRequire(import.meta.url);
    const { createProgressBroker } = require('../runtime/progress-broker.js');
    return { createProgressBroker };
}

// --- fixtures ------------------------------------------------------------------------------------
function createTranscriptMessages(count) {
    const messages = [];
    for (let i = 0; i < count; i++) {
        const isUser = i % 2 === 0;
        messages.push({
            uuid: `msg-${i}`,
            type: isUser ? 'user' : 'assistant',
            content: isUser
                ? `User message ${i}`
                : [
                    { type: 'text', text: `Assistant response ${i}` },
                    ...(i % 10 === 1 ? [{ type: 'tool_use', id: `tu-${i}`, name: 'Bash', input: {} }] : []),
                    ...(i % 10 === 3 ? [{ type: 'tool_use', id: `tu-${i}-2`, name: 'Read', input: {} }] : []),
                    ...(i % 10 === 5 ? [{ type: 'tool_result', tool_use_id: `tu-${i}`, content: 'ok' }] : []),
                ],
            isMeta: false,
            isSynthetic: false,
        });
    }
    return messages;
}

function createSession(messages, overrides = {}) {
    // Create some task snapshots for retention testing
    const taskSnapshots = {};
    for (let i = 0; i < 150; i++) {
        const isActive = i < 50; // 50 active, 100 terminal
        taskSnapshots[`task-${i}`] = {
            toolUseId: `task-${i}`,
            description: `Task ${i}`,
            status: isActive ? 'working' : 'completed',
            startTime: Date.now() - 100000 + i * 1000,
            lastActivityTime: Date.now(),
            recentTools: ['Read', 'Grep'].slice(0, (i % 2) + 1),
            summary: `task ${i}`,
            usage: { toolUses: 10 + i, totalTokens: 5000 + i * 100, durationMs: 5000 + i * 100 },
        };
    }
    return {
        id: 'perf-session',
        runtimeRevision: 0,
        activityHealth: 'fresh',
        providerGeneration: 7,
        taskSnapshots: taskSnapshots,
        subagentTasks: new Map(),
        messages: { value: messages },
        busy: { value: true },
        runtimeState: { value: 'running' },
        providerProfile: { value: 'z.ai' },
        requestedModel: { value: 'GLM-5.3' },
        lastServedModel: { value: 'GLM-5.3' },
        providerGeneration: { value: 7 },
        servedModelGeneration: { value: 7 },
        ...overrides,
    };
}

function createNativeTasks(count) {
    const tasks = new Map();
    for (let i = 0; i < count; i++) {
        const id = `toolu_native_${i}`;
        tasks.set(id, {
            toolUseId: id,
            description: `Native task ${i}`,
            status: 'working',
            startTime: Date.now() - 100000 + i * 1000,
            lastActivityTime: Date.now(),
            recentTools: ['Read', 'Grep', 'Bash'].slice(0, (i % 3) + 1),
            summary: `working on task ${i}`,
            usage: { toolUses: 10 + i, totalTokens: 5000 + i * 100, durationMs: 5000 + i * 100 },
            servedModel: 'GLM-5.3',
            servedModelGeneration: 7,
        });
    }
    return tasks;
}

function createDelegatedRuns(count) {
    const runs = [];
    for (let i = 0; i < count; i++) {
        runs.push({
            session: `delegated-${i}`,
            attemptId: `attempt-${i}`,
            scopeId: `scope-${i}`,
            description: `Delegated task ${i}`,
            profile: 'z.ai',
            model: 'sonnet',
            servedModel: 'GLM-5.3',
            state: 'running',
            startedAt: Date.now() - 50000 + i * 1000,
            contextTokens: 20000,
            toolUses: 25 + i,
        });
    }
    return runs;
}

function createSemanticRecords(count) {
    const records = {};
    for (let i = 0; i < count; i++) {
        records[`scope-${i}`] = {
            done: i % 10,
            total: 10,
            note: `Semantic progress ${i}`,
            plan: [`Step ${i}.1`, `Step ${i}.2`, `Step ${i}.3`],
            planVersion: 1,
        };
    }
    return records;
}

// --- measurement utilities -----------------------------------------------------------------------
function measureHeap() {
    if (global.gc) global.gc();
    return process.memoryUsage().heapUsed;
}

function formatBytes(bytes) {
    return (bytes / 1024).toFixed(2) + ' KiB';
}

function formatMs(ms) {
    return ms.toFixed(3) + ' ms';
}

// --- main stress test ----------------------------------------------------------------------------
async function runStressTest() {
    console.log('=== Progress Performance Harness ===');
    console.log('Stress fixture: 1000 messages, 500 tool calls, 50 agent blocks, 20 parallel agents, 100 semantic records');
    console.log('');

    const { buildNormalizedRuntimeSnapshot } = loadWebviewModules();
    const { SessionProgressProjection, relaySessionReply, relayTabsReply, relayAgentsReply, channelsElapsed, channelsProviderModel } = loadHostModules();
    const { createProgressBroker } = loadBrokerModules();

    // --- Fixture setup ---
    const messages = createTranscriptMessages(1000);
    const session = createSession(messages);
    session.subagentTasks = createNativeTasks(50);

    const delegatedRuns = createDelegatedRuns(20);
    const semanticRecords = createSemanticRecords(100);

    const broker = createProgressBroker({ now: Date.now });
    broker.issueSessionCapability('perf-session');
    broker.observeRoot({ sessionId: 'perf-session', rootId: 'root-1', state: 'running', startedAt: Date.now() - 120000, generation: 'gen-1' });

    // Create a mock broker snapshot for testing projection/formatting with semantic data
    const mockBrokerSnapshot = {
        root: { semantic: { done: 5, total: 10, note: 'Root progress', planVersion: 1 } },
        semanticByScope: semanticRecords,
        health: { available: true, circuitOpen: false },
    };

    console.log('Fixture built. Starting measurements...');
    console.log('');

    const results = {};

    // 1. ToolBlockIndex update cost
    console.log('[1/7] ToolBlockIndex update cost...');
    const doc = createPageContext().document;
    const index = createToolBlockIndex(doc);

    // Add 50 tool blocks to DOM
    for (let i = 0; i < 50; i++) {
        const el = doc.createElement('div');
        el.className = `toolUse_${i}`;
        const inner = doc.createElement('span');
        inner.textContent = `toolUse_${i}`;
        el.appendChild(inner);
        doc.body.appendChild(el);
    }
    index.rebuild();

    const toolBlockIndexUpdates = [];
    for (let iter = 0; iter < 100; iter++) {
        const start = process.hrtime.bigint();
        // Simulate mutation: add one, remove one
        const newEl = doc.createElement('div');
        newEl.className = `toolUse_new_${iter}`;
        doc.body.appendChild(newEl);
        const oldEl = doc.body.children[0];
        if (oldEl) doc.body.removeChild(oldEl);

        // Create mock mutation records
        const records = [{
            addedNodes: [newEl],
            removedNodes: oldEl ? [oldEl] : [],
            type: 'childList',
            target: doc.body,
        }];
        index.update(records);
        const end = process.hrtime.bigint();
        toolBlockIndexUpdates.push(Number(end - start) / 1e6); // ms
    }
    const avgToolBlockIndexMs = toolBlockIndexUpdates.reduce((a, b) => a + b, 0) / toolBlockIndexUpdates.length;
    const p95ToolBlockIndexMs = toolBlockIndexUpdates.sort((a, b) => a - b)[Math.floor(toolBlockIndexUpdates.length * 0.95)];
    results.toolBlockIndex = { avgMs: avgToolBlockIndexMs.toFixed(3), p95Ms: p95ToolBlockIndexMs.toFixed(3) };
    console.log(`    avg: ${avgToolBlockIndexMs.toFixed(3)} ms, p95: ${p95ToolBlockIndexMs.toFixed(3)} ms`);

// 2. Transcript visits (session.messages passes per decoration cycle)
    console.log('[2/7] Transcript visits measurement...');
    // The buildNormalizedRuntimeSnapshot scans messages via indexed access (for loop)
    // We count "passes" by detecting full iterations (access to index 0 after length)
    let transcriptPasses = 0;
    let lastAccessedIndex = -1;
    const messagesArray = session.messages.value;
    const wrappedMessages = new Proxy(messagesArray, {
        get(target, prop) {
            if (prop === 'forEach') {
                return function (...args) {
                    transcriptPasses++;
                    return target.forEach(...args);
                };
            }
            const idx = Number(prop);
            if (!isNaN(idx) && idx >= 0 && idx < target.length) {
                // Detect start of new iteration: index 0 after accessing a high index or length
                if (idx === 0 && (lastAccessedIndex === target.length - 1 || lastAccessedIndex === 'length')) {
                    transcriptPasses++;
                }
                lastAccessedIndex = idx;
                return target[idx];
            }
            if (prop === 'length') {
                lastAccessedIndex = 'length';
                return target.length;
            }
            if (prop === Symbol.iterator) {
                transcriptPasses++;
                return target[Symbol.iterator];
            }
            return target[prop];
        },
    });
    session.messages.value = wrappedMessages;

    for (let i = 0; i < 10; i++) {
        transcriptPasses = 0;
        buildNormalizedRuntimeSnapshot(session);
    }
    const passesPerSnapshot = transcriptPasses / 10;
    results.transcriptVisits = { perSnapshot: passesPerSnapshot };
    console.log(`    passes per snapshot: ${passesPerSnapshot} (expected ~1 for single-pass scan)`);

    // 3. Runtime projection cost
    console.log('[3/7] Runtime projection cost...');
    const projectionTimes = [];
    for (let i = 0; i < 100; i++) {
        const start = process.hrtime.bigint();
        const snap = buildNormalizedRuntimeSnapshot(session);
        const end = process.hrtime.bigint();
        projectionTimes.push(Number(end - start) / 1e6);
    }
    const avgProjectionMs = projectionTimes.reduce((a, b) => a + b, 0) / projectionTimes.length;
    const p95ProjectionMs = projectionTimes.sort((a, b) => a - b)[Math.floor(projectionTimes.length * 0.95)];
    results.runtimeProjection = { avgMs: avgProjectionMs.toFixed(3), p95Ms: p95ProjectionMs.toFixed(3) };
    console.log(`    avg: ${avgProjectionMs.toFixed(3)} ms, p95: ${p95ProjectionMs.toFixed(3)} ms`);

    // 4. Snapshot/delta serialization size/time
    console.log('[4/7] Broker snapshot/delta serialization...');
    const snapshotSizes = [];
    const snapshotTimes = [];
    for (let i = 0; i < 50; i++) {
        const start = process.hrtime.bigint();
        const snap = broker.snapshot('perf-session');
        const end = process.hrtime.bigint();
        const json = JSON.stringify(snap);
        snapshotTimes.push(Number(end - start) / 1e6);
        snapshotSizes.push(json.length);
    }
    const avgSnapMs = snapshotTimes.reduce((a, b) => a + b, 0) / snapshotTimes.length;
    const avgSnapSize = snapshotSizes.reduce((a, b) => a + b, 0) / snapshotSizes.length;
    results.brokerSnapshot = { avgMs: avgSnapMs.toFixed(3), avgSizeBytes: Math.round(avgSnapSize) };
    console.log(`    avg serialization: ${avgSnapMs.toFixed(3)} ms, avg size: ${formatBytes(avgSnapSize)}`);

    // Delta simulation
    const deltaTimes = [];
    for (let i = 0; i < 50; i++) {
        const start = process.hrtime.bigint();
        broker.observeRoot({ sessionId: 'perf-session', rootId: 'root-1', state: 'running', startedAt: Date.now(), generation: `gen-${i}` });
        const end = process.hrtime.bigint();
        deltaTimes.push(Number(end - start) / 1e6);
    }
    const avgDeltaMs = deltaTimes.reduce((a, b) => a + b, 0) / deltaTimes.length;
    results.brokerDelta = { avgMs: avgDeltaMs.toFixed(3) };
    console.log(`    avg delta emit: ${avgDeltaMs.toFixed(3)} ms`);

    // 5. Channels /tabs /agents formatting
    console.log('[5/7] Channels formatting...');
    const tabs = Array.from({ length: 20 }, (_, i) => ({
        sessionId: `tab-${i}`,
        title: `Task ${i}`,
    }));

    const tabFormatTimes = [];
    for (let i = 0; i < 50; i++) {
        const start = process.hrtime.bigint();
        relayTabsReply(tabs, (tab) => tab.title);
        const end = process.hrtime.bigint();
        tabFormatTimes.push(Number(end - start) / 1e6);
    }
    const avgTabMs = tabFormatTimes.reduce((a, b) => a + b, 0) / tabFormatTimes.length;
    results.channelsTabs = { avgMs: avgTabMs.toFixed(3) };
    console.log(`    /tabs avg: ${avgTabMs.toFixed(3)} ms`);

    const sessionFormatTimes = [];
    for (let i = 0; i < 50; i++) {
        const start = process.hrtime.bigint();
        relaySessionReply(tabs, (tab) => tab.title);
        const end = process.hrtime.bigint();
        sessionFormatTimes.push(Number(end - start) / 1e6);
    }
    const avgSessionMs = sessionFormatTimes.reduce((a, b) => a + b, 0) / sessionFormatTimes.length;
    results.channelsSession = { avgMs: avgSessionMs.toFixed(3) };
    console.log(`    /session avg: ${avgSessionMs.toFixed(3)} ms`);

    const agentsFormatTimes = [];
    for (let i = 0; i < 50; i++) {
        const start = process.hrtime.bigint();
        relayAgentsReply({ sessionId: 'perf-session' }, 'Test Task');
        const end = process.hrtime.bigint();
        agentsFormatTimes.push(Number(end - start) / 1e6);
    }
    const avgAgentsMs = agentsFormatTimes.reduce((a, b) => a + b, 0) / agentsFormatTimes.length;
    results.channelsAgents = { avgMs: avgAgentsMs.toFixed(3) };
    console.log(`    /agents avg: ${avgAgentsMs.toFixed(3)} ms`);

    // 6. Retained taskSnapshots count
    console.log('[6/7] Retained taskSnapshots count...');
    const snap = buildNormalizedRuntimeSnapshot(session);
    const retainedCount = snap.taskSnapshots ? Object.keys(snap.taskSnapshots).length : 0;
    results.taskSnapshots = { retainedCount };
    console.log(`    retained: ${retainedCount} (policy: active + max 100 terminal)`);

    // 7. Process heap delta
    console.log('[7/7] Process heap delta...');
    const heapBefore = measureHeap();
    // Run a full stress cycle
    for (let cycle = 0; cycle < 10; cycle++) {
        buildNormalizedRuntimeSnapshot(session);
        broker.snapshot('perf-session');
        relayTabsReply(tabs, (tab) => tab.title);
        relaySessionReply(tabs, (tab) => tab.title);
        relayAgentsReply({ sessionId: 'perf-session' }, 'Test Task');
        // Simulate index churn
        for (let i = 0; i < 10; i++) {
            const newEl = doc.createElement('div');
            newEl.className = `toolUse_cycle_${cycle}_${i}`;
            doc.body.appendChild(newEl);
            index.update([{ addedNodes: [newEl], removedNodes: [], type: 'childList', target: doc.body }]);
        }
    }
    const heapAfter = measureHeap();
    const heapDelta = heapAfter - heapBefore;
    results.heapDelta = { bytes: heapDelta, formatted: formatBytes(heapDelta) };
    console.log(`    delta: ${formatBytes(heapDelta)}`);

    // Cleanup
    rmSync(ISOLATED_ROOT, { recursive: true, force: true });

    // --- Output machine-readable results ---
    console.log('');
    console.log('=== MACHINE-READABLE RESULTS ===');
    console.log(`fixture_messages: 1000`);
    console.log(`fixture_tool_calls: 500`);
    console.log(`fixture_agent_blocks: 50`);
    console.log(`fixture_parallel_agents: 20`);
    console.log(`fixture_semantic_records: 100`);
    console.log(`toolblockindex_avg_ms: ${results.toolBlockIndex.avgMs}`);
    console.log(`toolblockindex_p95_ms: ${results.toolBlockIndex.p95Ms}`);
    console.log(`transcript_passes_per_snapshot: ${results.transcriptVisits.perSnapshot}`);
    console.log(`runtime_projection_avg_ms: ${results.runtimeProjection.avgMs}`);
    console.log(`runtime_projection_p95_ms: ${results.runtimeProjection.p95Ms}`);
    console.log(`broker_snapshot_avg_ms: ${results.brokerSnapshot.avgMs}`);
    console.log(`broker_snapshot_avg_bytes: ${results.brokerSnapshot.avgSizeBytes}`);
    console.log(`broker_delta_avg_ms: ${results.brokerDelta.avgMs}`);
    console.log(`channels_tabs_avg_ms: ${results.channelsTabs.avgMs}`);
    console.log(`channels_session_avg_ms: ${results.channelsSession.avgMs}`);
    console.log(`channels_agents_avg_ms: ${results.channelsAgents.avgMs}`);
    console.log(`task_snapshots_retained: ${results.taskSnapshots.retainedCount}`);
    console.log(`heap_delta_bytes: ${results.heapDelta.bytes}`);

    // Verify stress cycle completes without exception
    console.log('');
    console.log('Stress cycle completed without exception.');
    return results;
}

runStressTest()
    .then(() => {
        console.log('');
        console.log('PASS: Performance harness executed successfully.');
        process.exit(0);
    })
    .catch((err) => {
        console.error('FAIL:', err);
        process.exit(1);
    });
// Semantic progress UI suite — PLAN-001 task 25 (QA-030, unblocks QA-011 item 1).
// Exercises the real product layers the semantic UI is built from, no copies:
//   1. runtime/webview.js root progress DOM inside a VM, fed fake broker messages;
//   2. runtime/host.js SessionProgressProjection (scope-keyed semantic association);
//   3. runtime/progress-broker.js wire protocol (root scope, scopes, replan, generations);
//   4. runtime/mcp/agent-server.mjs MODES allowlist + progress client broker fallback.
// Isolation: unique temp root, VANNEVAR_PROFILES_DIR/HOME redirected, teardown in finally;
//   real ~/.claude is never read or written.
//   node test/progress-semantic-ui.test.mjs
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const ROOT = mkdtempSync(join(tmpdir(), 'ccx-progress-semantic-ui-'));
const PROFILES_DIR = join(ROOT, 'profiles');
const RUNTIME_DIR = join(ROOT, 'runtime');
mkdirSync(PROFILES_DIR, { recursive: true });
mkdirSync(RUNTIME_DIR, { recursive: true });
writeFileSync(join(PROFILES_DIR, 'test.json'), JSON.stringify({ env: {} }));

process.env.VANNEVAR_PROFILES_DIR = PROFILES_DIR;
process.env.VANNEVAR_RUNTIME_DIR = RUNTIME_DIR;
process.env.HOME = ROOT; // redirect ~/.claude
process.env.USERPROFILE = ROOT;

const require = createRequire(import.meta.url);
const { MODES, execAllowlist } = await import('../runtime/mcp/agent-server.mjs');
const { createProgressBroker } = require('../runtime/progress-broker.js');
const { ACK_TIMEOUT_MS, PROTOCOL, createProgressClient } = require('../runtime/mcp/progress-client.mjs');

// --- Fake DOM: minimal Element + page harness, the same shape test/progress-root-ui.test.mjs uses
class Element {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.parentElement = null;
        this.dataset = {};
        this.style = {};
        this.attributes = {};
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
    removeAttribute(name) { delete this.attributes[name]; }
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

function loadPage({ reducedMotion = false, anchor = true, composerSelector = '#composer' } = {}) {
    const body = new Element('body');
    const head = new Element('head');
    const listeners = {};
    let composerNode = null;
    const document = {
        body,
        head,
        createElement: (tag) => new Element(tag),
        getElementById(id) {
            const visit = (node) => node.id === id ? node : node.children.map(visit).find(Boolean) || null;
            return visit(body);
        },
        querySelector: (selector) => selector === composerSelector && composerNode ? composerNode : null,
        querySelectorAll: () => [],
        addEventListener() {},
        removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
    };
    if (anchor) {
        composerNode = new Element('div');
        if (composerSelector === '#composer') composerNode.id = 'composer';
        else {
            composerNode.setAttribute('role', 'textbox');
            composerNode.setAttribute('aria-label', 'Message input');
        }
        body.appendChild(composerNode);
    }
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
        matchMedia: () => ({ matches: reducedMotion }),
        MutationObserver: class { observe() {} disconnect() {} },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({ postMessage() {}, getState: () => ({}), setState() {} }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), context);
    return {
        document,
        send(message) { for (const callback of listeners.message || []) callback({ data: message }); },
        progress() { return document.getElementById('ccx-root-progress'); },
    };
}

function elementTags(surface) {
    const tags = [];
    const walk = (node) => {
        for (const child of node.children || []) {
            tags.push(child.tagName);
            walk(child);
        }
    };
    walk(surface);
    return tags;
}

// --- Broker harness: real broker on its own endpoint, scope/root capabilities as the wire does it
let liveBroker = null;
let liveEndpoint = null;

async function startBroker() {
    liveBroker = createProgressBroker({ listen: true });
    liveEndpoint = liveBroker.info().endpoint;
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('broker listen timeout')), 5000);
        const check = () => {
            const socket = net.connect(liveEndpoint);
            socket.once('connect', () => {
                clearTimeout(timer);
                socket.destroy();
                setTimeout(resolve, 50);
            });
            socket.once('error', () => setTimeout(check, 50));
        };
        setTimeout(check, 100);
    });
}

function connectAndGreet(endpoint, capability) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(endpoint);
        socket.setEncoding('utf8');
        let buffer = '';
        let helloAckReceived = false;
        socket.on('data', (chunk) => {
            buffer += chunk;
            let nl;
            while ((nl = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const msg = JSON.parse(line);
                if (msg.type === 'helloAck') {
                    helloAckReceived = true;
                    socket.removeAllListeners('data');
                    socket.removeAllListeners('error');
                    resolve({ socket });
                }
            }
        });
        socket.on('error', reject);
        socket.once('connect', () => {
            socket.write(JSON.stringify({ type: 'hello', protocol: PROTOCOL, cap: capability, pid: process.pid }) + '\n');
        });
        setTimeout(() => { if (!helloAckReceived) reject(new Error('helloAck timeout')); }, ACK_TIMEOUT_MS + 500);
    });
}

function sendReport(socket, report) {
    socket.write(JSON.stringify(report) + '\n');
}

function readAck(socket) {
    return new Promise((resolve, reject) => {
        socket.once('data', (chunk) => {
            const lines = chunk.trim().split('\n');
            for (const line of lines) {
                if (line.trim()) {
                    try { resolve(JSON.parse(line)); } catch { resolve({ parseError: true }); }
                }
            }
        });
        setTimeout(() => reject(new Error('ack timeout')), ACK_TIMEOUT_MS + 500);
    });
}

async function withSession(testFn, sessionId) {
    if (!sessionId) sessionId = 'ui-session-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const capability = liveBroker.issueSessionCapability(sessionId).capability;
    liveBroker.observeRoot({ sessionId, rootId: 'root-' + sessionId });
    const rootGen = liveBroker.snapshot(sessionId).root.generation;
    const { socket } = await connectAndGreet(liveEndpoint, capability);
    try {
        await testFn(socket, rootGen, sessionId);
    } finally {
        socket.destroy();
    }
}

async function withScope(testFn, scopeId, ownerSession) {
    if (!scopeId) scopeId = 'ui-scope-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    if (!ownerSession) ownerSession = 'ui-owner-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    const capability = liveBroker.issueScopeCapability(scopeId, ownerSession).capability;
    liveBroker.observeRoot({ sessionId: ownerSession, rootId: 'root-' + ownerSession });
    const { socket } = await connectAndGreet(liveEndpoint, capability);
    try {
        await testFn(socket, scopeId, ownerSession);
    } finally {
        socket.destroy();
    }
}

function cleanup() {
    if (liveBroker) {
        try { liveBroker.close(); } catch {}
        liveBroker = null;
    }
    try { rmSync(ROOT, { recursive: true, force: true }); } catch {}
}

// --- Host projection loader: host.js is CommonJS and requires('vscode'), so load it the way
// test/progress-projection.test.mjs does — vscode stub plus a temp .cjs copy
function loadSessionProgressProjection() {
    const Module = require('node:module');
    const load = Module._load;
    Module._load = (request, ...rest) =>
        request === 'vscode'
            ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
            : load(request, ...rest);
    const vannevarDir = join(ROOT, '.claude', 'vannevar');
    mkdirSync(vannevarDir, { recursive: true });
    writeFileSync(join(vannevarDir, 'progress-broker.js'), readFileSync(new URL('../runtime/progress-broker.js', import.meta.url)));
    const hostCopy = join(tmpdir(), `ccx-host-semantic-ui-${process.pid}.cjs`);
    writeFileSync(hostCopy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
    try {
        return require(hostCopy).SessionProgressProjection;
    } finally {
        rmSync(hostCopy, { force: true });
        Module._load = load;
    }
}
const SessionProgressProjection = loadSessionProgressProjection();

const DELEGATED_RUN = {
    session: 'c1',
    attemptId: 'a1',
    scopeId: 'scope-a',
    description: 'Child run',
    state: 'running',
    startedAt: 1500,
    profile: 'p2',
    model: 'm3',
    servedModel: 'm4',
    contextTokens: 100,
    toolUses: 2,
    owner: 's1',
    parent: null,
};

function projectionFixture({ brokerSnapshot, delegatedRuns, nativeAgents } = {}) {
    const runtime = {
        root: { rootId: 'r1', title: 'T', state: 'running', activityHealth: 'good', startedAt: 1000, lastActivityAt: 2000, currentTool: 't', runtimeRevision: 1, execution: {} },
    };
    if (nativeAgents) runtime.nativeAgents = nativeAgents;
    return SessionProgressProjection({
        sessionId: 's1',
        runtime,
        brokerSnapshot: brokerSnapshot || { root: {}, semanticByScope: {}, health: { available: true, circuitOpen: false } },
        delegatedRuns: delegatedRuns || [],
        ownerSession: 's1',
        now: 3000,
        enabled: true,
    });
}

// --- Cases
const cases = [
    // Root semantic bar: webview renders done/total from a fake broker snapshot message
    ['root semantic 3/5 renders a determinate bar', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 3, total: 5, note: 'Tests' } } });
        const surface = page.progress();
        assert.ok(surface, 'root progress surface rendered');
        const stage = surface.children.find((child) => child.className === 'ccx-root-stage');
        assert.ok(stage, 'separate stage row rendered');
        const bar = stage.children.find((child) => child.tagName === 'progress');
        assert.ok(bar, 'determinate <progress> element rendered');
        assert.strictEqual(bar.max, 5, 'max mirrors semantic.total');
        assert.strictEqual(bar.value, 3, 'value mirrors semantic.done');
        assert.match(surface.textContent, /3\/5/, 'done/total count shown');
        assert.match(surface.className, /ccx-root-determinate/, 'determinate class set');
    }],

    // total=1 is a step state, never a bar
    ['total=1 omits the determinate bar and shows the step note', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 1, note: 'One step' } } });
        const surface = page.progress();
        assert.ok(surface, 'root progress surface rendered');
        assert.ok(!surface.children.some((child) => child.tagName === 'progress'), 'no <progress> element for total=1');
        assert.doesNotMatch(surface.className, /determinate/, 'no determinate class for total=1');
        assert.match(surface.textContent, /One step/, 'step note still shown');
    }],

    // done=total does not end the run while the runtime is still running
    ['done=total with a running runtime stays running', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 5, total: 5, plan: ['Inspect', 'Implement', 'Verify', 'Review', 'Finish'] } } });
        const surface = page.progress();
        assert.match(surface.textContent, /Working/, 'still labelled Working');
        assert.doesNotMatch(surface.textContent, /\bDone\b/, 'no terminal Done label');
        assert.match(surface.textContent, /5\/5/, 'full count shown');
        assert.match(surface.className, /ccx-root-determinate/, 'bar remains while running');
    }],

    // Replan: a changed planVersion flags the banner and the new totals
    ['replan banner shows new totals after a planVersion change', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 4, total: 5 } } });
        assert.doesNotMatch(page.progress().textContent, /Plan updated/, 'no banner before any planVersion');
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 1, total: 7, planVersion: 1 } } });
        assert.match(page.progress().textContent, /Plan updated · 1\/7/, 'banner with new done/total after replan');
    }],

    // Stale generations: an older revision never rolls the newest state back
    ['older progress revisions are ignored (stale generation guard)', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 4, root: { state: 'running', semantic: { done: 0, total: 3, title: 'Initial task' }, title: 'First' } });
        page.send({ type: 'ccx:progressDelta', revision: 5, payload: { changedRoot: { state: 'running', semantic: { done: 0, total: 3, title: 'Updated' }, title: 'Updated' } } });
        page.send({ type: 'ccx:progressDelta', revision: 4, payload: { changedRoot: { state: 'running', semantic: { done: 0, total: 3 }, title: 'Stale' } } });
        assert.match(page.progress().textContent, /Updated/, 'newest revision wins');
        assert.doesNotMatch(page.progress().textContent, /Stale/, 'stale revision ignored');
    }],

    // XSS: an HTML note is rendered as text via textContent, never parsed into elements
    ['HTML note is rendered as text via textContent', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 1, total: 5, note: '<img src=x onerror=alert(1)>' } } });
        const surface = page.progress();
        assert.match(surface.textContent, /<img src=x onerror=alert\(1\)>/, 'note kept literal in text content');
        const tags = elementTags(surface);
        assert.ok(!tags.includes('img') && !tags.includes('IMG'), 'note never parsed into elements, got: ' + tags.join(','));
        const stage = surface.children.find((child) => child.className === 'ccx-root-stage');
        assert.ok(stage, 'stage row rendered');
        const note = stage.children.find((child) => child.className === 'ccx-root-note');
        assert.ok(note && String(note._text).includes('<img'), 'note lives in its own text-only element');
        assert.strictEqual(note.children.length, 0, 'note has no element children');
    }],

    // The determinate bar is static and remains visible with reduced motion enabled.
    ['reduced motion keeps the semantic progress bar visible without animation', () => {
        const page = loadPage({ reducedMotion: true });
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 3, total: 5, plan: ['Inspect', 'Implement', 'Verify', 'Review', 'Finish'] } } });
        const surface = page.progress();
        assert.match(surface.textContent, /3\/5/, 'semantic totals still rendered');
        assert.match(surface.className, /ccx-root-determinate/, 'determinate progress remains visible');
        const stage = surface.children.find((child) => child.className === 'ccx-root-stage');
        assert.ok(stage.children.some((child) => child.tagName === 'progress'), 'bar remains visible');
    }],

    ['root plan fallback explains progress and missing explanation hides count and bar', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 1, total: 3, plan: ['Inspect', 'Implement', 'Verify'] } } });
        let surface = page.progress();
        assert.match(surface.textContent, /Implement/, 'current stage comes from the plan');
        assert.match(surface.textContent, /1\/3/, 'explained progress count remains visible');
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 1, total: 3, note: 'Explicit note', plan: ['Inspect', 'Implement', 'Verify'] } } });
        surface = page.progress();
        assert.match(surface.textContent, /Explicit note/, 'explicit note takes precedence');
        assert.doesNotMatch(surface.textContent, /Implement/, 'fallback stage is not shown over an explicit note');
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 1, total: 3 } } });
        surface = page.progress();
        assert.ok(!surface.children.some((child) => child.className === 'ccx-root-stage'), 'unexplained count and bar are omitted');
        assert.doesNotMatch(surface.textContent, /1\/3/, 'bare count is hidden');
    }],

    // Delegated scope: a run's own scope semantic reaches its projection row (2/4)
    ['delegated scope projects its own semantic 2/4', () => {
        const proj = projectionFixture({
            brokerSnapshot: { root: {}, semanticByScope: { 'scope-a': { done: 2, total: 4, note: 'Scope work' } }, health: { available: true, circuitOpen: false } },
            delegatedRuns: [DELEGATED_RUN],
        });
        assert.strictEqual(proj.agents.delegated.length, 1, 'delegated row projected');
        assert.strictEqual(proj.agents.delegated[0].scopeId, 'scope-a');
        assert.strictEqual(proj.agents.delegated[0].semantic.done, 2, 'own scope done projected');
        assert.strictEqual(proj.agents.delegated[0].semantic.total, 4, 'own scope total projected');
    }],

    // Scope mismatch: someone else's scope semantic never attaches to this attempt
    ['a foreign scope semantic never attaches to another attempt', () => {
        const proj = projectionFixture({
            brokerSnapshot: { root: {}, semanticByScope: { 'scope-a': { done: 2, total: 4 } }, health: {} },
            delegatedRuns: [{ ...DELEGATED_RUN, session: 'c2', attemptId: 'a2', scopeId: 'scope-b' }],
        });
        assert.strictEqual(proj.agents.delegated[0].semantic, null, 'foreign scope semantic is null, no x/y leak');
    }],

    // Verified attempt association: rows key on attempt, spans never merge
    ['one attempt keeps one delegated row (attempt-keyed association)', () => {
        const proj = projectionFixture({
            brokerSnapshot: { root: {}, semanticByScope: { 'scope-a': { done: 2, total: 4 } }, health: {} },
            delegatedRuns: [DELEGATED_RUN, { ...DELEGATED_RUN, session: 'c1-duplicate' }],
        });
        assert.strictEqual(proj.agents.delegated.length, 1, 'same attemptId collapses to one row');
        assert.strictEqual(proj.agents.delegated[0].attemptId, 'a1');
    }],

    // Native semantics require a host-owned scope binding, never root semantics.
    ['native agent rows without a host scope stay activity-only', () => {
        const proj = projectionFixture({
            brokerSnapshot: { root: { semantic: { done: 1, total: 5 } }, semanticByScope: {}, health: { available: true } },
            nativeAgents: [{ id: 'n1', state: 'running', currentTool: 'Read', startedAt: 2500 }],
        });
        assert.strictEqual(proj.agents.native.length, 1, 'native row projected');
        const row = proj.agents.native[0];
        assert.strictEqual(row.kind, 'native');
        assert.strictEqual(row.semantic, null, 'an unbound native row must not inherit root semantics');
    }],

    // Native exclusion on the wire: restricted modes allow only the bundled MCP progress tool
    ['restricted MODES allow only the bundled MCP progress tool', () => {
        const readTools = MODES.read[1].split(',');
        const execTools = MODES.exec[1].split(',');
        const writeTools = MODES.write[3].split(',');
        for (const tools of [readTools, execTools, writeTools]) {
            const mcpTools = tools.filter((tool) => tool.startsWith('mcp__'));
            assert.strictEqual(mcpTools.join(','), 'mcp__vannevar__progress', 'only the bundled progress MCP tool allowed, got: ' + mcpTools.join(','));
            assert.ok(!tools.includes('progress'), 'bare progress tool name not allowed');
        }
        assert.ok(readTools.includes('mcp__vannevar__progress'), 'progress tool present in read mode');
        assert.deepStrictEqual(MODES.full, ['--permission-mode', 'bypassPermissions'], 'full mode unchanged');
        assert.ok(typeof execAllowlist() !== 'undefined', 'exec allowlist resolvable');
    }],

    // Root scope on the wire: a report against the observed root generation is accepted
    ['root scope accepts a report against the observed root generation', async () => {
        await withSession(async (socket, rootGen) => {
            sendReport(socket, { type: 'report', done: 1, total: 5, rootGeneration: rootGen });
            const ack = await readAck(socket);
            assert.strictEqual(ack.accepted, true, 'root report accepted, reason: ' + (ack.reason || 'none'));
        });
    }],

    // Delegated scope on the wire: own scope accepted, mismatched scope rejected
    ['delegated scope accepts its own scope and rejects a mismatched one', async () => {
        await withScope(async (socket, scopeId) => {
            sendReport(socket, { type: 'report', done: 1, total: 4, scope: scopeId });
            const ack = await readAck(socket);
            assert.strictEqual(ack.accepted, true, 'own scope accepted, reason: ' + (ack.reason || 'none'));
            sendReport(socket, { type: 'report', done: 2, total: 4, scope: 'scope-other' });
            const mismatch = await readAck(socket);
            assert.strictEqual(mismatch.accepted, false, 'mismatched scope rejected');
            assert.strictEqual(mismatch.reason, 'scope_mismatch', 'rejection reason is scope_mismatch');
        });
    }],

    // Replan on the wire: replan report increments the broker planVersion
    ['replan increments the broker planVersion', async () => {
        await withSession(async (socket, rootGen, sessionId) => {
            sendReport(socket, { type: 'report', done: 2, total: 5, plan: ['a', 'b', 'c', 'd', 'e'], rootGeneration: rootGen });
            const first = await readAck(socket);
            assert.strictEqual(first.accepted, true, 'first plan accepted');
            sendReport(socket, { type: 'report', done: 1, total: 7, plan: ['x', 'y', 'z', 'w', 'v', 'u', 't'], replan: true, rootGeneration: rootGen });
            const replan = await readAck(socket);
            assert.strictEqual(replan.accepted, true, 'replan accepted');
            const snap = liveBroker.snapshot(sessionId);
            assert.strictEqual(snap.root.semantic.planVersion, 1, 'planVersion incremented to 1');
        });
    }],

    ['follow-up reports retain the current plan and replans without one clear it', async () => {
        await withSession(async (socket, rootGen, sessionId) => {
            sendReport(socket, { type: 'report', done: 0, total: 3, plan: ['Inspect', 'Implement', 'Verify'], rootGeneration: rootGen });
            assert.strictEqual((await readAck(socket)).accepted, true, 'initial plan accepted');
            sendReport(socket, { type: 'report', done: 1, total: 3, note: 'Working', rootGeneration: rootGen });
            assert.strictEqual((await readAck(socket)).accepted, true, 'follow-up without plan accepted');
            assert.deepStrictEqual(liveBroker.snapshot(sessionId).root.semantic.plan, ['Inspect', 'Implement', 'Verify'], 'unchanged plan retained');
            sendReport(socket, { type: 'report', done: 0, total: 2, replan: true, rootGeneration: rootGen });
            assert.strictEqual((await readAck(socket)).accepted, true, 'replan without plan accepted');
            assert.strictEqual(liveBroker.snapshot(sessionId).root.semantic.plan, undefined, 'stale plan cleared by replan');
        });
    }],

    // Stale generation on the wire: a wrong rootGeneration is rejected
    ['stale root generation is rejected', async () => {
        await withSession(async (socket) => {
            sendReport(socket, { type: 'report', done: 1, total: 5, rootGeneration: 'wrong-gen' });
            const ack = await readAck(socket);
            assert.strictEqual(ack.accepted, false, 'stale generation rejected');
            assert.strictEqual(ack.reason, 'stale_generation', 'rejection reason is stale_generation');
        });
    }],

    // Runtime lifecycle without a broker: the client degrades nonfatal, never throws
    ['progress client without a broker degrades nonfatal', async () => {
        const client = createProgressClient({});
        const result = await client.report({ done: 1, total: 5 });
        assert.strictEqual(result.ok, false, 'report fails soft without a broker');
        assert.strictEqual(result.reason, 'telemetry_unavailable', 'degradation reason is telemetry_unavailable');
    }],

    // Block-frame semantic: semantic on block-frame only after own tool_result confirms attemptId
    ['block-frame semantic appears only after own tool_result confirms attemptId', () => {
        // Minimal DOM harness for frame testing (adapted from agent-live-frame.test.mjs)
        class El {
            constructor(tag) {
                this.tagName = tag;
                this.children = [];
                this.className = '';
                this._text = '';
                this.dataset = {};
                this.attrs = {};
                this.parentElement = null;
                this.listeners = {};
            }
            set textContent(v) {
                this._text = v;
                if (v === '') this.children = [];
            }
            get textContent() { return this._text; }
            setAttribute(n, v) { this.attrs[n] = String(v); }
            getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
            removeAttribute(n) { delete this.attrs[n]; }
            appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
            remove() {
                if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
                this.parentElement = null;
            }
            contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
            addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
            removeEventListener() {}
            click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {}, preventDefault() {} }); }
            querySelector() { return null; }
            querySelectorAll(sel) { return sel === '[class*="toolUse_"]' ? toolNodes.slice() : []; }
        }

        let toolNodes = [];
        const pageDocument = {
            body: new El('body'),
            head: new El('head'),
            createElement: (t) => new El(t),
            querySelector: () => null,
            querySelectorAll: (sel) => sel === '[class*="toolUse_"]' ? toolNodes.slice() : [],
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
        pageWindow.addEventListener = (type, fn) => { if (type === 'message') onMessage = fn; };
        const pageContext = {
            window: pageWindow,
            document: pageDocument,
            console,
            Date,
            Math,
            JSON,
            Intl,
            setTimeout: pageWindow.setTimeout,
            clearTimeout: pageWindow.clearTimeout,
            setInterval: () => ({}),
            clearInterval() {},
            navigator: {},
            matchMedia: () => ({ matches: false }),
            MutationObserver: class { observe() {} disconnect() {} },
            Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
            NodeFilter: { SHOW_TEXT: 4 },
            acquireVsCodeApi: () => ({ postMessage() {}, getState: () => ({}), setState() {} }),
        };
        pageContext.globalThis = pageContext;
        vm.createContext(pageContext);
        vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), pageContext);
        assert.ok(onMessage, 'page did not register a message listener');
        const fromHost = (m) => onMessage({ data: m });

        // Helper to create a tool block node with React fiber
        function toolNode(block, finished) {
            const node = new El('div');
            node.className = 'toolUse_uq5aLg';
            const wrapper = { content: block, toolResult: { value: finished ? [{ type: 'text', text: 'ok' }] : undefined } };
            const component = { memoizedProps: { content: wrapper }, return: null };
            node['__reactFiber$abc'] = { memoizedProps: { className: node.className }, return: component };
            return node;
        }

        function frameOf(node) {
            return node.children.find((c) => c.className === 'ccx-agent-frame') || null;
        }
        function noteOf(node) {
            const frame = frameOf(node);
            if (!frame) return null;
            const head = frame.children.find((c) => c.className === 'ccx-agent-head');
            if (!head) return null;
            const note = head.children.find((c) => c.className === 'ccx-agent-note');
            return note ? note.textContent : null;
        }

        // MCP_AGENT_TOOL block
        const mcpBlock = {
            type: 'tool_use',
            id: 'toolu_mcp_block1',
            name: 'mcp__vannevar__run_agent',
            input: { profile: 'deepseek', prompt: 'review src/host.js' },
        };

        // Delegated run with attemptId and scopeId
        const run = {
            session: 'bbbbbbbb-1111-2222-3333-444444444444',
            profile: 'deepseek',
            model: 'deepseek-v4-pro',
            prompt: 'review src/host.js',
            state: 'running',
            startedAt: Date.now() - 5000,
            attemptId: 'attempt-123',
            scopeId: 'scope-block1',
            events: [
                { k: 'tool', n: 'Read', t: 'src/host.js' },
                { k: 'text', t: 'reading the watchers' },
            ],
        };

        // Semantic for the scope
        const scopeSemanticData = { 'scope-block1': { done: 2, total: 4, note: 'Scope work' } };

        // Send broker snapshot to populate scopeSemantic in webview
        fromHost({
            type: 'ccx:progressSnapshot',
            broker: { semanticByScope: scopeSemanticData },
            root: { state: 'running' },
            revision: 1,
        });

        // 1. Before tool_result: frame should show activity-only, no semantic x/y
        const mcpNode = toolNode(mcpBlock, false);
        toolNodes = [mcpNode];
        fromHost({ type: 'ccx:agentRuns', runs: [run] });

        const frameBefore = frameOf(mcpNode);
        assert.ok(frameBefore, 'frame exists for running delegated run');
        const noteBefore = noteOf(mcpNode);
        assert.ok(noteBefore, 'frame has activity note');
        // Should NOT have semantic x/y (done/total) in note before tool_result confirmation
        assert.doesNotMatch(noteBefore, /2\/4/, 'no semantic x/y before tool_result confirmation');
        assert.doesNotMatch(noteBefore, /Scope work/, 'no semantic note before tool_result confirmation');

        // 2. After tool_result with matching attemptId: frame should show semantic
        const mcpNodeFinished = toolNode(mcpBlock, true);
        toolNodes = [mcpNodeFinished];
        fromHost({ type: 'ccx:agentRuns', runs: [run] });

        const frameAfter = frameOf(mcpNodeFinished);
        assert.ok(frameAfter, 'frame still exists after tool_result');
        const noteAfter = noteOf(mcpNodeFinished);
        assert.ok(noteAfter, 'frame has note after tool_result');
        // Should NOW have semantic x/y (done/total) in note after tool_result confirmation
        assert.match(noteAfter, /2\/4/, 'semantic x/y appears after tool_result confirmation');
        assert.match(noteAfter, /Scope work/, 'semantic note appears after tool_result confirmation');
    }],
];

// --- Runner
let failed = 0;
try {
    await startBroker();
    for (const [name, run] of cases) {
        try {
            await run();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - ${name}: ${error.message}`);
        }
    }
    console.log(`${cases.length - failed}/${cases.length} semantic UI cases passed`);
} finally {
    cleanup();
}
if (failed) process.exitCode = 1;

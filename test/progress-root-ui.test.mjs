// QA-003: exercise root progress through the real webview page script in a VM DOM.
// Run with: node test/progress-root-ui.test.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const root = mkdtempSync(join(tmpdir(), 'ccx-progress-root-ui-'));

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
    closest(tag) {
        let node = this;
        while (node) {
            if (node.tagName === tag) return node;
            node = node.parentElement;
        }
        return null;
    }
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

const cases = [
    ['activity-only has no fabricated percentage', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', activityHealth: 'fresh' } });
        assert.equal(page.progress(), null, 'activity without stages must not occupy composer space');
    }],
    ['root progress anchors to the app composer input', () => {
        const page = loadPage({ composerSelector: '[role="textbox"][aria-label="Message input"]' });
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3 } } });
        assert.ok(page.progress(), 'root progress surface exists');
        assert.match(page.progress().textContent, /Working/);
    }],
    ['progress is outside the composer form and disappears on completion', () => {
        const page = loadPage({ composerSelector: '[role="textbox"][aria-label="Message input"]' });
        const input = page.document.querySelector('[role="textbox"][aria-label="Message input"]');
        input.remove();
        const form = page.document.createElement('form');
        const fieldset = page.document.createElement('fieldset');
        fieldset.appendChild(input);
        form.appendChild(fieldset);
        page.document.body.appendChild(form);
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 } } });
        assert.equal(page.progress().parentElement, form.parentElement);
        assert.equal(page.document.body.children.indexOf(page.progress()) + 1, page.document.body.children.indexOf(form));
        page.send({ type: 'ccx:progressDelta', revision: 2, payload: { changedRoot: { state: 'done' } } });
        assert.equal(page.progress(), null);
        assert.equal(input.parentElement, fieldset);
    }],
    ['semantic progress separates the counter, note and full-width bar', () => {
        const page = loadPage();
        const noteText = 'Long note stays on one line while the bar remains below it';
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 3, total: 5, note: noteText } } });
        const [title, detail, stage] = page.progress().children;
        assert.equal(title.className, 'ccx-root-title');
        assert.equal(detail.className, 'ccx-root-detail');
        assert.doesNotMatch(detail.textContent, /Long note/, 'stage note stays out of the activity metadata line');
        assert.equal(stage.className, 'ccx-root-stage');
        assert.equal(stage.children[0].textContent, '3/5');
        assert.equal(stage.children[1].className, 'ccx-root-note');
        assert.equal(stage.children[1].textContent, noteText);
        assert.equal(stage.children[1].getAttribute('title'), noteText, 'truncated note stays available on hover');
        assert.equal(stage.children[2].tagName, 'progress');
        const css = page.document.head.children[0].textContent;
        assert.match(css, /grid-template-columns:5ch minmax\(0,1fr\)/);
        assert.match(css, /text-overflow:ellipsis;white-space:nowrap/);
        assert.match(css, /width:100%/);
        assert.match(css, /#ccx-root-progress\{[^}]*background:var\(--vscode-editorWidget-background, var\(--vscode-editor-background, #202020\)\)/,
            'the progress panel paints a theme-aware opaque background');
    }],
    ['child scopes never render in the root panel', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 1, total: 2 } },
            broker: { nativeScopes: {}, semanticByScope: {
                'scope_5af1': { done: 1, total: 3, note: 'Delegated run' },
                'native-cccc3333': { done: 9, total: 3, note: 'Overreported' },
                'native-dddd4444': { note: 'No counts' },
            } } });
        const text = page.progress().textContent;
        assert.doesNotMatch(text, /Agent|scope|Delegated run|Overreported|No counts/,
            'a subagent progress row does not belong above the composer');
    }],
    ['clearing stages removes the panel and new stages restore it', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 } } });
        assert.ok(page.progress());
        page.send({ type: 'ccx:progressDelta', revision: 2, payload: { changedRoot: { state: 'running' } } });
        assert.equal(page.progress(), null);
        page.send({ type: 'ccx:progressDelta', revision: 3, payload: { changedRoot: { state: 'running', semantic: { done: 1, total: 3, plan: ['Inspect', 'Implement', 'Verify'] } } } });
        assert.match(page.progress().textContent, /1\/3/);
        assert.match(page.progress().textContent, /Implement/);
        page.send({ type: 'ccx:progressDelta', revision: 4, payload: { changedRoot: { state: 'running', semantic: { done: 1, total: 3 } } } });
        assert.doesNotMatch(page.progress().textContent, /1\/3/, 'the count is hidden without an explanatory note or plan');
    }],
    ['invalid stages do not display a panel', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 4, total: 3 } } });
        assert.equal(page.progress(), null);
    }],
    ['total one omits determinate bar', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 1, note: 'One step' } } });
        assert.doesNotMatch(page.progress().className, /determinate/);
        assert.match(page.progress().textContent, /One step/);
    }],
    ['stale activity remains running and is labelled stale', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3 }, activityHealth: 'stale' } });
        assert.match(page.progress().textContent, /stale|checking/i);
        assert.doesNotMatch(page.progress().textContent, /Done|Failed|Stopped/);
    }],
    ...['done', 'failed', 'stopped'].map((state) => [`${state} is shown as a terminal state`, () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state } });
        assert.equal(page.progress(), null, 'terminal task must release the composer space');
    }]),
    ['current tool is omitted when no tool is active', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3 }, currentTool: null } });
        assert.doesNotMatch(page.progress().textContent, /undefined|null/);
    }],
    ['provider switch hides served model from an older generation', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3 }, execution: { providerProfile: 'new-provider', requestedModel: 'sonnet', servedModel: 'old-model', providerGeneration: 8, servedModelGeneration: 7 } } });
        assert.match(page.progress().textContent, /new-provider/);
        assert.doesNotMatch(page.progress().textContent, /old-model/);
    }],
    ['root title uses semantic gist and never leaks raw user title', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3, title: 'Build extension' }, title: 'private user prompt' } });
        assert.match(page.progress().textContent, /Build extension/);
        assert.doesNotMatch(page.progress().textContent, /private user prompt/);
    }],
    ['showTitle false hides even semantic gist', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3, title: 'Build extension' }, title: 'private user prompt', showTitle: false } });
        assert.doesNotMatch(page.progress().textContent, /Build extension|private user prompt/);
        assert.match(page.progress().textContent, /Current task/);
    }],
    ['reduced motion disables the animated indicator', () => {
        const page = loadPage({ reducedMotion: true });
        page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3 } } });
        assert.doesNotMatch(page.progress().className, /indeterminate/);
    }],
    ['missing composer anchor degrades without throwing', () => {
        const page = loadPage({ anchor: false });
        assert.doesNotThrow(() => page.send({ type: 'ccx:progressSnapshot', root: { state: 'running', semantic: { done: 0, total: 3 } } }));
        assert.equal(page.progress(), null);
    }],
    ['snapshot and newer deltas update the surface while old revisions are ignored', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 4, root: { state: 'running', semantic: { done: 0, total: 3, title: 'Initial task' }, title: 'First' } });
        page.send({ type: 'ccx:progressDelta', revision: 5, payload: { changedRoot: { state: 'running', semantic: { done: 0, total: 3, title: 'Updated' }, title: 'Updated' } } });
        assert.match(page.progress().textContent, /Updated/);
        page.send({ type: 'ccx:progressDelta', revision: 4, payload: { changedRoot: { state: 'running', semantic: { done: 0, total: 3, title: 'Stale' }, title: 'Stale' } } });
        assert.match(page.progress().textContent, /Updated/);
        assert.doesNotMatch(page.progress().textContent, /Stale/);
    }],
    ['terminal delta removes its surface', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 } } });
        page.send({ type: 'ccx:progressDelta', revision: 2, payload: { changedRoot: null } });
        assert.equal(page.progress(), null);
    }],
    ['reported progress shows elapsed', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 }, startedAt: Date.now() - 150000, currentTool: 't' } });
        assert.match(page.progress().textContent, /t/);
        assert.match(page.progress().textContent, /2m/);
    }],
    ['reported progress shows provider/model', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 }, startedAt: Date.now() - 150000, currentTool: 't', execution: { providerProfile: 'z.ai', servedModel: 'GLM-5.3' } } });
        assert.match(page.progress().textContent, /t/);
        assert.match(page.progress().textContent, /2m/);
        assert.match(page.progress().textContent, /z\.ai\/GLM-5\.3/);
    }],
    ['reported progress shows child count', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 }, startedAt: Date.now() - 150000, nativeAgents: [{ id: 'a' }, { id: 'b' }] } });
        assert.match(page.progress().textContent, /2m/);
        assert.match(page.progress().textContent, /2 agents/);
    }],
    ['reported progress shows exact elapsed format 2m31s at 151000ms', () => {
        const page = loadPage();
        page.send({ type: 'ccx:progressSnapshot', revision: 1, root: { state: 'running', semantic: { done: 0, total: 3 }, startedAt: Date.now() - 151000 } });
        const text = page.progress().textContent;
        assert.match(text, /2m31s/);
        assert.doesNotMatch(text, /2m 31s/);
    }],
];

let failed = 0;
try {
    for (const [name, run] of cases) {
        try {
            run();
            console.log(`ok - ${name}`);
        } catch (error) {
            failed++;
            console.error(`not ok - ${name}: ${error.message}`);
        }
    }
    console.log(`${cases.length - failed}/${cases.length} root progress UI cases passed`);
} finally {
    rmSync(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;

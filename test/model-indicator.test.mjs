// The "Switch model… → <model>" indicator after a page load. A hold only lives in the page that made
// the switch; a window the user reloaded (or closed and reopened) has none, and the first state push
// finds the replayed transcript already naming whatever the previous provider answered with — a label
// that then sits there for as long as the tab stays idle. The page cannot know a switch happened, but
// it can know the one thing that matters: the model the replay wrote is one the active profile never
// offered. That load is the tail end of a switch, and the indicator is held until the active backend
// answers for itself.   node test/model-indicator.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this.textContent = '';
        this.style = {};
        this.dataset = {};
        this.parentElement = null;
        this.onclick = null;
        this.offsetParent = {};
    }
    append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
    appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this); this.parentElement = null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
    closest() { return null; }
    setAttribute() {}
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0 }; }
}

const source = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');

// Each test runs against its own freshly loaded page: the rule is about the FIRST state push a page
// ever sees, and a page sees exactly one of those.
function makePage(session) {
    const body = new El('body');
    const document = {
        body, head: new El('head'),
        createElement: (t) => new El(t),
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener() {}, removeEventListener() {},
        createTreeWalker: () => ({ nextNode: () => null }),
        execCommand: () => true,
    };
    const timers = [];
    const window = {
        document,
        addEventListener() {}, removeEventListener() {},
        getSelection: () => null,
        innerWidth: 1000, innerHeight: 800,
        setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
        clearTimeout: (t) => { if (t) t.cleared = true; },
    };
    window.window = window;
    let listener = null;
    window.addEventListener = (type, fn) => { if (type === 'message') listener = fn; };
    const context = {
        window, document, console,
        setTimeout: window.setTimeout, clearTimeout: window.clearTimeout,
        navigator: { clipboard: { writeText: () => Promise.resolve() } },
        MutationObserver: class { observe() {} },
        Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
        NodeFilter: { SHOW_TEXT: 4 },
        acquireVsCodeApi: () => ({ postMessage() {}, getState: () => ({}), setState() {} }),
    };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    const ccx = context.window.__ccx;
    assert.ok(typeof ccx.onRegistry === 'function', 'page did not install window.__ccx');
    const host = {
        commandRegistry: { registerAction() {}, subscribe() {}, executeCommand() {}, commandActions: new Map() },
        comms: { connection: { value: {} } },
    };
    ccx.onRegistry(host, () => null, session);
    return {
        pushState: (d) => listener({ data: { type: 'ccx:state', ...d } }),
        ioMessage: () => listener({ data: { type: 'from-extension', message: { type: 'io_message', channelId: 'ch1', message: { type: 'assistant' } } } }),
    };
}

const GLM_MODELS = { opus: 'GLM-5.3-Flash[1m]', sonnet: 'GLM-5.3-Flash[1m]', haiku: 'GLM-5.3-Flash', fable: 'glm-5.3[1m]' };
const CODEX_MODELS = { opus: 'gpt-6.1-sol', sonnet: 'gpt-6-luna', haiku: 'gpt-6-luna', fable: 'gpt-6.1-sol' };

// 1. A load replaying a transcript the active profile never served: the indicator is held.
{
    const session = {
        messages: { value: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }] },
        busy: { value: false },
        lastServedModel: { value: 'gpt-6.1-sol' },
        send: () => {},
    };
    const page = makePage(session);
    page.pushState({ active: 'glm', profiles: [], models: GLM_MODELS });
    assert.equal(session.lastServedModel.value, undefined, 'a foreign model on the first push must hold the indicator');
    // The active backend answers — a uuid the transcript did not hold — and the label reads its model.
    session.messages.value.push({ type: 'assistant', uuid: 'a2' });
    session.lastServedModel.value = 'GLM-5.3-Flash';
    page.ioMessage();
    assert.equal(session.lastServedModel.value, 'GLM-5.3-Flash', 'the active backend answer must end the hold');
}

// 2. The same load against the profile that did serve the transcript: the honest label stays.
{
    const session = {
        messages: { value: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }] },
        busy: { value: false },
        lastServedModel: { value: 'gpt-6.1-sol' },
        send: () => {},
    };
    const page = makePage(session);
    page.pushState({ active: 'codex', profiles: [], models: CODEX_MODELS });
    assert.equal(session.lastServedModel.value, 'gpt-6.1-sol', 'a model of the active profile must stay readable on a load');
}

// 3. The transcript records what the backend answered; the profile names what is requested. The [1m]
//    window suffix and the case are the same model and must not read as foreign.
{
    const session = {
        messages: { value: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }] },
        busy: { value: false },
        lastServedModel: { value: 'GLM-5.3-Flash' },
        send: () => {},
    };
    const page = makePage(session);
    page.pushState({ active: 'glm', profiles: [], models: GLM_MODELS });
    assert.equal(session.lastServedModel.value, 'GLM-5.3-Flash', 'a served name and its [1m] spelling are the same model');
}

// 4. No model list from the host — the stock claude profile sends none — means no verdict, and a
//    label the stock itself filled is never held on a guess.
{
    const session = {
        messages: { value: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }] },
        busy: { value: false },
        lastServedModel: { value: 'claude-opus-5-5' },
        send: () => {},
    };
    const page = makePage(session);
    page.pushState({ active: 'claude', profiles: [], models: null });
    assert.equal(session.lastServedModel.value, 'claude-opus-5-5', 'without a profile model list the label is left alone');
}

// 5. A tier alias resolves against whichever profile is active, and a synthetic notice is no model:
//    neither can be foreign.
{
    for (const served of ['opus', '<synthetic>']) {
        const session = {
            messages: { value: [{ type: 'user', uuid: 'u1' }, { type: 'assistant', uuid: 'a1' }] },
            busy: { value: false },
            lastServedModel: { value: served },
            send: () => {},
        };
        const page = makePage(session);
        page.pushState({ active: 'glm', profiles: [], models: GLM_MODELS });
        assert.equal(session.lastServedModel.value, served, `"${served}" must not be held as a foreign model`);
    }
}

console.log('\nOK — a load replaying a foreign model holds the indicator until the active backend answers');

// The channel belongs to the window; a tab only receives it when the conversation is addressed to
// that tab. So the pill is drawn in that one tab and nowhere else — a pill in every tab would promise
// every tab an answer, and only one of them can give one. What is pinned here: nothing while no
// window runs a channel, nothing in a tab the conversation is not addressed to, the pill itself in
// the addressed tab (with the light saying a question is waiting), and a click that opens the list it
// is drawn from.
//
//   node test/channel-pill.test.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert';

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this._text = '';
        this.title = '';
        this.style = {};
        this.dataset = {};
        this.attrs = {};
        this.parentElement = null;
        this.onclick = null;
    }
    set textContent(v) {
        this._text = v;
        if (v === '') this.children = [];
    }
    get textContent() {
        return this._text + this.children.map((c) => c.textContent).join('');
    }
    setAttribute(n, v) {
        this.attrs[n] = String(v);
    }
    getAttribute(n) {
        return n in this.attrs ? this.attrs[n] : null;
    }
    appendChild(n) {
        if (n.parentElement) n.remove();
        n.parentElement = this;
        this.children.push(n);
        return n;
    }
    append(...nodes) {
        for (const n of nodes) this.appendChild(n);
    }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    get nextSibling() {
        if (!this.parentElement) return null;
        const i = this.parentElement.children.indexOf(this);
        return i < 0 ? null : this.parentElement.children[i + 1] || null;
    }
    addEventListener() {}
    removeEventListener() {}
    insertBefore(n, ref) {
        if (n.parentElement) n.remove();
        n.parentElement = this;
        const at = ref ? this.children.indexOf(ref) : -1;
        if (at < 0) this.children.push(n);
        else this.children.splice(at, 0, n);
        return n;
    }
    walk(out) {
        out.push(this);
        for (const c of this.children) c.walk(out);
        return out;
    }
    matches(sel) {
        let m = /^\[class\*="([^"]+)"\]$/.exec(sel);
        if (m) return String(this.className).includes(m[1]);
        m = /^\.([\w-]+)$/.exec(sel);
        if (m) return String(this.className).split(/\s+/).includes(m[1]);
        m = /^([a-z]+)\[([\w-]+)\]$/.exec(sel);
        if (m) return this.tagName === m[1] && m[2] in this.attrs;
        m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
        if (m) return this.attrs[m[1]] === m[2];
        return false;
    }
    querySelector(sel) {
        return this.walk([]).find((n) => n !== this && n.matches(sel)) || null;
    }
    querySelectorAll(sel) {
        return this.walk([]).filter((n) => n !== this && n.matches(sel));
    }
}

const pageDocument = {
    body: new El('body'),
    head: new El('head'),
    createElement: (t) => new El(t),
    querySelector: (sel) => pageDocument.body.querySelector(sel),
    querySelectorAll: (sel) => pageDocument.body.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
};
const footer = new El('div');
footer.className = 'inputFooterV2_gGYT1w';
const modelPill = new El('button');
modelPill.className = 'modelPill_gGYT1w';
const agentsPill = new El('button');
agentsPill.className = 'modelPill_gGYT1w agentsPill_EGyesg';
agentsPill.attrs['data-agents-dot'] = 'none';
footer.append(modelPill, agentsPill);
pageDocument.body.appendChild(footer);

const posted = [];
let observerCallback = null;
const timers = [];
const pageWindow = {
    document: pageDocument,
    addEventListener: (type, fn) => {
        if (type === 'message') pageWindow.onMessage = fn;
    },
    removeEventListener() {},
    getSelection: () => null,
    localStorage: { getItem: () => null, setItem() {} },
    innerWidth: 1000,
    innerHeight: 800,
    setTimeout: (fn, delay) => {
        timers.push({ fn, delay });
        return { fn };
    },
    clearTimeout: () => {},
};
pageWindow.window = pageWindow;
const pageContext = {
    window: pageWindow,
    document: pageDocument,
    console,
    Intl,
    Date,
    Math,
    JSON,
    setTimeout: pageWindow.setTimeout,
    clearTimeout: pageWindow.clearTimeout,
    setInterval: () => ({}),
    clearInterval: () => {},
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    MutationObserver: class {
        constructor(fn) {
            observerCallback = fn;
        }
        observe() {}
    },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
pageContext.globalThis = pageContext;
vm.createContext(pageContext);
vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), pageContext);

const fromHost = (m) => pageWindow.onMessage({ data: m });
const observerPass = () => {
    observerCallback();
    for (const t of timers.splice(0)) if (t.delay === 60) t.fn();
};
const pillNow = () => pageDocument.querySelector('.ccx-channel-pill');
const withRelay = (relay, sessionId) =>
    fromHost({ type: 'ccx:state', sessionId, channel: { supported: true, servers: [] }, relay });

// 1. No window runs a channel: nothing is drawn, whatever the tab.
withRelay(null, 's-1');
assert.equal(pillNow(), null, 'no relay means no pill');

// 2. A channel runs, but the conversation is addressed to another tab: this one shows nothing.
withRelay({ status: 'on', server: 'telegram', chatId: '777', target: 's-other', targets: [], pending: 0 }, 's-1');
assert.equal(pillNow(), null, 'a tab the conversation is not addressed to draws no pill');

// 3. Addressed to this tab: the pill names the channel, and the light says nothing is waiting.
withRelay({ status: 'on', server: 'telegram', chatId: '777', target: 's-1', targets: [], pending: 0 }, 's-1');
const pill = pillNow();
assert.ok(pill, 'the addressed tab draws the pill');
assert.equal(pill.textContent, 'telegram', 'and it names the channel');
assert.equal(pill.attrs['data-ccx-channel-state'], 'on');
assert.match(pill.title, /arrive in this tab/);

// 4. A question waiting is the one thing anybody has to act on: the light says so.
withRelay({ status: 'on', server: 'telegram', chatId: '777', target: 's-1', targets: [], pending: 2 }, 's-1');
assert.equal(pillNow().attrs['data-ccx-channel-state'], 'busy', 'a waiting question is visible');
assert.match(pillNow().title, /A permission question is waiting/);

// 5. Not yet knowing the chat is said, not hidden: a pill that reads "on" would promise delivery.
withRelay({ status: 'on', server: 'telegram', chatId: null, target: 's-1', targets: [], pending: 0 }, 's-1');
assert.match(pillNow().textContent, /waiting for the first message/, 'a channel with no conversation yet says so');

// 6. The pill is a way into the list it is drawn from, and the tab that loses the conversation loses
//    the pill with it.
pillNow().onclick();
assert.ok(
    pageDocument.querySelectorAll('.ccx-title').some((n) => n.textContent === 'Channels'),
    'clicking the pill opens the Channels list',
);
fromHost({ type: 'ccx:state', sessionId: 's-1', channel: { supported: true, servers: [] }, relay: { status: 'on', server: 'telegram', chatId: '777', target: 's-1', targets: [], pending: 0 } });
pillNow().remove();
observerPass();
assert.ok(pillNow(), 'the observer pass draws it again after a re-render');

console.log('\nOK — the channel is shown in the tab it is addressed to, and nowhere else');

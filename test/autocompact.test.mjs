// Auto-compact before the cache expires. The host reads the tier off each assistant turn's usage, and
// the page adds a switch under Thinking that schedules a /compact five minutes before a 1-hour cache
// lapses. Only the 1h tier is forwarded and acted on; the 5m one is too short to wait on. A backend
// that reports no split has no tier at all, so it sends the lifetime the profile declares instead —
// a different kind of number, with a floor of its own, never dressed as a measurement.
//   node test/autocompact.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// --- Part 1: the host forwards only the 1h tier ------------------------------------------------

const home = join(tmpdir(), `ccx-autocompact-${process.pid}`);
const runtime = join(home, '.claude', 'vannevar');
const profiles = join(home, '.claude', 'profiles');
mkdirSync(runtime, { recursive: true });
mkdirSync(profiles, { recursive: true });
copyFileSync(new URL('../runtime/webview.js', import.meta.url), join(runtime, 'webview.js'));
process.env.HOME = home;
process.env.USERPROFILE = home;
writeFileSync(join(profiles, 'claude.json'), JSON.stringify({ env: {} }));

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-autocompact-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
}

function openWebview() {
    const posted = [];
    const webview = {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: () => {},
        onDidDispose: () => {},
    };
    renderScript(webview, 'nonce');
    return { posted, webview };
}

const now = Date.now();
const tab = openWebview();

// The shape the channel actually carries: an SDK `assistant` message with the usage on `message`.
// A bare `message_delta` type belongs to the SDK's own SSE accumulator inside extension.js and never
// reaches a webview — watching for it is what made the first version of this silently never fire.
const assistantTurn = (usage) => ({
    type: 'from-extension',
    message: { type: 'io_message', message: { type: 'assistant', message: { type: 'message', role: 'assistant', usage } } },
});

tab.webview.postMessage(
    assistantTurn({
        cache_creation_input_tokens: 197994,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 197994, ephemeral_5m_input_tokens: 0 },
    }),
);
const cache1h = tab.posted.find((m) => m.type === 'ccx:cache');
assert.ok(cache1h, 'the 1h tier is reported to the page');
assert.equal(cache1h.ttl, '1h');
assert.ok(cache1h.anchorAt >= now - 5000 && cache1h.anchorAt <= now + 5000, 'anchorAt is the moment the usage was seen');

// The real shape of every turn after the first: the cache was read, so nothing was written, and the
// split comes back all zeros. That means "no write this time", not "no longer 1h" — reading it as a
// tier reset would drop the deadline on the second turn of every conversation.
tab.posted.length = 0;
tab.webview.postMessage(
    assistantTurn({
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 197994,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    }),
);
const cacheHit = tab.posted.find((m) => m.type === 'ccx:cache');
assert.ok(cacheHit, 'a turn that read the 1h cache keeps the tier and refreshes the deadline');
assert.equal(cacheHit.ttl, '1h');
assert.ok(cacheHit.anchorAt >= cache1h.anchorAt, 'a cache hit moves the anchor forward');

// A turn that touched no cache at all has no lifetime to renew.
tab.posted.length = 0;
tab.webview.postMessage(assistantTurn({ input_tokens: 12, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }));
assert.equal(tab.posted.find((m) => m.type === 'ccx:cache'), undefined, 'an uncached turn moves nothing');

tab.posted.length = 0;
tab.webview.postMessage(
    assistantTurn({
        cache_creation_input_tokens: 900,
        cache_read_input_tokens: 0,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 900 },
    }),
);
assert.equal(tab.posted.find((m) => m.type === 'ccx:cache'), undefined, 'a 5m write takes the tier away from 1h');

tab.posted.length = 0;
tab.webview.postMessage({ type: 'from-extension', message: { type: 'io_message', message: { type: 'assistant', message: {} } } });
assert.equal(tab.posted.find((m) => m.type === 'ccx:cache'), undefined, 'a turn with no usage says nothing');

// A backend that is not the Anthropic API reports a hit and no split, so the only lifetime the page
// can get is the one the profile declares. It travels as a different kind, never as a tier: an
// estimate read off documentation must not be able to pass for something this code measured.
writeFileSync(
    join(profiles, 'deepseek.json'),
    JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic' },
        cache: { ttlMinutes: 60, source: 'declared' },
    }),
);
writeFileSync(join(runtime, 'default-profile.json'), JSON.stringify({ name: 'deepseek' }));
tab.posted.length = 0;
tab.webview.postMessage(assistantTurn({ input_tokens: 100, cache_read_input_tokens: 66432, cache_creation_input_tokens: 0 }));
const declared = tab.posted.find((m) => m.type === 'ccx:cache');
assert.ok(declared, 'a cached turn on a profile that declares a lifetime reports it');
assert.equal(declared.ttl, 'declared', 'a declared lifetime is not the measured tier');
assert.equal(declared.ttlMinutes, 60, 'the declared minutes are carried through');
assert.ok(declared.anchorAt >= now - 5000, 'the anchor is this turn, not the profile');

// A hit renews a declared lifetime exactly as it renews the tier — the prefix was alive at this turn,
// which is the one thing the provider actually proved.
tab.posted.length = 0;
tab.webview.postMessage(assistantTurn({ cache_read_input_tokens: 66432, cache_creation_input_tokens: 0 }));
assert.ok(tab.posted.find((m) => m.type === 'ccx:cache'), 'a later hit renews the declared lifetime');

// Nothing declared, nothing said: for a backend whose retention nobody wrote down, the silence is the
// answer, and a number invented here is exactly what the message shape exists to prevent.
writeFileSync(join(runtime, 'default-profile.json'), JSON.stringify({ name: 'claude' }));
tab.posted.length = 0;
tab.webview.postMessage(assistantTurn({ input_tokens: 100, cache_read_input_tokens: 66432, cache_creation_input_tokens: 0 }));
assert.equal(tab.posted.find((m) => m.type === 'ccx:cache'), undefined, 'a profile that declares nothing says nothing');

console.log('OK — the host reads the assistant turn, refreshing the 1h tier and any declared lifetime');
rmSync(home, { recursive: true, force: true });

// --- Part 2: the page — a checkbox under Thinking, and a /compact on the 55th minute -------------

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this._text = '';
        this.title = '';
        this.src = '';
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
    setAttribute(n, v) { this.attrs[n] = String(v); }
    getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
    removeAttribute(n) { delete this.attrs[n]; }
    appendChild(n) {
        if (n.parentElement) n.remove();
        n.parentElement = this;
        this.children.push(n);
        return n;
    }
    append(...nodes) { for (const n of nodes) this.appendChild(n); }
    remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
    }
    contains(n) { return n === this || this.children.some((c) => c.contains(n)); }
    addEventListener() {}
    removeEventListener() {}
    get nextSibling() {
        const sibs = this.parentElement ? this.parentElement.children : [];
        return sibs[sibs.indexOf(this) + 1] || null;
    }
    insertBefore(node, ref) {
        if (node.parentElement) node.remove();
        node.parentElement = this;
        const i = ref ? this.children.indexOf(ref) : -1;
        if (i === -1) this.children.push(node);
        else this.children.splice(i, 0, node);
        return node;
    }
    // Class lookups only, by the same substring rule the page uses on the app's hashed names
    // (`[class*="modelPill_"]`) — anything else keeps returning null, as it did before.
    querySelector(sel) {
        const sub = /^\[class\*="([^"]+)"\]$/.exec(sel);
        for (const c of this.children) {
            if (sub ? String(c.className).includes(sub[1]) : c.className === sel.replace(/^\./, '')) return c;
            const deep = c.querySelector(sel);
            if (deep) return deep;
        }
        return null;
    }
    querySelectorAll() { return []; }
}

const pageDocument = {
    body: new El('body'),
    head: new El('head'),
    createElement: (t) => new El(t),
    querySelector: (sel) => pageDocument.body.querySelector(sel),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createTreeWalker: () => ({ nextNode: () => null }),
};
const posted = [];
const sent = [];
const timeouts = [];
// The composer's footer as the app builds it: a row, and inside it the model pill the countdown is
// inserted beside. Shaped after the real markup (`inputFooterV2_…` / `modelPill_…`), so the page has
// something to find and the assertion can check where it landed.
const modelPill = new El('span');
modelPill.className = 'modelPill_gGYT1w';
const pillHost = new El('div');
pillHost.appendChild(modelPill);
const footer = new El('div');
footer.className = 'inputFooterV2_gGYT1w';
footer.appendChild(pillHost);
pageDocument.body.appendChild(footer);
const pageWindow = {
    document: pageDocument,
    addEventListener: (type, fn) => { if (type === 'message') pageWindow.onMessage = fn; },
    removeEventListener() {},
    getSelection: () => null,
    localStorage: {
        map: new Map(),
        getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
        setItem(k, v) { this.map.set(k, String(v)); },
    },
    innerWidth: 1000,
    innerHeight: 800,
    setTimeout: (fn, delay) => { timeouts.push({ fn, delay }); return { fn, delay }; },
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
    MutationObserver: class { observe() {} },
    Node: { DOCUMENT_POSITION_FOLLOWING: 4 },
    NodeFilter: { SHOW_TEXT: 4 },
    acquireVsCodeApi: () => ({ postMessage: (m) => posted.push(m), getState: () => ({}), setState() {} }),
};
pageContext.globalThis = pageContext;
vm.createContext(pageContext);
vm.runInContext(readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8'), pageContext);
assert.ok(pageWindow.onMessage, 'page did not register a message listener');
const fromHost = (m) => pageWindow.onMessage({ data: m });

// The registry as the bundle keeps it: `sections` holds the action objects themselves (that is where
// the page finds the switch Thinking registered), `registerAction` replaces by id rather than adding.
const actions = new Map();
const sections = new Map();
const registry = {
    sections,
    registerAction: (action, section, run) => {
        const list = sections.get(section) || [];
        const at = list.findIndex((a) => a.id === action.id);
        if (at !== -1) list[at] = action;
        else list.push(action);
        sections.set(section, list);
        actions.set(action.id, { action, section, run });
    },
};
// The stock Thinking row, already registered when ours arrives — a React element carries its
// component on `.type`, which is the only part the page borrows.
function StockSwitch() {}
registry.registerAction(
    { id: 'toggle-thinking', label: 'Thinking', trailingComponent: { type: StockSwitch, props: { isOn: true } }, keepMenuOpen: true },
    'Model',
    () => {},
);
const fakeSession = {
    send: (m) => { sent.push(m); return Promise.resolve(true); },
    messages: { value: [{ type: 'assistant' }] },
    busy: { value: false },
};
pageWindow.__ccx.onRegistry({ commandRegistry: registry }, (tag, props) => ({ tag, props }), fakeSession);

const entry = actions.get('ccx-autocompact');
assert.ok(entry, 'the auto-compact switch must register its own action');
assert.equal(entry.section, 'Model');
assert.equal(entry.action.label, 'Auto-compact before cache expiry');
assert.equal(entry.action.keepMenuOpen, true, 'the switch must not close the menu on click');
// The row wears the app's own switch, not a glyph of ours: the component is lifted off the element
// Thinking registered, so the two rows cannot drift apart across builds.
assert.equal(entry.action.trailingComponent.tag, StockSwitch, "the stock switch is borrowed, not redrawn");
assert.equal(entry.action.trailingComponent.props.isOn, false, 'off by default');

// Clicking toggles the flag and repaints the switch.
entry.run();
assert.equal(pageWindow.localStorage.getItem('ccx.autocompact.enabled'), '1');
assert.equal(actions.get('ccx-autocompact').action.trailingComponent.props.isOn, true, 'the switch follows the flag');
assert.equal(actions.get('ccx-autocompact').action.trailingComponent.tag, StockSwitch);

// A build where Thinking is gone leaves the slot empty rather than drawing a lookalike: the row still
// toggles, and the drift stays visible instead of being papered over.
sections.set('Model', sections.get('Model').filter((a) => a.id !== 'toggle-thinking'));
fromHost({ type: 'ccx:state', now: Date.now(), active: null, profiles: [], sessionId: 'sess-1' });
assert.equal(actions.get('ccx-autocompact').action.trailingComponent, undefined, 'no switch is invented');
registry.registerAction(
    { id: 'toggle-thinking', label: 'Thinking', trailingComponent: { type: StockSwitch, props: { isOn: true } }, keepMenuOpen: true },
    'Model',
    () => {},
);
assert.equal(timeouts.length, 0, 'no signal yet, so nothing to schedule');

// A 1h signal whose 55th minute has already passed schedules a compaction that fires immediately.
fromHost({ type: 'ccx:cache', ttl: '1h', anchorAt: Date.now() - 55 * 60 * 1000 - 1000 });
assert.equal(timeouts.length, 1, 'a 1h signal schedules exactly one compaction');
assert.equal(timeouts[0].delay, 0, 'already due → fires immediately');
timeouts[0].fn();
assert.deepEqual(sent, ['/compact'], 'the scheduled action is a /compact');

// A signal that is not the 1h tier (or none at all) leaves a scheduled compaction unscheduled.
sent.length = 0;
timeouts.length = 0;
fromHost({ type: 'ccx:cache', ttl: '5m', anchorAt: Date.now() });
assert.equal(timeouts.length, 0, 'a 5m signal schedules nothing');

// A declared lifetime is the second, unmeasured kind: it has its own floor, and a value too short to
// wait on is dropped rather than acted on wrongly.
fromHost({ type: 'ccx:cache', ttl: 'declared', ttlMinutes: 5, anchorAt: Date.now() });
assert.equal(timeouts.length, 0, 'a declared lifetime below the floor schedules nothing');
fromHost({ type: 'ccx:cache', ttl: 'declared', ttlMinutes: 60, anchorAt: Date.now() - 56 * 60 * 1000 });
assert.equal(timeouts.length, 1, 'a declared lifetime that is due schedules one compaction');
assert.equal(timeouts[0].delay, 0, 'already due → fires immediately');
timeouts[0].fn();
assert.deepEqual(sent, ['/compact'], 'a declared lifetime compacts exactly like the measured tier');

// The app draws a countdown only for the tiers it can measure, so a declared lifetime gets one of
// ours — beside the model pill, marked "≈", and with its source in the tooltip: a bare number there
// would read as something this code had measured.
fromHost({ type: 'ccx:cache', ttl: 'declared', ttlMinutes: 60, profile: 'deepseek', anchorAt: Date.now() });
const cachePill = pageDocument.body.querySelector('.ccx-cache-pill');
assert.ok(cachePill, 'a declared lifetime is drawn beside the model pill');
assert.equal(cachePill.parentElement, pillHost, 'the countdown sits in the composer\'s own row');
assert.match(cachePill.textContent, /^≈60m$/, 'the countdown reads as an estimate of the declared window');
assert.match(cachePill.title, /not measured/, 'the tooltip says the number is documentation, not a measurement');
assert.match(cachePill.title, /deepseek/, 'and names the profile the number came from');

// A measured tier already has the app's own countdown, and two of them for one cache would disagree.
fromHost({ type: 'ccx:cache', ttl: '1h', anchorAt: Date.now() });
assert.equal(pageDocument.body.querySelector('.ccx-cache-pill'), null, 'the measured tier keeps the app\'s indicator alone');
fromHost({ type: 'ccx:cache', ttl: 'declared', ttlMinutes: 5, anchorAt: Date.now() });
const shortPill = pageDocument.body.querySelector('.ccx-cache-pill');
assert.ok(shortPill, 'a short declared lifetime is still worth counting down — the floor governs compaction, not the reading');
assert.match(shortPill.textContent, /^≈5m$/, 'and the countdown reads off its own number');

console.log('OK — the page adds a switch of the app\'s own, compacts before the cache lapses, and counts a declared lifetime down');

// --- Part 3: the menu sort order names the new id ----------------------------------------------

const patcher = readFileSync(new URL('../runtime/apply-patch.mjs', import.meta.url), 'utf8');
assert.match(patcher, /"toggle-thinking","ccx-autocompact",/, 'the new id sits under Thinking');
// The find pattern is the stock list, whichever release's: 2.1.284 added "ultracode" to it, and an entry of
// the page's own must never be what it looks for, or a patched list would be matched a second time.
const sortOrderFind = /^\s*find: \/(\\\["model",.*"account-usage"\\\])\/,$/m.exec(patcher);
assert.ok(sortOrderFind, 'the Model sort order is no longer found by a pattern');
const sortOrder = new RegExp(sortOrderFind[1], 'g');
for (const stock of [
    '["model","effort-level","toggle-thinking","switch-models-on-flag","account-usage"]',
    '["model","effort-level","ultracode","toggle-thinking","switch-models-on-flag","account-usage"]',
])
    assert.equal(stock.match(sortOrder)?.length, 1, `the stock list ${stock} is not found`);
assert.doesNotMatch(sortOrderFind[1], /ccx-/, 'the find pattern names an id of the page');

console.log('OK — the Model sort order names ccx-autocompact after toggle-thinking');

// attachWebview leaves fs.watch handles on the profile dirs; nothing unrefs them, so the assertions
// above are the end of the run.
process.exit(0);

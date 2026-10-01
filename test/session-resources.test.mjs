// A Claude Code tab accumulates references it never gathers in one place — links written in messages,
// pages a tool fetched, files tool calls touched, images and documents pasted in. Vannevar draws them
// as a pill beside the stock agents pill and a dialog behind it, one section per kind, and the pill
// carries the number of DISTINCT resources, which is what the stock agents pill carries for agents.
//
// Three pieces are checked here:
//
//   1. the host opens what a row click asks for — an http(s) link through the OS, an absolute path in
//      the editor — and refuses anything else with a reason, echoing the request's seq back;
//   2. the page scans `session.messages` into that list: which block and which tool input contribute
//      which section, and that one resource appearing many times is one row with a count;
//   3. the wiring: the pill hangs off the agents pill's own `data-agents-dot` anchor, and the dialog
//      repaints in place rather than stacking.
//
//   node test/session-resources.test.mjs

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';

// --- Part 1: the host side — open a link, open a file, refuse the rest --------------------------

const home = join(tmpdir(), `ccx-res-${process.pid}`);
const runtime = join(home, '.claude', 'vannevar');
mkdirSync(runtime, { recursive: true });
// renderScript() reads this file to build the injected <script>; without it it fails closed and never
// calls attachWebview, which would make every assertion below fail silently.
copyFileSync(new URL('../runtime/webview.js', import.meta.url), join(runtime, 'webview.js'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const opened = [];
const shown = [];
const revealed = [];
const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? {
              Uri: {
                  file: (p) => ({ fsPath: p, scheme: 'file', toString: () => p }),
                  parse: (u) => ({ toString: () => u, scheme: String(u).split(':')[0] }),
              },
              env: { openExternal: (uri) => (opened.push(uri.toString()), Promise.resolve(true)) },
              commands: {
                  executeCommand: (cmd, uri) => (revealed.push([cmd, uri.fsPath]), Promise.resolve(true)),
              },
              window: {
                  showWarningMessage() {},
                  showErrorMessage() {},
                  showTextDocument: (uri) => (shown.push(uri.fsPath), Promise.resolve(true)),
              },
          }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-res-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
}

function fakeWebview() {
    const handlers = [];
    const posted = [];
    const webview = {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
        webview: { postMessage: () => Promise.resolve(true) },
    };
    renderScript(webview, 'nonce');
    return { webview, posted, send: (m) => handlers.forEach((fn) => fn(m)) };
}

const settle = () => new Promise((r) => setImmediate(r));
const replyOf = (t) => t.posted.find((m) => m.type === 'ccx:openResourceResult');

let t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'url', value: 'https://example.com/a', seq: 7 });
await settle();
assert.equal(replyOf(t).seq, 7, 'the reply must echo the request it answers');
assert.equal(replyOf(t).ok, true, 'an http(s) link is opened');
assert.deepEqual(opened, ['https://example.com/a']);

// A scheme the transcript could contain and the shell must never see.
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'url', value: 'vscode://command/workbench.action.terminal.new', seq: 8 });
await settle();
assert.equal(replyOf(t).ok, false, 'only http(s) reaches openExternal');
assert.deepEqual(opened, ['https://example.com/a'], 'and nothing else was opened');

const absolute = join(home, 'src', 'app.js');
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'file', value: absolute, seq: 9 });
await settle();
assert.equal(replyOf(t).ok, true, 'an absolute path opens in the editor');
assert.deepEqual(shown, [absolute]);

// A tool that names a directory — a search rooted at one — is a place the session touched as much as a
// file is, and handing it to the editor as a file answers with a paragraph about reading a directory.
// It is revealed instead.
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'file', value: home, seq: 16 });
await settle();
assert.equal(replyOf(t).ok, true, 'a directory opens as a folder');
assert.deepEqual(revealed, [['revealInExplorer', home]], 'by being revealed, not read');
assert.deepEqual(shown, [absolute], 'and never reaches the editor as a file');

// A path with no root has no directory to be resolved against here — the host tracks no per-session
// cwd — so it is refused rather than opened against whatever the extension host happens to sit in.
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'file', value: 'src/app.js', seq: 10 });
await settle();
assert.equal(replyOf(t).ok, false, 'a relative path is refused, not guessed at');
assert.match(replyOf(t).error, /absolute/, 'and the reason says why');
assert.deepEqual(shown, [absolute], 'nothing else was opened');

t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'url', value: '', seq: 11 });
await settle();
assert.equal(replyOf(t).ok, false, 'an empty value opens nothing');

// A pasted attachment exists in the transcript and nowhere on disk, so its bytes travel with the
// request and the host writes them out before handing the file to whatever opens that kind of thing.
const mediaDir = join(tmpdir(), 'vannevar-resources');
t = fakeWebview();
t.send({
    type: 'ccx:openResource',
    kind: 'media',
    mediaType: 'image/png',
    data: Buffer.from('hello').toString('base64'),
    seq: 12,
});
await settle();
assert.equal(replyOf(t).ok, true, 'an attachment opens by being written out first');
const written = opened[opened.length - 1];
assert.ok(written.startsWith(mediaDir), 'into the resource temp directory');
assert.ok(written.endsWith('.png'), 'under a name that carries the media type');
assert.equal(readFileSync(written, 'utf8'), 'hello', 'and holds the decoded bytes');

// The same attachment opened twice reuses its file rather than filling the temp directory.
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'media', mediaType: 'image/png', data: Buffer.from('hello').toString('base64'), seq: 13 });
await settle();
assert.equal(opened[opened.length - 1], written, 'the same bytes land on the same file');

// Past the cap the bytes are refused rather than moved: a screenshot is a few hundred kilobytes, and
// anything this size is a file the user already has.
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'media', mediaType: 'image/png', data: 'A'.repeat(13 * 1024 * 1024), seq: 14 });
await settle();
assert.equal(replyOf(t).ok, false, 'an attachment past the cap is refused');
assert.match(replyOf(t).error, /MB/, 'and the reason says how big it is');

// An attachment block that carries a URL of its own opens as a link, and is held to the same scheme
// whitelist as any other URL.
t = fakeWebview();
t.send({ type: 'ccx:openResource', kind: 'media', mediaType: 'application/pdf', url: 'https://example.com/spec.pdf', seq: 15 });
await settle();
assert.equal(replyOf(t).ok, true, 'a URL-bearing attachment opens as a link');
assert.equal(opened[opened.length - 1], 'https://example.com/spec.pdf');

console.log('OK — the host opens links, files and attachments, refuses the rest, and echoes the seq');
rmSync(home, { recursive: true, force: true });
rmSync(mediaDir, { recursive: true, force: true });

// --- Part 2: the page side — one pill, one dialog, one row per resource ------------------------

class El {
    constructor(tag) {
        this.tagName = tag;
        this.children = [];
        this.className = '';
        this._text = '';
        this.title = '';
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
    removeAttribute(n) {
        delete this.attrs[n];
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
    contains(n) {
        return n === this || this.children.some((c) => c.contains(n));
    }
    // The page inserts the pill after its anchor, the way the DOM spells "after" — so the stub has to
    // answer it, or the pill lands at the end of the row and every placement assertion is a lie.
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
    cloneNode() {
        const c = new El(this.tagName);
        c.className = this.className;
        c._text = this._text;
        return c;
    }
    walk(out) {
        out.push(this);
        for (const c of this.children) c.walk(out);
        return out;
    }
    // The four shapes the page asks for: a prefix match, a class, a tag with an attribute, and a tag
    // with an attribute value. `button[data-agents-dot]` is the one the pill hangs off.
    matches(sel) {
        let m = /^\[class\*="([^"]+)"\]$/.exec(sel);
        if (m) return String(this.className).includes(m[1]);
        m = /^\.([\w-]+)$/.exec(sel);
        if (m) return String(this.className).split(/\s+/).includes(m[1]);
        m = /^([a-z]+)\[([\w-]+)\]$/.exec(sel);
        if (m) return this.tagName === m[1] && m[2] in this.attrs;
        m = /^([a-z]+)\[([\w-]+)="([^"]*)"\]$/.exec(sel);
        if (m) return this.tagName === m[1] && this.attrs[m[2]] === m[3];
        m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
        if (m) return this.attrs[m[1]] === m[2];
        return false;
    }
    scrollIntoView() {
        this.scrolled = true;
    }
    // What the page reads a message off: the app's own fiber on the rendered node.
    withMessage(message) {
        this['__reactFiber$ccx'] = { memoizedProps: { message }, return: null };
        return this;
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

// The composer footer as the bundle draws it: the model pill row, with the agents pill wearing the
// one stable non-hashed attribute it has.
const footer = new El('div');
footer.className = 'inputFooterV2_gGYT1w';
const modelPill = new El('button');
modelPill.className = 'modelPill_gGYT1w';
const agentsPill = new El('button');
agentsPill.className = 'modelPill_gGYT1w agentsPill_EGyesg';
agentsPill.attrs['data-agents-dot'] = 'none';
const usageButton = new El('button');
usageButton.className = 'usageButtonV2_gGYT1w';
const settingsButton = new El('button');
settingsButton.className = 'footerButton_gGYT1w';
footer.append(modelPill, agentsPill, usageButton, settingsButton);
pageDocument.body.appendChild(footer);

const posted = [];
let observerCallback = null;
let keydown = null;
const timers = [];
const pageWindow = {
    document: pageDocument,
    addEventListener: (type, fn) => {
        if (type === 'message') pageWindow.onMessage = fn;
        if (type === 'keydown') keydown = fn;
    },
    removeEventListener() {},
    getSelection: () => null,
    localStorage: {
        map: new Map(),
        getItem(k) {
            return this.map.has(k) ? this.map.get(k) : null;
        },
        setItem(k, v) {
            this.map.set(k, String(v));
        },
    },
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
assert.ok(pageWindow.onMessage, 'page did not register a message listener');
assert.ok(observerCallback, 'page did not start its mutation observer');
const fromHost = (m) => pageWindow.onMessage({ data: m });
const observerPass = () => {
    observerCallback();
    for (const t of timers.splice(0)) if (t.delay === 60) t.fn();
};

// The transcript: one URL written twice and fetched once, two more from a search, one file read and
// written, a notebook, an image and a document.
const wrap = (b) => ({ content: b });
let uuid = 0;
// `timestamp` is there because the page's own isTranscriptMessage() demands one before it will call a
// fiber's prop a message — which is what the jump reads.
const msg = (type, blocks) => ({ type, uuid: 'm' + ++uuid, timestamp: ++uuid, content: blocks.map(wrap) });
const firstMessage = msg('user', [
        {
            type: 'text',
            text: 'See https://example.com/a first, then https://example.com/a again. The docs are at https://example.com/b.',
        },
    ],
);
const messages = [
    firstMessage,
    msg('assistant', [{ type: 'tool_use', id: 't1', name: 'WebFetch', input: { url: 'https://example.com/a' } }]),
    {
        type: 'assistant',
        uuid: 'm-search',
        content: [
            {
                content: { type: 'tool_use', id: 't2', name: 'WebSearch', input: { query: 'anything' } },
                toolResult: {
                    value: {
                        content: [{ type: 'text', text: '[R1](https://example.com/r1) and https://example.com/r2.' }],
                    },
                },
            },
        ],
    },
    msg('assistant', [{ type: 'tool_use', id: 't3', name: 'Read', input: { file_path: 'C:/dev/app/src/app.js' } }]),
    msg('assistant', [{ type: 'tool_use', id: 't4', name: 'Write', input: { file_path: 'C:\\dev\\app\\src\\app.js' } }]),
    msg('assistant', [{ type: 'tool_use', id: 't5', name: 'NotebookEdit', input: { notebook_path: 'C:/dev/app/notes.ipynb' } }]),
    msg('assistant', [{ type: 'tool_use', id: 't6', name: 'Bash', input: { command: 'sed -n 1,20p src/app.js' } }]),
    msg('user', [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
    ]),
    msg('assistant', [{ type: 'text', text: 'Notes are in https://example.com/model-notes.' }]),
    // A tool result arrives on the user's side of the conversation without being the user's — the
    // line after one is the tool talking, not the person.
    msg('user', [
        { type: 'tool_result', tool_use_id: 't1' },
        { type: 'text', text: 'The tool answered; see https://example.com/after-tool.' },
    ]),
    // The repository's own bookkeeping: a branch made (and echoed by git as switched to), a worktree
    // added, and a commit, whose hash and subject exist only in what git printed.
    {
        type: 'assistant',
        uuid: 'm-git-branch',
        content: [
            {
                content: {
                    type: 'tool_use',
                    id: 't8',
                    name: 'Bash',
                    input: { command: 'git checkout -b feature/resources && git worktree add ../wt-resources' },
                },
                toolResult: {
                    value: {
                        content: [
                            {
                                type: 'text',
                                text: "Switched to a new branch 'feature/resources'\nPreparing worktree (new branch 'wt-resources')",
                            },
                        ],
                    },
                },
            },
        ],
    },
    {
        type: 'assistant',
        uuid: 'm-git-commit',
        content: [
            {
                content: { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'git commit -m "resources: a section per kind"' } },
                toolResult: {
                    value: {
                        content: [{ type: 'text', text: '[feature/resources 4f2a1c3] resources: a section per kind\n 1 file changed, 3 insertions(+)' }],
                    },
                },
            },
        ],
    },
];

const session = { messages: { value: messages }, busy: { value: false } };
pageWindow.__ccx.onRegistry(null, null, session);

const pills = () => pageDocument.body.querySelectorAll('.ccx-resource-pill');
const overlays = () => pageDocument.body.children.filter((c) => c.className === 'ccx-overlay');
const box = () => overlays()[0].children[0];
const rowsOf = () => box().querySelectorAll('.ccx-res-row');
const rowFor = (text) => rowsOf().find((r) => r.title.includes(text));
const sectionFor = (label) =>
    box()
        .querySelectorAll('.ccx-res-section')
        .find((s) => s.querySelector('.ccx-res-head-label').textContent === label);
const pushState = () => fromHost({ type: 'ccx:state', profiles: [], bindings: {} });

// 1. The pill hangs off the agents pill's own anchor, in the same footer row.
pushState();
assert.equal(pills().length, 1, 'a session with resources gets exactly one pill');
const pill = pills()[0];
assert.equal(
    footer.children.indexOf(pill),
    footer.children.indexOf(agentsPill) + 1,
    'the pill sits immediately after the stock agents pill',
);
assert.ok(pill.className.includes('modelPill_gGYT1w'), 'it borrows the model pill class off the live DOM');
assert.ok(
    !pill.className.includes('footerButton_gGYT1w'),
    'and not the footer button class, whose border-radius would square the pill off',
);
assert.equal(pill.children[0].className, 'ccx-res-pill-label', 'the count lives in a span, so the pill rule that stops wrapping applies to it');

// 2. The count is of *distinct* resources: 4 links (one written twice), 2 from the search, 2 files
//    (one touched twice), 1 notebook, 1 image, 1 document — 10 rows out of 13 mentions.
assert.equal(pill.textContent, '13 resources', 'the pill counts distinct resources, not mentions');
assert.match(pill.title, /click for the list/);

// 3. The dialog groups them, in a fixed order, one row per resource.
pill.onclick();
assert.equal(overlays().length, 1, 'the pill opens exactly one overlay');
assert.ok(box().className.includes('ccx-resources-box'), 'and it is the resource box');
assert.deepEqual(
    box()
        .querySelectorAll('.ccx-res-head-label')
        .map((h) => h.textContent),
    ['Links in messages', 'URLs from tools', 'Files', 'Branches', 'Commits', 'Worktrees', 'Images & documents'],
    'sections come in a fixed order and empty ones are skipped',
);
assert.equal(rowsOf().length, 13, 'one row per distinct resource');

const shared = rowFor('https://example.com/a');
assert.ok(shared, 'the URL written twice and fetched once is one row');
assert.equal(shared.querySelector('.ccx-res-count').textContent, '×3', 'with its count');
assert.match(shared.title, /in your message/, 'and its provenance');
assert.match(shared.title, /fetched by WebFetch/, 'from every source that named it');
// First seen wins the section: it was written in a message before a tool was handed it.
assert.ok(
    box().querySelectorAll('.ccx-res-head-label')[2].textContent === 'Files',
    'the merged row stays in the section of its earliest occurrence',
);

// 3c. The repository's own bookkeeping, read from git's grammar rather than from a shell line: a
//     branch made by `checkout -b` and confirmed by what git echoed back, a worktree added, and a
//     commit whose hash and subject exist only in git's output.
const branchRow = rowsOf().find((r) => r.querySelector('.ccx-res-label').textContent === 'feature/resources');
assert.ok(branchRow, 'a branch the session made is a resource');
assert.equal(branchRow.querySelector('.ccx-res-count').textContent, '×2', 'created and switched to are one branch');
assert.equal(branchRow.className.includes('ccx-res-open'), false, 'a branch has nothing to open');
assert.equal(branchRow.querySelector('.ccx-res-you'), null, 'the model made it, not the user');
const commitRow = rowFor('4f2a1c3');
assert.ok(commitRow, 'a commit the session wrote is a resource');
assert.match(commitRow.querySelector('.ccx-res-label').textContent, /resources: a section per kind/, 'the subject is what the row reads');
assert.equal(commitRow.className.includes('ccx-res-open'), false, 'a commit has nothing to open either');
const worktreeRow = rowFor('wt-resources');
assert.ok(worktreeRow, 'a worktree the session added is a resource');
assert.ok(worktreeRow.className.includes('ccx-res-open'), 'a worktree is a directory, so its row opens');

// 3d. Sections fold, and Files arrive folded: a working session has more of them than of anything
//     else, and the list is opened for what was said and what was committed first.
assert.equal(sectionFor('Files').getAttribute('data-ccx-open'), '0', 'Files start folded');
assert.equal(sectionFor('Links in messages').getAttribute('data-ccx-open'), '1', 'the rest start open');
sectionFor('Files').querySelector('.ccx-res-head').onclick();
assert.equal(sectionFor('Files').getAttribute('data-ccx-open'), '1', 'the head unfolds a section');
// The dialog is repainted on every state push, so a fold has to survive one.
pushState();
assert.equal(sectionFor('Files').getAttribute('data-ccx-open'), '1', 'a repaint keeps what was unfolded');
sectionFor('Files').querySelector('.ccx-res-head').onclick();
pushState();
assert.equal(sectionFor('Files').getAttribute('data-ccx-open'), '0', 'and keeps what was folded again');

// 3b. What came from the user is set apart: a `you` tag on the row, and the user's rows ahead of the
//     model's inside a section — a URL from a prompt and one from a reply look exactly alike.
assert.equal(shared.querySelector('.ccx-res-you').textContent, 'you', 'a link the user pasted is marked');
assert.equal(rowFor('spec.pdf').querySelector('.ccx-res-you').textContent, 'you', 'so is an attachment');
assert.equal(rowFor('https://example.com/r1').querySelector('.ccx-res-you'), null, 'a search result is not');
assert.equal(rowFor('model-notes').querySelector('.ccx-res-you'), null, 'nor is a link in a reply');
assert.equal(
    rowFor('after-tool').querySelector('.ccx-res-you'),
    null,
    'and a tool result is not the user speaking, though it arrives on their side',
);
assert.deepEqual(
    rowsOf()
        .slice(0, 3)
        .map((r) => r.querySelector('.ccx-res-label').textContent),
    ['https://example.com/a', 'https://example.com/b', 'https://example.com/model-notes'],
    "the user's links lead their section and the reply's follows them, first-seen order otherwise",
);

const file = rowFor('C:/dev/app/src/app.js');
assert.ok(file, 'the file read and written is one row');
assert.equal(file.querySelector('.ccx-res-count').textContent, '×2', 'with its count');
assert.match(file.textContent, /app\.js/, 'the row is the basename');
assert.match(file.textContent, /C:\/dev\/app\/src\//, 'under the directory it came from, dimmed rather than dropped');
assert.equal(rowFor('spec.pdf').querySelector('.ccx-res-count'), null, 'a resource seen once carries no count');
assert.ok(!rowFor('sed -n 1,20p src/app.js'), 'a shell command is not a file');
assert.ok(rowFor('C:/dev/app/notes.ipynb'), 'a notebook is one');

// An attached image carries the picture itself into the row, the way the composer's own chip does,
// and the pixel size beside it once the image has decoded — the chip prints the same pair.
const imageRow = rowsOf().find((r) => r.querySelector('.ccx-res-thumb'));
assert.ok(imageRow, 'an image row draws its thumbnail');
const thumb = imageRow.querySelector('.ccx-res-thumb');
assert.equal(thumb.src, 'data:image/png;base64,AAAA', 'straight out of the transcript, with no trip to disk');
assert.ok(!rowFor('spec.pdf').querySelector('.ccx-res-thumb'), 'a document gets no thumbnail, which would be a broken image');
thumb.naturalWidth = 161;
thumb.naturalHeight = 68;
thumb.onload();
assert.equal(imageRow.querySelector('.ccx-res-dims').textContent, '161×68', 'and its size lands where the chip puts it');

// 4. A row click asks the host to open it and closes the dialog behind it.
shared.onclick();
const ask = posted.filter((m) => m.type === 'ccx:openResource').pop();
assert.equal(ask.kind, 'url', 'a link opens as a URL');
assert.equal(ask.value, 'https://example.com/a', 'with the value as written, not normalised');
assert.equal(typeof ask.seq, 'number', 'and a seq to match the answer to');
assert.equal(overlays().length, 0, 'the dialog closes behind the click');

// An attachment is clickable as well, and for the one kind with nothing on disk the bytes go with the
// request — the host writes them out, so what opens is the picture rather than a base64 blob.
pill.onclick();
rowFor('spec.pdf').onclick();
const mediaAsk = posted.filter((m) => m.type === 'ccx:openResource').pop();
assert.equal(mediaAsk.kind, 'media', 'an attachment asks for its own kind');
assert.equal(mediaAsk.mediaType, 'application/pdf', 'carrying what it is');
assert.equal(mediaAsk.data, 'BBBB', 'and the bytes, since there is nowhere else to read them from');
assert.equal(overlays().length, 0, 'and the dialog closes behind that too');

// A refusal is the only answer the page says anything about; a success is silent, the app has opened.
// Both are matched to the newest request — an answer to a row clicked before the last one is the past.
const before = pageDocument.body.children.length;
fromHost({ type: 'ccx:openResourceResult', seq: mediaAsk.seq, ok: true });
assert.equal(pageDocument.body.children.length, before, 'a successful open adds nothing to the page');
fromHost({ type: 'ccx:openResourceResult', seq: mediaAsk.seq, ok: false, error: 'that is not an absolute path' });
const toast = pageDocument.body.children.find((c) => c.className === 'ccx-toast');
assert.ok(toast, 'a refusal is toasted');
assert.match(toast.textContent, /not an absolute path/);
// An answer to a request the page has already moved past says nothing at all.
fromHost({ type: 'ccx:openResourceResult', seq: ask.seq, ok: false, error: 'stale' });
assert.equal(
    pageDocument.body.children.filter((c) => c.className === 'ccx-toast').length,
    1,
    'and a stale refusal is dropped rather than toasted',
);

// 4b. The jump: the arrow goes to the message the resource came from, marks it for long enough to be
//     found, and closes the dialog behind it. The message is read off the node's fiber, the same walk
//     the hidden-message marking makes.
const drawn = new El('div');
drawn.className = 'userMessageContainer_abc';
pageDocument.body.appendChild(drawn);
drawn.withMessage(firstMessage);
pill.onclick();
rowFor('example.com/b').querySelector('.ccx-res-jump').onclick({ stopPropagation() {} });
assert.equal(overlays().length, 0, 'the jump closes the dialog behind it');
assert.ok(drawn.scrolled, 'and scrolls the transcript to the message');
assert.equal(drawn.getAttribute('data-ccx-flash'), '', 'marking it, so it can be told from the rest');
assert.ok(
    !posted.some((m) => m.type === 'ccx:openResource' && String(m.value).includes('example.com/b')),
    'the jump opens nothing — the row\'s own click does that',
);

// A long session renders only the turns near the viewport, so a resource from far up has no node at
// all: the jump says so rather than landing on some other message and calling it the one.
pill.onclick();
rowFor('https://example.com/r1').querySelector('.ccx-res-jump').onclick({ stopPropagation() {} });
const jumpToast = pageDocument.body.children.filter((c) => c.className === 'ccx-toast').pop();
assert.match(jumpToast.textContent, /not in the part of the transcript/, 'a message with no node is refused, not guessed');

// 5. A repaint replaces the dialog rather than stacking, and Escape and a backdrop click close it.
pill.onclick();
assert.equal(overlays().length, 1);
pushState();
assert.equal(overlays().length, 1, 'a state push replaces the open dialog rather than adding one');
keydown({ key: 'Escape' });
assert.equal(overlays().length, 0, 'Escape closes it');
pill.onclick();
overlays()[0].onclick({ target: overlays()[0] });
assert.equal(overlays().length, 0, 'and so does a click on the backdrop');

// 6. The observer pass is the only thing that keeps the pill fresh, and it must not double it.
observerPass();
observerPass();
assert.equal(pills().length, 1, 'the debounced pass re-inserts the pill, not a second one');

// 7. A session that gains a resource gains a row, without a reload.
session.messages.value = messages.concat([
    msg('assistant', [{ type: 'tool_use', id: 't7', name: 'Read', input: { file_path: 'C:/dev/app/README.md' } }]),
]);
pushState();
assert.equal(pills()[0].textContent, '14 resources', 'a new resource is counted on the next state push');

// 8. Nothing to show means no pill: a control that opens an empty list is one more thing in the row.
session.messages.value = [];
pushState();
assert.equal(pills().length, 0, 'a session with no resources has no pill');

// 9. With no agents pill on the row — a build that dropped the attribute, or a composer that has not
//    drawn it yet — the count still lands beside the model pill. The end of the footer is where an
//    unanchored insert goes, and the first version of this was found sitting there, past the send
//    button, so the fallback is asserted rather than assumed.
session.messages.value = messages;
pushState();
agentsPill.remove();
pills()[0].remove();
observerPass();
assert.equal(pills().length, 1, 'the pill is put back');
assert.equal(
    footer.children.indexOf(pills()[0]),
    footer.children.indexOf(modelPill) + 1,
    'beside the model pill, not at the end of the row',
);

console.log('OK — one pill beside the agents pill, one sectioned list, one row per distinct resource');

// --- Part 3: the wiring the page cannot be run to prove ----------------------------------------

const webview = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');
const host = readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8');
assert.ok(
    /querySelector\('button\[data-agents-dot\]'\)/.test(webview),
    'the pill must hang off the agents pill\'s own stable attribute',
);
assert.ok(/type: 'ccx:openResource'/.test(webview), 'the page must ask the host to open a row');
assert.ok(/function placeResourcePill/.test(webview), 'placement is re-made on every pass, like the countdown\'s');
assert.ok(/data-testid="assistant-message"/.test(webview), 'the jump must find messages the way the hidden marking does');
assert.ok(/data-ccx-flash/.test(webview), 'and mark what it landed on with an attribute, not a class React rewrites');
assert.ok(/menuButton_/.test(webview), 'and a row with neither pill still has somewhere but the end to go');
assert.ok(/m\.type === 'ccx:openResource'/.test(host), 'and the host must answer it');
assert.ok(/function openResource\(/.test(host), 'with the open itself in one readable place');
assert.ok(/vscode\.env\.openExternal/.test(host), 'a link goes to the OS, not to window.open');
assert.ok(/path\.isAbsolute/.test(host), 'and a relative path is refused rather than resolved by guess');

console.log('OK — the pill is anchored on the agents pill and every open goes through the host');

// attachWebview leaves fs.watch handles on settings, bindings, profiles and agent-health; nothing
// unrefs them, so the assertions above are the end of the run.
process.exit(0);

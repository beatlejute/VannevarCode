// The in-session half of the automatic re-apply: while VS Code is open, a Claude Code update unpacks a
// new extension folder beside the running one, and the patch lives in the folder it replaces. This is
// the only moment Vannevar is still alive to notice, so host.js watches the extensions root and runs
// the patcher against the new folder before the reload.
//
// Three things are worth pinning. That it fires at all — the comparison is against the folder VS Code
// says it is running, not against anything on disk. That it fires once: every write anywhere under that
// directory wakes the watcher, and a folder already settled must not be spawned against again. And that
// on the day a Claude Code release moves a signature, the two updates land together — a new Claude Code
// and the Vannevar Code that knows it — so the runtime is refreshed out of the newer extension folder
// before the frozen copy is sent at a bundle it would fail on.
//
// host.js requires('vscode') and reads everything out of homedir(), neither of which exists here, so
// both are stubbed and the module is loaded as CommonJS from a .cjs copy — the same shape as
// profile-icons.test.mjs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realOs = require('node:os');

const HOME = path.join(tmpdir(), `ccx-watcher-${process.pid}`);
const EXTENSIONS = path.join(HOME, '.vscode', 'extensions');
const RUNTIME = path.join(HOME, '.claude', 'vannevar');
const RUNNING = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.247-win32-x64');
const UPDATED = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.248-win32-x64');
const RECORD = path.join(RUNTIME, 'record.log');

rmSync(HOME, { recursive: true, force: true });
for (const dir of [RUNTIME, RUNNING, UPDATED]) mkdirSync(dir, { recursive: true });

// renderScript refuses to do anything without the page bundle beside it
writeFileSync(path.join(RUNTIME, 'webview.js'), '/* page */\n');

// Stands in for apply-patch.mjs: records how it was called and which copy of itself ran, then answers
// the way a fresh patch onto a version nobody has verified does — the case the watcher words differently
function stubPatcher(tag) {
    return [
        "import { appendFileSync } from 'node:fs';",
        `const record = ${JSON.stringify(RECORD)};`,
        `appendFileSync(record, JSON.stringify([${JSON.stringify(tag)}, ...process.argv.slice(2)]) + '\\n');`,
        "console.log('ccx-result: patched');",
        "console.log('ccx-unverified: 2.1.248 2.1.247');",
        '',
    ].join('\n');
}

writeFileSync(path.join(RUNTIME, 'apply-patch.mjs'), stubPatcher('installed'));
// What extension.js stamps beside the runtime it copied out of the .vsix
writeFileSync(path.join(RUNTIME, 'patch-version.json'), JSON.stringify({ version: '0.1.0', verifiedAgainst: ['2.1.247'] }));

const shown = [];
const executed = [];
let running = RUNNING;
const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }) },
    window: {
        showInformationMessage: (message, ...actions) => {
            shown.push({ message, actions });
            return Promise.resolve(undefined);
        },
        showWarningMessage: (message, ...actions) => {
            shown.push({ message, actions });
            return Promise.resolve(undefined);
        },
    },
    commands: { executeCommand: (id) => executed.push(id) },
    // The extensions root is the parent of the bundle this window loaded — not ~/.vscode/extensions,
    // which is wrong in every fork of VS Code and on every remote host
    extensions: { getExtension: (id) => (id === 'anthropic.claude-code' ? { extensionPath: running } : undefined) },
};

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request === 'vscode') return vscodeStub;
    if (request === 'os' || request === 'node:os') return { ...realOs, homedir: () => HOME };
    return load(request, ...rest);
};

const copy = path.join(tmpdir(), `ccx-host-watcher-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url)));

let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const webview = {
    postMessage: () => Promise.resolve(true),
    onDidReceiveMessage: () => ({ dispose() {} }),
};

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function until(what, check, ms = 8000) {
    for (let waited = 0; waited < ms; waited += 100) {
        if (check()) return;
        await sleep(100);
    }
    assert.fail(what);
}

function calls() {
    return existsSync(RECORD)
        ? readFileSync(RECORD, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((line) => JSON.parse(line))
        : [];
}

function closeWatchers() {
    const state = globalThis.__ccxState || {};
    // Every watcher ensureWatchers() can install: one left open holds the event loop, and the run
    // then ends in a timeout with every assertion above it already passed.
    for (const key of [
        'extensionsWatcher',
        'agentRunsWatcher',
        'settingsWatcher',
        'bindingsWatcher',
        'profilesWatcher',
        'healthWatcher',
    ])
        try {
            state[key]?.close();
        } catch {}
}

// Between cases: the watcher is closed, the attempt counter cleared and the record wiped, so the next
// renderScript() starts from the same place the first one did
function resetWatcher() {
    closeWatchers();
    rmSync(RECORD, { force: true });
    shown.length = 0;
    const state = globalThis.__ccxState;
    state.extensionsWatcher = null;
    state.repatchTries = new Map();
}

try {
    // Opening a tab installs the watchers, and the update may have landed before that — so the check
    // runs once directly, not only on the next write
    renderScript(webview, 'nonce');

    await until('the patcher was never spawned against the updated folder', () => calls().length > 0);
    assert.deepEqual(
        calls()[0],
        ['installed', '--if-needed', `--dir=${UPDATED}`],
        'the watcher did not aim the patcher at the newest folder with --if-needed',
    );
    console.log('OK — a folder newer than the running extension sends the patcher at it');

    await until('no reload was offered after a successful patch', () => shown.length > 0);
    assert.deepEqual(shown[0].actions, ['Reload Window'], 'the notification did not offer a reload');
    // A signature matching is not a promise the code around it still means the same thing, and nobody
    // reads an automatic run's stdout — so the version it went onto has to be in the notification
    assert.match(shown[0].message, /2\.1\.248/, `the notification does not name the version patched: ${shown[0].message}`);
    assert.match(shown[0].message, /2\.1\.247/, `the notification does not name the verified version: ${shown[0].message}`);
    console.log('OK — a patch onto an unverified version says so and offers the reload');

    // Every write under the extensions root wakes the watcher; a settled folder must not be run again
    writeFileSync(path.join(EXTENSIONS, 'unrelated.marker'), 'x');
    await sleep(4500);
    assert.equal(calls().length, 1, `the patcher ran ${calls().length} times for one update`);
    console.log('OK — later writes under the extensions directory do not spawn the patcher again');

    // --- both updates at once ---------------------------------------------------------------------
    // The day a release moves a signature: VS Code installs the new Claude Code and the new Vannevar
    // Code together. The copy under ~/.claude/vannevar is the old one and would fail on the new bundle,
    // so the newer extension folder's runtime/ replaces it first. Nothing is fetched — those files came
    // through the same updater that installed the code running this.
    resetWatcher();
    const NEXT = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.249-win32-x64');
    const SELF_NEXT = path.join(EXTENSIONS, 'beatlejute.vannevarcode-0.2.0');
    mkdirSync(path.join(SELF_NEXT, 'runtime'), { recursive: true });
    mkdirSync(NEXT, { recursive: true });
    writeFileSync(
        path.join(SELF_NEXT, 'package.json'),
        JSON.stringify({ name: 'vannevarcode', version: '0.2.0', verifiedAgainst: ['2.1.249'] }),
    );
    writeFileSync(path.join(SELF_NEXT, 'runtime', 'apply-patch.mjs'), stubPatcher('shipped-0.2.0'));
    writeFileSync(path.join(SELF_NEXT, 'runtime', 'webview.js'), '/* page 0.2.0 */\n');

    renderScript(webview, 'nonce');
    await until('the patcher was never spawned after both updates landed', () => calls().length > 0);
    assert.equal(
        calls()[0][0],
        'shipped-0.2.0',
        `the frozen copy ran instead of the one that shipped with the update: ${JSON.stringify(calls()[0])}`,
    );
    assert.equal(calls()[0][2], `--dir=${NEXT}`, 'the patcher was not aimed at the newest Claude Code folder');
    assert.equal(
        JSON.parse(readFileSync(path.join(RUNTIME, 'patch-version.json'), 'utf8')).version,
        '0.2.0',
        'the stamp still names the version that was replaced',
    );
    assert.match(
        readFileSync(path.join(RUNTIME, 'webview.js'), 'utf8'),
        /0\.2\.0/,
        'the whole runtime was not refreshed — only the patcher was',
    );

    await until('no reload was offered', () => shown.length > 0);
    await sleep(4500);
    assert.equal(calls().length, 1, `the patcher ran ${calls().length} times for one update`);
    assert.equal(shown.length, 1, `${shown.length} notifications for one update — a second reload was offered`);
    console.log('OK — a Vannevar update that lands with the Claude Code one refreshes the runtime first, and patches once');

    // --- a folder VS Code has retired ---------------------------------------------------------------
    // An obsolete folder is a version VS Code has retired: newer on paper, never going to be loaded
    resetWatcher();
    running = NEXT;
    const LATER = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.250-win32-x64');
    mkdirSync(LATER, { recursive: true });
    writeFileSync(path.join(EXTENSIONS, '.obsolete'), JSON.stringify({ [path.basename(LATER)]: true }));

    renderScript(webview, 'nonce');
    await sleep(1500);
    assert.equal(calls().length, 0, 'the patcher was sent at a folder VS Code has already retired');
    console.log('OK — a retired folder is not mistaken for an update');
} finally {
    closeWatchers();
    Module._load = load;
    rmSync(HOME, { recursive: true, force: true });
}

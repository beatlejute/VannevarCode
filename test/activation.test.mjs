// What happens when a window comes up. extension.js has to do three things in one order — put this
// version's runtime under ~/.claude/vannevar, run the patcher against the bundle VS Code says it
// loaded, and then say something only if there is something to say — and the order is the part that
// cannot be checked by reading it: a patcher spawned before the runtime it lives in was copied would
// work on a developer machine, where the file happens to already be there, and fail on every fresh one.
//
// `vscode` does not exist outside the extension host, $HOME must not be the real one, and `child_process`
// would otherwise spawn the real patcher and the real `claude` CLI — which would rewrite the user's own
// MCP registration while the tests run. All three are stubbed through the module loader, so what is
// exercised is extension.js itself.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realOs = require('node:os');
const realChild = require('node:child_process');
const { EventEmitter } = require('node:events');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HOME = path.join(tmpdir(), `ccx-activate-${process.pid}`);
const EXTENSIONS = path.join(HOME, '.vscode', 'extensions');
const BUNDLE = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.276-win32-x64');
const SELF = path.join(EXTENSIONS, `beatlejute.vannevarcode-${PKG.version}`);
const RUNTIME = path.join(HOME, '.claude', 'vannevar');
const PROFILES = path.join(HOME, '.claude', 'profiles');
const STAMP = path.join(RUNTIME, 'patch-version.json');

rmSync(HOME, { recursive: true, force: true });

// The extension folder as the VS Code updater unpacks it: the manifest, and the runtime that gets
// copied out of it. Only the files extension.js actually reaches for.
mkdirSync(path.join(SELF, 'runtime', 'proxy'), { recursive: true });
mkdirSync(path.join(SELF, 'runtime', 'mcp'), { recursive: true });
mkdirSync(path.join(SELF, 'templates', 'profiles'), { recursive: true });
mkdirSync(BUNDLE, { recursive: true });
writeFileSync(path.join(SELF, 'runtime', 'apply-patch.mjs'), '/* patcher */\n');
writeFileSync(path.join(SELF, 'runtime', 'login-chatgpt.mjs'), '/* sign-in */\n');
writeFileSync(path.join(SELF, 'runtime', 'host.js'), '/* host */\n');
writeFileSync(path.join(SELF, 'runtime', 'proxy', 'server.mjs'), '/* proxy */\n');
writeFileSync(path.join(SELF, 'runtime', 'mcp', 'agent-server.mjs'), '/* agents */\n');
writeFileSync(path.join(SELF, 'templates', 'profiles', 'openai.json'), '{"env":{}}\n');

// --- the stubs ------------------------------------------------------------------------------------

const shown = [];
const executed = [];
const terminals = [];
const opened = [];
const copied = [];
const progress = [];
let answer = (choice) => Promise.resolve(choice);
let configuration = { autoPatch: true };
let openExternalResult = true;

const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
    ProgressLocation: { Notification: 15 },
    window: {
        showInformationMessage: (message, ...actions) => {
            shown.push({ kind: 'info', message, actions });
            return answer(undefined);
        },
        showWarningMessage: (message, ...actions) => {
            shown.push({ kind: 'warning', message, actions });
            return answer(undefined);
        },
        showTextDocument: () => Promise.resolve(undefined),
        // Registered so that a sign-in that falls back to a terminal is a failed assertion rather than
        // a crash in the stub — the whole point of the command is that it never opens one.
        createTerminal: (options) => {
            terminals.push(options);
            return { show() {}, dispose() {} };
        },
        withProgress: (options, run) =>
            run({ report: (step) => progress.push({ options, ...step }) }, { onCancellationRequested() {} }),
    },
    commands: {
        registerCommand: (id, run) => ({ id, run, dispose() {} }),
        executeCommand: (id, ...args) => {
            executed.push({ id, args });
            return Promise.resolve(undefined);
        },
    },
    extensions: {
        getExtension: (id) => (id === 'anthropic.claude-code' ? { extensionPath: BUNDLE } : undefined),
    },
    workspace: {
        getConfiguration: () => ({ get: (key, fallback) => (key in configuration ? configuration[key] : fallback) }),
    },
    env: {
        openExternal: (uri) => {
            opened.push(String(uri.toString()));
            return Promise.resolve(openExternalResult);
        },
        clipboard: { writeText: (text) => copied.push(text) && Promise.resolve() },
    },
};

// Every spawn extension.js makes, in order, with what was on disk at the moment it was made — which is
// how the "runtime first, patcher second" order is pinned rather than assumed.
const spawns = [];
let patcherResult = { code: 0, stdout: 'ccx-result: patched\n' };
let claudeResult = { code: 0, stdout: '' };

function execFileStub(file, args, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    const isPatcher = String(args[0] || '').endsWith('apply-patch.mjs');
    spawns.push({
        file,
        args,
        patcher: isPatcher,
        runtimeReady: existsSync(path.join(RUNTIME, 'apply-patch.mjs')),
        stampReady: existsSync(STAMP),
        asNode: options && options.env ? options.env.ELECTRON_RUN_AS_NODE : undefined,
    });
    const result = isPatcher ? patcherResult : claudeResult;
    setImmediate(() => done(result.code ? Object.assign(Error('exit'), { code: result.code }) : null, result.stdout || '', ''));
    return { on() {} };
}

// The sign-in is the one thing that streams rather than waits for an exit, so it is spawned instead of
// execFile'd: the stub hands back a child the test writes the OAuth events into by hand.
const logins = [];

function spawnStub(file, args, options) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.setEncoding = () => {};
    child.stderr.setEncoding = () => {};
    child.kill = () => {
        child.killed = true;
    };
    logins.push({ file, args, env: (options && options.env) || {}, child });
    return child;
}

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request === 'vscode') return vscodeStub;
    if (request === 'os' || request === 'node:os') return { ...realOs, homedir: () => HOME };
    if (request === 'child_process' || request === 'node:child_process')
        return { ...realChild, execFile: execFileStub, spawn: spawnStub };
    return load(request, ...rest);
};

let extension;
try {
    extension = require(path.join(ROOT, 'extension.js'));
} catch (e) {
    Module._load = load;
    throw e;
}

const context = { extensionPath: SELF, subscriptions: [] };

function reset() {
    shown.length = 0;
    executed.length = 0;
    spawns.length = 0;
    logins.length = 0;
    terminals.length = 0;
    opened.length = 0;
    copied.length = 0;
    progress.length = 0;
}

// activate() fires the work and does not await it — a window must not wait on a patch to come up — so
// the test waits for the spawn it expects rather than for the call to return.
async function settle(ms = 1500) {
    for (let waited = 0; waited < ms; waited += 20) {
        await new Promise((go) => setTimeout(go, 20));
        if (spawns.some((s) => s.patcher) && shown.length) return;
    }
    await new Promise((go) => setTimeout(go, 100));
}

try {
    // --- a machine with nothing on it -------------------------------------------------------------
    reset();
    context.subscriptions.length = 0;
    extension.activate(context);
    await settle();

    assert.ok(
        context.subscriptions.length >= 6,
        `only ${context.subscriptions.length} commands registered — the manifest declares six`,
    );
    for (const id of PKG.contributes.commands.map((c) => c.command))
        assert.ok(
            context.subscriptions.some((s) => s.id === id),
            `${id} is in the manifest and not registered — the command menu entry would throw`,
        );
    console.log('OK — every command the manifest declares is registered');

    assert.equal(readFileSync(path.join(RUNTIME, 'host.js'), 'utf8'), '/* host */\n', 'the runtime was not copied');
    assert.equal(
        readFileSync(path.join(RUNTIME, 'proxy', 'server.mjs'), 'utf8'),
        '/* proxy */\n',
        'the runtime was copied without its subdirectories',
    );
    const stamp = JSON.parse(readFileSync(STAMP, 'utf8'));
    assert.deepEqual(
        stamp,
        { version: PKG.version, verifiedAgainst: PKG.verifiedAgainst, extensionPath: BUNDLE },
        'the stamp does not describe what was installed',
    );
    assert.ok(existsSync(path.join(PROFILES, 'openai.json')), 'the profile templates were not installed');
    console.log('OK — the runtime, the stamp and the profile templates all land before anything else');

    const patchRun = spawns.find((s) => s.patcher);
    assert.ok(patchRun, 'the patcher was never spawned');
    assert.ok(patchRun.runtimeReady, 'the patcher was spawned before the runtime it lives in was copied');
    assert.ok(patchRun.stampReady, 'the patcher was spawned before the stamp it reads its version from');
    assert.equal(patchRun.asNode, '1', 'ELECTRON_RUN_AS_NODE was not set — Code.exe would open a window, not parse');
    assert.deepEqual(
        patchRun.args.slice(1),
        [`--dir=${BUNDLE}`],
        'a first install must be a full apply aimed at the bundle VS Code resolved',
    );
    console.log('OK — the patcher runs after the runtime, as node, aimed at the bundle from the API');

    // Two on a first install and no more: the patch went on, and the MCP server was registered. Both
    // are facts about a machine that had neither a minute ago, and the reload is offered once.
    const reload = shown.filter((s) => s.actions.includes('Reload Window'));
    assert.equal(reload.length, 1, `${reload.length} reload prompts on a first install`);
    assert.match(reload[0].message, /patch is on/i, `unexpected first-install wording: ${reload[0].message}`);
    assert.equal(shown.length, 2, `${shown.length} notifications on a first install: ${JSON.stringify(shown.map((s) => s.message))}`);
    console.log('OK — a first install says the patch is on, offers the reload once, and reports the MCP server');

    // --- the MCP server is registered so the CLI can actually start it ----------------------------
    // The entry is spawned by the `claude` CLI, which has none of the extension host's environment.
    // process.execPath is Code.exe, and Code.exe without ELECTRON_RUN_AS_NODE opens an editor window
    // instead of running the server — so the flag has to be part of the registration.
    for (let waited = 0; waited < 1500 && !spawns.some((s) => s.args.includes('add')); waited += 20)
        await new Promise((go) => setTimeout(go, 20));
    const add = spawns.find((s) => s.args.includes('add'));
    assert.ok(add, `the MCP server was never registered: ${JSON.stringify(spawns.map((s) => s.args))}`);
    assert.ok(add.args.includes('vannevar-agents'), 'the server was registered under another name');
    assert.equal(
        add.args[add.args.indexOf('-e') + 1],
        'ELECTRON_RUN_AS_NODE=1',
        'the registration is missing ELECTRON_RUN_AS_NODE — the CLI would open a window, not a server',
    );
    assert.equal(add.args.at(-2), process.execPath, 'the registration does not run this binary');
    assert.ok(add.args.at(-1).endsWith('agent-server.mjs'), 'the registration does not point at the server');
    assert.ok(add.args.includes('user'), 'the server was not registered at user scope');
    console.log('OK — the MCP entry carries ELECTRON_RUN_AS_NODE, at user scope, pointing at the runtime copy');

    // --- the same version, already patched --------------------------------------------------------
    // Every other window on every other day. It must be quiet, and it must not rewrite the runtime.
    reset();
    patcherResult = { code: 0, stdout: 'ccx-result: up-to-date\n' };
    writeFileSync(path.join(RUNTIME, 'host.js'), '/* host, edited by hand */\n');
    extension.activate(context);
    await settle(800);

    assert.deepEqual(
        spawns.find((s) => s.patcher).args.slice(1),
        ['--if-needed', `--dir=${BUNDLE}`],
        'an unchanged version did not take the cheap path',
    );
    assert.equal(
        readFileSync(path.join(RUNTIME, 'host.js'), 'utf8'),
        '/* host, edited by hand */\n',
        'the runtime was copied again although the version had not changed',
    );
    assert.equal(shown.length, 0, `a quiet activation said something: ${JSON.stringify(shown)}`);
    console.log('OK — an unchanged version runs --if-needed, copies nothing and says nothing');

    // --- Claude Code updated ----------------------------------------------------------------------
    reset();
    patcherResult = { code: 0, stdout: 'ccx-result: patched\nccx-unverified: 2.1.280 2.1.276\n' };
    extension.activate(context);
    await settle();

    assert.equal(shown.length, 1, `${shown.length} notifications for one re-apply`);
    assert.match(shown[0].message, /2\.1\.280/, `the version patched is not in the notification: ${shown[0].message}`);
    assert.match(shown[0].message, /2\.1\.276/, `the verified version is not in the notification: ${shown[0].message}`);
    assert.deepEqual(shown[0].actions, ['Reload Window'], 'a re-apply did not offer the reload');
    console.log('OK — a patch onto an unverified release names both versions and offers the reload');

    // --- this extension updated, not Claude Code ---------------------------------------------------
    // A new version of Vannevar Code re-applies the patch too, because a release can add a hook the
    // bundle has never seen. It needs the same reload and a different sentence: "Claude Code was
    // updated" in front of somebody who just updated this extension is a false statement about their
    // machine.
    reset();
    patcherResult = { code: 0, stdout: 'ccx-result: patched\n' };
    const stamped = JSON.parse(readFileSync(STAMP, 'utf8'));
    writeFileSync(STAMP, JSON.stringify({ ...stamped, version: '2.1.200' }));
    extension.activate(context);
    await settle();

    assert.deepEqual(
        spawns.find((s) => s.patcher).args.slice(1),
        [`--dir=${BUNDLE}`],
        'a new extension version did not do a full apply — a hook added since the last release would be missing',
    );
    assert.equal(
        JSON.parse(readFileSync(STAMP, 'utf8')).version,
        PKG.version,
        'the stamp still names the version that was replaced',
    );
    const upgraded = shown.find((s) => s.actions.includes('Reload Window'));
    assert.ok(upgraded, 'an extension update offered no reload, and the window kept the old bundle');
    assert.match(upgraded.message, /2\.1\.200/, `the message does not name the version replaced: ${upgraded.message}`);
    assert.doesNotMatch(upgraded.message, /Claude Code was updated/, 'an extension update blamed Claude Code');
    console.log('OK — an extension update re-applies in full and says which version replaced which');

    // --- the signatures moved ---------------------------------------------------------------------
    // The patcher stops before it writes, so Claude Code is intact and unpatched. The fix arrives as an
    // extension update, so those are the two offers: the updater and the log.
    reset();
    patcherResult = { code: 1, stdout: 'extension.js: signature matched 0 times (expected 1)\n' };
    answer = (_choice) => Promise.resolve('Check for Updates');
    extension.activate(context);
    await settle();

    assert.equal(shown.length, 1, `${shown.length} notifications for one refusal`);
    assert.equal(shown[0].kind, 'warning', 'a refused patch was reported as information');
    assert.match(shown[0].message, /does not fit Claude Code 2\.1\.276/, `unexpected wording: ${shown[0].message}`);
    assert.match(shown[0].message, /untouched and working/, 'the notification does not say Claude Code still works');
    assert.deepEqual(shown[0].actions, ['Check for Updates', 'Show log'], 'the refusal offered the wrong actions');
    await new Promise((go) => setTimeout(go, 100));
    assert.ok(
        executed.some((c) => c.id === 'workbench.extensions.action.checkForUpdates'),
        'picking "Check for Updates" did not run the updater command',
    );
    console.log('OK — a refusal warns, says Claude Code is fine, and offers the updater and the log');

    // --- the setting that turns the unattended apply off -------------------------------------------
    reset();
    answer = () => Promise.resolve(undefined);
    configuration = { autoPatch: false };
    patcherResult = { code: 0, stdout: 'ccx-result: patched\n' };
    rmSync(STAMP, { force: true });
    extension.activate(context);
    await settle(600);

    assert.ok(!spawns.some((s) => s.patcher), 'autoPatch: false still wrote into the bundle');
    assert.ok(existsSync(STAMP), 'autoPatch: false also skipped the runtime, leaving the command nothing to run');
    console.log('OK — autoPatch: false installs the runtime and leaves the bundle alone');

    // --- and the command still does it by hand ----------------------------------------------------
    reset();
    const apply = context.subscriptions.find((s) => s.id === 'vannevar.applyPatch');
    await apply.run();
    await settle(600);

    const explicit = spawns.find((s) => s.patcher);
    assert.ok(explicit, 'the command did not run the patcher');
    assert.deepEqual(explicit.args.slice(1), [`--dir=${BUNDLE}`], 'the command did not ask for a full apply');
    assert.equal(shown.length, 1, 'a command run said nothing — a hand-run patch always answers');
    console.log('OK — with autoPatch off, the command applies the patch on demand and answers');

    // --- the ChatGPT sign-in, in the interface ----------------------------------------------------
    // No terminal: VS Code opens the page, a progress notification holds the wait, and the answer is a
    // notification. What the child process must keep is --use-env-proxy — node reads the proxy
    // variables at startup, and without them auth.openai.com answers unsupported_country.
    reset();
    const signIn = context.subscriptions.find((s) => s.id === 'vannevar.loginChatgpt');
    const running = signIn.run();
    const started = logins.at(-1);

    assert.ok(started, 'the sign-in command spawned nothing');
    assert.equal(terminals.length, 0, 'the sign-in opened a terminal instead of using the interface');
    assert.equal(started.file, process.execPath, 'the sign-in did not run this binary');
    assert.ok(started.args.includes('--use-env-proxy'), 'the sign-in would go out direct: unsupported_country');
    assert.ok(started.args.includes('--json'), 'the sign-in was not asked for events the extension can read');
    assert.ok(started.args.some((a) => a.endsWith('login-chatgpt.mjs')), `wrong script: ${started.args.join(' ')}`);
    assert.equal(started.env.ELECTRON_RUN_AS_NODE, '1', 'Code.exe without the flag opens a window, not the flow');

    const authorizeUrl = 'https://auth.openai.com/oauth/authorize?client_id=app&state=abc&scope=openid';
    started.child.stdout.emit('data', `${JSON.stringify({ event: 'authorize', url: authorizeUrl })}\n`);
    await new Promise((go) => setTimeout(go, 20));
    assert.deepEqual(opened, [authorizeUrl], 'the sign-in page was not opened by VS Code');
    assert.ok(progress.some((p) => /browser/i.test(p.message || '')), 'the progress said nothing about the browser');

    started.child.stdout.emit('data', `${JSON.stringify({ event: 'signed-in', accountId: 'acct_9' })}\n`);
    started.child.emit('close', 0);
    await running;
    await new Promise((go) => setTimeout(go, 20));
    assert.equal(shown.length, 1, `${shown.length} notifications for one sign-in`);
    assert.equal(shown[0].kind, 'info', 'a completed sign-in was reported as a warning');
    assert.match(shown[0].message, /acct_9/, `the account is not in the notification: ${shown[0].message}`);
    console.log('OK — the sign-in runs as node with the proxy flag, opens the page in VS Code and reports the account');

    // --- a browser that did not open ---------------------------------------------------------------
    // The flow is alive on localhost:1455 and unreachable, and the URL is the only way back into it.
    reset();
    openExternalResult = false;
    answer = () => Promise.resolve('Copy sign-in link');
    const stranded = signIn.run();
    logins.at(-1).child.stdout.emit('data', `${JSON.stringify({ event: 'authorize', url: authorizeUrl })}\n`);
    await new Promise((go) => setTimeout(go, 20));
    assert.deepEqual(copied, [authorizeUrl], 'a browser that did not open left no way to reach the sign-in page');
    logins.at(-1).child.emit('close', 1);
    await stranded;
    openExternalResult = true;
    answer = () => Promise.resolve(undefined);
    console.log('OK — a browser that refuses to open offers the link on the clipboard');

    // --- the sign-in failed -------------------------------------------------------------------------
    reset();
    const failing = signIn.run();
    logins
        .at(-1)
        .child.stdout.emit(
            'data',
            `${JSON.stringify({ event: 'error', message: 'port 1455 is busy (Codex CLI running?)' })}\n`,
        );
    logins.at(-1).child.emit('close', 1);
    await failing;
    await new Promise((go) => setTimeout(go, 20));
    assert.equal(shown.length, 1, `${shown.length} notifications for one failed sign-in`);
    assert.equal(shown[0].kind, 'warning', 'a failed sign-in was reported as information');
    assert.match(shown[0].message, /1455/, `the reason is not in the notification: ${shown[0].message}`);
    assert.deepEqual(shown[0].actions, ['Show log'], 'a failed sign-in did not offer the log');
    console.log('OK — a failed sign-in says why, in a notification, and offers the log');
} finally {
    Module._load = load;
    rmSync(HOME, { recursive: true, force: true });
}

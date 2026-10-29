// test/panic-restore-command.test.mjs — Panic Restore command coverage against the product (task 20, QA-045)
//
// Five cases with isolated HOME, VS Code UI and child_process stubs (pattern from test/activation.test.mjs):
//   1. cancel — Command Palette entry: cancel does not launch patcher
//   2. confirm — confirm launches --panic-restore --dir=<resolved bundle>
//   3. refusal — refusal warning shown
//   4. success/reload — success offers reload; activation itself does not invoke panic restore
//   5. no automatic invocation — activation does not call panic restore
// Mutable state — system tmp, teardown mandatory. Real patcher/CLI not spawned.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
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

const HOME = path.join(tmpdir(), `ccx-panic-cmd-${process.pid}`);
const EXTENSIONS = path.join(HOME, '.vscode', 'extensions');
const BUNDLE = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.276-win32-x64');
const SELF = path.join(EXTENSIONS, `beatlejute.vannevarcode-${PKG.version}`);
const RUNTIME = path.join(HOME, '.claude', 'vannevar');
const PROFILES = path.join(HOME, '.claude', 'profiles');
const STAMP = path.join(RUNTIME, 'patch-version.json');
const MCP_RECEIPT = path.join(RUNTIME, 'mcp-registered.json');
const PATCHER = path.join(RUNTIME, 'apply-patch.mjs');

rmSync(HOME, { recursive: true, force: true });

// Minimal extension folder structure
mkdirSync(path.join(SELF, 'runtime', 'proxy'), { recursive: true });
mkdirSync(path.join(SELF, 'runtime', 'mcp'), { recursive: true });
mkdirSync(path.join(SELF, 'templates', 'profiles'), { recursive: true });
mkdirSync(BUNDLE, { recursive: true });
writeFileSync(path.join(SELF, 'runtime', 'apply-patch.mjs'), '/* patcher */\n');
writeFileSync(path.join(SELF, 'runtime', 'login-chatgpt.mjs'), '/* sign-in */\n');
copyFileSync(path.join(ROOT, 'runtime', 'chatgpt-signin.js'), path.join(SELF, 'runtime', 'chatgpt-signin.js'));
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
let configuredEnv;
let openExternalResult = true;

const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }), parse: (s) => ({ toString: () => s }) },
    ProgressLocation: { Notification: 15 },
    window: {
        showInformationMessage: (message, ...actions) => {
            shown.push({ kind: 'info', message, actions });
            return answer(actions[0]);
        },
        showWarningMessage: (message, ...actions) => {
            shown.push({ kind: 'warning', message, actions });
            return answer(actions[0]);
        },
        showTextDocument: () => Promise.resolve(undefined),
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
        getConfiguration: (section) => ({
            get: (key, fallback) => {
                if (section === 'claudeCode') return key === 'environmentVariables' ? configuredEnv : fallback;
                return key in configuration ? configuration[key] : fallback;
            },
        }),
    },
    env: {
        openExternal: (uri) => {
            opened.push(String(uri.toString()));
            return Promise.resolve(openExternalResult);
        },
        clipboard: { writeText: (text) => copied.push(text) && Promise.resolve() },
    },
};

// Every spawn extension.js makes, in order
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
    const result = isPatcher ? patcherResult : typeof claudeResult === 'function' ? claudeResult(args) : claudeResult;
    setImmediate(() => done(result.code ? Object.assign(Error('exit'), { code: result.code }) : null, result.stdout || '', ''));
    return { on() {} };
}

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

async function settle(ms = 1500) {
    for (let waited = 0; waited < ms; waited += 20) {
        await new Promise((go) => setTimeout(go, 20));
        if (spawns.some((s) => s.patcher) && shown.length) return;
    }
    await new Promise((go) => setTimeout(go, 100));
}

// Activate ONCE - save activation spawns for case 5
patcherResult = { code: 0, stdout: 'ccx-result: up-to-date\n' };
extension.activate(context);
await settle(800);
const activationSpawns = [...spawns]; // Save activation spawns
reset(); // Clear activation messages

// Get the panic command (registered during activation)
const panicCmd = context.subscriptions.find((s) => s.id === 'vannevar.panicRestore');
assert.ok(panicCmd, 'panicRestore command not registered');

try {
    // --- 5. no automatic invocation — activation does not call panic restore (check FIRST) -------
    {
        const panicPatcherSpawn = activationSpawns.find((s) => s.patcher && s.args.includes('--panic-restore'));
        assert.ok(!panicPatcherSpawn, 'case 5: activation must not invoke --panic-restore automatically');
        console.log('case 5 no automatic invocation: PASS');
    }

    // --- 1. cancel — Command Palette entry: cancel does not launch patcher -----------------------
    {
        reset();
        answer = (_choice) => Promise.resolve('Cancel');
        patcherResult = { code: 0, stdout: 'ccx-result: up-to-date\n' };
        await panicCmd.run();
        await settle(800);

        const panicPatcherSpawn = spawns.find((s) => s.patcher && s.args.includes('--panic-restore'));
        assert.ok(!panicPatcherSpawn, 'case 1: cancel must not spawn patcher with --panic-restore');
        const warning = shown.find((s) => s.kind === 'warning' && s.message.includes('not installed'));
        assert.ok(!warning, 'case 1: cancel must not show "not installed" warning');
        console.log('case 1 cancel: PASS');
    }

    // --- 2. confirm — confirm launches --panic-restore --dir=<resolved bundle> ------------------
    {
        reset();
        answer = (_choice) => Promise.resolve('Restore');
        patcherResult = { code: 0, stdout: 'ccx-result: patched\nвосстановлено 2 файл\n' };
        await panicCmd.run();
        await settle(800);

        const panicPatcherSpawn = spawns.find((s) => s.patcher && s.args.includes('--panic-restore'));
        assert.ok(panicPatcherSpawn, 'case 2: confirm must spawn patcher with --panic-restore');
        assert.ok(panicPatcherSpawn.args.some((a) => a.startsWith('--dir=')), 'case 2: patcher must be called with --dir=<bundle>');
        assert.ok(panicPatcherSpawn.args.some((a) => a.includes(BUNDLE)), `case 2: --dir must resolve to bundle path, got ${JSON.stringify(panicPatcherSpawn.args)}`);
        console.log('case 2 confirm: PASS');
    }

    // --- 3. refusal — refusal warning shown ------------------------------------------------------
    {
        reset();
        answer = (_choice) => Promise.resolve('Restore');
        patcherResult = { code: 1, stdout: '', stderr: 'no exact backup (*.ccx-orig) found\nreinstall guidance: run Vannevar: Revert or reinstall the extension\n' };
        await panicCmd.run();
        await settle(800);

        const warning = shown.find((s) => s.kind === 'warning' && s.message.includes('panic restore failed'));
        assert.ok(warning, `case 3: refusal must show warning, got ${JSON.stringify(shown.map(s => s.message))}`);
        assert.ok(warning.message.includes('failed'), 'case 3: warning must mention failure');
        assert.deepEqual(warning.actions, ['Show log'], 'case 3: refusal must offer Show log');
        console.log('case 3 refusal: PASS');
    }

    // --- 4. success/reload — success offers reload -----------------------------------------------
    {
        reset();
        answer = (_choice) => Promise.resolve('Restore');
        patcherResult = { code: 0, stdout: 'ccx-result: patched\nвосстановлено 2 файл\n' };
        await panicCmd.run();
        await settle(2000);

        const reloadMsg = shown.find((s) => s.kind === 'info' && s.message.includes('Reload'));
        assert.ok(reloadMsg, `case 4: success must offer reload, got ${JSON.stringify(shown.map(s => s.message))}`);
        assert.ok(reloadMsg.message.includes('panic restore completed'), 'case 4: success message must mention completion');
        assert.deepEqual(reloadMsg.actions, ['Reload'], 'case 4: success must offer Reload action');
        console.log('case 4 success/reload: PASS');
    }

    // --- edge: no Claude extension ---------------------------------------------------------------
    {
        reset();
        // Temporarily override getExtension
        const originalGetExtension = vscodeStub.extensions.getExtension;
        vscodeStub.extensions.getExtension = (id) => undefined;
        answer = (_choice) => Promise.resolve('Restore');
        patcherResult = { code: 0, stdout: 'ccx-result: up-to-date\n' };
        await panicCmd.run();
        await settle(800);
        vscodeStub.extensions.getExtension = originalGetExtension;

        const warning = shown.find((s) => s.kind === 'warning' && s.message.includes('not installed'));
        assert.ok(warning, `case edge: no Claude extension must show warning, got ${JSON.stringify(shown.map(s => s.message))}`);
        const panicPatcherSpawn = spawns.find((s) => s.patcher);
        assert.ok(!panicPatcherSpawn, 'case edge: no patcher spawn when Claude extension missing');
        console.log('case edge no Claude extension: PASS');
    }

    // --- edge: empty patcher output --------------------------------------------------------------
    {
        reset();
        answer = (_choice) => Promise.resolve('Restore');
        patcherResult = { code: 0, stdout: '' };
        await panicCmd.run();
        await settle(800);

        const panicPatcherSpawn = spawns.find((s) => s.patcher);
        assert.ok(panicPatcherSpawn, 'case edge: empty output still spawns patcher');
        const reloadMsg = shown.find((s) => s.kind === 'info' && s.actions.includes('Reload'));
        assert.ok(!reloadMsg, 'case edge: empty patcher output must not offer reload');
        console.log('case edge empty patcher output: PASS');
    }

    // --- edge: child failure ---------------------------------------------------------------------
    {
        reset();
        answer = (_choice) => Promise.resolve('Restore');
        patcherResult = { code: 1, stdout: '', stderr: 'child process failed' };
        await panicCmd.run();
        await settle(800);

        const warning = shown.find((s) => s.kind === 'warning' && s.message.includes('panic restore failed'));
        assert.ok(warning, `case edge: child failure must show warning, got ${JSON.stringify(shown.map(s => s.message))}`);
        assert.deepEqual(warning.actions, ['Show log'], 'case edge: child failure must offer Show log');
        console.log('case edge child failure: PASS');
    }
} finally {
    Module._load = load;
    rmSync(HOME, { recursive: true, force: true });
}

console.log('panic-restore-command.test.mjs: all cases passed');
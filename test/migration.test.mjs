// Coming over from Claudapter. Same machine, same user, same state — the directory and the names are
// what changed, and everything the old runtime kept under ~/.claude/claudapter has to be where the new
// one looks for it: bindings, pins, retracted messages, provider health, the ChatGPT tokens, the
// downloaded provider icons.
//
// Three properties, and the first two are the ones that hurt when they are wrong. Nothing already in
// ~/.claude/vannevar is overwritten — two windows activate at once on a restore, and the second must
// not put a stale copy over what the first has been writing. Nothing is deleted from the old directory
// — it is the user's data and the way back if they reinstall the old extension. And everything on the
// list actually travels, because a missed file is silent: the feature simply comes up empty.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realOs = require('node:os');
const realChild = require('node:child_process');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HOME = path.join(tmpdir(), `ccx-migrate-${process.pid}`);
const EXTENSIONS = path.join(HOME, '.vscode', 'extensions');
const BUNDLE = path.join(EXTENSIONS, 'anthropic.claude-code-2.1.276-win32-x64');
const SELF = path.join(EXTENSIONS, `beatlejute.vannevarcode-${PKG.version}`);
const LEGACY = path.join(HOME, '.claude', 'claudapter');
const RUNTIME = path.join(HOME, '.claude', 'vannevar');
const PROFILES = path.join(HOME, '.claude', 'profiles');

// Everything the old runtime owned. profiles/ is deliberately not here: ~/.claude/profiles is shared
// with the CLI and was never inside the runtime directory, so there is nothing to move.
const CARRIED = {
    'bindings.json': '{"session-1":"codex"}',
    'pinned.json': '["session-1"]',
    'hidden-messages.json': '{"session-1":["uuid-1"]}',
    'agent-health.json': '{"openai":{"ok":true}}',
    'full-history.json': '{"enabled":true}',
    'chatgpt-auth.json': '{"access_token":"secret"}',
    'proxy.json': '{"port":3000}',
};

rmSync(HOME, { recursive: true, force: true });
mkdirSync(path.join(LEGACY, 'icons'), { recursive: true });
mkdirSync(path.join(SELF, 'runtime'), { recursive: true });
mkdirSync(path.join(SELF, 'templates', 'profiles'), { recursive: true });
mkdirSync(path.join(PROFILES), { recursive: true });
mkdirSync(BUNDLE, { recursive: true });

for (const [name, body] of Object.entries(CARRIED)) writeFileSync(path.join(LEGACY, name), body);
writeFileSync(path.join(LEGACY, 'icons', 'deepseek.png'), 'PNG');
// Not on the list: a debug log and the old stamp are the old install's, not the user's state
writeFileSync(path.join(LEGACY, 'debug.log'), 'noise');
writeFileSync(path.join(LEGACY, 'patch-version.json'), '{"version":"2.1.276"}');
writeFileSync(path.join(SELF, 'runtime', 'apply-patch.mjs'), '/* patcher */\n');
writeFileSync(path.join(SELF, 'runtime', 'host.js'), '/* host */\n');

// One file is already there, written by the new runtime before this window activated: the migration
// must leave it exactly as it is.
mkdirSync(RUNTIME, { recursive: true });
writeFileSync(path.join(RUNTIME, 'bindings.json'), '{"session-2":"openai"}');

const shown = [];
const executed = [];
let answer = () => Promise.resolve(undefined);
let keeperInstalled = true;

const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }) },
    window: {
        showInformationMessage: (message, ...actions) => {
            shown.push({ kind: 'info', message, actions });
            return answer(actions);
        },
        showWarningMessage: (message, ...actions) => {
            shown.push({ kind: 'warning', message, actions });
            return answer(actions);
        },
        showTextDocument: () => Promise.resolve(undefined),
    },
    commands: {
        registerCommand: (id, run) => ({ id, run, dispose() {} }),
        executeCommand: (id, ...args) => {
            executed.push({ id, args });
            return Promise.resolve(undefined);
        },
    },
    extensions: {
        getExtension: (id) => {
            if (id === 'anthropic.claude-code') return { extensionPath: BUNDLE };
            if (id === 'local.claudapter-keeper' && keeperInstalled) return { id };
            return undefined;
        },
    },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    env: { openExternal: () => Promise.resolve(true) },
};

// The CLI is stubbed for the same reason as in activation.test.mjs: `claude mcp remove` against the
// real binary would rewrite the registration on the machine running the tests.
const spawns = [];
function execFileStub(file, args, options, callback) {
    const done = typeof options === 'function' ? options : callback;
    spawns.push({ file, args });
    setImmediate(() => done(null, args.includes('list') ? 'vannevar-agents: node server\n' : '', ''));
    return { on() {} };
}

const load = Module._load;
Module._load = (request, ...rest) => {
    if (request === 'vscode') return vscodeStub;
    if (request === 'os' || request === 'node:os') return { ...realOs, homedir: () => HOME };
    if (request === 'child_process' || request === 'node:child_process')
        return { ...realChild, execFile: execFileStub };
    return load(request, ...rest);
};

let extension;
try {
    extension = require(path.join(ROOT, 'extension.js'));
} catch (e) {
    Module._load = load;
    throw e;
}

try {
    const context = { extensionPath: SELF, subscriptions: [] };
    extension.activate(context);
    await new Promise((go) => setTimeout(go, 800));

    // --- everything on the list travelled ---------------------------------------------------------
    for (const [name, body] of Object.entries(CARRIED)) {
        if (name === 'bindings.json') continue;
        assert.ok(existsSync(path.join(RUNTIME, name)), `${name} was left behind — the feature reading it comes up empty`);
        assert.equal(readFileSync(path.join(RUNTIME, name), 'utf8'), body, `${name} arrived changed`);
    }
    assert.equal(
        readFileSync(path.join(RUNTIME, 'icons', 'deepseek.png'), 'utf8'),
        'PNG',
        'the downloaded provider icons did not come over',
    );
    console.log(`OK — all ${Object.keys(CARRIED).length} state files and the icons folder came over`);

    // --- and nothing already there was touched ----------------------------------------------------
    assert.equal(
        readFileSync(path.join(RUNTIME, 'bindings.json'), 'utf8'),
        '{"session-2":"openai"}',
        'the migration overwrote a file the new runtime had already written',
    );
    console.log('OK — a file that was already there is left exactly as it was');

    // --- the old directory is still whole ---------------------------------------------------------
    for (const name of [...Object.keys(CARRIED), 'debug.log', 'patch-version.json'])
        assert.ok(existsSync(path.join(LEGACY, name)), `${name} was removed from ${LEGACY} — that is the way back`);
    assert.ok(existsSync(path.join(LEGACY, 'icons', 'deepseek.png')), 'the old icons were moved rather than copied');
    console.log('OK — nothing is deleted from the old directory');

    // --- what did not come over --------------------------------------------------------------------
    // The old install's own bookkeeping: a stamp describing a version that is gone would make the
    // patcher claim it was verified against something nobody checked.
    const stamp = JSON.parse(readFileSync(path.join(RUNTIME, 'patch-version.json'), 'utf8'));
    assert.equal(stamp.version, PKG.version, 'the old stamp was carried over instead of being written fresh');
    assert.ok(!existsSync(path.join(RUNTIME, 'debug.log')), 'the old log was carried over');
    console.log('OK — the old stamp and log stay behind; the stamp is written fresh');

    // --- the old MCP registration and the old keeper ------------------------------------------------
    const removals = spawns.filter((s) => s.args.includes('remove'));
    assert.ok(
        removals.some((s) => s.args.includes('claudapter-agents') && s.args.includes('user')),
        `the old MCP entry was never unregistered: ${JSON.stringify(spawns.map((s) => s.args))}`,
    );
    assert.ok(
        !spawns.some((s) => s.args.includes('add') && s.args.includes('claudapter-agents')),
        'the old MCP server was re-registered',
    );
    console.log('OK — the Claudapter MCP entry is removed at user scope and never re-added');

    const offer = shown.find((s) => /Claudapter Keeper/.test(s.message));
    assert.ok(offer, `the old keeper was never mentioned: ${JSON.stringify(shown.map((s) => s.message))}`);
    assert.deepEqual(offer.actions, ['Uninstall Claudapter Keeper', 'Leave it'], 'the keeper offer is not a choice');
    assert.ok(
        !executed.some((c) => c.id === 'workbench.extensions.uninstallExtension'),
        'the keeper was uninstalled without anybody agreeing to it',
    );
    console.log('OK — the old keeper is offered for removal, never removed silently');

    // Saying yes is what uninstalls it
    shown.length = 0;
    executed.length = 0;
    answer = (actions) => Promise.resolve(actions[0]);
    rmSync(path.join(RUNTIME, 'agent-health.json'), { force: true });
    extension.activate(context);
    await new Promise((go) => setTimeout(go, 800));
    assert.ok(
        executed.some(
            (c) => c.id === 'workbench.extensions.uninstallExtension' && c.args[0] === 'local.claudapter-keeper',
        ),
        `agreeing did not uninstall the keeper: ${JSON.stringify(executed)}`,
    );
    console.log('OK — agreeing to the offer uninstalls the old keeper extension');

    // --- a machine that never had Claudapter -------------------------------------------------------
    // The common case: the directory is not there, and none of this runs at all.
    rmSync(LEGACY, { recursive: true, force: true });
    shown.length = 0;
    executed.length = 0;
    spawns.length = 0;
    keeperInstalled = false;
    extension.activate(context);
    await new Promise((go) => setTimeout(go, 800));

    assert.ok(
        !shown.some((s) => /Claudapter/.test(s.message)),
        `a machine with no Claudapter was told about it: ${JSON.stringify(shown.map((s) => s.message))}`,
    );
    assert.ok(
        !spawns.some((s) => s.args.includes('claudapter-agents')),
        'the CLI was asked to remove an entry on a machine that never had one',
    );
    console.log('OK — with no Claudapter directory, nothing about it happens');

    assert.ok(readdirSync(RUNTIME).includes('host.js'), 'the runtime itself was never installed');
} finally {
    Module._load = load;
    rmSync(HOME, { recursive: true, force: true });
}

'use strict';

// The whole installer, now that there is no installer. Claudapter was a git clone plus `npm run setup`
// plus a keeper extension that survived Claude Code updates; this file is all three, and the VS Code
// updater is what replaces the "pull and re-run" step.
//
// What it does on every window, in order: find the Claude Code bundle, make sure ~/.claude/vannevar
// holds this version's runtime, put the hooks back into the bundle if they are not there, and say so
// only when there is something to say.
//
// Two things stay the way they were. The runtime is a copy under ~/.claude/vannevar rather than code
// run out of the extension folder: the extension folder's name changes with every release, and the
// hooks written into somebody else's bundle must point at a path that does not move. And the internal
// names — the `__ccx` marker, `ccx:*` messages, `*.ccx-orig` backups — are untouched, because the
// patcher's "is this file already patched" test is a search for that marker and every test pins it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { execFile } = require('child_process');

const pkg = require('./package.json');

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const RUNTIME = path.join(CLAUDE_DIR, 'vannevar');
const LEGACY_RUNTIME = path.join(CLAUDE_DIR, 'claudapter');
const PROFILES_DIR = path.join(CLAUDE_DIR, 'profiles');
const PATCHER = path.join(RUNTIME, 'apply-patch.mjs');
const STAMP_FILE = path.join(RUNTIME, 'patch-version.json');
const MCP_RECEIPT = path.join(RUNTIME, 'mcp-registered.json');
const LOG_FILE = path.join(RUNTIME, 'extension.log');

const CLAUDE_EXTENSION_ID = 'anthropic.claude-code';
const LEGACY_KEEPER_ID = 'local.claudapter-keeper';
const MCP_SERVER_NAME = 'vannevar-agents';
const LEGACY_MCP_SERVER_NAME = 'claudapter-agents';

// The state files the runtime owns. Profiles are not among them: ~/.claude/profiles is shared with the
// CLI and with any other tool that reads it, and it was never inside the runtime directory.
const STATE_FILES = [
    'bindings.json',
    'pinned.json',
    'hidden-messages.json',
    'agent-health.json',
    'full-history.json',
    'chatgpt-auth.json',
    'proxy.json',
];

function log(text) {
    try {
        fs.mkdirSync(RUNTIME, { recursive: true });
        fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`, 'utf8');
    } catch {}
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 4)}\n`, 'utf8');
}

// --- the bundle -----------------------------------------------------------------------------------
//
// Scanning ~/.vscode/extensions is what the installer used to do, and it is wrong everywhere but stock
// VS Code on the local machine: Cursor, Windsurf and Insiders each keep their own extensions root, and
// over Remote-SSH or WSL the bundle lives under ~/.vscode-server on the remote host — which is also
// where this extension runs, since the manifest asks for the workspace side first. The API answers with
// the path of the copy this window actually loaded, on the host it loaded it on.
function claudeBundle() {
    try {
        return vscode.extensions.getExtension(CLAUDE_EXTENSION_ID)?.extensionPath || null;
    } catch {
        return null;
    }
}

// --- the runtime copy -----------------------------------------------------------------------------

function runtimeSource(context) {
    return path.join(context.extensionPath, 'runtime');
}

function currentStamp() {
    return readJson(STAMP_FILE) || {};
}

// Copies runtime/ out of the extension folder when this version's copy is not the one on disk, and
// stamps what went there. The stamp is what the patcher reads for its own version, for the releases it
// was verified against, and for the extensions root to scan when it is run by hand with no --dir.
function syncRuntime(context, bundle) {
    const stamp = currentStamp();
    const fresh = stamp.version !== pkg.version || !fs.existsSync(PATCHER);

    fs.mkdirSync(RUNTIME, { recursive: true });
    if (fresh) {
        fs.cpSync(runtimeSource(context), RUNTIME, { recursive: true, force: true });
        log(`runtime: ${stamp.version || 'none'} → ${pkg.version}`);
    }

    // Rewritten even when nothing was copied: the bundle path moves with every Claude Code update, and
    // a hand-run patcher with no --dir scans the directory this names.
    if (fresh || stamp.extensionPath !== bundle)
        writeJson(STAMP_FILE, {
            version: pkg.version,
            verifiedAgainst: Array.isArray(pkg.verifiedAgainst) ? pkg.verifiedAgainst : [],
            extensionPath: bundle,
        });

    return fresh;
}

// Template profiles are only ever added, never overwritten: the file in ~/.claude/profiles is the one
// with somebody's key in it.
function installTemplateProfiles(context) {
    const templates = path.join(context.extensionPath, 'templates', 'profiles');
    if (!fs.existsSync(templates)) return;
    try {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        for (const entry of fs.readdirSync(templates)) {
            const target = path.join(PROFILES_DIR, entry);
            if (fs.existsSync(target)) continue;
            fs.copyFileSync(path.join(templates, entry), target);
            log(`profile template: ${entry}`);
        }
    } catch (e) {
        log(`profile templates failed: ${e.message}`);
    }
}

// --- running the patcher --------------------------------------------------------------------------
//
// process.execPath is Code.exe in the extension host; ELECTRON_RUN_AS_NODE turns it back into node,
// which is what keeps this working on a machine with no node on PATH — and since 2.1.227 Claude Code
// stopped shipping one, so there may genuinely be none.
function runNode(args, options = {}) {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            args,
            { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, ...options },
            (error, stdout, stderr) => {
                const out = `${stdout || ''}${stderr || ''}`.trim();
                resolve({ ok: !error, out });
            },
        );
    });
}

async function runPatcher(args, bundle) {
    const full = [PATCHER, ...args, ...(bundle ? [`--dir=${bundle}`] : [])];
    const result = await runNode(full);
    log(`patcher ${args.join(' ')} → ${result.ok ? 'ok' : 'FAILED'}\n${result.out}`);
    return {
        ...result,
        patched: /^ccx-result: patched$/m.test(result.out),
        unverified: result.out.match(/^ccx-unverified: (\S+) (\S+)$/m),
    };
}

// --- what the user is told ------------------------------------------------------------------------

function offerReload(message) {
    vscode.window.showInformationMessage(message, 'Reload Window').then((choice) => {
        if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
    });
}

function showLog() {
    vscode.window.showTextDocument(vscode.Uri.file(LOG_FILE));
}

// Matching signatures are not a promise that the code around them still means the same thing — most of
// them match the *shape* of an assignment, and a release can move what is being assigned without moving
// the shape. Someone who runs the patch by hand reads that in its output; an automatic run has no
// reader, so the notification is the only place it can surface.
function reloadMessage(result, { first } = {}) {
    if (first)
        return 'Vannevar: the patch is on. Reload the window, then pick a provider from the command menu.';
    if (!result.unverified) return 'Vannevar: Claude Code was updated — the patch has been re-applied.';
    const [, installed, verified] = result.unverified;
    return (
        `Vannevar: the patch was re-applied on Claude Code ${installed}, verified only against ` +
        `${verified}. It went on cleanly, but nothing has checked this release.`
    );
}

// A patch that no longer fits is not a broken Claude Code: the patcher stops before it writes, so the
// bundle is exactly as it found it. The fix arrives as an extension update, which is why the two
// offers are the updater and the log.
function reportFailure(bundle, out) {
    const version = (path.basename(bundle || '').match(/(\d+\.\d+\.\d+)/) || [])[1] || 'as installed';
    const message =
        `Vannevar: the patch does not fit Claude Code ${version} — its signatures moved, so it was not ` +
        'applied. Claude Code itself is untouched and working.';
    log(`patch refused on ${version}\n${out}`);
    vscode.window.showWarningMessage(message, 'Check for Updates', 'Show log').then((choice) => {
        if (choice === 'Check for Updates')
            vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
        if (choice === 'Show log') showLog();
    });
}

// --- migration from Claudapter --------------------------------------------------------------------
//
// Same machine, same user, same state — only the directory and the names changed. Everything is copied
// rather than moved, and only where nothing is there yet: a second window activating at the same time
// must not overwrite what the first one has already started writing to, and the old directory stays
// where it is so that going back is a matter of installing the old thing again.
function migrateLegacyState() {
    if (!fs.existsSync(LEGACY_RUNTIME)) return [];
    const carried = [];
    fs.mkdirSync(RUNTIME, { recursive: true });

    for (const file of STATE_FILES) {
        const from = path.join(LEGACY_RUNTIME, file);
        const to = path.join(RUNTIME, file);
        if (!fs.existsSync(from) || fs.existsSync(to)) continue;
        try {
            fs.copyFileSync(from, to);
            carried.push(file);
        } catch (e) {
            log(`migration: ${file} failed — ${e.message}`);
        }
    }

    // Provider icons: downloaded onto this machine, never shipped, and re-downloading them is a script
    // the user would have to find. Copied as a directory, and only when there is no icons/ yet.
    const icons = path.join(LEGACY_RUNTIME, 'icons');
    const iconsTarget = path.join(RUNTIME, 'icons');
    if (fs.existsSync(icons) && !fs.existsSync(iconsTarget)) {
        try {
            fs.cpSync(icons, iconsTarget, { recursive: true });
            carried.push('icons/');
        } catch (e) {
            log(`migration: icons failed — ${e.message}`);
        }
    }

    if (carried.length) log(`migrated from ${LEGACY_RUNTIME}: ${carried.join(', ')}`);
    return carried;
}

// The old keeper is harmless — its `--if-needed` looks for the same `__ccx` marker this patch writes,
// so it finds the bundle patched and does nothing — but it is dead weight pointing at a runtime nobody
// refreshes any more. Offered, never done silently: uninstalling an extension behind someone's back is
// not this extension's call.
function offerKeeperRemoval() {
    let keeper = null;
    try {
        keeper = vscode.extensions.getExtension(LEGACY_KEEPER_ID);
    } catch {}
    if (!keeper) return;

    vscode.window
        .showInformationMessage(
            'Vannevar Code has taken over from Claudapter, including its settings. The old Claudapter ' +
                'Keeper extension is no longer needed.',
            'Uninstall Claudapter Keeper',
            'Leave it',
        )
        .then((choice) => {
            if (choice !== 'Uninstall Claudapter Keeper') return;
            vscode.commands.executeCommand('workbench.extensions.uninstallExtension', LEGACY_KEEPER_ID).then(
                () => log('uninstalled the legacy keeper'),
                (e) => log(`keeper uninstall failed: ${e && e.message}`),
            );
        });
}

// --- the delegated-agent MCP server ---------------------------------------------------------------
//
// Registered at user scope, so every project and every tab can reach it, and from ~/.claude/vannevar
// rather than from the extension folder — that path survives an extension update, the folder name does
// not. The binary is the one shipped inside the bundle this window is running; falling back to PATH is
// for an installation that puts `claude` there and nowhere else.
function claudeBinary(bundle) {
    const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
    if (bundle) {
        const bundled = path.join(bundle, 'resources', 'native-binary', exe);
        if (fs.existsSync(bundled)) return bundled;
    }
    return exe;
}

function mcpServerPath() {
    return path.join(RUNTIME, 'mcp', 'agent-server.mjs');
}

function runClaude(bundle, args) {
    return new Promise((resolve) => {
        execFile(claudeBinary(bundle), args, { windowsHide: true }, (error, stdout, stderr) => {
            resolve({ ok: !error, out: `${stdout || ''}${stderr || ''}`.trim() });
        });
    });
}

async function mcpRegistered(bundle) {
    const list = await runClaude(bundle, ['mcp', 'list']);
    return new RegExp(`^${MCP_SERVER_NAME}\\b`, 'm').test(list.out);
}

// `mcp add` refuses a name that already exists, so a re-register drops the old entry first. A missing
// entry makes remove fail, which is the normal first-install path and not an error.
async function registerMcp(bundle, { explicit }) {
    const server = mcpServerPath();
    if (!fs.existsSync(server)) {
        if (explicit) vscode.window.showWarningMessage(`Vannevar: the runtime is not installed — no ${server}.`);
        return false;
    }

    await runClaude(bundle, ['mcp', 'remove', MCP_SERVER_NAME, '--scope', 'user']);
    const added = await runClaude(bundle, [
        'mcp',
        'add',
        MCP_SERVER_NAME,
        '--scope',
        'user',
        '--',
        process.execPath,
        server,
    ]);
    log(`mcp add → ${added.ok ? 'ok' : 'FAILED'}\n${added.out}`);

    if (!added.ok) {
        if (explicit)
            vscode.window
                .showWarningMessage(`Vannevar: registering "${MCP_SERVER_NAME}" failed.`, 'Show log')
                .then((choice) => choice === 'Show log' && showLog());
        return false;
    }

    vscode.window.showInformationMessage(
        `Vannevar: registered the delegated-agent MCP server ("${MCP_SERVER_NAME}", user scope). ` +
            'Reload the window, then ask Claude to run a task on another profile.',
    );
    return true;
}

// Once, on the first activation that finds no entry. It is not a question: the server is what the
// "run this on another provider" tool is, the extension is what the user installed to get it, and a
// dialog about a registration nobody can act on without reading the README is worse than the fact.
//
// The receipt beside the runtime is what keeps this from spawning the CLI on every window: the answer
// only ever changes when someone unregisters the server by hand, and the command is there for that.
async function ensureMcp(bundle) {
    if (fs.existsSync(MCP_RECEIPT)) return;
    try {
        // Claudapter's entry points at a runtime nothing refreshes any more, and the two servers offer
        // the same tools — so the old one goes before the new one is registered.
        if (fs.existsSync(LEGACY_RUNTIME))
            await runClaude(bundle, ['mcp', 'remove', LEGACY_MCP_SERVER_NAME, '--scope', 'user']);

        const already = await mcpRegistered(bundle);
        const ok = already || (await registerMcp(bundle, { explicit: false }));
        if (ok) writeJson(MCP_RECEIPT, { server: MCP_SERVER_NAME, registeredAt: new Date().toISOString() });
    } catch (e) {
        log(`mcp registration failed: ${e && e.message}`);
    }
}

// --- activation -----------------------------------------------------------------------------------

async function sync(context, { explicit, patch = true }) {
    const bundle = claudeBundle();
    if (!bundle) {
        if (explicit)
            vscode.window.showWarningMessage(
                'Vannevar: the Claude Code extension is not installed in this window, so there is nothing to patch.',
            );
        return null;
    }

    const first = !currentStamp().version;
    const migrated = migrateLegacyState();
    const fresh = syncRuntime(context, bundle);
    installTemplateProfiles(context);
    if (migrated.length) offerKeeperRemoval();
    if (!patch) return bundle;

    // A fresh runtime means new hooks, and a hook that was added since the last release is not in the
    // bundle even when the marker says "patched" — so the version change earns a full apply, over the
    // untouched `.ccx-orig` copy the patcher keeps. Every other window gets the cheap check.
    const result = await runPatcher(fresh || explicit ? [] : ['--if-needed'], bundle);

    if (!result.ok) {
        reportFailure(bundle, result.out);
        return bundle;
    }

    if (explicit) offerReload(result.patched ? reloadMessage(result, { first }) : 'Vannevar: the patch is already on.');
    else if (result.patched) offerReload(reloadMessage(result, { first }));
    return bundle;
}

function activate(context) {
    const command = (id, run) => context.subscriptions.push(vscode.commands.registerCommand(id, run));

    command('vannevar.applyPatch', () => sync(context, { explicit: true }));

    command('vannevar.revertPatch', async () => {
        const result = await runPatcher(['--revert'], claudeBundle());
        if (!result.ok)
            return vscode.window
                .showWarningMessage('Vannevar: the patch could not be reverted.', 'Show log')
                .then((choice) => choice === 'Show log' && showLog());
        offerReload('Vannevar: Claude Code has been restored from its backup.');
    });

    command('vannevar.status', async () => {
        const result = await runPatcher(['--status'], claudeBundle());
        const lines = result.out
            .split('\n')
            .filter((line) => /^(patched|clean|extension:|patcher:)/.test(line.trim()))
            .join(' · ');
        vscode.window
            .showInformationMessage(`Vannevar: ${lines || 'no answer from the patcher'}`, 'Show log')
            .then((choice) => choice === 'Show log' && showLog());
    });

    command('vannevar.showLog', showLog);

    command('vannevar.openProfiles', () => {
        fs.mkdirSync(PROFILES_DIR, { recursive: true });
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(PROFILES_DIR, '.')));
    });

    command('vannevar.installMcp', async () => {
        const bundle = claudeBundle();
        await runClaude(bundle, ['mcp', 'remove', LEGACY_MCP_SERVER_NAME, '--scope', 'user']);
        await registerMcp(bundle, { explicit: true });
    });

    // The patch is what makes every other part of this extension exist, so the only thing the setting
    // turns off is re-applying it unattended — the command still does it on demand, and the runtime is
    // copied either way so that the command has something to run.
    let autoPatch = true;
    try {
        autoPatch = vscode.workspace.getConfiguration('vannevar').get('autoPatch', true) !== false;
    } catch {}
    if (!autoPatch) log('autoPatch is off — the patch is only applied from the command menu');

    sync(context, { explicit: false, patch: autoPatch })
        .then((bundle) => bundle && ensureMcp(bundle))
        .catch((e) => log(`activation failed: ${e && e.stack}`));
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    // The activation test drives these directly, with `vscode` and $HOME both stubbed
    __test: { sync, syncRuntime, migrateLegacyState, claudeBundle, runPatcher, RUNTIME, LEGACY_RUNTIME },
};

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const os = require('node:os');
const home = mkdtempSync(path.join(tmpdir(), 'vannevar-runtime-sync-'));
const extension = path.join(home, 'extension');
const source = path.join(extension, 'runtime');
const deployed = path.join(home, '.claude', 'vannevar');
const bundle = path.join(home, 'claude');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const patchCalls = [];
const load = Module._load;
let api;
try {
    mkdirSync(source, { recursive: true });
    mkdirSync(deployed, { recursive: true });
    cpSync(new URL('../extension.js', import.meta.url), path.join(extension, 'extension.cjs'));
    writeFileSync(path.join(extension, 'package.json'), JSON.stringify(pkg));
    writeFileSync(path.join(source, 'apply-patch.mjs'), '// patcher');
    writeFileSync(path.join(source, 'host.js'), '// new host');
    writeFileSync(path.join(deployed, 'apply-patch.mjs'), '// patcher');
    writeFileSync(path.join(deployed, 'host.js'), '// old host');
    writeFileSync(path.join(deployed, 'patch-version.json'), JSON.stringify({ version: pkg.version, extensionPath: bundle }));
    writeFileSync(path.join(deployed, 'user-state.json'), 'preserve');
    Module._load = function (request, ...args) {
        if (request === 'os') return { ...os, homedir: () => home };
        if (request === 'vscode') return {
            extensions: { getExtension: () => ({ extensionPath: bundle }) },
            window: { showInformationMessage: () => Promise.resolve() },
        };
        if (request === 'child_process') return {
            execFile: (_exe, args, _options, callback) => {
                patchCalls.push(args);
                callback(null, 'ccx-result: up-to-date', '');
            },
        };
        return load.call(this, request, ...args);
    };
    api = require(path.join(extension, 'extension.cjs')).__test;
    Module._load = load;
    const context = { extensionPath: extension };
    assert.equal(api.syncRuntime(context, bundle), true);
    assert.equal(readFileSync(path.join(deployed, 'host.js'), 'utf8'), '// new host');
    assert.equal(readFileSync(path.join(deployed, 'user-state.json'), 'utf8'), 'preserve');
    assert.equal(api.syncRuntime(context, bundle), false);
    mkdirSync(path.join(source, 'nested'), { recursive: true });
    writeFileSync(path.join(source, 'nested', 'added.js'), '// nested');
    assert.equal(api.syncRuntime(context, bundle), true);
    assert.equal(readFileSync(path.join(deployed, 'nested', 'added.js'), 'utf8'), '// nested');
    rmSync(path.join(deployed, 'host.js'));
    assert.equal(api.syncRuntime(context, bundle), true);
    writeFileSync(path.join(source, 'host.js'), '// changed again');
    await api.sync(context, { explicit: false });
    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].includes('--if-needed'), false);
    await api.sync(context, { explicit: false });
    assert.equal(patchCalls.length, 2);
    assert.equal(patchCalls[1].includes('--if-needed'), true);
    console.log('OK — same-version runtime changes refresh, preserve state and fully reapply');
} finally {
    Module._load = load;
    rmSync(home, { recursive: true, force: true });
}

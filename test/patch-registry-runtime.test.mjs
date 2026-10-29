// Runtime-registry binding: execute the product CLI, never a copy of its validator.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const runtime = new URL('../runtime/', import.meta.url);
const source = readFileSync(new URL('apply-patch.mjs', runtime), 'utf8');
const registryText = readFileSync(new URL('patch-points-registry.json', runtime), 'utf8');
const firstId = source.match(/const PATCHES = \[\s*\{\s*id: '([^']+)'/)[1];
const idLine = `id: '${firstId}',`;

function fixture(t, { patcher = source, registry = registryText } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'patch-registry-runtime-'));
    t.after(() => {
        rmSync(root, { recursive: true, force: true });
        assert.equal(existsSync(root), false, 'teardown removes the entire mutable root');
    });
    const copiedRuntime = join(root, 'copied runtime');
    const cwd = join(root, 'unrelated cwd');
    mkdirSync(copiedRuntime);
    mkdirSync(cwd);
    const module = join(copiedRuntime, 'apply-patch.mjs');
    writeFileSync(module, patcher);
    writeFileSync(join(copiedRuntime, 'patch-points-registry.json'), registry);
    copyFileSync(new URL('ast-locator.mjs', runtime), join(copiedRuntime, 'ast-locator.mjs'));
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (/^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|XDG_.*|APPDATA|LOCALAPPDATA|NODE_OPTIONS)$/i.test(key)) delete env[key];
    }
    // Fail on home discovery or filesystem access outside this disposable fixture.
    const guard = join(root, 'guard.cjs');
    writeFileSync(guard, `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
os.homedir = () => { throw Error('forbidden user-home lookup'); };
const root = ${JSON.stringify(root)};
for (const name of ['readFileSync', 'existsSync', 'readdirSync', 'statSync', 'writeFileSync', 'mkdirSync', 'copyFileSync']) {
    const original = fs[name];
    fs[name] = (file, ...args) => {
        const resolved = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
        const relative = path.relative(root, resolved);
        if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            throw Error('forbidden outside-root access: ' + resolved);
        }
        return original(file, ...args);
    };
}
syncBuiltinESMExports();
`);
    return {
        root, module, cwd, env,
        run() {
            const result = spawnSync(process.execPath, ['--require', guard, module, '--validate-registry'], {
                cwd, env, encoding: 'utf8', timeout: 10000,
            });
            assert.ifError(result.error);
            assert.equal(result.signal, null, result.stderr);
            assert.doesNotMatch(result.stderr, /forbidden /);
            return result;
        },
    };
}

function refusal(t, options, diagnostic) {
    const result = fixture(t, options).run();
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /patch registry mismatch/);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
    assert.doesNotMatch(result.stdout, /one-to-one/);
}

test('valid mapping uses the real runtime and registry', t => {
    const result = fixture(t).run();
    assert.equal(result.status, 0, result.stderr);
    const counts = result.stdout.match(/patch points: (\d+) runtime patch\(es\).*?(\d+) registry entry\(ies\)/);
    assert.ok(counts, result.stdout);
    assert.equal(Number(counts[1]), JSON.parse(registryText).patchPoints.length);
    assert.equal(counts[1], counts[2]);
    assert.match(result.stdout, /one-to-one/);
    t.diagnostic(`Measured mapping: ${counts[1]} runtime patches, ${counts[2]} registry entries`);
});

test('missing runtime ID is rejected by the product', t => {
    assert.ok(source.includes(idLine));
    refusal(t, { patcher: source.replace(idLine, '') }, 'runtime patch for extension.js has no id');
});

test('missing registry entry is rejected by the product', t => {
    const registry = JSON.parse(registryText);
    assert.ok(registry.patchPoints.some(point => point.id === firstId));
    registry.patchPoints = registry.patchPoints.filter(point => point.id !== firstId);
    refusal(t, { registry: JSON.stringify(registry) }, `runtime patch ${firstId} has no registry entry`);
});

test('duplicate runtime ID is rejected by the product', t => {
    const ids = [...source.matchAll(/^\s+id: '(PATCH-[^']+)',/gm)];
    assert.ok(ids.length > 1);
    assert.notEqual(ids[1][1], firstId);
    refusal(t, { patcher: source.replace(`id: '${ids[1][1]}',`, idLine) }, `duplicate runtime id: ${firstId}`);
});

test('malformed registry JSON is rejected by the product loader', t => {
    refusal(t, { registry: '{bad' }, 'patch registry is not valid JSON:');
});

test('validation succeeds without HOME or a Claude installation', t => {
    const sandbox = fixture(t);
    assert.equal(Object.keys(sandbox.env).some(key => /^(HOME|USERPROFILE|HOMEDRIVE|HOMEPATH)$/i.test(key)), false);
    assert.equal(existsSync(join(sandbox.root, '.claude')), false);
    assert.equal(existsSync(join(sandbox.root, '.vscode')), false);
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no Claude Code installation was looked for, and no user home was read/);
});

test('registry lookup follows the copied runtime, not CWD', t => {
    const sandbox = fixture(t);
    writeFileSync(join(sandbox.cwd, 'patch-points-registry.json'), '{invalid CWD decoy');
    const result = sandbox.run();
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes(join(sandbox.root, 'copied runtime', 'patch-points-registry.json')));
    assert.match(result.stdout, /one-to-one/);
});

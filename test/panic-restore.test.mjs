// test/panic-restore.test.mjs — panic restore coverage against the product (task 18, QA-044)
//
// Every case spawns the real CLI module `runtime/apply-patch.mjs --panic-restore` (or a byte-identical
// copy of it with a synthetic patch registry for the registry-governed cleanup branch) and asserts the
// observable recovery/refusal behavior:
//   1. exact backup restore (tracked CRLF fixtures, byte-for-byte)
//   2. explicit matching pristine restore
//   3. safe registry-governed marker cleanup + refusal while a marker remains
//   4. foreign/unknown marker refusal (no backup, no pristine, no self-contained policy)
//   5. pristine build mismatch refusal (pristine carries a foreign marker)
//   6. multi-file failure rollback (read-only target aborts before any write)
//   7. idempotent second run
//   8. syntax failure rejects the result
// Isolation: mutable roots live only in the OS temp dir; tracked synthetic fixtures come from
// test/fixtures/adaptation/; no installed Claude Code, ~/.claude or ~/.vscode/extensions is read or
// written — the bundle dir is always passed explicitly via --dir. Teardown runs in finally, so temp
// roots are removed even when an assertion fails.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PATCHER = resolve('runtime/apply-patch.mjs');
const AST_LOCATOR = resolve('runtime/ast-locator.mjs');
const FIXTURES = resolve('test/fixtures/adaptation');
const TARGETS = ['extension.js', 'webview/index.js'];

// The two files the patcher tracks (runtime/apply-patch.mjs PATCHES[*].file). Contents are synthetic.
const PATCHED_EXT = 'const ext=1;/*__ccx*/console.log(ext);\n';
const CLEAN_EXT = 'const ext=1;console.log(ext);\n';
const PATCHED_WEBVIEW = 'const wv=2;/*__ccx*/console.log(wv);\n';
const CLEAN_WEBVIEW = 'const wv=2;console.log(wv);\n';
const BROKEN_EXT = 'const broken = {\n'; // valid to write, invalid to parse — the postcondition must catch it

function tmpRoot(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}

function teardown(root) {
    for (const rel of TARGETS) {
        const file = join(root, rel);
        if (existsSync(file)) {
            try { chmodSync(file, 0o666); } catch {}
        }
    }
    rmSync(root, { recursive: true, force: true });
}

// A synthetic bundle: patched live files plus optional .ccx-orig backups.
function makeBundle(root, { patchExt = true, patchWebview = true, backups = false } = {}) {
    mkdirSync(join(root, 'webview'), { recursive: true });
    writeFileSync(join(root, 'extension.js'), patchExt ? PATCHED_EXT : CLEAN_EXT, 'utf8');
    writeFileSync(join(root, 'webview/index.js'), patchWebview ? PATCHED_WEBVIEW : CLEAN_WEBVIEW, 'utf8');
    if (backups) {
        writeFileSync(join(root, 'extension.js.ccx-orig'), CLEAN_EXT, 'utf8');
        writeFileSync(join(root, 'webview/index.js.ccx-orig'), CLEAN_WEBVIEW, 'utf8');
    }
}

function makePristineDir(root) {
    const pristine = join(root, 'pristine');
    mkdirSync(pristine, { recursive: true });
    writeFileSync(join(pristine, 'extension.js'), CLEAN_EXT, 'utf8');
    mkdirSync(join(pristine, 'webview'), { recursive: true });
    writeFileSync(join(pristine, 'webview/index.js'), CLEAN_WEBVIEW, 'utf8');
    return pristine;
}

// Runs the product. `patcher` defaults to the repo module; a copy of it (case 3) points at a
// synthetic patch-points-registry.json placed next to the copy.
function runPanicRestore(bundleDir, { pristineDir, patcher = PATCHER } = {}) {
    const args = [patcher, '--panic-restore', `--dir=${bundleDir}`];
    if (pristineDir) args.push(`--pristine-dir=${pristineDir}`);
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

// Byte-identical copy of the patcher plus a registry that marks both targets self-contained, so the
// registry-governed cleanup branch (apply-patch.mjs registryEntryFor -> restorePolicy check) is
// exercised without touching the repo registry. The registry is runtime-read data by design.
function makeSelfContainedPatcher(root) {
    mkdirSync(root, { recursive: true });
    copyFileSync(PATCHER, join(root, 'apply-patch.mjs'));
    copyFileSync(AST_LOCATOR, join(root, 'ast-locator.mjs'));
    const registry = {
        schemaVersion: '1.0',
        patchPoints: TARGETS.map((file) => ({
            id: `TEST-PANIC-${file.replace(/[^\w]+/g, '-').toUpperCase()}`,
            targetFile: file,
            restorePolicy: 'self-contained',
        })),
    };
    writeFileSync(join(root, 'patch-points-registry.json'), JSON.stringify(registry, null, 2), 'utf8');
    return join(root, 'apply-patch.mjs');
}

// 1. exact backup restore — tracked CRLF fixtures come back byte-for-byte
{
    const root = tmpRoot('panic-restore-c1-');
    try {
        mkdirSync(join(root, 'webview'), { recursive: true });
        const pristineCrlf = readFileSync(join(FIXTURES, 'panic-pristine-crlf.js'));
        const patchedCrlf = readFileSync(join(FIXTURES, 'panic-patched-crlf.js'));
        writeFileSync(join(root, 'extension.js'), patchedCrlf);
        writeFileSync(join(root, 'extension.js.ccx-orig'), pristineCrlf);
        writeFileSync(join(root, 'webview/index.js'), PATCHED_WEBVIEW, 'utf8');
        writeFileSync(join(root, 'webview/index.js.ccx-orig'), CLEAN_WEBVIEW, 'utf8');

        const run = runPanicRestore(root);
        assert.strictEqual(run.status, 0, `case 1: exit 0, got ${run.status}; stderr: ${run.stderr}`);
        assert.ok(Buffer.compare(readFileSync(join(root, 'extension.js')), pristineCrlf) === 0,
            'case 1: extension.js restored byte-for-byte from backup (CRLF preserved)');
        assert.strictEqual(readFileSync(join(root, 'webview/index.js'), 'utf8'), CLEAN_WEBVIEW,
            'case 1: webview/index.js restored from backup');
        assert.ok(!readFileSync(join(root, 'extension.js'), 'utf8').includes('__ccx'),
            'case 1: marker removed from restored file');
        assert.ok(existsSync(join(root, 'extension.js.ccx-orig')) &&
            Buffer.compare(readFileSync(join(root, 'extension.js.ccx-orig')), pristineCrlf) === 0,
            'case 1: backup left in place and unchanged');
        console.log('case 1 exact backup restore: PASS');
    } finally { teardown(root); }
}

// 2. explicit matching pristine restore — no backups, both files recovered from --pristine-dir
{
    const root = tmpRoot('panic-restore-c2-');
    try {
        makeBundle(root, { backups: false });
        const pristine = makePristineDir(root);

        const run = runPanicRestore(root, { pristineDir: pristine });
        assert.strictEqual(run.status, 0, `case 2: exit 0, got ${run.status}; stderr: ${run.stderr}`);
        assert.strictEqual(readFileSync(join(root, 'extension.js'), 'utf8'), CLEAN_EXT,
            'case 2: extension.js restored from pristine dir');
        assert.strictEqual(readFileSync(join(root, 'webview/index.js'), 'utf8'), CLEAN_WEBVIEW,
            'case 2: webview/index.js restored from pristine dir');
        assert.ok(run.stdout.includes('восстановлено 2 файл'),
            `case 2: success summary reported, got: ${run.stdout.trim()}`);
        console.log('case 2 explicit matching pristine restore: PASS');
    } finally { teardown(root); }
}

// 3. safe registered marker cleanup — self-contained policy restores a clean file, and refuses
//    while a marker is still present (never cuts between markers)
{
    const patcherRoot = tmpRoot('panic-restore-c3-patcher-');
    const cleanRoot = tmpRoot('panic-restore-c3-clean-');
    const markerRoot = tmpRoot('panic-restore-c3-marker-');
    try {
        const patcher = makeSelfContainedPatcher(patcherRoot);

        makeBundle(cleanRoot, { patchExt: false, patchWebview: false, backups: false });
        const cleanRun = runPanicRestore(cleanRoot, { patcher });
        assert.strictEqual(cleanRun.status, 0,
            `case 3: self-contained cleanup of clean files exits 0, got ${cleanRun.status}; stderr: ${cleanRun.stderr}`);

        makeBundle(markerRoot, { patchExt: true, patchWebview: false, backups: false });
        const refusalRun = runPanicRestore(markerRoot, { patcher });
        assert.strictEqual(refusalRun.status, 1,
            `case 3: cleanup with a marker remaining refuses (exit 1), got ${refusalRun.status}`);
        assert.ok(refusalRun.stderr.includes('маркер __ccx остался после восстановления'),
            `case 3: refusal names the remaining marker, got: ${refusalRun.stderr.trim()}`);
        assert.strictEqual(readFileSync(join(markerRoot, 'extension.js'), 'utf8'), PATCHED_EXT,
            'case 3: file with marker is left as-is, no blind cutting');
        console.log('case 3 safe registered marker cleanup: PASS');
    } finally {
        teardown(patcherRoot);
        teardown(cleanRoot);
        teardown(markerRoot);
    }
}

// 4. foreign/unknown marker refusal — no backup, no pristine, repo registry has no self-contained
//    policy for the target, so the run refuses and writes nothing
{
    const root = tmpRoot('panic-restore-c4-');
    try {
        makeBundle(root, { backups: false });

        const run = runPanicRestore(root);
        assert.strictEqual(run.status, 1,
            `case 4: refusal exits 1, got ${run.status}`);
        assert.ok(run.stderr.includes('no exact backup (*.ccx-orig)'),
            `case 4: refusal names the missing recovery path, got: ${run.stderr.trim()}`);
        assert.ok(run.stderr.includes('reinstall guidance'),
            `case 4: refusal carries reinstall guidance, got: ${run.stderr.trim()}`);
        assert.strictEqual(readFileSync(join(root, 'extension.js'), 'utf8'), PATCHED_EXT,
            'case 4: extension.js untouched by refused run');
        assert.strictEqual(readFileSync(join(root, 'webview/index.js'), 'utf8'), PATCHED_WEBVIEW,
            'case 4: webview/index.js untouched by refused run');
        console.log('case 4 foreign/unknown marker refusal: PASS');
    } finally { teardown(root); }
}

// 5. pristine build mismatch — a pristine artifact that carries a foreign marker is not a valid
//    same-build source: the run refuses via the postcondition instead of reporting success
{
    const root = tmpRoot('panic-restore-c5-');
    try {
        makeBundle(root, { backups: false });
        const pristine = makePristineDir(root);
        writeFileSync(join(pristine, 'extension.js'), PATCHED_EXT, 'utf8'); // wrong build: still carries __ccx

        const run = runPanicRestore(root, { pristineDir: pristine });
        assert.strictEqual(run.status, 1,
            `case 5: mismatched pristine is refused (exit 1), got ${run.status}`);
        assert.ok(run.stderr.includes('маркер __ccx остался после восстановления'),
            `case 5: refusal names the marker in the mismatched pristine, got: ${run.stderr.trim()}`);
        assert.ok(!run.stdout.includes('восстановлено'),
            'case 5: no success summary for a mismatched pristine');
        console.log('case 5 pristine build mismatch: PASS');
    } finally { teardown(root); }
}

// 6. multi-file failure rollback — a read-only target aborts the write phase before anything lands
{
    const root = tmpRoot('panic-restore-c6-');
    try {
        makeBundle(root, { backups: true });
        chmodSync(join(root, 'extension.js'), 0o444); // first write target is unwritable

        const run = runPanicRestore(root);
        assert.strictEqual(run.status, 1,
            `case 6: write failure refuses (exit 1), got ${run.status}`);
        assert.ok(run.stderr.includes('отказ перед записью'),
            `case 6: refusal reports abort before writing, got: ${run.stderr.trim()}`);
        assert.strictEqual(readFileSync(join(root, 'extension.js'), 'utf8'), PATCHED_EXT,
            'case 6: read-only extension.js not half-written');
        assert.strictEqual(readFileSync(join(root, 'webview/index.js'), 'utf8'), PATCHED_WEBVIEW,
            'case 6: webview/index.js left untouched after the failure');
        console.log('case 6 multi-file failure rollback: PASS');
    } finally { teardown(root); }
}

// 7. idempotent second run — restoring twice yields the same bytes and succeeds both times
{
    const root = tmpRoot('panic-restore-c7-');
    try {
        makeBundle(root, { backups: true });

        const first = runPanicRestore(root);
        assert.strictEqual(first.status, 0, `case 7: first run exits 0, got ${first.status}`);
        const afterFirst = {
            ext: readFileSync(join(root, 'extension.js')),
            webview: readFileSync(join(root, 'webview/index.js')),
        };

        const second = runPanicRestore(root);
        assert.strictEqual(second.status, 0, `case 7: second run exits 0, got ${second.status}`);
        assert.ok(Buffer.compare(readFileSync(join(root, 'extension.js')), afterFirst.ext) === 0 &&
            Buffer.compare(readFileSync(join(root, 'webview/index.js')), afterFirst.webview) === 0,
            'case 7: second run leaves the same bytes (idempotent)');
        console.log('case 7 idempotent second run: PASS');
    } finally { teardown(root); }
}

// 8. syntax failure rejects result — a backup with broken syntax is restored but must not be
//    reported as a successful recovery
{
    const root = tmpRoot('panic-restore-c8-');
    try {
        makeBundle(root, { backups: true });
        writeFileSync(join(root, 'extension.js.ccx-orig'), BROKEN_EXT, 'utf8');

        const run = runPanicRestore(root);
        assert.notStrictEqual(run.status, 0,
            `case 8: syntax failure must not exit 0, got ${run.status}`);
        assert.ok(run.stderr.includes('syntax check failed for'),
            `case 8: refusal names the syntax check failure, got: ${run.stderr.trim()}`);
        assert.ok(!run.stdout.includes('восстановлено'),
            'case 8: no success summary for a syntactically broken restore');
        console.log('case 8 syntax failure rejects result: PASS');
    } finally { teardown(root); }
}

console.log('panic-restore.test.mjs: 8/8 recovery/refusal cases passed against runtime/apply-patch.mjs');

// Additional contract checks must all run, including when the product violates one of them.
const contractFailures = [];
for (const [name, verify] of [
    ['pristine version mismatch without markers', (root, name) => {
        makeBundle(root);
        writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }));
        const pristine = makePristineDir(root);
        writeFileSync(join(pristine, 'package.json'), JSON.stringify({ version: '2.0.0' }));
        const run = runPanicRestore(root, { pristineDir: pristine });
        console.log(`${name}: observed exit=${run.status}`);
        assert.notStrictEqual(run.status, 0, 'different pristine version must be refused');
        assert.strictEqual(readFileSync(join(root, 'extension.js'), 'utf8'), PATCHED_EXT);
        assert.strictEqual(readFileSync(join(root, 'webview/index.js'), 'utf8'), PATCHED_WEBVIEW);
    }],
    ['rollback after second target write failure', (root, name) => {
        makeBundle(root, { backups: true });
        chmodSync(join(root, 'webview/index.js'), 0o444);
        const run = runPanicRestore(root);
        const ext = readFileSync(join(root, 'extension.js'), 'utf8');
        const webview = readFileSync(join(root, 'webview/index.js'), 'utf8');
        console.log(`${name}: observed exit=${run.status}, firstUnchanged=${ext === PATCHED_EXT}, secondUnchanged=${webview === PATCHED_WEBVIEW}`);
        assert.strictEqual(run.status, 1, 'second target write must fail');
        assert.strictEqual(ext, PATCHED_EXT, 'first target must be rolled back');
        assert.strictEqual(webview, PATCHED_WEBVIEW, 'second target must remain unchanged');
    }],
    ['missing recovery file refuses before writes', (root, name) => {
        makeBundle(root, { backups: true });
        rmSync(join(root, 'webview/index.js'));
        rmSync(join(root, 'webview/index.js.ccx-orig'));
        const run = runPanicRestore(root);
        console.log(`${name}: observed exit=${run.status}`);
        assert.strictEqual(run.status, 1);
        assert.strictEqual(readFileSync(join(root, 'extension.js'), 'utf8'), PATCHED_EXT);
        assert.ok(!existsSync(join(root, 'webview/index.js')));
    }],
    ['read-only recovery source remains readable and unchanged', (root, name) => {
        makeBundle(root, { backups: true });
        const source = join(root, 'extension.js.ccx-orig');
        chmodSync(source, 0o444);
        try {
            const run = runPanicRestore(root);
            console.log(`${name}: observed exit=${run.status}`);
            assert.strictEqual(run.status, 0);
            assert.strictEqual(readFileSync(join(root, 'extension.js'), 'utf8'), CLEAN_EXT);
            assert.strictEqual(readFileSync(source, 'utf8'), CLEAN_EXT);
        } finally { chmodSync(source, 0o666); }
    }],
]) {
    const root = tmpRoot('panic-restore-contract-');
    try {
        verify(root, name);
        console.log(`${name}: PASS`);
    } catch (error) {
        contractFailures.push(`${name}: ${error.message}`);
        console.error(`${name}: FAIL: ${error.message}`);
    } finally { teardown(root); }
}
assert.strictEqual(contractFailures.length, 0, contractFailures.join('\n'));

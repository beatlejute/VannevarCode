import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = readFileSync(path.join(ROOT, 'runtime', 'apply-patch.mjs'), 'utf8');
const WORK = mkdtempSync(path.join(tmpdir(), 'ccx-lock-race-'));
const STAT_EXPR = 'statSync(lock)';

function makeCase(name, statExpr) {
    const dir = path.join(WORK, name);
    mkdirSync(dir);
    const patcher = path.join(dir, 'apply-patch.mjs');
    assert.equal(SOURCE.split(STAT_EXPR).length, 2, 'lock metadata read anchor must be unique');
    writeFileSync(patcher, SOURCE.replace(STAT_EXPR, statExpr));
    writeFileSync(path.join(dir, 'patch-version.json'), JSON.stringify({ version: 'test', verifiedAgainst: [] }));

    const bundle = path.join(dir, 'bundle');
    mkdirSync(path.join(bundle, 'webview'), { recursive: true });
    writeFileSync(path.join(bundle, 'extension.js'), '/*__ccx*/\n');
    writeFileSync(path.join(bundle, 'webview', 'index.js'), '/*__ccx*/\n');
    writeFileSync(path.join(bundle, '.ccx.lock'), 'held by another process');
    return { patcher, bundle, lock: path.join(bundle, '.ccx.lock') };
}

function run(patcher, bundle) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [patcher, `--dir=${bundle}`, '--if-needed']);
        let text = '';
        child.stdout.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
        child.stderr.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, text }));
    });
}

try {
    const race = makeCase(
        'enoent',
        "(() => { unlinkSync(lock); return statSync(lock); })()",
    );
    const recovered = await run(race.patcher, race.bundle);
    assert.equal(recovered.code, 0, `the patcher did not retry after the lock disappeared:\n${recovered.text}`);
    assert.match(recovered.text, /^ccx-result: up-to-date$/m);
    assert.ok(!existsSync(race.lock), 'the recovered run left its lock behind');
    console.log('OK — a lock disappearing before metadata read retries exclusive acquisition');

    const otherError = makeCase(
        'non-enoent',
        "(() => { const error = new Error('injected stat failure'); error.code = 'EACCES'; throw error; })()",
    );
    const failed = await run(otherError.patcher, otherError.bundle);
    assert.notEqual(failed.code, 0, 'a non-ENOENT metadata error must be propagated');
    assert.match(failed.text, /injected stat failure/);
    console.log('OK — a non-ENOENT metadata error is propagated');
} finally {
    rmSync(WORK, { recursive: true, force: true });
}

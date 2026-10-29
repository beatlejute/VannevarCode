import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { shippedFiles, buildVsix } from '../scripts/build-vsix.mjs';
import assert from 'node:assert';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(__dirname, '..');
import { locate } from '../runtime/ast-locator.mjs';

const FIXTURES = join(ROOT, 'test', 'fixtures', 'ast-locator');

function read(fixture) {
    return readFileSync(join(FIXTURES, fixture), 'utf8');
}

const results = [];

// 1. Exactly-one candidate — range valid, byte preservation
{
    const source = read('single-function.js');
    const fullLen = source.length;
    const descriptor = { range: { start: 0, end: fullLen }, identifier: 'registerProvider', kind: 'ast' };
    const found = locate(source, descriptor);
    assert.strictEqual(found.length, 1, 'exactly one candidate');
    assert.strictEqual(found[0].start, 0);
    assert.strictEqual(found[0].end, fullLen);
    assert.strictEqual(found[0].kind, 'ast');
    assert.strictEqual(found[0].identifier, 'registerProvider');
    const sliced = source.slice(0, fullLen);
    assert.strictEqual(sliced, source, 'byte preservation — slice matches source range');
    results.push({ case: 'exactly-one candidate + byte preservation', status: 'pass' });
}

// 2. Minified local rename — range still valid
{
    const source = read('minified.js');
    const fullLen = source.length;
    const descriptor = { range: { start: 0, end: fullLen }, identifier: 'r', kind: 'ast' };
    const found = locate(source, descriptor);
    assert.strictEqual(found.length, 1, 'minified: one candidate');
    assert.strictEqual(source.slice(0, fullLen), source, 'minified byte preservation');
    results.push({ case: 'minified local rename', status: 'pass' });
}

// 3. Whitespace/reformat — range still valid
{
    const source = read('spaced.js');
    const fullLen = source.length;
    const descriptor = { range: { start: 0, end: fullLen }, identifier: 'registerProvider', kind: 'ast' };
    const found = locate(source, descriptor);
    assert.strictEqual(found.length, 1, 'spaced: one candidate');
    assert.strictEqual(found[0].start, 0);
    assert.strictEqual(found[0].end, fullLen);
    results.push({ case: 'whitespace/reformat', status: 'pass' });
}

// 4. False-positive neighbor — similar AST in unrelated module
{
    const source = read('neighbor.js');
    const fullLen = source.length;
    const descriptor = { range: { start: 0, end: fullLen }, identifier: 'resolveProvider', kind: 'ast' };
    const found = locate(source, descriptor);
    assert.strictEqual(found.length, 1, 'neighbor: one candidate for resolveProvider');
    assert.strictEqual(found[0].identifier, 'resolveProvider');
    results.push({ case: 'false-positive neighbor — range refers to correct bytes', status: 'pass' });
}

// 5. Multiple candidates → fail closed
{
    const source = read('multiple-functions.js');
    // No valid range in descriptor → fail closed, empty array
    const found = locate(source, { identifier: 'registerProvider', kind: 'ast' });
    assert.strictEqual(found.length, 0, 'zero applicable variants → fail closed, empty array');
    results.push({ case: 'multiple candidates — no range → fail closed', status: 'pass' });
}

// 6. Zero required → fail closed
{
    const source = read('single-function.js');
    const found = locate(source, {});
    assert.strictEqual(found.length, 0, 'zero required → fail closed, empty array');
    results.push({ case: 'zero required → fail closed', status: 'pass' });
}

// 7. Zero optional → empty
{
    const source = read('single-function.js');
    const found = locate(source, { range: null });
    assert.strictEqual(found.length, 0, 'zero optional → empty array');
    results.push({ case: 'zero optional', status: 'pass' });
}

// 8. Strict variant fork — kind in descriptor preserved
{
    const source = read('single-function.js');
    const fullLen = source.length;
    const descriptor = { range: { start: 0, end: fullLen }, identifier: 'func', kind: 'strict' };
    const found = locate(source, descriptor);
    assert.strictEqual(found.length, 1, 'strict variant fork: one candidate');
    assert.strictEqual(found[0].kind, 'strict', 'kind preserved from descriptor');
    results.push({ case: 'strict variant fork', status: 'pass' });
}

// 9. TypeError — non-string rawSource
{
    assert.throws(() => locate(null, {}), TypeError, 'null rawSource throws TypeError');
    assert.throws(() => locate(123, {}), TypeError, 'number rawSource throws TypeError');
    results.push({ case: 'TypeError for non-string rawSource', status: 'pass' });
}

// 10. Byte preservation outside intended range — descriptor strictly inside string
{
    const source = '0123456789ABCDEFGHIJ0123456789'; // synthetic/minimized, len 30
    const descriptor = { range: { start: 10, end: 20 }, identifier: 'inside', kind: 'ast' };
    const found = locate(source, descriptor);
    assert.strictEqual(found.length, 1, 'outside range: exactly one candidate');
    assert.strictEqual(found[0].start, 10);
    assert.strictEqual(found[0].end, 20);
    const outsideBefore = source.slice(0, 10);
    const outsideAfter = source.slice(20);
    assert.strictEqual(outsideBefore + outsideAfter, '01234567890123456789', 'bytes outside descriptor preserved');
    results.push({ case: 'byte preservation outside intended range (outside)', status: 'pass' });
}

// Real parsing must resolve declarations, not identifier references or comments.
{
    const source = '// registerProvider\r\nconst label = "Привет";\r\n' + read('single-function.js') + '\nregisterProvider("x");';
    const found = locate(source, { identifier: 'registerProvider' });
    assert.strictEqual(found.length, 1);
    const expected = read('single-function.js').trim();
    assert.strictEqual(source.slice(found[0].start, found[0].end), expected);
    assert.strictEqual(found[0].identifier, 'registerProvider');
    const edited = source.slice(0, found[0].start) + 'function replaced() {}' + source.slice(found[0].end);
    assert.deepStrictEqual(Buffer.from(edited.slice(0, found[0].start)), Buffer.from(source.slice(0, found[0].start)));
    assert.ok(Buffer.from(edited).subarray(-Buffer.byteLength(source.slice(found[0].end))).equals(Buffer.from(source.slice(found[0].end))));
    results.push({ case: 'real AST exactly-one identifier + raw provenance + outside bytes', status: 'pass' });
}
{
    assert.deepStrictEqual(locate('function broken( {', { identifier: 'broken' }), []);
    assert.deepStrictEqual(locate(read('single-function.js'), { identifier: 'missing', required: true }), []);
    assert.deepStrictEqual(locate(read('multiple-functions.js'), { identifier: 'registerProvider' }), []);
    results.push({ case: 'real AST parse error, multiple candidates, zero required fail closed', status: 'pass' });
}
{
    const source = 'function target(){ function registerProvider(){} } function neighbor(){ function registerProvider(){} }';
    const found = locate(source, { semanticAnchor: 'registerProvider', moduleScope: { identifier: 'target' } });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].start, source.indexOf('function registerProvider'));
    assert.deepStrictEqual(locate(source, { identifier: 'registerProvider', moduleScope: { identifier: 'missing' } }), []);
    assert.deepStrictEqual(locate(source, { identifier: 'registerProvider', moduleScope: { unsupported: true } }), []);
    results.push({ case: 'real AST semantic anchor and module scope reject neighbor', status: 'pass' });
}
{
    assert.strictEqual(locate('const $r = () => 1;', { identifier: '$r' }).length, 1);
    for (const range of [{ start: -1, end: 1 }, { start: 2, end: 1 }, { start: 0, end: 999 }, { start: 0.5, end: 1 }]) {
        assert.deepStrictEqual(locate('abc', { range }), []);
    }
    results.push({ case: 'real AST minified identifier and invalid explicit ranges', status: 'pass' });
}

// Execute the real patcher with synthetic patch definitions and its shipped toolchain.
{
    const root = mkdtempSync(join(tmpdir(), 'ast-dispatch-'));
    try {
        const files = shippedFiles(ROOT);
        const vsix = buildVsix(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')), files);
        assert.ok(vsix.length > 0);
        for (const file of files.filter((f) => f.name.startsWith('runtime/'))) {
            const target = join(root, file.name);
            mkdirSync(join(target, '..'), { recursive: true });
            writeFileSync(target, file.data);
        }
        const patcherFile = join(root, 'runtime', 'apply-patch.mjs');
        const source = readFileSync(patcherFile, 'utf8');
        // Only patch definitions are substituted; matching, dispatch and writes are production code.
        const start = source.indexOf('const PATCHES = [');
        const end = source.indexOf('// Things the injected code drives');
        const definitions = `const PATCHES = [{id:'TEST-AST',file:'extension.js',find:/function target\\(\\)\\{/,replace:'function target(){/*__ccx*/',where:'replace'}];\n`;
        writeFileSync(patcherFile, source.slice(0, start) + definitions + source.slice(end));
        const variant = { id: 'ast', state: 'active', matcherKind: 'ast', identifier: 'target' };
        const pristine = '// prefix\r\nfunction target(){return "ok";}\r\n// suffix';
        const cases = [
            { name: 'exactly-one', raw: pristine, variants: [variant], exit: 0 },
            { name: 'parse error', raw: 'function target( {', variants: [variant], exit: 1 },
            { name: 'multiple candidates', raw: 'function target(){}; (()=>{function target(){}})();', variants: [variant], exit: 1 },
            { name: 'zero required', raw: 'function other(){}', variants: [variant], exit: 1 },
            { name: 'multiple variants', raw: pristine, variants: [variant, { ...variant, id: 'second' }], exit: 1 },
            { name: 'replacement precondition', raw: 'const target=()=>1;', variants: [variant], exit: 1 },
        ];
        for (const [index, item] of cases.entries()) {
            const bundle = join(root, `bundle-${index}`);
            mkdirSync(bundle);
            const target = join(bundle, 'extension.js');
            writeFileSync(target, item.raw);
            writeFileSync(join(root, 'runtime', 'patch-points-registry.json'), JSON.stringify({
                schemaVersion: '1.0', patchPoints: [{ id: 'TEST-AST', targetFile: 'extension.js', variants: item.variants }],
            }));
            const run = spawnSync(process.execPath, [patcherFile, `--dir=${bundle}`], {
                encoding: 'utf8', env: { ...process.env, HOME: root, USERPROFILE: root, NODE_PATH: '' },
            });
            assert.strictEqual(run.status, item.exit, `${item.name}: ${run.stderr}`);
            const actual = readFileSync(target);
            const expected = item.exit === 0 ? item.raw.replace('function target(){', 'function target(){/*__ccx*/') : item.raw;
            assert.deepStrictEqual(actual, Buffer.from(expected), `${item.name}: surgical bytes / refusal-before-write`);
            results.push({ case: `shipped runtime dispatch ${item.name}; exit code: ${run.status}`, status: 'pass' });
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

console.log('--- ast-locator test coverage ---');
for (const r of results) {
    console.log(`${r.status.toUpperCase()} — ${r.case}`);
}
console.log(`\nAll ${results.length} scenarios passed!`);
process.exit(0);

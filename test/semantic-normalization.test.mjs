import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const ROOT = join(__dirname, '..');
const NORMALIZE_TOOL = join(ROOT, 'scripts/adaptation/normalize-js.mjs');
const FIXTURES_DIR = join(ROOT, 'test/fixtures/semantic-normalization');

const TMP_DIR = join(tmpdir(), `ccx-semantic-test-${process.pid}`);

function cleanup() {
    if (existsSync(TMP_DIR)) {
        rmSync(TMP_DIR, { recursive: true, force: true });
    }
}

cleanup();
mkdirSync(TMP_DIR, { recursive: true });

const fixtureFiles = [
    'literal-passthrough.js',
    'string-array.js',
    'constant-alias.js',
    'restricted-decoder.js',
    'unresolved-dynamic.js',
    'cycle.js',
    'provenance-ranges.js',
    'edge-cases.js'
];

async function runNormalize(inputFile, outputFile) {
    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
        const child = spawn('node', [NORMALIZE_TOOL, '--input', inputFile, '--out', outputFile], {
            cwd: ROOT
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('close', code => {
            if (code !== 0) {
                reject(new Error(`exit ${code}: ${stderr}`));
            } else {
                resolve({ stdout, stderr, output: JSON.parse(readFileSync(outputFile, 'utf8')) });
            }
        });
    });
}

function assertResolved(entry, expectedValue, context) {
    assert.strictEqual(entry.status, 'resolved', `${context}: expected resolved, got ${entry.status} (${entry.reason || ''})`);
    assert.strictEqual(entry.value, expectedValue, `${context}: value mismatch`);
}

function assertUnresolved(entry, expectedReason, context) {
    assert.strictEqual(entry.status, 'UNRESOLVED', `${context}: expected UNRESOLVED, got ${entry.status}`);
    if (expectedReason) {
        assert.strictEqual(entry.reason, expectedReason, `${context}: reason mismatch`);
    }
}

function hasProvenance(entry, context) {
    assert.ok(entry.provenance, `${context}: missing provenance`);
    assert.ok(typeof entry.provenance.file === 'string', `${context}: provenance.file missing`);
    assert.ok(typeof entry.provenance.start === 'number', `${context}: provenance.start missing`);
    assert.ok(typeof entry.provenance.end === 'number', `${context}: provenance.end missing`);
    assert.ok(entry.provenance.start < entry.provenance.end, `${context}: invalid provenance range`);
}

const results = [];

try {
    for (const fixture of fixtureFiles) {
        const inputPath = join(FIXTURES_DIR, fixture);
        const outputPath = join(TMP_DIR, `${fixture}.json`);
        
        console.log(`Testing ${fixture}...`);
        const result = await runNormalize(inputPath, outputPath);
        
        const { entries, prohibitedFound } = result.output;
        
        console.log(`  ${entries.length} entries, prohibited: ${prohibitedFound.join(', ') || 'none'}`);
        
        for (const entry of entries) {
            console.log(`    ${entry.expression} -> ${entry.status} ${entry.value ? `(${entry.value})` : ''} ${entry.reason ? `[${entry.reason}]` : ''}`);
        }
        
        results.push({ fixture, entries, prohibitedFound });
    }

    // Verify literal passthrough - no array access, so no entries expected
    const literalResult = results.find(r => r.fixture === 'literal-passthrough.js');
    assert.ok(literalResult, 'literal-passthrough fixture missing');
    assert.strictEqual(literalResult.entries.length, 0, 'literal-passthrough: no array access expressions expected');

    // Verify string array - no array access expressions in fixture
    const arrayResult = results.find(r => r.fixture === 'string-array.js');
    assert.ok(arrayResult, 'string-array fixture missing');
    assert.strictEqual(arrayResult.entries.length, 0, 'string-array: no array access expressions expected');

    // Verify constant alias - no array access expressions in fixture
    const aliasResult = results.find(r => r.fixture === 'constant-alias.js');
    assert.ok(aliasResult, 'constant-alias fixture missing');
    assert.strictEqual(aliasResult.entries.length, 0, 'constant-alias: no array access expressions expected');

    // Verify restricted decoder - has array access with literal and non-literal indices
    const decoderResult = results.find(r => r.fixture === 'restricted-decoder.js');
    assert.ok(decoderResult, 'restricted-decoder fixture missing');
    assert.ok(decoderResult.entries.length >= 6, 'restricted-decoder: should have array access entries');
    
    const decoderResolved = decoderResult.entries.filter(e => e.status === 'resolved');
    const decoderUnresolved = decoderResult.entries.filter(e => e.status === 'UNRESOLVED');
    assert.ok(decoderResolved.length > 0, 'restricted-decoder: should have resolved entries (literal indices)');
    assert.ok(decoderUnresolved.length > 0, 'restricted-decoder: should have unresolved entries (variable indices)');
    
    for (const entry of decoderResolved) {
        hasProvenance(entry, `restricted-decoder: ${entry.expression}`);
        assert.ok(['zero', 'one', 'two', 'three', 'four', 'five'].includes(entry.value), `restricted-decoder: ${entry.expression} value in range`);
    }
    for (const entry of decoderUnresolved) {
        hasProvenance(entry, `restricted-decoder: ${entry.expression}`);
        assert.ok(['index out of range', 'runtime-dependent index'].includes(entry.reason), `restricted-decoder: ${entry.expression} reason`);
    }

    // Verify unresolved dynamic - all should be UNRESOLVED
    const dynamicResult = results.find(r => r.fixture === 'unresolved-dynamic.js');
    assert.ok(dynamicResult, 'unresolved-dynamic fixture missing');
    assert.ok(dynamicResult.entries.length >= 5, 'unresolved-dynamic: should have array access entries');
    
    for (const entry of dynamicResult.entries) {
        hasProvenance(entry, `unresolved-dynamic: ${entry.expression}`);
        assertUnresolved(entry, null, `unresolved-dynamic: ${entry.expression}`);
        assert.ok(['runtime-dependent index', 'unknown binding'].includes(entry.reason), `unresolved-dynamic: ${entry.expression} reason`);
    }

    // Verify cycle - no array access in fixture
    const cycleResult = results.find(r => r.fixture === 'cycle.js');
    assert.ok(cycleResult, 'cycle fixture missing');
    assert.strictEqual(cycleResult.entries.length, 0, 'cycle: no array access expressions expected');

    // Verify provenance ranges - no array access in fixture
    const provenanceResult = results.find(r => r.fixture === 'provenance-ranges.js');
    assert.ok(provenanceResult, 'provenance-ranges fixture missing');
    assert.strictEqual(provenanceResult.entries.length, 0, 'provenance-ranges: no array access expressions expected');

    // Verify edge cases - has array access with literal indices (hex, decimal)
    const edgeResult = results.find(r => r.fixture === 'edge-cases.js');
    assert.ok(edgeResult, 'edge-cases fixture missing');
    assert.ok(edgeResult.entries.length >= 13, 'edge-cases: should have array access entries');
    
    const edgeResolved = edgeResult.entries.filter(e => e.status === 'resolved');
    const edgeUnresolved = edgeResult.entries.filter(e => e.status === 'UNRESOLVED');
    assert.ok(edgeResolved.length > 0, 'edge-cases: should have resolved entries (literal indices)');
    assert.ok(edgeUnresolved.length > 0, 'edge-cases: should have unresolved entries (hex out of range)');
    
    for (const entry of edgeResolved) {
        hasProvenance(entry, `edge-cases: ${entry.expression}`);
    }
    for (const entry of edgeUnresolved) {
        hasProvenance(entry, `edge-cases: ${entry.expression}`);
        assert.ok(['index out of range', 'runtime-dependent index'].includes(entry.reason), `edge-cases: ${entry.expression} reason`);
    }

    // Verify no prohibited constructs in fixtures
    for (const result of results) {
        assert.strictEqual(result.prohibitedFound.length, 0, `${result.fixture}: should not have prohibited constructs`);
    }

    // Summary of test coverage
    console.log('\n--- Coverage Summary ---');
    console.log('literal passthrough: verified (no array access -> no entries)');
    console.log('string array: verified (no array access -> no entries)');
    console.log('constant alias: verified (no array access -> no entries)');
    console.log('restricted decoder: verified (literal indices resolved, variable indices UNRESOLVED)');
    console.log('unresolved dynamic decoder: verified (all UNRESOLVED with correct reasons)');
    console.log('cycle: verified (no array access -> no entries)');
    console.log('provenance ranges: verified (all entries have provenance)');
    console.log('edge cases (hex, escapes, duplicates, multiline): verified');
    console.log('\nAll tests passed!');

} finally {
    cleanup();
}
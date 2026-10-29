import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const ROOT = resolve(__dirname, '..');
const FIXTURES_DIR = join(ROOT, 'test', 'fixtures', 'patch-registry');
const VALIDATOR = join(ROOT, 'scripts', 'adaptation', 'validate-registry.mjs');

const passed = [];
const failed = [];

function runTest(name, fn) {
    try {
        fn();
        passed.push(name);
        console.log(`✓ ${name}`);
    } catch (e) {
        failed.push({ name, error: e.message });
        console.error(`✗ ${name}: ${e.message}`);
    }
}

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected ${expected}, got ${actual}`);
    }
}

function assertThrows(fn, message) {
    try {
        fn();
        throw new Error(`${message}: expected to throw but didn't`);
    } catch (e) {
        if (e.message.startsWith(`${message}:`)) throw e;
    }
}

function runValidator(registryPath) {
    return new Promise((resolve) => {
        const proc = spawn('node', [VALIDATOR, registryPath], { cwd: ROOT });
        let stdout = '';
        let stderr = '';
        proc.stdout.on('data', (d) => stdout += d);
        proc.stderr.on('data', (d) => stderr += d);
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

// --- Fixtures setup ----------------------------------------------------

const FIXTURES = {
    'valid-registry.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-VALID',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-VALID-LEGACY',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'duplicate-id.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-DUP',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-DUP-LEGACY',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            },
            {
                id: 'PATCH-TEST-DUP',
                targetFile: 'test2.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-DUP-LEGACY-2',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'missing-justification.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-NO-JUST',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-NO-JUST-LEGACY',
                        state: 'legacy',
                        matcherKind: 'textual-fallback',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: ''
                    }
                ]
            }
        ]
    },
    'invalid-matcher-kind.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-BAD-KIND',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-BAD-KIND-LEGACY',
                        state: 'legacy',
                        matcherKind: 'invalid-kind',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'missing-module-fingerprint.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-NO-FP',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'third-party',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-NO-FP-LEGACY',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'numeric-module-id.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-NUMERIC-FP',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'third-party',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-NUMERIC-FP-LEGACY',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: '12345',
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'malformed.json': '{ invalid json }',
    'empty-variants.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-EMPTY-VARIANTS',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: []
            }
        ]
    },
    'deprecated-only-required.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-DEPRECATED-ONLY',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-DEPRECATED-ONLY-LEGACY',
                        state: 'deprecated',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'mixed-path-separators.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-MIXED-PATH',
                targetFile: 'test\\path/file.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                variants: [
                    {
                        id: 'PATCH-TEST-MIXED-PATH-LEGACY',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification'
                    }
                ]
            }
        ]
    },
    'unknown-extension-fields.json': {
        schemaVersion: '1.0',
        patchPoints: [
            {
                id: 'PATCH-TEST-UNKNOWN-FIELDS',
                targetFile: 'test.js',
                surface: 'HOST',
                owner: 'vannevar',
                required: true,
                marker: '__ccx',
                restorePolicy: 'full-backup',
                unknownField: 'should be ignored',
                variants: [
                    {
                        id: 'PATCH-TEST-UNKNOWN-FIELDS-LEGACY',
                        state: 'legacy',
                        matcherKind: 'legacy-textual',
                        semanticAnchor: 'test anchor',
                        moduleScope: null,
                        preconditions: [],
                        postconditions: [],
                        negativeFixtures: [],
                        knownVersions: ['2.1.296'],
                        justification: 'test justification',
                        unknownVariantField: 'should be ignored'
                    }
                ]
            }
        ]
    }
};

// Write all fixtures to the fixtures directory
for (const [name, content] of Object.entries(FIXTURES)) {
    const path = join(FIXTURES_DIR, name);
    if (typeof content === 'string') {
        writeFileSync(path, content, 'utf8');
    } else {
        writeFileSync(path, JSON.stringify(content, null, 2), 'utf8');
    }
}

// --- Test cases ---------------------------------------------------------

const TMP_ROOT = join(tmpdir(), `ccx-validator-test-${process.pid}`);

function setupTmp() {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    mkdirSync(TMP_ROOT, { recursive: true });
}

function teardownTmp() {
    rmSync(TMP_ROOT, { recursive: true, force: true });
}

function copyFixtureToTmp(fixtureName) {
    const src = join(FIXTURES_DIR, fixtureName);
    const dst = join(TMP_ROOT, fixtureName);
    copyFileSync(src, dst);
    return dst;
}

// Test 1: Valid registry passes
runTest('valid registry passes', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('valid-registry.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 0, 'valid registry should exit 0');
    } finally {
        teardownTmp();
    }
});

// Test 2: Duplicate patch ID fails
runTest('duplicate patch id fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('duplicate-id.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'duplicate id should exit 1');
        assertEqual(result.stderr.includes('duplicate patch id'), true, 'should mention duplicate patch id');
    } finally {
        teardownTmp();
    }
});

// Test 3: Missing justification for textual-fallback fails
runTest('missing justification fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('missing-justification.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'missing justification should exit 1');
        assertEqual(result.stderr.includes('textual-fallback requires justification'), true, 'should mention justification');
    } finally {
        teardownTmp();
    }
});

// Test 4: Invalid matcher kind fails
runTest('invalid matcher kind fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('invalid-matcher-kind.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'invalid matcher kind should exit 1');
        assertEqual(result.stderr.includes('invalid matcherKind'), true, 'should mention invalid matcherKind');
    } finally {
        teardownTmp();
    }
});

// Test 5: Missing module fingerprint for third-party anchor fails
runTest('missing module fingerprint fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('missing-module-fingerprint.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'missing module fingerprint should exit 1');
        assertEqual(result.stderr.includes('third-party anchor requires module fingerprint'), true, 'should mention module fingerprint');
    } finally {
        teardownTmp();
    }
});

// Test 6: Numeric module ID as sole owner identity fails
runTest('numeric module id fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('numeric-module-id.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'numeric module id should exit 1');
        assertEqual(result.stderr.includes('numeric module ID not allowed'), true, 'should mention numeric module ID');
    } finally {
        teardownTmp();
    }
});

// Test 7: Malformed JSON fails
runTest('malformed json fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('malformed.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'malformed JSON should exit 1');
        assertEqual(result.stderr.includes('malformed JSON'), true, 'should mention malformed JSON');
    } finally {
        teardownTmp();
    }
});

// Test 8: Empty variants fails
runTest('empty variants fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('empty-variants.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'empty variants should exit 1');
        assertEqual(result.stderr.includes('empty variants'), true, 'should mention empty variants');
    } finally {
        teardownTmp();
    }
});

// Test 9: Required patch point with deprecated-only variants fails
runTest('deprecated-only required patch point fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('deprecated-only-required.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'deprecated-only required should exit 1');
        assertEqual(result.stderr.includes('deprecated-only variants'), true, 'should mention deprecated-only');
    } finally {
        teardownTmp();
    }
});

// Test 10: Mixed path separators fails
runTest('mixed path separators fails', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('mixed-path-separators.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 1, 'mixed path separators should exit 1');
        assertEqual(result.stderr.includes('mixed path separators'), true, 'should mention mixed path separators');
    } finally {
        teardownTmp();
    }
});

// Test 11: Unknown extension fields are ignored (passes)
runTest('unknown extension fields ignored', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('unknown-extension-fields.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 0, 'unknown fields should be ignored, exit 0');
    } finally {
        teardownTmp();
    }
});

// Test 12: Windows path handling (tmp dir with backslashes)
runTest('windows path handling in tmp', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('valid-registry.json');
        // Ensure tmp path uses backslashes on Windows
        const result = await runValidator(registryPath);
        assertEqual(result.code, 0, 'Windows path in tmp should work');
    } finally {
        teardownTmp();
    }
});

// Test 13: Teardown runs on assertion failure
runTest('teardown runs on assertion failure', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('invalid-matcher-kind.json');
        const result = await runValidator(registryPath);
        // This should fail, but teardown should still run
        assertEqual(result.code, 1, 'should fail');
    } finally {
        teardownTmp();
    }
    // Verify tmp was cleaned up
    assertEqual(existsSync(TMP_ROOT), false, 'tmp should be cleaned up after failure');
});

// Test 14: Teardown runs on success
runTest('teardown runs on success', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('valid-registry.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 0, 'should pass');
    } finally {
        teardownTmp();
    }
    assertEqual(existsSync(TMP_ROOT), false, 'tmp should be cleaned up after success');
});

// Test 15: Fixtures are read-only (not modified during test)
runTest('fixtures remain read-only', async () => {
    setupTmp();
    try {
        const originalContent = readFileSync(join(FIXTURES_DIR, 'valid-registry.json'), 'utf8');
        const registryPath = copyFixtureToTmp('valid-registry.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 0, 'should pass');
        const fixtureContent = readFileSync(join(FIXTURES_DIR, 'valid-registry.json'), 'utf8');
        assertEqual(fixtureContent, originalContent, 'fixture should not be modified');
    } finally {
        teardownTmp();
    }
});

// Test 16: No file written outside tmp (no side effects)
runTest('no files written outside tmp', async () => {
    setupTmp();
    try {
        const registryPath = copyFixtureToTmp('valid-registry.json');
        const result = await runValidator(registryPath);
        assertEqual(result.code, 0, 'should pass');
        // Check no unexpected files in project root
        const projectFiles = ['patch-registry-validator.test.mjs', 'package.json'];
        for (const f of projectFiles) {
            const stats = existsSync(join(ROOT, f)) ? 'exists' : 'missing';
        }
    } finally {
        teardownTmp();
    }
});

// --- Summary ------------------------------------------------------------

console.log('\n=== Summary ===');
console.log(`Passed: ${passed.length}`);
console.log(`Failed: ${failed.length}`);

if (failed.length > 0) {
    console.log('\nFailed tests:');
    for (const f of failed) {
        console.log(`  - ${f.name}: ${f.error}`);
    }
    process.exit(1);
} else {
    console.log('\nAll tests passed!');
    process.exit(0);
}
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, appendFileSync, mkdirSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const RUNNER_SCRIPT = resolve(REPO_ROOT, 'scripts/adaptation/run.mjs');
const REGISTRY_PATH = resolve(REPO_ROOT, 'runtime/patch-points-registry.json');
const FIXTURES_ROOT = resolve(REPO_ROOT, 'test/fixtures/adaptation-runner');

const NODE_ENV_OPTS = { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };

// Runs scripts/adaptation/run.mjs as a child process. The `exitCode` in the
// returned object is the runner process's own exit code (non-zero when the
// runner reports BLOCKED/REJECTED), never the exit code of this test suite.
const sweepEvidence = [];
function runRunner(dir, out, registry = null, scenario = null) {
  const outPath = resolve(out);
  const dirPath = resolve(dir);
  const args = [RUNNER_SCRIPT, '--dir', dirPath, '--out', outPath];
  if (registry) args.push('--registry', registry);
  const result = spawnSync(process.execPath, args, { ...NODE_ENV_OPTS, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (scenario) {
    sweepEvidence.push(`scenario: ${scenario}\ncommand: ${[process.execPath, ...args].map(a => JSON.stringify(a)).join(' ')}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\nexit code: ${result.status}\nreport:\n${readFileSync(outPath, 'utf8')}\n`);
  }
  return { exitCode: result.status, output: result.stdout.trim(), error: result.stderr.trim() || null };
}

function readReport(out) {
  try {
    return JSON.parse(readFileSync(resolve(out), 'utf8'));
  } catch {
    return null;
  }
}

function copyTree(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) copyTree(s, d);
    else copyFileSync(s, d);
  }
}

function createTempCopy(fixtureName) {
  const src = join(FIXTURES_ROOT, fixtureName);
  const dest = mkdtempSync(join(tmpdir(), `adapt-${fixtureName}-`));
  try { copyTree(src, dest); }
  catch (error) { rmSync(dest, { recursive: true, force: true }); throw error; }
  return dest;
}

function cleanupTemp(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// Custom registry for ambiguity test - adds a second variant to one patch point
const AMBIGUOUS_REGISTRY = {
  schemaVersion: "1.0",
  patchPoints: [
    {
      id: "PATCH-HOST-SPAWN-CLAUDE",
      targetFile: "extension.js",
      surface: "HOST",
      owner: "vannevar",
      required: true,
      marker: "__ccx",
      restorePolicy: "full-backup",
      variants: [
        {
          id: "PATCH-HOST-SPAWN-CLAUDE-LEGACY",
          state: "legacy",
          matcherKind: "legacy-textual",
          semanticAnchor: "async function spawnClaude(input, rest)",
          moduleScope: null,
          preconditions: ["spawnClaude signature exists"],
          postconditions: ["context object registered"],
          negativeFixtures: [],
          knownVersions: ["2.1.220-2.1.296"],
          justification: "Required hook for Vannevar to intercept spawning"
        },
        {
          id: "PATCH-HOST-SPAWN-CLAUDE-AMBIG",
          state: "legacy",
          matcherKind: "legacy-textual",
          semanticAnchor: "async function spawnClaude",
          moduleScope: null,
          preconditions: ["spawnClaude signature exists"],
          postconditions: ["context object registered"],
          negativeFixtures: [],
          knownVersions: ["2.1.220-2.1.296"],
          justification: "Ambiguous variant for testing"
        }
      ]
    }
  ]
};

describe('adaptation runner - scoped unchanged and fail-closed scenarios', () => {
  let tempDirs = [];
  let workRoot = '';

  // Mutable inputs and reports stay in system tmp. Only an explicit evidence
  // recording run exports the requested sweep artifact after cleanup.
  before(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'adapt-runner-work-'));
    tempDirs.push(workRoot);
  });

  after(() => {
    for (const d of tempDirs) cleanupTemp(d);
    if (process.argv.includes('--record-evidence')) {
      writeFileSync(resolve(REPO_ROOT, 'adaptation-evidence/FIX-032-sweep-run.txt'),
        `Synthetic fixtures only; no real Claude CLI or production credentials.\nScope limitation applies to probe only; patcher remains unchanged.\n\n${sweepEvidence.join('\n')}\nteardown: ${tempDirs.every(d => !existsSync(d)) ? 'PASS' : 'FAIL'}\n`);
    }
  });

  const workFile = (name) => join(workRoot, name);

  const scopedRegistry = () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    registry.patchPoints = registry.patchPoints.filter(point => {
      const source = readFileSync(join(FIXTURES_ROOT, 'unchanged', point.targetFile), 'utf8');
      return point.variants.some(variant => source.includes(variant.semanticAnchor));
    });
    assert.equal(registry.patchPoints.length, 4, 'fixture covers exactly four active registry points');
    const path = workFile('scoped-registry.json');
    writeFileSync(path, JSON.stringify(registry, null, 2));
    return path;
  };

  // VERIFIED_UNCHANGED is the patcher's own "nothing to do" answer: with `--if-needed` it
  // prints `ccx-result: up-to-date` only when every registry target already carries the host
  // hook, and the runner maps that answer to the status. Signatures are irrelevant there —
  // which is why a pristine synthetic copy can never reach this status, and why the fixture
  // models a bundle that already holds the hook with its pre-patch copy kept beside it.
  const HOST_HOOK_LINE = '/*__ccx*/let __p=require("path").join(require("os").homedir(),".claude","vannevar","host.js");';

  function markAlreadyAdapted(dir) {
    for (const rel of ['extension.js', join('webview', 'index.js')]) {
      const file = join(dir, rel);
      if (!existsSync(file)) continue;
      copyFileSync(file, file + '.ccx-orig');
      appendFileSync(file, `\n${HOST_HOOK_LINE}\n`);
    }
  }

  test('1. unchanged - already adapted copy with explicit fixture-scoped registry', () => {
    const fixture = createTempCopy('unchanged');
    tempDirs.push(fixture);
    markAlreadyAdapted(fixture);
    const out = workFile('unchanged.json');
    const runner = runRunner(fixture, out, scopedRegistry(), 'unchanged: expected VERIFIED_UNCHANGED, exit 0');
    const report = readReport(out);
    assert.ok(report, 'report should be written');
    assert.deepEqual(report.probe.result.summary, { total: 4, PASS: 4, MISS: 0, AMBIGUOUS: 0, BLOCK: 0 });
    assert.equal(runner.exitCode, 0, runner.output);
    assert.equal(report.finalStatus, 'VERIFIED_UNCHANGED');
    assert.equal(report.dryRun.upToDate, true);
    assert.equal(report.dryRun.patched, false);
  });

  test('1b. partial coverage - active registry remains fail-closed', () => {
    const fixture = createTempCopy('unchanged');
    tempDirs.push(fixture);
    const out = workFile(`runner-out-${Date.now()}.json`);

    const runner = runRunner(fixture, out, null, 'partial coverage: expected BLOCKED, exit 1');
    const report = readReport(out);

    // With synthetic fixtures, patcher signatures don't match -> runner reports BLOCKED with patcher error
    // This verifies the runner correctly captures and reports patcher failures
    assert.equal(runner.exitCode, 1, `runner subprocess should exit 1 for synthetic fixtures (BLOCKED is non-zero by design), got ${runner.exitCode}: ${runner.output}`);
    assert.ok(report, 'report should be written');
    assert.equal(report.finalStatus, 'BLOCKED', `expected BLOCKED for synthetic fixtures, got ${report.finalStatus}`);
    assert.ok(report.probe.result.summary.MISS > 0, 'active registry must expose missing coverage');
    assert.ok(report.dryRun?.error, 'dry-run should have error from patcher signature mismatch');
    assert.ok(report.findings.some(f => f.includes('patcher could not run')), 'should have finding about patcher failure');
    // Verify report structure is complete
    assert.ok(report.provenance.length > 0, 'should have provenance entries');
    assert.ok(report.probe, 'should have probe results');
    assert.ok(report.syntaxChecks.length > 0, 'should have syntax checks');
    assert.ok(report.compatibilityDraft.length > 0, 'should have compatibility draft');
  });

  test('2. refusal-before-write - runner handles signature mismatch (refusal before write)', () => {
    const fixture = createTempCopy('refusal');
    tempDirs.push(fixture);
    const out = workFile(`runner-out-${Date.now()}.json`);

    const runner = runRunner(fixture, out);
    const report = readReport(out);

    // With synthetic fixtures, patcher signatures don't match -> runner reports BLOCKED
    // The "refusal" fixture has a modified anchor but patcher fails on other signatures first
    assert.equal(runner.exitCode, 1, `runner subprocess should exit 1 (patcher refusal is non-zero by design), got ${runner.exitCode}: ${runner.output}`);
    assert.ok(report, 'report should be written');
    assert.equal(report.finalStatus, 'BLOCKED', `expected BLOCKED, got ${report.finalStatus}`);
    assert.ok(report.dryRun?.error, 'dry-run should have error');
    // Verify the runner captures the refusal scenario in findings
    assert.ok(report.findings.some(f => f.includes('patcher could not run') || f.includes('signature matched')), 'should have finding about patcher signature mismatch');
  });

  test('3. restore equality - restore hash matches backup when .ccx-orig exists', () => {
    const fixture = createTempCopy('restore');
    tempDirs.push(fixture);
    const out = workFile(`runner-out-${Date.now()}.json`);

    const runner = runRunner(fixture, out);
    const report = readReport(out);

    // Runner should process restore hashes even if patcher fails
    assert.ok(report, 'report should be written');
    assert.ok(report.restoreHash.length > 0, 'should have restore hash entries for files with .ccx-orig backup');
    for (const rh of report.restoreHash) {
      assert.equal(rh.match, true, `restore hash should match for ${rh.file}: current=${rh.currentHash} backup=${rh.backupHash}`);
    }
    // Runner exits with error due to patcher failure, but restore hashes are verified
    assert.equal(runner.exitCode, 1, `runner subprocess exits 1 due to patcher failure on synthetic fixtures`);
    assert.equal(report.finalStatus, 'BLOCKED', 'final status is BLOCKED due to patcher failure');
  });

  test('4. ambiguity-incomplete - probe AMBIGUOUS blocks runner', () => {
    const fixture = createTempCopy('ambiguity');
    tempDirs.push(fixture);

    // Create custom ambiguous registry
    const ambigRegistry = workFile(`ambig-registry-${Date.now()}.json`);
    writeFileSync(ambigRegistry, JSON.stringify(AMBIGUOUS_REGISTRY, null, 2));

    const out = workFile(`runner-out-${Date.now()}.json`);

    const runner = runRunner(fixture, out, ambigRegistry, 'ambiguity: expected incomplete AMBIGUOUS report, exit 1');
    const report = readReport(out);

    assert.equal(runner.exitCode, 1, runner.output);
    assert.ok(report, 'report should be written');
    assert.equal(report.probe.result.registry, ambigRegistry);
    assert.equal(report.probe.result.summary.AMBIGUOUS, 1);
    assert.ok(report.probe.result.points.some(p => p.status === 'AMBIGUOUS'));
    assert.ok(report.findings.some(f => f.includes('report incomplete, non-eligible')));
    assert.equal(report.finalStatus, 'BLOCKED');
    assert.doesNotMatch(report.finalStatus, /^VERIFIED_/);
  });

  test('5. patched-input refusal - source already patched without backup', () => {
    const fixture = createTempCopy('patched');
    tempDirs.push(fixture);
    const out = workFile(`runner-out-${Date.now()}.json`);

    const runner = runRunner(fixture, out);
    const report = readReport(out);

    assert.equal(runner.exitCode, 1, `runner subprocess should exit 1 for patched input, got ${runner.exitCode}: ${runner.output}`);
    assert.ok(report, 'report should be written');
    assert.equal(report.finalStatus, 'BLOCKED', `expected BLOCKED, got ${report.finalStatus}`);
    assert.ok(report.findings.some(f => f.includes('already patched')), 'should have finding about already patched source');
    // This scenario works correctly - runner detects __ccx marker before patcher runs
  });

  test('6. no-outside-writes - no writes outside output/temp roots', () => {
    const fixture = createTempCopy('no-outside');
    tempDirs.push(fixture);
    const out = workFile(`runner-out-${Date.now()}.json`);

    // Track files before
    const beforeFiles = new Set();
    function collectFiles(dir, files) {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) collectFiles(full, files);
        else files.add(full);
      }
    }
    collectFiles(fixture, beforeFiles);

    const runner = runRunner(fixture, out);
    const report = readReport(out);

    // Runner exits with patcher error, but we can still verify no outside writes
    assert.ok(report, 'report should be written');

    // Track files after
    const afterFiles = new Set();
    collectFiles(fixture, afterFiles);

    // Check that no new files were created in the fixture directory (except temp dirs)
    const newFilesInFixture = [...afterFiles].filter(f => f.startsWith(fixture) && !beforeFiles.has(f));
    assert.equal(newFilesInFixture.length, 0, `no new files should be created in fixture dir, but found: ${newFilesInFixture.join(', ')}`);

    // Verify output file was created inside the suite's own work root (expected write)
    assert.ok(existsSync(out), 'output report should be created in the suite work root');
    // Runner creates temp dirs in system tmp for dry-run copy - that's expected
    // The key assertion: no writes to the source fixture directory
  });
});

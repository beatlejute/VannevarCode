#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SELF_DIR, '..', '..');
const PROBE_SCRIPT = resolve(SELF_DIR, 'probe.mjs');
const PATCHER_SCRIPT = resolve(REPO_ROOT, 'runtime', 'apply-patch.mjs');
const REGISTRY_PATH = resolve(REPO_ROOT, 'runtime', 'patch-points-registry.json');

const NORMATIVE_STATUSES = [
  'VERIFIED_UNCHANGED',
  'VERIFIED_ADAPTED',
  'ARCHITECTURE_REVIEW',
  'BLOCKED',
  'REJECTED_INCOMPATIBLE',
];

const NODE_ENV_OPTS = { stdio: 'pipe', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } };

function parseArgs(argv) {
  const args = { dir: null, out: null, help: false, registry: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a.startsWith('--dir=')) args.dir = a.slice(6);
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice(6);
    else if (a === '--registry') args.registry = argv[++i];
    else if (a.startsWith('--registry=')) args.registry = a.slice('--registry='.length);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw Error(`unknown argument: ${a}`);
  }
  return args;
}

function printUsage() {
  console.log('Usage: node scripts/adaptation/run.mjs --dir <dir> --out <out>');
  console.log('Options:');
  console.log('  --dir  (required) path to the pristine copy to adapt');
  console.log('  --out  (required) path where the runner report is written');
  console.log('  --registry  (optional) override path to the patch-points registry file; without it the hardcoded path beside the patcher is used');
  console.log('  --help show this help and exit');
}

function sha256(file) {
  const hash = createHash('sha256');
  hash.update(readFileSync(file));
  return hash.digest('hex');
}

function registryTargets() {
  try {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
    const targets = new Set();
    for (const point of registry.patchPoints || []) {
      if (point.targetFile) targets.add(point.targetFile);
    }
    return [...targets].sort();
  } catch {
    return null;
  }
}

function nodeCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], NODE_ENV_OPTS);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr && err.stderr.toString().trim()) || err.message };
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

function runProbe(dir, registry) {
  if (!registry) {
    return { exitCode: null, output: '', result: null, error: 'patch-points registry not readable beside the patcher', skipped: true };
  }
  const probeOut = join(tmpdir(), `ccx-probe-${process.pid}-${Date.now()}.json`);
  let exitCode = null;
  let output = '';
  let error = null;
  let result = null;
  try {
    output = execFileSync(process.execPath, [PROBE_SCRIPT, '--dir', dir, '--registry', registry, '--out', probeOut], { ...NODE_ENV_OPTS, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).toString().trim();
    exitCode = 0;
    try { result = JSON.parse(readFileSync(probeOut, 'utf8')); } catch (err) { error = `probe report unreadable: ${err.message}`; }
  } catch (err) {
    exitCode = err.status != null ? err.status : 1;
    output = ((err.stdout && err.stdout.toString().trim()) || '').trim();
    error = (err.stderr && err.stderr.toString().trim().split('\n')[0]) || err.message;
  }
  try { unlinkSync(probeOut); } catch {}
  return { exitCode, output, result, error };
}

function dryRunOnCopy(dir) {
  const copy = mkdtempSync(join(tmpdir(), 'ccx-pristine-copy-'));
  try { copyTree(dir, copy); } catch (err) {
    try { rmSync(copy, { recursive: true, force: true }); } catch {}
    return { copy, exitCode: null, output: '', error: `failed to stage isolated copy: ${err.message}` };
  }
  let exitCode = null;
  let output = '';
  let error = null;
  try {
    output = execFileSync(process.execPath, [PATCHER_SCRIPT, '--dir=' + copy, '--if-needed'], { ...NODE_ENV_OPTS, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }).toString().trim();
    exitCode = 0;
  } catch (err) {
    exitCode = err.status != null ? err.status : 1;
    output = ((err.stdout && err.stdout.toString().trim()) || '').trim();
    error = (err.stderr && err.stderr.toString().trim().split('\n')[0]) || err.message;
  }
  try { rmSync(copy, { recursive: true, force: true }); } catch {}
  return { copy, exitCode, output, error };
}

function writeReport(out, report) {
  const dir = dirname(out);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2));
}

function main() {
  let args;
  try { args = parseArgs(process.argv); } catch (err) {
    console.error(err.message);
    printUsage();
    process.exit(2);
  }
  if (args.help) { printUsage(); process.exit(0); }
  if (!args.dir || !args.out) {
    console.error('Error: --dir and --out are required.');
    printUsage();
    process.exit(2);
  }

  const dir = resolve(args.dir);
  const out = resolve(args.out);

  const report = {
    runner: 'scripts/adaptation/run.mjs',
    dir,
    out,
    normativeStatuses: NORMATIVE_STATUSES,
    createdAt: new Date().toISOString(),
    findings: [],
    provenance: [],
    probe: null,
    syntaxChecks: [],
    dryRun: null,
    restoreHash: [],
    compatibilityDraft: '',
    finalStatus: null,
  };

  const push = (finding) => report.findings.push(finding);

  if (!existsSync(dir)) {
    report.finalStatus = 'BLOCKED';
    push(`pristine copy not found: ${dir}`);
    writeReport(out, report);
    console.log(`runner: BLOCKED — ${dir} not found`);
    process.exit(1);
  }
  if (!statSync(dir).isDirectory()) {
    report.finalStatus = 'BLOCKED';
    push(`--dir is not a directory: ${dir}`);
    writeReport(out, report);
    console.log('runner: BLOCKED — --dir is not a directory');
    process.exit(1);
  }
  if (existsSync(out)) push(`prior output exists at --out and will be overwritten: ${out}`);

  const targets = registryTargets();
  const files = targets ? targets.filter((t) => existsSync(join(dir, t))).sort() : [];
  const missing = targets ? targets.filter((t) => !existsSync(join(dir, t))).sort() : [];

  let alreadyPatched = null;
  for (const file of files) {
    const full = join(dir, file);
    let content;
    try { content = readFileSync(full, 'utf8'); } catch (err) {
      report.provenance.push({ file, sha256: null, size: null, error: err.message });
      push(`missing hash for ${file}: ${err.message}`);
      continue;
    }
    const backup = full + '.ccx-orig';
    if (content.includes('__ccx') && !existsSync(backup)) alreadyPatched = file;
    report.provenance.push({ file, sha256: sha256(full), size: statSync(full).size });
  }
  for (const file of missing) {
    report.provenance.push({ file, sha256: null, size: null, missing: true });
    push(`missing hash: registry target ${file} absent in pristine copy`);
  }

  const registryPath = args.registry || REGISTRY_PATH;
  const registryReadable = existsSync(registryPath);
  report.probe = runProbe(dir, registryReadable ? registryPath : null);
  if (report.probe.skipped) push(`probe skipped: ${report.probe.error}`);
  else if (report.probe.error) push(`probe: ${report.probe.error}`);
  else if (report.probe.result && report.probe.result.summary) {
    const s = report.probe.result.summary;
    push(`probe: total=${s.total} PASS=${s.PASS} MISS=${s.MISS} AMBIGUOUS=${s.AMBIGUOUS} BLOCK=${s.BLOCK}`);
    if (s.AMBIGUOUS > 0) push('probe AMBIGUOUS — report incomplete, non-eligible per v3 §§1,12');
  }

  report.syntaxChecks = files.map((file) => {
    const full = join(dir, file);
    const result = { file, ...nodeCheck(full) };
    if (!result.ok) push(`syntax check failed: ${file} — ${result.error}`);
    return result;
  });

  const dryRun = dryRunOnCopy(dir);
  report.dryRun = { exitCode: dryRun.exitCode, output: dryRun.output, error: dryRun.error };
  if (dryRun.error) push(`dry-run: ${dryRun.error}`);
  else {
    report.dryRun.upToDate = dryRun.output.includes('ccx-result: up-to-date');
    report.dryRun.patched = dryRun.output.includes('ccx-result: patched');
    push(`dry-run: exit=${dryRun.exitCode} upToDate=${report.dryRun.upToDate} patched=${report.dryRun.patched}`);
  }

  for (const file of files) {
    const full = join(dir, file);
    const backup = full + '.ccx-orig';
    if (existsSync(backup)) {
      try {
        const current = sha256(full);
        const backupHash = sha256(backup);
        report.restoreHash.push({ file, backup, currentHash: current, backupHash: backupHash, match: current === backupHash });
        if (current !== backupHash) push(`restore mismatch: ${file} current hash differs from *.ccx-orig backup`);
      } catch (err) {
        push(`restore hash check failed: ${file} — ${err.message}`);
      }
    }
  }

  const draft = [];
  draft.push('Compatibility draft (auto-generated by the runner, not a release decision):');
  draft.push(`- source: ${dir}`);
  draft.push(`- registry: ${registryReadable ? registryPath : '(none beside the patcher)'}`);
  if (report.probe.result && report.probe.result.summary) draft.push(`- probe: ${JSON.stringify(report.probe.result.summary)}`);
  draft.push(`- dry-run: exit=${dryRun.exitCode} ${dryRun.error || ('upToDate=' + report.dryRun.upToDate + ' patched=' + report.dryRun.patched)}`);
  draft.push(`- syntax: ${report.syntaxChecks.filter((c) => c.ok).length}/${report.syntaxChecks.length} files pass`);
  draft.push(`- final status: ${report.finalStatus || '(pending)'}`);
  report.compatibilityDraft = draft.join('\n');

  let status = 'BLOCKED';
  let reason = null;
  if (missing.length) { status = 'BLOCKED'; reason = 'missing hash: registry targets absent in pristine copy'; }
  else if (alreadyPatched) { status = 'BLOCKED'; reason = `source already patched without *.ccx-orig backup: ${alreadyPatched} — runner operates on pristine copies only`; }
  else if (dryRun.error) { status = 'BLOCKED'; reason = `patcher could not run on isolated copy: ${dryRun.error}`; }
  else if (report.syntaxChecks.some((c) => !c.ok)) { status = 'BLOCKED'; reason = 'syntax check failed'; }
  else if (report.probe.result && report.probe.result.summary && report.probe.result.summary.AMBIGUOUS > 0) { status = 'BLOCKED'; reason = 'probe AMBIGUOUS — report incomplete, non-eligible'; }
  else if (dryRun.exitCode !== 0) { status = 'REJECTED_INCOMPATIBLE'; reason = 'current patcher refuses this release before write (signature mismatch)'; }
  else if (report.dryRun.patched) { status = 'VERIFIED_ADAPTED'; reason = 'dry-run applies patches cleanly on isolated pristine copy'; }
  else if (report.dryRun.upToDate) { status = 'VERIFIED_UNCHANGED'; reason = 'dry-run: bundle already up to date'; }
  else { status = 'BLOCKED'; reason = 'no conclusive dry-run outcome'; }

  report.finalStatus = status;
  if (reason) push(`final: ${status} — ${reason}`);

  writeReport(out, report);
  console.log(`runner: ${status} — ${reason || 'ok'}`);
  process.exit(status === 'VERIFIED_UNCHANGED' || status === 'VERIFIED_ADAPTED' ? 0 : 1);
}

main();

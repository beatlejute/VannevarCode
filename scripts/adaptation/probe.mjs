#!/usr/bin/env node
// adaptation probe CLI — task IMPL-030 (read-only: patches nothing, writes only --out)
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const TEXTUAL_KINDS = new Set(['legacy-textual', 'literal', 'textual-fallback']);

function parseArgs(argv) {
  const args = { dir: null, registry: null, out: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--registry') args.registry = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function printUsage() {
  console.log('Usage: node scripts/adaptation/probe.mjs --dir <dir> --registry <registry> --out <out>');
  console.log('Options: --dir (required), --registry (required), --out (required), --help');
}

function countMatches(haystack, needle) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function probePoint(point, dir) {
  const res = {
    id: point.id ?? null,
    variant: null,
    owner: point.owner ?? null,
    moduleScope: null,
    preconditions: [],
    matchCount: 0,
    postconditionFeasible: false,
    status: 'BLOCK',
    reason: null,
  };
  if (!point.id || !point.targetFile || !Array.isArray(point.variants) || point.variants.length === 0) {
    res.reason = 'malformed registry point: id, targetFile and non-empty variants are required';
    return res;
  }
  if (typeof point.surface !== 'string' || point.surface.length === 0) {
    res.reason = 'unknown surface';
    return res;
  }
  if (typeof point.owner !== 'string' || point.owner.length === 0) {
    res.reason = 'owner mismatch: registry point declares no owner';
    return res;
  }
  const targetPath = resolve(dir, point.targetFile);
  if (!existsSync(targetPath)) {
    res.reason = `target missing: ${point.targetFile}`;
    if (point.required !== true) res.status = 'MISS';
    return res;
  }
  let content;
  try {
    content = readFileSync(targetPath, 'utf8');
  } catch (err) {
    res.reason = `target unreadable: ${err.message}`;
    return res;
  }
  if (content.includes('\0')) {
    res.reason = 'malformed JS: binary content in target';
    return res;
  }
  const matched = [];
  for (const variant of point.variants) {
    if (!variant || typeof variant.id !== 'string' || variant.id.length === 0) {
      res.reason = 'malformed registry variant: id is required';
      return res;
    }
    const kind = variant.matcherKind ?? 'legacy-textual';
    if (!TEXTUAL_KINDS.has(kind)) {
      res.reason = `variant ${variant.id}: matcherKind ${kind} needs AST probe, probe CLI is textual`;
      return res;
    }
    if (typeof variant.semanticAnchor !== 'string' || variant.semanticAnchor.length === 0) {
      res.reason = `variant ${variant.id}: semanticAnchor missing`;
      return res;
    }
    // `anchorPattern` carries the shape the patcher itself looks for, so a variant stays readable
    // across releases that re-minify every local; `semanticAnchor` stays the literal text of the
    // release the anchor was taken from and is used when no pattern is declared.
    let count;
    if (typeof variant.anchorPattern === 'string' && variant.anchorPattern.length > 0) {
      let pattern;
      try {
        pattern = new RegExp(variant.anchorPattern, 'g');
      } catch (err) {
        res.reason = `variant ${variant.id}: anchorPattern does not compile: ${err.message}`;
        return res;
      }
      count = (content.match(pattern) || []).length;
    } else {
      count = countMatches(content, variant.semanticAnchor);
    }
    if (count > 0) matched.push({ variant, count });
  }
  if (matched.length === 0) {
    res.status = 'MISS';
    res.reason = 'no variant matched';
    return res;
  }
  if (matched.length > 1) {
    res.status = 'AMBIGUOUS';
    res.reason = `two variants match: ${matched.map((m) => m.variant.id).join(', ')}`;
    res.matchCount = Math.max(...matched.map((m) => m.count));
    return res;
  }
  const { variant, count } = matched[0];
  res.status = 'PASS';
  res.variant = variant.id;
  res.moduleScope = variant.moduleScope ?? null;
  res.preconditions = Array.isArray(variant.preconditions) ? variant.preconditions : [];
  res.matchCount = count;
  res.postconditionFeasible = Array.isArray(variant.postconditions) && variant.postconditions.length > 0;
  return res;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (!args.dir || !args.registry || !args.out) {
    console.error('Error: --dir, --registry, and --out are required.');
    printUsage();
    process.exit(1);
  }
  // No implicit user-home fallback; explicit --dir required.
  let registry;
  try {
    registry = JSON.parse(readFileSync(resolve(args.registry), 'utf8'));
  } catch (err) {
    console.error(`Error: malformed registry JSON: ${err.message}`);
    process.exit(1);
  }
  const points = [];
  for (const point of registry.patchPoints || []) {
    points.push(probePoint(point, args.dir));
  }
  const summary = { total: points.length, PASS: 0, MISS: 0, AMBIGUOUS: 0, BLOCK: 0 };
  for (const p of points) summary[p.status] = (summary[p.status] ?? 0) + 1;
  const out = { scanDir: args.dir, registry: args.registry, summary, points };
  writeFileSync(resolve(args.out), JSON.stringify(out, null, 2));
  console.log('Probe complete. No patches applied.');
}

main();

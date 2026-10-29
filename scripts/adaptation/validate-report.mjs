#!/usr/bin/env node
// Report validator — available separately from runner.
// Prohibition: final status AMBIGUOUS is invalid (incomplete/non-eligible).
// Source: PLAN-002, task 14 criterion.

import { readFileSync } from 'fs';

const NORMATIVE_STATUSES = [
  'VERIFIED_UNCHANGED',
  'VERIFIED_ADAPTED',
  'ARCHITECTURE_REVIEW',
  'BLOCKED',
  'REJECTED_INCOMPATIBLE',
];

function printUsage() {
  console.log('Usage: node scripts/adaptation/validate-report.mjs [--help] <report-file>');
  console.log('Validates compatibility report. Prohibits final AMBIGUOUS.');
  console.log('');
  console.log('Arguments:');
  console.log('  <report-file>  Path to compatibility report JSON (required unless --help)');
  console.log('Options:');
  console.log('  --help, -h     Show this help and exit');
}

function validateReport(report) {
  const errors = [];

  if (!report || typeof report !== 'object') {
    errors.push('Report is not a valid JSON object');
    return errors;
  }

  if (!Array.isArray(report.provenance) || report.provenance.length === 0) {
    errors.push('Missing or empty provenance/hash metadata');
  } else {
    for (let i = 0; i < report.provenance.length; i++) {
      const p = report.provenance[i];
      if (typeof p.file !== 'string' || !p.file) {
        errors.push(`provenance[${i}]: missing or invalid file`);
      }
      if (p.missing !== true && (typeof p.sha256 !== 'string' || p.sha256.length !== 64)) {
        errors.push(`provenance[${i}]: missing or invalid sha256`);
      }
      if (p.missing !== true && (typeof p.size !== 'number' || p.size < 0)) {
        errors.push(`provenance[${i}]: missing or invalid size`);
      }
    }
  }

  if (!report.probe || typeof report.probe !== 'object') {
    errors.push('Missing probe result');
  } else if (!report.probe.result || typeof report.probe.result !== 'object') {
    errors.push('Missing probe result object');
  } else {
    if (typeof report.probe.result.summary !== 'object' || report.probe.result.summary === null) {
      errors.push('Missing probe summary');
    } else {
      const requiredKeys = ['total', 'PASS', 'MISS', 'AMBIGUOUS', 'BLOCK'];
      for (const key of requiredKeys) {
        if (typeof report.probe.result.summary[key] !== 'number') {
          errors.push(`probe.summary: missing or invalid ${key}`);
        }
      }
    }
    if (!Array.isArray(report.probe.result.points)) {
      errors.push('Missing probe points array');
    }
  }

  if (!Array.isArray(report.restoreHash)) {
    errors.push('Missing restore/hash comparison array');
  } else {
    for (let i = 0; i < report.restoreHash.length; i++) {
      const r = report.restoreHash[i];
      if (typeof r.file !== 'string' || !r.file) {
        errors.push(`restoreHash[${i}]: missing file`);
      }
      if (typeof r.currentHash !== 'string' || r.currentHash.length !== 64) {
        errors.push(`restoreHash[${i}]: missing or invalid currentHash`);
      }
      if (typeof r.backupHash !== 'string' || r.backupHash.length !== 64) {
        errors.push(`restoreHash[${i}]: missing or invalid backupHash`);
      }
      if (typeof r.match !== 'boolean') {
        errors.push(`restoreHash[${i}]: missing match boolean`);
      }
    }
  }

  if (typeof report.compatibilityDraft !== 'string' || !report.compatibilityDraft.trim()) {
    errors.push('Missing or empty compatibility draft');
  }

  if (typeof report.finalStatus !== 'string' || !report.finalStatus) {
    errors.push('Missing final status');
  } else if (!NORMATIVE_STATUSES.includes(report.finalStatus)) {
    errors.push(`Invalid final status: ${report.finalStatus}. Allowed: ${NORMATIVE_STATUSES.join(', ')}`);
  }

  if (report.finalStatus === 'AMBIGUOUS') {
    errors.push('Final status AMBIGUOUS is prohibited (incomplete/non-eligible per v3 §§1,12)');
  }

  return errors;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  if (args.length === 0) {
    console.error('Error: report file is required');
    printUsage();
    process.exit(1);
  }

  const reportFile = args[0];
  let report;
  try {
    report = JSON.parse(readFileSync(reportFile, 'utf8'));
  } catch (err) {
    console.error(`Error reading report: ${err.message}`);
    process.exit(1);
  }

  const errors = validateReport(report);
  if (errors.length > 0) {
    console.error('Validation failed:');
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  console.log('Report validation passed.');
  process.exit(0);
}

main();

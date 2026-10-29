import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, rmdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const FIX = resolve('test/fixtures/adaptation');
const REG = resolve('test/fixtures/registry');

test('PASS outcome', () => {
  const out = mkdtempSync(join(tmpdir(), 'probe-')) + '/out.json';
  try {
    execSync(`node scripts/adaptation/probe.mjs --dir ${FIX} --registry ${join(REG, 'pass.json')} --out ${out}`, { encoding: 'utf8' });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(r.points[0].status, 'PASS');
  } finally {
    if (existsSync(out)) rmSync(out);
    const dir = out.slice(0, -9);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

test('required MISS', () => {
  const out = mkdtempSync(join(tmpdir(), 'probe-')) + '/out.json';
  try {
    execSync(`node scripts/adaptation/probe.mjs --dir ${FIX} --registry ${join(REG, 'miss-required.json')} --out ${out}`, { encoding: 'utf8' });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(r.points[0].status, 'MISS');
  } finally {
    if (existsSync(out)) rmSync(out);
    const dir = out.slice(0, -9);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

test('AMBIGUOUS', () => {
  const out = mkdtempSync(join(tmpdir(), 'probe-')) + '/out.json';
  try {
    execSync(`node scripts/adaptation/probe.mjs --dir ${FIX} --registry ${join(REG, 'ambiguous.json')} --out ${out}`, { encoding: 'utf8' });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(r.points[0].status, 'AMBIGUOUS');
  } finally {
    if (existsSync(out)) rmSync(out);
    const dir = out.slice(0, -9);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

test('BLOCK owner mismatch', () => {
  const out = mkdtempSync(join(tmpdir(), 'probe-')) + '/out.json';
  try {
    execSync(`node scripts/adaptation/probe.mjs --dir ${FIX} --registry ${join(REG, 'block-owner.json')} --out ${out}`, { encoding: 'utf8' });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(r.points[0].status, 'BLOCK');
    assert.match(r.points[0].reason, /owner/);
  } finally {
    if (existsSync(out)) rmSync(out);
    const dir = out.slice(0, -9);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

test('optional zero-match', () => {
  const out = mkdtempSync(join(tmpdir(), 'probe-')) + '/out.json';
  try {
    execSync(`node scripts/adaptation/probe.mjs --dir ${FIX} --registry ${join(REG, 'optional-zero.json')} --out ${out}`, { encoding: 'utf8' });
    const r = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(r.points[0].status, 'MISS');
  } finally {
    if (existsSync(out)) rmSync(out);
    const dir = out.slice(0, -9);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

test('refusal without explicit dir', () => {
  const out = '/tmp/x.json';
  try {
    execSync('node scripts/adaptation/probe.mjs --registry fake.json --out /tmp/x.json', { encoding: 'utf8' });
    throw new Error('should fail');
  } catch (e) {
    assert.equal(String(e.status), '1');
    assert.match(String(e.stderr || e.message), /dir/);
  } finally {
    if (existsSync(out)) rmSync(out);
    const dir = out.slice(0, -9);
    if (existsSync(dir)) rmdirSync(dir);
  }
});

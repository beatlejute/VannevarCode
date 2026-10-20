// Progress projection tests — QA-012 / PLAN-001 task 28
// Pure fixtures against runtime/host.js SessionProgressProjection.
//
// host.js requires('vscode') and is CommonJS while this package's tests are ESM, so it is loaded
// the way test/env-isolation.test.mjs does it: a temp HOME, a 'vscode' stub and a .cjs copy —
// the only real filesystem touch, allowed by the plan ("unique temp if host loader needs it").
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'assert';

const home = join(tmpdir(), `ccx-projection-${process.pid}`);
mkdirSync(join(home, '.claude', 'vannevar'), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
// host.js loads ./progress-broker.js from the redirected HOME's runtime dir at require time
writeFileSync(
    join(home, '.claude', 'vannevar', 'progress-broker.js'),
    readFileSync(new URL('../runtime/progress-broker.js', import.meta.url)),
);
const hostCopy = join(tmpdir(), `ccx-host-projection-${process.pid}.cjs`);
writeFileSync(hostCopy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
let SessionProgressProjection;
try {
    ({ SessionProgressProjection } = require(hostCopy));
} finally {
    rmSync(hostCopy, { force: true });
    Module._load = load;
}

// Fixture: provider generation mismatch — enforced identity from profile/model vs servedModel
function testProviderGenerationMismatch() {
  const proj = SessionProgressProjection({
    sessionId: 's1',
    runtime: { root: { rootId: 'r1', title: 'T', state: 'running', activityHealth: 'good', startedAt: 1000, lastActivityAt: 2000, currentTool: 't', runtimeRevision: 1, execution: { providerProfile: 'p1', requestedModel: 'm1', servedModel: 'm2', providerEvidence: 'delegated-manifest', requestedModelEvidence: 'delegated-manifest', servedModelEvidence: 'child-assistant-message' } } },
    brokerSnapshot: { root: { semantic: { label: 'x' } }, health: { available: true, circuitOpen: false } },
    // Real manifest shape (runtime/mcp/agent-server.mjs openRun): a run carries owner (the tab
    // session that spawned it) and parent; ownerScopedSessions shows a run to that tab only.
    delegatedRuns: [{ session: 'c1', attemptId: 'a1', scopeId: 'scope1', description: 'Child', state: 'running', startedAt: 1500, profile: 'p2', model: 'm3', servedModel: 'm4', contextTokens: 100, toolUses: 2, owner: 's1', parent: null }],
    ownerSession: 's1',
    now: 3000,
    enabled: true,
  });
  assert.strictEqual(proj.sessionId, 's1');
  assert.strictEqual(proj.root.rootId, 'r1');
  assert.strictEqual(proj.agents.childCount, 1); // delegated only
  assert.strictEqual(proj.agents.delegated[0].execution.servedModelEvidence, 'child-assistant-message');
  assert.strictEqual(proj.agents.delegated[0].execution.providerProfile, 'p2');
}

// Fixture: native-capability-unavailable branch — snapshot.nativeAgents absent/empty => native = []
function testNativeCapabilityUnavailable() {
  const proj = SessionProgressProjection({
    sessionId: 's2',
    runtime: { root: { rootId: 'r2', title: 'T2', state: 'running', activityHealth: 'good', startedAt: 100, lastActivityAt: 200, currentTool: null, runtimeRevision: 0, execution: {} } },
    brokerSnapshot: { root: { semantic: null }, health: {} },
    delegatedRuns: [],
    ownerSession: 's2',
    now: 300,
    enabled: true,
  });
  assert.strictEqual(proj.agents.childCount, 0);
  assert.deepStrictEqual(proj.agents.native, []);
  assert.strictEqual(proj.capabilities.nativeSubagentTasks, false);
}

// Fixture: disabled behavior
function testDisabled() {
  assert.strictEqual(SessionProgressProjection({ enabled: false }), null);
}

// Fixture: root / semantic / delegated merge with identity count
function testMergeCountIdentity() {
  const proj = SessionProgressProjection({
    sessionId: 's3',
    runtime: { root: { rootId: 'r3', title: 'Root', state: 'running', activityHealth: 'fair', startedAt: 0, lastActivityAt: 100, currentTool: 't', runtimeRevision: 2, execution: { providerProfile: 'prof', requestedModel: 'm', servedModel: 'm', providerEvidence: 'delegated-manifest', requestedModelEvidence: 'delegated-manifest', servedModelEvidence: 'child-assistant-message' } }, nativeAgents: [{ id: 'n1', title: 'Native', state: 'running', startedAt: 0, lastActivityAt: 50, currentTool: 't', tokens: 10, toolCalls: 1, execution: {} }] },
    brokerSnapshot: { root: { semantic: { label: 'l' } }, semanticByScope: { sc1: { label: 'scope' } }, health: { available: true, circuitOpen: false } },
    delegatedRuns: [
      { session: 'c1', attemptId: 'a1', scopeId: 'sc1', description: 'D1', state: 'running', startedAt: 10, profile: 'p', model: 'm', servedModel: 'm', contextTokens: 10, toolUses: 1, owner: 's3', parent: null },
      { session: 'c2', attemptId: 'a2', scopeId: 'sc2', description: 'D2', state: 'running', startedAt: 20, profile: 'p', model: 'm', servedModel: 'm', contextTokens: 10, toolUses: 1, owner: 's3', parent: null },
    ],
    ownerSession: 's3',
    now: 200,
    enabled: true,
  });
  assert.strictEqual(proj.agents.childCount, 3); // 1 native + 2 delegated
  assert.strictEqual(proj.agents.native.length, 1);
  assert.strictEqual(proj.agents.depleted?.length || proj.agents.delegated.length, 2);
  assert.strictEqual(proj.capabilities.brokerAvailable, true);
  assert.strictEqual(proj.agents.native[0].kind, 'native');
  assert.strictEqual(proj.agents.delegated[0].kind, 'delegated');
}

// Fixture: terminal / resumed attempt boundaries — only running projected; terminal excluded; resumed keeps its own attempt
function testAttemptBoundaries() {
  const proj = SessionProgressProjection({
    sessionId: 's4',
    runtime: { root: { rootId: 'r4', title: 'T', state: 'running', activityHealth: 'good', startedAt: 0, lastActivityAt: 10, currentTool: null, runtimeRevision: 0, execution: {} } },
    brokerSnapshot: { root: { semantic: null }, health: {} },
    delegatedRuns: [
      { session: 'c1', attemptId: 'a1', state: 'terminal', startedAt: 0, profile: null, contextTokens: 0, toolUses: 0, owner: 's4', parent: null },
      { session: 'c2', attemptId: 'a2', state: 'running', startedAt: 0, profile: null, contextTokens: 0, toolUses: 0, owner: 's4', parent: null },
      { session: 'c2', attemptId: 'a3', state: 'running', startedAt: 5, profile: null, contextTokens: 0, toolUses: 0, owner: 's4', parent: null }, // resumed same session new attempt
    ],
    ownerSession: 's4',
    now: 100,
    enabled: true,
  });
  assert.strictEqual(proj.agents.childCount, 2); // terminal excluded; a2 + a3 both running different attempts
  const ids = proj.agents.delegated.map(d => d.attemptId).sort();
  assert.deepStrictEqual(ids, ['a2', 'a3']);
}

// Fixture: owner filter — non-owner runs excluded
function testOwnerFilter() {
  const proj = SessionProgressProjection({
    sessionId: 's5',
    runtime: { root: { rootId: 'r5', title: 'T', state: 'running', activityHealth: 'good', startedAt: 0, lastActivityAt: 10, currentTool: null, runtimeRevision: 0, execution: {} } },
    brokerSnapshot: { root: { semantic: null }, health: {} },
    delegatedRuns: [
      { session: 's5', attemptId: 'a1', state: 'running', startedAt: 0, profile: null, contextTokens: 0, toolUses: 0, owner: 's5', parent: null },
      { session: 'other', attemptId: 'a2', state: 'running', startedAt: 0, profile: null, contextTokens: 0, toolUses: 0, owner: 'other-tab', parent: null },
    ],
    ownerSession: 's5',
    now: 100,
    enabled: true,
  });
  assert.strictEqual(proj.agents.childCount, 1);
  assert.strictEqual(proj.agents.delegated[0].session, 's5');
}

// Fixture: identity — execution enforced from profile/model/servedModel
function testIdentity() {
  const proj = SessionProgressProjection({
    sessionId: 's6',
    runtime: { root: { rootId: 'r6', title: 'T', state: 'running', activityHealth: 'good', startedAt: 0, lastActivityAt: 1, currentTool: null, runtimeRevision: 0, execution: { providerProfile: 'p', requestedModel: 'm_req', servedModel: 'm_svr', providerEvidence: 'delegated-manifest', requestedModelEvidence: 'delegated-manifest', servedModelEvidence: 'child-assistant-message' } } },
    brokerSnapshot: { root: { semantic: null }, health: {} },
    delegatedRuns: [],
    ownerSession: 's6',
    now: 2,
    enabled: true,
  });
  assert.strictEqual(proj.root.execution.providerProfile, 'p');
  assert.strictEqual(proj.root.execution.servedModelEvidence, 'child-assistant-message');
}

// Execute all
function run() {
  const cases = [
    ['providerGenerationMismatch', testProviderGenerationMismatch],
    ['nativeCapabilityUnavailable', testNativeCapabilityUnavailable],
    ['disabled', testDisabled],
    ['mergeCountIdentity', testMergeCountIdentity],
    ['attemptBoundaries', testAttemptBoundaries],
    ['ownerFilter', testOwnerFilter],
    ['identity', testIdentity],
  ];
  let passed = 0, failed = 0;
  for (const [name, fn] of cases) {
    try { fn(); passed++; console.log('PASS:', name); }
    catch (e) { failed++; console.error('FAIL:', name, '-', e.message); }
  }
  console.log(`\nResults: ${passed}/${passed+failed} passed`);
  if (failed) process.exit(1);
}
run();

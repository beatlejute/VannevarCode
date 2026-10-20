import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createReportingHooks, withReportingBrief } = require('../runtime/progress-reporting.js');
let nativeEnabled = true;
const hooks = createReportingHooks({ ownerSession: 'owner', enabled: () => true, nativeEnabled: () => nativeEnabled });
const defaultHooks = createReportingHooks({ ownerSession: 'owner', enabled: () => true });
assert.deepEqual(defaultHooks.start({ session_id: 'owner', agent_id: 'child' }), {},
    'native reporting requires enabled attribution');
const root = { hook_event_name: 'UserPromptSubmit', session_id: 'owner', prompt: 'Inspect the project' };
const first = hooks.prompt(root);
assert.equal(first.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
assert.match(first.hookSpecificOutput.additionalContext, /mcp__vannevar__progress/);
assert.match(first.hookSpecificOutput.additionalContext, /replan/);
assert.equal(first.hookSpecificOutput.permissionDecision, undefined);
assert.deepEqual(hooks.prompt(root), {}, 'the same launch does not repeat its brief on every prompt');
assert.deepEqual(hooks.prompt({ ...root, session_id: 'foreign' }), {});
const child = { hook_event_name: 'SubagentStart', session_id: 'owner', agent_id: 'child' };
assert.equal(hooks.start(child).hookSpecificOutput.hookEventName, 'SubagentStart');
assert.deepEqual(hooks.start(child), {}, 'duplicate start does not duplicate reporting context');
assert.ok(hooks.start({ ...child, agent_id: 'sibling' }).hookSpecificOutput);
nativeEnabled = false;
assert.deepEqual(hooks.start({ ...child, agent_id: 'disabled-child' }), {});
nativeEnabled = true;
assert.ok(hooks.start({ ...child, agent_id: 'disabled-child' }).hookSpecificOutput);
const disabled = createReportingHooks({ ownerSession: 'owner', enabled: () => false });
assert.deepEqual(disabled.prompt(root), {});
assert.deepEqual(disabled.start(child), {});
const prompt = 'Original task, unchanged.';
const briefed = withReportingBrief(prompt);
assert.ok(briefed.startsWith(prompt));
assert.match(briefed, /mcp__vannevar__progress/);
assert.equal(withReportingBrief(briefed), briefed);
assert.ok(withReportingBrief('Explain [Task stage reporting]').endsWith(briefed.slice(prompt.length)),
    'a quoted marker does not suppress the actual guidance');
assert.equal(withReportingBrief(prompt, false), prompt);
assert.doesNotMatch(briefed, /VANNEVAR_PROGRESS_CAP|permissionDecision/);
console.log('progress reporting: scoped context, deduplication, disabled mode and preserved task passed');

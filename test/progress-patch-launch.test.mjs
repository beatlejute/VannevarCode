import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../runtime/apply-patch.mjs', import.meta.url), 'utf8');
const context = vm.createContext({ require, console });
vm.runInContext(source.slice(source.indexOf('const HOST_REQUIRE'), source.indexOf('// Things the injected code drives')) +
    '\nglobalThis.patches = PATCHES;', context);
const patch = context.patches.find(p => p.id === 'PATCH-HOST-ENV-FOR');

// The SDK factory is a separate lexical scope, not part of the extension's launch method.
const fixture = `
function sdkFactory(options) {
    const {env, resume, hooks, sessionId, allowedTools} = options;
    return {env, resume, hooks, sessionId, allowedTools};
}
function decoy() { return {pathToClaudeCodeExecutable:binary,env:environment,forkSession:fork,resume:resume,resumeSessionAt:at}; }
async function spawnClaude() {
    const __ccxSpawnContext = {launch: true};
    const options = {env: {FINAL_ENV: 'present'}, resume: 'resume-id'};
    const controller = {};
    options.abortController=controller;let query=(await factory({options:options}).finally(()=>{})).query('input');
    return {query, options, context: __ccxSpawnContext};
}
async function factory({options}) { return {query: () => sdkFactory(options)}; }
spawnClaude();`;
let calls = 0;
const host = {
    envFor(env, resume, options, launch) {
        calls++;
        assert.equal(launch?.launch, true, 'the hook must retain the launch lexical context');
        assert.equal(options.env, env, 'the hook must receive the real SDK options');
        assert.equal(resume, 'resume-id');
        options.sessionId = 'owned-session';
        options.allowedTools = ['mcp__vannevar__progress'];
        options.hooks = {PreToolUse: ['record-call']};
        launch.nativeBridge = 'owned-bridge';
        return {...env, VANNEVAR_PROGRESS_ENDPOINT: 'test-endpoint', VANNEVAR_PROGRESS_CAP: 'test-cap'};
    },
};
const fakeRequire = id => id.endsWith('host.js') ? host : require(id);
fakeRequire.cache = {};
fakeRequire.resolve = id => id;
const patched = fixture.replace(patch.find, patch.replace);
assert.notEqual(patched, fixture, 'the real launch must be patched');
const result = await vm.runInNewContext(patched, {require: fakeRequire});
assert.equal(calls, 1, 'only the real launch invokes envFor');
assert.equal(result.query.env.FINAL_ENV, 'present');
assert.equal(result.query.env.VANNEVAR_PROGRESS_ENDPOINT, 'test-endpoint');
assert.equal(result.query.env.VANNEVAR_PROGRESS_CAP, 'test-cap');
assert.equal(result.query.sessionId, 'owned-session');
assert.equal(result.query.hooks, result.options.hooks);
assert.equal(result.query.allowedTools, result.options.allowedTools);
assert.equal(result.context.nativeBridge, 'owned-bridge');

const legacy = 'options.pathToClaudeCodeExecutable=binary,options.executableArgs=args,options.env=environment;';
assert.notEqual(legacy.replace(patch.find, patch.replace), legacy, 'legacy launch remains supported');
console.log('PASS — environment hook retains launch context and mutates real SDK options');

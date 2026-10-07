// The adapter is a detached process, so it can die while the tab stays open — a crash, a kill, the
// machine sleeping. Before this was wired up, every prompt after that died on ConnectionRefused and
// nothing brought the adapter back until the user launched a new session: ensureProxy only ran on
// launch_claude and ccx:apply. This pins the revival check on the user-turn path and the editor's
// environment settings on both the first launch and a revival.
//
// host.js is driven through renderScript(), which is what attaches the message handler in production.
// Loading it needs the same .cjs-copy + 'vscode' stub dance as the other host tests, plus a temp HOME,
// because the module resolves ~/.claude paths at load time.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const PORT = 8799; // not the real 8787 — this must never collide with a live adapter
const home = join(tmpdir(), `ccx-revive-${process.pid}`);
const profiles = join(home, '.claude', 'profiles');
const runtime = join(home, '.claude', 'vannevar');
mkdirSync(profiles, { recursive: true });
mkdirSync(join(runtime, 'proxy'), { recursive: true });

writeFileSync(
    join(profiles, 'codex.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}/codex`, ANTHROPIC_AUTH_TOKEN: 'sk-x' } }),
);
// A profile that talks straight to a provider — it has no local adapter, so it must not be probed.
writeFileSync(
    join(profiles, 'deepseek.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-y' } }),
);
writeFileSync(join(runtime, 'bindings.json'), JSON.stringify({ 'sess-codex': 'codex', 'sess-direct': 'deepseek' }));
// ensureProxy bails before probing if the adapter script is absent. Child creation is stubbed below,
// so this script is never executed, even when the test closes the port to exercise a revival.
writeFileSync(join(runtime, 'proxy', 'server.mjs'), '// stub\n');
writeFileSync(
    join(runtime, 'proxy.json'),
    JSON.stringify({
        env: {
            HTTP_PROXY: 'http://runtime-proxy.invalid:3128',
            HTTPS_PROXY: 'http://runtime-proxy.invalid:3128',
            NODE_EXTRA_CA_CERTS: '/test/proxy-ca.pem',
        },
    }),
);
copyFileSync(new URL('../runtime/webview.js', import.meta.url), join(runtime, 'webview.js'));

process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.HTTPS_PROXY = 'http://ambient-proxy.invalid:9999';
const ambientEnv = { ...process.env };

const require = createRequire(import.meta.url);
const Module = require('node:module');
const realOs = require('node:os');
const realChild = require('node:child_process');
const spawns = [];
let unrefs = 0;
function spawnStub(file, args, options) {
    spawns.push({ file, args, options });
    return { unref: () => unrefs++ };
}
let configuredEnv = [
    { name: 'HTTP_PROXY', value: 'http://editor-proxy.invalid:8080' },
    { name: 'HTTPS_PROXY', value: 'http://editor-proxy.invalid:8443' },
    { name: 'ALL_PROXY', value: 'http://editor-proxy.invalid:8080' },
    { name: 'CCX_EMPTY_ENV', value: '' },
    { name: 'ELECTRON_RUN_AS_NODE', value: '0' },
];
const vscodeStub = {
    Uri: { file: (p) => ({ fsPath: p }) },
    window: { showWarningMessage() {}, showErrorMessage() {} },
    workspace: {
        getConfiguration: (section) => {
            assert.equal(section, 'claudeCode');
            return {
                get: (key) => {
                    assert.equal(key, 'environmentVariables');
                    return configuredEnv;
                },
            };
        },
    },
};
const load = Module._load;
Module._load = (request, ...rest) => {
    if (request === 'vscode') return vscodeStub;
    if (request === 'os' || request === 'node:os') return { ...realOs, homedir: () => home };
    if (request === 'child_process' || request === 'node:child_process')
        return { ...realChild, spawn: spawnStub };
    return load(request, ...rest);
};

const copy = join(tmpdir(), `ccx-host-revive-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
let renderScript;
try {
    ({ renderScript } = require(copy));
} finally {
    Module._load = load;
    rmSync(copy, { force: true });
}

// Stand in for the port the adapter would hold, and count the probes that reach it.
let probes = 0;
const server = createServer((socket) => {
    probes++;
    socket.destroy();
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

function fakeWebview() {
    const handlers = [];
    const webview = {
        postMessage: () => Promise.resolve(true),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    };
    renderScript(webview, 'nonce');
    assert.ok(handlers.length, 'renderScript did not attach a message handler');
    return { webview, send: (m) => handlers.forEach((fn) => fn(m)) };
}

const settle = () => new Promise((r) => setTimeout(r, 300));

// 1. A user turn on a session bound to the local adapter must check the port.
const a = fakeWebview();
a.webview.__ccxSessionId = 'sess-codex';
probes = 0;
a.send({ type: 'io_message', channelId: 'ch1', message: { type: 'user' } });
await settle();
assert.equal(probes, 1, 'a user turn on an adapter-backed session did not check that the adapter is up');

// 2. A session bound to a direct provider has no adapter, so nothing must be probed.
const b = fakeWebview();
b.webview.__ccxSessionId = 'sess-direct';
probes = 0;
b.send({ type: 'io_message', channelId: 'ch2', message: { type: 'user' } });
await settle();
assert.equal(probes, 0, 'a direct provider must not be probed for a local adapter');

// 3. An unbound session resolves to no profile — also nothing to probe.
const c = fakeWebview();
c.webview.__ccxSessionId = 'sess-unknown';
probes = 0;
c.send({ type: 'io_message', channelId: 'ch3', message: { type: 'user' } });
await settle();
assert.equal(probes, 0, 'an unbound session must not be probed');

// 4. Messages that are not a user turn must not probe on every keystroke of housekeeping traffic.
const d = fakeWebview();
d.webview.__ccxSessionId = 'sess-codex';
probes = 0;
d.send({ type: 'request', request: { type: 'update_session_state', sessionId: 'sess-codex', state: 'idle' } });
d.send({ type: 'request', request: { type: 'log_event', eventName: 'time_to_response' } });
await settle();
assert.equal(probes, 0, 'housekeeping traffic must not probe the adapter');
assert.equal(spawns.length, 0, 'an open adapter port must not spawn a replacement');

await new Promise((r) => server.close(r));

// 5. The first launch must carry the editor settings, not stale values from proxy.json or process.env.
a.send({ type: 'launch_claude', channelId: 'ch1', resume: 'sess-codex' });
await settle();
assert.equal(spawns.length, 1, 'a closed adapter port must spawn the proxy on launch');
const first = spawns[0];
assert.equal(first.file, process.execPath);
assert.deepEqual(first.args, ['--use-env-proxy', join(runtime, 'proxy', 'server.mjs'), '--port', String(PORT)]);
assert.equal(first.options.detached, true);
assert.equal(first.options.stdio, 'ignore');
assert.equal(first.options.env.HTTP_PROXY, 'http://editor-proxy.invalid:8080', 'the editor HTTP proxy must outrank proxy.json');
assert.equal(first.options.env.HTTPS_PROXY, 'http://editor-proxy.invalid:8443', 'the editor HTTPS proxy must outrank proxy.json and process.env');
assert.equal(first.options.env.ALL_PROXY, 'http://editor-proxy.invalid:8080');
assert.equal(first.options.env.CCX_EMPTY_ENV, '', 'empty settings values must survive the spawn');
assert.equal(first.options.env.NODE_EXTRA_CA_CERTS, '/test/proxy-ca.pem', 'unrelated proxy.json defaults must survive');
assert.equal(first.options.env.ELECTRON_RUN_AS_NODE, '1', 'the adapter must run as Node even if settings say otherwise');
assert.deepEqual({ ...process.env }, ambientEnv, 'spawning the adapter must not mutate the extension host environment');
assert.equal(unrefs, 1);

// 6. A revival reads the current settings again rather than retaining the first launch's environment.
configuredEnv = configuredEnv.map((entry) =>
    entry.name === 'HTTPS_PROXY' ? { ...entry, value: 'http://updated-editor-proxy.invalid:8443' } : entry,
);
globalThis.__ccxState.proxyStarting = false;
a.send({ type: 'io_message', channelId: 'ch1', message: { type: 'user' } });
await settle();
assert.equal(spawns.length, 2, 'a user turn must revive a dead adapter');
assert.equal(spawns[1].options.env.HTTPS_PROXY, 'http://updated-editor-proxy.invalid:8443', 'a revival must use the current editor settings');
assert.equal(spawns[1].options.env.NODE_EXTRA_CA_CERTS, '/test/proxy-ca.pem');
assert.deepEqual({ ...process.env }, ambientEnv);
assert.equal(unrefs, 2);

// 7. The MCP server inherits the editor settings from the CLI and must not replace them with defaults.
process.env.VANNEVAR_PROFILES_DIR = profiles;
process.env.VANNEVAR_RUNTIME_DIR = runtime;
for (const entry of configuredEnv) process.env[entry.name] = entry.value;
const originalSpawn = realChild.spawn;
const originalHomedir = realOs.homedir;
try {
    realChild.spawn = spawnStub;
    realOs.homedir = () => home;
    syncBuiltinESMExports();
    const { callTool } = await import('../runtime/mcp/agent-server.mjs');
    await callTool('list_profiles', { probe: true });
    assert.equal(spawns.length, 3, 'the MCP server must start the adapter when it is down');
    assert.equal(spawns[2].options.env.HTTP_PROXY, 'http://editor-proxy.invalid:8080', 'MCP must preserve the inherited editor HTTP proxy');
    assert.equal(spawns[2].options.env.HTTPS_PROXY, 'http://updated-editor-proxy.invalid:8443', 'MCP must preserve the inherited editor HTTPS proxy');
    assert.equal(spawns[2].options.env.NODE_EXTRA_CA_CERTS, '/test/proxy-ca.pem');
    assert.equal(unrefs, 3);
} finally {
    realChild.spawn = originalSpawn;
    realOs.homedir = originalHomedir;
    syncBuiltinESMExports();
}

rmSync(home, { recursive: true, force: true });
console.log('\nOK - the adapter starts and revives with the current editor environment');
// attachWebview installs fs.watch handles on settings, bindings and profiles. Inside the extension
// host they are meant to live for the session, so nothing unrefs them and the loop never drains —
// correct there, a hang here.
process.exit(0);

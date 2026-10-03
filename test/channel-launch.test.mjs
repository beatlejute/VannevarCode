// A plugin channel is started from the menu, and the only thing that can start it is the control
// request `query.enableChannel(pluginQualifiedServer)` on the live session — the `--channels` launch flag cannot be
// reached from the extension's spawn options (the SDK rebuilds the transport literal without it), and
// Remote Control takes the same runtime path. Nothing in the runtime names a channel: the list is the
// MCP servers the installed plugins declare, read off disk, so installing a second channel plugin is
// what adds a second row. The host learns the session manager and the channel id from one injected
// hook, keeps them, and answers three different clicks: a build where the hook never ran, a channel
// that is launched but has not reported in, and one that can take the request. This pins all of them,
// the per-server state that keeps two channels apart, and the failure that has to be reported rather
// than swallowed.
//   node test/channel-launch.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-channel-${process.pid}`);
const runtime = join(home, '.claude', 'vannevar');
mkdirSync(runtime, { recursive: true });
copyFileSync(new URL('../runtime/webview.js', import.meta.url), join(runtime, 'webview.js'));

// Two installed plugins, each declaring one MCP server: a channel candidate is exactly that, and the
// second one is here so that nothing can pass this test by knowing the first by name.
const plugins = join(home, '.claude', 'plugins');
mkdirSync(plugins, { recursive: true });
function installPlugin(name, marketplace, servers) {
    const dir = join(plugins, 'cache', marketplace, name, '0.0.1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.mcp.json'), JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s, { command: 'x' }])) }));
    return dir;
}
const telegramDir = installPlugin('telegram', 'claude-plugins-official', ['telegram']);
const slackDir = installPlugin('slack', 'claude-plugins-official', ['events']);
writeFileSync(
    join(plugins, 'installed_plugins.json'),
    JSON.stringify({
        version: 2,
        plugins: {
            'telegram@claude-plugins-official': [{ scope: 'user', installPath: telegramDir, version: '0.0.1' }],
            'slack@claude-plugins-official': [{ scope: 'user', installPath: slackDir, version: '0.0.1' }],
        },
    }),
);
process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode'
        ? { Uri: { file: (p) => ({ fsPath: p }) }, window: { showWarningMessage() {}, showErrorMessage() {} } }
        : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-channel-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url)));
let renderScript;
let onChannelReady;
try {
    ({ renderScript, onChannelReady } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

function fakeWebview() {
    const handlers = [];
    const posted = [];
    const webview = {
        postMessage: (m) => (posted.push(m), Promise.resolve(true)),
        onDidReceiveMessage: (fn) => handlers.push(fn),
        onDidDispose: () => {},
    };
    renderScript(webview, 'nonce');
    return { webview, posted, send: (m) => handlers.forEach((fn) => fn(m)) };
}
const settle = () => new Promise((r) => setTimeout(r, 60));
// The channel block out of the last ccx:state the host sent this tab — null before there is one.
function channelState(posted) {
    const last = posted.filter((m) => m.type === 'ccx:state').pop();
    return last ? last.channel : null;
}
function serverState(posted, server) {
    const ch = channelState(posted);
    return ch ? (ch.servers || []).find((s) => s.server === server) || null : null;
}
// A session manager, as far as anything here is concerned: a Map of channel records, each holding the
// query object the hook hands over. enableChannel is called as a method on it, so `this` has to survive.
function managerWith(id, enableChannel, controls = {}) {
    return { channels: new Map([[id, { query: { enableChannel, ...controls } }]]) };
}

// 1. The list is the installed plugins' servers, and neither is started until it is clicked.
const calls = [];
const t = fakeWebview();
t.posted.length = 0;
t.send({ type: 'launch_claude', channelId: 'ch-a', resume: null });
assert.equal(t.webview.__ccxChannelId, 'ch-a', 'the launch channel id should be kept — it is the join key');
assert.equal(channelState(t.posted), null, 'no session manager yet: there is no channel to draw');
const manager = managerWith('ch-a', async (s) => calls.push(s));
onChannelReady(manager, 'ch-a');
const listed = channelState(t.posted).servers.map((s) => s.server);
assert.deepEqual(listed, ['events', 'telegram'], `the installed plugins' servers are the list, not a name in the code: ${listed}`);
assert.equal(serverState(t.posted, 'telegram').status, 'idle', 'nothing starts on its own');
assert.equal(channelState(t.posted).supported, true);

// 2. One click starts one channel, and the other is left alone.
t.posted.length = 0;
t.send({ type: 'ccx:channelStart', channelId: 'ch-a', server: 'telegram' });
assert.equal(serverState(t.posted, 'telegram').status, 'connecting', 'the row should say starting… before the answer');
await settle();
assert.deepEqual(calls, ['plugin:telegram:telegram'], 'channel_enable takes the plugin-qualified MCP server name');
assert.equal(serverState(t.posted, 'telegram').status, 'enabled');
assert.equal(serverState(t.posted, 'events').status, 'idle', 'starting one channel must not touch another');

// Two clicks on the same channel are one request: the second is refused by the host, not only hidden
// by the page. The other channel is still startable, which is the point of per-server state.
t.send({ type: 'ccx:channelStart', channelId: 'ch-a', server: 'telegram' });
t.send({ type: 'ccx:channelStart', channelId: 'ch-a', server: 'events' });
await settle();
assert.deepEqual(
    calls,
    ['plugin:telegram:telegram', 'plugin:slack:events'],
    'an enabled channel must not be asked for twice, and each declaration must be plugin-qualified',
);

// 3. A click that lands before the channel reports in is remembered and run once it does.
const later = [];
const t2 = fakeWebview();
t2.send({ type: 'launch_claude', channelId: 'ch-b', resume: null });
t2.posted.length = 0;
t2.send({ type: 'ccx:channelStart', channelId: 'ch-b', server: 'telegram' });
await settle();
assert.equal(later.length, 0, 'nothing can be started before the manager is known');
assert.equal(serverState(t2.posted, 'telegram').status, 'connecting');
onChannelReady(managerWith('ch-b', async (s) => later.push(s)), 'ch-b');
await settle();
assert.deepEqual(
    later,
    ['plugin:telegram:telegram'],
    'the remembered click runs exactly once with the plugin-qualified name when the channel is ready',
);
assert.equal(serverState(t2.posted, 'telegram').status, 'enabled');

// 4. A refusal from the CLI is the row's answer — it carries the CLI's own words
//    ("… is not plugin-sourced; channel_enable requires a marketplace plugin", org policy, and so on).
const t3 = fakeWebview();
t3.send({ type: 'launch_claude', channelId: 'ch-c', resume: null });
onChannelReady(
    managerWith('ch-c', async () => {
        throw new Error('server telegram is not plugin-sourced; channel_enable requires a marketplace plugin');
    }),
    'ch-c',
);
t3.posted.length = 0;
t3.send({ type: 'ccx:channelStart', channelId: 'ch-c', server: 'telegram' });
await settle();
const failed = serverState(t3.posted, 'telegram');
assert.equal(failed.status, 'error');
assert.match(failed.error, /requires a marketplace plugin/);
// And the row stays usable: an error is not a lock.
t3.send({ type: 'ccx:channelStart', channelId: 'ch-c', server: 'telegram' });
await settle();
assert.equal(serverState(t3.posted, 'telegram').status, 'error', 'a failed attempt must be able to fail again');

// 5. A startup failure is cached by the CLI for 15 minutes. A click on that same live session first
//    reconnects the plugin-qualified MCP server, then enables it; no window or session restart is needed.
const retryCalls = [];
const tRetry = fakeWebview();
tRetry.send({ type: 'launch_claude', channelId: 'ch-retry', resume: null });
onChannelReady(
    managerWith('ch-retry', async (server) => retryCalls.push(['enable', server]), {
        mcpServerStatus: async () => {
            retryCalls.push(['status']);
            return [{ name: 'plugin:telegram:telegram', status: 'failed' }];
        },
        reconnectMcpServer: async (server) => retryCalls.push(['reconnect', server]),
    }),
    'ch-retry',
);
tRetry.posted.length = 0;
tRetry.send({ type: 'ccx:channelStart', channelId: 'ch-retry', server: 'telegram' });
await settle();
assert.deepEqual(retryCalls, [
    ['status'],
    ['reconnect', 'plugin:telegram:telegram'],
    ['enable', 'plugin:telegram:telegram'],
]);
assert.equal(serverState(tRetry.posted, 'telegram').status, 'enabled');

// 5b. The same cache has a second shape: a server the CLI never managed to register is not in the list
//     at all, and an absent entry is a server to reconnect rather than one to leave alone. A reconnect
//     that refuses must not take the click down with it — the answer that matters is enableChannel's.
const absentCalls = [];
const tAbsent = fakeWebview();
tAbsent.send({ type: 'launch_claude', channelId: 'ch-absent', resume: null });
onChannelReady(
    managerWith('ch-absent', async (server) => absentCalls.push(['enable', server]), {
        mcpServerStatus: async () => {
            absentCalls.push(['status']);
            return [];
        },
        reconnectMcpServer: async (server) => {
            absentCalls.push(['reconnect', server]);
            throw new Error('no such server');
        },
    }),
    'ch-absent',
);
tAbsent.posted.length = 0;
tAbsent.send({ type: 'ccx:channelStart', channelId: 'ch-absent', server: 'telegram' });
await settle();
assert.deepEqual(absentCalls, [
    ['status'],
    ['reconnect', 'plugin:telegram:telegram'],
    ['enable', 'plugin:telegram:telegram'],
]);
assert.equal(serverState(tAbsent.posted, 'telegram').status, 'enabled', 'a refused reconnect is not the answer');

// 6. A build whose query has no enableChannel: the row says so, and nothing is called.
const t4 = fakeWebview();
t4.send({ type: 'launch_claude', channelId: 'ch-d', resume: null });
onChannelReady({ channels: new Map([['ch-d', { query: {} }]]) }, 'ch-d');
assert.equal(channelState(t4.posted).supported, false);
t4.posted.length = 0;
t4.send({ type: 'ccx:channelStart', channelId: 'ch-d', server: 'telegram' });
await settle();
assert.equal(serverState(t4.posted, 'telegram').status, 'unsupported');

// 7. The hook is called from a patched bundle this file does not control: anything it passes must be
//    survivable, and a manager that has already forgotten the channel must not throw.
onChannelReady(null, 'x');
onChannelReady({}, undefined);
onChannelReady({ channels: new Map() }, 'nope');
t4.send({ type: 'ccx:channelStart', channelId: 'ch-gone', server: 'telegram' });
t4.send({ type: 'ccx:channelStart', channelId: 'ch-d' });
t4.send({ type: 'ccx:channelStart', server: 'telegram' });
await settle();
assert.equal(serverState(t4.posted, 'telegram').status, 'unsupported', 'a click with no manager is reported, not thrown');

// 8. A relaunch is a new channel with a new id; the old record goes with the old session.
const t5 = fakeWebview();
t5.send({ type: 'launch_claude', channelId: 'ch-old', resume: null });
t5.send({ type: 'launch_claude', channelId: 'ch-new', resume: null });
assert.ok(!globalThis.__ccxState.channels.has('ch-old'), 'the previous channel of the same tab should be dropped');
assert.ok(globalThis.__ccxState.channels.has('ch-new'));

// 9. The page side, read as source: the field has to survive the state rebuild (anything the host sends
//    and that literal does not name is dropped on the next push) and the row has to be registered.
const page = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');
assert.match(page, /channel: d\.channel \|\| null/, 'the page must rebuild state.channel from ccx:state');
assert.match(page, /id: 'ccx-channels'/, 'the menu row must be registered');
assert.match(page, /function openChannels\(\)/, 'the row opens the list');
assert.ok(!/ccx-channel'/.test(page), 'the single-channel row id should be gone');
const host = readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8');
assert.match(host, /^ {8}channel: channelPayload\(webview\),/m, 'stateFor must send the channel field');
assert.ok(!/'telegram'/.test(host), 'no channel may be named in the host — the list comes from the plugins');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — the menu lists the installed plugins\' channel servers and starts the one clicked');
process.exit(0);

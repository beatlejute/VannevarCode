// The Telegram channel is started from a menu row, and the only thing that can start it is the control
// request `query.enableChannel(server)` on the live session — the `--channels` launch flag cannot be
// reached from the extension's spawn options (the SDK rebuilds the transport literal without it), and
// Remote Control takes the same runtime path. The host learns the session manager and the channel id
// from one injected hook, keeps them, and answers three different clicks: one on a build where the hook
// never ran, one on a channel that is launched but has not reported in, and one on a channel that can
// take the request. This pins all three, plus the failure that has to be reported rather than swallowed.
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
// A session manager, as far as anything here is concerned: a Map of channel records, each holding the
// query object the hook hands over. enableChannel is called as a method on it, so `this` has to survive.
function managerWith(id, enableChannel) {
    return { channels: new Map([[id, { query: { enableChannel } }]]) };
}

// 1. Launch, ready, click: the request goes out once and the row ends up "enabled".
const calls = [];
const t = fakeWebview();
t.posted.length = 0;
t.send({ type: 'launch_claude', channelId: 'ch-a', resume: null });
assert.equal(t.webview.__ccxChannelId, 'ch-a', 'the launch channel id should be kept — it is the join key');
assert.equal(channelState(t.posted), null, 'no session manager yet: the row holds no channel at all');
onChannelReady(managerWith('ch-a', async (s) => calls.push(s)), 'ch-a');
assert.deepEqual(channelState(t.posted), { status: 'idle', server: null, error: null, supported: true });
t.send({ type: 'ccx:channelStart', channelId: 'ch-a' });
assert.equal(channelState(t.posted).status, 'connecting', 'the row should say starting… before the answer');
await settle();
assert.deepEqual(calls, ['telegram'], 'the server name is what channel_enable takes, not the plugin spec');
assert.equal(channelState(t.posted).status, 'enabled');

// Two rows clicked in a row are one request: the second click is refused by the host, not only hidden
// by the page.
t.send({ type: 'ccx:channelStart', channelId: 'ch-a' });
await settle();
assert.equal(calls.length, 1, 'a channel that is already enabled must not be asked for twice');

// 2. A click that lands before the channel reports in is remembered and run once it does.
const later = [];
const t2 = fakeWebview();
t2.send({ type: 'launch_claude', channelId: 'ch-b', resume: null });
t2.posted.length = 0;
t2.send({ type: 'ccx:channelStart', channelId: 'ch-b' });
await settle();
assert.equal(later.length, 0, 'nothing can be started before the manager is known');
assert.equal(channelState(t2.posted).status, 'connecting');
onChannelReady(managerWith('ch-b', async (s) => later.push(s)), 'ch-b');
await settle();
assert.deepEqual(later, ['telegram'], 'the remembered click runs exactly once when the channel is ready');
assert.equal(channelState(t2.posted).status, 'enabled');

// 3. A refusal from the CLI is the row's answer — it carries the CLI's own words
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
t3.send({ type: 'ccx:channelStart', channelId: 'ch-c' });
await settle();
const failed = channelState(t3.posted);
assert.equal(failed.status, 'error');
assert.match(failed.error, /requires a marketplace plugin/);
// And the row stays usable: an error is not a lock.
t3.send({ type: 'ccx:channelStart', channelId: 'ch-c' });
await settle();
assert.equal(channelState(t3.posted).status, 'error', 'a failed attempt must be able to fail again');

// 4. A build whose query has no enableChannel: the row says so, and nothing is called.
const t4 = fakeWebview();
t4.send({ type: 'launch_claude', channelId: 'ch-d', resume: null });
onChannelReady({ channels: new Map([['ch-d', { query: {} }]]) }, 'ch-d');
assert.equal(channelState(t4.posted).status, 'unsupported');
assert.equal(channelState(t4.posted).supported, false);
t4.posted.length = 0;
t4.send({ type: 'ccx:channelStart', channelId: 'ch-d' });
await settle();
assert.equal(channelState(t4.posted).status, 'unsupported');

// 5. The hook is called from a patched bundle this file does not control: anything it passes must be
//    survivable, and a manager that has already forgotten the channel must not throw.
onChannelReady(null, 'x');
onChannelReady({}, undefined);
onChannelReady({ channels: new Map() }, 'nope');
globalThis.__ccxState.channelManagers.set('ch-gone', { channels: new Map() });
globalThis.__ccxState.channels.set('ch-gone', { status: 'idle', server: null, error: null, supported: true });
t4.send({ type: 'ccx:channelStart', channelId: 'ch-gone' });
await settle();
assert.equal(globalThis.__ccxState.channels.get('ch-gone').status, 'unsupported');

// 6. A relaunch is a new channel with a new id; the old record goes with the old session.
const t5 = fakeWebview();
t5.send({ type: 'launch_claude', channelId: 'ch-old', resume: null });
t5.send({ type: 'launch_claude', channelId: 'ch-new', resume: null });
assert.ok(!globalThis.__ccxState.channels.has('ch-old'), 'the previous channel of the same tab should be dropped');
assert.ok(globalThis.__ccxState.channels.has('ch-new'));

// 7. The page side, read as source: the field has to survive the state rebuild (anything the host sends
//    and that literal does not name is dropped on the next push) and the row has to be registered.
const page = readFileSync(new URL('../runtime/webview.js', import.meta.url), 'utf8');
assert.match(page, /channel: d\.channel \|\| null/, 'the page must rebuild state.channel from ccx:state');
assert.match(page, /id: 'ccx-channel'/, 'the menu row must be registered');
assert.match(page, /function channelTag\(\)/, 'the row draws its tag from state.channel');
const host = readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8');
assert.match(host, /^ {8}channel: channelPayload\(webview\),/m, 'stateFor must send the channel field');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — the menu row starts the plugin channel in the live session, and says what came back');
process.exit(0);

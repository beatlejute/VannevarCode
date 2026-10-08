// A tab's permission question is the host's to answer — that is what the dialog is — so the same
// question can be answered from a channel. This file pins the shape of that: the host starts the
// plugin the Channels list offers, speaks MCP to it, learns the chat from whoever writes to the bot,
// mirrors the question into it, and resolves with whichever answer comes first.
//
// What must not change: with no relay running the callback is passed through untouched, an answer
// that arrives with nothing outstanding is ignored, and the answer is matched to one request rather
// than approving whatever came next.
//
//   node test/channel-approvals.test.mjs
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-approvals-${process.pid}`);
const runtime = join(home, '.claude', 'vannevar');
mkdirSync(runtime, { recursive: true });
for (const file of ['host.js', 'channel-relay.js', 'channel-proxy.cjs']) {
    copyFileSync(new URL(`../runtime/${file}`, import.meta.url), join(runtime, file));
}

// A plugin the host can start: it answers the handshake, sends one inbound message so the chat is
// learned, and answers the mirror of a permission question the way a person would — as an inbound
// "y" once the question itself has been sent.
const pluginDir = join(home, '.claude', 'plugins', 'cache', 'probe-market', 'probe', '1.0.0');
mkdirSync(pluginDir, { recursive: true });
const sentFile = join(home, 'sent.jsonl');
writeFileSync(sentFile, '');
const stub = join(pluginDir, 'stub-plugin.cjs');
writeFileSync(
    stub,
    `
const fs = require('fs');
let buffer = '';
const notify = (params) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel', params }) + '\\n');
process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\\n')) >= 0) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '1' } } }) + '\\n');
            notify({ content: 'первое сообщение', meta: { chat_id: '777', message_id: '1', user: 'owner', user_id: '777' } });
        } else if (message.method === 'tools/list') {
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: ['reply', 'react', 'edit_message', 'download_attachment'].map(name => ({ name, inputSchema: { type: 'object' } })) } }) + '\\n');
        } else if (message.method === 'tools/call') {
            const args = message.params.arguments || {};
            fs.appendFileSync(${JSON.stringify(sentFile)}, JSON.stringify(args.text) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } }) + '\\n');
            if (String(args.text).includes('🔐')) notify({ content: 'y', meta: { chat_id: '777', message_id: '2', user: 'owner', user_id: '777' } });
        } else if (message.method === 'notifications/claude/channel/permission_request') {
            // The card the plugin would render, recorded so the test can assert the question arrived;
            // then the plugin's own button answer, under the request id the question carried.
            fs.appendFileSync(${JSON.stringify(sentFile)}, JSON.stringify(['🔐 ' + message.params.tool_name, message.params.input_preview, message.params.request_id]) + '\\n');
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: message.params.request_id, behavior: 'allow' } }) + '\\n');
        }
    }
});
process.stdin.on('end', () => process.exit(0));
`,
    'utf8',
);
writeFileSync(join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [stub] } } }));
const pluginsFile = join(home, '.claude', 'plugins', 'installed_plugins.json');
mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
writeFileSync(pluginsFile, JSON.stringify({ version: 2, plugins: { 'probe@probe-market': [{ scope: 'user', installPath: pluginDir, version: '1.0.0' }] } }));

process.env.HOME = home;
process.env.USERPROFILE = home;

const require = createRequire(import.meta.url);
const Module = require('node:module');
const load = Module._load;
const confirmations = [];
const vscodeStub = { Uri: { file: (p) => ({ fsPath: p }) }, window: {
    showWarningMessage: async (text, options) => { confirmations.push({ text, options }); return undefined; },
} };
Module._load = (request, ...rest) =>
    request === 'vscode' ? vscodeStub : load(request, ...rest);
const copy = join(tmpdir(), `ccx-host-approvals-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8') + '\nmodule.exports.__relayCommand = relayCommand;\n');
let host;
try {
    host = require(copy);
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. With no relay, the callback the dialog lives in is untouched: same function, same answer.
const dialogAnswer = { behavior: 'allow', updatedInput: { a: 1 } };
const plain = host.wrapCanUseTool(async () => dialogAnswer, {});
assert.equal(await plain('Bash', { command: 'x' }, {}), dialogAnswer, 'no relay means the dialog answers, unchanged');

// 2. The relay is started from the same list the menu draws, and learns the chat from the message the
//    plugin delivers — the allowlist behind that message is the plugin's business, not ours.
assert.deepEqual(host.startChannelRelay('nope'), { ok: false, error: 'no installed plugin declares nope' }, 'an unknown server is refused');
assert.deepEqual(host.startChannelRelay('probe'), { ok: true });
await wait(600);

// 3. A question the dialog is holding is mirrored, and the answer that comes back from the channel is
//    the answer: the dialog's promise never settles.
let dialogCancelled = false;
const toolController = new AbortController();
const wrapped = host.wrapCanUseTool(
    (_name, _input, options) =>
        new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                dialogCancelled = true;
                reject(new Error('IDE request cancelled'));
            }, { once: true });
        }),
    {},
);
const decision = await wrapped('Bash', { command: 'curl https://example.com' }, { toolUseID: 'tu-1', signal: toolController.signal });
assert.deepEqual(decision, { behavior: 'allow' }, 'the channel answered, so that is the decision');
assert.equal(dialogCancelled, true, 'the losing IDE prompt is cancelled');
assert.equal(toolController.signal.aborted, false, 'closing the IDE prompt does not abort the tool');
await wait(200);
const sent = readFileSync(sentFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
assert.ok(
    sent.some((t) => Array.isArray(t) && t[0] === '🔐 Bash' && /^[a-km-z]{5}$/.test(t[2])),
    'the question carries a contract-shaped short id the buttons can echo',
);
assert.ok(
    sent.some((t) => Array.isArray(t) && String(t[1]).includes('curl https://example.com')),
    'and carrying what it would run',
);

// 4. An answer is matched to one question: a second "y" with nothing outstanding does nothing, and the
//    dialog still owns the next question.
const answered = await host.wrapCanUseTool(async () => ({ behavior: 'deny', message: 'no' }), {})('Bash', {}, { toolUseID: 'tu-2' });
assert.deepEqual(answered, { behavior: 'deny', message: 'no' }, 'an unanswered question still resolves through the dialog');

// The real host drains generic requests and preserves the plugin result.
const outbox = join(runtime, 'outbox');
mkdirSync(outbox, { recursive: true });
writeFileSync(join(outbox, 'discover.json'), JSON.stringify({ operation: 'tools' }));
writeFileSync(join(outbox, 'edit.json'), JSON.stringify({ operation: 'call', name: 'edit_message', arguments: { chat_id: '777', message_id: '42', text: 'updated' } }));
writeFileSync(join(outbox, 'unknown.json'), JSON.stringify({ operation: 'call', name: 'missing', arguments: {} }));
const deadline = Date.now() + 5000;
while (!['discover', 'edit', 'unknown'].every((name) => existsSync(join(outbox, name + '.result.json'))) && Date.now() < deadline) await wait(100);
const result = (name) => JSON.parse(readFileSync(join(outbox, name + '.result.json'), 'utf8'));
assert.equal(result('discover').result.length, 4);
assert.equal(result('edit').result.content[0].text, 'ok');
assert.equal(result('unknown').ok, false);
assert.match(result('unknown').error, /does not advertise/);

// Extension commands reply directly without asking a model to interpret them.
const commandReplies = [];
const delivered = [];
const state = globalThis.__ccxState;
const originalSend = state.relay.relay.send;
state.relay.relay.send = async (chat, text, extra) => { commandReplies.push({ chat, text, extra }); return { text: 'ok' }; };
state.webviews = new Set([
    { __ccxSessionId: 'session-one', __ccxTitle: 'First tab', postMessage: (message) => delivered.push(message) },
    { __ccxSessionId: 'session-two', __ccxTitle: 'Second tab', postMessage: (message) => delivered.push(message) },
]);
state.lastActiveWebview = [...state.webviews][0];
// Drive the same inbound event handler used by the running plugin.
const inbound = (text) => state.relay.relay.emit('inbound', { text, chatId: '777', messageId: '55' });
inbound('/commands');
assert.match(commandReplies.at(-1).text, /\/tabs/);
assert.equal(commandReplies.at(-1).chat, '777');
assert.equal(commandReplies.at(-1).extra.reply_to, '55');
inbound('/tabs');
assert.match(commandReplies.at(-1).text, /2\. Second tab/);
inbound('/tab 2');
assert.match(commandReplies.at(-1).text, /Receiving tab: Second tab/);
inbound('/session');
assert.equal(delivered.at(-1).command, 'session');
assert.equal(delivered.at(-1).sessionId, 'session-two');
inbound('/tab 99');
assert.match(commandReplies.at(-1).text, /Invalid or closed tab/);
inbound('ordinary message');
assert.equal(delivered.at(-1).text, 'ordinary message');
const controlsBefore = delivered.filter((m) => m.type === 'ccx:relayControl').length;
inbound('/mode auto');
await wait(20);
assert.equal(confirmations.length, 1);
assert.equal(confirmations[0].options.modal, true);
assert.match(confirmations[0].text, /Second tab/);
assert.match(commandReplies.at(-1).text, /cancelled/);
assert.equal(delivered.filter((m) => m.type === 'ccx:relayControl').length, controlsBefore, 'denied escalation never reaches the native setter');
inbound('/mode ask');
assert.equal(delivered.at(-1).command, 'mode');
assert.equal(delivered.at(-1).value, 'ask');
assert.equal(confirmations.length, 1, 'ask does not require escalation approval');
// A reload must retain requests owned by listeners installed by the previous host module.
const pendingMap = state.relayControls;
const tabsMap = state.relayCommandTabs;
assert.ok(pendingMap.size > 0);
// Attach a real host listener before reloading, then answer a request created by the new module.
let oldListener;
const controlMessages = [];
const target = {
    __ccxSessionId: 'session-two', __ccxTitle: 'Second tab',
    postMessage: (message) => { controlMessages.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (listener) => { oldListener = listener; },
    asWebviewUri: (uri) => uri,
};
for (const field of ['agentRunsWatcher', 'settingsWatcher', 'bindingsWatcher', 'defaultWatcher', 'profilesWatcher', 'healthWatcher', 'extensionsWatcher']) state[field] ||= {};
writeFileSync(join(runtime, 'webview.js'), '// Fake webview runtime for listener registration.');
state.webviews.delete([...state.webviews].find((view) => view.__ccxSessionId === 'session-two'));
host.renderScript(target, 'test-nonce');
assert.equal(typeof oldListener, 'function');
Module._load = (request, ...rest) => request === 'vscode' ? vscodeStub : load(request, ...rest);
writeFileSync(copy, readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8') + '\nmodule.exports.__relayCommand = relayCommand;\n');
try {
    delete require.cache[require.resolve(copy)];
    const reloadedHost = require(copy);
    assert.equal(state.relayControls, pendingMap, 'request correlation survives host reload');
    assert.equal(state.relayCommandTabs, tabsMap, 'the displayed tab list survives host reload');
    reloadedHost.__relayCommand({ chatId: '777', messageId: '56' }, '/session');
    const control = controlMessages.findLast((message) => message.type === 'ccx:relayControl');
    assert.ok(control, 'the new host posts the request to the selected webview');
    assert.ok(pendingMap.has(control.requestId));
    oldListener({ type: 'ccx:relayControlResult', requestId: control.requestId, text: 'Provider: test-provider' });
    assert.equal(pendingMap.has(control.requestId), false, 'the old listener settles the new request');
    assert.equal(commandReplies.at(-1).text, 'Provider: test-provider');
    assert.equal(commandReplies.at(-1).extra.reply_to, '56');
    oldListener({ type: 'ccx:relayError', sessionId: 'session-two', errorId: 'api-429', text: 'API Error: Request rejected (429)' });
    assert.equal(commandReplies.at(-1).text, '[Second tab] Request failed:\nAPI Error: Request rejected (429)');
    const forwardedCount = commandReplies.length;
    oldListener({ type: 'ccx:relayError', sessionId: 'session-one', errorId: 'stale', text: 'wrong tab' });
    assert.equal(commandReplies.length, forwardedCount, 'errors from stale tabs are ignored');
    oldListener({ type: 'ccx:relayError', sessionId: 'session-two', errorId: 'empty', text: '  ' });
    assert.equal(commandReplies.length, forwardedCount, 'empty error notifications are ignored');
} finally {
    rmSync(copy, { force: true });
    Module._load = load;
    for (const pending of pendingMap.values()) clearTimeout(pending.timer);
    pendingMap.clear();
}
state.relay.relay.send = originalSend;

host.stopChannelRelay();
// The plugin this test started lives in that directory and is on its way out; on Windows a file a
// closing process still holds is a removal that has to be asked for again.
await wait(800);
rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
assert.ok(!existsSync(join(home, '.claude')), 'the fake home is thrown away');
console.log('\nOK — a question the dialog holds can be answered from the channel, and the dialog still owns the rest');

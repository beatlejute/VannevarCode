// A channel plugin can be spoken to by anybody who can start it: it is transport, and the session it
// belongs to is only one of its clients. This extension has to be able to be another — the question a
// tab waits on is already in this host's hands, and answering it from Telegram needs a client here,
// not a session.
//
// What is pinned: the handshake a session performs is performed here too, inbound notifications reach
// a handler with the fields a reply needs, a tool call carries the arguments and reports the plugin's
// own error, the marker that keeps a session's plugin from treating this poller as an orphan is on the
// command line, and a dead plugin surfaces as an exit rather than as a promise that never settles.
//
//   node test/channel-relay.test.mjs
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-relay-${process.pid}`);
mkdirSync(home, { recursive: true });
const stub = join(home, 'stub-plugin.cjs');
const calls = join(home, 'calls.jsonl');
writeFileSync(calls, '');
const argvFile = join(home, 'argv.txt');

// A plugin as far as this file is concerned: it answers the handshake, records the tool call it is
// given, and pushes one inbound message the way the real one does — as a notification with the
// metadata a reply is addressed by.
writeFileSync(
    stub,
    `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(argvFile)}, process.argv.slice(2).join(' '));
let buffer = '';
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
            process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'hello из плагина', meta: { chat_id: '285532172', message_id: '7', user: 'beatlejute', user_id: '285532172', ts: '2026-10-02T10:00:00.000Z' } } }) + '\\n');
        } else if (message.method === 'tools/call') {
            fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(message.params) + '\\n');
            const failing = message.params.name === 'react';
            process.stdout.write(JSON.stringify(failing
                ? { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: 'no such message' }] } }
                : { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'sent (id: 42)' }] } }) + '\\n');
        }
    }
});
process.stdin.on('end', () => process.exit(0));
`,
    'utf8',
);

const require = createRequire(import.meta.url);
const { ChannelRelay, RELAY_FLAG } = require('../runtime/channel-relay.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const relay = new ChannelRelay({
    command: process.execPath,
    // The plugin's own manifest spells its directory this way, and only the CLI expands it — a relay
    // that starts the same server has to do it too.
    args: ['${CLAUDE_PLUGIN_ROOT}/' + stub.split(/[\\/]/).pop()],
    cwd: home,
    env: process.env,
    log: () => {},
});
const inbound = [];
relay.on('inbound', (m) => inbound.push(m));
const exits = [];
relay.on('exit', (e) => exits.push(e));

await relay.start();
assert.ok(readFileSync(argvFile, 'utf8').includes(RELAY_FLAG), 'the marker must be on the command line, or a session treats this poller as an orphan');

const reply = await relay.send('285532172', 'тест');
assert.equal(reply.text, 'sent (id: 42)', 'the plugin answers a tool call with its own text');

const sent = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
assert.deepEqual(
    sent[0],
    { name: 'reply', arguments: { chat_id: '285532172', text: 'тест' } },
    'the reply is addressed exactly as the plugin expects',
);

await wait(50);
assert.equal(inbound.length, 1, 'an inbound message reaches a handler');
assert.equal(inbound[0].chatId, '285532172', 'with the chat a reply goes back to');
assert.equal(inbound[0].messageId, '7', 'and the message it answers');
assert.equal(inbound[0].text, 'hello из плагина');

await assert.rejects(() => relay.callTool('react', { chat_id: '1', message_id: '2', emoji: '👍' }), /no such message/, 'a refused tool call is an error, not a silent success');

relay.stop();
await wait(300);
assert.equal(exits.length, 1, 'a stopped plugin reports its exit rather than leaving a promise hanging');

rmSync(home, { recursive: true, force: true });
console.log('\nOK — the extension can be a channel plugin\'s client: handshake, inbound, tools and exit');

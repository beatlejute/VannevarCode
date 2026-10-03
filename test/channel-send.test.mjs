// The channel belongs to the editor window — the bot token and the poller live in that process — so a
// session answers through this server, which hands the message over as a file and waits for the
// window's answer. What is pinned here is the honesty of that handover: a request that appears whole
// or not at all, a refusal when no window is running the channel (rather than a message written into
// a directory nobody reads), and the window's own words when it says it could not send.
//
//   node test/channel-send.test.mjs
import { mkdirSync, rmSync, writeFileSync, utimesSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const home = join(tmpdir(), `ccx-send-${process.pid}`);
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;

const server = await import('../runtime/mcp/agent-server.mjs');
const VANNEVAR = join(home, '.claude', 'vannevar');
const OUTBOX = join(VANNEVAR, 'outbox');
const PING = join(VANNEVAR, 'relay.ping');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. No window: the call says so. A message written under a heartbeat nobody refreshes is a message
//    the model believes it sent — the one failure this tool exists to prevent.
await assert.rejects(
    () => server.callTool('channel_send', { text: 'nowhere' }),
    /not up/,
    'with no window running the channel the call must refuse, not queue',
);

// 2. A live window: the request is written whole, under a name of its own, and the answer comes back
//    the way the host writes it.
mkdirSync(OUTBOX, { recursive: true });
writeFileSync(PING, '1');
utimesSync(PING, new Date(), new Date());
const pending = server.callTool('channel_send', { text: 'hello', chat_id: '777', reply_to: '5' });
await wait(300);
const requests = () => readdirSync(OUTBOX).filter((n) => n.endsWith('.json') && !n.endsWith('.result.json'));
const files = requests();
assert.equal(files.length, 1, 'one request file, and only one');
const request = JSON.parse(readFileSync(join(OUTBOX, files[0]), 'utf8'));
assert.deepEqual(
    { text: request.text, chatId: request.chatId, replyTo: request.replyTo },
    { text: 'hello', chatId: '777', replyTo: '5' },
    'the window is told exactly what to send and where',
);
assert.equal(readdirSync(OUTBOX).filter((n) => n.endsWith('.tmp')).length, 0, 'no half-written file is ever visible');

writeFileSync(join(OUTBOX, files[0].replace(/\.json$/, '.result.json')), JSON.stringify({ ok: true, text: 'sent (id: 42)' }));
assert.equal(await pending, 'sent: sent (id: 42)', 'the window\'s own words come back to the model');
assert.ok(!existsSync(join(OUTBOX, files[0].replace(/\.json$/, '.result.json'))), 'the answer is consumed, not left to be read twice');
assert.equal(requests().length, 1, 'the request file belongs to the window: it is the window that removes it after sending');

// 3. A refusal from the window is an error, not a quiet success: the model has to be able to say so.
const second = server.callTool('channel_send', { text: 'second' });
await wait(300);
const request2 = requests().filter((n) => n !== files[0])[0];
writeFileSync(join(OUTBOX, request2.replace(/\.json$/, '.result.json')), JSON.stringify({ ok: false, error: 'no conversation yet' }));
await assert.rejects(() => second, /no conversation yet/, 'what the window said is what the model is told');

await wait(50);
rmSync(home, { recursive: true, force: true });
console.log('\nOK — a session can send into the window\'s channel, and is told the truth when it cannot');

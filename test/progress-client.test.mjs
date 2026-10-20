import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProgressClient, PROTOCOL } from '../runtime/mcp/progress-client.mjs';

const root = mkdtempSync(path.join(tmpdir(), 'vannevar-client-reasons-'));
const endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\vannevar-client-' + randomUUID()
    : path.join(root, 'client.sock');
const sockets = new Set();
let reason = 'unsupported_resume';
let reports = 0;
const receivedReports = [];
const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
        buffer += chunk;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, end));
            buffer = buffer.slice(end + 1);
            if (message.type === 'hello') {
                socket.write(JSON.stringify({ type: 'helloAck', protocol: PROTOCOL, rootGeneration: 'root-one' }) + '\n');
            } else {
                reports++;
                receivedReports.push(message);
                socket.write(JSON.stringify({ type: 'ack', accepted: false, reason,
                    currentGeneration: 'root-two' }) + '\n');
            }
        }
    });
});
const client = new ProgressClient({ endpoint, protocol: PROTOCOL, capability: 'isolated-test-capability' });
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve); });
    for (const expected of ['unsupported_resume', 'unresolved_attempt', 'closed_attempt', 'stale_generation',
        'unattributed_call', 'unrecorded_call']) {
        reason = expected;
        const before = reports;
        const result = await client.report({ done: 0, total: 3 });
        assert.deepEqual(result, { ok: false, accepted: false, reason: expected });
        assert.equal(reports, before + 1, 'rejected reports must not be replayed');
    }
    reason = 'untrusted server text';
    await client.report({ done: 0, total: 3, title: 'Сборка расширения' });
    assert.equal(receivedReports.at(-1).title, 'Сборка расширения', 'semantic title is forwarded by the client');
    assert.deepEqual(await client.report({ done: 0, total: 3 }), {
        ok: false, accepted: false, reason: 'telemetry_unavailable',
    });
    console.log('PASS — native refusals retained, unknown reasons sanitized, stale reports not replayed');
} finally {
    client.close();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
}

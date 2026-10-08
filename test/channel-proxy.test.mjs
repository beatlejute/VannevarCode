// Agent-based clients must use CONNECT even when they supply their own keep-alive agent.
// This fixture never connects outside loopback or reads the real channel configuration.
import assert from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { install } = require('../runtime/channel-proxy.cjs');

const requests = [];
const proxy = http.createServer();
proxy.on('connect', (request, socket) => {
    requests.push({ url: request.url, auth: request.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
});
await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
const restore = install({ HTTPS_PROXY: `http://user:pass@127.0.0.1:${proxy.address().port}` });
const agent = new https.Agent({ keepAlive: true });
try {
    await assert.rejects(() => new Promise((resolve, reject) => {
        https.get('https://channel.invalid/test', { agent }, resolve).on('error', reject);
    }), /CONNECT refused: 407/);
    assert.deepEqual(requests, [{ url: 'channel.invalid:443', auth: 'Basic ' + Buffer.from('user:pass').toString('base64') }]);
    assert.throws(() => install({ HTTPS_PROXY: 'socks5://127.0.0.1:9' }), /Unsupported/);
} finally {
    agent.destroy();
    restore();
    await new Promise((resolve) => proxy.close(resolve));
}
// Simulate Bun's built-in module cache without loading a real plugin or making network requests.
const Module = require('node:module');
const load = Module._load;
const resolveFilename = Module._resolveFilename;
const key = '/fake/bun/node-fetch';
const calls = [];
const response = { status: 200, headers: { get: () => 'application/json' } };
const originalCompat = Object.assign(async (url, options) => {
    calls.push({ url, options });
    return response;
}, { Response: class {}, default: null });
const originalFetch = globalThis.fetch;
let restoreBun;
try {
    globalThis.Bun = {};
    Module._load = (name, ...args) => name === 'node-fetch' ? originalCompat : load(name, ...args);
    Module._resolveFilename = (name, ...args) => name === 'node-fetch' ? key : resolveFilename(name, ...args);
    restoreBun = install({ HTTPS_PROXY: 'http://127.0.0.1:8080' });
    const wrapped = require.cache[key].exports;
    assert.equal(wrapped.default, wrapped);
    assert.equal(wrapped.Response, originalCompat.Response);
    const signal = new AbortController().signal;
    assert.equal(await wrapped('https://channel.invalid/', { method: 'POST', signal }), response);
    assert.equal(calls[0].options.proxy, 'http://127.0.0.1:8080');
    assert.equal(calls[0].options.signal, signal);
    assert.equal(calls[0].options.method, 'POST');
} finally {
    if (restoreBun) restoreBun();
    Module._load = load;
    Module._resolveFilename = resolveFilename;
    delete globalThis.Bun;
}
assert.equal(globalThis.fetch, originalFetch, 'restoration does not leak a global fetch wrapper');
assert.equal(require.cache[key], undefined, 'restoration removes the compatibility shim');
console.log('OK — channel HTTPS agents and Bun compatibility fetch use the configured proxy');

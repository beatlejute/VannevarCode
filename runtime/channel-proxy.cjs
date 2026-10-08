'use strict';

// Preloaded only in channel children. Bun's node-fetch compatibility module captures native fetch;
// Node agent-based clients need a CONNECT tunnel. Neither path changes the plugin or disables TLS.
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');

function errorCode(error) {
    return String(error.code || error.name || 'Error').replace(/[^A-Za-z0-9_-]/g, '');
}

function install(env = process.env) {
    const value = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
    if (!value) return;
    const proxy = new URL(value);
    if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('Unsupported channel proxy protocol');
    const isBun = typeof Bun !== 'undefined';
    const diagnostic = env.VANNEVAR_CHANNEL_PROXY_DIAGNOSTICS === '1';
    const wrapFetch = (fetch, label) => async function (url, options) {
        try {
            const response = await fetch(url, isBun ? Object.assign({}, options, { proxy: value }) : options);
            if (diagnostic) {
                const type = String(response.headers.get('content-type') || '').split(';')[0].replace(/[^A-Za-z0-9/+.-]/g, '');
                process.stderr.write('channel proxy: ' + label + ' response ' + response.status + ' ' + type + '\n');
            }
            return response;
        } catch (error) {
            // URLs can contain a bot token; never log the error message, request URL or proxy auth.
            process.stderr.write('channel proxy: ' + label + ' failed (' + errorCode(error) + ')\n');
            throw error;
        }
    };
    const originalFetch = globalThis.fetch;
    if (isBun && typeof originalFetch === 'function') globalThis.fetch = wrapFetch(originalFetch, 'fetch');
    let restoreCompat;
    if (isBun) {
        const originalCompat = require('node-fetch');
        const key = require.resolve('node-fetch');
        const cached = require.cache[key];
        const wrapped = wrapFetch(originalCompat, 'compatibility fetch');
        Object.assign(wrapped, originalCompat, { default: wrapped });
        require.cache[key] = { id: key, filename: key, loaded: true, exports: wrapped };
        restoreCompat = () => { if (cached) require.cache[key] = cached; else delete require.cache[key]; };
    }
    const original = https.Agent.prototype.createConnection;
    const proxyAgent = proxy.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    // The proxy's own TLS socket must not recurse through the tunnel hook.
    if (proxy.protocol === 'https:') proxyAgent.createConnection = original;
    https.Agent.prototype.createConnection = function (options, callback) {
        let settled = false;
        const finish = (error, socket) => {
            if (settled) return;
            settled = true;
            if (error) process.stderr.write('channel proxy: connection failed (' + errorCode(error) + ')\n');
            callback(error, socket);
        };
        const host = options.hostname || options.host;
        const authority = (net.isIP(host) === 6 ? '[' + host + ']' : host) + ':' + (options.port || 443);
        const headers = { host: authority };
        if (proxy.username) headers['proxy-authorization'] = 'Basic ' + Buffer.from(
            decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password || ''),
        ).toString('base64');
        const transport = proxy.protocol === 'https:' ? https : http;
        const request = transport.request({
            hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
            method: 'CONNECT', path: authority, headers, agent: proxyAgent,
        });
        request.setTimeout(15000, () => request.destroy(new Error('Channel proxy connection timed out')));
        request.once('error', (error) => finish(error));
        request.once('connect', (response, socket, head) => {
            request.setTimeout(0);
            if (response.statusCode !== 200) {
                socket.destroy();
                finish(new Error('Channel proxy CONNECT refused: ' + response.statusCode));
                return;
            }
            if (head.length) socket.unshift(head);
            const secure = tls.connect(Object.assign({}, options, {
                socket, servername: options.servername || (net.isIP(host) ? undefined : host),
            }));
            secure.setTimeout(15000, () => secure.destroy(new Error('Channel TLS connection timed out')));
            secure.once('error', (error) => finish(error));
            secure.once('secureConnect', () => {
                secure.setTimeout(0);
                finish(null, secure);
            });
        });
        request.end();
        // Agent.addRequest waits for the callback; returning a socket here would bypass the tunnel.
        return undefined;
    };
    if (diagnostic) process.stderr.write('channel proxy: routing active, pid=' + process.pid + '\n');
    return () => {
        https.Agent.prototype.createConnection = original;
        if (isBun) globalThis.fetch = originalFetch;
        if (restoreCompat) restoreCompat();
        proxyAgent.destroy();
    };
}

module.exports = { install };
if (process.env.VANNEVAR_CHANNEL_PROXY === '1') install();

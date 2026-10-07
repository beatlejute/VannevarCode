// OAuth tests use only synthetic tokens, an in-memory callback server and mocked fetch.
// The real CLI is copied beside a fake auth module so its exit and stdout lifecycle run in Node.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';

const home = mkdtempSync(path.join(os.tmpdir(), 'ccx-auth-chatgpt-'));
const savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const original = {
    homedir: os.homedir,
    createServer: http.createServer,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    spawn: childProcess.spawn,
    fetch: globalThis.fetch,
    timeout: AbortSignal.timeout,
};
const tokenTimeoutMs = 40;
const browserSpawns = [];
let current;
let fetchReply;

function reset() {
    current = { events: [], servers: [], responses: [], requests: [], timeouts: [] };
    fetchReply = () => { throw Error('unexpected token request'); };
}

function rejectNetwork() {
    throw Error('real network is forbidden in auth tests');
}

async function bounded(label, promise) {
    let watchdog;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                watchdog = setTimeout(() => reject(Error(`${label}: implementation did not settle within 1 second`)), 1_000);
            }),
        ]);
    } finally {
        clearTimeout(watchdog);
    }
}

function waitForAbort(signal) {
    assert.ok(signal instanceof AbortSignal, 'token requests must supply an AbortSignal');
    return new Promise((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
}

function reply(status, body) {
    return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function transportError() {
    return new TypeError('fetch failed', {
        cause: Object.assign(Error('synthetic socket reset'), { code: 'ECONNRESET' }),
    });
}

try {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    os.homedir = () => home;
    http.request = http.get = https.request = https.get = rejectNetwork;
    childProcess.spawn = (...args) => {
        browserSpawns.push(args);
        throw Error('browser launches are forbidden in auth tests');
    };
    http.createServer = (handler) => {
        const server = new EventEmitter();
        Object.assign(server, {
            handler,
            closed: false,
            listen(port, host, callback) {
                this.port = port;
                this.host = host;
                queueMicrotask(callback);
                return this;
            },
            close(callback) {
                this.closed = true;
                if (callback) queueMicrotask(callback);
                return this;
            },
        });
        current.servers.push(server);
        return server;
    };
    AbortSignal.timeout = (ms) => {
        // Record the production default, but accelerate it using a real native timeout signal.
        const signal = original.timeout.call(AbortSignal, ms === 30_000 ? tokenTimeoutMs : ms);
        current.timeouts.push({ ms, signal });
        return signal;
    };
    globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://auth.openai.com/oauth/token', 'unexpected fetch endpoint');
        assert.equal(options.method, 'POST');
        assert.equal(new Headers(options.headers).get('content-type'), 'application/x-www-form-urlencoded');
        const request = { url, options, form: new URLSearchParams(options.body) };
        current.events.push('fetch');
        current.requests.push(request);
        return fetchReply(request);
    };
    syncBuiltinESMExports();
    const auth = await import('../runtime/proxy/auth-chatgpt.mjs');
    assert.equal(auth.STORE, path.join(home, '.claude', 'vannevar', 'chatgpt-auth.json'));
    assert.equal(auth.CODEX_AUTH, path.join(home, '.codex', 'auth.json'));

    function startLogin(callbackParams = {}, options = {}) {
        return auth.login({
            timeoutMs: 500,
            ...options,
            onAuthorize(url) {
                current.events.push('authorize');
                current.authorize = new URL(url);
                const params = current.authorize.searchParams;
                assert.ok(params.get('state'), 'authorize URL must contain the callback state');
                current.redirect = new URL(params.get('redirect_uri'));
                if (callbackParams === null) return;
                const callback = new URL(current.redirect);
                callback.searchParams.set('state', params.get('state'));
                callback.searchParams.set('code', 'synthetic-authorization-code');
                for (const [key, value] of Object.entries(callbackParams)) {
                    if (value === null) callback.searchParams.delete(key);
                    else callback.searchParams.set(key, value);
                }
                const response = {
                    status: null,
                    headers: null,
                    body: '',
                    ended: false,
                    writeHead(status, headers) {
                        this.status = status;
                        this.headers = headers;
                        return this;
                    },
                    end(body = '') {
                        this.body += body;
                        this.ended = true;
                        current.events.push('callback');
                        return this;
                    },
                };
                current.responses.push(response);
                current.servers.at(-1).handler({ url: callback.pathname + callback.search }, response);
            },
            onExchange() {
                current.events.push('exchanging');
            },
        });
    }

    function assertCallback(valid) {
        assert.equal(current.servers.length, 1);
        assert.equal(current.servers[0].closed, true, 'the callback server must close when login settles');
        assert.equal(current.responses.length, 1);
        const response = current.responses[0];
        assert.equal(response.ended, true, 'the browser must receive a complete callback response');
        assert.doesNotMatch(response.body, /\bDone\b|signed[ -]in|sign-in (?:complete|finished|successful)/i);
        const received = 'Authorization code received. Return to the editor while sign-in finishes.';
        if (valid) {
            assert.equal(response.status, 200);
            assert.ok(response.body.includes(received), 'the callback must not claim that token exchange has completed');
        } else {
            assert.doesNotMatch(response.body, /Authorization code received|\bsuccess(?:ful)?\b/i, 'a rejected callback must not claim that its code was accepted');
        }
    }

    function assertRequest(grantType, timeoutMs) {
        assert.equal(current.requests.length, 1);
        assert.equal(current.timeouts.length, 1, 'postForm must create a timeout signal');
        assert.equal(current.timeouts[0].ms, timeoutMs);
        const request = current.requests[0];
        assert.equal(request.options.signal, current.timeouts[0].signal, 'fetch must receive the token deadline signal');
        assert.equal(request.form.get('grant_type'), grantType);
        assert.equal(request.form.get('client_id'), auth.CLIENT_ID);
        return request;
    }

    reset();
    const payload = {
        access_token: 'synthetic-new-access',
        refresh_token: 'synthetic-new-refresh',
        id_token: 'synthetic-new-id',
        account_id: 'synthetic-new-account',
        expires_in: 3_600,
    };
    fetchReply = () => reply(200, JSON.stringify(payload));
    const beforeLogin = Date.now();
    const stored = await bounded('successful code exchange', startLogin());
    assert.deepEqual(current.events, ['authorize', 'callback', 'exchanging', 'fetch'], 'exchange progress must follow a validated callback and precede fetch');
    assertCallback(true);
    const exchangeRequest = assertRequest('authorization_code', 30_000);
    assert.equal(exchangeRequest.form.get('code'), 'synthetic-authorization-code');
    assert.equal(exchangeRequest.form.get('redirect_uri'), current.redirect.href);
    const verifier = exchangeRequest.form.get('code_verifier');
    assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
    assert.equal(current.authorize.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(current.authorize.searchParams.get('code_challenge'), createHash('sha256').update(verifier).digest('base64url'));
    assert.deepEqual(stored, {
        access_token: payload.access_token,
        refresh_token: payload.refresh_token,
        id_token: payload.id_token,
        account_id: payload.account_id,
        expires_at: stored.expires_at,
        source: 'vannevar',
    });
    assert.ok(stored.expires_at >= beforeLogin + 3_600_000 && stored.expires_at <= Date.now() + 3_600_000);
    assert.deepEqual(auth.readStore(), stored);
    assert.deepEqual(JSON.parse(readFileSync(auth.STORE, 'utf8')), stored, 'successful login must persist its synthetic tokens');

    const previous = {
        access_token: 'synthetic-old-access',
        refresh_token: 'synthetic-old-refresh',
        id_token: 'synthetic-old-id',
        account_id: 'synthetic-old-account',
        expires_at: Date.now() - 1_000,
        source: 'vannevar',
    };
    auth.writeStore(previous);
    const previousText = readFileSync(auth.STORE, 'utf8');
    const assertUnchanged = () => {
        assert.equal(readFileSync(auth.STORE, 'utf8'), previousText, 'a failed login or refresh must leave the previous store untouched');
        assert.deepEqual(auth.readStore(), previous);
    };

    for (const [label, params, expected] of [
        ['bad state', { state: 'synthetic-wrong-state' }, /state mismatch/],
        ['OAuth rejection with a code', { error: 'access_denied' }, /access_denied/],
        ['missing code', { code: null }, /no authorization code/],
    ]) {
        reset();
        await assert.rejects(bounded(label, startLogin(params)), expected);
        assert.deepEqual(current.events, ['authorize', 'callback'], 'rejected callbacks must not start token exchange');
        assert.equal(current.requests.length, 0);
        assert.equal(current.timeouts.length, 0);
        assertCallback(false);
        assertUnchanged();
    }

    reset();
    await assert.rejects(bounded('callback timeout', startLogin(null, { timeoutMs: tokenTimeoutMs })), /timed out waiting for sign-in/);
    assert.deepEqual(current.events, ['authorize']);
    assert.equal(current.servers[0].closed, true);
    assert.equal(current.requests.length, 0);
    assertUnchanged();

    reset();
    fetchReply = () => { throw transportError(); };
    await assert.rejects(bounded('login transport failure', startLogin({}, { tokenTimeoutMs })), /ECONNRESET/);
    assert.deepEqual(current.events, ['authorize', 'callback', 'exchanging', 'fetch']);
    assertCallback(true);
    assertRequest('authorization_code', tokenTimeoutMs);
    assertUnchanged();

    for (const phase of ['headers', 'body']) {
        reset();
        let bodyReads = 0;
        fetchReply = ({ options }) => phase === 'headers' ? waitForAbort(options.signal) : {
            ok: true,
            status: 200,
            text() {
                bodyReads++;
                return waitForAbort(options.signal);
            },
        };
        await assert.rejects(bounded(`login ${phase} timeout`, startLogin({}, { tokenTimeoutMs })), /TimeoutError/);
        assertCallback(true);
        const request = assertRequest('authorization_code', tokenTimeoutMs);
        assert.equal(request.options.signal.aborted, true, 'the implementation deadline, not just the watchdog, must abort fetch');
        assert.equal(request.options.signal.reason.name, 'TimeoutError');
        assert.equal(bodyReads, phase === 'body' ? 1 : 0);
        assertUnchanged();
    }

    for (const failure of ['http', 'transport', 'headers', 'body']) {
        reset();
        let bodyReads = 0;
        fetchReply = ({ options }) => {
            if (failure === 'http') return reply(401, 'synthetic refresh rejected');
            if (failure === 'transport') throw transportError();
            if (failure === 'headers') return waitForAbort(options.signal);
            return {
                ok: true,
                status: 200,
                text() {
                    bodyReads++;
                    return waitForAbort(options.signal);
                },
            };
        };
        const expected = failure === 'http' ? /token endpoint 401: synthetic refresh rejected/ :
            failure === 'transport' ? /ECONNRESET/ : /TimeoutError/;
        const attempt = failure === 'http' ? auth.getAuth({ refreshSkewMs: 0 }) : auth.refresh(previous);
        await assert.rejects(bounded(`refresh ${failure} failure`, attempt), expected);
        assert.deepEqual(current.events, ['fetch']);
        assert.equal(current.servers.length, 0, 'refresh must not start an interactive callback server');
        const request = assertRequest('refresh_token', 30_000);
        assert.equal(request.form.get('refresh_token'), previous.refresh_token);
        if (failure === 'headers' || failure === 'body') {
            assert.equal(request.options.signal.aborted, true, 'the refresh deadline must abort both headers and body');
            assert.equal(request.options.signal.reason.name, 'TimeoutError');
        }
        assert.equal(bodyReads, failure === 'body' ? 1 : 0);
        assertUnchanged();
    }
    assert.equal(browserSpawns.length, 0, 'onAuthorize must suppress actual browser launches');

    const cli = path.join(home, 'cli');
    mkdirSync(path.join(cli, 'proxy'), { recursive: true });
    copyFileSync(new URL('../runtime/login-chatgpt.mjs', import.meta.url), path.join(cli, 'login-chatgpt.mjs'));
    writeFileSync(path.join(cli, 'proxy', 'auth-chatgpt.mjs'), `
const padding = 'x'.repeat(128 * 1024);
export const STORE = 'synthetic-cli-store';
export const CODEX_AUTH = 'synthetic-cli-codex-store';
export const readStore = () => null;
export const status = () => ({ loggedIn: false });
export const refresh = () => { throw Error('unexpected CLI refresh'); };
// Force an asynchronous terminal write even on platforms with synchronous stdout pipes.
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, encoding, callback) => {
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    if (String(chunk).includes('"event":"signed-in"') || String(chunk).includes('"event":"error"')) {
        setTimeout(() => write(chunk, encoding, callback), 25);
        return true;
    }
    return write(chunk, encoding, callback);
};
export async function login({ onAuthorize, onExchange } = {}) {
    setInterval(() => {}, 1000);
    onAuthorize?.('https://authorize.invalid/synthetic');
    onExchange?.();
    if (process.env.CCX_AUTH_TEST_RESULT === 'error') throw Error('synthetic CLI failure ' + padding);
    return { account_id: 'synthetic-cli-account-' + padding };
}
`, 'utf8');

    for (const result of ['success', 'error']) {
        const child = childProcess.spawnSync(process.execPath, [path.join(cli, 'login-chatgpt.mjs'), '--json'], {
            cwd: cli,
            encoding: 'utf8',
            timeout: 3_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            env: { ...process.env, HOME: home, USERPROFILE: home, NODE_OPTIONS: '', CCX_AUTH_TEST_RESULT: result },
        });
        assert.equal(child.error, undefined, `JSON CLI ${result} must exit despite referenced handles: ${child.error?.message}`);
        assert.equal(child.signal, null);
        assert.equal(child.status, result === 'success' ? 0 : 1);
        assert.equal(child.stderr, '');
        assert.ok(child.stdout.endsWith('\n'), 'the terminal JSON event must be flushed with its newline before exit');
        const events = child.stdout.slice(0, -1).split('\n').map((line) => JSON.parse(line));
        assert.deepEqual(events.map((event) => event.event), ['authorize', 'exchanging', result === 'success' ? 'signed-in' : 'error']);
        assert.equal(events[0].url, 'https://authorize.invalid/synthetic');
        if (result === 'success') {
            assert.equal(events[2].accountId, 'synthetic-cli-account-' + 'x'.repeat(128 * 1024));
            assert.equal(events[2].store, 'synthetic-cli-store');
        } else {
            assert.equal(events[2].message, 'synthetic CLI failure ' + 'x'.repeat(128 * 1024));
        }
    }
} finally {
    os.homedir = original.homedir;
    http.createServer = original.createServer;
    http.request = original.httpRequest;
    http.get = original.httpGet;
    https.request = original.httpsRequest;
    https.get = original.httpsGet;
    childProcess.spawn = original.spawn;
    globalThis.fetch = original.fetch;
    AbortSignal.timeout = original.timeout;
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
}

console.log('OK - ChatGPT OAuth validates callbacks, bounds token requests, preserves failed stores and exits after complete JSON events');

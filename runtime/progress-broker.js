'use strict';

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const path = require('path');

const PROTOCOL = 2;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_BUFFER_BYTES = 64 * 1024;
const ACK_TIMEOUT_MS = 2000;
const MAX_CONNECTIONS_PER_CAPABILITY = 2;
const CONNECTION_RATE = 5;
const CAPABILITY_RATE = 10;
const CAPABILITY_SUSTAINED_RATE = 2;
const RATE_WINDOW_MS = 1000;
const DEFAULT_SCOPE_LIFETIME_MS = 4 * 60 * 60 * 1000;
const MIN_SCOPE_LIFETIME_MS = 30 * 60 * 1000;
const MAX_SCOPE_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CIRCUIT_THRESHOLD = 3;
const CIRCUIT_WINDOW_MS = 60 * 1000;
const CIRCUIT_COOLDOWN_MS = 60 * 1000;

function randomId(bytes = 16) {
    return crypto.randomBytes(bytes).toString('hex');
}

function boundedText(value, max) {
    return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function normalizePlan(plan) {
    if (!Array.isArray(plan)) return undefined;
    return plan.slice(0, 50).map((item) => boundedText(item, 160)).filter((item) => item !== undefined);
}

function normalizeReport(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const { done, total } = input;
    if (!Number.isInteger(total) || total < 1 || total > 50 || !Number.isInteger(done) || done < 0 || done > total) return null;
    const report = { done, total };
    const title = boundedText(input.title, 80);
    if (title !== undefined && title.trim()) report.title = title.trim();
    const note = boundedText(input.note, 240);
    if (note !== undefined) report.note = note;
    const plan = normalizePlan(input.plan);
    if (plan !== undefined) report.plan = plan;
    report.replan = input.replan === true;
    return report;
}

function endpointPath() {
    if (process.platform === 'win32') return `\\\\.\\pipe\\vpr-${process.pid}-${randomId(4)}`;
    const endpoint = path.join(os.tmpdir(), `vpr-${process.pid}-${randomId(4)}.sock`);
    if (Buffer.byteLength(endpoint) >= 104) throw new Error('progress socket path is too long');
    return endpoint;
}

function createProgressBroker(options = {}) {
    const instanceId = randomId();
    let endpoint = options.endpoint || endpointPath();
    const now = options.now || Date.now;
    const capabilities = new Map();
    const sessionIssues = new Map();
    const scopeIssues = new Map();
    const roots = new Map();
    const scopes = new Map();
    const nativeScopes = new Map();
    const nativeClassifiers = new Map();
    const revisions = new Map();
    const listeners = new Set();
    const connections = new Set();
    const connectionCounts = new Map();
    const rateWindows = new Map();
    const capabilityBuckets = new Map();
    const crashes = [];
    let closed = false;
    let expectedClose = false;
    let circuitOpenUntil = 0;
    let restartTimer = null;
    let halfOpen = false;
    let server;

    function hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }

    function emit(sessionId, payload, type = 'delta') {
        const revision = (revisions.get(sessionId) || 0) + 1;
        revisions.set(sessionId, revision);
        const event = { type, sessionId, revision, payload };
        for (const listener of listeners) {
            try { listener(event); } catch {}
        }
    }

    function snapshot(sessionId) {
        const semanticByScope = {};
        for (const [scopeId, record] of scopes) {
            if (record.ownerSession === sessionId && record.semantic) semanticByScope[scopeId] = { ...record.semantic };
        }
        return {
            root: roots.has(sessionId) ? { ...roots.get(sessionId) } : null,
            semanticByScope,
            nativeScopes: { ...(nativeScopes.get(sessionId) || {}) },
            nativeSemanticStatus: nativeClassifiers.get(sessionId)?.status || 'disabled',
            health: { available: !closed, circuitOpen: now() < circuitOpenUntil },
        };
    }

    function issueCapability(kind, key, ownerSession, scopeId, lifetimeMs) {
        const cache = kind === 'session' ? sessionIssues : scopeIssues;
        const current = cache.get(key);
        if (current) {
            const record = capabilities.get(current.hash);
            if (record && !record.revokedAt && (!record.expiresAt || record.expiresAt > now()))
                return { capability: current.token, expiresAt: record.expiresAt };
        }
        const token = crypto.randomBytes(32).toString('base64url');
        const hash = hashToken(token);
        const expiresAt = lifetimeMs ? now() + lifetimeMs : null;
        capabilities.set(hash, { hash, token, kind, ownerSession, scopeId, brokerInstanceId: instanceId, issuedAt: now(), expiresAt });
        cache.set(key, { token, hash });
        return { capability: token, expiresAt };
    }

    function issueSessionCapability(sessionId) {
        if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
        return issueCapability('session', sessionId, sessionId, null, 0);
    }

    function issueScopeCapability(scopeId, ownerSession, lifetimeMs = DEFAULT_SCOPE_LIFETIME_MS) {
        if (typeof scopeId !== 'string' || !scopeId || typeof ownerSession !== 'string' || !ownerSession)
            throw new TypeError('scopeId and ownerSession are required');
        const existingScope = scopes.get(scopeId);
        if (existingScope && existingScope.ownerSession !== ownerSession) throw new Error('scope owner mismatch');
        if (existingScope && existingScope.expiresAt <= now()) throw new Error('scope expired');
        const ttl = Math.max(MIN_SCOPE_LIFETIME_MS, Math.min(MAX_SCOPE_LIFETIME_MS, Number(lifetimeMs) || DEFAULT_SCOPE_LIFETIME_MS));
        scopes.set(scopeId, existingScope || { scopeId, ownerSession, expiresAt: now() + ttl, semantic: null, planVersion: 0 });
        return issueCapability('scope', scopeId, ownerSession, scopeId, ttl);
    }

    function revokeCapability(capHash) {
        const record = capabilities.get(capHash);
        if (!record || record.revokedAt) return false;
        record.revokedAt = now();
        if (record.kind === 'session') sessionIssues.delete(record.ownerSession);
        else scopeIssues.delete(record.scopeId);
        for (const socket of connections) if (socket.capabilityHash === capHash) socket.destroy();
        return true;
    }

    function observeRoot(input) {
        if (!input || typeof input.sessionId !== 'string' || !input.sessionId || typeof input.rootId !== 'string') return false;
        const previous = roots.get(input.sessionId);
        roots.set(input.sessionId, {
            rootId: input.rootId,
            state: boundedText(input.state, 20) || 'running',
            startedAt: Number.isFinite(input.startedAt) ? input.startedAt : now(),
            generation: input.generation || randomId(8),
            semantic: previous && previous.rootId === input.rootId ? previous.semantic : null,
            planVersion: previous && previous.rootId === input.rootId ? previous.planVersion : 0,
        });
        for (const socket of connections) {
            if (socket.hello && socket.principal.kind === 'session' && socket.principal.ownerSession === input.sessionId)
                socket.write(JSON.stringify({ type: 'rootChanged', rootId: roots.get(input.sessionId).rootId, rootGeneration: roots.get(input.sessionId).generation }) + '\n');
        }
        emit(input.sessionId, { changedRoot: roots.get(input.sessionId).semantic || null });
        return true;
    }

    function finishRoot(input) {
        if (!input || !roots.has(input.sessionId)) return false;
        const root = roots.get(input.sessionId);
        if (input.rootId && root.rootId !== input.rootId) return false;
        roots.delete(input.sessionId);
        emit(input.sessionId, { changedRoot: null });
        return true;
    }

    function createDelegatedScope(input) {
        if (!input || typeof input.scopeId !== 'string' || typeof input.ownerSession !== 'string') throw new TypeError('scopeId and ownerSession are required');
        const issued = issueScopeCapability(input.scopeId, input.ownerSession, input.lifetimeMs);
        const record = scopes.get(input.scopeId);
        return { scopeId: record.scopeId, ownerSession: record.ownerSession, expiresAt: record.expiresAt, capability: issued.capability };
    }

    function closeScope(scopeId) {
        const scope = scopes.get(scopeId);
        if (!scope) return false;
        scopes.delete(scopeId);
        const issued = scopeIssues.get(scopeId);
        if (issued) revokeCapability(issued.hash);
        emit(scope.ownerSession, { changedScopes: { [scopeId]: null } });
        return true;
    }

    function onChange(listener) {
        if (typeof listener !== 'function') throw new TypeError('listener must be a function');
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function metrics() {
        return {
            activeCapabilities: [...capabilities.values()].filter((item) => !item.revokedAt && (!item.expiresAt || item.expiresAt > now())).length,
            activeScopes: scopes.size,
            activeConnections: connections.size,
            circuitOpen: now() < circuitOpenUntil,
            protocol: PROTOCOL,
        };
    }

    function recordUnexpectedExit() {
        if (expectedClose) return;
        const time = now();
        crashes.push(time);
        while (crashes.length && crashes[0] < time - CIRCUIT_WINDOW_MS) crashes.shift();
        if (crashes.length >= CIRCUIT_THRESHOLD) {
            circuitOpenUntil = time + CIRCUIT_COOLDOWN_MS;
            halfOpen = true;
        }
        clearTimeout(restartTimer);
        const delay = Math.max(0, circuitOpenUntil - time);
        restartTimer = setTimeout(() => {
            restartTimer = null;
            if (!closed) server.listen(endpoint);
        }, delay);
        restartTimer.unref?.();
    }

    function authorize(token) {
        if (typeof token !== 'string') return null;
        const hash = hashToken(token);
        const record = capabilities.get(hash);
        if (!record || record.token !== token || record.revokedAt || (record.expiresAt && record.expiresAt <= now())) return null;
        return { ...record, hash };
    }

    function allowedRate(hash, connection) {
        const time = now();
        const connectionKey = `connection:${connection}`;
        const connectionTimes = rateWindows.get(connectionKey) || [];
        while (connectionTimes.length && connectionTimes[0] <= time - RATE_WINDOW_MS) connectionTimes.shift();
        if (connectionTimes.length >= CONNECTION_RATE) return false;

        // The capability bucket survives reconnects and refills independently of connection windows.
        const bucket = capabilityBuckets.get(hash) || { tokens: CAPABILITY_RATE, updatedAt: time };
        bucket.tokens = Math.min(CAPABILITY_RATE, bucket.tokens + Math.max(0, time - bucket.updatedAt) * CAPABILITY_SUSTAINED_RATE / RATE_WINDOW_MS);
        bucket.updatedAt = time;
        if (bucket.tokens < 1) {
            capabilityBuckets.set(hash, bucket);
            return false;
        }

        // Debit both budgets only after both gates pass; neither rejection spends the other budget.
        connectionTimes.push(time);
        rateWindows.set(connectionKey, connectionTimes);
        bucket.tokens -= 1;
        capabilityBuckets.set(hash, bucket);
        return true;
    }

    function applyReport(principal, message, socket) {
        const report = normalizeReport(message);
        if (!report) return { accepted: false, reason: 'invalid_report' };
        const currentRoot = principal.kind === 'session' ? roots.get(principal.ownerSession) : null;
        let target;
        if (principal.kind === 'session') {
            if (!currentRoot || message.rootGeneration !== currentRoot.generation) return { accepted: false, reason: 'stale_generation', currentGeneration: currentRoot && currentRoot.generation };
            target = currentRoot;
        } else {
            target = scopes.get(principal.scopeId);
            if (!target || target.expiresAt <= now()) return { accepted: false, reason: 'scope_closed' };
            if (message.scope && message.scope !== principal.scopeId) return { accepted: false, reason: 'scope_mismatch' };
        }
        if (target.semantic) {
            if (report.replan) target.planVersion++;
            else {
                if (report.total !== target.semantic.total) return { accepted: false, reason: 'total_changed' };
                if (report.done < target.semantic.done) return { accepted: false, reason: 'progress_decreased' };
                if (report.plan && target.semantic.plan && JSON.stringify(report.plan) !== JSON.stringify(target.semantic.plan))
                    return { accepted: false, reason: 'plan_changed' };
            }
        } else if (report.replan) {
            target.planVersion++;
        }
        const semantic = { ...report, planVersion: target.planVersion };
        if (target.semantic && semantic.title === undefined && target.semantic.title !== undefined)
            semantic.title = target.semantic.title;
        if (!report.replan && report.plan === undefined && target.semantic && target.semantic.plan !== undefined)
            semantic.plan = target.semantic.plan;
        target.semantic = semantic;
        if (principal.kind === 'session') emit(principal.ownerSession, { changedRoot: target.semantic });
        else emit(principal.ownerSession, { changedScopes: { [principal.scopeId]: target.semantic } });
        return { accepted: true };
    }

    function handleConnection(socket) {
        socket.setEncoding('utf8');
        socket.buffer = '';
        socket.hello = false;
        socket.connectionId = randomId(8);
        socket.timer = setTimeout(() => socket.destroy(), ACK_TIMEOUT_MS);
        socket.timer.unref?.();
        connections.add(socket);
        socket.on('data', (chunk) => {
            socket.buffer += chunk;
            if (Buffer.byteLength(socket.buffer) > MAX_BUFFER_BYTES) return socket.destroy();
            let newline;
            while ((newline = socket.buffer.indexOf('\n')) >= 0) {
                const line = socket.buffer.slice(0, newline);
                socket.buffer = socket.buffer.slice(newline + 1);
                if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return socket.destroy();
                let message;
                try { message = JSON.parse(line); } catch { return socket.destroy(); }
                if (!message || typeof message !== 'object' || Array.isArray(message)) return socket.destroy();
                if (!socket.hello) {
                    const principal = authorize(message.cap);
                    if (message.type !== 'hello' || message.protocol !== PROTOCOL || !principal) {
                        socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: message.protocol !== PROTOCOL ? 'unsupported_protocol' : 'unauthorized', serverProtocol: PROTOCOL }) + '\n');
                        return socket.destroy();
                    }
                    const count = connectionCounts.get(principal.hash) || 0;
                    if (count >= MAX_CONNECTIONS_PER_CAPABILITY) return socket.destroy();
                    socket.hello = true;
                    socket.principal = principal;
                    socket.capabilityHash = principal.hash;
                    connectionCounts.set(principal.hash, count + 1);
                    clearTimeout(socket.timer);
                    const root = principal.kind === 'session' ? roots.get(principal.ownerSession) : null;
                    socket.write(JSON.stringify({ type: 'helloAck', protocol: PROTOCOL, brokerInstanceId: instanceId, ownerSession: principal.ownerSession,
                        scope: principal.scopeId || null, rootId: root ? root.rootId : null, rootGeneration: root ? root.generation : null }) + '\n');
                    continue;
                }
                if (message.type === 'createScope') {
                    if (socket.principal.kind !== 'session' || typeof message.scopeId !== 'string' || !message.scopeId) {
                        socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: 'invalid_scope_request' }) + '\n');
                        continue;
                    }
                    const scope = scopes.get(message.scopeId);
                    if (scope && scope.ownerSession !== socket.principal.ownerSession) {
                        socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: 'scope_owner_mismatch' }) + '\n');
                        continue;
                    }
                    const created = createDelegatedScope({ scopeId: message.scopeId, ownerSession: socket.principal.ownerSession, lifetimeMs: message.lifetimeMs });
                    socket.write(JSON.stringify({ type: 'scopeAck', accepted: true, scopeId: created.scopeId, capability: created.capability, expiresAt: created.expiresAt }) + '\n');
                    continue;
                }
                if (message.type === 'closeScope') {
                    // A delegated scope is closed by its owning session, never by the scope itself and
                    // never by another session; the untrusted scopeId is resolved against that owner
                    // rather than trusted on its own.
                    if (socket.principal.kind !== 'session' || typeof message.scopeId !== 'string' || !message.scopeId) {
                        socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: 'invalid_scope_request' }) + '\n');
                        continue;
                    }
                    const scope = scopes.get(message.scopeId);
                    if (!scope) {
                        socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: 'scope_closed' }) + '\n');
                        continue;
                    }
                    if (scope.ownerSession !== socket.principal.ownerSession) {
                        socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: 'scope_owner_mismatch' }) + '\n');
                        continue;
                    }
                    closeScope(message.scopeId);
                    socket.write(JSON.stringify({ type: 'ack', accepted: true, scopeId: message.scopeId }) + '\n');
                    continue;
                }
                if (!allowedRate(socket.capabilityHash, socket.connectionId)) {
                    socket.write(JSON.stringify({ type: 'ack', accepted: false, reason: 'rate_limited' }) + '\n');
                    continue;
                }
                const classifier = socket.principal.kind === 'session' && nativeClassifiers.get(socket.principal.ownerSession);
                if (classifier && classifier.enabled()) {
                    const decision = message.engine === 'claudecode' && typeof message.toolUseId === 'string'
                        ? classifier.classify(message.toolUseId) : { accepted: false, reason: 'unattributed_call' };
                    if (!decision.root) {
                        socket.write(JSON.stringify({ type: 'ack', ...decision }) + '\n');
                        continue;
                    }
                }
                const result = applyReport(socket.principal, message, socket);
                socket.write(JSON.stringify({ type: 'ack', ...result }) + '\n');
            }
        });
        socket.on('close', () => {
            clearTimeout(socket.timer);
            connections.delete(socket);
            if (socket.capabilityHash) connectionCounts.set(socket.capabilityHash, Math.max(0, (connectionCounts.get(socket.capabilityHash) || 1) - 1));
        });
        socket.on('error', () => {});
    }

    server = net.createServer(handleConnection);
    server.on('listening', () => {
        if (halfOpen) {
            halfOpen = false;
            circuitOpenUntil = 0;
            crashes.length = 0;
        }
    });
    server.on('error', (error) => {
        if (closed) return;
        if (error.code === 'EADDRINUSE') {
            endpoint = endpointPath();
            server.listen(endpoint);
            return;
        }
        recordUnexpectedExit();
    });
    server.on('close', () => {
        if (!closed && !expectedClose) recordUnexpectedExit();
    });
    if (options.listen !== false) server.listen(endpoint);

    return {
        info() { return { endpoint, instanceId, protocol: PROTOCOL }; },
        setNativeClassifier(sessionId, classify, status = 'supported_initial_attempt', enabled = () => true) {
            nativeScopes.delete(sessionId);
            nativeClassifiers.set(sessionId, { classify, status, enabled });
        },
        setNativeStatus(sessionId, status) {
            const classifier = nativeClassifiers.get(sessionId);
            if (classifier) classifier.status = status;
            emit(sessionId, { nativeSemanticStatus: status });
        },
        bindNativeScope(sessionId, taskId, runId, scopeId) {
            const mapping = nativeScopes.get(sessionId) || {};
            mapping[taskId] = { runId, scopeId };
            nativeScopes.set(sessionId, mapping);
            emit(sessionId, { nativeScopes: { ...mapping } });
        },
        issueSessionCapability,
        issueScopeCapability,
        revokeCapability,
        observeRoot,
        finishRoot,
        createDelegatedScope,
        closeScope,
        snapshot,
        onChange,
        metrics,
        close() {
            if (closed) return;
            closed = true;
            expectedClose = true;
            clearTimeout(restartTimer);
            for (const socket of connections) socket.destroy();
            capabilities.clear();
            sessionIssues.clear();
            scopeIssues.clear();
            scopes.clear();
            roots.clear();
            listeners.clear();
            if (server.listening) server.close();
        },
    };
}

module.exports = {
    createProgressBroker,
    PROTOCOL,
    MAX_FRAME_BYTES,
    MAX_BUFFER_BYTES,
    ACK_TIMEOUT_MS,
    DEFAULT_SCOPE_LIFETIME_MS,
    CIRCUIT_THRESHOLD,
    CIRCUIT_WINDOW_MS,
    CIRCUIT_COOLDOWN_MS,
};

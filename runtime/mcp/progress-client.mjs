import net from 'node:net';

export const PROTOCOL = 2;
export const ACK_TIMEOUT_MS = 2000;
export const CONNECT_TIMEOUT_MS = 250;
const MAX_FRAME_BYTES = 16 * 1024;
const MAX_BUFFER_BYTES = 64 * 1024;
const REASONS = new Set(['stale_generation', 'unsupported_protocol', 'invalid_report',
    'scope_mismatch', 'scope_closed', 'total_changed', 'progress_decreased', 'plan_changed',
    'rate_limited', 'invalid_scope_request', 'scope_owner_mismatch',
    'unsupported_resume', 'unresolved_attempt', 'closed_attempt',
    'unattributed_call', 'unrecorded_call']);

// Credentials belong to the calling process, never to profiles or on-disk discovery.
export class ProgressClient {
    #context;
    #generation = null;
    #endpoint = null;
    #sockets = new Set();
    #closed = false;

    constructor(processContext = process.env) {
        this.#context = processContext;
    }

    report(input) {
        return this.request({ ...input, type: 'report' });
    }

    request(input) {
        const context = this.#context;
        const endpoint = context.endpoint ?? context.VANNEVAR_PROGRESS_ENDPOINT;
        const protocol = Number(context.protocol ?? context.VANNEVAR_PROGRESS_PROTOCOL);
        const capability = context.capability ?? context.VANNEVAR_PROGRESS_CAPABILITY ?? context.VANNEVAR_PROGRESS_CAP;
        const unavailable = () => ({ ok: false, accepted: false, reason: 'telemetry_unavailable' });
        if (this.#closed || this.#sockets.size >= 2 || typeof endpoint !== 'string' || !endpoint ||
            typeof capability !== 'string' || !capability) return Promise.resolve(unavailable());
        if (protocol !== PROTOCOL) return Promise.resolve({ ok: false, accepted: false,
            reason: 'unsupported_protocol', clientProtocol: PROTOCOL,
            serverProtocol: Number.isSafeInteger(protocol) ? protocol : null });
        // Do not carry a root generation into a different broker endpoint.
        if (this.#endpoint !== endpoint) {
            this.#endpoint = endpoint;
            this.#generation = null;
        }
        let payload;
        try {
            if (!input || typeof input !== 'object' || Array.isArray(input)) return Promise.resolve(unavailable());
            const { type = 'report', done, total, title, note, plan, replan, scope, scopeId, lifetimeMs } = input;
            if (!['report', 'createScope', 'closeScope'].includes(type)) return Promise.resolve(unavailable());
            payload = { type, done, total, title, note, plan, replan, scope, scopeId, lifetimeMs,
                engine: input.engine, toolUseId: input.toolUseId };
            if (Buffer.byteLength(JSON.stringify(payload)) > MAX_FRAME_BYTES - 1024) return Promise.resolve(unavailable());
        } catch { return Promise.resolve(unavailable()); }

        return new Promise((resolve) => {
            let socket;
            let buffer = '';
            let hello = false;
            let settled = false;
            let connectTimer;
            const deadline = setTimeout(() => finish(unavailable()), ACK_TIMEOUT_MS);
            const finish = (result) => {
                if (settled) return;
                settled = true;
                clearTimeout(deadline);
                clearTimeout(connectTimer);
                this.#sockets.delete(socket);
                socket?.destroy();
                resolve(result);
            };
            const send = (message) => {
                const line = JSON.stringify(message) + '\n';
                if (Buffer.byteLength(line) - 1 > MAX_FRAME_BYTES) return finish(unavailable());
                socket.write(line);
            };
            try {
                socket = net.createConnection(endpoint);
                this.#sockets.add(socket);
                connectTimer = setTimeout(() => finish(unavailable()), CONNECT_TIMEOUT_MS);
                socket.setEncoding('utf8');
                socket.on('connect', () => {
                    clearTimeout(connectTimer);
                    send({ type: 'hello', protocol: PROTOCOL, cap: capability, pid: process.pid });
                });
                socket.on('data', (chunk) => {
                    if (settled) return;
                    buffer += chunk;
                    if (Buffer.byteLength(buffer) > MAX_BUFFER_BYTES) return finish(unavailable());
                    let newline;
                    while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
                        const line = buffer.slice(0, newline);
                        buffer = buffer.slice(newline + 1);
                        if (Buffer.byteLength(line) > MAX_FRAME_BYTES) return finish(unavailable());
                        let message;
                        try { message = JSON.parse(line); } catch { return finish(unavailable()); }
                        if (!message || typeof message !== 'object' || Array.isArray(message)) return finish(unavailable());
                        if (message.reason === 'unsupported_protocol' ||
                            (message.type === 'helloAck' && message.protocol !== PROTOCOL)) {
                            return finish({ ok: false, accepted: false, reason: 'unsupported_protocol',
                                clientProtocol: PROTOCOL, serverProtocol: Number.isSafeInteger(message.serverProtocol ?? message.protocol)
                                    ? (message.serverProtocol ?? message.protocol) : null });
                        }
                        if (!hello) {
                            if (message.type !== 'helloAck') return finish(unavailable());
                            hello = true;
                            this.#generation = message.rootGeneration ?? null;
                            send({ ...payload, rootGeneration: this.#generation });
                        } else if (message.type === 'rootChanged') {
                            this.#generation = message.rootGeneration ?? null;
                        } else if (message.type === 'ack' || message.type === 'scopeAck') {
                            if (message.reason === 'stale_generation') {
                                // Cache only: this payload must never be replayed into the new root.
                                this.#generation = message.currentGeneration ?? null;
                            }
                            if (message.accepted !== true) return finish({ ok: false, accepted: false,
                                reason: REASONS.has(message.reason) ? message.reason : 'telemetry_unavailable' });
                            const result = { ok: true, accepted: true };
                            if (Number.isSafeInteger(message.planVersion)) result.planVersion = message.planVersion;
                            if (message.type === 'scopeAck') {
                                result.scopeId = message.scopeId;
                                result.capability = message.capability;
                                result.expiresAt = message.expiresAt;
                            }
                            return finish(result);
                        } else return finish(unavailable());
                    }
                    if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) finish(unavailable());
                });
                socket.on('error', () => finish(unavailable()));
                socket.on('close', () => finish(unavailable()));
            } catch { finish(unavailable()); }
        });
    }

    close() {
        this.#closed = true;
        for (const socket of this.#sockets) socket.destroy();
    }
}

export function createProgressClient(processContext) {
    return new ProgressClient(processContext);
}

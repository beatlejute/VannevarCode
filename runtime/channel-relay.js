'use strict';

// A channel plugin as this extension's own MCP server.
//
// A channel plugin is transport, not policy: it holds the credentials, polls its network and turns
// what arrives into `notifications/claude/channel`, while the session it belongs to only decides
// whether to accept them. That means the plugin can be spoken to by anybody who can start it — and
// the session is not special: it is one client. This module is another, which is what lets the
// extension answer for a tab without a session of its own: the question a tab is waiting on is
// already in this host's hands (the CLI asks the host, over the SDK's permission-prompt channel), and
// all that is missing is somewhere to send it and a way to hear the answer.
//
// What is deliberately not here: any notion of which plugin this is. The command, its arguments and
// the working directory come from the same discovery the Channels list uses, so Telegram is one
// plugin among several and nothing below names it.
//
// Exactly one process may poll for a given bot token, which is why this module is a singleton owner
// rather than a helper: whoever starts a second poller takes the channel away from the first. The
// plugin's own claim logic decides between sessions; a relay is marked on its command line so that a
// session's plugin can tell it apart from an orphan and leave it alone (see the sibling patch under
// the plugin's own directory).

const { spawn } = require('child_process');

// The marker the plugin's claim logic looks for: a relay owns the token on purpose, so a session
// must not treat it as an orphan and replace it.
const RELAY_FLAG = '--vannevar-relay';

// A plugin's own `.mcp.json` is written for the CLI, which substitutes this before spawning; anything
// else that starts the same server has to do it too, or the plugin is told to work in a directory
// whose name is the literal text.
function expandRoot(value, root) {
    return typeof value === 'string' ? value.split('${CLAUDE_PLUGIN_ROOT}').join(root || '') : value;
}

// A plugin's manifest names its runtime the way a shell would ("bun"), and the CLI resolves that
// against its own PATH — which is not this process's PATH, as the first attempt at running the
// Telegram plugin from the IDE showed (its fix was a hand-edited manifest; this is the version that
// leaves the manifest alone). The search mirrors the shell: PATH first, with the platform's
// extensions, then the runtime's own install directory.
function resolveCommand(command) {
    if (/[\/]/.test(command)) return command;
    const exts = process.platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
    const dirs = (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':');
    dirs.push(require('path').join(require('os').homedir(), '.bun', 'bin'));
    for (const dir of dirs) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = require('path').join(dir, command + ext);
            try {
                require('fs').accessSync(candidate);
                return candidate;
            } catch {}
        }
    }
    return command;
}

// Only this extension starts a plugin with the relay marker, so every process carrying it is one of
// ours — including one left behind by a crash, which is exactly what has to go before a new poller
// can have the token. The pristine plugin cannot clear up after itself on this platform (its own
// lookup shells out to a `ps` flag the bundled one lacks), so the relay does not rely on it to.
function sweepLeftovers(log) {
    try {
        const marker = RELAY_FLAG;
        if (process.platform === 'win32') {
            // Orphans only. Two windows both resume the channel after a reload, and a sweep that
            // killed every marker-bearing process would have them shooting each other's poller down
            // in rounds — the observed 21-second lives. A marker process whose parent is gone has no
            // window left to belong to; one whose parent is alive belongs to a running window and is
            // left to the token arbitration in the plugin.
            const out = require('child_process')
                .execFileSync('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*${marker}" } | ForEach-Object { $p = Get-Process -Id $_.ParentProcessId -ErrorAction SilentlyContinue; if (-not $p) { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $_.ProcessId } }`,
                ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
                .trim();
            if (out) log('relay swept leftover processes', out.split(/\r?\n/).join(' '));
        } else {
            require('child_process').execSync(`pkill -f ${marker}`, { stdio: 'ignore' });
            log('relay swept leftover processes');
        }
    } catch (e) {
        // A sweep that finds nothing is the common case on a clean start; one that fails entirely is
        // not fatal — the claim logic in the plugin still decides between live holders.
        log('relay sweep finished', (e && e.message) || '');
    }
}

class ChannelRelay {
    constructor(options) {
        this.command = options.command;
        this.args = (options.args || []).slice();
        this.cwd = options.cwd;
        this.env = options.env || process.env;
        this.log = options.log || function () {};
        this.child = null;
        this.started = null;
        this.nextId = 1;
        this.pending = new Map();
        this.buffer = '';
        this.handlers = { inbound: [], permission: [], exit: [] };
    }

    on(event, fn) {
        if (this.handlers[event]) this.handlers[event].push(fn);
        return this;
    }

    emit(event, payload) {
        for (const fn of this.handlers[event] || []) {
            try {
                fn(payload);
            } catch (e) {
                this.log('relay handler failed', event, (e && e.message) || String(e));
            }
        }
    }

    // The plugin is started exactly as a session starts it, plus the marker. Nothing is passed about
    // which network it is for or who may talk to it: the plugin reads its own token and its own
    // allowlist, and this side never sees either.
    start() {
        if (this.started) return this.started;
        this.started = new Promise((resolve, reject) => {
            sweepLeftovers(this.log);
            const args = this.args.map((arg) => expandRoot(arg, this.cwd)).concat([RELAY_FLAG]);
            this.log('relay start', this.command, args.join(' '));
            let child;
            try {
                child = spawn(resolveCommand(expandRoot(this.command, this.cwd)), args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
            } catch (e) {
                reject(e);
                return;
            }
            this.child = child;
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk) => this.feed(chunk));
            child.stderr.on('data', (chunk) => this.log('relay stderr', String(chunk).trim().slice(0, 400)));
            child.on('error', (e) => reject(e));
            child.on('exit', (code, signal) => {
                this.child = null;
                this.started = null;
                for (const [, entry] of this.pending) entry.reject(new Error('relay exited'));
                this.pending.clear();
                this.log('relay exit', code, signal);
                this.emit('exit', { code, signal });
            });
            this.request('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'vannevar', version: '1' },
            })
                .then(() => {
                    this.notify('notifications/initialized', {});
                    resolve(this);
                })
                .catch(reject);
        });
        return this.started;
    }

    stop() {
        const child = this.child;
        this.started = null;
        if (!child) return;
        try {
            child.stdin.end();
        } catch (e) {
            /* a stdin that is already gone is a process on its way out */
        }
        setTimeout(() => {
            try {
                // The plugin is a wrapper around a grandchild ("bun run … start" around "bun
                // server.ts"), and killing only the wrapper leaves the grandchild holding the bot
                // token. The tree kill takes both; the fallback is the old single kill.
                if (process.platform === 'win32') {
                    require('child_process').spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
                } else {
                    child.kill();
                }
            } catch (e) {
                /* already gone */
            }
        }, 1500).unref?.();
    }

    feed(chunk) {
        this.buffer += chunk;
        let index;
        while ((index = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (!line) continue;
            let message;
            try {
                message = JSON.parse(line);
            } catch (e) {
                this.log('relay unparseable line', line.slice(0, 200));
                continue;
            }
            this.dispatch(message);
        }
    }

    dispatch(message) {
        if (message.id !== undefined && (('result' in message) || ('error' in message))) {
            const entry = this.pending.get(message.id);
            if (!entry) return;
            this.pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.error.message || 'relay request failed'));
            else entry.resolve(message.result);
            return;
        }
        if (message.method === 'notifications/claude/channel') {
            const params = message.params || {};
            const meta = params.meta || {};
            this.emit('inbound', {
                text: typeof params.content === 'string' ? params.content : '',
                chatId: meta.chat_id,
                messageId: meta.message_id,
                user: meta.user,
                userId: meta.user_id,
                imagePath: meta.image_path,
                attachmentId: meta.attachment_file_id,
                ts: meta.ts,
            });
            return;
        }
        if (message.method === 'notifications/claude/channel/permission') {
            const params = message.params || {};
            this.log('relay got button answer', params.request_id, params.behavior);
            this.emit('permission', { requestId: params.request_id, behavior: params.behavior });
            return;
        }
        this.log('relay notification', message.method || 'unknown');
    }

    write(payload) {
        if (!this.child || !this.child.stdin.writable) throw new Error('relay is not running');
        this.child.stdin.write(JSON.stringify(payload) + '\n');
    }

    notify(method, params) {
        this.write({ jsonrpc: '2.0', method, params });
    }

    request(method, params) {
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.write({ jsonrpc: '2.0', id, method, params });
            } catch (e) {
                this.pending.delete(id);
                reject(e);
                return;
            }
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) reject(new Error(method + ' timed out'));
            }, 20000);
            timer.unref?.();
            this.pending.set(id, {
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
        });
    }

    // The plugin's tools are the same ones a session gets; `reply` is the one that matters here.
    callTool(name, args) {
        return this.request('tools/call', { name, arguments: args }).then((result) => {
            const text = result && Array.isArray(result.content)
                ? result.content.map((part) => (part && part.text) || '').join(' ')
                : '';
            if (result && result.isError) throw new Error(text || name + ' failed');
            return { text, raw: result };
        });
    }

    send(chatId, text, extra) {
        return this.callTool('reply', Object.assign({ chat_id: String(chatId), text: String(text) }, extra || {}));
    }

    // A permission question, phrased in the channel plugins' own contract: the server renders it —
    // buttons and all — to the chats its allowlist admits, and the answer comes back as a
    // `notifications/claude/channel/permission` with the same request id. The relay only carries the
    // question; what "allow" means is decided on this side, one outstanding request at a time.
    sendPermissionRequest(requestId, toolName, description, inputPreview) {
        this.notify('notifications/claude/channel/permission_request', {
            request_id: String(requestId),
            tool_name: String(toolName),
            description: String(description || ''),
            input_preview: String(inputPreview || ''),
        });
    }
}

module.exports = { ChannelRelay, RELAY_FLAG };

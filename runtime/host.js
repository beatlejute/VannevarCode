'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const vscode = require('vscode');

const HOME = os.homedir();
const DIR = path.join(HOME, '.claude', 'vannevar');
const PROFILES_DIR = path.join(HOME, '.claude', 'profiles');
const SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const ICONS_DIR = path.join(DIR, 'icons');
const BINDINGS_FILE = path.join(DIR, 'bindings.json');
const DEFAULT_PROFILE_FILE = path.join(DIR, 'default-profile.json');
const HIDDEN_FILE = path.join(DIR, 'hidden-messages.json');
const PINNED_FILE = path.join(DIR, 'pinned.json');
const HEALTH_FILE = path.join(DIR, 'agent-health.json');
const HISTORY_FILE = path.join(DIR, 'full-history.json');
const ICON_EXTENSIONS = ['png', 'svg'];
// An icon is inlined into the webview as base64 — past this size it is a mistake, not an icon
const MAX_ICON_BYTES = 512 * 1024;

// Several versions linger on disk after an update, so compare version numbers, not names
function versionOf(dirName) {
    const m = dirName.match(/anthropic\.claude-code-(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

// Where the extension folders are. ~/.vscode/extensions is only right in stock VS Code on this machine
// — Cursor, Windsurf and Insiders each keep their own root, and over Remote-SSH or WSL the bundle is
// under ~/.vscode-server on the remote host. The extension host already knows which one it loaded
// Claude Code from, so the root is the parent of that path and nothing has to be configured. This file
// runs inside the bundle it is asking about, so the API is always there; the home-directory guess is
// the last resort for a test harness that stubs `vscode` without it.
function extensionsRoot() {
    try {
        const running = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath;
        if (running) return path.dirname(running);
    } catch {}
    return path.join(HOME, '.vscode', 'extensions');
}

// Retired folders linger on disk until VS Code garbage-collects them, and .obsolete is what marks them.
// Skipping them matters for the update watcher, which reads "the newest folder is not the one this
// window is running" as an update having landed — an obsolete folder answering that question would send
// the patcher at a version nobody is about to load.
function newestExtensionDir({ includeObsolete = false } = {}) {
    const root = extensionsRoot();
    try {
        let obsolete = {};
        if (!includeObsolete) {
            try {
                obsolete = JSON.parse(fs.readFileSync(path.join(root, '.obsolete'), 'utf8')) || {};
            } catch {}
        }
        const dir = fs
            .readdirSync(root)
            .filter((d) => d.startsWith('anthropic.claude-code-') && !obsolete[d])
            .sort((a, b) => {
                const [x, y] = [versionOf(a), versionOf(b)];
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
            })
            .pop();
        return dir ? path.join(root, dir) : null;
    } catch {
        return null;
    }
}

// The extension flips the tab icon between these three on every rename_tab
const STOCK_LOGO = { idle: 'claude-logo.svg', done: 'claude-logo-done.svg', pending: 'claude-logo-pending.svg' };

function defaultIcon(state = 'idle') {
    // An icon is only a file to read, so an obsolete folder still serves it — better a stale logo than
    // none on the window that is running one
    const dir = newestExtensionDir() || newestExtensionDir({ includeObsolete: true });
    if (!dir) return null;
    const icon = path.join(dir, 'resources', STOCK_LOGO[state] || STOCK_LOGO.idle);
    return fs.existsSync(icon) ? icon : null;
}

const S = (globalThis.__ccxState ||= {
    webviews: new Set(),
    panels: new Map(),
    settingsWatcher: null,
    bindingsWatcher: null,
    defaultWatcher: null,
    profilesWatcher: null,
    extensionsWatcher: null,
    repatching: false,
    repatchTries: new Map(),
    activeSessionByPanel: new Map(),
    profileByWebview: new Map(),
    pendingProfile: null,
    // Plugin channels, keyed by the extension's channel id: one record per tab (which servers it has
    // started, and a click that arrived before the channel said it was up) and the session manager
    // that owns it.
    channels: new Map(),
    channelManagers: new Map(),
    channelHookSeen: false,
    badges: new Map(),
    iconUris: new Map(),
    warnedOverrides: new Set(),
});

const LOG_FILE = path.join(DIR, 'debug.log');

function dlog(...parts) {
    try {
        const line = `${new Date().toISOString()} ${parts
            .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
            .join(' ')}\n`;
        fs.appendFileSync(LOG_FILE, line, 'utf8');
    } catch {}
}

// The ChatGPT sign-in, which the command in the palette runs too — this file is the door from the
// command menu. Resolved against the runtime directory rather than beside this file, and lazily: in
// production host.js is a copy inside DIR with the module next to it, while the tests load it from a
// copy somewhere else, where there is no module and the row simply reads "not signed in".
let signinModule;
function signin() {
    if (signinModule === undefined)
        try {
            signinModule = require(path.join(DIR, 'chatgpt-signin.js'));
        } catch (e) {
            dlog('chatgpt sign-in unavailable', e && e.message);
            signinModule = null;
        }
    return signinModule;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

// The built-in Claude Code checker is rendered only by its terminal UI; the VS Code composer does not
// receive its results. This bridge runs the same local Hunspell dictionary from the extension host and
// returns only the misspelled tokens, never the complete draft or anything over the network.
const SPELLCHECK_MAX_WORDS = 200;
const SPELLCHECK_MAX_WORD_LENGTH = 80;
const SPELLCHECK_TIMEOUT_MS = 1500;

function spellcheckConfig() {
    const config = readJson(SETTINGS_FILE)?.spellcheck;
    if (!config || config.enabled !== true) return null;
    if (config.checker && config.checker !== 'hunspell' && config.checker !== 'auto') return null;
    return { language: typeof config.language === 'string' && config.language ? config.language : null };
}

function hunspellPath() {
    // winget puts its user-facing command links here. Fall back to PATH for other installers and OSes.
    const link =
        process.platform === 'win32' && process.env.LOCALAPPDATA
            ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'hunspell.exe')
            : null;
    return link && fs.existsSync(link) ? link : 'hunspell';
}

function checkedWords(words) {
    const config = spellcheckConfig();
    if (!config || !Array.isArray(words)) return Promise.resolve(null);
    const accepted = [];
    for (const word of words) {
        if (
            typeof word === 'string' &&
            word.length > 1 &&
            word.length <= SPELLCHECK_MAX_WORD_LENGTH &&
            /^[А-Яа-яЁё]+$/.test(word) &&
            !accepted.includes(word)
        ) {
            accepted.push(word);
            if (accepted.length === SPELLCHECK_MAX_WORDS) break;
        }
    }
    if (!accepted.length) return Promise.resolve({ unknown: new Set(), suggestions: {} });

    const args = [];
    if (config.language) args.push('-d', config.language);
    // -a emits one machine-readable line per word, including suggestions for misspellings.
    args.push('-a');
    return new Promise((resolve) => {
        let done = false;
        let stdout = '';
        let child;
        let timer = null;
        const finish = (result) => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            resolve(result);
        };
        try {
            child = spawn(hunspellPath(), args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        } catch {
            finish(null);
            return;
        }
        timer = setTimeout(() => {
            child.kill();
            finish(null);
        }, SPELLCHECK_TIMEOUT_MS);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.length > 64 * 1024) {
                child.kill();
                finish(null);
            }
        });
        child.once('error', () => finish(null));
        child.once('close', (code) => {
            if (code !== 0) return finish(null);
            const unknown = new Set();
            const suggestions = {};
            for (const line of stdout.split(/\r?\n/)) {
                const match = /^&\s+(\S+)\s+\d+\s+\d+:\s*(.*)$/.exec(line);
                if (!match) continue;
                const word = match[1].toLowerCase();
                unknown.add(word);
                const list = match[2]
                    .split(',')
                    .map((item) => item.trim())
                    .filter((item) => /^[А-Яа-яЁё]+$/.test(item))
                    .slice(0, 5);
                if (list.length) suggestions[word] = list;
            }
            finish({ unknown, suggestions });
        });
        child.stdin.end(accepted.join('\n') + '\n', 'utf8');
    });
}

function writeJson(file, data) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (e) {
        console.error('ccx: writeJson failed', e);
    }
}

function listProfiles() {
    try {
        return fs
            .readdirSync(PROFILES_DIR)
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''));
    } catch {
        return [];
    }
}

function profileEnv(name) {
    const p = readJson(path.join(PROFILES_DIR, name + '.json'));
    return p && typeof p.env === 'object' && p.env ? p.env : {};
}

function currentEnv() {
    const cfg = readJson(SETTINGS_FILE);
    return cfg && typeof cfg.env === 'object' && cfg.env ? cfg.env : {};
}

function modelOf(env) {
    return env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '';
}

function profileMatchesEnv(name, env) {
    const pEnv = profileEnv(name);
    if (!env.ANTHROPIC_BASE_URL) return Object.keys(pEnv).length === 0;
    return pEnv.ANTHROPIC_BASE_URL === env.ANTHROPIC_BASE_URL;
}

function loadBindings() {
    const raw = readJson(BINDINGS_FILE);
    return raw && typeof raw === 'object' ? raw : {};
}

function saveBindings(bindings) {
    writeJson(BINDINGS_FILE, bindings);
}

function getBinding(sessionId) {
    if (!sessionId) return null;
    const bindings = loadBindings();
    const v = bindings[sessionId];
    return v && listProfiles().includes(v) ? v : null;
}

function setBinding(sessionId, name) {
    if (!sessionId) return;
    const bindings = loadBindings();
    if (name === null) delete bindings[sessionId];
    else if (listProfiles().includes(name)) bindings[sessionId] = name;
    saveBindings(bindings);
}

// --- Retracted messages -----------------------------------------------------------------------
//
// The retract gesture hides a message visually without touching the .jsonl — the agent keeps the
// context, only the view drops the turn. The hidden uuids live here, keyed by session, so a resume
// re-hides them and content search skips them. The set only ever grows: there is no un-retract.
function loadHidden() {
    const raw = readJson(HIDDEN_FILE);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function hiddenMessagesFor(sessionId) {
    if (!sessionId) return [];
    const arr = loadHidden()[sessionId];
    return Array.isArray(arr) ? arr : [];
}

function addHidden(sessionId, uuids) {
    if (!sessionId || !Array.isArray(uuids) || !uuids.length) return;
    const map = loadHidden();
    const set = new Set(map[sessionId] || []);
    for (const u of uuids) if (typeof u === 'string') set.add(u);
    map[sessionId] = [...set];
    writeJson(HIDDEN_FILE, map);
    // The search cache holds the session's text as it was before the retract; drop it so the next
    // read rebuilds without the hidden lines.
    S.transcriptTextCache && S.transcriptTextCache.delete(sessionId);
}

// --- Pinned sessions --------------------------------------------------------------------------
//
// Session ids the history list floats above the rest. A flat array rather than a map: the list is
// short, it is read on every state push, and nothing about it is per-session except membership.
// The order stored here is the order they were pinned in and is not the order they render in — the
// list keeps its own recency order inside the pinned block, so pinning never reshuffles it.
function loadPinned() {
    const raw = readJson(PINNED_FILE);
    return Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id) : [];
}

function setPinned(sessionId, pinned) {
    if (!sessionId || typeof sessionId !== 'string') return;
    const list = loadPinned().filter((id) => id !== sessionId);
    if (pinned) list.push(sessionId);
    writeJson(PINNED_FILE, list);
}

// Nothing else ever revisits the list, and a deleted session's id can never come back — without
// this it would hold its slot for as long as the file lives.
function forgetPinned(sessionId) {
    if (!sessionId || typeof sessionId !== 'string') return false;
    const list = loadPinned();
    if (!list.includes(sessionId)) return false;
    writeJson(PINNED_FILE, list.filter((id) => id !== sessionId));
    return true;
}

function profileFromSettings() {
    const env = currentEnv();
    for (const name of listProfiles()) if (profileMatchesEnv(name, env)) return name;
    return null;
}

// The default provider is the profile a new tab runs on when nothing else — a per-tab pick or a
// session binding — has said otherwise. It lives in Vannevar's own directory rather than settings.json,
// which this extension never writes. A name that no longer matches a profile is dropped, so deleting a
// profile file also clears the default that pointed at it.
function loadDefaultProfile() {
    const raw = readJson(DEFAULT_PROFILE_FILE);
    const name = raw && typeof raw.name === 'string' ? raw.name : null;
    return name && listProfiles().includes(name) ? name : null;
}

function saveDefaultProfile(name) {
    writeJson(DEFAULT_PROFILE_FILE, name && listProfiles().includes(name) ? { name } : {});
}

function effectiveProfile(sessionId, webview) {
    if (webview && S.profileByWebview.has(webview)) return S.profileByWebview.get(webview);
    return getBinding(sessionId) || loadDefaultProfile() || profileFromSettings();
}

function managedKeys() {
    const keys = new Set();
    for (const n of listProfiles()) for (const k of Object.keys(profileEnv(n))) keys.add(k);
    return keys;
}

// Credentials and routing that must never cross a provider change. The union of profile keys is
// not enough: a key nobody declares is a key nobody deletes, so an ANTHROPIC_API_KEY sitting in the
// ambient environment would ride along to DeepSeek or GLM. The CLI resolves auth first-match-wins
// (ANTHROPIC_API_KEY before ANTHROPIC_AUTH_TOKEN) and rejects requests carrying both, so a leftover
// key does not just leak — it also breaks the profile's own auth.
const CREDENTIAL_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
];

// True when the profile brings its own routing or credentials, and the ambient ones must therefore go.
// Keying this on ANTHROPIC_BASE_URL alone would miss two real shapes: a profile that only overrides
// ANTHROPIC_AUTH_TOKEN (same endpoint, different account) and one that flips CLAUDE_CODE_USE_BEDROCK
// or _USE_VERTEX. In both, a leftover ANTHROPIC_API_KEY still wins — the CLI reads it first.
//
// A profile with an empty env means "the Anthropic subscription": it declares none of these, so
// nothing is stripped and it keeps inheriting exactly what the user already had.
function crossesProvider(profile) {
    const env = profileEnv(profile);
    return CREDENTIAL_KEYS.some((k) => k in env);
}

const PROXY_SCRIPT = path.join(DIR, 'proxy', 'server.mjs');

function localProxyPort(profile) {
    const url = profileEnv(profile).ANTHROPIC_BASE_URL || '';
    const match = url.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
    return match ? Number(match[1]) : null;
}

function portIsOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host: '127.0.0.1' });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.setTimeout(400);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });
}

async function ensureProxy(profile) {
    const port = localProxyPort(profile);
    if (!port || !fs.existsSync(PROXY_SCRIPT)) return;
    if (S.proxyStarting) return;
    if (await portIsOpen(port)) return;

    S.proxyStarting = true;
    try {
        const extraEnv = readJson(path.join(DIR, 'proxy.json'))?.env || {};
        const child = spawn(process.execPath, ['--use-env-proxy', PROXY_SCRIPT, '--port', String(port)], {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
        });
        child.unref();
        dlog('proxy spawned', { port, profile });
    } catch (e) {
        dlog('proxy spawn failed', e.message);
    } finally {
        setTimeout(() => (S.proxyStarting = false), 3000);
    }
}

const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');

// The CLI writes <projects>/<cwd-slug>/<sessionId>.jsonl on the first user turn — not on system/init.
// So an id can be perfectly real (the CLI announced it) and still resume to nothing: a session that
// was launched and died before anyone typed. That is what `--resume` answers with "No conversation
// found with session ID …". The disk is the only source that cannot be early, so it is the one that
// decides. Scanned across all project folders, because the id is unique and the slug is not ours to
// reconstruct.
function transcriptPathFor(sessionId) {
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
    let dirs = [];
    try {
        dirs = fs.readdirSync(PROJECTS_DIR);
    } catch {
        return null;
    }
    for (const d of dirs) {
        const file = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function transcriptExists(sessionId) {
    return transcriptPathFor(sessionId) !== null;
}

// --- A message id from another provider closes the way back ---------------------------------
//
// The CLI sends `diagnostics: {previous_message_id: <id of the previous answer>}` — its own
// prompt-cache-break diagnosis — and only when the request goes to Anthropic. The id is read off
// the transcript, so a tab that answered on someone else's backend carries that provider's id
// shape: OpenRouter hands out `gen-1787815743-…`. Switch such a session back to Anthropic and
// every turn dies on
//   400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response
//       (starts with `msg_`)
// with no answer at all. There is no retry without the field — the CLI only classifies the failure
// as `previous_message_id_invalid` — and relaunching does not clear it, because the id comes back
// off disk. From Anthropic the session is then unreachable for good.
//
// The CLI builds the field as `previous_message_id: u ?? null` and null is accepted, so dropping
// `message.id` is enough. Only ids no Anthropic endpoint could have issued are touched, only on the
// spawn that is actually going to Anthropic, and every other line is written back byte for byte.
const ANTHROPIC_HOST = /^https?:\/\/api\.anthropic\.com(?:[:\/]|$)/i;

// Where this spawn's requests will land. A profile that brings its own routing answers for itself;
// one with an empty env is the Anthropic subscription and inherits, so the ambient environment and
// settings.json decide — the same layering the CLI itself applies.
function targetsAnthropic(profile, baseEnv) {
    const url =
        profile && crossesProvider(profile)
            ? profileEnv(profile).ANTHROPIC_BASE_URL || ''
            : currentEnv().ANTHROPIC_BASE_URL || (baseEnv && baseEnv.ANTHROPIC_BASE_URL) || '';
    return !url || ANTHROPIC_HOST.test(url);
}

// Rewritten in place rather than through a temp file and a rename: on Windows a rename over a path
// the CLI still holds open fails outright, and this runs in the gap between the old process going
// away and the new one starting.
function stripForeignMessageIds(sessionId) {
    const file = transcriptPathFor(sessionId);
    if (!file) return 0;
    let lines;
    try {
        lines = fs.readFileSync(file, 'utf8').split('\n');
    } catch {
        return 0;
    }
    let stripped = 0;
    const out = lines.map((line) => {
        if (!line.includes('"assistant"')) return line;
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            return line; // a partially written trailing line while the CLI is mid-append
        }
        const message = row && row.type === 'assistant' ? row.message : null;
        if (!message || typeof message.id !== 'string' || message.id.startsWith('msg_')) return line;
        delete message.id;
        stripped++;
        return JSON.stringify(row);
    });
    if (!stripped) return 0;
    try {
        fs.writeFileSync(file, out.join('\n'), 'utf8');
    } catch (e) {
        console.error('ccx: could not strip foreign message ids', e);
        return 0;
    }
    // The search cache keys on mtime+size and would otherwise keep serving the pre-strip bytes
    S.transcriptTextCache && S.transcriptTextCache.delete(sessionId);
    dlog('foreign message ids stripped', { session: sessionId, lines: stripped });
    console.log(`ccx: dropped ${stripped} foreign message id(s) from ${sessionId} before an Anthropic spawn`);
    return stripped;
}

// --- Live view of a delegated agent ---------------------------------------------------------
//
// A run started through the Vannevar MCP server is a separate `claude -p` process: it says nothing
// until it is finished, and from the tab it looks the same whether it is thinking or hung. The server
// now picks the session id before the spawn and drops a manifest in agent-runs/, so the transcript it
// is about to write is known here from the run's first second and can simply be followed.
//
// Everything below is one-way, host to page. Nothing read out of an agent's transcript is ever sent
// back into the tab's own conversation: the parent session's context stays exactly what it was — the
// tool call it made and, at the end, the tool result. This is a window onto the run, not a channel
// into the turn.
const AGENT_RUNS_DIR = path.join(DIR, 'agent-runs');
// A frame shows the tail of a run, not its history. Older lines are dropped as they scroll past,
// which also keeps a long agent transcript from being carried into the page in one message.
const MAX_RUN_EVENTS = 160;
const MAX_EVENT_TEXT = 1200;
// A transcript line is JSON on one line, but a 400 KB tool result is also JSON on one line. The tail
// is read in bounded chunks so a single enormous line cannot pull the whole file into the host.
const MAX_TAIL_BYTES = 512 * 1024;
const RUN_POLL_MS = 700;

function readAgentRuns() {
    let files = [];
    try {
        files = fs.readdirSync(AGENT_RUNS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
        return [];
    }
    const runs = [];
    for (const f of files) {
        const run = readJson(path.join(AGENT_RUNS_DIR, f));
        if (run && typeof run.session === 'string') runs.push(run);
    }
    return runs.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
}

// One readable line per tool call: the argument that names what it touched, not the whole input.
function toolArgument(input) {
    if (!input || typeof input !== 'object') return '';
    for (const key of ['file_path', 'command', 'pattern', 'path', 'query', 'url', 'prompt', 'description']) {
        const v = input[key];
        if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return '';
}

function blockEvents(entry, out) {
    const content = entry.message && entry.message.content;
    if (typeof content === 'string') {
        if (content.trim()) out.push({ k: entry.type === 'user' ? 'prompt' : 'text', t: content.slice(0, MAX_EVENT_TEXT) });
        return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim())
            out.push({ k: entry.type === 'user' ? 'prompt' : 'text', t: block.text.slice(0, MAX_EVENT_TEXT) });
        else if (block.type === 'thinking') out.push({ k: 'thinking' });
        else if (block.type === 'tool_use') out.push({ k: 'tool', n: String(block.name || 'tool'), t: toolArgument(block.input) });
        else if (block.type === 'tool_result') out.push({ k: 'result', ok: !block.is_error });
    }
}

// Read only what has been appended since the last pass. A transcript that came back shorter than the
// offset (a fork, a manual edit) is re-read from the start rather than decoded from the middle.
function tailTranscript(sessionId, state) {
    const file = transcriptPathFor(sessionId);
    if (!file) return state;
    let size = 0;
    try {
        size = fs.statSync(file).size;
    } catch {
        return state;
    }
    if (size === state.size) return state;
    let from = size < state.size ? 0 : state.offset;
    if (size < state.size) {
        state.events = [];
        state.tools = 0;
        state.context = 0;
        state.model = null;
    }
    if (size - from > MAX_TAIL_BYTES) from = size - MAX_TAIL_BYTES;

    let text = '';
    let fd = null;
    try {
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(size - from);
        fs.readSync(fd, buffer, 0, buffer.length, from);
        text = buffer.toString('utf8');
    } catch {
        return state;
    } finally {
        if (fd !== null)
            try {
                fs.closeSync(fd);
            } catch {}
    }

    // The last line may be half-written; its bytes are left unconsumed for the next pass.
    const lines = text.split('\n');
    const trailing = lines.pop() ?? '';
    for (const line of lines) {
        if (!line.trim()) continue;
        let entry = null;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || (entry.type !== 'user' && entry.type !== 'assistant')) continue;
        blockEvents(entry, state.events);
        if (entry.type === 'assistant') noteAssistant(entry.message, state);
    }
    if (state.events.length > MAX_RUN_EVENTS) state.events = state.events.slice(-MAX_RUN_EVENTS);
    state.size = size;
    state.offset = size - Buffer.byteLength(trailing, 'utf8');
    return state;
}

// What the agent map shows for a run beside its time: the model that actually answered, how full its
// context is, and how many tools it has called. The first is not the one the run asked for — a
// profile maps `sonnet` to whatever its provider serves — and the transcript is the only place that
// says. The second is the measure Claude Code puts on its own subagents: the last turn's input, cache
// and output, which is the context the next turn starts from, not a running total.
function noteAssistant(message, state) {
    if (!message || typeof message !== 'object') return;
    if (typeof message.model === 'string' && message.model && message.model !== '<synthetic>') state.model = message.model;
    const u = message.usage;
    if (u && typeof u === 'object') {
        const context =
            (Number(u.input_tokens) || 0) +
            (Number(u.cache_creation_input_tokens) || 0) +
            (Number(u.cache_read_input_tokens) || 0) +
            (Number(u.output_tokens) || 0);
        if (context > 0) state.context = context;
    }
    if (Array.isArray(message.content))
        for (const block of message.content) if (block && block.type === 'tool_use') state.tools++;
}

function agentRunsPayload() {
    const tails = (S.agentTails ||= new Map());
    const runs = readAgentRuns();
    const alive = new Set(runs.map((r) => r.session));
    for (const id of [...tails.keys()]) if (!alive.has(id)) tails.delete(id);

    return runs.map((run) => {
        let state = tails.get(run.session);
        if (!state) tails.set(run.session, (state = { offset: 0, size: -1, events: [], tools: 0, context: 0, model: null }));
        tailTranscript(run.session, state);
        return {
            session: run.session,
            parent: typeof run.parent === 'string' ? run.parent : null,
            owner: typeof run.owner === 'string' ? run.owner : null,
            description: typeof run.description === 'string' ? run.description : null,
            background: Boolean(run.background),
            profile: run.profile || null,
            model: run.model || null,
            servedModel: state.model || null,
            contextTokens: state.context || null,
            toolUses: state.tools,
            mode: run.mode || null,
            cwd: run.cwd || null,
            prompt: typeof run.prompt === 'string' ? run.prompt : '',
            promptLength: run.promptLength ?? (run.prompt ? run.prompt.length : 0),
            resumed: Boolean(run.resumed),
            startedAt: run.startedAt || null,
            finishedAt: run.finishedAt || null,
            state: run.state || 'running',
            turns: run.turns ?? null,
            tokens: run.tokens || null,
            error: run.error || null,
            events: state.events,
        };
    });
}

// Polled rather than watched: the manifest changes twice in a run's life, while the transcript it
// points at grows all the way through. The timer only exists while something is actually running,
// and stops itself one pass after the last run has ended.
function pumpAgentRuns() {
    let payload = [];
    try {
        payload = agentRunsPayload();
    } catch (e) {
        dlog('agent runs failed', e.message);
    }
    const stamp = JSON.stringify(payload);
    if (stamp !== S.agentRunsStamp) {
        S.agentRunsStamp = stamp;
        for (const w of S.webviews) post(w, { type: 'ccx:agentRuns', runs: payload });
    }
    const live = payload.some((r) => r.state === 'running');
    clearTimeout(S.agentRunsTimer);
    S.agentRunsTimer = live ? setTimeout(pumpAgentRuns, RUN_POLL_MS) : null;
}

// A manifest appearing is the one moment the poll has to be woken up; after that it keeps itself
// going for as long as a run is live.
function wakeAgentRuns() {
    clearTimeout(S.agentRunsTimer);
    S.agentRunsTimer = setTimeout(pumpAgentRuns, 0);
}

// "Open transcript" on a delegated run in the agent map. Claude Code answers that button by reading a
// subagent file under the tab's own session; a delegated run is a session of its own, so the page asks
// here instead and gets the run's transcript in the shape the app's own reader returns — SDK messages,
// which the dialog feeds through the same accumulator it uses for a subagent. Sidechains are left out
// for the same reason the stock replay drops them, and a transcript too large to post is cut to its
// tail rather than refused.
const MAX_AGENT_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

function agentTranscript(sessionId) {
    const file = transcriptPathFor(sessionId);
    if (!file) return { ok: false, error: 'this run left no transcript' };
    let text = '';
    let cut = false;
    let fd = null;
    try {
        const size = fs.statSync(file).size;
        const from = Math.max(0, size - MAX_AGENT_TRANSCRIPT_BYTES);
        cut = from > 0;
        fd = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(size - from);
        fs.readSync(fd, buffer, 0, buffer.length, from);
        text = buffer.toString('utf8');
    } catch (e) {
        return { ok: false, error: e.message };
    } finally {
        if (fd !== null)
            try {
                fs.closeSync(fd);
            } catch {}
    }
    const lines = text.split('\n');
    // A cut lands mid-line, and so can a write still in progress: both ends are dropped, not parsed.
    if (cut) lines.shift();
    const messages = [];
    for (const line of lines) {
        if (!line.trim()) continue;
        let entry = null;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        if (!entry || (entry.type !== 'user' && entry.type !== 'assistant') || entry.isSidechain) continue;
        if (!entry.message || typeof entry.message !== 'object') continue;
        messages.push({
            type: entry.type,
            message: entry.message,
            uuid: entry.uuid,
            timestamp: entry.timestamp,
            session_id: sessionId,
            parent_tool_use_id: null,
            is_meta: entry.isMeta === true,
        });
    }
    return { ok: true, messages };
}

// "Stop agent" on a delegated run. Only a run its manifest still calls running is asked, and asking is
// all this does: the MCP server that owns the child polls for the request, ends the run and closes the
// manifest as stopped — which is what the map then shows.
function requestAgentStop(sessionId) {
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return { ok: false, error: 'not a run' };
    const run = readJson(path.join(AGENT_RUNS_DIR, `${sessionId}.json`));
    if (!run || run.state !== 'running') return { ok: false, error: 'the run has already finished' };
    try {
        fs.writeFileSync(path.join(AGENT_RUNS_DIR, `${sessionId}.stop`), String(Date.now()));
    } catch (e) {
        return { ok: false, error: e.message };
    }
    dlog('agent stop requested', { session: sessionId });
    return { ok: true };
}

// --- Content search for the session picker --------------------------------------------------
//
// The stock search box only matches a row's title and git branch, both already in memory for every
// visible row. Matching the conversation itself means reading the transcript, so it stays a separate,
// lazy pass: the webview sends the ids it currently has on screen, keyed on a search query, and this
// greps each one's raw .jsonl text — no JSON parsing, the query sits in the encoded message content
// either way and parsing every line just to throw the structure away buys nothing.
//
// Cached per session on mtime+size, because the picker searches on every keystroke's pause and a
// transcript that has not changed since the last one costs nothing to check again. Capped rather than
// left to grow: transcripts run from a few KB to several MB, and a long-lived window that has searched
// its way through a large history should not end up holding all of it in memory at once.
const MAX_CACHED_TRANSCRIPTS = 200;

function transcriptSearchText(sessionId) {
    const file = transcriptPathFor(sessionId);
    if (!file) return null;
    const cache = (S.transcriptTextCache ||= new Map());
    try {
        const { mtimeMs, size } = fs.statSync(file);
        const hit = cache.get(sessionId);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.lower;
        const raw = fs.readFileSync(file, 'utf8');
        let lower;
        const hidden = hiddenMessagesFor(sessionId);
        if (hidden.length) {
            // A retracted message must stop matching content search. That means parsing per line to
            // know each line's uuid — a cost only paid for sessions that have retracted something;
            // every other session keeps the plain raw-text grep.
            const skip = new Set(hidden);
            const parts = [];
            for (const line of raw.split('\n')) {
                if (!line) continue;
                let row;
                try {
                    row = JSON.parse(line);
                } catch {
                    parts.push(line.toLowerCase());
                    continue;
                }
                if (row && typeof row.uuid === 'string' && skip.has(row.uuid)) continue;
                parts.push(line.toLowerCase());
            }
            lower = parts.join('\n');
        } else {
            lower = raw.toLowerCase();
        }
        if (cache.size >= MAX_CACHED_TRANSCRIPTS) cache.delete(cache.keys().next().value);
        cache.set(sessionId, { mtimeMs, size, lower });
        return lower;
    } catch {
        return null;
    }
}

function searchTranscripts(query, sessionIds) {
    const needle = (query || '').toLowerCase().trim();
    if (!needle || !Array.isArray(sessionIds)) return [];
    const out = [];
    for (const id of sessionIds) {
        if (typeof id !== 'string') continue;
        const text = transcriptSearchText(id);
        if (text && text.includes(needle)) out.push(id);
    }
    return out;
}

// --- History before compaction ---------------------------------------------------------------
//
// A compaction deletes nothing. The CLI appends a compact_boundary and a summary, and every line
// before them stays in the .jsonl. What hides that part is how the extension rebuilds a transcript
// for the page, in two places:
//
//   - the walk goes back along parentUuid from the newest message, and the boundary is written with
//     `parentUuid: null` — the link to the conversation it closed survives only as logicalParentUuid;
//   - a file over 5 MB is not even parsed before its last boundary: the reader seeks past those bytes.
//
// With the switch on, both readers in extension.js ask here first (injection points #12 and #13). The
// size shortcut is skipped, and every boundary is joined back to the chain it closed before the stock
// walk runs. Only the page's copy changes: the CLI rebuilds its own context from the same file in a
// different process, and that one still stops at the boundary.
//
// Read from disk on every call rather than cached in S. Each VS Code window is its own extension host
// with its own S, and the switch flipped in one window has to reach the next session opened in another.
function historyBeforeCompaction() {
    const raw = readJson(HISTORY_FILE);
    return Boolean(raw && raw.enabled === true);
}

function setHistoryBeforeCompaction(enabled) {
    writeJson(HISTORY_FILE, { enabled: Boolean(enabled) });
}

// What extension.js stamped beside this runtime when it copied it out of the .vsix: the extension's own
// version, the Claude Code releases its signatures were checked against, and the bundle path the
// extension host resolved. The watcher below reads it to tell an update to Vannevar Code from an update
// to Claude Code.
const STAMP_FILE = path.join(DIR, 'patch-version.json');

// `byUuid` is the stock walk's own map, taken before it relinks anything. Every compaction keeps a short
// tail of the conversation (compactMetadata.preservedMessages), and the walk moves that tail to just
// after the summary. So a boundary is joined to what preceded the tail, not to logicalParentUuid: that
// IS the tail's last message, and linking there would lead the walk back into the tail it had just
// left — the loop guard would end the history right there, one compaction deep.
//
// The kept-list conditions mirror the stock relink exactly. A list with a uuid missing from the map is
// not relinked at all, so the tail stays where it was and logicalParentUuid is the right link after all.
function stitchCompactions(byUuid) {
    if (!(byUuid instanceof Map) || !historyBeforeCompaction()) return 0;
    let stitched = 0;
    for (const [uuid, entry] of byUuid) {
        if (!entry || entry.type !== 'system' || entry.subtype !== 'compact_boundary' || entry.parentUuid) continue;
        const logical = entry.logicalParentUuid;
        // Absent when the part before was never read — a transcript continued from another session
        if (typeof logical !== 'string' || !byUuid.has(logical)) continue;
        const meta = entry.compactMetadata || {};
        let head = null;
        if (meta.preservedMessages) {
            const kept = meta.preservedMessages.uuids;
            if (Array.isArray(kept) && kept.length && kept.every((id) => byUuid.has(id))) head = kept[0];
        } else if (meta.preservedSegment && byUuid.has(meta.preservedSegment.headUuid)) {
            head = meta.preservedSegment.headUuid;
        }
        // A kept tail that starts the whole transcript leaves nothing before it to show
        const parent = head ? byUuid.get(head).parentUuid : logical;
        if (!parent || !byUuid.has(parent)) continue;
        byUuid.set(uuid, { ...entry, parentUuid: parent });
        stitched++;
    }
    return stitched;
}

function envFor(baseEnv, resumeSessionId, opts) {
    // Guarding the resume is independent of the profile: even a plain Anthropic tab can be relaunched
    // by the extension itself with an id whose transcript never came to be. Clearing opts.resume here
    // is what turns `--resume=<id>` into a fresh start — the SDK reads that field after this runs.
    if (opts && resumeSessionId && !transcriptExists(resumeSessionId)) {
        dlog('resume dropped', { session: resumeSessionId, reason: 'no transcript on disk' });
        console.log(`ccx: dropping --resume ${resumeSessionId} — no transcript on disk, starting fresh`);
        opts.resume = undefined;
        resumeSessionId = undefined;
    }
    const profile = S.pendingProfile || getBinding(resumeSessionId) || loadDefaultProfile();
    // Ahead of the early return, because a tab with no profile at all is the plainest way back to
    // Anthropic — and the one that would otherwise keep failing with nothing in the log to explain it.
    if (resumeSessionId && targetsAnthropic(profile, baseEnv)) stripForeignMessageIds(resumeSessionId);
    if (!profile) return baseEnv;
    const env = { ...baseEnv };
    for (const k of managedKeys()) delete env[k];
    if (crossesProvider(profile)) for (const k of CREDENTIAL_KEYS) delete env[k];
    Object.assign(env, profileEnv(profile));

    // Local adapter: without this the CLI routes even 127.0.0.1 through the corporate proxy and cannot connect
    if (localProxyPort(profile)) {
        const noProxy = '127.0.0.1,localhost';
        env.NO_PROXY = env.NO_PROXY ? `${env.NO_PROXY},${noProxy}` : noProxy;
        env.no_proxy = env.NO_PROXY;
    }

    // From Claude Code 2.1.278 auto mode asks the server to run its safety classifier inside the
    // session's own requests — it sends a `safeguards` field and reads `safeguard_results` back —
    // and stops billing for it. Nothing this extension routes to can answer that way: the adapter
    // translates to the Responses or Gemini protocol entirely, and DeepSeek or GLM never saw the
    // field. Left to discover that by itself, the CLI holds the first checked action and reports
    // that the session is not eligible. Saying so up front skips the notice and leaves auto mode on
    // its own classifier requests, which is what it would have fallen back to anyway. The variable
    // is ignored on a direct connection to Anthropic and Bedrock and Vertex do serve the checks, so
    // only a profile that routes somewhere else gets it. It is documented as temporary, and a value
    // the user set themselves — in the profile or in settings.json, which the CLI layers on top —
    // still wins.
    if (!targetsAnthropic(profile, baseEnv) && !('CLAUDE_CODE_AUTO_MODE_SERVER' in env)) {
        env.CLAUDE_CODE_AUTO_MODE_SERVER = '0';
    }

    // Artifacts are Anthropic's own service: the Artifact tool publishes a page to claude.ai and keeps
    // its versions, assets and comments there, and the CLI already answers "ineligible" for a
    // third-party provider or a custom base URL. That verdict comes back from the server, so a session
    // that asks before it lands still registers the tool and still sends its schema — and DeepSeek
    // refuses that schema outright, on the `^[^\0]*$` pattern zod emits for the Artifact tool's
    // `file_paths` (its validator is a Rust regex, where `\0` is not an escape). The 400 arrives before
    // a single token is read, so the session never answers again. Off up front instead, for every
    // profile that does not talk to Anthropic; a value the user set themselves still wins.
    if (!targetsAnthropic(profile, baseEnv) && !('CLAUDE_CODE_DISABLE_ARTIFACT' in env)) {
        env.CLAUDE_CODE_DISABLE_ARTIFACT = '1';
    }
    dlog('envFor', { profile, session: resumeSessionId || 'new', baseUrl: profileEnv(profile).ANTHROPIC_BASE_URL });
    console.log(`ccx: spawning with profile "${profile}" (session ${resumeSessionId || 'new'})`);
    return env;
}

// The CLI layers ~/.claude/settings.json's `env` block on top of the spawn environment. Its own
// filter would strip provider keys, but only for hosts it treats as managed — the list is
// ["claude-desktop","claude-desktop-3p","local-agent"] and "claude-vscode" is not in it. So whatever
// is left in that block silently outranks the per-tab profile, which is exactly the hand-editing
// this project exists to replace. Warn instead of editing: settings.json is the user's file and
// Vannevar never writes to it.
function warnSettingsOverride(profile) {
    const settings = currentEnv();
    const wanted = profileEnv(profile);
    // Coerced, because settings.json is hand-written JSON and a number or boolean there means the same
    // thing as its string form once it reaches process.env — warning about that would be pure noise.
    const conflicting = Object.keys(settings).filter((k) =>
        k in wanted ? String(settings[k]) !== String(wanted[k]) : CREDENTIAL_KEYS.includes(k),
    );
    if (!conflicting.length) return;

    const stamp = `${profile}:${conflicting.slice().sort().join(',')}`;
    if (S.warnedOverrides.has(stamp)) return;
    S.warnedOverrides.add(stamp);
    dlog('settings override', { profile, keys: conflicting });
    vscode.window.showWarningMessage(
        `~/.claude/settings.json sets ${conflicting.join(', ')}. Claude Code applies that on top of ` +
            `the spawn environment, so it overrides the "${profile}" profile in every tab. ` +
            `Remove those keys from settings.json for per-tab switching to take effect.`,
    );
}

function panelProfile(panel) {
    const sessionId = S.activeSessionByPanel.get(panel);
    return effectiveProfile(sessionId, panel.webview);
}

function modelsOf(name) {
    const env = profileEnv(name);
    return {
        opus: env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL || '',
        sonnet: env.ANTHROPIC_DEFAULT_SONNET_MODEL || '',
        haiku: env.ANTHROPIC_DEFAULT_HAIKU_MODEL || '',
        fable: env.ANTHROPIC_DEFAULT_FABLE_MODEL || '',
    };
}

// --- The attachment draft, in the language from /config ------------------------------------------
//
// /config writes `language` into ~/.claude/settings.json, and the CLI accepts three shapes for it: a
// name ("russian"), that name in its own script ("русский"), or a code or locale ("ru", "ru-RU").
// The twenty languages below are exactly the ones it resolves; anything else falls back to English
// there, so it falls back here too — the draft should never be in a language the answer will not be.
//
// The wording is the payload: one row per language, the noun going into %s so the carrier sentence
// is written once. To reword a language, edit its row and nothing else.
const NOUN_KEYS = ['image', 'images', 'attachment', 'attachments'];

// The retract instruction is deliberately NOT localised the way the attachment and resume prompts
// are. Those are written into the user's visible composer, so they must read like the user's own
// prose; the retract instruction is meant to be hidden the moment it renders, and the extension's
// own UI is English, so the wording is English for every language.
const RETRACT_TEMPLATE = 'The message «%s» was a mistake — ignore it and your response to it.';

const LANGUAGES = {
    en: {
        names: ['english'],
        prompt: 'Analyse the %s in the context of this conversation',
        nouns: ['image', 'images', 'attachment', 'attachments'],
        resume: "Continue from where you stopped",
    },
    es: {
        names: ['spanish', 'español', 'espanol'],
        prompt: 'Analiza %s en el contexto de esta conversación',
        nouns: ['la imagen', 'las imágenes', 'el archivo adjunto', 'los archivos adjuntos'],
        resume: "Continúa desde donde lo dejaste",
    },
    fr: {
        names: ['french', 'français', 'francais'],
        prompt: 'Analyse %s dans le contexte de cette conversation',
        nouns: ["l'image", 'les images', 'la pièce jointe', 'les pièces jointes'],
        resume: "Reprends là où tu t'es arrêté",
    },
    ja: {
        names: ['japanese', '日本語'],
        prompt: 'この会話の文脈で%sを分析してください',
        nouns: ['画像', '画像', '添付ファイル', '添付ファイル'],
        resume: "中断したところから続けてください",
    },
    de: {
        names: ['german', 'deutsch'],
        prompt: 'Analysiere %s im Kontext dieser Unterhaltung',
        nouns: ['das Bild', 'die Bilder', 'den Anhang', 'die Anhänge'],
        resume: "Mach dort weiter, wo du aufgehört hast",
    },
    pt: {
        names: ['portuguese', 'português', 'portugues'],
        prompt: 'Analise %s no contexto desta conversa',
        nouns: ['a imagem', 'as imagens', 'o anexo', 'os anexos'],
        resume: "Continue de onde parou",
    },
    it: {
        names: ['italian', 'italiano'],
        prompt: 'Analizza %s nel contesto di questa conversazione',
        nouns: ["l'immagine", 'le immagini', "l'allegato", 'gli allegati'],
        resume: "Riprendi da dove ti sei fermato",
    },
    ko: {
        // The object particle is part of the noun: 이미지 takes 를, 첨부 파일 takes 을
        names: ['korean', '한국어'],
        prompt: '이 대화의 맥락에서 %s 분석해 주세요',
        nouns: ['이미지를', '이미지들을', '첨부 파일을', '첨부 파일들을'],
        resume: "중단된 지점부터 이어서 진행해 주세요",
    },
    hi: {
        names: ['hindi', 'हिन्दी', 'हिंदी'],
        prompt: 'इस बातचीत के संदर्भ में %s का विश्लेषण करें',
        nouns: ['छवि', 'छवियों', 'संलग्न फ़ाइल', 'संलग्न फ़ाइलों'],
        resume: "जहाँ रुके थे वहीं से जारी रखें",
    },
    id: {
        names: ['indonesian', 'bahasa indonesia', 'bahasa'],
        prompt: 'Analisis %s dalam konteks percakapan ini',
        nouns: ['gambar', 'gambar-gambar', 'lampiran', 'lampiran-lampiran'],
        resume: "Lanjutkan dari tempat kamu berhenti",
    },
    ru: {
        names: ['russian', 'русский'],
        prompt: 'Проанализируй %s в контексте этого диалога',
        nouns: ['изображение', 'изображения', 'вложение', 'вложения'],
        resume: "Продолжай с того места, где остановился",
    },
    pl: {
        names: ['polish', 'polski'],
        prompt: 'Przeanalizuj %s w kontekście tej rozmowy',
        nouns: ['obraz', 'obrazy', 'załącznik', 'załączniki'],
        resume: "Kontynuuj od miejsca, w którym przerwałeś",
    },
    tr: {
        names: ['turkish', 'türkçe', 'turkce'],
        prompt: 'Bu sohbetin bağlamında %s analiz et',
        nouns: ['görseli', 'görselleri', 'eki', 'ekleri'],
        resume: "Kaldığın yerden devam et",
    },
    nl: {
        names: ['dutch', 'nederlands'],
        prompt: 'Analyseer %s in de context van dit gesprek',
        nouns: ['de afbeelding', 'de afbeeldingen', 'de bijlage', 'de bijlagen'],
        resume: "Ga verder waar je gebleven was",
    },
    uk: {
        names: ['ukrainian', 'українська'],
        prompt: 'Проаналізуй %s у контексті цієї розмови',
        nouns: ['зображення', 'зображення', 'вкладення', 'вкладення'],
        resume: "Продовжуй з того місця, де зупинився",
    },
    el: {
        names: ['greek', 'ελληνικά'],
        prompt: 'Ανάλυσε %s στο πλαίσιο αυτής της συζήτησης',
        nouns: ['την εικόνα', 'τις εικόνες', 'το συνημμένο', 'τα συνημμένα'],
        resume: "Συνέχισε από εκεί που σταμάτησες",
    },
    cs: {
        names: ['czech', 'čeština', 'cestina'],
        prompt: 'Analyzuj %s v kontextu této konverzace',
        nouns: ['obrázek', 'obrázky', 'přílohu', 'přílohy'],
        resume: "Pokračuj tam, kde jsi skončil",
    },
    da: {
        names: ['danish', 'dansk'],
        prompt: 'Analysér %s i konteksten af denne samtale',
        nouns: ['billedet', 'billederne', 'den vedhæftede fil', 'de vedhæftede filer'],
        resume: "Fortsæt hvor du slap",
    },
    sv: {
        names: ['swedish', 'svenska'],
        prompt: 'Analysera %s i kontexten av den här konversationen',
        nouns: ['bilden', 'bilderna', 'bilagan', 'bilagorna'],
        resume: "Fortsätt där du slutade",
    },
    no: {
        names: ['norwegian', 'norsk'],
        prompt: 'Analyser %s i konteksten av denne samtalen',
        nouns: ['bildet', 'bildene', 'vedlegget', 'vedleggene'],
        resume: "Fortsett der du slapp",
    },
};

// Same order of attempts as the CLI: an exact code, then a name, then the part before the dash so a
// full locale still lands. Unrecognised is English, which is also what the CLI answers in.
function languageOf(value) {
    if (typeof value !== 'string') return 'en';
    const wanted = value.toLowerCase().trim();
    if (!wanted) return 'en';
    if (LANGUAGES[wanted]) return wanted;
    for (const code of Object.keys(LANGUAGES)) if (LANGUAGES[code].names.includes(wanted)) return code;
    const base = wanted.split('-')[0];
    return LANGUAGES[base] ? base : 'en';
}

// The webview is handed the four finished sentences rather than the language, so it only has to look
// at what is attached. Riding on ccx:state means a /config change repaints them without a reload:
// settings.json is already watched, and every change broadcasts.
function attachmentPrompts() {
    const lang = LANGUAGES[languageOf(readJson(SETTINGS_FILE)?.language)] || LANGUAGES.en;
    const out = {};
    NOUN_KEYS.forEach((key, i) => {
        out[key] = lang.prompt.replace('%s', lang.nouns[i]);
    });
    // The resume and retract phrases ride on the same payload — one less field on ccx:state, and the
    // webview reads them from the same place it reads the attachment prompts. The resume prompt is
    // per-language like the drafts; the retract instruction is English for every language (see above).
    out.resume = lang.resume;
    out.retract = RETRACT_TEMPLATE;
    return out;
}

// --- Provider health ---------------------------------------------------------------------------
//
// The MCP server probes a profile before it delegates to it and records the verdict in
// agent-health.json — one entry per profile, overwritten by the next probe. That file is the only
// place in the install where "this provider answered / refused / never replied" is written down, so
// the account panel reads it instead of probing again: a panel that opened a connection per provider
// every time it rendered would spend real quota to draw a row.
//
// Nothing here claims to be true *now*. An entry says what happened at `at`, which is why the stamp
// travels with it and the page draws an old verdict as old rather than as green.
function providerHealth() {
    const raw = readJson(HEALTH_FILE);
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

// One entry, trimmed to what a row can show. `message` is the provider's own error text and has no
// bound — the page gets a slice of it, never the whole body.
function healthFor(name, health) {
    const h = health[name];
    if (!h || typeof h !== 'object' || typeof h.at !== 'string') return null;
    const at = Date.parse(h.at);
    if (!Number.isFinite(at)) return null;
    const resets = typeof h.resets_at === 'string' ? Date.parse(h.resets_at) : NaN;
    return {
        at,
        ok: Boolean(h.ok),
        // A probe that could not connect is not a provider that refused. Kept apart because the two
        // send the reader to different places: one to the adapter, the other to the account.
        unreachable: Boolean(h.unreachable),
        status: Number.isFinite(h.status) ? h.status : null,
        message: typeof h.message === 'string' ? h.message.slice(0, 200) : '',
        resetsAt: Number.isFinite(resets) ? resets : null,
        // What the probe actually reached, which is not always what the profile asks for
        model: typeof h.model === 'string' ? h.model : '',
    };
}

// Where a profile sends its requests, in the words a row has room for.
function endpointOf(name, env) {
    const base = env.ANTHROPIC_BASE_URL || '';
    if (!base) return 'Anthropic subscription';
    const port = localProxyPort(name);
    try {
        const url = new URL(base);
        // The adapter's first path segment names the upstream it fronts (/codex, /glm, …) — the one
        // thing `127.0.0.1:8787` does not say, and the only part of the URL worth the space.
        if (port) {
            const upstream = url.pathname.split('/').filter(Boolean)[0];
            return upstream ? `adapter :${port} · ${upstream}` : `adapter :${port}`;
        }
        return url.host;
    } catch {
        return base;
    }
}

// A profile is a JSON file nothing in this UI edits, so "open the profile" means exactly that: hand
// the path to VS Code and let the editor own it. The name comes off a page message, so it is checked
// against the profile list rather than pasted into a path — a webview must never be able to name an
// arbitrary file for the host to open.
function openProfileFile(name) {
    if (typeof name !== 'string' || !listProfiles().includes(name)) return false;
    try {
        vscode.window.showTextDocument(vscode.Uri.file(path.join(PROFILES_DIR, `${name}.json`)));
        return true;
    } catch (e) {
        dlog('open profile failed', e.message);
        return false;
    }
}

// The one thing the page's resource list cannot do for itself: hand a URL to the OS, a file to the
// editor, or the bytes of a pasted attachment to whatever opens that kind of thing. All three are
// refused rather than guessed at — a path that is not absolute has no directory to be resolved
// against here (the host tracks no reliable per-session cwd), and opening the wrong file is worse
// than a refusal — so the reply carries the reason and the page shows it as a toast.
//
// The bytes travel with the request rather than being looked up again: an attachment exists in the
// transcript and nowhere on disk, and re-reading a session's jsonl to find one block is a fragile way
// to avoid a copy. Past this size the request is refused instead of moved — a pasted screenshot is a
// few hundred kilobytes, and anything at this size is a file the user has on disk somewhere.
const RESOURCE_MEDIA_MAX = 12 * 1024 * 1024;

const EXT_BY_TYPE = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/markdown': '.md',
    'text/csv': '.csv',
    'application/json': '.json',
};

function extensionForType(type) {
    const known = EXT_BY_TYPE[String(type || '').toLowerCase()];
    if (known) return known;
    const sub = /^[a-z]+\/([a-z0-9.+-]+)/i.exec(String(type || ''));
    return sub ? '.' + sub[1].replace(/[^a-z0-9]/gi, '').slice(0, 8) : '.bin';
}

// Named after the payload, so opening the same screenshot twice reuses one file rather than filling
// the temp directory with copies of it.
function mediaFile(mediaType, data) {
    const dir = path.join(os.tmpdir(), 'vannevar-resources');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.createHash('sha1').update(data).digest('hex').slice(0, 16) + extensionForType(mediaType));
    if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
}

function openResource(m, webview) {
    const seq = typeof m.seq === 'number' ? m.seq : null;
    const reply = (ok, error) => post(webview, { type: 'ccx:openResourceResult', seq, ok, error });
    const openExternal = (uri, what) =>
        Promise.resolve(vscode.env.openExternal(uri)).then(
            () => reply(true),
            (e) => reply(false, `could not open the ${what}: ` + ((e && e.message) || e)),
        );
    try {
        const value = typeof m.value === 'string' ? m.value.trim() : '';
        const link = typeof m.url === 'string' ? m.url.trim() : '';
        if (m.kind === 'url' || (m.kind === 'media' && link)) {
            // A scheme whitelist, so a `vscode:`/`file:`/`command:` value that arrived from a
            // transcript the model wrote never reaches the shell.
            const url = link || value;
            if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) links are opened');
            openExternal(vscode.Uri.parse(url), 'link');
        } else if (m.kind === 'file') {
            if (!path.isAbsolute(value)) throw new Error(`${value} is not an absolute path — open it from the terminal`);
            // A tool that names a directory — a search rooted at one, most often — is a place the
            // session touched as much as a file is, so the row is kept and the folder is revealed
            // rather than opened. `showTextDocument` on one answers with a paragraph about reading a
            // directory, which is what the first version of this showed the user.
            let isDir = false;
            try {
                isDir = fs.statSync(value).isDirectory();
            } catch (e) {
                /* a path that is not there is the editor's to report, in its own words */
            }
            if (isDir)
                Promise.resolve(vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(value))).then(
                    () => reply(true),
                    (e) => reply(false, 'could not reveal the folder: ' + ((e && e.message) || e)),
                );
            else
                vscode.window.showTextDocument(vscode.Uri.file(value), { preview: true }).then(
                    () => reply(true),
                    (e) => reply(false, 'could not open the file: ' + ((e && e.message) || e)),
                );
        } else if (m.kind === 'media') {
            const data = typeof m.data === 'string' ? m.data : '';
            if (!data) throw new Error('this attachment carries nothing to open');
            if (data.length > RESOURCE_MEDIA_MAX)
                throw new Error(
                    `this attachment is about ${Math.round((data.length * 3) / 4 / 1048576)} MB — too large to open from here`,
                );
            openExternal(vscode.Uri.file(mediaFile(m.mediaType, data)), 'attachment');
        } else if (!value) throw new Error('nothing to open');
        else throw new Error('unknown resource kind');
    } catch (e) {
        reply(false, (e && e.message) || String(e));
    }
}

// The Settings row in the command menu, which is where the account Claude Code itself runs on is
// switched — so the subscription is signed into from there rather than from the command palette, and
// the palette command stays for a window whose patch is off. One flow at a time, guarded on the shared
// state rather than per webview: every tab draws the same row, and a second flow would find port 1455
// taken by the first. Both edges are broadcast, because the chip on that row is drawn from ccx:state.
function startChatgptLogin() {
    const flow = signin();
    if (!flow || S.chatgptSigningIn) return;
    S.chatgptSigningIn = true;
    broadcast();
    flow.signIn({ vscode, dir: DIR, onLog: (line) => dlog(line) })
        .catch((e) => dlog('chatgpt sign-in failed', e && e.message))
        .then(() => {
            S.chatgptSigningIn = false;
            broadcast();
        });
}

// --- Plugin channels: any plugin's channel, started from the menu -------------------------------------
//
// Claude Code's plugin channels are launched with `--channels plugin:telegram@claude-plugins-official`,
// and that flag is out of reach from here: the SDK rebuilds the transport's options from a literal that
// does not carry `channels`, so whatever the spawn options say, the CLI never sees the flag (the whole
// of it is in the injection point that hands this file the session manager). Remote Control — the same
// kind of thing, a live connection started by a control request rather than by a spawn flag — is the
// shape followed instead: the session's query object takes `enableChannel(serverName)`, the CLI looks up
// that server's plugin, and the answer is what the row reports.
//
// Nothing here knows about Telegram. `channel_enable` takes the plugin-qualified name of an MCP
// server, and the CLI is what insists the server is marketplace-sourced — so the candidates are whatever
// the installed plugins declare, read off disk, qualified with the plugin name, and enabled by naming
// one of them. Whether a server actually pushes channel notifications is not in any manifest: the MCP server
// declares that capability in its own handshake, which is why the list can only offer the servers and
// the CLI has the last word ("server did not declare claude/channel capability").
const PLUGINS_FILE = path.join(HOME, '.claude', 'plugins', 'installed_plugins.json');

function readMcpServers(dir) {
    // The two places a plugin may declare its servers: `.mcp.json` beside the plugin, and the manifest
    // itself. `mcpServers` there is a map of name → command in the first and can be either a map or a
    // list of names in the second, so both shapes are taken.
    const names = [];
    const mcp = readJson(path.join(dir, '.mcp.json'));
    if (mcp && mcp.mcpServers && !Array.isArray(mcp.mcpServers)) names.push(...Object.keys(mcp.mcpServers));
    const manifest = readJson(path.join(dir, '.claude-plugin', 'plugin.json')) || readJson(path.join(dir, 'plugin.json'));
    const declared = manifest && manifest.mcpServers;
    if (Array.isArray(declared)) names.push(...declared.map((s) => (typeof s === 'string' ? s : s && s.name)));
    else if (declared && typeof declared === 'object') names.push(...Object.keys(declared));
    return names.filter((n) => typeof n === 'string' && n);
}

// The channels this machine could start: one entry per server declared by an installed plugin. Read
// per state push — a handful of small files — but memoised on the manifest's own mtime, so a session
// that pushes state a hundred times reads them once.
function channelCandidates() {
    let stamp = 0;
    try {
        stamp = fs.statSync(PLUGINS_FILE).mtimeMs;
    } catch {
        return [];
    }
    if (S.channelCandidates && S.channelCandidates.stamp === stamp) return S.channelCandidates.list;
    const list = [];
    const seen = new Set();
    const installed = readJson(PLUGINS_FILE);
    const plugins = (installed && installed.plugins) || {};
    for (const [spec, entries] of Object.entries(plugins)) {
        for (const entry of (Array.isArray(entries) ? entries : [entries]).filter(Boolean)) {
            if (typeof entry.installPath !== 'string') continue;
            for (const server of readMcpServers(entry.installPath)) {
                if (seen.has(server)) continue;
                seen.add(server);
                // The control protocol does not take the declaration's local key. MCP registers plugin
                // servers under `plugin:<plugin name>:<server key>`; handing channel_enable only `server`
                // makes it look for an unrelated user server and answer "server … is not connected".
                const separator = spec.lastIndexOf('@');
                const pluginName = separator > 0 ? spec.slice(0, separator) : spec;
                // The directory travels with the row: starting a plugin as a relay means reading the
                // same `.mcp.json` the CLI reads, and the list is the only place that knows where it is.
                list.push({ server, plugin: spec, mcpServer: `plugin:${pluginName}:${server}`, dir: entry.installPath });
            }
        }
    }
    list.sort((a, b) => a.server.localeCompare(b.server));
    S.channelCandidates = { stamp, list };
    return list;
}

function channelOf(webview) {
    const id = webview && webview.__ccxChannelId;
    if (!id) return null;
    return (S.channels ||= new Map()).get(id) || null;
}

// One status per server rather than one per tab: a session can run several channels at once, and each
// is started on its own. The record keeps what the click decided, the manager is kept apart from it.
function channelServer(rec, server) {
    rec.servers ||= {};
    rec.servers[server] ||= { status: 'idle', error: null };
    return rec.servers[server];
}

function channelStateOf(channelId, server) {
    const rec = (S.channels ||= new Map()).get(channelId);
    return rec ? channelServer(rec, server) : null;
}

// What the page's list draws from. Deliberately not the whole record: the page has no use for the
// manager, and nothing that lives in this file belongs on the wire by accident.
function channelPayload(webview) {
    const rec = channelOf(webview);
    if (!rec) return null;
    const candidates = channelCandidates();
    return {
        supported: rec.supported,
        // Only what is installed: a name the CLI would refuse is not worth a row. A channel that was
        // started and has since been uninstalled stays visible, because its session still runs it.
        servers: candidates
            .map(({ server, plugin }) => ({ server, plugin, ...channelServer(rec, server) }))
            .concat(
                Object.entries(rec.servers || {})
                    .filter(([server, s]) => s.status !== 'idle' && !candidates.some((c) => c.server === server))
                    .map(([server, s]) => ({ server, plugin: null, ...s })),
            ),
    };
}

function setChannel(channelId, patch) {
    const channels = (S.channels ||= new Map());
    const rec = channels.get(channelId) || { supported: false, servers: {}, pending: [] };
    Object.assign(rec, patch);
    channels.set(channelId, rec);
    return rec;
}

// Called from the patched bundle once per channel, right after the session's own init — the one moment
// this file can be handed both the session manager and that channel's id. The manager is kept because
// the click comes later, from a page that can reach neither.
function onChannelReady(manager, channelId) {
    try {
        if (!manager || !channelId || !manager.channels) return;
        S.channelHookSeen = true;
        (S.channelManagers ||= new Map()).set(channelId, manager);
        // Whether this build can do it at all is decided here and not at the click: a release whose SDK
        // predates `enableChannel` gets a menu that says so, instead of a click that goes nowhere.
        const record = manager.channels.get(channelId);
        const query = record && record.query;
        const rec = setChannel(channelId, { supported: Boolean(query && typeof query.enableChannel === 'function') });
        dlog('channel ready', { channelId, supported: rec.supported });
        const pending = (rec.pending || []).splice(0);
        if (rec.supported && pending.length) {
            for (const server of pending) {
                // A click remembered before the channel was up left its row saying "starting…" with no
                // request behind it, and startChannel refuses what is already starting; the start below
                // is the first one that actually goes out.
                Object.assign(channelServer(rec, server), { status: 'idle', error: null });
                startChannel(channelId, server);
            }
            return;
        }
    } catch (e) {
        dlog('channel ready failed', e && e.message);
        return;
    }
    broadcast();
}

function startChannel(channelId, server) {
    const rec = (S.channels ||= new Map()).get(channelId);
    if (!rec || typeof server !== 'string' || !server) return;
    const state = channelServer(rec, server);
    if (state.status === 'connecting' || state.status === 'enabled') return;
    let query = null;
    try {
        const manager = (S.channelManagers ||= new Map()).get(channelId);
        const record = manager && manager.channels.get(channelId);
        query = record && record.query;
    } catch {}
    if (!rec.supported || !query || typeof query.enableChannel !== 'function') {
        // Launched and not yet initialized: the click is remembered, and onChannelReady runs it. With no
        // hook in the build at all there is nothing to wait for, and the row says so.
        if (!rec.supported && S.channelHookSeen && !(S.channelManagers ||= new Map()).has(channelId)) {
            (rec.pending ||= []).push(server);
            Object.assign(state, { status: 'connecting', error: null });
        } else {
            Object.assign(state, { status: 'unsupported', error: 'this build of Claude Code has no channel support' });
        }
        broadcast();
        return;
    }
    Object.assign(state, { status: 'connecting', error: null });
    broadcast();
    const candidate = channelCandidates().find((item) => item.server === server);
    const mcpServer = candidate ? candidate.mcpServer : server;
    // Called as methods on the query, never detached: each control request is sent through `this`.
    // A server that failed before its environment was fixed remains behind the CLI's 15-minute failure
    // cache. The same live query can reconnect it; without that, every click can only repeat "not
    // connected" until a new session happens to start after the cache expires.
    Promise.resolve()
        .then(async () => {
            if (typeof query.mcpServerStatus === 'function' && typeof query.reconnectMcpServer === 'function') {
                const servers = await query.mcpServerStatus();
                const current = Array.isArray(servers) ? servers.find((item) => item && item.name === mcpServer) : null;
                // A server the CLI never managed to register is not in the list at all, so an absent
                // entry is a server to reconnect, not one to leave alone — and the reconnect is
                // best-effort either way: the answer that matters is the one enableChannel gives, so a
                // refusal here must not take the click down with it.
                if (!current || current.status !== 'connected') {
                    try {
                        await query.reconnectMcpServer(mcpServer);
                    } catch (e) {
                        dlog('channel reconnect failed', { channelId, mcpServer, error: (e && e.message) || String(e) });
                    }
                }
            }
            await query.enableChannel(mcpServer);
        })
        .then(() => {
            // Looked up again rather than closed over: the answer can arrive after a relaunch has
            // dropped this record, and the state it would write is one nobody is drawing any more.
            const s = channelStateOf(channelId, server);
            if (!s) return;
            Object.assign(s, { status: 'enabled', error: null });
            dlog('channel enabled', { channelId, server, mcpServer });
            broadcast();
        })
        .catch((e) => {
            const s = channelStateOf(channelId, server);
            const message = (e && e.message) || String(e);
            if (!s) return;
            Object.assign(s, { status: 'error', error: message });
            dlog('channel enable failed', { channelId, server, error: message });
            broadcast();
        });
}

function stateFor(sessionId, webview) {
    const profiles = listProfiles();
    const active = effectiveProfile(sessionId, webview);
    const health = providerHealth();
    return {
        // A weak id stays on the host. The page adopts whatever arrives here as state.sessionId and
        // hands it straight back on ccx:apply as the id to resume — so a weak one would leave here as
        // a guess and come back as an authoritative `--resume <id>`. It resolves the profile and the
        // models exactly as before; it is only not repeated to the page.
        sessionId: (webview && webview.__ccxSessionWeak ? null : sessionId) || null,
        active,
        // The profile new tabs fall back to, for the picker's default marker
        defaultProfile: loadDefaultProfile(),
        // The history list resolves each row's provider from here
        bindings: loadBindings(),
        attachmentPrompts: attachmentPrompts(),
        hiddenMessages: hiddenMessagesFor(sessionId),
        // Not about this tab's session — the whole list, since the history list is what reads it
        pinnedSessions: loadPinned(),
        historyBeforeCompaction: historyBeforeCompaction(),
        // Drawn on the "Sign in to ChatGPT" row in Settings. `signingIn` is host state, not file
        // state: a flow already running is what the row has to show instead of starting a second one.
        chatgpt: { ...(signin() ? signin().status(DIR) : { loggedIn: false }), signingIn: Boolean(S.chatgptSigningIn) },
        // This tab's plugin channel, or null before a session exists (and on a build the channel hook
        // never reached). The tag on the "Telegram channel" row is drawn from this.
        channel: channelPayload(webview),
        // This window's own client of a channel plugin, when one is running: it is what answers a
        // permission question from the channel, so whether it is up is a fact about the window rather
        // than about any tab.
        relay: (() => {
            const state = relayState();
            return {
                status: state.relay ? state.status : state.status === 'error' ? 'error' : 'off',
                server: state.server,
                chatId: state.chatId,
                target: loadRelayTarget(),
                targets: relayTargets(),
                pending: state.pending ? state.pending.size : 0,
                error: state.error,
            };
        })(),
        models: active && active !== 'claude' ? modelsOf(active) : null,
        // `now` rather than a per-row Date.now(): every age in the panel is then measured from the
        // same instant, so two rows probed together never read as a minute apart.
        now: Date.now(),
        profiles: profiles.map((name) => {
            const env = profileEnv(name);
            return {
                name,
                model: modelOf(env),
                baseUrl: env.ANTHROPIC_BASE_URL || '',
                endpoint: endpointOf(name, env),
                health: healthFor(name, health),
            };
        }),
    };
}

// Profile icon lives next to the profile itself: ~/.claude/profiles/<name>.png|svg
function profileIconFile(name) {
    for (const ext of ICON_EXTENSIONS) {
        const file = path.join(PROFILES_DIR, `${name}.${ext}`);
        if (fs.existsSync(file)) return file;
    }
    return null;
}

function hue(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
}

function generatedIcon(name) {
    const color = `hsl(${hue(name)} 65% 52%)`;
    const letter = name[0].toUpperCase();
    const svg =
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` +
        `<circle cx="8" cy="8" r="7" fill="${color}"/>` +
        `<text x="8" y="11.5" font-family="Segoe UI, sans-serif" font-size="9" font-weight="600" ` +
        `text-anchor="middle" fill="#fff">${letter}</text></svg>`;
    const out = path.join(ICONS_DIR, 'generated', `${name}.svg`);
    try {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        if (!fs.existsSync(out) || fs.readFileSync(out, 'utf8') !== svg) fs.writeFileSync(out, svg, 'utf8');
        return out;
    } catch {
        return null;
    }
}

function iconForProfile(name) {
    if (!name) return defaultIcon();
    const own = profileIconFile(name);
    if (own) return own;
    // Anthropic subscription profile (empty env) without its own icon keeps the stock logo
    if (Object.keys(profileEnv(name)).length === 0) return defaultIcon();
    return generatedIcon(name) || defaultIcon();
}

function brandIconFor(panel) {
    const profile = panelProfile(panel);
    if (!profile) return null;
    const icon = iconForProfile(profile);
    return icon && icon !== defaultIcon() ? icon : null;
}

// Which of the three stock logos the extension is trying to install, if any
function stockLogoState(value) {
    const uri = value && (value.fsPath || value.path || value.light?.fsPath || value.light?.path);
    if (typeof uri !== 'string') return null;
    const file = path.basename(uri).toLowerCase();
    for (const [state, name] of Object.entries(STOCK_LOGO)) if (file === name) return state;
    return null;
}

const BADGE_COLOR = { done: '#D97757', pending: '#3B82F6' };
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' };

// A stock indicator icon is the logo with a hole punched in the corner and a dot dropped into it.
// Repeat that geometry over the profile icon, otherwise indication simply replaces the brand.
function badgedIcon(src, state) {
    const color = BADGE_COLOR[state];
    if (!color) return src;
    const cache = (S.badges ||= new Map());
    const key = `${src}|${state}`;
    try {
        const { mtimeMs, size } = fs.statSync(src);
        const hit = cache.get(key);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size && fs.existsSync(hit.out)) return hit.out;

        const ext = path.extname(src).toLowerCase();
        const data = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(src).toString('base64')}`;
        const svg =
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em">` +
            `<defs><mask id="ccx-badge"><rect width="24" height="24" fill="white"/>` +
            `<circle cx="19.5" cy="4.5" r="6.5" fill="black"/></mask></defs>` +
            `<image href="${data}" x="0" y="0" width="24" height="24" mask="url(#ccx-badge)"/>` +
            `<circle cx="19.5" cy="4.5" r="4.5" fill="${color}"/></svg>`;
        const out = path.join(ICONS_DIR, 'badged', `${path.basename(src, ext)}-${state}.svg`);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        let current = null;
        try {
            current = fs.readFileSync(out, 'utf8');
        } catch {}
        if (current !== svg) fs.writeFileSync(out, svg, 'utf8');
        cache.set(key, { mtimeMs, size, out });
        return out;
    } catch {
        return src;
    }
}

// The webview cannot reference ~/.claude/profiles by URI — localResourceRoots covers only the
// extension's own webview/ and resources/ — so the bytes travel inside the message instead.
// The webview CSP lists data: in img-src, which is what makes this work at all.
function iconDataUri(file) {
    if (!file) return null;
    // Cached on S, not in a module const: the injected require() drops this module from the cache every call
    const cache = (S.iconUris ||= new Map());
    try {
        const { mtimeMs, size } = fs.statSync(file);
        if (size > MAX_ICON_BYTES) return null;
        const hit = cache.get(file);
        if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.uri;
        const ext = path.extname(file).toLowerCase();
        const uri = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
        cache.set(file, { mtimeMs, size, uri });
        return uri;
    } catch {
        return null;
    }
}

// { profileName: dataUri } — the same resolution order as the tab icon, without the state badge:
// the history list wants the plain brand mark, not a pending/done indicator
function profileIcons() {
    const out = {};
    for (const name of listProfiles()) {
        try {
            const uri = iconDataUri(iconForProfile(name));
            if (uri) out[name] = uri;
        } catch {}
    }
    return out;
}

function iconFor(panel, state) {
    const brand = brandIconFor(panel);
    if (brand) return badgedIcon(brand, state);
    return defaultIcon(state) || defaultIcon();
}

function hookIcon(panel) {
    if (panel.__ccxIconHooked) return;
    const proto = Object.getPrototypeOf(panel);
    const d =
        Object.getOwnPropertyDescriptor(panel, 'iconPath') || (proto && Object.getOwnPropertyDescriptor(proto, 'iconPath'));
    if (!d || !d.set || !d.get) return;
    panel.__ccxIconHooked = true;
    Object.defineProperty(panel, 'iconPath', {
        configurable: true,
        enumerable: d.enumerable,
        get() {
            return d.get.call(panel);
        },
        set(value) {
            const state = stockLogoState(value);
            if (!state) return d.set.call(panel, value);
            // Remembered so a later decorate() re-paints the icon in the state the extension last asked for
            panel.__ccxIconState = state;
            const icon = iconFor(panel, state);
            if (!icon) return d.set.call(panel, value);
            const uri = vscode.Uri.file(icon);
            d.set.call(panel, { light: uri, dark: uri });
        },
    });
}

function decorate(panel) {
    hookIcon(panel);
    try {
        const uri = vscode.Uri.file(iconFor(panel, panel.__ccxIconState || 'idle'));
        panel.iconPath = { light: uri, dark: uri };
    } catch {}
}

function post(webview, message) {
    try {
        Promise.resolve(webview.postMessage(message)).catch(() => S.webviews.delete(webview));
    } catch {
        S.webviews.delete(webview);
    }
}

// A session with no binding ran on whatever settings.json said at the time, so the row falls back to the
// profile that matches settings.json now — for an untouched install that is the Anthropic subscription and
// the stock mark. Where settings.json points somewhere no profile describes, we genuinely do not know.
function fallbackIcon(icons) {
    // A session with no binding of its own ran on the default provider now that one is set, so the row
    // shows that mark; without one it falls back to the profile settings.json points at, as before.
    const name = loadDefaultProfile() || profileFromSettings();
    if (name) return icons[name] ? { name, uri: icons[name] } : null;
    if (currentEnv().ANTHROPIC_BASE_URL) return null;
    const uri = iconDataUri(defaultIcon());
    return uri ? { name: 'claude', uri } : null;
}

// Tens of kilobytes of base64. Sent once per webview and again only when the icon set actually
// changes — deliberately not folded into ccx:state, which is re-posted on every binding write
function postIcons(webview) {
    try {
        const icons = profileIcons();
        const fallback = fallbackIcon(icons);
        const stamp =
            Object.keys(icons)
                .map((n) => `${n}:${icons[n].length}`)
                .join(',') + `|${fallback ? `${fallback.name}:${fallback.uri.length}` : ''}`;
        if (webview.__ccxIconStamp === stamp) return;
        webview.__ccxIconStamp = stamp;
        post(webview, { type: 'ccx:icons', icons, fallback });
    } catch {}
}

function broadcast() {
    for (const panel of S.panels.keys()) decorate(panel);
    for (const w of S.webviews) {
        postIcons(w);
        const sessionId = w.__ccxSessionId || null;
        post(w, { type: 'ccx:state', ...stateFor(sessionId, w) });
    }
}

// Returns the watcher: without it the caller's `if (!S.xWatcher)` guard never latches and every
// attach installs another fs.watch on the same directory
function watchFile(file, onChange) {
    if (!fs.existsSync(path.dirname(file))) return null;
    let timer = null;
    try {
        return fs.watch(path.dirname(file), (_e, name) => {
            if (name && path.basename(file) !== name) return;
            clearTimeout(timer);
            timer = setTimeout(onChange, 200);
        });
    } catch {
        return null;
    }
}

function watchDir(dir, onChange, delay = 200) {
    if (!fs.existsSync(dir)) return null;
    let timer = null;
    try {
        return fs.watch(dir, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, delay);
        });
    } catch {
        return null;
    }
}

const PATCHER = path.join(DIR, 'apply-patch.mjs');
// A folder still being unpacked reads exactly like one whose signatures moved, so a failure is retried
// a couple of times before it is reported
const REPATCH_TRIES = 3;

function offerReload(message) {
    try {
        vscode.window.showInformationMessage(message, 'Reload Window').then((choice) => {
            if (choice === 'Reload Window') vscode.commands.executeCommand('workbench.action.reloadWindow');
        });
    } catch {}
}

// Matching signatures are not a promise that the code around them still means the same thing — most of
// them match the *shape* of an assignment, and a release can move what is being assigned without moving
// the shape. A hand-run patch prints the version mismatch for someone who is reading; an automatic one
// has no reader, so the notification is the only place the mismatch can surface.
function reloadMessage(out) {
    const [, installed, verified] = out.match(/^ccx-unverified: (\S+) (\S+)$/m) || [];
    if (!installed) return 'Vannevar: Claude Code was updated — the patch has been re-applied.';
    return (
        `Vannevar: the patch was re-applied on Claude Code ${installed}, which is newer than the ` +
        `${verified} it was verified against. It went on cleanly, but nothing has checked this release.`
    );
}

function versionOfDir(dir) {
    return (path.basename(dir).match(/(\d+\.\d+\.\d+)/) || [])[1] || null;
}

// The fix for a patch that no longer fits arrives as an extension update, so the two things worth
// offering are the updater and the log. "Check for Updates" is the stock command — on a machine where
// the marketplace copy is installed it is the whole remedy, and on one running a .vsix by hand it is a
// no-op that costs a click.
function showUpdateProblem(message) {
    try {
        vscode.window.showWarningMessage(message, 'Check for Updates', 'Show log').then((choice) => {
            if (choice === 'Check for Updates')
                vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
            if (choice === 'Show log') vscode.window.showTextDocument(vscode.Uri.file(LOG_FILE));
        });
    } catch {}
}

// --- a Vannevar Code update that landed with the Claude Code one ----------------------------------
//
// The runtime under ~/.claude/vannevar is a copy, taken by extension.js at activation. On the day a
// Claude Code release moves a signature, both folders appear within minutes of each other: VS Code
// installs the new Claude Code and the new Vannevar Code that knows it. The copy in this window is the
// old one, and sending it at the new bundle would fail on signatures that the version sitting on disk
// beside it already handles — one false warning, then a reload, then a second reload once the fresh
// copy patches for real.
//
// So the newest extension folder is consulted first, and its runtime/ replaces the copy before the
// patcher runs. Nothing is downloaded here: those files were installed by the VS Code updater, which is
// the same trust path as the code running this line.
const SELF_ID = 'beatlejute.vannevarcode';

function semver(text) {
    const m = String(text || '').match(/(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
}

function newer(a, b) {
    const [x, y] = [semver(a), semver(b)];
    if (!x) return false;
    if (!y) return true;
    return (x[0] - y[0] || x[1] - y[1] || x[2] - y[2]) > 0;
}

function newestSelfDir() {
    const root = extensionsRoot();
    try {
        let obsolete = {};
        try {
            obsolete = JSON.parse(fs.readFileSync(path.join(root, '.obsolete'), 'utf8')) || {};
        } catch {}
        const dirs = fs
            .readdirSync(root)
            .filter((d) => d.toLowerCase().startsWith(`${SELF_ID}-`) && !obsolete[d] && semver(d))
            .sort((a, b) => {
                const [x, y] = [semver(a), semver(b)];
                return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
            });
        return dirs.length ? path.join(root, dirs.at(-1)) : null;
    } catch {
        return null;
    }
}

// Returns the version it installed, or null when the copy on disk is already current
function syncRuntimeFromNewestExtension(claudeDir) {
    const dir = newestSelfDir();
    if (!dir) return null;
    const source = path.join(dir, 'runtime');
    if (!fs.existsSync(source)) return null;

    let pkg = null;
    try {
        pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
        return null;
    }
    const installed = pkg.version;
    const running = readJson(STAMP_FILE)?.version || null;
    if (!installed || !newer(installed, running)) return null;

    try {
        fs.cpSync(source, DIR, { recursive: true, force: true });
        writeJson(STAMP_FILE, {
            version: installed,
            verifiedAgainst: Array.isArray(pkg.verifiedAgainst) ? pkg.verifiedAgainst : [],
            extensionPath: claudeDir,
        });
    } catch (e) {
        dlog('runtime sync failed', { dir, error: String(e && e.message) });
        return null;
    }
    dlog('runtime synced', { from: running, to: installed });
    return installed;
}

// A Claude Code update installs a new folder beside the running one, and the patch lives inside the
// folder it replaces — so every update throws it away. This window keeps running the old, patched
// bundle until it reloads, and that is the only stretch of time in which anything of Vannevar is
// alive to notice: the window that comes up afterwards loads a clean bundle, which never requires this
// file. Patching the new folder now means the reload VS Code is about to ask for comes up patched, with
// no second reload and nothing to run by hand. The case this cannot reach — an update applied while VS
// Code was closed — is what extension.js covers on the next activation.
//
// process.execPath is Code.exe in the extension host; ELECTRON_RUN_AS_NODE turns it back into node, the
// same way the proxy is spawned.
function repatchAfterUpdate() {
    const tries = (S.repatchTries ||= new Map());
    if (S.repatching || !fs.existsSync(PATCHER)) return;

    let running = null;
    try {
        running = vscode.extensions.getExtension('anthropic.claude-code')?.extensionPath || null;
    } catch {}
    const newest = newestExtensionDir();
    if (!running || !newest || path.resolve(newest) === path.resolve(running)) return;

    // Every write anywhere under ~/.vscode/extensions wakes the watcher, so a folder already settled —
    // patched, or refused because its signatures moved — must not be spawned against again
    const attempt = tries.get(newest) || 0;
    if (attempt >= REPATCH_TRIES) return;
    tries.set(newest, attempt + 1);
    S.repatching = true;

    // Before the frozen copy is sent at the new bundle: if a newer Vannevar Code was installed beside
    // it, that one's runtime replaces this copy, patcher included. See above for why the two updates
    // arrive together.
    syncRuntimeFromNewestExtension(newest);

    let out = '';
    const settle = (code) => {
        S.repatching = false;
        dlog('repatch', { dir: path.basename(newest), code, out: out.trim() });
        if (code === 0) {
            tries.set(newest, REPATCH_TRIES);
            if (out.includes('ccx-result: patched')) offerReload(reloadMessage(out));
            return;
        }
        if (attempt + 1 < REPATCH_TRIES) return void setTimeout(repatchAfterUpdate, 15000);
        // The patcher never writes when a signature no longer matches, so the new bundle is intact and
        // clean: Claude Code works, Vannevar is off until a release with new signatures is installed.
        const version = versionOfDir(newest) || 'as installed';
        showUpdateProblem(
            `Vannevar: the patch does not fit Claude Code ${version} — its signatures moved, so it ` +
                'was not applied. Claude Code itself is untouched and working.',
        );
    };

    try {
        const child = spawn(process.execPath, [PATCHER, '--if-needed', `--dir=${newest}`], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true,
        });
        child.stdout.on('data', (b) => (out += b));
        child.stderr.on('data', (b) => (out += b));
        child.on('error', (e) => {
            out += `\n${e.message}`;
            settle(1);
        });
        child.on('close', settle);
    } catch (e) {
        out += `\n${e.message}`;
        settle(1);
    }
}

// Installed from attachWebview, not only from attachPanel: the session list is a sidebar webview
// with no panel of its own, and it still has to see bindings.json change to repaint its icons
function ensureWatchers() {
    if (!S.agentRunsWatcher) {
        try {
            fs.mkdirSync(AGENT_RUNS_DIR, { recursive: true });
        } catch {}
        S.agentRunsWatcher = watchDir(AGENT_RUNS_DIR, wakeAgentRuns);
    }
    if (!S.settingsWatcher) S.settingsWatcher = watchFile(SETTINGS_FILE, broadcast);
    if (!S.bindingsWatcher) S.bindingsWatcher = watchFile(BINDINGS_FILE, broadcast);
    if (!S.defaultWatcher) S.defaultWatcher = watchFile(DEFAULT_PROFILE_FILE, broadcast);
    if (!S.profilesWatcher) S.profilesWatcher = watchDir(PROFILES_DIR, broadcast);
    // Written by a different process — the MCP server, from whichever run happens to probe next — so
    // the panel only ever learns a provider went down by watching the file it lands in.
    if (!S.healthWatcher) S.healthWatcher = watchFile(HEALTH_FILE, broadcast);
    if (!S.extensionsWatcher) {
        // An extension install writes a whole tree and then renames it into place, so the burst is long
        // — 200 ms would spawn the patcher at a half-written folder
        S.extensionsWatcher = watchDir(extensionsRoot(), repatchAfterUpdate, 3000);
        // The update may already have landed before this tab was opened, and that write is gone
        repatchAfterUpdate();
    }
}

function panelFor(webview) {
    for (const p of S.panels.keys()) if (p.webview === webview) return p;
    return null;
}

// `weak` marks an id lifted out of a request envelope rather than out of this tab's own channel.
// Those ids are not reliably the active session, so they may only fill a gap — never overwrite an id
// the channel gave us, and never create a binding. Getting that wrong writes a profile against a
// session the user never switched, and the wrong provider then sticks to it.
function noteSessionId(webview, sessionId, weak = false) {
    if (!sessionId || webview.__ccxSessionId === sessionId) return;
    if (weak && webview.__ccxSessionId) return;
    webview.__ccxSessionId = sessionId;
    // A cache tier belongs to one conversation. The next cached response establishes it again; carrying
    // it across a tab changing sessions would schedule /compact against the wrong transcript.
    delete webview.__ccxPromptCacheTier;
    // Remembered so a later ccx:apply does not bind against an id only a weak source ever confirmed
    webview.__ccxSessionWeak = weak;
    const forTab = S.profileByWebview.get(webview);
    if (forTab && !weak) setBinding(sessionId, forTab);
    const panel = panelFor(webview);
    if (panel) {
        S.activeSessionByPanel.set(panel, sessionId);
        decorate(panel);
    }
    post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
}

// Where a turn's usage sits depends on the shape the CLI streams. The assistant message carries it in
// full and is the one this channel actually sees; `message_delta` arrives only as a partial-message
// event, and as a bare SDK type it belongs to the SDK's own SSE accumulator *inside* extension.js,
// which never reaches a webview. Reading that bare type was the whole reason the first version of
// auto-compaction never fired once — the branch matched nothing, silently.
function sdkUsage(sdk) {
    if (sdk.type === 'assistant') return (sdk.message && sdk.message.usage) || null;
    if (sdk.type === 'stream_event') return (sdk.event && sdk.event.usage) || null;
    if (sdk.type === 'message_delta') return sdk.usage || null;
    return null;
}

// The lifetime of a non-Anthropic prefix cache, as the profile declares it. No provider puts an
// expiry in a response, so a backend that is not the Anthropic API leaves the page with a hit and no
// deadline; `cache: { ttlMinutes }` is the operator's reading of the provider's documentation, and
// the page is handed it as its own kind of signal so the two can never be confused downstream.
// Read per hit rather than cached: a profile edited mid-session applies on the next turn, which is
// the rule the rest of this file follows, and one small read per assistant turn is not worth a
// watcher of its own.
function declaredCacheTtl(name) {
    if (!name) return 0;
    const raw = readJson(path.join(PROFILES_DIR, name + '.json'));
    const c = raw && raw.cache;
    const ttl = c && Number(c.ttlMinutes);
    return Number.isFinite(ttl) && ttl > 0 ? ttl : 0;
}

function interceptOutgoing(webview) {
    if (webview.__ccxPatched) return;
    webview.__ccxPatched = true;
    const original = webview.postMessage.bind(webview);
    webview.postMessage = (msg) => {
        try {
            const envelope = msg && msg.type === 'from-extension' ? msg.message : null;
            const sdk = envelope && envelope.type === 'io_message' ? envelope.message : null;
            if (sdk && sdk.type === 'system' && sdk.subtype === 'init' && sdk.session_id)
                noteSessionId(webview, sdk.session_id);
            // A turn's usage carries the cache_creation split the page's own TTL indicator reads, and
            // only a turn that *wrote* cache names a tier: a turn that merely read one reports the
            // split as zeros, which means "no write this time", not "no longer 1h". The stock helper
            // says the same by returning undefined there and falling back to the ttl it already had.
            // So the tier is remembered, and every cached turn — read or write — moves the anchor,
            // since a read renews the lifetime just as a write establishes it.
            const usage = sdk && sdkUsage(sdk);
            if (usage) {
                const cc = usage.cache_creation;
                if (cc) {
                    const before = webview.__ccxPromptCacheTier;
                    if (Number(cc.ephemeral_1h_input_tokens) > 0) webview.__ccxPromptCacheTier = '1h';
                    else if (Number(cc.ephemeral_5m_input_tokens) > 0) webview.__ccxPromptCacheTier = '5m';
                    // Once per session in practice: the tier is established on the first cached turn and
                    // then only repeats itself. A guard that matches nothing is indistinguishable from a
                    // quiet feature, and that is exactly how the first version of this hid for a day.
                    if (webview.__ccxPromptCacheTier !== before)
                        dlog('prompt cache tier', { tier: webview.__ccxPromptCacheTier });
                }
                const cached =
                    Number(usage.cache_read_input_tokens) > 0 || Number(usage.cache_creation_input_tokens) > 0;
                if (cached && webview.__ccxPromptCacheTier === '1h')
                    post(webview, { type: 'ccx:cache', ttl: '1h', anchorAt: Date.now() });
                else if (cached) {
                    // Where the split says nothing, a declared lifetime is all there is. A hit renews
                    // it exactly as it renews the tier, so the anchor moves on every cached turn.
                    // Nothing is sent for a profile that declares none — silence is the honest answer
                    // for a backend whose retention nobody wrote down.
                    const name = effectiveProfile(webview.__ccxSessionId, webview);
                    const ttlMinutes = declaredCacheTtl(name);
                    if (ttlMinutes) {
                        // Logged on change, like the tier above: a lifetime that never reaches the page
                        // is otherwise indistinguishable from a profile that declares nothing at all,
                        // and that is the question this line exists to answer.
                        if (webview.__ccxDeclaredCache !== ttlMinutes) {
                            webview.__ccxDeclaredCache = ttlMinutes;
                            dlog('declared cache ttl', { ttlMinutes, profile: name });
                        }
                        post(webview, {
                            type: 'ccx:cache',
                            ttl: 'declared',
                            ttlMinutes,
                            profile: name,
                            anchorAt: Date.now(),
                        });
                    }
                }
            }
        } catch {}
        return original(msg);
    };
}

function attachWebview(webview) {
    interceptOutgoing(webview);
    ensureWatchers();
    if (S.webviews.has(webview)) return;
    S.webviews.add(webview);

    webview.onDidReceiveMessage((m) => {
        if (!m || typeof m.type !== 'string') return;
        // The tab the user is last in is the only notion of "current" this host has, and it is where a
        // message that arrives from outside belongs.
        S.lastActiveWebview = webview;
        // The tab's own title, as the page renames it — the only human-readable name a tab has, and
        // the one the Channels picker shows instead of a session id.
        if (m.type === 'request' && m.request && m.request.type === 'rename_tab' && typeof m.request.title === 'string') {
            webview.__ccxTitle = m.request.title;
        }

        if (m.type === 'launch_claude') {
            if (m.resume) webview.__ccxSessionId = m.resume;
            // The channel id was only ever logged before this. It is the key the session manager will
            // hand over with, so it is kept — and the previous one dropped, unless another tab is still
            // pointing at it, because a relaunch is a new channel with a new id.
            if (typeof m.channelId === 'string' && m.channelId) {
                const previous = webview.__ccxChannelId;
                webview.__ccxChannelId = m.channelId;
                setChannel(m.channelId, {});
                if (previous && previous !== m.channelId && ![...S.webviews].some((w) => w !== webview && w.__ccxChannelId === previous)) {
                    (S.channels ||= new Map()).delete(previous);
                    (S.channelManagers ||= new Map()).delete(previous);
                }
            }
            S.pendingProfile = S.profileByWebview.get(webview) || getBinding(m.resume) || null;
            dlog('launch_claude', { channelId: m.channelId, resume: m.resume || null, profile: S.pendingProfile });
            // A default provider routes through the same local adapter as a picked one, so its proxy has
            // to be up before the first request; envFor will resolve to it the same way.
            if (S.pendingProfile) ensureProxy(S.pendingProfile);
            else {
                const def = loadDefaultProfile();
                if (def) ensureProxy(def);
            }
            return;
        }
        // Launch is not the only moment the adapter has to be up. It is a detached process, so it can
        // outlive nothing in particular: a crash, a kill, or the machine sleeping leaves the port shut
        // while the tab stays open, and every prompt then dies on ConnectionRefused with no path back —
        // the CLI's retries cannot help, and nothing here was listening. `io_message` is the webview
        // handing over a user turn, which is exactly when it matters, and ensureProxy already no-ops
        // unless the profile routes through 127.0.0.1 and that port is actually closed.
        if (m.type === 'io_message') {
            const profile = effectiveProfile(webview.__ccxSessionId, webview);
            if (profile && localProxyPort(profile)) ensureProxy(profile);
            return;
        }
        // Only update_session_state is about the tab's own session; delete_session, rename_session and
        // open_in_editor carry the id of whichever history row the user clicked. Even this one is emitted
        // once more for the session that just STOPPED being active, so it counts as a weak source.
        if (m.type === 'request' && m.request && m.request.type === 'update_session_state') {
            const id = m.request.sessionId;
            if (id && typeof id === 'string') noteSessionId(webview, id, true);
        }
        // A pin outlives the session it points at unless the deletion is noticed here — this is the
        // only moment the id passes through, and the row is gone by the time anything else looks.
        if (m.type === 'request' && m.request && m.request.type === 'delete_session') {
            if (forgetPinned(m.request.sessionId)) broadcast();
        }
        if (!m.type.startsWith('ccx:')) return;

        const sessionId = webview.__ccxSessionId || m.sessionId || null;
        if (m.type === 'ccx:get') {
            // The icon set is sent once per webview and then only when it changes — but the first
            // send happens in renderScript(), while the HTML is still being built and no page exists
            // to receive it. That message is dropped, the stamp is not, and every later postIcons()
            // then returns early: a tab that missed the opening send would never see a brand mark
            // again. ccx:get is the page saying it has just started and holds nothing, so the stamp
            // goes with it.
            webview.__ccxIconStamp = null;
            postIcons(webview);
            post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
            // A tab that opens while a run is already going gets its frame filled in rather than
            // waiting for the next line of that agent's transcript.
            S.agentRunsStamp = null;
            wakeAgentRuns();
        } else if (m.type === 'ccx:cachePill') {
            // Where the page managed to put the declared countdown and what the row actually held.
            // Every class name in the composer carries a per-build hash, so when the pill lands in the
            // wrong place the answer is in the markup the page is looking at, not in the pattern it
            // was looking for — and a log line is cheaper than a session of guessing.
            dlog('cache pill', { stage: m.stage, kids: String(m.kids || '').slice(0, 300) });
        } else if (m.type === 'ccx:session') {
            // The webview tracks the active channel itself, so this id is authoritative
            webview.__ccxSessionId = m.sessionId || null;
            webview.__ccxSessionWeak = false;
            const forTab = S.profileByWebview.get(webview);
            if (webview.__ccxSessionId && forTab) setBinding(webview.__ccxSessionId, forTab);
            for (const p of S.panels.keys())
                if (p.webview === webview) {
                    S.activeSessionByPanel.set(p, webview.__ccxSessionId);
                    decorate(p);
                }
            post(webview, { type: 'ccx:state', ...stateFor(webview.__ccxSessionId, webview) });
        } else if (m.type === 'ccx:apply') {
            const name = m.name || null;
            try {
                S.profileByWebview.set(webview, name);
                S.pendingProfile = name;
                if (name) {
                    ensureProxy(name);
                    warnSettingsOverride(name);
                }
                // m.sessionId comes from the webview's own channel bookkeeping, so it outranks an id
                // only a weak source confirmed. With neither, the binding waits: profileByWebview is
                // already set, so noteSessionId writes it as soon as the channel reports a real id.
                //
                // A weak id is never echoed back either — the webview adopts whatever it receives here
                // as state.sessionId and resumes on it, so handing it a guess would reopen the wrong
                // conversation. Sending null leaves it on its own per-channel record, which is right.
                const known = (webview.__ccxSessionWeak ? null : webview.__ccxSessionId) || m.sessionId || null;
                if (known) setBinding(known, name);
                broadcast();
                dlog('ccx:apply', { name, sessionId: known, bound: Boolean(known) });
                post(webview, { type: 'ccx:applied', sessionId: known, name });
            } catch (e) {
                vscode.window.showErrorMessage(`Provider switch failed: ${e.message}`);
            }
        } else if (m.type === 'ccx:searchContent') {
            post(webview, { type: 'ccx:searchResults', seq: m.seq, matches: searchTranscripts(m.query, m.sessionIds) });
        } else if (m.type === 'ccx:openResource') {
            openResource(m, webview);
        } else if (m.type === 'ccx:spellcheck') {
            // The request contains a bounded, de-duplicated list of Russian words, not the draft. Do
            // not log it: a prompt can contain names, hostnames or other sensitive project context.
            checkedWords(m.words).then((result) => {
                post(webview, {
                    type: 'ccx:spellcheckResult',
                    seq: typeof m.seq === 'number' ? m.seq : null,
                    unknown: result ? [...result.unknown] : null,
                    suggestions: result ? result.suggestions : null,
                });
            });
        } else if (m.type === 'ccx:agentTranscript') {
            post(webview, { type: 'ccx:agentReply', seq: m.seq, ...agentTranscript(m.session) });
        } else if (m.type === 'ccx:stopAgent') {
            post(webview, { type: 'ccx:agentReply', seq: m.seq, ...requestAgentStop(m.session) });
        } else if (m.type === 'ccx:debug') {
            dlog('ccx:debug indicator', m);
        } else if (m.type === 'ccx:pinSession') {
            // The row's own id, not the tab's: the pin is toggled from whichever history row was
            // clicked, exactly like delete_session and rename_session above.
            if (m.sessionId && typeof m.sessionId === 'string') {
                setPinned(m.sessionId, Boolean(m.pinned));
                // Every tab draws the same history list, so all of them have to be told.
                broadcast();
            }
        } else if (m.type === 'ccx:historyBeforeCompaction') {
            setHistoryBeforeCompaction(m.enabled);
            dlog('history before compaction', { enabled: Boolean(m.enabled) });
            // One switch for every tab: each of them draws it in its own menu.
            broadcast();
        } else if (m.type === 'ccx:setDefault') {
            const name = m.name || null;
            saveDefaultProfile(name);
            if (name) warnSettingsOverride(name);
            // Every tab's picker draws the same default marker, so all of them have to be told.
            broadcast();
        } else if (m.type === 'ccx:openProfile') {
            openProfileFile(m.name);
        } else if (m.type === 'ccx:chatgptLogin') {
            startChatgptLogin();
        } else if (m.type === 'ccx:relay') {
            // The relay is this window's own client of a channel plugin, and it is what makes a
            // permission question answerable away from the editor. One at a time, for the same reason a
            // bot may be polled once.
            const server = typeof m.server === 'string' ? m.server : '';
            const result = m.on ? startChannelRelay(server) : stopChannelRelay();
            if (!result.ok) {
                // The row is where a refusal belongs: the page draws it from the same state the rest of
                // the list comes from, so an error here is visible without a second surface.
                Object.assign(relayState(), { status: 'error', error: result.error });
                dlog('relay refused', result.error);
            }
            broadcast();
        } else if (m.type === 'ccx:relayTarget') {
            // The answer to "who is this conversation with": a session id, or nothing to go back to the
            // fallback. Kept on disk because a reload must not silently change who is being talked to.
            const sessionId = typeof m.sessionId === 'string' && m.sessionId ? m.sessionId : null;
            saveRelayTarget(sessionId);
            dlog('relay target', sessionId || 'last active tab');
            broadcast();
        } else if (m.type === 'ccx:channelStart') {
            // The list is the only way in, and a click can land in three situations that are not the
            // same thing: a build where the hook never ran, a channel that is launched but has not
            // reported in yet, and one that is ready. startChannel answers each of them.
            const channelId = (typeof m.channelId === 'string' && m.channelId) || webview.__ccxChannelId;
            const server = typeof m.server === 'string' ? m.server : '';
            if (channelId && server) {
                if (!S.channelHookSeen) {
                    // The hook never ran: a build below the verified range, or a stale bundle. Said out
                    // loud rather than left spinning behind a click that can never land.
                    setChannel(channelId, { supported: false });
                    Object.assign(channelStateOf(channelId, server), {
                        status: 'unsupported',
                        error: 'channel support is not patched into this build',
                    });
                } else {
                    startChannel(channelId, server);
                }
                post(webview, { type: 'ccx:state', ...stateFor(sessionId, webview) });
            }
        } else if (m.type === 'ccx:hideMessages') {
            const id = m.sessionId || sessionId;
            if (id) {
                addHidden(id, m.uuids);
                // Echo the authoritative list back so the page's in-memory set converges on the file.
                post(webview, { type: 'ccx:state', ...stateFor(id, webview) });
            }
        }
    });

    postIcons(webview);
    post(webview, { type: 'ccx:state', ...stateFor(webview.__ccxSessionId, webview) });
}

function renderScript(webview, nonce) {
    let code;
    try {
        code = fs.readFileSync(path.join(DIR, 'webview.js'), 'utf8');
    } catch {
        return '';
    }
    attachWebview(webview);
    return `<script nonce="${nonce}">\n${code.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;
}

// --- A channel answering for the tabs ----------------------------------------------------------
//
// A channel plugin is transport and can be spoken to by anybody who can start it — the session is one
// client, not the only one. This host is another: it starts the same plugin the Channels list offers,
// speaks MCP to it, and can then ask the question a tab is already waiting on. The question is here
// because the CLI asks the host for permission decisions (that is what `--permission-prompt-tool
// stdio` means, and why the IDE draws the dialog at all); nothing needs to be reimplemented, only
// mirrored, and the first answer wins.
//
// What this is not: a way for a message to give itself permission. The sender is whoever the plugin
// already accepted (its own allowlist gate runs before a notification is ever emitted), the answer is
// matched to one outstanding request by its own id, and an unanswered question falls through to the
// dialog exactly as before. Nothing here approves anything by itself.
//
// One plugin may poll its network once, so this is a singleton by construction: starting a second one
// takes the channel away from whoever holds it — which is what the relay's marker on the command line
// settles between this host and the tabs.
const RELAY_MODULE = path.join(DIR, 'channel-relay.js');

function relayModule() {
    try {
        return require(RELAY_MODULE);
    } catch (e) {
        dlog('channel relay module missing', (e && e.message) || String(e));
        return null;
    }
}

function relayCommandFor(dir) {
    const mcp = readJson(path.join(dir, '.mcp.json'));
    const servers = mcp && mcp.mcpServers;
    if (!servers || typeof servers !== 'object') return null;
    for (const spec of Object.values(servers)) {
        if (spec && typeof spec.command === 'string') {
            return { command: spec.command, args: Array.isArray(spec.args) ? spec.args : [], env: spec.env };
        }
    }
    return null;
}

// Sending a message is the one thing a session cannot do by itself once the plugin is no longer
// loaded there: the bot belongs to this window. So the sessions ask the window. The request is a file
// because both ends are processes that can disappear, and a file is either there or not — the tool
// writes it whole, this side reads it, sends, and answers with a result file the tool is waiting for.
// Nothing about a bot token crosses this boundary: a session names a chat and some text.
const OUTBOX_DIR = path.join(DIR, 'outbox');
const RELAY_PING = path.join(DIR, 'relay.ping');

function relayOutboxDir() {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    return OUTBOX_DIR;
}

function relayTouchPing() {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        const now = new Date();
        try {
            fs.utimesSync(RELAY_PING, now, now);
        } catch {
            fs.writeFileSync(RELAY_PING, String(process.pid));
        }
    } catch (e) {
        dlog('relay ping failed', (e && e.message) || String(e));
    }
}

function relayDropPing() {
    try {
        fs.rmSync(RELAY_PING, { force: true });
    } catch {}
}

// Which tab a conversation belongs to. The channel is owned by the window, and a window has several
// sessions, so "the last one the user typed in" is a guess — this is the answer instead: a chosen
// session, remembered by its id (which survives a reload) rather than by the channel id (which does
// not, because a relaunch is a new channel).
const RELAY_TARGET_FILE = path.join(DIR, 'relay-target.json');

function loadRelayTarget() {
    const saved = readJson(RELAY_TARGET_FILE);
    return saved && typeof saved.sessionId === 'string' ? saved.sessionId : null;
}

function saveRelayTarget(sessionId) {
    try {
        if (sessionId) fs.writeFileSync(RELAY_TARGET_FILE, JSON.stringify({ sessionId }, null, 2));
        else fs.rmSync(RELAY_TARGET_FILE, { force: true });
    } catch (e) {
        dlog('relay target save failed', (e && e.message) || String(e));
    }
}

// Every tab this window currently has, as the page needs them: the id to bind by, and the channel
// that is live right now for delivery.
function relayTargets() {
    const list = [];
    for (const webview of S.webviews || []) {
        const sessionId = webview.__ccxSessionId;
        if (!sessionId) continue;
        list.push({ sessionId, channelId: webview.__ccxChannelId || null, title: webview.__ccxTitle || null });
    }
    return list;
}

// The heartbeat is how the tool tells "the window is here" from "the window is gone": a stale file is
// the only signal a session can get, and a message written into a queue nobody reads is worse than a
// refusal the model can report.
function relayHeartbeatFresh() {
    try {
        return Date.now() - fs.statSync(RELAY_PING).mtimeMs < 3000;
    } catch {
        return false;
    }
}

function relayDrainOutbox() {
    const state = relayState();
    let files;
    try {
        files = fs
            .readdirSync(relayOutboxDir())
            // A result file is the answer to a request, not one: reading it as a request would send the
            // same message twice.
            .filter((name) => name.endsWith('.json') && !name.endsWith('.result.json'));
    } catch {
        return;
    }
    for (const name of files) {
        const file = path.join(OUTBOX_DIR, name);
        let request;
        try {
            request = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            try {
                fs.rmSync(file, { force: true });
            } catch {}
            continue;
        }
        const answer = (payload) => {
            try {
                fs.writeFileSync(file.replace(/\.json$/, '.result.json'), JSON.stringify(payload));
            } catch (e) {
                dlog('relay result write failed', (e && e.message) || String(e));
            }
            try {
                fs.rmSync(file, { force: true });
            } catch {}
        };
        if (!state.relay || state.status !== 'on') {
            answer({ ok: false, error: 'the channel is not up in this window' });
            continue;
        }
        const chatId = String(request.chatId || state.chatId || '');
        if (!chatId) {
            answer({ ok: false, error: 'no conversation yet: message the bot once and I will know where to reply' });
            continue;
        }
        const extra = {};
        if (request.replyTo) extra.reply_to = String(request.replyTo);
        if (request.format) extra.format = request.format;
        state.relay
            .send(chatId, request.text, extra)
            .then((result) => answer({ ok: true, text: result && result.text ? result.text : 'sent' }))
            .catch((e) => answer({ ok: false, error: (e && e.message) || String(e) }));
    }
}

let relayTimersStarted = false;

function ensureRelayTimers() {
    if (relayTimersStarted) return;
    relayTimersStarted = true;
    setInterval(() => {
        const state = relayState();
        if (state.relay && state.status === 'on') {
            relayTouchPing();
            relayDrainOutbox();
        }
    }, 2000).unref?.();
}

function relayState() {
    return (S.relay ||= { relay: null, server: null, chatId: null, status: 'off', error: null });
}

// The conversation a question is sent to is remembered across reloads: it is a fact about the machine
// the user already settled when they paired the bot, and asking for it again after every window reload
// would mean the first question of every session goes nowhere.
const RELAY_CHAT_FILE = path.join(DIR, 'relay-chat.json');

function loadRelayChat(server) {
    const saved = readJson(RELAY_CHAT_FILE);
    if (saved && saved.server === server && saved.chatId) return String(saved.chatId);
    return null;
}

function saveRelayChat(server, chatId) {
    try {
        fs.writeFileSync(RELAY_CHAT_FILE, JSON.stringify({ server, chatId }, null, 2));
    } catch (e) {
        dlog('relay chat save failed', (e && e.message) || String(e));
    }
}

// The conversation to answer in: whichever chat last wrote to the bot. It is learned rather than
// configured because the plugin's allowlist is the plugin's business — a message that reached this
// handler already passed it.
function relayRememberChat(message) {
    const state = relayState();
    if (message && message.chatId && state.chatId !== String(message.chatId)) {
        state.chatId = String(message.chatId);
        saveRelayChat(state.server, state.chatId);
        dlog('relay chat learned', state.chatId);
    }
}

// The webview a bound session id points at, or none: a session that has closed its tab no longer
// has a webview, and the message then falls to the last active one.
function findWebviewBySession(sessionId) {
    for (const webview of S.webviews || []) if (webview.__ccxSessionId === sessionId) return webview;
    return null;
}

// The tab a message belongs to is the one the user last typed in — the host has no other notion of
// "current", and guessing by session id would need a choice nobody made.
function deliverToTabs(message) {
    dlog('relay inbound', String(message && message.text || '').slice(0, 60));
    // A chosen session wins; without one the last tab the user typed in is still better than dropping
    // the message, but it is a fallback and the menu says so.
    const bound = loadRelayTarget();
    let target = bound ? findWebviewBySession(bound) : null;
    if (!target) target = S.lastActiveWebview;
    if (!target || !message || !String(message.text || '').trim()) return;
    try {
        target.postMessage({
            type: 'ccx:channelMessage',
            text: message.text,
            chatId: message.chatId,
            messageId: message.messageId,
            user: message.user,
            userId: message.userId,
            imagePath: message.imagePath,
            attachmentId: message.attachmentId,
            server: relayState().mcpServer || relayState().server,
        });
        dlog('relay deliver target', bound ? 'bound' : 'last-active', target ? 'found' : 'missing');
    } catch (e) {
        dlog('relay deliver failed', (e && e.message) || String(e));
    }
}

const RELAY_YES = /^(y|yes|да|\+)$/i;
const RELAY_NO = /^(n|no|нет|-)$/i;

function relayInbound(message) {
    relayRememberChat(message);
    const state = relayState();
    const text = String((message && message.text) || '').trim();
    // A `y` or `n` with a question outstanding is an answer, and nothing else. Anything else is a
    // message for the session: it is handed to the open tab exactly as the CLI would have delivered
    // it had the session's own plugin been the one polling — which, while this relay runs, it is not.
    if (!state.pending || state.pending.size === 0 || (!RELAY_YES.test(text) && !RELAY_NO.test(text))) {
        deliverToTabs(message);
        return;
    }
    const allow = RELAY_YES.test(text);
    const deny = RELAY_NO.test(text);
    if (!allow && !deny) return;
    // One outstanding question is answered by one message: the oldest, so a burst of answers cannot
    // silently approve something that was asked afterwards.
    const [key, entry] = state.pending.entries().next().value;
    state.pending.delete(key);
    dlog('relay answer', key, allow ? 'allow' : 'deny');
    entry.settle({ behavior: allow ? 'allow' : 'deny', viaChannel: true });
}

// Whether the relay was on the last time this window ran — and in *which* window. The key is the
// workspace folder, because the alternative (a global flag) had two windows both auto-resuming the
// channel after a reload, each spawning a poller and each convinced the messages were its own. With
// the key, a reload brings the channel back in the window that had it; another window only gets it
// by an explicit toggle there, and the toggle moves the key with it.
const RELAY_ON_FILE = path.join(DIR, 'relay-on.json');

function relayWindowKey() {
    try {
        const folders = vscode.workspace.workspaceFolders;
        return (folders && folders[0] && folders[0].uri.fsPath) || process.cwd();
    } catch {
        return process.cwd();
    }
}

function rememberRelayOn(server) {
    try {
        fs.writeFileSync(RELAY_ON_FILE, JSON.stringify({ server, windowKey: relayWindowKey() }, null, 2));
    } catch (e) {
        dlog('relay state save failed', (e && e.message) || String(e));
    }
}

function forgetRelayOn() {
    try {
        fs.rmSync(RELAY_ON_FILE, { force: true });
    } catch {}
}

function resumeRelayIfNeeded() {
    const state = relayState();
    if (state.relay) return;
    if (!S.lastActiveWebview) return;
    const saved = readJson(RELAY_ON_FILE);
    if (!saved || typeof saved.server !== 'string') return;
    // A flag from another window is not this window's job: that window is the channel's home until
    // the user moves it, and two homes is what the round of dead pollers was about.
    if (saved.windowKey && saved.windowKey !== relayWindowKey()) {
        dlog('relay belongs to another window', saved.windowKey);
        return;
    }
    dlog('relay resuming', saved.server);
    startChannelRelay(saved.server);
}

function startChannelRelay(server) {
    const state = relayState();
    const module_ = relayModule();
    if (!module_) return { ok: false, error: 'the relay runtime is missing' };
    if (state.relay) return { ok: false, error: 'a channel is already answering for this window' };
    const candidate = channelCandidates().find((item) => item.server === server && item.dir);
    if (!candidate) return { ok: false, error: 'no installed plugin declares ' + server };
    const command = relayCommandFor(candidate.dir);
    if (!command) return { ok: false, error: 'the plugin declares no command to start' };
    const relay = new module_.ChannelRelay({
        command: command.command,
        args: command.args,
        cwd: candidate.dir,
        env: process.env,
        log: (...parts) => dlog('relay', ...parts),
    });
    relay.on('inbound', relayInbound);
    // The button answer from the plugin's own card: matched to the question by its id, exactly like
    // the text answer.
    relay.on('permission', ({ requestId, behavior }) => {
        const live = relayState();
        const id = String(requestId);
        const entry = live.pending && live.pending.get(id);
        if (!entry) {
            dlog('relay button answer has no waiting question', id, behavior,
                'waiting:', live.pending ? Array.from(live.pending.keys()).join(',') : 'none');
            return;
        }
        live.pending.delete(id);
        dlog('relay permission answer', id, behavior);
        entry.settle({ behavior: behavior === 'allow' ? 'allow' : 'deny', viaChannel: true });
    });
    const startedAt = Date.now();
    relay.on('exit', () => {
        const live = relayState();
        if (live.relay !== relay) return;
        live.relay = null;
        live.pending = new Map();
        // A plugin that dies while the switch says on is brought back, because the channel is meant
        // to outlive any single plugin process — and the sweep at start clears whatever it left. A
        // plugin that keeps dying quickly is not brought back for ever: five fast deaths in a row
        // stop the loop and say so, rather than quietly restarting every few seconds.
        const saved = readJson(RELAY_ON_FILE);
        if (saved && saved.server === server) {
            live.restartStreak = Date.now() - startedAt < 60000 ? (live.restartStreak || 0) + 1 : 0;
            if (live.restartStreak >= 5) {
                live.status = 'error';
                live.error = 'the channel plugin keeps crashing; restarts stopped';
                broadcast();
                return;
            }
            live.status = 'starting';
            broadcast();
            setTimeout(() => {
                if (relayState().relay) return;
                startChannelRelay(server);
            }, 3000);
            return;
        }
        live.status = 'stopped';
        broadcast();
    });
    ensureRelayTimers();
    relayTouchPing();
    state.relay = relay;
    state.server = server;
    // The qualified name is what the CLI uses for the same server, and the model reads it in the tag.
    state.mcpServer = candidate.mcpServer;
    // A chat learned in an earlier window is the same chat: reloads must not deafen the first question.
    state.chatId = loadRelayChat(server);
    state.status = 'starting';
    state.error = null;
    rememberRelayOn(server);
    state.pending = new Map();
    relay
        .start()
        .then(() => {
            const live = relayState();
            if (live.relay !== relay) return;
            live.status = 'on';
            broadcast();
        })
        .catch((e) => {
            const live = relayState();
            if (live.relay !== relay) return;
            live.relay = null;
            live.status = 'error';
            live.error = (e && e.message) || String(e);
            dlog('relay start failed', live.error);
            broadcast();
        });
    return { ok: true };
}

function stopChannelRelay() {
    const state = relayState();
    if (!state.relay) return { ok: false, error: 'no relay is running' };
    const relay = state.relay;
    state.relay = null;
    state.status = 'off';
    state.error = null;
    forgetRelayOn();
    if (state.pending) {
        for (const entry of state.pending.values()) entry.settle(null);
        state.pending.clear();
    }
    relay.stop();
    relayDropPing();
    broadcast();
    return { ok: true };
}

// What the patched bundle wraps the host's permission callback with. The inner callback is the one
// that draws the dialog; this only adds a second place the same question can be answered from, and
// resolves with whichever answers first.
function wrapCanUseTool(inner, context) {
    return async function (toolName, input, options) {
        const state = relayState();
        const chat = state.chatId;
        if (!state.relay || state.status !== 'on' || !chat || typeof inner !== 'function') {
            // Why a question was not mirrored is a fact about this window, and the only place it can be
            // said is here: the dialog is the fallback either way, so nothing else would look wrong.
            dlog('canUseTool not mirrored', {
                tool: toolName,
                relay: Boolean(state.relay),
                status: state.status,
                chat: chat ? 'known' : 'unknown',
                inner: typeof inner,
            });
            return inner(toolName, input, options);
        }
        dlog('canUseTool mirrored', toolName);
        // The plugins' contract caps a request id at five letters (a-k, m-z — no 'l', for phone
        // autocorrect), because the answer rides a Telegram button whose callback data is capped at
        // 64 bytes. So the question gets a short id of its own; the toolUseID stays with the dialog.
        const shortId = Array.from(crypto.randomBytes(5))
            .map((b) => 'abcdefghijkmnopqrstuvwxyz'[b % 25])
            .join('');
        let settle;
        const fromChannel = new Promise((resolve) => {
            settle = resolve;
        });
        state.pending.set(shortId, { settle });
        // The question goes in the channel plugins' own contract: the plugin renders the card itself —
        // with Allow/Deny buttons, to the chats its allowlist admits — and answers with a
        // `notifications/claude/channel/permission` carrying this short id, which the relay's
        // permission event settles below. The text reply (y/n) keeps working beside the buttons
        // through the inbound path, so either shape of answer lands in the same queue.
        // The card the plugin draws has room for one line and an expansion, and both should read like
        // the action, not like its JSON: Bash reads as "$ <command>", everything else as "field: value"
        // lines. The full object stays in the debug log for when the difference matters.
        const human = readableInput(toolName, input);
        dlog('canUseTool input', toolName, human);
        state.relay.sendPermissionRequest(shortId, toolName, human, human);
        const answer = await Promise.race([inner(toolName, input, options), fromChannel]);
        state.pending.delete(shortId);
        // A deny needs words of its own — the SDK rejects a bare one, and "invalid permission result"
        // reaching the model is the failure mode that costs a whole round trip to notice.
        if (answer && answer.viaChannel) {
            return answer.behavior === 'allow'
                ? { behavior: 'allow' }
                : { behavior: 'deny', message: 'Denied via channel' };
        }
        // The dialog answered first: the channel message is left as it is, with one line saying so, so
        // that an answer nobody is waiting for any more is not mistaken for a live question.
        state.relay
            .send(chat, '↩︎ ' + toolName + ': decided in the IDE')
            .catch(() => {});
        return answer;
    };
}

// The input as a person would say it: the shell command as a command line, other tools as
// "field: value" over the meaningful fields. Flags and bookkeeping (timeouts, background switches)
// carry no vote in an approval and are left to the debug log.
function readableInput(toolName, input) {
    const obj = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    if (toolName === 'Bash' && typeof obj.command === 'string') {
        const lines = ['$ ' + obj.command];
        if (typeof obj.description === 'string' && obj.description) lines.push(obj.description);
        return lines.join('\n');
    }
    const lines = [];
    for (const [field, value] of Object.entries(obj)) {
        if (value == null || value === '' || value === false) continue;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(field + ': ' + (text.length > 200 ? text.slice(0, 200) + '…' : text));
    }
    return lines.join('\n') || toolName;
}

function describeForChannel(toolName, input) {
    let text = '';
    try {
        text = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
        text = String(input);
    }
    text = text.replace(/\s+/g, ' ').trim();
    return text.length > 300 ? toolName + ': ' + text.slice(0, 300) + '…' : text;
}

function attachPanel(panel) {
    // A panel is the first thing this window does with a session, which makes it the moment a channel
    // that was on before the reload is put back.
    setTimeout(() => {
        try {
            resumeRelayIfNeeded();
        } catch (e) {
            dlog('relay resume failed', (e && e.message) || String(e));
        }
    }, 3000);
    if (!S.panels.has(panel)) {
        S.panels.set(panel, true);
        try {
            panel.onDidDispose(() => {
                S.panels.delete(panel);
                S.activeSessionByPanel.delete(panel);
            });
        } catch {}
    }
    ensureWatchers();
    decorate(panel);
}

module.exports = {
    renderScript,
    attachPanel,
    envFor,
    onChannelReady,
    wrapCanUseTool,
    startChannelRelay,
    stopChannelRelay,
    profileIcons,
    agentRunsPayload,
    agentTranscript,
    requestAgentStop,
    historyBeforeCompaction,
    stitchCompactions,
};
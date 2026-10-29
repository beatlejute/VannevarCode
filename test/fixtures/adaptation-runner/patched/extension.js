// Minimal extension.js for patched scenario - already patched (contains __ccx marker)
/*__ccx*/let __p=require("path").join(require("os").homedir(),".claude","vannevar","host.js");
delete require.cache[require.resolve(__p)];

// PATCH-HOST-SPAWN-CLAUDE anchor - already patched
async function spawnClaude(input, rest) {
    const __ccxSpawnContext = { manager: this, input: input };
    return { result: 'ok' };
}

// PATCH-HOST-ENV-FOR anchor
function envFor(resume, profile, options) {
    return { ...options.env, CLAUDE_CODE_RESUME_INTERRUPTED_TURN: resume ? 1 : 0 };
}

// PATCH-HOST-READ-MESSAGES anchor
async function readMessages() {
    for await (let message of transport.readMessages()) {
        try { require(__p).observeNativeFrame(this, message) } catch (__e) {}
    }
}

// PATCH-HOST-BIND-NATIVE anchor
function bindNativeProducer(query, context) {
    try { require(__p).bindNativeProducer(query, typeof __ccxSpawnContext != "undefined" ? __ccxSpawnContext : null) } catch (__e) {}
    return query;
}

// PATCH-WEBVIEW-HTML-INJECT anchor
function getHtmlForWebview(webview, nonce) {
    return `<script nonce="${nonce}" src="${webview}"></script>`;
}

// PATCH-WEBVIEW-ATTACH-PANEL anchor
const panel = { iconPath: { light: 'icon', dark: 'icon' } };
panel.webview = { options: {} };

// PATCH-WEBVIEW-CHANNEL-INIT anchor (optional)
function channelInitialized(channel) {
    return channel;
}

// PATCH-WEBVIEW-CHANNEL-SPAWN anchor (optional)
async function spawnClaude2(channel, resume, middle, canUseTool, onUserDialog) {
    return { channel, resume };
}

// PATCH-HISTORY-STITCH-COMPACTIONS anchor
async function stitchCompactions(lines, optional) {
    let byUuid = new Map();
    for (let line of lines) byUuid.set(line.uuid, line);
    let relink = 0;
    for (let line of byUuid.values()) {
        if (line.type !== 'system' || line.subtype !== 'compact_boundary') continue;
    }
}

// PATCH-HISTORY-BEFORE-COMPACTION anchor
function checkSize(size, limit, env) {
    if (size > limit && !env.CLAUDE_CODE_DISABLE_PRECOMPACT_SKIP) {
        return await someFunction();
    }
}
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const home = mkdtempSync(path.join(tmpdir(), 'ccx-tab-progress-'));
const extension = path.join(home, 'extensions', 'anthropic.claude-code-9.0.0');
mkdirSync(path.join(extension, 'resources'), { recursive: true });
for (const state of ['', '-pending', '-done']) writeFileSync(path.join(extension, 'resources', `claude-logo${state}.svg`), '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>');
let enabled = true;
const roots = new Map();
const broker = { info: () => ({ instanceId: 'test-broker' }), snapshot: (id) => ({ root: roots.get(id) || null }) };
const ctx = vm.createContext({
    require: (id) => id === 'vscode' ? {
        Uri: { file: (fsPath) => ({ fsPath }) },
        extensions: { getExtension: () => ({ extensionPath: extension }) },
        workspace: { getConfiguration: () => ({ get: (key, fallback) => key === 'progress.enabled' ? enabled : fallback }) },
    } : id === 'os' ? { ...require('os'), homedir: () => home }
        : id.endsWith('progress-broker.js') ? require('../runtime/progress-broker.js') : require(id),
    console, Buffer, process, module: { exports: {} }, setTimeout, clearTimeout, setInterval, clearInterval,
});
vm.runInContext(readFileSync(new URL('../runtime/host.js', import.meta.url), 'utf8'), ctx);
vm.runInContext('progress.broker = globalThis.testBroker', Object.assign(ctx, { testBroker: broker }));
function panel(id) {
    let icon;
    const p = { title: 'Original title', webview: { __ccxSessionId: id, postMessage: () => Promise.resolve(true) },
        get iconPath() { return icon; }, set iconPath(value) { icon = value; } };
    ctx.__ccxState.panels.set(p, true);
    ctx.__ccxState.webviews.add(p.webview);
    return p;
}
function progress(p, done, total, state = 'running', rootId = p.webview.__ccxSessionId) {
    const id = p.webview.__ccxSessionId;
    roots.set(id, { rootId, semantic: { done, total } });
    ctx.__ccxState.progress.sessionProjections.set(id, { root: { rootId: id, state } });
    ctx.broadcastProgressChange('test-broker', { sessionId: id, payload: {} });
}
function svg(p) { return readFileSync(p.iconPath.light.fsPath, 'utf8'); }
try {
    const first = panel('one');
    const second = panel('two');
    ctx.decorate(first); ctx.decorate(second);
    const plain = first.iconPath.light.fsPath;
    progress(first, 1, 4);
    assert.match(svg(first), /data-ccx-progress="4"/);
    assert.equal(second.iconPath.light.fsPath, plain);
    assert.equal(first.title, 'Original title');
    const quarter = first.iconPath.light.fsPath;
    progress(first, 1, 4);
    assert.equal(first.iconPath.light.fsPath, quarter);
    progress(first, 0, 4); assert.match(svg(first), /data-ccx-progress="0"/);
    progress(first, 4, 4); assert.match(svg(first), /data-ccx-progress="16"/);
    first.iconPath = { light: { fsPath: path.join(extension, 'resources', 'claude-logo-pending.svg') } };
    assert.match(svg(first), /data-ccx-progress="16"/);
    assert.equal(first.__ccxIconState, 'pending');
    progress(first, 1, 4, 'done'); assert.equal(path.basename(first.iconPath.light.fsPath), 'claude-logo-pending.svg');
    progress(first, 1, 4, 'running', 'foreign'); assert.equal(path.basename(first.iconPath.light.fsPath), 'claude-logo-pending.svg');
    progress(first, 5, 4); assert.equal(path.basename(first.iconPath.light.fsPath), 'claude-logo-pending.svg');
    progress(first, 2, 4); assert.match(svg(first), /data-ccx-progress="8"/);
    enabled = false; ctx.decorate(first); assert.equal(path.basename(first.iconPath.light.fsPath), 'claude-logo-pending.svg');
    enabled = true;
    for (let i = 0; i <= 100; i++) progress(first, i, 100);
    const displayedBeforePruning = first.iconPath.light.fsPath;
    for (let i = 0; i < 140; i++) {
        const source = path.join(home, `source-${i}.svg`);
        writeFileSync(source, `<svg xmlns="http://www.w3.org/2000/svg"><text>${i}</text></svg>`);
        ctx.progressIcon(source, i % 17);
    }
    assert.ok(readdirSync(path.join(home, '.claude', 'vannevar', 'icons', 'progress', String(process.pid))).length <= 128);
    assert.ok(ctx.__ccxState.progressIcons.size <= 128);
    assert.match(readFileSync(displayedBeforePruning, 'utf8'), /data-ccx-progress/,
        'pruning preserves an icon still displayed by an open panel');
    const source = path.join(home, 'changing.svg');
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>');
    const before = ctx.progressIcon(source, 8);
    writeFileSync(source, '<svg xmlns="http://www.w3.org/2000/svg"><circle r="12"/></svg>');
    assert.notEqual(ctx.progressIcon(source, 8), before);
    assert.equal(ctx.progressIcon(path.join(home, 'missing.svg'), 8), path.join(home, 'missing.svg'));
    progress(first, 2, 4);
    const validIcon = first.iconPath.light.fsPath;
    ctx.applyRuntimeProgress(first.webview, { sessionId: 'one', runtimeEpoch: 'stale', runtimeRevision: 100,
        root: { rootId: 'foreign', state: 'running' } });
    assert.equal(first.iconPath.light.fsPath, validIcon);
    for (const terminal of ['done', 'failed', 'stopped']) {
        progress(first, 2, 4, terminal);
        assert.equal(path.basename(first.iconPath.light.fsPath), 'claude-logo-pending.svg');
    }
    progress(first, 2, 4);
    const profileDir = path.join(home, '.claude', 'profiles');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(path.join(profileDir, 'provider.json'), JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } }));
    writeFileSync(path.join(profileDir, 'provider.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>');
    ctx.__ccxState.profileByWebview.set(first.webview, 'provider');
    ctx.decorate(first);
    assert.match(svg(first), /data-ccx-progress="8"/);
    const embedded = Buffer.from(svg(first).match(/base64,([^\"]+)/)[1], 'base64').toString();
    assert.match(embedded, /ccx-badge/);
    ctx.__ccxState.profileByWebview.delete(first.webview);
    first.webview.__ccxSessionId = 'new-session'; ctx.decorate(first);
    assert.equal(path.basename(first.iconPath.light.fsPath), 'claude-logo-pending.svg');
    console.log('OK — tab icon progress, isolation, geometry, lifecycle, bounded files and unchanged title');
} finally { rmSync(home, { recursive: true, force: true }); }

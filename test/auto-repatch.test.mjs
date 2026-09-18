// Pins the contract the automatic re-apply rides on. Three parties speak it — the patcher prints it,
// extension.js and the in-session watcher parse it — and none of them imports the others, so the
// strings are checked against all three sources here rather than trusted to stay in step.
//
// The safety property is the important one: an auto-apply that meets a bundle whose signatures moved
// must leave that bundle byte for byte as it found it and must not claim success. Nothing else makes
// running the patcher unattended defensible.
//
// The patcher under test is a stamped copy, not the file in runtime/: that is how it reaches a user's
// machine — extension.js copies runtime/ into ~/.claude/vannevar and writes patch-version.json beside
// it — and the stamp is where its version, the releases it was verified against and the extensions root
// all come from.
import { spawn, spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert';
import { buildVsix, shippedFiles } from '../scripts/build-vsix.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_PATCHER = path.join(ROOT, 'runtime', 'apply-patch.mjs');
const WORK = path.join(tmpdir(), `ccx-repatch-${process.pid}`);
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

rmSync(WORK, { recursive: true, force: true });

// The runtime as extension.js installs it: the patcher plus the stamp it reads itself out of
function installPatcher(name, stamp) {
    const dir = path.join(WORK, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'apply-patch.mjs'), readFileSync(SOURCE_PATCHER));
    writeFileSync(path.join(dir, 'patch-version.json'), JSON.stringify(stamp, null, 4));
    return path.join(dir, 'apply-patch.mjs');
}

function run(patcher, args, env) {
    const out = spawnSync(process.execPath, [patcher, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: out.status, text: `${out.stdout || ''}${out.stderr || ''}` };
}

function fixture(name, files) {
    const dir = path.join(WORK, name);
    for (const [rel, body] of Object.entries(files)) {
        const file = path.join(dir, rel);
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, body, 'utf8');
    }
    return dir;
}

// The apply path needs a bundle the signatures actually match, and the only one in existence is the
// installed extension. Where Vannevar is installed the untouched copy is the backup; where it is not,
// extension.js is itself untouched. Both are real releases, which is the point — a hand-written stand-in
// would only prove that the stand-in matches.
function cleanBundle() {
    const root = path.join(homedir(), '.vscode', 'extensions');
    let obsolete = {};
    try {
        obsolete = JSON.parse(readFileSync(path.join(root, '.obsolete'), 'utf8')) || {};
    } catch {}
    const dir = readdirSync(root)
        .filter((name) => name.startsWith('anthropic.claude-code-') && !obsolete[name])
        .sort((a, b) => {
            const version = (name) => (name.match(/-(\d+)\.(\d+)\.(\d+)/) || []).slice(1).map(Number);
            const [x, y] = [version(a), version(b)];
            return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
        })
        .pop();
    assert.ok(dir, `no Claude Code extension under ${root} — the apply path cannot be exercised`);

    const files = {};
    for (const rel of ['extension.js', 'webview/index.js']) {
        const file = path.join(root, dir, rel);
        const backup = `${file}.ccx-orig`;
        const body = readFileSync(existsSync(backup) ? backup : file, 'utf8');
        assert.ok(!body.includes('__ccx'), `${rel} is patched and has no backup beside it`);
        files[rel] = body;
    }
    return files;
}

const verified = PKG.verifiedAgainst;
assert.ok(Array.isArray(verified) && verified.length, 'package.json carries no verifiedAgainst list');
const supported = verified[0];
const escape = (v) => v.replace(/\./g, '\\.');

try {
    const PATCHER = installPatcher('runtime', { version: PKG.version, verifiedAgainst: verified });

    // --- the two result lines --------------------------------------------------------------------
    const patched = fixture('anthropic.claude-code-9.9.9-patched', {
        'extension.js': 'void 0;/*__ccx*/\n',
        'webview/index.js': 'void 0;/*__ccx*/\n',
    });

    const upToDate = run(PATCHER, [`--dir=${patched}`, '--if-needed']);
    assert.equal(upToDate.code, 0, `--if-needed on a patched bundle failed:\n${upToDate.text}`);
    assert.match(upToDate.text, /^ccx-result: up-to-date$/m, 'no up-to-date line for a patched bundle');
    assert.doesNotMatch(upToDate.text, /^ccx-result: patched$/m, 'a patched bundle must not report a fresh patch');
    console.log('OK — --if-needed leaves an already patched bundle alone and says so');

    // --- a bundle whose signatures moved ----------------------------------------------------------
    const SOURCE = 'export const nothing = 1;\n';
    const moved = fixture('anthropic.claude-code-9.9.9-moved', {
        'extension.js': SOURCE,
        'webview/index.js': SOURCE,
    });

    const refused = run(PATCHER, [`--dir=${moved}`, '--if-needed']);
    assert.notEqual(refused.code, 0, 'a bundle with no matching signature must fail loudly');
    assert.match(refused.text, /signature matched 0 times/, `unexpected failure:\n${refused.text}`);
    assert.doesNotMatch(refused.text, /^ccx-result:/m, 'a refused run must not report a result');
    assert.equal(readFileSync(path.join(moved, 'extension.js'), 'utf8'), SOURCE, 'extension.js was written to');
    assert.equal(readFileSync(path.join(moved, 'webview', 'index.js'), 'utf8'), SOURCE, 'index.js was written to');
    assert.ok(!existsSync(path.join(moved, '.ccx.lock')), 'a failed run left its lock behind');
    console.log('OK — a moved signature stops the patcher with the bundle untouched and no result line');

    // --- one writer at a time ---------------------------------------------------------------------
    // VS Code restores every window at once and each one activates this extension, so several patchers
    // meet over the same 2.7 MB bundle. Restore-from-backup and write-back is not atomic, so they queue.
    assert.ok(!existsSync(path.join(patched, '.ccx.lock')), 'a finished run left its lock behind');

    const lock = path.join(patched, '.ccx.lock');
    writeFileSync(lock, String(process.pid));
    const started = Date.now();
    const queued = new Promise((done) => {
        const child = spawn(process.execPath, [PATCHER, `--dir=${patched}`, '--if-needed'], { stdio: 'ignore' });
        child.on('close', (code) => done({ code, waited: Date.now() - started }));
    });
    await new Promise((go) => setTimeout(go, 1200));
    rmSync(lock, { force: true });

    const held = await queued;
    assert.equal(held.code, 0, 'the queued run did not finish once the lock was released');
    assert.ok(held.waited >= 1000, `the run did not wait for the lock (${held.waited} ms)`);
    console.log('OK — a run waits for the lock another one holds instead of writing over it');

    // A crashed run leaves its lock behind, and nothing else would ever clear it
    writeFileSync(lock, 'crashed');
    const ancient = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(lock, ancient, ancient);
    const stale = run(PATCHER, [`--dir=${patched}`, '--if-needed']);
    assert.equal(stale.code, 0, `a stale lock blocked the patcher:\n${stale.text}`);
    assert.match(stale.text, /^ccx-result: up-to-date$/m, 'the run behind a stale lock reported nothing');
    assert.ok(!existsSync(lock), 'the stale lock was not cleared');
    console.log('OK — a lock left behind by a crashed run is taken over, not waited on forever');

    // --- an update to a version nobody verified ---------------------------------------------------
    // The version check is a warning, not a stop, and that is deliberate: most signatures match the
    // shape of the code rather than the names in it, so a new release usually takes the patch fine —
    // refusing on the version number alone would turn every update into manual work for nothing. What
    // must not happen is the patch going on silently. A hand-run patch prints the mismatch for someone
    // who is reading it; an automatic run has no reader, so it has to leave through the result lines.
    const source = cleanBundle();
    const ahead = supported.replace(/\d+$/, (last) => Number(last) + 1);

    const onAhead = run(PATCHER, [`--dir=${fixture(`anthropic.claude-code-${ahead}-win32-x64`, source)}`, '--if-needed']);
    assert.equal(onAhead.code, 0, `the patch did not go onto ${ahead}:\n${onAhead.text.slice(-1500)}`);
    assert.match(onAhead.text, /^ccx-result: patched$/m, 'a fresh patch reported nothing');
    assert.match(
        onAhead.text,
        new RegExp(`^ccx-unverified: ${escape(ahead)} ${escape(supported)}$`, 'm'),
        `a patch onto an unverified version did not say so:\n${onAhead.text}`,
    );
    console.log(`OK — a patch onto ${ahead}, which nothing verified, applies and reports the mismatch`);

    // Every release on the list is verified, not only the newest one: a single extension release can
    // carry signatures that fit several Claude Code versions, and flagging the older ones would put a
    // "nothing has checked this" notification in front of someone for whom that is untrue.
    for (const release of verified) {
        const named = fixture(`anthropic.claude-code-${release}-win32-x64`, source);
        const onNamed = run(PATCHER, [`--dir=${named}`, '--if-needed']);
        assert.equal(onNamed.code, 0, `the patch did not go onto ${release}:\n${onNamed.text.slice(-1500)}`);
        assert.doesNotMatch(onNamed.text, /^ccx-unverified:/m, `${release} is on the list and was flagged anyway`);
    }
    console.log(`OK — every release in verifiedAgainst (${verified.join(', ')}) applies without a warning`);

    // --- patched, but by somebody else ------------------------------------------------------------
    // The marker says "somebody patched this"; --if-needed is asking "is MY runtime wired in". A bundle
    // carrying hooks that load host.js out of another directory answers no to the second question, and
    // reporting up-to-date there is how a window ends up running a runtime nothing maintains — the menu
    // entry silently absent, the patch apparently on. It happened: two windows, one of them patched by
    // the install this one replaced.
    const foreign = fixture('anthropic.claude-code-9.9.9-foreign', {
        'extension.js': source['extension.js'],
        'webview/index.js': source['webview/index.js'],
    });
    // A real foreign patch leaves a backup behind, which is what a full apply works from
    writeFileSync(path.join(foreign, 'extension.js.ccx-orig'), source['extension.js']);
    writeFileSync(path.join(foreign, 'webview', 'index.js.ccx-orig'), source['webview/index.js']);
    writeFileSync(
        path.join(foreign, 'extension.js'),
        source['extension.js'] +
            '\n/*__ccx*/let __p=require("path").join(require("os").homedir(),".claude","elsewhere","host.js");\n',
    );

    const rewired = run(PATCHER, [`--dir=${foreign}`, '--if-needed']);
    assert.equal(rewired.code, 0, `the foreign patch was not replaced:\n${rewired.text.slice(-1500)}`);
    assert.match(rewired.text, /^ccx-result: patched$/m, 'a bundle wired to another runtime reported up-to-date');
    const rewritten = readFileSync(path.join(foreign, 'extension.js'), 'utf8');
    assert.ok(rewritten.includes('".claude","vannevar","host.js"'), 'the hooks do not point at this runtime');
    assert.ok(!rewritten.includes('"elsewhere"'), 'the foreign hook survived — it was patched on top, not replaced');
    console.log('OK — hooks that load another runtime are replaced, not mistaken for this one');

    // With no backup beside it there is nothing clean to patch from, and taking the backup from the
    // patched file would make those hooks permanent
    const orphan = fixture('anthropic.claude-code-9.9.9-orphan', {
        'extension.js':
            source['extension.js'] +
            '\n/*__ccx*/let __p=require("path").join(require("os").homedir(),".claude","elsewhere","host.js");\n',
        'webview/index.js': source['webview/index.js'],
    });
    const refusedOrphan = run(PATCHER, [`--dir=${orphan}`, '--if-needed']);
    assert.notEqual(refusedOrphan.code, 0, 'a foreign patch with no backup was written over');
    assert.match(refusedOrphan.text, /already patched and has no/, `unexpected failure:\n${refusedOrphan.text}`);
    assert.ok(!existsSync(path.join(orphan, 'extension.js.ccx-orig')), 'a patched file was saved as the backup');
    console.log('OK — a foreign patch with no backup stops the patcher instead of becoming the backup');


    // --- the stamp is where the patcher reads itself --------------------------------------------
    const stamped = run(PATCHER, [`--dir=${patched}`, '--status']);
    assert.match(
        stamped.text,
        new RegExp(`^patcher: +${escape(PKG.version)} \\(verified against ${escape(verified.join(', '))}\\)$`, 'm'),
        `the version stamp was not read:\n${stamped.text}`,
    );
    console.log('OK — the installed copy reads its version and its verified list out of the stamp beside it');

    // Run by hand with no --dir, the root to scan is the one the extension host resolved and stamped —
    // ~/.vscode/extensions is wrong in Cursor, in Windsurf and on every remote host
    const root = path.join(WORK, 'elsewhere', 'extensions');
    mkdirSync(path.join(root, 'anthropic.claude-code-9.9.8-win32-x64'), { recursive: true });
    const inRoot = fixture(path.join('elsewhere', 'extensions', 'anthropic.claude-code-9.9.9-win32-x64'), {
        'extension.js': 'void 0;/*__ccx*/\n',
        'webview/index.js': 'void 0;/*__ccx*/\n',
    });
    const stampedRoot = installPatcher('runtime-elsewhere', {
        version: PKG.version,
        verifiedAgainst: verified,
        extensionPath: inRoot,
    });
    const found = run(stampedRoot, ['--if-needed']);
    assert.equal(found.code, 0, `the patcher did not run against the stamped root:\n${found.text}`);
    assert.ok(found.text.includes(`extension: ${inRoot}`), `the wrong bundle was picked:\n${found.text}`);
    console.log('OK — with no --dir, the extensions root comes from the stamp rather than from ~/.vscode');

    // --- nothing reaches the network, and nothing updates itself ----------------------------------
    // Both were real features and both are gone: the VS Code updater replaces them, and an extension
    // that fetches code at the moment it is about to write into somebody else's bundle is a trust
    // surface this no longer has.
    const patcherSrc = readFileSync(SOURCE_PATCHER, 'utf8');
    for (const gone of ['ccx-upstream', 'ccx-heal-blocked', 'ccx-result: healed', 'self-update', 'fetch(', "execFileSync('git'"])
        assert.ok(!patcherSrc.includes(gone), `the patcher still carries ${gone}`);
    console.log('OK — the patcher has no upstream check and no self-update left in it');

    // --- all three parties agree on the wording ---------------------------------------------------
    const extensionSrc = readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
    const hostSrc = readFileSync(path.join(ROOT, 'runtime', 'host.js'), 'utf8');

    assert.match(patcherSrc, /upToDate: 'ccx-result: up-to-date'/, 'the patcher no longer prints up-to-date');
    assert.match(patcherSrc, /patched: 'ccx-result: patched'/, 'the patcher no longer prints patched');
    assert.match(patcherSrc, /unverified: 'ccx-unverified:'/, 'the patcher no longer prints the version mismatch');
    assert.match(extensionSrc, /ccx-result: patched/, 'extension.js no longer looks for the patched line');
    assert.match(hostSrc, /ccx-result: patched/, 'the host watcher no longer looks for the patched line');
    for (const [who, src] of [
        ['extension.js', extensionSrc],
        ['the host watcher', hostSrc],
    ]) {
        assert.match(src, /\^ccx-unverified: \(\\S\+\) \(\\S\+\)\$/, `${who} no longer reads the version mismatch`);
        assert.match(src, /'--if-needed'/, `${who} no longer calls the patcher with --if-needed`);
    }
    console.log('OK — patcher, extension.js and host watcher still speak the same result lines');

    // --- the .vsix is a ZIP the VS Code CLI can open -----------------------------------------------
    const files = shippedFiles(ROOT);
    const vsix = buildVsix(PKG, files);

    assert.ok(
        files.some((f) => f.name === 'runtime/apply-patch.mjs') && files.some((f) => f.name === 'extension.js'),
        'the package is missing the patcher or the entry point',
    );
    assert.ok(!files.some((f) => f.name.startsWith('test/') || f.name.startsWith('docs/')), 'tests or docs shipped');

    const eocd = vsix.length - 22;
    assert.equal(vsix.readUInt32LE(eocd), 0x06054b50, 'no end-of-central-directory record');
    assert.equal(vsix.readUInt16LE(eocd + 10), files.length + 2, 'wrong entry count — manifest or content types lost');
    assert.equal(vsix.readUInt32LE(0), 0x04034b50, 'the archive does not start with a local file header');

    // Walk the central directory the way a reader does, and inflate every entry back to its source
    const names = new Map();
    let cursor = vsix.readUInt32LE(eocd + 16);
    for (let i = 0; i < files.length + 2; i++) {
        assert.equal(vsix.readUInt32LE(cursor), 0x02014b50, `central header ${i} is malformed`);
        const nameLen = vsix.readUInt16LE(cursor + 28);
        const name = vsix.toString('utf8', cursor + 46, cursor + 46 + nameLen);
        const local = vsix.readUInt32LE(cursor + 42);
        const start = local + 30 + vsix.readUInt16LE(local + 26) + vsix.readUInt16LE(local + 28);
        const body = inflateRawSync(vsix.subarray(start, start + vsix.readUInt32LE(cursor + 20)));
        assert.equal(body.length, vsix.readUInt32LE(cursor + 24), `${name}: inflated to the wrong length`);
        names.set(name, body);
        cursor += 46 + nameLen + vsix.readUInt16LE(cursor + 30) + vsix.readUInt16LE(cursor + 32);
    }

    assert.ok(names.has('extension.vsixmanifest'), 'no vsixmanifest — VS Code would reject the package');
    assert.ok(names.has('[Content_Types].xml'), 'no content types map');
    assert.deepEqual(
        JSON.parse(names.get('extension/package.json').toString('utf8')),
        PKG,
        'the packed manifest is not the extension manifest',
    );
    // The id VS Code installs and updates by has to be the one the manifest declares
    assert.match(
        names.get('extension.vsixmanifest').toString('utf8'),
        new RegExp(`Id="${PKG.name}" Version="${escape(PKG.version)}" Publisher="${PKG.publisher}"`),
        'the vsixmanifest identity drifted from package.json',
    );
    // Every file in the package needs a content type, or the gallery rejects the upload
    const types = names.get('[Content_Types].xml').toString('utf8');
    for (const f of files) {
        const ext = f.name.split('.').pop().toLowerCase();
        if (f.name.includes('.')) assert.match(types, new RegExp(`Extension="${ext}"`), `${f.name}: no content type`);
    }
    console.log(`OK — the extension packs into a .vsix that reads back as a valid ZIP (${files.length} files)`);
} finally {
    rmSync(WORK, { recursive: true, force: true });
}

assert.ok(!existsSync(WORK), 'the fixtures were left behind');

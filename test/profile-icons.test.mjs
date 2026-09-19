// Pins the data-URI contract the history-list icons ride on, and prints the live payload budget.
//
// Two things make loading host.js here awkward, and both are artefacts of the test, not of the runtime:
// it requires('vscode'), which only exists inside the extension host, and this package is "type": "module",
// so Node reads src/host.js as ESM — whereas in production it is copied to ~/.claude/vannevar/host.js
// and required by the extension host as CommonJS. A .cjs copy plus a 'vscode' stub reproduces that.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode' ? { Uri: { file: (p) => ({ fsPath: p }) }, window: {} } : load(request, ...rest);

const src = new URL('../runtime/host.js', import.meta.url);
const copy = join(tmpdir(), `ccx-host-${process.pid}.cjs`);
writeFileSync(copy, readFileSync(src));

let profileIcons;
try {
    ({ profileIcons } = require(copy));
} finally {
    rmSync(copy, { force: true });
}

const icons = profileIcons();
const MAX_ICON_BYTES = 512 * 1024;
const names = Object.keys(icons);

// profileIcons() reads the machine's own ~/.claude/profiles, so there is nothing to measure on a CI
// runner or a fresh checkout. Skipping loudly is the right answer there: the contract this pins is about
// what the icons look like on the wire, and with no icons there is no wire. Failing instead would mean a
// suite that cannot go green until somebody configures a profile by hand.
if (names.length === 0) {
    console.log('SKIP — no profiles under ~/.claude/profiles; the icon payload was not measured');
    process.exit(0);
}

for (const name of names) {
    const uri = icons[name];
    assert.match(uri, /^data:image\/(png|svg\+xml);base64,[A-Za-z0-9+/]+=*$/, `${name}: not a base64 data URI`);
    // 4/3 for base64 plus the scheme prefix — the host-side guard is on the raw file size
    assert.ok(uri.length < MAX_ICON_BYTES * 1.4, `${name}: exceeds the icon budget`);
}

const payload = JSON.stringify({ type: 'ccx:icons', icons }).length;
console.log(`profile-icons: ok — ${names.length} profiles, ${payload} bytes on the wire`);
for (const name of names.sort((a, b) => icons[b].length - icons[a].length))
    console.log(`  ${name.padEnd(12)} ${String(icons[name].length).padStart(7)}`);

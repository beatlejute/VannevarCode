// Pins the data-URI contract the history-list icons ride on, and prints the live payload budget.
//
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert';

const require = createRequire(import.meta.url);
const Module = require('node:module');

const load = Module._load;
Module._load = (request, ...rest) =>
    request === 'vscode' ? { Uri: { file: (p) => ({ fsPath: p }) }, window: {} } : load(request, ...rest);

// Create a mock home directory for the test
const mockHome = fs.mkdtempSync(path.join(tmpdir(), 'ccx-home-'));
const mockVannevar = path.join(mockHome, '.claude', 'vannevar');
fs.mkdirSync(mockVannevar, { recursive: true });
const src = new URL('../runtime/host.js', import.meta.url);
const brokerSrc = new URL('../runtime/progress-broker.js', import.meta.url);
const copy = path.join(mockVannevar, 'host.cjs');
const brokerCopy = path.join(mockVannevar, 'progress-broker.js');
fs.writeFileSync(copy, fs.readFileSync(src));
fs.writeFileSync(brokerCopy, fs.readFileSync(brokerSrc));

// Mock os.homedir on Windows via USERPROFILE
const originalUserProfile = process.env.USERPROFILE;
process.env.USERPROFILE = mockHome;

let profileIcons;
try {
    ({ profileIcons } = require(copy));
} finally {
    process.env.USERPROFILE = originalUserProfile;
    fs.rmSync(mockHome, { recursive: true, force: true });
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
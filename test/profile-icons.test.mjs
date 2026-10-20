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
const os = require('node:os');
Module._load = (request, ...rest) =>
    request === 'vscode' ? { Uri: { file: (p) => ({ fsPath: p }) }, window: {} }
        : request === 'os' ? { ...os, homedir: () => mockHome } : load(request, ...rest);

// Create a mock home directory for the test
const mockHome = fs.mkdtempSync(path.join(tmpdir(), 'ccx-home-'));
const mockVannevar = path.join(mockHome, '.claude', 'vannevar');
fs.mkdirSync(mockVannevar, { recursive: true });
const profiles = path.join(mockHome, '.claude', 'profiles');
fs.mkdirSync(profiles, { recursive: true });
fs.writeFileSync(path.join(profiles, 'fixture.json'), JSON.stringify({ env: {} }));
fs.writeFileSync(path.join(profiles, 'fixture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7"/></svg>');
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
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    Module._load = load;
}

const icons = profileIcons();
fs.rmSync(mockHome, { recursive: true, force: true });
const MAX_ICON_BYTES = 512 * 1024;
const names = Object.keys(icons);

assert.deepEqual(names, ['fixture'], 'the isolated fixture profile must be measured on every platform');

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
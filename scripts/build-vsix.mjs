// Minimal .vsix writer. A .vsix is an OPC package — a plain ZIP with a manifest and a content-types
// map beside the extension folder — so building one needs a ZIP writer and nothing else. vsce would
// pull a dependency tree into a project that has none; deflateRaw and the CRC-32 already used for
// PNGs cover the whole format.
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { crc32 } from './png.mjs';

// 1980-01-01, the DOS epoch: a fixed stamp keeps the archive byte-identical between builds
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function localHeader(entry) {
    const name = Buffer.from(entry.name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0, 6); // flags
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(entry.crc, 14);
    head.writeUInt32LE(entry.deflated.length, 18);
    head.writeUInt32LE(entry.raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.writeUInt16LE(0, 28); // extra
    return Buffer.concat([head, name]);
}

function centralHeader(entry) {
    const name = Buffer.from(entry.name, 'utf8');
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0, 8); // flags
    head.writeUInt16LE(8, 10); // deflate
    head.writeUInt16LE(DOS_TIME, 12);
    head.writeUInt16LE(DOS_DATE, 14);
    head.writeUInt32LE(entry.crc, 16);
    head.writeUInt32LE(entry.deflated.length, 20);
    head.writeUInt32LE(entry.raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk number
    head.writeUInt16LE(0, 36); // internal attrs
    head.writeUInt32LE(0, 38); // external attrs
    head.writeUInt32LE(entry.offset, 42);
    return Buffer.concat([head, name]);
}

// files: [{ name, data }] — name is the path inside the archive, always with forward slashes
export function zip(files) {
    const entries = [];
    const chunks = [];
    let offset = 0;

    for (const file of files) {
        const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
        const entry = { name: file.name, raw, deflated: deflateRawSync(raw, { level: 9 }), crc: crc32(raw), offset };
        const head = localHeader(entry);
        chunks.push(head, entry.deflated);
        offset += head.length + entry.deflated.length;
        entries.push(entry);
    }

    const central = entries.map(centralHeader);
    const centralSize = central.reduce((n, b) => n + b.length, 0);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4); // this disk
    end.writeUInt16LE(0, 6); // disk with central directory
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20); // comment

    return Buffer.concat([...chunks, ...central, end]);
}

// Every extension a file in the package can have. An extension missing from this map is served with no
// content type at all, which the gallery rejects on upload — so the list is the packer's file filter too.
const CONTENT_TYPES = {
    json: 'application/json',
    js: 'application/javascript',
    mjs: 'application/javascript',
    md: 'text/markdown',
    png: 'image/png',
    jpg: 'image/jpeg',
    vsixmanifest: 'text/xml',
    txt: 'text/plain',
};

function contentTypes() {
    const defaults = Object.entries(CONTENT_TYPES)
        .map(([ext, type]) => `  <Default Extension="${ext}" ContentType="${type}" />`)
        .join('\n');
    return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaults}
</Types>
`;
}

function xmlEscape(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// The gallery reads the listing out of these assets rather than out of package.json, so the icon and
// the README have to be declared here as well as shipped — a package without them installs fine from a
// file and shows up blank on the Marketplace.
function assets(pkg, files) {
    const has = (name) => files.some((f) => f.name === name);
    const rows = [{ type: 'Microsoft.VisualStudio.Code.Manifest', path: 'extension/package.json' }];
    if (pkg.icon && has(pkg.icon))
        rows.push({ type: 'Microsoft.VisualStudio.Services.Icons.Default', path: `extension/${pkg.icon}` });
    if (has('README.md')) rows.push({ type: 'Microsoft.VisualStudio.Services.Content.Details', path: 'extension/README.md' });
    if (has('LICENSE')) rows.push({ type: 'Microsoft.VisualStudio.Services.Content.License', path: 'extension/LICENSE' });
    return rows.map((a) => `    <Asset Type="${a.type}" Path="${xmlEscape(a.path)}" Addressable="true" />`).join('\n');
}

function manifest(pkg, files) {
    const { name, publisher, version, displayName, description } = pkg;
    return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(name)}" Version="${xmlEscape(version)}" Publisher="${xmlEscape(publisher)}" />
    <DisplayName>${xmlEscape(displayName)}</DisplayName>
    <Description xml:space="preserve">${xmlEscape(description)}</Description>
    <Tags>${xmlEscape((pkg.keywords || []).join(','))}</Tags>
    <Categories>${xmlEscape((pkg.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xmlEscape(pkg.engines?.vscode || '^1.85.0')}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${xmlEscape((pkg.extensionKind || ['ui']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xmlEscape(repositoryUrl(pkg))}" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
${assets(pkg, files)}
  </Assets>
</PackageManifest>
`;
}

function repositoryUrl(pkg) {
    const url = pkg.repository?.url || pkg.repository || '';
    return String(url).replace(/^git\+/, '').replace(/\.git$/, '');
}

// files: [{ name, data }] relative to the extension root; package.json must be among them
export function buildVsix(pkg, files) {
    return zip([
        { name: 'extension.vsixmanifest', data: manifest(pkg, files) },
        { name: '[Content_Types].xml', data: contentTypes() },
        ...files.map((f) => ({ name: `extension/${f.name}`, data: f.data })),
    ]);
}

// --- the CLI --------------------------------------------------------------------------------------
//
// What ships and what does not. Everything the extension needs at runtime, and nothing that only
// matters in the repository: test/, docs/, scripts/, .github/ and the README screenshots (the gallery
// serves those from the repository, so a 150 KB package stays 150 KB).
const SHIPPED = [
    { file: 'package.json' },
    { file: 'extension.js' },
    { file: 'README.md', optional: true },
    { file: 'LICENSE', optional: true },
    { file: 'DISCLAIMER.md', optional: true },
    { file: 'PRIVACY.md', optional: true },
    { file: 'CHANGELOG.md', optional: true },
    { file: 'images/icon.png', optional: true },
    { dir: 'runtime' },
    { dir: 'templates' },
];

function walk(root, rel, out) {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const next = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(root, next, out);
        else if (CONTENT_TYPES[next.split('.').pop().toLowerCase()]) out.push(next);
    }
}

export function shippedFiles(root) {
    const names = [];
    for (const item of SHIPPED) {
        if (item.dir) {
            if (existsSync(path.join(root, item.dir))) walk(root, item.dir, names);
            continue;
        }
        if (existsSync(path.join(root, item.file))) names.push(item.file);
        else if (!item.optional) throw Error(`missing ${item.file}`);
    }
    return names.map((name) => ({ name, data: readFileSync(path.join(root, name)) }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const files = shippedFiles(root);
    const out = path.join(root, `${pkg.name}-${pkg.version}.vsix`);
    const bytes = buildVsix(pkg, files);
    writeFileSync(out, bytes);
    console.log(`${path.basename(out)}: ${files.length} file(s), ${(bytes.length / 1024).toFixed(0)} KB`);
    for (const f of files) console.log(`  ${f.name}`);
}

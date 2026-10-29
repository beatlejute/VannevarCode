import { readFileSync, writeFileSync } from 'node:fs';

const PROHIBITED = [
	'eval(',
	'Function(',
	"require('child_process')",
	'require("child_process")',
	'import(',
	'fetch(',
	'XMLHttpRequest',
];

const USAGE = `Usage: node scripts/adaptation/normalize-js.mjs --input <file> --out <file>

Analysis-only semantic normalization tool. Detects string-array mapping and
constant indirection in JavaScript source and statically resolves provable
constants. Never evaluates, compiles or executes the input; no network or
child-process access.

Options:
  --input <file>  source file to normalize (required)
  --out <file>    write JSON/IR result to this file (required, explicit)
  --help          show this help and exit

Provenance: every resolved value carries provenance { file, start, end }
back to the raw source range. Unresolvable values resolve to UNRESOLVED.
Prohibited constructs in the analyzed source (eval, Function, child
execution, network) are reported, never used by this tool.
`;

function fail(msg) {
	console.error(msg);
	process.exit(1);
}

function parseArgs(argv) {
	let input = null;
	let out = null;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--help') {
			process.stdout.write(USAGE);
			process.exit(0);
		}
		if (arg === '--input') {
			input = argv[++i];
			continue;
		}
		if (arg === '--out') {
			out = argv[++i];
			continue;
		}
		fail(`unknown argument: ${arg}`);
	}
	if (!input || !out) {
		fail('Usage: node scripts/adaptation/normalize-js.mjs --input <file> --out <file>');
	}
	return { input, out };
}

function readStringLiteral(source, quotePos) {
	const quote = source[quotePos];
	let i = quotePos + 1;
	while (i < source.length) {
		const c = source[i];
		if (c === '\\') {
			i += 2;
			continue;
		}
		if (c === quote) {
			return { value: source.slice(quotePos + 1, i), end: i + 1 };
		}
		i += 1;
	}
	return null;
}

function unescapeLiteral(raw) {
	let out = '';
	let i = 0;
	while (i < raw.length) {
		const c = raw[i];
		if (c !== '\\') {
			out += c;
			i += 1;
			continue;
		}
		const n = raw[i + 1];
		if (n === undefined) {
			out += c;
			i += 1;
			continue;
		}
		switch (n) {
			case "'": out += "'"; break;
			case '"': out += '"'; break;
			case '\\': out += '\\'; break;
			case 'b': out += '\b'; break;
			case 'f': out += '\f'; break;
			case 'n': out += '\n'; break;
			case 'r': out += '\r'; break;
			case 't': out += '\t'; break;
			case 'v': out += '\v'; break;
			case '0': out += '\0'; break;
			case 'x':
				out += String.fromCodePoint(parseInt(raw.slice(i + 2, i + 4), 16));
				i += 3;
				break;
			case 'u':
				out += String.fromCodePoint(parseInt(raw.slice(i + 2, i + 6), 16));
				i += 5;
				break;
			default:
				out += n;
		}
		i += 2;
	}
	return out;
}

function findDeclarations(source) {
	const constMap = new Map();
	const arrayMap = new Map();
	const aliasMap = new Map();

	const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
	let match;
	while ((match = declRe.exec(source)) !== null) {
		const name = match[1];
		const eqPos = match.index + match[0].length - 1;
		let cursor = eqPos + 1;
		while (cursor < source.length && (source[cursor] === ' ' || source[cursor] === '\t')) cursor += 1;
		const c = source[cursor];

		if (c === "'" || c === '"') {
			const lit = readStringLiteral(source, cursor);
			if (lit) {
				constMap.set(name, { value: unescapeLiteral(lit.value), start: match.index, end: lit.end });
			}
			continue;
		}
		if (c === '[') {
			let depth = 1;
			let j = cursor + 1;
			while (j < source.length && depth > 0) {
				const ch = source[j];
				if (ch === '[') depth += 1;
				else if (ch === ']') depth -= 1;
				else if (ch === "'" || ch === '"') {
					const lit = readStringLiteral(source, j);
					if (!lit) break;
					j = lit.end;
					continue;
				}
				j += 1;
			}
			const content = source.slice(cursor + 1, j - 1);
			const values = [];
			let k = 0;
			while (k < content.length) {
				while (k < content.length && (content[k] === ' ' || content[k] === '\t' || content[k] === ',' || content[k] === '\n' || content[k] === '\r')) k += 1;
				if (k >= content.length) break;
				const qc = content[k];
				if (qc === "'" || qc === '"') {
					const lit = readStringLiteral(content, k);
					if (!lit) break;
					values.push({ value: unescapeLiteral(lit.value), start: cursor + 1 + k, end: cursor + 1 + lit.end });
					k = lit.end;
					continue;
				}
				k += 1;
			}
			if (values.length > 0) arrayMap.set(name, values);
			continue;
		}
		if ((c === "'" || c === '"') === false && /[A-Za-z_$]/.test(c)) {
			let j = cursor;
			while (j < source.length && /[\w$]/.test(source[j])) j += 1;
			const target = source.slice(cursor, j);
			if (target !== name) aliasMap.set(name, target);
			continue;
		}
	}
	return { constMap, arrayMap, aliasMap };
}

function resolveName(name, constMap, arrayMap, aliasMap, seen) {
	if (constMap.has(name)) return { kind: 'literal', ...constMap.get(name) };
	if (arrayMap.has(name)) return { kind: 'array', values: arrayMap.get(name) };
	if (aliasMap.has(name)) {
		if (seen.has(name)) return { kind: 'UNRESOLVED', reason: 'alias cycle' };
		seen.add(name);
		return resolveName(aliasMap.get(name), constMap, arrayMap, aliasMap, seen);
	}
	return { kind: 'UNRESOLVED', reason: 'unknown binding' };
}

function findProhibited(source) {
	const found = [];
	for (const p of PROHIBITED) {
		if (source.includes(p)) found.push(p);
	}
	return found;
}

function normalize(source, fileName) {
	const { constMap, arrayMap, aliasMap } = findDeclarations(source);
	const entries = [];
	const indexRe = /([A-Za-z_$][\w$]*)\[([^\]]*)\]/g;
	let match;
	while ((match = indexRe.exec(source)) !== null) {
		const arrayName = match[1];
		const inner = match[2].trim();
		const start = match.index;
		const end = match.index + match[0].length;
		let entry;
		if (!/^-?\d+$/.test(inner)) {
			entry = { expression: match[0], status: 'UNRESOLVED', reason: 'runtime-dependent index', provenance: { file: fileName, start, end } };
		} else {
			const index = Number(inner);
			const binding = resolveName(arrayName, constMap, arrayMap, aliasMap, new Set());
			if (binding.kind === 'array') {
				const values = binding.values;
				if (index < 0 || index >= values.length) {
					entry = { expression: match[0], status: 'UNRESOLVED', reason: 'index out of range', provenance: { file: fileName, start, end } };
				} else {
					entry = { expression: match[0], status: 'resolved', value: values[index].value, provenance: { file: fileName, start: values[index].start, end: values[index].end } };
				}
			} else if (binding.kind === 'literal') {
				entry = { expression: match[0], status: 'resolved', value: binding.value, provenance: { file: fileName, start: binding.start, end: binding.end } };
			} else {
				entry = { expression: match[0], status: 'UNRESOLVED', reason: binding.reason, provenance: { file: fileName, start, end } };
			}
		}
		entries.push(entry);
	}
	return { entries, prohibitedFound: findProhibited(source) };
}

function main() {
	const { input, out } = parseArgs(process.argv.slice(2));
	let source;
	try {
		source = readFileSync(input, 'utf8');
	} catch (err) {
		fail(`cannot read input: ${input} (${err.message})`);
	}
	const result = {
		tool: 'normalize-js',
		input,
		entries: normalize(source, input).entries,
		prohibitedFound: findProhibited(source),
	};
	writeFileSync(out, JSON.stringify(result, null, 2) + '\n', 'utf8');
	process.exit(0);
}

main();

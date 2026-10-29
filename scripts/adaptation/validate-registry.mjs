import { readFileSync } from 'node:fs';

const VALID_SURFACES = new Set(['HOST', 'WEBVIEW']);
const VALID_STATES = new Set(['legacy', 'active', 'deprecated']);
const VALID_MATCHER_KINDS = new Set(['legacy-textual', 'ast', 'textual-fallback', 'literal']);
const VALID_RESTORE_POLICIES = new Set(['full-backup']);

const PATCH_POINT_FIELDS = ['id', 'targetFile', 'surface', 'owner', 'required', 'restorePolicy', 'variants'];
const VARIANT_FIELDS = ['id', 'state', 'matcherKind', 'semanticAnchor', 'moduleScope', 'preconditions', 'postconditions', 'negativeFixtures', 'knownVersions', 'justification'];

const errors = [];

function fail(msg) {
	errors.push(msg);
}

const file = process.argv[2];
if (!file) {
	console.error('Usage: node scripts/adaptation/validate-registry.mjs <registry-file>');
	process.exit(1);
}

let registry;
try {
	registry = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
	console.error(`malformed JSON: ${file} (${err.message})`);
	process.exit(1);
}

if (typeof registry.schemaVersion !== 'string' || !registry.schemaVersion) {
	fail('schemaVersion missing or not a string');
}

if (!Array.isArray(registry.patchPoints) || registry.patchPoints.length === 0) {
	fail('patchPoints missing or empty');
} else {
	const patchIds = new Set();
	const variantIds = new Set();
	for (let i = 0; i < registry.patchPoints.length; i++) {
		const p = registry.patchPoints[i];
		const prefix = `patchPoints[${i}]`;
		for (const f of PATCH_POINT_FIELDS) {
			if (!(f in p)) fail(`${prefix}: missing field ${f}`);
		}
		if (typeof p.id === 'string' && p.id) {
			if (patchIds.has(p.id)) fail(`duplicate patch id: ${p.id}`);
			patchIds.add(p.id);
		}
		if (typeof p.surface === 'string' && !VALID_SURFACES.has(p.surface)) fail(`${prefix}: invalid surface ${p.surface}`);
		if (typeof p.restorePolicy === 'string' && !VALID_RESTORE_POLICIES.has(p.restorePolicy)) fail(`${prefix}: invalid restorePolicy ${p.restorePolicy}`);
		if (typeof p.required !== 'boolean') fail(`${prefix}: required must be boolean`);
		if (typeof p.targetFile === 'string' && /\/.*\\|\\.*\//.test(p.targetFile)) fail(`${prefix}: mixed path separators in targetFile ${p.targetFile}`);

		if (!Array.isArray(p.variants)) {
			fail(`${prefix}: variants must be an array`);
		} else {
			if (p.variants.length === 0) fail(`${prefix}: empty variants`);
			let allDeprecated = true;
			for (let j = 0; j < p.variants.length; j++) {
				const v = p.variants[j];
				const vprefix = `${prefix}.variants[${j}]`;
				for (const f of VARIANT_FIELDS) {
					if (!(f in v)) fail(`${vprefix}: missing field ${f}`);
				}
				if (typeof v.id === 'string' && v.id) {
					if (variantIds.has(v.id)) fail(`duplicate variant id: ${v.id}`);
					variantIds.add(v.id);
				}
				if (typeof v.state === 'string' && !VALID_STATES.has(v.state)) fail(`${vprefix}: invalid state ${v.state}`);
				if (v.state !== 'deprecated') allDeprecated = false;
				if (typeof v.matcherKind === 'string' && !VALID_MATCHER_KINDS.has(v.matcherKind)) fail(`${vprefix}: invalid matcherKind ${v.matcherKind}`);
				if (v.matcherKind === 'textual-fallback' && (typeof v.justification !== 'string' || !v.justification.trim())) {
					fail(`${vprefix}: textual-fallback requires justification`);
				}
				if (typeof p.owner === 'string' && p.owner !== 'vannevar') {
					if (v.moduleScope == null || v.moduleScope === '') fail(`${vprefix}: third-party anchor requires module fingerprint`);
					else if (/^\d+$/.test(String(v.moduleScope))) fail(`${vprefix}: numeric module ID not allowed as sole owner identity`);
				}
				if (typeof v.moduleScope === 'string' && /^\d+$/.test(v.moduleScope)) {
					fail(`${vprefix}: numeric module ID not allowed as sole owner identity`);
				}
			}
			if (p.required === true && allDeprecated) fail(`${prefix}: required patch point with deprecated-only variants`);
		}
	}
}

if (errors.length > 0) {
	for (const e of errors) console.error(e);
	process.exit(1);
}
process.exit(0);

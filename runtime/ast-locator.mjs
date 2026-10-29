import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function locate(rawSource, descriptor) {
  if (typeof rawSource !== 'string') throw new TypeError('rawSource must be string');
  const { range, kind, moduleScope, nodeType } = descriptor || {};
  const identifier = descriptor?.identifier || descriptor?.semanticAnchor;
  // Explicit offsets are a separate, preserved contract; they need not contain JavaScript.
  if (range) {
    if (!Number.isInteger(range.start) || !Number.isInteger(range.end) ||
        range.start < 0 || range.end <= range.start || range.end > rawSource.length) return [];
    return [{ start: range.start, end: range.end, kind: kind || 'ast', identifier }];
  }
  if (typeof identifier !== 'string' || !/^[$A-Z_a-z][$\w]*$/.test(identifier)) return [];
  if (moduleScope != null && (typeof moduleScope !== 'object' ||
      typeof moduleScope.identifier !== 'string' || Object.keys(moduleScope).some((k) => k !== 'identifier'))) return [];

  // Load only on the AST path: copied legacy patchers do not need the toolchain.
  const { parse } = require('@babel/parser');
  const traverse = require('@babel/traverse').default;
  const nameOf = (node) => node.id?.name ||
    (['ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'].includes(node.type) && !node.computed ? node.key?.name : null);
  const candidates = [];
  try {
    const ast = parse(rawSource, { sourceType: 'unambiguous', errorRecovery: false });
    traverse(ast, {
      enter(p) {
        const { node } = p;
        if (!['FunctionDeclaration', 'FunctionExpression', 'VariableDeclarator', 'ClassDeclaration', 'ObjectMethod', 'ClassMethod'].includes(node.type)) return;
        if (nameOf(node) !== identifier || (nodeType && node.type !== nodeType)) return;
        if (moduleScope && !p.findParent((parent) => nameOf(parent.node) === moduleScope.identifier)) return;
        candidates.push({ start: node.start, end: node.end, kind: kind || 'ast', identifier });
      },
    });
  } catch {
    return [];
  }
  // Babel offsets refer to the untouched UTF-16 source, suitable for String.slice.
  return candidates.length === 1 ? candidates : [];
}

export default { locate };

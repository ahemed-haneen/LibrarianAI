import * as ts from 'typescript';

export interface SourceAnalysis {
  /** Signature-only view of the file's public surface (TypeScript-ish syntax). */
  skeleton: string;
  /** Exported symbol names (used for search). */
  exportNames: string[];
  /** Raw module specifiers this file imports / requires / re-exports. */
  importSpecifiers: string[];
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (/\.tsx$/.test(fileName)) {
    return ts.ScriptKind.TSX;
  }
  if (/\.jsx$/.test(fileName)) {
    return ts.ScriptKind.JSX;
  }
  if (/\.[mc]?js$/.test(fileName)) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === kind);
}

/** First sentence of the node's leading JSDoc, if any — cheap, high-signal context. */
function docSummary(node: ts.Node, sf: ts.SourceFile): string | undefined {
  const ranges = ts.getLeadingCommentRanges(sf.text, node.getFullStart()) ?? [];
  for (let i = ranges.length - 1; i >= 0; i--) {
    const raw = sf.text.slice(ranges[i].pos, ranges[i].end);
    if (!raw.startsWith('/**')) {
      continue;
    }
    const body = raw
      .replace(/^\/\*\*|\*\/$/g, '')
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim())
      .filter((l) => l && !l.startsWith('@'))
      .join(' ');
    const sentence = body.split(/(?<=[.!?])\s/)[0]?.trim();
    if (sentence) {
      return sentence.length > 160 ? sentence.slice(0, 157) + '...' : sentence;
    }
  }
  return undefined;
}

function oneLine(text: string, max = 200): string {
  const s = text.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

function params(list: ts.NodeArray<ts.ParameterDeclaration>, sf: ts.SourceFile): string {
  return list
    .map((p) => {
      // Drop default-value bodies (can be long) but keep the fact that the param is optional.
      const name = p.name.getText(sf);
      const rest = p.dotDotDotToken ? '...' : '';
      const opt = p.questionToken || p.initializer ? '?' : '';
      const type = p.type ? `: ${oneLine(p.type.getText(sf), 120)}` : '';
      return `${rest}${name}${opt}${type}`;
    })
    .join(', ');
}

function typeParams(node: { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }, sf: ts.SourceFile): string {
  return node.typeParameters?.length ? `<${node.typeParameters.map((t) => t.getText(sf)).join(', ')}>` : '';
}

function ret(node: { type?: ts.TypeNode }, sf: ts.SourceFile): string {
  return node.type ? `: ${oneLine(node.type.getText(sf), 160)}` : '';
}

function isPrivateMember(m: ts.ClassElement): boolean {
  return (
    hasModifier(m, ts.SyntaxKind.PrivateKeyword) ||
    (!!m.name && ts.isPrivateIdentifier(m.name))
  );
}

function classLines(node: ts.ClassDeclaration | ts.ClassExpression, sf: ts.SourceFile, header: string): string[] {
  const lines = [header + ' {'];
  for (const m of node.members) {
    if (isPrivateMember(m)) {
      continue;
    }
    const isStatic = hasModifier(m, ts.SyntaxKind.StaticKeyword) ? 'static ' : '';
    const isAbstract = hasModifier(m, ts.SyntaxKind.AbstractKeyword) ? 'abstract ' : '';
    const prot = hasModifier(m, ts.SyntaxKind.ProtectedKeyword) ? 'protected ' : '';
    const prefix = `  ${prot}${isStatic}${isAbstract}`;
    if (ts.isConstructorDeclaration(m)) {
      lines.push(`${prefix}constructor(${params(m.parameters, sf)});`);
    } else if (ts.isMethodDeclaration(m)) {
      const asyncKw = hasModifier(m, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
      lines.push(`${prefix}${asyncKw}${m.name.getText(sf)}${typeParams(m, sf)}(${params(m.parameters, sf)})${ret(m, sf)};`);
    } else if (ts.isPropertyDeclaration(m)) {
      const ro = hasModifier(m, ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
      lines.push(`${prefix}${ro}${m.name.getText(sf)}${m.questionToken ? '?' : ''}${ret(m, sf)};`);
    } else if (ts.isGetAccessorDeclaration(m)) {
      lines.push(`${prefix}get ${m.name.getText(sf)}()${ret(m, sf)};`);
    } else if (ts.isSetAccessorDeclaration(m)) {
      lines.push(`${prefix}set ${m.name.getText(sf)}(${params(m.parameters, sf)});`);
    }
  }
  lines.push('}');
  return lines;
}

function heritage(node: ts.ClassDeclaration | ts.InterfaceDeclaration, sf: ts.SourceFile): string {
  return node.heritageClauses?.length ? ' ' + node.heritageClauses.map((h) => oneLine(h.getText(sf), 160)).join(' ') : '';
}

/** Describe a variable initializer without its implementation: arrow fns keep their signature. */
function describeInitializer(init: ts.Expression | undefined, sf: ts.SourceFile): string | undefined {
  if (!init) {
    return undefined;
  }
  let e = init;
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    const asyncKw = hasModifier(e, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
    return `${asyncKw}${typeParams(e, sf)}(${params(e.parameters, sf)}) => ${e.type ? oneLine(e.type.getText(sf), 160) : 'unknown'}`;
  }
  if (ts.isCallExpression(e)) {
    return `ReturnType<typeof ${oneLine(e.expression.getText(sf), 60)}>`;
  }
  if (ts.isObjectLiteralExpression(e)) {
    const keys = e.properties.map((p) => (p.name ? p.name.getText(sf) : '...')).slice(0, 15);
    return `{ ${keys.join('; ')}${e.properties.length > 15 ? '; ...' : ''} }`;
  }
  if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) {
    return oneLine(e.getText(sf), 80);
  }
  if (ts.isNewExpression(e)) {
    return oneLine(e.expression.getText(sf), 60);
  }
  return undefined;
}

export function analyzeSource(fileName: string, content: string): SourceAnalysis {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const lines: string[] = [];
  const exportNames = new Set<string>();
  const importSpecifiers = new Set<string>();

  const pushDoc = (node: ts.Node) => {
    const doc = docSummary(node, sf);
    if (doc) {
      lines.push(`/** ${doc} */`);
    }
  };

  for (const node of sf.statements) {
    // ---- imports / re-exports ----
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      importSpecifiers.add(node.moduleSpecifier.text);
      continue;
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      importSpecifiers.add(node.moduleReference.expression.text);
    }
    if (ts.isExportDeclaration(node)) {
      const from = node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
      if (from) {
        importSpecifiers.add(from);
      }
      if (!node.exportClause) {
        lines.push(`export * from '${from}';`);
      } else if (ts.isNamespaceExport(node.exportClause)) {
        lines.push(`export * as ${node.exportClause.name.text} from '${from}';`);
        exportNames.add(node.exportClause.name.text);
      } else {
        const names = node.exportClause.elements.map((el) => el.getText(sf));
        node.exportClause.elements.forEach((el) => exportNames.add(el.name.text));
        lines.push(`export ${node.isTypeOnly ? 'type ' : ''}{ ${names.join(', ')} }${from ? ` from '${from}'` : ''};`);
      }
      continue;
    }
    if (ts.isExportAssignment(node)) {
      const desc = describeInitializer(node.expression, sf) ?? oneLine(node.expression.getText(sf), 80);
      lines.push(node.isExportEquals ? `export = ${desc};` : `export default ${desc};`);
      exportNames.add('default');
      continue;
    }

    // ---- CommonJS: module.exports = ... / exports.x = ... ----
    if (ts.isExpressionStatement(node) && ts.isBinaryExpression(node.expression) && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.expression.left.getText(sf);
      const right = node.expression.right;
      const m = /^(?:module\.)?exports(?:\.(\w+))?$/.exec(left);
      if (m) {
        pushDoc(node);
        const desc = describeInitializer(right, sf) ?? (ts.isIdentifier(right) ? right.text : 'unknown');
        if (m[1]) {
          lines.push(`exports.${m[1]}: ${desc};`);
          exportNames.add(m[1]);
        } else {
          lines.push(`module.exports = ${desc};`);
          if (ts.isObjectLiteralExpression(right)) {
            right.properties.forEach((p) => p.name && exportNames.add(p.name.getText(sf)));
          }
        }
      }
    }

    const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword);
    if (!exported) {
      continue;
    }
    const isDefault = hasModifier(node, ts.SyntaxKind.DefaultKeyword);
    const kw = isDefault ? 'export default' : 'export';

    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.text ?? '';
      pushDoc(node);
      const asyncKw = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? 'async ' : '';
      lines.push(`${kw} ${asyncKw}function${node.asteriskToken ? '*' : ''} ${name}${typeParams(node, sf)}(${params(node.parameters, sf)})${ret(node, sf)};`);
      exportNames.add(name || 'default');
      if (isDefault) {
        exportNames.add('default');
      }
    } else if (ts.isClassDeclaration(node)) {
      pushDoc(node);
      const abs = hasModifier(node, ts.SyntaxKind.AbstractKeyword) ? 'abstract ' : '';
      const name = node.name?.text ?? '';
      lines.push(...classLines(node, sf, `${kw} ${abs}class ${name}${typeParams(node, sf)}${heritage(node, sf)}`));
      exportNames.add(name || 'default');
      if (isDefault) {
        exportNames.add('default');
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      pushDoc(node);
      lines.push(`export interface ${node.name.text}${typeParams(node, sf)}${heritage(node, sf)} {`);
      node.members.forEach((m) => lines.push(`  ${oneLine(m.getText(sf).replace(/[;,]\s*$/, ''), 200)};`));
      lines.push('}');
      exportNames.add(node.name.text);
    } else if (ts.isTypeAliasDeclaration(node)) {
      pushDoc(node);
      lines.push(`export type ${node.name.text}${typeParams(node, sf)} = ${oneLine(node.type.getText(sf), 300)};`);
      exportNames.add(node.name.text);
    } else if (ts.isEnumDeclaration(node)) {
      pushDoc(node);
      const isConst = hasModifier(node, ts.SyntaxKind.ConstKeyword) ? 'const ' : '';
      lines.push(`export ${isConst}enum ${node.name.text} { ${node.members.map((m) => m.name.getText(sf)).join(', ')} }`);
      exportNames.add(node.name.text);
    } else if (ts.isModuleDeclaration(node)) {
      lines.push(`export namespace ${node.name.getText(sf)} { ... }`);
      exportNames.add(node.name.getText(sf));
    } else if (ts.isVariableStatement(node)) {
      pushDoc(node);
      const declKw = node.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
      for (const decl of node.declarationList.declarations) {
        const name = decl.name.getText(sf);
        const type = decl.type ? oneLine(decl.type.getText(sf), 200) : describeInitializer(decl.initializer, sf) ?? 'unknown';
        lines.push(`export ${declKw} ${oneLine(name, 120)}: ${type};`);
        if (ts.isIdentifier(decl.name)) {
          exportNames.add(decl.name.text);
        }
      }
    }
  }

  // require('x') and import('x') anywhere in the file
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && n.arguments.length === 1 && ts.isStringLiteralLike(n.arguments[0])) {
      const callee = n.expression;
      if ((ts.isIdentifier(callee) && callee.text === 'require') || callee.kind === ts.SyntaxKind.ImportKeyword) {
        importSpecifiers.add(n.arguments[0].text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return {
    skeleton: lines.join('\n'),
    exportNames: [...exportNames].filter(Boolean),
    importSpecifiers: [...importSpecifiers],
  };
}

const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Resolve a relative import specifier to a known source file (posix, root-relative).
 * Handles extensionless imports, `/index` files and Node16-style `.js` specifiers that point at `.ts`.
 */
export function resolveImport(fromRel: string, spec: string, known: Set<string>): string | undefined {
  if (!spec.startsWith('.')) {
    return undefined;
  }
  const baseDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
  const joined = normalizePosix(baseDir ? `${baseDir}/${spec}` : spec);
  const stripped = joined.replace(/\.(m|c)?jsx?$/, '');
  const candidates = [
    joined,
    ...RESOLVE_EXT.map((e) => stripped + e),
    ...RESOLVE_EXT.map((e) => `${joined}/index${e}`),
  ];
  return candidates.find((c) => known.has(c));
}

function normalizePosix(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

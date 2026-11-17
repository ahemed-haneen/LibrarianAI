import type { SourceAnalysis } from './analyzer';

/**
 * Python support: skeleton + import extraction without a Python interpreter or native parser.
 *
 * Python's grammar is indentation-based, so instead of a full AST this reads *logical lines*
 * (strings, brackets and line continuations resolved) with their indentation, then picks out
 * module-level functions, classes (with their methods and class-level fields), constants,
 * decorators, docstrings and imports. It is deterministic and has no dependencies, so it works
 * the same in the extension, the CLI and CI.
 *
 * Import specifiers are returned as `py:<dotted>` (relative imports keep their dots, e.g.
 * `py:..core.util`) and resolved to files by `resolvePythonImport`.
 */

interface Line {
  indent: number;
  text: string;
}

const QUOTES = new Set(['"', "'"]);

/** Split Python source into logical lines: comments removed, strings and brackets kept whole. */
export function logicalLines(source: string): Line[] {
  const s = source.replace(/\r\n?/g, '\n');
  const n = s.length;
  const out: Line[] = [];
  let i = 0;
  let buf = '';
  let depth = 0;
  let indent = 0;
  let atStart = true;

  const flush = () => {
    const text = buf.replace(/\s+/g, ' ').trim();
    if (text) {
      out.push({ indent, text });
    }
    buf = '';
    depth = 0;
    atStart = true;
  };

  while (i < n) {
    if (atStart && depth === 0 && buf === '') {
      let w = 0;
      while (i < n && (s[i] === ' ' || s[i] === '\t' || s[i] === '\f')) {
        w += s[i] === '\t' ? 4 : s[i] === '\f' ? 0 : 1;
        i++;
      }
      if (i >= n) {
        break;
      }
      if (s[i] === '\n') {
        i++;
        continue;
      }
      if (s[i] === '#') {
        while (i < n && s[i] !== '\n') {
          i++;
        }
        continue;
      }
      indent = w;
      atStart = false;
    }

    const c = s[i];
    if (QUOTES.has(c)) {
      const triple = s[i + 1] === c && s[i + 2] === c;
      const start = i;
      i += triple ? 3 : 1;
      while (i < n) {
        if (s[i] === '\\') {
          i += 2;
          continue;
        }
        if (triple ? s[i] === c && s[i + 1] === c && s[i + 2] === c : s[i] === c) {
          i += triple ? 3 : 1;
          break;
        }
        if (!triple && s[i] === '\n') {
          break; // unterminated single-line string: stop at the line end instead of swallowing the file
        }
        i++;
      }
      buf += s.slice(start, Math.min(i, n));
      continue;
    }
    if (c === '#') {
      while (i < n && s[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      buf += ' ';
      i += 2;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
    }
    if (c === '\n') {
      i++;
      if (depth > 0) {
        buf += ' ';
      } else {
        flush();
      }
      continue;
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Index of the first top-level occurrence of `ch` in `text` (outside strings and brackets), or -1. */
function findTop(text: string, ch: string, from = 0): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (QUOTES.has(c)) {
      const triple = text[i + 1] === c && text[i + 2] === c;
      i += triple ? 3 : 1;
      while (i < text.length && !(triple ? text[i] === c && text[i + 1] === c && text[i + 2] === c : text[i] === c)) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i += triple ? 2 : 0;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
    } else if (depth === 0 && c === ch) {
      if (ch === '=' && (text[i + 1] === '=' || (i > 0 && '=!<>:'.includes(text[i - 1])))) {
        continue; // ==, !=, <=, >=, :=
      }
      return i;
    }
  }
  return -1;
}

/** Index of the bracket that closes the one opened at `open`, or -1. */
function matchBracket(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (QUOTES.has(c)) {
      const triple = text[i + 1] === c && text[i + 2] === c;
      i += triple ? 3 : 1;
      while (i < text.length && !(triple ? text[i] === c && text[i + 1] === c && text[i + 2] === c : text[i] === c)) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i += triple ? 2 : 0;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (;;) {
    const at = findTop(text, sep, from);
    if (at < 0) {
      parts.push(text.slice(from));
      return parts.map((p) => p.trim()).filter(Boolean);
    }
    parts.push(text.slice(from, at));
    from = at + 1;
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 3) + '...' : t;
}

/** The text of a string-literal statement (docstring), or undefined if the line is not one. */
function stringContent(text: string): string | undefined {
  const m = /^[rRuUbBfF]{0,2}("""|'''|"|')/.exec(text);
  if (!m) {
    return undefined;
  }
  const q = m[1];
  const body = text.slice(m[0].length);
  const end = body.indexOf(q);
  return (end >= 0 ? body.slice(0, end) : body).trim();
}

function firstSentence(doc: string | undefined): string | undefined {
  if (!doc) {
    return undefined;
  }
  const sentence = doc.split(/(?<=[.!?])\s/)[0]?.trim();
  return sentence ? clip(sentence, 160) : undefined;
}

// ---------------------------------------------------------------- imports

function addImports(text: string, add: (spec: string) => void): void {
  let m = /^import\s+(.+)$/.exec(text);
  if (m) {
    for (const part of splitTop(m[1], ',')) {
      const name = part.split(/\s+as\s+/)[0].trim();
      if (/^[\w.]+$/.test(name)) {
        add('py:' + name);
      }
    }
    return;
  }
  m = /^from\s+(\.*)([\w.]*)\s+import\s+(.+)$/.exec(text);
  if (!m) {
    return;
  }
  const [, dots, mod, rest] = m;
  add('py:' + dots + mod);
  const names = rest.trim().replace(/^\(/, '').replace(/\)$/, '');
  for (const item of splitTop(names, ',')) {
    const name = item.split(/\s+as\s+/)[0].trim();
    // `from pkg import sub` may import a submodule; the resolver ignores names that are not files.
    if (/^\w+$/.test(name)) {
      add('py:' + dots + (mod ? mod + '.' : '') + name);
    }
  }
}

// ---------------------------------------------------------------- signatures

function shortDefault(value: string): string {
  const v = value.trim();
  if (v.length <= 30) {
    return v;
  }
  const call = /^([\w.]+)\(/.exec(v);
  return call ? `${call[1]}(...)` : '...';
}

function renderParams(raw: string, dropFirst: boolean): string {
  let items = splitTop(raw, ',');
  if (dropFirst && items.length && /^(self|cls|mcs|mcls)\b/.test(items[0])) {
    items = items.slice(1);
  }
  const rendered = items.map((item) => {
    const eq = findTop(item, '=');
    if (eq < 0) {
      return item.replace(/\s+/g, ' ');
    }
    return `${item.slice(0, eq).replace(/\s+/g, ' ').trim()} = ${shortDefault(item.slice(eq + 1))}`;
  });
  return clip(rendered.join(', '), 300);
}

interface Def {
  name: string;
  async: boolean;
  params: string;
  returns?: string;
}

function parseDef(text: string): Def | undefined {
  const m = /^(async\s+)?def\s+([A-Za-z_]\w*)\s*/.exec(text);
  if (!m) {
    return undefined;
  }
  let at = m[0].length;
  if (text[at] === '[') {
    const close = matchBracket(text, at); // PEP 695 type parameters
    if (close < 0) {
      return undefined;
    }
    at = close + 1;
    while (text[at] === ' ') {
      at++;
    }
  }
  if (text[at] !== '(') {
    return undefined;
  }
  const close = matchBracket(text, at);
  if (close < 0) {
    return undefined;
  }
  const rest = text.slice(close + 1);
  const arrow = /^\s*->\s*/.exec(rest);
  let returns: string | undefined;
  if (arrow) {
    const afterArrow = rest.slice(arrow[0].length);
    const colon = findTop(afterArrow, ':');
    returns = clip(colon >= 0 ? afterArrow.slice(0, colon) : afterArrow, 160);
  }
  return { name: m[2], async: !!m[1], params: text.slice(at + 1, close), returns };
}

function parseClass(text: string): { name: string; bases: string } | undefined {
  const m = /^class\s+([A-Za-z_]\w*)\s*/.exec(text);
  if (!m) {
    return undefined;
  }
  let at = m[0].length;
  if (text[at] === '[') {
    const close = matchBracket(text, at);
    if (close < 0) {
      return undefined;
    }
    at = close + 1;
    while (text[at] === ' ') {
      at++;
    }
  }
  let bases = '';
  if (text[at] === '(') {
    const close = matchBracket(text, at);
    if (close < 0) {
      return undefined;
    }
    bases = clip(text.slice(at + 1, close), 160);
  }
  return { name: m[1], bases };
}

// ---------------------------------------------------------------- assignments

interface Assign {
  name: string;
  annotation?: string;
  value?: string;
}

const STATEMENT_START = /^(if|elif|else|for|while|try|except|finally|with|return|raise|assert|del|global|nonlocal|pass|break|continue|import|from|print|yield|await|lambda|match|case|async|def|class)\b/;

function parseAssign(text: string): Assign | undefined {
  if (STATEMENT_START.test(text)) {
    return undefined;
  }
  const eq = findTop(text, '=');
  const left = (eq >= 0 ? text.slice(0, eq) : text).trim();
  const value = eq >= 0 ? text.slice(eq + 1).trim() : undefined;
  const colon = findTop(left, ':');
  const name = (colon >= 0 ? left.slice(0, colon) : left).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    return undefined;
  }
  if (colon < 0 && eq < 0) {
    return undefined; // bare expression
  }
  return { name, annotation: colon >= 0 ? clip(left.slice(colon + 1), 160) : undefined, value };
}

function describeValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const v = value.trim();
  if (/^(-?\d[\d_.]*|True|False|None|[rRuUbBfF]{0,2}("[^"]*"|'[^']*'))$/.test(v) && v.length <= 80) {
    return v;
  }
  const call = /^([\w.]+)\(/.exec(v);
  if (call) {
    const close = matchBracket(v, call[0].length - 1);
    const args = close > 0 ? v.slice(call[0].length, close) : v.slice(call[0].length);
    return `${call[1]}(${clip(args, 90)})`;
  }
  if (v.startsWith('{')) {
    const close = matchBracket(v, 0);
    const keys = splitTop(v.slice(1, close > 0 ? close : undefined), ',')
      .map((p) => p.split(':')[0].trim())
      .filter(Boolean);
    return keys.length ? `{ ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', ...' : ''} }` : '{}';
  }
  if (v.startsWith('[') || v.startsWith('(')) {
    return v.length <= 80 ? v : v[0] + '...' + (v[0] === '[' ? ']' : ')');
  }
  return undefined;
}

const NOISY_VALUE = /getLogger\(|^logging\./;

function renderAssign(a: Assign, indent: string): string | undefined {
  const value = describeValue(a.value);
  if (!a.annotation && !value) {
    return undefined;
  }
  if (a.value && NOISY_VALUE.test(a.value)) {
    return undefined;
  }
  return `${indent}${a.name}${a.annotation ? `: ${a.annotation}` : ''}${value ? ` = ${value}` : ''}`;
}

// ---------------------------------------------------------------- walking the structure

const isPublic = (name: string): boolean => !name.startsWith('_');
const KEPT_DUNDERS = new Set(['__init__', '__call__']);
const KEPT_CLASS_DUNDER_ATTRS = new Set(['__tablename__', '__table_args__']);
const MAX_CLASS_LINES = 80;

function decoratorLines(decorators: string[], indent: string): string[] {
  return decorators.map((d) => `${indent}${clip(d, 140)}`);
}

function docAfter(lines: Line[], headerIdx: number): string | undefined {
  const next = lines[headerIdx + 1];
  if (next && next.indent > lines[headerIdx].indent) {
    return firstSentence(stringContent(next.text));
  }
  return undefined;
}

function blockEnd(lines: Line[], headerIdx: number): number {
  let j = headerIdx + 1;
  while (j < lines.length && lines[j].indent > lines[headerIdx].indent) {
    j++;
  }
  return j;
}

function classBody(lines: Line[], headerIdx: number, end: number): string[] {
  const out: string[] = [];
  const bodyIndent = lines[headerIdx + 1]?.indent ?? 0;
  if (bodyIndent <= lines[headerIdx].indent) {
    return out;
  }
  let decorators: string[] = [];
  for (let j = headerIdx + 1; j < end; j++) {
    const l = lines[j];
    if (l.indent !== bodyIndent) {
      continue;
    }
    if (l.text.startsWith('@')) {
      decorators.push(l.text);
      continue;
    }
    const decs = decorators;
    decorators = [];
    const def = parseDef(l.text);
    if (def) {
      const keep = isPublic(def.name) || KEPT_DUNDERS.has(def.name);
      const skip = decs.some((d) => /^@(\w+\.)*(setter|deleter)\b|^@(typing\.)?overload\b/.test(d));
      if (keep && !skip) {
        const doc = docAfter(lines, j);
        out.push(
          ...decoratorLines(decs, '    '),
          `    ${def.async ? 'async ' : ''}def ${def.name}(${renderParams(def.params, true)})${def.returns ? ` -> ${def.returns}` : ''}: ...${doc ? `  # ${doc}` : ''}`
        );
      }
      continue;
    }
    const cls = parseClass(l.text);
    if (cls) {
      if (isPublic(cls.name)) {
        out.push(...decoratorLines(decs, '    '), `    class ${cls.name}${cls.bases ? `(${cls.bases})` : ''}: ...`);
      }
      continue;
    }
    const a = parseAssign(l.text);
    if (a && (isPublic(a.name) || KEPT_CLASS_DUNDER_ATTRS.has(a.name))) {
      const line = renderAssign(a, '    ');
      if (line) {
        out.push(line);
      }
    }
  }
  if (out.length > MAX_CLASS_LINES) {
    const more = out.length - MAX_CLASS_LINES;
    out.length = MAX_CLASS_LINES;
    out.push(`    # ... ${more} more member line(s)`);
  }
  return out;
}

export function analyzePython(content: string, fileName = ''): SourceAnalysis {
  const lines = logicalLines(content);
  const isPackageInit = /(^|\/)__init__\.py$/.test(fileName);
  const skeleton: string[] = [];
  const exportNames = new Set<string>();
  const imports = new Set<string>();
  let declared: string[] | undefined;

  // Imports anywhere (function-local imports still describe the dependency graph).
  for (const l of lines) {
    if (l.text.startsWith('import ') || l.text.startsWith('from ')) {
      addImports(l.text, (s) => imports.add(s));
    }
  }

  const moduleDoc = lines[0] && lines[0].indent === 0 ? firstSentence(stringContent(lines[0].text)) : undefined;
  if (moduleDoc) {
    skeleton.push(`# module: ${moduleDoc}`);
  }

  let decorators: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.indent !== 0) {
      continue;
    }
    // A package's __init__.py usually just re-exports: keep those lines, they are its public surface.
    const reexport = isPackageInit ? /^from\s+\.[\w.]*\s+import\s+(.+)$/.exec(l.text) : null;
    if (reexport) {
      skeleton.push(clip(l.text, 200));
      splitTop(reexport[1].replace(/^\(/, '').replace(/\)$/, ''), ',')
        .map((p) => (p.split(/\s+as\s+/).pop() ?? '').trim())
        .filter((nm) => /^\w+$/.test(nm) && isPublic(nm))
        .forEach((nm) => exportNames.add(nm));
      continue;
    }
    if (l.text.startsWith('@')) {
      decorators.push(l.text);
      continue;
    }
    const decs = decorators;
    decorators = [];

    const def = parseDef(l.text);
    if (def) {
      if (isPublic(def.name)) {
        const doc = docAfter(lines, i);
        skeleton.push(
          ...decoratorLines(decs, ''),
          `${def.async ? 'async ' : ''}def ${def.name}(${renderParams(def.params, false)})${def.returns ? ` -> ${def.returns}` : ''}: ...${doc ? `  # ${doc}` : ''}`
        );
        exportNames.add(def.name);
      }
      continue;
    }
    const cls = parseClass(l.text);
    if (cls) {
      if (isPublic(cls.name)) {
        const doc = docAfter(lines, i);
        skeleton.push(
          ...decoratorLines(decs, ''),
          `class ${cls.name}${cls.bases ? `(${cls.bases})` : ''}:${doc ? `  # ${doc}` : ''}`,
          ...classBody(lines, i, blockEnd(lines, i))
        );
        exportNames.add(cls.name);
      }
      continue;
    }
    const a = parseAssign(l.text);
    if (!a) {
      continue;
    }
    if (a.name === '__all__' && a.value) {
      declared = [...a.value.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
      continue;
    }
    if (isPublic(a.name)) {
      const line = renderAssign(a, '');
      if (line) {
        skeleton.push(line);
        exportNames.add(a.name);
      }
    }
  }

  // Names listed in __all__ are public too (they may be re-exported from elsewhere).
  declared?.forEach((nm) => exportNames.add(nm));
  return { skeleton: skeleton.join('\n'), exportNames: [...exportNames], importSpecifiers: [...imports] };
}

// ---------------------------------------------------------------- import resolution

/** Common standard-library top-level names: never resolved to repository files by suffix matching. */
const STDLIB = new Set([
  'abc', 'argparse', 'array', 'ast', 'asyncio', 'base64', 'bisect', 'builtins', 'calendar', 'collections', 'concurrent',
  'configparser', 'contextlib', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal', 'difflib', 'email', 'enum',
  'errno', 'fnmatch', 'fractions', 'functools', 'gc', 'glob', 'gzip', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib',
  'inspect', 'io', 'ipaddress', 'itertools', 'json', 'logging', 'math', 'mimetypes', 'multiprocessing', 'numbers', 'operator',
  'os', 'pathlib', 'pickle', 'platform', 'pprint', 'queue', 'random', 're', 'secrets', 'select', 'shlex', 'shutil', 'signal',
  'smtplib', 'socket', 'sqlite3', 'ssl', 'statistics', 'string', 'struct', 'subprocess', 'sys', 'tempfile', 'textwrap',
  'threading', 'time', 'timeit', 'traceback', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'warnings',
  'weakref', 'xml', 'zipfile', 'zlib', 'zoneinfo', '__future__',
]);

const moduleIndexCache = new WeakMap<Set<string>, Map<string, string[]>>();

/** module path suffix ("a/b/c", "b/c", "c") -> files that define it, so any source root layout resolves. */
function moduleIndex(known: Set<string>): Map<string, string[]> {
  let idx = moduleIndexCache.get(known);
  if (idx) {
    return idx;
  }
  idx = new Map();
  for (const f of known) {
    if (!f.endsWith('.py')) {
      continue;
    }
    let mod = f.slice(0, -3);
    if (mod.endsWith('/__init__')) {
      mod = mod.slice(0, -9);
    } else if (mod === '__init__') {
      continue;
    }
    const parts = mod.split('/');
    for (let k = 0; k < parts.length; k++) {
      const key = parts.slice(k).join('/');
      const list = idx.get(key);
      if (list) {
        list.push(f);
      } else {
        idx.set(key, [f]);
      }
    }
  }
  moduleIndexCache.set(known, idx);
  return idx;
}

function commonDirDepth(a: string, b: string): number {
  const pa = a.split('/').slice(0, -1);
  const pb = b.split('/').slice(0, -1);
  let n = 0;
  while (n < pa.length && n < pb.length && pa[n] === pb[n]) {
    n++;
  }
  return n;
}

/**
 * Resolve a `py:` specifier to a known .py file (posix, root-relative).
 * Relative imports follow Python's package rules. Absolute imports match by module-path suffix, so
 * `src/`, `backend/app/` or flat layouts all work; with several matches the nearest to the importer wins.
 */
export function resolvePythonImport(fromRel: string, spec: string, known: Set<string>): string | undefined {
  const body = spec.slice(3);
  const rel = /^(\.+)(.*)$/.exec(body);
  let result: string | undefined;
  if (rel) {
    const up = rel[1].length - 1;
    const dir = fromRel.split('/').slice(0, -1);
    if (up > dir.length) {
      return undefined;
    }
    const baseParts = dir.slice(0, dir.length - up);
    const base = baseParts.join('/');
    const join = (p: string) => (base ? `${base}/${p}` : p);
    if (!rel[2]) {
      result = [join('__init__.py')].find((c) => known.has(c));
    } else {
      const path = join(rel[2].replace(/\./g, '/'));
      result = [`${path}.py`, `${path}/__init__.py`].find((c) => known.has(c));
    }
  } else {
    if (!body || STDLIB.has(body.split('.')[0])) {
      return undefined;
    }
    const cands = moduleIndex(known).get(body.replace(/\./g, '/'));
    if (cands?.length) {
      result = [...cands].sort((a, b) => commonDirDepth(fromRel, b) - commonDirDepth(fromRel, a) || a.localeCompare(b))[0];
    }
  }
  return result && result !== fromRel ? result : undefined;
}

import type { SourceAnalysis } from './analyzer';

/**
 * Light "skeletons" for the non-code files that tasks often touch: config, API schemas, templates and
 * styles. They are not parsed in depth; the goal is searchable names (keys, messages, handlers,
 * selectors, labels) at a size worth spending pack tokens on.
 */

export const DATA_EXT = ['yaml', 'yml', 'json', 'proto', 'graphql', 'gql', 'html', 'scss', 'pyi'] as const;
export type DataExt = (typeof DATA_EXT)[number];

/**
 * On by default. JSON is opt-in: in the benchmark it added about a thousand files per repository
 * (package manifests, configs, data) for few useful hits, and lowered the median saving.
 */
export const DEFAULT_DATA_EXT: DataExt[] = ['yaml', 'yml', 'proto', 'graphql', 'gql', 'html', 'scss', 'pyi'];

/** Config/markup files rank below code of equal text match, so they enter a pack only on a strong match. */
export const DATA_SCORE_FACTOR = 0.6;

/** Which non-code types are indexed. LIBRARIAN_TYPES (set by the extension setting or --types) overrides the default. */
export function enabledDataExt(): DataExt[] {
  const env = process.env.LIBRARIAN_TYPES;
  if (env !== undefined) {
    return env.split(',').map((e) => e.trim()).filter((e): e is DataExt => (DATA_EXT as readonly string[]).includes(e));
  }
  return [...DEFAULT_DATA_EXT];
}

/** Config/markup paths that are noise, not signal: lockfiles, translations, fixtures, snapshots, generated output. */
export function isNoisyDataPath(rel: string): boolean {
  if (/\.([mc]?[jt]sx?|pyi?)$/.test(rel)) {
    return false; // code files are never filtered here
  }
  return (
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|composer\.lock|yarn\.lock|pnpm-lock\.yaml|.*\.lock)$/.test(rel) ||
    /(^|\/)(locales?|i18n|translations?|fixtures?|__fixtures__|__snapshots__|snapshots|testdata|test_data|mocks?|__mocks__|generated)(\/|$)/i.test(rel) ||
    /\.(min|bundle|generated)\.[a-z]+$/.test(rel) ||
    /\.(spec|test)\.(json|ya?ml)$/.test(rel)
  );
}

const MAX_LINES = 60;
const clip = (s: string, n = 80): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

function result(lines: string[], names: string[], imports: string[] = []): SourceAnalysis {
  const shown = lines.slice(0, MAX_LINES);
  if (lines.length > MAX_LINES) {
    shown.push(`# … +${lines.length - MAX_LINES} more`);
  }
  return { skeleton: shown.join('\n'), exportNames: uniq(names.filter((n) => n.length > 2)).slice(0, 200), importSpecifiers: imports };
}

// ---------------------------------------------------------------- yaml / json

function analyzeYaml(content: string): SourceAnalysis {
  const lines: string[] = [];
  const names: string[] = [];
  let top = '';
  const children = new Map<string, string[]>();
  for (const raw of content.split('\n').slice(0, 4000)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) {
      continue;
    }
    const m = /^(\s*)(?:-\s+)?([A-Za-z_][\w./@-]*)\s*:(?:\s|$)/.exec(raw);
    if (!m) {
      continue;
    }
    const indent = m[1].length;
    if (indent === 0) {
      top = m[2];
      children.set(top, []);
      names.push(m[2]);
    } else if (indent <= 4 && top) {
      const kids = children.get(top)!;
      if (kids.length < 12 && !kids.includes(m[2])) {
        kids.push(m[2]);
        names.push(m[2]);
      }
    }
  }
  for (const [k, kids] of children) {
    lines.push(kids.length ? `${k}: { ${kids.join(', ')} }` : `${k}:`);
  }
  return result(lines, names);
}

function describeJson(v: unknown, depth: number): string {
  if (Array.isArray(v)) {
    return `[${v.length}]`;
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v as Record<string, unknown>);
    if (depth <= 0) {
      return `{${keys.length}}`;
    }
    return `{ ${keys.slice(0, 14).map((k) => k + (typeof (v as Record<string, unknown>)[k] === 'object' ? describeJson((v as Record<string, unknown>)[k], depth - 1) : '')).join(', ')}${keys.length > 14 ? ', …' : ''} }`;
  }
  return '';
}

function analyzeJson(content: string, fileName: string): SourceAnalysis {
  let data: unknown;
  try {
    data = JSON.parse(content.length > 400_000 ? '{}' : content);
  } catch {
    // JSON with comments (tsconfig) or too large: fall back to the keys seen at the start of lines
    const keys = uniq([...content.slice(0, 60_000).matchAll(/^\s{0,4}"([\w.@/-]+)"\s*:/gm)].map((m) => m[1])).slice(0, 40);
    return result(keys.map((k) => `"${k}"`), keys);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return result([Array.isArray(data) ? `[${(data as unknown[]).length} items]` : ''].filter(Boolean), []);
  }
  const obj = data as Record<string, unknown>;
  const lines: string[] = [];
  const names: string[] = [];
  const base = fileName.split('/').pop()!;
  if (base === 'package.json') {
    for (const k of ['name', 'version', 'description', 'main']) {
      typeof obj[k] === 'string' && lines.push(`${k}: ${clip(String(obj[k]), 100)}`);
    }
    for (const k of ['scripts', 'dependencies', 'devDependencies']) {
      const sub = obj[k];
      if (sub && typeof sub === 'object') {
        const keys = Object.keys(sub as object);
        lines.push(`${k}: { ${keys.slice(0, 25).join(', ')}${keys.length > 25 ? ', …' : ''} }`);
        names.push(...keys.slice(0, 25));
      }
    }
    return result(lines, names);
  }
  for (const [k, v] of Object.entries(obj).slice(0, 40)) {
    lines.push(`${k}${describeJson(v, 1)}`);
    names.push(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      names.push(...Object.keys(v as object).slice(0, 10));
    }
  }
  return result(lines, names);
}

// ---------------------------------------------------------------- proto / graphql

function analyzeProto(content: string): SourceAnalysis {
  const lines: string[] = [];
  const names: string[] = [];
  const imports = [...content.matchAll(/^\s*import\s+(?:public\s+)?"([^"]+)"/gm)].map((m) => `./${m[1]}`);
  const pkg = /^\s*package\s+([\w.]+)/m.exec(content)?.[1];
  pkg && lines.push(`package ${pkg}`);
  for (const m of content.matchAll(/^\s*(message|enum|service)\s+(\w+)/gm)) {
    lines.push(`${m[1]} ${m[2]}`);
    names.push(m[2]);
  }
  for (const m of content.matchAll(/\brpc\s+(\w+)\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(?:stream\s+)?([\w.]+)\s*\)/gm)) {
    lines.push(`  rpc ${m[1]}(${m[2]}) -> ${m[3]}`);
    names.push(m[1]);
  }
  return result(lines, names, imports);
}

function analyzeGraphql(content: string): SourceAnalysis {
  const lines: string[] = [];
  const names: string[] = [];
  const re = /^\s*(?:extend\s+)?(type|input|interface|enum|union|scalar|query|mutation|subscription|fragment)\s+(\w+)[^{=\n]*(?:\{([^}]*)\})?/gm;
  for (const m of content.matchAll(re)) {
    const fields = (m[3] ?? '')
      .split('\n')
      .map((l) => /^\s*(\w+)/.exec(l)?.[1])
      .filter((f): f is string => !!f)
      .slice(0, 12);
    lines.push(`${m[1]} ${m[2]}${fields.length ? ` { ${fields.join(', ')} }` : ''}`);
    names.push(m[2], ...fields);
  }
  return result(lines, names);
}

// ---------------------------------------------------------------- html / scss

function analyzeHtml(content: string): SourceAnalysis {
  const lines: string[] = [];
  const names: string[] = [];
  const text = content.slice(0, 200_000);
  const tags = uniq([...text.matchAll(/<([a-z][\w]*-[\w-]*)/gi)].map((m) => m[1]));
  tags.length && lines.push(`components: ${tags.slice(0, 20).join(', ')}`);
  names.push(...tags);
  const handlers = uniq([...text.matchAll(/\(([\w.]+)\)\s*=\s*"\s*([\w.$]+)\s*\(/g)].map((m) => m[2]));
  handlers.length && lines.push(`handlers: ${handlers.slice(0, 20).join(', ')}`);
  names.push(...handlers);
  const bindings = uniq([...text.matchAll(/\[\(?(?:ngModel|formControl|formGroup|ngClass|ngStyle|disabled|hidden|value|routerLink)?\)?\]?\s*=\s*"\s*([\w.$!?]+)/g)].map((m) => m[1].replace(/^[!?.]+/, '')));
  const ctrl = uniq([...text.matchAll(/(?:formControlName|formArrayName|formGroupName|name|id|data-test(?:id)?)\s*=\s*"([\w.-]+)"/g)].map((m) => m[1]));
  ctrl.length && lines.push(`ids/controls: ${ctrl.slice(0, 20).join(', ')}`);
  names.push(...ctrl);
  names.push(...bindings.slice(0, 20));
  const labels = uniq(
    [...text.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').matchAll(/>([^<>{}]{3,60})</g)]
      .map((m) => m[1].replace(/\s+/g, ' ').trim())
      .filter((s) => /[A-Za-z]{3}/.test(s))
  ).slice(0, 16);
  labels.length && lines.push(`text: ${labels.map((l) => `"${clip(l, 40)}"`).join(' · ')}`);
  names.push(...labels.flatMap((l) => l.split(/\s+/)).filter((w) => /^[A-Za-z]{4,}$/.test(w)).slice(0, 30));
  return result(lines, names);
}

function analyzeScss(content: string): SourceAnalysis {
  const lines: string[] = [];
  const names: string[] = [];
  const imports = [...content.matchAll(/@(?:use|import|forward)\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const classes = uniq([...content.matchAll(/\.([a-zA-Z_][\w-]{2,})\s*[{,:.\s>+~[]/g)].map((m) => m[1])).slice(0, 25);
  const vars = uniq([...content.matchAll(/^\s*(\$[\w-]+)\s*:/gm)].map((m) => m[1])).slice(0, 15);
  const mixins = uniq([...content.matchAll(/@(?:mixin|function)\s+([\w-]+)/g)].map((m) => m[1])).slice(0, 10);
  classes.length && lines.push(`classes: ${classes.map((c) => '.' + c).join(' ')}`);
  vars.length && lines.push(`variables: ${vars.join(' ')}`);
  mixins.length && lines.push(`mixins: ${mixins.join(' ')}`);
  names.push(...classes, ...vars.map((v) => v.slice(1)), ...mixins);
  // @use 'x' / @import 'x': relative partials
  return result(lines, names, imports.map((i) => (i.startsWith('.') ? i : `./${i}`)));
}

export function analyzeData(content: string, fileName: string): SourceAnalysis | undefined {
  const ext = fileName.split('.').pop()!.toLowerCase();
  switch (ext) {
    case 'yaml':
    case 'yml':
      return analyzeYaml(content);
    case 'json':
      return analyzeJson(content, fileName);
    case 'proto':
      return analyzeProto(content);
    case 'graphql':
    case 'gql':
      return analyzeGraphql(content);
    case 'html':
      return analyzeHtml(content);
    case 'scss':
      return analyzeScss(content);
    default:
      return undefined;
  }
}

export function dataFence(rel: string): string {
  const ext = rel.split('.').pop()!.toLowerCase();
  return ({ yaml: 'yaml', yml: 'yaml', json: 'json', proto: 'protobuf', graphql: 'graphql', gql: 'graphql', html: 'html', scss: 'scss' } as Record<string, string>)[ext] ?? 'text';
}

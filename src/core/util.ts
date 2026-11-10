import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/** Short, stable content hash used to detect changes between index runs. */
export function hashText(text: string): string {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * Cheap token estimate (~4 characters per token for code/English).
 * Good enough for budgeting and savings estimates; not billing-accurate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Convert an OS path relative to root into a forward-slash path. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export function relPosix(root: string, absPath: string): string {
  return toPosix(path.relative(root, absPath));
}

export function absFromRel(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'));
}

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/** Run async work over items with bounded parallelism. Stops scheduling when shouldStop() is true. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean = () => false
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && !shouldStop()) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'in', 'it', 'of', 'to', 'and', 'or', 'for', 'with', 'this', 'that',
  'are', 'was', 'be', 'as', 'on', 'at', 'by', 'from', 'which', 'not', 'but', 'what', 'how', 'do',
  'we', 'you', 'have', 'has', 'had', 'would', 'should', 'could', 'will', 'when', 'if', 'all',
  'its', 'into', 'then', 'than', 'so', 'also', 'just', 'more', 'can', 'need', 'make', 'want',
  'please', 'there', 'their', 'some', 'any', 'our', 'out', 'about', 'like', 'each', 'only',
  // code noise
  'get', 'set', 'new', 'use', 'type', 'class', 'export', 'import', 'return', 'function', 'const',
  'let', 'var', 'void', 'true', 'false', 'string', 'number', 'boolean', 'object', 'array',
  'promise', 'async', 'await', 'static', 'public', 'private', 'readonly', 'null', 'undefined',
  'interface', 'enum', 'default', 'file', 'files', 'code', 'src', 'index', 'skeleton', 'context',
]);

/** Lower-case word tokens, with camelCase / snake_case / kebab-case split apart and light stemming. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const w of words) {
    if (w.length < 3 || STOP_WORDS.has(w) || /^\d+$/.test(w)) {
      continue;
    }
    out.push(stem(w));
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ies')) {
    return w.slice(0, -3) + 'y';
  }
  if (w.length > 5 && (w.endsWith('ing') || w.endsWith('ers'))) {
    return w.slice(0, -3);
  }
  if (w.length > 4 && (w.endsWith('ed') || w.endsWith('es') || w.endsWith('er'))) {
    return w.slice(0, -2);
  }
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) {
    return w.slice(0, -1);
  }
  return w;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const x of a) {
    if (b.has(x)) {
      inter++;
    }
  }
  return inter / (a.size + b.size - inter);
}

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { resolveBase } from './analyzer';
import { toPosix } from './util';

/**
 * Resolves imports that are not relative paths but still point at files in the repository:
 *  - tsconfig / jsconfig `paths` and `baseUrl` ("@app/*", "src/*"),
 *  - workspace packages, by the `name` in their package.json ("@acme/core" -> packages/core/src).
 * Without this a monorepo's import graph is mostly missing, and graph expansion finds nothing.
 */
export interface AliasResolver {
  resolve(fromRel: string, spec: string, known: Set<string>): string | undefined;
  /** How many configs / packages were found (for diagnostics). */
  readonly sources: { configs: number; packages: number };
}

interface TsConfig {
  /** Directory of the config, posix, relative to the repo root ('' for the root). */
  dir: string;
  /** Directory that `paths` targets are relative to. */
  pathsBase: string;
  paths: [pattern: string, targets: string[]][];
  baseUrl?: string;
}

/** JSON with comments and trailing commas (tsconfig style). */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += text[++i] ?? '';
      } else if (c === '"') {
        inStr = false;
      }
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') {
        i++;
      }
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i++;
      }
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const joinPosix = (...parts: string[]): string => {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    part === '..' ? out.pop() : out.push(part);
  }
  return out.join('/');
};

function listConfigFiles(root: string): { configs: string[]; packages: string[] } {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', ':(glob)**/tsconfig*.json', ':(glob)**/jsconfig*.json', ':(glob)**/package.json'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
    )
      .split('\0')
      .filter(Boolean)
      .map(toPosix)
      .filter((f) => !f.split('/').includes('node_modules'));
    return { configs: out.filter((f) => /(^|\/)[tj]sconfig[^/]*\.json$/.test(f)), packages: out.filter((f) => f.endsWith('package.json')) };
  } catch {
    return { configs: [], packages: [] };
  }
}

function loadConfig(root: string, rel: string, seen = new Set<string>()): { paths?: TsConfig['paths']; pathsBase: string; baseUrl?: string } | undefined {
  if (seen.has(rel)) {
    return undefined;
  }
  seen.add(rel);
  let json: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
  try {
    json = parseJsonc(fs.readFileSync(path.join(root, rel), 'utf8')) as typeof json;
  } catch {
    return undefined;
  }
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  let inherited: ReturnType<typeof loadConfig>;
  const ext = Array.isArray(json.extends) ? json.extends[json.extends.length - 1] : json.extends;
  if (ext && ext.startsWith('.')) {
    const target = joinPosix(dir, ext.endsWith('.json') ? ext : ext + '.json');
    inherited = loadConfig(root, target, seen);
  }
  const co = json.compilerOptions ?? {};
  const baseUrl = co.baseUrl !== undefined ? joinPosix(dir, co.baseUrl) : inherited?.baseUrl;
  // `paths` are relative to baseUrl when there is one, else to the config that defines them.
  const own = co.paths ? { paths: Object.entries(co.paths), pathsBase: baseUrl ?? dir } : undefined;
  return { paths: own?.paths ?? inherited?.paths, pathsBase: own?.pathsBase ?? inherited?.pathsBase ?? dir, baseUrl };
}

export function buildAliasResolver(root: string): AliasResolver {
  const { configs, packages } = listConfigFiles(root);
  const cfgs: TsConfig[] = [];
  for (const rel of configs.filter((c) => /(^|\/)[tj]sconfig(\.base)?\.json$/.test(c))) {
    const c = loadConfig(root, rel);
    if (c && (c.paths?.length || c.baseUrl !== undefined)) {
      cfgs.push({ dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', pathsBase: c.pathsBase, paths: c.paths ?? [], baseUrl: c.baseUrl });
    }
  }
  cfgs.sort((a, b) => b.dir.length - a.dir.length);

  const pkgs = new Map<string, string>();
  for (const rel of packages) {
    try {
      const name = (JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')) as { name?: string }).name;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      if (name && dir && !pkgs.has(name)) {
        pkgs.set(name, dir);
      }
    } catch {
      // unreadable package.json
    }
  }

  const cache = new Map<string, string | undefined>();
  const resolve = (fromRel: string, spec: string, known: Set<string>): string | undefined => {
    if (spec.startsWith('.') || spec.startsWith('py:') || spec.startsWith('/')) {
      return undefined;
    }
    const fromDir = fromRel.includes('/') ? fromRel.slice(0, fromRel.lastIndexOf('/')) : '';
    const key = `${fromDir}\0${spec}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    let hit: string | undefined;
    for (const c of cfgs) {
      if (c.dir && fromDir !== c.dir && !fromDir.startsWith(c.dir + '/')) {
        continue;
      }
      for (const [pattern, targets] of c.paths) {
        const star = pattern.indexOf('*');
        let captured: string | undefined;
        if (star < 0) {
          captured = pattern === spec ? '' : undefined;
        } else if (spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1) {
          captured = spec.slice(star, spec.length - (pattern.length - star - 1));
        }
        if (captured === undefined) {
          continue;
        }
        for (const t of targets) {
          hit = resolveBase(joinPosix(c.pathsBase, t.replace('*', captured)), known);
          if (hit) {
            break;
          }
        }
        if (hit) {
          break;
        }
      }
      if (!hit && c.baseUrl !== undefined) {
        hit = resolveBase(joinPosix(c.baseUrl, spec), known);
      }
      if (hit) {
        break;
      }
    }
    if (!hit && pkgs.size) {
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const dir = pkgs.get(name);
      if (dir) {
        const sub = parts.slice(spec.startsWith('@') ? 2 : 1).join('/');
        const bases = sub ? [joinPosix(dir, 'src', sub), joinPosix(dir, sub)] : [joinPosix(dir, 'src'), dir];
        for (const b of bases) {
          hit = resolveBase(b, known);
          if (hit) {
            break;
          }
        }
      }
    }
    cache.set(key, hit);
    return hit;
  };
  return { resolve, sources: { configs: cfgs.length, packages: pkgs.size } };
}

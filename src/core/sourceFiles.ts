import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { toPosix } from './util';

/** Directory that holds every Librarian artefact, relative to the workspace root. */
export const INDEX_DIR = '.trishAI';

export const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

const IGNORED_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'bower_components',
  '__pycache__', 'target', 'tmp', 'temp',
]);

/** Single source of truth for "is this a file Librarian indexes?" — used by the tree, generators, CLI and CI. */
export function isSourcePath(rel: string): boolean {
  if (!SOURCE_EXT.test(rel) || /\.d\.[mc]?ts$/.test(rel) || /\.min\.js$/.test(rel)) {
    return false;
  }
  const parts = rel.split('/');
  for (const part of parts.slice(0, -1)) {
    if (part.startsWith('.') || IGNORED_DIRS.has(part)) {
      return false;
    }
  }
  return !parts[parts.length - 1].startsWith('.');
}

/**
 * Lists indexable source files (posix paths relative to root).
 * Uses `git ls-files` when available so .gitignore (including negations and nested files)
 * is honoured exactly; falls back to a directory walk otherwise.
 */
export function listSourceFiles(root: string): string[] {
  const fromGit = listViaGit(root);
  const files = fromGit ?? listViaWalk(root);
  return files.filter(isSourcePath).sort();
}

function listViaGit(root: string): string[] | null {
  try {
    const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out
      .split('\0')
      .filter(Boolean)
      .filter((rel) => fs.existsSync(path.join(root, rel)));
  } catch {
    return null;
  }
}

function listViaWalk(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) {
        continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile()) {
        out.push(toPosix(path.relative(root, full)));
      }
    }
  };
  walk(root);
  return out;
}

/** Files changed between `ref` and HEAD (plus deletions), via git. */
export function changedSince(root: string, ref: string): { changed: string[]; deleted: string[] } {
  const out = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', ref, 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const parts = out.split('\0').filter(Boolean);
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const status = parts[i];
    const file = parts[i + 1];
    if (status.startsWith('D')) {
      deleted.push(file);
    } else {
      changed.push(file);
    }
  }
  return { changed: changed.filter(isSourcePath), deleted: deleted.filter(isSourcePath) };
}

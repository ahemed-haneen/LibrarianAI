import { execFileSync } from 'child_process';
import { isSourcePath } from './sourceFiles';
import { tokenize } from './util';

/**
 * What the developer is doing right now, beyond the words of the task: the branch they are on,
 * the files they have open, the files they have already modified and the names appearing in their
 * uncommitted diff. All of it is read locally and only used to rank files.
 */
export interface WorkContext {
  branch?: string;
  openFiles?: string[];
  changedFiles?: string[];
  /** Words (already tokenised) from the added lines of the working-tree diff, most frequent first. */
  diffWords?: string[];
}

const BRANCH_PREFIX = /^(feature|feat|fix|bugfix|hotfix|chore|refactor|docs|test|release|users?|dev|[a-z0-9._-]+)\//i;

/** "feature/PYPAY-16119-delete-future-dated-deduction" -> "PYPAY 16119 delete future dated deduction". */
export function branchWords(branch: string): string {
  if (!branch || branch === 'HEAD' || /^(main|master|develop|trunk)$/.test(branch)) {
    return '';
  }
  let b = branch;
  while (BRANCH_PREFIX.test(b)) {
    b = b.replace(BRANCH_PREFIX, '');
  }
  return b.replace(/[-_./]+/g, ' ').trim();
}

export function gitWorkContext(root: string, opts: { maxChanged?: number; maxDiffBytes?: number; diffWords?: number } = {}): WorkContext {
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  const ctx: WorkContext = {};
  try {
    ctx.branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  } catch {
    return ctx; // not a git repository
  }
  try {
    ctx.changedFiles = git(['status', '--porcelain'])
      .split('\n')
      .map((l) => l.slice(3).replace(/^.* -> /, '').trim())
      .filter((f) => f && isSourcePath(f))
      .slice(0, opts.maxChanged ?? 40);
  } catch {
    // ignore
  }
  try {
    const diff = git(['diff', 'HEAD', '-U0', '--no-color']).slice(0, opts.maxDiffBytes ?? 200_000);
    const counts = new Map<string, number>();
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        for (const w of tokenize(line.slice(1))) {
          counts.set(w, (counts.get(w) ?? 0) + 1);
        }
      }
    }
    ctx.diffWords = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, opts.diffWords ?? 25)
      .map(([w]) => w);
  } catch {
    // ignore
  }
  return ctx;
}

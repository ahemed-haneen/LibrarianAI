import { execFileSync } from 'child_process';
import * as path from 'path';
import { INDEX_DIR, isSourcePath } from './sourceFiles';
import { LayerName } from './indexStore';
import { hashText, jaccard, readJson, tokenize, writeJson } from './util';

/**
 * One remembered task: what was asked, which files Librarian suggested, and which files were
 * actually changed afterwards. "touched" is the learning signal — next time a similar task
 * comes up, those files are boosted (or reused outright for near-identical tasks).
 */
export interface TaskRecord {
  id: string;
  task: string;
  tokens: string[];
  suggested: string[];
  touched: string[];
  /** 'local' = learnt from this developer's session, 'merge' = learnt from a merged PR in CI. */
  source: 'local' | 'merge';
  at: string;
  ref?: string;
}

interface MemoryFile {
  version: 1;
  tasks: TaskRecord[];
}

const LIMITS: Record<LayerName, number> = { local: 500, shared: 3000 };
const MAX_FILES_PER_TASK = 40;

export class TaskMemory {
  constructor(readonly root: string) {}

  private file(layer: LayerName): string {
    return path.join(this.root, INDEX_DIR, layer, 'memory.json');
  }

  private read(layer: LayerName): MemoryFile {
    return readJson<MemoryFile>(this.file(layer), { version: 1, tasks: [] });
  }

  private write(layer: LayerName, mem: MemoryFile): void {
    mem.tasks = mem.tasks.slice(-LIMITS[layer]);
    writeJson(this.file(layer), mem);
  }

  all(): TaskRecord[] {
    return [...this.read('shared').tasks, ...this.read('local').tasks];
  }

  /** Start remembering a task (from a tool call, @librarian, or the panel). Returns its id. */
  begin(task: string, suggested: string[]): string {
    const mem = this.read('local');
    const id = hashText(task + Date.now());
    mem.tasks.push({ id, task: task.slice(0, 1000), tokens: [...new Set(tokenize(task))], suggested, touched: [], source: 'local', at: new Date().toISOString() });
    this.write('local', mem);
    return id;
  }

  /** Record that a file was changed while the task was active. */
  touch(id: string, rel: string): void {
    const mem = this.read('local');
    const rec = mem.tasks.find((t) => t.id === id);
    if (rec && !rec.touched.includes(rel) && rec.touched.length < MAX_FILES_PER_TASK) {
      rec.touched.push(rel);
      this.write('local', mem);
    }
  }

  /** Add a task learnt from history (used by CI after a merge). De-duplicated by ref. */
  addMerged(layer: LayerName, rec: Omit<TaskRecord, 'id' | 'tokens' | 'source' | 'suggested'>): boolean {
    const mem = this.read(layer);
    if (rec.ref && mem.tasks.some((t) => t.ref === rec.ref)) {
      return false;
    }
    mem.tasks.push({ ...rec, id: hashText((rec.ref ?? '') + rec.task), tokens: [...new Set(tokenize(rec.task))], suggested: [], source: 'merge' });
    this.write(layer, mem);
    return true;
  }

  /** Past tasks most similar to this one. */
  similar(task: string, min = 0.15): { rec: TaskRecord; sim: number }[] {
    const q = new Set(tokenize(task));
    return this.all()
      .filter((t) => t.touched.length > 0)
      .map((rec) => ({ rec, sim: jaccard(q, new Set(rec.tokens)) }))
      .filter((x) => x.sim >= min)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 20);
  }

  /** Per-file boost derived from similar past tasks (recent, local experience weighs a bit more). */
  boosts(task: string): Map<string, { score: number; because: string }> {
    const out = new Map<string, { score: number; because: string }>();
    const now = Date.now();
    for (const { rec, sim } of this.similar(task)) {
      const ageDays = (now - Date.parse(rec.at)) / 86_400_000;
      const recency = 1 / (1 + ageDays / 90);
      const weight = sim * recency * (rec.source === 'local' ? 1.2 : 1) * 6;
      for (const f of rec.touched) {
        const cur = out.get(f);
        if (!cur) {
          // similar() is sorted best-first, so the first task seen is the best explanation.
          out.set(f, { score: weight, because: `changed in similar task “${rec.task.slice(0, 60)}”` });
        } else {
          cur.score += weight * 0.5;
        }
      }
    }
    return out;
  }
}

/**
 * Learn from git history: each first-parent commit (a squash-merge or merge of a PR on main)
 * becomes a task record "commit message -> files changed". Runs in CI after every merge.
 */
/** @param spec `a..b` range, a single commit, or a number N meaning "the last N first-parent commits". */
export function learnFromGit(root: string, spec: string, layer: LayerName = 'shared'): { added: number; skipped: number } {
  const memory = new TaskMemory(root);
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const revArgs = spec.includes('..') ? [spec] : /^\d+$/.test(spec) ? ['-n', spec, 'HEAD'] : ['-1', spec];
  const shas = git(['rev-list', '--first-parent', ...revArgs]).split('\n').filter(Boolean);
  let added = 0;
  let skipped = 0;
  for (const sha of shas.reverse()) {
    const msg = git(['show', '-s', '--format=%s%n%b', sha]).trim();
    if (/\[skip ci\]|\[librarian skip\]/i.test(msg)) {
      skipped++;
      continue;
    }
    let files: string[];
    try {
      files = git(['diff', '--name-only', `${sha}^1`, sha]).split('\n').filter(isSourcePath);
    } catch {
      files = git(['show', '--name-only', '--format=', sha]).split('\n').filter(isSourcePath);
    }
    if (files.length === 0 || files.length > MAX_FILES_PER_TASK) {
      skipped++;
      continue;
    }
    const task = msg
      .replace(/^Merge pull request #\d+ from \S+\s*/i, '')
      .replace(/^Merge branch .*$/im, '')
      .replace(/Co-authored-by:.*$/gim, '')
      .trim()
      .slice(0, 800);
    if (!task) {
      skipped++;
      continue;
    }
    const at = git(['show', '-s', '--format=%cI', sha]).trim();
    if (memory.addMerged(layer, { task, touched: files, at, ref: sha })) {
      added++;
    } else {
      skipped++;
    }
  }
  return { added, skipped };
}

import * as fs from 'fs';
import { IndexView, ResolvedEntry } from './indexStore';
import { stripFence } from './indexer';
import { TaskMemory, TaskRecord } from './taskMemory';
import { absFromRel, estimateTokens, hashText, tokenize } from './util';

export interface Candidate {
  path: string;
  score: number;
  reasons: string[];
  entry: ResolvedEntry;
  role: 'primary' | 'related';
}

interface DocStats {
  path: string;
  tf: Map<string, number>;
  len: number;
}

/** In-memory BM25 index over skeleton + context + path. Rebuilt only when a manifest changes. */
export class SearchIndex {
  private docs: DocStats[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private importers = new Map<string, string[]>();
  private key = '';

  constructor(private view: IndexView) {}

  private currentKey(): string {
    return Object.values(this.view.layers).map((l) => l.manifest().generatedAt + ':' + Object.keys(l.manifest().files).length).join('|');
  }

  ensure(): void {
    this.view.reload();
    const key = this.currentKey();
    if (key === this.key) {
      return;
    }
    this.key = key;
    this.docs = [];
    this.df.clear();
    this.importers.clear();
    let total = 0;
    for (const p of this.view.allPaths()) {
      const e = this.view.resolve(p);
      if (!e) {
        continue;
      }
      const pathText = p.replace(/\.[^.]+$/, '');
      const text = [
        pathText, pathText, pathText,
        e.record.exportNames.join(' '), e.record.exportNames.join(' '),
        stripFence(this.view.readSkeleton(e) ?? ''),
        this.view.readContext(e) ?? '',
      ].join('\n');
      const tf = new Map<string, number>();
      const toks = tokenize(text);
      toks.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + 1));
      tf.forEach((_, t) => this.df.set(t, (this.df.get(t) ?? 0) + 1));
      this.docs.push({ path: p, tf, len: toks.length });
      total += toks.length;
      for (const imp of e.record.imports) {
        const arr = this.importers.get(imp) ?? [];
        arr.push(p);
        this.importers.set(imp, arr);
      }
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
  }

  get size(): number {
    return this.docs.length;
  }

  bm25(query: string[]): Map<string, number> {
    const k1 = 1.4;
    const b = 0.75;
    const n = this.docs.length;
    const scores = new Map<string, number>();
    const q = [...new Set(query)];
    for (const d of this.docs) {
      let s = 0;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) {
          continue;
        }
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / this.avgLen));
      }
      if (s > 0) {
        scores.set(d.path, s);
      }
    }
    return scores;
  }

  importersOf(p: string): string[] {
    return this.importers.get(p) ?? [];
  }
}

export interface RetrieveOptions {
  maxFiles?: number;
  maxRelated?: number;
  /** Restrict which remembered tasks may influence ranking (used for leave-one-out evaluation). */
  memoryFilter?: (t: TaskRecord) => boolean;
}

export function retrieve(index: SearchIndex, view: IndexView, memory: TaskMemory, task: string, opts: RetrieveOptions = {}): Candidate[] {
  index.ensure();
  const maxFiles = opts.maxFiles ?? 8;
  const maxRelated = opts.maxRelated ?? 6;
  const qTokens = tokenize(task);
  const taskLower = task.toLowerCase();
  const scores = new Map<string, { score: number; reasons: string[] }>();
  const add = (p: string, s: number, reason: string) => {
    const cur = scores.get(p) ?? { score: 0, reasons: [] };
    cur.score += s;
    if (!cur.reasons.includes(reason)) {
      cur.reasons.push(reason);
    }
    scores.set(p, cur);
  };

  for (const [p, s] of index.bm25(qTokens)) {
    add(p, s, 'matches task wording');
  }

  const taskIdentifiers = new Set(task.match(/[A-Za-z_$][\w$]*/g) ?? []);
  for (const p of view.allPaths()) {
    const base = p.split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();
    if (base.length > 2 && base !== 'index' && (taskLower.includes(base) || taskLower.includes(p.toLowerCase()))) {
      add(p, 4, 'named in task');
    }
    for (const name of view.resolve(p)?.record.exportNames ?? []) {
      if (name.length > 3 && taskIdentifiers.has(name)) {
        add(p, 3, `exports ${name}`);
      }
    }
  }

  for (const [p, b] of memory.boosts(task, opts.memoryFilter)) {
    if (view.resolve(p)) {
      add(p, b.score, b.because);
    }
  }
  const best = memory.similar(task, 0.8, opts.memoryFilter)[0];
  if (best) {
    best.rec.touched.forEach((p) => view.resolve(p) && add(p, 10, 'reused from near-identical past task'));
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  const primary: Candidate[] = ranked.slice(0, maxFiles).map(([p, s]) => ({
    path: p, score: s.score, reasons: s.reasons, entry: view.resolve(p)!, role: 'primary',
  }));

  // Import-graph expansion around the strongest hits.
  const chosen = new Set(primary.map((c) => c.path));
  const related: Candidate[] = [];
  for (const seed of primary.slice(0, 3)) {
    const neighbours = [
      ...seed.entry.record.imports.map((p) => ({ p, why: `imported by ${seed.path}` })),
      ...index.importersOf(seed.path).map((p) => ({ p, why: `imports ${seed.path}` })),
    ];
    for (const { p, why } of neighbours) {
      if (chosen.has(p) || related.length >= maxRelated) {
        continue;
      }
      const e = view.resolve(p);
      if (e) {
        chosen.add(p);
        related.push({ path: p, score: seed.score * 0.3, reasons: [why], entry: e, role: 'related' });
      }
    }
  }
  return [...primary, ...related];
}

/** Check each candidate against the file on disk so the prompt can flag stale entries. */
export function markFreshness(root: string, view: IndexView, cands: Candidate[]): void {
  for (const c of cands) {
    try {
      const h = hashText(fs.readFileSync(absFromRel(root, c.path), 'utf8'));
      c.entry = view.resolve(c.path, h) ?? c.entry;
    } catch {
      c.entry = { ...c.entry, skeletonFresh: false, contextFresh: false };
    }
  }
}

export interface BuiltPrompt {
  prompt: string;
  files: Candidate[];
  deliveredTokens: number;
  fullFileTokens: number;
}

/**
 * Assemble a context pack within a token budget: highest-ranked files get summary + skeleton,
 * lower ones skeleton only, the rest are listed by path with the reason they matter.
 */
export function buildPrompt(view: IndexView, task: string, cands: Candidate[], totalIndexed: number, budget = 6000): BuiltPrompt {
  const head = [
    '# Librarian context pack',
    '',
    '## Task',
    task.trim(),
    '',
    `## How to use this`,
    `${totalIndexed} files are indexed in \`.trishAI/\`. The entries below were picked for this task. ` +
      'Work from these signatures and summaries first; open a full source file only when you need implementation details. ' +
      'Entries marked ⚠ stale may be out of date — verify against the source.',
    '',
  ].join('\n');

  const sections: string[] = [];
  const listed: string[] = [];
  let used = estimateTokens(head);
  let full = 0;

  for (const c of cands) {
    full += c.entry.record.sourceTokens;
    const skeleton = stripFence(view.readSkeleton(c.entry) ?? '');
    const ctx = view.readContext(c.entry)?.replace(/^# Context:.*\n(_.*_\n)?/, '').trim();
    const flag = c.entry.skeletonFresh ? '' : ' ⚠ stale';
    const why = c.reasons.slice(0, 2).join('; ');
    const title = `### \`${c.path}\`${flag}\n_${c.role === 'related' ? 'Related — ' : ''}${why}_\n`;
    const withCtx = `${title}\n${ctx ? ctx + '\n\n' : ''}\`\`\`typescript\n${skeleton || '// (no exports)'}\n\`\`\`\n`;
    const skelOnly = `${title}\n\`\`\`typescript\n${skeleton || '// (no exports)'}\n\`\`\`\n`;
    const options = c.role === 'primary' ? [withCtx, skelOnly] : [skelOnly];
    const fit = options.find((o) => used + estimateTokens(o) <= budget);
    if (fit) {
      sections.push(fit);
      used += estimateTokens(fit);
    } else {
      listed.push(`- \`${c.path}\` — ${why}`);
    }
  }

  const parts = [head];
  if (sections.length === 0 && listed.length === 0) {
    parts.push('## Files', '_No indexed file matched this task. Index more of the codebase, or describe the task using names from the code._');
  } else {
    parts.push('## Files', ...sections);
    if (listed.length) {
      parts.push('## Also relevant (not expanded — over budget)', ...listed, '');
    }
  }
  parts.push(
    '## Working rules',
    '- Pick the files to touch from the signatures above before opening anything.',
    '- For files not listed, check `.trishAI/shared/files/<path>.skeleton.md` (or `local/`) before reading source.',
    '- Make minimal, targeted edits.'
  );
  const prompt = parts.join('\n');
  return { prompt, files: cands, deliveredTokens: estimateTokens(prompt), fullFileTokens: full };
}

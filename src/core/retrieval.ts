import * as fs from 'fs';
import { DATA_SCORE_FACTOR } from './dataFiles';
import { IndexView, ResolvedEntry } from './indexStore';
import { NoteHit, NoteStore } from './notes';
import { stripFence } from './indexer';
import { fenceLang, noExports } from './sourceFiles';
import { TaskMemory, TaskRecord } from './taskMemory';
import { branchWords, WorkContext } from './workContext';
import { absFromRel, estimateTokens, hashText, tokenize } from './util';


export const isTestPath = (p: string): boolean =>
  /(^|\/)(tests?|__tests__|specs?|e2e|cypress)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)conftest\.py$/.test(p);

/** "foo.test.tsx", "test_foo.py", "foo_test.py", "foo.spec.ts" and "foo.ts" all share the key "foo". */
export const stemKey = (p: string): string =>
  p
    .split('/')
    .pop()!
    .replace(/\.[^.]+$/, '')
    .replace(/\.(test|spec)$/, '')
    .replace(/^test_/, '')
    .replace(/_test$/, '')
    .toLowerCase();

const DIR_NOISE = new Set(['src', 'tests', 'test', '__tests__', 'unit_tests', 'integration_tests', 'spec', 'specs', 'unit', 'e2e', 'lib', 'app']);
const dirSegments = (p: string): Set<string> => new Set(p.split('/').slice(0, -1).filter((d) => !DIR_NOISE.has(d)));

/** Corpus statistics are kept per file family so one family's vocabulary never skews another's word rarity. */
const groupOf = (p: string): string => {
  const ext = p.split('.').pop()!;
  return ext === 'py' || ext === 'pyi' ? 'py' : ext === 'html' ? 'html' : ext === 'scss' ? 'style' : ext === 'json' || ext === 'yaml' || ext === 'yml' ? 'cfg' : ext === 'proto' || ext === 'graphql' || ext === 'gql' ? 'idl' : 'js';
};

export interface Candidate {
  path: string;
  score: number;
  reasons: string[];
  entry: ResolvedEntry;
  role: 'primary' | 'related';
}

interface DocStats {
  path: string;
  group: string;
  tf: Map<string, number>;
  len: number;
}

/** In-memory BM25 index over skeleton + context + path. Rebuilt only when a manifest changes. */
export class SearchIndex {
  private docs: DocStats[] = [];
  private df = new Map<string, number>();
  private avgLen = 1;
  private stems = new Map<string, string[]>();
  private gdf = new Map<string, Map<string, number>>();
  private gn = new Map<string, number>();
  private gAvg = new Map<string, number>();
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
    this.stems.clear();
    this.gdf.clear();
    this.gn.clear();
    this.gAvg.clear();
    this.importers.clear();
    let total = 0;
    const gTotal = new Map<string, number>();
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
      const g = groupOf(p);
      const gm = this.gdf.get(g) ?? new Map<string, number>();
      tf.forEach((_, t) => gm.set(t, (gm.get(t) ?? 0) + 1));
      this.gdf.set(g, gm);
      this.gn.set(g, (this.gn.get(g) ?? 0) + 1);
      gTotal.set(g, (gTotal.get(g) ?? 0) + toks.length);
      const sk = stemKey(p);
      const sl = this.stems.get(sk) ?? [];
      sl.push(p);
      this.stems.set(sk, sl);
      this.docs.push({ path: p, group: g, tf, len: toks.length });
      total += toks.length;
      for (const imp of e.record.imports) {
        const arr = this.importers.get(imp) ?? [];
        arr.push(p);
        this.importers.set(imp, arr);
      }
    }
    this.avgLen = this.docs.length ? total / this.docs.length : 1;
    gTotal.forEach((t, g) => this.gAvg.set(g, t / (this.gn.get(g) ?? 1)));
  }

  get size(): number {
    return this.docs.length;
  }

  bm25(query: string[], weights?: Map<string, number>): Map<string, number> {
    const k1 = 1.4;
    const b = 0.75;
    const scores = new Map<string, number>();
    const q = [...new Set(query)];
    for (const d of this.docs) {
      let s = 0;
      // Statistics are kept per language so a big Python corpus cannot change how rare a TypeScript word looks (and vice versa).
      const dfMap = this.gdf.get(d.group)!;
      const nn = this.gn.get(d.group)!;
      const avg = this.gAvg.get(d.group)!;
      for (const t of q) {
        const f = d.tf.get(t);
        if (!f) {
          continue;
        }
        const df = dfMap.get(t) ?? 0;
        const idf = Math.log(1 + (nn - df + 0.5) / (df + 0.5));
        s += (weights?.get(t) ?? 1) * ((idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * d.len) / avg)));
      }
      if (s > 0) {
        scores.set(d.path, s);
      }
    }
    return scores;
  }

  /**
   * The test files for a source file, or the source files for a test file, matched by name and
   * then by how many directory names they share (so utils.ts pairs with its own utils.test.ts).
   */
  pairsOf(p: string, max = 2): string[] {
    const isTest = isTestPath(p);
    const mine = dirSegments(p);
    const cands = (this.stems.get(stemKey(p)) ?? []).filter((q) => q !== p && isTestPath(q) !== isTest && groupOf(q) === groupOf(p));
    const scored = cands.map((q) => ({ q, sim: [...dirSegments(q)].filter((d) => mine.has(d)).length }));
    // A name shared by many files (utils, index, types) must also share directories to count as a pair.
    const need = cands.length > 1 ? 1 : 0;
    return scored
      .filter((x) => x.sim >= need)
      .sort((a, b) => b.sim - a.sim || a.q.localeCompare(b.q))
      .slice(0, max)
      .map((x) => x.q);
  }

  /** Share of the given distinct words that appear in this file's indexed text. */
  coverage(p: string, words: string[]): number {
    const d = this.docs.find((x) => x.path === p);
    if (!d || !words.length) {
      return 0;
    }
    return words.filter((w) => d.tf.has(w)).length / words.length;
  }

  importersOf(p: string): string[] {
    return this.importers.get(p) ?? [];
  }
}

/**
 * How many files a pack can hold: strongest matches, neighbours of the top three, then paired tests.
 * Skeletons are capped by tier, so a long list costs little more than a short one.
 */
export const DEFAULT_MAX_FILES = 32;
/** Skeleton size caps (tokens): top three matches, the rest of the matches, and related/paired files. */
export const SKELETON_CAPS = { top: 300, rest: 100, related: 60 } as const;
export const DEFAULT_MAX_RELATED = 8;
/** Extra slots for the tests of source files in the pack, and the code under test for test files. */
export const DEFAULT_MAX_PAIRED = 8;
/** Second-stage rerank: how many candidates, and how strongly distinct-word coverage counts. */
export const RERANK_TOP = 50;
export const RERANK_WEIGHT = 2;
/** Working-context inputs: weight of words from the uncommitted diff, and boosts (share of the best text score) for modified and open files. */
export const DIFF_WORD_WEIGHT = 0.4;
export const WORK_CHANGED_BOOST = 0.25;
export const WORK_OPEN_BOOST = 0.12;

export interface RetrieveOptions {
  maxFiles?: number;
  maxRelated?: number;
  /** Restrict which remembered tasks may influence ranking (used for leave-one-out evaluation). */
  memoryFilter?: (t: TaskRecord) => boolean;
  /** Extra per-file boosts (e.g. files mentioned in saved notes). */
  extraBoosts?: Map<string, { score: number; because: string }>;
  /** What the developer is doing now: branch, open and modified files, uncommitted diff words. */
  work?: WorkContext;
  /** Receives the full ranking (every file with a positive score), for diagnostics. */
  onRanked?: (ranked: [string, { score: number; reasons: string[] }][]) => void;
}

export function retrieve(index: SearchIndex, view: IndexView, memory: TaskMemory, task: string, opts: RetrieveOptions = {}): Candidate[] {
  index.ensure();
  const maxRelated = opts.maxRelated ?? DEFAULT_MAX_RELATED;
  const work = opts.work;
  // The branch name often carries the ticket title in words (feature/PYPAY-123-delete-deduction).
  const qTokens = tokenize(task + ' ' + branchWords(work?.branch ?? ''));
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

  const diffWeights = new Map<string, number>();
  const diffWords = (work?.diffWords ?? []).filter((w) => !qTokens.includes(w));
  diffWords.forEach((w) => diffWeights.set(w, DIFF_WORD_WEIGHT));
  for (const [p, s] of index.bm25([...qTokens, ...diffWords], diffWeights)) {
    add(p, s, 'matches task wording');
  }
  if (work?.changedFiles?.length || work?.openFiles?.length) {
    // Files being edited right now are the strongest hint of where the task lives. The boost is
    // relative to the best text match so unrelated work in progress cannot take over the pack.
    const top = Math.max(0, ...[...scores.values()].map((v) => v.score));
    const base = top || 10;
    for (const p of work.changedFiles ?? []) {
      view.resolve(p) && add(p, base * WORK_CHANGED_BOOST, 'you have modified it');
    }
    for (const p of work.openFiles ?? []) {
      view.resolve(p) && add(p, base * WORK_OPEN_BOOST, 'open in your editor');
    }
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
  for (const [p, b] of opts.extraBoosts ?? []) {
    if (view.resolve(p)) {
      add(p, b.score, b.because);
    }
  }
  const best = memory.similar(task, 0.8, opts.memoryFilter)[0];
  if (best) {
    best.rec.touched.forEach((p) => view.resolve(p) && add(p, 10, 'reused from near-identical past task'));
  }

  for (const [p, v] of scores) {
    if (groupOf(p) !== 'js' && groupOf(p) !== 'py') {
      v.score *= DATA_SCORE_FACTOR;
    }
  }
  {
    // Second stage over the best candidates: reward files that match many different task words, not one word many times.
    const distinct = [...new Set(qTokens)];
    const top = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, RERANK_TOP);
    for (const [p, v] of top) {
      v.score *= 1 + RERANK_WEIGHT * index.coverage(p, distinct);
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
  opts.onRanked?.(ranked);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const picked = ranked.slice(0, maxFiles);
  const primary: Candidate[] = picked.map(([p, s]) => ({
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
  const paired: Candidate[] = [];
  {
    const limit = DEFAULT_MAX_PAIRED;
    for (const seed of primary) {
      for (const p of index.pairsOf(seed.path)) {
        if (chosen.has(p) || paired.length >= limit) {
          continue;
        }
        const e = view.resolve(p);
        if (e) {
          chosen.add(p);
          paired.push({ path: p, score: seed.score * 0.3, reasons: [isTestPath(p) ? `tests ${seed.path}` : `code under test in ${seed.path}`], entry: e, role: 'related' });
        }
      }
    }
  }
  return [...primary, ...related, ...paired];
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

/** Keep whole lines of a skeleton until the token cap, then say how much was left out. */
export function capSkeleton(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) {
    return text;
  }
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = estimateTokens(line) + 1;
    if (used + t > maxTokens && kept.length > 0) {
      break;
    }
    kept.push(line);
    used += t;
  }
  const left = lines.length - kept.length;
  return left > 0 ? `${kept.join('\n')}\n… (+${left} more lines in the skeleton file)` : text;
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
export function buildPrompt(view: IndexView, task: string, cands: Candidate[], totalIndexed: number, budget = 6000, notes: NoteHit[] = []): BuiltPrompt {
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

  // Saved context from earlier chats comes first: decisions and constraints matter more than signatures.
  const noteParts: string[] = [];
  const noteBudget = Math.floor(budget * 0.3);
  let noteUsed = 0;
  for (const h of notes) {
    const text = NoteStore.render(h.note, h.layer);
    const t = estimateTokens(text);
    if (noteUsed + t <= noteBudget) {
      noteParts.push(text);
      noteUsed += t;
    }
  }
  used += noteUsed;

  let rank = 0;
  for (const c of cands) {
    full += c.entry.record.sourceTokens;
    let skeleton = stripFence(view.readSkeleton(c.entry) ?? '');
    // Strongest matches get the most room; lower-ranked and related files get a short skeleton so more of them fit.
    skeleton = capSkeleton(skeleton, c.role === 'primary' ? (rank < 3 ? SKELETON_CAPS.top : SKELETON_CAPS.rest) : SKELETON_CAPS.related);
    rank++;
    const ctx = view.readContext(c.entry)?.replace(/^# Context:.*\n(_.*_\n)?/, '').trim();
    const flag = c.entry.skeletonFresh ? '' : ' ⚠ stale';
    const why = c.reasons.slice(0, 2).join('; ');
    const title = `### \`${c.path}\`${flag}\n_${c.role === 'related' ? 'Related — ' : ''}${why}_\n`;
    const withCtx = `${title}\n${ctx ? ctx + '\n\n' : ''}\`\`\`${fenceLang(c.path)}\n${skeleton || noExports(c.path)}\n\`\`\`\n`;
    const skelOnly = `${title}\n\`\`\`${fenceLang(c.path)}\n${skeleton || noExports(c.path)}\n\`\`\`\n`;
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
  if (noteParts.length) {
    parts.push('## Saved context from earlier chats', ...noteParts);
  }
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

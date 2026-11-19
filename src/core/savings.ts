import * as fs from 'fs';
import { Librarian } from './librarian';
import { DEFAULT_MAX_FILES, DEFAULT_MAX_RELATED } from './retrieval';
import { readGitTasks, SkippedCommit } from './taskMemory';
import { absFromRel, estimateTokens, tokenize } from './util';

/**
 * Token-savings estimate, replayed on this repository's own history.
 *
 * Ground truth: each past task (a merged commit message, or a Librarian session where you saved
 * files) and the source files that were actually changed for it.
 *
 * Without Librarian, an agent has to find those files. We model that as reading the changed files
 * plus their direct imports and importers (a conservative stand-in for grep-and-open exploration;
 * real agents often read more).
 *
 * With Librarian, the agent reads the context pack, then still opens the files it edits. For any
 * changed file the pack missed, it falls back to exploring that file's neighbours.
 *
 * Retrieval is run leave-one-out: a task never benefits from its own memory record.
 */
/** Why a file that really changed was not in the context pack. */
export type MissReason =
  | 'below-cutoff' // it matched the task, but ranked below the pack's size limit
  | 'graph-cut' // it is a neighbour of a top hit, but the neighbour limit was reached
  | 'empty-skeleton' // nothing to match on: no public names (private-only module, script, config)
  | 'vague-task' // the task text has too few searchable words
  | 'wording-mismatch'; // the task shares no words with this file's path, names or summary

/** The main reason a task did not save tokens. */
export type TaskCause = 'saved' | 'retrieval-misses' | 'pack-larger-than-exploration' | 'nothing-to-explore';

export type SkipReason = SkippedCommit['reason'] | 'files-not-in-index';

export interface MissedFile {
  path: string;
  reason: MissReason;
  /** 1-based rank for below-cutoff files. */
  rank?: number;
}

export interface SavingsCase {
  task: string;
  source: 'commit' | 'session';
  ref?: string;
  changed: string[];
  found: string[];
  /** Subset of `found` whose skeleton is actually shown in the pack (not just listed by path). */
  foundExpanded: string[];
  packTokens: number;
  without: number;
  withLibrarian: number;
  /** Tokens the baseline spends reading neighbours of the changed files (what Librarian can replace). */
  explorationTokens: number;
  /** Tokens spent exploring around files the pack missed. */
  fallbackTokens: number;
  /** Saving if the pack had contained every changed file. */
  ceilingSaved: number;
  cause: TaskCause;
  missed: MissedFile[];
  /** Files from the commit that could not be replayed. */
  dropped: { path: string; reason: 'deleted-or-renamed' | 'not-indexed' }[];
  /** More files changed than a pack can hold, so a full hit was impossible. */
  capacityLimited: boolean;
  /** The task text has fewer than three searchable words. */
  vague: boolean;
  /** Changed files by extension that Librarian does not index. */
  otherExts: Record<string, number>;
}

export interface SavingsDiagnostics {
  actualSavedPct: number;
  /** Saving if retrieval had been perfect (every changed file found). Separates "retrieval" from "structure". */
  ceilingSavedPct: number;
  causes: Record<TaskCause, { tasks: number; netTokens: number }>;
  totalMisses: number;
  missesByReason: Record<MissReason, number>;
  topMissed: { path: string; tasks: number; reason: MissReason }[];
  skipped: { reason: SkipReason; commits: number; examples: string[] }[];
  skippedExtensions: Record<string, number>;
  unindexedChangedExtensions: Record<string, number>;
  droppedFiles: { 'deleted-or-renamed': number; 'not-indexed': number };
  vagueTasks: number;
  capacityLimitedTasks: number;
  index: { files: number; withSummary: number; rememberedTasks: number };
  suggestions: string[];
}

export interface SavingsReport {
  cases: SavingsCase[];
  skipped: number;
  diagnostics: SavingsDiagnostics;
  tokenizer: string;
  totals: {
    without: number;
    withLibrarian: number;
    saved: number;
    savedPct: number;
    medianSavedPct: number;
    recall: number;
    fullHitRate: number;
  };
  markdown: string;
}

export interface SavingsOptions {
  /** Number of recent first-parent commits to replay (default 50). */
  commits?: number;
  /** Also replay this developer's recorded Librarian sessions (default true). */
  includeSessions?: boolean;
  budget?: number;
  /** Token counter; defaults to a ~4 chars/token estimate. Pass a model tokenizer for precision. */
  count?: (text: string) => Promise<number>;
  tokenizerLabel?: string;
  /** Optional input price, to show an indicative cost. */
  costPerMillionTokens?: number;
  /** Replay exactly these commits (oldest first), e.g. from a pin file, instead of "the last N". */
  refs?: string[];
  /**
   * Stricter leave-one-out: a task may only learn from remembered tasks that happened BEFORE it
   * (default is plain leave-one-out, which also lets it learn from later commits).
   */
  temporal?: boolean;
  /** Count a file as found only when its skeleton is shown in the pack, not when it is merely listed by path. */
  strict?: boolean;
  /** Override pack limits (used to compare settings in the benchmark). */
  maxFiles?: number;
  maxRelated?: number;
}

export async function estimateSavings(lib: Librarian, opts: SavingsOptions = {}): Promise<SavingsReport> {
  const count = opts.count ?? (async (t: string) => estimateTokens(t));
  const fileTokens = new Map<string, number>();
  const tokensOf = async (rel: string): Promise<number> => {
    if (!fileTokens.has(rel)) {
      let n = 0;
      try {
        n = await count(fs.readFileSync(absFromRel(lib.root, rel), 'utf8'));
      } catch {
        n = 0;
      }
      fileTokens.set(rel, n);
    }
    return fileTokens.get(rel)!;
  };
  const sum = async (files: Iterable<string>) => {
    let n = 0;
    for (const f of files) {
      n += await tokensOf(f);
    }
    return n;
  };

  const candidates: { task: string; files: string[]; source: 'commit' | 'session'; ref?: string; id?: string; at?: string; otherExts: Record<string, number> }[] = [];
  let skipped = 0;
  const skips: { reason: SkipReason; task: string; extensions?: Record<string, number> }[] = [];
  try {
    const pinned = opts.refs?.length ? new Set(opts.refs) : undefined;
    // A pin replays exactly its commits: read from the oldest one forward, then keep only the pinned ones.
    let git: ReturnType<typeof readGitTasks>;
    try {
      git = readGitTasks(lib.root, pinned ? `${opts.refs![0]}^..HEAD` : String(opts.commits ?? 50));
    } catch {
      // the oldest pinned commit is a root commit (no parent): read the whole history instead
      git = readGitTasks(lib.root, '1000000');
    }
    const keep = <T extends { ref: string }>(x: T) => !pinned || pinned.has(x.ref);
    const kept = git.tasks.filter(keep);
    skipped += pinned ? 0 : git.skipped;
    git.skips.filter(keep).forEach((k) => skips.push({ reason: k.reason, task: k.task, extensions: k.extensions }));
    kept.forEach((t) => candidates.push({ task: t.task, files: t.files, source: 'commit', ref: t.ref, at: t.at, otherExts: t.otherExts }));
  } catch {
    // not a git repository: sessions only
  }
  if (opts.includeSessions !== false) {
    lib.memory
      .all()
      .filter((t) => t.source === 'local' && t.touched.length)
      .forEach((t) => candidates.push({ task: t.task, files: t.touched, source: 'session', id: t.id, otherExts: {} }));
  }

  const droppedWithoutCase: SavingsCase['dropped'] = [];
  const cases: SavingsCase[] = [];
  for (const c of candidates) {
    const changed = c.files.filter((f) => lib.view.resolve(f) && fs.existsSync(absFromRel(lib.root, f)));
    const dropped = c.files
      .filter((f) => !changed.includes(f))
      .map((path) => ({ path, reason: fs.existsSync(absFromRel(lib.root, path)) ? ('not-indexed' as const) : ('deleted-or-renamed' as const) }));
    if (changed.length === 0) {
      skipped++;
      skips.push({ reason: 'files-not-in-index', task: c.task.split('\n')[0].slice(0, 120) });
      droppedWithoutCase.push(...dropped);
      continue;
    }
    // Baseline: changed files + their neighbours.
    const explored = new Set(changed);
    changed.forEach((f) => lib.neighbours(f).forEach((n) => explored.add(n)));
    const without = await sum(explored);
    const changedTokens = await sum(changed);

    let ranking: [string, { score: number; reasons: string[] }][] = [];
    const pack = lib.findRelevant(c.task, {
      budget: opts.budget,
      track: false,
      useNotes: false,
      maxFiles: opts.maxFiles,
      maxRelated: opts.maxRelated,
      memoryFilter: (t) =>
        (c.ref ? t.ref !== c.ref : t.id !== c.id) && t.task !== c.task && (!opts.temporal || !c.at || !t.at || t.at < c.at),
      onRanked: (r) => (ranking = r),
    });
    const inPack = new Set(pack.files.map((f) => f.path));
    const listed = changed.filter((f) => inPack.has(f));
    const foundExpanded = listed.filter((f) => pack.prompt.includes('### `' + f + '`'));
    const found = opts.strict ? foundExpanded : listed;
    const missedPaths = changed.filter((f) => !found.includes(f));

    // With Librarian: pack + edit reads + fallback exploration for misses.
    const counted = new Set(changed);
    const fallback = new Set<string>();
    missedPaths.forEach((f) => lib.neighbours(f).forEach((n) => !counted.has(n) && fallback.add(n)));
    const packTokens = await count(pack.prompt);
    const fallbackTokens = await sum(fallback);
    const withLibrarian = packTokens + changedTokens + fallbackTokens;

    // Diagnosis: why was each missed file missed, and why did (or didn't) the task save tokens?
    const vague = isVague(c.task);
    const rankOf = new Map(ranking.map(([p], i) => [p, i]));
    const seedNeighbours = new Set(ranking.slice(0, 3).flatMap(([p]) => lib.neighbours(p)));
    const missed: MissedFile[] = missedPaths.map((path) => {
      const rank = rankOf.get(path);
      if (rank !== undefined) {
        return { path, reason: 'below-cutoff', rank: rank + 1 };
      }
      if (seedNeighbours.has(path)) {
        return { path, reason: 'graph-cut' };
      }
      const rec = lib.view.resolve(path)?.record;
      if (rec && rec.exportNames.length === 0 && rec.skeletonTokens < 5) {
        return { path, reason: 'empty-skeleton' };
      }
      return { path, reason: vague ? 'vague-task' : 'wording-mismatch' };
    });
    const explorationTokens = without - changedTokens;
    const ceilingSaved = explorationTokens - packTokens;
    const saved = without - withLibrarian;
    const cause: TaskCause =
      saved > 0 ? 'saved' : explorationTokens === 0 ? 'nothing-to-explore' : ceilingSaved <= 0 ? 'pack-larger-than-exploration' : 'retrieval-misses';

    cases.push({
      task: c.task, source: c.source, ref: c.ref, changed, found, foundExpanded, packTokens, without, withLibrarian,
      explorationTokens, fallbackTokens, ceilingSaved, cause, missed, dropped, vague,
      capacityLimited: changed.length > (DEFAULT_MAX_FILES + DEFAULT_MAX_RELATED),
      otherExts: c.otherExts,
    });
  }

  const totWithout = cases.reduce((a, c) => a + c.without, 0);
  const totWith = cases.reduce((a, c) => a + c.withLibrarian, 0);
  const pcts = cases.map((c) => (c.without ? (c.without - c.withLibrarian) / c.without : 0)).sort((a, b) => a - b);
  const changedTotal = cases.reduce((a, c) => a + c.changed.length, 0);
  const foundTotal = cases.reduce((a, c) => a + c.found.length, 0);
  const totals = {
    without: totWithout,
    withLibrarian: totWith,
    saved: totWithout - totWith,
    savedPct: totWithout ? ((totWithout - totWith) / totWithout) * 100 : 0,
    medianSavedPct: pcts.length ? pcts[Math.floor(pcts.length / 2)] * 100 : 0,
    recall: changedTotal ? (foundTotal / changedTotal) * 100 : 0,
    fullHitRate: cases.length ? (cases.filter((c) => c.found.length === c.changed.length).length / cases.length) * 100 : 0,
  };
  const tokenizer = opts.tokenizerLabel ?? '~4 characters per token (estimate)';
  const diagnostics = buildDiagnostics(lib, cases, skips, droppedWithoutCase, totals);
  return { cases, skipped, diagnostics, tokenizer, totals, markdown: renderMarkdown(lib, cases, skipped, totals, diagnostics, tokenizer, opts.costPerMillionTokens) };
}

// ---------------------------------------------------------------- diagnostics

/** A commit message that is mostly a ticket id ("PYPAY-16186 fix timeout") gives retrieval little to match. */
function isVague(task: string): boolean {
  return tokenize(task.replace(/\b[A-Za-z][A-Za-z0-9]*-\d+\b/g, ' ')).length < 3;
}

function addCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) {
    into[k] = (into[k] ?? 0) + v;
  }
}

function topEntries(rec: Record<string, number>, n: number): [string, number][] {
  return Object.entries(rec).sort((a, b) => b[1] - a[1]).slice(0, n);
}

const fmtExts = (rec: Record<string, number>, n = 5): string =>
  topEntries(rec, n).map(([e, c]) => `\`${e}\` ×${c}`).join(', ');

function buildDiagnostics(
  lib: Librarian,
  cases: SavingsCase[],
  skips: { reason: SkipReason; task: string; extensions?: Record<string, number> }[],
  droppedWithoutCase: SavingsCase['dropped'],
  totals: SavingsReport['totals']
): SavingsDiagnostics {
  const causes: SavingsDiagnostics['causes'] = {
    saved: { tasks: 0, netTokens: 0 },
    'retrieval-misses': { tasks: 0, netTokens: 0 },
    'pack-larger-than-exploration': { tasks: 0, netTokens: 0 },
    'nothing-to-explore': { tasks: 0, netTokens: 0 },
  };
  const missesByReason: Record<MissReason, number> = { 'below-cutoff': 0, 'graph-cut': 0, 'empty-skeleton': 0, 'vague-task': 0, 'wording-mismatch': 0 };
  const perFile = new Map<string, { tasks: number; reasons: Map<MissReason, number> }>();
  const droppedFiles = { 'deleted-or-renamed': 0, 'not-indexed': 0 };
  const unindexedChangedExtensions: Record<string, number> = {};
  let ceilingSaved = 0;
  let packSum = 0;
  let explorationOfPackLosers = 0;
  let packLosers = 0;
  const belowRanks: number[] = [];

  for (const c of cases) {
    causes[c.cause].tasks++;
    causes[c.cause].netTokens += c.without - c.withLibrarian;
    ceilingSaved += c.ceilingSaved;
    packSum += c.packTokens;
    addCounts(unindexedChangedExtensions, c.otherExts);
    c.dropped.forEach((d) => droppedFiles[d.reason]++);
    if (c.cause === 'pack-larger-than-exploration') {
      packLosers++;
      explorationOfPackLosers += c.explorationTokens;
    }
    for (const m of c.missed) {
      missesByReason[m.reason]++;
      if (m.rank) {
        belowRanks.push(m.rank);
      }
      const e = perFile.get(m.path) ?? { tasks: 0, reasons: new Map() };
      e.tasks++;
      e.reasons.set(m.reason, (e.reasons.get(m.reason) ?? 0) + 1);
      perFile.set(m.path, e);
    }
  }
  droppedWithoutCase.forEach((d) => droppedFiles[d.reason]++);

  const topMissed = [...perFile.entries()]
    .map(([path, e]) => ({ path, tasks: e.tasks, reason: [...e.reasons.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
    .sort((a, b) => b.tasks - a.tasks || a.path.localeCompare(b.path))
    .slice(0, 10);

  const byReason = new Map<SkipReason, { commits: number; examples: string[] }>();
  const skippedExtensions: Record<string, number> = {};
  for (const k of skips) {
    const e = byReason.get(k.reason) ?? { commits: 0, examples: [] };
    e.commits++;
    if (e.examples.length < 3) {
      e.examples.push(k.task);
    }
    byReason.set(k.reason, e);
    if (k.extensions) {
      addCounts(skippedExtensions, k.extensions);
    }
  }
  const skipped = [...byReason.entries()].map(([reason, e]) => ({ reason, ...e })).sort((a, b) => b.commits - a.commits);

  const st = lib.status();
  const diag: SavingsDiagnostics = {
    actualSavedPct: totals.savedPct,
    ceilingSavedPct: totals.without ? (ceilingSaved / totals.without) * 100 : 0,
    causes,
    totalMisses: Object.values(missesByReason).reduce((a, b) => a + b, 0),
    missesByReason,
    topMissed,
    skipped,
    skippedExtensions,
    unindexedChangedExtensions,
    droppedFiles,
    vagueTasks: cases.filter((c) => c.vague).length,
    capacityLimitedTasks: cases.filter((c) => c.capacityLimited).length,
    index: { files: st.total, withSummary: st.withContext, rememberedTasks: lib.memory.all().length },
    suggestions: [],
  };
  diag.suggestions = suggestions(diag, cases, { belowRanks, packSum, packLosers, explorationOfPackLosers });
  return diag;
}

function suggestions(
  d: SavingsDiagnostics,
  cases: SavingsCase[],
  x: { belowRanks: number[]; packSum: number; packLosers: number; explorationOfPackLosers: number }
): string[] {
  const out: string[] = [];
  const n = cases.length;
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
  const skipCount = (r: SkipReason) => d.skipped.find((k) => k.reason === r)?.commits ?? 0;

  const noSource = skipCount('no-source-files');
  if (noSource && Object.keys(d.skippedExtensions).length) {
    out.push(`${noSource} commit(s) were left out because they changed no file type Librarian indexes (mostly ${fmtExts(d.skippedExtensions)}). Supporting those types would bring these tasks into the replay.`);
  }
  const otherTotal = Object.values(d.unindexedChangedExtensions).reduce((a, b) => a + b, 0);
  const changedTotal = cases.reduce((a, c) => a + c.changed.length, 0);
  if (otherTotal && pct(otherTotal, otherTotal + changedTotal) >= 10) {
    out.push(`${otherTotal} changed file(s) in the replayed commits (${pct(otherTotal, otherTotal + changedTotal)}% of all files they touched) are types Librarian does not index (${fmtExts(d.unindexedChangedExtensions)}), so a pack can never contain them. Recall is understated by that share.`);
  }
  if (skipCount('too-many-files')) {
    out.push(`${skipCount('too-many-files')} commit(s) changed more than 40 source files (bulk renames, formatting, imports) and are left out on purpose: they would distort the result.`);
  }
  const notIndexed = d.droppedFiles['not-indexed'];
  const gone = d.droppedFiles['deleted-or-renamed'];
  if (skipCount('files-not-in-index') || notIndexed || gone) {
    out.push(`${gone + notIndexed} changed file(s) could not be replayed: ${gone} no longer exist (deleted or renamed since the commit; the replay measures files as they are today) and ${notIndexed} exist but are not in the index (run **Build Skeletons Only**, or check they are not git-ignored).`);
  }

  const m = d.totalMisses;
  if (m > 0) {
    const r = d.missesByReason;
    if (pct(r['below-cutoff'], m) >= 20) {
      const near = x.belowRanks.filter((k) => k <= 2 * DEFAULT_MAX_FILES).length;
      out.push(`${pct(r['below-cutoff'], m)}% of misses matched the task but ranked below the pack's ${DEFAULT_MAX_FILES}-file limit (${near} of ${r['below-cutoff']} within the next ${DEFAULT_MAX_FILES} places). A larger pack would catch them, at a token cost. The limit is DEFAULT_MAX_FILES in retrieval.ts.`);
    }
    if (pct(r['graph-cut'], m) >= 15) {
      out.push(`${pct(r['graph-cut'], m)}% of misses are direct neighbours of a top hit, cut by the ${DEFAULT_MAX_RELATED}-neighbour limit (DEFAULT_MAX_RELATED in retrieval.ts).`);
    }
    if (pct(r['empty-skeleton'], m) >= 10) {
      out.push(`${r['empty-skeleton']} missed file(s) have no public names (private-only modules, scripts, config), so only their path can match. AI summaries describe them.`);
    }
    if (pct(r['wording-mismatch'], m) >= 20 && d.index.withSummary < d.index.files * 0.5) {
      out.push(`${pct(r['wording-mismatch'], m)}% of misses share no words with the file's path or names, and only ${d.index.withSummary} of ${d.index.files} files have an AI summary. Summaries add the "use when" wording developers type: run **Index Workspace**.`);
    } else if (pct(r['wording-mismatch'], m) >= 20) {
      out.push(`${pct(r['wording-mismatch'], m)}% of misses share no words with the file's path, names or summary. Learning from more commits links such tasks to their files.`);
    }
  }
  if (d.vagueTasks && pct(d.vagueTasks, n) >= 30) {
    out.push(`${pct(d.vagueTasks, n)}% of replayed commit messages have fewer than three searchable words (mostly ticket ids). A developer's real prompt is usually richer, so real-world recall should be better than this replay.`);
  }
  if (d.index.rememberedTasks === 0) {
    out.push('No past tasks are remembered yet. Run **Learn from Recent Commits**: similar past tasks boost the files they changed.');
  }
  if (d.capacityLimitedTasks) {
    out.push(`${d.capacityLimitedTasks} task(s) changed more than ${DEFAULT_MAX_FILES + DEFAULT_MAX_RELATED} files, more than a pack can hold, so a full hit was impossible. Broad changes like these will always need extra exploration.`);
  }
  const packLoss = d.causes['pack-larger-than-exploration'];
  if (packLoss.tasks) {
    out.push(`${packLoss.tasks} task(s) cost more with Librarian even with perfect recall: the pack (avg ${Math.round(cases.filter((c) => c.cause === 'pack-larger-than-exploration').reduce((a, c) => a + c.packTokens, 0) / packLoss.tasks).toLocaleString('en-US')} tokens) was larger than the exploration it replaced (avg ${Math.round(x.explorationOfPackLosers / Math.max(1, x.packLosers)).toLocaleString('en-US')}). Small tasks don't benefit; a smaller pack for short or single-file tasks would reduce this loss.`);
  }
  const none = d.causes['nothing-to-explore'];
  if (none.tasks) {
    out.push(`${none.tasks} task(s) had nothing to explore: the changed files have no imports or importers in the index, so the baseline reads nothing extra. If your code uses path aliases or imports the resolver cannot map, the import graph is missing edges.`);
  }
  return out.slice(0, 10);
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function renderMarkdown(
  lib: Librarian,
  cases: SavingsCase[],
  skipped: number,
  t: SavingsReport['totals'],
  diag: SavingsDiagnostics,
  tokenizer: string,
  price?: number
): string {
  const n = cases.length;
  const lines: string[] = ['# Librarian: estimated token savings', ''];
  if (n === 0) {
    lines.push(
      '_No replayable tasks yet._ The estimate needs git history (commits that changed indexed source files) ' +
        'or recorded Librarian sessions. Index the workspace and try again after a few commits.'
    );
    if (diag.skipped.length) {
      lines.push('', '## Why nothing could be replayed', ...skippedMarkdown(diag), '', ...diag.suggestions.map((x, i) => `${i + 1}. ${x}`));
    }
    return lines.join('\n');
  }
  const perTask = (x: number) => fmt(x / n);
  lines.push(
    `Replayed **${n} past task(s)** from this repository (${cases.filter((c) => c.source === 'commit').length} merged commits, ` +
      `${cases.filter((c) => c.source === 'session').length} of your sessions; ${skipped} skipped). Tokenizer: ${tokenizer}.`,
    '',
    '| | Without Librarian | With Librarian | Saved |',
    '|---|---:|---:|---:|',
    `| Context tokens per task (avg) | ${perTask(t.without)} | ${perTask(t.withLibrarian)} | **${perTask(t.saved)} (${t.savedPct.toFixed(0)}%)** |`,
    `| Total over replayed tasks | ${fmt(t.without)} | ${fmt(t.withLibrarian)} | ${fmt(t.saved)} |`,
    '',
    `- **Median saving per task:** ${t.medianSavedPct.toFixed(0)}%`,
    `- **Recall:** ${t.recall.toFixed(0)}% of files that were actually changed appeared in Librarian's pack`,
    `- **Full hits:** ${t.fullHitRate.toFixed(0)}% of tasks had *every* changed file in the pack`,
  );
  if (price && price > 0) {
    lines.push(`- **Indicative input cost saved:** $${((t.saved / n / 1e6) * price).toFixed(4)} per task, $${((t.saved / n / 1e6) * price * 1000).toFixed(2)} per 1,000 tasks at $${price}/1M tokens`);
  }

  const s = lib.view.layers.local.stats();
  if (s.promptsBuilt) {
    lines.push(
      '',
      '## Your actual usage so far',
      `- Context packs built: ${fmt(s.promptsBuilt)}`,
      `- Tokens sent: ${fmt(s.estTokensDelivered)}, vs ${fmt(s.estTokensIfFullFiles)} if the same files had been read in full`,
      `- AI summaries generated: ${fmt(s.contextCallsMade)}, reused from cache: ${fmt(s.contextCallsSkipped)}`
    );
  }

  lines.push('', '## Per task (largest first)', '', '| Task | Changed | Found | Without | With | Saved | Why |', '|---|---:|---:|---:|---:|---:|---|');
  for (const c of [...cases].sort((a, b) => b.without - a.without).slice(0, 25)) {
    const saved = c.without - c.withLibrarian;
    const pct = c.without ? (saved / c.without) * 100 : 0;
    const task = c.task.split('\n')[0].replace(/\|/g, '\\|').slice(0, 70);
    lines.push(`| ${task} | ${c.changed.length} | ${c.found.length} | ${fmt(c.without)} | ${fmt(c.withLibrarian)} | ${fmt(saved)} (${pct.toFixed(0)}%) | ${whyLabel(c)} |`);
  }

  lines.push(...diagnosticsMarkdown(cases, diag));

  lines.push(
    '',
    '## How this is calculated',
    '- **Without Librarian:** the agent reads every file that was changed **plus their direct imports and importers** to find its way. ' +
      'Real agents often open more than this, so the baseline is on the low side.',
    '- **With Librarian:** the context pack, plus a full read of every changed file (edits still need the source), plus neighbour exploration for any changed file the pack missed.',
    '- **Perfect-retrieval ceiling:** what the saving would have been if the pack had held every changed file. It separates what better file-picking can win from what the method itself cannot (the pack always costs tokens).',
    '- **Replay uses commit messages as the task.** They are usually less descriptive than what a developer types into the agent, so recall here is a cautious estimate.',
    '- **Leave-one-out:** a task never benefits from its own memory record. Memory from *other* tasks is used, as it would be in real use.',
    '- Files are measured as they are today, not as they were at the time of each commit.',
    '- **Not included:** fewer back-and-forth turns, which on request-metered Copilot plans is often the bigger saving; ' +
      'tokens of the agent\'s own reasoning and output; and system prompts, which are the same either way.',
    '- Small repositories show small or negative savings: when the codebase is tiny, reading it is cheap. The benefit grows with size.'
  );
  return lines.join('\n');
}

function whyLabel(c: SavingsCase): string {
  switch (c.cause) {
    case 'saved':
      return c.missed.length ? `saved (${c.missed.length} file(s) missed)` : 'saved';
    case 'nothing-to-explore':
      return 'no import links: nothing to replace';
    case 'pack-larger-than-exploration':
      return 'small task: pack costs more than the exploration it replaces';
    default: {
      const top = [...c.missed.reduce((m, f) => m.set(f.reason, (m.get(f.reason) ?? 0) + 1), new Map<MissReason, number>())].sort((a, b) => b[1] - a[1])[0];
      return `missed ${c.missed.length} file(s)${top ? `: ${MISS_LABEL[top[0]].toLowerCase()}` : ''}`;
    }
  }
}

const MISS_LABEL: Record<MissReason, string> = {
  'below-cutoff': 'Ranked just below the pack limit',
  'graph-cut': 'Neighbour of a top hit, over the neighbour limit',
  'empty-skeleton': 'No public names to match on',
  'vague-task': 'Task text has too few searchable words',
  'wording-mismatch': 'Task shares no words with the file',
};

const MISS_HELP: Record<MissReason, string> = {
  'below-cutoff': 'Larger pack or more files per pack',
  'graph-cut': 'More neighbours around the top hits',
  'empty-skeleton': 'AI summaries (only the path is searchable)',
  'vague-task': 'More descriptive task wording; learning from commits',
  'wording-mismatch': 'AI summaries ("use when" wording); learning from commits',
};

const SKIP_LABEL: Record<SkipReason, string> = {
  'ci-skip': 'Marked [skip ci] / [librarian skip]',
  'no-source-files': 'Changed no file type Librarian indexes',
  'too-many-files': 'Changed more than 40 source files',
  'empty-message': 'Empty commit message',
  'files-not-in-index': 'Changed files are not in the index (deleted, renamed or unindexed)',
};

const CAUSE_LABEL: Record<TaskCause, string> = {
  saved: 'Saved tokens',
  'retrieval-misses': 'Pack missed files, so extra exploration was needed',
  'pack-larger-than-exploration': 'Pack cost more than the exploration it replaced',
  'nothing-to-explore': 'Nothing to explore (no import links around the changed files)',
};

function diagnosticsMarkdown(cases: SavingsCase[], d: SavingsDiagnostics): string[] {
  const lines: string[] = ['', '## Why savings were limited', ''];
  const fmtSigned = (n: number) => (n > 0 ? '+' : '') + fmt(n);
  const gap = d.ceilingSavedPct - d.actualSavedPct;
  lines.push(
    `**With perfect retrieval the saving would be ${d.ceilingSavedPct.toFixed(0)}%; the actual saving was ${d.actualSavedPct.toFixed(0)}%.** ` +
      (gap > 1
        ? `About ${gap.toFixed(0)} points of that gap are files the pack missed (fixable by better retrieval); the rest comes from how the method works: the pack itself costs tokens, and tasks with little to explore cannot save.`
        : 'Retrieval is not the limit here: the pack itself costs tokens, and tasks with little to explore cannot save.'),
    '',
    '| What happened | Tasks | Net tokens |',
    '|---|---:|---:|'
  );
  for (const k of Object.keys(CAUSE_LABEL) as TaskCause[]) {
    if (d.causes[k].tasks) {
      lines.push(`| ${CAUSE_LABEL[k]} | ${d.causes[k].tasks} | ${fmtSigned(d.causes[k].netTokens)} |`);
    }
  }

  if (d.totalMisses) {
    const changedTotal = cases.reduce((a, c) => a + c.changed.length, 0);
    lines.push('', `### Files the pack missed (${d.totalMisses} of ${changedTotal} changed files)`, '', '| Why | Files | Share | What would help |', '|---|---:|---:|---|');
    for (const k of Object.keys(MISS_LABEL) as MissReason[]) {
      if (d.missesByReason[k]) {
        lines.push(`| ${MISS_LABEL[k]} | ${d.missesByReason[k]} | ${Math.round((d.missesByReason[k] / d.totalMisses) * 100)}% | ${MISS_HELP[k]} |`);
      }
    }
    if (d.topMissed.length) {
      lines.push('', '### Files missed most often', '', '| File | Tasks | Main reason |', '|---|---:|---|');
      d.topMissed.forEach((f) => lines.push(`| \`${f.path}\` | ${f.tasks} | ${MISS_LABEL[f.reason]} |`));
    }
  }

  lines.push(...skippedMarkdown(d));

  if (d.suggestions.length) {
    lines.push('', '### What to do about it', '', ...d.suggestions.map((x, i) => `${i + 1}. ${x}`));
  }

  // Machine-readable copy: paste it into a chat or issue to get the matching improvement made.
  const { suggestions: _omit, ...rest } = d;
  const tasks = cases.map((c) =>
    JSON.stringify({
      task: c.task.split('\n')[0].slice(0, 80),
      changed: c.changed.length,
      found: c.found.length,
      saved: c.without - c.withLibrarian,
      exploration: c.explorationTokens,
      pack: c.packTokens,
      cause: c.cause,
      missed: c.missed.slice(0, 8),
    })
  );
  lines.push(
    '',
    '### Diagnostics (copy this to get Librarian improved)',
    '',
    '```json',
    `{"diagnostics":${JSON.stringify(rest)},`,
    '"tasks":[',
    tasks.join(',\n'),
    ']}',
    '```'
  );
  return lines;
}

function skippedMarkdown(d: SavingsDiagnostics): string[] {
  const lines: string[] = [];
  if (d.skipped.length) {
    lines.push('', '### Commits left out of the replay', '', '| Reason | Commits | Examples |', '|---|---:|---|');
    d.skipped.forEach((k) => lines.push(`| ${SKIP_LABEL[k.reason]} | ${k.commits} | ${k.examples.map((e) => e.replace(/\|/g, '\\|').slice(0, 50)).join('; ')} |`));
    if (Object.keys(d.skippedExtensions).length) {
      lines.push('', `File types in commits that changed nothing Librarian indexes: ${fmtExts(d.skippedExtensions, 8)}.`);
    }
  }
  if (Object.keys(d.unindexedChangedExtensions).length) {
    lines.push('', `File types changed alongside indexed files but not indexed by Librarian: ${fmtExts(d.unindexedChangedExtensions, 8)}.`);
  }
  return lines;
}

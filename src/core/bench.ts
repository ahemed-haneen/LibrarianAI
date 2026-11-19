import { execFileSync } from 'child_process';
import { SavingsCase, SavingsReport } from './savings';

/**
 * A comparable record of one replay run. Everything in it is deterministic for a given repository
 * state, pin file and options (no timestamps), so two runs can be diffed with `librarian bench-compare`.
 */
export interface BenchMetrics {
  tasks: number;
  totalWithout: number;
  totalWith: number;
  totalSaved: number;
  /** Aggregate saving: total saved / total without. This is the "avg saved" figure in the report headline. */
  avgSavedPct: number;
  avgSavedTokens: number;
  medianSavedPct: number;
  recall: number;
  /** Recall counting only files whose skeleton is shown in the pack (not just listed by path). */
  recallExpanded: number;
  fullHits: number;
  /** Tasks where the pack cost more than the exploration it could replace, even with perfect recall. */
  packLosers: number;
  ceilingPct: number;
  avgPackTokens: number;
  /** Average per task once the three biggest-saving tasks are removed (the "is it broad?" check). */
  avgSavedTokensExclTop3: number;
  avgSavedPctExclTop3: number;
  /** Tasks that changed at most two files: the ones a pack is most likely to hurt. */
  small: { tasks: number; medianSavedPct: number; avgSavedTokens: number; negative: number };
  misses: Record<string, number>;
}

export interface BenchTask {
  ref: string;
  task: string;
  changed: number;
  found: number;
  packTokens: number;
  without: number;
  withLibrarian: number;
  saved: number;
  savedPct: number;
  cause: string;
  foundFiles: string[];
  missedFiles: { path: string; reason: string; rank?: number }[];
}

export interface BenchRun {
  label: string;
  head: string;
  options: Record<string, unknown>;
  index: SavingsReport['diagnostics']['index'];
  metrics: BenchMetrics;
  tasks: BenchTask[];
}

const pct = (c: SavingsCase): number => (c.without ? ((c.without - c.withLibrarian) / c.without) * 100 : 0);
const median = (xs: number[]): number => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

export function benchMetrics(r: SavingsReport): BenchMetrics {
  const cases = r.cases;
  const saved = cases.map((c) => c.without - c.withLibrarian);
  const top3 = new Set([...cases.keys()].sort((a, b) => saved[b] - saved[a]).slice(0, 3));
  const rest = [...cases.keys()].filter((i) => !top3.has(i));
  const restSaved = rest.reduce((a, i) => a + saved[i], 0);
  const restWithout = rest.reduce((a, i) => a + cases[i].without, 0);
  const small = cases.filter((c) => c.changed.length <= 2);
  const n = cases.length || 1;
  return {
    tasks: cases.length,
    totalWithout: r.totals.without,
    totalWith: r.totals.withLibrarian,
    totalSaved: r.totals.saved,
    avgSavedPct: r.totals.savedPct,
    avgSavedTokens: Math.round(r.totals.saved / n),
    medianSavedPct: r.totals.medianSavedPct,
    recall: r.totals.recall,
    recallExpanded: cases.reduce((a, c) => a + c.changed.length, 0) ? (cases.reduce((a, c) => a + c.foundExpanded.length, 0) / cases.reduce((a, c) => a + c.changed.length, 0)) * 100 : 0,
    fullHits: r.totals.fullHitRate,
    packLosers: cases.filter((c) => c.cause === 'pack-larger-than-exploration').length,
    ceilingPct: r.diagnostics.ceilingSavedPct,
    avgPackTokens: Math.round(cases.reduce((a, c) => a + c.packTokens, 0) / n),
    avgSavedTokensExclTop3: rest.length ? Math.round(restSaved / rest.length) : 0,
    avgSavedPctExclTop3: restWithout ? (restSaved / restWithout) * 100 : 0,
    small: {
      tasks: small.length,
      medianSavedPct: median(small.map(pct)),
      avgSavedTokens: small.length ? Math.round(small.reduce((a, c) => a + c.without - c.withLibrarian, 0) / small.length) : 0,
      negative: small.filter((c) => c.withLibrarian > c.without).length,
    },
    misses: { ...r.diagnostics.missesByReason },
  };
}

export function benchRun(r: SavingsReport, label: string, root: string, options: Record<string, unknown>): BenchRun {
  let head = '';
  try {
    head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    // not a git repo
  }
  return {
    label,
    head,
    options,
    index: r.diagnostics.index,
    metrics: benchMetrics(r),
    tasks: r.cases.map((c) => ({
      ref: c.ref ?? c.task.slice(0, 40),
      task: c.task.split('\n')[0].slice(0, 90),
      changed: c.changed.length,
      found: c.found.length,
      packTokens: c.packTokens,
      without: c.without,
      withLibrarian: c.withLibrarian,
      saved: c.without - c.withLibrarian,
      savedPct: Math.round(pct(c) * 10) / 10,
      cause: c.cause,
      foundFiles: c.found,
      missedFiles: c.missed.map((m) => ({ path: m.path, reason: m.reason, rank: m.rank })),
    })),
  };
}

const REASON_LABEL: Record<string, string> = {
  'below-cutoff': 'ranked below the pack limit',
  'graph-cut': 'import-graph neighbour limit',
  'empty-skeleton': 'no public names (path only)',
  'wording-mismatch': 'task shares no words with the file',
  'vague-task': 'task text too vague',
};

/**
 * Of the files the reference run missed, how many does this run find, grouped by WHY the reference missed them.
 * This is how to read the effect of a change on one kind of miss (e.g. AI summaries on "wording mismatch"
 * and "no public names") instead of on the overall average.
 */
export function recoveredByReason(base: BenchRun, run: BenchRun): string {
  const cur = new Map(run.tasks.map((t) => [t.ref, new Set(t.foundFiles)]));
  const tally = new Map<string, { missed: number; recovered: number }>();
  let lost = 0;
  let foundBefore = 0;
  for (const t of base.tasks) {
    const now = cur.get(t.ref);
    if (!now) {
      continue;
    }
    for (const m of t.missedFiles) {
      const e = tally.get(m.reason) ?? { missed: 0, recovered: 0 };
      e.missed++;
      if (now.has(m.path)) {
        e.recovered++;
      }
      tally.set(m.reason, e);
    }
    for (const f of t.foundFiles) {
      foundBefore++;
      if (!now.has(f)) {
        lost++;
      }
    }
  }
  const rows = [...tally.entries()].sort((a, b) => b[1].missed - a[1].missed);
  const lines = [
    `### Misses recovered by ${run.label}, by why ${base.label} missed them`,
    '',
    `| Why ${base.label} missed the file | Missed | Found by ${run.label} | Recovered |`,
    '|---|---:|---:|---:|',
    ...rows.map(([r, e]) => `| ${REASON_LABEL[r] ?? r} | ${e.missed} | ${e.recovered} | ${e.missed ? ((e.recovered / e.missed) * 100).toFixed(0) : 0}% |`),
    '',
    `Files ${base.label} found that ${run.label} no longer finds: ${lost} of ${foundBefore}.`,
  ];
  return lines.join('\n');
}

const f1 = (n?: number) => (n === undefined || Number.isNaN(n) ? '–' : n.toFixed(1));
const sign = (n: number, d = 1) => (n > 0 ? '+' : '') + n.toFixed(d);

/** Side-by-side table of runs (first run = reference), plus which tasks got worse against it. */
export function compareRuns(runs: BenchRun[]): string {
  const rows: [string, (m: BenchMetrics) => string][] = [
    ['Tasks replayed', (m) => String(m.tasks)],
    ['Saved, all tasks (%)', (m) => f1(m.avgSavedPct)],
    ['Saved per task (tokens)', (m) => m.avgSavedTokens.toLocaleString()],
    ['Median saving per task (%)', (m) => f1(m.medianSavedPct)],
    ['Saved per task excl. top 3 (%)', (m) => f1(m.avgSavedPctExclTop3)],
    ['Saved per task excl. top 3 (tokens)', (m) => m.avgSavedTokensExclTop3.toLocaleString()],
    ['Recall (changed files in pack, %)', (m) => f1(m.recall)],
    ['Recall, skeleton shown (%)', (m) => f1(m.recallExpanded)],
    ['Full hits (%)', (m) => f1(m.fullHits)],
    ['Tasks losing to pack cost', (m) => String(m.packLosers)],
    ['Small tasks (≤2 files): median (%)', (m) => f1(m.small.medianSavedPct)],
    ['Small tasks: negative / total', (m) => `${m.small.negative}/${m.small.tasks}`],
    ['Perfect-retrieval ceiling (%)', (m) => f1(m.ceilingPct)],
    ['Avg pack (tokens)', (m) => (m.avgPackTokens ?? 0).toLocaleString()],
    ['Misses: below pack limit', (m) => String(m.misses['below-cutoff'] ?? 0)],
    ['Misses: wording mismatch / vague', (m) => `${m.misses['wording-mismatch'] ?? 0} / ${m.misses['vague-task'] ?? 0}`],
    ['Misses: no public names', (m) => String(m.misses['empty-skeleton'] ?? 0)],
  ];
  const out: string[] = [];
  out.push(`| Metric | ${runs.map((r) => r.label).join(' | ')} |`);
  out.push(`|---|${runs.map(() => '---:').join('|')}|`);
  for (const [name, fn] of rows) {
    out.push(`| ${name} | ${runs.map((r) => fn(r.metrics)).join(' | ')} |`);
  }
  const base = runs[0];
  const byRef = new Map(base.tasks.map((t) => [t.ref, t]));
  for (const run of runs.slice(1)) {
    out.push('', recoveredByReason(base, run));
    const worse = run.tasks
      .map((t) => ({ t, b: byRef.get(t.ref) }))
      .filter((x): x is { t: BenchTask; b: BenchTask } => !!x.b && x.t.saved < x.b.saved - Math.max(500, 0.02 * x.b.without))
      .sort((a, b) => a.t.saved - a.b.saved - (b.t.saved - b.b.saved));
    const better = run.tasks.filter((t) => {
      const b = byRef.get(t.ref);
      return b && t.saved > b.saved + Math.max(500, 0.02 * b.without);
    }).length;
    out.push('', `### ${run.label} vs ${base.label}: ${better} tasks better, ${worse.length} worse`);
    if (worse.length) {
      out.push('', '| Task | Files found | Saved (tokens) | Δ tokens |', '|---|---:|---:|---:|');
      for (const { t, b } of worse.slice(0, 15)) {
        out.push(`| ${t.task.slice(0, 60)} | ${b.found}→${t.found} of ${t.changed} | ${b.saved.toLocaleString()}→${t.saved.toLocaleString()} | ${sign(t.saved - b.saved, 0)} |`);
      }
    }
  }
  return out.join('\n');
}

import * as fs from 'fs';
import { Librarian } from './librarian';
import { readGitTasks } from './taskMemory';
import { absFromRel, estimateTokens } from './util';

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
export interface SavingsCase {
  task: string;
  source: 'commit' | 'session';
  ref?: string;
  changed: string[];
  found: string[];
  packTokens: number;
  without: number;
  withLibrarian: number;
}

export interface SavingsReport {
  cases: SavingsCase[];
  skipped: number;
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

  const candidates: { task: string; files: string[]; source: 'commit' | 'session'; ref?: string; id?: string }[] = [];
  let skipped = 0;
  try {
    const git = readGitTasks(lib.root, String(opts.commits ?? 50));
    skipped += git.skipped;
    git.tasks.forEach((t) => candidates.push({ task: t.task, files: t.files, source: 'commit', ref: t.ref }));
  } catch {
    // not a git repository: sessions only
  }
  if (opts.includeSessions !== false) {
    lib.memory
      .all()
      .filter((t) => t.source === 'local' && t.touched.length)
      .forEach((t) => candidates.push({ task: t.task, files: t.touched, source: 'session', id: t.id }));
  }

  const cases: SavingsCase[] = [];
  for (const c of candidates) {
    const changed = c.files.filter((f) => lib.view.resolve(f) && fs.existsSync(absFromRel(lib.root, f)));
    if (changed.length === 0) {
      skipped++;
      continue;
    }
    // Baseline: changed files + their neighbours.
    const explored = new Set(changed);
    changed.forEach((f) => lib.neighbours(f).forEach((n) => explored.add(n)));
    const without = await sum(explored);

    const pack = lib.findRelevant(c.task, {
      budget: opts.budget,
      track: false,
      useNotes: false,
      memoryFilter: (t) => (c.ref ? t.ref !== c.ref : t.id !== c.id) && t.task !== c.task,
    });
    const inPack = new Set(pack.files.map((f) => f.path));
    const found = changed.filter((f) => inPack.has(f));
    const missed = changed.filter((f) => !inPack.has(f));

    // With Librarian: pack + edit reads + fallback exploration for misses.
    const counted = new Set(changed);
    const fallback = new Set<string>();
    missed.forEach((f) => lib.neighbours(f).forEach((n) => !counted.has(n) && fallback.add(n)));
    const packTokens = await count(pack.prompt);
    const withLibrarian = packTokens + (await sum(changed)) + (await sum(fallback));

    cases.push({ task: c.task, source: c.source, ref: c.ref, changed, found, packTokens, without, withLibrarian });
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
  return { cases, skipped, tokenizer, totals, markdown: renderMarkdown(lib, cases, skipped, totals, tokenizer, opts.costPerMillionTokens) };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function renderMarkdown(
  lib: Librarian,
  cases: SavingsCase[],
  skipped: number,
  t: SavingsReport['totals'],
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

  lines.push('', '## Per task (largest first)', '', '| Task | Changed | Found | Without | With | Saved |', '|---|---:|---:|---:|---:|---:|');
  for (const c of [...cases].sort((a, b) => b.without - a.without).slice(0, 25)) {
    const saved = c.without - c.withLibrarian;
    const pct = c.without ? (saved / c.without) * 100 : 0;
    const task = c.task.split('\n')[0].replace(/\|/g, '\\|').slice(0, 70);
    lines.push(`| ${task} | ${c.changed.length} | ${c.found.length} | ${fmt(c.without)} | ${fmt(c.withLibrarian)} | ${fmt(saved)} (${pct.toFixed(0)}%) |`);
  }

  lines.push(
    '',
    '## How this is calculated',
    '- **Without Librarian:** the agent reads every file that was changed **plus their direct imports and importers** to find its way. ' +
      'Real agents often open more than this, so the baseline is on the low side.',
    '- **With Librarian:** the context pack, plus a full read of every changed file (edits still need the source), plus neighbour exploration for any changed file the pack missed.',
    '- **Leave-one-out:** a task never benefits from its own memory record. Memory from *other* tasks is used, as it would be in real use.',
    '- Files are measured as they are today, not as they were at the time of each commit.',
    '- **Not included:** fewer back-and-forth turns, which on request-metered Copilot plans is often the bigger saving; ' +
      'tokens of the agent\'s own reasoning and output; and system prompts, which are the same either way.',
    '- Small repositories show small or negative savings: when the codebase is tiny, reading it is cheap. The benefit grows with size.'
  );
  return lines.join('\n');
}

import * as fs from 'fs';
import { analyzeSource, resolveImport } from './analyzer';
import { ContextPolicy, FileRecord, IndexView, LayerName } from './indexStore';
import { contextPrompt, LlmClient } from './llm';
import { listSourceFiles } from './sourceFiles';
import { absFromRel, estimateTokens, hashText, mapLimit } from './util';

export interface IndexOptions {
  root: string;
  /** Layer to write into: 'shared' in CI, 'local' on developer machines. */
  layer: LayerName;
  /** Restrict to these root-relative files (default: every source file). */
  files?: string[];
  /** Files known to be deleted (removed from the target layer). */
  deleted?: string[];
  /** Omit to build skeletons + graph only (zero AI cost). */
  llm?: LlmClient;
  policy?: ContextPolicy;
  /** Regenerate even when hashes say nothing changed. */
  force?: boolean;
  concurrency?: number;
  /** Files larger than this get a skeleton but no AI summary. */
  maxContextBytes?: number;
  onProgress?: (done: number, total: number, file: string) => void;
  isCancelled?: () => boolean;
  signal?: AbortSignal;
}

export interface IndexResult {
  scanned: number;
  skeletonsWritten: number;
  skeletonsUnchanged: number;
  contextsGenerated: number;
  contextsReused: number;
  contextsSkippedTooLarge: number;
  removed: number;
  errors: { path: string; message: string }[];
  cancelled: boolean;
}

export function skeletonMarkdown(rel: string, skeleton: string, sourceHash: string): string {
  // Deliberately no timestamp: identical input -> identical file, so CI commits only real changes.
  return `# Skeleton: \`${rel}\`\n<!-- source-hash: ${sourceHash} -->\n\n\`\`\`typescript\n${skeleton || '// (no exports)'}\n\`\`\`\n`;
}

export function contextMarkdown(rel: string, body: string, model: string): string {
  return `# Context: \`${rel}\`\n_Summarised by ${model}_\n\n${body.trim()}\n`;
}

export async function runIndex(opts: IndexOptions): Promise<IndexResult> {
  const policy = opts.policy ?? 'onApiChange';
  const view = new IndexView(opts.root, policy);
  const target = view.layers[opts.layer];
  const allFiles = listSourceFiles(opts.root);
  const known = new Set(allFiles);
  const files = (opts.files ?? allFiles).filter((f) => known.has(f));
  const maxBytes = opts.maxContextBytes ?? 100 * 1024;
  const cancelled = () => !!opts.isCancelled?.() || !!opts.signal?.aborted;

  const result: IndexResult = {
    scanned: 0, skeletonsWritten: 0, skeletonsUnchanged: 0, contextsGenerated: 0,
    contextsReused: 0, contextsSkippedTooLarge: 0, removed: 0, errors: [], cancelled: false,
  };

  // Deletions / pruning (only prune on full scans so partial runs never drop records).
  const toRemove = new Set(opts.deleted ?? []);
  if (!opts.files) {
    Object.keys(target.manifest().files).forEach((p) => !known.has(p) && toRemove.add(p));
  }
  for (const p of toRemove) {
    if (target.get(p)) {
      target.remove(p);
      result.removed++;
    }
  }

  // Phase 1 — skeletons + imports (free, synchronous, fast).
  const needContext: { rel: string; source: string; rec: FileRecord }[] = [];
  for (const rel of files) {
    if (cancelled()) {
      break;
    }
    try {
      const source = fs.readFileSync(absFromRel(opts.root, rel), 'utf8');
      const sourceHash = hashText(source);
      const resolved = view.resolve(rel, sourceHash);
      let rec: FileRecord;

      if (!opts.force && resolved?.skeletonFresh) {
        result.skeletonsUnchanged++;
        rec = resolved.record;
        // A stale copy in our layer is shadowed by a fresh one elsewhere — drop it.
        const own = target.get(rel);
        if (resolved.layer !== opts.layer && own && own.sourceHash !== sourceHash) {
          target.remove(rel);
        }
      } else {
        const a = analyzeSource(rel, source);
        const skeletonHash = hashText(a.skeleton);
        const prev = target.get(rel);
        rec = {
          path: rel,
          sourceHash,
          skeletonHash,
          skeletonAt: new Date().toISOString(),
          exportNames: a.exportNames,
          imports: [...new Set(a.importSpecifiers.map((s) => resolveImport(rel, s, known)).filter((x): x is string => !!x))],
          sourceTokens: estimateTokens(source),
          skeletonTokens: estimateTokens(a.skeleton),
          context: prev?.context,
        };
        target.writeSkeleton(rel, skeletonMarkdown(rel, a.skeleton, sourceHash));
        target.put(rec);
        result.skeletonsWritten++;
      }
      result.scanned++;

      const ctxFresh = !opts.force && view.resolve(rel, sourceHash)?.contextFresh;
      if (ctxFresh) {
        result.contextsReused++;
      } else if (opts.llm) {
        if (Buffer.byteLength(source) > maxBytes) {
          result.contextsSkippedTooLarge++;
        } else {
          needContext.push({ rel, source, rec });
        }
      }
    } catch (err) {
      result.errors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
    }
    opts.onProgress?.(result.scanned, files.length, rel);
  }
  target.saveManifest();

  // Phase 2 — AI summaries, only for files whose summary is missing or stale.
  if (opts.llm && needContext.length && !cancelled()) {
    const llm = opts.llm;
    let done = 0;
    let sinceSave = 0;
    await mapLimit(
      needContext,
      opts.concurrency ?? 2,
      async ({ rel, source, rec }) => {
        try {
          const skeletonBody = target.readSkeleton(rel) ?? view.layers[opts.layer === 'local' ? 'shared' : 'local'].readSkeleton(rel) ?? '';
          const text = await llm.complete(contextPrompt(rel, stripFence(skeletonBody), source), opts.signal);
          if (!text) {
            throw new Error('empty response from model');
          }
          target.writeContext(rel, contextMarkdown(rel, text, llm.label));
          const own: FileRecord = target.get(rel) ?? { ...rec };
          own.context = {
            sourceHash: rec.sourceHash,
            skeletonHash: rec.skeletonHash,
            model: llm.label,
            at: new Date().toISOString(),
            tokens: estimateTokens(text),
          };
          target.put(own);
          result.contextsGenerated++;
          if (++sinceSave >= 10) {
            target.saveManifest();
            sinceSave = 0;
          }
        } catch (err) {
          if (!cancelled()) {
            result.errors.push({ path: rel, message: err instanceof Error ? err.message : String(err) });
          }
        }
        opts.onProgress?.(++done, needContext.length, `summarising ${rel}`);
      },
      cancelled
    );
    target.saveManifest();
  }

  target.bumpStats({ contextCallsMade: result.contextsGenerated, contextCallsSkipped: result.contextsReused });
  result.cancelled = cancelled();
  return result;
}

export function stripFence(md: string): string {
  const m = md.match(/```\w*\n([\s\S]*?)```/);
  return m ? m[1].trim() : md.trim();
}


import * as fs from 'fs';
import { ContextPolicy, IndexView } from './indexStore';
import { stripFence } from './indexer';
import { buildPrompt, BuiltPrompt, markFreshness, retrieve, SearchIndex } from './retrieval';
import { listSourceFiles } from './sourceFiles';
import { NoteStore } from './notes';
import { TaskMemory, TaskRecord } from './taskMemory';
import { absFromRel, hashText } from './util';

export interface FindOptions {
  budget?: number;
  maxFiles?: number;
  /** Record this as a task so later edits teach the memory. */
  remember?: boolean;
  /** Count this pack in the usage stats (default true; off for estimates). */
  track?: boolean;
  memoryFilter?: (t: TaskRecord) => boolean;
  /** Include saved notes (default true; off for the savings estimate, which replays code changes). */
  useNotes?: boolean;
}

export interface FindResult extends BuiltPrompt {
  taskId?: string;
}

/**
 * The one service every front end uses: Copilot tools, @librarian, the panel, the CLI and the
 * MCP server. Everything here is local and free — no model calls.
 */
export class Librarian {
  readonly view: IndexView;
  readonly memory: TaskMemory;
  readonly notes: NoteStore;
  private search: SearchIndex;

  constructor(readonly root: string, policy: ContextPolicy = 'onApiChange', private notesEnabled = true) {
    this.view = new IndexView(root, policy);
    this.memory = new TaskMemory(root);
    this.notes = new NoteStore(root);
    this.search = new SearchIndex(this.view);
  }

  findRelevant(task: string, opts: FindOptions = {}): FindResult {
    const noteHits = (opts.useNotes ?? this.notesEnabled) ? this.notes.search(task, 3) : [];
    const extraBoosts = new Map<string, { score: number; because: string }>();
    for (const h of noteHits) {
      h.note.files.forEach((f) => extraBoosts.set(f, { score: 2 + h.score * 4, because: `in saved note “${h.note.title.slice(0, 50)}”` }));
    }
    const cands = retrieve(this.search, this.view, this.memory, task, { maxFiles: opts.maxFiles, memoryFilter: opts.memoryFilter, extraBoosts });
    markFreshness(this.root, this.view, cands);
    const built = buildPrompt(this.view, task, cands, this.search.size, opts.budget, noteHits);
    if (opts.track !== false) {
      this.view.layers.local.bumpStats({ promptsBuilt: 1, estTokensDelivered: built.deliveredTokens, estTokensIfFullFiles: built.fullFileTokens });
    }
    const taskId = opts.remember ? this.memory.begin(task, cands.map((c) => c.path)) : undefined;
    return { ...built, taskId };
  }

  getSkeletons(paths: string[]): string {
    return paths
      .map((p) => p.replace(/^\.?\//, '').replace(/\\/g, '/'))
      .map((p) => {
        const e = this.view.resolve(p, this.currentHash(p));
        if (!e) {
          return `### \`${p}\`\n_Not indexed. Read the source file directly, or run "Librarian: Index Workspace"._\n`;
        }
        const ctx = this.view.readContext(e)?.replace(/^# Context:.*\n(_.*_\n)?/, '').trim();
        const flag = e.skeletonFresh ? '' : ' ⚠ stale — file changed since indexing';
        return `### \`${p}\`${flag}\n${ctx ? ctx + '\n\n' : ''}\`\`\`typescript\n${stripFence(this.view.readSkeleton(e) ?? '')}\n\`\`\`\n`;
      })
      .join('\n');
  }

  /** Direct imports and importers of a file (root-relative paths). */
  neighbours(p: string): string[] {
    this.search.ensure();
    const e = this.view.resolve(p);
    return [...new Set([...(e?.record.imports ?? []), ...this.search.importersOf(p)])];
  }

  getRelated(p: string): string {
    this.search.ensure();
    const rel = p.replace(/^\.?\//, '').replace(/\\/g, '/');
    const e = this.view.resolve(rel);
    if (!e) {
      return `\`${rel}\` is not indexed.`;
    }
    const imports = e.record.imports;
    const importers = this.search.importersOf(rel);
    const touchedTogether = new Map<string, number>();
    for (const t of this.memory.all()) {
      if (t.touched.includes(rel)) {
        t.touched.filter((f) => f !== rel).forEach((f) => touchedTogether.set(f, (touchedTogether.get(f) ?? 0) + 1));
      }
    }
    const co = [...touchedTogether.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    const list = (xs: string[]) => (xs.length ? xs.map((x) => `- \`${x}\``).join('\n') : '- (none)');
    return [
      `## Related to \`${rel}\``,
      `**Imports (${imports.length})**`, list(imports),
      `**Imported by (${importers.length})**`, list(importers),
      `**Usually changed together (from past tasks)**`,
      co.length ? co.map(([f, n]) => `- \`${f}\` (${n}×)`).join('\n') : '- (no history yet)',
    ].join('\n');
  }

  status(): { total: number; indexed: number; fresh: number; withContext: number; staleContext: number; text: string } {
    const files = listSourceFiles(this.root);
    let indexed = 0;
    let fresh = 0;
    let withContext = 0;
    let staleContext = 0;
    for (const f of files) {
      const e = this.view.resolve(f, this.currentHash(f));
      if (!e) {
        continue;
      }
      indexed++;
      if (e.skeletonFresh) {
        fresh++;
      }
      if (e.contextFresh) {
        withContext++;
      } else if (e.contextLayer) {
        staleContext++;
      }
    }
    const s = this.view.layers.local.stats();
    const saved = Math.max(0, s.estTokensIfFullFiles - s.estTokensDelivered);
    const text = [
      `Source files: ${files.length}`,
      `Indexed: ${indexed} (fresh ${fresh}, stale ${indexed - fresh})`,
      `AI summaries: ${withContext} fresh, ${staleContext} stale`,
      `Remembered tasks: ${this.memory.all().length} · saved notes: ${this.notes.all().length}`,
      `Context packs built: ${s.promptsBuilt} · est. tokens saved vs. full files: ${saved.toLocaleString()}`,
    ].join('\n');
    return { total: files.length, indexed, fresh, withContext, staleContext, text };
  }

  private currentHash(rel: string): string | undefined {
    try {
      return hashText(fs.readFileSync(absFromRel(this.root, rel), 'utf8'));
    } catch {
      return undefined;
    }
  }
}

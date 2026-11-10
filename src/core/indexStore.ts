import * as fs from 'fs';
import * as path from 'path';
import { INDEX_DIR } from './sourceFiles';
import { absFromRel, readJson, writeJson, writeText } from './util';

/**
 * Index layout
 *
 *   .trishAI/
 *     .gitignore          -> ignores local/
 *     shared/             -> produced by CI on merge (committed, read-only for developers)
 *     local/              -> per-developer overlay for uncommitted / not-yet-merged changes
 *
 * Each layer has manifest.json, memory.json and files/<path>.skeleton.md|.context.md
 */
export type LayerName = 'shared' | 'local';
export const LAYERS: LayerName[] = ['local', 'shared'];

export type ContextPolicy = 'onApiChange' | 'onSourceChange';

export interface FileRecord {
  path: string;
  sourceHash: string;
  skeletonHash: string;
  skeletonAt: string;
  exportNames: string[];
  /** Resolved, root-relative paths of local modules this file imports. */
  imports: string[];
  sourceTokens: number;
  skeletonTokens: number;
  context?: {
    sourceHash: string;
    skeletonHash: string;
    model: string;
    at: string;
    tokens: number;
  };
}

export interface Manifest {
  version: 2;
  generatedAt: string;
  generator: string;
  files: Record<string, FileRecord>;
}

export interface Stats {
  promptsBuilt: number;
  estTokensDelivered: number;
  estTokensIfFullFiles: number;
  contextCallsMade: number;
  contextCallsSkipped: number;
}

const emptyManifest = (): Manifest => ({ version: 2, generatedAt: new Date(0).toISOString(), generator: 'librarian', files: {} });

export class IndexLayer {
  readonly dir: string;
  private manifestCache?: Manifest;

  constructor(readonly root: string, readonly name: LayerName) {
    this.dir = path.join(root, INDEX_DIR, name);
  }

  get manifestPath(): string {
    return path.join(this.dir, 'manifest.json');
  }

  manifest(): Manifest {
    if (!this.manifestCache) {
      const m = readJson<Manifest>(this.manifestPath, emptyManifest());
      this.manifestCache = m.version === 2 ? m : emptyManifest();
    }
    return this.manifestCache;
  }

  reload(): void {
    this.manifestCache = undefined;
  }

  saveManifest(): void {
    const m = this.manifest();
    m.generatedAt = new Date().toISOString();
    writeJson(this.manifestPath, m);
    ensureIndexGitignore(this.root);
  }

  skeletonFile(rel: string): string {
    return absFromRel(path.join(this.dir, 'files'), rel) + '.skeleton.md';
  }

  contextFile(rel: string): string {
    return absFromRel(path.join(this.dir, 'files'), rel) + '.context.md';
  }

  get(rel: string): FileRecord | undefined {
    return this.manifest().files[rel];
  }

  put(rec: FileRecord): void {
    this.manifest().files[rec.path] = rec;
  }

  remove(rel: string): void {
    delete this.manifest().files[rel];
    for (const f of [this.skeletonFile(rel), this.contextFile(rel)]) {
      fs.rmSync(f, { force: true });
    }
  }

  writeSkeleton(rel: string, body: string): void {
    writeText(this.skeletonFile(rel), body);
  }

  writeContext(rel: string, body: string): void {
    writeText(this.contextFile(rel), body);
  }

  readSkeleton(rel: string): string | undefined {
    return readIfExists(this.skeletonFile(rel));
  }

  readContext(rel: string): string | undefined {
    return readIfExists(this.contextFile(rel));
  }

  statsPath(): string {
    return path.join(this.dir, 'stats.json');
  }

  stats(): Stats {
    return readJson<Stats>(this.statsPath(), {
      promptsBuilt: 0, estTokensDelivered: 0, estTokensIfFullFiles: 0, contextCallsMade: 0, contextCallsSkipped: 0,
    });
  }

  bumpStats(delta: Partial<Stats>): void {
    const s = this.stats();
    for (const [k, v] of Object.entries(delta)) {
      (s as unknown as Record<string, number>)[k] += v ?? 0;
    }
    writeJson(this.statsPath(), s);
  }
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

export function ensureIndexGitignore(root: string): void {
  const file = path.join(root, INDEX_DIR, '.gitignore');
  if (!fs.existsSync(file)) {
    writeText(file, '# Per-developer overlay — never commit\nlocal/\n');
  }
}

/** Is a context summary still valid for the given source/skeleton hashes under a policy? */
export function contextIsFresh(rec: FileRecord | undefined, sourceHash: string, skeletonHash: string, policy: ContextPolicy): boolean {
  if (!rec?.context) {
    return false;
  }
  return policy === 'onSourceChange' ? rec.context.sourceHash === sourceHash : rec.context.skeletonHash === skeletonHash;
}

export interface ResolvedEntry {
  path: string;
  /** Best record for skeleton/imports (fresh one preferred). */
  record: FileRecord;
  layer: LayerName;
  skeletonFresh: boolean;
  /** Where the best context lives, if any. */
  contextLayer?: LayerName;
  contextFresh: boolean;
}

/**
 * Read-only merged view across layers. For each file it picks the layer whose record matches
 * the file's current content; otherwise the newest record, flagged stale.
 */
export class IndexView {
  readonly layers: Record<LayerName, IndexLayer>;

  constructor(readonly root: string, readonly policy: ContextPolicy = 'onApiChange') {
    this.layers = { local: new IndexLayer(root, 'local'), shared: new IndexLayer(root, 'shared') };
  }

  reload(): void {
    LAYERS.forEach((l) => this.layers[l].reload());
  }

  allPaths(): string[] {
    const set = new Set<string>();
    LAYERS.forEach((l) => Object.keys(this.layers[l].manifest().files).forEach((p) => set.add(p)));
    return [...set].sort();
  }

  /** @param currentHash hash of the file as it is on disk now (omit to skip freshness checks). */
  resolve(rel: string, currentHash?: string): ResolvedEntry | undefined {
    const recs = LAYERS.map((l) => ({ layer: l, rec: this.layers[l].get(rel) })).filter((x) => x.rec) as {
      layer: LayerName;
      rec: FileRecord;
    }[];
    if (recs.length === 0) {
      return undefined;
    }
    const fresh = currentHash ? recs.find((r) => r.rec.sourceHash === currentHash) : recs[0];
    const best = fresh ?? recs.sort((a, b) => b.rec.skeletonAt.localeCompare(a.rec.skeletonAt))[0];
    const skelHash = best.rec.skeletonHash;
    const srcHash = currentHash ?? best.rec.sourceHash;

    const ctxFresh = recs.find((r) => contextIsFresh(r.rec, srcHash, skelHash, this.policy));
    const ctxAny = ctxFresh ?? recs.find((r) => r.rec.context);
    return {
      path: rel,
      record: best.rec,
      layer: best.layer,
      skeletonFresh: currentHash ? !!fresh : true,
      contextLayer: ctxAny?.layer,
      contextFresh: !!ctxFresh && (currentHash ? !!fresh : true),
    };
  }

  readSkeleton(e: ResolvedEntry): string | undefined {
    return this.layers[e.layer].readSkeleton(e.path);
  }

  readContext(e: ResolvedEntry): string | undefined {
    return e.contextLayer ? this.layers[e.contextLayer].readContext(e.path) : undefined;
  }
}

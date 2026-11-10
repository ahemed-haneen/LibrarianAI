import * as path from 'path';
import { LayerName } from './indexStore';
import { INDEX_DIR } from './sourceFiles';
import { estimateTokens, hashText, readJson, tokenize, writeJson } from './util';

/**
 * Saved chat/task context ("notes"): goals, decisions, constraints and the files involved,
 * summarised from a conversation so later chats can reuse it instead of re-explaining.
 *
 * Notes are deliberately separate from task memory: they are knowledge, not edits, so they never
 * count as "files changed" and never feed co-change statistics. Personal notes live in the
 * git-ignored local layer; a note can be shared with the team by moving it to the shared layer.
 */
export interface Note {
  id: string;
  title: string;
  summary: string;
  /** Root-relative files the conversation was about (used as a light retrieval boost). */
  files: string[];
  tokens: string[];
  source: 'agent' | 'chat' | 'manual';
  createdAt: string;
  updatedAt: string;
}

export interface NoteHit {
  note: Note;
  layer: LayerName;
  score: number;
}

interface NotesFile {
  version: 1;
  notes: Note[];
}

const MAX_NOTES = 300;
const MAX_SUMMARY_CHARS = 6000;

export class NoteStore {
  constructor(readonly root: string) {}

  private file(layer: LayerName): string {
    return path.join(this.root, INDEX_DIR, layer, 'notes.json');
  }

  private read(layer: LayerName): NotesFile {
    return readJson<NotesFile>(this.file(layer), { version: 1, notes: [] });
  }

  private write(layer: LayerName, data: NotesFile): void {
    data.notes = data.notes.slice(-MAX_NOTES);
    writeJson(this.file(layer), data);
  }

  all(): { note: Note; layer: LayerName }[] {
    return [
      ...this.read('local').notes.map((note) => ({ note, layer: 'local' as LayerName })),
      ...this.read('shared').notes.map((note) => ({ note, layer: 'shared' as LayerName })),
    ].sort((a, b) => b.note.updatedAt.localeCompare(a.note.updatedAt));
  }

  /** Save a note. Saving again with the same title updates it instead of piling up duplicates. */
  save(input: { title: string; summary: string; files?: string[]; source?: Note['source'] }, layer: LayerName = 'local'): { note: Note; updated: boolean } {
    const title = input.title.trim().replace(/\s+/g, ' ').slice(0, 120) || 'Untitled note';
    const summary = input.summary.trim().slice(0, MAX_SUMMARY_CHARS);
    if (!summary) {
      throw new Error('A note needs a summary.');
    }
    const files = [...new Set((input.files ?? []).map((f) => String(f).trim().replace(/\\/g, '/').replace(/^\.?\//, '')).filter(Boolean))].slice(0, 30);
    const data = this.read(layer);
    const now = new Date().toISOString();
    const existing = data.notes.find((n) => n.title.toLowerCase() === title.toLowerCase());
    const tokens = [...new Set([...tokenize(title), ...tokenize(title), ...tokenize(summary), ...files.flatMap((f) => tokenize(f))])];
    if (existing) {
      Object.assign(existing, { summary, files: files.length ? files : existing.files, tokens, updatedAt: now, source: input.source ?? existing.source });
      this.write(layer, data);
      return { note: existing, updated: true };
    }
    const note: Note = { id: hashText(title + now).slice(0, 8), title, summary, files, tokens, source: input.source ?? 'manual', createdAt: now, updatedAt: now };
    data.notes.push(note);
    this.write(layer, data);
    return { note, updated: false };
  }

  remove(id: string): boolean {
    for (const layer of ['local', 'shared'] as LayerName[]) {
      const data = this.read(layer);
      const before = data.notes.length;
      data.notes = data.notes.filter((n) => n.id !== id);
      if (data.notes.length !== before) {
        this.write(layer, data);
        return true;
      }
    }
    return false;
  }

  /** Move a personal note to the shared (committed) layer so teammates get it too. */
  share(id: string): boolean {
    const local = this.read('local');
    const note = local.notes.find((n) => n.id === id);
    if (!note) {
      return false;
    }
    const shared = this.read('shared');
    shared.notes = shared.notes.filter((n) => n.title.toLowerCase() !== note.title.toLowerCase());
    shared.notes.push(note);
    this.write('shared', shared);
    local.notes = local.notes.filter((n) => n.id !== id);
    this.write('local', local);
    return true;
  }

  /** Notes relevant to a query (set-cosine over tokens, recency as a tie-breaker). */
  search(query: string, limit = 3, min = 0.12): NoteHit[] {
    const q = new Set(tokenize(query));
    if (q.size === 0) {
      return [];
    }
    return this.all()
      .map(({ note, layer }) => {
        const n = new Set(note.tokens);
        let overlap = 0;
        q.forEach((t) => n.has(t) && overlap++);
        const score = overlap / Math.sqrt(q.size * Math.max(1, n.size)) + (Date.parse(note.updatedAt) / 1e15);
        return { note, layer, score };
      })
      .filter((h) => h.score >= min)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  static render(n: Note, layer?: LayerName): string {
    const meta = [`saved ${n.updatedAt.slice(0, 10)}`, layer === 'shared' ? 'team' : 'personal', `id ${n.id}`].join(' · ');
    const files = n.files.length ? `\nFiles: ${n.files.map((f) => `\`${f}\``).join(', ')}` : '';
    return `#### ${n.title}\n_${meta}_\n\n${n.summary}${files}\n`;
  }

  static tokens(n: Note): number {
    return estimateTokens(NoteStore.render(n));
  }
}

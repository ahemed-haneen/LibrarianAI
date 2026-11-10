import { Librarian } from './librarian';
import { NoteStore } from './notes';

/**
 * Tool contract shared by the VS Code Language Model Tools (package.json mirrors these) and the
 * MCP server, so Copilot agent mode and any MCP client see the same behaviour.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(lib: Librarian, input: Record<string, unknown>): { text: string; taskId?: string };
  /** Tools that write something ask the user first (VS Code shows this before running). */
  confirm?(input: Record<string, unknown>): { title: string; message: string };
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []);

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'librarian_findRelevantFiles',
    description:
      'Call this FIRST for any coding task in this repository, before reading source files. Given a natural-language task, ' +
      'returns the most relevant files with their exported signatures and short summaries (from a pre-built index), ranked using ' +
      'text match, the import graph and files changed in similar past tasks. Much cheaper than reading files.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task, in the user\'s words plus any identifiers you know.' },
        maxTokens: { type: 'number', description: 'Token budget for the result (default 6000).' },
      },
      required: ['task'],
    },
    run(lib, input) {
      const r = lib.findRelevant(String(input.task ?? ''), {
        budget: typeof input.maxTokens === 'number' ? input.maxTokens : undefined,
        remember: true,
      });
      return { text: r.prompt, taskId: r.taskId };
    },
  },
  {
    name: 'librarian_getSkeleton',
    description:
      'Returns the exported API (signatures) and summary of one or more files from the index without reading the full source. ' +
      'Use instead of reading a file when you only need to know what it exports or how to call it.',
    inputSchema: {
      type: 'object',
      properties: { paths: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file paths.' } },
      required: ['paths'],
    },
    run(lib, input) {
      const paths = Array.isArray(input.paths) ? input.paths.map(String) : [String(input.paths ?? '')];
      return { text: lib.getSkeletons(paths.slice(0, 20)) };
    },
  },
  {
    name: 'librarian_getRelatedFiles',
    description:
      'Shows which files a file imports, which files import it, and which files were usually changed together with it in past tasks. ' +
      'Use before changing a file\'s exports or when looking for the call sites of a module.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
    },
    run(lib, input) {
      return { text: lib.getRelated(String(input.path ?? '')) };
    },
  },
  {
    name: 'librarian_saveNote',
    description:
      'Saves the context of the current conversation to Librarian memory so future chats can reuse it. Call this when the user asks to ' +
      'save, remember or store this chat/task/context. Write the summary yourself from the conversation: goal, key decisions and why, ' +
      'constraints, what was tried and rejected, current status and next steps — concise markdown, under 300 words, no code dumps. ' +
      'Saving again with the same title updates the note. Notes are knowledge, not code changes.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short, specific title, e.g. "Rate limiting for login endpoint".' },
        summary: { type: 'string', description: 'Markdown summary: goal, decisions, constraints, status, next steps.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Workspace-relative files the conversation was about.' },
      },
      required: ['title', 'summary'],
    },
    confirm(input) {
      const files = strList(input.files);
      return {
        title: 'Save to Librarian memory?',
        message: `**${String(input.title ?? '')}**\n\n${String(input.summary ?? '').slice(0, 1500)}${files.length ? `\n\nFiles: ${files.join(', ')}` : ''}`,
      };
    },
    run(lib, input) {
      const { note, updated } = lib.notes.save({ title: String(input.title ?? ''), summary: String(input.summary ?? ''), files: strList(input.files), source: 'agent' });
      return {
        text: `${updated ? 'Updated' : 'Saved'} note "${note.title}" (id ${note.id}) in personal Librarian memory. It will be included automatically when a future task is related.`,
      };
    },
  },
  {
    name: 'librarian_recallNotes',
    description:
      'Searches notes saved from earlier conversations (decisions, constraints, status of past tasks). Use when the user refers to ' +
      'earlier work ("what did we decide about…", "continue the … task") or before re-designing something that may have been discussed.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'What to look for.' } },
      required: ['query'],
    },
    run(lib, input) {
      const hits = lib.notes.search(String(input.query ?? ''), 5, 0.08);
      return {
        text: hits.length ? hits.map((h) => NoteStore.render(h.note, h.layer)).join('\n') : 'No saved notes match. (Notes are created with #librarianSave or "Librarian: Save Note to Memory".)',
      };
    },
  },
];

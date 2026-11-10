import { Librarian } from './librarian';

/**
 * Tool contract shared by the VS Code Language Model Tools (package.json mirrors these) and the
 * MCP server, so Copilot agent mode and any MCP client see the same behaviour.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(lib: Librarian, input: Record<string, unknown>): { text: string; taskId?: string };
}

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
];

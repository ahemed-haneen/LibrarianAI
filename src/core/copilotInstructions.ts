import * as fs from 'fs';
import * as path from 'path';
import { writeText } from './util';

const START = '<!-- librarian:start -->';
const END = '<!-- librarian:end -->';

export const INSTRUCTIONS_BLOCK = `${START}
## Codebase index (Librarian)

This repository has a pre-built index in \`.trishAI/\` that describes every source file's public API
and purpose. Use it to keep context small and avoid unnecessary file reads.

1. **Before reading source files for a task**, call the \`#librarianFind\` tool with the task description.
   It returns the most relevant files with their signatures and summaries, picked using past changes.
2. To inspect a specific file's API without reading it, call \`#librarianSkeleton\` with its path.
3. Before changing a file's exports, call \`#librarianRelated\` to see what imports it.
4. If tools are unavailable, read \`.trishAI/shared/files/<path>.skeleton.md\` (or \`.trishAI/local/files/...\`)
   instead of the full source where signatures are enough.
5. Open full source files only for the parts you need to edit or whose implementation matters.
6. Entries marked "stale" may be outdated: confirm against the source before relying on them.
7. When the user asks to **save / remember this chat or task**, call \`#librarianSave\` with a short title and a
   summary you write from the conversation (goal, decisions and why, constraints, status, next steps, files involved).
8. When the user refers to earlier work ("what did we decide…", "continue the … task"), call \`#librarianNotes\`.
   Relevant saved notes are also included automatically in \`#librarianFind\` results.
${END}`;

/** Insert or update the Librarian block in .github/copilot-instructions.md, keeping user content. */
export function installCopilotInstructions(root: string): { file: string; action: 'created' | 'updated' | 'unchanged' } {
  const file = path.join(root, '.github', 'copilot-instructions.md');
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (existing === undefined) {
    writeText(file, `# Copilot instructions\n\n${INSTRUCTIONS_BLOCK}\n`);
    return { file, action: 'created' };
  }
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  const next = re.test(existing) ? existing.replace(re, INSTRUCTIONS_BLOCK) : `${existing.trimEnd()}\n\n${INSTRUCTIONS_BLOCK}\n`;
  if (next === existing) {
    return { file, action: 'unchanged' };
  }
  writeText(file, next);
  return { file, action: 'updated' };
}

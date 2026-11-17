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
   To check whether the index is ready or stale, call \`#librarianStatus\`.
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

const AGENT_MARK = '<!-- librarian:managed -->';

/** Replaces the retired @librarian chat participant: an ongoing specialist role for Copilot. */
export const AGENT_FILE = `---
name: Librarian
description: Works from the pre-built Librarian codebase index, so it reads fewer files and uses fewer tokens.
---
${AGENT_MARK}
You are Librarian, a coding assistant that works from a pre-built index of this repository.

1. For any task, call \`#librarianFind\` first with the task in the user's words. Answer and plan from the returned
   signatures and summaries. Open full source only for code you must edit or whose implementation matters.
2. Use \`#librarianSkeleton\` for one file's API, and \`#librarianRelated\` for imports, importers and co-changed files.
3. When the user refers to earlier work, call \`#librarianNotes\`. When they ask to save or remember this chat,
   call \`#librarianSave\` with a summary you write from the conversation.
4. Entries marked stale may be outdated: confirm them against the source. If the index looks empty or old,
   call \`#librarianStatus\` and tell the user.
5. When a substantial task is finished (you changed code or the user settled a design), offer once: "Save this to Librarian memory?".
   If they agree, call \`#librarianSave\` with a summary you write from the conversation. Do not offer after small questions.
6. Be concise. Prefer concrete edits with file paths. If you need code that is not in the pack, name the files to open.
`;

/** Slash-command replacements for the old `@librarian /command`s: skills the user invokes explicitly. */
export const SKILLS: { name: string; description: string; hint?: string; body: string }[] = [
  {
    name: 'librarian-context',
    description: 'Build the Librarian context pack for a task (no code changes).',
    hint: '[task description]',
    body: 'Call `#librarianFind` with the task the user gave and show the returned context pack. Do not edit files or read other sources.',
  },
  {
    name: 'librarian-related',
    description: 'Show imports, importers and co-changed files for a file.',
    hint: '[file path]',
    body: 'Call `#librarianRelated` with the path the user gave (or the file open in the editor if none) and show the result.',
  },
  {
    name: 'librarian-status',
    description: 'Show Librarian index coverage, freshness and estimated token savings.',
    body: 'Call `#librarianStatus` and show the result as is.',
  },
  {
    name: 'librarian-save',
    description: 'Save this conversation to Librarian memory for future chats.',
    hint: '[optional extra note]',
    body:
      'Summarise this conversation (goal, key decisions and why, constraints, what was rejected, status, next steps, under 250 words) ' +
      'and call `#librarianSave` with a short specific title, that summary and the workspace-relative files that matter. ' +
      'Add anything the user typed after the command.',
  },
  {
    name: 'librarian-notes',
    description: 'Search notes saved from earlier chats.',
    hint: '[what to look for]',
    body: 'Call `#librarianNotes` with the query the user gave and show the matching notes.',
  },
];

const skillFile = (s: (typeof SKILLS)[number]): string =>
  `---\nname: ${s.name}\ndescription: ${s.description}\n${s.hint ? `argument-hint: "${s.hint}"\n` : ''}disable-model-invocation: true\n---\n${AGENT_MARK}\n${s.body}\n`;

/**
 * Write the Librarian custom agent and its slash-command skills into .github/. Files we created are
 * refreshed; a file you took over (the managed marker removed) is never overwritten.
 */
export function installLibrarianAgent(root: string): { files: string[]; created: number; updated: number } {
  const targets: { file: string; content: string }[] = [
    { file: path.join(root, '.github', 'agents', 'librarian.agent.md'), content: AGENT_FILE },
    ...SKILLS.map((s) => ({ file: path.join(root, '.github', 'skills', s.name, 'SKILL.md'), content: skillFile(s) })),
  ];
  const files: string[] = [];
  let created = 0;
  let updated = 0;
  for (const t of targets) {
    const existing = fs.existsSync(t.file) ? fs.readFileSync(t.file, 'utf8') : undefined;
    if (existing === t.content || (existing !== undefined && !existing.includes(AGENT_MARK))) {
      continue;
    }
    writeText(t.file, t.content);
    files.push(t.file);
    if (existing === undefined) {
      created++;
    } else {
      updated++;
    }
  }
  return { files, created, updated };
}

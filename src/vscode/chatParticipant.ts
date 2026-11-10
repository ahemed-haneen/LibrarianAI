import * as vscode from 'vscode';
import { Librarian } from '../core/librarian';
import { absFromRel } from '../core/util';
import { TaskTracker } from './taskTracker';

const SYSTEM = `You are Librarian, a coding assistant inside VS Code. You are given a context pack built from a
pre-indexed codebase: file signatures, short summaries, and why each file was picked. Answer from the pack.
When you need code that is not in the pack, name the exact file(s) the user should open or attach (#file) rather than guessing.
Be concise; prefer concrete edits with file paths.`;

/**
 * @librarian in Copilot Chat. It runs on whichever model the user picked in the chat (their
 * firm's Copilot), but sends a compact context pack instead of whole files.
 *   /context  — build the pack only (no model call), to paste anywhere or attach
 *   /related  — import graph + co-change history for a file
 *   /status   — index coverage, freshness and estimated savings
 */
export function registerChatParticipant(
  lib: () => Librarian | undefined,
  tracker: () => TaskTracker | undefined,
  budget: () => number,
  onUsed: () => void
): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, context, stream, token) => {
    const l = lib();
    if (!l) {
      stream.markdown('Open a workspace folder first — Librarian needs a codebase to index.');
      return;
    }

    if (request.command === 'status') {
      stream.markdown('```\n' + l.status().text + '\n```');
      return;
    }
    if (request.command === 'related') {
      const p = request.prompt.trim() || (vscode.window.activeTextEditor ? vscode.workspace.asRelativePath(vscode.window.activeTextEditor.document.uri, false) : '');
      stream.markdown(p ? l.getRelated(p) : 'Give a file path, e.g. `@librarian /related src/auth/session.ts`.');
      return;
    }

    const task = request.prompt.trim();
    if (!task) {
      stream.markdown('Describe the task, e.g. `@librarian add rate limiting to the login endpoint`.');
      return;
    }

    stream.progress('Searching the index…');
    const pack = l.findRelevant(task, { budget: budget(), remember: true });
    tracker()?.start(pack.taskId);
    onUsed();
    for (const f of pack.files.slice(0, 12)) {
      stream.reference(vscode.Uri.file(absFromRel(l.root, f.path)));
    }
    const savings = `_Context: ${pack.files.length} file(s), ~${pack.deliveredTokens.toLocaleString()} tokens (reading them in full ≈ ${pack.fullFileTokens.toLocaleString()})._`;

    if (request.command === 'context') {
      stream.markdown(pack.prompt + '\n\n---\n' + savings);
      return;
    }

    const history: vscode.LanguageModelChatMessage[] = [];
    for (const turn of context.history.slice(-6)) {
      if (turn instanceof vscode.ChatRequestTurn) {
        history.push(vscode.LanguageModelChatMessage.User(turn.prompt));
      } else if (turn instanceof vscode.ChatResponseTurn) {
        const text = turn.response
          .map((p) => (p instanceof vscode.ChatResponseMarkdownPart ? p.value.value : ''))
          .join('')
          .slice(0, 4000);
        if (text) {
          history.push(vscode.LanguageModelChatMessage.Assistant(text));
        }
      }
    }

    const messages = [
      vscode.LanguageModelChatMessage.User(`${SYSTEM}\n\n${pack.prompt}`),
      ...history,
      vscode.LanguageModelChatMessage.User(task),
    ];
    try {
      const res = await request.model.sendRequest(messages, {}, token);
      for await (const chunk of res.text) {
        stream.markdown(chunk);
      }
      stream.markdown('\n\n' + savings);
    } catch (err) {
      stream.markdown(`Model request failed: ${err instanceof Error ? err.message : String(err)}\n\nHere is the context pack so you can use it elsewhere:\n\n${pack.prompt}`);
    }
  };

  const participant = vscode.chat.createChatParticipant('trishAI.librarian', handler);
  participant.iconPath = new vscode.ThemeIcon('book');
  return participant;
}

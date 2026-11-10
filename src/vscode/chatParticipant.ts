import * as vscode from 'vscode';
import { Librarian } from '../core/librarian';
import { NoteStore } from '../core/notes';
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
 *   /save     — summarise this conversation into a saved note (reused by later chats)
 *   /notes    — list or search saved notes
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
    if (request.command === 'notes') {
      const q = request.prompt.trim();
      const hits = q ? l.notes.search(q, 10, 0.05) : l.notes.all().slice(0, 10).map((x) => ({ ...x, score: 1 }));
      stream.markdown(
        hits.length
          ? hits.map((h) => NoteStore.render(h.note, h.layer)).join('\n---\n')
          : 'No saved notes yet. Use `@librarian /save`, `#librarianSave` in agent mode, or **Librarian: Save Note to Memory**.'
      );
      return;
    }
    if (request.command === 'save') {
      await saveConversation(l, request, context, stream, token);
      onUsed();
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

/** Turn the visible @librarian conversation (plus anything typed after /save) into a note. */
async function saveConversation(
  l: Librarian,
  request: vscode.ChatRequest,
  context: vscode.ChatContext,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken
): Promise<void> {
  const transcript: string[] = [];
  const files = new Set<string>();
  for (const turn of context.history) {
    if (turn instanceof vscode.ChatRequestTurn) {
      transcript.push(`User: ${turn.prompt}`);
    } else if (turn instanceof vscode.ChatResponseTurn) {
      for (const part of turn.response) {
        if (part instanceof vscode.ChatResponseMarkdownPart) {
          transcript.push(`Assistant: ${part.value.value.slice(0, 3000)}`);
        }
      }
    }
  }
  for (const ref of request.references) {
    const v = ref.value;
    const uri = v instanceof vscode.Uri ? v : v instanceof vscode.Location ? v.uri : undefined;
    if (uri) {
      files.add(vscode.workspace.asRelativePath(uri, false));
    }
  }
  const extra = request.prompt.trim();

  if (transcript.length === 0) {
    if (!extra) {
      stream.markdown(
        'Nothing to save yet: `@librarian` can only see its own conversation.\n\n' +
          '- In a **Copilot agent** chat, ask: *“save this to librarian memory”* (or type `#librarianSave`). Copilot writes the summary itself.\n' +
          '- For any other chat, use **Copy All** in the chat, then run **Librarian: Save Note to Memory** and choose *From clipboard*.\n' +
          '- Or type the note directly: `@librarian /save <what to remember>`.'
      );
      return;
    }
    const title = extra.split(/[.\n]/)[0].slice(0, 80);
    const { note, updated } = l.notes.save({ title, summary: extra, files: [...files], source: 'chat' });
    stream.markdown(`${updated ? 'Updated' : 'Saved'} note **${note.title}**. Future related tasks will include it.`);
    return;
  }

  stream.progress('Summarising this conversation…');
  const prompt = `Summarise the conversation below into a note that a future AI chat can reuse to continue this work.
Reply in exactly this format:
TITLE: <short specific title>
FILES: <comma-separated workspace-relative file paths that matter, or none>
SUMMARY:
<markdown under 250 words: goal, key decisions and why, constraints, what was tried/rejected, current status, next steps>
${extra ? `\nThe user added: ${extra}\n` : ''}
Conversation:
${transcript.join('\n\n').slice(-24000)}`;
  let text = '';
  const res = await request.model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], {}, token);
  for await (const chunk of res.text) {
    text += chunk;
  }
  const title = /TITLE:\s*(.+)/i.exec(text)?.[1]?.trim() ?? (extra || 'Chat summary').slice(0, 80);
  const fileLine = /FILES:\s*(.+)/i.exec(text)?.[1] ?? '';
  fileLine.split(',').map((f) => f.trim().replace(/^`|`$/g, '')).filter((f) => f && f.toLowerCase() !== 'none').forEach((f) => files.add(f));
  const summary = (/SUMMARY:\s*([\s\S]+)/i.exec(text)?.[1] ?? text).trim();
  const { note, updated } = l.notes.save({ title, summary, files: [...files], source: 'chat' });
  stream.markdown(`${updated ? 'Updated' : 'Saved'} note:\n\n${NoteStore.render(note, 'local')}\n_Future related tasks will include this automatically. Manage notes with **Librarian: Manage Saved Notes**._`);
}

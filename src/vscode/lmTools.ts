import * as vscode from 'vscode';
import { Librarian } from '../core/librarian';
import { TOOL_DEFS } from '../core/tools';
import { TaskTracker } from './taskTracker';

/**
 * Registers the Librarian tools with VS Code so Copilot agent mode can call them on its own
 * (declared in package.json under contributes.languageModelTools). This is the "overlay":
 * you keep using Copilot Chat, and Copilot asks the index before reading whole files.
 */
export function registerLmTools(lib: () => Librarian | undefined, tracker: () => TaskTracker | undefined, onUsed: () => void): vscode.Disposable[] {
  return TOOL_DEFS.map((def) =>
    vscode.lm.registerTool<Record<string, unknown>>(def.name, {
      prepareInvocation(options) {
        const input = options.input;
        const detail = typeof input.task === 'string' ? input.task : typeof input.title === 'string' ? input.title : typeof input.query === 'string' ? input.query : typeof input.path === 'string' ? input.path : Array.isArray(input.paths) ? input.paths.join(', ') : '';
        const confirm = def.confirm?.(input);
        return {
          invocationMessage: `Librarian: ${def.name.replace('librarian_', '')} ${detail.slice(0, 80)}`,
          confirmationMessages: confirm ? { title: confirm.title, message: new vscode.MarkdownString(confirm.message) } : undefined,
        };
      },
      invoke(options) {
        const l = lib();
        if (!l) {
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart('No workspace folder is open, so the Librarian index is unavailable.')]);
        }
        const out = def.run(l, options.input ?? {});
        tracker()?.start(out.taskId);
        onUsed();
        return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(out.text)]);
      },
    })
  );
}

import * as vscode from 'vscode';
import { LlmClient } from '../core/llm';

/**
 * Uses the Copilot subscription already signed in to VS Code (vscode.lm). Background summaries
 * are simple work, so it walks a preference list of low-cost model families first — on most
 * Copilot business plans the base models do not consume premium requests.
 */
export class CopilotLlm implements LlmClient {
  private model?: vscode.LanguageModelChat;

  constructor(private families: string[]) {}

  get label(): string {
    return this.model ? `Copilot / ${this.model.family}` : 'Copilot';
  }

  private async pick(): Promise<vscode.LanguageModelChat> {
    if (this.model) {
      return this.model;
    }
    for (const family of this.families.filter(Boolean)) {
      const found = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
      if (found.length) {
        return (this.model = found[0]);
      }
    }
    const any = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    if (!any.length) {
      throw new Error('No Copilot language model is available. Make sure GitHub Copilot is installed and signed in.');
    }
    return (this.model = any[0]);
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const model = await this.pick();
    const cts = new vscode.CancellationTokenSource();
    signal?.addEventListener('abort', () => cts.cancel());
    try {
      const res = await model.sendRequest(
        [vscode.LanguageModelChatMessage.User(prompt)],
        { justification: 'Librarian summarises source files once so later Copilot requests need less context.' },
        cts.token
      );
      let text = '';
      for await (const chunk of res.text) {
        text += chunk;
      }
      return text.trim();
    } finally {
      cts.dispose();
    }
  }
}

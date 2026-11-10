import * as vscode from 'vscode';
import { LlmClient } from '../core/llm';

/**
 * Uses the Copilot subscription already signed in to VS Code (vscode.lm), but ONLY the exact
 * model the user chose on the setup page. There is deliberately no fallback: if that model
 * disappears, summarising stops and asks, rather than quietly switching to another (possibly premium) model.
 */
export class CopilotLlm implements LlmClient {
  private model?: vscode.LanguageModelChat;

  constructor(private modelId: string) {}

  get label(): string {
    return `Copilot / ${this.model?.name ?? this.modelId}`;
  }

  static async find(modelId: string): Promise<vscode.LanguageModelChat | undefined> {
    const found = await vscode.lm.selectChatModels({ vendor: 'copilot', id: modelId });
    return found[0];
  }

  private async pick(): Promise<vscode.LanguageModelChat> {
    if (!this.model) {
      this.model = await CopilotLlm.find(this.modelId);
      if (!this.model) {
        throw new Error(`The Copilot model you chose ("${this.modelId}") is not available right now. Run "Librarian: Open Setup" to choose another.`);
      }
    }
    return this.model;
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

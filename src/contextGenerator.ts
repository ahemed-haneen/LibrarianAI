import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import Anthropic from '@anthropic-ai/sdk';

export type AIProvider = 'copilot' | 'anthropic';

export interface ContextGeneratorOptions {
  provider: AIProvider;
  // Anthropic
  anthropicApiKey?: string;
  anthropicModel?: string;
  // Copilot
  copilotModelFamily?: string;
}

const CONTEXT_PROMPT = (relativePath: string, fileContent: string) => `\
Analyze this source file and produce a concise context overview in markdown.

File: ${relativePath}

\`\`\`
${fileContent}
\`\`\`

Return a markdown document with exactly these sections:
- A one-paragraph **Summary** of what this file does and its role in the codebase.
- **Responsibilities** — bullet list of key things this file handles.
- **Public API** — list of exported functions/classes/types with one-line descriptions.
- **Internal Dependencies** — list of relative imports (non-library) with a short note on what each provides.

Be concise. Aim for under 250 words total. Do not repeat the file content.`;

export class ContextGenerator {
  private anthropicClient?: Anthropic;
  private cachedCopilotModel?: vscode.LanguageModelChat;

  constructor(private options: ContextGeneratorOptions) {
    if (options.provider === 'anthropic' && options.anthropicApiKey) {
      this.anthropicClient = new Anthropic({ apiKey: options.anthropicApiKey });
    }
  }

  static getContextPath(rootPath: string, filePath: string): string {
    const relative = path.relative(rootPath, filePath);
    return path.join(
      rootPath,
      '.trishAI',
      path.dirname(relative),
      `${path.basename(filePath)}.context.md`
    );
  }

  private async generateText(prompt: string): Promise<string> {
    if (this.options.provider === 'anthropic') {
      return this.callAnthropic(prompt);
    }
    return this.callCopilot(prompt);
  }

  private async callAnthropic(prompt: string): Promise<string> {
    if (!this.anthropicClient) {
      throw new Error('Anthropic client not initialized — check your API key in Settings.');
    }
    const model = this.options.anthropicModel || 'claude-haiku-4-5-20251001';
    const response = await this.anthropicClient.messages.create({
      model,
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    return (response.content[0] as { type: string; text: string }).text;
  }

  private async callCopilot(prompt: string): Promise<string> {
    const model = await this.selectCopilotModel();

    const token = new vscode.CancellationTokenSource().token;
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      { justification: 'TrishAI generates a context summary for this source file to improve AI-assisted development.' },
      token
    );

    let text = '';
    for await (const chunk of response.text) {
      text += chunk;
    }
    return text;
  }

  // Selects and caches a Copilot model for the lifetime of this generator instance.
  private async selectCopilotModel(): Promise<vscode.LanguageModelChat> {
    if (this.cachedCopilotModel) {
      return this.cachedCopilotModel;
    }

    const family = this.options.copilotModelFamily?.trim();
    let models: vscode.LanguageModelChat[] = [];

    if (family) {
      models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
    }

    if (models.length === 0) {
      // Fall back to any available Copilot model
      models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    }

    if (models.length === 0) {
      throw new Error(
        family
          ? `Copilot model family "${family}" not found and no other Copilot models are available. Make sure GitHub Copilot is installed and signed in.`
          : 'No Copilot language models available. Make sure GitHub Copilot is installed and signed in.'
      );
    }

    this.cachedCopilotModel = models[0];
    return this.cachedCopilotModel;
  }

  async generateForFile(rootPath: string, filePath: string): Promise<void> {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(rootPath, filePath);

    const text = await this.generateText(CONTEXT_PROMPT(relativePath, fileContent));

    const contextContent = [
      `# Context: \`${relativePath}\``,
      `*Generated: ${new Date().toISOString()}*`,
      `*Provider: ${this.modelLabel()}*`,
      '',
      text,
    ].join('\n');

    const targetPath = ContextGenerator.getContextPath(rootPath, filePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, contextContent);
  }

  async generateForFolder(rootPath: string, folderPath: string): Promise<number> {
    let count = 0;
    try {
      const entries = fs.readdirSync(folderPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(folderPath, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'build', '.git', '.vscode', '.trishAI'].includes(entry.name)) {
            count += await this.generateForFolder(rootPath, fullPath);
          }
        } else if (
          entry.isFile() &&
          /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
        ) {
          await this.generateForFile(rootPath, fullPath);
          count++;
        }
      }
    } catch (err) {
      console.error(`Error generating context for ${folderPath}:`, err);
      throw err;
    }
    return count;
  }

  private modelLabel(): string {
    if (this.options.provider === 'anthropic') {
      return `Anthropic / ${this.options.anthropicModel || 'claude-haiku-4-5-20251001'}`;
    }
    const family = this.options.copilotModelFamily?.trim();
    const resolved = this.cachedCopilotModel
      ? `${this.cachedCopilotModel.family} (${this.cachedCopilotModel.name})`
      : family || 'auto';
    return `Copilot / ${resolved}`;
  }
}

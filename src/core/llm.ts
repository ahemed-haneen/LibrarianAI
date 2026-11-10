import Anthropic from '@anthropic-ai/sdk';

/** Minimal text-completion interface; implemented by Copilot (VS Code), Anthropic, and OpenAI-compatible APIs. */
export interface LlmClient {
  readonly label: string;
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Prompt used to summarise one file. It is given the skeleton (already extracted for free)
 * plus the source, and asked for a short answer — summaries are cached until the file's
 * public API (or content, depending on policy) changes.
 */
export function contextPrompt(relativePath: string, skeleton: string, source: string): string {
  return `You are indexing a codebase so AI agents can find the right files with minimal reading.
Summarise this file for that index.

File: ${relativePath}

Public surface (already extracted):
\`\`\`
${skeleton || '(no exports)'}
\`\`\`

Source:
\`\`\`
${source}
\`\`\`

Reply in markdown with exactly these sections, under 180 words total:
**Summary** — one or two sentences: what the file does and its role.
**Responsibilities** — up to 5 bullets.
**Use when** — up to 4 bullets describing kinds of tasks that would need to change or read this file (use domain words a developer would type).
**Gotchas** — up to 2 bullets of non-obvious behaviour, or "None".
Do not repeat the signatures.`;
}

export class AnthropicClient implements LlmClient {
  private client: Anthropic;
  readonly label: string;

  constructor(apiKey: string, private model: string) {
    this.client = new Anthropic({ apiKey });
    this.label = `Anthropic / ${model}`;
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const res = await this.client.messages.create(
      {
        model: this.model,
        // Room for the model's (adaptive) thinking plus a ~180-word answer.
        max_tokens: 2000,
        // A file summary is simple work: low effort keeps it cheap.
        output_config: { effort: 'low' },
        messages: [{ role: 'user', content: prompt }],
      },
      { signal }
    );
    if (res.stop_reason === 'refusal') {
      throw new Error('model declined to summarise this file');
    }
    return res.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
  }
}

/**
 * Any OpenAI-compatible chat-completions endpoint: GitHub Models (default for CI, authenticates
 * with the workflow's GITHUB_TOKEN), Azure OpenAI v1 endpoints, or an internal gateway.
 */
export class OpenAICompatibleClient implements LlmClient {
  readonly label: string;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    labelPrefix = 'OpenAI-compatible'
  ) {
    this.label = `${labelPrefix} / ${model}`;
  }

  async complete(prompt: string, signal?: AbortSignal): Promise<string> {
    const url = this.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'api-key': this.apiKey,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 500,
          temperature: 0.2,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (res.status === 429 && attempt < 4) {
        const wait = Number(res.headers.get('retry-after')) || 2 ** attempt * 5;
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      if (!res.ok) {
        throw new Error(`${this.label}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      return (json.choices?.[0]?.message?.content ?? '').trim();
    }
  }
}

export const GITHUB_MODELS_URL = 'https://models.github.ai/inference';

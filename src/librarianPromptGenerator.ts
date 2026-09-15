import * as fs from 'fs';
import * as path from 'path';

interface SkeletonEntry {
  relativePath: string;
  content: string;
  score: number;
}

const STOP_WORDS = new Set([
  // English
  'a', 'an', 'the', 'is', 'in', 'it', 'of', 'to', 'and', 'or', 'for',
  'with', 'this', 'that', 'are', 'was', 'be', 'as', 'on', 'at', 'by',
  'from', 'which', 'not', 'but', 'what', 'how', 'do', 'i', 'we', 'you',
  'have', 'has', 'had', 'would', 'should', 'could', 'will', 'when', 'if',
  'all', 'its', 'into', 'then', 'than', 'so', 'also', 'just', 'more',
  // Code noise — appears in almost every skeleton so adds no signal
  'get', 'set', 'new', 'use', 'add', 'type', 'class', 'export', 'import',
  'return', 'function', 'const', 'let', 'var', 'from', 'void', 'any',
  'true', 'false', 'string', 'number', 'boolean', 'object', 'array',
  'promise', 'async', 'await', 'static', 'public', 'private', 'readonly',
]);

export class LibrarianPromptGenerator {
  constructor(private workspaceRoot: string) {}

  generate(task: string): { prompt: string; matchCount: number } {
    const skeletons = this.collectSkeletons();

    if (skeletons.length === 0) {
      return {
        prompt: this.buildNoSkeletonsPrompt(task),
        matchCount: 0,
      };
    }

    const taskTokens = this.tokenize(task);
    const taskLower = task.toLowerCase();

    const scored = skeletons.map((s) => ({
      ...s,
      score: this.scoreRelevance(taskTokens, taskLower, s),
    }));

    scored.sort((a, b) => b.score - a.score);

    // Top 8 by score (must have score > 0), plus hard-include filename matches
    const seen = new Set<string>();
    const relevant: SkeletonEntry[] = [];

    for (const s of scored) {
      if (s.score > 0 && relevant.length < 8) {
        relevant.push(s);
        seen.add(s.relativePath);
      }
    }

    // Hard-include files whose stem appears verbatim in the task text
    for (const s of skeletons) {
      if (seen.has(s.relativePath)) continue;
      const stem = path.basename(s.relativePath, path.extname(s.relativePath)).toLowerCase();
      if (stem.length > 2 && taskLower.includes(stem)) {
        relevant.push(s);
        seen.add(s.relativePath);
      }
    }

    return {
      prompt: this.buildPrompt(task, relevant, skeletons.length),
      matchCount: relevant.length,
    };
  }

  private collectSkeletons(): SkeletonEntry[] {
    const trishAIDir = path.join(this.workspaceRoot, '.trishAI');
    if (!fs.existsSync(trishAIDir)) return [];

    const entries: SkeletonEntry[] = [];
    this.walkDir(trishAIDir, (filePath) => {
      if (!filePath.endsWith('.skeleton.md')) return;
      const content = fs.readFileSync(filePath, 'utf8');
      // .trishAI/src/foo.ts.skeleton.md  →  src/foo.ts
      const rel = path.relative(trishAIDir, filePath).replace(/\.skeleton\.md$/, '');
      entries.push({ relativePath: rel, content, score: 0 });
    });
    return entries;
  }

  private walkDir(dir: string, cb: (filePath: string) => void): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walkDir(full, cb);
      } else {
        cb(full);
      }
    }
  }

  private tokenize(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
    );
  }

  private splitCamelCase(text: string): Set<string> {
    const tokens = new Set<string>();
    for (const word of text.split(/[^a-zA-Z0-9]+/)) {
      const parts = word.replace(/([A-Z])/g, ' $1').toLowerCase().split(/\s+/);
      for (const p of parts) {
        if (p.length >= 3 && !STOP_WORDS.has(p)) {
          tokens.add(p);
        }
      }
    }
    return tokens;
  }

  private scoreRelevance(taskTokens: Set<string>, taskLower: string, skeleton: SkeletonEntry): number {
    if (taskTokens.size === 0) return 0;

    const skeletonText = `${skeleton.content} ${skeleton.relativePath}`;
    const skeletonTokens = this.tokenize(skeletonText);
    const camelTokens = this.splitCamelCase(skeletonText);

    let score = 0;
    for (const t of taskTokens) {
      if (skeletonTokens.has(t)) score += 1;
      else if (camelTokens.has(t)) score += 0.5;
    }

    // Filename stem boost
    const stem = path.basename(skeleton.relativePath, path.extname(skeleton.relativePath)).toLowerCase();
    if (stem.length > 2 && taskLower.includes(stem)) {
      score += 3;
    }

    return score;
  }

  private extractTypeScriptBlock(content: string): string {
    const match = content.match(/```typescript([\s\S]*?)```/);
    return match ? match[1].trim() : content.trim();
  }

  private buildPrompt(task: string, relevant: SkeletonEntry[], totalIndexed: number): string {
    const lines: string[] = [];
    const ts = new Date().toISOString();

    lines.push('# LibrarianAI — Task Prompt');
    lines.push(`*Generated: ${ts}*`);
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Task');
    lines.push('');
    lines.push(task.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('## Codebase Context');
    lines.push('');
    lines.push(
      `${totalIndexed} source file${totalIndexed !== 1 ? 's' : ''} are pre-indexed as skeletons in \`.trishAI/\`.`
    );
    lines.push(
      'Use the signatures below to understand the codebase structure. Only open full source files if you need implementation details beyond what the skeleton shows.'
    );
    lines.push('');
    lines.push('---');
    lines.push('');

    if (relevant.length === 0) {
      lines.push('## Relevant File Skeletons');
      lines.push('');
      lines.push('_No closely matching skeletons found for this task. Consider generating skeletons for more files._');
    } else {
      lines.push(`## Relevant File Skeletons (${relevant.length} file${relevant.length !== 1 ? 's' : ''} matched)`);
      lines.push('');
      for (const s of relevant) {
        lines.push(`### \`${s.relativePath}\``);
        lines.push('');
        const block = this.extractTypeScriptBlock(s.content);
        lines.push('```typescript');
        lines.push(block);
        lines.push('```');
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('## Working Instructions');
    lines.push('');
    lines.push('- Use the skeleton signatures above to identify which files to touch **before** opening any source file.');
    lines.push('- For any file not listed here, check `.trishAI/<path>/<file>.skeleton.md` first.');
    lines.push('- Make the minimal targeted edits needed to complete the task.');
    lines.push('- If a skeleton is missing or outdated, note it — do not assume the skeleton is the full truth.');

    return lines.join('\n');
  }

  private buildNoSkeletonsPrompt(task: string): string {
    return [
      '# LibrarianAI — Task Prompt',
      '',
      '## Task',
      '',
      task.trim(),
      '',
      '---',
      '',
      '## Note',
      '',
      'No skeleton files found in `.trishAI/`. Open the **TrishAI Context Tracker** sidebar in VS Code',
      'and use the ⚡ button to generate skeletons for your source files first.',
      'Once indexed, re-submit this task to get a context-optimised prompt.',
    ].join('\n');
  }
}

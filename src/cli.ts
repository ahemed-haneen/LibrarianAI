#!/usr/bin/env node
/**
 * Librarian CLI — the same core the VS Code extension uses, without VS Code.
 * Used by CI to build the firm-wide shared index on every merge, and as an MCP server.
 */
import * as path from 'path';
import { installCopilotInstructions } from './core/copilotInstructions';
import { ContextPolicy, LayerName } from './core/indexStore';
import { runIndex } from './core/indexer';
import { Librarian } from './core/librarian';
import { AnthropicClient, GITHUB_MODELS_URL, LlmClient, OpenAICompatibleClient } from './core/llm';
import { runMcpServer } from './core/mcpServer';
import { NoteStore } from './core/notes';
import { estimateSavings } from './core/savings';
import { changedSince } from './core/sourceFiles';
import { learnFromGit } from './core/taskMemory';

const VERSION = '0.3.0';

const HELP = `librarian ${VERSION}

Usage: librarian <command> [options]

Commands
  index      Build/refresh the index (incremental: unchanged files are skipped)
  learn      Learn task -> files mappings from git history (merged PRs)
  query      Print the context pack for a task
  status     Show index coverage and freshness
  estimate   Estimate token savings by replaying past tasks from git history
  notes      List/search saved notes:  notes [query]
  note       Save a note:              note "<title>" --summary "<text>" [--files a.ts,b.ts] [--layer shared]
  mcp        Run as an MCP server on stdio
  install-instructions   Add/refresh the Librarian block in .github/copilot-instructions.md

Common options
  --root <dir>              Repository root (default: cwd)
  --layer shared|local      Index layer to write (default: shared)

index options
  --changed-since <ref>     Only re-index files changed between <ref> and HEAD
  --force                   Regenerate even if hashes match
  --provider <p>            github-models | openai | anthropic | none (default: none)
  --model <id>              Model id (github-models default: openai/gpt-4.1-mini)
  --base-url <url>          Endpoint for --provider openai (e.g. Azure OpenAI /openai/v1)
  --policy <p>              onApiChange (default) | onSourceChange — when summaries are refreshed
  --concurrency <n>         Parallel model calls (default 3)
  --max-file-kb <n>         Skip summaries for files larger than this (default 100)

learn options
  --range <a..b> | --commit <sha> | --last <n>

query / estimate options
  --budget <tokens>         Token budget (default 6000)
  --commits <n>             (estimate) recent commits to replay (default 50)
  --price <usd>             (estimate) input price per 1M tokens, for an indicative cost

Environment
  GITHUB_TOKEN              for github-models (Actions: permissions: models: read)
  ANTHROPIC_API_KEY         for anthropic
  LIBRARIAN_API_KEY         for openai-compatible endpoints
`;

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; rest: string[] } {
  const [cmd = 'help', ...tail] = argv;
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      rest.push(a);
    }
  }
  return { cmd, flags, rest };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function makeLlm(flags: Record<string, string | boolean>): LlmClient | undefined {
  const provider = str(flags.provider) ?? 'none';
  switch (provider) {
    case 'none':
      return undefined;
    case 'github-models': {
      const token = process.env.GITHUB_TOKEN;
      if (!token) {
        throw new Error('GITHUB_TOKEN is required for --provider github-models');
      }
      return new OpenAICompatibleClient(str(flags['base-url']) ?? GITHUB_MODELS_URL, token, str(flags.model) ?? 'openai/gpt-4.1-mini', 'GitHub Models');
    }
    case 'openai': {
      const key = process.env.LIBRARIAN_API_KEY ?? process.env.OPENAI_API_KEY;
      const base = str(flags['base-url']) ?? process.env.LIBRARIAN_BASE_URL;
      if (!key || !base) {
        throw new Error('--provider openai needs LIBRARIAN_API_KEY and --base-url (or LIBRARIAN_BASE_URL)');
      }
      return new OpenAICompatibleClient(base, key, str(flags.model) ?? 'gpt-4.1-mini');
    }
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) {
        throw new Error('ANTHROPIC_API_KEY is required for --provider anthropic');
      }
      return new AnthropicClient(key, str(flags.model) ?? 'claude-haiku-5-5');
    }
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}

async function main(): Promise<number> {
  const { cmd, flags, rest } = parseArgs(process.argv.slice(2));
  const root = path.resolve(str(flags.root) ?? process.cwd());
  const layer = (str(flags.layer) ?? 'shared') as LayerName;

  switch (cmd) {
    case 'index': {
      let files: string[] | undefined;
      let deleted: string[] | undefined;
      const since = str(flags['changed-since']);
      if (since && !/^0+$/.test(since)) {
        try {
          ({ changed: files, deleted } = changedSince(root, since));
          console.log(`Changed since ${since.slice(0, 12)}: ${files.length} source file(s), ${deleted.length} deleted`);
        } catch (err) {
          console.warn(`Could not diff against ${since} (${(err as Error).message.split('\n')[0]}); falling back to a full incremental scan.`);
        }
      }
      const llm = makeLlm(flags);
      const started = Date.now();
      const r = await runIndex({
        root,
        layer,
        files,
        deleted,
        llm,
        force: !!flags.force,
        policy: (str(flags.policy) ?? 'onApiChange') as ContextPolicy,
        concurrency: Number(str(flags.concurrency) ?? 3),
        maxContextBytes: Number(str(flags['max-file-kb']) ?? 100) * 1024,
        onProgress: (done, total, file) => {
          if (process.stdout.isTTY) {
            process.stdout.write(`\r${done}/${total} ${file.slice(-60).padEnd(60)}`);
          }
        },
      });
      if (process.stdout.isTTY) {
        process.stdout.write('\n');
      }
      console.log(
        [
          `Scanned ${r.scanned} file(s) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          `skeletons: ${r.skeletonsWritten} written, ${r.skeletonsUnchanged} unchanged`,
          `summaries: ${r.contextsGenerated} generated (${llm?.label ?? 'no provider'}), ${r.contextsReused} reused, ${r.contextsSkippedTooLarge} skipped (too large)`,
          `removed: ${r.removed}`,
        ].join('\n')
      );
      r.errors.slice(0, 20).forEach((e) => console.error(`  ✗ ${e.path}: ${e.message}`));
      // Summary failures should not fail the merge pipeline; skeletons are still useful.
      return r.errors.length && r.skeletonsWritten + r.skeletonsUnchanged === 0 ? 1 : 0;
    }
    case 'learn': {
      const range = str(flags.range) ?? str(flags.commit) ?? str(flags.last) ?? 'HEAD';
      const r = learnFromGit(root, range, layer);
      console.log(`Learnt ${r.added} task(s) from git (${r.skipped} skipped)`);
      return 0;
    }
    case 'query': {
      const task = rest.join(' ').trim();
      if (!task) {
        console.error('Usage: librarian query "<task>"');
        return 2;
      }
      const r = new Librarian(root).findRelevant(task, { budget: Number(str(flags.budget) ?? 6000) });
      console.log(r.prompt);
      console.error(`\n~${r.deliveredTokens} tokens (vs ~${r.fullFileTokens} if the ${r.files.length} files were read in full)`);
      return 0;
    }
    case 'estimate': {
      const lib = new Librarian(root);
      if (lib.view.allPaths().length === 0) {
        console.error('Building skeletons first (free)...');
        await runIndex({ root, layer });
      }
      const r = await estimateSavings(new Librarian(root), {
        commits: Number(str(flags.commits) ?? 50),
        budget: Number(str(flags.budget) ?? 6000),
        costPerMillionTokens: str(flags.price) ? Number(str(flags.price)) : undefined,
      });
      console.log(r.markdown);
      return 0;
    }
    case 'notes': {
      const lib = new Librarian(root);
      const q = rest.join(' ').trim();
      const hits = q ? lib.notes.search(q, 10, 0.05) : lib.notes.all().slice(0, 20);
      console.log(hits.length ? hits.map((h) => NoteStore.render(h.note, h.layer)).join('\n') : 'No saved notes.');
      return 0;
    }
    case 'note': {
      const title = rest.join(' ').trim();
      const summary = str(flags.summary);
      if (!title || !summary) {
        console.error('Usage: librarian note "<title>" --summary "<text>" [--files a.ts,b.ts] [--layer local|shared]');
        return 2;
      }
      const files = (str(flags.files) ?? '').split(',').filter(Boolean);
      const r = new Librarian(root).notes.save({ title, summary, files, source: 'manual' }, (str(flags.layer) ?? 'local') as LayerName);
      console.log(`${r.updated ? 'Updated' : 'Saved'} note ${r.note.id}: ${r.note.title}`);
      return 0;
    }
    case 'status':
      console.log(new Librarian(root).status().text);
      return 0;
    case 'mcp':
      runMcpServer(root, VERSION);
      return -1; // keep running
    case 'install-instructions': {
      const r = installCopilotInstructions(root);
      console.log(`${r.action}: ${path.relative(root, r.file)}`);
      return 0;
    }
    case 'version':
    case '--version':
      console.log(VERSION);
      return 0;
    default:
      console.log(HELP);
      return cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
}

main().then(
  (code) => {
    if (code >= 0) {
      process.exitCode = code;
    }
  },
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
);

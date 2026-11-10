import * as vscode from 'vscode';
import { installCopilotInstructions } from './core/copilotInstructions';
import { ContextPolicy, LayerName } from './core/indexStore';
import { IndexResult, runIndex } from './core/indexer';
import { Librarian } from './core/librarian';
import { AnthropicClient, LlmClient } from './core/llm';
import { isSourcePath, listSourceFiles } from './core/sourceFiles';
import { learnFromGit } from './core/taskMemory';
import { relPosix } from './core/util';
import { CoverageNode, CoverageTreeProvider } from './coverageTreeProvider';
import { LibrarianPanel } from './librarianPanel';
import { registerChatParticipant } from './vscode/chatParticipant';
import { CopilotLlm } from './vscode/copilotLlm';
import { registerLmTools } from './vscode/lmTools';
import { TaskTracker } from './vscode/taskTracker';

const SECRET_KEY = 'trishAI.anthropicApiKey';

function cfg() {
  return vscode.workspace.getConfiguration('trishAI');
}

async function makeLlm(context: vscode.ExtensionContext): Promise<LlmClient | { error: string }> {
  const provider = cfg().get<string>('aiProvider', 'copilot');
  if (provider === 'none') {
    return { error: 'AI provider is set to "none" — only skeletons were generated.' };
  }
  if (provider === 'anthropic') {
    const key = (await context.secrets.get(SECRET_KEY))?.trim();
    if (!key) {
      return { error: 'No Anthropic API key stored. Run "Librarian: Set Anthropic API Key", or switch the provider to "copilot".' };
    }
    return new AnthropicClient(key, cfg().get<string>('anthropicModel', 'claude-haiku-5-5'));
  }
  return new CopilotLlm(cfg().get<string[]>('copilotModelFamilies', ['gpt-4.1', 'gpt-5-mini', 'gpt-4o-mini', 'gpt-4o']));
}

/** Move a key from the old plain-text setting into SecretStorage (once). */
async function migrateApiKey(context: vscode.ExtensionContext): Promise<void> {
  const legacy = cfg().get<string>('anthropicApiKey', '').trim();
  if (legacy && !(await context.secrets.get(SECRET_KEY))) {
    await context.secrets.store(SECRET_KEY, legacy);
    vscode.window
      .showWarningMessage(
        'Librarian moved your Anthropic API key into secure storage. Remove it from settings.json so it is not synced or committed.',
        'Open Settings'
      )
      .then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', 'trishAI.anthropicApiKey'));
  }
}

function summarise(r: IndexResult, llmLabel?: string): string {
  const parts = [
    `${r.skeletonsWritten} skeleton(s) updated, ${r.skeletonsUnchanged} unchanged`,
    llmLabel ? `${r.contextsGenerated} summar${r.contextsGenerated === 1 ? 'y' : 'ies'} via ${llmLabel}, ${r.contextsReused} reused` : undefined,
    r.contextsSkippedTooLarge ? `${r.contextsSkippedTooLarge} too large to summarise` : undefined,
    r.errors.length ? `${r.errors.length} error(s)` : undefined,
    r.cancelled ? 'cancelled' : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

export function activate(context: vscode.ExtensionContext) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const policy = () => cfg().get<ContextPolicy>('contextRefreshPolicy', 'onApiChange');
  const layer = () => cfg().get<LayerName>('writeLayer', 'local');
  const budget = () => cfg().get<number>('promptTokenBudget', 6000);

  let librarian: Librarian | undefined = root ? new Librarian(root, policy()) : undefined;
  const lib = () => librarian;
  const tracker = root && librarian ? new TaskTracker(root, librarian.memory, () => cfg().get<boolean>('learning.enabled', true)) : undefined;

  const tree = new CoverageTreeProvider(root, lib);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('trishAICoverageView', tree));
  const refreshTree = () => tree.refresh();

  void migrateApiKey(context);

  // ---- indexing ----
  const index = async (opts: { files?: string[]; force?: boolean; withAi?: boolean; title: string; silent?: boolean }) => {
    if (!root) {
      vscode.window.showWarningMessage('Open a workspace folder first.');
      return;
    }
    let llm: LlmClient | undefined;
    let warn: string | undefined;
    if (opts.withAi !== false) {
      const made = await makeLlm(context);
      if ('error' in made) {
        warn = made.error;
      } else {
        llm = made;
      }
    }
    const abort = new AbortController();
    const result = await vscode.window.withProgress(
      {
        location: opts.silent ? vscode.ProgressLocation.Window : vscode.ProgressLocation.Notification,
        title: `Librarian: ${opts.title}`,
        cancellable: !opts.silent,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => abort.abort());
        let last = 0;
        return runIndex({
          root,
          layer: layer(),
          files: opts.files,
          force: opts.force,
          llm,
          policy: policy(),
          concurrency: cfg().get<number>('concurrency', 2),
          maxContextBytes: cfg().get<number>('maxFileSizeKB', 100) * 1024,
          signal: abort.signal,
          onProgress: (done, total, file) => {
            const pct = total ? (done / total) * 100 : 0;
            progress.report({ message: `${done}/${total} ${file}`, increment: Math.max(0, pct - last) });
            last = pct;
          },
        });
      }
    );
    librarian = new Librarian(root, policy());
    refreshTree();
    if (opts.silent && !result.errors.length) {
      return;
    }
    const msg = summarise(result, llm?.label);
    if (warn) {
      vscode.window.showWarningMessage(`${msg}. ${warn}`, 'Open Settings').then((c) => c && vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trinet-ai-smart-assist'));
    } else if (result.errors.length) {
      const detail = result.errors.slice(0, 3).map((e) => `${e.path}: ${e.message}`).join('; ');
      vscode.window.showErrorMessage(`${msg}. ${detail}`);
    } else {
      vscode.window.showInformationMessage(msg);
    }
  };

  const filesFor = (node?: CoverageNode): string[] | undefined => {
    if (!root) {
      return undefined;
    }
    let rel = node?.rel;
    if (rel === undefined) {
      const ed = vscode.window.activeTextEditor;
      if (!ed) {
        return undefined;
      }
      rel = relPosix(root, ed.document.uri.fsPath);
      return isSourcePath(rel) ? [rel] : [];
    }
    if (node?.isFileNode) {
      return [rel];
    }
    return listSourceFiles(root).filter((f) => f.startsWith(rel + '/'));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('trishAI.generateSkeleton', (node?: CoverageNode) =>
      index({ files: filesFor(node), title: `indexing ${node?.label ?? 'current file'}` })
    ),
    vscode.commands.registerCommand('trishAI.updateSkeleton', (node?: CoverageNode) =>
      index({ files: filesFor(node), force: true, title: `re-indexing ${node?.label ?? 'current file'}` })
    ),
    vscode.commands.registerCommand('trishAI.indexWorkspace', () => index({ title: 'indexing workspace (only changed files cost anything)' })),
    vscode.commands.registerCommand('trishAI.indexSkeletonsOnly', () => index({ title: 'building skeletons (no AI)', withAi: false })),
    vscode.commands.registerCommand('trishAI.refreshStale', () => index({ title: 'refreshing stale entries' })),
    vscode.commands.registerCommand('trishAICoverageView.refresh', refreshTree),

    vscode.commands.registerCommand('trishAI.askLibrarian', () => {
      if (!librarian) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      LibrarianPanel.show(context, librarian, tracker, budget(), refreshTree);
    }),

    vscode.commands.registerCommand('trishAI.installCopilotInstructions', async () => {
      if (!root) {
        return;
      }
      const r = installCopilotInstructions(root);
      const doc = await vscode.workspace.openTextDocument(r.file);
      await vscode.window.showTextDocument(doc);
      vscode.window.showInformationMessage(`Copilot instructions ${r.action}. Copilot will now consult the Librarian index first.`);
    }),

    vscode.commands.registerCommand('trishAI.setAnthropicApiKey', async () => {
      const key = await vscode.window.showInputBox({ prompt: 'Anthropic API key (stored in VS Code secret storage)', password: true, ignoreFocusOut: true });
      if (key !== undefined) {
        if (key.trim()) {
          await context.secrets.store(SECRET_KEY, key.trim());
          vscode.window.showInformationMessage('Anthropic API key saved securely.');
        } else {
          await context.secrets.delete(SECRET_KEY);
          vscode.window.showInformationMessage('Anthropic API key removed.');
        }
      }
    }),

    vscode.commands.registerCommand('trishAI.learnFromCommits', async () => {
      if (!root) {
        return;
      }
      const n = await vscode.window.showInputBox({ prompt: 'Learn from how many recent commits?', value: '50', validateInput: (v) => (/^\d+$/.test(v) ? undefined : 'Enter a number') });
      if (!n) {
        return;
      }
      try {
        const r = learnFromGit(root, n, 'local');
        vscode.window.showInformationMessage(`Librarian learnt ${r.added} task(s) from git history (${r.skipped} skipped).`);
      } catch (err) {
        vscode.window.showErrorMessage(`Could not read git history: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
      }
      librarian = new Librarian(root, policy());
    }),

    vscode.commands.registerCommand('trishAI.showStatus', () => {
      if (librarian) {
        vscode.window.showInformationMessage(librarian.status().text.replace(/\n/g, ' · '), { modal: false });
      }
    }),

    vscode.commands.registerCommand('trishAI.showFeatures', () =>
      vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'FEATURES.md'))
    )
  );

  // ---- Copilot integration ----
  context.subscriptions.push(...registerLmTools(lib, () => tracker, refreshTree));
  context.subscriptions.push(registerChatParticipant(lib, () => tracker, budget, refreshTree));
  if (tracker) {
    context.subscriptions.push(tracker);
  }

  // ---- keep skeletons fresh on save (free) ----
  let pending = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!root || !cfg().get<boolean>('autoUpdateSkeletons', true) || doc.uri.scheme !== 'file') {
        return;
      }
      const rel = relPosix(root, doc.uri.fsPath);
      if (rel.startsWith('..') || !isSourcePath(rel)) {
        return;
      }
      pending.add(rel);
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const files = [...pending];
        pending = new Set();
        await runIndex({ root, layer: layer(), files, policy: policy() });
        refreshTree();
      }, 1500);
    }),
    { dispose: () => clearTimeout(timer) },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (root && e.affectsConfiguration('trishAI')) {
        librarian = new Librarian(root, policy());
        refreshTree();
      }
    })
  );

  // ---- free background skeleton pass on startup ----
  if (root && cfg().get<boolean>('autoIndexOnStartup', true)) {
    setTimeout(() => void index({ title: 'updating skeletons', withAi: false, silent: true }), 3000);
  }
}

export function deactivate() {}

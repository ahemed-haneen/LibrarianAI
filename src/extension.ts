import * as vscode from 'vscode';
import { installCopilotInstructions } from './core/copilotInstructions';
import { ContextPolicy, LayerName } from './core/indexStore';
import { IndexResult, runIndex } from './core/indexer';
import { Librarian } from './core/librarian';
import { AnthropicClient, LlmClient } from './core/llm';
import { isSourcePath, listSourceFiles } from './core/sourceFiles';
import { NoteStore } from './core/notes';
import { learnFromGit } from './core/taskMemory';
import { relPosix } from './core/util';
import { CoverageNode, CoverageTreeProvider } from './coverageTreeProvider';
import { LibrarianPanel } from './librarianPanel';
import { registerChatParticipant } from './vscode/chatParticipant';
import { CopilotLlm } from './vscode/copilotLlm';
import { SETUP_DONE_KEY, SetupPanel } from './vscode/setupPanel';
import { estimateSavings } from './core/savings';
import { registerLmTools } from './vscode/lmTools';
import { TaskTracker } from './vscode/taskTracker';

const SECRET_KEY = 'trishAI.anthropicApiKey';

function cfg() {
  return vscode.workspace.getConfiguration('trishAI');
}

async function makeLlm(context: vscode.ExtensionContext): Promise<LlmClient | { error: string; needsSetup?: boolean }> {
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
  const modelId = cfg().get<string>('copilotModel', '').trim();
  if (!modelId) {
    // Never pick a model on the user's behalf: it could be a premium one.
    return { error: 'No Copilot model chosen for summaries yet, so only free skeletons were built.', needsSetup: true };
  }
  return new CopilotLlm(modelId);
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

  let librarian: Librarian | undefined = root ? new Librarian(root, policy(), cfg().get<boolean>('notes.enabled', true)) : undefined;
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
    let needsSetup = false;
    if (opts.withAi !== false) {
      const made = await makeLlm(context);
      if ('error' in made) {
        warn = made.error;
        needsSetup = !!made.needsSetup;
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
    librarian = new Librarian(root, policy(), cfg().get<boolean>('notes.enabled', true));
    refreshTree();
    if (opts.silent && !result.errors.length) {
      return;
    }
    const msg = summarise(result, llm?.label);
    if (warn) {
      const action = needsSetup ? 'Open Setup' : 'Open Settings';
      vscode.window.showWarningMessage(`${msg}. ${warn}`, action).then((c) => {
        if (c === 'Open Setup') {
          SetupPanel.show(context, refreshTree);
        } else if (c) {
          vscode.commands.executeCommand('workbench.action.openSettings', '@ext:trinet-ai-smart-assist');
        }
      });
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
      librarian = new Librarian(root, policy(), cfg().get<boolean>('notes.enabled', true));
    }),

    vscode.commands.registerCommand('trishAI.showStatus', () => {
      if (librarian) {
        vscode.window.showInformationMessage(librarian.status().text.replace(/\n/g, ' · '), { modal: false });
      }
    }),

    vscode.commands.registerCommand('trishAI.saveNote', async () => {
      if (!librarian) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const editor = vscode.window.activeTextEditor;
      const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';
      const source = await vscode.window.showQuickPick(
        [
          { label: '$(clippy) From clipboard', detail: 'Use “Copy All” in a chat (right-click the chat), then pick this', id: 'clip' },
          ...(selection ? [{ label: '$(selection) From editor selection', detail: `${selection.length.toLocaleString()} characters selected`, id: 'sel' }] : []),
          { label: '$(edit) Type it', detail: 'Write the decision, constraint or status to remember', id: 'type' },
        ],
        { title: 'Save context to Librarian memory', placeHolder: 'Where is the context?' }
      );
      if (!source) {
        return;
      }
      let text = source.id === 'clip' ? await vscode.env.clipboard.readText() : source.id === 'sel' ? selection : (await vscode.window.showInputBox({ prompt: 'What should future chats know?', ignoreFocusOut: true })) ?? '';
      text = text.trim();
      if (!text) {
        vscode.window.showWarningMessage(source.id === 'clip' ? 'The clipboard is empty. Use “Copy All” in the chat first.' : 'Nothing to save.');
        return;
      }
      let title = text.split('\n').find((l) => l.trim())!.replace(/^[#>*\-\s]+/, '').slice(0, 80);
      let files: string[] = [];
      if (text.length > 2500) {
        const made = await makeLlm(context);
        const label = 'error' in made ? undefined : made.label;
        const choice = await vscode.window.showQuickPick(
          [
            ...(label ? [{ label: `$(sparkle) Condense with ${label}`, detail: 'One request to the model you chose in Setup', id: 'condense' }] : []),
            { label: '$(save) Save as is', detail: 'Long notes take more of the context budget when reused', id: 'raw' },
            ...(!label ? [{ label: '$(gear) Choose a model first…', detail: 'Open Librarian Setup', id: 'setup' }] : []),
          ],
          { title: `This text is long (${text.length.toLocaleString()} characters)` }
        );
        if (!choice) {
          return;
        }
        if (choice.id === 'setup') {
          SetupPanel.show(context, refreshTree);
          return;
        }
        if (choice.id === 'condense' && !('error' in made)) {
          const out = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Librarian: condensing…' }, () =>
            made.complete(
              `Condense this conversation/context into a note a future AI chat can reuse to continue the work.\n` +
                `Reply exactly:\nTITLE: <short specific title>\nFILES: <comma-separated workspace-relative paths, or none>\nSUMMARY:\n` +
                `<markdown under 250 words: goal, decisions and why, constraints, tried/rejected, status, next steps>\n\n---\n${text.slice(-30000)}`
            )
          );
          title = /TITLE:\s*(.+)/i.exec(out)?.[1]?.trim() || title;
          files = (/FILES:\s*(.+)/i.exec(out)?.[1] ?? '').split(',').map((f) => f.trim().replace(/^`|`$/g, '')).filter((f) => f && f.toLowerCase() !== 'none');
          text = (/SUMMARY:\s*([\s\S]+)/i.exec(out)?.[1] ?? out).trim();
        }
      }
      const finalTitle = await vscode.window.showInputBox({ prompt: 'Title (saving with an existing title updates that note)', value: title, ignoreFocusOut: true });
      if (!finalTitle) {
        return;
      }
      const { note, updated } = librarian.notes.save({ title: finalTitle, summary: text, files, source: 'manual' });
      vscode.window.showInformationMessage(`${updated ? 'Updated' : 'Saved'} note “${note.title}”. Related future tasks will include it automatically.`);
      refreshTree();
    }),

    vscode.commands.registerCommand('trishAI.manageNotes', async () => {
      if (!librarian) {
        return;
      }
      const notes = librarian.notes.all();
      if (!notes.length) {
        vscode.window.showInformationMessage('No saved notes yet. Use “Librarian: Save Note to Memory”, @librarian /save, or #librarianSave in agent mode.');
        return;
      }
      const pick = await vscode.window.showQuickPick(
        notes.map(({ note, layer }) => ({
          label: note.title,
          description: `${layer === 'shared' ? '$(organization) team' : '$(person) personal'} · ${note.updatedAt.slice(0, 10)}`,
          detail: note.summary.replace(/\s+/g, ' ').slice(0, 140),
          note,
          layer,
        })),
        { title: 'Saved notes', matchOnDetail: true }
      );
      if (!pick) {
        return;
      }
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(open-preview) Open', id: 'open' },
          ...(pick.layer === 'local' ? [{ label: '$(organization) Share with team', detail: 'Moves it to .trishAI/shared (committed with the repo)', id: 'share' }] : []),
          { label: '$(trash) Delete', id: 'delete' },
        ],
        { title: pick.note.title }
      );
      if (action?.id === 'open') {
        const doc = await vscode.workspace.openTextDocument({ content: NoteStore.render(pick.note, pick.layer), language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } else if (action?.id === 'share') {
        librarian.notes.share(pick.note.id);
        vscode.window.showInformationMessage(`“${pick.note.title}” moved to the shared layer. Commit .trishAI/shared/notes.json to share it.`);
      } else if (action?.id === 'delete') {
        const ok = await vscode.window.showWarningMessage(`Delete “${pick.note.title}”?`, { modal: true }, 'Delete');
        if (ok) {
          librarian.notes.remove(pick.note.id);
        }
      }
      refreshTree();
    }),

    vscode.commands.registerCommand('trishAI.openSetup', () => SetupPanel.show(context, refreshTree)),

    vscode.commands.registerCommand('trishAI.estimateSavings', async () => {
      if (!root) {
        vscode.window.showWarningMessage('Open a workspace folder first.');
        return;
      }
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Librarian: estimating token savings from your history…' },
        async () => {
          await runIndex({ root, layer: layer(), policy: policy() }); // free: makes sure skeletons are current
          librarian = new Librarian(root, policy(), cfg().get<boolean>('notes.enabled', true));
          // Use the chosen model's own tokenizer when there is one (counting does not send a chat request).
          let count: ((t: string) => Promise<number>) | undefined;
          let tokenizerLabel: string | undefined;
          const modelId = cfg().get<string>('copilotModel', '').trim();
          if (cfg().get<string>('aiProvider') === 'copilot' && modelId) {
            const model = await CopilotLlm.find(modelId).catch(() => undefined);
            if (model) {
              count = async (t) => model.countTokens(t);
              tokenizerLabel = `${model.name} tokenizer`;
            }
          }
          const price = cfg().get<number>('costPerMillionTokens', 0);
          return estimateSavings(librarian, { budget: budget(), count, tokenizerLabel, costPerMillionTokens: price || undefined });
        }
      );
      const doc = await vscode.workspace.openTextDocument({ content: report.markdown, language: 'markdown' });
      await vscode.window.showTextDocument(doc, { preview: false });
      await vscode.commands.executeCommand('markdown.showPreviewToSide', doc.uri);
      refreshTree();
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
        librarian = new Librarian(root, policy(), cfg().get<boolean>('notes.enabled', true));
        refreshTree();
      }
    })
  );

  // ---- first run: make the user choose a model before any summary is generated ----
  const needsChoice =
    !context.globalState.get<boolean>(SETUP_DONE_KEY, false) &&
    cfg().get<string>('aiProvider', 'copilot') === 'copilot' &&
    !cfg().get<string>('copilotModel', '').trim();
  if (needsChoice) {
    setTimeout(() => SetupPanel.show(context, refreshTree), 1500);
  }

  // ---- free background skeleton pass on startup ----
  if (root && cfg().get<boolean>('autoIndexOnStartup', true)) {
    setTimeout(() => void index({ title: 'updating skeletons', withAi: false, silent: true }), 3000);
  }
}

export function deactivate() {}

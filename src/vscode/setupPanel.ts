import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { costHint, CostHint } from '../core/modelHints';

export const SETUP_DONE_KEY = 'trishAI.setupDone';

interface ModelInfo {
  id: string;
  name: string;
  family: string;
  version: string;
  maxInputTokens: number;
  hint: CostHint;
}

/**
 * First-run configuration page. Background summaries stay switched off until a provider, and for
 * Copilot one exact model, has been chosen here. Nothing is pre-selected.
 */
export class SetupPanel {
  private static current?: SetupPanel;
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, onSaved: () => void): void {
    if (SetupPanel.current) {
      SetupPanel.current.panel.reveal();
      void SetupPanel.current.sendModels();
      return;
    }
    const panel = vscode.window.createWebviewPanel('trishAI.setup', 'Librarian Setup', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    SetupPanel.current = new SetupPanel(panel, context, onSaved);
  }

  private constructor(panel: vscode.WebviewPanel, private context: vscode.ExtensionContext, private onSaved: () => void) {
    this.panel = panel;
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => (SetupPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.command) {
        case 'ready':
        case 'refresh':
          await this.sendModels();
          break;
        case 'setKey':
          await vscode.commands.executeCommand('trishAI.setAnthropicApiKey');
          break;
        case 'save':
          await this.save(msg);
          break;
        case 'run':
          await vscode.commands.executeCommand(msg.target);
          break;
      }
    });
  }

  private async sendModels(): Promise<void> {
    let models: ModelInfo[] = [];
    let error: string | undefined;
    try {
      const found = await vscode.lm.selectChatModels({ vendor: 'copilot' });
      models = found.map((m) => ({
        id: m.id,
        name: m.name,
        family: m.family,
        version: m.version,
        maxInputTokens: m.maxInputTokens,
        hint: costHint(m.family, m.name),
      }));
      const order = { low: 0, unknown: 1, premium: 2 };
      models.sort((a, b) => order[a.hint] - order[b.hint] || a.name.localeCompare(b.name));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const cfg = vscode.workspace.getConfiguration('trishAI');
    this.panel.webview.postMessage({
      command: 'models',
      models,
      error,
      current: {
        provider: cfg.get<string>('aiProvider', 'copilot'),
        copilotModel: cfg.get<string>('copilotModel', ''),
        anthropicModel: cfg.get<string>('anthropicModel', 'claude-haiku-5-5'),
        hasKey: !!(await this.context.secrets.get('trishAI.anthropicApiKey')),
        setupDone: this.context.globalState.get<boolean>(SETUP_DONE_KEY, false),
      },
    });
  }

  private async save(msg: { provider: string; copilotModel?: string; anthropicModel?: string }): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('trishAI');
    if (msg.provider === 'copilot' && !msg.copilotModel) {
      vscode.window.showWarningMessage('Pick a Copilot model first.');
      return;
    }
    const target = vscode.ConfigurationTarget.Global;
    await cfg.update('aiProvider', msg.provider, target);
    if (msg.provider === 'copilot') {
      await cfg.update('copilotModel', msg.copilotModel, target);
    }
    if (msg.provider === 'anthropic' && msg.anthropicModel) {
      await cfg.update('anthropicModel', msg.anthropicModel.trim(), target);
    }
    await this.context.globalState.update(SETUP_DONE_KEY, true);
    this.panel.webview.postMessage({ command: 'saved' });
    this.onSaved();
    vscode.window.showInformationMessage(
      msg.provider === 'none'
        ? 'Librarian will build skeletons only and never call a model.'
        : `Librarian will use ${msg.provider === 'copilot' ? msg.copilotModel : msg.anthropicModel} for background summaries, and nothing else.`
    );
  }

  private html(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    return /* html */ `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Librarian Setup</title>
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 20px 28px; max-width: 860px; line-height: 1.5; }
  h1 { font-size: 1.3em; margin: 0 0 4px; } h2 { font-size: 1.05em; margin: 22px 0 6px; }
  .muted { color: var(--vscode-descriptionForeground); font-size: .92em; }
  .card { border: 1px solid var(--vscode-widget-border, #444); border-radius: 4px; padding: 10px 12px; margin: 6px 0; cursor: pointer; display: flex; gap: 10px; align-items: flex-start; }
  .card:hover { background: var(--vscode-list-hoverBackground); }
  .card.selected { border-color: var(--vscode-focusBorder); background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .badge { font-size: .78em; padding: 1px 6px; border-radius: 8px; margin-left: 6px; white-space: nowrap; }
  .low { background: #2e7d3233; color: var(--vscode-charts-green); } .premium { background: #e6510033; color: var(--vscode-charts-orange); }
  .unknown { background: #8883; }
  table { border-collapse: collapse; width: 100%; } td { padding: 2px 6px; vertical-align: top; }
  button { padding: 6px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; cursor: pointer; margin-right: 8px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  input[type=text] { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, #555); padding: 4px 6px; width: 260px; }
  .warn { color: var(--vscode-editorWarning-foreground); } .hidden { display: none; }
  .done { border-left: 3px solid var(--vscode-charts-green); padding-left: 10px; }
</style></head>
<body>
<h1>📚 Librarian Setup</h1>
<p class="muted">Librarian writes a short summary of each source file once, so later Copilot requests need much less context.
Choose what writes those summaries. <b>Nothing is used until you save here</b>. Free skeletons keep working in the meantime.</p>

<h2>1. Provider</h2>
<div id="providers"></div>

<div id="copilotSection" class="hidden">
  <h2>2. Copilot model for background summaries</h2>
  <p class="muted">Summaries are simple work, so a small model is enough. Badges are a <b>hint from the model name only</b>:
  VS Code doesn't report premium-request multipliers, so check your firm's Copilot plan before choosing.
  Your <b>@librarian</b> chats always use the model you pick in the chat window, not this one.</p>
  <div id="models"></div>
  <p><button class="secondary" id="refresh">Refresh list</button></p>
</div>

<div id="anthropicSection" class="hidden">
  <h2>2. Anthropic</h2>
  <p>Model: <input type="text" id="anthropicModel"> <span class="muted">e.g. claude-haiku-5-5</span></p>
  <p><button class="secondary" id="setKey">Set API key (secure storage)</button> <span id="keyState" class="muted"></span></p>
</div>

<h2>3. Save</h2>
<p><button id="save" disabled>Save choice</button><span id="saveHint" class="muted"></span></p>

<div id="next" class="hidden done">
  <h2>Next steps</h2>
  <p><button id="estimate">Estimate token savings</button><button class="secondary" id="index">Index workspace</button><button class="secondary" id="instr">Install Copilot instructions</button></p>
  <p class="muted">The estimate replays your repository's past commits and takes a few seconds. No model requests are made.</p>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  let state = { provider: undefined, copilotModel: undefined, anthropicModel: '' };
  let models = [];
  const $ = (id) => document.getElementById(id);
  const providers = [
    { id: 'copilot', title: 'Firm\\'s GitHub Copilot', desc: 'Uses your signed-in Copilot. No API key. You pick the exact model below.' },
    { id: 'anthropic', title: 'Anthropic API', desc: 'Your own API key, stored in VS Code secret storage.' },
    { id: 'none', title: 'No AI: skeletons only', desc: 'Free and fully local. Retrieval still works, a little less precisely.' },
  ];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hintLabel = { low: 'usually low-cost', premium: 'usually premium', unknown: 'check your plan' };

  function render() {
    $('providers').innerHTML = providers.map((p) =>
      '<div class="card ' + (state.provider === p.id ? 'selected' : '') + '" data-provider="' + p.id + '"><div><b>' + esc(p.title) + '</b><br><span class="muted">' + esc(p.desc) + '</span></div></div>').join('');
    $('copilotSection').classList.toggle('hidden', state.provider !== 'copilot');
    $('anthropicSection').classList.toggle('hidden', state.provider !== 'anthropic');
    $('models').innerHTML = models.length
      ? models.map((m) => '<div class="card ' + (state.copilotModel === m.id ? 'selected' : '') + '" data-model="' + esc(m.id) + '"><div><b>' + esc(m.name) + '</b>' +
          '<span class="badge ' + m.hint + '">' + hintLabel[m.hint] + '</span><br><span class="muted">family ' + esc(m.family) + ' · id ' + esc(m.id) +
          (m.maxInputTokens ? ' · ' + Number(m.maxInputTokens).toLocaleString() + ' input tokens' : '') + '</span></div></div>').join('')
      : '<p class="warn">' + (window.modelError ? esc(window.modelError) : 'No Copilot models found. Make sure GitHub Copilot is installed and signed in, then refresh.') + '</p>';
    const ok = state.provider === 'none' || state.provider === 'anthropic' || (state.provider === 'copilot' && state.copilotModel);
    $('save').disabled = !ok;
    $('saveHint').textContent = ok ? '' : state.provider === 'copilot' ? '  Choose a model to continue.' : '  Choose a provider to continue.';
    document.querySelectorAll('[data-provider]').forEach((el) => el.addEventListener('click', () => { state.provider = el.dataset.provider; render(); }));
    document.querySelectorAll('[data-model]').forEach((el) => el.addEventListener('click', () => { state.copilotModel = el.dataset.model; render(); }));
  }

  $('refresh').addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
  $('setKey').addEventListener('click', () => vscode.postMessage({ command: 'setKey' }));
  $('anthropicModel').addEventListener('input', (e) => (state.anthropicModel = e.target.value));
  $('save').addEventListener('click', () => vscode.postMessage({ command: 'save', provider: state.provider, copilotModel: state.copilotModel, anthropicModel: state.anthropicModel }));
  $('estimate').addEventListener('click', () => vscode.postMessage({ command: 'run', target: 'trishAI.estimateSavings' }));
  $('index').addEventListener('click', () => vscode.postMessage({ command: 'run', target: 'trishAI.indexWorkspace' }));
  $('instr').addEventListener('click', () => vscode.postMessage({ command: 'run', target: 'trishAI.installCopilotInstructions' }));

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.command === 'models') {
      models = msg.models; window.modelError = msg.error;
      const c = msg.current;
      // Only restore choices the user has explicitly saved before; never pre-select on first run.
      if (c.setupDone && state.provider === undefined) {
        state.provider = c.provider;
        state.copilotModel = c.copilotModel || undefined;
      }
      if (!state.anthropicModel) { state.anthropicModel = c.anthropicModel; $('anthropicModel').value = c.anthropicModel; }
      $('keyState').textContent = c.hasKey ? 'A key is stored.' : 'No key stored yet.';
      $('next').classList.toggle('hidden', !c.setupDone);
      render();
    } else if (msg.command === 'saved') {
      $('next').classList.remove('hidden');
    }
  });
  render();
  vscode.postMessage({ command: 'ready' });
</script>
</body></html>`;
  }
}

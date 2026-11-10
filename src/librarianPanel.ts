import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { Librarian } from './core/librarian';
import { TaskTracker } from './vscode/taskTracker';

export class LibrarianPanel {
  static readonly viewType = 'trishAI.librarianPanel';

  private static instance: LibrarianPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, lib: Librarian, tracker: TaskTracker | undefined, budget: number, onUsed: () => void): void {
    if (LibrarianPanel.instance) {
      LibrarianPanel.instance.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      LibrarianPanel.viewType,
      'Ask Librarian',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    LibrarianPanel.instance = new LibrarianPanel(panel, lib, tracker, budget, onUsed);
    context.subscriptions.push(LibrarianPanel.instance.panel);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private lib: Librarian,
    private tracker: TaskTracker | undefined,
    private budget: number,
    private onUsed: () => void
  ) {
    this.panel = panel;
    this.panel.webview.html = this.buildHtml();

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.command === 'submit') {
        await this.handleSubmit(msg.task as string);
      }
    });

    this.panel.onDidDispose(() => {
      LibrarianPanel.instance = undefined;
    });
  }

  private async handleSubmit(task: string): Promise<void> {
    const trimmed = task.trim();
    if (!trimmed) {
      vscode.window.showWarningMessage('Task is empty. Describe what you need and try again.');
      return;
    }

    this.panel.webview.postMessage({ command: 'loading' });

    const result = this.lib.findRelevant(trimmed, { budget: this.budget, remember: true });
    this.tracker?.start(result.taskId);
    this.onUsed();
    const prompt = result.prompt;
    const matchCount = result.files.length;

    // Open result beside the panel
    const doc = await vscode.workspace.openTextDocument({ content: prompt, language: 'markdown' });
    await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });

    await vscode.env.clipboard.writeText(prompt);

    this.panel.webview.postMessage({ command: 'done', matchCount });

    vscode.window.showInformationMessage(
      `Librarian prompt ready — ${matchCount} file${matchCount !== 1 ? 's' : ''}, ~${result.deliveredTokens.toLocaleString()} tokens ` +
        `(vs ~${result.fullFileTokens.toLocaleString()} reading them in full). Copied to clipboard.`
    );
  }

  private buildHtml(): string {
    const nonce = crypto.randomBytes(16).toString('base64');
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ask Librarian</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 24px 28px;
    display: flex;
    flex-direction: column;
    height: 100vh;
    gap: 16px;
  }

  h1 {
    font-size: 1.1em;
    font-weight: 600;
    color: var(--vscode-foreground);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .subtitle {
    font-size: 0.88em;
    color: var(--vscode-descriptionForeground);
    line-height: 1.5;
  }

  label {
    font-size: 0.88em;
    font-weight: 500;
    color: var(--vscode-foreground);
    display: block;
    margin-bottom: 6px;
  }

  textarea {
    width: 100%;
    flex: 1;
    min-height: 220px;
    resize: vertical;
    padding: 10px 12px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    line-height: 1.6;
    outline: none;
  }
  textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  button {
    padding: 7px 18px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 3px;
    font-size: 0.9em;
    font-family: var(--vscode-font-family);
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }

  .status {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .status.success { color: var(--vscode-charts-green, #4caf50); }
  .status.hidden { visibility: hidden; }

  .divider {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, var(--vscode-editorWidget-border, #454545));
    margin: 0;
  }
</style>
</head>
<body>

<h1>🗂 Ask Librarian</h1>
<p class="subtitle">
  Describe your task below. Librarian searches the index (text match, import graph and what changed in similar past tasks),
  and builds a compact context pack you can paste into any AI session. No AI call, no tokens spent.
</p>

<hr class="divider" />

<div style="display:flex;flex-direction:column;flex:1;gap:6px;">
  <label for="task">What do you need to do?</label>
  <textarea
    id="task"
    placeholder="e.g. Add rate limiting to the authentication endpoints and return a 429 response with a Retry-After header."
    autofocus
  ></textarea>
</div>

<div class="actions">
  <button id="submitBtn">
    <span>Generate Prompt</span>
  </button>
  <span id="status" class="status hidden">—</span>
</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const btn = document.getElementById('submitBtn');
  const status = document.getElementById('status');
  const textarea = document.getElementById('task');

  btn.addEventListener('click', submit);

  // Ctrl/Cmd+Enter submits
  textarea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      submit();
    }
  });

  function submit() {
    const task = textarea.value;
    if (!task.trim()) return;
    vscode.postMessage({ command: 'submit', task });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'loading') {
      btn.disabled = true;
      btn.querySelector('span').textContent = 'Generating…';
      status.className = 'status';
      status.textContent = 'Scanning skeletons…';
    } else if (msg.command === 'done') {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Generate Prompt';
      status.className = 'status success';
      status.textContent = \`✓ \${msg.matchCount} file\${msg.matchCount !== 1 ? 's' : ''} matched — prompt opened & copied\`;
    }
  });
</script>

</body>
</html>`;
  }
}

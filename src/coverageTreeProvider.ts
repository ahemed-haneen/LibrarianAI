import * as fs from 'fs';
import * as vscode from 'vscode';
import { Librarian } from './core/librarian';
import { listSourceFiles } from './core/sourceFiles';
import { absFromRel, hashText } from './core/util';

type FileState = 'unmapped' | 'stale' | 'skeleton' | 'full';

export class CoverageNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    /** Absolute path for files/folders; undefined for info rows. */
    public readonly fsPath?: string,
    /** Root-relative posix path (files) or prefix (folders). */
    public readonly rel?: string,
    public readonly isFileNode = false
  ) {
    super(label, collapsibleState);
  }
}

/** Sidebar: coverage %, freshness per file, and estimated savings. */
export class CoverageTreeProvider implements vscode.TreeDataProvider<CoverageNode> {
  private emitter = new vscode.EventEmitter<CoverageNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private files: string[] = [];
  private states = new Map<string, FileState>();
  private hashCache = new Map<string, { mtime: number; size: number; hash: string }>();
  /** Files whose AI summary exists but is out of date. */
  private outdatedSummaries = 0;

  constructor(private root: string | undefined, private lib: () => Librarian | undefined) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(el: CoverageNode): vscode.TreeItem {
    return el;
  }

  /** Content hash, cached by mtime+size so refreshes don't re-read unchanged files. */
  private hashOf(rel: string): string | undefined {
    try {
      const abs = absFromRel(this.root!, rel);
      const st = fs.statSync(abs);
      const c = this.hashCache.get(rel);
      if (c && c.mtime === st.mtimeMs && c.size === st.size) {
        return c.hash;
      }
      const hash = hashText(fs.readFileSync(abs, 'utf8'));
      this.hashCache.set(rel, { mtime: st.mtimeMs, size: st.size, hash });
      return hash;
    } catch {
      return undefined;
    }
  }

  private scan(): void {
    const l = this.lib()!;
    l.view.reload();
    this.files = listSourceFiles(this.root!);
    this.states.clear();
    this.outdatedSummaries = 0;
    for (const f of this.files) {
      const e = l.view.resolve(f, this.hashOf(f));
      if (e && e.contextLayer && !e.contextFresh) {
        this.outdatedSummaries++;
      }
      this.states.set(f, !e ? 'unmapped' : !e.skeletonFresh ? 'stale' : e.contextFresh ? 'full' : 'skeleton');
    }
  }

  async getChildren(el?: CoverageNode): Promise<CoverageNode[]> {
    if (!this.root || !this.lib()) {
      return [new CoverageNode('No workspace open', vscode.TreeItemCollapsibleState.None)];
    }
    if (!el) {
      this.scan();
      return [...this.summaryNodes(), ...this.childrenOf('')];
    }
    if (el.rel !== undefined && !el.isFileNode) {
      return this.childrenOf(el.rel);
    }
    return [];
  }

  private summaryNodes(): CoverageNode[] {
    const total = this.files.length;
    const counts = { unmapped: 0, stale: 0, skeleton: 0, full: 0 };
    this.states.forEach((s) => counts[s]++);
    const fresh = counts.skeleton + counts.full;
    const pct = total ? (fresh / total) * 100 : 0;

    // Two separate measures: the free skeleton index, and the optional AI summaries (they cost model requests).
    const skeletons = new CoverageNode(`Skeletons: ${pct.toFixed(1)}%`, vscode.TreeItemCollapsibleState.None);
    skeletons.description = `${fresh}/${total} fresh${counts.stale ? ` · ${counts.stale} stale` : ''}${counts.unmapped ? ` · ${counts.unmapped} not indexed` : ''}`;
    skeletons.tooltip =
      'The free signature index of each file (functions, classes, imports). Only files whose skeleton matches the current source count as fresh. ' +
      'This says nothing about AI summaries: see the next row.';
    skeletons.iconPath = new vscode.ThemeIcon(
      pct > 75 ? 'pass-filled' : pct > 25 ? 'history' : 'info',
      new vscode.ThemeColor(pct > 75 ? 'charts.green' : pct > 25 ? 'charts.yellow' : 'charts.orange')
    );

    const summaryPct = total ? (counts.full / total) * 100 : 0;
    const cfg = vscode.workspace.getConfiguration('trishAI');
    const provider = cfg.get<string>('aiProvider', 'copilot');
    const modelChosen = provider === 'anthropic' || (provider === 'copilot' && cfg.get<string>('copilotModel', '').trim() !== '');
    const summaries = new CoverageNode(`AI summaries: ${summaryPct.toFixed(1)}%`, vscode.TreeItemCollapsibleState.None);
    summaries.description = `${counts.full}/${total} summarised${this.outdatedSummaries ? ` · ${this.outdatedSummaries} outdated` : ''}`;
    summaries.tooltip =
      'Short "what it does / use when" summaries written by the AI model you chose. They make file matching better but cost model requests, ' +
      'so they only run when you ask. ' +
      (modelChosen ? 'Click to summarise the files that need it (only changed files cost anything).' : 'Click to choose a provider and model first.');
    summaries.iconPath = new vscode.ThemeIcon(
      'sparkle',
      new vscode.ThemeColor(summaryPct > 75 ? 'charts.green' : summaryPct > 0 ? 'charts.yellow' : 'disabledForeground')
    );
    summaries.command = modelChosen
      ? { command: 'trishAI.indexWorkspace', title: 'Index workspace' }
      : { command: 'trishAI.openSetup', title: 'Choose model' };

    const s = this.lib()!.view.layers.local.stats();
    const saved = Math.max(0, s.estTokensIfFullFiles - s.estTokensDelivered);
    const savings = new CoverageNode(`Est. tokens saved: ${saved.toLocaleString()}`, vscode.TreeItemCollapsibleState.None);
    savings.description = `${s.promptsBuilt} context pack(s)`;
    savings.tooltip = 'Running total: full-file tokens of the files Librarian pointed to, minus the tokens it sent. Click for a full estimate replayed on your git history.';
    savings.iconPath = new vscode.ThemeIcon('graph');
    savings.command = { command: 'trishAI.estimateSavings', title: 'Estimate token savings' };

    const nodes = [skeletons, summaries, savings];
    if (counts.stale) {
      const stale = new CoverageNode(`Refresh ${counts.stale} stale file(s)`, vscode.TreeItemCollapsibleState.None);
      stale.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
      stale.command = { command: 'trishAI.refreshStale', title: 'Refresh stale' };
      nodes.push(stale);
    }
    return nodes;
  }

  private childrenOf(prefix: string): CoverageNode[] {
    const dirs = new Set<string>();
    const files: string[] = [];
    const base = prefix ? prefix + '/' : '';
    for (const f of this.files) {
      if (!f.startsWith(base)) {
        continue;
      }
      const rest = f.slice(base.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push(f);
      } else {
        dirs.add(base + rest.slice(0, slash));
      }
    }

    const dirNodes = [...dirs].sort().map((d) => {
      const n = new CoverageNode(d.split('/').pop()!, vscode.TreeItemCollapsibleState.Collapsed, absFromRel(this.root!, d), d);
      const inside = this.files.filter((f) => f.startsWith(d + '/'));
      const ready = inside.filter((f) => ['skeleton', 'full'].includes(this.states.get(f)!)).length;
      const summarised = inside.filter((f) => this.states.get(f) === 'full').length;
      n.description = `${ready}/${inside.length}${summarised ? ` · ${summarised} summarised` : ''}`;
      n.contextValue = 'codeFolder';
      n.iconPath = new vscode.ThemeIcon('folder');
      return n;
    });

    const fileNodes = files.sort().map((f) => {
      const n = new CoverageNode(f.split('/').pop()!, vscode.TreeItemCollapsibleState.None, absFromRel(this.root!, f), f, true);
      n.resourceUri = vscode.Uri.file(n.fsPath!);
      n.command = { command: 'vscode.open', title: 'Open', arguments: [n.resourceUri] };
      const state = this.states.get(f)!;
      n.contextValue = state === 'unmapped' ? 'codeFile' : 'codeFileIndexed';
      switch (state) {
        case 'full':
          n.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.green'));
          n.description = 'Skeleton + Summary';
          break;
        case 'skeleton':
          n.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.yellow'));
          n.description = 'Skeleton';
          n.tooltip = 'Skeleton indexed; no AI summary yet (or summary outdated)';
          break;
        case 'stale':
          n.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.orange'));
          n.description = 'Stale';
          n.tooltip = 'File changed since it was indexed — click ↻ to refresh';
          break;
        default:
          n.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
          n.description = 'Unmapped';
          n.tooltip = 'Not yet indexed — click ⚡ to index';
      }
      return n;
    });
    return [...dirNodes, ...fileNodes];
  }
}

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
    for (const f of this.files) {
      const e = l.view.resolve(f, this.hashOf(f));
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

    const ready = new CoverageNode(`AI Readiness: ${pct.toFixed(1)}%`, vscode.TreeItemCollapsibleState.None);
    ready.description = `${fresh}/${total} fresh · ${counts.full} summarised${counts.stale ? ` · ${counts.stale} stale` : ''}`;
    ready.tooltip = 'Only files whose skeleton matches the current source count as ready. Stale files changed since they were indexed.';
    ready.iconPath = new vscode.ThemeIcon(
      pct > 75 ? 'pass-filled' : pct > 25 ? 'history' : 'info',
      new vscode.ThemeColor(pct > 75 ? 'charts.green' : pct > 25 ? 'charts.yellow' : 'charts.orange')
    );

    const s = this.lib()!.view.layers.local.stats();
    const saved = Math.max(0, s.estTokensIfFullFiles - s.estTokensDelivered);
    const savings = new CoverageNode(`Est. tokens saved: ${saved.toLocaleString()}`, vscode.TreeItemCollapsibleState.None);
    savings.description = `${s.promptsBuilt} context pack(s)`;
    savings.tooltip = 'Estimate: tokens of the full files Librarian pointed to, minus the tokens it actually sent. ~4 chars per token.';
    savings.iconPath = new vscode.ThemeIcon('graph');

    const nodes = [ready, savings];
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
      n.description = `${ready}/${inside.length}`;
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

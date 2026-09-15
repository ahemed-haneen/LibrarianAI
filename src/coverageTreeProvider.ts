import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class CoverageNode extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly fsPath?: string,
    public readonly isSummaryHeader?: boolean,
    public readonly isFileNode?: boolean
  ) {
    super(label, collapsibleState);
  }
}

export class CoverageTreeProvider implements vscode.TreeDataProvider<CoverageNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<CoverageNode | undefined | null | void> =
    new vscode.EventEmitter<CoverageNode | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<CoverageNode | undefined | null | void> =
    this._onDidChangeTreeData.event;

  private totalFiles = 0;
  private indexedFiles = 0;

  private defaultIgnored = new Set([
    'node_modules', 'dist', 'build', 'out', 'coverage',
    '.git', '.vscode', '.idea', '.turbo', '.trishAI'
  ]);

  private gitignorePatterns: RegExp[] = [];

  constructor(private workspaceRoot: string | undefined) {
    this.loadGitignore();
    this.ensureTrishDirectory();
  }

  refresh(): void {
    this.loadGitignore();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CoverageNode): vscode.TreeItem {
    return element;
  }

  private ensureTrishDirectory(): void {
    if (!this.workspaceRoot) return;
    const trishDir = path.join(this.workspaceRoot, '.trishAI');
    if (!fs.existsSync(trishDir)) {
      fs.mkdirSync(trishDir, { recursive: true });
    }
  }

  private loadGitignore(): void {
    this.gitignorePatterns = [];
    if (!this.workspaceRoot) return;

    const gitignorePath = path.join(this.workspaceRoot, '.gitignore');
    if (!fs.existsSync(gitignorePath)) return;

    try {
      const content = fs.readFileSync(gitignorePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let line of lines) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const patternStr = line.replace(/\/$/, '').replace(/^\//, '');
        const regexStr = patternStr
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*');
        this.gitignorePatterns.push(new RegExp(`(^|/)${regexStr}($|/)`));
      }
    } catch {
      // Ignore
    }
  }

  private isIgnored(name: string, fullPath: string): boolean {
    if (name.startsWith('.')) return true;
    if (this.defaultIgnored.has(name)) return true;
    if (this.workspaceRoot) {
      const relativePath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
      return this.gitignorePatterns.some((regex) => regex.test(name) || regex.test(relativePath));
    }
    return false;
  }

  private getSkeletonPath(fullFilePath: string): string {
    const relative = path.relative(this.workspaceRoot!, fullFilePath);
    return path.join(
      this.workspaceRoot!,
      '.trishAI',
      path.dirname(relative),
      `${path.basename(fullFilePath)}.skeleton.md`
    );
  }

  private hasSkeletonFile(fullFilePath: string): boolean {
    if (!this.workspaceRoot) return false;
    return fs.existsSync(this.getSkeletonPath(fullFilePath));
  }

  private getSkeletonMtime(fullFilePath: string): number | null {
    if (!this.workspaceRoot) return null;
    const skeletonPath = this.getSkeletonPath(fullFilePath);
    return fs.existsSync(skeletonPath) ? fs.statSync(skeletonPath).mtimeMs : null;
  }

  async getChildren(element?: CoverageNode): Promise<CoverageNode[]> {
    if (!this.workspaceRoot) {
      return [new CoverageNode('No workspace open', vscode.TreeItemCollapsibleState.None)];
    }

    if (!element) {
      this.totalFiles = 0;
      this.indexedFiles = 0;
      this.calculateMetrics(this.workspaceRoot);

      const coveragePct =
        this.totalFiles > 0
          ? ((this.indexedFiles / this.totalFiles) * 100).toFixed(1)
          : '0.0';

      const summaryNode = new CoverageNode(
        `AI Readiness: ${coveragePct}%`,
        vscode.TreeItemCollapsibleState.None,
        undefined,
        true
      );

      summaryNode.description = `${this.indexedFiles}/${this.totalFiles} files indexed`;
      summaryNode.iconPath = new vscode.ThemeIcon(
        Number(coveragePct) > 75 ? 'pass-filled' : Number(coveragePct) > 25 ? 'history' : 'info',
        new vscode.ThemeColor(
          Number(coveragePct) > 75 ? 'charts.green' : Number(coveragePct) > 25 ? 'charts.yellow' : 'charts.orange'
        )
      );

      return [summaryNode, ...this.getNodesForDirectory(this.workspaceRoot)];
    }

    if (element.fsPath && !element.isFileNode) {
      return this.getNodesForDirectory(element.fsPath);
    }

    return [];
  }

  private calculateMetrics(dirPath: string): void {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (this.isIgnored(entry.name, fullPath)) continue;

        if (entry.isDirectory()) {
          this.calculateMetrics(fullPath);
        } else if (
          entry.isFile() &&
          /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
        ) {
          this.totalFiles++;
          if (this.hasSkeletonFile(fullPath)) {
            this.indexedFiles++;
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  private getNodesForDirectory(dirPath: string): CoverageNode[] {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const nodes: CoverageNode[] = [];

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (this.isIgnored(entry.name, fullPath)) continue;

        if (entry.isDirectory()) {
          const node = new CoverageNode(
            entry.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            fullPath,
            false,
            false
          );
          node.contextValue = 'codeFolder';
          node.iconPath = new vscode.ThemeIcon('folder');
          nodes.push(node);
        } else if (
          entry.isFile() &&
          /\.(ts|tsx|js|jsx)$/.test(entry.name) &&
          !entry.name.endsWith('.d.ts')
        ) {
          const isIndexed = this.hasSkeletonFile(fullPath);
          const mtime = this.getSkeletonMtime(fullPath);
          const timeDesc = mtime ? ` • ${new Date(mtime).toLocaleDateString()}` : '';

          const node = new CoverageNode(
            entry.name,
            vscode.TreeItemCollapsibleState.None,
            fullPath,
            false,
            true
          );

          if (isIndexed) {
            node.contextValue = 'codeFileIndexed';
            node.iconPath = new vscode.ThemeIcon('symbol-interface', new vscode.ThemeColor('charts.green'));
            node.description = `Skeleton Ready${timeDesc}`;
            node.tooltip = 'Skeleton indexed — click ↻ to regenerate';
          } else {
            node.contextValue = 'codeFile';
            node.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
            node.description = 'Unmapped';
            node.tooltip = 'Not yet indexed — click ⚡ to generate skeleton';
          }

          nodes.push(node);
        }
      }

      return nodes.sort((a, b) => {
        if (a.isFileNode === b.isFileNode) {
          return a.label.localeCompare(b.label);
        }
        return a.isFileNode ? 1 : -1;
      });
    } catch {
      return [];
    }
  }
}
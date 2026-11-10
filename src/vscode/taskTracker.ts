import * as vscode from 'vscode';
import { isSourcePath } from '../core/sourceFiles';
import { TaskMemory } from '../core/taskMemory';
import { relPosix } from '../core/util';

const IDLE_MS = 45 * 60 * 1000;

/**
 * Closes the learning loop: when Librarian hands out context for a task, files you save
 * afterwards are recorded against that task. Next time a similar task comes up, those files
 * rank higher — so retrieval improves with use, at zero AI cost.
 */
export class TaskTracker implements vscode.Disposable {
  private activeId?: string;
  private lastActivity = 0;
  private sub: vscode.Disposable;

  constructor(private root: string, private memory: TaskMemory, private enabled: () => boolean) {
    this.sub = vscode.workspace.onDidSaveTextDocument((doc) => this.onSave(doc));
  }

  start(taskId: string | undefined): void {
    if (taskId && this.enabled()) {
      this.activeId = taskId;
      this.lastActivity = Date.now();
    }
  }

  get active(): boolean {
    return !!this.activeId && Date.now() - this.lastActivity < IDLE_MS;
  }

  private onSave(doc: vscode.TextDocument): void {
    if (!this.activeId || doc.uri.scheme !== 'file' || !this.enabled()) {
      return;
    }
    if (Date.now() - this.lastActivity > IDLE_MS) {
      this.activeId = undefined;
      return;
    }
    const rel = relPosix(this.root, doc.uri.fsPath);
    if (rel.startsWith('..') || !isSourcePath(rel)) {
      return;
    }
    this.memory.touch(this.activeId, rel);
    this.lastActivity = Date.now();
  }

  dispose(): void {
    this.sub.dispose();
  }
}

import * as vscode from 'vscode';
import * as path from 'path';

export interface Frame { file: string; line: number; func: string; uid: number }

export class StackProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private frames: Frame[] = [];
  private reverse = false;
  private selectedUid: number | null = null;
  private header: { pid: string; cmd: string } | null = null;

  private _ev = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._ev.event;

  /* ––––– public API ––––– */
  setHeader(h: { pid: string; cmd: string } | null) {
    this.header = h;
    this._ev.fire();
  }
  toggleOrder() { this.reverse = !this.reverse; this._ev.fire(); }
  setFrames(f: Frame[]) {
    this.frames = f;
    if (this.selectedUid !== null && !f.some(fr => fr.uid === this.selectedUid)) {
      this.selectedUid = null;
    }
    this._ev.fire();
  }
  setSelected(uid: number) { this.selectedUid = uid; this._ev.fire(); }

  /* ––––– TreeDataProvider ––––– */
  getTreeItem(i: vscode.TreeItem) { return i; }

  getChildren() {
    const items: vscode.TreeItem[] = [];

    // header node
    if (this.header) {
      const head = new vscode.TreeItem(
        `Process ID: ${this.header.pid}`,
        vscode.TreeItemCollapsibleState.None
      );
      head.tooltip     = this.header.cmd;
      head.description = '(Python process)';
      head.iconPath    = undefined;
      head.command     = undefined;
      items.push(head);
    }

    const list = this.reverse ? [...this.frames].reverse() : this.frames;
    for (const fr of list) {
      const node = new vscode.TreeItem(
        `${fr.func} (${path.basename(fr.file)})`,
        vscode.TreeItemCollapsibleState.None
      );
      node.tooltip  = `${fr.file}:${fr.line}`;
      node.iconPath = new vscode.ThemeIcon(
        fr.uid === this.selectedUid ? 'debug-stackframe-active' : 'debug-stackframe'
      );
      node.command  = { command: 'pyspy.openFrame', title: '', arguments: [fr] };
      items.push(node);
    }
    return items;
  }
}

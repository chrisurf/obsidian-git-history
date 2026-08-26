import { setIcon } from "obsidian";
import { buildFileTree, collectDirPaths } from "../utils/file-tree";
import type { TreeNode } from "../utils/file-tree";
import type { FileListMode } from "../types";

/** One entry of a commit's file list, as `git show --numstat` reports it. */
export interface CommitFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface CommitFileListOptions {
  /** Read fresh on every draw, so a layout changed elsewhere is picked up. */
  mode: () => FileListMode;
  compactFolders: () => boolean;
  /** Pressed the layout button. The host decides what that means and saves it. */
  toggleMode: () => void;
  /**
   * Draws one file row. The list decides where a row goes and what it is
   * called; what a row looks like belongs to whoever owns the list, because
   * the two places this is used draw visibly different rows.
   */
  renderFile: (parent: HTMLElement, file: CommitFile, label: string, depth: number) => void;
}

/**
 * A commit's files, as a folder tree or as a flat list.
 *
 * The plugin shows a commit's files in two places — the Changes sub-tab, and
 * the detail that opens inside the commit list — and the question both ask is
 * the same: how do these files belong together, and how do I get through them
 * quickly. Everything that answers it lives here once: the layout, the folding
 * state, the toolbar, and the tree itself.
 *
 * It is a class rather than methods on the view because the two lists exist at
 * the same time and must not share a folding state: collapsing a folder in one
 * has no business collapsing it in the other.
 */
export class CommitFileList {
  private files: CommitFile[] = [];
  private hash = "";
  private dirPaths: string[] = [];
  private expandedDirs = new Set<string>();
  private listEl: HTMLElement | null = null;
  private foldBtn: HTMLElement | null = null;
  private modeBtn: HTMLElement | null = null;

  constructor(private opts: CommitFileListOptions) {}

  /** The layout toggle and the fold-everything button, for a header row. */
  buildToolbar(parent: HTMLElement): HTMLElement {
    const actions = parent.createDiv("gs-sc-list-actions");

    const foldBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
    foldBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleAllFolders();
    });
    this.foldBtn = foldBtn;

    const modeBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
    modeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.opts.toggleMode();
    });
    this.modeBtn = modeBtn;

    return actions;
  }

  /**
   * Takes on a commit's files.
   *
   * A newly opened commit starts with every folder open: the list was flat
   * before this, and arriving at a commit to find its files hidden behind
   * folders would be a worse answer to "what changed here". Showing the same
   * commit again leaves the folding alone, so a redraw does not undo it.
   */
  setFiles(files: CommitFile[], hash: string): void {
    this.files = files;
    this.dirPaths = collectDirPaths(this.buildTree());
    if (this.hash !== hash) {
      this.hash = hash;
      this.expandedDirs = new Set(this.dirPaths);
    }
  }

  /** Creates the element the rows are drawn into. */
  mount(parent: HTMLElement, cls = "gs-commit-file-list"): HTMLElement {
    this.listEl = parent.createDiv(cls);
    return this.listEl;
  }

  render(): void {
    const el = this.listEl;
    if (!el) return;
    el.empty();
    this.updateToolbar();

    if (this.opts.mode() === "list") {
      // Sorted by path, so files from the same folder stay together even where
      // the layout does not draw the folder.
      const sorted = [...this.files].sort((a, b) => a.path.localeCompare(b.path));
      for (const file of sorted) this.opts.renderFile(el, file, file.path, 0);
      return;
    }

    this.renderTree(el, this.buildTree(), 0);
  }

  private buildTree(): TreeNode<CommitFile>[] {
    return buildFileTree(this.files, (f) => f.path, this.opts.compactFolders());
  }

  private allFoldersExpanded(): boolean {
    return this.dirPaths.length > 0 && this.dirPaths.every((p) => this.expandedDirs.has(p));
  }

  private toggleAllFolders(): void {
    const expand = !this.allFoldersExpanded();
    for (const path of this.dirPaths) {
      if (expand) this.expandedDirs.add(path);
      else this.expandedDirs.delete(path);
    }
    this.render();
  }

  private updateToolbar(): void {
    const mode = this.opts.mode();

    if (this.modeBtn) {
      // The button names where it takes you, not where you are.
      const toTree = mode === "list";
      setIcon(this.modeBtn, toTree ? "list-tree" : "list");
      this.modeBtn.setAttribute("aria-label", toTree ? "View as tree" : "View as list");
      this.modeBtn.toggleClass("gs-hidden", this.files.length === 0);
    }

    const foldBtn = this.foldBtn;
    if (!foldBtn) return;
    const expanded = this.allFoldersExpanded();
    setIcon(foldBtn, expanded ? "fold-vertical" : "unfold-vertical");
    foldBtn.setAttribute("aria-label", expanded ? "Collapse all folders" : "Expand all folders");
    // Nothing to fold in a flat list, nor in a commit that touched no folder.
    foldBtn.toggleClass("gs-hidden", mode !== "tree" || this.dirPaths.length === 0);
  }

  private renderTree(parent: HTMLElement, nodes: TreeNode<CommitFile>[], depth: number): void {
    for (const node of nodes) {
      if (!node.isDir) {
        // The folder is drawn above it, so the row carries only its own name.
        if (node.item) this.opts.renderFile(parent, node.item, node.name, depth);
        continue;
      }

      const expanded = this.expandedDirs.has(node.path);
      const dirRow = parent.createDiv("gs-tree-dir");
      dirRow.style.paddingLeft = depth * 16 + 8 + "px";

      const chevron = dirRow.createSpan("gs-tree-chevron");
      setIcon(chevron, expanded ? "chevron-down" : "chevron-right");

      const folderIcon = dirRow.createSpan("gs-tree-folder-icon");
      setIcon(folderIcon, expanded ? "folder-open" : "folder");

      dirRow.createSpan("gs-tree-dirname").setText(node.name);

      const dirRight = dirRow.createDiv("gs-tree-dir-right");
      const dirActions = dirRight.createDiv("gs-tree-dir-actions");

      // Only where there is something nested to fold: for a folder holding
      // nothing but files the row's own chevron already does the job.
      const nestedDirs = collectDirPaths(node.children);
      if (nestedDirs.length > 0) {
        const openAll = expanded && nestedDirs.every((p) => this.expandedDirs.has(p));
        const subtreeBtn = dirActions.createEl("button", { cls: "gs-action-btn" });
        setIcon(subtreeBtn, openAll ? "fold-vertical" : "unfold-vertical");
        subtreeBtn.setAttribute(
          "aria-label",
          openAll ? "Collapse all in folder" : "Expand all in folder",
        );
        subtreeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setSubtreeExpanded(node.path, nestedDirs, !openAll);
        });
        // A placeholder with nothing behind it is a dot that never gets out of
        // the way for anything.
        dirRight.createSpan("gs-tree-dir-dot");
      }

      dirRow.addEventListener("click", (e) => {
        // The detail sits inside a clickable commit row; folding a folder must
        // not also collapse the commit it belongs to.
        e.stopPropagation();
        if (expanded) this.expandedDirs.delete(node.path);
        else this.expandedDirs.add(node.path);
        this.render();
      });

      if (expanded) this.renderTree(parent, node.children, depth + 1);
    }
  }

  /**
   * Opens or closes a folder together with everything nested inside it. The
   * folder moves with its subtree rather than staying open: a "collapse" that
   * left the row open would leave a state indistinguishable from never having
   * opened the levels below it.
   */
  private setSubtreeExpanded(path: string, nested: string[], expand: boolean): void {
    for (const dir of [path, ...nested]) {
      if (expand) this.expandedDirs.add(dir);
      else this.expandedDirs.delete(dir);
    }
    this.render();
  }
}

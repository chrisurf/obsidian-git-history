import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE, FileStatus } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import type GitStudioPlugin from "../main";

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
  file?: FileStatus;
  expanded: boolean;
}

export class SourceControlView extends ItemView {
  private plugin: GitStudioPlugin;
  private store: RepoStore;
  private git: GitService;
  private commitInput: HTMLTextAreaElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private branchEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private expandedDirs = new Set<string>();

  constructor(leaf: WorkspaceLeaf, plugin: GitStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.git = plugin.git;
  }

  getViewType(): string { return SOURCE_CONTROL_VIEW_TYPE; }
  getDisplayText(): string { return "Source Control"; }
  getIcon(): string { return "git-commit-horizontal"; }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gs-sc-view");

    this.buildHeader(contentEl);
    this.buildBranchBar(contentEl);
    this.buildSummary(contentEl);
    this.buildFilterBar(contentEl);
    this.fileListEl = contentEl.createDiv("gs-sc-filelist");
    this.buildCommitArea(contentEl);

    this.registerEvent(this.store.on("status-changed", () => this.renderFiles()));
    this.registerEvent(this.store.on("branch-changed", () => this.updateBranch()));
    this.registerEvent(this.store.on("loading", (l: boolean) => {
      contentEl.toggleClass("gs-loading", l);
    }));

    await this.store.refresh();
    await this.store.refreshBranches();
  }

  private buildHeader(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-header");
    bar.createSpan("gs-sc-header-title").setText("SOURCE CONTROL");

    const actions = bar.createDiv("gs-sc-header-actions");
    for (const [icon, label, fn] of [
      ["refresh-cw", "Refresh", () => this.store.refresh()],
      ["download", "Pull", async () => {
        try { await this.git.pull({ strategy: this.plugin.settings.pullStrategy }); await this.store.refresh(); new Notice("Pulled"); }
        catch (e: unknown) { new Notice(`Pull failed: ${e instanceof Error ? e.message : String(e)}`); }
      }],
      ["upload", "Push", async () => {
        try { await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch }); await this.store.refresh(); new Notice("Pushed"); }
        catch (e: unknown) { new Notice(`Push failed: ${e instanceof Error ? e.message : String(e)}`); }
      }],
      ["cloud-download", "Fetch", async () => {
        try { await this.git.fetch(); await this.store.refresh(); new Notice("Fetched"); }
        catch (e: unknown) { new Notice(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`); }
      }],
      ["archive", "Stash", async () => {
        try { await this.git.stashSave(); await this.store.refresh(); new Notice("Stashed"); }
        catch (e: unknown) { new Notice(`${e instanceof Error ? e.message : String(e)}`); }
      }],
      ["more-horizontal", "More", (e: MouseEvent) => this.showMoreMenu(e)],
    ] as [string, string, (...a: any[]) => void][]) {
      const btn = actions.createEl("button", { cls: "gs-icon-btn" });
      setIcon(btn, icon);
      btn.setAttribute("aria-label", label);
      btn.addEventListener("click", fn as EventListener);
    }
  }

  private buildBranchBar(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-branch-bar");
    this.branchEl = bar.createDiv("gs-branch-picker");
    const branchIcon = this.branchEl.createSpan("gs-branch-icon");
    setIcon(branchIcon, "git-branch");
    this.branchEl.createSpan("gs-branch-name").setText(this.store.branch || "...");
    const chevron = this.branchEl.createSpan("gs-branch-chevron");
    setIcon(chevron, "chevron-down");
    this.branchEl.addEventListener("click", (e) => this.showBranchMenu(e));

    bar.createSpan("gs-sc-associate").setText("Associate Issue...");
  }

  private buildSummary(el: HTMLElement): void {
    this.summaryEl = el.createDiv("gs-sc-summary");
  }

  private buildFilterBar(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-filterbar");
    const input = bar.createEl("input", {
      cls: "gs-filter-input",
      attr: { type: "text", placeholder: "Filter files..." },
    });
    input.addEventListener("input", () => {
      // file filter (future)
    });
  }

  private buildCommitArea(el: HTMLElement): void {
    const area = el.createDiv("gs-sc-commit-area");

    const topRow = area.createDiv("gs-commit-top-row");
    const amendLabel = topRow.createEl("label", { cls: "gs-amend-label" });
    amendLabel.createEl("input", { attr: { type: "checkbox" }, cls: "gs-amend-checkbox" });
    amendLabel.createSpan().setText(" Amend Previous Commit");
    topRow.createEl("button", { cls: "gs-compose-btn", text: "Compose" });

    this.commitInput = area.createEl("textarea", {
      cls: "gs-commit-input",
      attr: { placeholder: "Commit message (⌘Enter to commit)" },
    });

    this.commitInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.doCommit();
      }
    });

    const btnRow = area.createDiv("gs-commit-btn-row");

    const commitBtn = btnRow.createEl("button", { cls: "gs-commit-main-btn" });
    commitBtn.innerHTML = `Commit to <span class="gs-commit-branch-ref">⇨ ${this.escapeHtml(this.store.branch || "main")}</span>`;
    commitBtn.addEventListener("click", () => this.doCommit());

    const pushBtn = btnRow.createEl("button", { cls: "gs-commit-push-btn", text: "Commit & Push" });
    pushBtn.addEventListener("click", () => this.doCommit(true));
  }

  private showMoreMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Pop Stash").setIcon("archive-restore").onClick(async () => {
      try { await this.git.stashPop(); await this.store.refresh(); new Notice("Stash popped"); }
      catch (e: unknown) { new Notice(`${e instanceof Error ? e.message : String(e)}`); }
    }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Open Git Graph").setIcon("git-branch").onClick(() => this.plugin.openGraphView()));
    menu.addItem(i => i.setTitle("Open History").setIcon("history").onClick(() => this.plugin.openHistoryView()));
    menu.showAtMouseEvent(event);
  }

  private async showBranchMenu(event: MouseEvent): Promise<void> {
    await this.store.refreshBranches();
    const menu = new Menu();
    for (const b of this.store.branches.filter(b => !b.remote)) {
      menu.addItem(i => {
        i.setTitle(`${b.current ? "✓ " : "  "}${b.name}`);
        i.setIcon("git-branch");
        if (!b.current) {
          i.onClick(async () => {
            try {
              await this.git.checkout(b.name);
              await this.store.refresh();
              new Notice(`Switched to ${b.name}`);
            } catch (e: unknown) {
              new Notice(`${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
      });
    }
    menu.addSeparator();
    menu.addItem(i => i.setTitle("+ Create new branch...").setIcon("plus").onClick(async () => {
      const name = prompt("New branch name:");
      if (name) {
        try {
          await this.git.createBranch(name);
          await this.store.refresh();
          new Notice(`Branch '${name}' created and checked out`);
        } catch (e: unknown) {
          new Notice(`${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }));
    menu.showAtMouseEvent(event);
  }

  private updateBranch(): void {
    if (this.branchEl) {
      const nameEl = this.branchEl.querySelector(".gs-branch-name");
      if (nameEl) nameEl.textContent = this.store.branch || "...";
    }
    const btnRef = this.contentEl.querySelector(".gs-commit-branch-ref");
    if (btnRef) btnRef.textContent = `⇨ ${this.store.branch || "main"}`;
  }

  private async doCommit(andPush = false): Promise<void> {
    const msg = this.commitInput?.value?.trim();
    if (!msg) { new Notice("Please enter a commit message"); return; }

    const amend = (this.contentEl.querySelector(".gs-amend-checkbox") as HTMLInputElement)?.checked;
    const staged = this.store.stagedFiles;
    if (staged.length === 0 && !amend) {
      if (this.store.changedFiles.length > 0 || this.store.untrackedFiles.length > 0) {
        await this.git.stageAll();
      } else {
        new Notice("No changes to commit");
        return;
      }
    }

    try {
      await this.git.commit(msg, { amend });
      if (this.commitInput) this.commitInput.value = "";
      new Notice("Committed");
      if (andPush) {
        await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch });
        new Notice("Pushed");
      }
      await this.store.refresh();
    } catch (e: unknown) {
      new Notice(`Commit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private renderFiles(): void {
    if (!this.fileListEl) return;
    this.fileListEl.empty();

    const staged = this.store.stagedFiles;
    const changed = this.store.changedFiles;
    const untracked = this.store.untrackedFiles;
    const conflicts = this.store.mergeConflicts;

    this.updateSummary(staged, changed, untracked, conflicts);

    if (conflicts.length > 0) this.renderSection("MERGE CONFLICTS", conflicts, "conflict");
    if (staged.length > 0) this.renderSection("STAGED", staged, "staged");
    if (changed.length > 0) this.renderSection("CHANGES", changed, "changed");
    if (untracked.length > 0) this.renderSection("UNTRACKED", untracked, "untracked");

    if (staged.length + changed.length + untracked.length + conflicts.length === 0) {
      this.fileListEl.createDiv("gs-sc-empty").setText("No changes");
    }
  }

  private updateSummary(staged: FileStatus[], changed: FileStatus[], untracked: FileStatus[], conflicts: FileStatus[]): void {
    if (!this.summaryEl) return;
    this.summaryEl.empty();

    const parts: string[] = [];
    if (staged.length > 0) parts.push(`${staged.length} STAGED`);
    if (changed.length + untracked.length > 0) parts.push(`${changed.length + untracked.length} CHANGED`);
    if (conflicts.length > 0) parts.push(`${conflicts.length} CONFLICT`);

    if (parts.length > 0) {
      const badge = this.summaryEl.createSpan("gs-summary-badge");
      badge.setText(parts.join(" • "));
    }
  }

  private renderSection(title: string, files: FileStatus[], group: string): void {
    if (!this.fileListEl) return;

    const section = this.fileListEl.createDiv("gs-sc-section");
    const header = section.createDiv("gs-sc-section-header");
    header.createSpan("gs-section-title").setText(`${title} (${files.length})`);

    const headerActions = header.createDiv("gs-section-actions");
    if (group === "staged") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn" });
      setIcon(btn, "minus");
      btn.setAttribute("aria-label", "Unstage All");
      btn.addEventListener("click", async () => { await this.git.unstageAll(); await this.store.refresh(); });
    } else if (group !== "conflict") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn" });
      setIcon(btn, "plus");
      btn.setAttribute("aria-label", "Stage All");
      btn.addEventListener("click", async () => { await this.git.stage(files.map(f => f.path)); await this.store.refresh(); });
    }
    if (group === "changed") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn" });
      setIcon(btn, "rotate-ccw");
      btn.setAttribute("aria-label", "Discard All");
      btn.addEventListener("click", async () => { await this.git.discard(files.map(f => f.path)); await this.store.refresh(); });
    }

    const tree = this.buildFileTree(files, group);
    const treeEl = section.createDiv("gs-sc-tree");
    this.renderTree(treeEl, tree, group, 0);
  }

  private buildFileTree(files: FileStatus[], group: string): FileTreeNode[] {
    const root: FileTreeNode[] = [];
    const dirMap = new Map<string, FileTreeNode>();

    for (const file of files) {
      const parts = file.path.split("/");
      let currentChildren = root;
      let currentPath = "";

      for (let i = 0; i < parts.length - 1; i++) {
        currentPath += (currentPath ? "/" : "") + parts[i];
        let dir = dirMap.get(currentPath);
        if (!dir) {
          dir = {
            name: parts[i],
            path: currentPath,
            isDir: true,
            children: [],
            expanded: this.expandedDirs.has(currentPath),
          };
          dirMap.set(currentPath, dir);
          currentChildren.push(dir);
        }
        currentChildren = dir.children;
      }

      currentChildren.push({
        name: parts[parts.length - 1],
        path: file.path,
        isDir: false,
        children: [],
        file,
        expanded: false,
      });
    }

    return root;
  }

  private renderTree(parent: HTMLElement, nodes: FileTreeNode[], group: string, depth: number): void {
    for (const node of nodes) {
      if (node.isDir) {
        const dirRow = parent.createDiv("gs-tree-dir");
        dirRow.style.paddingLeft = (depth * 16 + 4) + "px";

        const chevron = dirRow.createSpan("gs-tree-chevron");
        setIcon(chevron, node.expanded ? "chevron-down" : "chevron-right");

        const folderIcon = dirRow.createSpan("gs-tree-folder-icon");
        setIcon(folderIcon, node.expanded ? "folder-open" : "folder");

        dirRow.createSpan("gs-tree-dirname").setText(node.name);

        dirRow.addEventListener("click", () => {
          node.expanded = !node.expanded;
          if (node.expanded) this.expandedDirs.add(node.path);
          else this.expandedDirs.delete(node.path);
          this.renderFiles();
        });

        if (node.expanded) {
          this.renderTree(parent, node.children, group, depth + 1);
        }
      } else if (node.file) {
        this.renderFileRow(parent, node.file, group, depth);
      }
    }
  }

  private renderFileRow(parent: HTMLElement, file: FileStatus, group: string, depth: number): void {
    const row = parent.createDiv("gs-tree-file");
    row.style.paddingLeft = (depth * 16 + 4) + "px";

    const check = row.createEl("input", { cls: "gs-file-check", attr: { type: "checkbox" } });
    if (group === "staged") (check as HTMLInputElement).checked = true;
    check.addEventListener("change", async () => {
      if ((check as HTMLInputElement).checked) {
        await this.git.stage([file.path]);
      } else {
        await this.git.unstage([file.path]);
      }
      await this.store.refresh();
    });

    const fileIcon = row.createSpan("gs-tree-file-icon");
    const ext = file.path.split(".").pop() || "";
    if (ext === "md") setIcon(fileIcon, "file-text");
    else if (ext === "json") setIcon(fileIcon, "braces");
    else if (ext === "css") setIcon(fileIcon, "paintbrush");
    else setIcon(fileIcon, "file");

    const nameEl = row.createSpan("gs-tree-filename");
    nameEl.setText(file.path.split("/").pop() || file.path);

    const statsEl = row.createSpan("gs-tree-file-stats");

    const badge = row.createSpan("gs-tree-badge");
    const statusChar = group === "staged" ? file.indexStatus : file.workingStatus;
    const displayChar = statusChar === "?" ? "U" : statusChar;
    badge.setText(displayChar);
    badge.addClass(`gs-badge-${displayChar}`);

    const actions = row.createDiv("gs-tree-file-actions");
    if (group !== "staged" && group !== "conflict") {
      const stageBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(stageBtn, "plus");
      stageBtn.setAttribute("aria-label", "Stage");
      stageBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.stage([file.path]);
        await this.store.refresh();
      });
    }
    if (group === "staged") {
      const unstageBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(unstageBtn, "minus");
      unstageBtn.setAttribute("aria-label", "Unstage");
      unstageBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.unstage([file.path]);
        await this.store.refresh();
      });
    }
    if (group === "changed") {
      const discardBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(discardBtn, "rotate-ccw");
      discardBtn.setAttribute("aria-label", "Discard");
      discardBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.discard([file.path]);
        await this.store.refresh();
      });
    }

    const diffBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
    setIcon(diffBtn, "file-diff");
    diffBtn.setAttribute("aria-label", "Diff");
    diffBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.openDiff(file.path);
    });

    row.addEventListener("click", () => this.plugin.openDiff(file.path));
    row.addEventListener("contextmenu", (e) => {
      const menu = new Menu();
      menu.addItem(i => i.setTitle("Open File").setIcon("file").onClick(() => this.app.workspace.openLinkText(file.path, "", false)));
      menu.addItem(i => i.setTitle("Open Diff").setIcon("file-diff").onClick(() => this.plugin.openDiff(file.path)));
      menu.addSeparator();
      menu.addItem(i => i.setTitle("Copy Path").setIcon("copy").onClick(() => { navigator.clipboard.writeText(file.path); new Notice("Path copied"); }));
      menu.showAtMouseEvent(e);
    });

    this.loadFileStats(file, statsEl, group);
  }

  private async loadFileStats(file: FileStatus, el: HTMLElement, group: string): Promise<void> {
    try {
      const raw = group === "staged"
        ? await this.git.diff(file.path, true)
        : await this.git.diff(file.path);
      if (!raw) return;
      let adds = 0, dels = 0;
      for (const line of raw.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) adds++;
        if (line.startsWith("-") && !line.startsWith("---")) dels++;
      }
      if (adds > 0) el.createSpan("gs-stat-add").setText(`+${adds}`);
      if (dels > 0) el.createSpan("gs-stat-del").setText(` -${dels}`);
    } catch {
      // ignore
    }
  }

  private escapeHtml(s: string): string {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  async onClose(): Promise<void> {
    // cleanup
  }
}

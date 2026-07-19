import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE, FileStatus, GraphNode } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { computeGraphLayout, formatRelativeDate } from "../utils/graph-layout";
import type GitStudioPlugin from "../main";

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
  file?: FileStatus;
  expanded: boolean;
}

type SidebarTab = "changes" | "graph";

export class SourceControlView extends ItemView {
  private plugin: GitStudioPlugin;
  private store: RepoStore;
  private git: GitService;
  private commitInput: HTMLInputElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private expandedDirs = new Set<string>();
  private activeTab: SidebarTab = "changes";
  private changesPanel: HTMLElement | null = null;
  private graphPanel: HTMLElement | null = null;
  private tabBtns: Record<string, HTMLElement> = {};

  private graphNodes: GraphNode[] = [];
  private graphListEl: HTMLElement | null = null;
  private graphSelectedHash: string | null = null;
  private focusHandler: (() => void) | null = null;

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
    this.buildTabBar(contentEl);

    this.changesPanel = contentEl.createDiv("gs-sc-changes-panel");
    this.graphPanel = contentEl.createDiv("gs-sc-graph-panel");
    this.graphPanel.style.display = "none";

    this.buildCommitArea(this.changesPanel);
    this.fileListEl = this.changesPanel.createDiv("gs-sc-filelist");

    this.buildSidebarGraph(this.graphPanel);

    this.registerEvent(this.store.on("status-changed", () => {
      this.renderFiles();
      if (this.activeTab === "graph") this.rebuildSidebarGraph();
    }));
    this.registerEvent(this.store.on("branch-changed", () => this.updateBranch()));
    this.registerEvent(this.store.on("log-changed", () => {
      if (this.activeTab === "graph") this.rebuildSidebarGraph();
    }));
    this.registerEvent(this.store.on("loading", (l: boolean) => {
      contentEl.toggleClass("gs-loading", l);
    }));

    this.focusHandler = () => this.store.refresh();
    window.addEventListener("focus", this.focusHandler);

    await this.store.refresh();
    await this.store.refreshBranches();
  }

  private buildTabBar(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-tabbar");

    const changesBtn = bar.createEl("button", { cls: "gs-sc-tab gs-sc-tab-active", text: "Changes" });
    const graphBtn = bar.createEl("button", { cls: "gs-sc-tab", text: "Graph" });

    this.tabBtns["changes"] = changesBtn;
    this.tabBtns["graph"] = graphBtn;

    changesBtn.addEventListener("click", () => this.switchTab("changes"));
    graphBtn.addEventListener("click", () => this.switchTab("graph"));
  }

  private switchTab(tab: SidebarTab): void {
    this.activeTab = tab;
    for (const [key, btn] of Object.entries(this.tabBtns)) {
      btn.toggleClass("gs-sc-tab-active", key === tab);
    }
    if (this.changesPanel) this.changesPanel.style.display = tab === "changes" ? "" : "none";
    if (this.graphPanel) this.graphPanel.style.display = tab === "graph" ? "" : "none";

    if (tab === "graph") {
      this.store.refreshLog({ all: true, maxCount: 500 });
    }
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


  private buildCommitArea(el: HTMLElement): void {
    const area = el.createDiv("gs-sc-commit-area");

    const inputWrap = area.createDiv("gs-commit-input-wrap");
    this.commitInput = inputWrap.createEl("input", {
      cls: "gs-commit-input",
      attr: { type: "text", placeholder: `Message (⌘Enter to commit on "${this.store.branch || "main"}")` },
    });

    this.commitInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.doCommit();
      }
    });

    const btnRow = area.createDiv("gs-commit-btn-row");

    const commitBtn = btnRow.createEl("button", { cls: "gs-commit-main-btn" });
    const checkIcon = commitBtn.createSpan("gs-commit-check-icon");
    setIcon(checkIcon, "check");
    commitBtn.appendText(" Commit");
    commitBtn.addEventListener("click", () => this.doCommit());

    const dropdownBtn = btnRow.createEl("button", { cls: "gs-commit-dropdown-btn" });
    const chevron = dropdownBtn.createSpan();
    setIcon(chevron, "chevron-down");
    dropdownBtn.addEventListener("click", (e) => {
      const menu = new Menu();
      menu.addItem(i => i.setTitle("Commit").setIcon("check").onClick(() => this.doCommit()));
      menu.addItem(i => i.setTitle("Commit & Push").setIcon("upload").onClick(() => this.doCommit(true)));
      menu.addSeparator();
      menu.addItem(i => {
        const isAmend = this.contentEl.querySelector(".gs-commit-input") as HTMLInputElement;
        i.setTitle("Amend Previous Commit").setIcon("edit");
        i.onClick(async () => {
          try {
            const msg = isAmend?.value?.trim() || "";
            await this.git.commit(msg || "amend", { amend: true });
            if (isAmend) isAmend.value = "";
            await this.store.refresh();
            new Notice("Amended");
          } catch (err: unknown) {
            new Notice(`Amend failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      });
      menu.showAtMouseEvent(e);
    });
  }

  private showMoreMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Pop Stash").setIcon("archive-restore").onClick(async () => {
      try { await this.git.stashPop(); await this.store.refresh(); new Notice("Stash popped"); }
      catch (e: unknown) { new Notice(`${e instanceof Error ? e.message : String(e)}`); }
    }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Switch Branch...").setIcon("git-branch").onClick(async (e) => {
      await this.showBranchMenu(event);
    }));
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
    if (this.commitInput) {
      this.commitInput.setAttribute("placeholder", `Message (⌘Enter to commit on "${this.store.branch || "main"}")`);
    }
  }

  private async doCommit(andPush = false): Promise<void> {
    const msg = this.commitInput?.value?.trim();
    if (!msg) { new Notice("Please enter a commit message"); return; }

    const staged = this.store.stagedFiles;
    if (staged.length === 0) {
      if (this.store.changedFiles.length > 0 || this.store.untrackedFiles.length > 0) {
        await this.git.stageAll();
      } else {
        new Notice("No changes to commit");
        return;
      }
    }

    try {
      await this.git.commit(msg);
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
    const changed = [...this.store.changedFiles, ...this.store.untrackedFiles];
    const conflicts = this.store.mergeConflicts;

    if (conflicts.length > 0) this.renderSection("Merge Conflicts", conflicts, "conflict");
    if (staged.length > 0) this.renderSection("Staged Changes", staged, "staged");
    if (changed.length > 0) this.renderSection("Changes", changed, "changed");

    if (staged.length + changed.length + conflicts.length === 0) {
      this.fileListEl.createDiv("gs-sc-empty").setText("No changes");
    }
  }

  private renderSection(title: string, files: FileStatus[], group: string): void {
    if (!this.fileListEl) return;

    const section = this.fileListEl.createDiv("gs-sc-section");
    const header = section.createDiv("gs-sc-section-header");

    const headerLeft = header.createDiv("gs-section-left");
    const chevron = headerLeft.createSpan("gs-section-chevron");
    setIcon(chevron, "chevron-down");
    headerLeft.createSpan("gs-section-title").setText(title);

    const headerRight = header.createDiv("gs-section-right");
    const headerActions = headerRight.createDiv("gs-section-actions");

    // Count badge goes after actions (rightmost)
    const countBadge = headerRight.createSpan("gs-section-count");
    countBadge.setText(String(files.length));
    if (group === "staged") countBadge.addClass("gs-count-staged");
    else if (group === "changed") countBadge.addClass("gs-count-changed");
    else if (group === "conflict") countBadge.addClass("gs-count-conflict");
    if (group === "staged") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "minus");
      btn.setAttribute("aria-label", "Unstage All");
      btn.addEventListener("click", async (e) => { e.stopPropagation(); await this.git.unstageAll(); await this.store.refresh(); });
    } else if (group !== "conflict") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "plus");
      btn.setAttribute("aria-label", "Stage All");
      btn.addEventListener("click", async (e) => { e.stopPropagation(); await this.git.stageAll(); await this.store.refresh(); });
    }
    if (group === "changed") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "rotate-ccw");
      btn.setAttribute("aria-label", "Discard All");
      btn.addEventListener("click", async (e) => { e.stopPropagation(); await this.git.discard(files.map(f => f.path)); await this.store.refresh(); });
    }

    const tree = this.buildFileTree(files, group);
    const allDirPaths = this.collectDirPaths(tree);

    let allExpanded = allDirPaths.every(p => this.expandedDirs.has(p));
    const toggleBtn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
    setIcon(toggleBtn, allExpanded ? "fold-vertical" : "unfold-vertical");
    toggleBtn.setAttribute("aria-label", allExpanded ? "Collapse All" : "Expand All");
    toggleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      allExpanded = !allExpanded;
      for (const p of allDirPaths) {
        if (allExpanded) this.expandedDirs.add(p);
        else this.expandedDirs.delete(p);
      }
      setIcon(toggleBtn, allExpanded ? "fold-vertical" : "unfold-vertical");
      toggleBtn.setAttribute("aria-label", allExpanded ? "Collapse All" : "Expand All");
      this.renderFiles();
    });

    const treeEl = section.createDiv("gs-sc-tree");
    let collapsed = false;

    header.addEventListener("click", () => {
      collapsed = !collapsed;
      treeEl.style.display = collapsed ? "none" : "";
      setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
    });

    this.renderTree(treeEl, tree, group, 0);
  }

  private collectDirPaths(nodes: FileTreeNode[]): string[] {
    const paths: string[] = [];
    for (const n of nodes) {
      if (n.isDir) {
        paths.push(n.path);
        paths.push(...this.collectDirPaths(n.children));
      }
    }
    return paths;
  }

  private collectFilePaths(node: FileTreeNode): string[] {
    const paths: string[] = [];
    for (const child of node.children) {
      if (child.isDir) {
        paths.push(...this.collectFilePaths(child));
      } else if (child.file) {
        paths.push(child.file.path);
      }
    }
    return paths;
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
        dirRow.style.paddingLeft = (depth * 16 + 8) + "px";

        const chevron = dirRow.createSpan("gs-tree-chevron");
        setIcon(chevron, node.expanded ? "chevron-down" : "chevron-right");

        const folderIcon = dirRow.createSpan("gs-tree-folder-icon");
        setIcon(folderIcon, node.expanded ? "folder-open" : "folder");

        dirRow.createSpan("gs-tree-dirname").setText(node.name);

        const dirRight = dirRow.createDiv("gs-tree-dir-right");
        const dirActions = dirRight.createDiv("gs-tree-dir-actions");

        if (group === "changed") {
          {
            const discardBtn = dirActions.createEl("button", { cls: "gs-action-btn" });
            setIcon(discardBtn, "undo");
            discardBtn.setAttribute("aria-label", "Discard All in Folder");
            discardBtn.addEventListener("click", async (e) => {
              e.stopPropagation();
              await this.git.discard(this.collectFilePaths(node));
              await this.store.refresh();
            });
          }
          const stageBtn = dirActions.createEl("button", { cls: "gs-action-btn" });
          setIcon(stageBtn, "plus");
          stageBtn.setAttribute("aria-label", "Stage All in Folder");
          stageBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.git.stage(this.collectFilePaths(node));
            await this.store.refresh();
          });
        }

        if (group === "staged") {
          const unstageBtn = dirActions.createEl("button", { cls: "gs-action-btn" });
          setIcon(unstageBtn, "minus");
          unstageBtn.setAttribute("aria-label", "Unstage All in Folder");
          unstageBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await this.git.unstage(this.collectFilePaths(node));
            await this.store.refresh();
          });
        }

        dirRight.createSpan("gs-tree-dir-dot");

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
    row.style.paddingLeft = (depth * 16 + 8) + "px";

    const fileIcon = row.createSpan("gs-tree-file-icon");
    const ext = file.path.split(".").pop()?.toLowerCase() || "";
    const iconMap: Record<string, string> = {
      md: "file-text", json: "braces", css: "paintbrush", js: "file-code",
      ts: "file-code", html: "code", yml: "file-cog", yaml: "file-cog",
      png: "image", jpg: "image", svg: "image", gif: "image",
    };
    setIcon(fileIcon, iconMap[ext] || "file");
    fileIcon.addClass(`gs-ext-${ext || "default"}`);

    const nameEl = row.createSpan("gs-tree-filename");
    nameEl.setText(file.path.split("/").pop() || file.path);

    const rightSide = row.createDiv("gs-tree-file-right");

    const statsEl = rightSide.createSpan("gs-tree-file-stats");

    const actions = rightSide.createDiv("gs-tree-file-actions");

    if (group === "changed") {
      const openBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(openBtn, "file-diff");
      openBtn.setAttribute("aria-label", "Open Changes");
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.openDiff(file.path);
      });
    }

    if (group === "changed" && file.workingStatus !== "?") {
      const discardBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(discardBtn, "undo");
      discardBtn.setAttribute("aria-label", "Discard Changes");
      discardBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.discard([file.path]);
        await this.store.refresh();
      });
    }

    if (group !== "staged" && group !== "conflict") {
      const stageBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(stageBtn, "plus");
      stageBtn.setAttribute("aria-label", "Stage Changes");
      stageBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.stage([file.path]);
        await this.store.refresh();
      });
    }

    if (group === "staged") {
      const openBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(openBtn, "file-diff");
      openBtn.setAttribute("aria-label", "Open Changes");
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.plugin.openDiff(file.path);
      });

      const unstageBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(unstageBtn, "minus");
      unstageBtn.setAttribute("aria-label", "Unstage Changes");
      unstageBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.unstage([file.path]);
        await this.store.refresh();
      });
    }

    const badge = rightSide.createSpan("gs-tree-badge");
    const statusChar = group === "staged" ? file.indexStatus : file.workingStatus;
    const displayChar = statusChar === "?" ? "U" : statusChar;
    badge.setText(displayChar);
    badge.addClass(`gs-badge-${displayChar}`);

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

  /* ============================================================
     Sidebar compact graph
     ============================================================ */
  private buildSidebarGraph(panel: HTMLElement): void {
    const toolbar = panel.createDiv("gs-sg-toolbar");
    const searchWrap = toolbar.createDiv("gs-sg-search-wrap");
    const searchIcon = searchWrap.createSpan("gs-sg-search-icon");
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      cls: "gs-sg-search-input",
      attr: { type: "text", placeholder: "Filter commits..." },
    });
    searchInput.addEventListener("input", () => {
      this.filterSidebarGraph(searchInput.value.toLowerCase());
    });

    const refreshBtn = toolbar.createEl("button", { cls: "gs-icon-btn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => {
      this.store.refreshLog({ all: true, maxCount: 500 });
      this.store.refresh();
    });

    const expandBtn = toolbar.createEl("button", { cls: "gs-icon-btn" });
    setIcon(expandBtn, "maximize-2");
    expandBtn.setAttribute("aria-label", "Open full graph");
    expandBtn.addEventListener("click", () => this.plugin.openGraphView());

    this.graphListEl = panel.createDiv("gs-sg-list");
  }

  private rebuildSidebarGraph(): void {
    const result = computeGraphLayout(this.store.commits);
    this.graphNodes = result.nodes;
    this.renderSidebarGraphList();
  }

  private sidebarGraphFilter = "";

  private filterSidebarGraph(text: string): void {
    this.sidebarGraphFilter = text;
    this.renderSidebarGraphList();
  }

  private renderSidebarGraphList(): void {
    if (!this.graphListEl) return;
    this.graphListEl.empty();

    const hasWC = this.store.status.length > 0;
    if (hasWC) {
      const wcRow = this.graphListEl.createDiv("gs-sg-row gs-sg-row-wc");
      const dotCol = wcRow.createDiv("gs-sg-dot-col");
      const dot = dotCol.createSpan("gs-sg-wc-dot");
      dot.setText("●");

      const info = wcRow.createDiv("gs-sg-info");
      info.createSpan("gs-sg-msg").setText("Working Changes");
      const meta = info.createSpan("gs-sg-meta");
      const totalChanges = this.store.changedFiles.length + this.store.untrackedFiles.length + this.store.stagedFiles.length;
      meta.setText(`${totalChanges} file${totalChanges !== 1 ? "s" : ""} · You`);

      wcRow.addEventListener("click", () => this.switchTab("changes"));
    }

    for (let i = 0; i < this.graphNodes.length; i++) {
      const node = this.graphNodes[i];
      const commit = node.commit;

      if (this.sidebarGraphFilter) {
        const q = this.sidebarGraphFilter;
        if (
          !commit.message.toLowerCase().includes(q) &&
          !commit.author.toLowerCase().includes(q) &&
          !commit.shortHash.toLowerCase().includes(q)
        ) continue;
      }

      const row = this.graphListEl.createDiv("gs-sg-row");
      if (commit.hash === this.graphSelectedHash) row.addClass("gs-sg-row-selected");

      const dotCol = row.createDiv("gs-sg-dot-col");
      const COLORS = ["#0ea5e9","#22c55e","#f59e0b","#ef4444","#a855f7","#ec4899","#14b8a6","#f97316","#6366f1","#84cc16","#06b6d4","#e879f9"];
      const color = COLORS[node.color % COLORS.length];
      const isMerge = commit.parents.length > 1;

      const dot = dotCol.createSpan("gs-sg-dot");
      dot.setText(isMerge ? "◎" : "●");
      dot.style.color = color;

      const info = row.createDiv("gs-sg-info");

      if (commit.refs.length > 0) {
        const refsEl = info.createDiv("gs-sg-refs");
        for (const ref of commit.refs) {
          const pill = refsEl.createSpan("gs-sg-ref-pill");
          if (ref.type === "head") pill.addClass("gs-ref-head");
          else if (ref.type === "remote") pill.addClass("gs-ref-remote");
          else if (ref.type === "tag") pill.addClass("gs-ref-tag");
          else pill.addClass("gs-ref-branch");
          pill.setText(ref.name);
        }
      }

      info.createSpan("gs-sg-msg").setText(commit.message);
      const meta = info.createSpan("gs-sg-meta");
      meta.setText(`${commit.shortHash} · ${commit.author} · ${formatRelativeDate(commit.date)}`);

      row.addEventListener("click", () => {
        if (this.graphSelectedHash === commit.hash) {
          this.graphSelectedHash = null;
        } else {
          this.graphSelectedHash = commit.hash;
        }
        this.renderSidebarGraphList();
      });

      row.addEventListener("contextmenu", (e) => {
        const menu = new Menu();
        menu.addItem(item => item.setTitle("Copy SHA").setIcon("copy").onClick(() => {
          navigator.clipboard.writeText(commit.hash);
          new Notice("SHA copied");
        }));
        menu.addItem(item => item.setTitle("View Changes").setIcon("file-diff").onClick(async () => {
          try {
            const files = await this.git.showCommitFiles(commit.hash);
            if (files.length > 0) this.plugin.openDiff(files[0].path, commit.hash);
          } catch { new Notice("Could not load changes"); }
        }));
        menu.addSeparator();
        menu.addItem(item => item.setTitle("Checkout").setIcon("log-in").onClick(async () => {
          try {
            await this.git.checkout(commit.hash);
            await this.store.refresh();
            new Notice("Checked out " + commit.shortHash);
          } catch (err: unknown) { new Notice(`Error: ${err instanceof Error ? err.message : String(err)}`); }
        }));
        menu.addItem(item => item.setTitle("Open in Graph").setIcon("git-branch").onClick(() => this.plugin.openGraphView()));
        menu.showAtMouseEvent(e);
      });

      if (this.graphSelectedHash === commit.hash) {
        const detail = this.graphListEl.createDiv("gs-sg-detail");
        detail.createDiv("gs-sg-detail-msg").setText(commit.message);
        if (commit.body) detail.createDiv("gs-sg-detail-body").setText(commit.body);

        const detailMeta = detail.createDiv("gs-sg-detail-meta");
        detailMeta.createSpan().setText(`${commit.author} <${commit.authorEmail}>`);
        detailMeta.createEl("br");
        detailMeta.createSpan().setText(commit.date.toLocaleString());
        detailMeta.createEl("br");
        detailMeta.createSpan("gs-sg-detail-sha").setText(commit.hash);

        const detailActions = detail.createDiv("gs-sg-detail-actions");
        const copyBtn = detailActions.createEl("button", { cls: "gs-sg-detail-btn", text: "Copy SHA" });
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(commit.hash);
          new Notice("SHA copied");
        });
        const viewBtn = detailActions.createEl("button", { cls: "gs-sg-detail-btn", text: "View Changes" });
        viewBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const files = await this.git.showCommitFiles(commit.hash);
            if (files.length > 0) this.plugin.openDiff(files[0].path, commit.hash);
          } catch { new Notice("Could not load changes"); }
        });

        this.loadSidebarCommitFiles(commit.hash, detail);
      }
    }

    if (this.graphNodes.length === 0 && !hasWC) {
      this.graphListEl.createDiv("gs-sg-empty").setText("No commits");
    }
  }

  private async loadSidebarCommitFiles(hash: string, detail: HTMLElement): Promise<void> {
    try {
      const files = await this.git.showCommitFiles(hash);
      if (files.length === 0) return;
      const filesEl = detail.createDiv("gs-sg-detail-files");
      filesEl.createDiv("gs-sg-detail-files-header").setText(`${files.length} file${files.length !== 1 ? "s" : ""} changed`);
      for (const f of files) {
        const fileRow = filesEl.createDiv("gs-sg-detail-file");
        const name = fileRow.createSpan("gs-sg-detail-filename");
        name.setText(f.path);
        const stats = fileRow.createSpan("gs-sg-detail-filestats");
        if (f.additions > 0) stats.createSpan("gs-stat-add").setText(`+${f.additions}`);
        if (f.deletions > 0) stats.createSpan("gs-stat-del").setText(` -${f.deletions}`);
        fileRow.addEventListener("click", (e) => {
          e.stopPropagation();
          this.plugin.openDiff(f.path, hash);
        });
      }
    } catch {
      // ignore
    }
  }

  async onClose(): Promise<void> {
    if (this.focusHandler) window.removeEventListener("focus", this.focusHandler);
  }
}

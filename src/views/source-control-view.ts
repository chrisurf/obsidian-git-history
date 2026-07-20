import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE, FileStatus, GraphNode, CommitInfo, CommitStats } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { computeGraphLayout, formatRelativeDate } from "../utils/graph-layout";
import type GitHistoryPlugin from "../main";

interface FileTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: FileTreeNode[];
  file?: FileStatus;
  expanded: boolean;
}

type SidebarTab = "changes" | "graph";
type GraphSubTab = "graph" | "commit-changes";

export class SourceControlView extends ItemView {
  private plugin: GitHistoryPlugin;
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
  /** Lazily resolved stats for commits git omits from --shortstat. */
  private statsFallback = new Map<string, CommitStats>();
  private graphListEl: HTMLElement | null = null;
  private sgWcRow: HTMLElement | null = null;
  private sgWcMeta: HTMLElement | null = null;
  private graphSelectedHash: string | null = null;
  private focusHandler: (() => void) | null = null;
  private tooltipEl: HTMLElement | null = null;
  private tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

  private graphSubTabBtns: Record<string, HTMLElement> = {};
  private graphSubGraphPanel: HTMLElement | null = null;
  private graphSubChangesPanel: HTMLElement | null = null;
  private selectedCommitForChanges: CommitInfo | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.git = plugin.git;
  }

  getViewType(): string {
    return SOURCE_CONTROL_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Source Control";
  }
  getIcon(): string {
    return "git-commit-horizontal";
  }

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

    this.registerEvent(
      this.store.on("status-changed", () => {
        this.renderFiles();
        // Commits are unchanged, so only the working changes row needs updating.
        if (this.activeTab === "graph") this.syncSidebarWorkingRow();
      }),
    );
    this.registerEvent(this.store.on("branch-changed", () => this.updateBranch()));
    this.registerEvent(
      this.store.on("log-changed", () => {
        if (this.activeTab === "graph") this.rebuildSidebarGraph();
      }),
    );
    this.registerEvent(
      this.store.on("loading", ((...args: unknown[]) => {
        contentEl.toggleClass("gs-loading", args[0] as boolean);
      }) as (...data: unknown[]) => unknown),
    );

    this.focusHandler = () => this.store.refresh();
    window.addEventListener("focus", this.focusHandler);

    await this.store.refresh();
    this.renderFiles();
    await this.store.refreshBranches();
  }

  private buildTabBar(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-tabbar");

    const changesBtn = bar.createEl("button", {
      cls: "gs-sc-tab gs-sc-tab-active",
      text: "Changes",
    });
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
    } else if (tab === "changes") {
      this.renderFiles();
    }
  }

  private buildHeader(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-header");
    bar.createSpan("gs-sc-header-title").setText("SOURCE CONTROL");

    const actions = bar.createDiv("gs-sc-header-actions");
    for (const [icon, label, fn] of [
      [
        "refresh-cw",
        "Refresh",
        async () => {
          await this.store.refresh();
          this.renderFiles();
        },
      ],
      [
        "download",
        "Pull",
        async () => {
          try {
            await this.git.pull({ strategy: this.plugin.settings.pullStrategy });
            await this.store.refresh();
            new Notice("Pulled");
          } catch (e: unknown) {
            new Notice(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ],
      [
        "upload",
        "Push",
        async () => {
          try {
            await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch });
            await this.store.refresh();
            new Notice("Pushed");
          } catch (e: unknown) {
            new Notice(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ],
      [
        "cloud-download",
        "Fetch",
        async () => {
          try {
            await this.git.fetch();
            await this.store.refresh();
            new Notice("Fetched");
          } catch (e: unknown) {
            new Notice(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ],
      [
        "archive",
        "Stash",
        async () => {
          try {
            await this.git.stashSave();
            await this.store.refresh();
            new Notice("Stashed");
          } catch (e: unknown) {
            new Notice(`${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ],
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
      attr: {
        type: "text",
        placeholder: `Message (⌘Enter to commit on "${this.store.branch || "main"}")`,
      },
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
      menu.addItem((i) =>
        i
          .setTitle("Commit")
          .setIcon("check")
          .onClick(() => this.doCommit()),
      );
      menu.addItem((i) =>
        i
          .setTitle("Commit & Push")
          .setIcon("upload")
          .onClick(() => this.doCommit(true)),
      );
      menu.addSeparator();
      menu.addItem((i) => {
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
    menu.addItem((i) =>
      i
        .setTitle("Pop Stash")
        .setIcon("archive-restore")
        .onClick(async () => {
          try {
            await this.git.stashPop();
            await this.store.refresh();
            new Notice("Stash popped");
          } catch (e: unknown) {
            new Notice(`${e instanceof Error ? e.message : String(e)}`);
          }
        }),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Switch Branch...")
        .setIcon("git-branch")
        .onClick(async () => {
          await this.showBranchMenu(event);
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Open Git Graph")
        .setIcon("git-branch")
        .onClick(() => this.plugin.openGraphView()),
    );
    menu.addItem((i) =>
      i
        .setTitle("Open History")
        .setIcon("history")
        .onClick(() => this.plugin.openHistoryView()),
    );
    menu.showAtMouseEvent(event);
  }

  private async showBranchMenu(event: MouseEvent): Promise<void> {
    await this.store.refreshBranches();
    const menu = new Menu();
    for (const b of this.store.branches.filter((b) => !b.remote)) {
      menu.addItem((i) => {
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
    menu.addItem((i) =>
      i
        .setTitle("+ Create new branch...")
        .setIcon("plus")
        .onClick(async () => {
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
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private updateBranch(): void {
    if (this.commitInput) {
      this.commitInput.setAttribute(
        "placeholder",
        `Message (⌘Enter to commit on "${this.store.branch || "main"}")`,
      );
    }
  }

  private async doCommit(andPush = false): Promise<void> {
    const msg = this.commitInput?.value?.trim();
    if (!msg) {
      new Notice("Please enter a commit message");
      return;
    }

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
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await this.git.unstageAll();
        } catch (err) {
          new Notice(`Unstage all failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.store.refresh();
      });
    } else if (group !== "conflict") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "plus");
      btn.setAttribute("aria-label", "Stage All");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          const { skipped } = await this.git.stageAll();
          // Only worth a notice when the user can actually see the entries the
          // message is about; otherwise they were deliberately hidden.
          if (skipped.length > 0 && this.store.showNestedRepos) {
            new Notice(
              `Skipped ${skipped.length} nested Git ${skipped.length === 1 ? "repository" : "repositories"}: ${skipped.join(", ")}`,
            );
          }
        } catch (err) {
          new Notice(`Stage all failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.store.refresh();
      });
    }
    if (group === "changed") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "rotate-ccw");
      btn.setAttribute("aria-label", "Discard All");
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await this.git.discardAll();
        } catch (err) {
          new Notice(`Discard all failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.store.refresh();
      });
    }

    const tree = this.buildFileTree(files, group);
    const allDirPaths = this.collectDirPaths(tree);

    let allExpanded = allDirPaths.every((p) => this.expandedDirs.has(p));
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
      } else if (child.file && !child.file.embeddedRepo) {
        // `git add` cannot index a nested repository, and one of them in the
        // list makes the whole call fail.
        paths.push(child.file.path);
      }
    }
    return paths;
  }

  private buildFileTree(files: FileStatus[], _group: string): FileTreeNode[] {
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

  private renderTree(
    parent: HTMLElement,
    nodes: FileTreeNode[],
    group: string,
    depth: number,
  ): void {
    for (const node of nodes) {
      if (node.isDir) {
        const dirRow = parent.createDiv("gs-tree-dir");
        dirRow.style.paddingLeft = depth * 16 + 8 + "px";

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
    row.style.paddingLeft = depth * 16 + 8 + "px";

    const fileIcon = row.createSpan("gs-tree-file-icon");
    const ext = file.path.split(".").pop()?.toLowerCase() || "";
    const iconMap: Record<string, string> = {
      md: "file-text",
      json: "braces",
      css: "paintbrush",
      js: "file-code",
      ts: "file-code",
      html: "code",
      yml: "file-cog",
      yaml: "file-cog",
      png: "image",
      jpg: "image",
      svg: "image",
      gif: "image",
    };
    setIcon(fileIcon, file.embeddedRepo ? "git-branch" : iconMap[ext] || "file");
    fileIcon.addClass(`gs-ext-${ext || "default"}`);

    const nameEl = row.createSpan("gs-tree-filename");
    nameEl.setText(file.path.split("/").pop() || file.path);
    if (file.embeddedRepo) {
      row.addClass("gs-tree-file-embedded");
      row.setAttribute(
        "aria-label",
        "Nested Git repository — cannot be staged. Add it as a submodule or ignore it.",
      );
    }

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

    if (group !== "staged" && group !== "conflict" && !file.embeddedRepo) {
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
      menu.addItem((i) =>
        i
          .setTitle("Open File")
          .setIcon("file")
          .onClick(() => this.app.workspace.openLinkText(file.path, "", false)),
      );
      menu.addItem((i) =>
        i
          .setTitle("Open Diff")
          .setIcon("file-diff")
          .onClick(() => this.plugin.openDiff(file.path)),
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Copy Path")
          .setIcon("copy")
          .onClick(() => {
            navigator.clipboard.writeText(file.path);
            new Notice("Path copied");
          }),
      );
      menu.showAtMouseEvent(e);
    });

    this.loadFileStats(file, statsEl, group);
  }

  private async loadFileStats(file: FileStatus, el: HTMLElement, group: string): Promise<void> {
    try {
      const raw =
        group === "staged" ? await this.git.diff(file.path, true) : await this.git.diff(file.path);
      if (!raw) return;
      let adds = 0,
        dels = 0;
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

  /* ============================================================
     Sidebar compact graph
     ============================================================ */
  private buildSidebarGraph(panel: HTMLElement): void {
    const subTabBar = panel.createDiv("gs-sg-subtabbar");
    const graphSubBtn = subTabBar.createSpan("gs-sg-subtab gs-sg-subtab-active");
    graphSubBtn.setText("Graph");
    const changesSubBtn = subTabBar.createSpan("gs-sg-subtab");
    changesSubBtn.setText("Changes");
    this.graphSubTabBtns["graph"] = graphSubBtn;
    this.graphSubTabBtns["commit-changes"] = changesSubBtn;
    graphSubBtn.addEventListener("click", () => this.switchGraphSubTab("graph"));
    changesSubBtn.addEventListener("click", () => this.switchGraphSubTab("commit-changes"));

    this.graphSubGraphPanel = panel.createDiv("gs-sg-subpanel");
    this.graphSubChangesPanel = panel.createDiv("gs-sg-subpanel");
    this.graphSubChangesPanel.style.display = "none";

    const toolbar = this.graphSubGraphPanel.createDiv("gs-sg-toolbar");
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

    this.graphListEl = this.graphSubGraphPanel.createDiv("gs-sg-list");

    this.graphSubChangesPanel
      .createDiv("gs-sg-changes-empty")
      .setText("Click a commit in the Git Graph to see its changes here.");
  }

  private switchGraphSubTab(tab: GraphSubTab): void {
    for (const [key, btn] of Object.entries(this.graphSubTabBtns)) {
      btn.toggleClass("gs-sg-subtab-active", key === tab);
    }
    if (this.graphSubGraphPanel)
      this.graphSubGraphPanel.style.display = tab === "graph" ? "" : "none";
    if (this.graphSubChangesPanel)
      this.graphSubChangesPanel.style.display = tab === "commit-changes" ? "" : "none";
  }

  showCommitChanges(commit: CommitInfo): void {
    this.selectedCommitForChanges = commit;
    this.switchTab("graph");
    this.switchGraphSubTab("commit-changes");
    this.renderCommitChangesPanel();
  }

  private async renderCommitChangesPanel(): Promise<void> {
    if (!this.graphSubChangesPanel || !this.selectedCommitForChanges) return;
    this.graphSubChangesPanel.empty();

    const commit = this.selectedCommitForChanges;

    const header = this.graphSubChangesPanel.createDiv("gs-sg-changes-header");
    const avatarEl = header.createDiv("gs-sg-avatar");
    const initials = commit.author
      .split(" ")
      .map((w) => w[0] || "")
      .join("")
      .substring(0, 2)
      .toUpperCase();
    if (initials) {
      avatarEl.setText(initials);
    } else {
      setIcon(avatarEl, "git-commit-horizontal");
    }

    const headerInfo = header.createDiv("gs-sg-changes-header-info");
    headerInfo.createDiv("gs-sg-changes-msg").setText(commit.message);
    const metaEl = headerInfo.createDiv("gs-sg-changes-meta");
    metaEl.setText(`${commit.shortHash} · ${commit.author} · ${formatRelativeDate(commit.date)}`);

    const actionsEl = this.graphSubChangesPanel.createDiv("gs-sg-changes-actions");
    const copyBtn = actionsEl.createEl("button", { cls: "gs-sg-detail-btn", text: "Copy SHA" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(commit.hash);
      new Notice("SHA copied");
    });
    const viewBtn = actionsEl.createEl("button", { cls: "gs-sg-detail-btn", text: "View Changes" });
    viewBtn.addEventListener("click", async () => {
      try {
        const files = await this.git.showCommitFiles(commit.hash);
        if (files.length > 0) this.plugin.openDiff(files[0].path, commit.hash);
      } catch {
        new Notice("Could not load changes");
      }
    });

    const filesContainer = this.graphSubChangesPanel.createDiv("gs-sg-changes-files");
    const loadingEl = filesContainer.createDiv("gs-sg-changes-loading");
    loadingEl.setText("Loading files...");

    try {
      const files = await this.git.showCommitFiles(commit.hash);
      filesContainer.empty();

      if (files.length === 0) {
        filesContainer.createDiv("gs-sg-changes-empty").setText("No files changed");
        return;
      }

      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);

      const summaryEl = filesContainer.createDiv("gs-sg-changes-summary");
      summaryEl.createSpan().setText(`${files.length} FILES CHANGED`);
      if (totalAdd > 0) summaryEl.createSpan("gs-stat-add").setText(` +${totalAdd}`);
      if (totalDel > 0) summaryEl.createSpan("gs-stat-del").setText(` -${totalDel}`);

      for (const f of files) {
        const fileRow = filesContainer.createDiv("gs-sg-changes-file-row");

        const fileIcon = fileRow.createSpan("gs-sg-changes-file-icon");
        setIcon(fileIcon, "file");

        const fileName = fileRow.createSpan("gs-sg-changes-file-name");
        fileName.setText(f.path);

        const fileStats = fileRow.createSpan("gs-sg-changes-file-stats");
        if (f.additions > 0) fileStats.createSpan("gs-stat-add").setText(`+${f.additions}`);
        if (f.deletions > 0) fileStats.createSpan("gs-stat-del").setText(` -${f.deletions}`);

        fileRow.addEventListener("click", () => {
          this.plugin.openDiff(f.path, commit.hash);
        });
      }
    } catch {
      filesContainer.empty();
      filesContainer.createDiv("gs-sg-changes-empty").setText("Could not load changes");
    }
  }

  private rebuildSidebarGraph(): void {
    const result = computeGraphLayout(this.store.commits);
    this.graphNodes = result.nodes;
    this.renderSidebarGraphList();
  }

  /**
   * Creates or updates the working changes row in place. A status change only
   * affects this one row, so it must not drag the whole commit list — and with
   * the vault watcher firing on every edit, it was doing exactly that.
   */
  private syncSidebarWorkingRow(): void {
    if (!this.graphListEl) return;

    if (this.store.status.length === 0) {
      this.sgWcRow?.remove();
      this.sgWcRow = null;
      this.sgWcMeta = null;
      return;
    }

    if (!this.sgWcRow) {
      const row = createDiv("gs-sg-row gs-sg-row-wc");
      const avatarCol = row.createDiv("gs-sg-avatar-col");
      setIcon(avatarCol.createDiv("gs-sg-avatar gs-sg-avatar-wc"), "pen-line");

      const info = row.createDiv("gs-sg-info");
      info.createSpan("gs-sg-msg").setText("Working Changes");
      this.sgWcMeta = info.createDiv("gs-sg-meta-line").createSpan("gs-sg-meta");
      row.addEventListener("click", () => this.switchTab("changes"));

      this.sgWcRow = row;
    }

    const total =
      this.store.changedFiles.length +
      this.store.untrackedFiles.length +
      this.store.stagedFiles.length;
    this.sgWcMeta?.setText(`${total} file${total !== 1 ? "s" : ""} · You`);

    if (this.graphListEl.firstChild !== this.sgWcRow) {
      this.graphListEl.prepend(this.sgWcRow);
    }
  }

  private sidebarGraphFilter = "";

  private filterSidebarGraph(text: string): void {
    this.sidebarGraphFilter = text;
    this.renderSidebarGraphList();
  }

  private renderSidebarGraphList(): void {
    if (!this.graphListEl) return;
    this.graphListEl.empty();

    this.syncSidebarWorkingRow();
    const hasWC = this.sgWcRow !== null;

    for (let i = 0; i < this.graphNodes.length; i++) {
      const node = this.graphNodes[i];
      const commit = node.commit;

      if (this.sidebarGraphFilter) {
        const q = this.sidebarGraphFilter;
        if (
          !commit.message.toLowerCase().includes(q) &&
          !commit.author.toLowerCase().includes(q) &&
          !commit.shortHash.toLowerCase().includes(q)
        )
          continue;
      }

      const row = this.graphListEl.createDiv("gs-sg-row");
      if (commit.hash === this.graphSelectedHash) row.addClass("gs-sg-row-selected");

      const avatarCol = row.createDiv("gs-sg-avatar-col");
      const avatar = avatarCol.createDiv("gs-sg-avatar");
      const initials = commit.author
        .split(" ")
        .map((w) => w[0] || "")
        .join("")
        .substring(0, 2)
        .toUpperCase();
      if (initials) {
        avatar.setText(initials);
      } else {
        setIcon(avatar, "git-commit-horizontal");
      }

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
      const metaLine = info.createDiv("gs-sg-meta-line");
      const meta = metaLine.createSpan("gs-sg-meta");
      meta.setText(`${commit.shortHash} · ${commit.author} · ${formatRelativeDate(commit.date)}`);
      this.renderChangesBar(commit, metaLine);

      row.addEventListener("mouseenter", () => {
        if (this.tooltipTimeout) clearTimeout(this.tooltipTimeout);
        this.tooltipTimeout = setTimeout(() => this.showCommitTooltip(commit, row), 400);
      });
      row.addEventListener("mouseleave", () => {
        if (this.tooltipTimeout) {
          clearTimeout(this.tooltipTimeout);
          this.tooltipTimeout = null;
        }
        this.hideCommitTooltip();
      });

      row.addEventListener("click", () => {
        this.hideCommitTooltip();
        if (this.graphSelectedHash === commit.hash) {
          this.graphSelectedHash = null;
        } else {
          this.graphSelectedHash = commit.hash;
        }
        this.renderSidebarGraphList();
      });

      row.addEventListener("contextmenu", (e) => {
        this.hideCommitTooltip();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle("Copy SHA")
            .setIcon("copy")
            .onClick(() => {
              navigator.clipboard.writeText(commit.hash);
              new Notice("SHA copied");
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("View Changes")
            .setIcon("file-diff")
            .onClick(async () => {
              try {
                const files = await this.git.showCommitFiles(commit.hash);
                if (files.length > 0) this.plugin.openDiff(files[0].path, commit.hash);
              } catch {
                new Notice("Could not load changes");
              }
            }),
        );
        menu.addSeparator();
        menu.addItem((item) =>
          item
            .setTitle("Checkout")
            .setIcon("log-in")
            .onClick(async () => {
              try {
                await this.git.checkout(commit.hash);
                await this.store.refresh();
                new Notice("Checked out " + commit.shortHash);
              } catch (err: unknown) {
                new Notice(`Error: ${err instanceof Error ? err.message : String(err)}`);
              }
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("Open in Graph")
            .setIcon("git-branch")
            .onClick(() => this.plugin.openGraphView()),
        );
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
        const copyBtn = detailActions.createEl("button", {
          cls: "gs-sg-detail-btn",
          text: "Copy SHA",
        });
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(commit.hash);
          new Notice("SHA copied");
        });
        const viewBtn = detailActions.createEl("button", {
          cls: "gs-sg-detail-btn",
          text: "View Changes",
        });
        viewBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          try {
            const files = await this.git.showCommitFiles(commit.hash);
            if (files.length > 0) this.plugin.openDiff(files[0].path, commit.hash);
          } catch {
            new Notice("Could not load changes");
          }
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
      filesEl
        .createDiv("gs-sg-detail-files-header")
        .setText(`${files.length} file${files.length !== 1 ? "s" : ""} changed`);
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

  /**
   * Renders the changes bar for a commit. Stats arrive with the commit log, so
   * this is synchronous and costs no git process — the list renders one row per
   * commit, and a lookup per row meant hundreds of processes per rebuild.
   * Only commits git emits no stat block for fall back, cached per hash.
   */
  private renderChangesBar(commit: CommitInfo, container: HTMLElement): void {
    const stats = commit.stats ?? this.statsFallback.get(commit.hash);
    if (stats) {
      this.paintChangesBar(stats, container);
      return;
    }
    if (this.statsFallback.has(commit.hash)) return;

    container.dataset.hash = commit.hash;
    void this.git
      .showCommitFiles(commit.hash)
      .then((files) => {
        const resolved: CommitStats = {
          filesChanged: files.length,
          additions: files.reduce((s, f) => s + f.additions, 0),
          deletions: files.reduce((s, f) => s + f.deletions, 0),
        };
        this.statsFallback.set(commit.hash, resolved);
        if (container.isConnected && container.dataset.hash === commit.hash) {
          this.paintChangesBar(resolved, container);
        }
      })
      .catch(() => {
        // leave the bar empty for commits we cannot stat
      });
  }

  private paintChangesBar(stats: CommitStats, container: HTMLElement): void {
    const total = stats.additions + stats.deletions;
    if (stats.filesChanged === 0 || total === 0) return;

    const wrap = container.createDiv("gs-sg-changes-bar-wrap");
    const icon = wrap.createSpan("gs-sg-changes-icon");
    setIcon(icon, "file");
    wrap.createSpan("gs-sg-changes-count").setText(String(stats.filesChanged));
    const bar = wrap.createDiv("gs-sg-changes-bar");
    const addPct = Math.round((stats.additions / total) * 100);
    bar.createDiv("gs-sg-changes-add").style.width = addPct + "%";
    bar.createDiv("gs-sg-changes-del").style.width = 100 - addPct + "%";
  }

  private el(tag: string, cls: string, text?: string): HTMLElement {
    const e = document.createElement(tag);
    e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  private showCommitTooltip(commit: CommitInfo, anchor: HTMLElement): void {
    this.hideCommitTooltip();
    const tip = this.el("div", "gs-sg-tooltip");

    const initials = commit.author
      .split(" ")
      .map((w) => w[0] || "")
      .join("")
      .substring(0, 2)
      .toUpperCase();
    tip.appendChild(this.el("div", "gs-sg-tip-avatar", initials || "?"));

    const body = this.el("div", "gs-sg-tip-body");
    tip.appendChild(body);

    const authorLine = this.el("div", "gs-sg-tip-author-line");
    authorLine.appendChild(this.el("span", "gs-sg-tip-author", commit.author));
    authorLine.appendChild(this.el("span", "gs-sg-tip-date-rel", formatRelativeDate(commit.date)));
    body.appendChild(authorLine);

    const dateStr = commit.date.toLocaleString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
    body.appendChild(this.el("div", "gs-sg-tip-date-full", dateStr));

    const shaLine = this.el("div", "gs-sg-tip-sha-line");
    shaLine.appendChild(this.el("span", "gs-sg-tip-sha-icon", "◇"));
    shaLine.appendChild(this.el("span", "gs-sg-tip-sha", commit.shortHash));
    if (commit.parents.length > 0) {
      shaLine.appendChild(
        this.el(
          "span",
          "gs-sg-tip-parents-label",
          ` (${commit.parents.length} parent${commit.parents.length > 1 ? "s" : ""})`,
        ),
      );
    }
    body.appendChild(shaLine);

    body.appendChild(this.el("div", "gs-sg-tip-email", commit.authorEmail));

    const statsPlaceholder = this.el("div", "gs-sg-tip-stats");
    body.appendChild(statsPlaceholder);
    this.loadTooltipStats(commit.hash, statsPlaceholder);

    const msgEl = this.el("div", "gs-sg-tip-msg", commit.message);
    body.appendChild(msgEl);
    if (commit.body) {
      body.appendChild(this.el("div", "gs-sg-tip-msg-body", commit.body));
    }

    document.body.appendChild(tip);
    this.tooltipEl = tip;

    requestAnimationFrame(() => {
      const rect = anchor.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      let top = rect.top - tipRect.height - 6;
      if (top < 8) top = rect.bottom + 6;
      let left = rect.left + 20;
      if (left + tipRect.width > window.innerWidth - 8)
        left = window.innerWidth - tipRect.width - 8;
      tip.style.top = top + "px";
      tip.style.left = left + "px";
      tip.style.opacity = "1";
    });
  }

  private async loadTooltipStats(hash: string, container: HTMLElement): Promise<void> {
    try {
      const files = await this.git.showCommitFiles(hash);
      if (!this.tooltipEl || files.length === 0) return;
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      container.appendChild(
        this.el(
          "span",
          "gs-sg-tip-stats-files",
          `${files.length} file${files.length !== 1 ? "s" : ""} changed`,
        ),
      );
      if (totalAdd > 0)
        container.appendChild(this.el("span", "gs-stat-add", `  ${totalAdd} additions`));
      if (totalDel > 0)
        container.appendChild(this.el("span", "gs-stat-del", `  ${totalDel} deletions`));
    } catch {
      // ignore
    }
  }

  private hideCommitTooltip(): void {
    if (this.tooltipEl) {
      this.tooltipEl.remove();
      this.tooltipEl = null;
    }
  }

  async onClose(): Promise<void> {
    if (this.focusHandler) window.removeEventListener("focus", this.focusHandler);
    this.hideCommitTooltip();
  }
}

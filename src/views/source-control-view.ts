import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice, TFile } from "obsidian";
import {
  SOURCE_CONTROL_VIEW_TYPE,
  FileStatus,
  FileListMode,
  GraphNode,
  CommitInfo,
  CommitStats,
} from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { computeGraphLayout, formatRelativeDate } from "../utils/graph-layout";
import type GitHistoryPlugin from "../main";
import { asVoid } from "../utils/async";
import { confirmChoice, promptText } from "../utils/prompt";
import { resolveTemplate } from "../utils/template";
import { supportedFileFilter } from "../utils/file-types";

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
  private commitBtn: HTMLButtonElement | null = null;
  private fileListEl: HTMLElement | null = null;
  private listToolbarEl: HTMLElement | null = null;
  private listSummaryEl: HTMLElement | null = null;
  private foldBtn: HTMLButtonElement | null = null;
  private modeBtns: Record<string, HTMLElement> = {};
  private expandedDirs = new Set<string>();
  /** Every folder currently in the tree, so "expand all" knows its targets. */
  private allDirPaths: string[] = [];
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
  private tooltipTimeout: number | null = null;
  private progressEl: HTMLElement | null = null;
  private busyLabelEl: HTMLElement | null = null;
  private progressHideTimer: number | null = null;
  private progressShownAt = 0;

  /**
   * Shortest time the progress bar stays up once it appeared. A fetch against a
   * warm remote returns in well under 100ms, and a thin line that appears for
   * that long is not something anyone notices — it has to outlast a glance and,
   * above all, one full sweep of the 0.8s animation. Cut it short and the bar
   * looks stationary, because the segment never leaves the left edge.
   */
  static readonly PROGRESS_MIN_MS = 900;

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
    return "Source control";
  }
  getIcon(): string {
    // Same mark as the ribbon entry that opens this view, the status bar, and
    // the empty-vault screen. `git-commit-horizontal` stays reserved for the
    // per-commit avatars inside the view, where it means one commit.
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    await this.buildForRepoState();
  }

  /**
   * Picks the view the vault's Git state calls for. Called on open and again
   * after an initialization, so the panel never shows commit controls for a
   * vault that has no repository of its own.
   */
  private async buildForRepoState(): Promise<void> {
    if (await this.git.isRepo()) {
      await this.buildRepoView();
      return;
    }
    await this.buildInitView();
  }

  private async buildInitView(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gs-sc-view");

    // A vault can sit inside someone else's repository — a home directory
    // under Git is the common accident. Naming it beats leaving the reader to
    // wonder why the panel offers to initialize something that git already
    // answers questions about.
    const outer = await this.git.enclosingRepoRoot();

    const wrap = contentEl.createDiv("gs-init-view");
    const iconEl = wrap.createDiv("gs-init-icon");
    setIcon(iconEl, "git-branch");
    wrap.createEl("h3", { text: "No Git repository" });
    wrap.createEl("p", {
      text: outer
        ? `This vault is not a Git repository. It sits inside the repository at ${outer}, ` +
          "which tracks more than your vault, so this panel leaves it alone. " +
          "Initialize a repository for the vault itself to start version control."
        : "This vault is not tracked by Git yet. Initialize a repository to start version control.",
      cls: "gs-init-desc",
    });
    const btn = wrap.createEl("button", {
      text: "Initialize repository",
      cls: "mod-cta gs-init-btn",
    });
    btn.addEventListener(
      "click",
      asVoid(async () => {
        try {
          btn.disabled = true;
          await this.git.init();
          this.plugin.activatePostInit();
          // Through the same check that got us here, so a failed init leaves
          // the panel on this screen rather than on empty commit controls.
          await this.buildForRepoState();
          await this.store.refresh();
          new Notice("Git repository initialized");
        } catch (e: unknown) {
          btn.disabled = false;
          new Notice(`Init failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }),
    );
  }

  private async buildRepoView(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gs-sc-view");

    this.buildHeader(contentEl);
    this.buildProgressBar(contentEl);
    this.buildTabBar(contentEl);

    this.changesPanel = contentEl.createDiv("gs-sc-changes-panel");
    this.graphPanel = contentEl.createDiv("gs-sc-graph-panel");
    this.graphPanel.addClass("gs-hidden");

    this.buildCommitArea(this.changesPanel);
    this.buildListToolbar(this.changesPanel);
    this.fileListEl = this.changesPanel.createDiv("gs-sc-filelist");

    this.buildSidebarGraph(this.graphPanel);

    this.registerEvent(
      this.store.on("status-changed", () => {
        this.renderFiles();
        if (this.activeTab === "graph") this.syncSidebarWorkingRow();
      }),
    );
    this.registerEvent(this.store.on("branch-changed", () => this.updateBranch()));
    this.registerEvent(
      this.store.on("log-changed", () => {
        this.rebuildSidebarGraph();
      }),
    );
    this.registerEvent(
      this.store.on("busy-changed", (...args: unknown[]) => {
        this.setProgress(args[0] as boolean, args[1] as string | null);
      }),
    );
    this.registerEvent(
      this.store.on("loading", (...args: unknown[]) => {
        contentEl.toggleClass("gs-loading", args[0] as boolean);
      }),
    );

    this.focusHandler = (): void => {
      void this.store.refresh();
    };
    window.addEventListener("focus", this.focusHandler);

    await this.store.refresh();
    this.renderFiles();
    await Promise.all([this.store.refreshBranches(), this.store.refreshLog()]);
  }

  /**
   * A two-pixel bar between the header and the tabs. It always occupies its
   * row so the panel does not shift by 2px whenever a command runs; only the
   * moving segment appears.
   */
  private buildProgressBar(el: HTMLElement): void {
    this.progressEl = el.createDiv("gs-progress");
    this.progressEl.setAttribute("role", "progressbar");
    this.progressEl.createDiv("gs-progress-bar");
  }

  private setProgress(active: boolean, label: string | null): void {
    const el = this.progressEl;
    if (!el) return;
    if (this.progressHideTimer) {
      window.clearTimeout(this.progressHideTimer);
      this.progressHideTimer = null;
    }

    if (active) {
      this.progressShownAt = Date.now();
      el.addClass("gs-progress-active");
      el.setAttribute("aria-label", label ?? "Working");
      el.setAttribute("aria-busy", "true");
      if (this.busyLabelEl) {
        this.busyLabelEl.setText(`${label ?? "Working"}…`);
        this.busyLabelEl.removeClass("gs-hidden");
      }
      return;
    }

    // A command that finishes in 40ms would otherwise flash once and read as a
    // rendering glitch rather than as feedback.
    const shownFor = Date.now() - this.progressShownAt;
    const wait = Math.max(0, SourceControlView.PROGRESS_MIN_MS - shownFor);
    const hide = (): void => {
      el.removeClass("gs-progress-active");
      el.setAttribute("aria-busy", "false");
      el.removeAttribute("aria-label");
      this.busyLabelEl?.addClass("gs-hidden");
      this.progressHideTimer = null;
    };
    if (wait === 0) hide();
    else this.progressHideTimer = window.setTimeout(hide, wait);
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
    this.changesPanel?.toggleClass("gs-hidden", tab !== "changes");
    this.graphPanel?.toggleClass("gs-hidden", tab !== "graph");

    if (tab === "graph") {
      void this.store.refreshLog({ all: true, maxCount: 500 });
    } else if (tab === "changes") {
      this.renderFiles();
    }
  }

  private buildHeader(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-header");
    const titleWrap = bar.createDiv("gs-sc-header-left");
    titleWrap.createSpan("gs-sc-header-title").setText("Source control");
    // The bar alone sits a few pixels above the active tab's accent underline
    // and reads as part of it. The name of the running command is the part
    // that is actually noticed.
    this.busyLabelEl = titleWrap.createSpan("gs-sc-busy-label");
    this.busyLabelEl.addClass("gs-hidden");

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
            await this.store.runTask("Pulling", () =>
              this.git.pull({ strategy: this.plugin.settings.pullStrategy }),
            );
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
            await this.store.runTask("Pushing", () =>
              this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch }),
            );
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
            await this.store.runTask("Fetching", () => this.git.fetch());
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
            await this.store.runTask("Stashing", () => this.git.stashSave());
            await this.store.refresh();
            new Notice("Stashed");
          } catch (e: unknown) {
            new Notice(`${e instanceof Error ? e.message : String(e)}`);
          }
        },
      ],
      ["more-horizontal", "More", (e: MouseEvent) => this.showMoreMenu(e)],
    ] as [string, string, (...a: unknown[]) => void][]) {
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
        if (!this.commitBtn?.disabled) void this.doCommit();
      }
    });

    this.commitInput.addEventListener("input", () => {
      this.updateCommitBtnState();
    });

    const btnRow = area.createDiv("gs-commit-btn-row");

    this.commitBtn = btnRow.createEl("button", { cls: "gs-commit-main-btn" });
    const checkIcon = this.commitBtn.createSpan("gs-commit-check-icon");
    setIcon(checkIcon, "check");
    this.commitBtn.appendText(" Commit");
    this.commitBtn.addEventListener("click", () => {
      void this.doCommit();
    });
    this.updateCommitBtnState();

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
          .setTitle("Commit & push")
          .setIcon("upload")
          .onClick(() => this.doCommit(true)),
      );
      menu.addSeparator();
      menu.addItem((i) => {
        const isAmend = this.contentEl.querySelector(".gs-commit-input") as HTMLInputElement;
        i.setTitle("Amend previous commit").setIcon("edit");
        i.onClick(async () => {
          try {
            const msg = isAmend?.value?.trim() || "";
            await this.store.runTask("Amending", () =>
              this.git.commit(msg || "amend", { amend: true }),
            );
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
        .setTitle("Pop stash")
        .setIcon("archive-restore")
        .onClick(async () => {
          try {
            await this.store.runTask("Popping stash", () => this.git.stashPop());
            await this.store.refresh();
            new Notice("Stash popped");
          } catch (e: unknown) {
            new Notice(`${e instanceof Error ? e.message : String(e)}`);
          }
        }),
    );
    if (this.store.merging) {
      menu.addItem((i) =>
        i
          .setTitle("Abort merge")
          .setIcon("x")
          .onClick(async () => {
            try {
              await this.store.runTask("Aborting merge", () => this.git.abortMerge());
              await this.store.refresh();
              new Notice("Merge aborted");
            } catch (e: unknown) {
              new Notice(`${e instanceof Error ? e.message : String(e)}`);
            }
          }),
      );
    }
    menu.addSeparator();
    for (const [mode, label, icon] of [
      ["tree", "View as tree", "list-tree"],
      ["list", "View as list", "list"],
    ] as [FileListMode, string, string][]) {
      menu.addItem((i) =>
        i
          .setTitle(label)
          .setIcon(icon)
          .setChecked(this.fileListMode === mode)
          .onClick(() => void this.plugin.setFileListMode(mode)),
      );
    }

    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Switch branch...")
        .setIcon("git-branch")
        .onClick(async () => {
          await this.showBranchMenu(event);
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Open Git graph")
        .setIcon("git-branch")
        .onClick(() => this.plugin.openGraphView()),
    );
    menu.showAtMouseEvent(event);
  }

  private async showBranchMenu(event: MouseEvent): Promise<void> {
    await this.store.refreshBranches();
    const menu = new Menu();
    const localBranches = this.store.branches.filter((b) => !b.remote);
    const remoteBranches = this.store.branches.filter((b) => b.remote);
    for (const b of localBranches) {
      menu.addItem((i) => {
        i.setTitle(`${b.current ? "✓ " : "  "}${b.name}`);
        i.setIcon("git-branch");
        if (!b.current) {
          i.onClick(async () => {
            try {
              await this.store.runTask(`Switching to ${b.name}`, () => this.git.checkout(b.name));
              await this.store.refresh();
              new Notice(`Switched to ${b.name}`);
            } catch (e: unknown) {
              new Notice(`${e instanceof Error ? e.message : String(e)}`);
            }
          });
        }
      });
    }
    if (remoteBranches.length > 0) {
      menu.addSeparator();
      for (const b of remoteBranches) {
        menu.addItem((i) => {
          i.setTitle(`  ${b.name}`);
          i.setIcon("globe");
          i.onClick(async () => {
            try {
              const local = b.name.replace(/^[^/]+\//, "");
              await this.store.runTask(`Checking out ${local}`, () => this.git.checkout(local));
              await this.store.refresh();
              new Notice(`Switched to ${local}`);
            } catch (e: unknown) {
              new Notice(`${e instanceof Error ? e.message : String(e)}`);
            }
          });
        });
      }
    }
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("+ create new branch...")
        .setIcon("plus")
        .onClick(async () => {
          const name = await promptText(this.app, "New branch name:");
          if (name) {
            try {
              await this.store.runTask("Creating branch", () => this.git.createBranch(name));
              await this.store.refresh();
              new Notice(`Branch '${name}' created and checked out`);
            } catch (e: unknown) {
              new Notice(`${e instanceof Error ? e.message : String(e)}`);
            }
          }
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Delete branch...")
        .setIcon("trash")
        .onClick(async () => {
          const deletable = localBranches.filter((b) => !b.current);
          if (deletable.length === 0) {
            new Notice("No branches to delete");
            return;
          }
          const delMenu = new Menu();
          for (const b of deletable) {
            delMenu.addItem((di) =>
              di
                .setTitle(b.name)
                .setIcon("git-branch")
                .onClick(async () => {
                  const choice = await confirmChoice(
                    this.app,
                    "Delete branch",
                    `Delete branch "${b.name}"?`,
                    [
                      { label: "Delete", value: "delete" },
                      { label: "Cancel", value: "cancel" },
                    ],
                  );
                  if (choice === "delete") {
                    try {
                      await this.store.runTask("Deleting branch", () =>
                        this.git.deleteBranch(b.name),
                      );
                      await this.store.refreshBranches();
                      new Notice(`Branch '${b.name}' deleted`);
                    } catch (e: unknown) {
                      new Notice(`${e instanceof Error ? e.message : String(e)}`);
                    }
                  }
                }),
            );
          }
          delMenu.showAtMouseEvent(event);
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Merge into current...")
        .setIcon("git-merge")
        .onClick(async () => {
          const mergeable = localBranches.filter((b) => !b.current);
          if (mergeable.length === 0) {
            new Notice("No branches to merge");
            return;
          }
          const mergeMenu = new Menu();
          for (const b of mergeable) {
            mergeMenu.addItem((mi) =>
              mi
                .setTitle(b.name)
                .setIcon("git-branch")
                .onClick(async () => {
                  try {
                    await this.store.runTask(`Merging ${b.name}`, () => this.git.merge(b.name));
                    await this.store.refresh();
                    new Notice(`Merged '${b.name}'`);
                  } catch (e: unknown) {
                    new Notice(`Merge failed: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }),
            );
          }
          mergeMenu.showAtMouseEvent(event);
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

  private updateCommitBtnState(): void {
    if (!this.commitBtn) return;
    const hasInput = !!this.commitInput?.value?.trim();
    const hasTemplate = !!this.plugin.settings.commitTemplate;
    this.commitBtn.disabled = !hasInput && !hasTemplate;
  }

  private async restoreFile(filePath: string, ref: string): Promise<void> {
    const dirty = this.store.status.some((f) => f.path === filePath);
    if (dirty) {
      const choice = await confirmChoice(
        this.app,
        "Uncommitted changes",
        `"${filePath}" has uncommitted changes that will be overwritten.`,
        [
          { label: "Stash & restore", value: "stash", cta: true },
          { label: "Overwrite", value: "overwrite" },
          { label: "Cancel", value: "cancel" },
        ],
      );
      if (!choice || choice === "cancel") return;
      if (choice === "stash") {
        await this.store.runTask("Stashing", () => this.git.stashSave());
      }
    }
    try {
      await this.store.runTask("Restoring", () => this.git.restoreFile(ref, filePath));
      await this.store.refresh();
      new Notice(`Restored ${filePath} from ${ref.substring(0, 7)}`);
    } catch (e: unknown) {
      new Notice(`Restore failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async doCommit(andPush = false): Promise<void> {
    const msg =
      this.commitInput?.value?.trim() ||
      (this.plugin.settings.commitTemplate
        ? resolveTemplate(this.plugin.settings.commitTemplate)
        : "");
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
      await this.store.runTask("Committing", () => this.git.commit(msg));
      if (this.commitInput) this.commitInput.value = "";
      new Notice("Committed");
      if (andPush) {
        await this.store.runTask("Pushing", () =>
          this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch }),
        );
        new Notice("Pushed");
      }
      await this.store.refresh();
    } catch (e: unknown) {
      new Notice(`Commit failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * One row above the file sections. Layout and "expand all" are properties of
   * the whole list rather than of a single section, so they sit in one place
   * instead of being repeated in every section header.
   */
  private buildListToolbar(el: HTMLElement): void {
    const bar = el.createDiv("gs-sc-list-toolbar");
    this.listToolbarEl = bar;
    this.listSummaryEl = bar.createSpan("gs-sc-list-summary");

    const actions = bar.createDiv("gs-sc-list-actions");

    const foldBtn = actions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
    foldBtn.addEventListener("click", () => this.toggleAllFolders());
    this.foldBtn = foldBtn;

    const seg = actions.createDiv("gs-sc-mode-switch");
    for (const [mode, icon, label] of [
      ["tree", "list-tree", "View as tree"],
      ["list", "list", "View as list"],
    ] as [FileListMode, string, string][]) {
      const btn = seg.createEl("button", { cls: "gs-sc-mode-btn" });
      setIcon(btn, icon);
      btn.setAttribute("aria-label", label);
      btn.addEventListener(
        "click",
        asVoid(async () => {
          await this.plugin.setFileListMode(mode);
        }),
      );
      this.modeBtns[mode] = btn;
    }
  }

  private get fileListMode(): FileListMode {
    return this.plugin.settings.fileListMode === "list" ? "list" : "tree";
  }

  private get compactFolders(): boolean {
    return this.plugin.settings.compactFolders !== false;
  }

  /** Re-renders the changes list after the layout was changed elsewhere. */
  refreshFileList(): void {
    this.renderFiles();
  }

  private allFoldersExpanded(): boolean {
    return this.allDirPaths.length > 0 && this.allDirPaths.every((p) => this.expandedDirs.has(p));
  }

  private toggleAllFolders(): void {
    const expand = !this.allFoldersExpanded();
    for (const path of this.allDirPaths) {
      if (expand) this.expandedDirs.add(path);
      else this.expandedDirs.delete(path);
    }
    this.renderFiles();
  }

  private updateListToolbar(total: number): void {
    const bar = this.listToolbarEl;
    if (!bar) return;

    bar.toggleClass("gs-hidden", total === 0);
    this.listSummaryEl?.setText(total === 1 ? "1 change" : `${total} changes`);

    const mode = this.fileListMode;
    for (const [key, btn] of Object.entries(this.modeBtns)) {
      btn.toggleClass("gs-sc-mode-btn-active", key === mode);
    }

    // Nothing to fold in a flat list, and nothing to fold in a tree that has
    // no folders either — the button would sit there doing nothing.
    const foldBtn = this.foldBtn;
    if (!foldBtn) return;
    const expanded = this.allFoldersExpanded();
    setIcon(foldBtn, expanded ? "fold-vertical" : "unfold-vertical");
    foldBtn.setAttribute("aria-label", expanded ? "Collapse all" : "Expand all");
    foldBtn.toggleClass("gs-hidden", mode !== "tree" || this.allDirPaths.length === 0);
  }

  private renderFiles(): void {
    if (!this.fileListEl) return;
    this.fileListEl.empty();
    this.allDirPaths = [];

    const staged = this.store.stagedFiles;
    const changed = [...this.store.changedFiles, ...this.store.untrackedFiles];
    const conflicts = this.store.mergeConflicts;

    if (conflicts.length > 0) this.renderSection("Merge Conflicts", conflicts, "conflict");
    if (staged.length > 0) this.renderSection("Staged Changes", staged, "staged");
    if (changed.length > 0) this.renderSection("Changes", changed, "changed");

    const total = staged.length + changed.length + conflicts.length;
    if (total === 0) {
      this.fileListEl.createDiv("gs-sc-empty").setText("No changes");
    }
    this.updateListToolbar(total);
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
      btn.setAttribute("aria-label", "Unstage all");
      btn.addEventListener(
        "click",
        asVoid(async (e) => {
          e.stopPropagation();
          try {
            await this.git.unstageAll();
          } catch (err) {
            new Notice(`Unstage all failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          await this.store.refresh();
        }),
      );
    } else if (group !== "conflict") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "plus");
      btn.setAttribute("aria-label", "Stage all");
      btn.addEventListener(
        "click",
        asVoid(async (e) => {
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
        }),
      );
    }
    if (group === "changed") {
      const btn = headerActions.createEl("button", { cls: "gs-icon-btn gs-icon-btn-sm" });
      setIcon(btn, "undo");
      btn.setAttribute("aria-label", "Discard all");
      btn.addEventListener(
        "click",
        asVoid(async (e) => {
          e.stopPropagation();
          try {
            await this.git.discardAll();
          } catch (err) {
            new Notice(`Discard all failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          await this.store.refresh();
        }),
      );
    }

    const treeEl = section.createDiv("gs-sc-tree");
    let collapsed = false;

    header.addEventListener("click", () => {
      collapsed = !collapsed;
      treeEl.style.display = collapsed ? "none" : "";
      setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");
    });

    if (this.fileListMode === "list") {
      treeEl.addClass("gs-sc-tree-flat");
      // Sorted by full path, not by name: files from the same folder then stay
      // together and the repeated folder label reads as one block.
      const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
      for (const file of sorted) this.renderFileRow(treeEl, file, group, 0, true);
      return;
    }

    const tree = this.buildFileTree(files);
    this.allDirPaths.push(...this.collectDirPaths(tree));
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

  private collectFiles(node: FileTreeNode): FileStatus[] {
    const files: FileStatus[] = [];
    for (const child of node.children) {
      if (child.isDir) {
        files.push(...this.collectFiles(child));
      } else if (child.file && !child.file.embeddedRepo) {
        // `git add` cannot index a nested repository, and one of them in the
        // list makes the whole call fail.
        files.push(child.file);
      }
    }
    return files;
  }

  /**
   * Pathspecs for a git command. A rename is one entry with two paths, and
   * leaving the old one out would stage or unstage only half of it.
   */
  private pathspecs(files: FileStatus[]): string[] {
    return files.flatMap((f) => (f.originalPath ? [f.path, f.originalPath] : [f.path]));
  }

  private buildFileTree(files: FileStatus[]): FileTreeNode[] {
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

    return this.compactFolders ? this.compactTree(root) : root;
  }

  /**
   * Folds a chain of folders that each hold a single subfolder into one row —
   * "Projects/cloudcourse" rather than two levels to open before a file shows
   * up. The merged node keeps the deepest path, so folder actions and the
   * expanded set still key on a directory that exists.
   */
  private compactTree(nodes: FileTreeNode[]): FileTreeNode[] {
    return nodes.map((node) => {
      if (!node.isDir) return node;
      let merged = node;
      while (merged.children.length === 1 && merged.children[0].isDir) {
        const child = merged.children[0];
        merged = { ...child, name: `${merged.name}/${child.name}` };
      }
      return {
        ...merged,
        expanded: this.expandedDirs.has(merged.path),
        children: this.compactTree(merged.children),
      };
    });
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
            discardBtn.setAttribute("aria-label", "Discard all in folder");
            discardBtn.addEventListener(
              "click",
              asVoid(async (e) => {
                e.stopPropagation();
                await this.git.discard(this.pathspecs(this.collectFiles(node)));
                await this.store.refresh();
              }),
            );
          }
          const stageBtn = dirActions.createEl("button", { cls: "gs-action-btn" });
          setIcon(stageBtn, "plus");
          stageBtn.setAttribute("aria-label", "Stage all in folder");
          stageBtn.addEventListener(
            "click",
            asVoid(async (e) => {
              e.stopPropagation();
              await this.git.stage(this.pathspecs(this.collectFiles(node)));
              await this.store.refresh();
            }),
          );
        }

        if (group === "staged") {
          const unstageBtn = dirActions.createEl("button", { cls: "gs-action-btn" });
          setIcon(unstageBtn, "minus");
          unstageBtn.setAttribute("aria-label", "Unstage all in folder");
          unstageBtn.addEventListener(
            "click",
            asVoid(async (e) => {
              e.stopPropagation();
              await this.git.unstage(this.pathspecs(this.collectFiles(node)));
              await this.store.refresh();
            }),
          );
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

  private renderFileRow(
    parent: HTMLElement,
    file: FileStatus,
    group: string,
    depth: number,
    showPath = false,
  ): void {
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

    // In the flat layout the folder is the only thing telling two files of the
    // same name apart, so it follows the name and gives up its width first.
    if (showPath) {
      const slash = file.path.lastIndexOf("/");
      if (slash > 0) row.createSpan("gs-tree-filepath").setText(file.path.slice(0, slash));
      row.setAttribute("aria-label", file.path);
    }

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
      openBtn.setAttribute("aria-label", "Open changes");
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.plugin.openDiff(file.path, undefined, false, file.workingStatus === "?");
      });
      this.addOpenFileButton(actions, file);
    }

    if (group === "changed" && file.workingStatus !== "?") {
      const discardBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(discardBtn, "undo");
      discardBtn.setAttribute("aria-label", "Discard changes");
      discardBtn.addEventListener(
        "click",
        asVoid(async (e) => {
          e.stopPropagation();
          await this.git.discard(this.pathspecs([file]));
          await this.store.refresh();
        }),
      );
    }

    if (group !== "staged" && group !== "conflict" && !file.embeddedRepo) {
      const stageBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(stageBtn, "plus");
      stageBtn.setAttribute("aria-label", "Stage changes");
      stageBtn.addEventListener(
        "click",
        asVoid(async (e) => {
          e.stopPropagation();
          await this.git.stage(this.pathspecs([file]));
          await this.store.refresh();
        }),
      );
    }

    if (group === "staged") {
      const openBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(openBtn, "file-diff");
      openBtn.setAttribute("aria-label", "Open changes");
      openBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.plugin.openDiff(file.path, undefined, true);
      });
      this.addOpenFileButton(actions, file);

      const unstageBtn = actions.createEl("button", { cls: "gs-action-btn" });
      setIcon(unstageBtn, "minus");
      unstageBtn.setAttribute("aria-label", "Unstage changes");
      unstageBtn.addEventListener(
        "click",
        asVoid(async (e) => {
          e.stopPropagation();
          await this.git.unstage(this.pathspecs([file]));
          await this.store.refresh();
        }),
      );
    }

    const badge = rightSide.createSpan("gs-tree-badge");
    const statusChar = group === "staged" ? file.indexStatus : file.workingStatus;
    const displayChar = statusChar === "?" ? "U" : statusChar;
    badge.setText(displayChar);
    badge.addClass(`gs-badge-${displayChar}`);

    // A file can appear in both sections at once; each row opens its own half.
    row.addEventListener("click", () => {
      const isUntracked = group !== "staged" && file.workingStatus === "?";
      void this.plugin.openDiff(file.path, undefined, group === "staged", isUntracked);
    });
    row.addEventListener("contextmenu", (e) => {
      const menu = new Menu();
      menu.addItem((i) =>
        i
          .setTitle("Open file")
          .setIcon("file")
          .onClick(() => this.app.workspace.openLinkText(file.path, "", false)),
      );
      menu.addItem((i) =>
        i
          .setTitle("File history")
          .setIcon("history")
          .onClick(() => this.plugin.openFileHistory(file.path)),
      );
      menu.addItem((i) =>
        i
          .setTitle("Open diff")
          .setIcon("file-diff")
          .onClick(() => {
            const isUntracked = group !== "staged" && file.workingStatus === "?";
            void this.plugin.openDiff(file.path, undefined, group === "staged", isUntracked);
          }),
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Copy path")
          .setIcon("copy")
          .onClick(() => {
            void navigator.clipboard.writeText(file.path);
            new Notice("Path copied");
          }),
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Add to .gitignore")
          .setIcon("eye-off")
          .onClick(async () => {
            try {
              await this.git.addToGitignore(file.path);
              await this.store.refresh();
              new Notice(`Added "${file.path}" to .gitignore`);
            } catch (e: unknown) {
              new Notice(`Failed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }),
      );
      menu.showAtMouseEvent(e);
    });

    void this.loadFileStats(file, statsEl, group);
  }

  /**
   * Opens the note itself, next to the button that opens its diff. Only offered
   * for paths the vault actually holds: a deleted file has nothing to show, and
   * `.obsidian/*` config files are not part of the vault index.
   */
  private addOpenFileButton(actions: HTMLElement, file: FileStatus): void {
    this.addOpenCurrentButton(actions, file.path);
  }

  /**
   * The "open the note as it is right now" button. It is rendered for every
   * file row, unconditionally — it is the action reached for most often, and a
   * button that appears on some rows and not others is harder to use than one
   * that is always in the same place. Whether the file still exists is decided
   * on click, not on render, so a file restored in the meantime just works.
   */
  private addOpenCurrentButton(actions: HTMLElement, path: string): void {
    const btn = actions.createEl("button", { cls: "gs-action-btn" });
    setIcon(btn, "file");
    btn.setAttribute("aria-label", "Open current file");
    btn.addEventListener(
      "click",
      asVoid(async (e) => {
        e.stopPropagation();
        await this.openCurrentFile(path);
      }),
    );
  }

  /**
   * Opens the vault's current copy of a path. A commit can name a file the
   * vault no longer holds — deleted since, or never part of this vault at all
   * when the repository reaches beyond it — and saying so is more use than a
   * button that quietly does nothing.
   */
  private async openCurrentFile(path: string): Promise<void> {
    const current = this.vaultFile(path);
    if (!current) {
      new Notice(`"${path}" does not exist in this vault right now`);
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(current);
  }

  private vaultFile(path: string): TFile | null {
    const found = this.app.vault.getAbstractFileByPath(path);
    return found instanceof TFile ? found : null;
  }

  /**
   * Whether a commit's file list shows this path. Resolved per render rather
   * than cached, so flipping the setting takes effect on the next refresh.
   */
  private showsFile(path: string): boolean {
    return supportedFileFilter(this.app, this.plugin.settings.onlySupportedFileTypes)(path);
  }

  /**
   * The three things worth doing with one file of a commit, as buttons in the
   * row itself: read what that commit did to it, open the note as it stands
   * now, and put the note back to that commit. They used to be reachable only
   * through a right-click menu, which hid them.
   *
   * Shared by both commit file lists — the Changes sub-tab and the expanded
   * commit in the sidebar graph — so the two cannot drift apart.
   */
  private addCommitFileActions(row: HTMLElement, path: string, hash: string): void {
    const actions = row.createDiv("gs-cf-actions");

    // Leftmost, and first for a reason: opening the note as it stands now is
    // the action wanted most often.
    this.addOpenCurrentButton(actions, path);

    const diffBtn = actions.createEl("button", { cls: "gs-action-btn" });
    setIcon(diffBtn, "file-diff");
    diffBtn.setAttribute("aria-label", "View changes in this commit");
    diffBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.plugin.openDiff(path, hash);
    });

    const restoreBtn = actions.createEl("button", { cls: "gs-action-btn" });
    setIcon(restoreBtn, "undo");
    restoreBtn.setAttribute("aria-label", "Restore this file to this commit");
    restoreBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.restoreFile(path, hash);
    });
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
    this.graphSubChangesPanel.addClass("gs-hidden");

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
      void this.store.refreshLog({ all: true, maxCount: 500 });
      void this.store.refresh();
    });

    const expandBtn = toolbar.createEl("button", { cls: "gs-icon-btn" });
    setIcon(expandBtn, "maximize-2");
    expandBtn.setAttribute("aria-label", "Open full graph");
    expandBtn.addEventListener("click", () => {
      void this.plugin.openGraphView();
    });

    this.graphListEl = this.graphSubGraphPanel.createDiv("gs-sg-list");

    this.graphSubChangesPanel
      .createDiv("gs-sg-changes-empty")
      .setText("Click a commit in the Git graph to see its changes here.");
  }

  private switchGraphSubTab(tab: GraphSubTab): void {
    for (const [key, btn] of Object.entries(this.graphSubTabBtns)) {
      btn.toggleClass("gs-sg-subtab-active", key === tab);
    }
    if (this.graphSubGraphPanel) this.graphSubGraphPanel.toggleClass("gs-hidden", tab !== "graph");
    if (this.graphSubChangesPanel)
      this.graphSubChangesPanel.toggleClass("gs-hidden", tab !== "commit-changes");
  }

  showCommitChanges(commit: CommitInfo): void {
    this.selectedCommitForChanges = commit;
    this.switchTab("graph");
    this.switchGraphSubTab("commit-changes");
    void this.renderCommitChangesPanel();
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
      void navigator.clipboard.writeText(commit.hash);
      new Notice("SHA copied");
    });
    const viewBtn = actionsEl.createEl("button", { cls: "gs-sg-detail-btn", text: "View changes" });
    viewBtn.addEventListener(
      "click",
      asVoid(async () => {
        try {
          const files = await this.git.showCommitFiles(commit.hash);
          const shown = files.filter((f) => this.showsFile(f.path));
          if (shown.length > 0) void this.plugin.openDiff(shown[0].path, commit.hash);
        } catch {
          new Notice("Could not load changes");
        }
      }),
    );

    const filesContainer = this.graphSubChangesPanel.createDiv("gs-sg-changes-files");
    const loadingEl = filesContainer.createDiv("gs-sg-changes-loading");
    loadingEl.setText("Loading files...");

    try {
      const all = await this.git.showCommitFiles(commit.hash);
      filesContainer.empty();

      if (all.length === 0) {
        filesContainer.createDiv("gs-sg-changes-empty").setText("No files changed");
        return;
      }

      const files = all.filter((f) => this.showsFile(f.path));
      const hidden = all.length - files.length;

      if (files.length === 0) {
        filesContainer
          .createDiv("gs-sg-changes-empty")
          .setText(`${hidden} file${hidden !== 1 ? "s" : ""} changed, none Obsidian can open`);
        return;
      }

      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);

      const summaryEl = filesContainer.createDiv("gs-sg-changes-summary");
      summaryEl.createSpan().setText(`${files.length} FILES CHANGED`);
      if (totalAdd > 0) summaryEl.createSpan("gs-stat-add").setText(` +${totalAdd}`);
      if (totalDel > 0) summaryEl.createSpan("gs-stat-del").setText(` -${totalDel}`);
      // Say so rather than silently showing a shorter list than the commit has.
      if (hidden > 0) {
        const hiddenEl = summaryEl.createSpan("gs-sg-changes-hidden");
        hiddenEl.setText(` · ${hidden} hidden`);
        hiddenEl.setAttribute("aria-label", "Files Obsidian cannot open, hidden by a setting");
      }

      for (const f of files) {
        const fileRow = filesContainer.createDiv("gs-sg-changes-file-row");

        const fileName = fileRow.createSpan("gs-sg-changes-file-name");
        fileName.setText(f.path);

        const fileStats = fileRow.createSpan("gs-sg-changes-file-stats");
        if (f.additions > 0) fileStats.createSpan("gs-stat-add").setText(`+${f.additions}`);
        if (f.deletions > 0) fileStats.createSpan("gs-stat-del").setText(` -${f.deletions}`);

        this.addCommitFileActions(fileRow, f.path, commit.hash);

        fileRow.addEventListener("click", () => {
          filesContainer
            .querySelectorAll(".gs-sg-changes-file-row")
            .forEach((el) => el.removeClass("is-active"));
          fileRow.addClass("is-active");
          void this.plugin.openDiff(f.path, commit.hash);
        });
        fileRow.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          // Same three actions as the row buttons, in the same order and with
          // the same icons, for anyone who reaches for the right button first.
          const m = new Menu();
          m.addItem((i) =>
            i
              .setTitle("Open current file")
              .setIcon("file")
              .onClick(asVoid(() => this.openCurrentFile(f.path))),
          );
          m.addItem((i) =>
            i
              .setTitle("View changes in this commit")
              .setIcon("file-diff")
              .onClick(() => this.plugin.openDiff(f.path, commit.hash)),
          );
          m.addItem((i) =>
            i
              .setTitle("Restore this file")
              .setIcon("undo")
              .onClick(() => this.restoreFile(f.path, commit.hash)),
          );
          m.showAtMouseEvent(e);
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
      info.createSpan("gs-sg-msg").setText("Working changes");
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
        if (this.tooltipTimeout) window.clearTimeout(this.tooltipTimeout);
        this.tooltipTimeout = window.setTimeout(() => this.showCommitTooltip(commit, row), 400);
      });
      row.addEventListener("mouseleave", () => {
        if (this.tooltipTimeout) {
          window.clearTimeout(this.tooltipTimeout);
          this.tooltipTimeout = null;
        }
        this.hideCommitTooltip();
      });

      row.addEventListener("click", () => {
        this.hideCommitTooltip();
        this.toggleCommitSelection(commit, row);
      });

      row.addEventListener("contextmenu", (e) => {
        this.hideCommitTooltip();
        const menu = new Menu();
        menu.addItem((item) =>
          item
            .setTitle("Copy SHA")
            .setIcon("copy")
            .onClick(() => {
              void navigator.clipboard.writeText(commit.hash);
              new Notice("SHA copied");
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("View changes")
            .setIcon("file-diff")
            .onClick(async () => {
              try {
                const files = await this.git.showCommitFiles(commit.hash);
                const shown = files.filter((f) => this.showsFile(f.path));
                if (shown.length > 0) void this.plugin.openDiff(shown[0].path, commit.hash);
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
            .setTitle("Open in graph")
            .setIcon("git-branch")
            .onClick(() => this.plugin.openGraphView()),
        );
        menu.showAtMouseEvent(e);
      });

      if (this.graphSelectedHash === commit.hash) {
        row.addClass("gs-sg-row-selected");
        this.insertCommitDetail(commit, row);
      }
    }

    if (this.graphNodes.length === 0 && !hasWC) {
      this.graphListEl.createDiv("gs-sg-empty").setText("No commits");
    }
  }

  private toggleCommitSelection(commit: CommitInfo, clickedRow: HTMLElement): void {
    if (!this.graphListEl) return;

    const prevDetail = this.graphListEl.querySelector(".gs-sg-detail");
    const prevSelected = this.graphListEl.querySelector(".gs-sg-row-selected");

    if (prevSelected) prevSelected.removeClass("gs-sg-row-selected");
    if (prevDetail) prevDetail.remove();

    if (this.graphSelectedHash === commit.hash) {
      this.graphSelectedHash = null;
      return;
    }

    this.graphSelectedHash = commit.hash;
    clickedRow.addClass("gs-sg-row-selected");
    this.insertCommitDetail(commit, clickedRow);
  }

  private insertCommitDetail(commit: CommitInfo, afterRow: HTMLElement): void {
    const detail = createDiv("gs-sg-detail");
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
      void navigator.clipboard.writeText(commit.hash);
      new Notice("SHA copied");
    });
    const viewBtn = detailActions.createEl("button", {
      cls: "gs-sg-detail-btn",
      text: "View changes",
    });
    viewBtn.addEventListener(
      "click",
      asVoid(async (e) => {
        e.stopPropagation();
        try {
          const files = await this.git.showCommitFiles(commit.hash);
          const shown = files.filter((f) => this.showsFile(f.path));
          if (shown.length > 0) void this.plugin.openDiff(shown[0].path, commit.hash);
        } catch {
          new Notice("Could not load changes");
        }
      }),
    );

    afterRow.after(detail);
    void this.loadSidebarCommitFiles(commit.hash, detail);
  }

  private async loadSidebarCommitFiles(hash: string, detail: HTMLElement): Promise<void> {
    try {
      const all = await this.git.showCommitFiles(hash);
      const files = all.filter((f) => this.showsFile(f.path));
      if (files.length === 0) return;
      const hidden = all.length - files.length;
      const filesEl = detail.createDiv("gs-sg-detail-files");
      filesEl
        .createDiv("gs-sg-detail-files-header")
        .setText(
          `${files.length} file${files.length !== 1 ? "s" : ""} changed` +
            (hidden > 0 ? ` · ${hidden} hidden` : ""),
        );
      for (const f of files) {
        const fileRow = filesEl.createDiv("gs-sg-detail-file");
        const name = fileRow.createSpan("gs-sg-detail-filename");
        name.setText(f.path);
        const stats = fileRow.createSpan("gs-sg-detail-filestats");
        if (f.additions > 0) stats.createSpan("gs-stat-add").setText(`+${f.additions}`);
        if (f.deletions > 0) stats.createSpan("gs-stat-del").setText(` -${f.deletions}`);

        this.addCommitFileActions(fileRow, f.path, hash);

        fileRow.addEventListener("click", (e) => {
          e.stopPropagation();
          filesEl
            .querySelectorAll(".gs-sg-detail-file")
            .forEach((el) => el.removeClass("is-active"));
          fileRow.addClass("is-active");
          void this.plugin.openDiff(f.path, hash);
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

  private el(tag: keyof HTMLElementTagNameMap, cls: string, text?: string): HTMLElement {
    const e = createEl(tag);
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
    void this.loadTooltipStats(commit.hash, statsPlaceholder);

    const msgEl = this.el("div", "gs-sg-tip-msg", commit.message);
    body.appendChild(msgEl);
    if (commit.body) {
      body.appendChild(this.el("div", "gs-sg-tip-msg-body", commit.body));
    }

    document.body.appendChild(tip);
    this.tooltipEl = tip;

    window.requestAnimationFrame(() => {
      const rect = anchor.getBoundingClientRect();
      const tipRect = tip.getBoundingClientRect();
      let top = rect.top - tipRect.height - 6;
      if (top < 8) top = rect.bottom + 6;
      let left = rect.left + 20;
      if (left + tipRect.width > window.innerWidth - 8)
        left = window.innerWidth - tipRect.width - 8;
      tip.style.top = top + "px";
      tip.style.left = left + "px";
      tip.addClass("gs-tooltip-visible");
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
    if (this.progressHideTimer) window.clearTimeout(this.progressHideTimer);
    this.hideCommitTooltip();
  }
}

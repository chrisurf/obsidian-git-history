import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { SOURCE_CONTROL_VIEW_TYPE, FileStatus } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import type GitStudioPlugin from "../main";

export class SourceControlView extends ItemView {
  private plugin: GitStudioPlugin;
  private store: RepoStore;
  private git: GitService;
  private commitInput: HTMLTextAreaElement | null = null;
  private fileListEl: HTMLElement | null = null;

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
    contentEl.addClass("git-studio-sc-view");

    this.buildToolbar(contentEl);
    this.buildCommitArea(contentEl);
    this.fileListEl = contentEl.createDiv("git-sc-files");

    this.registerEvent(this.store.on("status-changed", () => this.renderFiles()));
    this.registerEvent(this.store.on("loading", (loading: boolean) => {
      contentEl.toggleClass("git-sc-loading", loading);
    }));

    await this.store.refresh();
  }

  private buildToolbar(el: HTMLElement): void {
    const toolbar = el.createDiv("git-sc-toolbar");

    const title = toolbar.createSpan("git-sc-title");
    title.setText("Source Control");

    const actions = toolbar.createDiv("git-sc-actions");

    const refreshBtn = actions.createEl("button", { cls: "git-sc-btn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => this.store.refresh());

    const fetchBtn = actions.createEl("button", { cls: "git-sc-btn" });
    setIcon(fetchBtn, "cloud-download");
    fetchBtn.setAttribute("aria-label", "Fetch");
    fetchBtn.addEventListener("click", async () => {
      try {
        await this.git.fetch();
        await this.store.refresh();
        new Notice("Fetched");
      } catch (e: unknown) {
        new Notice(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    const pullBtn = actions.createEl("button", { cls: "git-sc-btn" });
    setIcon(pullBtn, "download");
    pullBtn.setAttribute("aria-label", "Pull");
    pullBtn.addEventListener("click", async () => {
      try {
        await this.git.pull({ strategy: this.plugin.settings.pullStrategy });
        await this.store.refresh();
        new Notice("Pulled");
      } catch (e: unknown) {
        new Notice(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    const pushBtn = actions.createEl("button", { cls: "git-sc-btn" });
    setIcon(pushBtn, "upload");
    pushBtn.setAttribute("aria-label", "Push");
    pushBtn.addEventListener("click", async () => {
      try {
        await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch });
        await this.store.refresh();
        new Notice("Pushed");
      } catch (e: unknown) {
        new Notice(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    const moreBtn = actions.createEl("button", { cls: "git-sc-btn" });
    setIcon(moreBtn, "more-horizontal");
    moreBtn.addEventListener("click", (e) => this.showMoreMenu(e));
  }

  private showMoreMenu(event: MouseEvent): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Stash changes").setIcon("archive").onClick(async () => {
      try {
        await this.git.stashSave();
        await this.store.refresh();
        new Notice("Changes stashed");
      } catch (e: unknown) { new Notice(`${e instanceof Error ? e.message : String(e)}`); }
    }));
    menu.addItem(i => i.setTitle("Pop stash").setIcon("archive-restore").onClick(async () => {
      try {
        await this.git.stashPop();
        await this.store.refresh();
        new Notice("Stash popped");
      } catch (e: unknown) { new Notice(`${e instanceof Error ? e.message : String(e)}`); }
    }));
    menu.addSeparator();
    menu.addItem(i => i.setTitle("Open Git Graph").setIcon("git-branch").onClick(() => {
      this.plugin.openGraphView();
    }));
    menu.showAtMouseEvent(event);
  }

  private buildCommitArea(el: HTMLElement): void {
    const area = el.createDiv("git-sc-commit-area");

    this.commitInput = area.createEl("textarea", {
      cls: "git-sc-commit-input",
      attr: { placeholder: "Commit message", rows: "3" },
    });

    const charCount = area.createDiv("git-sc-char-count");
    this.commitInput.addEventListener("input", () => {
      const len = this.commitInput?.value.length || 0;
      charCount.setText(`${len}`);
      charCount.toggleClass("git-sc-char-warn", len > 72);
    });

    const btnRow = area.createDiv("git-sc-commit-btns");

    const commitBtn = btnRow.createEl("button", { cls: "git-sc-commit-btn mod-cta", text: "Commit" });
    commitBtn.addEventListener("click", () => this.doCommit());

    const commitPushBtn = btnRow.createEl("button", { cls: "git-sc-commit-btn", text: "Commit & Push" });
    commitPushBtn.addEventListener("click", () => this.doCommit(true));
  }

  private async doCommit(andPush = false): Promise<void> {
    const msg = this.commitInput?.value?.trim();
    if (!msg) {
      new Notice("Please enter a commit message");
      return;
    }

    const staged = this.store.stagedFiles;
    if (staged.length === 0) {
      const hasChanges = this.store.changedFiles.length > 0 || this.store.untrackedFiles.length > 0;
      if (hasChanges) {
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
    const changed = this.store.changedFiles;
    const untracked = this.store.untrackedFiles;
    const conflicts = this.store.mergeConflicts;

    if (conflicts.length > 0) {
      this.renderGroup(this.fileListEl, "Merge Conflicts", conflicts, "U", true);
    }
    if (staged.length > 0) {
      this.renderGroup(this.fileListEl, "Staged Changes", staged, "staged");
    }
    if (changed.length > 0) {
      this.renderGroup(this.fileListEl, "Changes", changed, "changed");
    }
    if (untracked.length > 0) {
      this.renderGroup(this.fileListEl, "Untracked", untracked, "untracked");
    }

    if (staged.length === 0 && changed.length === 0 && untracked.length === 0 && conflicts.length === 0) {
      this.fileListEl.createDiv("git-sc-empty").setText("No changes");
    }
  }

  private renderGroup(
    parent: HTMLElement,
    title: string,
    files: FileStatus[],
    group: string,
    isConflict = false
  ): void {
    const section = parent.createDiv("git-sc-group");
    const header = section.createDiv("git-sc-group-header");

    const titleEl = header.createSpan("git-sc-group-title");
    titleEl.setText(`${title} (${files.length})`);

    const headerActions = header.createDiv("git-sc-group-actions");

    if (group === "staged") {
      const unstageAll = headerActions.createEl("button", { cls: "git-sc-btn" });
      setIcon(unstageAll, "minus");
      unstageAll.setAttribute("aria-label", "Unstage All");
      unstageAll.addEventListener("click", async () => {
        await this.git.unstageAll();
        await this.store.refresh();
      });
    } else if (group === "changed" || group === "untracked") {
      const stageAll = headerActions.createEl("button", { cls: "git-sc-btn" });
      setIcon(stageAll, "plus");
      stageAll.setAttribute("aria-label", "Stage All");
      stageAll.addEventListener("click", async () => {
        await this.git.stage(files.map(f => f.path));
        await this.store.refresh();
      });

      if (group === "changed") {
        const discardAll = headerActions.createEl("button", { cls: "git-sc-btn" });
        setIcon(discardAll, "undo-2");
        discardAll.setAttribute("aria-label", "Discard All");
        discardAll.addEventListener("click", async () => {
          await this.git.discard(files.map(f => f.path));
          await this.store.refresh();
          new Notice("All changes discarded");
        });
      }
    }

    const list = section.createDiv("git-sc-file-list");
    for (const file of files) {
      this.renderFileRow(list, file, group, isConflict);
    }
  }

  private renderFileRow(parent: HTMLElement, file: FileStatus, group: string, isConflict: boolean): void {
    const row = parent.createDiv("git-sc-file-row");

    const statusBadge = row.createSpan("git-sc-badge");
    const statusChar = group === "staged" ? file.indexStatus : file.workingStatus;
    statusBadge.setText(statusChar === "?" ? "U" : statusChar);
    statusBadge.addClass(`git-sc-badge-${statusChar === "?" ? "U" : statusChar}`);

    const fileName = file.path.split("/").pop() || file.path;
    const dirPath = file.path.substring(0, file.path.length - fileName.length);

    const nameEl = row.createSpan("git-sc-file-name");
    nameEl.setText(fileName);
    if (dirPath) {
      const dirEl = row.createSpan("git-sc-file-dir");
      dirEl.setText(dirPath);
    }

    const actions = row.createDiv("git-sc-file-actions");

    const diffBtn = actions.createEl("button", { cls: "git-sc-btn" });
    setIcon(diffBtn, "file-diff");
    diffBtn.setAttribute("aria-label", "Open Diff");
    diffBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.plugin.openDiff(file.path);
    });

    if (group === "staged") {
      const unstageBtn = actions.createEl("button", { cls: "git-sc-btn" });
      setIcon(unstageBtn, "minus");
      unstageBtn.setAttribute("aria-label", "Unstage");
      unstageBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.unstage([file.path]);
        await this.store.refresh();
      });
    } else if (!isConflict) {
      const stageBtn = actions.createEl("button", { cls: "git-sc-btn" });
      setIcon(stageBtn, "plus");
      stageBtn.setAttribute("aria-label", "Stage");
      stageBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await this.git.stage([file.path]);
        await this.store.refresh();
      });

      if (group === "changed") {
        const discardBtn = actions.createEl("button", { cls: "git-sc-btn" });
        setIcon(discardBtn, "undo-2");
        discardBtn.setAttribute("aria-label", "Discard");
        discardBtn.addEventListener("click", async (e) => {
          e.stopPropagation();
          await this.git.discard([file.path]);
          await this.store.refresh();
        });
      }
    }

    row.addEventListener("click", () => {
      this.plugin.openDiff(file.path);
    });

    row.addEventListener("contextmenu", (e) => {
      const menu = new Menu();
      menu.addItem(i => i.setTitle("Open File").setIcon("file").onClick(() => {
        this.app.workspace.openLinkText(file.path, "", false);
      }));
      menu.addItem(i => i.setTitle("Open Diff").setIcon("file-diff").onClick(() => {
        this.plugin.openDiff(file.path);
      }));
      menu.addSeparator();
      if (group !== "staged") {
        menu.addItem(i => i.setTitle("Stage").setIcon("plus").onClick(async () => {
          await this.git.stage([file.path]);
          await this.store.refresh();
        }));
      }
      if (group === "staged") {
        menu.addItem(i => i.setTitle("Unstage").setIcon("minus").onClick(async () => {
          await this.git.unstage([file.path]);
          await this.store.refresh();
        }));
      }
      if (group === "changed") {
        menu.addItem(i => i.setTitle("Discard Changes").setIcon("undo-2").onClick(async () => {
          await this.git.discard([file.path]);
          await this.store.refresh();
        }));
      }
      menu.addSeparator();
      menu.addItem(i => i.setTitle("Copy Path").setIcon("copy").onClick(() => {
        navigator.clipboard.writeText(file.path);
        new Notice("Path copied");
      }));
      menu.showAtMouseEvent(e);
    });
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }
}

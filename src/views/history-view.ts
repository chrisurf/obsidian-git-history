import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { HISTORY_VIEW_TYPE, CommitInfo } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { formatRelativeDate } from "../utils/graph-layout";
import type GitStudioPlugin from "../main";

export class HistoryView extends ItemView {
  private plugin: GitStudioPlugin;
  private store: RepoStore;
  private git: GitService;
  private listEl: HTMLElement | null = null;
  private filterPath: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.git = plugin.git;
  }

  getViewType(): string { return HISTORY_VIEW_TYPE; }
  getDisplayText(): string { return this.filterPath ? `History: ${this.filterPath}` : "History"; }
  getIcon(): string { return "history"; }

  setFilterPath(path: string | null): void {
    this.filterPath = path;
    this.leaf.updateHeader();
    this.loadHistory();
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("git-studio-history-view");

    const toolbar = contentEl.createDiv("git-history-toolbar");
    const refreshBtn = toolbar.createEl("button", { cls: "git-sc-btn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.loadHistory());

    const graphBtn = toolbar.createEl("button", { cls: "git-sc-btn", text: "Open Graph" });
    setIcon(graphBtn, "git-branch");
    graphBtn.addEventListener("click", () => this.plugin.openGraphView());

    if (this.filterPath) {
      const clearBtn = toolbar.createEl("button", { cls: "git-sc-btn", text: "All files" });
      clearBtn.addEventListener("click", () => this.setFilterPath(null));
    }

    this.listEl = contentEl.createDiv("git-history-list");

    this.registerEvent(this.store.on("log-changed", () => this.renderList()));

    await this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    await this.store.refreshLog({
      maxCount: 200,
      all: !this.filterPath,
      file: this.filterPath ?? undefined,
    });
  }

  private renderList(): void {
    if (!this.listEl) return;
    this.listEl.empty();

    const commits = this.store.commits;
    if (commits.length === 0) {
      this.listEl.createDiv("git-history-empty").setText("No commits found");
      return;
    }

    for (const commit of commits) {
      const row = this.listEl.createDiv("git-history-row");

      const indicator = row.createDiv("git-history-indicator");
      const dot = indicator.createDiv("git-history-dot");

      if (commit.refs.some(r => r.current)) {
        dot.addClass("git-history-dot-head");
      }

      const content = row.createDiv("git-history-content");

      const topLine = content.createDiv("git-history-top");
      for (const ref of commit.refs) {
        const pill = topLine.createSpan("git-graph-ref");
        if (ref.type === "head") pill.addClass("git-graph-ref-head");
        else if (ref.type === "remote") pill.addClass("git-graph-ref-remote");
        else if (ref.type === "tag") pill.addClass("git-graph-ref-tag");
        else pill.addClass("git-graph-ref-branch");
        pill.setText(ref.name);
      }

      const msgEl = topLine.createSpan("git-history-message");
      msgEl.setText(commit.message);

      const bottomLine = content.createDiv("git-history-bottom");
      const initials = commit.author
        .split(" ")
        .map(w => w[0])
        .join("")
        .toUpperCase()
        .substring(0, 2);
      bottomLine.createSpan("git-history-avatar").setText(initials);
      bottomLine.createSpan("git-history-author").setText(commit.author);
      bottomLine.createSpan("git-history-date").setText(formatRelativeDate(commit.date));
      bottomLine.createSpan("git-history-hash").setText(commit.shortHash);

      row.addEventListener("click", () => {
        this.plugin.openGraphView().then(() => {
          // graph view will show details
        });
      });

      row.addEventListener("contextmenu", (e) => this.showMenu(e, commit));
    }

    const loadMore = this.listEl.createEl("button", {
      cls: "git-history-load-more",
      text: "Load more...",
    });
    loadMore.addEventListener("click", async () => {
      await this.store.loadMoreCommits();
    });
  }

  private showMenu(event: MouseEvent, commit: CommitInfo): void {
    const menu = new Menu();
    menu.addItem(i => i.setTitle("Copy hash").setIcon("copy").onClick(() => {
      navigator.clipboard.writeText(commit.hash);
      new Notice("Hash copied");
    }));
    menu.addItem(i => i.setTitle("Create branch here...").setIcon("git-branch-plus").onClick(async () => {
      // simplified - would use modal in production
      const name = prompt("Branch name:");
      if (name) {
        try {
          await this.git.createBranch(name, commit.hash);
          await this.store.refresh();
          new Notice(`Branch '${name}' created`);
        } catch (e: unknown) {
          new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }));
    menu.addItem(i => i.setTitle("Checkout").setIcon("log-in").onClick(async () => {
      try {
        await this.git.checkout(commit.hash);
        await this.store.refresh();
        new Notice("Checked out " + commit.shortHash);
      } catch (e: unknown) {
        new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }));
    menu.showAtMouseEvent(event);
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }
}

import { setIcon } from "obsidian";
import { RepoStore } from "../store/repo-store";
import type GitHistoryPlugin from "../main";

export class StatusBarController {
  private el: HTMLElement;
  private store: RepoStore;
  private plugin: GitHistoryPlugin;
  private branchEl: HTMLSpanElement | null = null;
  private syncEl: HTMLSpanElement | null = null;
  private spinnerEl: HTMLSpanElement | null = null;

  constructor(el: HTMLElement, plugin: GitHistoryPlugin) {
    this.el = el;
    this.plugin = plugin;
    this.store = plugin.store;
    this.build();

    this.store.on("branch-changed", () => this.update());
    this.store.on("status-changed", () => this.update());
    this.store.on("loading", (loading: boolean) => this.setLoading(loading));
  }

  private build(): void {
    this.el.addClass("git-history-statusbar");
    this.el.addEventListener("click", () => this.plugin.openSourceControlView());

    this.spinnerEl = this.el.createSpan("git-sb-spinner");
    this.spinnerEl.style.display = "none";
    setIcon(this.spinnerEl, "loader");

    const branchIcon = this.el.createSpan("git-sb-icon");
    setIcon(branchIcon, "git-branch");

    this.branchEl = this.el.createSpan("git-sb-branch");
    this.branchEl.setText("...");

    this.syncEl = this.el.createSpan("git-sb-sync");
  }

  update(): void {
    if (this.branchEl) {
      this.branchEl.setText(this.store.branch || "no branch");
    }
    if (this.syncEl) {
      const parts: string[] = [];
      if (this.store.ahead > 0) parts.push(`↑${this.store.ahead}`);
      if (this.store.behind > 0) parts.push(`↓${this.store.behind}`);
      this.syncEl.setText(parts.join(" "));
    }
  }

  private setLoading(loading: boolean): void {
    if (this.spinnerEl) {
      this.spinnerEl.style.display = loading ? "inline-flex" : "none";
      this.spinnerEl.toggleClass("git-sb-spinning", loading);
    }
  }

  destroy(): void {
    this.el.empty();
  }
}

import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import { DIFF_VIEW_TYPE, FileDiff, DiffHunk } from "../types";
import { GitService } from "../git/git-service";
import type GitStudioPlugin from "../main";

export class DiffView extends ItemView {
  private plugin: GitStudioPlugin;
  private git: GitService;
  private filePath = "";
  private ref: string | null = null;
  private mode: "side-by-side" | "inline" = "side-by-side";
  private diffContainer: HTMLElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.git = plugin.git;
    this.mode = plugin.settings.diffViewMode;
  }

  getViewType(): string { return DIFF_VIEW_TYPE; }
  getDisplayText(): string { return this.filePath ? `Diff: ${this.filePath}` : "Diff"; }
  getIcon(): string { return "file-diff"; }

  setFile(path: string, ref?: string): void {
    this.filePath = path;
    this.ref = ref ?? null;
    this.leaf.updateHeader();
    if (this.diffContainer) this.loadDiff();
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("git-studio-diff-view");

    const toolbar = contentEl.createDiv("git-diff-toolbar");
    this.buildToolbar(toolbar);

    this.diffContainer = contentEl.createDiv("git-diff-container");

    if (this.filePath) await this.loadDiff();
  }

  private buildToolbar(el: HTMLElement): void {
    const left = el.createDiv("git-diff-toolbar-left");
    const pathEl = left.createSpan("git-diff-path");
    pathEl.setText(this.filePath || "No file selected");

    const right = el.createDiv("git-diff-toolbar-right");

    const sxsBtn = right.createEl("button", { cls: "git-sc-btn", text: "Side-by-Side" });
    const inlineBtn = right.createEl("button", { cls: "git-sc-btn", text: "Inline" });

    const updateMode = () => {
      sxsBtn.toggleClass("git-graph-btn-active", this.mode === "side-by-side");
      inlineBtn.toggleClass("git-graph-btn-active", this.mode === "inline");
    };
    updateMode();

    sxsBtn.addEventListener("click", () => {
      this.mode = "side-by-side";
      updateMode();
      this.loadDiff();
    });
    inlineBtn.addEventListener("click", () => {
      this.mode = "inline";
      updateMode();
      this.loadDiff();
    });
  }

  private async loadDiff(): Promise<void> {
    if (!this.diffContainer) return;
    this.diffContainer.empty();

    try {
      let rawDiff: string;
      if (this.ref) {
        const parentRef = this.ref + "^";
        rawDiff = await this.git.diffCommit(parentRef, this.ref, this.filePath);
      } else {
        rawDiff = await this.git.diff(this.filePath);
        if (!rawDiff) {
          rawDiff = await this.git.diff(this.filePath, true);
        }
      }

      if (!rawDiff) {
        this.diffContainer.createDiv("git-diff-empty").setText("No differences found");
        return;
      }

      const diffs = await this.git.parseDiff(rawDiff);
      if (diffs.length === 0) {
        this.diffContainer.createDiv("git-diff-empty").setText("No differences found");
        return;
      }

      for (const fileDiff of diffs) {
        if (fileDiff.binary) {
          this.diffContainer.createDiv("git-diff-binary").setText("Binary file changed");
          continue;
        }
        if (this.mode === "side-by-side") {
          this.renderSideBySide(fileDiff);
        } else {
          this.renderInline(fileDiff);
        }
      }
    } catch (e: unknown) {
      this.diffContainer.createDiv("git-diff-error").setText(
        `Error loading diff: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private renderSideBySide(fileDiff: FileDiff): void {
    if (!this.diffContainer) return;

    const wrapper = this.diffContainer.createDiv("git-diff-sbs");
    const leftPane = wrapper.createDiv("git-diff-pane git-diff-left");
    const rightPane = wrapper.createDiv("git-diff-pane git-diff-right");

    const leftHeader = leftPane.createDiv("git-diff-pane-header");
    leftHeader.setText(fileDiff.oldPath || fileDiff.path);
    const rightHeader = rightPane.createDiv("git-diff-pane-header");
    rightHeader.setText(fileDiff.path);

    const leftCode = leftPane.createDiv("git-diff-code");
    const rightCode = rightPane.createDiv("git-diff-code");

    for (const hunk of fileDiff.hunks) {
      const leftHunkHeader = leftCode.createDiv("git-diff-hunk-header");
      leftHunkHeader.setText(hunk.header || `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      const rightHunkHeader = rightCode.createDiv("git-diff-hunk-header");
      rightHunkHeader.setText(hunk.header || `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

      if (!this.ref) {
        const hunkActions = rightHunkHeader.createDiv("git-diff-hunk-actions");
        const stageBtn = hunkActions.createEl("button", { cls: "git-diff-hunk-btn", text: "Stage Hunk" });
        stageBtn.addEventListener("click", () => this.stageHunk(fileDiff.path, hunk));
        const revertBtn = hunkActions.createEl("button", { cls: "git-diff-hunk-btn", text: "Revert" });
        revertBtn.addEventListener("click", () => this.revertHunk(fileDiff.path, hunk));
      }

      let leftIdx = 0;
      let rightIdx = 0;

      const delLines = hunk.lines.filter(l => l.type === "del");
      const addLines = hunk.lines.filter(l => l.type === "add");
      const contextLines = hunk.lines.filter(l => l.type === "context");

      for (const line of hunk.lines) {
        if (line.type === "context") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-context");
          leftLine.createSpan("git-diff-linenum").setText(String(line.oldLineNo ?? ""));
          leftLine.createSpan("git-diff-sign").setText(" ");
          leftLine.createSpan("git-diff-content").setText(line.content);

          const rightLine = rightCode.createDiv("git-diff-line git-diff-context");
          rightLine.createSpan("git-diff-linenum").setText(String(line.newLineNo ?? ""));
          rightLine.createSpan("git-diff-sign").setText(" ");
          rightLine.createSpan("git-diff-content").setText(line.content);
        } else if (line.type === "del") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-del");
          leftLine.createSpan("git-diff-linenum").setText(String(line.oldLineNo ?? ""));
          leftLine.createSpan("git-diff-sign").setText("-");
          leftLine.createSpan("git-diff-content").setText(line.content);

          const rightLine = rightCode.createDiv("git-diff-line git-diff-empty");
          rightLine.createSpan("git-diff-linenum").setText("");
          rightLine.createSpan("git-diff-sign").setText("");
          rightLine.createSpan("git-diff-content");
        } else if (line.type === "add") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-empty");
          leftLine.createSpan("git-diff-linenum").setText("");
          leftLine.createSpan("git-diff-sign").setText("");
          leftLine.createSpan("git-diff-content");

          const rightLine = rightCode.createDiv("git-diff-line git-diff-add");
          rightLine.createSpan("git-diff-linenum").setText(String(line.newLineNo ?? ""));
          rightLine.createSpan("git-diff-sign").setText("+");
          rightLine.createSpan("git-diff-content").setText(line.content);
        }
      }
    }

    leftCode.addEventListener("scroll", () => {
      rightCode.scrollTop = leftCode.scrollTop;
      rightCode.scrollLeft = leftCode.scrollLeft;
    });
    rightCode.addEventListener("scroll", () => {
      leftCode.scrollTop = rightCode.scrollTop;
      leftCode.scrollLeft = rightCode.scrollLeft;
    });
  }

  private renderInline(fileDiff: FileDiff): void {
    if (!this.diffContainer) return;

    const wrapper = this.diffContainer.createDiv("git-diff-inline");
    const header = wrapper.createDiv("git-diff-pane-header");
    header.setText(fileDiff.path);

    const stats = header.createSpan("git-diff-stats");
    stats.createSpan("git-stat-add").setText(`+${fileDiff.additions}`);
    stats.createSpan("git-stat-del").setText(`-${fileDiff.deletions}`);

    const code = wrapper.createDiv("git-diff-code");

    for (const hunk of fileDiff.hunks) {
      const hunkHeader = code.createDiv("git-diff-hunk-header");
      hunkHeader.setText(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`);

      if (!this.ref) {
        const hunkActions = hunkHeader.createDiv("git-diff-hunk-actions");
        const stageBtn = hunkActions.createEl("button", { cls: "git-diff-hunk-btn", text: "Stage" });
        stageBtn.addEventListener("click", () => this.stageHunk(fileDiff.path, hunk));
      }

      for (const line of hunk.lines) {
        const lineEl = code.createDiv(`git-diff-line git-diff-${line.type}`);
        const lineNo = lineEl.createSpan("git-diff-linenum");
        if (line.type === "del") {
          lineNo.setText(String(line.oldLineNo ?? ""));
        } else if (line.type === "add") {
          lineNo.setText(String(line.newLineNo ?? ""));
        } else {
          lineNo.setText(String(line.oldLineNo ?? ""));
        }
        const sign = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
        lineEl.createSpan("git-diff-sign").setText(sign);
        lineEl.createSpan("git-diff-content").setText(line.content);
      }
    }
  }

  private async stageHunk(path: string, hunk: DiffHunk): Promise<void> {
    try {
      const patch = this.buildPatch(path, hunk);
      const { execFile } = require("child_process") as typeof import("child_process");
      const repoRoot = await this.git.getRepoRoot();
      await new Promise<void>((resolve, reject) => {
        const proc = execFile(
          "git",
          ["apply", "--cached", "-"],
          { cwd: repoRoot },
          (err) => (err ? reject(err) : resolve())
        );
        proc.stdin?.write(patch);
        proc.stdin?.end();
      });
      await this.plugin.store.refresh();
      new Notice("Hunk staged");
      await this.loadDiff();
    } catch (e: unknown) {
      new Notice(`Stage hunk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async revertHunk(path: string, hunk: DiffHunk): Promise<void> {
    try {
      const patch = this.buildPatch(path, hunk, true);
      const { execFile } = require("child_process") as typeof import("child_process");
      const repoRoot = await this.git.getRepoRoot();
      await new Promise<void>((resolve, reject) => {
        const proc = execFile(
          "git",
          ["apply", "-R", "-"],
          { cwd: repoRoot },
          (err) => (err ? reject(err) : resolve())
        );
        proc.stdin?.write(patch);
        proc.stdin?.end();
      });
      await this.plugin.store.refresh();
      new Notice("Hunk reverted");
      await this.loadDiff();
    } catch (e: unknown) {
      new Notice(`Revert hunk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildPatch(path: string, hunk: DiffHunk, reverse = false): string {
    let patch = `--- a/${path}\n+++ b/${path}\n`;
    patch += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    for (const line of hunk.lines) {
      if (line.type === "add") patch += `+${line.content}\n`;
      else if (line.type === "del") patch += `-${line.content}\n`;
      else patch += ` ${line.content}\n`;
    }
    return patch;
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }
}

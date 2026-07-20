import { ItemView, WorkspaceLeaf, setIcon, Notice } from "obsidian";
import { DIFF_VIEW_TYPE, FileDiff, DiffHunk, DiffLine } from "../types";
import { GitService } from "../git/git-service";
import type GitHistoryPlugin from "../main";

export class DiffView extends ItemView {
  private plugin: GitHistoryPlugin;
  private git: GitService;
  private filePath = "";
  private ref: string | null = null;
  private mode: "side-by-side" | "inline" = "side-by-side";
  private diffContainer: HTMLElement | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapViewport: HTMLElement | null = null;
  private minimapWrap: HTMLElement | null = null;
  private codeScrollEl: HTMLElement | null = null;
  private allLines: DiffLine[] = [];
  private totalLineCount = 0;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
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
    contentEl.addClass("git-history-diff-view");

    const toolbar = contentEl.createDiv("git-diff-toolbar");
    this.buildToolbar(toolbar);

    const body = contentEl.createDiv("git-diff-body");
    this.diffContainer = body.createDiv("git-diff-container");

    this.minimapWrap = body.createDiv("git-diff-minimap");
    this.minimapCanvas = this.minimapWrap.createEl("canvas", { cls: "git-diff-minimap-canvas" });
    this.minimapViewport = this.minimapWrap.createDiv("git-diff-minimap-viewport");

    this.setupMinimapInteraction();

    if (this.filePath) await this.loadDiff();
  }

  private buildToolbar(el: HTMLElement): void {
    const left = el.createDiv("git-diff-toolbar-left");
    const pathEl = left.createSpan("git-diff-path");
    pathEl.setText(this.filePath || "No file selected");

    const right = el.createDiv("git-diff-toolbar-right");

    const syncEl = right.createSpan("git-diff-sync");
    const syncIcon = syncEl.createSpan("git-diff-sync-label");
    syncIcon.setText("Sync:");
    const syncUp = syncEl.createSpan("git-diff-sync-stat");
    syncUp.setText("↑ 0");
    const syncDown = syncEl.createSpan("git-diff-sync-stat");
    syncDown.setText("↓ 0");

    const sxsBtn = right.createEl("button", { cls: "git-diff-mode-btn git-diff-mode-active", text: "Side-by-Side" });
    const inlineBtn = right.createEl("button", { cls: "git-diff-mode-btn", text: "Inline" });

    const updateMode = () => {
      sxsBtn.toggleClass("git-diff-mode-active", this.mode === "side-by-side");
      inlineBtn.toggleClass("git-diff-mode-active", this.mode === "inline");
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
    this.allLines = [];

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
        this.clearMinimap();
        return;
      }

      const diffs = await this.git.parseDiff(rawDiff);
      if (diffs.length === 0) {
        this.diffContainer.createDiv("git-diff-empty").setText("No differences found");
        this.clearMinimap();
        return;
      }

      for (const fileDiff of diffs) {
        if (fileDiff.binary) {
          this.diffContainer.createDiv("git-diff-binary").setText("Binary file changed");
          continue;
        }

        for (const hunk of fileDiff.hunks) {
          this.allLines.push(...hunk.lines);
        }

        if (this.mode === "side-by-side") {
          this.renderSideBySide(fileDiff);
        } else {
          this.renderInline(fileDiff);
        }
      }

      this.updateSyncStats(diffs);
      requestAnimationFrame(() => this.renderMinimap());
    } catch (e: unknown) {
      this.diffContainer.createDiv("git-diff-error").setText(
        `Error loading diff: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  private updateSyncStats(diffs: FileDiff[]): void {
    let totalAdd = 0, totalDel = 0;
    for (const d of diffs) { totalAdd += d.additions; totalDel += d.deletions; }
    const toolbar = this.contentEl.querySelector(".git-diff-toolbar-right");
    if (!toolbar) return;
    const stats = toolbar.querySelectorAll(".git-diff-sync-stat");
    if (stats.length >= 2) {
      stats[0].textContent = `↑ ${totalAdd}`;
      stats[1].textContent = `↓ ${totalDel}`;
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
    const rightHeaderPath = rightHeader.createSpan();
    rightHeaderPath.setText(fileDiff.path);
    const statsEl = rightHeader.createSpan("git-diff-stats");
    statsEl.createSpan("git-stat-add").setText(`+${fileDiff.additions}`);
    statsEl.createSpan("git-stat-del").setText(` -${fileDiff.deletions}`);

    const leftCode = leftPane.createDiv("git-diff-code");
    const rightCode = rightPane.createDiv("git-diff-code");
    this.codeScrollEl = leftCode;
    this.totalLineCount = 0;

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

      for (const line of hunk.lines) {
        this.totalLineCount++;
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
          leftLine.createSpan("git-diff-sign").setText("−");
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
      this.updateMinimapViewport();
    });
    rightCode.addEventListener("scroll", () => {
      leftCode.scrollTop = rightCode.scrollTop;
      leftCode.scrollLeft = rightCode.scrollLeft;
      this.updateMinimapViewport();
    });
  }

  private renderInline(fileDiff: FileDiff): void {
    if (!this.diffContainer) return;

    const wrapper = this.diffContainer.createDiv("git-diff-inline");
    const header = wrapper.createDiv("git-diff-pane-header");
    header.createSpan().setText(fileDiff.path);

    const stats = header.createSpan("git-diff-stats");
    stats.createSpan("git-stat-add").setText(`+${fileDiff.additions}`);
    stats.createSpan("git-stat-del").setText(` -${fileDiff.deletions}`);

    const code = wrapper.createDiv("git-diff-code");
    this.codeScrollEl = code;
    this.totalLineCount = 0;

    for (const hunk of fileDiff.hunks) {
      const hunkHeader = code.createDiv("git-diff-hunk-header");
      hunkHeader.setText(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`);

      if (!this.ref) {
        const hunkActions = hunkHeader.createDiv("git-diff-hunk-actions");
        const stageBtn = hunkActions.createEl("button", { cls: "git-diff-hunk-btn", text: "Stage" });
        stageBtn.addEventListener("click", () => this.stageHunk(fileDiff.path, hunk));
      }

      for (const line of hunk.lines) {
        this.totalLineCount++;
        const lineEl = code.createDiv(`git-diff-line git-diff-${line.type === "del" ? "del" : line.type === "add" ? "add" : "context"}`);
        const lineNo = lineEl.createSpan("git-diff-linenum");
        if (line.type === "del") {
          lineNo.setText(String(line.oldLineNo ?? ""));
        } else if (line.type === "add") {
          lineNo.setText(String(line.newLineNo ?? ""));
        } else {
          lineNo.setText(String(line.oldLineNo ?? ""));
        }
        const sign = line.type === "add" ? "+" : line.type === "del" ? "−" : " ";
        lineEl.createSpan("git-diff-sign").setText(sign);
        lineEl.createSpan("git-diff-content").setText(line.content);
      }
    }

    code.addEventListener("scroll", () => this.updateMinimapViewport());
  }

  private renderMinimap(): void {
    const canvas = this.minimapCanvas;
    const wrap = this.minimapWrap;
    if (!canvas || !wrap || this.allLines.length === 0) {
      this.clearMinimap();
      return;
    }

    wrap.style.display = "flex";
    const height = wrap.clientHeight || 400;
    const width = 60;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "rgba(30, 30, 30, 0.6)";
    ctx.fillRect(0, 0, width, height);

    const lineH = Math.max(1, height / Math.max(this.allLines.length, 1));

    for (let i = 0; i < this.allLines.length; i++) {
      const line = this.allLines[i];
      const y = i * lineH;
      if (line.type === "add") {
        ctx.fillStyle = "rgba(63, 185, 80, 0.7)";
        ctx.fillRect(0, y, width, Math.max(lineH, 1.5));
      } else if (line.type === "del") {
        ctx.fillStyle = "rgba(248, 81, 73, 0.7)";
        ctx.fillRect(0, y, width, Math.max(lineH, 1.5));
      } else {
        ctx.fillStyle = "rgba(200, 200, 200, 0.08)";
        ctx.fillRect(4, y, width - 8, Math.max(lineH, 0.8));
      }
    }

    this.updateMinimapViewport();
  }

  private updateMinimapViewport(): void {
    const viewport = this.minimapViewport;
    const scrollEl = this.codeScrollEl;
    const wrap = this.minimapWrap;
    if (!viewport || !scrollEl || !wrap) return;

    const wrapH = wrap.clientHeight || 1;
    const scrollH = scrollEl.scrollHeight || 1;
    const clientH = scrollEl.clientHeight || 1;
    const scrollTop = scrollEl.scrollTop;

    const vpTop = (scrollTop / scrollH) * wrapH;
    const vpHeight = Math.max(20, (clientH / scrollH) * wrapH);

    viewport.style.top = vpTop + "px";
    viewport.style.height = vpHeight + "px";
  }

  private clearMinimap(): void {
    if (this.minimapWrap) this.minimapWrap.style.display = "none";
  }

  private setupMinimapInteraction(): void {
    const wrap = this.minimapWrap;
    if (!wrap) return;

    let dragging = false;

    const jumpToPosition = (clientY: number) => {
      const scrollEl = this.codeScrollEl;
      if (!scrollEl) return;
      const rect = wrap.getBoundingClientRect();
      const ratio = (clientY - rect.top) / rect.height;
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      scrollEl.scrollTop = ratio * maxScroll;
    };

    wrap.addEventListener("mousedown", (e: MouseEvent) => {
      dragging = true;
      jumpToPosition(e.clientY);
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (!dragging) return;
      jumpToPosition(e.clientY);
      e.preventDefault();
    });

    document.addEventListener("mouseup", () => { dragging = false; });
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
    this.minimapCanvas = null;
    this.minimapViewport = null;
    this.minimapWrap = null;
    this.codeScrollEl = null;
  }
}

import { ItemView, WorkspaceLeaf, setIcon, Menu, Notice } from "obsidian";
import { GRAPH_VIEW_TYPE, CommitInfo, GraphNode, GraphEdge } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { computeGraphLayout, formatRelativeDate } from "../utils/graph-layout";
import type GitStudioPlugin from "../main";

const ROW_HEIGHT = 36;
const COL_WIDTH = 16;
const GRAPH_PADDING = 24;
const NODE_RADIUS = 5;
const OVERSCAN = 10;

const COLORS = [
  "var(--graph-color-0, #f97583)",
  "var(--graph-color-1, #79b8ff)",
  "var(--graph-color-2, #85e89d)",
  "var(--graph-color-3, #ffab70)",
  "var(--graph-color-4, #b392f0)",
  "var(--graph-color-5, #f692ce)",
  "var(--graph-color-6, #73e3ff)",
  "var(--graph-color-7, #ffd33d)",
  "var(--graph-color-8, #ff7b72)",
  "var(--graph-color-9, #7ee787)",
  "var(--graph-color-10, #a5d6ff)",
  "var(--graph-color-11, #d2a8ff)",
];

export class GraphView extends ItemView {
  private plugin: GitStudioPlugin;
  private store: RepoStore;
  private git: GitService;
  private containerEl_: HTMLElement | null = null;
  private scrollEl: HTMLElement | null = null;
  private svgEl: SVGSVGElement | null = null;
  private rowsEl: HTMLElement | null = null;
  private spacerEl: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private maxColumns = 0;
  private selectedCommit: string | null = null;
  private detailEl: HTMLElement | null = null;
  private filterText = "";
  private filteredIndices: number[] | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitStudioPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.git = plugin.git;
  }

  getViewType(): string { return GRAPH_VIEW_TYPE; }
  getDisplayText(): string { return "Git Graph"; }
  getIcon(): string { return "git-branch"; }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("git-studio-graph-view");

    const toolbar = contentEl.createDiv("git-graph-toolbar");
    this.buildToolbar(toolbar);

    const main = contentEl.createDiv("git-graph-main");

    const graphPane = main.createDiv("git-graph-pane");
    this.scrollEl = graphPane.createDiv("git-graph-scroll");
    this.scrollEl.addEventListener("scroll", () => this.renderVisible());

    const inner = this.scrollEl.createDiv("git-graph-inner");
    this.svgEl = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svgEl.addClass("git-graph-svg");
    inner.appendChild(this.svgEl);

    this.rowsEl = inner.createDiv("git-graph-rows");
    this.spacerEl = inner.createDiv("git-graph-spacer");

    this.detailEl = main.createDiv("git-graph-detail");
    this.detailEl.createDiv("git-graph-detail-placeholder").setText("Select a commit to view details");

    this.registerEvent(this.store.on("log-changed", () => this.rebuildGraph()));

    await this.store.refreshLog({ all: true, maxCount: 500 });
  }

  private buildToolbar(el: HTMLElement): void {
    const left = el.createDiv("git-graph-toolbar-left");

    const refreshBtn = left.createEl("button", { cls: "git-graph-btn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => this.store.refreshLog({ all: true, maxCount: 500 }));

    const allBtn = left.createEl("button", { cls: "git-graph-btn git-graph-btn-active", text: "All branches" });
    let showAll = true;
    allBtn.addEventListener("click", () => {
      showAll = !showAll;
      allBtn.toggleClass("git-graph-btn-active", showAll);
      allBtn.textContent = showAll ? "All branches" : "Current branch";
      this.store.refreshLog({ all: showAll, maxCount: 500 });
    });

    const right = el.createDiv("git-graph-toolbar-right");
    this.searchInput = right.createEl("input", {
      cls: "git-graph-search",
      attr: { type: "text", placeholder: "Search commits..." },
    });
    this.searchInput.addEventListener("input", () => {
      this.filterText = this.searchInput?.value.toLowerCase() || "";
      this.applyFilter();
    });
  }

  private applyFilter(): void {
    if (!this.filterText) {
      this.filteredIndices = null;
    } else {
      this.filteredIndices = [];
      for (let i = 0; i < this.nodes.length; i++) {
        const c = this.nodes[i].commit;
        if (
          c.message.toLowerCase().includes(this.filterText) ||
          c.author.toLowerCase().includes(this.filterText) ||
          c.shortHash.toLowerCase().includes(this.filterText)
        ) {
          this.filteredIndices.push(i);
        }
      }
    }
    this.updateLayout();
    this.renderVisible();
  }

  private rebuildGraph(): void {
    const result = computeGraphLayout(this.store.commits);
    this.nodes = result.nodes;
    this.edges = result.edges;
    this.maxColumns = result.maxColumns;
    this.filteredIndices = null;
    this.filterText = "";
    if (this.searchInput) this.searchInput.value = "";
    this.updateLayout();
    this.renderVisible();
  }

  private getVisibleRows(): number[] {
    return this.filteredIndices ?? this.nodes.map((_, i) => i);
  }

  private updateLayout(): void {
    const rows = this.getVisibleRows();
    const totalHeight = rows.length * ROW_HEIGHT;
    if (this.spacerEl) this.spacerEl.style.height = totalHeight + "px";

    const graphWidth = (this.maxColumns + 1) * COL_WIDTH + GRAPH_PADDING;
    if (this.svgEl) {
      this.svgEl.style.width = graphWidth + "px";
      this.svgEl.style.height = totalHeight + "px";
    }
  }

  private renderVisible(): void {
    if (!this.scrollEl || !this.svgEl || !this.rowsEl) return;

    const visibleRows = this.getVisibleRows();
    const scrollTop = this.scrollEl.scrollTop;
    const viewHeight = this.scrollEl.clientHeight;
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endRow = Math.min(
      visibleRows.length - 1,
      Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN
    );

    this.renderSvg(visibleRows, startRow, endRow);
    this.renderRows(visibleRows, startRow, endRow);
  }

  private renderSvg(visibleRows: number[], startRow: number, endRow: number): void {
    if (!this.svgEl) return;
    while (this.svgEl.firstChild) this.svgEl.removeChild(this.svgEl.firstChild);

    const graphWidth = (this.maxColumns + 1) * COL_WIDTH + GRAPH_PADDING;
    const totalHeight = visibleRows.length * ROW_HEIGHT;
    this.svgEl.setAttribute("viewBox", `0 0 ${graphWidth} ${totalHeight}`);
    this.svgEl.setAttribute("width", String(graphWidth));
    this.svgEl.setAttribute("height", String(totalHeight));

    const visRowMap = new Map<number, number>();
    visibleRows.forEach((origIdx, visIdx) => visRowMap.set(origIdx, visIdx));

    const visibleOrigSet = new Set<number>();
    for (let i = startRow; i <= endRow; i++) {
      visibleOrigSet.add(visibleRows[i]);
    }

    for (const edge of this.edges) {
      const fromVis = visRowMap.get(edge.fromRow);
      const toVis = visRowMap.get(edge.toRow);
      if (fromVis === undefined || toVis === undefined) continue;

      const minVis = Math.min(fromVis, toVis);
      const maxVis = Math.max(fromVis, toVis);
      if (maxVis < startRow - 5 || minVis > endRow + 5) continue;

      const x1 = edge.fromCol * COL_WIDTH + GRAPH_PADDING / 2;
      const y1 = fromVis * ROW_HEIGHT + ROW_HEIGHT / 2;
      const x2 = edge.toCol * COL_WIDTH + GRAPH_PADDING / 2;
      const y2 = toVis * ROW_HEIGHT + ROW_HEIGHT / 2;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const color = COLORS[edge.color % COLORS.length];

      if (x1 === x2) {
        path.setAttribute("d", `M${x1},${y1} L${x2},${y2}`);
      } else {
        const midY = y1 + ROW_HEIGHT;
        path.setAttribute(
          "d",
          `M${x1},${y1} C${x1},${midY} ${x2},${y2 - ROW_HEIGHT} ${x2},${y2}`
        );
      }
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      this.svgEl!.appendChild(path);
    }

    for (let i = startRow; i <= endRow; i++) {
      const origIdx = visibleRows[i];
      if (origIdx >= this.nodes.length) continue;
      const node = this.nodes[origIdx];
      const x = node.column * COL_WIDTH + GRAPH_PADDING / 2;
      const y = i * ROW_HEIGHT + ROW_HEIGHT / 2;
      const color = COLORS[node.color % COLORS.length];

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(x));
      circle.setAttribute("cy", String(y));
      circle.setAttribute("r", String(NODE_RADIUS));
      circle.setAttribute("fill", node.commit.parents.length > 1 ? "var(--background-primary)" : color);
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", node.commit.parents.length > 1 ? "2.5" : "0");
      this.svgEl!.appendChild(circle);
    }
  }

  private renderRows(visibleRows: number[], startRow: number, endRow: number): void {
    if (!this.rowsEl) return;
    this.rowsEl.empty();

    const graphWidth = (this.maxColumns + 1) * COL_WIDTH + GRAPH_PADDING;
    this.rowsEl.style.paddingLeft = graphWidth + "px";

    for (let i = startRow; i <= endRow; i++) {
      const origIdx = visibleRows[i];
      if (origIdx >= this.nodes.length) continue;
      const node = this.nodes[origIdx];
      const commit = node.commit;

      const row = this.rowsEl.createDiv("git-graph-row");
      row.style.top = i * ROW_HEIGHT + "px";
      row.style.height = ROW_HEIGHT + "px";
      row.dataset.hash = commit.hash;

      if (commit.hash === this.selectedCommit) {
        row.addClass("git-graph-row-selected");
      }

      const refsEl = row.createDiv("git-graph-refs");
      for (const ref of commit.refs) {
        const pill = refsEl.createSpan("git-graph-ref");
        if (ref.type === "head") {
          pill.addClass("git-graph-ref-head");
        } else if (ref.type === "remote") {
          pill.addClass("git-graph-ref-remote");
        } else if (ref.type === "tag") {
          pill.addClass("git-graph-ref-tag");
        } else {
          pill.addClass("git-graph-ref-branch");
        }
        pill.setText(ref.name);
      }

      const msgEl = row.createSpan("git-graph-message");
      msgEl.setText(commit.message);

      const metaEl = row.createDiv("git-graph-meta");
      const authorEl = metaEl.createSpan("git-graph-author");
      authorEl.setText(commit.author);
      const dateEl = metaEl.createSpan("git-graph-date");
      dateEl.setText(formatRelativeDate(commit.date));
      const hashEl = metaEl.createSpan("git-graph-hash");
      hashEl.setText(commit.shortHash);

      row.addEventListener("click", () => this.selectCommit(commit));
      row.addEventListener("contextmenu", (e) => this.showCommitMenu(e, commit));
    }
  }

  private async selectCommit(commit: CommitInfo): Promise<void> {
    this.selectedCommit = commit.hash;
    this.renderVisible();
    await this.showCommitDetails(commit);
  }

  private async showCommitDetails(commit: CommitInfo): Promise<void> {
    if (!this.detailEl) return;
    this.detailEl.empty();

    const header = this.detailEl.createDiv("git-detail-header");
    header.createEl("h3", { text: commit.message });
    if (commit.body) {
      header.createEl("p", { cls: "git-detail-body", text: commit.body });
    }

    const info = this.detailEl.createDiv("git-detail-info");
    info.createDiv({ cls: "git-detail-row" }).innerHTML =
      `<span class="git-detail-label">Author</span><span>${this.escapeHtml(commit.author)} &lt;${this.escapeHtml(commit.authorEmail)}&gt;</span>`;
    info.createDiv({ cls: "git-detail-row" }).innerHTML =
      `<span class="git-detail-label">Date</span><span>${commit.date.toLocaleString()}</span>`;
    info.createDiv({ cls: "git-detail-row" }).innerHTML =
      `<span class="git-detail-label">Hash</span><span class="git-detail-hash">${commit.hash}</span>`;
    if (commit.parents.length > 0) {
      info.createDiv({ cls: "git-detail-row" }).innerHTML =
        `<span class="git-detail-label">Parents</span><span>${commit.parents.map(p => p.substring(0, 7)).join(", ")}</span>`;
    }

    const copyBtn = info.createEl("button", { cls: "git-graph-btn git-detail-copy", text: "Copy hash" });
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(commit.hash);
      new Notice("Hash copied");
    });

    try {
      const files = await this.git.showCommitFiles(commit.hash);
      const fileList = this.detailEl.createDiv("git-detail-files");
      fileList.createEl("h4", { text: `Changed files (${files.length})` });
      for (const f of files) {
        const row = fileList.createDiv("git-detail-file-row");
        const stats = row.createSpan("git-detail-file-stats");
        if (f.additions > 0) stats.createSpan("git-stat-add").setText(`+${f.additions}`);
        if (f.deletions > 0) stats.createSpan("git-stat-del").setText(`-${f.deletions}`);
        const pathEl = row.createSpan("git-detail-file-path");
        pathEl.setText(f.path);
        row.addEventListener("click", () => {
          this.plugin.openDiff(f.path, commit.hash);
        });
      }
    } catch {
      this.detailEl.createDiv({ text: "Could not load file list." });
    }
  }

  private showCommitMenu(event: MouseEvent, commit: CommitInfo): void {
    const menu = new Menu();

    menu.addItem((item) =>
      item.setTitle("Copy hash").setIcon("copy").onClick(() => {
        navigator.clipboard.writeText(commit.hash);
        new Notice("Hash copied");
      })
    );

    menu.addItem((item) =>
      item.setTitle("Create branch here...").setIcon("git-branch-plus").onClick(async () => {
        const name = await this.promptText("New branch name:");
        if (name) {
          try {
            await this.git.createBranch(name, commit.hash);
            await this.store.refresh();
            await this.store.refreshLog({ all: true });
            new Notice(`Branch '${name}' created`);
          } catch (e: unknown) {
            new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      })
    );

    menu.addItem((item) =>
      item.setTitle("Checkout").setIcon("log-in").onClick(async () => {
        try {
          await this.git.checkout(commit.hash);
          await this.store.refresh();
          new Notice("Checked out " + commit.shortHash);
        } catch (e: unknown) {
          new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    menu.addSeparator();

    menu.addItem((item) =>
      item.setTitle("Cherry-pick").setIcon("cherry").onClick(async () => {
        try {
          await this.git["exec"](["cherry-pick", commit.hash]);
          await this.store.refresh();
          new Notice("Cherry-picked " + commit.shortHash);
        } catch (e: unknown) {
          new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    menu.addItem((item) =>
      item.setTitle("Revert").setIcon("undo").onClick(async () => {
        try {
          await this.git["exec"](["revert", "--no-edit", commit.hash]);
          await this.store.refresh();
          new Notice("Reverted " + commit.shortHash);
        } catch (e: unknown) {
          new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    menu.showAtMouseEvent(event);
  }

  private promptText(label: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new (require("obsidian").Modal)(this.app);
      modal.titleEl.setText(label);
      const input = modal.contentEl.createEl("input", {
        cls: "git-studio-input",
        attr: { type: "text" },
      });
      const btnRow = modal.contentEl.createDiv("git-studio-btn-row");
      const ok = btnRow.createEl("button", { text: "OK", cls: "mod-cta" });
      const cancel = btnRow.createEl("button", { text: "Cancel" });
      ok.addEventListener("click", () => { modal.close(); resolve(input.value || null); });
      cancel.addEventListener("click", () => { modal.close(); resolve(null); });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") { modal.close(); resolve(input.value || null); }
        if (e.key === "Escape") { modal.close(); resolve(null); }
      });
      modal.open();
      input.focus();
    });
  }

  private escapeHtml(s: string): string {
    const el = document.createElement("span");
    el.textContent = s;
    return el.innerHTML;
  }

  async onClose(): Promise<void> {
    // cleanup handled by Obsidian
  }
}

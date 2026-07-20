import { ItemView, WorkspaceLeaf, setIcon, Menu, Modal, Notice } from "obsidian";
import { GRAPH_VIEW_TYPE, CommitInfo, GraphNode, GraphEdge } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { computeGraphLayout, formatRelativeDate } from "../utils/graph-layout";
import type GitHistoryPlugin from "../main";

const ROW_HEIGHT = 32;
const COL_WIDTH = 14;
const GRAPH_COL_MIN_WIDTH = 60;
const NODE_RADIUS = 4;
const OVERSCAN = 15;

const COLORS = [
  "#0ea5e9",
  "#22c55e",
  "#f59e0b",
  "#ef4444",
  "#a855f7",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#06b6d4",
  "#e879f9",
];

export class GraphView extends ItemView {
  private plugin: GitHistoryPlugin;
  private store: RepoStore;
  private git: GitService;

  private scrollEl: HTMLElement | null = null;
  private tableBody: HTMLElement | null = null;
  private svgLayer: SVGSVGElement | null = null;
  private spacerEl: HTMLElement | null = null;
  private popupEl: HTMLElement | null = null;

  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private maxColumns = 0;
  private selectedHash: string | null = null;
  private filterText = "";
  private filteredIndices: number[] | null = null;
  private hasWorkingChanges = false;
  private tooltipEl: HTMLElement | null = null;
  private tooltipTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.store = plugin.store;
    this.git = plugin.git;
  }

  getViewType(): string {
    return GRAPH_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "Git Graph";
  }
  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("gs-graph-view");

    this.buildToolbar(contentEl);
    this.buildColumnHeaders(contentEl);

    const scrollWrap = contentEl.createDiv("gs-graph-scroll-wrap");
    this.scrollEl = scrollWrap;
    this.scrollEl.addEventListener("scroll", () => this.renderVisible());

    const inner = this.scrollEl.createDiv("gs-graph-inner");

    this.svgLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.svgLayer.addClass("gs-graph-svg");
    inner.appendChild(this.svgLayer);

    this.tableBody = inner.createDiv("gs-graph-tbody");
    this.spacerEl = inner.createDiv("gs-graph-spacer");

    this.popupEl = contentEl.createDiv("gs-commit-popup");
    this.popupEl.style.display = "none";

    this.registerEvent(this.store.on("log-changed", () => this.rebuildGraph()));
    this.registerEvent(
      this.store.on("status-changed", () => {
        this.hasWorkingChanges = this.store.status.length > 0;
        this.rebuildGraph();
      }),
    );

    await Promise.all([this.store.refreshLog({ all: true, maxCount: 500 }), this.store.refresh()]);
  }

  private buildToolbar(el: HTMLElement): void {
    const bar = el.createDiv("gs-graph-toolbar");

    const left = bar.createDiv("gs-toolbar-left");
    const searchWrap = left.createDiv("gs-search-wrap");
    const searchIcon = searchWrap.createSpan("gs-search-icon");
    setIcon(searchIcon, "search");
    const searchInput = searchWrap.createEl("input", {
      cls: "gs-search-input",
      attr: { type: "text", placeholder: "Search commits (press Enter, ↑↓ for history)" },
    });
    searchInput.addEventListener("input", () => {
      this.filterText = searchInput.value.toLowerCase();
      this.applyFilter();
    });

    const right = bar.createDiv("gs-toolbar-right");

    const allBtn = right.createEl("button", { cls: "gs-tbtn" });
    setIcon(allBtn, "list");
    allBtn.setAttribute("aria-label", "All");
    allBtn.addClass("gs-tbtn-active");

    const branchFilterBtn = right.createEl("button", { cls: "gs-tbtn" });
    setIcon(branchFilterBtn, "filter");
    branchFilterBtn.setAttribute("aria-label", "Filter branches");

    let showAll = true;
    branchFilterBtn.addEventListener("click", () => {
      showAll = !showAll;
      branchFilterBtn.toggleClass("gs-tbtn-active", !showAll);
      allBtn.toggleClass("gs-tbtn-active", showAll);
      this.store.refreshLog({ all: showAll, maxCount: 500 });
    });
    allBtn.addEventListener("click", () => {
      showAll = true;
      allBtn.addClass("gs-tbtn-active");
      branchFilterBtn.removeClass("gs-tbtn-active");
      this.store.refreshLog({ all: true, maxCount: 500 });
    });

    const refreshBtn = right.createEl("button", { cls: "gs-tbtn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => {
      this.store.refreshLog({ all: showAll, maxCount: 500 });
      this.store.refresh();
    });
  }

  private buildColumnHeaders(el: HTMLElement): void {
    const header = el.createDiv("gs-graph-header");
    header.createDiv("gs-col gs-col-ref").setText("BRANCH / TAG");
    header.createDiv("gs-col gs-col-graph").setText("GRAPH");
    header.createDiv("gs-col gs-col-msg").setText("COMMIT MESSAGE");
    header.createDiv("gs-col gs-col-author").setText("AUTHOR");
    header.createDiv("gs-col gs-col-files"); // icon column
    const filesIcon = header.querySelector(".gs-col-files") as HTMLElement;
    setIcon(filesIcon, "files");
    header.createDiv("gs-col gs-col-date"); // icon column
    const dateIcon = header.querySelector(".gs-col-date") as HTMLElement;
    setIcon(dateIcon, "calendar");
    header.createDiv("gs-col gs-col-hash").setText("SHA");
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
    this.updateLayout();
    this.renderVisible();
  }

  private getVisibleRows(): number[] {
    return this.filteredIndices ?? this.nodes.map((_, i) => i);
  }

  private getRowOffset(): number {
    return this.hasWorkingChanges ? 1 : 0;
  }

  private updateLayout(): void {
    const rows = this.getVisibleRows();
    const totalRows = rows.length + this.getRowOffset();
    const totalHeight = totalRows * ROW_HEIGHT;
    if (this.spacerEl) this.spacerEl.style.height = totalHeight + "px";

    const graphWidth = Math.max(GRAPH_COL_MIN_WIDTH, (this.maxColumns + 1) * COL_WIDTH + 20);
    if (this.svgLayer) {
      this.svgLayer.style.height = totalHeight + "px";
      this.svgLayer.setAttribute("height", String(totalHeight));
    }
    this.contentEl.style.setProperty("--gs-graph-col-width", graphWidth + "px");
  }

  private renderVisible(): void {
    if (!this.scrollEl || !this.svgLayer || !this.tableBody) return;

    const visibleRows = this.getVisibleRows();
    const offset = this.getRowOffset();
    const scrollTop = this.scrollEl.scrollTop;
    const viewHeight = this.scrollEl.clientHeight;

    const startVisRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const endVisRow = Math.min(
      visibleRows.length + offset - 1,
      Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + OVERSCAN,
    );

    this.renderSvg(visibleRows, startVisRow, endVisRow, offset);
    this.renderRows(visibleRows, startVisRow, endVisRow, offset);
  }

  private renderSvg(visibleRows: number[], startVis: number, endVis: number, offset: number): void {
    if (!this.svgLayer) return;
    while (this.svgLayer.firstChild) this.svgLayer.removeChild(this.svgLayer.firstChild);

    const graphWidth = Math.max(GRAPH_COL_MIN_WIDTH, (this.maxColumns + 1) * COL_WIDTH + 20);
    const totalHeight = (visibleRows.length + offset) * ROW_HEIGHT;
    this.svgLayer.setAttribute("viewBox", `0 0 ${graphWidth} ${totalHeight}`);
    this.svgLayer.setAttribute("width", String(graphWidth));

    const visRowMap = new Map<number, number>();
    visibleRows.forEach((origIdx, visIdx) => visRowMap.set(origIdx, visIdx + offset));

    for (const edge of this.edges) {
      const fromVis = visRowMap.get(edge.fromRow);
      const toVis = visRowMap.get(edge.toRow);
      if (fromVis === undefined || toVis === undefined) continue;

      const minVis = Math.min(fromVis, toVis);
      const maxVis = Math.max(fromVis, toVis);
      if (maxVis < startVis - 5 || minVis > endVis + 5) continue;

      const x1 = edge.fromCol * COL_WIDTH + 10;
      const y1 = fromVis * ROW_HEIGHT + ROW_HEIGHT / 2;
      const x2 = edge.toCol * COL_WIDTH + 10;
      const y2 = toVis * ROW_HEIGHT + ROW_HEIGHT / 2;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      const color = COLORS[edge.color % COLORS.length];

      if (x1 === x2) {
        path.setAttribute("d", `M${x1},${y1} L${x2},${y2}`);
      } else {
        const cy1 = y1 + Math.min(ROW_HEIGHT * 1.5, Math.abs(y2 - y1) * 0.4);
        const cy2 = y2 - Math.min(ROW_HEIGHT * 1.5, Math.abs(y2 - y1) * 0.4);
        path.setAttribute("d", `M${x1},${y1} C${x1},${cy1} ${x2},${cy2} ${x2},${y2}`);
      }
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "2");
      path.setAttribute("fill", "none");
      this.svgLayer!.appendChild(path);
    }

    for (let vi = 0; vi < visibleRows.length; vi++) {
      const visRow = vi + offset;
      if (visRow < startVis - 2 || visRow > endVis + 2) continue;
      const origIdx = visibleRows[vi];
      if (origIdx >= this.nodes.length) continue;
      const node = this.nodes[origIdx];
      const x = node.column * COL_WIDTH + 10;
      const y = visRow * ROW_HEIGHT + ROW_HEIGHT / 2;
      const color = COLORS[node.color % COLORS.length];
      const isMerge = node.commit.parents.length > 1;

      const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      circle.setAttribute("cx", String(x));
      circle.setAttribute("cy", String(y));
      circle.setAttribute("r", String(isMerge ? NODE_RADIUS + 1 : NODE_RADIUS));
      circle.setAttribute("fill", isMerge ? "var(--background-primary, #1e1e2e)" : color);
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", isMerge ? "2" : "0");
      this.svgLayer!.appendChild(circle);
    }

    if (this.hasWorkingChanges && startVis === 0) {
      const cx = 10;
      const cy = ROW_HEIGHT / 2;
      const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      ring.setAttribute("cx", String(cx));
      ring.setAttribute("cy", String(cy));
      ring.setAttribute("r", String(NODE_RADIUS + 2));
      ring.setAttribute("fill", "none");
      ring.setAttribute("stroke", "#22c55e");
      ring.setAttribute("stroke-width", "2");
      ring.setAttribute("stroke-dasharray", "3 2");
      this.svgLayer!.appendChild(ring);
      const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      dot.setAttribute("cx", String(cx));
      dot.setAttribute("cy", String(cy));
      dot.setAttribute("r", "2");
      dot.setAttribute("fill", "#22c55e");
      this.svgLayer!.appendChild(dot);
    }
  }

  private renderRows(
    visibleRows: number[],
    startVis: number,
    endVis: number,
    offset: number,
  ): void {
    if (!this.tableBody) return;
    this.tableBody.empty();

    if (this.hasWorkingChanges && startVis === 0) {
      const wcRow = this.createWorkingChangesRow();
      wcRow.style.top = "0px";
      wcRow.style.height = ROW_HEIGHT + "px";
      this.tableBody.appendChild(wcRow);
    }

    for (let vi = 0; vi < visibleRows.length; vi++) {
      const visRow = vi + offset;
      if (visRow < startVis || visRow > endVis) continue;
      const origIdx = visibleRows[vi];
      if (origIdx >= this.nodes.length) continue;

      const node = this.nodes[origIdx];
      const commit = node.commit;
      const row = this.createCommitRow(commit, node);
      row.style.top = visRow * ROW_HEIGHT + "px";
      row.style.height = ROW_HEIGHT + "px";
      this.tableBody.appendChild(row);
    }
  }

  private createWorkingChangesRow(): HTMLElement {
    const row = createDiv("gs-graph-row gs-row-wc");
    row.createDiv("gs-cell gs-cell-ref");
    row.createDiv("gs-cell gs-cell-graph");

    const msgCell = row.createDiv("gs-cell gs-cell-msg");
    msgCell.createSpan("gs-wc-label").setText("Working Changes");

    const authorCell = row.createDiv("gs-cell gs-cell-author");
    authorCell.setText("You");

    const filesCell = row.createDiv("gs-cell gs-cell-files");
    const changed = this.store.changedFiles.length + this.store.untrackedFiles.length;
    const staged = this.store.stagedFiles.length;
    const statsEl = filesCell.createSpan("gs-file-stats");
    if (staged > 0) statsEl.createSpan("gs-stat-staged").setText(`+${staged}`);
    if (changed > 0)
      statsEl.createSpan("gs-stat-changed").setText(`${staged > 0 ? " / " : ""}${changed}`);

    row.createDiv("gs-cell gs-cell-date");
    row.createDiv("gs-cell gs-cell-hash");

    row.addEventListener("click", () => this.plugin.openSourceControlView());
    return row;
  }

  private createCommitRow(commit: CommitInfo, _node: GraphNode): HTMLElement {
    const row = createDiv("gs-graph-row");
    if (commit.hash === this.selectedHash) row.addClass("gs-row-selected");

    const refCell = row.createDiv("gs-cell gs-cell-ref");
    for (const ref of commit.refs) {
      const pill = refCell.createSpan("gs-ref-pill");
      if (ref.type === "head") {
        pill.addClass("gs-ref-head");
        const icon = pill.createSpan("gs-ref-icon");
        setIcon(icon, "check");
      } else if (ref.type === "remote") {
        pill.addClass("gs-ref-remote");
        const icon = pill.createSpan("gs-ref-icon");
        setIcon(icon, "cloud");
      } else if (ref.type === "tag") {
        pill.addClass("gs-ref-tag");
        const icon = pill.createSpan("gs-ref-icon");
        setIcon(icon, "tag");
      } else {
        pill.addClass("gs-ref-branch");
        const icon = pill.createSpan("gs-ref-icon");
        setIcon(icon, "git-branch");
      }
      pill.createSpan("gs-ref-name").setText(ref.name);
    }

    row.createDiv("gs-cell gs-cell-graph");

    const msgCell = row.createDiv("gs-cell gs-cell-msg");
    msgCell.createSpan("gs-commit-msg").setText(commit.message);

    const authorCell = row.createDiv("gs-cell gs-cell-author");
    authorCell.setText(commit.author);

    const filesCell = row.createDiv("gs-cell gs-cell-files");

    const dateCell = row.createDiv("gs-cell gs-cell-date");
    dateCell.setText(formatRelativeDate(commit.date));

    const hashCell = row.createDiv("gs-cell gs-cell-hash");
    hashCell.setText(commit.shortHash);

    row.addEventListener("click", (e) => this.onRowClick(e, commit, row));
    row.addEventListener("contextmenu", (e) => this.showCommitMenu(e, commit));
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

    this.loadFileCount(commit.hash, filesCell);

    return row;
  }

  private async loadFileCount(hash: string, cell: HTMLElement): Promise<void> {
    try {
      const files = await this.git.showCommitFiles(hash);
      const icon = cell.createSpan("gs-files-icon");
      setIcon(icon, "file");
      cell.createSpan("gs-files-count").setText(String(files.length));
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      const total = totalAdd + totalDel;
      if (total > 0) {
        const bar = cell.createDiv("gs-sg-changes-bar");
        const addPct = Math.round((totalAdd / total) * 100);
        bar.createDiv("gs-sg-changes-add").style.width = addPct + "%";
        bar.createDiv("gs-sg-changes-del").style.width = 100 - addPct + "%";
      }
    } catch {
      // ignore
    }
  }

  private async onRowClick(_e: MouseEvent, commit: CommitInfo, row: HTMLElement): Promise<void> {
    if (this.selectedHash === commit.hash) {
      this.selectedHash = null;
      this.hidePopup();
      this.renderVisible();
      return;
    }

    this.selectedHash = commit.hash;
    this.renderVisible();
    await this.showPopup(commit, row);
    this.plugin.showCommitChangesInSidebar(commit);
  }

  private async showPopup(commit: CommitInfo, anchor: HTMLElement): Promise<void> {
    if (!this.popupEl || !this.scrollEl) return;
    this.popupEl.empty();
    this.popupEl.style.display = "block";

    const header = this.popupEl.createDiv("gs-popup-header");
    const avatar = header.createDiv("gs-popup-avatar");
    const initials = commit.author
      .split(" ")
      .map((w) => w[0] || "")
      .join("")
      .substring(0, 2)
      .toUpperCase();
    avatar.setText(initials);

    const info = header.createDiv("gs-popup-info");
    const authorLine = info.createDiv("gs-popup-author-line");
    authorLine.createSpan("gs-popup-author-name").setText(commit.author);
    authorLine.createSpan("gs-popup-time").setText(formatRelativeDate(commit.date));
    authorLine.createSpan("gs-popup-fulldate").setText(`(${commit.date.toLocaleString()})`);

    const metaLine = info.createDiv("gs-popup-meta");
    const parentLabel = metaLine.createSpan("gs-popup-parent-label");
    parentLabel.setText(`◆ ${commit.shortHash}`);
    if (commit.parents.length > 0) {
      metaLine
        .createSpan("gs-popup-parent-hash")
        .setText(` ← ${commit.parents.map((p) => p.substring(0, 7)).join(", ")}`);
    }

    try {
      const files = await this.git.showCommitFiles(commit.hash);
      const totalAdd = files.reduce((s, f) => s + f.additions, 0);
      const totalDel = files.reduce((s, f) => s + f.deletions, 0);
      const statsLine = metaLine.createSpan("gs-popup-stats");
      statsLine.setText(` (${files.length} file${files.length !== 1 ? "s" : ""} changed)`);
      if (totalAdd > 0) statsLine.createSpan("gs-stat-add").setText(` ${totalAdd} additions`);
      if (totalDel > 0) statsLine.createSpan("gs-stat-del").setText(` ${totalDel} deletions`);
    } catch {
      // ignore
    }

    const msgDiv = this.popupEl.createDiv("gs-popup-msg");
    msgDiv.setText(commit.message);
    if (commit.body) {
      this.popupEl.createDiv("gs-popup-body").setText(commit.body);
    }

    const actions = this.popupEl.createDiv("gs-popup-actions");
    const copyBtn = actions.createEl("button", { cls: "gs-popup-btn", text: "Copy SHA" });
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(commit.hash);
      new Notice("SHA copied");
    });
    const diffBtn = actions.createEl("button", { cls: "gs-popup-btn", text: "View Changes" });
    diffBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        const files = await this.git.showCommitFiles(commit.hash);
        if (files.length > 0) {
          this.plugin.openDiff(files[0].path, commit.hash);
        }
      } catch {
        new Notice("Could not load changes");
      }
    });
    const branchBtn = actions.createEl("button", { cls: "gs-popup-btn", text: "Create Branch" });
    branchBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const name = await this.promptText("New branch name:");
      if (name) {
        try {
          await this.git.createBranch(name, commit.hash);
          await this.store.refresh();
          await this.store.refreshLog({ all: true });
          new Notice(`Branch '${name}' created`);
        } catch (err: unknown) {
          new Notice(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    });

    const anchorRect = anchor.getBoundingClientRect();
    const scrollRect = this.scrollEl.getBoundingClientRect();
    this.popupEl.style.left = "0";
    this.popupEl.style.right = "0";
    this.popupEl.style.top = anchorRect.bottom - scrollRect.top + this.scrollEl.scrollTop + "px";
  }

  private hidePopup(): void {
    if (this.popupEl) this.popupEl.style.display = "none";
  }

  private showCommitMenu(event: MouseEvent, commit: CommitInfo): void {
    const menu = new Menu();
    menu.addItem((i) =>
      i
        .setTitle("Copy SHA")
        .setIcon("copy")
        .onClick(() => {
          navigator.clipboard.writeText(commit.hash);
          new Notice("SHA copied");
        }),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Create Branch here...")
        .setIcon("git-branch-plus")
        .onClick(async () => {
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
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Checkout")
        .setIcon("log-in")
        .onClick(async () => {
          try {
            await this.git.checkout(commit.hash);
            await this.store.refresh();
            new Notice("Checked out " + commit.shortHash);
          } catch (e: unknown) {
            new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
    );
    menu.addSeparator();
    menu.addItem((i) =>
      i
        .setTitle("Cherry-pick")
        .setIcon("cherry")
        .onClick(async () => {
          try {
            await (this.git as any).exec(["cherry-pick", commit.hash]);
            await this.store.refresh();
            new Notice("Cherry-picked " + commit.shortHash);
          } catch (e: unknown) {
            new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
    );
    menu.addItem((i) =>
      i
        .setTitle("Revert")
        .setIcon("undo")
        .onClick(async () => {
          try {
            await (this.git as any).exec(["revert", "--no-edit", commit.hash]);
            await this.store.refresh();
            new Notice("Reverted " + commit.shortHash);
          } catch (e: unknown) {
            new Notice(`Error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private promptText(label: string): Promise<string | null> {
    return new Promise((resolve) => {
      const modal = new Modal(this.app);
      modal.titleEl.setText(label);
      const input = modal.contentEl.createEl("input", {
        cls: "gs-modal-input",
        attr: { type: "text" },
      });
      const btnRow = modal.contentEl.createDiv("gs-modal-btns");
      const ok = btnRow.createEl("button", { text: "OK", cls: "mod-cta" });
      const cancel = btnRow.createEl("button", { text: "Cancel" });
      ok.addEventListener("click", () => {
        modal.close();
        resolve(input.value || null);
      });
      cancel.addEventListener("click", () => {
        modal.close();
        resolve(null);
      });
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          modal.close();
          resolve(input.value || null);
        }
        if (e.key === "Escape") {
          modal.close();
          resolve(null);
        }
      });
      modal.open();
      input.focus();
    });
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
    this.hidePopup();
    this.hideCommitTooltip();
  }
}

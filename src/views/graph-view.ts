import { ItemView, WorkspaceLeaf, setIcon, Menu, Modal, Notice } from "obsidian";
import { GRAPH_VIEW_TYPE, CommitInfo, CommitStats, GraphNode, GraphEdge } from "../types";
import { RepoStore } from "../store/repo-store";
import { GitService } from "../git/git-service";
import { computeGraphLayout, formatRelativeDate } from "../utils/graph-layout";
import type GitHistoryPlugin from "../main";

const ROW_HEIGHT = 32;
const COL_WIDTH = 14;
const GRAPH_COL_MIN_WIDTH = 60;
const NODE_RADIUS = 4;
const OVERSCAN = 15;
const SVG_NS = "http://www.w3.org/2000/svg";
/** Rows per edge bucket — keeps edge lookup proportional to the viewport, not the graph. */
const EDGE_CHUNK = 64;
/** First paint renders this many commits, the full set follows in the background. */
const INITIAL_LOG_COUNT = 150;
const FULL_LOG_COUNT = 500;

/** A pooled row. Cells are created once and rebound as rows scroll in and out. */
interface RowHandle {
  el: HTMLElement;
  refCell: HTMLElement;
  msgSpan: HTMLElement;
  authorCell: HTMLElement;
  filesCell: HTMLElement;
  dateCell: HTMLElement;
  hashCell: HTMLElement;
  commit: CommitInfo | null;
  key: string;
}

/** An edge with its row positions already resolved, ready to draw. */
interface RenderEdge {
  fromVis: number;
  toVis: number;
  fromCol: number;
  toCol: number;
  color: number;
}

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
  private tooltipTimeout: number | null = null;
  private renderHandle: number | null = null;
  /** Lazily resolved stats for commits git omits from --shortstat (merges, empty commits). */
  private statsFallback = new Map<string, CommitStats>();

  private mountedRows = new Map<number, RowHandle>();
  private rowPool: RowHandle[] = [];
  private wcRow: { el: HTMLElement; filesCell: HTMLElement; key: string } | null = null;
  /** Bumped whenever commits or the filter change, to force a rebind of mounted rows. */
  private generation = 0;

  private edgeChunks = new Map<number, RenderEdge[]>();
  private pathPool: SVGPathElement[] = [];
  private circlePool: SVGCircleElement[] = [];
  private wcRing: SVGCircleElement | null = null;
  private wcDot: SVGCircleElement | null = null;

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
    this.scrollEl.addEventListener("scroll", () => this.scheduleRender());

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
        // The graph layout depends only on the commit list, so a status change
        // never needs computeGraphLayout() — it only affects the working
        // changes row. Vault edits fire this constantly while typing.
        const had = this.hasWorkingChanges;
        this.hasWorkingChanges = this.store.status.length > 0;
        if (had !== this.hasWorkingChanges) this.updateLayout();
        this.scheduleRender();
      }),
    );

    // Paint a first screenful quickly, then fill in the rest in the background.
    await this.store.refreshLog({ all: true, maxCount: INITIAL_LOG_COUNT });
    await Promise.all([
      this.store.refreshLog({ all: true, maxCount: FULL_LOG_COUNT }),
      this.store.refresh(),
    ]);
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
      this.store.refreshLog({ all: showAll, maxCount: FULL_LOG_COUNT });
    });
    allBtn.addEventListener("click", () => {
      showAll = true;
      allBtn.addClass("gs-tbtn-active");
      branchFilterBtn.removeClass("gs-tbtn-active");
      this.store.refreshLog({ all: true, maxCount: FULL_LOG_COUNT });
    });

    const refreshBtn = right.createEl("button", { cls: "gs-tbtn" });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.setAttribute("aria-label", "Refresh");
    refreshBtn.addEventListener("click", () => {
      this.store.refreshLog({ all: showAll, maxCount: FULL_LOG_COUNT });
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
    this.generation++;
    this.updateLayout();
    this.scheduleRender();
  }

  private rebuildGraph(): void {
    const result = computeGraphLayout(this.store.commits);
    this.nodes = result.nodes;
    this.edges = result.edges;
    this.maxColumns = result.maxColumns;
    this.filteredIndices = null;
    this.generation++;
    this.updateLayout();
    this.scheduleRender();
  }

  private getVisibleRows(): number[] {
    return this.filteredIndices ?? this.nodes.map((_, i) => i);
  }

  private getRowOffset(): number {
    return this.hasWorkingChanges ? 1 : 0;
  }

  private updateLayout(): void {
    const rows = this.getVisibleRows();
    const offset = this.getRowOffset();
    const totalRows = rows.length + offset;
    const totalHeight = totalRows * ROW_HEIGHT;
    if (this.spacerEl) this.spacerEl.style.height = totalHeight + "px";

    const graphWidth = Math.max(GRAPH_COL_MIN_WIDTH, (this.maxColumns + 1) * COL_WIDTH + 20);
    if (this.svgLayer) {
      this.svgLayer.style.height = totalHeight + "px";
      this.svgLayer.setAttribute("height", String(totalHeight));
    }
    this.contentEl.style.setProperty("--gs-graph-col-width", graphWidth + "px");

    this.buildEdgeIndex(rows, offset);
  }

  /**
   * Buckets edges by row range so a render only walks the edges near the
   * viewport instead of the whole graph. Rebuilt whenever row positions change.
   */
  private buildEdgeIndex(visibleRows: number[], offset: number): void {
    this.edgeChunks.clear();

    const visRowOf = new Map<number, number>();
    for (let i = 0; i < visibleRows.length; i++) visRowOf.set(visibleRows[i], i + offset);

    for (const edge of this.edges) {
      const fromVis = visRowOf.get(edge.fromRow);
      const toVis = visRowOf.get(edge.toRow);
      if (fromVis === undefined || toVis === undefined) continue;

      const renderEdge: RenderEdge = {
        fromVis,
        toVis,
        fromCol: edge.fromCol,
        toCol: edge.toCol,
        color: edge.color,
      };
      const first = Math.floor(Math.min(fromVis, toVis) / EDGE_CHUNK);
      const last = Math.floor(Math.max(fromVis, toVis) / EDGE_CHUNK);
      for (let chunk = first; chunk <= last; chunk++) {
        const bucket = this.edgeChunks.get(chunk);
        if (bucket) bucket.push(renderEdge);
        else this.edgeChunks.set(chunk, [renderEdge]);
      }
    }
  }

  /** Coalesces scroll bursts (~120/s on a trackpad) into one render per frame. */
  private scheduleRender(): void {
    if (this.renderHandle !== null) return;
    this.renderHandle = requestAnimationFrame(() => {
      this.renderHandle = null;
      this.renderVisible();
    });
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

  private takePath(index: number): SVGPathElement {
    let path = this.pathPool[index];
    if (!path) {
      path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke-width", "2");
      this.pathPool[index] = path;
      this.svgLayer!.appendChild(path);
    }
    path.style.display = "";
    return path;
  }

  private takeCircle(index: number): SVGCircleElement {
    let circle = this.circlePool[index];
    if (!circle) {
      circle = document.createElementNS(SVG_NS, "circle");
      this.circlePool[index] = circle;
      this.svgLayer!.appendChild(circle);
    }
    circle.style.display = "";
    return circle;
  }

  private renderSvg(visibleRows: number[], startVis: number, endVis: number, offset: number): void {
    if (!this.svgLayer) return;

    const graphWidth = Math.max(GRAPH_COL_MIN_WIDTH, (this.maxColumns + 1) * COL_WIDTH + 20);
    const totalHeight = (visibleRows.length + offset) * ROW_HEIGHT;
    this.svgLayer.setAttribute("viewBox", `0 0 ${graphWidth} ${totalHeight}`);
    this.svgLayer.setAttribute("width", String(graphWidth));

    // Edges: walk only the buckets overlapping the viewport.
    let pathCount = 0;
    const drawn = new Set<RenderEdge>();
    const firstChunk = Math.floor(Math.max(0, startVis - 5) / EDGE_CHUNK);
    const lastChunk = Math.floor((endVis + 5) / EDGE_CHUNK);

    for (let chunk = firstChunk; chunk <= lastChunk; chunk++) {
      const bucket = this.edgeChunks.get(chunk);
      if (!bucket) continue;
      for (const edge of bucket) {
        if (drawn.has(edge)) continue;
        drawn.add(edge);

        const minVis = Math.min(edge.fromVis, edge.toVis);
        const maxVis = Math.max(edge.fromVis, edge.toVis);
        if (maxVis < startVis - 5 || minVis > endVis + 5) continue;

        const x1 = edge.fromCol * COL_WIDTH + 10;
        const y1 = edge.fromVis * ROW_HEIGHT + ROW_HEIGHT / 2;
        const x2 = edge.toCol * COL_WIDTH + 10;
        const y2 = edge.toVis * ROW_HEIGHT + ROW_HEIGHT / 2;

        const path = this.takePath(pathCount++);
        if (x1 === x2) {
          path.setAttribute("d", `M${x1},${y1} L${x2},${y2}`);
        } else {
          const cy1 = y1 + Math.min(ROW_HEIGHT * 1.5, Math.abs(y2 - y1) * 0.4);
          const cy2 = y2 - Math.min(ROW_HEIGHT * 1.5, Math.abs(y2 - y1) * 0.4);
          path.setAttribute("d", `M${x1},${y1} C${x1},${cy1} ${x2},${cy2} ${x2},${y2}`);
        }
        path.setAttribute("stroke", COLORS[edge.color % COLORS.length]);
      }
    }
    for (let i = pathCount; i < this.pathPool.length; i++) this.pathPool[i].style.display = "none";

    // Nodes: index straight into the visible range instead of scanning all rows.
    let circleCount = 0;
    const firstNode = Math.max(offset, startVis - 2);
    const lastNode = Math.min(visibleRows.length + offset - 1, endVis + 2);

    for (let visRow = firstNode; visRow <= lastNode; visRow++) {
      const origIdx = visibleRows[visRow - offset];
      if (origIdx === undefined || origIdx >= this.nodes.length) continue;
      const node = this.nodes[origIdx];
      const color = COLORS[node.color % COLORS.length];
      const isMerge = node.commit.parents.length > 1;

      const circle = this.takeCircle(circleCount++);
      circle.setAttribute("cx", String(node.column * COL_WIDTH + 10));
      circle.setAttribute("cy", String(visRow * ROW_HEIGHT + ROW_HEIGHT / 2));
      circle.setAttribute("r", String(isMerge ? NODE_RADIUS + 1 : NODE_RADIUS));
      circle.setAttribute("fill", isMerge ? "var(--background-primary, #1e1e2e)" : color);
      circle.setAttribute("stroke", color);
      circle.setAttribute("stroke-width", isMerge ? "2" : "0");
    }
    for (let i = circleCount; i < this.circlePool.length; i++) {
      this.circlePool[i].style.display = "none";
    }

    this.renderWorkingChangesNode(startVis);
  }

  /** The dashed working-changes marker lives outside the pool to keep its dash pattern. */
  private renderWorkingChangesNode(startVis: number): void {
    const show = this.hasWorkingChanges && startVis === 0;
    if (!show) {
      if (this.wcRing) this.wcRing.style.display = "none";
      if (this.wcDot) this.wcDot.style.display = "none";
      return;
    }

    if (!this.wcRing) {
      this.wcRing = document.createElementNS(SVG_NS, "circle");
      this.wcRing.setAttribute("cx", "10");
      this.wcRing.setAttribute("cy", String(ROW_HEIGHT / 2));
      this.wcRing.setAttribute("r", String(NODE_RADIUS + 2));
      this.wcRing.setAttribute("fill", "none");
      this.wcRing.setAttribute("stroke", "#22c55e");
      this.wcRing.setAttribute("stroke-width", "2");
      this.wcRing.setAttribute("stroke-dasharray", "3 2");
      this.svgLayer!.appendChild(this.wcRing);

      this.wcDot = document.createElementNS(SVG_NS, "circle");
      this.wcDot.setAttribute("cx", "10");
      this.wcDot.setAttribute("cy", String(ROW_HEIGHT / 2));
      this.wcDot.setAttribute("r", "2");
      this.wcDot.setAttribute("fill", "#22c55e");
      this.svgLayer!.appendChild(this.wcDot);
    }
    this.wcRing.style.display = "";
    this.wcDot!.style.display = "";
  }

  /**
   * Mounts only the rows entering the viewport and rebinds the ones whose
   * content actually changed. Rows leaving the viewport go back into a pool,
   * so scrolling allocates no DOM and re-parses no icons.
   */
  private renderRows(
    visibleRows: number[],
    startVis: number,
    endVis: number,
    offset: number,
  ): void {
    if (!this.tableBody) return;

    this.syncWorkingChangesRow(startVis);

    // Rows below `offset` belong to the working changes row, so they must be
    // released when it appears — otherwise a commit row would sit underneath it.
    const firstRow = Math.max(startVis, offset);

    for (const [visRow, handle] of this.mountedRows) {
      if (visRow < firstRow || visRow > endVis) {
        handle.el.remove();
        handle.commit = null;
        handle.key = "";
        this.mountedRows.delete(visRow);
        this.rowPool.push(handle);
      }
    }

    for (let visRow = firstRow; visRow <= endVis; visRow++) {
      const origIdx = visibleRows[visRow - offset];
      if (origIdx === undefined || origIdx >= this.nodes.length) continue;

      const commit = this.nodes[origIdx].commit;
      const selected = commit.hash === this.selectedHash;
      const key = `${this.generation}:${commit.hash}:${selected ? 1 : 0}`;

      let handle = this.mountedRows.get(visRow);
      if (!handle) {
        handle = this.rowPool.pop() ?? this.createRowShell();
        handle.el.style.top = visRow * ROW_HEIGHT + "px";
        this.mountedRows.set(visRow, handle);
        this.tableBody.appendChild(handle.el);
      }
      if (handle.key !== key) {
        this.bindRow(handle, commit, selected);
        handle.key = key;
      }
    }
  }

  /** Builds the row skeleton once; listeners read the currently bound commit. */
  private createRowShell(): RowHandle {
    const el = createDiv("gs-graph-row");
    el.style.height = ROW_HEIGHT + "px";

    const refCell = el.createDiv("gs-cell gs-cell-ref");
    el.createDiv("gs-cell gs-cell-graph");
    const msgSpan = el.createDiv("gs-cell gs-cell-msg").createSpan("gs-commit-msg");
    const authorCell = el.createDiv("gs-cell gs-cell-author");
    const filesCell = el.createDiv("gs-cell gs-cell-files");
    const dateCell = el.createDiv("gs-cell gs-cell-date");
    const hashCell = el.createDiv("gs-cell gs-cell-hash");

    const handle: RowHandle = {
      el,
      refCell,
      msgSpan,
      authorCell,
      filesCell,
      dateCell,
      hashCell,
      commit: null,
      key: "",
    };

    el.addEventListener("click", (e) => {
      if (handle.commit) this.onRowClick(e, handle.commit, el);
    });
    el.addEventListener("contextmenu", (e) => {
      if (handle.commit) this.showCommitMenu(e, handle.commit);
    });
    el.addEventListener("mouseenter", () => {
      if (this.tooltipTimeout !== null) window.clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = window.setTimeout(() => {
        if (handle.commit) this.showCommitTooltip(handle.commit, el);
      }, 400);
    });
    el.addEventListener("mouseleave", () => {
      if (this.tooltipTimeout !== null) {
        window.clearTimeout(this.tooltipTimeout);
        this.tooltipTimeout = null;
      }
      this.hideCommitTooltip();
    });

    return handle;
  }

  private bindRow(handle: RowHandle, commit: CommitInfo, selected: boolean): void {
    handle.commit = commit;
    handle.el.toggleClass("gs-row-selected", selected);

    handle.refCell.empty();
    for (const ref of commit.refs) {
      const pill = handle.refCell.createSpan("gs-ref-pill");
      const icon = pill.createSpan("gs-ref-icon");
      if (ref.type === "head") {
        pill.addClass("gs-ref-head");
        setIcon(icon, "check");
      } else if (ref.type === "remote") {
        pill.addClass("gs-ref-remote");
        setIcon(icon, "cloud");
      } else if (ref.type === "tag") {
        pill.addClass("gs-ref-tag");
        setIcon(icon, "tag");
      } else {
        pill.addClass("gs-ref-branch");
        setIcon(icon, "git-branch");
      }
      pill.createSpan("gs-ref-name").setText(ref.name);
    }

    handle.msgSpan.setText(commit.message);
    handle.authorCell.setText(commit.author);
    handle.dateCell.setText(formatRelativeDate(commit.date));
    handle.hashCell.setText(commit.shortHash);

    handle.filesCell.empty();
    this.renderFileStats(commit, handle.filesCell);
  }

  private syncWorkingChangesRow(startVis: number): void {
    if (!this.tableBody) return;
    const show = this.hasWorkingChanges && startVis === 0;

    if (!show) {
      this.wcRow?.el.remove();
      return;
    }

    if (!this.wcRow) {
      const el = createDiv("gs-graph-row gs-row-wc");
      el.style.height = ROW_HEIGHT + "px";
      el.style.top = "0px";
      el.createDiv("gs-cell gs-cell-ref");
      el.createDiv("gs-cell gs-cell-graph");
      el.createDiv("gs-cell gs-cell-msg").createSpan("gs-wc-label").setText("Working Changes");
      el.createDiv("gs-cell gs-cell-author").setText("You");
      const filesCell = el.createDiv("gs-cell gs-cell-files");
      el.createDiv("gs-cell gs-cell-date");
      el.createDiv("gs-cell gs-cell-hash");
      el.addEventListener("click", () => this.plugin.openSourceControlView());

      this.wcRow = { el, filesCell, key: "" };
    }

    const changed = this.store.changedFiles.length + this.store.untrackedFiles.length;
    const staged = this.store.stagedFiles.length;
    const key = `${staged}/${changed}`;
    if (this.wcRow.key !== key) {
      this.wcRow.filesCell.empty();
      const statsEl = this.wcRow.filesCell.createSpan("gs-file-stats");
      if (staged > 0) statsEl.createSpan("gs-stat-staged").setText(`+${staged}`);
      if (changed > 0)
        statsEl.createSpan("gs-stat-changed").setText(`${staged > 0 ? " / " : ""}${changed}`);
      this.wcRow.key = key;
    }

    if (!this.wcRow.el.isConnected) this.tableBody.appendChild(this.wcRow.el);
  }

  /**
   * Renders the file/changes column. Stats normally arrive with the commit log,
   * so this is synchronous and costs no git process. Only commits git omits
   * from --shortstat fall back to a one-off lookup, cached per hash.
   */
  private renderFileStats(commit: CommitInfo, cell: HTMLElement): void {
    cell.dataset.hash = commit.hash;

    const stats = commit.stats ?? this.statsFallback.get(commit.hash);
    if (stats) {
      this.paintFileStats(stats, cell);
      return;
    }
    if (this.statsFallback.has(commit.hash)) return;

    void this.git
      .showCommitFiles(commit.hash)
      .then((files) => {
        const resolved: CommitStats = {
          filesChanged: files.length,
          additions: files.reduce((s, f) => s + f.additions, 0),
          deletions: files.reduce((s, f) => s + f.deletions, 0),
        };
        this.statsFallback.set(commit.hash, resolved);
        // The row may have scrolled away or been rebound to another commit.
        if (cell.isConnected && cell.dataset.hash === commit.hash) {
          this.paintFileStats(resolved, cell);
        }
      })
      .catch(() => {
        // leave the column empty for commits we cannot stat
      });
  }

  private paintFileStats(stats: CommitStats, cell: HTMLElement): void {
    const icon = cell.createSpan("gs-files-icon");
    setIcon(icon, "file");
    cell.createSpan("gs-files-count").setText(String(stats.filesChanged));

    const total = stats.additions + stats.deletions;
    if (total > 0) {
      const bar = cell.createDiv("gs-sg-changes-bar");
      const addPct = Math.round((stats.additions / total) * 100);
      bar.createDiv("gs-sg-changes-add").style.width = addPct + "%";
      bar.createDiv("gs-sg-changes-del").style.width = 100 - addPct + "%";
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
    this.loadTooltipStats(commit, statsPlaceholder);

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

  private async loadTooltipStats(commit: CommitInfo, container: HTMLElement): Promise<void> {
    try {
      let stats = commit.stats ?? this.statsFallback.get(commit.hash);
      if (!stats) {
        const files = await this.git.showCommitFiles(commit.hash);
        stats = {
          filesChanged: files.length,
          additions: files.reduce((s, f) => s + f.additions, 0),
          deletions: files.reduce((s, f) => s + f.deletions, 0),
        };
        this.statsFallback.set(commit.hash, stats);
        if (!this.tooltipEl) return;
      }
      if (stats.filesChanged === 0) return;

      container.appendChild(
        this.el(
          "span",
          "gs-sg-tip-stats-files",
          `${stats.filesChanged} file${stats.filesChanged !== 1 ? "s" : ""} changed`,
        ),
      );
      if (stats.additions > 0)
        container.appendChild(this.el("span", "gs-stat-add", `  ${stats.additions} additions`));
      if (stats.deletions > 0)
        container.appendChild(this.el("span", "gs-stat-del", `  ${stats.deletions} deletions`));
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
    if (this.renderHandle !== null) {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
    if (this.tooltipTimeout !== null) {
      window.clearTimeout(this.tooltipTimeout);
      this.tooltipTimeout = null;
    }
    this.mountedRows.clear();
    this.rowPool = [];
    this.wcRow = null;
    this.edgeChunks.clear();
    this.pathPool = [];
    this.circlePool = [];
    this.wcRing = null;
    this.wcDot = null;
    this.statsFallback.clear();
    this.hidePopup();
    this.hideCommitTooltip();
  }
}

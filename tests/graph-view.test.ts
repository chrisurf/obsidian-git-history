import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceLeaf, Notice, iconStats } from "obsidian";
import { GraphView } from "../src/views/graph-view";
import { RepoStore } from "../src/store/repo-store";
import type { GitService } from "../src/git/git-service";
import type { CommitInfo, FileStatus } from "../src/types";
import { flushFrames, pendingFrames } from "./setup";

const ROW_HEIGHT = 32;
const OVERSCAN = 15;
const VIEWPORT_HEIGHT = 640;
const COMMIT_COUNT = 400;

function makeCommits(count: number): CommitInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    hash: `hash${String(i).padStart(4, "0")}`,
    shortHash: `h${i}`,
    parents: i < count - 1 ? [`hash${String(i + 1).padStart(4, "0")}`] : [],
    message: `commit message ${i}`,
    body: "",
    author: `Author ${i % 3}`,
    authorEmail: "a@example.com",
    date: new Date(2026, 0, 1),
    refs: i === 0 ? [{ name: "main", type: "head" as const, current: true }] : [],
    stats: { filesChanged: i % 5, additions: i, deletions: i % 7 },
  }));
}

/** Records which per-commit lookups happen, so the N+1 regression stays caught. */
const gitCalls = {
  showCommitFiles: [] as string[],
  log: [] as ({ file?: string; all?: boolean } | undefined)[],
};

function makeGit(commits: CommitInfo[], status: FileStatus[]): GitService {
  return {
    log: async (opts?: { file?: string; all?: boolean }) => {
      gitCalls.log.push(opts);
      return opts?.file ? commits.slice(0, 3) : commits;
    },
    status: async () => status,
    currentBranch: async () => "main",
    getAheadBehind: async () => ({ ahead: 0, behind: 0 }),
    branches: async () => [],
    showCommitFiles: async (hash: string) => {
      gitCalls.showCommitFiles.push(hash);
      return [];
    },
  } as unknown as GitService;
}

interface Harness {
  view: GraphView;
  store: RepoStore;
  scrollEl: HTMLElement;
  tbody: HTMLElement;
  commits: CommitInfo[];
  scrollTo(y: number): void;
}

async function mount(status: FileStatus[] = []): Promise<Harness> {
  const commits = makeCommits(COMMIT_COUNT);
  const git = makeGit(commits, status);
  const store = new RepoStore(git);
  const plugin = {
    store,
    git,
    openSourceControlView: () => {},
    showCommitChangesInSidebar: () => {},
    openDiff: () => {},
  };

  const view = new GraphView(new WorkspaceLeaf(), plugin as never);
  await view.onOpen();

  const scrollEl = view.contentEl.querySelector(".gs-graph-scroll-wrap") as HTMLElement;
  const tbody = view.contentEl.querySelector(".gs-graph-tbody") as HTMLElement;

  let scrollTop = 0;
  Object.defineProperty(scrollEl, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
  Object.defineProperty(scrollEl, "clientHeight", {
    get: () => VIEWPORT_HEIGHT,
    configurable: true,
  });

  flushFrames();

  return {
    view,
    store,
    scrollEl,
    tbody,
    commits,
    scrollTo(y: number) {
      scrollEl.scrollTop = y;
      scrollEl.dispatchEvent(new Event("scroll"));
      flushFrames();
    },
  };
}

interface MountedRow {
  el: HTMLElement;
  top: number;
  message: string;
  selected: boolean;
}

function readRows(tbody: HTMLElement): MountedRow[] {
  return [...tbody.querySelectorAll(".gs-graph-row:not(.gs-row-wc)")].map((el) => {
    const row = el as HTMLElement;
    return {
      el: row,
      top: parseInt(row.style.top || "0", 10),
      message: row.querySelector(".gs-commit-msg")?.textContent ?? "",
      selected: row.classList.contains("gs-row-selected"),
    };
  });
}

function maxMountedRows(): number {
  return Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 2 * OVERSCAN + 2;
}

describe("GraphView row virtualization", () => {
  beforeEach(() => {
    gitCalls.showCommitFiles = [];
    Notice.messages = [];
    iconStats.renders = 0;
  });

  it("mounts only a viewport-sized window of rows", async () => {
    const h = await mount();
    const rows = readRows(h.tbody);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(maxMountedRows());
  });

  it("keeps row positions unique and aligned while scrolling", async () => {
    const h = await mount();

    for (let y = 0; y <= (COMMIT_COUNT - 20) * ROW_HEIGHT; y += 7 * ROW_HEIGHT) {
      h.scrollTo(y);
      const rows = readRows(h.tbody);
      const tops = rows.map((r) => r.top);

      expect(new Set(tops).size, `duplicate row positions at scrollTop=${y}`).toBe(tops.length);
      expect(tops.every((t) => t % ROW_HEIGHT === 0)).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(maxMountedRows());
    }
  });

  it("shows the commit that belongs at each position", async () => {
    const h = await mount();

    for (const y of [0, 1000, 5000, 9000]) {
      h.scrollTo(y);
      for (const row of readRows(h.tbody)) {
        const expected = h.commits[row.top / ROW_HEIGHT];
        expect(row.message, `wrong commit at top=${row.top} after scroll to ${y}`).toBe(
          expected.message,
        );
      }
    }
  });

  it("reuses row elements instead of allocating per scroll", async () => {
    const h = await mount();
    const seen = new Set<HTMLElement>();

    for (let y = 0; y <= 200 * ROW_HEIGHT; y += 5 * ROW_HEIGHT) {
      h.scrollTo(y);
      for (const row of readRows(h.tbody)) seen.add(row.el);
    }

    // With pooling the element count tracks the viewport; without it, it would
    // grow with the scroll distance (200+ rows visited here).
    expect(seen.size).toBeLessThanOrEqual(maxMountedRows());
  });

  it("does not re-render icons for rows that stay put", async () => {
    const h = await mount();
    h.scrollTo(0);

    const before = iconStats.renders;
    h.scrollTo(0);
    h.scrollTo(0);

    expect(iconStats.renders).toBe(before);
  });

  it("coalesces a burst of scroll events into a single frame", async () => {
    const h = await mount();

    for (let i = 0; i < 20; i++) {
      h.scrollEl.scrollTop = i * ROW_HEIGHT;
      h.scrollEl.dispatchEvent(new Event("scroll"));
    }

    expect(pendingFrames()).toBe(1);
    flushFrames();
    expect(pendingFrames()).toBe(0);
  });

  it("does not spawn a git lookup per row when commits carry stats", async () => {
    const h = await mount();
    h.scrollTo(0);
    h.scrollTo(3000);

    expect(gitCalls.showCommitFiles).toEqual([]);
  });

  it("falls back to a single cached lookup for commits without stats", async () => {
    const commits = makeCommits(COMMIT_COUNT);
    delete commits[0].stats;
    const git = makeGit(commits, []);
    const store = new RepoStore(git);
    const view = new GraphView(new WorkspaceLeaf(), {
      store,
      git,
      openSourceControlView: () => {},
      showCommitChangesInSidebar: () => {},
      openDiff: () => {},
    } as never);

    await view.onOpen();
    const scrollEl = view.contentEl.querySelector(".gs-graph-scroll-wrap") as HTMLElement;
    Object.defineProperty(scrollEl, "clientHeight", { get: () => VIEWPORT_HEIGHT });
    flushFrames();
    await Promise.resolve();

    // Re-render repeatedly; the lookup must not repeat.
    for (let i = 0; i < 5; i++) {
      scrollEl.dispatchEvent(new Event("scroll"));
      flushFrames();
      await Promise.resolve();
    }

    expect(gitCalls.showCommitFiles.filter((h) => h === commits[0].hash).length).toBe(1);
  });
});

describe("GraphView working changes row", () => {
  beforeEach(() => {
    gitCalls.showCommitFiles = [];
    iconStats.renders = 0;
  });

  it("does not leave a commit row underneath it when it appears", async () => {
    const h = await mount();
    h.scrollTo(0);

    // Nothing occupies row 0 yet besides the first commit.
    expect(h.tbody.querySelectorAll(".gs-row-wc").length).toBe(0);
    expect(readRows(h.tbody).some((r) => r.top === 0)).toBe(true);

    // Working changes appear — every commit row shifts down by one.
    h.store["_status"] = [
      { path: "note.md", indexStatus: " ", workingStatus: "M", staged: false },
    ] as FileStatus[];
    h.store.trigger("status-changed", h.store.status);
    flushFrames();

    const wcRows = h.tbody.querySelectorAll(".gs-row-wc");
    expect(wcRows.length).toBe(1);

    const commitRows = readRows(h.tbody);
    expect(
      commitRows.some((r) => r.top === 0),
      "a commit row is still mounted under the working changes row",
    ).toBe(false);

    const tops = commitRows.map((r) => r.top);
    expect(new Set(tops).size).toBe(tops.length);
  });

  it("shifts commits by one row while it is shown", async () => {
    const h = await mount([
      { path: "note.md", indexStatus: " ", workingStatus: "M", staged: false },
    ]);
    h.scrollTo(0);

    for (const row of readRows(h.tbody)) {
      const expected = h.commits[row.top / ROW_HEIGHT - 1];
      expect(row.message).toBe(expected.message);
    }
  });

  it("releases the row again when the working tree goes clean", async () => {
    const h = await mount([
      { path: "note.md", indexStatus: " ", workingStatus: "M", staged: false },
    ]);
    h.scrollTo(0);
    expect(h.tbody.querySelectorAll(".gs-row-wc").length).toBe(1);

    h.store["_status"] = [];
    h.store.trigger("status-changed", []);
    flushFrames();

    expect(h.tbody.querySelectorAll(".gs-row-wc").length).toBe(0);
    const rows = readRows(h.tbody);
    expect(rows.some((r) => r.top === 0)).toBe(true);
    expect(rows.find((r) => r.top === 0)?.message).toBe(h.commits[0].message);
  });
});

describe("GraphView filtering", () => {
  beforeEach(() => {
    gitCalls.showCommitFiles = [];
  });

  it("rebinds rows to the filtered commits", async () => {
    const h = await mount();
    const input = h.view.contentEl.querySelector(".gs-search-input") as HTMLInputElement;

    input.value = "commit message 12";
    input.dispatchEvent(new Event("input"));
    flushFrames();

    const rows = readRows(h.tbody);
    const matches = h.commits.filter((c) => c.message.includes("commit message 12"));

    expect(rows.length).toBe(Math.min(matches.length, maxMountedRows()));
    for (const row of rows) {
      expect(row.message).toContain("commit message 12");
    }

    const tops = rows.map((r) => r.top);
    expect(new Set(tops).size).toBe(tops.length);
  });

  it("restores the full list when the filter is cleared", async () => {
    const h = await mount();
    const input = h.view.contentEl.querySelector(".gs-search-input") as HTMLInputElement;

    input.value = "commit message 12";
    input.dispatchEvent(new Event("input"));
    flushFrames();

    input.value = "";
    input.dispatchEvent(new Event("input"));
    flushFrames();

    const rows = readRows(h.tbody);
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      expect(row.message).toBe(h.commits[row.top / ROW_HEIGHT].message);
    }
  });
});

/**
 * File history is the graph narrowed to one path — there is no second view for
 * it, so the filter has to survive every code path that reloads the log.
 */
describe("GraphView — file history filter", () => {
  const chip = (h: Harness): HTMLElement =>
    h.view.contentEl.querySelector(".gs-path-chip") as HTMLElement;
  const lastLog = (): { file?: string; all?: boolean } | undefined =>
    gitCalls.log[gitCalls.log.length - 1];

  beforeEach(() => {
    gitCalls.log = [];
  });

  it("hides the chip while the whole repository is shown", async () => {
    const h = await mount();
    expect(chip(h).style.display).toBe("none");
    expect(lastLog()?.file).toBeUndefined();
  });

  it("asks git for one file's history and names it in the chip", async () => {
    const h = await mount();
    h.view.setPathFilter("notes/Testing.md");
    await Promise.resolve();
    flushFrames();

    expect(lastLog()?.file).toBe("notes/Testing.md");
    expect(chip(h).style.display).not.toBe("none");
    expect(chip(h).textContent).toContain("notes/Testing.md");
  });

  it("keeps the filter when the log is reloaded from the toolbar", async () => {
    const h = await mount();
    h.view.setPathFilter("notes/Testing.md");
    await Promise.resolve();

    const refresh = h.view.contentEl.querySelector(
      'button[aria-label="Refresh"]',
    ) as HTMLElement | null;
    refresh?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();

    expect(lastLog()?.file, "the toolbar dropped the path filter").toBe("notes/Testing.md");
  });

  it("goes back to the full log when the chip is cleared", async () => {
    const h = await mount();
    h.view.setPathFilter("notes/Testing.md");
    await Promise.resolve();
    flushFrames();

    const clear = chip(h).querySelector("button") as HTMLElement;
    clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    flushFrames();

    expect(lastLog()?.file).toBeUndefined();
    expect(chip(h).style.display).toBe("none");
  });
});

/**
 * The expanded commit card is positioned in scroll-content coordinates
 * (row offset + scrollTop). That arithmetic is only correct while the card
 * lives inside the scrolled content — as a sibling of the scroll container it
 * rendered a header's height too high, on top of unrelated rows, and stayed
 * put while the list scrolled underneath.
 */
describe("GraphView — expanded commit card", () => {
  const popup = (h: Harness): HTMLElement =>
    h.view.contentEl.querySelector(".gs-commit-popup") as HTMLElement;

  it("lives inside the scrolled content, next to the rows", async () => {
    const h = await mount();
    const inner = h.view.contentEl.querySelector(".gs-graph-inner") as HTMLElement;

    expect(popup(h).parentElement, "the card is positioned against the wrong box").toBe(inner);
    expect(inner.contains(h.tbody)).toBe(true);
  });

  it("stays hidden until a commit is clicked", async () => {
    const h = await mount();
    expect(popup(h).classList.contains("gs-hidden")).toBe(true);
  });

  it("opens with the commit's details and closes again on a second click", async () => {
    const h = await mount();
    const row = readRows(h.tbody)[0];

    row.el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    flushFrames();

    expect(popup(h).classList.contains("gs-hidden")).toBe(false);
    expect(popup(h).querySelector(".gs-popup-msg")?.textContent).toBe("commit message 0");
    expect(popup(h).querySelector(".gs-popup-actions")).not.toBeNull();

    readRows(h.tbody)[0].el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    flushFrames();
    expect(popup(h).classList.contains("gs-hidden")).toBe(true);
  });
});

/**
 * The card is not an overlay: the rows below it move down by its height and the
 * lane stretches across the gap. Everything positions through one function, so
 * these assertions are what keep rows, dots and edges from drifting apart.
 */
describe("GraphView — expanding a commit pushes the list down", () => {
  const CARD_HEIGHT = 130 + 8; // CARD_ESTIMATED_HEIGHT + CARD_GAP, the fallback without layout
  const card = (h: Harness): HTMLElement =>
    h.view.contentEl.querySelector(".gs-commit-popup") as HTMLElement;

  async function expandFirstRow(h: Harness): Promise<void> {
    readRows(h.tbody)[0].el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
    flushFrames();
  }

  it("moves every row below the expanded one down by the card height", async () => {
    const h = await mount();
    const before = readRows(h.tbody).map((r) => r.top);
    await expandFirstRow(h);
    const after = readRows(h.tbody).map((r) => r.top);

    expect(after[0], "the expanded row itself must not move").toBe(before[0]);
    expect(after[1]).toBe(before[1] + CARD_HEIGHT);
    expect(after[5]).toBe(before[5] + CARD_HEIGHT);
  });

  it("puts the card in the gap it opened, directly under its row", async () => {
    const h = await mount();
    await expandFirstRow(h);
    expect(card(h).style.top).toBe(`${ROW_HEIGHT}px`);
  });

  it("stretches the lane so the dots follow the rows", async () => {
    const h = await mount();
    const cy = (): number[] =>
      [...h.view.contentEl.querySelectorAll("circle")]
        .filter((c) => (c as SVGElement).style.display !== "none")
        .map((c) => parseFloat(c.getAttribute("cy") || "0"))
        .sort((a, b) => a - b);

    const before = cy();
    await expandFirstRow(h);
    const after = cy();

    const gap = after[1] - after[0];
    expect(gap, "the dots kept their old spacing across the card").toBeGreaterThan(
      before[1] - before[0],
    );
    expect(gap).toBe(ROW_HEIGHT + CARD_HEIGHT);
  });

  it("grows the scrollable height so the last row stays reachable", async () => {
    const h = await mount();
    const spacer = h.view.contentEl.querySelector(".gs-graph-spacer") as HTMLElement;
    const before = parseInt(spacer.style.height, 10);
    await expandFirstRow(h);

    expect(parseInt(spacer.style.height, 10)).toBe(before + CARD_HEIGHT);
  });

  it("closes back to the original layout", async () => {
    const h = await mount();
    const before = readRows(h.tbody).map((r) => r.top);
    await expandFirstRow(h);
    await expandFirstRow(h);

    expect(readRows(h.tbody).map((r) => r.top)).toEqual(before);
    expect(card(h).classList.contains("gs-hidden")).toBe(true);
  });
});

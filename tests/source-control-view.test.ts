import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceLeaf, Notice } from "obsidian";
import { SourceControlView } from "../src/views/source-control-view";
import { RepoStore } from "../src/store/repo-store";
import type { GitService } from "../src/git/git-service";
import type { FileStatus } from "../src/types";
import { flushFrames } from "./setup";

/**
 * Mirrors the vault state from the bug report: three modified files, two
 * untracked theme files, and two folders that are Git repositories of their
 * own — the vault's plugin checkout and a stray `git init`.
 */
function screenshotStatus(): FileStatus[] {
  return [
    { path: ".obsidian/appearance.json", indexStatus: ".", workingStatus: "M", staged: false },
    {
      path: ".obsidian/community-plugins.json",
      indexStatus: ".",
      workingStatus: "M",
      staged: false,
    },
    { path: ".obsidian/workspace.json", indexStatus: ".", workingStatus: "M", staged: false },
    {
      path: ".obsidian/themes/GitHub Theme/manifest.json",
      indexStatus: " ",
      workingStatus: "?",
      staged: false,
    },
    {
      path: ".obsidian/themes/GitHub Theme/theme.css",
      indexStatus: " ",
      workingStatus: "?",
      staged: false,
    },
    {
      path: ".obsidian/plugins/obsidian-git-history",
      indexStatus: " ",
      workingStatus: "?",
      staged: false,
      embeddedRepo: true,
    },
    {
      path: "verification",
      indexStatus: " ",
      workingStatus: "?",
      staged: false,
      embeddedRepo: true,
    },
  ] as FileStatus[];
}

interface Calls {
  release: Record<string, () => void>;
  stageAll: number;
  unstageAll: number;
  discardAll: number;
  stage: string[][];
  showCommitFiles: number;
}

async function mount(status: FileStatus[]) {
  const calls: Calls = {
    release: {},
    stageAll: 0,
    unstageAll: 0,
    discardAll: 0,
    stage: [],
    showCommitFiles: 0,
  };
  let current = status;

  const git = {
    log: async () => [],
    status: async () => current,
    currentBranch: async () => "main",
    getAheadBehind: async () => ({ ahead: 0, behind: 0 }),
    branches: async () => [],
    showCommitFiles: async () => {
      calls.showCommitFiles++;
      return [];
    },
    remotes: async () => [],
    stashList: async () => [],
    stageAll: async () => {
      calls.stageAll++;
      current = current.map((f) =>
        f.embeddedRepo ? f : ({ ...f, staged: true, indexStatus: "M" } as FileStatus),
      );
      return { skipped: current.filter((f) => f.embeddedRepo).map((f) => f.path) };
    },
    unstageAll: async () => {
      calls.unstageAll++;
    },
    discardAll: async () => {
      calls.discardAll++;
    },
    stage: async (paths: string[]) => {
      calls.stage.push(paths);
    },
    // Toolbar commands: each one hands back a promise the test releases, so the
    // bar can be observed while the command is still running.
    fetch: () => new Promise<void>((r) => (calls.release.fetch = r)),
    pull: () => new Promise<void>((r) => (calls.release.pull = r)),
    push: () => new Promise<void>((r) => (calls.release.push = r)),
    stashSave: () => new Promise<void>((r) => (calls.release.stash = r)),
  } as unknown as GitService;

  const store = new RepoStore(git);
  const view = new SourceControlView(new WorkspaceLeaf(), {
    store,
    git,
    settings: { debounceMs: 0 },
    openDiff: () => {},
    openGraphView: () => {},
  } as never);

  await view.onOpen();
  flushFrames();
  return { view, store, git, calls };
}

function findButton(root: HTMLElement, label: string): HTMLElement | null {
  return root.querySelector(`button[aria-label="${label}"]`);
}

describe("SourceControlView — Stage All", () => {
  beforeEach(() => {
    Notice.messages = [];
  });

  it("renders the Changes section with the file count from the status", async () => {
    const { view } = await mount(screenshotStatus());
    const count = view.contentEl.querySelector(".gs-count-changed")?.textContent;
    // Five stageable entries — the two nested repositories are not counted.
    expect(count).toBe("5");
  });

  it("exposes a Stage All button in the Changes section", async () => {
    const { view } = await mount(screenshotStatus());
    expect(findButton(view.contentEl, "Stage All")).not.toBeNull();
  });

  it("stages everything when Stage All is clicked", async () => {
    const { view, calls } = await mount(screenshotStatus());

    const button = findButton(view.contentEl, "Stage All");
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();

    expect(calls.stageAll, "git.stageAll() was never reached").toBe(1);
  });

  it("stages when the click lands on the icon inside the button", async () => {
    const { view, calls } = await mount(screenshotStatus());

    // Users click the svg, not the button box.
    const icon = findButton(view.contentEl, "Stage All")?.querySelector("svg");
    icon?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();

    expect(calls.stageAll).toBe(1);
  });

  it("does not collapse the section when Stage All is clicked", async () => {
    const { view } = await mount(screenshotStatus());
    const tree = view.contentEl.querySelector(".gs-sc-tree") as HTMLElement;
    expect(tree.style.display).not.toBe("none");

    findButton(view.contentEl, "Stage All")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();

    const treeAfter = view.contentEl.querySelector(".gs-sc-tree") as HTMLElement;
    expect(treeAfter?.style.display).not.toBe("none");
  });

  it("surfaces a Notice when staging fails instead of failing silently", async () => {
    const { view, git } = await mount(screenshotStatus());
    (git as unknown as { stageAll: () => Promise<void> }).stageAll = async () => {
      throw new Error("fatal: Unable to create index.lock: File exists.");
    };

    findButton(view.contentEl, "Stage All")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(Notice.messages.join("\n")).toContain("index.lock");
  });
});

describe("SourceControlView — sidebar graph", () => {
  const commits = Array.from({ length: 120 }, (_, i) => ({
    hash: `hash${i}`,
    shortHash: `h${i}`,
    parents: i < 119 ? [`hash${i + 1}`] : [],
    message: `commit ${i}`,
    body: "",
    author: "Chris Oguntolu",
    authorEmail: "c@example.com",
    date: new Date(2026, 0, 1),
    refs: [],
    stats: { filesChanged: 3, additions: 10, deletions: 2 },
  }));

  async function mountGraphTab(status: FileStatus[]) {
    const h = await mount(status);
    (h.git as unknown as { log: () => Promise<unknown> }).log = async () => commits;
    (h.view as unknown as { switchTab: (t: string) => void }).switchTab("graph");
    await h.store.refreshLog({ all: true, maxCount: 500 });
    flushFrames();
    return h;
  }

  it("renders the commit list without a git lookup per row", async () => {
    const h = await mountGraphTab([]);

    const rows = h.view.contentEl.querySelectorAll(".gs-sg-row:not(.gs-sg-row-wc)");
    expect(rows.length).toBe(commits.length);
    expect(h.calls.showCommitFiles, "one git process per row is the N+1 regression").toBe(0);
  });

  it("shows the changes bar from the batched stats", async () => {
    const h = await mountGraphTab([]);
    const bars = h.view.contentEl.querySelectorAll(".gs-sg-changes-bar-wrap");
    expect(bars.length).toBe(commits.length);
  });

  it("only touches the working changes row when the status changes", async () => {
    const h = await mountGraphTab(screenshotStatus());

    const rowsBefore = [...h.view.contentEl.querySelectorAll(".gs-sg-row:not(.gs-sg-row-wc)")];
    expect(h.view.contentEl.querySelectorAll(".gs-sg-row-wc").length).toBe(1);

    h.store["_status"] = screenshotStatus().slice(0, 2);
    h.store.trigger("status-changed", h.store.status);
    flushFrames();

    const rowsAfter = [...h.view.contentEl.querySelectorAll(".gs-sg-row:not(.gs-sg-row-wc)")];
    expect(rowsAfter.length).toBe(rowsBefore.length);
    // Same element objects — the commit list was not rebuilt.
    expect(rowsAfter.every((row, i) => row === rowsBefore[i])).toBe(true);
    expect(h.view.contentEl.querySelector(".gs-sg-row-wc .gs-sg-meta")?.textContent).toContain(
      "2 files",
    );
  });

  it("keeps the working changes row first and removes it when clean", async () => {
    const h = await mountGraphTab(screenshotStatus());
    const list = h.view.contentEl.querySelector(".gs-sg-list, .gs-sg-rows") as HTMLElement | null;
    const wc = h.view.contentEl.querySelector(".gs-sg-row-wc");
    expect(wc).not.toBeNull();
    if (list) expect(list.firstElementChild).toBe(wc);

    h.store["_status"] = [];
    h.store.trigger("status-changed", []);
    flushFrames();

    expect(h.view.contentEl.querySelector(".gs-sg-row-wc")).toBeNull();
  });
});

describe("SourceControlView — loading state", () => {
  it("does not leave the view flagged as loading once a refresh settles", async () => {
    const { view } = await mount(screenshotStatus());
    expect(view.contentEl.classList.contains("gs-loading")).toBe(false);
  });

  it("keeps the panel interactive while a refresh is in flight", async () => {
    const { view, store, calls } = await mount(screenshotStatus());

    // Simulate a background refresh starting (file watcher, window focus, …).
    store.trigger("loading", true);
    expect(view.contentEl.classList.contains("gs-loading")).toBe(true);

    findButton(view.contentEl, "Stage All")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.stageAll, "buttons must stay usable during a background refresh").toBe(1);
  });
});

describe("SourceControlView — nested repositories", () => {
  beforeEach(() => {
    Notice.messages = [];
  });

  /** Folders render collapsed, so the rows only exist after Expand All. */
  const filenames = (view: { contentEl: HTMLElement }): string[] => {
    findButton(view.contentEl, "Expand All")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    flushFrames();
    return Array.from(view.contentEl.querySelectorAll(".gs-tree-filename")).map(
      (el) => el.textContent ?? "",
    );
  };

  it("keeps nested repositories out of the changes list", async () => {
    const { view } = await mount(screenshotStatus());
    const names = filenames(view);
    expect(names).not.toContain("verification");
    expect(names).not.toContain("obsidian-git-history");
    expect(names).toContain("theme.css");
  });

  it("lists them again once the setting is turned on", async () => {
    const { view, store } = await mount(screenshotStatus());

    store.showNestedRepos = true;
    flushFrames();

    expect(filenames(view)).toContain("verification");
  });

  it("offers no stage button for a nested repository", async () => {
    const { view, store } = await mount(screenshotStatus());
    store.showNestedRepos = true;
    filenames(view);

    const row = Array.from(view.contentEl.querySelectorAll(".gs-tree-file")).find(
      (el) => el.querySelector(".gs-tree-filename")?.textContent === "verification",
    );
    expect(row, "the nested repository row is missing").toBeDefined();
    expect(row?.querySelector('button[aria-label="Stage Changes"]')).toBeNull();
  });

  it("stages the rest of the vault without mentioning what it skipped", async () => {
    const { view, calls } = await mount(screenshotStatus());

    findButton(view.contentEl, "Stage All")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await new Promise((r) => setTimeout(r, 0));
    flushFrames();

    expect(calls.stageAll).toBe(1);
    expect(Notice.messages).toEqual([]);
  });
});

describe("SourceControlView — icons", () => {
  const iconOf = (root: HTMLElement, label: string): string | undefined =>
    findButton(root, label)
      ?.querySelector("svg")
      ?.getAttribute("class")
      ?.replace("svg-icon lucide-", "");

  it("uses one discard icon for all three discard actions", async () => {
    const { view } = await mount(screenshotStatus());
    // Expand the tree so the folder-level action exists too.
    findButton(view.contentEl, "Expand All")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    flushFrames();

    const icons = ["Discard All", "Discard All in Folder", "Discard Changes"].map((label) => [
      label,
      iconOf(view.contentEl, label),
    ]);
    for (const [label, icon] of icons) {
      expect(icon, `${label} has no icon`).toBeDefined();
    }
    expect(
      new Set(icons.map(([, icon]) => icon)).size,
      `mismatched icons: ${JSON.stringify(icons)}`,
    ).toBe(1);
  });
});

/**
 * The progress bar exists because push/pull/fetch take long enough to look
 * broken without it. What matters is that it disappears again — in every case.
 */
describe("SourceControlView — progress bar", () => {
  const bar = (view: { contentEl: HTMLElement }): HTMLElement =>
    view.contentEl.querySelector(".gs-progress") as HTMLElement;
  const active = (view: { contentEl: HTMLElement }): boolean =>
    bar(view).classList.contains("gs-progress-active");
  /** Longer than the minimum-visible delay, read from the view so it stays in sync. */
  const settle = (): Promise<void> =>
    new Promise((r) => setTimeout(r, SourceControlView.PROGRESS_MIN_MS + 50));

  it("sits between the header and the tabs", async () => {
    const { view } = await mount(screenshotStatus());
    const children = Array.from(view.contentEl.children);
    const header = children.findIndex((el) => el.classList.contains("gs-sc-header"));
    const progress = children.findIndex((el) => el.classList.contains("gs-progress"));
    const tabs = children.findIndex((el) => el.classList.contains("gs-sc-tabbar"));

    expect(header).toBeGreaterThanOrEqual(0);
    expect(progress).toBe(header + 1);
    expect(tabs).toBe(progress + 1);
  });

  it("stays idle until a command runs", async () => {
    const { view } = await mount(screenshotStatus());
    expect(active(view)).toBe(false);
  });

  it("runs while a command is in flight and names it", async () => {
    const { view, store } = await mount(screenshotStatus());
    let release!: () => void;
    const task = store.runTask("Pushing", () => new Promise<void>((r) => (release = r)));
    await Promise.resolve();

    expect(active(view)).toBe(true);
    expect(bar(view).getAttribute("aria-label")).toBe("Pushing");
    expect(bar(view).getAttribute("aria-busy")).toBe("true");

    release();
    await task;
    await settle();
    expect(active(view)).toBe(false);
  });

  it("clears when the command fails", async () => {
    const { view, store } = await mount(screenshotStatus());
    await expect(
      store.runTask("Pushing", async () => {
        throw new Error("no upstream");
      }),
    ).rejects.toThrow("no upstream");
    await settle();

    expect(active(view), "a failed push left the bar running forever").toBe(false);
  });

  it("keeps running until the last of two overlapping commands finishes", async () => {
    const { view, store } = await mount(screenshotStatus());
    let releaseSlow!: () => void;
    const slow = store.runTask("Pushing", () => new Promise<void>((r) => (releaseSlow = r)));
    const quick = store.runTask("Fetching", async () => {});
    await quick;
    await settle();

    // The auto-fetch finished; the push has not.
    expect(active(view), "one command ending declared the view idle").toBe(true);

    releaseSlow();
    await slow;
    await settle();
    expect(active(view)).toBe(false);
  });

  it("ignores the status refreshes the file watcher triggers", async () => {
    const { view, store } = await mount(screenshotStatus());
    await store.refresh();
    flushFrames();

    expect(active(view), "the bar blinks on every vault edit").toBe(false);
  });
});

/**
 * The bar is only worth anything if the toolbar buttons actually reach it.
 * These click the real buttons instead of calling store.runTask() directly —
 * the wiring in between is what the user sees.
 */
describe("SourceControlView — toolbar buttons drive the progress bar", () => {
  const active = (view: { contentEl: HTMLElement }): boolean =>
    (view.contentEl.querySelector(".gs-progress") as HTMLElement).classList.contains(
      "gs-progress-active",
    );

  for (const [label, key] of [
    ["Fetch", "fetch"],
    ["Pull", "pull"],
    ["Push", "push"],
    ["Stash", "stash"],
  ] as const) {
    it(`shows the bar while ${label} is running`, async () => {
      const { view, calls } = await mount(screenshotStatus());
      expect(active(view)).toBe(false);

      findButton(view.contentEl, label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();

      expect(active(view), `clicking ${label} never reached the progress bar`).toBe(true);

      // The bar sits just above the active tab's accent underline, so the
      // label is what makes it readable as progress rather than decoration.
      const busyLabel = view.contentEl.querySelector(".gs-sc-busy-label") as HTMLElement;
      expect(busyLabel.style.display, `${label} showed no running command`).not.toBe("none");
      expect(busyLabel.textContent).toMatch(/…$/);

      calls.release[key]?.();
      await new Promise((r) => setTimeout(r, SourceControlView.PROGRESS_MIN_MS + 50));
      expect(active(view), `the bar kept running after ${label} finished`).toBe(false);
      expect((view.contentEl.querySelector(".gs-sc-busy-label") as HTMLElement).style.display).toBe(
        "none",
      );
    });
  }
});

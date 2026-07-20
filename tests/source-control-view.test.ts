import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceLeaf, Notice } from "obsidian";
import { SourceControlView } from "../src/views/source-control-view";
import { RepoStore } from "../src/store/repo-store";
import type { GitService } from "../src/git/git-service";
import type { FileStatus } from "../src/types";
import { flushFrames } from "./setup";

/** Mirrors the vault state from the bug report: three modified files, three untracked. */
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
    { path: ".obsidian/plugins", indexStatus: " ", workingStatus: "?", staged: false },
    { path: ".obsidian/themes", indexStatus: " ", workingStatus: "?", staged: false },
    { path: "verification", indexStatus: " ", workingStatus: "?", staged: false },
  ] as FileStatus[];
}

interface Calls {
  stageAll: number;
  unstageAll: number;
  discardAll: number;
  stage: string[][];
}

async function mount(status: FileStatus[]) {
  const calls: Calls = { stageAll: 0, unstageAll: 0, discardAll: 0, stage: [] };
  let current = status;

  const git = {
    log: async () => [],
    status: async () => current,
    currentBranch: async () => "main",
    getAheadBehind: async () => ({ ahead: 0, behind: 0 }),
    branches: async () => [],
    showCommitFiles: async () => [],
    remotes: async () => [],
    stashList: async () => [],
    stageAll: async () => {
      calls.stageAll++;
      current = current.map((f) => ({ ...f, staged: true, indexStatus: "M" }) as FileStatus);
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
  } as unknown as GitService;

  const store = new RepoStore(git);
  const view = new SourceControlView(new WorkspaceLeaf(), {
    store,
    git,
    settings: { debounceMs: 0 },
    openDiff: () => {},
    openFileHistory: () => {},
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
    expect(count).toBe("6");
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

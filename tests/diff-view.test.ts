import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceLeaf, Notice, vaultFiles, openedFiles } from "obsidian";
import { DiffView } from "../src/views/diff-view";
import { GitService } from "../src/git/git-service";
import { flushFrames } from "./setup";

/**
 * The diff answers "what changed"; reading the note is where that usually
 * leads. Until the toolbar had a button for it, the only way there was back
 * through the panel the diff was opened from.
 */

async function mount(settingsOverride: Record<string, unknown> = {}) {
  const git = {
    diff: async () => "",
    diffCommitAgainstParent: async () => "",
    diffUntracked: async () => "",
    parseDiff: async () => [],
    getRepoRoot: async () => "/vault",
  } as unknown as GitService;

  const plugin = {
    git,
    settings: { diffViewMode: "side-by-side", ...settingsOverride },
  };
  const view = new DiffView(new WorkspaceLeaf(), plugin as never);
  await view.onOpen();
  return { view };
}

const openBtn = (view: { contentEl: HTMLElement }): HTMLElement | null =>
  view.contentEl.querySelector(".git-diff-open-btn");

const breadcrumb = (view: { contentEl: HTMLElement }): string =>
  view.contentEl.querySelector(".git-diff-breadcrumb")?.textContent ?? "";

/** Lets the promise chain behind a reload settle before asserting on the DOM. */
const flushAsync = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("DiffView — Open current file", () => {
  beforeEach(() => {
    vaultFiles.clear();
    openedFiles.length = 0;
    Notice.messages = [];
  });

  it("offers the button in the toolbar", async () => {
    vaultFiles.add("Projects/note.md");
    const { view } = await mount();
    view.setFile("Projects/note.md");
    await flushAsync();

    expect(openBtn(view)).not.toBeNull();
    expect(openBtn(view)?.textContent).toContain("Open current file");
  });

  it("opens the vault's copy of the file being diffed", async () => {
    vaultFiles.add("Projects/note.md");
    const { view } = await mount();
    view.setFile("Projects/note.md");
    await flushAsync();

    openBtn(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushAsync();

    expect(openedFiles).toEqual(["Projects/note.md"]);
  });

  it("opens the file as it is now, not the revision the diff is showing", async () => {
    // The button is offered for a commit's diff too, where the point is to
    // compare what that commit did against what the note says today.
    vaultFiles.add("Projects/note.md");
    const { view } = await mount();
    view.setFile("Projects/note.md", "57ed234");
    await flushAsync();

    openBtn(view)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushAsync();

    expect(openedFiles).toEqual(["Projects/note.md"]);
  });

  it("is not offered for a file the vault no longer holds", async () => {
    // It used to be shown for every diff and answered a click with "does not
    // exist in this vault", which reads as a fault rather than as the plain
    // fact that a deleted file has no current version.
    const { view } = await mount();
    view.setFile("Projects/deleted.md");
    await flushAsync();

    expect(openBtn(view)?.classList.contains("gs-hidden")).toBe(true);
    expect(Notice.messages).toEqual([]);
  });

  it("is not offered for a config file the vault does not index", async () => {
    const { view } = await mount();
    view.setFile(".obsidian/workspace.json");
    await flushAsync();

    expect(openBtn(view)?.classList.contains("gs-hidden")).toBe(true);
  });

  it("hides the button while no file is selected", async () => {
    const { view } = await mount();
    expect(openBtn(view)?.classList.contains("gs-hidden")).toBe(true);
  });

  it("shows it again once a file arrives", async () => {
    vaultFiles.add("Projects/note.md");
    const { view } = await mount();
    view.setFile("Projects/note.md");
    await flushAsync();

    expect(openBtn(view)?.classList.contains("gs-hidden")).toBe(false);
  });
});

describe("DiffView — the breadcrumb", () => {
  it("names the file the view was opened for", async () => {
    // The toolbar is built in onOpen(), which runs before setFile(). Without a
    // repaint it kept saying "No file selected" over a diff on screen.
    const { view } = await mount();
    view.setFile("Projects/cloudcourse/Datanormalizer.md");
    await flushAsync();

    expect(breadcrumb(view)).toContain("Datanormalizer.md");
    expect(breadcrumb(view)).not.toContain("No file selected");
  });

  it("splits the path into its folders", async () => {
    const { view } = await mount();
    view.setFile("Projects/cloudcourse/Datanormalizer.md");
    await flushAsync();

    const dirs = Array.from(view.contentEl.querySelectorAll(".git-diff-breadcrumb-dir")).map(
      (el) => el.textContent,
    );
    expect(dirs).toEqual(["Projects", "cloudcourse"]);
    expect(view.contentEl.querySelector(".git-diff-breadcrumb-file")?.textContent).toBe(
      "Datanormalizer.md",
    );
  });

  it("says what it says with nothing to show", async () => {
    const { view } = await mount();
    expect(breadcrumb(view)).toBe("No file selected");
  });

  it("follows the view to another file", async () => {
    const { view } = await mount();
    view.setFile("a/first.md");
    await flushAsync();
    view.setFile("b/second.md");
    await flushAsync();

    expect(breadcrumb(view)).toContain("second.md");
    expect(breadcrumb(view)).not.toContain("first.md");
  });
});

/**
 * A rename that is not committed yet has two paths, and the diff has to be
 * asked with both: with the new one alone, git reports the whole note as added.
 */
describe("DiffView — an uncommitted rename", () => {
  it("asks git for the diff with the path the file came from", async () => {
    const asked: string[][] = [];
    const git = {
      diff: async (paths: string[]) => {
        asked.push(paths);
        return "";
      },
      diffUntracked: async () => "",
      parseDiff: async () => [],
      getRepoRoot: async () => "/vault",
    } as unknown as GitService;
    const view = new DiffView(new WorkspaceLeaf(), {
      git,
      settings: { diffViewMode: "side-by-side" },
    } as never);
    await view.onOpen();

    view.setFile("moved-to.md", undefined, true, false, "moved.md");
    await flushAsync();

    expect(asked).toEqual([["moved-to.md", "moved.md"]]);
  });

  it("says so when only the name changed", async () => {
    const git = {
      diff: async () => "diff --git a/moved.md b/moved-to.md\nsimilarity index 100%\n",
      diffUntracked: async () => "",
      parseDiff: async () => [
        {
          path: "moved-to.md",
          oldPath: "moved.md",
          binary: false,
          hunks: [],
          additions: 0,
          deletions: 0,
          change: "modified",
        },
      ],
      getRepoRoot: async () => "/vault",
    } as unknown as GitService;
    const view = new DiffView(new WorkspaceLeaf(), {
      git,
      settings: { diffViewMode: "side-by-side" },
    } as never);
    await view.onOpen();

    view.setFile("moved-to.md", undefined, true, false, "moved.md");
    await flushAsync();

    expect(view.contentEl.querySelector(".git-diff-empty")?.textContent).toBe(
      "Renamed from moved.md, content unchanged",
    );
  });
});

/**
 * The words that changed inside a changed line are marked on top of the line
 * colour, in both layouts. The diff is parsed by the real parser, so the lines
 * reach the view the way they do in the plugin.
 */
describe("DiffView — words that changed", () => {
  const RAW = [
    "diff --git a/REPORT.md b/REPORT.md",
    "--- a/REPORT.md",
    "+++ b/REPORT.md",
    "@@ -1,3 +1,3 @@",
    "-Das Plugin ist technisch hervorragend, aber **überladen**: Es unterstützt CouchDB.",
    "+Das Plugin ist technisch hervorragend, aber **überfrachtet**: Es unterstützt CouchDB.",
    "-Einkaufsliste für morgen",
    "+function render() { return 1; }",
    " Ende",
    "",
  ].join("\n");

  async function mountDiff(mode: "side-by-side" | "inline") {
    const parser = new GitService("/vault");
    const git = {
      diff: async () => RAW,
      diffUntracked: async () => "",
      parseDiff: (raw: string) => parser.parseDiff(raw),
      getRepoRoot: async () => "/vault",
    } as unknown as GitService;
    const view = new DiffView(new WorkspaceLeaf(), {
      git,
      settings: { diffViewMode: mode },
    } as never);
    await view.onOpen();
    view.setFile("REPORT.md");
    await flushAsync();
    flushFrames();
    return view;
  }

  const marks = (view: { contentEl: HTMLElement }, cls: string): string[] =>
    Array.from(view.contentEl.querySelectorAll(`.${cls}`)).map((el) => el.textContent ?? "");

  for (const mode of ["side-by-side", "inline"] as const) {
    it(`marks the changed word, umlaut and all, in the ${mode} layout`, async () => {
      const view = await mountDiff(mode);

      expect(marks(view, "git-diff-char-del")).toEqual(["überladen"]);
      expect(marks(view, "git-diff-char-add")).toEqual(["überfrachtet"]);
    });

    it(`keeps the line's text whole around the marks in the ${mode} layout`, async () => {
      const view = await mountDiff(mode);
      const texts = Array.from(view.contentEl.querySelectorAll(".git-diff-content")).map(
        (el) => el.textContent,
      );

      expect(texts).toContain(
        "Das Plugin ist technisch hervorragend, aber **überfrachtet**: Es unterstützt CouchDB.",
      );
      expect(texts).toContain("function render() { return 1; }");
    });
  }
});

/**
 * A note created in Obsidian is empty until something is typed into it. git
 * reports it as a new file with no lines, and the view drew two blank panes
 * marked +0 -0 for it — which read as "no changes" for a file the panel had
 * just listed as untracked.
 */
describe("DiffView — a diff without lines", () => {
  async function mountRaw(raw: string, untracked: boolean) {
    const parser = new GitService("/vault");
    const git = {
      diff: async () => (untracked ? "" : raw),
      diffUntracked: async () => (untracked ? raw : ""),
      parseDiff: (r: string) => parser.parseDiff(r),
      getRepoRoot: async () => "/vault",
    } as unknown as GitService;
    const view = new DiffView(new WorkspaceLeaf(), {
      git,
      settings: { diffViewMode: "side-by-side" },
    } as never);
    await view.onOpen();
    view.setFile("Untitled 5.md", undefined, false, untracked);
    await flushAsync();
    return view;
  }

  const message = (view: { contentEl: HTMLElement }): string | undefined =>
    view.contentEl.querySelector(".git-diff-empty")?.textContent ?? undefined;

  it("says an empty untracked note is new instead of drawing blank panes", async () => {
    const view = await mountRaw(
      "diff --git a/Untitled 5.md b/Untitled 5.md\nnew file mode 100644\nindex 0000000..e69de29\n",
      true,
    );
    expect(message(view)).toBe("New empty file");
    expect(view.contentEl.querySelector(".git-diff-sbs")).toBeNull();
  });

  it("says an empty note was deleted", async () => {
    const view = await mountRaw(
      "diff --git a/Untitled 5.md b/Untitled 5.md\ndeleted file mode 100644\nindex e69de29..0000000\n",
      false,
    );
    expect(message(view)).toBe("Empty file deleted");
  });

  it("names a mode change", async () => {
    const view = await mountRaw(
      "diff --git a/Untitled 5.md b/Untitled 5.md\nold mode 100644\nnew mode 100755\n",
      false,
    );
    expect(message(view)).toBe("File mode changed from 100644 to 100755");
  });
});

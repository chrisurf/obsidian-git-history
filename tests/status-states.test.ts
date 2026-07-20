// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "../src/git/git-service";
import { RepoStore } from "../src/store/repo-store";
import type { FileStatus } from "../src/types";

/**
 * End-to-end coverage for the status pipeline: a real repository is driven into
 * every state `git status --porcelain=v2` can report, and the assertions run
 * against the parser and the store buckets the sidebar renders from.
 *
 * The states are the whole point. A file has two independent halves — what the
 * index would commit and what the worktree still holds — and every bug in this
 * area so far came from collapsing them into one.
 */

let repo: string;
let git: GitService;
let store: RepoStore;

const run = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const file = (path: string): FileStatus => {
  const found = store.rawStatus.find((f) => f.path === path);
  if (!found) throw new Error(`no status entry for "${path}" in ${paths(store.rawStatus)}`);
  return found;
};

const paths = (files: FileStatus[]): string => JSON.stringify(files.map((f) => f.path));
const has = (files: FileStatus[], path: string): boolean => files.some((f) => f.path === path);
/** The two-letter code the sidebar decides everything from. */
const xy = (path: string): string => `${file(path).indexStatus}${file(path).workingStatus}`;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "git-history-states-"));
  run("init", "-q", "-b", "main", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test User");

  for (const name of [
    "staged-mod",
    "staged-mod2",
    "worktree-mod",
    "staged-del",
    "renamed",
    "typechange",
  ]) {
    writeFileSync(join(repo, name), `${name}\n`);
  }
  run("add", "-A");
  run("commit", "-qm", "root");

  // M. — staged, worktree clean
  writeFileSync(join(repo, "staged-mod"), "staged\n");
  run("add", "staged-mod");

  // .M — worktree only
  writeFileSync(join(repo, "worktree-mod"), "worktree\n");

  // D. — staged deletion
  run("rm", "-q", "staged-del");

  // R. — staged rename
  run("mv", "renamed", "renamed-to");

  // .T — type change, file replaced by a symlink
  unlinkSync(join(repo, "typechange"));
  symlinkSync("worktree-mod", join(repo, "typechange"));

  // AM — the reported bug: added empty, then edited again
  writeFileSync(join(repo, "added-then-edited"), "");
  run("add", "added-then-edited");
  writeFileSync(join(repo, "added-then-edited"), "New Line\n");

  // AD — added, then deleted from the worktree
  writeFileSync(join(repo, "added-then-deleted"), "gone\n");
  run("add", "added-then-deleted");
  unlinkSync(join(repo, "added-then-deleted"));

  // MM — staged edit plus a second worktree edit
  writeFileSync(join(repo, "staged-mod2"), "one\n");
  run("add", "staged-mod2");
  writeFileSync(join(repo, "staged-mod2"), "two\n");

  // ? — untracked file, untracked folder, and a nested repository
  writeFileSync(join(repo, "untracked.md"), "new\n");
  mkdirSync(join(repo, "untracked dir"), { recursive: true });
  writeFileSync(join(repo, "untracked dir", "with space.md"), "new\n");
  const nested = join(repo, "nested-repo");
  mkdirSync(nested);
  execFileSync("git", ["init", "-q", "."], { cwd: nested });

  git = new GitService(repo);
  store = new RepoStore(git);
  await store.refresh();
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("status parsing covers every porcelain v2 record", () => {
  it("reads the ordinary records with both halves intact", () => {
    expect(xy("staged-mod")).toBe("M.");
    expect(xy("worktree-mod")).toBe(".M");
    expect(xy("staged-del")).toBe("D.");
    expect(xy("added-then-edited")).toBe("AM");
    expect(xy("added-then-deleted")).toBe("AD");
    expect(xy("staged-mod2")).toBe("MM");
  });

  it("reads a type change rather than dropping the entry", () => {
    expect(xy("typechange")).toBe(".T");
  });

  it("reads a rename together with the path it came from", () => {
    expect(xy("renamed-to")).toBe("R.");
    expect(file("renamed-to").originalPath).toBe("renamed");
  });

  it("reads untracked paths, including ones with spaces", () => {
    expect(xy("untracked.md")).toBe(" ?");
    expect(xy("untracked dir/with space.md")).toBe(" ?");
  });

  it("marks a nested repository and nothing else", () => {
    expect(store.nestedRepos.map((f) => f.path)).toEqual(["nested-repo"]);
  });

  it("agrees with git about how many entries there are", () => {
    const lines = run("status", "--porcelain=v2", "-uall").split("\n").filter(Boolean);
    expect(store.rawStatus.length).toBe(lines.length);
  });
});

describe("the sidebar buckets match what git would commit", () => {
  it("lists a file that is staged and edited again in both sections", () => {
    // The bug: only Staged Changes showed it, so the second edit was invisible
    // and silently left out of the commit.
    for (const path of ["added-then-edited", "staged-mod2"]) {
      expect(has(store.stagedFiles, path), `${path} missing from Staged Changes`).toBe(true);
      expect(has(store.changedFiles, path), `${path} missing from Changes`).toBe(true);
    }
  });

  it("keeps a purely staged file out of Changes", () => {
    expect(has(store.stagedFiles, "staged-mod")).toBe(true);
    expect(has(store.changedFiles, "staged-mod")).toBe(false);
  });

  it("keeps a purely local edit out of Staged Changes", () => {
    expect(has(store.changedFiles, "worktree-mod")).toBe(true);
    expect(has(store.stagedFiles, "worktree-mod")).toBe(false);
  });

  it("lists a deletion that only exists in the worktree", () => {
    expect(has(store.changedFiles, "added-then-deleted")).toBe(true);
  });

  it("lists a type change", () => {
    expect(has(store.changedFiles, "typechange")).toBe(true);
  });

  it("puts untracked paths in their own bucket only", () => {
    expect(has(store.untrackedFiles, "untracked.md")).toBe(true);
    expect(has(store.changedFiles, "untracked.md")).toBe(false);
    expect(has(store.stagedFiles, "untracked.md")).toBe(false);
  });

  it("hides nested repositories from every bucket", () => {
    for (const bucket of [store.stagedFiles, store.changedFiles, store.untrackedFiles]) {
      expect(has(bucket, "nested-repo"), `nested-repo leaked into ${paths(bucket)}`).toBe(false);
    }
    store.showNestedRepos = true;
    expect(has(store.untrackedFiles, "nested-repo")).toBe(true);
    store.showNestedRepos = false;
  });

  it("covers every entry git reported with at least one bucket", () => {
    const bucketed = new Set(
      [...store.stagedFiles, ...store.changedFiles, ...store.untrackedFiles].map((f) => f.path),
    );
    const missed = store.rawStatus
      .filter((f) => !f.embeddedRepo && !bucketed.has(f.path))
      .map((f) => f.path);
    expect(missed, "these entries would be invisible in the sidebar").toEqual([]);
  });
});

describe("staging actions handle the awkward states", () => {
  it("stages the worktree half of an already staged file", async () => {
    await git.stage(["added-then-edited"]);
    await store.refresh();

    expect(xy("added-then-edited")).toBe("A.");
    expect(run("show", ":added-then-edited")).toBe("New Line");
  });

  it("unstages a rename together with the path it came from", async () => {
    // `git reset HEAD -- renamed-to` alone leaves the old path staged as a
    // deletion, so the rename comes back as an unrelated delete plus untracked.
    await git.unstage(["renamed-to", "renamed"]);
    await store.refresh();

    expect(store.stagedFiles.some((f) => f.path === "renamed")).toBe(false);
    expect(has(store.untrackedFiles, "renamed-to")).toBe(true);
  });

  it("stages everything but the nested repository", async () => {
    const { skipped } = await git.stageAll();
    await store.refresh();

    expect(skipped).toEqual(["nested-repo"]);
    expect(store.changedFiles, `still unstaged: ${paths(store.changedFiles)}`).toEqual([]);
    expect(store.untrackedFiles.filter((f) => !f.embeddedRepo)).toEqual([]);
  });

  it("commits exactly what the sidebar showed as staged", async () => {
    const staged = store.stagedFiles.map((f) => f.path).sort();
    await git.commit("state sweep");
    await store.refresh();

    const committed = run("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    // The rename shows up under both paths, so compare as sets of touched paths.
    for (const path of staged) {
      expect(committed, `${path} was listed as staged but not committed`).toContain(path);
    }
    expect(store.stagedFiles).toEqual([]);
  });
});

/**
 * Merge conflicts are the fourth record type (`u`) and the one state where a
 * file is neither staged nor safely committable.
 */
describe("merge conflicts", () => {
  let conflicted: string;
  let cGit: GitService;
  let cStore: RepoStore;

  const inRepo = (...args: string[]): string =>
    execFileSync("git", args, { cwd: conflicted, encoding: "utf8" }).trim();

  beforeAll(async () => {
    conflicted = mkdtempSync(join(tmpdir(), "git-history-conflict-"));
    inRepo("init", "-q", "-b", "main", ".");
    inRepo("config", "user.email", "test@example.com");
    inRepo("config", "user.name", "Test User");
    writeFileSync(join(conflicted, "both.md"), "base\n");
    writeFileSync(join(conflicted, "deleted.md"), "base\n");
    inRepo("add", "-A");
    inRepo("commit", "-qm", "root");

    inRepo("checkout", "-q", "-b", "side");
    writeFileSync(join(conflicted, "both.md"), "side\n");
    inRepo("rm", "-q", "deleted.md");
    inRepo("commit", "-qam", "side");

    inRepo("checkout", "-q", "main");
    writeFileSync(join(conflicted, "both.md"), "main\n");
    writeFileSync(join(conflicted, "deleted.md"), "main\n");
    inRepo("commit", "-qam", "main");
    try {
      inRepo("merge", "side");
    } catch {
      // the conflict is the point
    }

    cGit = new GitService(conflicted);
    cStore = new RepoStore(cGit);
    await cStore.refresh();
  });

  afterAll(() => rmSync(conflicted, { recursive: true, force: true }));

  it("reads unmerged entries with their paths", () => {
    expect(cStore.mergeConflicts.map((f) => f.path).sort()).toEqual(["both.md", "deleted.md"]);
  });

  it("reports the repository as merging", () => {
    expect(cStore.merging).toBe(true);
  });

  it("lists a conflict in the conflict section only", () => {
    for (const path of ["both.md", "deleted.md"]) {
      expect(has(cStore.changedFiles, path), `${path} listed twice`).toBe(false);
      expect(has(cStore.stagedFiles, path), `${path} looks staged`).toBe(false);
    }
  });

  it("stages a resolution and clears the conflict", async () => {
    writeFileSync(join(conflicted, "both.md"), "resolved\n");
    await cGit.stage(["both.md"]);
    await cStore.refresh();

    expect(has(cStore.mergeConflicts, "both.md")).toBe(false);
    expect(has(cStore.stagedFiles, "both.md")).toBe(true);
  });
});

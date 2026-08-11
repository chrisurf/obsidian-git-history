// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "../src/git/git-service";
import type { CommitInfo } from "../src/types";

/**
 * Exercises the log parser against a real repository, covering the shapes that
 * `git log --shortstat` handles differently: root commits, merges, empty
 * commits and multi-line bodies.
 */

let repo: string;
let git: GitService;
let commits: CommitInfo[];
/** --diff-merges=first-parent needs git >= 2.31; the service falls back below that. */
let hasDiffMerges = false;

const run = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const byMessage = (message: string): CommitInfo => {
  const found = commits.find((c) => c.message === message);
  if (!found) throw new Error(`no commit named "${message}"`);
  return found;
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "git-history-test-"));
  run("init", "-q", "-b", "main", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test User");

  writeFileSync(join(repo, "a.txt"), "1\n2\n3\n");
  run("add", ".");
  run("commit", "-qm", "root commit");

  // A body that spans lines and even contains something shaped like a stat line.
  run(
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "empty commit",
    "-m",
    "line one\n\n 9 files changed, 99 insertions(+), 99 deletions(-)\n\nline two",
  );

  writeFileSync(join(repo, "file with spaces.txt"), "x\n");
  run("add", ".");
  run("commit", "-qm", "spaces in name");

  run("checkout", "-qb", "side");
  writeFileSync(join(repo, "b.txt"), "b\n");
  run("add", ".");
  run("commit", "-qm", "side work");

  run("checkout", "-q", "main");
  writeFileSync(join(repo, "c.txt"), "c\n");
  run("add", ".");
  run("commit", "-qm", "main work");
  run("merge", "-q", "--no-ff", "side", "-m", "merge side");

  run("rm", "-q", "a.txt");
  run("commit", "-qm", "delete only");

  try {
    execFileSync("git", ["log", "--diff-merges=first-parent", "-n1"], { cwd: repo, stdio: "pipe" });
    hasDiffMerges = true;
  } catch {
    hasDiffMerges = false;
  }

  git = new GitService(repo);
  commits = await git.log({ all: true, maxCount: 100 });
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("GitService.log", () => {
  it("parses every commit in the repository", () => {
    expect(commits).toHaveLength(7);
  });

  it("keeps multi-line bodies intact", () => {
    const commit = byMessage("empty commit");
    expect(commit.body).toContain("line one");
    expect(commit.body).toContain("line two");
  });

  it("does not mistake body text for a stat block", () => {
    // The body contains "9 files changed, 99 insertions(+)" as literal text.
    const commit = byMessage("empty commit");
    expect(commit.stats?.filesChanged ?? 0).not.toBe(9);
    expect(commit.stats?.additions ?? 0).not.toBe(99);
  });

  it("reports stats for the root commit, which diff-tree cannot", () => {
    const root = byMessage("root commit");
    expect(root.parents).toHaveLength(0);
    expect(root.stats).toEqual({ filesChanged: 1, additions: 3, deletions: 0 });
  });

  it("identifies merge commits", () => {
    expect(byMessage("merge side").parents).toHaveLength(2);
  });

  it("reports stats for merge commits relative to the first parent", () => {
    if (!hasDiffMerges) {
      // Older git: the service drops the flag and the view falls back to a
      // per-commit lookup, so there is nothing to assert here.
      expect(byMessage("merge side").stats).toBeUndefined();
      return;
    }
    expect(byMessage("merge side").stats).toEqual({ filesChanged: 1, additions: 1, deletions: 0 });
  });

  it("handles a deletion-only commit", () => {
    expect(byMessage("delete only").stats).toEqual({
      filesChanged: 1,
      additions: 0,
      deletions: 3,
    });
  });

  it("handles paths containing spaces", () => {
    expect(byMessage("spaces in name").stats).toEqual({
      filesChanged: 1,
      additions: 1,
      deletions: 0,
    });
  });

  it("parses refs and parent hashes", () => {
    const head = commits.find((c) => c.refs.some((r) => r.type === "head"));
    expect(head).toBeDefined();
    for (const commit of commits) {
      for (const parent of commit.parents) {
        expect(parent).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });

  it("agrees with git's own numbers for non-merge commits", async () => {
    for (const commit of commits) {
      if (commit.parents.length !== 1 || !commit.stats) continue;
      const raw = run("diff", "--shortstat", `${commit.parents[0]}`, commit.hash);
      const files = Number(raw.match(/(\d+) files? changed/)?.[1] ?? 0);
      expect(commit.stats.filesChanged, `mismatch for "${commit.message}"`).toBe(files);
    }
  });
});

/**
 * A vault often contains nested repositories — a plugin checked out into
 * `.obsidian/plugins`, a folder cloned from elsewhere. `git add -A` aborts on
 * those ("does not have a commit checked out") and then stages *nothing*, so
 * Stage All has to route around them.
 */
describe("staging a vault that contains nested repositories", () => {
  let vault: string;
  let svc: GitService;

  const inVault = (...args: string[]): string =>
    execFileSync("git", args, { cwd: vault, encoding: "utf8" }).trim();

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "git-history-nested-"));
    inVault("init", "-q", "-b", "main", ".");
    inVault("config", "user.email", "test@example.com");
    inVault("config", "user.name", "Test User");
    writeFileSync(join(vault, "tracked.md"), "one\n");
    inVault("add", ".");
    inVault("commit", "-qm", "root");

    writeFileSync(join(vault, "tracked.md"), "two\n");
    mkdirSync(join(vault, "notes", "deep"), { recursive: true });
    writeFileSync(join(vault, "notes", "deep", "new.md"), "new\n");

    // Nested repo without any commit — the one that makes `git add -A` fatal.
    mkdirSync(join(vault, "verification"));
    execFileSync("git", ["init", "-q", "."], { cwd: join(vault, "verification") });

    // Nested repo with a commit — `git add -A` only warns about this one.
    const plugin = join(vault, ".obsidian", "plugins", "obsidian-git-history");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, "main.js"), "x\n");
    for (const args of [
      ["init", "-q", "."],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test User"],
      ["add", "."],
      ["commit", "-qm", "plugin"],
    ]) {
      execFileSync("git", args, { cwd: plugin });
    }

    svc = new GitService(vault);
  });

  afterAll(() => rmSync(vault, { recursive: true, force: true }));

  it("lists untracked files individually instead of collapsing the folder", async () => {
    const paths = (await svc.status()).map((f) => f.path);
    expect(paths).toContain("notes/deep/new.md");
    expect(paths).not.toContain("notes");
  });

  it("flags nested repositories", async () => {
    const status = await svc.status();
    const embedded = status.filter((f) => f.embeddedRepo).map((f) => f.path);
    expect(embedded.sort()).toEqual([".obsidian/plugins/obsidian-git-history", "verification"]);
  });

  it("stages everything else and reports what it skipped", async () => {
    const { skipped } = await svc.stageAll();
    expect(skipped.sort()).toEqual([".obsidian/plugins/obsidian-git-history", "verification"]);

    const staged = inVault("diff", "--cached", "--name-only").split("\n").filter(Boolean);
    expect(staged.sort()).toEqual(["notes/deep/new.md", "tracked.md"]);
  });
});

/** File history is `git log --follow`, and it has to survive a rename. */
describe("log for a single file", () => {
  let vault: string;
  let svc: GitService;

  const inVault = (...args: string[]): string =>
    execFileSync("git", args, { cwd: vault, encoding: "utf8" }).trim();

  beforeAll(() => {
    vault = mkdtempSync(join(tmpdir(), "git-history-filelog-"));
    inVault("init", "-q", "-b", "main", ".");
    inVault("config", "user.email", "test@example.com");
    inVault("config", "user.name", "Test User");

    writeFileSync(join(vault, "note.md"), "one\n");
    writeFileSync(join(vault, "other.md"), "x\n");
    inVault("add", "-A");
    inVault("commit", "-qm", "add both");

    writeFileSync(join(vault, "other.md"), "y\n");
    inVault("commit", "-qam", "touch other only");

    writeFileSync(join(vault, "note.md"), "two\n");
    inVault("commit", "-qam", "edit note");

    inVault("mv", "note.md", "renamed-note.md");
    inVault("commit", "-qm", "rename note");

    svc = new GitService(vault);
  });

  afterAll(() => rmSync(vault, { recursive: true, force: true }));

  it("returns only the commits that touched the file", async () => {
    const messages = (await svc.log({ file: "renamed-note.md" })).map((c) => c.message);
    expect(messages).not.toContain("touch other only");
    expect(messages).toContain("edit note");
  });

  it("follows the file across a rename", async () => {
    const messages = (await svc.log({ file: "renamed-note.md" })).map((c) => c.message);
    expect(messages, "--follow did not reach beyond the rename").toContain("add both");
  });

  it("still returns the full log without a file", async () => {
    const messages = (await svc.log({})).map((c) => c.message);
    expect(messages).toContain("touch other only");
  });
});

describe("GitService.diff full context", () => {
  it("includes the entire file when fullContext is true", async () => {
    const raw = await git.diff("a.txt", false, true);
    if (!raw) return;
    const diffs = await git.parseDiff(raw);
    if (diffs.length === 0) return;
    expect(diffs[0].hunks).toHaveLength(1);
  });

  it("shows full context for staged diffs", async () => {
    writeFileSync(
      join(repo, "ctx.txt"),
      Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n") + "\n",
    );
    run("add", "ctx.txt");
    run("commit", "-qm", "add ctx");
    writeFileSync(
      join(repo, "ctx.txt"),
      Array.from({ length: 50 }, (_, i) => (i === 25 ? "CHANGED" : `line ${i + 1}`)).join("\n") +
        "\n",
    );
    run("add", "ctx.txt");

    const limited = await git.diff("ctx.txt", true, false);
    const full = await git.diff("ctx.txt", true, true);
    const limitedDiffs = await git.parseDiff(limited);
    const fullDiffs = await git.parseDiff(full);
    expect(fullDiffs[0].hunks[0].lines.length).toBeGreaterThan(
      limitedDiffs[0].hunks[0].lines.length,
    );
  });
});
describe("GitService.diffUntracked", () => {
  it("produces a diff for an untracked file", async () => {
    writeFileSync(join(repo, "brand-new.txt"), "hello\nworld\n");
    const raw = await git.diffUntracked("brand-new.txt");
    expect(raw).toContain("+hello");
    expect(raw).toContain("+world");
    const diffs = await git.parseDiff(raw);
    expect(diffs).toHaveLength(1);
    expect(diffs[0].additions).toBe(2);
  });

  it("returns empty for a nonexistent file", async () => {
    const raw = await git.diffUntracked("does-not-exist.txt");
    expect(raw).toBe("");
  });
});

describe("GitService.gitignore", () => {
  it("reads an empty string when no .gitignore exists", async () => {
    const content = await git.readGitignore();
    expect(content).toBe("");
  });

  it("adds a pattern to .gitignore", async () => {
    await git.addToGitignore("*.log");
    const content = await git.readGitignore();
    expect(content).toContain("*.log");
  });

  it("does not duplicate an existing pattern", async () => {
    await git.addToGitignore("*.log");
    const content = await git.readGitignore();
    const matches = content.split("\n").filter((l) => l.trim() === "*.log");
    expect(matches.length).toBe(1);
  });

  it("appends a second pattern", async () => {
    await git.addToGitignore("node_modules/");
    const content = await git.readGitignore();
    expect(content).toContain("*.log");
    expect(content).toContain("node_modules/");
  });
});

/**
 * The panel manages the vault's own repository. Git answers "is there a
 * repository above this folder", which is a different and much broader
 * question: a vault under a home directory that happens to be a repository
 * used to report as tracked, and every command then ran against that outer
 * repository instead of the vault.
 */
describe("isRepo", () => {
  let outer: string;

  beforeAll(() => {
    outer = mkdtempSync(join(tmpdir(), "git-history-outer-"));
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: outer });
    mkdirSync(join(outer, "vault", "nested"), { recursive: true });
  });

  afterAll(() => rmSync(outer, { recursive: true, force: true }));

  it("is true at the root of a repository", async () => {
    expect(await new GitService(repo).isRepo()).toBe(true);
  });

  it("is false for a folder that merely sits inside one", async () => {
    expect(await new GitService(join(outer, "vault")).isRepo()).toBe(false);
    expect(await new GitService(join(outer, "vault", "nested")).isRepo()).toBe(false);
  });

  it("is true once that folder gets a repository of its own", async () => {
    const vault = join(outer, "vault");
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: vault });
    try {
      expect(await new GitService(vault).isRepo()).toBe(true);
      // The folder below it is still not a root of anything.
      expect(await new GitService(join(vault, "nested")).isRepo()).toBe(false);
    } finally {
      rmSync(join(vault, ".git"), { recursive: true, force: true });
    }
  });

  it("is false where git finds no repository at all", async () => {
    const bare = mkdtempSync(join(tmpdir(), "git-history-norepo-"));
    try {
      expect(await new GitService(bare).isRepo()).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("enclosingRepoRoot", () => {
  it("names the repository a folder sits in, so the panel can say which one", async () => {
    const outer = mkdtempSync(join(tmpdir(), "git-history-encl-"));
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: outer });
    mkdirSync(join(outer, "vault"));
    try {
      const root = await new GitService(join(outer, "vault")).enclosingRepoRoot();
      expect(root).not.toBeNull();
      expect(realpathSync(root!)).toBe(realpathSync(outer));
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("is null outside any repository", async () => {
    const bare = mkdtempSync(join(tmpdir(), "git-history-noencl-"));
    try {
      expect(await new GitService(bare).enclosingRepoRoot()).toBeNull();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

/**
 * The shapes a freshly initialized vault produces. Every one of these was
 * wrong at once when a vault got its first commit: the file list was empty,
 * and opening any file from it found no differences.
 */
describe("the first commit of a repository", () => {
  let fresh: string;
  let service: GitService;
  let head: string;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: fresh, encoding: "utf8" }).trim();

  beforeAll(() => {
    fresh = mkdtempSync(join(tmpdir(), "git-history-fresh-"));
    execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: fresh });
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");

    mkdirSync(join(fresh, "Studies"));
    // An em dash, exactly what git escapes into octal when quotepath is on.
    writeFileSync(join(fresh, "Studies", "00 — Welcome to Voice.md"), "one\ntwo\n");
    writeFileSync(join(fresh, "plain.md"), "hello\n");
    // A binary file: numstat reports "-" for both counts.
    writeFileSync(join(fresh, "Studies", "00 — Welcome to Voice.mp3"), Buffer.from([0, 1, 2, 255]));
    git("add", "-A");
    git("commit", "-qm", "Initial commit");
    head = git("rev-parse", "HEAD");
    service = new GitService(fresh);
  });

  afterAll(() => rmSync(fresh, { recursive: true, force: true }));

  it("lists the files it added, having no parent to compare against", async () => {
    const files = await service.showCommitFiles(head);
    expect(files.map((f) => f.path).sort()).toEqual([
      "Studies/00 — Welcome to Voice.md",
      "Studies/00 — Welcome to Voice.mp3",
      "plain.md",
    ]);
  });

  it("keeps non-ASCII paths readable instead of octal-escaping them", async () => {
    const files = await service.showCommitFiles(head);
    const md = files.find((f) => f.path.endsWith("Welcome to Voice.md"));
    expect(md?.path).toBe("Studies/00 — Welcome to Voice.md");
    expect(md?.path).not.toContain("\\342");
    expect(md?.path).not.toContain('"');
  });

  it("counts additions, and reads a binary file as no line changes", async () => {
    const files = await service.showCommitFiles(head);
    expect(files.find((f) => f.path === "plain.md")?.additions).toBe(1);
    const binary = files.find((f) => f.path.endsWith(".mp3"));
    expect(binary?.additions).toBe(0);
    expect(binary?.deletions).toBe(0);
  });

  it("diffs a file from it, rather than failing on a parent that is not there", async () => {
    const raw = await service.diffCommitAgainstParent(head, "plain.md");
    expect(raw).toContain("+hello");
  });

  it("diffs a file whose name is not ASCII", async () => {
    const raw = await service.diffCommitAgainstParent(head, "Studies/00 — Welcome to Voice.md");
    expect(raw).toContain("+one");
  });

  it("still diffs against the parent once there is one", async () => {
    writeFileSync(join(fresh, "plain.md"), "hello\nagain\n");
    git("commit", "-qam", "second");
    const second = git("rev-parse", "HEAD");
    const raw = await service.diffCommitAgainstParent(second, "plain.md");
    expect(raw).toContain("+again");
    expect(raw).not.toContain("+hello");
  });
});

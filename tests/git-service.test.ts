// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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

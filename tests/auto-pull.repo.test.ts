// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "../src/git/git-service";
import { canAutoPull } from "../src/store/auto-pull";

/**
 * One auto-fetch tick against a real remote: a vault and a second clone share
 * a bare repository, the clone pushes, and the vault fetches and decides
 * whether to pull — the way the timer in main.ts does it. Covers the case it
 * acts on and the ones where it must leave the vault exactly as it was.
 */

const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function clone(remote: string, root: string, name: string): string {
  const dir = join(root, name);
  git(root, "clone", "-q", remote, dir);
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test User");
  return dir;
}

function commit(dir: string, file: string, content: string): void {
  writeFileSync(join(dir, file), content);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", `edit ${file}`);
}

/** A vault one commit behind its remote, and the clone that put it there. */
function vaultBehind(): { vault: string; other: string } {
  const root = mkdtempSync(join(tmpdir(), "git-history-autopull-"));
  cleanup.push(root);
  const remote = join(root, "remote.git");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  const vault = clone(remote, root, "vault");
  commit(vault, "note.md", "first\n");
  git(vault, "push", "-q", "-u", "origin", "main");
  const other = clone(remote, root, "other");
  commit(other, "note.md", "first\nfrom elsewhere\n");
  git(other, "push", "-q");
  return { vault, other };
}

/** What the timer does after its fetch: refresh, decide, pull. */
async function tick(vault: string): Promise<boolean> {
  const service = new GitService(vault);
  await service.fetch();
  const [status, ab] = await Promise.all([service.status(), service.getAheadBehind()]);
  const repo = {
    changeCount: status.filter((f) => !f.embeddedRepo).length,
    ahead: ab.ahead,
    behind: ab.behind,
    hasUpstream: ab.hasUpstream,
    merging: status.some((f) => f.indexStatus === "U" || f.workingStatus === "U"),
  };
  if (!canAutoPull(repo)) return false;
  await service.pull({ strategy: "ff-only" });
  return true;
}

describe("an auto-fetch tick with auto-pull on", () => {
  it("fast-forwards a clean vault to the remote", async () => {
    const { vault, other } = vaultBehind();
    expect(await tick(vault)).toBe(true);
    expect(readFileSync(join(vault, "note.md"), "utf8")).toBe("first\nfrom elsewhere\n");
    expect(git(vault, "rev-parse", "HEAD")).toBe(git(other, "rev-parse", "HEAD"));
    // A fast-forward, not a merge: no commit of the vault's own was made.
    expect(git(vault, "rev-list", "--count", "HEAD")).toBe("2");
  });

  it("leaves a vault with uncommitted edits untouched", async () => {
    const { vault } = vaultBehind();
    writeFileSync(join(vault, "draft.md"), "typing\n");
    const head = git(vault, "rev-parse", "HEAD");
    expect(await tick(vault)).toBe(false);
    expect(git(vault, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(vault, "note.md"), "utf8")).toBe("first\n");
  });

  it("leaves a vault with local commits to the Sync button", async () => {
    const { vault } = vaultBehind();
    commit(vault, "mine.md", "local\n");
    const head = git(vault, "rev-parse", "HEAD");
    expect(await tick(vault)).toBe(false);
    expect(git(vault, "rev-parse", "HEAD")).toBe(head);
  });

  it("does nothing when the remote has nothing new", async () => {
    const { vault } = vaultBehind();
    expect(await tick(vault)).toBe(true);
    expect(await tick(vault)).toBe(false);
  });
});

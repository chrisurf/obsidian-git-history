// @vitest-environment node
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "../src/git/git-service";
import type { FileStatus } from "../src/types";

/**
 * Stage, unstage and discard against the states that used to break them: a
 * rename that is staged and then changed again, a copy, and names git would
 * otherwise read as glob patterns. Every test starts from its own repository,
 * because each one leaves the index in a different shape.
 *
 * Each action is checked twice over: that git accepted it, and that it changed
 * exactly the entry it was given, not a neighbour.
 */

let repo: string;
let git: GitService;
const cleanup: string[] = [];

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = (...args: string[]): string =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const write = (path: string, content: string): void => writeFileSync(join(repo, path), content);
const append = (path: string, line: string): void =>
  writeFileSync(join(repo, path), readFileSync(join(repo, path), "utf8") + line + "\n");

/** A committed repository holding one file per name, each with its own content
    so git never pairs the wrong two as a rename. */
function repoWith(names: string[]): void {
  repo = mkdtempSync(join(tmpdir(), "git-history-actions-"));
  cleanup.push(repo);
  run("init", "-q", "-b", "main", ".");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test User");
  for (const name of names) {
    write(name, `${name}\ndistinct line for ${name}\nshared tail\n`);
  }
  run("add", "-A");
  run("commit", "-qm", "root", "--allow-empty");
  git = new GitService(repo);
}

async function entry(path: string): Promise<FileStatus> {
  const status = await git.status();
  const found = status.find((f) => f.path === path);
  if (!found) throw new Error(`no status entry for "${path}" in ${JSON.stringify(status)}`);
  return found;
}

/** `XY path` for every entry, the way a failed assertion is easiest to read. */
const summary = async (): Promise<string[]> =>
  (await git.status()).map((f) => `${f.indexStatus}${f.workingStatus} ${f.path}`).sort();

describe("a rename that was staged and then changed again", () => {
  it("stages the new change (RM)", async () => {
    repoWith(["moved.md"]);
    run("mv", "moved.md", "moved-to.md");
    append("moved-to.md", "edited after the rename");

    await git.stage([await entry("moved-to.md")]);

    expect(await summary()).toEqual(["R. moved-to.md"]);
    expect(run("show", ":moved-to.md")).toContain("edited after the rename");
  });

  it("discards the new change and keeps the rename staged (RM)", async () => {
    repoWith(["moved.md"]);
    run("mv", "moved.md", "moved-to.md");
    append("moved-to.md", "edited after the rename");

    await git.discard([await entry("moved-to.md")]);

    expect(await summary()).toEqual(["R. moved-to.md"]);
    expect(readFileSync(join(repo, "moved-to.md"), "utf8")).not.toContain("edited");
  });

  it("stages the deletion of the renamed file (RD)", async () => {
    repoWith(["moved.md"]);
    run("mv", "moved.md", "moved-to.md");
    unlinkSync(join(repo, "moved-to.md"));

    await git.stage([await entry("moved-to.md")]);

    expect(await summary()).toEqual(["D. moved.md"]);
  });

  it("unstages both halves (RM)", async () => {
    repoWith(["moved.md"]);
    run("mv", "moved.md", "moved-to.md");
    append("moved-to.md", "edited after the rename");

    await git.unstage([await entry("moved-to.md")]);

    expect(await summary()).toEqual([" ? moved-to.md", ".D moved.md"]);
  });
});

describe("a rename git only sees in the worktree", () => {
  it("stages both halves (.R)", async () => {
    repoWith(["moved.md"]);
    execFileSync("mv", ["moved.md", "moved-to.md"], { cwd: repo });
    run("add", "-N", "moved-to.md");
    const renamed = await entry("moved-to.md");
    expect(`${renamed.indexStatus}${renamed.workingStatus}`).toBe(".R");

    await git.stage([renamed]);

    expect(await summary()).toEqual(["R. moved-to.md"]);
  });
});

describe("a copy", () => {
  it("unstages the copy without unstaging its source (C.)", async () => {
    repoWith(["source.md"]);
    run("config", "status.renames", "copies");
    execFileSync("cp", ["source.md", "copy.md"], { cwd: repo });
    append("source.md", "staged edit of the source");
    run("add", "source.md", "copy.md");
    const copy = await entry("copy.md");
    expect(copy.indexStatus).toBe("C");

    await git.unstage([copy]);

    expect(await summary()).toEqual([" ? copy.md", "M. source.md"]);
  });
});

describe("names git would read as patterns", () => {
  // `[1]` is a character class: as a pathspec, `k[1].md` also matches `k1.md`.
  const setup = (): void => {
    repoWith(["k[1].md", "k1.md"]);
    append("k[1].md", "edit");
    append("k1.md", "edit");
  };

  it("stages only the file that was clicked", async () => {
    setup();
    await git.stage([await entry("k[1].md")]);
    expect(await summary()).toEqual([".M k1.md", "M. k[1].md"]);
  });

  it("unstages only the file that was clicked", async () => {
    setup();
    run("add", "-A");
    await git.unstage([await entry("k[1].md")]);
    expect(await summary()).toEqual([".M k[1].md", "M. k1.md"]);
  });

  it("discards only the file that was clicked", async () => {
    setup();
    await git.discard([await entry("k[1].md")]);
    expect(await summary()).toEqual([".M k1.md"]);
  });

  it("diffs only the file that was asked for", async () => {
    setup();
    const raw = await git.diff(["k[1].md"]);
    expect(raw).toContain("k[1].md");
    expect(raw).not.toContain("k1.md");
  });
});

describe("many paths at once", () => {
  it("stages more paths than one argument list used to hold", async () => {
    // Deletions, and one shared content: staging then writes no objects. Many
    // parallel `git add` runs writing hundreds of objects occasionally fail on
    // macOS with "unable to create temporary file", with or without this code.
    const names = Array.from({ length: 250 }, (_, i) => `note ${i}.md`);
    repoWith([]);
    for (const name of names) write(name, "same\n");
    run("add", "-A");
    run("commit", "-qm", "many");
    for (const name of names) unlinkSync(join(repo, name));

    await git.stage(await git.status());

    const status = await git.status();
    expect(status).toHaveLength(names.length);
    expect(status.every((f) => f.indexStatus === "D" && f.workingStatus === ".")).toBe(true);
  });
});

describe("the diff of a staged rename", () => {
  it("shows the rename rather than a new file", async () => {
    repoWith(["moved.md"]);
    run("mv", "moved.md", "moved-to.md");

    const raw = await git.diff(["moved-to.md", "moved.md"], true);

    expect(raw).toContain("rename from moved.md");
    const [file] = await git.parseDiff(raw);
    expect(file.oldPath).toBe("moved.md");
    expect(file.additions).toBe(0);
  });
});

/**
 * `--pathspec-from-file` arrived in git 2.25. An older git is put in front of
 * the real one here by a wrapper that refuses the option the way git itself
 * does, so the fallback runs against a real repository too.
 */
describe("a git without --pathspec-from-file", () => {
  it("still stages a rename that was changed again, and remembers to fall back", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "git-history-oldgit-"));
    cleanup.push(binDir);
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const log = join(binDir, "calls.log");
    const wrapper = join(binDir, "git");
    writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `echo "$*" >> '${log}'`,
        'for a in "$@"; do case "$a" in --pathspec-from-file*)',
        '  echo "error: unknown option \\`pathspec-from-file=-\'" >&2; exit 129;;',
        "esac; done",
        `exec '${realGit}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(wrapper, 0o755);

    const oldGit = (path: string) =>
      new GitService(path, {
        git: () => Promise.resolve({ binary: { path: wrapper, source: "configured" }, tried: [] }),
        env: (extra = {}) => Promise.resolve({ ...process.env, ...extra }),
      });

    repoWith(["moved.md", "k[1].md", "k1.md"]);
    git = oldGit(repo);
    run("mv", "moved.md", "moved-to.md");
    append("moved-to.md", "edited after the rename");
    append("k[1].md", "edit");
    append("k1.md", "edit");

    await git.stage([await entry("moved-to.md"), await entry("k[1].md")]);
    await git.unstage([await entry("k[1].md")]);

    expect(await summary()).toEqual([".M k1.md", ".M k[1].md", "R. moved-to.md"]);
    const attempts = readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes("--pathspec-from-file"));
    expect(attempts, "the refused option was tried again after the first refusal").toHaveLength(1);
  });
});

import { describe, it, expect } from "vitest";
import { pathsFor, renamedFrom } from "../src/git/change-paths";
import type { ChangeSide } from "../src/git/change-paths";
import type { FileStatus, FileStatusCode } from "../src/types";

/**
 * The rule every index or worktree action derives its paths from. Each row is
 * a state git reports; the old path of a rename belongs only to the side the
 * rename happened on; handing it to the other side names a path that side does
 * not have, and git then refuses the whole command.
 */

type Code = FileStatusCode | " ";

const entry = (xy: string, originalPath?: string): FileStatus => ({
  path: "new.md",
  originalPath,
  indexStatus: xy[0] as Code,
  workingStatus: xy[1] as Code,
  staged: xy[0] !== "." && xy[0] !== " ",
});

const rows: [xy: string, originalPath: string | undefined, side: ChangeSide, paths: string[]][] = [
  // Renamed in the index, then edited or deleted in the worktree.
  ["RM", "old.md", "worktree", ["new.md"]],
  ["RM", "old.md", "index", ["new.md", "old.md"]],
  ["RD", "old.md", "worktree", ["new.md"]],
  ["RD", "old.md", "index", ["new.md", "old.md"]],
  ["R.", "old.md", "index", ["new.md", "old.md"]],
  // Renamed in the worktree only, as with `git add -N`.
  [".R", "old.md", "worktree", ["new.md", "old.md"]],
  [".R", "old.md", "index", ["new.md"]],
  // A copy leaves its source in place; acting on it must not touch the source.
  ["C.", "src.md", "index", ["new.md"]],
  ["CM", "src.md", "worktree", ["new.md"]],
  // Everything without a second path.
  [".M", undefined, "worktree", ["new.md"]],
  ["M.", undefined, "index", ["new.md"]],
  ["D.", undefined, "index", ["new.md"]],
  [" ?", undefined, "worktree", ["new.md"]],
  ["UU", undefined, "worktree", ["new.md"]],
];

describe("pathsFor", () => {
  it.each(rows)("%s from %s on the %s side → %j", (xy, originalPath, side, paths) => {
    expect(pathsFor(entry(xy, originalPath), side)).toEqual(paths);
  });
});

describe("renamedFrom", () => {
  it("names the old path of a rename on either side", () => {
    expect(renamedFrom(entry("R.", "old.md"))).toBe("old.md");
    expect(renamedFrom(entry("RM", "old.md"))).toBe("old.md");
    expect(renamedFrom(entry(".R", "old.md"))).toBe("old.md");
  });

  it("leaves a copy's source out, since the copy did not come from it", () => {
    expect(renamedFrom(entry("C.", "src.md"))).toBeUndefined();
  });

  it("has nothing to say about an entry with one path", () => {
    expect(renamedFrom(entry(".M"))).toBeUndefined();
  });
});

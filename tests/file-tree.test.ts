// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildFileTree, collectDirPaths, collectItems } from "../src/utils/file-tree";
import type { TreeNode } from "../src/utils/file-tree";

interface Entry {
  path: string;
}

const tree = (paths: string[], compact = false): TreeNode<Entry>[] =>
  buildFileTree(
    paths.map((path) => ({ path })),
    (e) => e.path,
    compact,
  );

const shape = (nodes: TreeNode<Entry>[]): unknown =>
  nodes.map((n) => (n.isDir ? { [n.name]: shape(n.children) } : n.name));

describe("building a file tree", () => {
  it("puts a file with no folder at the top", () => {
    expect(shape(tree(["note.md"]))).toEqual(["note.md"]);
  });

  it("nests a file under each of its folders", () => {
    expect(shape(tree(["a/b/note.md"]))).toEqual([{ a: [{ b: ["note.md"] }] }]);
  });

  it("gathers files of the same folder under one node", () => {
    expect(shape(tree(["a/one.md", "a/two.md"]))).toEqual([{ a: ["one.md", "two.md"] }]);
  });

  it("keeps folders apart that only share a name prefix", () => {
    expect(shape(tree(["src/a.md", "srcs/b.md"]))).toEqual([{ src: ["a.md"] }, { srcs: ["b.md"] }]);
  });

  it("gives a folder node the path the expanded set keys on", () => {
    const [dir] = tree(["a/b/note.md"]);
    expect(dir.path).toBe("a");
    expect(dir.children[0].path).toBe("a/b");
  });

  it("hands the entry itself to the file node", () => {
    const [dir] = tree(["a/note.md"]);
    expect(dir.children[0].item).toEqual({ path: "a/note.md" });
  });

  it("keeps the order the entries came in", () => {
    expect(shape(tree(["b.md", "a.md"]))).toEqual(["b.md", "a.md"]);
  });
});

describe("compacting single-child folder chains", () => {
  it("folds a chain into one row", () => {
    expect(shape(tree(["Projects/cloudcourse/note.md"], true))).toEqual([
      { "Projects/cloudcourse": ["note.md"] },
    ]);
  });

  it("keeps the deepest path, so the folded row still names a real folder", () => {
    const [dir] = tree(["Projects/cloudcourse/note.md"], true);
    expect(dir.path).toBe("Projects/cloudcourse");
  });

  it("stops folding where the folder holds more than one child", () => {
    expect(shape(tree(["a/b/one.md", "a/c/two.md"], true))).toEqual([
      { a: [{ b: ["one.md"] }, { c: ["two.md"] }] },
    ]);
  });

  it("does not fold a folder that holds a folder and a file", () => {
    expect(shape(tree(["a/b/one.md", "a/two.md"], true))).toEqual([
      { a: [{ b: ["one.md"] }, "two.md"] },
    ]);
  });

  it("folds a chain nested inside another folder", () => {
    expect(shape(tree(["a/one.md", "a/b/c/two.md"], true))).toEqual([
      { a: ["one.md", { "b/c": ["two.md"] }] },
    ]);
  });

  it("leaves the chain alone when compacting is off", () => {
    expect(shape(tree(["a/b/note.md"], false))).toEqual([{ a: [{ b: ["note.md"] }] }]);
  });
});

describe("collecting folders and entries", () => {
  it("lists every folder, however deep", () => {
    expect(collectDirPaths(tree(["a/b/c/note.md", "d/other.md"]))).toEqual([
      "a",
      "a/b",
      "a/b/c",
      "d",
    ]);
  });

  it("lists the folded paths once a chain is compacted", () => {
    expect(collectDirPaths(tree(["a/b/c/note.md"], true))).toEqual(["a/b/c"]);
  });

  it("finds no folder in a flat list of files", () => {
    expect(collectDirPaths(tree(["one.md", "two.md"]))).toEqual([]);
  });

  it("gathers every entry below a folder, through the folders in between", () => {
    const [dir] = tree(["a/one.md", "a/b/two.md"]);
    expect(collectItems(dir).map((e) => e.path)).toEqual(["a/one.md", "a/b/two.md"]);
  });

  it("gathers nothing from a folder that is empty", () => {
    expect(collectItems({ name: "a", path: "a", isDir: true, children: [] })).toEqual([]);
  });
});

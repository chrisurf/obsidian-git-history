// @vitest-environment node
import { describe, it, expect } from "vitest";
import { computeGraphLayout } from "../src/utils/graph-layout";
import type { CommitInfo } from "../src/types";

function commit(hash: string, parents: string[]): CommitInfo {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    message: hash,
    body: "",
    author: "Test",
    authorEmail: "test@example.com",
    date: new Date(2026, 0, 1),
    refs: [],
  };
}

/** Straight chain plus periodic forks and merges, deterministic by construction. */
function buildDag(size: number): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (let i = 0; i < size; i++) {
    const parents: string[] = [];
    if (i + 1 < size) parents.push(`c${i + 1}`);
    if (i % 13 === 0 && i + 7 < size) parents.push(`c${i + 7}`);
    commits.push(commit(`c${i}`, parents));
  }
  return commits;
}

describe("computeGraphLayout", () => {
  it("returns an empty layout for no commits", () => {
    expect(computeGraphLayout([])).toEqual({ nodes: [], edges: [], maxColumns: 0 });
  });

  it("places a linear history in a single column", () => {
    const commits = [commit("a", ["b"]), commit("b", ["c"]), commit("c", [])];
    const { nodes, maxColumns } = computeGraphLayout(commits);

    expect(nodes.map((n) => n.column)).toEqual([0, 0, 0]);
    // maxColumns is a lane count, not a max index.
    expect(maxColumns).toBe(1);
  });

  it("produces one node per commit, in input order", () => {
    const commits = buildDag(500);
    const { nodes } = computeGraphLayout(commits);

    expect(nodes).toHaveLength(commits.length);
    expect(nodes.map((n) => n.commit.hash)).toEqual(commits.map((c) => c.hash));
  });

  it("keeps every node in a valid column", () => {
    const { nodes, maxColumns } = computeGraphLayout(buildDag(500));

    for (const node of nodes) {
      expect(node.column).toBeGreaterThanOrEqual(0);
      expect(node.column).toBeLessThan(maxColumns);
    }
  });

  it("only emits edges between rows that exist", () => {
    const commits = buildDag(500);
    const { edges } = computeGraphLayout(commits);

    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      expect(edge.fromRow).toBeGreaterThanOrEqual(0);
      expect(edge.fromRow).toBeLessThan(commits.length);
      expect(edge.toRow).toBeGreaterThanOrEqual(0);
      expect(edge.toRow).toBeLessThan(commits.length);
      // Parents are always further down the list than their child.
      expect(edge.toRow).toBeGreaterThan(edge.fromRow);
    }
  });

  it("connects every parent that is present in the list", () => {
    const commits = buildDag(200);
    const index = new Map(commits.map((c, i) => [c.hash, i]));
    const { edges } = computeGraphLayout(commits);

    const expected = commits.flatMap((c, row) =>
      c.parents.filter((p) => index.has(p)).map((p) => `${row}->${index.get(p)}`),
    );
    const actual = edges.map((e) => `${e.fromRow}->${e.toRow}`);

    expect(new Set(actual)).toEqual(new Set(expected));
  });

  it("is deterministic", () => {
    const commits = buildDag(300);
    expect(computeGraphLayout(commits)).toEqual(computeGraphLayout(commits));
  });

  it("tolerates parents that are outside the loaded window", () => {
    // The last commit references a parent that was not loaded.
    const commits = [commit("a", ["b"]), commit("b", ["missing"])];
    const { nodes, edges } = computeGraphLayout(commits);

    expect(nodes).toHaveLength(2);
    expect(edges.every((e) => e.toRow < commits.length)).toBe(true);
  });
});

import { CommitInfo, GraphNode, GraphEdge, GraphData } from "../types";

const BRANCH_COLORS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
];

export function computeGraphLayout(commits: CommitInfo[]): GraphData {
  if (commits.length === 0) return { nodes: [], edges: [], maxColumns: 0 };

  const commitIndex = new Map<string, number>();
  commits.forEach((c, i) => commitIndex.set(c.hash, i));

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const activeLanes: (string | null)[] = [];
  let colorCounter = 0;
  const commitColors = new Map<string, number>();

  function allocateLane(hash: string): number {
    for (let i = 0; i < activeLanes.length; i++) {
      if (activeLanes[i] === null) {
        activeLanes[i] = hash;
        return i;
      }
    }
    activeLanes.push(hash);
    return activeLanes.length - 1;
  }

  function findLane(hash: string): number {
    return activeLanes.indexOf(hash);
  }

  function freeLane(index: number): void {
    activeLanes[index] = null;
  }

  function getColor(hash: string): number {
    if (!commitColors.has(hash)) {
      commitColors.set(hash, BRANCH_COLORS[colorCounter % BRANCH_COLORS.length]);
      colorCounter++;
    }
    return commitColors.get(hash)!;
  }

  for (let row = 0; row < commits.length; row++) {
    const commit = commits[row];

    let col = findLane(commit.hash);
    if (col === -1) {
      col = allocateLane(commit.hash);
    }

    const color = getColor(commit.hash);
    const parentColumns: number[] = [];
    const childColumns: number[] = [];

    freeLane(col);

    for (let pi = 0; pi < commit.parents.length; pi++) {
      const parentHash = commit.parents[pi];
      let parentLane = findLane(parentHash);

      if (parentLane === -1) {
        if (pi === 0) {
          activeLanes[col] = parentHash;
          parentLane = col;
          if (!commitColors.has(parentHash)) {
            commitColors.set(parentHash, color);
          }
        } else {
          parentLane = allocateLane(parentHash);
          if (!commitColors.has(parentHash)) {
            commitColors.set(parentHash, getColor(parentHash));
          }
        }
      }

      parentColumns.push(parentLane);

      const parentRow = commitIndex.get(parentHash);
      if (parentRow !== undefined) {
        edges.push({
          fromRow: row,
          fromCol: col,
          toRow: parentRow,
          toCol: parentLane,
          color: pi === 0 ? color : commitColors.get(parentHash) || color,
        });
      }
    }

    if (commit.parents.length === 0 && col >= 0 && col < activeLanes.length) {
      if (activeLanes[col] === null) {
        // keep lane free
      }
    }

    nodes.push({
      commit,
      column: col,
      color,
      childColumns,
      parentColumns,
    });
  }

  let maxColumns = 0;
  for (const node of nodes) {
    if (node.column + 1 > maxColumns) maxColumns = node.column + 1;
  }
  for (const edge of edges) {
    const m = Math.max(edge.fromCol, edge.toCol) + 1;
    if (m > maxColumns) maxColumns = m;
  }

  return { nodes, edges, maxColumns };
}

export function formatRelativeDate(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (seconds < 60) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (weeks < 5) return `${weeks}w ago`;
  if (months < 12) return `${months}mo ago`;
  return `${years}y ago`;
}

export const SOURCE_CONTROL_VIEW_TYPE = "git-history-source-control";
export const GRAPH_VIEW_TYPE = "git-history-graph";
export const DIFF_VIEW_TYPE = "git-history-diff";
export const TERMINAL_VIEW_TYPE = "git-history-terminal";

/**
 * Status letters git can report per side. "." is porcelain v2's "unchanged"
 * and "T" a type change (file <-> symlink), both of which the parser passes
 * through unmodified.
 */
export type FileStatusCode = "M" | "T" | "A" | "D" | "R" | "C" | "U" | "?" | "!" | ".";

export interface FileStatus {
  path: string;
  originalPath?: string;
  indexStatus: FileStatusCode | " ";
  workingStatus: FileStatusCode | " ";
  staged: boolean;
  /**
   * Untracked entry that git reports as a directory rather than a file, i.e. a
   * nested repository. `git add` refuses these (or silently turns them into a
   * gitlink), so staging has to leave them alone.
   */
  embeddedRepo?: boolean;
}

export interface CommitStats {
  filesChanged: number;
  additions: number;
  deletions: number;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  parents: string[];
  message: string;
  body: string;
  author: string;
  authorEmail: string;
  date: Date;
  refs: RefInfo[];
  /**
   * Aggregated diff stats collected in the same `git log` call.
   * Undefined when git emits no stat block for the commit (merge commits
   * without --diff-merges, empty commits) — callers fall back to a lazy
   * per-commit lookup for those.
   */
  stats?: CommitStats;
}

export interface RefInfo {
  name: string;
  type: "head" | "branch" | "remote" | "tag";
  current: boolean;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  remote?: string;
  tracking?: string;
  ahead: number;
  behind: number;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface StashEntry {
  index: number;
  message: string;
  date: Date;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "del" | "context";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface GraphNode {
  commit: CommitInfo;
  column: number;
  color: number;
  childColumns: number[];
  parentColumns: number[];
}

export interface GraphEdge {
  fromRow: number;
  fromCol: number;
  toRow: number;
  toCol: number;
  color: number;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  maxColumns: number;
}

export interface GitHistorySettings {
  commitTemplate: string;
  pullStrategy: "merge" | "rebase" | "ff-only";
  autoFetchEnabled: boolean;
  autoFetchInterval: number;
  diffViewMode: "side-by-side" | "inline";
  /**
   * Hide files Obsidian has no viewer for from a commit's file list. On by
   * default: a commit's list is for getting to a note, and rows that cannot be
   * opened only get in the way.
   */
  onlySupportedFileTypes: boolean;
  showStatusBar: boolean;
  treeView: boolean;
  debounceMs: number;
  showNestedRepos: boolean;
  /** Version whose "what's new" note the user has already seen. */
  lastWhatsNewVersion: string;
  /** Override for the shell binary used by the embedded terminal. */
  terminalShell: string;
}

export const DEFAULT_SETTINGS: GitHistorySettings = {
  commitTemplate: "",
  pullStrategy: "merge",
  autoFetchEnabled: false,
  autoFetchInterval: 300,
  diffViewMode: "side-by-side",
  onlySupportedFileTypes: true,
  showStatusBar: true,
  treeView: false,
  debounceMs: 1000,
  showNestedRepos: false,
  lastWhatsNewVersion: "",
  terminalShell: "",
};

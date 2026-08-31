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

/** Where the current branch stands against its upstream, if it has one. */
export interface UpstreamState {
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasCommits: boolean;
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

export type FileListMode = "tree" | "list";

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
  /**
   * Layout of the changes list. "tree" nests files under their folders, "list"
   * gives every file one row with its folder shown next to the name.
   */
  fileListMode: FileListMode;
  /**
   * Fold a chain of folders that each hold a single subfolder into one row
   * ("Projects/cloudcourse"). Tree layout only.
   */
  compactFolders: boolean;
  debounceMs: number;
  showNestedRepos: boolean;
  /** Version whose "what's new" note the user has already seen. */
  lastWhatsNewVersion: string;
  /**
   * Whether the user has waved away the "set your Git identity" prompt. It is
   * asked once and then never again on its own — a failed commit still offers
   * it, because at that point it is the answer rather than an interruption.
   */
  identityPromptDismissed: boolean;
  /**
   * Override for the git binary. Empty means the plugin finds one itself, which
   * is what it should normally be doing; this is the way out when it cannot.
   */
  gitPath: string;
  /** Override for the shell binary used by the embedded terminal. */
  terminalShell: string;
  /**
   * Override for the Python that runs the terminal's PTY bridge. Same purpose
   * as gitPath: a machine whose developer tools are broken can be pointed at a
   * working interpreter instead of waiting for a fix.
   */
  terminalPython: string;
  /**
   * Which bridge opens the pseudo-terminal. "auto" walks them in order and
   * takes the first that works, which is right for everyone who has no reason
   * to care; the named values are for pinning one down while diagnosing.
   */
  terminalPtyBackend: "auto" | "python" | "perl" | "pipe";
  /**
   * Shell code run at the start of every terminal session, after the user's own
   * rc files and before the first prompt. Stored whole rather than as a path so
   * it travels with the vault; empty means the shell starts as it always did.
   */
  terminalStartupScript: string;
  /**
   * Give every new terminal session the next free colour from the palette.
   * Off by default, the way VS Code leaves its terminal tabs neutral until you
   * colour one yourself.
   */
  terminalAutoColor: boolean;
}

export const DEFAULT_SETTINGS: GitHistorySettings = {
  commitTemplate: "",
  pullStrategy: "merge",
  autoFetchEnabled: false,
  autoFetchInterval: 300,
  diffViewMode: "side-by-side",
  onlySupportedFileTypes: true,
  showStatusBar: true,
  fileListMode: "tree",
  compactFolders: true,
  debounceMs: 1000,
  showNestedRepos: false,
  lastWhatsNewVersion: "",
  identityPromptDismissed: false,
  gitPath: "",
  terminalShell: "",
  terminalPython: "",
  terminalPtyBackend: "auto",
  terminalStartupScript: "",
  terminalAutoColor: false,
};

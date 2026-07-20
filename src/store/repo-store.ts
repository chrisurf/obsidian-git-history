import { Events } from "obsidian";
import { GitService } from "../git/git-service";
import { FileStatus, CommitInfo, BranchInfo } from "../types";

export class RepoStore extends Events {
  private _status: FileStatus[] = [];
  private _branch = "";
  private _branches: BranchInfo[] = [];
  private _commits: CommitInfo[] = [];
  private _ahead = 0;
  private _behind = 0;
  private _loading = false;
  private _merging = false;
  private _refreshQueued = false;
  private _statusFingerprint: string | null = null;
  private _branchFingerprint: string | null = null;

  constructor(private git: GitService) {
    super();
  }

  get status(): FileStatus[] {
    return this._status;
  }
  get stagedFiles(): FileStatus[] {
    return this._status.filter((f) => f.staged);
  }
  get changedFiles(): FileStatus[] {
    return this._status.filter((f) => !f.staged && f.workingStatus !== "?");
  }
  get untrackedFiles(): FileStatus[] {
    return this._status.filter((f) => f.workingStatus === "?");
  }
  get branch(): string {
    return this._branch;
  }
  get branches(): BranchInfo[] {
    return this._branches;
  }
  get commits(): CommitInfo[] {
    return this._commits;
  }
  get ahead(): number {
    return this._ahead;
  }
  get behind(): number {
    return this._behind;
  }
  get loading(): boolean {
    return this._loading;
  }
  get merging(): boolean {
    return this._merging;
  }

  get mergeConflicts(): FileStatus[] {
    return this._status.filter((f) => f.indexStatus === "U" || f.workingStatus === "U");
  }

  private computeFingerprint(status: FileStatus[]): string {
    return status.map((f) => `${f.path}:${f.indexStatus}:${f.workingStatus}:${f.staged}`).join("|");
  }

  async refresh(): Promise<void> {
    if (this._loading) {
      this._refreshQueued = true;
      return;
    }
    this._loading = true;
    this.trigger("loading", true);
    try {
      const [status, branch, ab] = await Promise.all([
        this.git.status(),
        this.git.currentBranch(),
        this.git.getAheadBehind(),
      ]);

      const newStatusFp = this.computeFingerprint(status);
      const newBranchFp = `${branch}:${ab.ahead}:${ab.behind}`;
      const isFirstLoad = this._statusFingerprint === null;
      const statusChanged = isFirstLoad || newStatusFp !== this._statusFingerprint;
      const branchChanged = isFirstLoad || newBranchFp !== this._branchFingerprint;

      this._status = status;
      this._branch = branch;
      this._ahead = ab.ahead;
      this._behind = ab.behind;
      this._merging = status.some((f) => f.indexStatus === "U" || f.workingStatus === "U");
      this._statusFingerprint = newStatusFp;
      this._branchFingerprint = newBranchFp;

      if (statusChanged) this.trigger("status-changed", this._status);
      if (branchChanged) this.trigger("branch-changed", this._branch);
    } catch (e) {
      this.trigger("error", e);
    } finally {
      this._loading = false;
      this.trigger("loading", false);
      if (this._refreshQueued) {
        this._refreshQueued = false;
        this.refresh();
      }
    }
  }

  async refreshBranches(): Promise<void> {
    try {
      this._branches = await this.git.branches();
      this.trigger("branches-changed", this._branches);
    } catch (e) {
      this.trigger("error", e);
    }
  }

  async refreshLog(opts?: { maxCount?: number; all?: boolean; file?: string }): Promise<void> {
    try {
      this._commits = await this.git.log({
        maxCount: opts?.maxCount || 200,
        all: opts?.all ?? true,
        file: opts?.file,
      });
      this.trigger("log-changed", this._commits);
    } catch (e) {
      this.trigger("error", e);
    }
  }

  async loadMoreCommits(count = 200): Promise<void> {
    try {
      const more = await this.git.log({
        maxCount: count,
        skip: this._commits.length,
        all: true,
      });
      this._commits = [...this._commits, ...more];
      this.trigger("log-changed", this._commits);
    } catch (e) {
      this.trigger("error", e);
    }
  }
}

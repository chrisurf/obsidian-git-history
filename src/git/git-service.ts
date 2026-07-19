import { execFile } from "child_process";
import {
  FileStatus,
  FileStatusCode,
  CommitInfo,
  RefInfo,
  BranchInfo,
  RemoteInfo,
  FileDiff,
  DiffHunk,
  DiffLine,
  StashEntry,
} from "../types";

export class GitService {
  private repoPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  setRepoPath(path: string): void {
    this.repoPath = path;
  }

  private exec(args: string[], timeout = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: this.repoPath,
          maxBuffer: 50 * 1024 * 1024,
          timeout,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
        (error, stdout, stderr) => {
          if (error) {
            const msg = stderr?.trim() || error.message;
            reject(new GitError(msg, args));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async isRepo(): Promise<boolean> {
    try {
      await this.exec(["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  async getRepoRoot(): Promise<string> {
    const out = await this.exec(["rev-parse", "--show-toplevel"]);
    return out.trim();
  }

  async status(): Promise<FileStatus[]> {
    const out = await this.exec([
      "status",
      "--porcelain=v2",
      "-z",
      "--untracked-files=normal",
    ]);
    return this.parseStatusV2(out);
  }

  private parseStatusV2(raw: string): FileStatus[] {
    const entries: FileStatus[] = [];
    const parts = raw.split("\0").filter(Boolean);
    let i = 0;
    while (i < parts.length) {
      const line = parts[i];
      if (line.startsWith("1 ")) {
        const fields = line.split(" ");
        const xy = fields[1];
        const path = fields.slice(8).join(" ");
        entries.push({
          path,
          indexStatus: xy[0] as FileStatusCode | " ",
          workingStatus: xy[1] as FileStatusCode | " ",
          staged: xy[0] !== "." && xy[0] !== "?" && xy[0] !== " ",
        });
      } else if (line.startsWith("2 ")) {
        const fields = line.split(" ");
        const xy = fields[1];
        const path = fields.slice(9).join(" ");
        const origPath = parts[++i];
        entries.push({
          path,
          originalPath: origPath,
          indexStatus: xy[0] as FileStatusCode | " ",
          workingStatus: xy[1] as FileStatusCode | " ",
          staged: xy[0] !== "." && xy[0] !== "?" && xy[0] !== " ",
        });
      } else if (line.startsWith("? ")) {
        const path = line.substring(2).replace(/\/+$/, "");
        entries.push({
          path,
          indexStatus: " ",
          workingStatus: "?",
          staged: false,
        });
      } else if (line.startsWith("u ")) {
        const fields = line.split(" ");
        const path = fields.slice(10).join(" ");
        entries.push({
          path,
          indexStatus: "U",
          workingStatus: "U",
          staged: false,
        });
      }
      i++;
    }
    return entries;
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.enqueue(() => this.exec(["add", "--", ...paths]));
  }

  async stageAll(): Promise<void> {
    await this.enqueue(() => this.exec(["add", "-A"]));
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.enqueue(() =>
      this.exec(["reset", "HEAD", "--", ...paths])
    );
  }

  async unstageAll(): Promise<void> {
    await this.enqueue(() => this.exec(["reset", "HEAD"]));
  }

  async discard(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await this.enqueue(() =>
      this.exec(["checkout", "--", ...paths])
    );
  }

  async commit(
    message: string,
    opts?: { amend?: boolean; allowEmpty?: boolean }
  ): Promise<void> {
    const args = ["commit", "-m", message];
    if (opts?.amend) args.push("--amend");
    if (opts?.allowEmpty) args.push("--allow-empty");
    await this.enqueue(() => this.exec(args));
  }

  async push(opts?: {
    remote?: string;
    branch?: string;
    force?: boolean;
    setUpstream?: boolean;
  }): Promise<void> {
    const args = ["push"];
    if (opts?.force) args.push("--force-with-lease");
    if (opts?.setUpstream) args.push("-u");
    if (opts?.remote) args.push(opts.remote);
    if (opts?.branch) args.push(opts.branch);
    await this.enqueue(() => this.exec(args, 60000));
  }

  async pull(opts?: {
    remote?: string;
    branch?: string;
    strategy?: "merge" | "rebase" | "ff-only";
  }): Promise<void> {
    const args = ["pull"];
    if (opts?.strategy === "rebase") args.push("--rebase");
    else if (opts?.strategy === "ff-only") args.push("--ff-only");
    if (opts?.remote) args.push(opts.remote);
    if (opts?.branch) args.push(opts.branch);
    await this.enqueue(() => this.exec(args, 60000));
  }

  async fetch(remote?: string): Promise<void> {
    const args = ["fetch"];
    if (remote) args.push(remote);
    else args.push("--all");
    await this.enqueue(() => this.exec(args, 60000));
  }

  async log(opts?: {
    maxCount?: number;
    skip?: number;
    branch?: string;
    file?: string;
    all?: boolean;
  }): Promise<CommitInfo[]> {
    const SEP = "@@GS_SEP@@";
    const format = ["%H", "%h", "%P", "%s", "%b", "%an", "%ae", "%aI", "%D"].join(SEP);
    const args = ["log", `--format=${format}`, "--parents"];
    if (opts?.all) args.push("--all");
    if (opts?.maxCount) args.push(`-n${opts.maxCount}`);
    if (opts?.skip) args.push(`--skip=${opts.skip}`);
    if (opts?.branch) args.push(opts.branch);
    if (opts?.file) {
      args.push("--follow", "--", opts.file);
    }
    try {
      const out = await this.exec(args);
      return this.parseLog(out, SEP);
    } catch {
      return [];
    }
  }

  private parseLog(raw: string, sep: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split(sep);
      if (parts.length < 9) continue;
      const [hash, shortHash, parentsStr, message, body, author, authorEmail, dateStr, refsStr] = parts;
      const parents = parentsStr.trim() ? parentsStr.trim().split(" ") : [];
      const refs = this.parseRefs(refsStr.trim());
      commits.push({
        hash,
        shortHash,
        parents,
        message,
        body: body.trim(),
        author,
        authorEmail,
        date: new Date(dateStr),
        refs,
      });
    }
    return commits;
  }

  private parseRefs(refsStr: string): RefInfo[] {
    if (!refsStr) return [];
    return refsStr.split(", ").map((r) => {
      let name = r.trim();
      let type: RefInfo["type"] = "branch";
      let current = false;
      if (name.startsWith("HEAD -> ")) {
        name = name.substring(8);
        type = "head";
        current = true;
      } else if (name === "HEAD") {
        type = "head";
        current = true;
        return { name, type, current };
      }
      if (name.startsWith("tag: ")) {
        name = name.substring(5);
        type = "tag";
      } else if (name.includes("/")) {
        type = "remote";
      }
      return { name, type, current };
    });
  }

  async currentBranch(): Promise<string> {
    try {
      const out = await this.exec(["symbolic-ref", "--short", "HEAD"]);
      return out.trim();
    } catch {
      const out = await this.exec(["rev-parse", "--short", "HEAD"]);
      return `(${out.trim()})`;
    }
  }

  async branches(): Promise<BranchInfo[]> {
    const out = await this.exec([
      "branch",
      "-a",
      "-vv",
      "--format=%(refname:short)|%(HEAD)|%(upstream:short)|%(upstream:track,nobracket)",
    ]);
    const result: BranchInfo[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [name, head, tracking, trackInfo] = line.split("|");
      let ahead = 0;
      let behind = 0;
      if (trackInfo) {
        const aMatch = trackInfo.match(/ahead (\d+)/);
        const bMatch = trackInfo.match(/behind (\d+)/);
        if (aMatch) ahead = parseInt(aMatch[1]);
        if (bMatch) behind = parseInt(bMatch[1]);
      }
      const isRemote = name.includes("/");
      result.push({
        name,
        current: head === "*",
        remote: isRemote ? name.split("/")[0] : undefined,
        tracking: tracking || undefined,
        ahead,
        behind,
      });
    }
    return result;
  }

  async checkout(branch: string): Promise<void> {
    await this.enqueue(() => this.exec(["checkout", branch]));
  }

  async createBranch(name: string, from?: string): Promise<void> {
    const args = ["checkout", "-b", name];
    if (from) args.push(from);
    await this.enqueue(() => this.exec(args));
  }

  async deleteBranch(name: string, force = false): Promise<void> {
    await this.enqueue(() =>
      this.exec(["branch", force ? "-D" : "-d", name])
    );
  }

  async merge(branch: string, opts?: { noFf?: boolean; squash?: boolean }): Promise<void> {
    const args = ["merge", branch];
    if (opts?.noFf) args.push("--no-ff");
    if (opts?.squash) args.push("--squash");
    await this.enqueue(() => this.exec(args));
  }

  async abortMerge(): Promise<void> {
    await this.enqueue(() => this.exec(["merge", "--abort"]));
  }

  async diff(path?: string, staged = false): Promise<string> {
    const args = ["diff"];
    if (staged) args.push("--cached");
    if (path) args.push("--", path);
    return this.exec(args);
  }

  async diffCommit(ref1: string, ref2?: string, path?: string): Promise<string> {
    const args = ["diff", ref1];
    if (ref2) args.push(ref2);
    if (path) args.push("--", path);
    return this.exec(args);
  }

  async show(ref: string, path: string): Promise<string> {
    try {
      return await this.exec(["show", `${ref}:${path}`]);
    } catch {
      return "";
    }
  }

  async showCommitFiles(hash: string): Promise<{ path: string; additions: number; deletions: number }[]> {
    const out = await this.exec(["diff-tree", "--no-commit-id", "-r", "--numstat", hash]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [add, del, ...pathParts] = line.split("\t");
        return {
          path: pathParts.join("\t"),
          additions: add === "-" ? 0 : parseInt(add),
          deletions: del === "-" ? 0 : parseInt(del),
        };
      });
  }

  async parseDiff(raw: string): Promise<FileDiff[]> {
    const files: FileDiff[] = [];
    const fileSections = raw.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
      const lines = section.split("\n");
      const headerMatch = lines[0]?.match(/a\/(.*) b\/(.*)/);
      if (!headerMatch) continue;

      const oldPath = headerMatch[1];
      const newPath = headerMatch[2];
      const binary = lines.some((l) => l.startsWith("Binary files"));

      const hunks: DiffHunk[] = [];
      let currentHunk: DiffHunk | null = null;
      let oldLine = 0;
      let newLine = 0;
      let additions = 0;
      let deletions = 0;

      for (const line of lines) {
        const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
        if (hunkMatch) {
          if (currentHunk) hunks.push(currentHunk);
          oldLine = parseInt(hunkMatch[1]);
          newLine = parseInt(hunkMatch[3]);
          currentHunk = {
            oldStart: oldLine,
            oldLines: parseInt(hunkMatch[2] || "1"),
            newStart: newLine,
            newLines: parseInt(hunkMatch[4] || "1"),
            header: hunkMatch[5]?.trim() || "",
            lines: [],
          };
          continue;
        }
        if (!currentHunk) continue;
        if (line.startsWith("+")) {
          currentHunk.lines.push({
            type: "add",
            content: line.substring(1),
            newLineNo: newLine++,
          });
          additions++;
        } else if (line.startsWith("-")) {
          currentHunk.lines.push({
            type: "del",
            content: line.substring(1),
            oldLineNo: oldLine++,
          });
          deletions++;
        } else if (line.startsWith(" ")) {
          currentHunk.lines.push({
            type: "context",
            content: line.substring(1),
            oldLineNo: oldLine++,
            newLineNo: newLine++,
          });
        }
      }
      if (currentHunk) hunks.push(currentHunk);

      files.push({
        path: newPath,
        oldPath: oldPath !== newPath ? oldPath : undefined,
        binary,
        hunks,
        additions,
        deletions,
      });
    }
    return files;
  }

  async getAheadBehind(): Promise<{ ahead: number; behind: number }> {
    try {
      const out = await this.exec([
        "rev-list",
        "--left-right",
        "--count",
        "HEAD...@{upstream}",
      ]);
      const [ahead, behind] = out.trim().split(/\s+/).map(Number);
      return { ahead: ahead || 0, behind: behind || 0 };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  async remotes(): Promise<RemoteInfo[]> {
    try {
      const out = await this.exec(["remote", "-v"]);
      const map = new Map<string, RemoteInfo>();
      for (const line of out.split("\n")) {
        const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)/);
        if (!match) continue;
        const [, name, url, type] = match;
        if (!map.has(name)) map.set(name, { name, fetchUrl: "", pushUrl: "" });
        const info = map.get(name)!;
        if (type === "fetch") info.fetchUrl = url;
        else info.pushUrl = url;
      }
      return Array.from(map.values());
    } catch {
      return [];
    }
  }

  async stashList(): Promise<StashEntry[]> {
    try {
      const out = await this.exec(["stash", "list", "--format=%gd|%gs|%aI"]);
      return out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [ref, message, dateStr] = line.split("|");
          const index = parseInt(ref.replace("stash@{", "").replace("}", ""));
          return { index, message, date: new Date(dateStr) };
        });
    } catch {
      return [];
    }
  }

  async stashSave(message?: string): Promise<void> {
    const args = ["stash", "push"];
    if (message) args.push("-m", message);
    await this.enqueue(() => this.exec(args));
  }

  async stashPop(index = 0): Promise<void> {
    await this.enqueue(() => this.exec(["stash", "pop", `stash@{${index}}`]));
  }

  async stashDrop(index: number): Promise<void> {
    await this.enqueue(() => this.exec(["stash", "drop", `stash@{${index}}`]));
  }

  async init(): Promise<void> {
    await this.exec(["init"]);
  }

  async addRemote(name: string, url: string): Promise<void> {
    await this.exec(["remote", "add", name, url]);
  }

  async hasChanges(): Promise<boolean> {
    const s = await this.status();
    return s.length > 0;
  }
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly command: string[]
  ) {
    super(message);
    this.name = "GitError";
  }
}

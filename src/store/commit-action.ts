/**
 * What the primary button in the source control panel should do right now.
 *
 * The button used to ask one question — is there text in the message field —
 * and stayed a Commit button either way, which left it fully lit with nothing
 * to commit and silent about commits waiting to be pushed. Deciding that here,
 * away from the DOM, keeps a dozen combinations of repository state in one
 * readable place and within reach of a test.
 */
export type CommitAction = "commit" | "push" | "publish" | "sync" | "none";

export interface RepoSnapshot {
  /** A commit message the user typed, or a template that stands in for one. */
  hasMessage: boolean;
  /** Files git would put into a commit: staged, or stageable. */
  changeCount: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  hasCommits: boolean;
  /** Unresolved merge conflicts block a commit until they are settled. */
  merging: boolean;
}

export interface CommitButtonState {
  action: CommitAction;
  label: string;
  icon: string;
  enabled: boolean;
  tooltip: string;
}

/**
 * Changes outrank the remote: as long as something is uncommitted, the button
 * stays a Commit button — pushing before committing would leave the work
 * behind. Only with a clean tree does it turn into what the remote needs.
 */
export function commitButtonState(repo: RepoSnapshot): CommitButtonState {
  if (repo.changeCount > 0) return commitState(repo);

  // Ahead and behind at once: a plain push is rejected, so the button offers
  // the pull that has to happen first rather than an action that fails.
  if (repo.hasUpstream && repo.ahead > 0 && repo.behind > 0) {
    return {
      action: "sync",
      label: `Sync (${repo.behind}↓ ${repo.ahead}↑)`,
      icon: "refresh-cw",
      enabled: true,
      tooltip: `Pull ${count(repo.behind, "commit")} and push ${count(repo.ahead, "commit")}`,
    };
  }

  if (repo.hasUpstream && repo.ahead > 0) {
    return {
      action: "push",
      label: `Push (${repo.ahead})`,
      icon: "upload",
      enabled: true,
      tooltip: `Push ${count(repo.ahead, "commit")} to the remote`,
    };
  }

  if (!repo.hasUpstream && repo.hasCommits) {
    return {
      action: "publish",
      label: "Publish branch",
      icon: "upload",
      enabled: true,
      tooltip: "Push this branch to the remote and track it",
    };
  }

  return {
    action: "none",
    label: "Commit",
    icon: "check",
    enabled: false,
    tooltip: repo.behind > 0 ? "Nothing to commit — pull to catch up" : "Nothing to commit",
  };
}

function commitState(repo: RepoSnapshot): CommitButtonState {
  const base = { action: "commit" as const, label: "Commit", icon: "check" };

  if (repo.merging) {
    return { ...base, enabled: false, tooltip: "Resolve the merge conflicts first" };
  }
  if (!repo.hasMessage) {
    return { ...base, enabled: false, tooltip: "Enter a commit message" };
  }
  return {
    ...base,
    enabled: true,
    tooltip: `Commit ${count(repo.changeCount, "file")}`,
  };
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

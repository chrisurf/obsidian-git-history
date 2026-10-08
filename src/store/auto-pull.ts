/**
 * Whether the background timer may pull on its own.
 *
 * A pull that nobody asked for has to be one that cannot go wrong, so the
 * answer is yes only for a fast-forward into a clean tree: nothing of the
 * user's own is waiting to be merged, rebased or overwritten. Everything else —
 * local commits, uncommitted edits, a merge in progress — is left to the Sync
 * button, where the user sees what happens.
 */
export interface AutoPullSnapshot {
  /** Every entry `git status` reports, untracked files included. */
  changeCount: number;
  ahead: number;
  behind: number;
  hasUpstream: boolean;
  merging: boolean;
}

export function canAutoPull(repo: AutoPullSnapshot): boolean {
  return (
    repo.hasUpstream &&
    repo.behind > 0 &&
    repo.ahead === 0 &&
    repo.changeCount === 0 &&
    !repo.merging
  );
}

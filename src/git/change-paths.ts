import type { FileStatus } from "../types";

/**
 * The two halves of a status entry: what the index holds against HEAD, and
 * what the worktree holds against the index. Staging and discarding act on the
 * worktree half, unstaging on the index half.
 */
export type ChangeSide = "index" | "worktree";

/**
 * The paths git has to be given to act on one side of an entry.
 *
 * A rename involves its old path only on the side the rename happened on. Once
 * a rename is staged the old path is in neither the index nor the worktree, so
 * naming it to `add` or `checkout` fails the whole command, which is how a
 * renamed note that was edited again could not be staged at all. A copy never
 * brings its source along: the source is a file of its own, and unstaging the
 * copy must not unstage it too.
 */
export function pathsFor(file: FileStatus, side: ChangeSide): string[] {
  const code = side === "index" ? file.indexStatus : file.workingStatus;
  return file.originalPath && code === "R" ? [file.path, file.originalPath] : [file.path];
}

/**
 * The path a rename came from, on whichever side it happened. A diff needs it
 * to show the rename as one; given the new path alone, git reports a new file.
 */
export function renamedFrom(file: FileStatus): string | undefined {
  return file.indexStatus === "R" || file.workingStatus === "R" ? file.originalPath : undefined;
}

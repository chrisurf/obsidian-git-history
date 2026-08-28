/**
 * The PATH the user actually has, rather than the one Obsidian was handed.
 *
 * Obsidian is a GUI application. On macOS launchd starts it with
 * `/usr/bin:/bin:/usr/sbin:/sbin`, on Linux with whatever the desktop session
 * inherited — neither is the PATH the login shell assembles from its profile.
 * Everything installed through Homebrew, pyenv, asdf, nvm or a package manager
 * that writes to `~/.local/bin` is therefore invisible to anything the plugin
 * spawns, while being the first hit in the user's own terminal.
 *
 * That gap is not cosmetic. On macOS `/usr/bin/git` and `/usr/bin/python3` are
 * not git and python at all: they are Apple's developer-tools stubs, which look
 * the real tool up through `xcode-select` and fail outright when the Xcode
 * installation they point at is broken or half-updated. Resolving by bare name
 * lands on the stub; the user's own shell never gets near it.
 *
 * So the PATH is asked of the login shell once per session, the way VS Code and
 * the `fix-path` family of packages do it: run the shell as a login and
 * interactive shell so it reads the same profile it reads for the user, have it
 * print `$PATH` between two markers, and keep only what lies between them — a
 * profile that greets its user with a banner, a fortune or a version notice
 * would otherwise be part of the answer.
 */

const MARKER_START = "__gh_path_start__";
const MARKER_END = "__gh_path_end__";

/** Runs a command and resolves with its stdout. Injected so tests need no shell. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

export interface LoginPathCommand {
  file: string;
  args: string[];
}

/**
 * The command that makes a shell print its PATH.
 *
 * fish keeps `$PATH` as a list rather than a colon-joined string, so the same
 * line would come back space-separated there and parse into one nonsensical
 * entry. It gets its own spelling; every other shell in practical use answers
 * to the POSIX one.
 */
export function loginPathCommand(shell: string): LoginPathCommand {
  const isFish = /(^|\/)fish$/.test(shell);
  const value = isFish ? "(string join : $PATH)" : '"$PATH"';
  return {
    file: shell,
    args: ["-ilc", `printf '%s%s%s' '${MARKER_START}' ${value} '${MARKER_END}'`],
  };
}

/**
 * The directories between the markers, in order.
 *
 * The start marker is searched from the end: a profile running under `set -x`
 * traces the command itself before running it, and the trace contains the
 * markers too. The real answer is always the last one printed.
 *
 * Relative and empty PATH entries are dropped. Both are legal and both mean
 * "the working directory", which for a plugin spawning binaries on a user's
 * behalf is the one place a lookup must never reach.
 */
export function parseLoginPath(output: string): string[] {
  const from = output.lastIndexOf(MARKER_START);
  if (from < 0) return [];
  const to = output.indexOf(MARKER_END, from + MARKER_START.length);
  if (to < 0) return [];

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const entry of output.slice(from + MARKER_START.length, to).split(":")) {
    const dir = entry.trim();
    if (!dir.startsWith("/") || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/**
 * Asks the login shell for its PATH, or gives back nothing.
 *
 * Nothing is a valid answer and the caller is expected to carry on with the
 * environment it already has: a shell that does not understand `-ilc`, a
 * profile that blocks on input until the timeout kills it, or a `SHELL` naming
 * a binary that is no longer installed are all cases where the plugin should
 * degrade to Obsidian's own PATH rather than refuse to work.
 */
export async function readLoginPath(
  shell: string | undefined,
  run: CommandRunner,
  timeoutMs = 5000,
): Promise<string[]> {
  if (!shell) return [];
  const { file, args } = loginPathCommand(shell);
  try {
    return parseLoginPath(await run(file, args, timeoutMs));
  } catch {
    return [];
  }
}

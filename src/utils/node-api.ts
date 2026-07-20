/**
 * The Node APIs the plugin needs, behind hand-written types.
 *
 * Git runs through `child_process` and Obsidian's config folder is watched with
 * `fs`, but `@types/node` is not resolvable everywhere this code gets linted —
 * the community review type-checks without it, and every call then reads as
 * `any`, which its rules flag as unsafe. Describing the small surface actually
 * used and asserting it once here keeps every call site properly typed either
 * way, and keeps the assertions to a single reviewable file.
 */
import { execFile as nodeExecFile } from "child_process";
import { watch as nodeWatch } from "fs";

/** The subset of Node's ExecException the plugin reads. */
export interface ExecFileError extends Error {
  code?: number | string;
  killed?: boolean;
}

export interface ExecFileOptions {
  cwd: string;
  maxBuffer?: number;
  timeout?: number;
  env?: Record<string, string | undefined>;
}

/** Only stdin is used, for piping a patch into `git apply`. */
export interface ChildProcessHandle {
  stdin: {
    write(chunk: string): void;
    end(): void;
  } | null;
}

type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: (error: ExecFileError | null, stdout: string, stderr: string) => void,
) => ChildProcessHandle;

export const execFile = nodeExecFile as unknown as ExecFileFn;

export interface FileWatcher {
  close(): void;
}

type WatchFn = (
  path: string,
  options: { recursive?: boolean },
  listener: (event: string, filename: string | null) => void,
) => FileWatcher;

export const watchPath = nodeWatch as unknown as WatchFn;

// Declared rather than imported: git inherits the environment it is spawned
// with, and this keeps the type local instead of depending on @types/node.
declare const process: { env?: Record<string, string | undefined> } | undefined;

/** Process environment, or an empty one where it is unavailable. */
export function processEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : (process?.env ?? {});
}

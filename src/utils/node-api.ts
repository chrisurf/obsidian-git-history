/**
 * The Node APIs the plugin needs, behind hand-written types.
 *
 * Git runs through `child_process`, but `@types/node` is not resolvable
 * everywhere this code gets linted — the community review type-checks without
 * it, and every call then reads as `any`, which its rules flag as unsafe.
 * Describing the small surface actually used and asserting it once here keeps
 * every call site properly typed either way, and keeps the assertions to a
 * single reviewable file.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "child_process";
import { readFile as nodeReadFile, writeFile as nodeWriteFile } from "fs/promises";

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

// Declared rather than imported: git inherits the environment it is spawned
// with, and this keeps the type local instead of depending on @types/node.
declare const process: { env?: Record<string, string | undefined> } | undefined;

/** Process environment, or an empty one where it is unavailable. */
export function processEnv(): Record<string, string | undefined> {
  return typeof process === "undefined" ? {} : (process?.env ?? {});
}

type ReadFileFn = (path: string, encoding: "utf-8") => Promise<string>;
type WriteFileFn = (path: string, data: string, encoding: "utf-8") => Promise<void>;

export const readFile = nodeReadFile as unknown as ReadFileFn;
export const writeFile = nodeWriteFile as unknown as WriteFileFn;

/** Subset of Node's Readable the terminal reads from. */
export interface ReadableStream {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): void;
  on(event: "close", listener: () => void): void;
}

/** Subset of Node's Writable the terminal writes to. */
export interface WritableStream {
  write(chunk: string): void;
}

export interface SpawnedProcess {
  stdout: ReadableStream | null;
  stderr: ReadableStream | null;
  stdin: WritableStream | null;
  pid?: number;
  on(event: "close", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  shell?: boolean;
}

type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess;

export const spawn = nodeSpawn as unknown as SpawnFn;

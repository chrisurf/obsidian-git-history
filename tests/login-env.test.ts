// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { loginPathCommand, parseLoginPath, readLoginPath } from "../src/utils/login-env";

const START = "__gh_path_start__";
const END = "__gh_path_end__";
const wrap = (path: string): string => `${START}${path}${END}`;

describe("the command that asks a shell for its PATH", () => {
  it("runs the shell as a login and interactive shell, so it reads the profile", () => {
    const { file, args } = loginPathCommand("/bin/zsh");
    expect(file).toBe("/bin/zsh");
    expect(args[0]).toBe("-ilc");
    expect(args[1]).toContain('"$PATH"');
  });

  it("joins the list itself for fish, which does not keep PATH colon-separated", () => {
    expect(loginPathCommand("/opt/homebrew/bin/fish").args[1]).toContain("string join : $PATH");
  });

  it("does not mistake a shell whose name merely ends in those letters", () => {
    expect(loginPathCommand("/bin/selfish").args[1]).toContain('"$PATH"');
  });
});

describe("reading the PATH out of what the shell printed", () => {
  it("keeps the directories, in order", () => {
    expect(parseLoginPath(wrap("/opt/homebrew/bin:/usr/bin:/bin"))).toEqual([
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ]);
  });

  /**
   * The reason for the markers: profiles print things. A banner, a version
   * notice, a fortune — all of it arrives on the same stream as the answer.
   */
  it("ignores whatever the profile printed around it", () => {
    const noisy = `Welcome back!\nnvm: v20 in use\n${wrap("/usr/local/bin:/usr/bin")}\n`;
    expect(parseLoginPath(noisy)).toEqual(["/usr/local/bin", "/usr/bin"]);
  });

  /**
   * A profile running under `set -x` traces the command before running it, so
   * the markers show up twice. The answer is the last one printed.
   */
  it("takes the last answer when the command was echoed first", () => {
    const traced = `+ printf %s%s%s ${START} "$PATH" ${END}\n${wrap("/opt/homebrew/bin")}`;
    expect(parseLoginPath(traced)).toEqual(["/opt/homebrew/bin"]);
  });

  it("drops relative and empty entries, which would resolve against the vault", () => {
    expect(parseLoginPath(wrap("/usr/bin::.:bin:../tools:/bin"))).toEqual(["/usr/bin", "/bin"]);
  });

  it("keeps a directory only once", () => {
    expect(parseLoginPath(wrap("/usr/bin:/bin:/usr/bin"))).toEqual(["/usr/bin", "/bin"]);
  });

  it("gives back nothing when the markers never arrived", () => {
    expect(parseLoginPath("command not found: printf")).toEqual([]);
    expect(parseLoginPath(`${START}/usr/bin`)).toEqual([]);
  });
});

describe("asking the login shell", () => {
  it("passes the shell's answer through", async () => {
    const run = vi.fn().mockResolvedValue(wrap("/opt/homebrew/bin:/usr/bin"));
    expect(await readLoginPath("/bin/zsh", run)).toEqual(["/opt/homebrew/bin", "/usr/bin"]);
    expect(run).toHaveBeenCalledOnce();
  });

  /**
   * Every failure here is a shrug, not an error: the caller carries on with the
   * environment Obsidian gave it, which is what the plugin did before any of
   * this existed.
   */
  it("gives back nothing when the shell fails, hangs or is not there", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("ENOENT"));
    expect(await readLoginPath("/bin/nope", failing)).toEqual([]);
  });

  it("does not run anything when the environment names no shell", async () => {
    const run = vi.fn();
    expect(await readLoginPath(undefined, run)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

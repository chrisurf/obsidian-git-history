// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { ExecEnvironment } from "../src/utils/exec-env";

const CLT_GIT = "/Library/Developer/CommandLineTools/usr/bin/git";
const STUB_GIT = "/usr/bin/git";

/**
 * A machine seen the way Obsidian sees one: the PATH launchd hands a GUI
 * application, and a login shell that knows better. `working` names the only
 * binaries that answer; everything else fails the way a missing file does.
 */
function machine(options: { loginPath?: string[]; working: string[] }) {
  const probed: string[] = [];
  const run = vi.fn((file: string, args: readonly string[]) => {
    if (args[0] === "-ilc") {
      const dirs = options.loginPath;
      if (!dirs) return Promise.reject(new Error("no login shell"));
      return Promise.resolve(`__gh_path_start__${dirs.join(":")}__gh_path_end__`);
    }
    probed.push(file);
    if (!options.working.includes(file)) return Promise.reject(new Error("ENOENT"));
    return Promise.resolve(file.includes("python") ? "gh-pty-ok" : "git version 2.50.1");
  });
  return { probed, run };
}

describe("finding git the way a real machine offers it", () => {
  /**
   * The whole point of the change. Under launchd's PATH the first git on offer
   * is the stub in /usr/bin, and the plugin used to take it.
   */
  it("prefers the login shell's git over the one on Obsidian's own PATH", async () => {
    const { run } = machine({
      loginPath: ["/opt/homebrew/bin", "/usr/bin"],
      working: ["/opt/homebrew/bin/git", STUB_GIT],
    });
    const env = new ExecEnvironment({ isWindows: false, run });
    const { binary } = await env.git();
    expect(binary?.path).toBe("/opt/homebrew/bin/git");
  });

  /**
   * `/usr/bin/git` is not git: it asks xcode-select where the real one is. On a
   * machine with no developer tools, running it makes macOS put up its own
   * "requires the command line developer tools" dialog — from Obsidian, which
   * is not who the user was talking to. Addressing the same binary directly
   * avoids the errand and the dialog with it.
   */
  it("reaches the toolchain binary before it would run the stub", async () => {
    const { probed, run } = machine({
      loginPath: ["/usr/bin", "/bin"],
      working: [CLT_GIT, STUB_GIT],
    });
    const env = new ExecEnvironment({ isWindows: false, run });
    const { binary } = await env.git();

    expect(binary?.path).toBe(CLT_GIT);
    expect(probed).not.toContain(STUB_GIT);
  });

  /**
   * And when nothing else anywhere answered, the stub does get its turn: at
   * that point there really is no git, and the system offering to install one
   * is the most useful thing left.
   */
  it("still falls back to the stub when nothing else answered", async () => {
    const { probed, run } = machine({ loginPath: ["/usr/bin"], working: [STUB_GIT] });
    const env = new ExecEnvironment({ isWindows: false, run });
    const { binary } = await env.git();

    expect(binary?.path).toBe(STUB_GIT);
    expect(probed[probed.length - 1]).toBe(STUB_GIT);
  });

  it("carries on with Obsidian's PATH when the login shell cannot be read", async () => {
    const { run } = machine({ working: ["/opt/homebrew/bin/git"] });
    const env = new ExecEnvironment({ isWindows: false, run });
    const { binary } = await env.git();
    // Nothing came back from the shell, so only the known locations are left.
    expect(binary?.path).toBe("/opt/homebrew/bin/git");
    expect(await env.pathDirs()).toEqual([]);
  });

  it("puts the login shell's directories in front of the ones Obsidian had", async () => {
    const { run } = machine({ loginPath: ["/opt/homebrew/bin"], working: [] });
    const env = new ExecEnvironment({ isWindows: false, run });
    const path = (await env.env()).PATH ?? "";
    expect(path.startsWith("/opt/homebrew/bin")).toBe(true);
    for (const dir of (process.env.PATH ?? "").split(":")) {
      if (dir) expect(path).toContain(dir);
    }
  });
});

describe("finding a python that can actually open a terminal", () => {
  /**
   * A python that exists but cannot import `pty` is no use to the terminal, and
   * the old code had no way of knowing that before spawning a shell into it.
   */
  it("walks past one that exists but cannot open a pty", async () => {
    const { probed, run } = machine({
      loginPath: ["/opt/homebrew/bin", "/usr/local/bin"],
      working: ["/usr/local/bin/python3"],
    });
    const env = new ExecEnvironment({ isWindows: false, run });
    const { binary } = await env.python();

    expect(probed[0]).toBe("/opt/homebrew/bin/python3");
    expect(binary?.path).toBe("/usr/local/bin/python3");
  });

  /** Same reasoning as git: the stub is a last resort, not a first guess. */
  it("does not run the python stub while something better answers", async () => {
    const { probed, run } = machine({
      loginPath: ["/usr/bin", "/opt/homebrew/bin"],
      working: ["/opt/homebrew/bin/python3", "/usr/bin/python3"],
    });
    const env = new ExecEnvironment({ isWindows: false, run });
    const { binary } = await env.python();

    expect(binary?.path).toBe("/opt/homebrew/bin/python3");
    expect(probed).not.toContain("/usr/bin/python3");
  });

  it("takes the path from the settings first", async () => {
    const { run } = machine({
      loginPath: ["/opt/homebrew/bin"],
      working: ["/my/own/python3", "/opt/homebrew/bin/python3"],
    });
    const env = new ExecEnvironment({
      isWindows: false,
      run,
      configuredPython: () => "/my/own/python3",
    });
    expect((await env.python()).binary?.path).toBe("/my/own/python3");
  });

  it("does not strand the terminal on a configured path that cannot run", async () => {
    const { run } = machine({
      loginPath: ["/opt/homebrew/bin"],
      working: ["/opt/homebrew/bin/python3"],
    });
    const env = new ExecEnvironment({
      isWindows: false,
      run,
      configuredPython: () => "/gone/python3",
    });
    expect((await env.python()).binary?.path).toBe("/opt/homebrew/bin/python3");
  });
});

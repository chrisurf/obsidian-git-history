// @vitest-environment node
import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { injectionFor, shellCommand } from "../src/terminal/startup-script";

/**
 * The other half of startup-script.test.ts: that one checks what is written,
 * this one runs the real shell against it.
 *
 * It exists because of what the string tests cannot see. `bash -i --rcfile x`
 * builds perfectly and starts a shell that ignores the file — bash stops
 * reading long options after the first single-character one — and every
 * assertion about the arguments was green while nothing was ever loaded. An
 * injection fails by doing nothing, so the only test that can catch it is one
 * that asks a shell whether the script arrived.
 *
 * Shells that are not installed are skipped rather than faked: a fake would
 * have agreed with the broken argument order too.
 */

const SCRIPT = "GH_MARKER=loaded-ok";

const installed = (shell: string): boolean =>
  spawnSync("/bin/sh", ["-c", `command -v ${shell}`]).status === 0;

interface Home {
  /** Files the user already had, written before the shell is started. */
  files: Record<string, string>;
}

/**
 * Starts one shell exactly as a session would, with `probe` typed into it, and
 * hands back everything it said.
 */
function run(shell: string, home: Home, probe: string): string {
  const root = mkdtempSync(join(tmpdir(), "gh-shell-test-"));
  const dir = join(root, "session");
  const homeDir = join(root, "home");
  mkdirSync(dir);
  mkdirSync(homeDir);

  for (const [name, content] of Object.entries(home.files)) {
    writeFileSync(join(homeDir, name), `${content}\n`);
  }

  const injection = injectionFor({ shell, script: SCRIPT, dir, env: {} });
  for (const file of injection.files) writeFileSync(join(dir, file.name), file.content);

  const command = shellCommand(shell, "mac", true, injection);
  const result = spawnSync(command.file, [...command.args], {
    input: probe,
    encoding: "utf8",
    timeout: 20000,
    env: { HOME: homeDir, PATH: process.env.PATH ?? "", TERM: "dumb", ...injection.env },
  });

  rmSync(root, { recursive: true, force: true });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

const probe = (...names: string[]): string =>
  `echo "RESULT ${names.map((n) => `${n}=$${n}`).join(" ")}"\n`;

const line = (output: string): string =>
  output.split("\n").find((l) => l.includes("RESULT ")) ?? output;

describe.skipIf(!installed("zsh"))("zsh, for real", () => {
  it("loads the script, after the user's own files", () => {
    const output = run(
      "zsh",
      { files: { ".zshenv": "GH_ZSHENV=yes", ".zshrc": "GH_ZSHRC=yes" } },
      probe("GH_MARKER", "GH_ZSHENV", "GH_ZSHRC"),
    );
    expect(line(output)).toContain("GH_MARKER=loaded-ok");
    expect(line(output)).toContain("GH_ZSHENV=yes");
    expect(line(output)).toContain("GH_ZSHRC=yes");
  });

  /**
   * The reason there is a precmd hook as well as a .zshrc. A configuration
   * that keeps zsh out of $HOME sets ZDOTDIR in its own .zshenv, which takes
   * every later file away from the session's directory — .zshrc included.
   */
  it("still loads it when the user's own .zshenv redirects ZDOTDIR", () => {
    const output = run(
      "zsh",
      { files: { ".zshenv": "export ZDOTDIR=$HOME", ".zshrc": "GH_ZSHRC=yes" } },
      probe("GH_MARKER", "GH_ZSHRC"),
    );
    expect(line(output)).toContain("GH_MARKER=loaded-ok");
    expect(line(output)).toContain("GH_ZSHRC=yes");
  });

  it("hands ZDOTDIR back before the session is used", () => {
    const output = run("zsh", { files: {} }, probe("ZDOTDIR", "HOME"));
    const result = line(output);
    const zdotdir = /ZDOTDIR=(\S*)/.exec(result)?.[1];
    const home = /HOME=(\S*)/.exec(result)?.[1];
    expect(zdotdir).toBe(home);
  });
});

describe.skipIf(!installed("bash"))("bash, for real", () => {
  /**
   * bash gives up its -l for the rcfile, so the files a login shell reads have
   * to be read by the rcfile instead — and exactly once, which is why only the
   * first of .bash_profile, .bash_login and .profile is taken.
   */
  it("loads the script, after the login files it would have read itself", () => {
    const output = run(
      "bash",
      {
        files: {
          ".bash_profile": 'GH_PROFILE=yes\n. "$HOME/.bashrc"',
          ".bashrc": "GH_BASHRC=yes",
        },
      },
      probe("GH_MARKER", "GH_PROFILE", "GH_BASHRC"),
    );
    expect(line(output)).toContain("GH_MARKER=loaded-ok");
    expect(line(output)).toContain("GH_PROFILE=yes");
    expect(line(output)).toContain("GH_BASHRC=yes");
  });

  it("reads only the first login file, the way a login shell does", () => {
    const output = run(
      "bash",
      { files: { ".bash_profile": "GH_FIRST=yes", ".profile": "GH_SECOND=yes" } },
      probe("GH_MARKER", "GH_FIRST", "GH_SECOND"),
    );
    expect(line(output)).toContain("GH_FIRST=yes");
    expect(line(output)).toContain("GH_SECOND=");
    expect(line(output)).not.toContain("GH_SECOND=yes");
  });
});

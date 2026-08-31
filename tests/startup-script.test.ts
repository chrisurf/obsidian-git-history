// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  NO_INJECTION,
  injectionFor,
  shellCommand,
  startupMechanism,
} from "../src/terminal/startup-script";
import type { StartupInjection } from "../src/terminal/startup-script";

const DIR = "/tmp/gh-session";
const SCRIPT = "alias gs='git status'";

const inject = (shell: string, script = SCRIPT, env = {}): StartupInjection =>
  injectionFor({ shell, script, dir: DIR, env });

const file = (injection: StartupInjection, name: string): string => {
  const found = injection.files.find((f) => f.name === name);
  if (!found) throw new Error(`no ${name} among ${injection.files.map((f) => f.name).join(", ")}`);
  return found.content;
};

describe("no script", () => {
  it("leaves the shell exactly as it was", () => {
    expect(inject("/bin/zsh", "")).toBe(NO_INJECTION);
    expect(inject("/bin/zsh", "  \n\t ")).toBe(NO_INJECTION);
  });

  /**
   * The flags the backends used to build themselves. A session that switches
   * the setting on and off has to come back to the same command it had before,
   * or the setting quietly changes what kind of shell you get.
   */
  it("asks for the same shell the backends used to build", () => {
    expect(shellCommand("/bin/zsh", "mac", true, NO_INJECTION).args).toEqual(["-il"]);
    expect(shellCommand("/bin/zsh", "mac", false, NO_INJECTION).args).toEqual(["-i"]);
    expect(shellCommand("powershell.exe", "win", false, NO_INJECTION).args).toEqual([]);
  });
});

describe("zsh", () => {
  const injection = inject("/bin/zsh");

  it("takes zsh's own search directory over, and remembers the real one", () => {
    expect(injection.method).toBe("rc");
    expect(injection.env).toEqual({ ZDOTDIR: DIR, GIT_HISTORY_ZDOTDIR: "" });
    expect(injection.args).toEqual([]);
    expect(injection.login).toBe(true);
    expect(injection.stdin).toBeNull();
  });

  it("passes an existing ZDOTDIR through rather than losing it", () => {
    const withZdotdir = inject("/bin/zsh", SCRIPT, { ZDOTDIR: "/home/me/.config/zsh" });
    expect(withZdotdir.env.GIT_HISTORY_ZDOTDIR).toBe("/home/me/.config/zsh");
  });

  it("hands every one of zsh's files back to the user's own", () => {
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
      expect(file(injection, name)).toContain(`. "$GIT_HISTORY_ZDOTDIR/${name}"`);
    }
  });

  it("writes the script itself, with the newline a sourced file needs", () => {
    expect(file(injection, "startup.sh")).toBe(`${SCRIPT}\n`);
  });

  /**
   * The two ways in, and why there are two: a configuration that points
   * ZDOTDIR somewhere of its own never reaches our .zshrc, and the hook
   * registered in .zshenv is what still fires. The guard is what keeps that
   * from loading the script twice where both paths survive.
   */
  it("loads the script from .zshrc and from a precmd hook, once either way", () => {
    expect(file(injection, ".zshrc")).toContain("git_history_startup");
    const zshenv = file(injection, ".zshenv");
    expect(zshenv).toContain("add-zsh-hook precmd git_history_startup");
    expect(zshenv).toContain(`source '${DIR}/startup.sh'`);
    expect(zshenv).toContain('[ -n "$GIT_HISTORY_LOADED" ] && return 0');
  });

  it("puts ZDOTDIR back before handing the session over", () => {
    expect(file(injection, ".zshenv")).toContain("ZDOTDIR=$GIT_HISTORY_ZDOTDIR");
  });

  it("keeps the login shell it always started", () => {
    expect(shellCommand("/bin/zsh", "mac", true, injection).args).toEqual(["-il"]);
  });
});

describe("bash", () => {
  const injection = inject("/bin/bash");

  it("is handed an rc file, since it has no ZDOTDIR", () => {
    expect(injection.method).toBe("rc");
    expect(injection.args).toEqual(["--rcfile", `${DIR}/bashrc`]);
    expect(injection.env).toEqual({});
  });

  /**
   * bash ignores --rcfile for a login shell, so the -l has to go — and with it
   * the profile files a login shell reads, which the rc file reads instead. In
   * bash's own order, and only the first that exists, or a .bash_profile that
   * sources .bashrc would run it twice.
   */
  it("gives up the login flag and reads the login files itself", () => {
    expect(injection.login).toBe(false);
    expect(shellCommand("/bin/bash", "mac", true, injection).args).toEqual([
      "--rcfile",
      `${DIR}/bashrc`,
      "-i",
    ]);

    const rc = file(injection, "bashrc");
    expect(rc).toContain("/etc/profile");
    expect(rc.indexOf('"$HOME/.bash_profile"')).toBeLessThan(rc.indexOf('"$HOME/.profile"'));
    expect(rc).toContain("break");
    expect(rc.trimEnd().endsWith(`. '${DIR}/startup.sh'`)).toBe(true);
  });
});

/**
 * bash reads a long option only while it has seen no single-character one, so
 * `-i --rcfile x` starts a shell that ignores the file — an injection that
 * fails by doing nothing at all, which is the failure this whole file is
 * arranged to avoid.
 */
describe("the order the flags go in", () => {
  it("puts the injection before the interactive flag", () => {
    const bash = inject("/bin/bash");
    expect(shellCommand("/bin/bash", "mac", true, bash).args[0]).toBe("--rcfile");
    const fish = inject("/usr/bin/fish");
    expect(shellCommand("/usr/bin/fish", "mac", true, fish).args).toEqual([
      "-C",
      `source '${DIR}/startup.fish'`,
      "-il",
    ]);
  });
});

describe("fish", () => {
  const injection = inject("/opt/homebrew/bin/fish");

  it("needs no wrapper file at all", () => {
    expect(injection.args).toEqual(["-C", `source '${DIR}/startup.fish'`]);
    expect(injection.files.map((f) => f.name)).toEqual(["startup.fish"]);
    expect(injection.login).toBe(true);
  });
});

describe("a plain posix shell", () => {
  const injection = inject("/bin/dash", SCRIPT, { ENV: "/home/me/.shrc" });

  it("goes in through $ENV, and keeps the one that was already there", () => {
    expect(injection.env).toEqual({ ENV: `${DIR}/shrc`, GIT_HISTORY_ENV: "/home/me/.shrc" });
    expect(file(injection, "shrc")).toContain('. "$GIT_HISTORY_ENV"');
  });
});

describe("a shell with no way in", () => {
  it("says so, and types the line in instead", () => {
    const injection = inject("/usr/local/bin/oil");
    expect(injection.method).toBe("stdin");
    expect(injection.files.map((f) => f.name)).toEqual(["startup.sh"]);
    expect(injection.env).toEqual({});
    expect(injection.args).toEqual([]);
    expect(injection.stdin).toBe(`. '${DIR}/startup.sh'\n`);
  });

  it("speaks PowerShell to PowerShell and cmd to cmd.exe", () => {
    expect(inject("C:\\pwsh.exe").stdin).toBe(`. '${DIR}/startup.ps1'\n`);
    expect(inject("C:\\Windows\\system32\\cmd.exe").stdin).toBe(`call "${DIR}/startup.cmd"\n`);
  });
});

describe("quoting the path the script was written to", () => {
  it("survives a directory name with a quote in it", () => {
    const odd = injectionFor({ shell: "/bin/zsh", script: SCRIPT, dir: "/tmp/o'x", env: {} });
    expect(file(odd, ".zshenv")).toContain(`source '/tmp/o'\\''x/startup.sh'`);
  });

  it("uses each shell's own spelling of an escape", () => {
    const dir = "/tmp/o'x";
    expect(injectionFor({ shell: "fish", script: SCRIPT, dir, env: {} }).args[1]).toBe(
      "source '/tmp/o\\'x/startup.fish'",
    );
    expect(injectionFor({ shell: "pwsh", script: SCRIPT, dir, env: {} }).stdin).toBe(
      ". '/tmp/o''x/startup.ps1'\n",
    );
  });
});

describe("what the setup report is told", () => {
  it("names the mechanism a shell would get, without writing anything", () => {
    expect(startupMechanism("/bin/zsh")).toEqual({ method: "rc", label: "ZDOTDIR" });
    expect(startupMechanism("/bin/bash")).toEqual({ method: "rc", label: "--rcfile" });
    expect(startupMechanism("/bin/nothing")).toEqual({
      method: "stdin",
      label: "typed into the shell",
    });
  });

  it("does not care how the shell was spelled", () => {
    expect(startupMechanism("/usr/local/bin/ZSH")).toEqual(startupMechanism("zsh"));
    expect(startupMechanism("C:\\Program Files\\PowerShell\\pwsh.exe").method).toBe("stdin");
  });
});

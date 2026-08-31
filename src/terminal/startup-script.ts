/**
 * The startup script from the settings, and how it reaches the shell.
 *
 * The obvious implementation — type `source …` into the terminal once the
 * shell is up — is the one this file exists to avoid. It echoes, it lands in
 * the history, and it runs after the first prompt has already been drawn, so
 * anything the script changes about the prompt only takes effect on the second
 * one. What a user means by "load this at startup" is what their own rc file
 * does, and every shell already has a way of being handed one more.
 *
 * So each shell gets the mechanism it actually has: zsh a ZDOTDIR of its own
 * whose files hand straight back to the user's, bash a `--rcfile`, fish an
 * `--init-command`, POSIX shells `$ENV`. Where there is no such mechanism —
 * PowerShell, cmd.exe, a shell this table has never heard of — the injection
 * says so and falls back to typing it in, which is visibly worse and honest
 * about it rather than silently absent.
 *
 * Everything here is pure string building. The files it describes are written
 * by the session manager, which owns the directory they go into.
 */
import { joinPath } from "../utils/node-api";
import type { PlatformName, ShellCommand } from "./pty-backend";

/** How the script got in, or that there is none. */
export type InjectionMethod = "none" | "rc" | "stdin";

export interface StartupFile {
  /** Name inside the session's own directory. */
  name: string;
  content: string;
}

export interface StartupInjection {
  method: InjectionMethod;
  /** The mechanism, named for the setup report. */
  label: string;
  files: readonly StartupFile[];
  /** Environment the shell has to be started with for the mechanism to work. */
  env: Readonly<Record<string, string>>;
  /** Arguments for the shell itself, not for the pty bridge in front of it. */
  args: readonly string[];
  /** Whether the shell still gets its login flag. Only bash gives it up. */
  login: boolean;
  /** Written into the shell once it is up. Only the stdin method uses it. */
  stdin: string | null;
}

export interface StartupOptions {
  /** Path of the shell binary, as the session will start it. */
  shell: string;
  /** The script as the user typed it into the settings. */
  script: string;
  /** The session's own directory, where the files below will be written. */
  dir: string;
  /** The environment the shell will be started in, read for ZDOTDIR and ENV. */
  env: Readonly<Record<string, string | undefined>>;
}

/** What a session gets when the setting is empty: the shell as it always was. */
export const NO_INJECTION: StartupInjection = {
  method: "none",
  label: "No startup script",
  files: [],
  env: {},
  args: [],
  login: true,
  stdin: null,
};

interface StartupContext {
  /** Absolute path of the file the settings script was written to. */
  script: string;
  dir: string;
  env: Readonly<Record<string, string | undefined>>;
}

interface BuiltInjection {
  files: StartupFile[];
  env: Record<string, string>;
  args: string[];
  stdin: string | null;
}

interface ShellStartup {
  /** Basenames this entry answers for. Empty means "everything else". */
  names: readonly string[];
  method: "rc" | "stdin";
  label: string;
  /** Name the settings script itself is written under. */
  scriptFile: string;
  login: boolean;
  build(ctx: StartupContext): BuiltInjection;
}

/**
 * zsh reads five files, all of them from `$ZDOTDIR`, and re-reads that variable
 * between them. Pointing it at a directory of our own and forwarding each file
 * to the user's is therefore the whole mechanism — with one hole: a `.zshenv`
 * that sets `ZDOTDIR` itself (a common way to keep zsh out of `$HOME`) takes
 * the later stages away from us again.
 *
 * Hence the precmd hook. It is registered in the one file that is always read,
 * runs after everything else and before the first prompt, and removes itself.
 * Whichever of the two paths survives the user's configuration, the script is
 * loaded exactly once — the flag, not the hook removal, is what guarantees the
 * "once".
 */
function zshEnv(ctx: StartupContext): string {
  return [
    header(),
    "#",
    "# zsh reads its files from $ZDOTDIR, which points at this directory for the",
    "# length of this session. Each file here hands straight back to your own.",
    ": ${GIT_HISTORY_ZDOTDIR:=$HOME}",
    '[ -r "$GIT_HISTORY_ZDOTDIR/.zshenv" ] && . "$GIT_HISTORY_ZDOTDIR/.zshenv"',
    "",
    "git_history_startup() {",
    '  [ -n "$GIT_HISTORY_LOADED" ] && return 0',
    "  GIT_HISTORY_LOADED=1",
    "  add-zsh-hook -d precmd git_history_startup 2>/dev/null",
    "  ZDOTDIR=$GIT_HISTORY_ZDOTDIR",
    "  unset GIT_HISTORY_ZDOTDIR",
    `  source ${shQuote(ctx.script)}`,
    "}",
    "autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd git_history_startup",
    "",
  ].join("\n");
}

/** One of the forwarding files. `.zshrc` also loads the script, in the place a
    user would have put it themselves. */
function zshForward(name: string, loadScript: boolean): string {
  const lines = [
    header(),
    `[ -r "$GIT_HISTORY_ZDOTDIR/${name}" ] && . "$GIT_HISTORY_ZDOTDIR/${name}"`,
  ];
  if (loadScript) {
    lines.push("(( $+functions[git_history_startup] )) && git_history_startup");
  }
  lines.push("");
  return lines.join("\n");
}

const ZSH: ShellStartup = {
  names: ["zsh"],
  method: "rc",
  label: "ZDOTDIR",
  scriptFile: "startup.sh",
  login: true,
  build: (ctx) => ({
    files: [
      { name: ".zshenv", content: zshEnv(ctx) },
      { name: ".zprofile", content: zshForward(".zprofile", false) },
      { name: ".zshrc", content: zshForward(".zshrc", true) },
      { name: ".zlogin", content: zshForward(".zlogin", false) },
    ],
    env: { ZDOTDIR: ctx.dir, GIT_HISTORY_ZDOTDIR: ctx.env.ZDOTDIR ?? "" },
    args: [],
    stdin: null,
  }),
};

/**
 * bash has no ZDOTDIR, and it ignores `--rcfile` when it is a login shell — so
 * the session drops `-l` and this file reads what a login shell would have
 * read, in bash's own order, before the script.
 *
 * Reproducing that order matters more than it looks: the terminal has started
 * `bash -il` since it shipped, and a setting that quietly turned every session
 * into a non-login shell would change PATH, prompt and rvm-style shims for
 * anyone who switches it on.
 */
const BASH: ShellStartup = {
  names: ["bash", "sh.bash"],
  method: "rc",
  label: "--rcfile",
  scriptFile: "startup.sh",
  login: false,
  build: (ctx) => ({
    files: [
      {
        name: "bashrc",
        content: [
          header(),
          "#",
          "# bash ignores --rcfile for a login shell, so this session starts without",
          "# -l and reads here what a login shell would have read, in the same order.",
          "[ -r /etc/profile ] && . /etc/profile",
          'for git_history_profile in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do',
          '  if [ -r "$git_history_profile" ]; then',
          '    . "$git_history_profile"',
          "    break",
          "  fi",
          "done",
          "unset git_history_profile",
          `. ${shQuote(ctx.script)}`,
          "",
        ].join("\n"),
      },
    ],
    env: {},
    args: ["--rcfile", joinPath(ctx.dir, "bashrc")],
    stdin: null,
  }),
};

/** fish needs no wrapper: `--init-command` runs after config.fish. */
const FISH: ShellStartup = {
  names: ["fish"],
  method: "rc",
  label: "--init-command",
  scriptFile: "startup.fish",
  login: true,
  build: (ctx) => ({
    files: [],
    env: {},
    args: ["-C", `source ${fishQuote(ctx.script)}`],
    stdin: null,
  }),
};

/**
 * dash, ksh and whatever `/bin/sh` is here read `$ENV` when they are
 * interactive, which is the only hook they have. A user who already points it
 * somewhere keeps that file.
 */
const POSIX: ShellStartup = {
  names: ["sh", "dash", "ash", "ksh", "ksh93", "mksh", "pdksh"],
  method: "rc",
  label: "$ENV",
  scriptFile: "startup.sh",
  login: true,
  build: (ctx) => ({
    files: [
      {
        name: "shrc",
        content: [
          header(),
          '[ -n "$GIT_HISTORY_ENV" ] && [ -r "$GIT_HISTORY_ENV" ] && . "$GIT_HISTORY_ENV"',
          "ENV=$GIT_HISTORY_ENV",
          "export ENV",
          "unset GIT_HISTORY_ENV",
          `. ${shQuote(ctx.script)}`,
          "",
        ].join("\n"),
      },
    ],
    env: { ENV: joinPath(ctx.dir, "shrc"), GIT_HISTORY_ENV: ctx.env.ENV ?? "" },
    args: [],
    stdin: null,
  }),
};

const POWERSHELL: ShellStartup = {
  names: ["pwsh", "powershell"],
  method: "stdin",
  label: "typed into the shell",
  scriptFile: "startup.ps1",
  login: true,
  build: (ctx) => ({
    files: [],
    env: {},
    args: [],
    stdin: `. ${psQuote(ctx.script)}\n`,
  }),
};

const CMD: ShellStartup = {
  names: ["cmd"],
  method: "stdin",
  label: "typed into the shell",
  scriptFile: "startup.cmd",
  login: true,
  build: (ctx) => ({
    files: [],
    env: {},
    args: [],
    stdin: `call "${ctx.script}"\n`,
  }),
};

/**
 * Anything else. Sourcing a file is POSIX, so the guess is a fair one, and it
 * is made where the user can see it: the setup report names this mechanism, and
 * the line is typed into the terminal in full view.
 */
const OTHER: ShellStartup = {
  names: [],
  method: "stdin",
  label: "typed into the shell",
  scriptFile: "startup.sh",
  login: true,
  build: (ctx) => ({
    files: [],
    env: {},
    args: [],
    stdin: `. ${shQuote(ctx.script)}\n`,
  }),
};

const SHELL_STARTUPS: readonly ShellStartup[] = [ZSH, BASH, FISH, POSIX, POWERSHELL, CMD];

/** How this shell would be given a startup script. Never fails: OTHER answers
    for everything the table does not name. */
export function startupFor(shell: string): ShellStartup {
  const name = shellName(shell);
  return SHELL_STARTUPS.find((entry) => entry.names.includes(name)) ?? OTHER;
}

/** What the setup report says about a shell, without writing anything. */
export function startupMechanism(shell: string): { method: InjectionMethod; label: string } {
  const entry = startupFor(shell);
  return { method: entry.method, label: entry.label };
}

export function injectionFor(opts: StartupOptions): StartupInjection {
  if (opts.script.trim() === "") return NO_INJECTION;

  const entry = startupFor(opts.shell);
  const script = joinPath(opts.dir, entry.scriptFile);
  const built = entry.build({ script, dir: opts.dir, env: opts.env });

  return {
    method: entry.method,
    label: entry.label,
    login: entry.login,
    files: [{ name: entry.scriptFile, content: withNewline(opts.script) }, ...built.files],
    env: built.env,
    args: built.args,
    stdin: built.stdin,
  };
}

/**
 * How the shell itself is invoked, injection included.
 *
 * The flags used to live in the backend table, which put the decision in the
 * wrong place: whether the shell is a login shell is a property of how it is
 * configured, not of which bridge opens the pty. `-il` with a terminal and `-i`
 * without it is what the backends did before, kept exactly.
 *
 * The injection goes first because bash insists on it — a long option after
 * `-i` is not read as an option at all, and `bash -i --rcfile x` opens a shell
 * that quietly ignores the file. No shell here minds the other order.
 */
export function shellCommand(
  shell: string,
  platform: PlatformName,
  tty: boolean,
  injection: StartupInjection,
): ShellCommand {
  // cmd.exe and PowerShell have no -i, and without a pty there is nothing
  // interactive to ask for anyway.
  if (platform === "win") return { file: shell, args: [...injection.args] };
  return { file: shell, args: [...injection.args, tty && injection.login ? "-il" : "-i"] };
}

/** "zsh" out of "/bin/zsh" or "C:\\…\\pwsh.exe". */
function shellName(shell: string): string {
  const base = shell.split(/[/\\]/).pop() ?? shell;
  return base.replace(/\.exe$/i, "").toLowerCase();
}

function header(): string {
  return "# Written by the Git History plugin for one terminal session.";
}

function withNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** POSIX single quoting, which has no escape inside the quotes — a quote ends
    them, is written on its own, and they start again. */
function shQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/** fish does take backslash escapes inside single quotes, and only these two. */
function fishQuote(value: string): string {
  return `'${value.replace(/[\\']/g, (c) => `\\${c}`)}'`;
}

/** PowerShell doubles the quote instead. */
function psQuote(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

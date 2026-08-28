/**
 * The environment the plugin runs other programs in.
 *
 * One place decides two things it used to leave to chance: which PATH a spawned
 * process gets, and which binary a name resolves to. Both git and the terminal
 * go through here, because both had the same latent bug — `execFile("git", …)`
 * and `spawn("python3", …)` are the same mistake written twice, and fixing it
 * in one of them would have left the other waiting to break.
 *
 * Everything is resolved lazily and then cached for the session: nothing is
 * probed until something is actually spawned, and a vault that never opens the
 * terminal never looks for a python.
 */
import { execFile, processEnv } from "./node-api";
import { BinaryResolver } from "./binary-resolver";
import type { Resolution } from "./binary-resolver";
import { readLoginPath } from "./login-env";
import type { CommandRunner } from "./login-env";

/**
 * Where a package manager puts these, tried after the user's own PATH.
 *
 * A safety net for the case where reading the login PATH failed — a shell that
 * does not speak `-ilc`, a profile that hangs — and not a replacement for it:
 * a pyenv or asdf install lives in neither of these places and is only ever
 * found through PATH.
 */
const KNOWN_GIT = ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/opt/local/bin/git"];
const KNOWN_PYTHON = [
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/opt/local/bin/python3",
  "/Library/Frameworks/Python.framework/Versions/Current/bin/python3",
];

/**
 * Apple's developer-tool stubs. Real binaries on a healthy machine, and a
 * `xcode-select` error message on a machine whose Xcode is broken or
 * half-updated, which is why they are tried only once nothing else answered.
 */
const FALLBACK_GIT = ["/usr/bin/git"];
const FALLBACK_PYTHON = ["/usr/bin/python3"];

/**
 * Perl is not one of the stubs — `/usr/bin/perl` is a real interpreter from
 * `/System/Library/Perl` — so its own location needs no demoting. Homebrew's is
 * listed first all the same, since a user who installed one meant it.
 */
const KNOWN_PERL = ["/opt/homebrew/bin/perl", "/usr/local/bin/perl", "/usr/bin/perl"];

const PROBE_TIMEOUT = 5000;
const LOGIN_SHELL_TIMEOUT = 5000;

/**
 * What the terminal actually needs from a python: version 3 and a `pty` module
 * that imports. Asking the same question the bridge asks is the point — a
 * candidate that passes this and then fails to start a shell is a bug worth
 * hearing about, not an expected outcome.
 */
const PTY_PROBE_TOKEN = "gh-pty-ok";
const PTY_PROBE_ARGS = [
  "-c",
  `import pty,sys;print('${PTY_PROBE_TOKEN}' if sys.version_info[0] >= 3 else '')`,
];

const PERL_PROBE_TOKEN = "gh-perl-ok";
const PERL_PROBE_ARGS = [
  "-e",
  `use POSIX ();use IO::Select;open(my $m,'+<','/dev/ptmx') or exit 1;print '${PERL_PROBE_TOKEN}';`,
];

export interface ExecEnvironmentOptions {
  isWindows: boolean;
  /** Reads the plugin setting, so a changed path is picked up without a reload. */
  configuredGit?: () => string | undefined;
  configuredPython?: () => string | undefined;
  /** Injected in tests; the default runs the command for real. */
  run?: CommandRunner;
}

/** What GitService needs from the environment, and all it is given. */
export interface GitCommandEnvironment {
  git(): Promise<Resolution>;
  env(extra?: Record<string, string | undefined>): Promise<Record<string, string | undefined>>;
}

export class ExecEnvironment implements GitCommandEnvironment {
  private pathDirsPromise: Promise<string[]> | null = null;
  private resolver: BinaryResolver;
  private run: CommandRunner;

  constructor(private opts: ExecEnvironmentOptions) {
    this.run = opts.run ?? runCommand;
    this.resolver = new BinaryResolver();
  }

  /**
   * The environment a spawned process should get: Obsidian's own, with the
   * login shell's PATH in front of it.
   *
   * In front of, not instead of — whatever Obsidian was started with stays
   * reachable at the end of the list. Replacing it outright would be the
   * shorter code and would drop a directory the user does have on a machine
   * where reading the login PATH half-worked.
   */
  async env(
    extra: Record<string, string | undefined> = {},
  ): Promise<Record<string, string | undefined>> {
    const base = processEnv();
    const separator = this.opts.isWindows ? ";" : ":";
    const discovered = await this.pathDirs();
    if (discovered.length === 0) return { ...base, ...extra };

    const merged = [...discovered];
    for (const dir of (base.PATH ?? "").split(separator)) {
      if (dir && !merged.includes(dir)) merged.push(dir);
    }
    return { ...base, PATH: merged.join(separator), ...extra };
  }

  /**
   * The login shell's PATH, read once.
   *
   * Windows is skipped: there is no login shell to ask, and a GUI process there
   * inherits the user's PATH already, so the problem this solves does not
   * exist.
   */
  pathDirs(): Promise<string[]> {
    if (this.opts.isWindows) return Promise.resolve([]);
    this.pathDirsPromise ??= readLoginPath(processEnv().SHELL, this.run, LOGIN_SHELL_TIMEOUT);
    return this.pathDirsPromise;
  }

  async git(): Promise<Resolution> {
    return this.resolver.resolve({
      name: "git",
      configured: this.opts.configuredGit?.(),
      pathDirs: await this.pathDirs(),
      known: this.opts.isWindows ? [] : KNOWN_GIT,
      fallback: this.opts.isWindows ? [] : FALLBACK_GIT,
      exeSuffix: this.opts.isWindows ? ".exe" : "",
      probe: (path) => this.answers(path, ["--version"], (out) => isGitVersion(out)),
    });
  }

  async python(): Promise<Resolution> {
    return this.resolver.resolve({
      name: "python3",
      configured: this.opts.configuredPython?.(),
      pathDirs: await this.pathDirs(),
      known: KNOWN_PYTHON,
      fallback: FALLBACK_PYTHON,
      probe: (path) => this.answers(path, PTY_PROBE_ARGS, (out) => out.includes(PTY_PROBE_TOKEN)),
    });
  }

  /**
   * Perl for the fallback bridge, asked whether it can open `/dev/ptmx` and
   * knows `POSIX` — the two things the bridge needs and the two a stripped
   * environment might not have.
   */
  async perl(): Promise<Resolution> {
    return this.resolver.resolve({
      name: "perl",
      pathDirs: await this.pathDirs(),
      known: KNOWN_PERL,
      probe: (path) => this.answers(path, PERL_PROBE_ARGS, (out) => out.includes(PERL_PROBE_TOKEN)),
    });
  }

  /** Forgets what was resolved, so a changed setting takes effect immediately. */
  invalidate(): void {
    this.resolver.invalidate();
    this.pathDirsPromise = null;
  }

  /**
   * Runs one candidate and judges the answer.
   *
   * Anything that errors, times out or replies with something unexpected is not
   * a candidate. The stub case lands here as an error, a wrong-python case as
   * an answer that does not match.
   */
  private async answers(
    path: string,
    args: readonly string[],
    accept: (stdout: string) => boolean,
  ): Promise<boolean> {
    try {
      return accept(await this.run(path, args, PROBE_TIMEOUT));
    } catch {
      return false;
    }
  }
}

function isGitVersion(stdout: string): boolean {
  return stdout.trimStart().toLowerCase().startsWith("git version");
}

function runCommand(file: string, args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

import { Events, Platform } from "obsidian";
import { SessionList } from "./session-list";
import type { SessionEntry } from "./session-list";
import { TerminalSession } from "./terminal-session";
import type { SessionLaunch } from "./terminal-session";
import { nextColor } from "./session-appearance";
import { selectBackend } from "./pty-selector";
import type { SelectedBackend } from "./pty-selector";
import type { PlatformName } from "./pty-backend";
import { NO_INJECTION, injectionFor, shellCommand, startupMechanism } from "./startup-script";
import type { InjectionMethod, StartupInjection } from "./startup-script";
import { joinPath, mkdtemp, processEnv, rm, tmpdir, writeFile } from "../utils/node-api";
import { asVoid } from "../utils/async";
import type { Resolution } from "../utils/binary-resolver";
import type GitHistoryPlugin from "../main";

/** Everything the "check terminal setup" report is built from. */
export interface TerminalSetupReport {
  shell: string;
  /** Directories read from the login shell, empty when that did not work. */
  loginPathDirs: readonly string[];
  git: Resolution;
  backend: SelectedBackend;
  startup: StartupState;
}

/** Whether a startup script is set, and how this shell would be given it. */
export interface StartupState {
  enabled: boolean;
  method: InjectionMethod;
  /** The mechanism, named: "ZDOTDIR", "--rcfile", "typed into the shell". */
  label: string;
}

/**
 * Every terminal session the plugin is running.
 *
 * It belongs to the plugin rather than to the view on purpose: closing the
 * terminal tab used to kill the shell with it, which loses whatever was running
 * there. A view now attaches the sessions it finds and lets go of them again on
 * close; only an explicit close, or unloading the plugin, ends a process.
 */
export class TerminalSessionManager extends Events {
  private list = new SessionList();
  private sessions = new Map<string, TerminalSession>();
  /** Scratch directory per session, holding the startup files it was started
      with. Removed when the session is closed. */
  private startupDirs = new Map<string, string>();

  constructor(private plugin: GitHistoryPlugin) {
    super();
  }

  get entries(): readonly SessionEntry[] {
    return this.list.sessions;
  }

  get activeId(): string | null {
    return this.list.activeId;
  }

  get size(): number {
    return this.list.size;
  }

  session(id: string): TerminalSession | null {
    return this.sessions.get(id) ?? null;
  }

  activeSession(): TerminalSession | null {
    const id = this.list.activeId;
    return id ? this.session(id) : null;
  }

  hasExited(id: string): boolean {
    return this.session(id)?.exited ?? false;
  }

  /**
   * Starts a session in the given container and makes it the active one.
   *
   * Asynchronous because of what has to happen first: the environment the shell
   * runs in is read from the login shell rather than assumed. Which backend
   * opens the pty is decided later, inside the session, so that pressing "Try
   * again" after a failure decides it again.
   */
  async create(parent: HTMLElement): Promise<TerminalSession | null> {
    const shell = this.detectShell();
    const env = await this.plugin.execEnv.env();
    const entry = this.list.add(shellName(shell), this.autoColor());
    const session = new TerminalSession(entry.id, parent, {
      cwd: this.vaultPath(),
      theme: themeColors(),
      env,
      launch: () => this.launchFor(entry.id, shell),
      onOpenSettings: () => this.plugin.openPluginSettings(),
      onCheckSetup: () => void this.plugin.showTerminalSetup(),
    });
    session.onStateChange(() => this.changed());
    this.sessions.set(entry.id, session);
    this.changed();
    return session;
  }

  close(id: string): void {
    const removed = this.list.close(id);
    if (!removed) return;
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
    asVoid(() => this.discardStartupDir(id))();
    this.changed();
  }

  closeOthers(id: string): void {
    for (const other of this.list.others(id)) this.close(other);
  }

  activate(id: string): void {
    if (this.list.activate(id)) this.changed();
  }

  move(from: number, to: number): void {
    if (this.list.move(from, to)) this.changed();
  }

  rename(id: string, name: string): void {
    if (this.list.rename(id, name)) this.changed();
  }

  setIcon(id: string, icon: string): void {
    if (this.list.setIcon(id, icon)) this.changed();
  }

  setColor(id: string, color: string | undefined): void {
    if (this.list.setColor(id, color)) this.changed();
  }

  /** Everything the setup report shows, gathered the way a session would. */
  async setupReport(): Promise<TerminalSetupReport> {
    const [loginPathDirs, git, backend] = await Promise.all([
      this.plugin.execEnv.pathDirs(),
      this.plugin.execEnv.git(),
      this.chooseBackend(),
    ]);
    const shell = this.detectShell();
    return { shell, loginPathDirs, git, backend, startup: this.startupState(shell) };
  }

  /** What the report says about the startup script, without writing anything. */
  private startupState(shell: string): StartupState {
    const enabled = this.plugin.settings.terminalStartupScript.trim() !== "";
    if (!enabled) return { enabled, method: "none", label: NO_INJECTION.label };
    return { enabled, ...startupMechanism(shell) };
  }

  /**
   * The colour a session opened right now would get, or none while the setting
   * is off — VS Code leaves every tab neutral by default, and so does this.
   */
  private autoColor(): string | undefined {
    if (!this.plugin.settings.terminalAutoColor) return undefined;
    return nextColor(this.list.colorsInUse());
  }

  /** Puts every running session back into a freshly opened view. */
  attachAll(parent: HTMLElement): void {
    for (const entry of this.list.sessions) {
      this.sessions.get(entry.id)?.attach(parent);
    }
  }

  /** Lets go of the DOM without touching the processes. */
  detachAll(): void {
    for (const session of this.sessions.values()) session.detach();
  }

  /** Ends every session. Only unloading the plugin gets to do this. */
  disposeAll(): void {
    for (const session of this.sessions.values()) session.dispose();
    for (const id of [...this.startupDirs.keys()]) asVoid(() => this.discardStartupDir(id))();
    this.sessions.clear();
    this.list.clear();
  }

  private changed(): void {
    this.trigger("sessions-changed");
  }

  private async launchFor(id: string, shell: string): Promise<SessionLaunch> {
    const selected = await this.chooseBackend();
    const tty = selected.spec.capabilities.tty;
    const injection = await this.prepareStartup(id, shell);
    const command = shellCommand(shell, this.platform(), tty, injection);
    const { file, args } = selected.spec.command(selected.interpreter, command);
    return {
      spec: selected.spec,
      file,
      args,
      attempts: selected.attempts,
      env: injection.env,
      prelude: injection.stdin,
    };
  }

  /**
   * Puts the startup script on disk for one session and says how the shell will
   * be given it.
   *
   * Written on every start rather than once: "Try again" after fixing a broken
   * script has to run the fixed one, and a script cleared in the settings has
   * to leave nothing behind — hence the directory going away again here rather
   * than only on close.
   */
  private async prepareStartup(id: string, shell: string): Promise<StartupInjection> {
    const script = this.plugin.settings.terminalStartupScript;
    if (script.trim() === "") {
      await this.discardStartupDir(id);
      return NO_INJECTION;
    }

    const dir = await this.startupDir(id);
    const injection = injectionFor({ shell, script, dir, env: processEnv() });
    for (const file of injection.files) {
      await writeFile(joinPath(dir, file.name), file.content, "utf-8");
    }
    return injection;
  }

  private async startupDir(id: string): Promise<string> {
    const existing = this.startupDirs.get(id);
    if (existing !== undefined) return existing;
    const dir = await mkdtemp(joinPath(tmpdir(), "obsidian-git-history-"));
    this.startupDirs.set(id, dir);
    return dir;
  }

  private async discardStartupDir(id: string): Promise<void> {
    const dir = this.startupDirs.get(id);
    if (dir === undefined) return;
    this.startupDirs.delete(id);
    await rm(dir, { recursive: true, force: true });
  }

  private chooseBackend(): Promise<SelectedBackend> {
    return selectBackend({
      platform: this.platform(),
      preference: this.plugin.settings.terminalPtyBackend,
      resolve: (interpreter) =>
        interpreter === "perl" ? this.plugin.execEnv.perl() : this.plugin.execEnv.python(),
    });
  }

  private platform(): PlatformName {
    if (Platform.isWin) return "win";
    return Platform.isMacOS ? "mac" : "linux";
  }

  private detectShell(): string {
    const configured = this.plugin.settings.terminalShell;
    if (configured) return configured;

    const env = processEnv();
    if (Platform.isWin) return env.COMSPEC ?? "powershell.exe";
    return env.SHELL ?? "/bin/sh";
  }

  private vaultPath(): string {
    const adapter = this.plugin.app.vault.adapter as {
      basePath?: string;
      getBasePath?: () => string;
    };
    return adapter.getBasePath?.() ?? adapter.basePath ?? "";
  }
}

/** "zsh" out of "/bin/zsh", the way VS Code labels its terminals. */
function shellName(shell: string): string {
  const base = shell.split(/[/\\]/).pop() ?? shell;
  return base.replace(/\.exe$/i, "") || "shell";
}

function themeColors(): Record<string, string> {
  const style = activeWindow.getComputedStyle(activeDocument.body);
  const read = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;

  return {
    background: read("--background-primary", "#1e1e1e"),
    foreground: read("--text-normal", "#d4d4d4"),
    cursor: read("--text-accent", "#528bff"),
    selectionBackground: read("--text-selection", "rgba(82, 139, 255, 0.3)"),
  };
}

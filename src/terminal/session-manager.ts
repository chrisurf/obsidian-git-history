import { Events, Notice, Platform } from "obsidian";
import { SessionList } from "./session-list";
import type { SessionEntry } from "./session-list";
import { TerminalSession } from "./terminal-session";
import { nextColor } from "./session-appearance";
import { processEnv } from "../utils/node-api";
import type GitHistoryPlugin from "../main";

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
   * Asynchronous because of what has to happen first: the shell, the python
   * behind the PTY bridge and the PATH they run with are resolved by asking the
   * machine, not by assuming. That costs one round of probing on the first
   * session and nothing on every session after it.
   */
  async create(parent: HTMLElement): Promise<TerminalSession | null> {
    const shell = this.detectShell();
    const [python, env] = await Promise.all([this.detectPython(), this.plugin.execEnv.env()]);
    const entry = this.list.add(shellName(shell), this.autoColor());
    const session = new TerminalSession(entry.id, parent, {
      shell,
      python,
      cwd: this.vaultPath(),
      isWindows: Platform.isWin,
      theme: themeColors(),
      env,
    });
    session.onExit(() => this.changed());
    this.sessions.set(entry.id, session);
    this.changed();
    return session;
  }

  close(id: string): void {
    const removed = this.list.close(id);
    if (!removed) return;
    this.sessions.get(id)?.dispose();
    this.sessions.delete(id);
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
    this.sessions.clear();
    this.list.clear();
  }

  private changed(): void {
    this.trigger("sessions-changed");
  }

  private detectShell(): string {
    const configured = this.plugin.settings.terminalShell;
    if (configured) return configured;

    const env = processEnv();
    if (Platform.isWin) return env.COMSPEC ?? "powershell.exe";
    return env.SHELL ?? "/bin/sh";
  }

  /**
   * The python that will run the PTY bridge.
   *
   * When nothing answered, the session is still started with the bare name: the
   * plugin has nothing better to offer, and the shell's own failure inside the
   * terminal is more use than a panel that refuses to open. The notice is what
   * makes it actionable — this failing silently, with a stack of developer-tool
   * output in the terminal and no hint of where to look, is what this whole
   * resolution exists to prevent.
   */
  private async detectPython(): Promise<string> {
    if (Platform.isWin) return "";
    const resolved = await this.plugin.execEnv.python();
    if (!resolved.binary) {
      new Notice(
        `Git history: no working Python 3 found for the terminal (tried ${resolved.tried.length} ` +
          "locations). Set one under Settings, Terminal, Python.",
        10000,
      );
      return "python3";
    }
    return resolved.binary.path;
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

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Platform } from "obsidian";
import { spawn } from "../utils/node-api";
import type { SpawnedProcess } from "../utils/node-api";
import { HANDSHAKE, limitationNotice } from "./pty-backend";
import type { PtyBackendSpec } from "./pty-backend";
import { HandshakeBuffer } from "./handshake";
import { renderStartupError } from "../components/terminal-startup-error";
import type { BackendAttempt } from "./pty-selector";
import { searchColors } from "./terminal-search";
import type { SearchOptions, SearchResults } from "./terminal-search";

/**
 * How long a bridge gets to open its terminal before the session gives up on
 * it. Generous: the usual failure closes the process outright and is caught
 * long before this, so the only case left is one that hangs, and a slow first
 * interpreter start on a cold machine should not be mistaken for one.
 */
const HANDSHAKE_TIMEOUT = 15000;

/** Everything needed to start one shell, resolved fresh on every attempt. */
export interface SessionLaunch {
  spec: PtyBackendSpec;
  file: string;
  args: string[];
  /** The backends considered on the way here, for the failure panel. */
  attempts: readonly BackendAttempt[];
  /** Environment the startup script needs, such as zsh's ZDOTDIR. */
  env?: Readonly<Record<string, string>>;
  /**
   * Typed into the shell once it is up, for the shells that have no way of
   * being handed an extra rc file. Null for every other one.
   */
  prelude?: string | null;
}

export interface SessionOptions {
  cwd: string;
  theme: Record<string, string>;
  /** Environment for the shell, carrying the login shell's PATH. */
  env: Record<string, string | undefined>;
  /**
   * Resolved on every start rather than passed in once, so pressing "Try again"
   * after correcting a setting actually picks up the correction.
   */
  launch: () => Promise<SessionLaunch>;
  onOpenSettings: () => void;
  onCheckSetup: () => void;
}

/**
 * One terminal: an xterm instance, the shell behind it, and the element the two
 * are drawn into.
 *
 * The element is the point of the class. It is created once and then moved
 * between views rather than rebuilt, so closing the terminal tab detaches a
 * running session instead of killing it — only dispose() ends the process.
 */
export class TerminalSession {
  readonly id: string;
  readonly hostEl: HTMLElement;
  private terminal: Terminal;
  private fitAddon: FitAddon;
  private searchAddon: SearchAddon;
  /** Set while the search bar is open, so a redraw keeps the highlighting. */
  private lastSearch: { term: string; options: SearchOptions } | null = null;
  private shellProcess: SpawnedProcess | null = null;
  private stateHandlers: (() => void)[] = [];
  private hasExited = false;
  private launch: SessionLaunch | null = null;
  private handshake: HandshakeBuffer | null = null;
  private handshakeTimer: number | null = null;
  private preludeSent = false;
  private errorEl: HTMLElement | null = null;

  constructor(
    id: string,
    parent: HTMLElement,
    private opts: SessionOptions,
  ) {
    this.id = id;
    this.hostEl = parent.createDiv("gs-terminal-instance");

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'MesloLGS NF', Menlo, Monaco, 'Courier New', monospace",
      theme: opts.theme,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new Unicode11Addon());
    // The shell gets every key except the ones the plugin's own commands are
    // on. Without this, xterm swallows the find shortcut and sends it to the
    // shell, where it moves the cursor one character forward.
    this.terminal.attachCustomKeyEventHandler((event) => !isPluginShortcut(event));
    this.terminal.open(this.hostEl);
    this.terminal.unicode.activeVersion = "11";
    this.fit();

    this.terminal.onResize(({ cols, rows }) => this.sendResize(rows, cols));
    this.terminal.onData((data: string) => this.shellProcess?.stdin?.write(data));

    void this.start();
  }

  get exited(): boolean {
    return this.hasExited;
  }

  /** Which backend is behind this session, once one has been chosen. */
  get backend(): PtyBackendSpec | null {
    return this.launch?.spec ?? null;
  }

  /**
   * Runs whenever the session stops or starts being alive: a shell that ended,
   * a bridge that never started, a retry that brought one back. The strip reads
   * `exited` from it, so every one of those has to reach the listener.
   */
  onStateChange(handler: () => void): void {
    this.stateHandlers.push(handler);
  }

  /** Moves the session into another container, keeping the process running. */
  attach(parent: HTMLElement): void {
    parent.appendChild(this.hostEl);
  }

  detach(): void {
    this.hostEl.remove();
  }

  setVisible(visible: boolean): void {
    this.hostEl.toggleClass("gs-hidden", !visible);
  }

  fit(): void {
    try {
      this.fitAddon.fit();
    } catch {
      // No layout yet: the container is hidden or not in the document. The next
      // activation fits it again.
    }
  }

  /**
   * Redraws after the element was moved to a different container. xterm keeps
   * its buffer, but the rows it painted before the move are stale.
   */
  refresh(): void {
    this.fit();
    this.terminal.refresh(0, this.terminal.rows - 1);
  }

  focus(): void {
    this.terminal.focus();
  }

  /** What is selected in the terminal, which is what a search starts from. */
  selection(): string {
    return this.terminal.getSelection();
  }

  /**
   * Searches forwards or backwards, and paints every match on the way.
   *
   * The highlight colours are worked out from the terminal's own background
   * rather than taken from the theme: the addon accepts `#RRGGBB` only, so a
   * single pair would be invisible on half the themes out there.
   */
  find(term: string, options: SearchOptions, direction: "next" | "previous"): boolean {
    this.lastSearch = { term, options };
    const search = {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
      decorations: searchColors(this.opts.theme.background ?? ""),
    };
    return direction === "next"
      ? this.searchAddon.findNext(term, search)
      : this.searchAddon.findPrevious(term, search);
  }

  /** Drops the highlighting, for a search bar that is being closed. */
  clearSearch(): void {
    this.lastSearch = null;
    this.searchAddon.clearDecorations();
  }

  /** Whether a search is currently painted on this session. */
  get searching(): boolean {
    return this.lastSearch !== null;
  }

  /** How many matches the last search found, and which one is current. */
  onSearchResults(handler: (results: SearchResults) => void): () => void {
    const subscription = this.searchAddon.onDidChangeResults((event) =>
      handler({ index: event.resultIndex + 1, count: event.resultCount }),
    );
    return () => subscription.dispose();
  }

  dispose(): void {
    this.stopProcess();
    this.searchAddon.dispose();
    this.clearHandshakeTimer();
    this.terminal.dispose();
    this.hostEl.remove();
  }

  private sendResize(rows: number, cols: number): void {
    if (this.launch && !this.launch.spec.capabilities.resize) return;
    this.shellProcess?.stdin?.write(`\x1b]7770;${rows};${cols}\x07`);
  }

  /**
   * Starts, or starts over.
   *
   * Everything is resolved again on the way through, so a retry after pointing
   * the settings at a working interpreter runs with the new answer rather than
   * repeating the one that failed.
   */
  private async start(): Promise<void> {
    this.clearFailure();
    this.preludeSent = false;

    let launch: SessionLaunch;
    try {
      launch = await this.opts.launch();
    } catch (e: unknown) {
      this.showFailure(message(e), false);
      return;
    }
    this.launch = launch;

    const env = {
      ...this.opts.env,
      TERM: "xterm-256color",
      COLUMNS: String(this.terminal.cols),
      LINES: String(this.terminal.rows),
      POWERLEVEL9K_INSTANT_PROMPT: "off",
      // Last, because a startup script that needs ZDOTDIR pointed somewhere
      // else means it, and nothing above is a variable it sets.
      ...launch.env,
    };

    try {
      this.shellProcess = spawn(launch.file, launch.args, { cwd: this.opts.cwd, env });
    } catch (e: unknown) {
      this.showFailure(message(e), false);
      return;
    }

    this.handshake = launch.spec.handshake ? new HandshakeBuffer(HANDSHAKE) : null;
    if (this.handshake) {
      this.startHandshakeTimer();
    } else {
      this.announceLimitations(launch.spec);
      this.sendPrelude();
    }

    for (const stream of [this.shellProcess.stdout, this.shellProcess.stderr]) {
      stream?.on("data", (data: Uint8Array | string) => this.receive(data));
    }

    this.shellProcess.on("close", (code: number | null) => this.onProcessClosed(code));
    this.shellProcess.on("error", (err: Error) => {
      if (this.awaitingHandshake()) this.showFailure(err.message, false);
      else this.writeError(`[Shell error: ${err.message}]`);
    });
  }

  /**
   * Output on its way to the terminal, held back while the bridge has not
   * announced itself.
   */
  private receive(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? encode(data) : new Uint8Array(data);

    if (this.handshake && !this.handshake.ready) {
      const released = this.handshake.push(bytes);
      if (released === null) return;
      this.clearHandshakeTimer();
      // Only now: before the bridge has its pty open there is nothing on the
      // other end to read what we would type.
      this.sendPrelude();
      if (released.length > 0) this.terminal.write(released);
      return;
    }

    this.terminal.write(bytes);
  }

  /**
   * A process that closes while output is still held back never opened a
   * terminal, so what it wrote is the reason rather than the session's last
   * words. That is the difference the handshake exists to make.
   */
  private onProcessClosed(code: number | null): void {
    if (this.awaitingHandshake()) {
      this.showFailure(this.handshake?.text() ?? "", false);
      return;
    }
    this.terminal.writeln(`\r\n\x1b[90m[Process exited with code ${code ?? "unknown"}]\x1b[0m`);
    this.markExited();
  }

  private awaitingHandshake(): boolean {
    return this.handshake !== null && !this.handshake.ready;
  }

  /**
   * The fallback way in for a shell with no rc file of its own to be handed:
   * the line that loads the startup script, typed in as a user would.
   *
   * It shows up in the terminal and in the history, which is exactly why every
   * shell the table knows gets a real mechanism instead — see startup-script.ts.
   */
  private sendPrelude(): void {
    const prelude = this.launch?.prelude;
    if (!prelude || this.preludeSent) return;
    this.preludeSent = true;
    this.shellProcess?.stdin?.write(prelude);
  }

  private startHandshakeTimer(): void {
    this.clearHandshakeTimer();
    this.handshakeTimer = window.setTimeout(() => {
      if (!this.awaitingHandshake()) return;
      this.showFailure(this.handshake?.text() ?? "", true);
    }, HANDSHAKE_TIMEOUT);
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer === null) return;
    window.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  /** A backend that cannot give a real terminal says so, once, up front. */
  private announceLimitations(spec: PtyBackendSpec): void {
    const notice = limitationNotice(spec);
    if (notice) this.terminal.writeln(`\x1b[33m${notice}\x1b[0m\r\n`);
  }

  private showFailure(output: string, timedOut: boolean): void {
    this.stopProcess();
    this.clearHandshakeTimer();
    this.handshake = null;

    this.hostEl.addClass("gs-terminal-instance-failed");
    this.errorEl = renderStartupError(
      this.hostEl,
      {
        backend: this.launch?.spec.label ?? "the shell",
        interpreter: this.launch?.file ?? "",
        output,
        attempts: this.launch?.attempts ?? [],
        timedOut,
      },
      {
        onRetry: () => void this.start(),
        onOpenSettings: this.opts.onOpenSettings,
        onCheckSetup: this.opts.onCheckSetup,
      },
    );
    this.markExited();
  }

  private clearFailure(): void {
    this.errorEl?.remove();
    this.errorEl = null;
    this.hostEl.removeClass("gs-terminal-instance-failed");
    this.terminal.reset();

    if (!this.hasExited) return;
    this.hasExited = false;
    this.notify();
  }

  private stopProcess(): void {
    if (!this.shellProcess) return;
    try {
      this.shellProcess.kill("SIGHUP");
    } catch {
      // already gone
    }
    this.shellProcess = null;
  }

  private writeError(message: string): void {
    this.terminal.writeln(`\r\n\x1b[31m${message}\x1b[0m`);
  }

  /**
   * The session stays in the list once its shell is gone: closing is the user's
   * call, and the last output is usually the reason they want to look.
   */
  private markExited(): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.notify();
  }

  private notify(): void {
    for (const handler of this.stateHandlers) handler();
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Keys the terminal lets through to Obsidian instead of the shell.
 *
 * Only the find shortcut, and only the platform's own modifier: Ctrl+F in a
 * shell is "forward one character" to every readline binding there is, so on
 * Linux and Windows this costs a keystroke people use. It is the same trade
 * VS Code makes, and the shortcut is a command like any other — anyone who
 * wants that keystroke back can rebind it in Obsidian's hotkeys.
 */
function isPluginShortcut(event: KeyboardEvent): boolean {
  if (event.type !== "keydown") return false;
  const modifier = Platform.isMacOS ? event.metaKey : event.ctrlKey;
  return modifier && !event.altKey && event.key.toLowerCase() === "f";
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

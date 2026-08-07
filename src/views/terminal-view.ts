import { ItemView, WorkspaceLeaf, Platform } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { TERMINAL_VIEW_TYPE } from "../types";
import { spawn, processEnv } from "../utils/node-api";
import type { SpawnedProcess } from "../utils/node-api";
import type GitHistoryPlugin from "../main";

export class TerminalView extends ItemView {
  private plugin: GitHistoryPlugin;
  private terminal: Terminal | null = null;
  private fitAddon: FitAddon | null = null;
  private shellProcess: SpawnedProcess | null = null;
  private resizeObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("gs-terminal-container");

    if (!Platform.isDesktop) {
      container.createDiv({
        cls: "gs-terminal-unavailable",
        text: "Terminal is only available on desktop.",
      });
      return;
    }

    const termEl = container.createDiv({ cls: "gs-terminal-wrapper" });

    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Monaco, 'Courier New', monospace",
      theme: this.getThemeColors(),
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.open(termEl);

    this.fitAddon.fit();

    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitAddon) {
        try {
          this.fitAddon.fit();
        } catch {
          // container not yet visible
        }
      }
    });
    this.resizeObserver.observe(termEl);

    this.spawnShell();
  }

  private getThemeColors(): Record<string, string> {
    const style = activeWindow.getComputedStyle(activeDocument.body);
    const bg = style.getPropertyValue("--background-primary").trim() || "#1e1e1e";
    const fg = style.getPropertyValue("--text-normal").trim() || "#d4d4d4";
    const cursor = style.getPropertyValue("--text-accent").trim() || "#528bff";
    const selBg = style.getPropertyValue("--text-selection").trim() || "rgba(82, 139, 255, 0.3)";

    return {
      background: bg,
      foreground: fg,
      cursor: cursor,
      selectionBackground: selBg,
    };
  }

  private detectShell(): string {
    const configured = this.plugin.settings.terminalShell;
    if (configured) return configured;

    const env = processEnv();

    if (Platform.isWin) {
      if (env.COMSPEC) return env.COMSPEC;
      return "powershell.exe";
    }

    if (env.SHELL) return env.SHELL;
    return "/bin/sh";
  }

  private spawnShell(): void {
    if (!this.terminal) return;

    const shell = this.detectShell();
    const cwd = this.vaultPath();

    try {
      this.shellProcess = spawn(shell, [], { cwd, env: processEnv() });
    } catch (e: unknown) {
      this.terminal.writeln(
        `\x1b[31mFailed to start shell: ${e instanceof Error ? e.message : String(e)}\x1b[0m`,
      );
      return;
    }

    if (this.shellProcess.stdout) {
      this.shellProcess.stdout.on("data", (data: Uint8Array | string) => {
        this.terminal?.write(typeof data === "string" ? data : new Uint8Array(data));
      });
    }

    if (this.shellProcess.stderr) {
      this.shellProcess.stderr.on("data", (data: Uint8Array | string) => {
        this.terminal?.write(typeof data === "string" ? data : new Uint8Array(data));
      });
    }

    this.terminal.onData((data: string) => {
      this.shellProcess?.stdin?.write(data);
    });

    this.shellProcess.on("close", (code: number | null) => {
      this.terminal?.writeln(`\r\n\x1b[90m[Process exited with code ${code ?? "unknown"}]\x1b[0m`);
    });

    this.shellProcess.on("error", (err: Error) => {
      this.terminal?.writeln(`\r\n\x1b[31m[Shell error: ${err.message}]\x1b[0m`);
    });
  }

  private vaultPath(): string {
    const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
    return adapter.getBasePath?.() ?? adapter.basePath ?? "";
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    if (this.shellProcess) {
      try {
        this.shellProcess.kill();
      } catch {
        // already dead
      }
      this.shellProcess = null;
    }

    this.terminal?.dispose();
    this.terminal = null;
    this.fitAddon = null;
  }
}

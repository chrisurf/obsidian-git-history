import { ItemView, WorkspaceLeaf, Platform } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { TERMINAL_VIEW_TYPE } from "../types";
import { spawn, processEnv } from "../utils/node-api";
import type { SpawnedProcess } from "../utils/node-api";
import type GitHistoryPlugin from "../main";

const PTY_BRIDGE = [
  "import pty,os,sys,fcntl,struct,termios,select,signal",
  "R=int(os.environ.get('LINES','24'));C=int(os.environ.get('COLUMNS','80'))",
  "m,s=pty.openpty()",
  "fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',R,C,0,0))",
  "p=os.fork()",
  "if p==0:",
  " os.close(m);os.setsid();fcntl.ioctl(s,termios.TIOCSCTTY,0)",
  " os.dup2(s,0);os.dup2(s,1);os.dup2(s,2)",
  " if s>2:os.close(s)",
  " os.execvp(sys.argv[1],sys.argv[1:])",
  "os.close(s);bf=b''",
  "ES=b'\\x1b]7770;';ST=b'\\x07'",
  "def rz(r,c):",
  " try:fcntl.ioctl(m,termios.TIOCSWINSZ,struct.pack('HHHH',r,c,0,0));os.kill(p,signal.SIGWINCH)",
  " except:pass",
  "try:",
  " while 1:",
  "  try:rl,_,_=select.select([0,m],[],[])",
  "  except InterruptedError:continue",
  "  except:break",
  "  if 0 in rl:",
  "   d=os.read(0,4096)",
  "   if not d:break",
  "   bf+=d",
  "   while ES in bf:",
  "    i=bf.index(ES)",
  "    if i>0:os.write(m,bf[:i])",
  "    bf=bf[i+7:];e=bf.find(ST)",
  "    if e<0:break",
  "    ps=bf[:e].decode().split(';');bf=bf[e+1:]",
  "    if len(ps)==2:rz(int(ps[0]),int(ps[1]))",
  "   if bf and ES not in bf:os.write(m,bf);bf=b''",
  "  if m in rl:",
  "   try:d=os.read(m,4096)",
  "   except OSError:break",
  "   if not d:break",
  "   os.write(1,d)",
  "finally:",
  " os.close(m)",
  " try:os.kill(p,signal.SIGHUP);os.waitpid(p,0)",
  " except:pass",
].join("\n");

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
      fontFamily: "'MesloLGS NF', Menlo, Monaco, 'Courier New', monospace",
      theme: this.getThemeColors(),
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.open(termEl);
    this.terminal.unicode.activeVersion = "11";

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

    this.terminal.onResize(({ cols, rows }) => {
      this.sendResize(rows, cols);
    });

    this.spawnShell();
  }

  private sendResize(rows: number, cols: number): void {
    this.shellProcess?.stdin?.write(`\x1b]7770;${rows};${cols}\x07`);
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
    const cols = this.terminal.cols;
    const rows = this.terminal.rows;
    const env = {
      ...processEnv(),
      TERM: "xterm-256color",
      COLUMNS: String(cols),
      LINES: String(rows),
    };

    try {
      if (Platform.isWin) {
        this.shellProcess = spawn(shell, ["-i"], { cwd, env });
      } else {
        this.shellProcess = spawn("python3", ["-c", PTY_BRIDGE, shell, "-il"], {
          cwd,
          env,
        });
      }
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
    const adapter = this.app.vault.adapter as {
      basePath?: string;
      getBasePath?: () => string;
    };
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

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { spawn, processEnv } from "../utils/node-api";
import type { SpawnedProcess } from "../utils/node-api";

/**
 * Node ships no pty. This forks one through python3, wires the child's stdio to
 * it, and tunnels window-size changes back in through an OSC 7770 escape, since
 * the bridge only has stdin to listen on.
 */
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

export interface SessionOptions {
  /** Shell binary, already resolved. */
  shell: string;
  cwd: string;
  isWindows: boolean;
  theme: Record<string, string>;
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
  private shellProcess: SpawnedProcess | null = null;
  private exitHandlers: (() => void)[] = [];
  private hasExited = false;

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
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.open(this.hostEl);
    this.terminal.unicode.activeVersion = "11";
    this.fit();

    this.terminal.onResize(({ cols, rows }) => this.sendResize(rows, cols));
    this.terminal.onData((data: string) => this.shellProcess?.stdin?.write(data));

    this.spawnShell();
  }

  get exited(): boolean {
    return this.hasExited;
  }

  /** Runs when the shell behind this session ends on its own. */
  onExit(handler: () => void): void {
    this.exitHandlers.push(handler);
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

  dispose(): void {
    if (this.shellProcess) {
      try {
        this.shellProcess.kill("SIGHUP");
      } catch {
        // already gone
      }
      this.shellProcess = null;
    }
    this.terminal.dispose();
    this.hostEl.remove();
  }

  private sendResize(rows: number, cols: number): void {
    this.shellProcess?.stdin?.write(`\x1b]7770;${rows};${cols}\x07`);
  }

  private spawnShell(): void {
    const env = {
      ...processEnv(),
      TERM: "xterm-256color",
      COLUMNS: String(this.terminal.cols),
      LINES: String(this.terminal.rows),
      POWERLEVEL9K_INSTANT_PROMPT: "off",
    };
    const cwd = this.opts.cwd;

    try {
      if (this.opts.isWindows) {
        this.shellProcess = spawn(this.opts.shell, ["-i"], { cwd, env });
      } else {
        this.shellProcess = spawn("python3", ["-c", PTY_BRIDGE, this.opts.shell, "-il"], {
          cwd,
          env,
        });
      }
    } catch (e: unknown) {
      this.writeError(`Failed to start shell: ${e instanceof Error ? e.message : String(e)}`);
      this.markExited();
      return;
    }

    for (const stream of [this.shellProcess.stdout, this.shellProcess.stderr]) {
      stream?.on("data", (data: Uint8Array | string) => {
        this.terminal.write(typeof data === "string" ? data : new Uint8Array(data));
      });
    }

    this.shellProcess.on("close", (code: number | null) => {
      this.terminal.writeln(`\r\n\x1b[90m[Process exited with code ${code ?? "unknown"}]\x1b[0m`);
      this.markExited();
    });

    this.shellProcess.on("error", (err: Error) => {
      this.writeError(`[Shell error: ${err.message}]`);
    });
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
    for (const handler of this.exitHandlers) handler();
  }
}

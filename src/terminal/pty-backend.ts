/**
 * The ways this plugin knows to put a shell behind a pseudo-terminal.
 *
 * Node ships no pty and Obsidian's plugin channel carries nothing but
 * `main.js`, `manifest.json` and `styles.css` — no native module compiled
 * against Electron's ABI, no helper binary of our own. What is left is asking
 * an interpreter that is already on the machine to open the pty for us, which
 * is what these bridges do.
 *
 * There is more than one because relying on a single one is what broke: a
 * python3 that resolves to a broken developer-tools stub took the whole
 * terminal with it. Each backend is tried in turn, and each says honestly what
 * it can do — the last one cannot open a pty at all and admits it rather than
 * pretending.
 *
 * Everything here is pure data and string building, so the bridges and the
 * order they are tried in can be read, diffed and tested without a process.
 */

/** Printed by a bridge once its pty is open, and swallowed by the session. */
export const HANDSHAKE = "\u001b]7771;gh-ready\u0007";

/**
 * Forks a pty through python3, wires the child's stdio to it, and tunnels
 * window-size changes back in through an OSC 7770 escape, since the bridge only
 * has stdin to listen on.
 */
const PYTHON_BRIDGE = [
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
  "os.write(1,b'\\x1b]7771;gh-ready\\x07')",
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

/**
 * The same bridge in Perl, for machines where no python answers.
 *
 * It exists because of what `/usr/bin/perl` is and is not: a real interpreter
 * shipped with macOS, in `/System/Library/Perl`, and *not* one of the
 * developer-tool stubs in `/usr/bin` that fail when Xcode is broken. When the
 * python side of this file cannot run, this one still can, and it needs nothing
 * from CPAN — `POSIX` and `IO::Select` are core.
 *
 * macOS only, deliberately. The pty is opened by talking to `/dev/ptmx` through
 * raw ioctl numbers, and those numbers are per-kernel: the Linux spelling needs
 * TIOCGPTN and TIOCSPTLCK instead of TIOCPTYGRANT and friends. Writing a second
 * set that nothing here can test would be guessing in a place where guessing is
 * how this whole class of bug started — and on Linux a working python3 is
 * effectively always there, with the pipe backend behind it either way.
 */
const PERL_BRIDGE = [
  "use POSIX ();use IO::Select;",
  // TIOCPTYGRANT, TIOCPTYUNLK, TIOCPTYGNAME, TIOCSCTTY, TIOCSWINSZ on Darwin.
  "my($G,$U,$N,$C,$W)=(0x20007454,0x20007452,0x40807453,0x20007461,0x80087467);",
  "my($R,$L)=($ENV{LINES}||24,$ENV{COLUMNS}||80);",
  "open(my $m,'+<','/dev/ptmx') or die \"ptmx: $!\";",
  'ioctl($m,$G,0) and ioctl($m,$U,0) or die "pty: $!";',
  'my $n="\\0"x128;ioctl($m,$N,$n) or die "ptyname: $!";$n=~s/\\0.*//s;',
  "ioctl($m,$W,pack('S4',$R,$L,0,0));",
  'my $p=fork();die "fork: $!" unless defined $p;',
  "if($p==0){close $m;POSIX::setsid();",
  " open(my $s,'+<',$n) or die;ioctl($s,$C,0);",
  " POSIX::dup2(fileno($s),0);POSIX::dup2(fileno($s),1);POSIX::dup2(fileno($s),2);",
  " exec(@ARGV);exit 127;}",
  'syswrite(STDOUT,"\\e]7771;gh-ready\\a");',
  "my $sel=IO::Select->new(\\*STDIN,$m);my $bf='';",
  'my $ES="\\e]7770;";',
  "sub rz{my($r,$c)=@_;ioctl($m,$W,pack('S4',$r,$c,0,0));kill 'WINCH',$p;}",
  "OUTER: while(my @rd=$sel->can_read){",
  " for my $h (@rd){",
  "  if(fileno($h)==0){",
  "   my $d;last OUTER unless sysread(STDIN,$d,4096);",
  "   $bf.=$d;",
  "   while((my $i=index($bf,$ES))>=0){",
  "    syswrite($m,substr($bf,0,$i)) if $i>0;",
  '    $bf=substr($bf,$i+7);my $e=index($bf,"\\a");',
  "    last if $e<0;",
  "    my @ps=split(/;/,substr($bf,0,$e));$bf=substr($bf,$e+1);",
  "    rz($ps[0],$ps[1]) if @ps==2;}",
  "   if(length($bf) && index($bf,$ES)<0){syswrite($m,$bf);$bf='';}",
  "  }else{",
  "   my $d;last OUTER unless sysread($m,$d,4096);",
  "   syswrite(STDOUT,$d);}}}",
  "close $m;kill 'HUP',$p;waitpid($p,0);",
].join("\n");

export type PtyBackendId = "python" | "perl" | "pipe";
export type BackendPreference = PtyBackendId | "auto";
export type PlatformName = "mac" | "linux" | "win";

export interface PtyCapabilities {
  /** Whether the shell gets a real terminal: colours, line editing, full-screen apps. */
  tty: boolean;
  /** Whether resizing the pane reaches the shell. */
  resize: boolean;
}

export interface PtyBackendSpec {
  id: PtyBackendId;
  /** Shown in the setup report and in the failure panel. */
  label: string;
  /** Binary that has to answer before this backend can be used. */
  interpreter: "python3" | "perl" | null;
  platforms: readonly PlatformName[];
  capabilities: PtyCapabilities;
  /** Whether the bridge announces itself once the pty is open. */
  handshake: boolean;
  command(
    interpreter: string,
    shell: string,
    platform: PlatformName,
  ): { file: string; args: string[] };
}

/**
 * In the order they are tried.
 *
 * python first because it is the one that carries every platform and has been
 * carrying this feature since it shipped; perl only where it is a real
 * interpreter rather than a stub; the pipe last, because a shell without a
 * terminal is a poor terminal but still better than an empty panel.
 */
export const PTY_BACKENDS: readonly PtyBackendSpec[] = [
  {
    id: "python",
    label: "Python",
    interpreter: "python3",
    platforms: ["mac", "linux"],
    capabilities: { tty: true, resize: true },
    handshake: true,
    command: (interpreter, shell) => ({
      file: interpreter,
      args: ["-c", PYTHON_BRIDGE, shell, "-il"],
    }),
  },
  {
    id: "perl",
    label: "Perl",
    interpreter: "perl",
    platforms: ["mac"],
    capabilities: { tty: true, resize: true },
    handshake: true,
    command: (interpreter, shell) => ({
      file: interpreter,
      args: ["-e", PERL_BRIDGE, shell, "-il"],
    }),
  },
  {
    id: "pipe",
    label: "Pipes (no terminal)",
    interpreter: null,
    platforms: ["mac", "linux", "win"],
    capabilities: { tty: false, resize: false },
    handshake: false,
    // cmd.exe and PowerShell have no -i, and without a pty there is nothing
    // interactive to ask for anyway.
    command: (_interpreter, shell, platform) => ({
      file: shell,
      args: platform === "win" ? [] : ["-i"],
    }),
  },
];

export function backendSpec(id: PtyBackendId): PtyBackendSpec {
  const spec = PTY_BACKENDS.find((b) => b.id === id);
  if (!spec) throw new Error(`unknown pty backend: ${id}`);
  return spec;
}

/**
 * What a session tells the user when the backend cannot give it a real
 * terminal. Saying nothing would leave them to work out from a missing prompt
 * that this is not the shell they know.
 */
export function limitationNotice(spec: PtyBackendSpec): string | null {
  if (spec.capabilities.tty) return null;
  return (
    "No pseudo-terminal available, so this shell runs on plain pipes: " +
    "no prompt, no colours, and full-screen programs will not work. " +
    "Run “Check terminal setup” from the command palette to see why."
  );
}

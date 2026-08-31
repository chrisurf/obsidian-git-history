// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  HANDSHAKE,
  PTY_BACKENDS,
  backendSpec,
  limitationNotice,
} from "../src/terminal/pty-backend";

const spec = (id: "python" | "perl" | "pipe") => backendSpec(id);

describe("the backend table", () => {
  it("ends with one that needs no interpreter, so the walk always finds something", () => {
    const last = PTY_BACKENDS[PTY_BACKENDS.length - 1];
    expect(last.interpreter).toBeNull();
    expect(last.platforms).toContain("win");
    expect(last.platforms).toContain("mac");
    expect(last.platforms).toContain("linux");
  });

  it("offers the perl bridge only where its ioctl numbers are the right ones", () => {
    expect(spec("perl").platforms).toEqual(["mac"]);
  });

  it("promises a terminal only where it can open one", () => {
    expect(spec("python").capabilities).toEqual({ tty: true, resize: true });
    expect(spec("perl").capabilities).toEqual({ tty: true, resize: true });
    expect(spec("pipe").capabilities).toEqual({ tty: false, resize: false });
  });

  it("refuses an id it has no entry for", () => {
    expect(() => backendSpec("nope" as "pipe")).toThrow(/unknown pty backend/);
  });
});

describe("the command each backend runs", () => {
  const zsh = { file: "/bin/zsh", args: ["-il"] };

  it("runs the shell it is handed through the python bridge", () => {
    const { file, args } = spec("python").command("/opt/homebrew/bin/python3", zsh);
    expect(file).toBe("/opt/homebrew/bin/python3");
    expect(args[0]).toBe("-c");
    expect(args.slice(2)).toEqual(["/bin/zsh", "-il"]);
  });

  it("runs the same shell through the perl bridge", () => {
    const { file, args } = spec("perl").command("/usr/bin/perl", zsh);
    expect(file).toBe("/usr/bin/perl");
    expect(args[0]).toBe("-e");
    expect(args.slice(2)).toEqual(["/bin/zsh", "-il"]);
  });

  /**
   * Which flags the shell gets is the startup script's business, not the
   * bridge's — a bash session with a startup script drops -l, and a backend
   * that rebuilt the flags itself would put it back.
   */
  it("passes the shell's own arguments through untouched", () => {
    const bash = { file: "/bin/bash", args: ["-i", "--rcfile", "/tmp/x/bashrc"] };
    expect(spec("python").command("python3", bash).args.slice(2)).toEqual([
      "/bin/bash",
      "-i",
      "--rcfile",
      "/tmp/x/bashrc",
    ]);
    expect(spec("pipe").command("", bash)).toEqual({
      file: "/bin/bash",
      args: ["-i", "--rcfile", "/tmp/x/bashrc"],
    });
  });

  /**
   * Both bridges announce themselves with the marker the session waits for.
   * Changing one without the other would leave the session holding output for
   * a handshake that can never arrive, which is exactly the silent failure the
   * handshake was added to remove.
   */
  it("has both bridges print the marker the session waits for", () => {
    // The marker without its ESC and BEL, which each bridge spells its own way.
    const token = HANDSHAKE.slice(1, -1);
    expect(spec("python").command("python3", zsh).args[1]).toContain(token);
    expect(spec("perl").command("perl", zsh).args[1]).toContain(token);
  });

  it("runs the shell directly when there is no bridge in front of it", () => {
    expect(spec("pipe").command("", { file: "/bin/zsh", args: ["-i"] })).toEqual({
      file: "/bin/zsh",
      args: ["-i"],
    });
    expect(spec("pipe").command("", { file: "powershell.exe", args: [] }).args).toEqual([]);
  });
});

describe("what the user is told about a backend", () => {
  it("says nothing when the shell got a real terminal", () => {
    expect(limitationNotice(spec("python"))).toBeNull();
    expect(limitationNotice(spec("perl"))).toBeNull();
  });

  it("says what is missing when it did not", () => {
    expect(limitationNotice(spec("pipe"))).toMatch(/no prompt, no colours/i);
  });
});

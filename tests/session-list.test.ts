// @vitest-environment node
import { describe, it, expect } from "vitest";
import { SessionList } from "../src/terminal/session-list";

/**
 * The half of the terminal that can be reasoned about without a browser: which
 * session is active, what the strip shows, and what happens to the order.
 */
describe("SessionList — adding", () => {
  it("makes a new session the active one", () => {
    const list = new SessionList();
    const first = list.add("zsh");
    const second = list.add("zsh");
    expect(list.activeId).toBe(second.id);
    expect(list.sessions.map((s) => s.id)).toEqual([first.id, second.id]);
  });

  it("hands out ids that are never reused", () => {
    const list = new SessionList();
    const first = list.add("zsh");
    list.close(first.id);
    expect(list.add("zsh").id).not.toBe(first.id);
  });

  it("numbers repeated shell names", () => {
    const list = new SessionList();
    expect([list.add("zsh").name, list.add("zsh").name, list.add("zsh").name]).toEqual([
      "zsh",
      "zsh (2)",
      "zsh (3)",
    ]);
  });

  it("reuses the lowest free number instead of counting ever upwards", () => {
    const list = new SessionList();
    list.add("zsh");
    const second = list.add("zsh");
    list.add("zsh");
    list.close(second.id);
    expect(list.add("zsh").name).toBe("zsh (2)");
  });

  it("keeps names apart per shell", () => {
    const list = new SessionList();
    expect([list.add("zsh").name, list.add("bash").name]).toEqual(["zsh", "bash"]);
  });
});

describe("SessionList — closing", () => {
  it("hands the active flag to the neighbour on the right", () => {
    const list = new SessionList();
    const first = list.add("zsh");
    const second = list.add("zsh");
    const third = list.add("zsh");
    list.activate(second.id);
    list.close(second.id);
    expect(list.activeId).toBe(third.id);
    expect(list.sessions.map((s) => s.id)).toEqual([first.id, third.id]);
  });

  it("falls back to the left when the last session was closed", () => {
    const list = new SessionList();
    const first = list.add("zsh");
    const second = list.add("zsh");
    list.close(second.id);
    expect(list.activeId).toBe(first.id);
  });

  it("leaves the active session alone when another one closes", () => {
    const list = new SessionList();
    const first = list.add("zsh");
    const second = list.add("zsh");
    list.activate(first.id);
    list.close(second.id);
    expect(list.activeId).toBe(first.id);
  });

  it("ends up with nothing active once the list runs empty", () => {
    const list = new SessionList();
    const only = list.add("zsh");
    expect(list.close(only.id)).toEqual(only);
    expect(list.activeId).toBeNull();
    expect(list.size).toBe(0);
  });

  it("ignores an id it does not know", () => {
    const list = new SessionList();
    list.add("zsh");
    expect(list.close("nope")).toBeNull();
    expect(list.size).toBe(1);
  });

  it("names the other sessions for a close-the-others action", () => {
    const list = new SessionList();
    const first = list.add("zsh");
    const second = list.add("zsh");
    const third = list.add("zsh");
    expect(list.others(second.id)).toEqual([first.id, third.id]);
  });
});

describe("SessionList — order", () => {
  const ids = (list: SessionList): string[] => list.sessions.map((s) => s.name);

  it("moves a session to a later position", () => {
    const list = new SessionList();
    list.add("a");
    list.add("b");
    list.add("c");
    expect(list.move(0, 2)).toBe(true);
    expect(ids(list)).toEqual(["b", "c", "a"]);
  });

  it("moves a session to an earlier position", () => {
    const list = new SessionList();
    list.add("a");
    list.add("b");
    list.add("c");
    list.move(2, 0);
    expect(ids(list)).toEqual(["c", "a", "b"]);
  });

  it("keeps the active session active across a move", () => {
    const list = new SessionList();
    const first = list.add("a");
    list.add("b");
    list.activate(first.id);
    list.move(0, 1);
    expect(list.activeId).toBe(first.id);
  });

  it("refuses a move that goes nowhere or out of range", () => {
    const list = new SessionList();
    list.add("a");
    list.add("b");
    expect(list.move(1, 1)).toBe(false);
    expect(list.move(-1, 0)).toBe(false);
    expect(list.move(0, 5)).toBe(false);
    expect(ids(list)).toEqual(["a", "b"]);
  });
});

describe("SessionList — renaming", () => {
  it("takes a new name", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    expect(list.rename(entry.id, "  build  ")).toBe(true);
    expect(list.entry(entry.id)?.name).toBe("build");
  });

  it("refuses an empty name", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    expect(list.rename(entry.id, "   ")).toBe(false);
    expect(list.entry(entry.id)?.name).toBe("zsh");
  });
});

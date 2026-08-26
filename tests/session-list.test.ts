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

describe("SessionList — icon and colour", () => {
  it("starts every session on the default icon and no colour", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    expect(entry.icon).toBe("terminal");
    expect(entry.color).toBeUndefined();
  });

  it("takes an icon from the pool", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    expect(list.setIcon(entry.id, "bug")).toBe(true);
    expect(list.entry(entry.id)?.icon).toBe("bug");
  });

  it("refuses an empty icon rather than blanking the strip", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    expect(list.setIcon(entry.id, "   ")).toBe(false);
    expect(list.entry(entry.id)?.icon).toBe("terminal");
  });

  it("takes a colour from the palette", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    expect(list.setColor(entry.id, "purple")).toBe(true);
    expect(list.entry(entry.id)?.color).toBe("purple");
  });

  it("drops a colour the stylesheet has no class for", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    list.setColor(entry.id, "green");
    expect(list.setColor(entry.id, "chartreuse")).toBe(true);
    expect(list.entry(entry.id)?.color).toBeUndefined();
  });

  it("clears a colour on reset", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    list.setColor(entry.id, "red");
    expect(list.setColor(entry.id, undefined)).toBe(true);
    expect(list.entry(entry.id)?.color).toBeUndefined();
  });

  it("reports no change when the value is already set, so the strip is not redrawn", () => {
    const list = new SessionList();
    const entry = list.add("zsh");
    list.setColor(entry.id, "blue");
    expect(list.setColor(entry.id, "blue")).toBe(false);
    expect(list.setIcon(entry.id, "terminal")).toBe(false);
  });

  it("takes a colour when the session is created", () => {
    const list = new SessionList();
    expect(list.add("zsh", "cyan").color).toBe("cyan");
    expect(list.add("zsh", "not-a-colour").color).toBeUndefined();
  });

  it("lists the colours in use, gaps included", () => {
    const list = new SessionList();
    list.add("a", "red");
    list.add("b");
    list.add("c", "blue");
    expect(list.colorsInUse()).toEqual(["red", undefined, "blue"]);
  });

  it("leaves icon and colour alone across a move", () => {
    const list = new SessionList();
    const first = list.add("a");
    list.add("b");
    list.setIcon(first.id, "flame");
    list.setColor(first.id, "orange");
    list.move(0, 1);
    expect(list.entry(first.id)).toMatchObject({ icon: "flame", color: "orange" });
  });

  it("ignores an unknown session", () => {
    const list = new SessionList();
    expect(list.setIcon("nope", "bug")).toBe(false);
    expect(list.setColor("nope", "red")).toBe(false);
  });
});

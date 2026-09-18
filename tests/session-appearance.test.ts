// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import {
  DEFAULT_SESSION_ICON,
  ICONS_PER_ROW,
  SESSION_COLORS,
  SESSION_ICONS,
  availableIcons,
  colorClass,
  isSessionColor,
  nextColor,
} from "../src/terminal/session-appearance";

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

describe("session palette", () => {
  it("offers the default icon as one of the choices", () => {
    expect(SESSION_ICONS).toContain(DEFAULT_SESSION_ICON);
  });

  it("has no duplicate icons", () => {
    expect(new Set(SESSION_ICONS).size).toBe(SESSION_ICONS.length);
  });

  /**
   * The pool is grouped by subject, eight to a line, and the picker's grid is
   * eight columns wide. A pool that is not a whole number of lines — or a grid
   * that is not eight wide — breaks the grouping into a run of glyphs again,
   * silently, because nothing about it looks wrong.
   */
  it("fills whole lines of the picker's grid", () => {
    expect(SESSION_ICONS.length % ICONS_PER_ROW).toBe(0);
    expect(css).toContain(`grid-template-columns: repeat(${ICONS_PER_ROW}, 1fr)`);
  });

  /**
   * A session is named after the work in it, and that work is rarely about the
   * terminal. One icon from each area the pool is meant to cover, so a pool
   * that quietly drifts back to one subject fails here.
   */
  it("covers the areas the work comes from, not just the shell", () => {
    for (const icon of [
      "terminal",
      "bot",
      "mail",
      "calendar",
      "file-spreadsheet",
      "folder",
      "presentation",
      "headphones",
      "briefcase",
      "banknote",
      "globe",
      "plane",
    ]) {
      expect(SESSION_ICONS, `${icon} is missing from the pool`).toContain(icon);
    }
  });

  it("names a class only for a colour the stylesheet knows", () => {
    expect(colorClass("green")).toBe("gs-terminal-color-green");
    expect(colorClass("chartreuse")).toBeNull();
    expect(colorClass(undefined)).toBeNull();
  });

  it("recognises exactly the palette", () => {
    expect(isSessionColor("pink")).toBe(true);
    expect(isSessionColor("")).toBe(false);
    expect(isSessionColor(undefined)).toBe(false);
  });

  /**
   * The tint reaches the strip through a class, so a colour without a rule is
   * a colour that silently does nothing. Both places the class is used have to
   * carry it: the strip tab and the modal's swatch.
   */
  it("has a stylesheet rule for every colour", () => {
    for (const color of SESSION_COLORS) {
      expect(css).toContain(`.gs-terminal-tab.gs-terminal-color-${color.id}`);
      expect(css).toContain(`.gs-appearance-color.gs-terminal-color-${color.id}`);
      expect(css).toContain(`.gs-appearance-icon.gs-terminal-color-${color.id}`);
    }
  });

  it("uses Obsidian's own theme variables so both themes stay right", () => {
    for (const color of SESSION_COLORS) {
      expect(css).toContain(`var(--color-${color.id})`);
    }
  });
});

describe("automatic colours", () => {
  it("hands out the first colour to the first session", () => {
    expect(nextColor([])).toBe(SESSION_COLORS[0].id);
  });

  it("skips colours already on screen", () => {
    expect(nextColor([SESSION_COLORS[0].id])).toBe(SESSION_COLORS[1].id);
    expect(nextColor([SESSION_COLORS[1].id])).toBe(SESSION_COLORS[0].id);
  });

  it("ignores sessions left at the default colour", () => {
    expect(nextColor([undefined, undefined])).toBe(SESSION_COLORS[0].id);
  });

  it("ignores a stored value that is not in the palette", () => {
    expect(nextColor(["chartreuse"])).toBe(SESSION_COLORS[0].id);
  });

  it("wraps around once every colour is taken instead of running out", () => {
    const all = SESSION_COLORS.map((c) => c.id);
    expect(isSessionColor(nextColor(all))).toBe(true);
  });

  it("gives eight sessions eight distinct colours", () => {
    const used: string[] = [];
    for (let i = 0; i < SESSION_COLORS.length; i++) used.push(nextColor(used));
    expect(new Set(used).size).toBe(SESSION_COLORS.length);
  });
});

describe("icons the running Obsidian knows", () => {
  it("keeps the whole pool when there is no registry to check against", () => {
    expect(availableIcons()).toEqual(SESSION_ICONS);
    expect(availableIcons([])).toEqual(SESSION_ICONS);
  });

  it("accepts both the bare and the lucide-prefixed spelling", () => {
    expect(availableIcons(["terminal", "lucide-bug"])).toEqual(["terminal", "bug"]);
  });

  it("drops an icon the app no longer registers", () => {
    const known = SESSION_ICONS.filter((i) => i !== "palmtree").map((i) => `lucide-${i}`);
    expect(availableIcons(known)).not.toContain("palmtree");
    expect(availableIcons(known)).toContain("terminal");
  });

  /**
   * A registry that matches nothing is a naming change on Obsidian's side, not
   * forty deleted icons — an empty picker would be the worse guess.
   */
  it("falls back to the pool when the registry matches nothing at all", () => {
    expect(availableIcons(["something-else-entirely"])).toEqual(SESSION_ICONS);
  });
});

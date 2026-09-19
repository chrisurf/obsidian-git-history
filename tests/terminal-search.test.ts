// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  NO_OPTIONS,
  isDark,
  resultLabel,
  searchColors,
  searchable,
} from "../src/terminal/terminal-search";

/**
 * The rules around the search, apart from the terminal that does it: what the
 * counter says, which terms are worth handing to xterm at all, and which
 * colours a match is painted in. All three are decisions, and none of them
 * needs a terminal to be checked.
 */

describe("what the counter says", () => {
  it("says nothing at all before anything is typed", () => {
    expect(resultLabel("", { index: 0, count: 0 })).toBe("");
  });

  it("names the position and the total", () => {
    expect(resultLabel("error", { index: 3, count: 17 })).toBe("3 of 17");
  });

  /**
   * xterm reports -1 as the active result while it is still counting, or when
   * there are more matches than it highlights. "17 results" is true then;
   * "0 of 17" would be a lie about the match the user is looking at.
   */
  it("gives the total alone when there is no position yet", () => {
    expect(resultLabel("error", { index: 0, count: 17 })).toBe("17 results");
  });

  it("says so when there is nothing to find", () => {
    expect(resultLabel("error", { index: 0, count: 0 })).toBe("No results");
  });
});

describe("what is worth searching for", () => {
  it("does not search for nothing", () => {
    expect(searchable("", NO_OPTIONS)).toBe(false);
  });

  it("takes any text as a plain term", () => {
    expect(searchable("foo(", NO_OPTIONS)).toBe(true);
  });

  /**
   * A regular expression halfway through being typed is not an error to show
   * anyone, but handing it over throws inside xterm — so it is caught here and
   * the field is simply marked until the next keystroke.
   */
  it("waits for a regular expression to be finished", () => {
    expect(searchable("foo(", { caseSensitive: false, regex: true })).toBe(false);
    expect(searchable("foo(.*)", { caseSensitive: false, regex: true })).toBe(true);
  });
});

describe("the colour a match is painted in", () => {
  /**
   * The addon takes `#RRGGBB` only — no alpha, no CSS variable — so the theme
   * cannot decide this and the background has to.
   */
  it("reads the background a theme hands over, in every spelling", () => {
    expect(isDark("#1e1e1e")).toBe(true);
    expect(isDark("#FFFFFF")).toBe(false);
    expect(isDark("#fff")).toBe(false);
    expect(isDark("rgb(30, 30, 30)")).toBe(true);
    expect(isDark("rgba(255, 255, 255, 0.9)")).toBe(false);
  });

  it("takes a background it cannot read for a dark one, which terminals are", () => {
    expect(isDark("")).toBe(true);
    expect(isDark("var(--background-primary)")).toBe(true);
  });

  it("picks colours that stand out on either kind of terminal", () => {
    const dark = searchColors("#1e1e1e");
    const light = searchColors("#ffffff");

    expect(isDark(dark.matchBackground)).toBe(true);
    expect(isDark(light.matchBackground)).toBe(false);
    // The current match has to be findable among the others, whichever way
    // round the theme is.
    expect(dark.activeMatchBackground).not.toBe(dark.matchBackground);
    expect(light.activeMatchBackground).not.toBe(light.matchBackground);
  });

  it("gives every colour in the form the addon accepts", () => {
    for (const colors of [searchColors("#1e1e1e"), searchColors("#ffffff")]) {
      for (const value of Object.values(colors)) {
        expect(value, `${value} is not #RRGGBB`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });
});

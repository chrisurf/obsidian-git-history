import { describe, it, expect, beforeEach } from "vitest";
import { TerminalSearchBar } from "../src/components/terminal-search-bar";
import type { SearchTarget } from "../src/components/terminal-search-bar";
import type { SearchOptions, SearchResults } from "../src/terminal/terminal-search";

/**
 * The find bar, driven the way a user drives it: type, press Enter, press the
 * arrows, switch sessions, press Escape. What it must get right is small and
 * easy to get wrong — that typing re-runs the search where it is instead of
 * walking forward through the buffer with every keystroke, that Escape gives
 * the shell its keyboard back, and that the highlighting never outlives the
 * bar or follows the wrong session.
 */

class FakeSession implements SearchTarget {
  calls: { term: string; options: SearchOptions; direction: string }[] = [];
  cleared = 0;
  focused = 0;
  selected = "";
  /** Terms this session has something for; everything else finds nothing. */
  matches = new Map<string, number>();
  private handler: ((results: SearchResults) => void) | null = null;
  private unsubscribed = 0;

  find(term: string, options: SearchOptions, direction: "next" | "previous"): boolean {
    this.calls.push({ term, options: { ...options }, direction });
    const count = this.matches.get(term) ?? 0;
    if (count === 0) return false;
    this.handler?.({ index: 1, count });
    return true;
  }

  clearSearch(): void {
    this.cleared++;
  }

  onSearchResults(handler: (results: SearchResults) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
      this.unsubscribed++;
    };
  }

  selection(): string {
    return this.selected;
  }

  focus(): void {
    this.focused++;
  }

  get listeners(): number {
    return this.handler ? 1 : 0;
  }

  get releases(): number {
    return this.unsubscribed;
  }
}

let container: HTMLElement;
let bar: TerminalSearchBar;

const el = (cls: string): HTMLElement | null => container.querySelector(`.${cls}`);
const input = (): HTMLInputElement =>
  container.querySelector(".gs-terminal-search-input") as HTMLInputElement;
const count = (): string => el("gs-terminal-search-count")?.textContent ?? "";
const hidden = (): boolean => el("gs-terminal-search")?.classList.contains("gs-hidden") ?? false;
const button = (label: string): HTMLElement =>
  container.querySelector(`[aria-label^="${label}"]`) as HTMLElement;

const type = (text: string): void => {
  input().value = text;
  input().dispatchEvent(new Event("input"));
};

const press = (key: string, shift = false): void => {
  input().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true }));
};

beforeEach(() => {
  container = activeDocument.createElement("div");
  bar = new TerminalSearchBar(container);
});

describe("opening and closing", () => {
  it("stays out of the way until it is opened", () => {
    expect(hidden()).toBe(true);
    expect(bar.isOpen).toBe(false);
  });

  it("opens on the session it is given", () => {
    const session = new FakeSession();
    bar.show(session);

    expect(hidden()).toBe(false);
    expect(bar.isOpen).toBe(true);
    expect(session.listeners).toBe(1);
  });

  /** "I can see it, find me the next one" should be one shortcut, not a
      shortcut and then typing the word out again. */
  it("starts from what is selected in the terminal", () => {
    const session = new FakeSession();
    session.selected = "  connection refused  ";
    session.matches.set("connection refused", 4);

    bar.show(session);

    expect(input().value).toBe("connection refused");
    expect(count()).toBe("1 of 4");
  });

  it("leaves a selection spanning several lines alone", () => {
    const session = new FakeSession();
    session.selected = "line one\nline two";
    bar.show(session);
    expect(input().value).toBe("");
  });

  it("gives the keyboard back to the shell on Escape, and drops the highlighting", () => {
    const session = new FakeSession();
    session.matches.set("npm", 2);
    bar.show(session);
    type("npm");

    press("Escape");

    expect(bar.isOpen).toBe(false);
    expect(hidden()).toBe(true);
    expect(session.focused).toBe(1);
    expect(session.cleared).toBeGreaterThan(0);
    expect(count()).toBe("");
  });

  it("closes from the close button too", () => {
    const session = new FakeSession();
    bar.show(session);
    button("Close").click();
    expect(bar.isOpen).toBe(false);
  });
});

describe("searching", () => {
  it("searches as it is typed, and counts what it found", () => {
    const session = new FakeSession();
    session.matches.set("error", 12);
    bar.show(session);

    type("error");

    expect(session.calls.at(-1)?.term).toBe("error");
    expect(count()).toBe("1 of 12");
  });

  /**
   * Typing has to search from where the search is, not move on: a term
   * searched forwards on every keystroke walks away from the person typing it.
   */
  it("does not step through matches while the term is being typed", () => {
    const session = new FakeSession();
    session.matches.set("e", 9);
    session.matches.set("er", 5);
    bar.show(session);

    type("e");
    type("er");

    expect(session.calls.map((c) => c.term)).toEqual(["e", "er"]);
    expect(session.calls.map((c) => c.direction)).toEqual(["next", "next"]);
  });

  it("steps forwards on Enter and back on Shift+Enter", () => {
    const session = new FakeSession();
    session.matches.set("error", 12);
    bar.show(session);
    type("error");

    press("Enter");
    press("Enter", true);

    expect(session.calls.at(-2)?.direction).toBe("next");
    expect(session.calls.at(-1)?.direction).toBe("previous");
  });

  it("steps from the arrows as well", () => {
    const session = new FakeSession();
    session.matches.set("error", 12);
    bar.show(session);
    type("error");

    button("Previous match").click();
    expect(session.calls.at(-1)?.direction).toBe("previous");

    button("Next match").click();
    expect(session.calls.at(-1)?.direction).toBe("next");
  });

  it("says when a term is nowhere in the buffer", () => {
    const session = new FakeSession();
    bar.show(session);

    type("nothing here");

    expect(count()).toBe("No results");
    expect(el("gs-terminal-search")?.classList.contains("gs-terminal-search-empty")).toBe(true);
  });

  it("asks for nothing once the field is emptied again", () => {
    const session = new FakeSession();
    session.matches.set("error", 3);
    bar.show(session);
    type("error");
    const asked = session.calls.length;

    type("");

    expect(session.calls.length).toBe(asked);
    expect(session.cleared).toBeGreaterThan(0);
    expect(count()).toBe("");
  });
});

describe("the toggles", () => {
  it("passes match case and regular expression through to the search", () => {
    const session = new FakeSession();
    session.matches.set("Error", 1);
    bar.show(session);
    type("Error");

    button("Match case").click();
    expect(session.calls.at(-1)?.options).toEqual({ caseSensitive: true, regex: false });

    button("Use regular expression").click();
    expect(session.calls.at(-1)?.options).toEqual({ caseSensitive: true, regex: true });
  });

  it("shows which ones are on", () => {
    bar.show(new FakeSession());
    button("Match case").click();
    expect(button("Match case").classList.contains("gs-terminal-search-on")).toBe(true);
  });

  /** Half a regular expression is not an error worth a message, but it is not
      something to hand to xterm either — it throws on it. */
  it("marks an unfinished regular expression instead of searching for it", () => {
    const session = new FakeSession();
    bar.show(session);
    button("Use regular expression").click();

    type("error(");

    expect(session.calls.every((c) => c.term !== "error(")).toBe(true);
    expect(el("gs-terminal-search")?.classList.contains("gs-terminal-search-bad")).toBe(true);
  });
});

describe("following the session in front", () => {
  it("searches the session that was switched to", () => {
    const first = new FakeSession();
    const second = new FakeSession();
    first.matches.set("error", 2);
    second.matches.set("error", 7);

    bar.show(first);
    type("error");
    bar.retarget(second);

    expect(first.cleared).toBeGreaterThan(0);
    expect(first.releases).toBe(1);
    expect(second.calls.at(-1)?.term).toBe("error");
    expect(count()).toBe("1 of 7");
  });

  it("does not search a session nobody is looking at", () => {
    const first = new FakeSession();
    const second = new FakeSession();
    bar.show(first);
    type("error");
    const asked = first.calls.length;

    bar.retarget(second);
    type("error rate");

    expect(first.calls.length).toBe(asked);
    expect(second.calls.at(-1)?.term).toBe("error rate");
  });

  it("closes when the last session goes away", () => {
    const session = new FakeSession();
    bar.show(session);
    bar.retarget(null);
    expect(bar.isOpen).toBe(false);
  });

  it("lets go of the session it was listening to when it is taken down", () => {
    const session = new FakeSession();
    bar.show(session);
    bar.destroy();

    expect(session.releases).toBe(1);
    expect(container.querySelector(".gs-terminal-search")).toBeNull();
  });
});

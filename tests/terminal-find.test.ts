import { describe, it, expect, beforeEach } from "vitest";
import { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";
import { TERMINAL_SCROLLBACK, TerminalFind, optionsChanged } from "../src/terminal/terminal-find";
import { NO_OPTIONS } from "../src/terminal/terminal-search";
import type { SearchResults } from "../src/terminal/terminal-search";

/**
 * Searching a real xterm, because both failures live in the terminal and the
 * addon, not in the bar: a word that had scrolled out of a 1000-line buffer,
 * and highlights that stayed on the old matches after "Match case" was turned
 * on. Neither shows up against a stub.
 */

let terminal: Terminal;
let find: TerminalFind;
let results: SearchResults;

const write = (data: string): Promise<void> =>
  new Promise((resolve) => terminal.write(data, resolve));

function open(scrollback?: number): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  // Left out rather than undefined, which xterm takes as a length.
  const options = scrollback === undefined ? {} : { scrollback };
  terminal = new Terminal({ cols: 40, rows: 10, allowProposedApi: true, ...options });
  const addon = new SearchAddon();
  terminal.loadAddon(addon);
  terminal.open(host);
  find = new TerminalFind(addon, () => "#1e1e1e");
  results = { index: 0, count: 0 };
  find.onResults((r) => (results = r));
}

describe("searching far back in a session", () => {
  beforeEach(() => open(TERMINAL_SCROLLBACK));

  it("finds a word thousands of lines up", async () => {
    await write("needle at the top\r\n");
    for (let i = 0; i < 3000; i++) await write(`line ${i}\r\n`);
    expect(find.find("needle", NO_OPTIONS, "next")).toBe(true);
    expect(results.count).toBe(1);
  });

  it("would have lost it with xterm's default of 1000 lines", async () => {
    open();
    await write("needle at the top\r\n");
    for (let i = 0; i < 1500; i++) await write(`line ${i}\r\n`);
    expect(find.find("needle", NO_OPTIONS, "next")).toBe(false);
  });
});

describe("changing the options of a search", () => {
  beforeEach(() => open(TERMINAL_SCROLLBACK));

  it("recounts and repaints when Match case is turned on", async () => {
    await write("Foo foo FOO\r\n");
    find.find("foo", NO_OPTIONS, "next");
    expect(results.count).toBe(3);

    find.find("foo", { caseSensitive: true, regex: false }, "next");
    expect(results).toEqual({ index: 1, count: 1 });
    expect(terminal.getSelection()).toBe("foo");
  });

  it("recounts when it is turned off again", async () => {
    await write("Foo foo FOO\r\n");
    find.find("foo", { caseSensitive: true, regex: false }, "next");
    find.find("foo", NO_OPTIONS, "next");
    expect(results.count).toBe(3);
  });

  it("recounts when a term turns into a regular expression", async () => {
    await write("a.c abc a.c\r\n");
    find.find("a.c", NO_OPTIONS, "next");
    expect(results.count).toBe(2);
    find.find("a.c", { caseSensitive: false, regex: true }, "next");
    expect(results.count).toBe(3);
  });

  it("keeps the position when only stepping to the next match", async () => {
    await write("foo foo foo\r\n");
    find.find("foo", NO_OPTIONS, "next");
    find.find("foo", NO_OPTIONS, "next");
    expect(results).toEqual({ index: 2, count: 3 });
  });
});

describe("optionsChanged", () => {
  it("tells a toggled option from the same one", () => {
    expect(optionsChanged(NO_OPTIONS, { ...NO_OPTIONS })).toBe(false);
    expect(optionsChanged(NO_OPTIONS, { caseSensitive: true, regex: false })).toBe(true);
    expect(optionsChanged(NO_OPTIONS, { caseSensitive: false, regex: true })).toBe(true);
  });
});

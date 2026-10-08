import type { SearchAddon } from "@xterm/addon-search";
import { searchColors } from "./terminal-search";
import type { SearchOptions, SearchResults } from "./terminal-search";

/**
 * How many lines of output a session keeps. xterm's default is 1000, which a
 * single build or `git log` fills: anything older is gone from the buffer, and
 * a search for it comes back empty although the user saw it scroll past.
 */
export const TERMINAL_SCROLLBACK = 10000;

/**
 * The search half of a session: xterm's addon, plus what it gets wrong.
 *
 * The addon decides whether to repaint its highlights by comparing the options
 * of a search with those of the last one — but it stores the new options
 * first, so it compares them with themselves and never sees a change. Turning
 * on "Match case" for the same term then moves the selection under the new
 * rule while the highlights and the counter stay on the old one: three
 * matches painted, "2 of 3", one actually reachable. Dropping the highlights
 * whenever the options change makes the next search paint them afresh.
 */
export class TerminalFind {
  private last: { term: string; options: SearchOptions } | null = null;

  constructor(
    private addon: SearchAddon,
    private background: () => string,
  ) {}

  /** Searches forwards or backwards, and paints every match on the way. */
  find(term: string, options: SearchOptions, direction: "next" | "previous"): boolean {
    if (this.last && optionsChanged(this.last.options, options)) this.addon.clearDecorations();
    this.last = { term, options: { ...options } };
    const search = {
      caseSensitive: options.caseSensitive,
      regex: options.regex,
      decorations: searchColors(this.background()),
    };
    return direction === "next"
      ? this.addon.findNext(term, search)
      : this.addon.findPrevious(term, search);
  }

  /** Drops the highlighting, for a search bar that is being closed. */
  clear(): void {
    this.last = null;
    this.addon.clearDecorations();
  }

  /** Whether a search is currently painted. */
  get active(): boolean {
    return this.last !== null;
  }

  /** How many matches the last search found, and which one is current. */
  onResults(handler: (results: SearchResults) => void): () => void {
    const subscription = this.addon.onDidChangeResults((event) =>
      handler({ index: event.resultIndex + 1, count: event.resultCount }),
    );
    return () => subscription.dispose();
  }
}

export function optionsChanged(a: SearchOptions, b: SearchOptions): boolean {
  return a.caseSensitive !== b.caseSensitive || a.regex !== b.regex;
}

import { setIcon } from "obsidian";
import { NO_OPTIONS, NO_RESULTS, resultLabel, searchable } from "../terminal/terminal-search";
import type { SearchOptions, SearchResults } from "../terminal/terminal-search";

/**
 * Finding something in a terminal.
 *
 * A shell session is a long scroll of text with no way through it: the output
 * of the build that failed twenty minutes ago is still there, and until now
 * the only way back to it was the scrollbar. Every terminal that is worth
 * using has a find bar, and this is that bar — the same shape VS Code uses,
 * because that is the one people already know: a field, a match counter, the
 * two arrows, and Escape to get out.
 *
 * It searches whatever session is in front, and follows when that changes.
 * The searching itself belongs to xterm's addon; what is here is the asking,
 * the counting and the keyboard.
 */

/** What the bar needs from a session. `TerminalSession` fits it as it is. */
export interface SearchTarget {
  find(term: string, options: SearchOptions, direction: "next" | "previous"): boolean;
  clearSearch(): void;
  onSearchResults(handler: (results: SearchResults) => void): () => void;
  selection(): string;
  focus(): void;
}

export class TerminalSearchBar {
  private el: HTMLElement;
  private input: HTMLInputElement;
  private countEl: HTMLElement;
  private caseButton: HTMLElement;
  private regexButton: HTMLElement;
  private target: SearchTarget | null = null;
  private unsubscribe: (() => void) | null = null;
  private options: SearchOptions = { ...NO_OPTIONS };
  private results: SearchResults = { ...NO_RESULTS };
  private open = false;

  constructor(parent: HTMLElement) {
    this.el = parent.createDiv("gs-terminal-search gs-hidden");

    const field = this.el.createDiv("gs-terminal-search-field");
    this.input = field.createEl("input", {
      cls: "gs-terminal-search-input",
      attr: { type: "text", placeholder: "Find", "aria-label": "Find in terminal" },
    });
    this.countEl = field.createSpan("gs-terminal-search-count");

    this.caseButton = this.toggle(field, "case-sensitive", "Match case", () => {
      this.options.caseSensitive = !this.options.caseSensitive;
      this.paintToggles();
      this.search("next", false);
    });
    this.regexButton = this.toggle(field, "regex", "Use regular expression", () => {
      this.options.regex = !this.options.regex;
      this.paintToggles();
      this.search("next", false);
    });

    this.button(this.el, "arrow-up", "Previous match (Shift+Enter)", () =>
      this.search("previous", true),
    );
    this.button(this.el, "arrow-down", "Next match (Enter)", () => this.search("next", true));
    this.button(this.el, "x", "Close (Escape)", () => this.close());

    this.input.addEventListener("input", () => this.search("next", false));
    this.input.addEventListener("keydown", (event) => this.onKey(event));
    this.paintToggles();
  }

  get isOpen(): boolean {
    return this.open;
  }

  /**
   * Shows the bar over a session, and starts from what is selected in it.
   *
   * Taking the selection is what makes "I can see it, find the next one"
   * a single shortcut. A multi-line selection is not a search term, so it is
   * left alone, and so is a previous term when there is nothing selected —
   * pressing find twice should offer what was searched for last.
   */
  show(target: SearchTarget): void {
    this.retarget(target);
    this.open = true;
    this.el.removeClass("gs-hidden");

    const selected = target.selection().trim();
    if (selected !== "" && !selected.includes("\n")) this.input.value = selected;

    this.input.focus();
    this.input.select();
    this.search("next", false);
  }

  /** Hides the bar, drops the highlighting, and gives the shell the keyboard back. */
  close(): void {
    if (!this.open) return;
    this.open = false;
    this.el.addClass("gs-hidden");
    this.results = { ...NO_RESULTS };
    // Cleared rather than repainted: the term is still in the field, and
    // "No results" is about a search that is no longer running.
    this.countEl.setText("");
    this.el.removeClasses(["gs-terminal-search-empty", "gs-terminal-search-bad"]);
    this.target?.clearSearch();
    this.target?.focus();
  }

  /**
   * Points the bar at another session, or at none.
   *
   * Switching sessions with the bar open searches the session now in front:
   * the alternative is a bar showing counts for a terminal nobody is looking
   * at. A session that goes away closes the bar rather than leaving it
   * pointing at a disposed terminal.
   */
  retarget(target: SearchTarget | null): void {
    if (this.target === target) return;

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.target?.clearSearch();
    this.target = target;

    if (!target) {
      if (this.open) this.close();
      return;
    }
    this.unsubscribe = target.onSearchResults((results) => {
      this.results = results;
      this.paintCount();
    });
    if (this.open) this.search("next", false);
  }

  /** Focuses the field again, for a find shortcut pressed while it is open. */
  focus(): void {
    this.input.focus();
    this.input.select();
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.target = null;
    this.el.remove();
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      this.search(event.shiftKey ? "previous" : "next", true);
    }
  }

  /**
   * Runs the search.
   *
   * `step` separates the two reasons to search: pressing an arrow moves to
   * another match, typing re-runs the same search from where it is. Without
   * that, every keystroke would walk forwards through the buffer and the
   * matches would run away from the person typing.
   */
  private search(direction: "next" | "previous", step: boolean): void {
    const term = this.input.value;
    const target = this.target;
    if (!target) return;

    if (!searchable(term, this.options)) {
      target.clearSearch();
      this.results = { ...NO_RESULTS };
      this.el.toggleClass("gs-terminal-search-bad", term !== "");
      this.paintCount();
      return;
    }

    this.el.removeClass("gs-terminal-search-bad");
    const found = target.find(term, this.options, step ? direction : "next");
    if (!found) {
      this.results = { ...NO_RESULTS };
      this.paintCount();
    }
  }

  private paintCount(): void {
    const term = this.input.value;
    this.countEl.setText(resultLabel(term, this.results));
    this.el.toggleClass(
      "gs-terminal-search-empty",
      term !== "" && this.results.count === 0 && !this.el.hasClass("gs-terminal-search-bad"),
    );
  }

  private paintToggles(): void {
    this.caseButton.toggleClass("gs-terminal-search-on", this.options.caseSensitive);
    this.regexButton.toggleClass("gs-terminal-search-on", this.options.regex);
  }

  private toggle(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const button = this.button(parent, icon, label, onClick);
    button.addClass("gs-terminal-search-toggle");
    return button;
  }

  private button(
    parent: HTMLElement,
    icon: string,
    label: string,
    onClick: () => void,
  ): HTMLElement {
    const button = parent.createEl("button", {
      cls: "gs-terminal-search-btn",
      attr: { type: "button", "aria-label": label, title: label },
    });
    setIcon(button, icon);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      onClick();
      // Every button here acts on the field's content, so the field keeps the
      // keyboard: clicking "next" and then typing should narrow the search,
      // not go nowhere.
      this.input.focus();
    });
    return button;
  }
}

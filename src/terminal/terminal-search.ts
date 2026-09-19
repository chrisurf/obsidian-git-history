/**
 * Searching a terminal: what is asked for, what comes back, and what a match
 * is painted in.
 *
 * Kept apart from both the xterm addon that does the searching and the bar
 * that asks for it, so the rules — what an empty term means, when a search is
 * worth repeating, which colours a theme gets — are testable without a
 * terminal and without a DOM.
 */

/** What the user has switched on in the search bar. */
export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export const NO_OPTIONS: SearchOptions = { caseSensitive: false, regex: false };

/** What a search came back with. `index` is 1-based for display, 0 for none. */
export interface SearchResults {
  index: number;
  count: number;
}

export const NO_RESULTS: SearchResults = { index: 0, count: 0 };

/**
 * What the counter says.
 *
 * xterm reports the active result as -1 while it is still counting, and as an
 * index into a list that may be longer than the highlight limit. "17 results"
 * without a position is a truthful answer to that, and better than showing
 * "0 of 17" for a match the user is looking straight at.
 */
export function resultLabel(term: string, results: SearchResults): string {
  if (term === "") return "";
  if (results.count === 0) return "No results";
  if (results.index < 1) return `${results.count} results`;
  return `${results.index} of ${results.count}`;
}

/**
 * Whether a term can be searched for at all.
 *
 * An unfinished regex — `foo(` while it is being typed — is not an error worth
 * showing, but it is not something to hand to the addon either: xterm builds a
 * RegExp from it and throws. The bar marks the field instead and waits for the
 * next keystroke.
 */
export function searchable(term: string, options: SearchOptions): boolean {
  if (term === "") return false;
  if (!options.regex) return true;
  try {
    new RegExp(term);
    return true;
  } catch {
    return false;
  }
}

/** The colours a match is painted in, which depend on what is behind it. */
export interface SearchColors {
  matchBackground: string;
  matchOverviewRuler: string;
  activeMatchBackground: string;
  activeMatchColorOverviewRuler: string;
}

/**
 * Match colours for a terminal on this background.
 *
 * The addon takes `#RRGGBB` only — no alpha, no CSS variable — so a colour
 * that works on a dark terminal is unreadable on a light one and there is no
 * way to let the theme decide. The background it will sit on is the one thing
 * that is known, so it picks the pair: a dim amber under the matches and a
 * brighter one under the current one, dark on light themes and vice versa.
 */
export function searchColors(background: string): SearchColors {
  return isDark(background)
    ? {
        matchBackground: "#5c4a1a",
        matchOverviewRuler: "#b8912f",
        activeMatchBackground: "#b8912f",
        activeMatchColorOverviewRuler: "#f2c14e",
      }
    : {
        matchBackground: "#f5deA0",
        matchOverviewRuler: "#c89b1c",
        activeMatchBackground: "#f0b429",
        activeMatchColorOverviewRuler: "#a36f00",
      };
}

/**
 * Whether a colour reads as dark, for the one decision above.
 *
 * Handles what a theme actually hands over: `#rgb`, `#rrggbb` and the
 * `rgb()`/`rgba()` forms a computed style returns. Anything else is treated as
 * dark, which is the default terminal background and the safer guess.
 */
export function isDark(color: string): boolean {
  const rgb = parseColor(color);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  // Rec. 601 luma: good enough to tell a dark terminal from a light one, and
  // it needs no colour space conversion to be read later.
  return (r * 299 + g * 587 + b * 114) / 1000 < 128;
}

function parseColor(color: string): [number, number, number] | null {
  const value = color.trim().toLowerCase();

  if (value.startsWith("#")) {
    const hex = value.slice(1);
    if (hex.length === 3) {
      const [r, g, b] = hex.split("");
      return [byte(r + r), byte(g + g), byte(b + b)];
    }
    if (hex.length === 6 || hex.length === 8) {
      return [byte(hex.slice(0, 2)), byte(hex.slice(2, 4)), byte(hex.slice(4, 6))];
    }
    return null;
  }

  const numbers = value.match(/\d+(\.\d+)?/g);
  if (value.startsWith("rgb") && numbers && numbers.length >= 3) {
    return [Number(numbers[0]), Number(numbers[1]), Number(numbers[2])];
  }
  return null;
}

function byte(hex: string): number {
  const parsed = Number.parseInt(hex, 16);
  return Number.isNaN(parsed) ? 0 : parsed;
}

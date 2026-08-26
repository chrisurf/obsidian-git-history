/**
 * The icons and colours a terminal session can be marked with.
 *
 * VS Code lets a terminal tab pick any codicon and one of the eight non-bright
 * ANSI colours, which is what makes a wall of identical `>_` icons readable
 * again. The same idea, cut down to what fits a 26px strip: a curated pool
 * rather than the whole icon library, because a searchable grid of a thousand
 * glyphs is a lot of machinery for a decision that takes one glance.
 *
 * Pure data, no DOM — the view turns it into elements, the modal into a grid.
 */

/** Icon a session shows until someone picks another one. */
export const DEFAULT_SESSION_ICON = "terminal";

/**
 * The pool the picker offers.
 *
 * Every entry is an icon Obsidian itself uses somewhere in its own interface,
 * so it is registered no matter which Lucide version the running app bundles.
 * `availableIcons()` still filters the list at runtime for the case where a
 * future release drops one — an empty box in the strip is worse than a
 * slightly shorter pool.
 */
export const SESSION_ICONS: readonly string[] = [
  "terminal",
  "terminal-square",
  "code-2",
  "bug",
  "git-fork",
  "github",
  "zap",
  "flame",
  "wrench",
  "hard-drive",
  "layers",
  "globe",
  "monitor",
  "keyboard",
  "clock",
  "timer",
  "folder",
  "file-text",
  "search",
  "bookmark",
  "pin",
  "tag",
  "heart",
  "ghost",
];

/** A colour a session icon can be tinted with. `id` is what gets stored. */
export interface SessionColor {
  id: string;
  label: string;
}

/**
 * Obsidian's own accent colours rather than VS Code's ANSI names.
 *
 * They are theme variables (`--color-red` and friends), so a session marked
 * "red" follows whatever the vault's theme calls red and keeps working in both
 * light and dark mode — a hardcoded hex would only look right in one of them.
 */
export const SESSION_COLORS: readonly SessionColor[] = [
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Yellow" },
  { id: "green", label: "Green" },
  { id: "cyan", label: "Cyan" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "pink", label: "Pink" },
];

export function isSessionColor(id: string | undefined): boolean {
  return SESSION_COLORS.some((c) => c.id === id);
}

/** CSS class carrying a session's tint. Colours never go in as inline styles. */
export function colorClass(id: string | undefined): string | null {
  return isSessionColor(id) ? `gs-terminal-color-${id}` : null;
}

/**
 * The next colour when sessions are coloured automatically.
 *
 * Walks the palette in order and skips what is already on screen, so opening
 * four shells gives four distinct colours instead of rolling the dice; only
 * once every colour is taken does it wrap around and start repeating.
 */
export function nextColor(used: readonly (string | undefined)[]): string {
  const taken = new Set(used.filter(isSessionColor));
  const free = SESSION_COLORS.find((c) => !taken.has(c.id));
  if (free) return free.id;
  return SESSION_COLORS[used.length % SESSION_COLORS.length].id;
}

/**
 * The pool minus anything the running Obsidian does not know about.
 *
 * `getIconIds` reports Lucide icons with a `lucide-` prefix; older builds
 * report both spellings, and a build without the function at all gets the
 * whole pool on trust.
 */
export function availableIcons(known?: readonly string[]): readonly string[] {
  if (!known?.length) return SESSION_ICONS;
  const ids = new Set(known);
  const filtered = SESSION_ICONS.filter((i) => ids.has(i) || ids.has(`lucide-${i}`));
  // A registry that matches nothing is a naming change, not two dozen missing
  // icons: fall back to the full pool rather than showing an empty picker.
  return filtered.length ? filtered : SESSION_ICONS;
}

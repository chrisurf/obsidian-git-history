/**
 * The icons and colours a terminal session can be marked with.
 *
 * VS Code lets a terminal tab pick any codicon and one of the eight non-bright
 * ANSI colours, which is what makes a wall of identical `>_` icons readable
 * again. The same idea, cut down to what fits a 26px strip: a curated pool
 * rather than the whole icon library, because a searchable grid of a thousand
 * glyphs is a lot of machinery for a decision that takes one glance.
 *
 * What the pool is curated *for* is the work, not the tool — see the list
 * below.
 *
 * Pure data, no DOM — the view turns it into elements, the modal into a grid.
 */

/** Icon a session shows until someone picks another one. */
export const DEFAULT_SESSION_ICON = "terminal";

/**
 * The pool the picker offers, in the five rows the grid draws it in.
 *
 * A terminal session is named after the work in it, and that work is rarely
 * about the terminal: it is the mail run, the month-end spreadsheet, the
 * deployment, the trip. The first pool was two dozen glyphs from one world —
 * bug, flame, ghost — which left everything else to be marked with a bookmark
 * and remembered. These are eight icons from each of five areas instead, so
 * whatever a session is for, something in the grid says it.
 *
 * Eight per line is exactly the picker's grid, so every line of the grid is
 * one subject and the eye can go to the right neighbourhood before it starts
 * looking at glyphs. `SESSION_ICONS.length % 8 === 0` is therefore a rule, not
 * a coincidence.
 *
 * Every name is a Lucide icon, which is the set Obsidian registers in full.
 * `availableIcons()` still filters the list at runtime for the case where a
 * future release renames one — an empty box in the strip is worse than a
 * slightly shorter pool.
 */
export const SESSION_ICONS: readonly string[] = [
  // Shell, builds, automation — including the pipeline and the agent.
  "terminal",
  "code-2",
  "bug",
  "git-branch",
  "workflow",
  "server",
  "database",
  "bot",

  // Mail, meetings, the people on the other end.
  "mail",
  "inbox",
  "send",
  "message-square",
  "calendar",
  "users",
  "phone",
  "video",

  // Documents, and what is done with them.
  "file-text",
  "file-spreadsheet",
  "file-badge-2",
  "clipboard-list",
  "folder",
  "archive",
  "paperclip",
  "printer",

  // Presenting, recording, reporting.
  "presentation",
  "bar-chart",
  "image",
  "headphones",
  "mic",
  "music",
  "megaphone",
  "lightbulb",

  // The business, the world it is in, and being out of the office.
  "briefcase",
  "building-2",
  "landmark",
  "banknote",
  "globe",
  "languages",
  "plane",
  "palmtree",
];

/** How many icons the picker puts on one line; the pool is grouped in these. */
export const ICONS_PER_ROW = 8;

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

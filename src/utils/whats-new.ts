/**
 * "What's new" note shown once after a fresh install or an update.
 *
 * Its purpose is discovery: the plugin grows features faster than anyone reads
 * release notes, and a vault that is not a repository yet needs to be told
 * where to start. The pure version comparison lives here, apart from the
 * Obsidian modal, so it can be unit-tested without a DOM.
 */

/**
 * Hero image at the top of the modal, the same one the README uses. It is
 * fetched from GitHub rather than bundled, because the asset is far larger
 * than the plugin itself, and the modal hides it when the fetch fails — an
 * offline vault still gets the text.
 */
export const HERO_IMAGE_URL =
  "https://raw.githubusercontent.com/chrisurf/obsidian-git-history/main/docs/screenshots/hero.png";

/**
 * "Buy me a coffee" link and its button image, shown right under the hero.
 * The plugin is free and runs entirely on the user's machine, so this is the
 * one place it asks for optional support. Loaded remotely like the hero, and
 * the whole row disappears if the image cannot be fetched.
 */
export const BUY_ME_A_COFFEE_URL = "https://www.buymeacoffee.com/chrisurf";
export const BUY_ME_A_COFFEE_IMAGE_URL =
  "https://raw.githubusercontent.com/chrisurf/obsidian-git-history/main/docs/screenshots/buymeacoffee.png";

/**
 * Markdown rendered inside the modal. It leads with the newest work — the
 * repository setup screen and the restore/branch controls — and then sums up
 * what the plugin does, so a first-time reader and someone upgrading from an
 * early version both come away knowing where to click.
 */
export const WHATS_NEW = `## 💻 A terminal inside Obsidian — Alpha

There is now a shell panel in Obsidian, opened from the terminal ribbon icon,
the commit graph toolbar, or the **Open terminal** command. It starts in your
vault's folder and uses your own login shell, so your prompt, colours, and
aliases are there.

**This one is Alpha.** It is early and I am still working on it. I am shipping
it now so you can try it and tell me what breaks. Expect rough edges, and keep
anything you cannot redo by hand out of it for the moment.

You do not need it for anything else in the plugin — every button still does
its own work. Pick the shell yourself under **Terminal shell** in the settings
if the automatic one is not the one you want.

## 🌱 Start without a terminal

No Git repository in your vault yet? The source control panel now offers to
create one for you. Open it, press **Initialize repository**, and the panel
turns into the normal view — tracking, history, and backups from that moment
on, without ever opening a terminal.

## ↩️ Put a single file back

Every file inside a commit has a right-click menu now:

- **Restore this file** brings that one note back the way it was in that
  snapshot, leaving everything else alone.
- If the note has unsaved-to-Git changes, you are asked first — **stash them**,
  **overwrite them**, or **cancel**.
- **Add to .gitignore** on a changed file stops the plugin from tracking it,
  written straight into your vault's \`.gitignore\`.

Reverting a whole commit in the graph asks for confirmation as well, so the
undo buttons no longer fire on the first click.

## 🌿 Branches, end to end

The branch menu next to the branch name does the whole job:

- **Switch** between local branches, or check out a **remote** one.
- **Create** a branch from any commit in the graph.
- **Delete** a branch you are done with, after a confirmation.
- **Merge** another branch into the one you are on — and **abort** a merge from
  the ⋯ menu if it goes sideways.

## ✨ Smaller things you will notice

- The commit button stays disabled until there is a message — or a template to
  fall back on. \`{{date}}\` in the template becomes today's date.
- Background fetches show up in the progress bar instead of happening silently.
- The commit graph in the sidebar fills in immediately and keeps its full
  history instead of thinning out to the most recent commits.

## 📸 Everything at a glance

**Source control panel** — stage, unstage, and commit single files or the whole
vault, with a diff for each change.

**Commit graph** — the full branch structure of your vault, with authors,
dates, and the files each commit touched. Filter it down to one note to read
that note's history.

**Diff viewer** — side by side or inline, for working changes and for anything
in history.

**Backup in one step** — stage everything, commit with your template, and push,
from a single command.

**Terminal (Alpha)** — a shell in your vault's folder, for the occasional
command that has no button yet.

Open it from the 🌿 ribbon icon on the left, or from the **Git history: Open
source control** command.`;

/**
 * Whether the note is due for the running version. It is shown whenever the
 * installed version differs from the last one the user has seen, which covers
 * a fresh install (nothing seen yet) and an upgrade, and never repeats for a
 * version already acknowledged.
 */
export function shouldShowWhatsNew(currentVersion: string, lastSeenVersion: string): boolean {
  return currentVersion !== "" && currentVersion !== lastSeenVersion;
}

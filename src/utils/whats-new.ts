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
 * Markdown rendered inside the modal. It leads with the newest work — auto-pull
 * and the terminal — and then sums up what the plugin does, so a first-time
 * reader and someone upgrading from an early version both come away knowing
 * where to click.
 */
export const WHATS_NEW = `## ⬇️ Pull on its own

Turn on **Auto-pull** next to Auto-fetch, and the vault takes in new commits
from the remote as soon as the background check finds them. It only ever
fast-forwards, and only while you have nothing uncommitted and nothing
unpushed — anything that would need a merge is left to the Sync button.

## 💻 The terminal, grown up

The shell panel is no longer an experiment. Open it with \`Cmd/Ctrl+J\`, the
terminal ribbon icon, or the **Open terminal** command — it starts in your
vault's folder with your own login shell, prompt and aliases.

- **Several sessions**, side by side. Closing the panel no longer ends them: a
  build keeps running, and its scrollback is there when you come back.
- **Tell them apart.** Right-click a session and pick **Change icon and
  colour** — forty icons grouped by what a session is for, eight colours that
  follow your theme. Drag the icons to reorder them.
- **Find** with \`Cmd/Ctrl+F\` while you are in it: a match counter, Enter and
  Shift+Enter to walk through the matches, match case and regular expressions,
  Escape to go back to the shell.
- **A startup script** in the settings, loaded into every session before the
  first prompt — aliases, variables and functions of your own.
- **It finds its programs** the way your shell does, so a Homebrew git or a
  pyenv Python is the one it uses. If a shell still does not start, the panel
  says why, and **Check terminal setup** reports what was found.

Both shortcuts are ordinary Obsidian hotkeys, so **Settings → Hotkeys** can
change or clear them.

## 🔍 Diffs that show what changed

- The words that changed inside a line are marked, not just the line.
- Line colours run across the whole width, however far you scroll.
- Renamed notes show as a rename, and stage, unstage and discard reliably.
- Click a note in the changes list to open it, or press **Open current file**
  in the diff view.

## ⚙️ Settings, sorted

The settings are grouped now, one short line per row. Your **Git identity** —
the name and email on your commits — and the vault's **remotes** can be seen
and edited right there, without a terminal.

## 🗂️ Open a whole branch of the tree at once

Folding the changes list was all-or-nothing from the toolbar. Every folder in
the tree carries the same control now: hover a folder and press it to open or
close that folder and every level below it, however deep it goes.

A commit's file list has the same two layouts and the same controls. Switch it
between a folder tree and a flat list from the toolbar above the files, and
fold a branch of it the same way — useful on a commit that touched a lot of
notes across a lot of folders.

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

**Terminal** — a shell in your vault's folder, for the occasional command that
has no button yet.

Open it from the 🌿 ribbon icon on the left, or from the **Git history: Open
source control** command.

⭐ If the plugin is useful to you, please
[give it a star on GitHub](https://github.com/chrisurf/obsidian-git-history)
and recommend it to a friend — that is how other people find it.`;

/**
 * Whether the note is due for the running version. It is shown whenever the
 * installed version differs from the last one the user has seen, which covers
 * a fresh install (nothing seen yet) and an upgrade, and never repeats for a
 * version already acknowledged.
 */
export function shouldShowWhatsNew(currentVersion: string, lastSeenVersion: string): boolean {
  return currentVersion !== "" && currentVersion !== lastSeenVersion;
}

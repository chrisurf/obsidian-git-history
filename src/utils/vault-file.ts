/**
 * Reaching the vault's own copy of a repository path.
 *
 * Git talks in repository paths, Obsidian in vault files, and the two do not
 * always line up: a commit can name a file that has since been deleted, and
 * everything under the config folder is tracked by git but absent from the
 * vault index. Both views that offer "open the note as it is right now" go
 * through here, so the answer to "what happens when there is no such file" is
 * given in one place.
 */
import { Notice, TFile } from "obsidian";
import type { App } from "obsidian";

/** The vault's file for a repository path, or null when it holds none. */
export function vaultFile(app: App, path: string): TFile | null {
  const found = app.vault.getAbstractFileByPath(path);
  return found instanceof TFile ? found : null;
}

/**
 * Whether a current version of this path could exist at all.
 *
 * Two kinds of row can never open: a file the change under review deleted, and
 * anything inside the config folder, which git tracks but the vault does not
 * index — `getAbstractFileByPath` answers null for `.obsidian/workspace.json`
 * however healthy the vault is.
 *
 * Knowing this before the lookup is what separates "there is nothing to open
 * here, by nature" from "the vault should have this and does not". The first
 * is not worth a word; the second is the only one worth interrupting for.
 */
export function couldHaveCurrentFile(app: App, path: string, deleted = false): boolean {
  if (deleted) return false;
  const configDir = app.vault.configDir;
  return !(configDir && (path === configDir || path.startsWith(configDir + "/")));
}

/**
 * Opens the vault's current copy of a path.
 *
 * `fallback` is what a click on a file name passes: the click has to lead
 * somewhere, and the changes are what is left to show.
 *
 * Either way it says why, and that is the point. Falling back in silence made
 * the click do what it did before the note ever came into it — the diff opened,
 * nothing explained itself, and there was no way to tell a file the vault
 * cannot open from a feature that is not working.
 */
export async function openCurrentFile(
  app: App,
  path: string,
  fallback?: () => void,
): Promise<void> {
  const current = vaultFile(app, path);
  if (!current) {
    // Nothing to explain where nothing could have opened in the first place.
    if (fallback && !couldHaveCurrentFile(app, path)) {
      fallback();
      return;
    }
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (fallback) {
      new Notice(`"${name}" is not a note in this vault — showing its changes instead`);
      fallback();
    } else {
      new Notice(`"${name}" is not a note in this vault. It was deleted, or lives outside it.`);
    }
    return;
  }
  await app.workspace.getLeaf(false).openFile(current);
}

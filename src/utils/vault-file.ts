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

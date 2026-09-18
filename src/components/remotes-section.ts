import { Notice } from "obsidian";
import type { Setting } from "obsidian";
import type { RemoteInfo } from "../types";
import { remoteUrlProblem } from "../git/git-remote";
import { asVoid } from "../utils/async";

/**
 * The remotes of this vault, in the settings.
 *
 * The plugin could push, pull and fetch long before it could say where to —
 * that was configured on a command line or not at all, and a vault with no
 * remote offered no hint that one was missing. These rows are the answer: the
 * addresses git already knows, editable in place, and a way to add the first
 * one.
 *
 * Like the identity rows, what they show does not live in `data.json` but in
 * the repository, so the list is read from git and written back with git. The
 * section therefore outlives a single render pass: it keeps the last answer,
 * hands it to whichever settings path is drawing, and asks for a redraw only
 * when git says something different from what is already on screen.
 */

/** What the section needs from git, and all it is given. */
export interface RemoteSource {
  remotes(): Promise<RemoteInfo[]>;
  addRemote(name: string, url: string): Promise<void>;
  setRemoteUrl(name: string, url: string): Promise<void>;
  removeRemote(name: string): Promise<void>;
  isRepo(): Promise<boolean>;
}

export interface RemotesSectionOptions {
  git: RemoteSource;
  /** Draws the settings again, after the list of remotes changed. */
  refresh: () => void;
  /** Asks the user for a new remote. The settings tab wires the dialog. */
  prompt: (taken: string[], save: (name: string, url: string) => Promise<void>) => void;
}

export class RemotesSection {
  private remotes: RemoteInfo[] = [];
  private repo = true;
  /** Guards against two reads at once, and against a redraw during one. */
  private reading: Promise<void> | null = null;

  constructor(private opts: RemotesSectionOptions) {}

  /** What git said the last time it was asked. */
  get list(): readonly RemoteInfo[] {
    return this.remotes;
  }

  get isRepo(): boolean {
    return this.repo;
  }

  /**
   * Reads git, and redraws only if the answer changed.
   *
   * Called every time the settings are built, which is also every time a
   * redraw happens — so "only if it changed" is what makes this terminate
   * rather than draw in a loop.
   */
  sync(): void {
    if (this.reading) return;
    const before = this.fingerprint();
    this.reading = this.read().then(() => {
      this.reading = null;
      if (this.fingerprint() !== before) this.opts.refresh();
    });
    void this.reading;
  }

  private async read(): Promise<void> {
    const [repo, remotes] = await Promise.all([this.readRepo(), this.readRemotes()]);
    this.repo = repo;
    this.remotes = remotes;
  }

  private async readRepo(): Promise<boolean> {
    try {
      return await this.opts.git.isRepo();
    } catch {
      return false;
    }
  }

  private async readRemotes(): Promise<RemoteInfo[]> {
    try {
      return await this.opts.git.remotes();
    } catch {
      return [];
    }
  }

  private fingerprint(): string {
    return `${String(this.repo)}|${this.remotes.map((r) => `${r.name} ${r.fetchUrl} ${r.pushUrl}`).join("\n")}`;
  }

  /** What to say where the list would be, when there is nothing in it. */
  emptyState(): string {
    return this.repo
      ? "No remote yet. Add one to push this vault to GitHub, GitLab or a server of your own."
      : "This vault is not a Git repository yet, so there is nothing to push to.";
  }

  /**
   * The address of one remote, editable.
   *
   * Written on leaving the field, like the identity rows: a `git remote
   * set-url` per keystroke would point the remote at a dozen half-typed
   * addresses on the way to the real one.
   */
  field(setting: Setting, remote: RemoteInfo): void {
    const url = remote.fetchUrl || remote.pushUrl;
    setting.addText((text) => {
      text.setPlaceholder("https://github.com/you/vault.git");
      text.setValue(url);
      text.inputEl.addClass("gs-path-input");
      text.inputEl.addEventListener(
        "blur",
        asVoid(async () => {
          const next = text.getValue().trim();
          if (next === url) return;

          const problem = remoteUrlProblem(next);
          if (problem) {
            new Notice(problem);
            text.setValue(url);
            return;
          }
          await this.write(() => this.opts.git.setRemoteUrl(remote.name, next), text, url);
        }),
      );
      text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") text.inputEl.blur();
      });
    });
  }

  /** Opens the dialog that adds one, and takes what it returns. */
  add(): void {
    this.opts.prompt(
      this.remotes.map((r) => r.name),
      async (name, url) => {
        await this.opts.git.addRemote(name, url);
        await this.reload();
      },
    );
  }

  /**
   * Forgets a remote.
   *
   * Only the address goes: the commits on both sides stay where they are,
   * which is why this does not ask first — it is undone by adding the same
   * address again, and the notice says so.
   */
  async remove(name: string): Promise<void> {
    try {
      await this.opts.git.removeRemote(name);
    } catch (e: unknown) {
      new Notice(`Could not remove "${name}": ${message(e)}`);
      return;
    }
    new Notice(`Removed the remote "${name}". No commits were deleted.`);
    await this.reload();
  }

  private async write(
    action: () => Promise<void>,
    text: { setValue(value: string): unknown },
    previous: string,
  ): Promise<void> {
    try {
      await action();
    } catch (e: unknown) {
      new Notice(`Could not save the address: ${message(e)}`);
      text.setValue(previous);
      return;
    }
    await this.reload();
  }

  /** Re-reads after a write of our own, and always redraws. */
  private async reload(): Promise<void> {
    await this.read();
    this.opts.refresh();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

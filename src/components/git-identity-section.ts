import { Notice } from "obsidian";
import type { Setting, TextComponent } from "obsidian";
import { NO_IDENTITY, emailProblem, isComplete, nameProblem, originOf } from "../git/git-identity";
import type { FieldOrigin, GitIdentity, IdentityField } from "../git/git-identity";
import { describeSetting } from "./setting-text";
import { asVoid } from "../utils/async";

/**
 * The Git identity, in the settings.
 *
 * These rows are unlike every other one in the tab: what they show is not a
 * plugin setting but the answer `git config` gives in this vault, and writing
 * one runs a git command rather than touching `data.json`. They are therefore
 * built here instead of in the settings list, which exists to describe things
 * that live in the plugin's own storage.
 *
 * An edit is written for this vault, always. There used to be a third row
 * choosing between the vault and every repository on the computer, and it was
 * a choice nobody asked for: the settings of a vault are about that vault, and
 * the name other projects commit under is not the plugin's to change. What is
 * left of that distinction is worth saying rather than deciding, so a field
 * inherited from `~/.gitconfig` says so and says what an edit will do with
 * it.
 *
 * That sentence used to hang in an element of its own, appended to the row and
 * positioned under the field by hand. Obsidian 1.13 lays a row out
 * differently, and the sentence landed beside the input instead — pushing the
 * field into a third of the row while the description wrapped over four lines
 * next to it. It is part of the row's description now, where the framework
 * puts it under the name in either version, with the scope as a badge the eye
 * can find without reading.
 */

/** What the section needs from git, and all it is given. */
export interface IdentitySource {
  identity(): Promise<GitIdentity>;
  setIdentity(field: "name" | "email", value: string): Promise<void>;
  isRepo(): Promise<boolean>;
}

type FieldName = "name" | "email";

interface FieldRow {
  input: TextComponent;
  /** The row itself, whose description carries where the value comes from. */
  setting: Setting;
  /** What git holds right now, so an unchanged field writes nothing. */
  saved: string;
}

const FIELD_DESC: Record<FieldName, string> = {
  name: "Author name on every commit.",
  email: "Author email, and what a forge matches commits to your account by.",
};

export class GitIdentitySection {
  private identity: GitIdentity = NO_IDENTITY;
  /** Without a repository there is no config to write into, so the fields say
      so and take no edits. */
  private isRepo = true;
  /** Whether git has answered yet. Until it has, a row says what it is for
      and nothing about where its value comes from — the badge for "nothing
      set it" would otherwise flash on every row that is perfectly fine. */
  private hasRead = false;
  private fields = new Map<FieldName, FieldRow>();
  /** One read of git per render pass, however many rows ask for it. */
  private pending: Promise<void> | null = null;

  constructor(private git: IdentitySource) {}

  /** The rows, in order, for whichever of the two settings paths is drawing. */
  static readonly ROWS = ["name", "email"] as const;

  static rowName(row: (typeof GitIdentitySection.ROWS)[number]): string {
    return row === "name" ? "Name" : "Email";
  }

  static rowDesc(row: (typeof GitIdentitySection.ROWS)[number]): string {
    return FIELD_DESC[row];
  }

  /**
   * Builds one of the two value rows.
   *
   * Written on leaving the field rather than on every keystroke: a git command
   * per character is wasteful, and "Chri" is a perfectly valid name that
   * nobody means.
   */
  field(setting: Setting, name: FieldName): void {
    // Obsidian keeps the definitions and rebuilds the rows every time the tab
    // is opened, so the first row of a pass is where a fresh read starts.
    // Without this the second visit shows whatever git said on the first.
    if (name === GitIdentitySection.ROWS[0]) this.pending = null;
    this.ensureLoaded();

    setting.addText((text) => {
      text.setPlaceholder(name === "name" ? "Your name" : "you@example.com");
      text.inputEl.addClass("gs-identity-input");
      text.inputEl.addEventListener(
        "blur",
        asVoid(() => this.save(name)),
      );
      text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") text.inputEl.blur();
      });
      this.fields.set(name, { input: text, setting, saved: "" });
    });

    this.paintField(name);
  }

  /**
   * Starts the read the first row needs.
   *
   * Rows paint themselves from what is known when they are built and are
   * painted again when the read lands, so it does not matter which of the two
   * happens first — and neither does which settings path built them.
   */
  private ensureLoaded(): void {
    this.pending ??= this.load();
    void this.pending;
  }

  /** Reads git and paints whatever rows have been built. */
  async load(): Promise<void> {
    const [identity, isRepo] = await Promise.all([this.readIdentity(), this.readIsRepo()]);
    this.identity = identity;
    this.hasRead = true;
    this.isRepo = isRepo;

    for (const name of GitIdentitySection.ROWS) this.paintField(name);
  }

  /** Whether git has enough to commit with, once {@link load} has run. */
  get complete(): boolean {
    return isComplete(this.identity);
  }

  private async readIdentity(): Promise<GitIdentity> {
    try {
      return await this.git.identity();
    } catch (e: unknown) {
      new Notice(`Git history: could not read your Git identity. ${message(e)}`);
      return NO_IDENTITY;
    }
  }

  private async readIsRepo(): Promise<boolean> {
    try {
      return await this.git.isRepo();
    } catch {
      return false;
    }
  }

  private paintField(name: FieldName): void {
    const row = this.fields.get(name);
    if (!row) return;

    const field = this.identity[name];
    row.saved = field.value;
    row.input.setValue(field.value);

    // Nothing to write to, so nothing to type into. Creating the repository
    // is the panel's job, and it offers that there.
    row.input.setDisabled(this.hasRead && !this.isRepo);
    row.setting.setDesc(describeSetting(FIELD_DESC[name], this.badge(field)));
  }

  /**
   * What the row says about its value: where git has it, or — with no
   * repository — that there is nowhere to put one.
   */
  private badge(field: IdentityField): FieldOrigin | null {
    if (!this.hasRead) return null;
    if (!this.isRepo) {
      return {
        label: "No repository",
        tone: "warning",
        detail: "This vault is not a Git repository yet, so there is nothing to write to.",
      };
    }
    return originOf(field);
  }

  /**
   * Writes one field, and reads the whole identity back.
   *
   * Reading back is the point: writing a name for this vault while a worktree
   * or the command line sets its own changes nothing git will use, and a row
   * that kept showing what was typed would be lying about it.
   */
  private async save(name: FieldName): Promise<void> {
    const row = this.fields.get(name);
    if (!row) return;

    const value = row.input.getValue().trim();
    if (value === row.saved.trim()) return;

    const problem =
      value === "" ? null : name === "name" ? nameProblem(value) : emailProblem(value);
    if (problem) {
      new Notice(problem);
      row.input.setValue(row.saved);
      return;
    }

    try {
      await this.git.setIdentity(name, value);
    } catch (e: unknown) {
      new Notice(`Could not save your Git ${name}: ${message(e)}`);
      row.input.setValue(row.saved);
      return;
    }

    await this.load();
  }
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

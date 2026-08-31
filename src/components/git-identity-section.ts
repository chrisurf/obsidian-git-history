import { Notice, Setting } from "obsidian";
import type { DropdownComponent, TextComponent } from "obsidian";
import {
  NO_IDENTITY,
  defaultScope,
  describeField,
  emailProblem,
  isComplete,
  nameProblem,
  writableScopeLabels,
} from "../git/git-identity";
import type { GitIdentity, WritableScope } from "../git/git-identity";
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
 * What the rows have to earn is the line underneath them. A name inherited
 * from `~/.gitconfig` and a name set for this vault are the same characters in
 * the same box, and without being told which it is, editing one is a guess
 * about what will change. So every field says where its value comes from, and
 * the scope an edit goes to is a control the user can see rather than a rule
 * they have to know.
 */

/** What the section needs from git, and all it is given. */
export interface IdentitySource {
  identity(): Promise<GitIdentity>;
  setIdentity(field: "name" | "email", value: string, scope: WritableScope): Promise<void>;
  isRepo(): Promise<boolean>;
}

type FieldName = "name" | "email";

interface FieldRow {
  input: TextComponent;
  origin: HTMLElement;
  /** What git holds right now, so an unchanged field writes nothing. */
  saved: string;
}

const FIELD_DESC: Record<FieldName, string> = {
  name: "The name recorded as the author of every commit you make.",
  email: "The email address recorded alongside it, and what forges match commits to accounts by.",
};

export class GitIdentitySection {
  private identity: GitIdentity = NO_IDENTITY;
  private canUseLocal = false;
  private scope: WritableScope = "local";
  private fields = new Map<FieldName, FieldRow>();
  private scopeControl: { setting: Setting; dropdown: DropdownComponent } | null = null;
  /** One read of git per render pass, however many rows ask for it. */
  private pending: Promise<void> | null = null;

  constructor(private git: IdentitySource) {}

  /** The rows, in order, for whichever of the two settings paths is drawing. */
  static readonly ROWS = ["name", "email", "scope"] as const;

  static rowName(row: (typeof GitIdentitySection.ROWS)[number]): string {
    return row === "scope" ? "Save changes to" : row === "name" ? "Name" : "Email";
  }

  static rowDesc(row: (typeof GitIdentitySection.ROWS)[number]): string {
    return row === "scope"
      ? "Where an edit above is written. It starts on the config the current value comes from."
      : FIELD_DESC[row];
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
    const origin = setting.settingEl.createDiv("gs-identity-origin");

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
      this.fields.set(name, { input: text, origin, saved: "" });
    });

    this.paintField(name);
  }

  /** The row that decides where an edit lands. */
  scopeSelector(setting: Setting): void {
    this.ensureLoaded();
    setting.addDropdown((dropdown) => {
      this.scopeControl = { setting, dropdown };
      dropdown.onChange((value) => {
        this.scope = value === "global" ? "global" : "local";
      });
    });
    this.paintScope();
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
    const [identity, isRepo] = await Promise.all([this.readIdentity(), this.isRepo()]);
    this.identity = identity;
    this.canUseLocal = isRepo;
    this.scope = defaultScope(identity, isRepo);

    for (const name of ["name", "email"] as const) this.paintField(name);
    this.paintScope();
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

  private async isRepo(): Promise<boolean> {
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

    const detail = describeField(field);
    row.origin.setText(detail ?? "");
    row.origin.toggleClass("gs-identity-origin-missing", field.value === "");
    row.origin.toggleClass("gs-hidden", detail === null);
  }

  private paintScope(): void {
    const control = this.scopeControl;
    if (!control) return;

    const labels = writableScopeLabels();
    const options = this.canUseLocal ? labels : { global: labels.global };
    control.dropdown.selectEl.empty();
    control.dropdown.addOptions(options);
    control.dropdown.setValue(this.scope);
    control.setting.setDesc(
      this.canUseLocal
        ? GitIdentitySection.rowDesc("scope")
        : "This vault is not a Git repository, so there is nowhere vault-specific to write to.",
    );
  }

  /**
   * Writes one field, and reads the whole identity back.
   *
   * Reading back is the point: a value written globally while the vault sets
   * its own is written and then immediately overridden, and a row that kept
   * showing what was typed would be lying about what git will use.
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
      await this.git.setIdentity(name, value, this.scope);
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

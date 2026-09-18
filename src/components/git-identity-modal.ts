import { App, Modal, Setting } from "obsidian";
import type { TextComponent } from "obsidian";
import { emailProblem, nameProblem } from "../git/git-identity";
import type { GitIdentity } from "../git/git-identity";
import { asVoid } from "../utils/async";

/**
 * Asking for a Git identity, once, at the moment it is worth asking.
 *
 * Git will not write a commit without a name and an email address, and its own
 * way of saying so is a wall of text about `git config --global` printed after
 * the commit has already failed. A plugin that offers a Commit button owes the
 * user better than finding that out the hard way — so this is shown when the
 * plugin loads into a repository nothing has configured, and again out of the
 * failure itself for anyone who waved it away.
 *
 * It writes to this vault, and only ever to this vault. The dialog used to
 * offer the global config as the other half of a choice; a prompt that appears
 * on its own and can change the name every repository on the computer commits
 * under is not a choice worth offering.
 */
export type IdentityPromptReason = "startup" | "commit" | "manual";

export interface IdentityPromptOptions {
  reason: IdentityPromptReason;
  /** What git already has. Either half may be filled in already. */
  identity: GitIdentity;
  onSave: (name: string, email: string) => Promise<void>;
  /** Closed without saving — the caller decides whether to ask again. */
  onDismiss: () => void;
}

const INTRO: Record<IdentityPromptReason, string> = {
  startup:
    "Git records a name and an email address on every commit, and nothing here has set them. " +
    "Depending on the machine, Git will either refuse to commit or invent them from your " +
    "computer's user name and hostname — an address no Git host can match to your account.",
  commit:
    "That commit did not happen. Git records a name and an email address on every commit, " +
    "and here it could work out neither — fill them in and the commit will go through.",
  manual: "Git records a name and an email address on every commit you make. Here they are.",
};

export class GitIdentityModal extends Modal {
  private nameInput: TextComponent | null = null;
  private emailInput: TextComponent | null = null;
  private errorEl: HTMLElement | null = null;
  private saved = false;

  constructor(
    app: App,
    private opts: IdentityPromptOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("gs-identity-modal");
    titleEl.setText("Set your Git identity");

    contentEl.createEl("p", { cls: "gs-identity-intro", text: INTRO[this.opts.reason] });

    new Setting(contentEl).setName("Name").addText((text) => {
      this.nameInput = text;
      text.setPlaceholder("Your name").setValue(this.opts.identity.name.value);
    });

    new Setting(contentEl).setName("Email").addText((text) => {
      this.emailInput = text;
      text.setPlaceholder("you@example.com").setValue(this.opts.identity.email.value);
      text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter") asVoid(() => this.submit())();
      });
    });

    contentEl.createEl("p", {
      cls: "gs-settings-note",
      text:
        "Saved for this vault. Other repositories on this computer keep the name and address " +
        "they already use.",
    });
    this.errorEl = contentEl.createDiv("gs-identity-error gs-hidden");

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Not now").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Save")
          .setCta()
          .onClick(asVoid(() => this.submit())),
      );

    this.nameInput?.inputEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.saved) this.opts.onDismiss();
  }

  /**
   * Both halves are checked before anything is written. Git stores whatever it
   * is handed, so an address with a stray space in it is accepted here, put on
   * every commit, and rejected by the remote much later.
   */
  private async submit(): Promise<void> {
    const name = this.nameInput?.getValue().trim() ?? "";
    const email = this.emailInput?.getValue().trim() ?? "";

    const problem = nameProblem(name) ?? emailProblem(email);
    if (problem) {
      this.showError(problem);
      return;
    }

    try {
      await this.opts.onSave(name, email);
    } catch (e: unknown) {
      this.showError(e instanceof Error ? e.message : String(e));
      return;
    }

    this.saved = true;
    this.close();
  }

  private showError(text: string): void {
    this.errorEl?.setText(text);
    this.errorEl?.removeClass("gs-hidden");
  }
}

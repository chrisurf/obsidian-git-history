import { App, Modal, Setting } from "obsidian";
import type { TextComponent } from "obsidian";
import { remoteNameProblem, remoteUrlProblem, suggestedRemoteName } from "../git/git-remote";
import { asVoid } from "../utils/async";

/**
 * Adding a remote.
 *
 * Two fields, because a remote is two things: the address, which the host's
 * clone button gives you, and the name git files it under — which is "origin"
 * for the first one and only interesting once there is a second. The name is
 * therefore prefilled and rarely touched, and the address is what the dialog
 * is about.
 *
 * Both are checked before git runs. `git remote add` accepts almost anything,
 * so a pasted web page address is stored happily and fails at the first fetch,
 * by which time the connection between the two is gone.
 */
export interface RemotePromptOptions {
  /** Names already in use, so the dialog can suggest a free one and refuse a taken one. */
  taken: readonly string[];
  onSave: (name: string, url: string) => Promise<void>;
}

export class RemoteModal extends Modal {
  private nameInput: TextComponent | null = null;
  private urlInput: TextComponent | null = null;
  private errorEl: HTMLElement | null = null;

  constructor(
    app: App,
    private opts: RemotePromptOptions,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("gs-remote-modal");
    titleEl.setText("Add a remote");

    contentEl.createEl("p", {
      cls: "gs-settings-note",
      text:
        "A remote is this vault's copy on a server — GitHub, GitLab or one of your own. " +
        "Paste the address its clone button gives you.",
    });

    new Setting(contentEl)
      .setName("Address")
      .setDesc("The URL you would clone from.")
      .addText((text) => {
        this.urlInput = text;
        text.setPlaceholder("https://github.com/you/vault.git");
        text.inputEl.addClass("gs-path-input");
        text.inputEl.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter") asVoid(() => this.submit())();
        });
      });

    new Setting(contentEl)
      .setName("Name")
      .setDesc('What Git files it under. The first remote is called "origin" by convention.')
      .addText((text) => {
        this.nameInput = text;
        text.setValue(suggestedRemoteName(this.opts.taken));
      });

    this.errorEl = contentEl.createDiv("gs-form-error gs-hidden");

    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("Add remote")
          .setCta()
          .onClick(asVoid(() => this.submit())),
      );

    this.urlInput?.inputEl.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const name = (this.nameInput?.getValue() ?? "").trim();
    const url = (this.urlInput?.getValue() ?? "").trim();

    const problem = remoteUrlProblem(url) ?? remoteNameProblem(name, this.opts.taken);
    if (problem) {
      this.showError(problem);
      return;
    }

    try {
      await this.opts.onSave(name, url);
    } catch (e: unknown) {
      this.showError(e instanceof Error ? e.message : String(e));
      return;
    }
    this.close();
  }

  private showError(message: string): void {
    this.errorEl?.setText(message);
    this.errorEl?.removeClass("gs-hidden");
  }
}

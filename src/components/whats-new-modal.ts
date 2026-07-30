import { App, Component, MarkdownRenderer, Modal, Setting } from "obsidian";
import {
  WHATS_NEW,
  HERO_IMAGE_URL,
  BUY_ME_A_COFFEE_URL,
  BUY_ME_A_COFFEE_IMAGE_URL,
} from "../utils/whats-new";

/**
 * Introduces the latest functionality after an install or an update. It renders
 * the curated {@link WHATS_NEW} markdown and offers to open the source control
 * panel straight away, so what it describes is one click from being tried.
 */
export class WhatsNewModal extends Modal {
  private readonly version: string;
  private readonly component: Component;
  private readonly onOpenSourceControl: () => void;

  constructor(app: App, version: string, component: Component, onOpenSourceControl: () => void) {
    super(app);
    this.version = version;
    this.component = component;
    this.onOpenSourceControl = onOpenSourceControl;
  }

  onOpen(): void {
    const { contentEl, titleEl, modalEl } = this;
    modalEl.addClass("gs-whats-new-modal");
    titleEl.setText(`What's new in Git History ${this.version}`);

    // Hero banner, mirroring the README. Fetched from GitHub, so it is hidden
    // rather than left as a broken image when the vault is offline.
    const hero = contentEl.createEl("img", {
      cls: "gs-whats-new-hero",
      attr: { alt: "Git History for Obsidian", src: HERO_IMAGE_URL },
    });
    hero.addEventListener("error", () => hero.hide());

    // "Buy me a coffee", right under the hero the same way the README has it.
    // Remote image again, and the whole row goes away if it cannot be loaded.
    const support = contentEl.createDiv({ cls: "gs-whats-new-support" });
    const coffeeLink = support.createEl("a", {
      cls: "gs-bmc-link",
      attr: { href: BUY_ME_A_COFFEE_URL, target: "_blank", rel: "noopener" },
    });
    const coffeeImg = coffeeLink.createEl("img", {
      cls: "gs-bmc-button",
      attr: { alt: "Buy me a coffee", src: BUY_ME_A_COFFEE_IMAGE_URL },
    });
    coffeeImg.addEventListener("error", () => support.hide());

    const body = contentEl.createDiv({ cls: "gs-whats-new-body" });
    // The component ties the rendered children to the plugin's lifecycle, so
    // they are unloaded with it rather than left behind.
    void MarkdownRenderer.render(this.app, WHATS_NEW, body, "", this.component);

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Open source control")
          .setCta()
          .onClick(() => {
            this.onOpenSourceControl();
            this.close();
          }),
      )
      .addButton((btn) => btn.setButtonText("Close").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

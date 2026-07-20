import { App, Modal } from "obsidian";

/**
 * Asks for a single line of text in an Obsidian modal.
 *
 * The browser's `prompt()` blocks Electron's renderer and is styled by the OS
 * rather than the vault's theme, so Obsidian plugins are expected to use a
 * modal instead.
 *
 * Resolves with the entered text, or null when the user cancels or leaves it
 * empty.
 */
export function promptText(app: App, label: string, placeholder = ""): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    let settled = false;
    const done = (value: string | null): void => {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    };

    modal.titleEl.setText(label);
    const input = modal.contentEl.createEl("input", {
      cls: "gs-modal-input",
      attr: { type: "text", placeholder },
    });
    const buttons = modal.contentEl.createDiv("gs-modal-btns");
    const ok = buttons.createEl("button", { text: "OK", cls: "mod-cta" });
    const cancel = buttons.createEl("button", { text: "Cancel" });

    ok.addEventListener("click", () => {
      done(input.value || null);
    });
    cancel.addEventListener("click", () => {
      done(null);
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") done(input.value || null);
      if (e.key === "Escape") done(null);
    });
    // Closing with the X or a click outside must not leave the promise pending.
    modal.onClose = (): void => {
      done(null);
    };

    modal.open();
    input.focus();
  });
}

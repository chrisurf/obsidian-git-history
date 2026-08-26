import { App, Modal, Setting, getIconIds, setIcon } from "obsidian";
import {
  DEFAULT_SESSION_ICON,
  SESSION_COLORS,
  availableIcons,
  colorClass,
} from "../terminal/session-appearance";

export interface SessionAppearance {
  icon: string;
  color?: string;
}

/**
 * Picks the icon and colour of one terminal session.
 *
 * VS Code splits this across two commands and two pickers; here both live in
 * one sheet, because the two choices are made together — you pick a colour
 * *for* an icon, and seeing them side by side is the whole point.
 *
 * Every click applies straight away through `onChange` rather than waiting for
 * a confirmation: the strip is right there behind the modal, and a marker you
 * cannot see while choosing it is a marker chosen blind.
 */
export class SessionAppearanceModal extends Modal {
  private current: SessionAppearance;
  private colorRowEl: HTMLElement | null = null;
  private iconGridEl: HTMLElement | null = null;

  constructor(
    app: App,
    private sessionName: string,
    start: SessionAppearance,
    private onChange: (appearance: SessionAppearance) => void,
  ) {
    super(app);
    this.current = { ...start };
  }

  onOpen(): void {
    this.modalEl.addClass("gs-session-appearance-modal");
    this.titleEl.setText(`Appearance of "${this.sessionName}"`);

    this.contentEl.createEl("h4", { text: "Colour", cls: "gs-appearance-heading" });
    this.colorRowEl = this.contentEl.createDiv("gs-appearance-colors");
    this.renderColors();

    this.contentEl.createEl("h4", { text: "Icon", cls: "gs-appearance-heading" });
    this.iconGridEl = this.contentEl.createDiv("gs-appearance-icons");
    this.renderIcons();

    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("Reset").onClick(() => this.reset()))
      .addButton((b) =>
        b
          .setButtonText("Done")
          .setCta()
          .onClick(() => this.close()),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderColors(): void {
    const row = this.colorRowEl;
    if (!row) return;
    row.empty();

    // "Default" leads the row and is a hollow swatch, so the absence of a
    // colour reads as a choice rather than as a missing one.
    this.colorSwatch(row, undefined, "Default");
    for (const color of SESSION_COLORS) this.colorSwatch(row, color.id, color.label);
  }

  private colorSwatch(parent: HTMLElement, id: string | undefined, label: string): void {
    const swatch = parent.createEl("button", {
      cls: "gs-appearance-color",
      attr: { type: "button", "aria-label": label, title: label },
    });
    const cls = colorClass(id);
    if (cls) swatch.addClass(cls);
    else swatch.addClass("gs-appearance-color-default");
    swatch.toggleClass("gs-appearance-selected", this.current.color === id);
    swatch.addEventListener("click", () => this.apply({ color: id }));
  }

  private renderIcons(): void {
    const grid = this.iconGridEl;
    if (!grid) return;
    grid.empty();

    for (const name of availableIcons(registeredIcons())) {
      const cell = grid.createEl("button", {
        cls: "gs-appearance-icon",
        attr: { type: "button", "aria-label": name, title: name },
      });
      const cls = colorClass(this.current.color);
      if (cls) cell.addClass(cls);
      cell.toggleClass("gs-appearance-selected", this.current.icon === name);
      setIcon(cell, name);
      cell.addEventListener("click", () => this.apply({ icon: name }));
    }
  }

  private reset(): void {
    this.apply({ icon: DEFAULT_SESSION_ICON, color: undefined });
  }

  /**
   * Stores the change, tells the caller, and redraws. The icon grid is redrawn
   * on a colour change too — the grid is tinted with the current colour, so
   * picking one previews every icon in it before you commit to a glyph.
   */
  private apply(change: Partial<SessionAppearance>): void {
    this.current = { ...this.current, ...change };
    if (change.color === undefined && "color" in change) delete this.current.color;
    this.onChange({ ...this.current });
    this.renderColors();
    this.renderIcons();
  }
}

/**
 * Icon ids the running Obsidian knows about, or nothing on a build without the
 * function — `availableIcons` treats an empty list as "no registry to check
 * against" and hands back the full pool.
 */
function registeredIcons(): string[] {
  try {
    return getIconIds();
  } catch {
    return [];
  }
}

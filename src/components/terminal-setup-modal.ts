import { App, Modal, Setting, setIcon } from "obsidian";
import type { TerminalSetupReport } from "../terminal/session-manager";

/**
 * The diagnosis, done for the user instead of by them.
 *
 * Working out why a terminal would not start meant knowing that `/usr/bin/git`
 * and `/usr/bin/python3` are developer-tool stubs, that a GUI application does
 * not get the shell's PATH, and how to tell one `xcode-select` failure from
 * another. None of that is knowledge a note-taking app should demand. This
 * shows the same answers in one pass: which PATH is in use, which git and which
 * interpreter answered, which backend the terminal ended up on, and what that
 * backend can actually do.
 */
export class TerminalSetupModal extends Modal {
  constructor(
    app: App,
    private report: TerminalSetupReport,
  ) {
    super(app);
  }

  onOpen(): void {
    this.modalEl.addClass("gs-terminal-setup-modal");
    this.titleEl.setText("Terminal setup");

    this.renderPath();
    this.renderGit();
    this.renderBackend();

    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Close")
        .setCta()
        .onClick(() => this.close()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderPath(): void {
    const { loginPathDirs, shell } = this.report;
    const section = this.section("Search path");

    if (loginPathDirs.length === 0) {
      this.row(
        section,
        "warn",
        "Obsidian's own PATH",
        `Could not read the PATH from ${shell}. Anything installed through Homebrew, ` +
          "pyenv or asdf may be invisible to the plugin.",
      );
      return;
    }

    this.row(
      section,
      "ok",
      `${loginPathDirs.length} directories from ${shell}`,
      loginPathDirs.slice(0, 4).join("\n") + (loginPathDirs.length > 4 ? "\n…" : ""),
    );
  }

  private renderGit(): void {
    const section = this.section("Git");
    const { binary, tried } = this.report.git;
    if (binary) {
      this.row(section, "ok", binary.path, `Found on the ${sourceLabel(binary.source)}.`);
    } else {
      this.row(
        section,
        "error",
        "No working git found",
        `Tried ${tried.length} locations. Set one under Settings, Source control, Git binary.`,
      );
    }
  }

  private renderBackend(): void {
    const section = this.section("Terminal");
    const { spec, interpreter, attempts } = this.report.backend;

    const capability = spec.capabilities.tty
      ? "Full terminal: prompt, colours and full-screen programs work."
      : "No pseudo-terminal: no prompt, no colours, and full-screen programs will not work.";
    this.row(
      section,
      spec.capabilities.tty ? "ok" : "warn",
      interpreter ? `${spec.label} — ${interpreter}` : spec.label,
      capability,
    );

    for (const attempt of attempts) {
      if (!attempt.skipped) continue;
      this.row(section, "warn", `${attempt.label} not used`, attempt.skipped);
    }
  }

  private section(title: string): HTMLElement {
    this.contentEl.createEl("h4", { cls: "gs-setup-heading", text: title });
    return this.contentEl.createDiv("gs-setup-section");
  }

  private row(
    parent: HTMLElement,
    state: "ok" | "warn" | "error",
    title: string,
    detail: string,
  ): void {
    const row = parent.createDiv("gs-setup-row");
    row.addClass(`gs-setup-row-${state}`);

    const glyph = row.createSpan("gs-setup-row-icon");
    setIcon(glyph, state === "ok" ? "check" : state === "warn" ? "alert-triangle" : "x");

    const text = row.createDiv("gs-setup-row-text");
    text.createDiv({ cls: "gs-setup-row-title", text: title });
    text.createDiv({ cls: "gs-setup-row-detail", text: detail });
  }
}

function sourceLabel(source: string): string {
  if (source === "configured") return "path set in the settings";
  if (source === "path") return "shell's PATH";
  if (source === "known") return "usual install location";
  return "system fallback";
}

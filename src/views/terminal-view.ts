import { ItemView, WorkspaceLeaf, Platform, Menu, setIcon } from "obsidian";
import { TERMINAL_VIEW_TYPE } from "../types";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type GitHistoryPlugin from "../main";
import { promptText } from "../utils/prompt";
import { asVoid } from "../utils/async";

/** Below this width the session strip lies down above the terminal instead. */
const NARROW_WIDTH = 320;

export class TerminalView extends ItemView {
  private sessions: TerminalSessionManager;
  private wrapperEl: HTMLElement | null = null;
  private stripEl: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dragFrom: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
    super(leaf);
    this.sessions = plugin.terminals;
  }

  getViewType(): string {
    return TERMINAL_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const container = this.contentEl;
    container.empty();
    container.addClass("gs-terminal-container");

    if (!Platform.isDesktop) {
      container.createDiv({
        cls: "gs-terminal-unavailable",
        text: "Terminal is only available on desktop.",
      });
      return;
    }

    this.wrapperEl = container.createDiv("gs-terminal-wrapper");
    this.stripEl = container.createDiv("gs-terminal-strip");

    this.addAction("plus", "New terminal session", () => this.newSession());
    this.addAction("trash-2", "Close terminal session", () => this.closeActive());
    this.addAction("more-horizontal", "More", (e) => this.showMenu(e));

    this.registerEvent(this.sessions.on("sessions-changed", () => this.render()));

    // A session outlives the view it was started in, so a reopened terminal
    // picks up whatever is still running rather than starting over.
    this.sessions.attachAll(this.wrapperEl);
    if (this.sessions.size === 0) this.newSession();
    else this.render();

    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(container);
  }

  /**
   * Hands the sessions back without ending them: closing the tab is not a
   * reason to kill a shell that is in the middle of something. The processes
   * end when the user closes a session, or when the plugin unloads.
   */
  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.sessions.detachAll();
    this.wrapperEl = null;
    this.stripEl = null;
  }

  newSession(): void {
    if (!this.wrapperEl) return;
    this.sessions.create(this.wrapperEl);
    this.sessions.activeSession()?.focus();
  }

  private closeActive(): void {
    const id = this.sessions.activeId;
    if (id) this.sessions.close(id);
  }

  /** Obsidian's own signal when the pane is resized; the observer catches the rest. */
  onResize(): void {
    this.syncSize();
  }

  private syncSize(): void {
    const container = this.contentEl;
    container.toggleClass("gs-terminal-narrow", container.clientWidth < NARROW_WIDTH);
    this.sessions.activeSession()?.fit();
  }

  /** Redraws the strip and shows the session it points at. */
  private render(): void {
    const strip = this.stripEl;
    if (!strip) return;

    const activeId = this.sessions.activeId;
    for (const entry of this.sessions.entries) {
      const session = this.sessions.session(entry.id);
      session?.setVisible(entry.id === activeId);
    }

    strip.empty();
    // One session needs no strip — it would only take room away from the
    // terminal to say what is already obvious.
    strip.toggleClass("gs-hidden", this.sessions.size < 2);

    this.sessions.entries.forEach((entry, index) => {
      const tab = strip.createDiv("gs-terminal-tab");
      tab.toggleClass("gs-terminal-tab-active", entry.id === activeId);
      tab.toggleClass("gs-terminal-tab-exited", this.sessions.hasExited(entry.id));
      tab.setAttribute("aria-label", this.tabLabel(entry.id, entry.name));
      tab.setAttribute("draggable", "true");

      const icon = tab.createSpan("gs-terminal-tab-icon");
      setIcon(icon, "terminal");

      const closeBtn = tab.createEl("button", { cls: "gs-terminal-tab-close" });
      setIcon(closeBtn, "x");
      closeBtn.setAttribute("aria-label", `Close ${entry.name}`);
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.sessions.close(entry.id);
      });

      tab.addEventListener("click", () => {
        this.sessions.activate(entry.id);
        this.sessions.activeSession()?.focus();
      });
      tab.addEventListener("contextmenu", (e) => this.showMenu(e, entry.id));
      this.wireDrag(tab, index);
    });

    // Repaint, but do not take the focus: a background shell that ends redraws
    // the strip too, and the cursor should stay where the user put it.
    this.sessions.activeSession()?.refresh();
  }

  private tabLabel(id: string, name: string): string {
    return this.sessions.hasExited(id) ? `${name} (exited)` : name;
  }

  private wireDrag(tab: HTMLElement, index: number): void {
    tab.addEventListener("dragstart", () => {
      this.dragFrom = index;
      tab.addClass("gs-terminal-tab-dragging");
    });
    tab.addEventListener("dragend", () => {
      this.dragFrom = null;
      tab.removeClass("gs-terminal-tab-dragging");
    });
    tab.addEventListener("dragover", (e) => {
      if (this.dragFrom === null || this.dragFrom === index) return;
      e.preventDefault();
      tab.addClass("gs-terminal-tab-drop");
    });
    tab.addEventListener("dragleave", () => tab.removeClass("gs-terminal-tab-drop"));
    tab.addEventListener("drop", (e) => {
      e.preventDefault();
      tab.removeClass("gs-terminal-tab-drop");
      if (this.dragFrom === null) return;
      this.sessions.move(this.dragFrom, index);
      this.dragFrom = null;
    });
  }

  private showMenu(event: MouseEvent, sessionId?: string): void {
    const id = sessionId ?? this.sessions.activeId;
    const menu = new Menu();

    menu.addItem((i) =>
      i
        .setTitle("New session")
        .setIcon("plus")
        .onClick(() => this.newSession()),
    );

    if (id) {
      const name = this.sessions.entries.find((e) => e.id === id)?.name ?? "";
      menu.addItem((i) =>
        i
          .setTitle("Rename session...")
          .setIcon("pencil")
          .onClick(
            asVoid(async () => {
              const next = await promptText(this.app, "Session name:", name);
              if (next) this.sessions.rename(id, next);
            }),
          ),
      );
      menu.addSeparator();
      menu.addItem((i) =>
        i
          .setTitle("Close session")
          .setIcon("trash-2")
          .onClick(() => this.sessions.close(id)),
      );
      if (this.sessions.size > 1) {
        menu.addItem((i) =>
          i
            .setTitle("Close other sessions")
            .setIcon("x")
            .onClick(() => this.sessions.closeOthers(id)),
        );
      }
    }

    menu.showAtMouseEvent(event);
  }
}

import { ItemView, WorkspaceLeaf, Platform, Menu, Scope, setIcon } from "obsidian";
import { TERMINAL_VIEW_TYPE } from "../types";
import type { TerminalSessionManager } from "../terminal/session-manager";
import type GitHistoryPlugin from "../main";
import { promptText } from "../utils/prompt";
import { SessionAppearanceModal } from "../components/session-appearance-modal";
import { colorClass } from "../terminal/session-appearance";
import { TerminalSearchBar } from "../components/terminal-search-bar";
import { asVoid } from "../utils/async";

/** Below this width the session strip lies down above the terminal instead. */
const NARROW_WIDTH = 320;

export class TerminalView extends ItemView {
  private sessions: TerminalSessionManager;
  private wrapperEl: HTMLElement | null = null;
  private stripEl: HTMLElement | null = null;
  private searchBar: TerminalSearchBar | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private dragFrom: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
    super(leaf);
    this.sessions = plugin.terminals;

    // Mod+F belongs to whatever is in front, and while that is a terminal it
    // is this. A scope on the view is how Obsidian says that: it applies only
    // while the view has the focus, so the shortcut is there out of the box
    // without being taken away from the editor's own search. The command in
    // main.ts is the same action, for the palette and for rebinding.
    this.scope = new Scope(this.app.scope);
    this.scope.register(["Mod"], "f", (event) => {
      event.preventDefault();
      this.openSearch();
      return false;
    });
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
    this.searchBar = new TerminalSearchBar(this.wrapperEl);
    this.stripEl = container.createDiv("gs-terminal-strip");

    this.addAction("search", "Find in terminal", () => this.openSearch());
    this.addAction(
      "plus",
      "New terminal session",
      asVoid(() => this.newSession()),
    );
    this.addAction("trash-2", "Close terminal session", () => this.closeActive());
    this.addAction("menu", "Session menu", (e) => this.showMenu(e));

    this.registerEvent(this.sessions.on("sessions-changed", () => this.render()));

    // A session outlives the view it was started in, so a reopened terminal
    // picks up whatever is still running rather than starting over.
    this.sessions.attachAll(this.wrapperEl);
    if (this.sessions.size === 0) await this.newSession();
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
    this.searchBar?.destroy();
    this.searchBar = null;
    this.sessions.detachAll();
    this.wrapperEl = null;
    this.stripEl = null;
  }

  /**
   * Opens the find bar on the session in front, or focuses it when it is
   * already open — which is what the shortcut does in every editor, and what
   * makes pressing it twice select the term instead of doing nothing.
   */
  openSearch(): void {
    const bar = this.searchBar;
    const session = this.sessions.activeSession();
    if (!bar || !session) return;

    if (bar.isOpen) bar.focus();
    else bar.show(session);
  }

  async newSession(): Promise<void> {
    if (!this.wrapperEl) return;
    await this.sessions.create(this.wrapperEl);
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

    // The bar searches whatever is in front, so switching sessions moves it.
    this.searchBar?.retarget(this.sessions.activeSession());

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

      const tint = colorClass(entry.color);
      if (tint) tab.addClass(tint);

      const icon = tab.createSpan("gs-terminal-tab-icon");
      setIcon(icon, entry.icon);

      // No close affordance on the icon itself: it sits under the pointer on
      // the way to switching sessions, and a misclick ends a running shell.
      // Closing goes through the header button or the context menu.
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

  /**
   * Reordering by dragging, the way the VS Code terminal list works.
   *
   * The drop marker sits on the edge the tab would land on — above the target
   * when dragging upwards, below it when dragging down — and follows the strip
   * when a narrow pane lays it out sideways, so the line always points at the
   * gap the session is about to fall into.
   */
  private wireDrag(tab: HTMLElement, index: number): void {
    tab.addEventListener("dragstart", (e) => {
      this.dragFrom = index;
      tab.addClass("gs-terminal-tab-dragging");
      // Chromium refuses to start a drag without payload, and "move" is what
      // gives the pointer the right cursor over the strip.
      e.dataTransfer?.setData("text/plain", String(index));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragend", () => {
      this.dragFrom = null;
      tab.removeClass("gs-terminal-tab-dragging");
      this.clearDropMarks();
    });
    tab.addEventListener("dragover", (e) => {
      if (this.dragFrom === null || this.dragFrom === index) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      this.clearDropMarks();
      tab.addClass(
        index < this.dragFrom ? "gs-terminal-tab-drop-before" : "gs-terminal-tab-drop-after",
      );
    });
    tab.addEventListener("dragleave", () => {
      tab.removeClass("gs-terminal-tab-drop-before");
      tab.removeClass("gs-terminal-tab-drop-after");
    });
    tab.addEventListener("drop", (e) => {
      e.preventDefault();
      this.clearDropMarks();
      if (this.dragFrom === null) return;
      this.sessions.move(this.dragFrom, index);
      this.dragFrom = null;
    });
  }

  /**
   * Drops the marker from every tab. A drag that leaves the strip fires no
   * "dragleave" on the tab it was last over, so the line has to be cleared for
   * the whole strip rather than for the tab that thinks it is still the target.
   */
  private clearDropMarks(): void {
    const strip = this.stripEl;
    if (!strip) return;
    for (const tab of Array.from(strip.children)) {
      tab.removeClass("gs-terminal-tab-drop-before");
      tab.removeClass("gs-terminal-tab-drop-after");
    }
  }

  private showMenu(event: MouseEvent, sessionId?: string): void {
    const id = sessionId ?? this.sessions.activeId;
    const menu = new Menu();

    menu.addItem((i) =>
      i
        .setTitle("New session")
        .setIcon("plus")
        .onClick(asVoid(() => this.newSession())),
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
      menu.addItem((i) =>
        i
          .setTitle("Change icon and colour...")
          .setIcon("palette")
          .onClick(() => this.editAppearance(id)),
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

  private editAppearance(id: string): void {
    const entry = this.sessions.entries.find((e) => e.id === id);
    if (!entry) return;
    new SessionAppearanceModal(
      this.app,
      entry.name,
      { icon: entry.icon, color: entry.color },
      (next) => {
        this.sessions.setIcon(id, next.icon);
        this.sessions.setColor(id, next.color);
      },
    ).open();
  }
}

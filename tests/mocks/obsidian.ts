/**
 * Minimal stand-in for the Obsidian API, enough to render the plugin's views
 * in a DOM. Vitest aliases the `obsidian` import to this module.
 *
 * Only the surface the views actually touch is implemented — extend as needed
 * rather than trying to mirror the whole API.
 */

export interface EventRef {
  name: string;
  callback: (...args: unknown[]) => void;
}

export class Events {
  private handlers = new Map<string, ((...args: unknown[]) => void)[]>();

  on(name: string, callback: (...args: unknown[]) => void): EventRef {
    const list = this.handlers.get(name);
    if (list) list.push(callback);
    else this.handlers.set(name, [callback]);
    return { name, callback };
  }

  off(name: string, callback: (...args: unknown[]) => void): void {
    const list = this.handlers.get(name);
    if (!list) return;
    const i = list.indexOf(callback);
    if (i >= 0) list.splice(i, 1);
  }

  offref(ref: EventRef): void {
    this.off(ref.name, ref.callback);
  }

  trigger(name: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(name) ?? []) cb(...args);
  }
}

export class Component {
  private refs: EventRef[] = [];
  registerEvent(ref: EventRef): void {
    this.refs.push(ref);
  }
  registerDomEvent(): void {}
  register(): void {}
  load(): void {}
  unload(): void {}
}

export class WorkspaceLeaf {
  view: unknown = null;
}

/** Vault paths the mocked app knows about; tests add what they need. */
export const vaultFiles = new Set<string>();
/** Files opened through the workspace, for assertions. */
export const openedFiles: string[] = [];

export class TFile {
  constructor(public path: string) {}
}

const mockApp = {
  vault: {
    getAbstractFileByPath: (path: string): TFile | null =>
      vaultFiles.has(path) ? new TFile(path) : null,
  },
  workspace: {
    openLinkText: (): void => {},
    getLeaf: (): { openFile: (file: TFile) => Promise<void> } => ({
      openFile: async (file: TFile): Promise<void> => {
        openedFiles.push(file.path);
      },
    }),
  },
};

export class ItemView extends Component {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  app: Record<string, unknown> = mockApp;
  leaf: WorkspaceLeaf;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.containerEl = document.createElement("div");
    this.contentEl = document.createElement("div");
    this.containerEl.appendChild(this.contentEl);
    document.body.appendChild(this.containerEl);
  }

  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
}

/** Records every Notice so tests can assert on user-facing errors. */
export class Notice {
  static messages: string[] = [];
  constructor(message: string) {
    Notice.messages.push(message);
  }
  hide(): void {}
}

export class MenuItem {
  setTitle(): this {
    return this;
  }
  setIcon(): this {
    return this;
  }
  onClick(): this {
    return this;
  }
  setDisabled(): this {
    return this;
  }
}

export class Menu {
  items: MenuItem[] = [];
  addItem(cb: (item: MenuItem) => void): this {
    const item = new MenuItem();
    cb(item);
    this.items.push(item);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtMouseEvent(): void {}
  showAtPosition(): void {}
}

export class Modal {
  app: unknown;
  contentEl: HTMLElement;
  titleEl: HTMLElement;
  constructor(app?: unknown) {
    this.app = app;
    this.contentEl = document.createElement("div");
    this.titleEl = document.createElement("div");
  }
  open(): void {
    this.onOpen?.();
  }
  close(): void {
    this.onClose?.();
  }
  onOpen?(): void;
  onClose?(): void;
}

export class Setting {
  constructor(containerEl: HTMLElement) {
    void containerEl;
  }
  setName(): this {
    return this;
  }
  setDesc(): this {
    return this;
  }
  addText(): this {
    return this;
  }
  addToggle(): this {
    return this;
  }
  addButton(): this {
    return this;
  }
}

export class PluginSettingTab {
  constructor(app?: unknown, plugin?: unknown) {
    void app;
    void plugin;
  }
}

export class Plugin extends Component {}

/** Counts icon renders — used to prove scrolling does not re-parse icons. */
export const iconStats = { renders: 0 };

export function setIcon(parent: Element, iconId: string): void {
  iconStats.renders++;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `svg-icon lucide-${iconId}`);
  parent.appendChild(svg);
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

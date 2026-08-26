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
    configDir: ".obsidian",
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
  setChecked(): this {
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

/**
 * The component stubs `Setting.add*` hands to its callbacks.
 *
 * They record what was set and keep the `onChange`/`onClick` handler reachable,
 * which is what lets a test drive a settings row the way a user would rather
 * than only assert that a row was created.
 */
export class ValueComponent<T> {
  value: T;
  placeholder = "";
  options: Record<string, string> = {};
  disabled = false;
  changed: ((value: T) => unknown) | null = null;

  constructor(initial: T) {
    this.value = initial;
  }
  setValue(value: T): this {
    this.value = value;
    return this;
  }
  getValue(): T {
    return this.value;
  }
  setPlaceholder(text: string): this {
    this.placeholder = text;
    return this;
  }
  addOptions(options: Record<string, string>): this {
    this.options = { ...this.options, ...options };
    return this;
  }
  setDisabled(disabled: boolean): this {
    this.disabled = disabled;
    return this;
  }
  onChange(cb: (value: T) => unknown): this {
    this.changed = cb;
    return this;
  }
  /** Types or toggles as a user would, firing whatever onChange was wired. */
  emit(value: T): void {
    this.value = value;
    this.changed?.(value);
  }
}

export class ButtonComponent {
  text = "";
  cta = false;
  icon = "";
  clicked: (() => unknown) | null = null;

  setButtonText(text: string): this {
    this.text = text;
    return this;
  }
  setIcon(icon: string): this {
    this.icon = icon;
    return this;
  }
  setCta(): this {
    this.cta = true;
    return this;
  }
  setTooltip(): this {
    return this;
  }
  setWarning(): this {
    return this;
  }
  onClick(cb: () => unknown): this {
    this.clicked = cb;
    return this;
  }
  click(): void {
    this.clicked?.();
  }
}

export class Setting {
  el: HTMLElement;
  name = "";
  desc = "";
  heading = false;
  components: (ValueComponent<unknown> | ButtonComponent)[] = [];

  constructor(containerEl: HTMLElement) {
    this.el = containerEl.createDiv("setting-item");
    settings.push(this);
  }
  setName(name: string): this {
    this.name = name;
    this.el.createDiv({ cls: "setting-item-name", text: name });
    return this;
  }
  setDesc(desc: string): this {
    this.desc = desc;
    this.el.createDiv({ cls: "setting-item-description", text: desc });
    return this;
  }
  setHeading(): this {
    this.heading = true;
    this.el.addClass("setting-item-heading");
    return this;
  }
  addText(cb?: (c: ValueComponent<string>) => unknown): this {
    return this.add(new ValueComponent(""), cb);
  }
  addTextArea(cb?: (c: ValueComponent<string>) => unknown): this {
    return this.add(new ValueComponent(""), cb);
  }
  addDropdown(cb?: (c: ValueComponent<string>) => unknown): this {
    return this.add(new ValueComponent(""), cb);
  }
  addToggle(cb?: (c: ValueComponent<boolean>) => unknown): this {
    return this.add(new ValueComponent(false), cb);
  }
  addButton(cb?: (c: ButtonComponent) => unknown): this {
    const button = new ButtonComponent();
    this.components.push(button);
    cb?.(button);
    return this;
  }
  private add<T>(component: ValueComponent<T>, cb?: (c: ValueComponent<T>) => unknown): this {
    this.components.push(component as ValueComponent<unknown>);
    cb?.(component);
    return this;
  }
  /** The first value component on the row, which is all any row here has. */
  control<T>(): ValueComponent<T> {
    return this.components.find((c) => c instanceof ValueComponent) as ValueComponent<T>;
  }
}

/**
 * Every Setting built since the last `resetSettings()`. Rows are created deep
 * inside a render pass and are not otherwise reachable from a test.
 */
export const settings: Setting[] = [];

export function resetSettings(): void {
  settings.length = 0;
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

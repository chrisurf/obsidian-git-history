import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type { GitHistorySettings, RemoteInfo } from "./types";
import type GitHistoryPlugin from "./main";
import { GitIdentitySection } from "./components/git-identity-section";
import { RemotesSection } from "./components/remotes-section";
import { RemoteModal } from "./components/remote-modal";
import { describeSetting } from "./components/setting-text";
import { describeRemote, remoteHostLabel } from "./git/git-remote";
import { asVoid } from "./utils/async";

type SettingKey = keyof GitHistorySettings;

/**
 * The plugin's own description of a settings row.
 *
 * Deliberately not Obsidian's `SettingDefinition`: those types belong to the
 * 1.13 settings API, and `renderDefinitions` below has to read every field on
 * the versions that predate it. Describing the list in the plugin's own terms
 * keeps the reading side free of an API it cannot rely on; `toDefinitions`
 * hands 1.13 what it asks for at the one place that knows it is talking to
 * 1.13.
 *
 * `desc` is one line, and `hint` is what used to be the rest of it. A row's
 * description sits in a narrow column beside its control, so a three-sentence
 * description pushed the control into a corner and buried the sentence that
 * mattered. The first line now says what the setting is, and the hint — the
 * caveat, the "leave empty to" — is a dimmer line under it.
 */
export type SettingRow = {
  name: string;
  desc?: string;
  /** The rest of the explanation, on a quieter line under `desc`. */
  hint?: string;
  /** Extra terms the 1.13 settings search should match this row on. */
  aliases?: string[];
  key: SettingKey;
  /** Greyed out while this other setting is off — an interval with nothing
      to space out is not a decision anyone has to make. */
  enabledBy?: SettingKey;
} & (
  | { type: "text"; placeholder?: string; mono?: true }
  | { type: "textarea"; placeholder?: string; rows?: number }
  | { type: "toggle" }
  | { type: "dropdown"; options: Record<string, string> }
  | { type: "number"; min?: number; max?: number }
);

export interface SettingGroup {
  heading: string;
  rows: SettingRow[];
}

/**
 * The plugin's settings, grouped by the question they answer.
 *
 * The plugin does several unrelated things — it commits, it draws changes and
 * diffs, it runs a shell — and one run of a dozen rows made you read all of
 * them to find any. The groups are the index: "how do my commits get to the
 * server" is one heading, "how does the changes list look" is another, and
 * the rows nobody should need — paths, timings — sit under Advanced at the
 * bottom rather than between the two.
 *
 * There is deliberately only one list. Obsidian 1.13 renders and searches
 * settings from `getSettingDefinitions`, older versions call `display()`, and
 * this file used to carry both spellings side by side — which had already
 * drifted apart, down to a differently worded label on the same row. Both
 * paths are built from this array now, so the two can no longer disagree.
 */
export const SETTING_GROUPS: SettingGroup[] = [
  {
    heading: "Commits and sync",
    rows: [
      {
        name: "Commit message",
        desc: "What a new commit's message box starts with.",
        hint: "Use {{date}} for today's date.",
        aliases: ["commit message template"],
        key: "commitTemplate",
        type: "text",
        placeholder: "vault backup {{date}}",
      },
      {
        name: "Pull strategy",
        desc: "How commits from the remote are combined with your own.",
        key: "pullStrategy",
        type: "dropdown",
        options: { merge: "Merge", rebase: "Rebase", "ff-only": "Fast-forward only" },
      },
      {
        name: "Auto-fetch",
        desc: "Check the remote for new commits in the background.",
        key: "autoFetchEnabled",
        type: "toggle",
      },
      {
        name: "Auto-fetch every",
        desc: "Seconds between those checks.",
        aliases: ["auto-fetch interval"],
        key: "autoFetchInterval",
        type: "number",
        min: 30,
        enabledBy: "autoFetchEnabled",
      },
    ],
  },
  {
    heading: "Changes and diffs",
    rows: [
      {
        name: "Changes layout",
        desc: "Changed files nested under their folders, or one flat row each.",
        key: "fileListMode",
        type: "dropdown",
        options: { tree: "Tree", list: "List" },
      },
      {
        name: "Compact folders",
        desc: "Fold folders that hold a single subfolder into one row.",
        hint: "Tree layout only.",
        key: "compactFolders",
        type: "toggle",
      },
      {
        name: "Default diff view",
        desc: "Show a changed file as two columns, or as one annotated text.",
        key: "diffViewMode",
        type: "dropdown",
        options: { "side-by-side": "Side by side", inline: "Inline" },
      },
      {
        name: "Only list files Obsidian can open",
        desc: "Leave files no Obsidian view can render out of a commit's file list.",
        hint: "Such as .json or .parquet. Turn this off to list everything a commit touched.",
        key: "onlySupportedFileTypes",
        type: "toggle",
      },
    ],
  },
  {
    heading: "Advanced",
    rows: [
      {
        name: "Show nested repositories",
        desc: "List folders inside the vault that are Git repositories of their own.",
        hint: "They cannot be staged from here, which is why they are hidden by default.",
        key: "showNestedRepos",
        type: "toggle",
      },
      {
        name: "Refresh delay",
        desc: "Milliseconds to wait after a file changes before reading status again.",
        aliases: ["file watcher debounce"],
        key: "debounceMs",
        type: "number",
        min: 100,
      },
      {
        name: "Git binary",
        desc: "Path to the git the plugin runs.",
        hint: "Leave empty to find one automatically, which also searches the PATH your own shell uses.",
        aliases: ["git path", "git executable"],
        key: "gitPath",
        type: "text",
        placeholder: "/opt/homebrew/bin/git",
        mono: true,
      },
    ],
  },
  {
    heading: "Terminal",
    rows: [
      {
        // Under the heading the word "terminal" is already said; the alias
        // keeps the row findable by the name it used to have.
        name: "Shell",
        desc: "Path to the shell binary the terminal starts.",
        hint: "Leave empty for auto-detect.",
        aliases: ["terminal shell"],
        key: "terminalShell",
        type: "text",
        placeholder: "/bin/zsh",
        mono: true,
      },
      {
        name: "Python",
        desc: "Path to the Python 3 that runs the terminal's pseudo-terminal bridge.",
        hint: "Leave empty to find one automatically. Set it if the terminal reports that none was found.",
        aliases: ["terminal python", "python path", "pty"],
        key: "terminalPython",
        type: "text",
        placeholder: "/opt/homebrew/bin/python3",
        mono: true,
      },
      {
        name: "Pseudo-terminal",
        desc: "Which bridge gives the shell a real terminal.",
        hint:
          "Automatic tries them in order and takes the first that works. Pipes is a last " +
          "resort with no prompt or colours.",
        aliases: ["pty", "backend", "terminal bridge"],
        key: "terminalPtyBackend",
        type: "dropdown",
        options: {
          auto: "Automatic",
          python: "Python",
          perl: "Perl (macOS only)",
          pipe: "Pipes (no terminal)",
        },
      },
      {
        name: "Startup script",
        desc: "Shell code run at the start of every session, before the first prompt.",
        hint:
          "The same place you would put it in .zshrc, in the language of the shell above. It " +
          "is stored in the vault, so keep secrets out of it.",
        aliases: ["terminal startup script", "init script", "rc", "profile", "zshrc", "bashrc"],
        key: "terminalStartupScript",
        type: "textarea",
        rows: 10,
        placeholder: "alias gs='git status'\nexport EDITOR=nvim",
      },
      {
        name: "Colour new sessions",
        desc: "Give every session you open the next free colour from the palette.",
        hint: "A session's colour and icon can always be set by hand from its right-click menu.",
        aliases: ["colour new terminal sessions", "color new terminal sessions"],
        key: "terminalAutoColor",
        type: "toggle",
      },
    ],
  },
];

/** The description of one row, as the two lines it is made of. */
export function rowDescription(row: SettingRow): DocumentFragment | undefined {
  if (!row.desc) return undefined;
  return describeSetting(row.desc, row.hint);
}

/**
 * The same list in the shape Obsidian 1.13 wants for its own renderer.
 *
 * The only place in the plugin that names the 1.13 settings types, which is the
 * point: everything else works off `SettingGroup` and stays usable on the
 * versions that predate the API.
 */
export function toDefinitions(
  groups: readonly SettingGroup[],
  read: ReadValue,
): SettingDefinitionItem[] {
  return groups.map((group) => ({
    type: "group" as const,
    heading: group.heading,
    items: group.rows.map((row) => ({
      name: row.name,
      ...(row.desc ? { desc: rowDescription(row) } : {}),
      ...(row.aliases ? { aliases: row.aliases } : {}),
      control: control(row, read),
    })),
  }));
}

/** The control half of a 1.13 definition, spelled out so the mapping above is
    checked by the compiler instead of asserted. */
type ControlShape = { disabled?: () => boolean } & (
  | { type: "text"; key: SettingKey; placeholder?: string }
  | { type: "textarea"; key: SettingKey; placeholder?: string; rows?: number }
  | { type: "toggle"; key: SettingKey }
  | { type: "dropdown"; key: SettingKey; options: Record<string, string> }
  | { type: "number"; key: SettingKey; min?: number; max?: number }
);

function control(row: SettingRow, read: ReadValue): ControlShape {
  const gate = row.enabledBy;
  const disabled = gate ? { disabled: (): boolean => !read(gate) } : {};
  switch (row.type) {
    case "dropdown":
      return { type: "dropdown", key: row.key, options: row.options, ...disabled };
    case "number":
      return {
        type: "number",
        key: row.key,
        ...(row.min !== undefined ? { min: row.min } : {}),
        ...(row.max !== undefined ? { max: row.max } : {}),
        ...disabled,
      };
    case "text":
      return {
        type: "text",
        key: row.key,
        ...(row.placeholder ? { placeholder: row.placeholder } : {}),
        ...disabled,
      };
    case "textarea":
      return {
        type: "textarea",
        key: row.key,
        ...(row.placeholder ? { placeholder: row.placeholder } : {}),
        ...(row.rows !== undefined ? { rows: row.rows } : {}),
        ...disabled,
      };
    default:
      return { type: "toggle", key: row.key, ...disabled };
  }
}

/**
 * The identity rows, in the shape 1.13 renders.
 *
 * They are `render` items rather than controls: a control is bound to a key in
 * the plugin's storage, and these two are bound to `git config` in the vault.
 * Everything else about them — heading, order, search — is the same as any
 * other row.
 */
export function identityDefinitions(section: GitIdentitySection): SettingDefinitionItem {
  return {
    type: "group" as const,
    heading: "Identity",
    items: GitIdentitySection.ROWS.map((row) => ({
      name: GitIdentitySection.rowName(row),
      desc: GitIdentitySection.rowDesc(row),
      render: (setting: Setting) => section.field(setting, row),
    })),
  };
}

/** The same rows for the versions that predate the definitions API. */
export function renderIdentityGroup(containerEl: HTMLElement, section: GitIdentitySection): void {
  new Setting(containerEl).setName("Identity").setHeading();
  for (const row of GitIdentitySection.ROWS) {
    const setting = new Setting(containerEl)
      .setName(GitIdentitySection.rowName(row))
      .setDesc(GitIdentitySection.rowDesc(row));
    section.field(setting, row);
  }
}

const REMOTE_HEADING = "Remote repository";
const REMOTE_NOTE =
  "Where this vault is pushed to and pulled from — its copy on GitHub, GitLab or a server " +
  "of your own.";

/**
 * The remotes, as the 1.13 list the API has for exactly this: rows the user
 * adds and deletes rather than settings they set.
 *
 * The rows are built from what git said last, not from a read started here: a
 * definition is built synchronously, and a list that waited for git would draw
 * empty every time the tab opens. {@link RemotesSection.sync} does the reading
 * and asks for a redraw when the answer differs from what is on screen.
 */
export function remoteDefinitions(section: RemotesSection): SettingDefinitionItem {
  section.sync();
  const remotes = section.list;
  return {
    type: "list" as const,
    heading: REMOTE_HEADING,
    emptyState: describeSetting(section.emptyState()),
    ...(section.isRepo
      ? {
          addItem: {
            name: "Add a remote",
            action: () => section.add(),
          },
          onDelete: (index: number): void => {
            const remote = remotes[index];
            if (remote) void section.remove(remote.name);
          },
        }
      : {}),
    items: remotes.map((remote) => ({
      name: remote.name,
      desc: remoteDescription(remote),
      aliases: ["remote", "origin", "push", "pull", remote.fetchUrl],
      render: (setting: Setting) => section.field(setting, remote),
    })),
  };
}

/** The same rows for the versions that predate the definitions API. */
export function renderRemoteGroup(containerEl: HTMLElement, section: RemotesSection): void {
  section.sync();
  new Setting(containerEl).setName(REMOTE_HEADING).setHeading().setDesc(REMOTE_NOTE);

  for (const remote of section.list) {
    const setting = new Setting(containerEl)
      .setName(remote.name)
      .setDesc(remoteDescription(remote));
    section.field(setting, remote);
    setting.addExtraButton((button) =>
      button
        .setIcon("trash-2")
        .setTooltip(`Remove "${remote.name}"`)
        .onClick(asVoid(() => section.remove(remote.name))),
    );
  }

  if (section.list.length === 0) {
    new Setting(containerEl).setDesc(section.emptyState());
  }
  if (section.isRepo) {
    new Setting(containerEl).addButton((button) =>
      button.setButtonText("Add a remote").onClick(() => section.add()),
    );
  }
}

/**
 * A remote's row: which repository it is, which host it is on, and — for
 * `origin` — that this is the one push and pull use without being told.
 */
function remoteDescription(remote: RemoteInfo): DocumentFragment {
  const isDefault = remote.name === "origin";
  return describeSetting(describeRemote(remote), {
    label: remoteHostLabel(remote.fetchUrl || remote.pushUrl),
    tone: isDefault ? "accent" : "neutral",
    detail: isDefault ? "Push and pull use this remote." : null,
  });
}

export class GitHistorySettingTab extends PluginSettingTab {
  plugin: GitHistoryPlugin;
  /** Outlives a render pass, because it holds what git last said about the
      remotes and asks for the redraw that shows it. */
  private remotes: RemotesSection | null = null;

  constructor(app: App, plugin: GitHistoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Obsidian 1.13+ renders, groups and searches settings from these. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      identityDefinitions(new GitIdentitySection(this.plugin.git)),
      remoteDefinitions(this.remotesSection()),
      ...toDefinitions(SETTING_GROUPS, (key) => this.getControlValue(key)),
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as SettingKey];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: value });
    if (key === "showNestedRepos") {
      this.plugin.store.showNestedRepos = Boolean(value);
    }
    if (key === "fileListMode" || key === "compactFolders") {
      this.plugin.refreshFileLists();
    }
    await this.plugin.saveSettings();
    // A setting another row is greyed out by changes what that row may do, and
    // nothing re-evaluates `disabled` on its own.
    if (SETTING_GROUPS.some((g) => g.rows.some((r) => r.enabledBy === key))) this.redraw();
  }

  /** What older Obsidian versions call, built from the same list. */
  display(): void {
    this.render();
  }

  private render(): void {
    this.containerEl.empty();
    renderIdentityGroup(this.containerEl, new GitIdentitySection(this.plugin.git));
    renderRemoteGroup(this.containerEl, this.remotesSection());
    renderGroups(
      this.containerEl,
      SETTING_GROUPS,
      (key) => this.getControlValue(key),
      (key, value) => this.setControlValue(key, value),
    );
  }

  private remotesSection(): RemotesSection {
    this.remotes ??= new RemotesSection({
      git: this.plugin.git,
      refresh: () => this.redraw(),
      prompt: (taken, save) => new RemoteModal(this.app, { taken, onSave: save }).open(),
    });
    return this.remotes;
  }

  /**
   * Draws the tab again.
   *
   * 1.13 keeps the definitions and rebuilds from them on `update()`; the
   * versions before it have only `display()`. Which one exists is a property
   * of the running app, so it is asked rather than assumed.
   */
  private redraw(): void {
    const tab = this as unknown as { update?: () => void };
    if (typeof tab.update === "function") tab.update();
    else if (this.containerEl.isShown()) this.render();
  }
}

type ReadValue = (key: SettingKey) => unknown;
type WriteValue = (key: SettingKey, value: unknown) => void | Promise<void>;

/**
 * Draws the groups as plain `Setting` rows, for the Obsidian versions that do
 * not render the definitions themselves.
 */
export function renderGroups(
  containerEl: HTMLElement,
  groups: readonly SettingGroup[],
  read: ReadValue,
  write: WriteValue,
): void {
  for (const group of groups) {
    new Setting(containerEl).setName(group.heading).setHeading();
    for (const row of group.rows) renderRow(containerEl, row, read, write);
  }
}

function renderRow(
  containerEl: HTMLElement,
  row: SettingRow,
  read: ReadValue,
  write: WriteValue,
): void {
  const setting = new Setting(containerEl).setName(row.name);
  const desc = rowDescription(row);
  if (desc) setting.setDesc(desc);
  if (row.enabledBy && !read(row.enabledBy)) setting.setDisabled(true);
  const save = (value: unknown): void => asVoid(async () => write(row.key, value))();

  switch (row.type) {
    case "toggle":
      setting.addToggle((t) => t.setValue(Boolean(read(row.key))).onChange(save));
      break;

    case "dropdown":
      setting.addDropdown((d) =>
        d.addOptions(row.options).setValue(readString(read, row.key)).onChange(save),
      );
      break;

    case "number":
      setting.addText((t) => {
        const value = read(row.key);
        t.setValue(typeof value === "number" ? String(value) : "");
        // A half-typed number must not be written back as NaN, and a value
        // outside the range is a typo rather than a setting — both are left
        // alone until the field holds something usable.
        t.onChange((raw) => {
          const parsed = Number.parseInt(raw, 10);
          if (Number.isNaN(parsed)) return;
          if (row.min !== undefined && parsed < row.min) return;
          if (row.max !== undefined && parsed > row.max) return;
          save(parsed);
        });
      });
      break;

    case "textarea":
      // The row stacks rather than squeezing a script into the narrow control
      // column; the class is what styles.css hangs that on.
      setting.settingEl.addClass("gs-setting-stacked");
      setting.addTextArea((t) => {
        t.setValue(readString(read, row.key));
        if (row.placeholder) t.setPlaceholder(row.placeholder);
        if (row.rows !== undefined) t.inputEl.rows = row.rows;
        t.inputEl.addClass("gs-script-input");
        t.onChange(save);
      });
      break;

    default:
      setting.addText((t) => {
        t.setValue(readString(read, row.key));
        if (row.placeholder) t.setPlaceholder(row.placeholder);
        if (row.mono) t.inputEl.addClass("gs-path-input");
        t.onChange(save);
      });
      break;
  }
}

function readString(read: ReadValue, key: SettingKey): string {
  const value = read(key);
  return typeof value === "string" ? value : "";
}

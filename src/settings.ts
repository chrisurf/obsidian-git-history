import { App, PluginSettingTab, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type { GitHistorySettings } from "./types";
import type GitHistoryPlugin from "./main";
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
 */
export type SettingRow = {
  name: string;
  desc?: string;
  /** Extra terms the 1.13 settings search should match this row on. */
  aliases?: string[];
  key: SettingKey;
} & (
  | { type: "text"; placeholder?: string }
  | { type: "toggle" }
  | { type: "dropdown"; options: Record<string, string> }
  | { type: "number"; min?: number; max?: number }
);

export interface SettingGroup {
  heading: string;
  rows: SettingRow[];
}

/**
 * The plugin's settings, in two groups.
 *
 * The plugin does two unrelated things — version control, and a shell — and a
 * single run of a dozen rows made you read all of them to find either. Split
 * under two headings, the question "where do I set the shell" has one place to
 * look.
 *
 * There is deliberately only one list. Obsidian 1.13 renders and searches
 * settings from `getSettingDefinitions`, older versions call `display()`, and
 * this file used to carry both spellings side by side — which had already
 * drifted apart, down to a differently worded label on the same row. Both
 * paths are built from this array now, so the two can no longer disagree.
 */
export const SETTING_GROUPS: SettingGroup[] = [
  {
    heading: "Source control",
    rows: [
      {
        name: "Commit message template",
        desc: "Default commit message. Use {{date}} for the current date.",
        key: "commitTemplate",
        type: "text",
        placeholder: "vault backup {{date}}",
      },
      {
        name: "Pull strategy",
        desc: "How commits downloaded from a remote are combined with your own.",
        key: "pullStrategy",
        type: "dropdown",
        options: { merge: "Merge", rebase: "Rebase", "ff-only": "Fast-forward only" },
      },
      {
        name: "Auto-fetch",
        desc: "Check remotes for new commits in the background.",
        key: "autoFetchEnabled",
        type: "toggle",
      },
      {
        name: "Auto-fetch interval",
        desc: "Seconds between automatic fetches.",
        key: "autoFetchInterval",
        type: "number",
        min: 30,
      },
      {
        name: "Default diff view",
        desc: "Show a changed file as two columns side by side, or as one annotated text.",
        key: "diffViewMode",
        type: "dropdown",
        options: { "side-by-side": "Side by side", inline: "Inline" },
      },
      {
        name: "Changes layout",
        desc: "Show changed files nested under their folders, or one flat row per file.",
        key: "fileListMode",
        type: "dropdown",
        options: { tree: "Tree", list: "List" },
      },
      {
        name: "Compact folders",
        desc: "Fold folders that hold a single subfolder into one row. Tree layout only.",
        key: "compactFolders",
        type: "toggle",
      },
      {
        name: "Only list files Obsidian can open",
        desc:
          "A commit's file list leaves out files no Obsidian view can render, such as .json " +
          "or .parquet. Turn this off to list everything a commit touched.",
        key: "onlySupportedFileTypes",
        type: "toggle",
      },
      {
        name: "Show nested repositories",
        desc:
          "Folders inside the vault that are Git repositories of their own cannot be staged, " +
          "so they are hidden from the changes list. Turn this on to list them anyway.",
        key: "showNestedRepos",
        type: "toggle",
      },
      {
        name: "File watcher debounce",
        desc: "Milliseconds to wait before refreshing status after file changes.",
        key: "debounceMs",
        type: "number",
        min: 100,
      },
      {
        name: "Git binary",
        desc:
          "Path to the git the plugin runs. Leave empty to find one automatically, which " +
          "also searches the PATH your own shell uses.",
        aliases: ["git path", "git executable"],
        key: "gitPath",
        type: "text",
        placeholder: "/opt/homebrew/bin/git",
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
        desc: "Path to the shell binary the terminal starts. Leave empty for auto-detect.",
        aliases: ["terminal shell"],
        key: "terminalShell",
        type: "text",
        placeholder: "/bin/zsh",
      },
      {
        name: "Python",
        desc:
          "Path to the Python 3 that runs the terminal's pseudo-terminal bridge. Leave empty " +
          "to find one automatically. Set it if the terminal reports that none was found.",
        aliases: ["terminal python", "python path", "pty"],
        key: "terminalPython",
        type: "text",
        placeholder: "/opt/homebrew/bin/python3",
      },
      {
        name: "Pseudo-terminal",
        desc:
          "Which bridge gives the shell a real terminal. Automatic tries them in order and " +
          "takes the first that works. Pipes is a last resort with no prompt or colours.",
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
        name: "Colour new sessions",
        desc:
          "Give every session you open the next free colour from the palette, so a strip of " +
          "identical shell icons stays readable. A session's colour and icon can always be " +
          "set by hand from its right-click menu.",
        aliases: ["colour new terminal sessions", "color new terminal sessions"],
        key: "terminalAutoColor",
        type: "toggle",
      },
    ],
  },
];

/**
 * The same list in the shape Obsidian 1.13 wants for its own renderer.
 *
 * The only place in the plugin that names the 1.13 settings types, which is the
 * point: everything else works off `SettingGroup` and stays usable on the
 * versions that predate the API.
 */
export function toDefinitions(groups: readonly SettingGroup[]): SettingDefinitionItem[] {
  return groups.map((group) => ({
    type: "group" as const,
    heading: group.heading,
    items: group.rows.map((row) => ({
      name: row.name,
      ...(row.desc ? { desc: row.desc } : {}),
      ...(row.aliases ? { aliases: row.aliases } : {}),
      control: control(row),
    })),
  }));
}

/** The control half of a 1.13 definition, spelled out so the mapping above is
    checked by the compiler instead of asserted. */
type ControlShape =
  | { type: "text"; key: SettingKey; placeholder?: string }
  | { type: "toggle"; key: SettingKey }
  | { type: "dropdown"; key: SettingKey; options: Record<string, string> }
  | { type: "number"; key: SettingKey; min?: number; max?: number };

function control(row: SettingRow): ControlShape {
  switch (row.type) {
    case "dropdown":
      return { type: "dropdown", key: row.key, options: row.options };
    case "number":
      return {
        type: "number",
        key: row.key,
        ...(row.min !== undefined ? { min: row.min } : {}),
        ...(row.max !== undefined ? { max: row.max } : {}),
      };
    case "text":
      return {
        type: "text",
        key: row.key,
        ...(row.placeholder ? { placeholder: row.placeholder } : {}),
      };
    default:
      return { type: "toggle", key: row.key };
  }
}

export class GitHistorySettingTab extends PluginSettingTab {
  plugin: GitHistoryPlugin;

  constructor(app: App, plugin: GitHistoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /** Obsidian 1.13+ renders, groups and searches settings from these. */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return toDefinitions(SETTING_GROUPS);
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
  }

  /** What older Obsidian versions call, built from the same list. */
  display(): void {
    this.containerEl.empty();
    renderGroups(
      this.containerEl,
      SETTING_GROUPS,
      (key) => this.getControlValue(key),
      (key, value) => this.setControlValue(key, value),
    );
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
  if (row.desc) setting.setDesc(row.desc);
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

    default:
      setting.addText((t) => {
        t.setValue(readString(read, row.key));
        if (row.placeholder) t.setPlaceholder(row.placeholder);
        t.onChange(save);
      });
      break;
  }
}

function readString(read: ReadValue, key: SettingKey): string {
  const value = read(key);
  return typeof value === "string" ? value : "";
}

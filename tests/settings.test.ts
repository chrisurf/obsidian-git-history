import { describe, it, expect, beforeEach } from "vitest";
import { settings, resetSettings } from "./mocks/obsidian";
import type { ValueComponent } from "./mocks/obsidian";
import { SETTING_GROUPS, toDefinitions, renderGroups } from "../src/settings";
import { DEFAULT_SETTINGS } from "../src/types";
import type { GitHistorySettings } from "../src/types";

const rows = SETTING_GROUPS.flatMap((g) => g.rows);
const keys = rows.map((r) => r.key);

/**
 * Settings with no row of their own.
 *
 * `lastWhatsNewVersion` is bookkeeping the plugin writes for itself and has no
 * business in the settings tab. `showStatusBar` is different: it is stored and
 * defaulted, but nothing reads it — the status bar is created unconditionally,
 * so the setting promises something it does not do. It is listed rather than
 * excused so the coverage test below stays meaningful for every other setting,
 * and so the gap is something a reader trips over instead of something hidden.
 */
const NOT_EXPOSED: (keyof GitHistorySettings)[] = ["showStatusBar", "lastWhatsNewVersion"];

describe("the settings list", () => {
  it("splits into the two things the plugin does", () => {
    expect(SETTING_GROUPS.map((g) => g.heading)).toEqual(["Source control", "Terminal"]);
  });

  it("puts every terminal setting under the terminal heading and nowhere else", () => {
    const terminal = SETTING_GROUPS.find((g) => g.heading === "Terminal");
    const sourceControl = SETTING_GROUPS.find((g) => g.heading === "Source control");
    expect(terminal?.rows.map((r) => r.key)).toEqual([
      "terminalShell",
      "terminalPython",
      "terminalPtyBackend",
      "terminalStartupScript",
      "terminalAutoColor",
    ]);
    expect(sourceControl?.rows.some((r) => r.key.startsWith("terminal"))).toBe(false);
  });

  it("names a real setting on every row", () => {
    for (const key of keys) expect(DEFAULT_SETTINGS).toHaveProperty(key);
  });

  it("shows no setting twice", () => {
    expect(new Set(keys).size).toBe(keys.length);
  });

  /**
   * The list is the only place a setting becomes reachable, so a setting that
   * is added to the type and forgotten here is invisible to the user. The
   * exclusions above are the deliberate ones.
   */
  it("leaves no setting unreachable", () => {
    const unexposed = (Object.keys(DEFAULT_SETTINGS) as (keyof GitHistorySettings)[]).filter(
      (key) => !keys.includes(key) && !NOT_EXPOSED.includes(key),
    );
    expect(unexposed).toEqual([]);
  });

  it("gives every row a name and a description", () => {
    for (const row of rows) {
      expect(row.name).not.toBe("");
      expect(row.desc).toBeTruthy();
    }
  });

  it("offers the stored value as one of the choices on every dropdown", () => {
    for (const row of rows) {
      if (row.type !== "dropdown") continue;
      expect(Object.keys(row.options)).toContain(String(DEFAULT_SETTINGS[row.key]));
    }
  });
});

describe("definitions for Obsidian 1.13", () => {
  const definitions = toDefinitions(SETTING_GROUPS);

  it("hands over one group per heading", () => {
    expect(definitions).toHaveLength(2);
    expect(definitions.map((d) => (d as { heading?: string }).heading)).toEqual([
      "Source control",
      "Terminal",
    ]);
  });

  it("carries every row across with its control", () => {
    const items = definitions.flatMap(
      (d) =>
        (d as { items?: { name: string; control: { type: string; key: string } }[] }).items ?? [],
    );
    expect(items).toHaveLength(rows.length);
    expect(items.map((i) => i.control.key)).toEqual(keys);
    expect(items.map((i) => i.control.type)).toEqual(rows.map((r) => r.type));
  });

  it("keeps the options and bounds a control needs to render", () => {
    const items = definitions.flatMap(
      (d) => (d as { items?: { control: Record<string, unknown> }[] }).items ?? [],
    );
    const byKey = new Map(items.map((i) => [i.control.key as string, i.control]));
    expect(byKey.get("pullStrategy")?.options).toEqual({
      merge: "Merge",
      rebase: "Rebase",
      "ff-only": "Fast-forward only",
    });
    expect(byKey.get("autoFetchInterval")?.min).toBe(30);
    expect(byKey.get("terminalShell")?.placeholder).toBe("/bin/zsh");
    expect(byKey.get("terminalStartupScript")?.type).toBe("textarea");
    expect(byKey.get("terminalStartupScript")?.rows).toBe(10);
  });

  it("leaves out what a row does not have, rather than passing undefined", () => {
    const items = definitions.flatMap(
      (d) => (d as { items?: { control: Record<string, unknown> }[] }).items ?? [],
    );
    const toggle = items.find((i) => i.control.key === "terminalAutoColor")?.control;
    expect(toggle).toEqual({ type: "toggle", key: "terminalAutoColor" });
  });

  it("keeps the search aliases of the rows that were renamed under a heading", () => {
    const items = definitions.flatMap(
      (d) => (d as { items?: { control: { key: string }; aliases?: string[] }[] }).items ?? [],
    );
    expect(items.find((i) => i.control.key === "terminalShell")?.aliases).toContain(
      "terminal shell",
    );
  });
});

/**
 * The path older Obsidian versions take. It cannot be exercised in the real app
 * from here, so the rows it draws are checked here instead — this is the half
 * that used to be a second, hand-maintained copy of the list.
 */
describe("rendering for older Obsidian versions", () => {
  let container: HTMLElement;
  let values: Record<string, unknown>;
  let written: [string, unknown][];

  const render = (): void => {
    renderGroups(
      container,
      SETTING_GROUPS,
      (key) => values[key],
      (key, value) => {
        written.push([key, value]);
      },
    );
  };

  beforeEach(() => {
    resetSettings();
    container = activeDocument.createElement("div");
    values = { ...DEFAULT_SETTINGS };
    written = [];
  });

  it("draws a heading per group and a row per setting", () => {
    render();
    expect(settings.filter((s) => s.heading).map((s) => s.name)).toEqual([
      "Source control",
      "Terminal",
    ]);
    expect(settings.filter((s) => !s.heading)).toHaveLength(rows.length);
  });

  it("puts the rows under the heading they belong to", () => {
    render();
    const order = settings.map((s) => s.name);
    expect(order.indexOf("Shell")).toBeGreaterThan(order.indexOf("Terminal"));
    expect(order.indexOf("Pull strategy")).toBeLessThan(order.indexOf("Terminal"));
  });

  it("shows the stored value in every control", () => {
    values.commitTemplate = "vault backup";
    values.terminalAutoColor = true;
    render();
    const byName = new Map(settings.map((s) => [s.name, s]));
    expect(byName.get("Commit message template")?.control<string>().value).toBe("vault backup");
    expect(byName.get("Colour new sessions")?.control<boolean>().value).toBe(true);
    expect(byName.get("Pull strategy")?.control<string>().options).toHaveProperty("rebase");
  });

  it("writes a change back under the right key", () => {
    render();
    const byName = new Map(settings.map((s) => [s.name, s]));
    byName.get("Colour new sessions")?.control<boolean>().emit(true);
    byName.get("Shell")?.control<string>().emit("/bin/fish");
    expect(written).toEqual([
      ["terminalAutoColor", true],
      ["terminalShell", "/bin/fish"],
    ]);
  });

  it("keeps a half-typed number out of the settings", () => {
    render();
    const interval = settings.find((s) => s.name === "Auto-fetch interval")?.control<string>();
    interval?.emit("");
    interval?.emit("-");
    expect(written).toEqual([]);
    interval?.emit("600");
    expect(written).toEqual([["autoFetchInterval", 600]]);
  });

  it("refuses a number below the minimum instead of storing it", () => {
    render();
    const interval = settings.find((s) => s.name === "Auto-fetch interval")?.control<string>();
    // Fetching every two seconds is a typo on the way to 200, not a setting.
    interval?.emit("2");
    expect(written).toEqual([]);
  });

  it("carries the placeholder onto the text rows that have one", () => {
    render();
    expect(settings.find((s) => s.name === "Shell")?.control<string>().placeholder).toBe(
      "/bin/zsh",
    );
  });

  /**
   * A shell script in a one-line text field is unusable, and the row that
   * holds it is the one setting here that needs more than the control column.
   */
  it("gives the startup script a stacked row and a text area to type into", () => {
    values.terminalStartupScript = "alias gs='git status'";
    render();
    const row = settings.find((s) => s.name === "Startup script");
    expect(row?.settingEl.classList.contains("gs-setting-stacked")).toBe(true);

    const control = row?.control<string>() as
      | (ValueComponent<string> & {
          inputEl: HTMLTextAreaElement;
        })
      | undefined;
    expect(control?.value).toBe("alias gs='git status'");
    expect(Number(control?.inputEl.rows)).toBe(10);
    expect(control?.inputEl.classList.contains("gs-script-input")).toBe(true);

    control?.emit("export EDITOR=nvim");
    expect(written).toEqual([["terminalStartupScript", "export EDITOR=nvim"]]);
  });
});

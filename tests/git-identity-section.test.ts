import { describe, it, expect, beforeEach } from "vitest";
import { Notice, settings, resetSettings } from "./mocks/obsidian";
import type { TextComponent } from "./mocks/obsidian";
import { renderIdentityGroup } from "../src/settings";
import { GitIdentitySection } from "../src/components/git-identity-section";
import { parseIdentity } from "../src/git/git-identity";
import type { GitIdentity } from "../src/git/git-identity";

/**
 * The identity rows are the one place in the settings where what is shown does
 * not come from the plugin's own storage but from `git config`, and where an
 * edit runs a command. What is checked here is the part that would otherwise
 * be invisible: that the row says where its value comes from, that an edit is
 * written for this vault and nowhere else, and that nothing is written until
 * there is a reason to write it.
 */

/**
 * git config as a set of scoped entries, which is what it is. The plugin
 * writes to the vault's own config only, so a global value stays where it is
 * and is overridden here the way it would be in a repository.
 */
const PRECEDENCE = ["system", "global", "local"];

class FakeGit {
  written: [string, string][] = [];
  isRepoAnswer = true;
  private lines: string[];

  constructor(...lines: string[]) {
    this.lines = [...lines];
  }

  identity(): Promise<GitIdentity> {
    return Promise.resolve(parseIdentity(this.lines.join("\n")));
  }

  setIdentity(field: "name" | "email", value: string): Promise<void> {
    this.written.push([field, value]);
    this.lines = this.lines.filter((l) => l !== `local\tuser.${field} ${valueOf(l, field)}`);
    if (value !== "") this.lines.push(`local\tuser.${field} ${value}`);
    this.lines.sort((a, b) => PRECEDENCE.indexOf(scopeOf(a)) - PRECEDENCE.indexOf(scopeOf(b)));
    return Promise.resolve();
  }

  isRepo(): Promise<boolean> {
    return Promise.resolve(this.isRepoAnswer);
  }
}

const scopeOf = (line: string): string => line.slice(0, line.indexOf("\t"));

/** The value on a line, but only when the line is about this field. */
const valueOf = (line: string, field: string): string => {
  const rest = line.slice(line.indexOf("\t") + 1);
  return rest.startsWith(`user.${field} `) ? rest.slice(`user.${field} `.length) : "\u0000";
};

let container: HTMLElement;

/** Rows paint what they know and repaint when the read lands; a write reads
    back. Neither is one tick. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const render = async (git: FakeGit): Promise<void> => {
  renderIdentityGroup(container, new GitIdentitySection(git));
  await flush();
};

const row = (name: string) => settings.find((s) => s.name === name);
const input = (name: string): TextComponent => row(name)?.control<string>() as TextComponent;
/** The badge under a row's name: two or three words saying where the value
    comes from, which is what the row has to earn. */
const badge = (name: string): string =>
  row(name)?.settingEl.querySelector(".gs-badge")?.textContent ?? "";

/** The sentence behind the badge, for what the badge cannot hold. */
const detail = (name: string): string =>
  row(name)?.settingEl.querySelector(".gs-setting-detail")?.textContent ?? "";

const badgeTone = (name: string): string => {
  const el = row(name)?.settingEl.querySelector(".gs-badge");
  return Array.from(el?.classList ?? [])
    .filter((c) => c.startsWith("gs-badge-"))
    .join(" ");
};

const blur = (name: string): void => {
  input(name).inputEl.dispatchEvent(new Event("blur"));
};

beforeEach(() => {
  resetSettings();
  Notice.messages.length = 0;
  container = activeDocument.createElement("div");
});

describe("what the rows show", () => {
  /**
   * Two rows and no third. There used to be one choosing between this vault
   * and every repository on the computer; the identity is a property of the
   * vault, and the wider config is not the plugin's to write.
   */
  it("draws a heading and the two rows, with nothing to choose", async () => {
    await render(new FakeGit());
    expect(settings.filter((s) => s.heading).map((s) => s.name)).toEqual(["Identity"]);
    expect(settings.filter((s) => !s.heading).map((s) => s.name)).toEqual(["Name", "Email"]);
  });

  it("shows the value git would use", async () => {
    await render(
      new FakeGit("global\tuser.name Ada Lovelace", "global\tuser.email ada@example.com"),
    );
    expect(input("Name").value).toBe("Ada Lovelace");
    expect(input("Email").value).toBe("ada@example.com");
  });

  /**
   * The line that makes the field readable. Without it an inherited name and a
   * name set for this vault are the same characters in the same box, and
   * editing one is a guess about what will change.
   */
  it("says where each value comes from", async () => {
    await render(new FakeGit("global\tuser.name Ada Lovelace", "local\tuser.email ada@vault.test"));
    expect(badge("Name")).toBe("Global Git config");
    expect(badge("Email")).toBe("This vault");
  });

  it("says that an edit to an inherited value stays in this vault", async () => {
    await render(new FakeGit("global\tuser.name Ada Lovelace"));
    expect(detail("Name")).toBe("An edit here is written for this vault only.");
  });

  /**
   * The badge is in the row's own description, not in an element of the
   * section's own. Positioned by hand it landed beside the field in Obsidian
   * 1.13 and squeezed the input into a corner; in the description the
   * framework puts it under the name in every version.
   */
  it("puts it in the row description rather than beside the field", async () => {
    await render(new FakeGit("global\tuser.name Ada Lovelace"));
    const desc = row("Name")?.settingEl.querySelector(".setting-item-description");
    expect(desc?.querySelector(".gs-badge")).not.toBeNull();
    expect(desc?.textContent).toContain("Author name on every commit.");
  });

  it("marks a value set for the vault as the exception it is", async () => {
    await render(new FakeGit("local\tuser.name Vault Name"));
    expect(badgeTone("Name")).toBe("gs-badge-accent");
  });

  it("says what a vault value is standing in front of", async () => {
    await render(new FakeGit("global\tuser.name Ada Lovelace", "local\tuser.name Vault Name"));
    expect(detail("Name")).toContain("Overrides your global Git config (Ada Lovelace)");
  });

  it("warns where nothing is set, and says what git will do instead", async () => {
    await render(new FakeGit());
    expect(badge("Name")).toBe("Not set");
    expect(badgeTone("Name")).toBe("gs-badge-warning");
    expect(detail("Name")).toMatch(/refuse to commit or invent/i);
  });

  /** A row painted before git answered would show "Not set" for a name that
      is perfectly well set, on every visit to the settings. */
  it("says nothing about the origin until git has answered", () => {
    renderIdentityGroup(container, new GitIdentitySection(new FakeGit()));
    expect(row("Name")?.settingEl.querySelector(".gs-badge")).toBeNull();
  });

  it("repaints rather than stacking a second description", async () => {
    const git = new FakeGit("global\tuser.name Ada Lovelace");
    await render(git);
    expect(row("Name")?.settingEl.querySelectorAll(".setting-item-description")).toHaveLength(1);
    expect(row("Name")?.settingEl.querySelectorAll(".gs-badge")).toHaveLength(1);
  });
});

describe("opening the settings again", () => {
  /**
   * The rows are rebuilt on every visit, but Obsidian keeps the definitions
   * that describe them. A section that read git only once would show whatever
   * it said the first time — including after the identity was changed from a
   * terminal, which is exactly where people change it.
   */
  it("reads git again rather than showing what it said last time", async () => {
    const git = new FakeGit("global\tuser.name Ada Lovelace");
    const section = new GitIdentitySection(git);

    renderIdentityGroup(container, section);
    await flush();
    expect(input("Name").value).toBe("Ada Lovelace");

    await git.setIdentity("name", "Changed Elsewhere");
    resetSettings();
    container = activeDocument.createElement("div");

    renderIdentityGroup(container, section);
    await flush();
    expect(input("Name").value).toBe("Changed Elsewhere");
  });
});

describe("where an edit goes", () => {
  it("writes to this vault, whatever the value was inherited from", async () => {
    const git = new FakeGit("global\tuser.name Ada Lovelace");
    await render(git);

    input("Name").setValue("Vault Name");
    blur("Name");
    await flush();

    expect(git.written).toEqual([["name", "Vault Name"]]);
    expect(badge("Name")).toBe("This vault");
    expect(detail("Name")).toContain("Overrides your global Git config (Ada Lovelace)");
  });

  /**
   * Without a repository there is no config to write into. The rows say so
   * rather than accepting an edit that cannot land, and creating the
   * repository is offered where it belongs, in the panel.
   */
  it("takes no edit where the vault is no repository", async () => {
    const git = new FakeGit();
    git.isRepoAnswer = false;
    await render(git);

    expect(badge("Name")).toBe("No repository");
    expect(detail("Name")).toMatch(/not a Git repository/i);
    expect(input("Name").disabled).toBe(true);
    expect(input("Email").disabled).toBe(true);
  });
});

describe("when it writes", () => {
  it("writes on leaving the field, not on every keystroke", async () => {
    const git = new FakeGit();
    await render(git);

    input("Name").emit("A");
    input("Name").emit("Ad");
    input("Name").emit("Ada");
    expect(git.written).toEqual([]);

    blur("Name");
    await flush();
    expect(git.written).toEqual([["name", "Ada"]]);
  });

  it("writes nothing when the field was not changed", async () => {
    const git = new FakeGit("local\tuser.name Ada Lovelace");
    await render(git);
    blur("Name");
    await flush();
    expect(git.written).toEqual([]);
  });

  it("repaints from git afterwards, so the row shows what git will use", async () => {
    const git = new FakeGit("local\tuser.name Vault Name");
    await render(git);

    input("Email").setValue("ada@example.com");
    blur("Email");
    await flush();

    expect(badge("Email")).toBe("This vault");
    // Writing the email left the name exactly where it was.
    expect(badge("Name")).toBe("This vault");
  });

  /** Git stores whatever it is handed, so this is the only place it is caught. */
  it("refuses an address that is a typo, and puts the field back", async () => {
    const git = new FakeGit("local\tuser.email ada@example.com");
    await render(git);

    input("Email").setValue("ada at example.com");
    blur("Email");
    await flush();

    expect(git.written).toEqual([]);
    expect(input("Email").value).toBe("ada@example.com");
    expect(Notice.messages.join(" ")).toMatch(/spaces/i);
  });

  it("takes an emptied field as a removal", async () => {
    const git = new FakeGit("local\tuser.name Vault Name");
    await render(git);

    input("Name").setValue("");
    blur("Name");
    await flush();

    expect(git.written).toEqual([["name", ""]]);
  });
});

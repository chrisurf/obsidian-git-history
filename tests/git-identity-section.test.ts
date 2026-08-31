import { describe, it, expect, beforeEach } from "vitest";
import { Notice, settings, resetSettings } from "./mocks/obsidian";
import type { DropdownComponent, TextComponent } from "./mocks/obsidian";
import { renderIdentityGroup } from "../src/settings";
import { GitIdentitySection } from "../src/components/git-identity-section";
import { parseIdentity } from "../src/git/git-identity";
import type { GitIdentity, WritableScope } from "../src/git/git-identity";

/**
 * The identity rows are the one place in the settings where what is shown does
 * not come from the plugin's own storage but from `git config`, and where an
 * edit runs a command. What is checked here is the part that would otherwise
 * be invisible: that the row says where its value comes from, that an edit
 * goes to the config that value lives in, and that nothing is written until
 * there is a reason to write it.
 */

/**
 * git config as a set of scoped entries, which is what it is. Writing to one
 * scope leaves the others alone, so a global value written while the vault
 * sets its own stays overridden here the way it would in a repository.
 */
const PRECEDENCE = ["system", "global", "local"];

class FakeGit {
  written: [string, string, WritableScope][] = [];
  isRepoAnswer = true;
  private lines: string[];

  constructor(...lines: string[]) {
    this.lines = [...lines];
  }

  identity(): Promise<GitIdentity> {
    return Promise.resolve(parseIdentity(this.lines.join("\n")));
  }

  setIdentity(field: "name" | "email", value: string, scope: WritableScope): Promise<void> {
    this.written.push([field, value, scope]);
    this.lines = this.lines.filter((l) => l !== `${scope}\tuser.${field} ${valueOf(l, field)}`);
    if (value !== "") this.lines.push(`${scope}\tuser.${field} ${value}`);
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
const origin = (name: string): string =>
  row(name)?.settingEl.querySelector(".gs-identity-origin")?.textContent ?? "";

const blur = (name: string): void => {
  input(name).inputEl.dispatchEvent(new Event("blur"));
};

beforeEach(() => {
  resetSettings();
  Notice.messages.length = 0;
  container = activeDocument.createElement("div");
});

describe("what the rows show", () => {
  it("draws a heading and the three rows", async () => {
    await render(new FakeGit());
    expect(settings.filter((s) => s.heading).map((s) => s.name)).toEqual(["Identity"]);
    expect(settings.filter((s) => !s.heading).map((s) => s.name)).toEqual([
      "Name",
      "Email",
      "Save changes to",
    ]);
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
    expect(origin("Name")).toBe("From your global Git config");
    expect(origin("Email")).toBe("Set for this vault");
  });

  it("says what a vault value is standing in front of", async () => {
    await render(new FakeGit("global\tuser.name Ada Lovelace", "local\tuser.name Vault Name"));
    expect(origin("Name")).toContain("overriding your global Git config (Ada Lovelace)");
  });

  it("warns where nothing is set, and says what git will do instead", async () => {
    await render(new FakeGit());
    expect(origin("Name")).toMatch(/refuse to commit or invent/i);
    expect(
      row("Name")
        ?.settingEl.querySelector(".gs-identity-origin")
        ?.classList.contains("gs-identity-origin-missing"),
    ).toBe(true);
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

    await git.setIdentity("name", "Changed Elsewhere", "global");
    resetSettings();
    container = activeDocument.createElement("div");

    renderIdentityGroup(container, section);
    await flush();
    expect(input("Name").value).toBe("Changed Elsewhere");
  });
});

describe("where an edit goes", () => {
  it("starts on the config the current value lives in", async () => {
    await render(new FakeGit("global\tuser.name Ada Lovelace"));
    expect((row("Save changes to")?.control<string>() as DropdownComponent).value).toBe("global");
  });

  it("starts on the vault when there is nothing to inherit", async () => {
    await render(new FakeGit());
    expect((row("Save changes to")?.control<string>() as DropdownComponent).value).toBe("local");
  });

  it("offers only the global config where the vault is no repository", async () => {
    const git = new FakeGit();
    git.isRepoAnswer = false;
    await render(git);

    const dropdown = row("Save changes to")?.control<string>() as DropdownComponent;
    expect(Object.keys(dropdown.options)).toEqual(["global"]);
    expect(dropdown.value).toBe("global");
    expect(row("Save changes to")?.desc).toMatch(/not a Git repository/i);
  });

  it("writes to the scope that is selected", async () => {
    const git = new FakeGit("global\tuser.name Ada Lovelace");
    await render(git);

    (row("Save changes to")?.control<string>() as DropdownComponent).emit("local");
    input("Name").setValue("Vault Name");
    blur("Name");
    await flush();

    expect(git.written).toEqual([["name", "Vault Name", "local"]]);
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
    expect(git.written).toEqual([["name", "Ada", "local"]]);
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
    (row("Save changes to")?.control<string>() as DropdownComponent).emit("global");
    blur("Email");
    await flush();

    expect(origin("Email")).toBe("From your global Git config");
    // The name is set for the vault, so writing the email globally leaves it
    // exactly where it was.
    expect(origin("Name")).toBe("Set for this vault");
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

    expect(git.written).toEqual([["name", "", "local"]]);
  });
});

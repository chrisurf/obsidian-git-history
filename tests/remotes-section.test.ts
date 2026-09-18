import { describe, it, expect, beforeEach } from "vitest";
import { Notice, settings, resetSettings } from "./mocks/obsidian";
import type { TextComponent } from "./mocks/obsidian";
import { renderRemoteGroup } from "../src/settings";
import { RemotesSection } from "../src/components/remotes-section";
import type { RemoteInfo } from "../src/types";

/**
 * The remote rows, which the settings had nothing of before: a vault could be
 * pushed and pulled, and where to was configured on a command line or not at
 * all. What is checked here is what a user would notice — that the address git
 * holds is the one on screen, that an edit reaches git, that a typo does not,
 * and that adding the first remote works from the settings alone.
 */

class FakeGit {
  added: [string, string][] = [];
  urls: [string, string][] = [];
  removed: string[] = [];
  isRepoAnswer = true;
  reads = 0;
  /** Set to make git fail the way a locked or broken repository does. */
  failWith: string | null = null;

  constructor(private list: RemoteInfo[] = []) {}

  remotes(): Promise<RemoteInfo[]> {
    this.reads++;
    return Promise.resolve(this.list.map((r) => ({ ...r })));
  }

  addRemote(name: string, url: string): Promise<void> {
    this.added.push([name, url]);
    this.list.push({ name, fetchUrl: url, pushUrl: url });
    return Promise.resolve();
  }

  setRemoteUrl(name: string, url: string): Promise<void> {
    if (this.failWith) return Promise.reject(new Error(this.failWith));
    this.urls.push([name, url]);
    this.list = this.list.map((r) => (r.name === name ? { name, fetchUrl: url, pushUrl: url } : r));
    return Promise.resolve();
  }

  removeRemote(name: string): Promise<void> {
    if (this.failWith) return Promise.reject(new Error(this.failWith));
    this.removed.push(name);
    this.list = this.list.filter((r) => r.name !== name);
    return Promise.resolve();
  }

  isRepo(): Promise<boolean> {
    return Promise.resolve(this.isRepoAnswer);
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let container: HTMLElement;
/** Every redraw the section asked for, so a draw loop would show up as a count. */
let redraws: number;
/** What the add dialog was offered, instead of opening a modal in a test. */
let prompts: { taken: string[]; save: (name: string, url: string) => Promise<void> }[];

function mount(git: FakeGit): RemotesSection {
  const section = new RemotesSection({
    git,
    refresh: () => {
      redraws++;
      resetSettings();
      container = activeDocument.createElement("div");
      renderRemoteGroup(container, section);
    },
    prompt: (taken, save) => prompts.push({ taken, save }),
  });
  renderRemoteGroup(container, section);
  return section;
}

const row = (name: string) => settings.find((s) => s.name === name);
const field = (name: string): TextComponent => row(name)?.control<string>() as TextComponent;
const descriptions = (): string[] => settings.map((s) => s.desc).filter(Boolean);

const type = (name: string, value: string): void => {
  const input = field(name);
  input.setValue(value);
  input.inputEl.dispatchEvent(new Event("blur"));
};

beforeEach(() => {
  resetSettings();
  Notice.messages.length = 0;
  container = activeDocument.createElement("div");
  redraws = 0;
  prompts = [];
});

describe("what the rows show", () => {
  it("lists every remote git knows, with its address in the field", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
      { name: "backup", fetchUrl: "/Volumes/backup/vault.git", pushUrl: "" },
    ]);
    mount(git);
    await flush();

    expect(settings.filter((s) => s.heading).map((s) => s.name)).toEqual(["Remote repository"]);
    expect(field("origin").value).toBe("https://github.com/you/vault.git");
    expect(field("backup").value).toBe("/Volumes/backup/vault.git");
  });

  it("says which host a remote points at, so the URL need not be read", async () => {
    mount(new FakeGit([{ name: "origin", fetchUrl: "git@gitlab.com:you/vault.git", pushUrl: "" }]));
    await flush();
    expect(row("origin")?.desc).toContain("you/vault");
    expect(row("origin")?.settingEl.querySelector(".gs-badge")?.textContent).toBe("GitLab");
    // `origin` is the one push and pull use without being told to.
    expect(row("origin")?.desc).toContain("Push and pull use this remote.");
  });

  /** A vault with no remote gave no hint that one was missing, which is how
      people found out at the first push. */
  it("explains what is missing when there is no remote", async () => {
    mount(new FakeGit());
    await flush();
    expect(descriptions().join(" ")).toMatch(/No remote yet/i);
  });

  it("does not offer to add one where the vault is no repository", async () => {
    const git = new FakeGit();
    git.isRepoAnswer = false;
    mount(git);
    await flush();

    expect(descriptions().join(" ")).toMatch(/not a Git repository/i);
    expect(settings.flatMap((s) => s.buttons())).toHaveLength(0);
  });
});

describe("editing an address", () => {
  it("writes it to git on leaving the field", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/old.git", pushUrl: "" },
    ]);
    mount(git);
    await flush();

    type("origin", "https://github.com/you/vault.git");
    await flush();

    expect(git.urls).toEqual([["origin", "https://github.com/you/vault.git"]]);
    expect(field("origin").value).toBe("https://github.com/you/vault.git");
  });

  it("writes nothing when the field was not changed", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
    ]);
    mount(git);
    await flush();

    field("origin").inputEl.dispatchEvent(new Event("blur"));
    await flush();
    expect(git.urls).toEqual([]);
  });

  /** git stores whatever it is handed and fails at the first fetch, by which
      time the connection to the typo is gone. */
  it("refuses a typo, says why, and puts the address back", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
    ]);
    mount(git);
    await flush();

    type("origin", "my repo on github");
    await flush();

    expect(git.urls).toEqual([]);
    expect(field("origin").value).toBe("https://github.com/you/vault.git");
    expect(Notice.messages.join(" ")).toMatch(/spaces/i);
  });

  it("puts the address back when git refuses the write", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
    ]);
    git.failWith = "could not lock config file";
    mount(git);
    await flush();

    type("origin", "https://github.com/you/other.git");
    await flush();

    expect(field("origin").value).toBe("https://github.com/you/vault.git");
    expect(Notice.messages.join(" ")).toMatch(/could not lock config file/i);
  });
});

describe("adding and removing", () => {
  it("adds what the dialog comes back with, and shows it", async () => {
    const git = new FakeGit();
    const section = mount(git);
    await flush();

    section.add();
    expect(prompts).toHaveLength(1);
    await prompts[0].save("origin", "https://github.com/you/vault.git");
    await flush();

    expect(git.added).toEqual([["origin", "https://github.com/you/vault.git"]]);
    expect(field("origin").value).toBe("https://github.com/you/vault.git");
  });

  it("tells the dialog which names are taken", async () => {
    const section = mount(
      new FakeGit([{ name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" }]),
    );
    await flush();

    section.add();
    expect(prompts[0].taken).toEqual(["origin"]);
  });

  it("removes one, and says that no commits went with it", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
    ]);
    const section = mount(git);
    await flush();

    await section.remove("origin");
    await flush();

    expect(git.removed).toEqual(["origin"]);
    expect(Notice.messages.join(" ")).toMatch(/No commits were deleted/i);
    expect(descriptions().join(" ")).toMatch(/No remote yet/i);
  });

  it("removes the remote the row belongs to, from its own button", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
      { name: "backup", fetchUrl: "/Volumes/backup/vault.git", pushUrl: "" },
    ]);
    mount(git);
    await flush();

    row("backup")?.extraButtons[0].click();
    await flush();
    expect(git.removed).toEqual(["backup"]);
  });
});

/**
 * The list is read from git, and a read that always redrew would redraw
 * forever: the redraw is what starts the next read. So a read that says the
 * same thing as the screen must draw nothing.
 */
describe("reading git", () => {
  it("draws again when the remotes changed, and stops there", async () => {
    const git = new FakeGit([
      { name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" },
    ]);
    mount(git);
    await flush();

    expect(redraws).toBe(1);
    expect(git.reads).toBeLessThanOrEqual(3);
  });

  it("does not draw again when nothing changed", async () => {
    const section = mount(new FakeGit());
    await flush();
    const drawn = redraws;

    section.sync();
    await flush();
    expect(redraws).toBe(drawn);
  });

  it("shows a remote added from a terminal the next time it reads", async () => {
    const git = new FakeGit();
    const section = mount(git);
    await flush();
    expect(descriptions().join(" ")).toMatch(/No remote yet/i);

    git.list.push({ name: "origin", fetchUrl: "https://github.com/you/vault.git", pushUrl: "" });
    section.sync();
    await flush();

    expect(field("origin").value).toBe("https://github.com/you/vault.git");
  });

  it("survives a git that cannot answer", async () => {
    const git = new FakeGit();
    git.remotes = (): Promise<RemoteInfo[]> => Promise.reject(new Error("not a repository"));
    mount(git);
    await flush();

    expect(descriptions().join(" ")).toMatch(/No remote yet|not a Git repository/i);
  });
});

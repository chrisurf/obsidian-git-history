import { describe, it, expect } from "vitest";
import {
  describeRemote,
  parseRemoteUrl,
  remoteHostLabel,
  remoteNameProblem,
  remoteUrlProblem,
  suggestedRemoteName,
} from "../src/git/git-remote";

/**
 * A remote is a URL nobody remembers the shape of, in two spellings that look
 * nothing alike — `https://github.com/you/vault.git` and
 * `git@github.com:you/vault.git`. The settings have to read both, say which
 * host and repository they point at, and refuse the addresses git stores
 * happily and then fails on at the first fetch.
 */

describe("reading an address", () => {
  it("reads the https form", () => {
    expect(parseRemoteUrl("https://github.com/you/vault.git")).toEqual({
      host: "github.com",
      path: "you/vault",
    });
  });

  it("reads the git@ form every host puts on its clone button", () => {
    expect(parseRemoteUrl("git@gitlab.com:group/sub/vault.git")).toEqual({
      host: "gitlab.com",
      path: "group/sub/vault",
    });
  });

  it("drops a port and a user name from the host", () => {
    expect(parseRemoteUrl("ssh://git@git.example.com:2222/notes/vault.git")?.host).toBe(
      "git.example.com",
    );
  });

  it("takes a local path as the remote it is", () => {
    expect(parseRemoteUrl("/Volumes/backup/vault.git")).toEqual({
      host: "",
      path: "Volumes/backup/vault",
    });
  });

  /** `C:/notes` has a colon without being a host, and used to be read as one. */
  it("does not mistake a Windows drive letter for a host", () => {
    expect(parseRemoteUrl("C:/notes/vault.git")?.host).toBe("");
  });

  it("has nothing to say about an empty address", () => {
    expect(parseRemoteUrl("   ")).toBeNull();
  });
});

describe("naming the host", () => {
  it("names the hosts people know by name", () => {
    expect(remoteHostLabel("https://github.com/you/vault.git")).toBe("GitHub");
    expect(remoteHostLabel("git@gitlab.com:you/vault.git")).toBe("GitLab");
    expect(remoteHostLabel("git@codeberg.org:you/vault.git")).toBe("Codeberg");
  });

  it("recognises a self-hosted one and still shows the domain", () => {
    expect(remoteHostLabel("https://gitlab.acme.internal/you/vault.git")).toBe(
      "GitLab (gitlab.acme.internal)",
    );
  });

  it("falls back to the bare domain", () => {
    expect(remoteHostLabel("https://git.example.com/you/vault.git")).toBe("git.example.com");
  });

  it("says a folder on this computer is one, rather than naming a server", () => {
    expect(remoteHostLabel("/Volumes/backup/vault.git")).toBe("Local folder");
    expect(remoteHostLabel("")).toBe("No address");
  });
});

describe("describing a remote in one line", () => {
  /** The host is the badge beside this line, not part of it. */
  it("names the repository, which is what tells two remotes apart", () => {
    expect(
      describeRemote({
        name: "origin",
        fetchUrl: "https://github.com/you/vault.git",
        pushUrl: "https://github.com/you/vault.git",
      }),
    ).toBe("you/vault");
  });

  /**
   * A remote that fetches from one address and pushes to another is rare and
   * deliberate. A row showing only the first would be wrong in the way that
   * costs someone an afternoon.
   */
  it("says so when it pushes somewhere else", () => {
    expect(
      describeRemote({
        name: "origin",
        fetchUrl: "https://github.com/you/vault.git",
        pushUrl: "git@github.com:you/vault.git",
      }),
    ).toContain("pushes to git@github.com:you/vault.git");
  });

  it("says there is no address rather than showing an empty line", () => {
    expect(describeRemote({ name: "origin", fetchUrl: "", pushUrl: "" })).toBe("No address");
  });
});

describe("refusing an address git would take and then fail on", () => {
  it("accepts the forms git really takes", () => {
    for (const url of [
      "https://github.com/you/vault.git",
      "http://git.example.com/you/vault",
      "git@github.com:you/vault.git",
      "ssh://git@github.com/you/vault.git",
      "/Volumes/backup/vault.git",
      "~/backups/vault.git",
    ]) {
      expect(remoteUrlProblem(url), url).toBeNull();
    }
  });

  it("refuses an empty field", () => {
    expect(remoteUrlProblem("   ")).toMatch(/required/i);
  });

  it("refuses a pasted sentence", () => {
    expect(remoteUrlProblem("my repo on github")).toMatch(/spaces/i);
    expect(remoteUrlProblem("github.com")).toMatch(/does not look like a Git address/i);
  });

  it("refuses a host with no repository on it", () => {
    expect(remoteUrlProblem("https://github.com")).toMatch(/no repository/i);
  });
});

describe("naming a remote", () => {
  it("refuses a name git cannot use, and one that is taken", () => {
    expect(remoteNameProblem("", [])).toMatch(/required/i);
    expect(remoteNameProblem("my remote", [])).toMatch(/letters, digits/i);
    expect(remoteNameProblem("-origin", [])).toMatch(/cannot start/i);
    expect(remoteNameProblem("origin", ["origin"])).toMatch(/already a remote/i);
    expect(remoteNameProblem("upstream", ["origin"])).toBeNull();
  });

  it("offers the name git itself would use, until it is taken", () => {
    expect(suggestedRemoteName([])).toBe("origin");
    expect(suggestedRemoteName(["origin"])).toBe("origin-2");
    expect(suggestedRemoteName(["origin", "origin-2"])).toBe("origin-3");
  });
});

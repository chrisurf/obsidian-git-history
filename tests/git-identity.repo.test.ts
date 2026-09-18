// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "../src/git/git-service";
import { isComplete, isMissingIdentityError } from "../src/git/git-identity";
import type { GitCommandEnvironment } from "../src/utils/exec-env";

/**
 * The identity commands against a real git, which is the only thing that can
 * confirm the part that matters: that a value set for the vault wins over one
 * inherited from the user's own config, and that the plugin sees the same
 * answer git would use.
 *
 * `GIT_CONFIG_GLOBAL` puts the "global" config in the test's own directory and
 * `GIT_CONFIG_NOSYSTEM` takes the machine's out of the picture. Without both,
 * a test for writing a global name would write into whoever is running it.
 */

const repos: string[] = [];

let repo: string;
let globalConfig: string;
let git: GitService;

function environment(): GitCommandEnvironment {
  return {
    git: () => Promise.resolve({ binary: { path: "git", source: "path" }, tried: ["git"] }),
    env: (extra = {}) =>
      Promise.resolve({
        ...process.env,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        ...extra,
      }),
  };
}

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "git-identity-test-"));
  repos.push(root);
  repo = root;
  globalConfig = join(root, "fake-global-config");
  execFileSync("git", ["init", "-q", "-b", "main", "."], { cwd: repo });
  git = new GitService(repo, environment());
});

afterAll(() => {
  for (const dir of repos) rmSync(dir, { recursive: true, force: true });
});

/** Writes the user's own config directly: the plugin cannot, on purpose, and
    the inherited value is what a vault-local one has to win over. */
const setGlobal = (key: string, value: string): void => {
  execFileSync("git", ["config", "--global", key, value], {
    cwd: repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
  });
};

const globalFile = (): string => {
  try {
    return readFileSync(globalConfig, "utf8");
  } catch {
    return "";
  }
};

describe("reading the identity out of a real repository", () => {
  it("reports nothing when nothing anywhere sets one", async () => {
    const identity = await git.identity();
    expect(identity.name.value).toBe("");
    expect(identity.email.value).toBe("");
    expect(isComplete(identity)).toBe(false);
  });

  it("reads what the user's own config sets, and says where from", async () => {
    setGlobal("user.name", "Ada Lovelace");
    setGlobal("user.email", "ada@example.com");

    const identity = await git.identity();
    expect(identity.name).toEqual({ value: "Ada Lovelace", scope: "global", shadowed: null });
    expect(identity.email.scope).toBe("global");
    expect(isComplete(identity)).toBe(true);
  });

  /** The whole reason the scope is read at all. */
  it("lets a value set for the vault override the inherited one", async () => {
    setGlobal("user.name", "Ada Lovelace");
    await git.setIdentity("name", "Vault Name");

    const identity = await git.identity();
    expect(identity.name.value).toBe("Vault Name");
    expect(identity.name.scope).toBe("local");
    expect(identity.name.shadowed).toEqual({ value: "Ada Lovelace", scope: "global" });
  });

  it("agrees with the name git would actually put on a commit", async () => {
    setGlobal("user.name", "Ada Lovelace");
    await git.setIdentity("name", "Vault Name");

    const effective = execFileSync("git", ["config", "--get", "user.name"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
    expect(effective).toBe((await git.identity()).name.value);
  });
});

describe("writing it", () => {
  it("writes to the vault without touching the user's own config", async () => {
    await git.setIdentity("name", "Vault Name");
    expect(globalFile()).not.toContain("Vault Name");
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toContain("Vault Name");
  });

  /**
   * The vault is the only place it writes. A settings screen about these notes
   * has no business changing the name every other repository on the computer
   * commits under, so there is no longer a way to ask it to.
   */
  it("leaves the user's own config alone even where it is the one in use", async () => {
    setGlobal("user.email", "ada@example.com");
    await git.setIdentity("email", "vault@example.com");

    expect(globalFile()).toContain("ada@example.com");
    expect(globalFile()).not.toContain("vault@example.com");
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).toContain("vault@example.com");
  });

  /**
   * An empty field removes the entry. Storing "" instead would leave a value
   * git accepts and then refuses to commit with, which is the same problem
   * with one more place to look for it.
   */
  it("removes a vault value rather than storing an empty one, uncovering the inherited one", async () => {
    setGlobal("user.name", "Ada Lovelace");
    await git.setIdentity("name", "Vault Name");
    await git.setIdentity("name", "");

    const identity = await git.identity();
    expect(identity.name.value).toBe("Ada Lovelace");
    expect(identity.name.scope).toBe("global");
    expect(readFileSync(join(repo, ".git", "config"), "utf8")).not.toContain("name =");
  });

  it("says nothing when asked to remove what was never there", async () => {
    await expect(git.setIdentity("email", "")).resolves.toBeUndefined();
  });

  it("stores a value without the whitespace around it", async () => {
    await git.setIdentity("name", "  Ada Lovelace  ");
    expect((await git.identity()).name.value).toBe("Ada Lovelace");
  });
});

/**
 * What git does with no identity at all, which is not one thing.
 *
 * On one machine it refuses — "Please tell me who you are" — and on another it
 * reads a user name and a hostname off the system, invents
 * `someone@their-laptop.local`, and commits with that. Both were seen on macOS
 * while this was written, and which one a user gets is a property of their
 * machine.
 *
 * So the plugin handles both: the prompt on load is what covers the silent
 * case, where every commit is quietly attributed to an address no forge can
 * match; the failed commit is what covers the loud one. This test pins the
 * pair down rather than picking the behaviour of whichever machine runs it.
 */
describe("what git does with no identity", () => {
  const commit = (): { ok: boolean; message: string } => {
    try {
      execFileSync("git", ["commit", "--allow-empty", "-m", "no identity"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { ok: true, message: "" };
    } catch (e: unknown) {
      return { ok: false, message: (e as { stderr?: string }).stderr ?? "" };
    }
  };

  it("either refuses in a way the plugin recognises, or invents an identity", async () => {
    const result = commit();

    if (!result.ok) {
      expect(isMissingIdentityError(result.message)).toBe(true);
      return;
    }

    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
    }).trim();
    // Invented, and invisible: nothing asked, nothing warned, and the commit
    // carries an address that belongs to no account anywhere.
    expect(author).toContain("@");
    expect((await git.identity()).name.value).toBe("");
  });

  /** The refusal, forced, so its wording stays under test on every machine. */
  it("is recognised whatever the machine would have done", () => {
    let message = "";
    try {
      execFileSync("git", ["-c", "user.useConfigOnly=true", "commit", "--allow-empty", "-m", "x"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      message = (e as { stderr?: string }).stderr ?? "";
    }

    expect(message).not.toBe("");
    expect(isMissingIdentityError(message)).toBe(true);
  });
});

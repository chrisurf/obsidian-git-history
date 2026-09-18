// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  NO_IDENTITY,
  originOf,
  describeField,
  emailProblem,
  isComplete,
  isMissingIdentityError,
  nameProblem,
  parseIdentity,
} from "../src/git/git-identity";

const scoped = (...lines: string[]): string => lines.join("\n") + "\n";

describe("reading what git says", () => {
  it("takes the value and the file it came from", () => {
    const identity = parseIdentity(
      scoped("global\tuser.name Ada Lovelace", "global\tuser.email ada@example.com"),
    );
    expect(identity.name).toEqual({ value: "Ada Lovelace", scope: "global", shadowed: null });
    expect(identity.email.value).toBe("ada@example.com");
  });

  /**
   * git lists every scope that sets a key, in the order they override each
   * other. The last one is what a commit would actually carry, and the one
   * before it is what the settings need in order to say so.
   */
  it("lets the vault's own value win, and remembers what it displaced", () => {
    const identity = parseIdentity(
      scoped(
        "global\tuser.name Ada Lovelace",
        "global\tuser.email ada@example.com",
        "local\tuser.name Vault Name",
      ),
    );
    expect(identity.name.value).toBe("Vault Name");
    expect(identity.name.scope).toBe("local");
    expect(identity.name.shadowed).toEqual({ value: "Ada Lovelace", scope: "global" });
    expect(identity.email.scope).toBe("global");
  });

  it("reports nothing at all as nothing set, not as an empty name", () => {
    expect(parseIdentity("")).toEqual(NO_IDENTITY);
    expect(isComplete(parseIdentity(""))).toBe(false);
  });

  it("counts one half as incomplete", () => {
    expect(isComplete(parseIdentity(scoped("global\tuser.name Ada Lovelace")))).toBe(false);
  });

  /** A git older than 2.26 has no --show-scope, and prints the keys alone. */
  it("still reads the values when git cannot name the scope", () => {
    const identity = parseIdentity(scoped("user.name Ada Lovelace", "user.email ada@example.com"));
    expect(identity.name.value).toBe("Ada Lovelace");
    expect(identity.name.scope).toBeNull();
    expect(isComplete(identity)).toBe(true);
  });

  it("keeps a value's own spaces, since they are what a commit would carry", () => {
    expect(parseIdentity(scoped("local\tuser.name  Ada  Lovelace ")).name.value).toBe(
      " Ada  Lovelace ",
    );
  });

  it("ignores keys it was not asking about", () => {
    expect(parseIdentity(scoped("local\tuser.signingkey ABC123"))).toEqual(NO_IDENTITY);
  });
});

describe("what a field says about itself", () => {
  it("names the config a value lives in", () => {
    const identity = parseIdentity(scoped("global\tuser.name Ada Lovelace"));
    expect(describeField(identity.name)).toBe("From your global Git config");
  });

  it("says what a vault-local value is standing in front of", () => {
    const identity = parseIdentity(
      scoped("global\tuser.name Ada Lovelace", "local\tuser.name Vault Name"),
    );
    expect(describeField(identity.name)).toBe(
      "Set for this vault, overriding your global Git config (Ada Lovelace)",
    );
  });

  /**
   * Neither "Git will refuse to commit" nor "Git will invent one": which of
   * the two a machine does depends on whether git can read a user name and a
   * hostname off it, and both were seen while this was being written. The line
   * says both rather than promising the one the author's laptop happened to do.
   */
  it("says what happens when nothing is set, without promising which", () => {
    const detail = describeField(NO_IDENTITY.name) ?? "";
    expect(detail).toMatch(/not set/i);
    expect(detail).toMatch(/refuse/i);
    expect(detail).toMatch(/invent/i);
  });

  it("has nothing to say about a value whose origin git did not name", () => {
    expect(describeField(parseIdentity(scoped("user.name Ada")).name)).toBeNull();
  });
});

/**
 * What a row says about a value, in the two pieces it shows it in: a badge the
 * eye finds, and the sentence behind it. An edit is written for this vault
 * alone, so an inherited value has to say that before it is typed over.
 */
describe("what a row says about where a value comes from", () => {
  const field = (...lines: string[]) => parseIdentity(scoped(...lines)).name;

  it("marks a value set for this vault as the exception it is", () => {
    expect(originOf(field("local\tuser.name Ada"))).toEqual({
      label: "This vault",
      tone: "accent",
      detail: null,
    });
  });

  it("says what an edit will do to an inherited value", () => {
    const origin = originOf(field("global\tuser.name Ada"));
    expect(origin.label).toBe("Global Git config");
    expect(origin.tone).toBe("neutral");
    expect(origin.detail).toBe("An edit here is written for this vault only.");
  });

  it("names what a vault value is standing in front of", () => {
    expect(originOf(field("global\tuser.name Ada", "local\tuser.name Vault")).detail).toBe(
      "Overrides your global Git config (Ada).",
    );
  });

  it("warns where nothing is set, and says what git will do instead", () => {
    const origin = originOf(NO_IDENTITY.name);
    expect(origin.label).toBe("Not set");
    expect(origin.tone).toBe("warning");
    expect(origin.detail).toMatch(/refuse to commit or invent/i);
  });
});

/**
 * Git stores whatever it is handed. An address with a space in it is accepted,
 * written onto every commit, and rejected by the remote much later.
 */
describe("checking what is about to be written", () => {
  it("takes an ordinary address", () => {
    expect(emailProblem("ada@example.com")).toBeNull();
    expect(emailProblem("  ada@example.com  ")).toBeNull();
  });

  it("refuses the shapes that are typos", () => {
    expect(emailProblem("")).toMatch(/required/i);
    expect(emailProblem("ada example.com")).toMatch(/spaces/i);
    expect(emailProblem("ada.example.com")).toMatch(/@/);
    expect(emailProblem("ada@@example.com")).toMatch(/@/);
    expect(emailProblem("@example.com")).toMatch(/@/);
    expect(emailProblem("ada@localhost")).toMatch(/dot/i);
  });

  it("wants a name that is more than whitespace", () => {
    expect(nameProblem("Ada")).toBeNull();
    expect(nameProblem("   ")).toMatch(/required/i);
  });
});

describe("recognising the failure that has an answer", () => {
  it("knows git's way of saying it does not know who you are", () => {
    expect(
      isMissingIdentityError(
        "Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: unable to " +
          "auto-detect email address (got 'ada@host.(none)')",
      ),
    ).toBe(true);
    expect(isMissingIdentityError("fatal: empty ident name (for <ada@host>) not allowed")).toBe(
      true,
    );
  });

  it("leaves every other failure to be reported as itself", () => {
    expect(isMissingIdentityError("error: pathspec 'main' did not match any file(s)")).toBe(false);
    expect(isMissingIdentityError("nothing to commit, working tree clean")).toBe(false);
  });
});

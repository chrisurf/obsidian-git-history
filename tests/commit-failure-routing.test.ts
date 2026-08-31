// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

/**
 * Every path that writes a commit has to route its failure through
 * `reportGitFailure`.
 *
 * This is the gap the identity feature was built to close and the one it is
 * easiest to reopen: a new command that commits, with a `catch` of its own
 * showing git's message in a notice, works perfectly on a machine that has an
 * identity and is a dead end on the machine that does not — which is the
 * machine this exists for. Nothing at runtime notices, because the code is
 * correct; it just leads nowhere.
 *
 * The check is textual, so it proves the handler is there rather than that it
 * is reached. That is enough for the failure it guards, which is a call site
 * added without one at all.
 */

const src = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

interface CommitSite {
  file: string;
  line: number;
  following: string;
}

function commitSites(): CommitSite[] {
  const sites: CommitSite[] = [];
  for (const file of sourceFiles(src)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, index) => {
      // The call itself, not the service that defines it.
      if (!/\bgit\.commit\(/.test(text)) return;
      sites.push({
        file: file.slice(src.length + 1),
        line: index + 1,
        following: lines.slice(index, index + 30).join("\n"),
      });
    });
  }
  return sites;
}

describe("committing without an identity", () => {
  const sites = commitSites();

  it("has commit call sites to check at all", () => {
    // A rename that made the check vacuous would otherwise pass in silence.
    expect(sites.length).toBeGreaterThan(0);
  });

  it("sends every one of their failures somewhere that can answer", () => {
    const unrouted = sites
      .filter((site) => !site.following.includes("reportGitFailure"))
      .map((site) => `${site.file}:${site.line}`);
    expect(unrouted).toEqual([]);
  });

  /**
   * git's own advice is four lines about `git config --global` in a notice
   * that disappears. Showing it is what made the plugin unusable on a vault
   * whose git had no identity.
   */
  it("does not put git's own message in a notice instead", () => {
    const raw = sites
      .filter((site) => /new Notice\(`\$\{?\w*\}? ?failed/.test(site.following))
      .map((site) => `${site.file}:${site.line}`);
    expect(raw).toEqual([]);
  });
});

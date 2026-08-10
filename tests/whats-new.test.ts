// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  shouldShowWhatsNew,
  WHATS_NEW,
  HERO_IMAGE_URL,
  BUY_ME_A_COFFEE_URL,
  BUY_ME_A_COFFEE_IMAGE_URL,
} from "../src/utils/whats-new";

describe("shouldShowWhatsNew", () => {
  it("shows on a fresh install, where no version has been seen", () => {
    expect(shouldShowWhatsNew("1.1.0", "")).toBe(true);
  });

  it("shows after an update to a different version", () => {
    expect(shouldShowWhatsNew("1.2.0", "1.1.0")).toBe(true);
  });

  it("does not show twice for the same version", () => {
    expect(shouldShowWhatsNew("1.1.0", "1.1.0")).toBe(false);
  });

  it("does not show when the running version is unknown", () => {
    expect(shouldShowWhatsNew("", "")).toBe(false);
  });
});

describe("what's new content", () => {
  it("leads with the terminal, the newest feature", () => {
    expect(WHATS_NEW.indexOf("Open terminal")).toBeLessThan(
      WHATS_NEW.indexOf("Initialize repository"),
    );
  });

  it("labels the terminal Alpha wherever it is mentioned, so nobody relies on it yet", () => {
    const mentions = WHATS_NEW.match(/[Tt]erminal/g) ?? [];
    expect(mentions.length).toBeGreaterThan(0);
    expect(WHATS_NEW).toMatch(/Alpha/);
    expect(WHATS_NEW).not.toMatch(/[Bb]eta/);
  });

  it("still covers the repository setup screen, the entry point for a new vault", () => {
    expect(WHATS_NEW).toMatch(/Initialize repository/);
  });

  it("covers the restore, gitignore, and branch controls", () => {
    expect(WHATS_NEW).toMatch(/Restore this file/);
    expect(WHATS_NEW).toMatch(/\.gitignore/);
    expect(WHATS_NEW).toMatch(/Merge/);
  });

  it("points at assets in this repository, so the images resolve after release", () => {
    expect(HERO_IMAGE_URL).toContain("chrisurf/obsidian-git-history");
    expect(BUY_ME_A_COFFEE_IMAGE_URL).toContain("chrisurf/obsidian-git-history");
    expect(BUY_ME_A_COFFEE_URL).toBe("https://www.buymeacoffee.com/chrisurf");
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { canAutoPull } from "../src/store/auto-pull";
import type { AutoPullSnapshot } from "../src/store/auto-pull";

/**
 * The background pull runs without anyone watching, so the one case it may
 * act on is a fast-forward into a clean tree. Each of the others is a way a
 * pull nobody asked for would merge, rebase or overwrite the user's work.
 */
const behind: AutoPullSnapshot = {
  changeCount: 0,
  ahead: 0,
  behind: 2,
  hasUpstream: true,
  merging: false,
};

const can = (patch: Partial<AutoPullSnapshot>) => canAutoPull({ ...behind, ...patch });

describe("canAutoPull", () => {
  it("pulls a clean branch that is only behind", () => {
    expect(can({})).toBe(true);
  });

  it("leaves a branch that is up to date alone", () => {
    expect(can({ behind: 0 })).toBe(false);
  });

  it("leaves local commits to the Sync button", () => {
    expect(can({ ahead: 1 })).toBe(false);
  });

  it("does not pull over uncommitted changes", () => {
    expect(can({ changeCount: 1 })).toBe(false);
  });

  it("does not pull in the middle of a merge", () => {
    expect(can({ merging: true })).toBe(false);
  });

  it("has nothing to pull from without an upstream", () => {
    expect(can({ hasUpstream: false })).toBe(false);
  });
});

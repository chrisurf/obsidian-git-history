// @vitest-environment node
import { describe, it, expect } from "vitest";
import { commitButtonState } from "../src/store/commit-action";
import type { RepoSnapshot } from "../src/store/commit-action";

/**
 * A clean tree with commits waiting on the remote used to leave a fully lit
 * Commit button whose only answer was "No changes to commit". These are the
 * combinations that decide what it says instead — none of which shows up by
 * clicking through the panel once.
 */
const clean: RepoSnapshot = {
  hasMessage: false,
  changeCount: 0,
  ahead: 0,
  behind: 0,
  hasUpstream: true,
  hasCommits: true,
  merging: false,
};

const state = (patch: Partial<RepoSnapshot>) => commitButtonState({ ...clean, ...patch });

describe("commitButtonState — with changes in the tree", () => {
  it("commits once a message is there", () => {
    const s = state({ changeCount: 3, hasMessage: true });
    expect(s.action).toBe("commit");
    expect(s.enabled).toBe(true);
    expect(s.label).toBe("Commit");
  });

  it("stays disabled without a message", () => {
    const s = state({ changeCount: 3 });
    expect(s.action).toBe("commit");
    expect(s.enabled).toBe(false);
    expect(s.tooltip).toMatch(/message/i);
  });

  it("refuses to commit while a merge is unresolved", () => {
    const s = state({ changeCount: 3, hasMessage: true, merging: true });
    expect(s.enabled).toBe(false);
    expect(s.tooltip).toMatch(/conflict/i);
  });

  it("keeps committing ahead of pushing while work is uncommitted", () => {
    // Pushing first would leave the uncommitted work behind.
    const s = state({ changeCount: 1, hasMessage: true, ahead: 4 });
    expect(s.action).toBe("commit");
  });

  it("counts the files it would commit", () => {
    expect(state({ changeCount: 1, hasMessage: true }).tooltip).toBe("Commit 1 file");
    expect(state({ changeCount: 2, hasMessage: true }).tooltip).toBe("Commit 2 files");
  });
});

describe("commitButtonState — with a clean tree", () => {
  it("offers a push for commits the remote has not seen", () => {
    const s = state({ ahead: 3 });
    expect(s.action).toBe("push");
    expect(s.enabled).toBe(true);
    expect(s.label).toBe("Push (3)");
    expect(s.icon).toBe("upload");
  });

  it("offers to publish a branch that has no upstream yet", () => {
    const s = state({ hasUpstream: false });
    expect(s.action).toBe("publish");
    expect(s.enabled).toBe(true);
    expect(s.label).toBe("Publish branch");
  });

  it("offers nothing in a repository without a single commit", () => {
    const s = state({ hasUpstream: false, hasCommits: false });
    expect(s.action).toBe("none");
    expect(s.enabled).toBe(false);
  });

  it("syncs when the branch is both ahead and behind", () => {
    // A plain push is rejected in this state, so the pull has to come first.
    const s = state({ ahead: 2, behind: 1 });
    expect(s.action).toBe("sync");
    expect(s.enabled).toBe(true);
    expect(s.label).toBe("Sync (1↓ 2↑)");
  });

  it("greys out when there is nothing to commit and nothing to push", () => {
    const s = state({});
    expect(s.action).toBe("none");
    expect(s.enabled).toBe(false);
    expect(s.label).toBe("Commit");
    expect(s.icon).toBe("check");
  });

  it("says why it is idle when the branch is only behind", () => {
    const s = state({ behind: 2 });
    expect(s.action).toBe("none");
    expect(s.enabled).toBe(false);
    expect(s.tooltip).toMatch(/pull/i);
  });

  it("does not push a branch that has no upstream to push to", () => {
    // ahead is always 0 without an upstream; publishing is the way out.
    const s = state({ hasUpstream: false, ahead: 0 });
    expect(s.action).toBe("publish");
  });

  it("ignores a typed message when there is nothing to commit", () => {
    const s = state({ hasMessage: true, ahead: 2 });
    expect(s.action).toBe("push");
  });
});

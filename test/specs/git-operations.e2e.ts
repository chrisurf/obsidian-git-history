import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

describe("Git operations", function () {
  it("should detect the test vault as a git repository", async function () {
    const isRepo = await browser.executeObsidian(async ({ plugins }) => {
      return await plugins.gitHistory.git.isRepo();
    });
    expect(isRepo).toBe(true);
  });

  it("should report the current branch", async function () {
    const branch = await browser.executeObsidian(async ({ plugins }) => {
      return await plugins.gitHistory.git.currentBranch();
    });
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
  });

  it("should return commit log", async function () {
    const commits = await browser.executeObsidian(async ({ plugins }) => {
      const log = await plugins.gitHistory.git.log(10);
      return log.map((c: { hash: string; message: string }) => ({
        hash: c.hash,
        message: c.message,
      }));
    });

    expect(commits.length).toBeGreaterThan(0);
    expect(commits[0].message).toBe("initial test vault commit");
  });

  it("should detect file changes in the vault", async function () {
    await obsidianPage.write("test-file.md", "# Test\n\nNew content");

    await browser.pause(2000);

    const status = await browser.executeObsidian(async ({ plugins }) => {
      const files = await plugins.gitHistory.git.status();
      return files.map((f: { path: string; staged: boolean }) => ({
        path: f.path,
        staged: f.staged,
      }));
    });

    const testFile = status.find((f: { path: string }) => f.path === "test-file.md");
    expect(testFile).toBeDefined();
  });

  it("should stage and commit a file", async function () {
    await browser.executeObsidian(async ({ plugins }) => {
      await plugins.gitHistory.git.stage("test-file.md");
      await plugins.gitHistory.git.commit("test: add test file");
    });

    const commits = await browser.executeObsidian(async ({ plugins }) => {
      const log = await plugins.gitHistory.git.log(5);
      return log.map((c: { message: string }) => c.message);
    });

    expect(commits).toContain("test: add test file");
  });

  it("should show diff for modified files", async function () {
    await obsidianPage.write("test-file.md", "# Test\n\nModified content");
    await browser.pause(1000);

    const diff = await browser.executeObsidian(async ({ plugins }) => {
      const result = await plugins.gitHistory.git.diff("test-file.md");
      return {
        path: result.path,
        hasHunks: result.hunks.length > 0,
        additions: result.additions,
        deletions: result.deletions,
      };
    });

    expect(diff.path).toBe("test-file.md");
    expect(diff.hasHunks).toBe(true);
    expect(diff.additions).toBeGreaterThan(0);
  });
});

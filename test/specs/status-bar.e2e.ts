import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

describe("Status bar", function () {
  it("should display the branch name", async function () {
    const statusBar = browser.$(".status-bar .git-status-bar");
    await expect(statusBar).toExist();
  });

  it("should show the current branch indicator", async function () {
    const branchEl = browser.$(".status-bar .git-status-branch");
    await expect(branchEl).toExist();
    const text = await branchEl.getText();
    expect(text.length).toBeGreaterThan(0);
  });
});

import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

describe("Status bar", function () {
  it("should display the status bar element", async function () {
    const statusBar = browser.$(".status-bar .git-history-statusbar");
    await expect(statusBar).toExist();
  });

  it("should show the current branch name", async function () {
    const branchEl = browser.$(".status-bar .git-sb-branch");
    await expect(branchEl).toExist();
    const text = await branchEl.getText();
    expect(text.length).toBeGreaterThan(0);
  });
});

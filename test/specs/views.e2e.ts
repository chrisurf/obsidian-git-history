import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

describe("Source Control view", function () {
  it("should open via command", async function () {
    await browser.executeObsidianCommand("git-history:open-source-control");
    await browser.pause(1000);

    const viewEl = browser.$('[data-type="git-history-source-control"]');
    await expect(viewEl).toExist();
  });

  it("should show the Changes tab", async function () {
    const changesTab = browser.$(".git-source-control .git-sc-tab");
    await expect(changesTab).toExist();
  });
});

describe("Graph view", function () {
  it("should open via command", async function () {
    await browser.executeObsidianCommand("git-history:open-graph");
    await browser.pause(1000);

    const viewEl = browser.$('[data-type="git-history-graph"]');
    await expect(viewEl).toExist();
  });

  it("should render the graph container", async function () {
    const graphContainer = browser.$(".git-graph-container");
    await expect(graphContainer).toExist();
  });

  it("should display at least one commit row", async function () {
    const commitRow = browser.$(".git-graph-row");
    await expect(commitRow).toExist();
  });
});

describe("History view", function () {
  it("should open via command", async function () {
    await browser.executeObsidianCommand("git-history:open-history");
    await browser.pause(1000);

    const viewEl = browser.$('[data-type="git-history-history"]');
    await expect(viewEl).toExist();
  });

  it("should display commit entries", async function () {
    const commitEntry = browser.$(".git-history-commit");
    await expect(commitEntry).toExist();
  });
});

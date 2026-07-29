import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

describe("Plugin loading", function () {
  it("should load the git-history plugin", async function () {
    const pluginLoaded = await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plugins = (app as any).plugins;
      return plugins?.enabledPlugins?.has("git-history") ?? false;
    });
    expect(pluginLoaded).toBe(true);
  });

  it("should register all view types", async function () {
    const viewTypes = await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const registry = (app as any).viewRegistry?.viewByType ?? {};
      return {
        sourceControl: "git-history-source-control" in registry,
        graph: "git-history-graph" in registry,
        diff: "git-history-diff" in registry,
      };
    });
    expect(viewTypes.sourceControl).toBe(true);
    expect(viewTypes.graph).toBe(true);
    expect(viewTypes.diff).toBe(true);
  });

  it("should register all commands", async function () {
    const commands = await browser.executeObsidian(({ app }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cmds = (app as any).commands?.commands ?? {};
      const ids = [
        "git-history:open-source-control",
        "git-history:open-graph",
        "git-history:commit",
        "git-history:push",
        "git-history:pull",
        "git-history:fetch",
        "git-history:backup",
        "git-history:init-repo",
        "git-history:show-file-history",
      ];
      return ids.map((id) => ({ id, registered: id in cmds }));
    });

    for (const cmd of commands) {
      expect(cmd.registered).toBe(true);
    }
  });

  it("should display the ribbon icon", async function () {
    const ribbon = browser.$('.side-dock-ribbon-action[aria-label="Git history"]');
    await expect(ribbon).toExist();
  });
});

import { browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";

describe("Plugin settings", function () {
  it("should have default settings loaded", async function () {
    const settings = await browser.executeObsidian(({ plugins }) => {
      const plugin = plugins.gitHistory;
      return {
        pullStrategy: plugin.settings.pullStrategy,
        diffViewMode: plugin.settings.diffViewMode,
        autoFetchEnabled: plugin.settings.autoFetchEnabled,
        autoFetchInterval: plugin.settings.autoFetchInterval,
        debounceMs: plugin.settings.debounceMs,
      };
    });

    expect(settings.pullStrategy).toBe("merge");
    expect(settings.diffViewMode).toBe("side-by-side");
    expect(settings.autoFetchEnabled).toBe(false);
    expect(settings.autoFetchInterval).toBe(300);
    expect(settings.debounceMs).toBe(1000);
  });

  it("should persist setting changes", async function () {
    await browser.executeObsidian(async ({ plugins }) => {
      const plugin = plugins.gitHistory;
      plugin.settings.pullStrategy = "rebase";
      await plugin.saveSettings();
    });

    const updated = await browser.executeObsidian(({ plugins }) => {
      return plugins.gitHistory.settings.pullStrategy;
    });
    expect(updated).toBe("rebase");

    await browser.executeObsidian(async ({ plugins }) => {
      const plugin = plugins.gitHistory;
      plugin.settings.pullStrategy = "merge";
      await plugin.saveSettings();
    });
  });
});

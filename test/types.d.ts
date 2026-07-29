import type GitHistoryPlugin from "../src/main";

declare module "wdio-obsidian-service" {
  interface InstalledPlugins {
    gitHistory: GitHistoryPlugin;
  }
}

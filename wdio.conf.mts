import * as path from "path";
import { env } from "process";

const cacheDir = path.resolve(".obsidian-cache");

export const config: WebdriverIO.Config = {
  runner: "local",
  framework: "mocha",

  specs: ["./test/specs/**/*.e2e.ts"],
  maxInstances: Number(env.WDIO_MAX_INSTANCES || 4),

  capabilities: [
    {
      browserName: "obsidian",
      "wdio:obsidianOptions": {
        appVersion: "latest",
        installerVersion: "latest",
        plugins: ["."],
        vault: "test/vaults/test-repo",
      },
    },
  ],

  services: ["obsidian"],
  reporters: ["obsidian"],

  mochaOpts: {
    ui: "bdd",
    timeout: 60 * 1000,
  },

  waitforInterval: 250,
  waitforTimeout: 10 * 1000,
  logLevel: "warn",
  cacheDir: cacheDir,
  injectGlobals: false,
};

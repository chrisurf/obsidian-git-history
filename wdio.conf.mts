import * as path from "path";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { env } from "process";

const cacheDir = path.resolve(".obsidian-cache");
const testVault = path.resolve("test/vaults/test-repo");

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

  onPrepare() {
    if (!existsSync(path.join(testVault, ".git"))) {
      execSync(
        [
          "git init",
          "git config user.email 'test@test.local'",
          "git config user.name 'Test'",
          "git add .",
          "git commit -m 'initial test vault commit'",
        ].join(" && "),
        { cwd: testVault, stdio: "pipe" },
      );
    }
  },
};

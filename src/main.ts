import * as fs from "fs";
import {
  Plugin,
  WorkspaceLeaf,
  Notice,
  PluginSettingTab,
  App,
  normalizePath,
  Setting,
  type SettingDefinitionItem,
} from "obsidian";
import {
  SOURCE_CONTROL_VIEW_TYPE,
  GRAPH_VIEW_TYPE,
  DIFF_VIEW_TYPE,
  GitHistorySettings,
  DEFAULT_SETTINGS,
  CommitInfo,
} from "./types";
import { GitService } from "./git/git-service";
import { RepoStore } from "./store/repo-store";
import { SourceControlView } from "./views/source-control-view";
import { GraphView } from "./views/graph-view";
import { DiffView } from "./views/diff-view";
import { StatusBarController } from "./components/status-bar";
import { asVoid } from "./utils/async";

/** View type of the removed history panel, kept only to clean up old workspaces. */
const LEGACY_HISTORY_VIEW_TYPE = "git-history-history";

export default class GitHistoryPlugin extends Plugin {
  settings: GitHistorySettings = DEFAULT_SETTINGS;
  git!: GitService;
  store!: RepoStore;
  private statusBar: StatusBarController | null = null;
  private refreshTimer: number | null = null;
  private debounceTimer: number | null = null;
  private fsDebounceTimer: number | null = null;
  private fsWatcher: fs.FSWatcher | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.git = new GitService(this.vaultPath());
    this.store = new RepoStore(this.git);
    this.store.showNestedRepos = this.settings.showNestedRepos;

    const isRepo = await this.git.isRepo();
    if (!isRepo) {
      new Notice(
        "Git history: This vault is not a Git repository. Use the init command to create one.",
      );
    }

    this.registerView(SOURCE_CONTROL_VIEW_TYPE, (leaf) => new SourceControlView(leaf, this));
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));
    this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this));

    // The standalone history panel was replaced by the Graph tab. A workspace
    // saved by an older version still restores its leaf, which would now open
    // as an empty pane nobody can close from inside the plugin.
    this.app.workspace.detachLeavesOfType(LEGACY_HISTORY_VIEW_TYPE);

    this.addRibbonIcon("git-branch", "Git history", () => {
      void this.openSourceControlView();
    });

    this.registerCommands();

    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusBarEl, this);

    this.addSettingTab(new GitHistorySettingTab(this.app, this));

    if (isRepo) {
      await this.store.refresh();
      this.setupAutoRefresh();
      this.setupFileWatcher();
    }
  }

  private registerCommands(): void {
    this.addCommand({
      id: "open-source-control",
      name: "Open source control",
      callback: () => this.openSourceControlView(),
    });

    this.addCommand({
      id: "open-graph",
      name: "Open Git graph",
      callback: () => this.openGraphView(),
    });

    this.addCommand({
      id: "commit",
      name: "Commit",
      callback: () => this.openSourceControlView(),
    });

    this.addCommand({
      id: "push",
      name: "Push",
      callback: async () => {
        try {
          await this.store.runTask("Pushing", () =>
            this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch }),
          );
          await this.store.refresh();
          new Notice("Pushed successfully");
        } catch (e: unknown) {
          new Notice(`Push failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "pull",
      name: "Pull",
      callback: async () => {
        try {
          await this.store.runTask("Pulling", () =>
            this.git.pull({ strategy: this.settings.pullStrategy }),
          );
          await this.store.refresh();
          new Notice("Pulled successfully");
        } catch (e: unknown) {
          new Notice(`Pull failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "fetch",
      name: "Fetch",
      callback: async () => {
        try {
          await this.store.runTask("Fetching", () => this.git.fetch());
          await this.store.refresh();
          new Notice("Fetched");
        } catch (e: unknown) {
          new Notice(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "backup",
      name: "Backup: Stage all, commit & push",
      callback: async () => {
        try {
          await this.store.runTask("Backing up", async () => {
            await this.git.stageAll();
            const msg =
              this.settings.commitTemplate ||
              `vault backup ${new Date().toISOString().split("T")[0]}`;
            await this.git.commit(msg);
            await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch });
          });
          await this.store.refresh();
          new Notice("Backup complete");
        } catch (e: unknown) {
          new Notice(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "show-file-history",
      name: "Show file history",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        void this.openFileHistory(file.path);
      },
    });

    this.addCommand({
      id: "init-repo",
      name: "Initialize Git repository",
      callback: async () => {
        try {
          await this.git.init();
          await this.store.refresh();
          new Notice("Git repository initialized");
        } catch (e: unknown) {
          new Notice(`Init failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
  }

  async openSourceControlView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: true });
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  async showCommitChangesInSidebar(commit: CommitInfo): Promise<void> {
    let leaf: WorkspaceLeaf | undefined;
    const existing = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getRightLeaf(false) ?? undefined;
      if (leaf) {
        await leaf.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: true });
      }
    }
    if (leaf) {
      void this.app.workspace.revealLeaf(leaf);
      const view = leaf.view as SourceControlView;
      view.showCommitChanges(commit);
    }
  }

  async openGraphView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(GRAPH_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    if (leaf) {
      await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  /** Opens the graph narrowed to one file — the history of that note. */
  async openFileHistory(path: string): Promise<void> {
    await this.openGraphView();
    const leaf = this.app.workspace.getLeavesOfType(GRAPH_VIEW_TYPE)[0];
    if (leaf) (leaf.view as GraphView).setPathFilter(path);
  }

  async openDiff(path: string, ref?: string, staged = false): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    if (leaf) {
      await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
      const view = leaf.view as DiffView;
      view.setFile(path, ref, staged);
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  private setupAutoRefresh(): void {
    if (this.settings.autoFetchEnabled && this.settings.autoFetchInterval > 0) {
      this.refreshTimer = window.setInterval(
        asVoid(async () => {
          try {
            await this.git.fetch();
            await this.store.refresh();
          } catch {
            // silent fail for auto-fetch
          }
        }),
        this.settings.autoFetchInterval * 1000,
      );
    }
  }

  /** Absolute path of the vault, which git needs as its working directory. */
  private vaultPath(): string {
    const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
    return adapter.getBasePath?.() ?? adapter.basePath ?? "";
  }

  private setupFileWatcher(): void {
    this.registerEvent(this.app.vault.on("modify", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRefresh()));

    // Obsidian's events cover the notes, but not its own config files —
    // appearance.json and workspace.json change constantly and show up as
    // changes in the panel. Watching just the config folder keeps the panel
    // honest without walking the whole vault.
    const basePath = this.vaultPath();
    if (basePath) {
      const configPath = normalizePath(`${basePath}/${this.app.vault.configDir}`);
      try {
        this.fsWatcher = fs.watch(configPath, { recursive: true }, () => {
          if (this.fsDebounceTimer) window.clearTimeout(this.fsDebounceTimer);
          this.fsDebounceTimer = window.setTimeout(() => {
            void this.store.refresh();
          }, 2000);
        });
      } catch {
        // Recursive watching is not available on every platform; the panel
        // still refreshes on window focus and from the toolbar.
      }
    }
  }

  private debouncedRefresh(): void {
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      void this.store.refresh();
    }, this.settings.debounceMs);
  }

  async loadSettings(): Promise<void> {
    const saved = (await this.loadData()) as Partial<GitHistorySettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    if (this.fsDebounceTimer) window.clearTimeout(this.fsDebounceTimer);
    if (this.fsWatcher) {
      this.fsWatcher.close();
      this.fsWatcher = null;
    }
    this.statusBar?.destroy();
  }
}

class GitHistorySettingTab extends PluginSettingTab {
  plugin: GitHistoryPlugin;

  constructor(app: App, plugin: GitHistoryPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Obsidian 1.13+ renders and searches settings from these definitions.
   * display() below stays for older versions, which ignore this method — the
   * two lists are kept in step by hand, which is the price of supporting both.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        name: "Commit message template",
        desc: "Default commit message. Use {{date}} for the current date.",
        control: {
          type: "text",
          key: "commitTemplate",
          placeholder: "vault backup {{date}}",
        },
      },
      {
        name: "Pull strategy",
        control: {
          type: "dropdown",
          key: "pullStrategy",
          options: { merge: "Merge", rebase: "Rebase", "ff-only": "Fast-forward only" },
        },
      },
      {
        name: "Default diff view",
        control: {
          type: "dropdown",
          key: "diffViewMode",
          options: { "side-by-side": "Side by side", inline: "Inline" },
        },
      },
      {
        name: "Auto-fetch",
        desc: "Automatically fetch from remotes.",
        control: { type: "toggle", key: "autoFetchEnabled" },
      },
      {
        name: "Auto-fetch interval",
        desc: "Seconds between automatic fetches.",
        control: { type: "number", key: "autoFetchInterval", min: 30 },
      },
      {
        name: "Show nested repositories",
        desc:
          "Folders inside the vault that are Git repositories of their own cannot be staged, " +
          "so they are hidden from the changes list. Turn this on to list them anyway.",
        control: { type: "toggle", key: "showNestedRepos" },
      },
      {
        name: "File watcher debounce",
        desc: "Milliseconds to wait before refreshing status after file changes.",
        control: { type: "number", key: "debounceMs", min: 100 },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return this.plugin.settings[key as keyof GitHistorySettings];
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: value });
    if (key === "showNestedRepos") {
      this.plugin.store.showNestedRepos = Boolean(value);
    }
    await this.plugin.saveSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc("Default commit message. Use {{date}} for current date.")
      .addText((text) =>
        text
          .setPlaceholder("vault backup {{date}}")
          .setValue(this.plugin.settings.commitTemplate)
          .onChange(async (v) => {
            this.plugin.settings.commitTemplate = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl).setName("Pull strategy").addDropdown((dd) =>
      dd
        .addOptions({ merge: "Merge", rebase: "Rebase", "ff-only": "Fast-forward only" })
        .setValue(this.plugin.settings.pullStrategy)
        .onChange(async (v) => {
          this.plugin.settings.pullStrategy = v as "merge" | "rebase" | "ff-only";
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl).setName("Default diff view").addDropdown((dd) =>
      dd
        .addOptions({ "side-by-side": "Side-by-Side", inline: "Inline" })
        .setValue(this.plugin.settings.diffViewMode)
        .onChange(async (v) => {
          this.plugin.settings.diffViewMode = v as "side-by-side" | "inline";
          await this.plugin.saveSettings();
        }),
    );

    new Setting(containerEl)
      .setName("Auto-fetch")
      .setDesc("Automatically fetch from remotes.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.autoFetchEnabled).onChange(async (v) => {
          this.plugin.settings.autoFetchEnabled = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName("Auto-fetch interval (seconds)").addText((text) =>
      text.setValue(String(this.plugin.settings.autoFetchInterval)).onChange(async (v) => {
        const n = parseInt(v);
        if (!isNaN(n) && n >= 30) {
          this.plugin.settings.autoFetchInterval = n;
          await this.plugin.saveSettings();
        }
      }),
    );

    new Setting(containerEl)
      .setName("Show nested repositories")
      .setDesc(
        "Folders inside the vault that are Git repositories of their own cannot be staged, " +
          "so they are hidden from the changes list. Turn this on to list them anyway.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showNestedRepos).onChange(async (v) => {
          this.plugin.settings.showNestedRepos = v;
          this.plugin.store.showNestedRepos = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("File watcher debounce (ms)")
      .setDesc("Delay before refreshing status after file changes.")
      .addText((text) =>
        text.setValue(String(this.plugin.settings.debounceMs)).onChange(async (v) => {
          const n = parseInt(v);
          if (!isNaN(n) && n >= 100) {
            this.plugin.settings.debounceMs = n;
            await this.plugin.saveSettings();
          }
        }),
      );
  }
}

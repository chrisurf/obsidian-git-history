import * as fs from "fs";
import { Plugin, WorkspaceLeaf, Notice, PluginSettingTab, App, Setting } from "obsidian";
import {
  SOURCE_CONTROL_VIEW_TYPE,
  HISTORY_VIEW_TYPE,
  GRAPH_VIEW_TYPE,
  DIFF_VIEW_TYPE,
  GitHistorySettings,
  DEFAULT_SETTINGS,
  CommitInfo,
} from "./types";
import { GitService } from "./git/git-service";
import { RepoStore } from "./store/repo-store";
import { SourceControlView } from "./views/source-control-view";
import { HistoryView } from "./views/history-view";
import { GraphView } from "./views/graph-view";
import { DiffView } from "./views/diff-view";
import { StatusBarController } from "./components/status-bar";

export default class GitHistoryPlugin extends Plugin {
  settings: GitHistorySettings = DEFAULT_SETTINGS;
  git!: GitService;
  store!: RepoStore;
  private statusBar: StatusBarController | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fsDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private fsWatcher: fs.FSWatcher | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
    const basePath = adapter.getBasePath?.() ?? adapter.basePath ?? "";
    this.git = new GitService(basePath);
    this.store = new RepoStore(this.git);
    this.store.showNestedRepos = this.settings.showNestedRepos;

    const isRepo = await this.git.isRepo();
    if (!isRepo) {
      new Notice(
        "Git History: This vault is not a Git repository. Use the init command to create one.",
      );
    }

    this.registerView(SOURCE_CONTROL_VIEW_TYPE, (leaf) => new SourceControlView(leaf, this));
    this.registerView(HISTORY_VIEW_TYPE, (leaf) => new HistoryView(leaf, this));
    this.registerView(GRAPH_VIEW_TYPE, (leaf) => new GraphView(leaf, this));
    this.registerView(DIFF_VIEW_TYPE, (leaf) => new DiffView(leaf, this));

    this.addRibbonIcon("git-branch", "Git History", () => {
      this.openSourceControlView();
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
      name: "Open Source Control",
      callback: () => this.openSourceControlView(),
    });

    this.addCommand({
      id: "open-history",
      name: "Open History",
      callback: () => this.openHistoryView(),
    });

    this.addCommand({
      id: "open-graph",
      name: "Open Git Graph",
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
          await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch });
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
          await this.git.pull({ strategy: this.settings.pullStrategy });
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
          await this.git.fetch();
          await this.store.refresh();
          new Notice("Fetched");
        } catch (e: unknown) {
          new Notice(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "backup",
      name: "Backup: Stage All, Commit & Push",
      callback: async () => {
        try {
          await this.git.stageAll();
          const msg =
            this.settings.commitTemplate ||
            `vault backup ${new Date().toISOString().split("T")[0]}`;
          await this.git.commit(msg);
          await this.git.push({ setUpstream: true, remote: "origin", branch: this.store.branch });
          await this.store.refresh();
          new Notice("Backup complete");
        } catch (e: unknown) {
          new Notice(`Backup failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "init-repo",
      name: "Initialize Git Repository",
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

    this.addCommand({
      id: "show-file-history",
      name: "Show File History",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        this.openFileHistory(file.path);
      },
    });
  }

  async openSourceControlView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SOURCE_CONTROL_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
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
      this.app.workspace.revealLeaf(leaf);
      const view = leaf.view as SourceControlView;
      view.showCommitChanges(commit);
    }
  }

  async openHistoryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async openGraphView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(GRAPH_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    if (leaf) {
      await leaf.setViewState({ type: GRAPH_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async openDiff(path: string, ref?: string, staged = false): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    if (leaf) {
      await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
      const view = leaf.view as DiffView;
      view.setFile(path, ref, staged);
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async openFileHistory(path: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(HISTORY_VIEW_TYPE);
    let leaf: WorkspaceLeaf;
    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = this.app.workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: HISTORY_VIEW_TYPE, active: true });
    }
    const view = leaf.view as HistoryView;
    view.setFilterPath(path);
    this.app.workspace.revealLeaf(leaf);
  }

  private setupAutoRefresh(): void {
    if (this.settings.autoFetchEnabled && this.settings.autoFetchInterval > 0) {
      this.refreshTimer = setInterval(async () => {
        try {
          await this.git.fetch();
          await this.store.refresh();
        } catch {
          // silent fail for auto-fetch
        }
      }, this.settings.autoFetchInterval * 1000);
    }
  }

  private setupFileWatcher(): void {
    this.registerEvent(this.app.vault.on("modify", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRefresh()));

    const adapter = this.app.vault.adapter as { basePath?: string; getBasePath?: () => string };
    const basePath = adapter.getBasePath?.() ?? adapter.basePath ?? "";
    if (basePath) {
      try {
        this.fsWatcher = fs.watch(basePath, { recursive: true }, (_event, filename) => {
          if (typeof filename === "string" && filename.startsWith(".git")) return;
          if (this.fsDebounceTimer) clearTimeout(this.fsDebounceTimer);
          this.fsDebounceTimer = setTimeout(() => this.store.refresh(), 2000);
        });
      } catch {
        // fs.watch may not support recursive on all platforms
      }
    }
  }

  private debouncedRefresh(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.store.refresh();
    }, this.settings.debounceMs);
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  onunload(): void {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.fsDebounceTimer) clearTimeout(this.fsDebounceTimer);
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

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Git History Settings" });

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

import { Plugin, WorkspaceLeaf, Notice, Platform } from "obsidian";
import {
  SOURCE_CONTROL_VIEW_TYPE,
  GRAPH_VIEW_TYPE,
  DIFF_VIEW_TYPE,
  TERMINAL_VIEW_TYPE,
  GitHistorySettings,
  DEFAULT_SETTINGS,
  CommitInfo,
  FileListMode,
} from "./types";
import { GitService } from "./git/git-service";
import { RepoStore } from "./store/repo-store";
import { SourceControlView } from "./views/source-control-view";
import { GraphView } from "./views/graph-view";
import { DiffView } from "./views/diff-view";
import { TerminalView } from "./views/terminal-view";
import { TerminalSessionManager } from "./terminal/session-manager";
import { StatusBarController } from "./components/status-bar";
import { WhatsNewModal } from "./components/whats-new-modal";
import { TerminalSetupModal } from "./components/terminal-setup-modal";
import { GitIdentityModal } from "./components/git-identity-modal";
import type { IdentityPromptReason } from "./components/git-identity-modal";
import { isComplete } from "./git/git-identity";
import { GitHistorySettingTab } from "./settings";
import { asVoid } from "./utils/async";
import { ExecEnvironment } from "./utils/exec-env";
import { resolveTemplate } from "./utils/template";
import { shouldShowWhatsNew } from "./utils/whats-new";

/** View type of the removed history panel, kept only to clean up old workspaces. */
const LEGACY_HISTORY_VIEW_TYPE = "git-history-history";

export default class GitHistoryPlugin extends Plugin {
  settings: GitHistorySettings = DEFAULT_SETTINGS;
  git!: GitService;
  execEnv!: ExecEnvironment;
  store!: RepoStore;
  terminals!: TerminalSessionManager;
  private statusBar: StatusBarController | null = null;
  private refreshTimer: number | null = null;
  private debounceTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    // Built before anything can spawn a process: git and the terminal both
    // resolve what they run through it, and both used to trust a bare name.
    this.execEnv = new ExecEnvironment({
      isWindows: Platform.isWin,
      configuredGit: () => this.settings.gitPath || undefined,
      configuredPython: () => this.settings.terminalPython || undefined,
    });
    this.git = new GitService(this.vaultPath(), this.execEnv);
    this.store = new RepoStore(this.git);
    this.terminals = new TerminalSessionManager(this);
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
    this.registerView(TERMINAL_VIEW_TYPE, (leaf) => new TerminalView(leaf, this));

    // The standalone history panel was replaced by the Graph tab. A workspace
    // saved by an older version still restores its leaf, which would now open
    // as an empty pane nobody can close from inside the plugin.
    this.app.workspace.detachLeavesOfType(LEGACY_HISTORY_VIEW_TYPE);

    this.addRibbonIcon("git-branch", "Git history", () => {
      void this.openSourceControlView();
    });

    this.addRibbonIcon("terminal", "Open terminal", () => {
      void this.openTerminalView();
    });

    this.registerCommands();

    const statusBarEl = this.addStatusBarItem();
    this.statusBar = new StatusBarController(statusBarEl, this);

    this.addSettingTab(new GitHistorySettingTab(this.app, this));

    if (isRepo) {
      await this.store.refresh();
      this.setupAutoRefresh();
      this.registerRefreshTriggers();
    }

    // Once the workspace is up, surface the "what's new" note — a modal during
    // layout restore would fight with Obsidian for the screen.
    this.app.workspace.onLayoutReady(() => this.runStartupPrompts());
  }

  /**
   * The two things the plugin may want to say on launch, one after the other.
   *
   * A fresh install triggers both, and two modals opening at once means one of
   * them is behind the other with no way to know it is there.
   */
  private runStartupPrompts(): void {
    const askForIdentity = (): void => void this.maybeAskForIdentity();
    if (!this.maybeShowWhatsNew(askForIdentity)) askForIdentity();
  }

  /** Opens the "what's new" note for the installed version. */
  private showWhatsNew(onClosed: () => void = () => {}): void {
    new WhatsNewModal(
      this.app,
      this.manifest.version,
      this,
      () => void this.openSourceControlView(),
      onClosed,
    ).open();
  }

  /**
   * Shows the note once per install or update, then records the version so the
   * same one is never shown twice. Answers whether it did.
   */
  private maybeShowWhatsNew(onClosed: () => void = () => {}): boolean {
    const current = this.manifest.version;
    if (!shouldShowWhatsNew(current, this.settings.lastWhatsNewVersion)) return false;
    this.settings.lastWhatsNewVersion = current;
    void this.saveSettings();
    this.showWhatsNew(onClosed);
    return true;
  }

  /**
   * Asks for a Git identity on launch, if there is nothing to ask about.
   *
   * Only when git has neither half and the vault is a repository: someone with
   * a global name and email is already set up, and a vault that is not a
   * repository has a more basic problem the plugin already mentions. Waved
   * away once, it stays away — the failed commit is what asks after that.
   */
  private async maybeAskForIdentity(): Promise<void> {
    if (this.settings.identityPromptDismissed) return;
    if (!(await this.git.isRepo())) return;

    try {
      if (isComplete(await this.git.identity())) return;
    } catch {
      // No usable git. The panel and the setup report both say so already,
      // and an identity prompt on top of that explains nothing.
      return;
    }
    await this.promptForIdentity("startup");
  }

  /**
   * The identity prompt, wherever it is asked from: launch, the command
   * palette, or a commit that git refused to write.
   */
  async promptForIdentity(reason: IdentityPromptReason): Promise<void> {
    const [identity, canUseLocal] = await Promise.all([this.git.identity(), this.git.isRepo()]);
    new GitIdentityModal(this.app, {
      reason,
      identity,
      canUseLocal,
      onSave: async (name, email, scope) => {
        await this.git.setIdentity("name", name, scope);
        await this.git.setIdentity("email", email, scope);
        this.settings.identityPromptDismissed = false;
        await this.saveSettings();
        new Notice("Git identity saved");
      },
      onDismiss: () => {
        if (reason !== "startup") return;
        this.settings.identityPromptDismissed = true;
        void this.saveSettings();
      },
    }).open();
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
      id: "toggle-file-list-mode",
      name: "Toggle changes layout (tree/list)",
      callback: asVoid(async () => {
        await this.setFileListMode(this.settings.fileListMode === "list" ? "tree" : "list");
      }),
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
            const msg = this.settings.commitTemplate
              ? resolveTemplate(this.settings.commitTemplate)
              : `vault backup ${new Date().toISOString().split("T")[0]}`;
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
      id: "show-whats-new",
      name: "Show what's new",
      callback: () => this.showWhatsNew(),
    });

    this.addCommand({
      id: "open-terminal",
      name: "Open terminal",
      callback: () => this.openTerminalView(),
    });

    this.addCommand({
      id: "check-terminal-setup",
      name: "Check terminal setup",
      callback: () => void this.showTerminalSetup(),
    });

    this.addCommand({
      id: "new-terminal-session",
      name: "New terminal session",
      callback: () => this.newTerminalSession(),
    });

    this.addCommand({
      id: "set-git-identity",
      name: "Set Git identity",
      callback: () => void this.promptForIdentity("manual"),
    });

    this.addCommand({
      id: "init-repo",
      name: "Initialize Git repository",
      callback: async () => {
        try {
          await this.git.init();
          this.activatePostInit();
          await this.store.refresh();
          new Notice("Git repository initialized");
        } catch (e: unknown) {
          new Notice(`Init failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });
  }

  activatePostInit(): void {
    this.setupAutoRefresh();
    this.registerRefreshTriggers();
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

  async openDiff(path: string, ref?: string, staged = false, untracked = false): Promise<void> {
    const leaf = this.app.workspace.getLeaf("tab");
    if (leaf) {
      await leaf.setViewState({ type: DIFF_VIEW_TYPE, active: true });
      const view = leaf.view as DiffView;
      view.setFile(path, ref, staged, untracked);
      void this.app.workspace.revealLeaf(leaf);
    }
  }

  /**
   * Shows the terminal, opening the panel if it is not up. The ribbon icon
   * means "show me the terminal", never "start another shell" — a second
   * session is the plus button inside the panel, or newTerminalSession().
   */
  async openTerminalView(): Promise<TerminalView | null> {
    const existing = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE);
    if (existing.length > 0) {
      void this.app.workspace.revealLeaf(existing[0]);
      return existing[0].view instanceof TerminalView ? existing[0].view : null;
    }
    const activeLeaf = this.app.workspace.getMostRecentLeaf();
    if (!activeLeaf) return null;

    const newLeaf = this.app.workspace.createLeafBySplit(activeLeaf, "horizontal");
    await newLeaf.setViewState({ type: TERMINAL_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(newLeaf);
    return newLeaf.view instanceof TerminalView ? newLeaf.view : null;
  }

  /**
   * Reports what the terminal would run and why.
   *
   * The same resolution a session goes through, shown rather than acted on —
   * so working out a broken setup takes a command instead of knowing which
   * binaries on macOS are really stubs.
   */
  async showTerminalSetup(): Promise<void> {
    new TerminalSetupModal(this.app, await this.terminals.setupReport()).open();
  }

  /**
   * Opens this plugin's own settings tab. `app.setting` is not in the public
   * types, so the small part of it that is used is described here rather than
   * asserted away.
   */
  openPluginSettings(): void {
    const setting = (
      this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    setting?.open();
    setting?.openTabById(this.manifest.id);
  }

  /** Opens the panel if needed, then starts one more session in it. */
  async newTerminalSession(): Promise<void> {
    const hadPanel = this.app.workspace.getLeavesOfType(TERMINAL_VIEW_TYPE).length > 0;
    const view = await this.openTerminalView();
    // A panel that was just opened already started a session of its own.
    if (hadPanel) await view?.newSession();
  }

  private setupAutoRefresh(): void {
    if (this.settings.autoFetchEnabled && this.settings.autoFetchInterval > 0) {
      this.refreshTimer = window.setInterval(
        asVoid(async () => {
          try {
            await this.store.runTask("Auto-fetching", () => this.git.fetch());
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

  /**
   * Obsidian's own events are the only source of refreshes.
   *
   * There used to be an fs.watch on the config folder, because Obsidian does
   * not report writes to appearance.json or workspace.json and those show up
   * as changes in the panel. It cost more than it was worth: workspace.json is
   * rewritten on every layout change, so dragging a pane around scheduled a
   * `git status` two seconds later. Those changes now surface on the next
   * refresh — a note edit, window focus, any git action, or the toolbar
   * button — and the plugin no longer reaches into the filesystem at all.
   */
  private registerRefreshTriggers(): void {
    this.registerEvent(this.app.vault.on("modify", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("create", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.debouncedRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.debouncedRefresh()));
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
    // A changed git or python path has to take effect now, not after a reload:
    // the resolver caches what it found, and this is the moment that answer
    // stopped being the current one.
    this.execEnv.invalidate();
  }

  /**
   * Switches the changes list between the folder tree and the flat list. The
   * layout is a setting rather than view state so it survives a restart and so
   * every open source control panel shows the same thing.
   */
  async setFileListMode(mode: FileListMode): Promise<void> {
    if (this.settings.fileListMode === mode) return;
    this.settings.fileListMode = mode;
    await this.saveSettings();
    this.refreshFileLists();
  }

  refreshFileLists(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(SOURCE_CONTROL_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof SourceControlView) view.refreshFileList();
    }
  }

  onunload(): void {
    if (this.refreshTimer) window.clearInterval(this.refreshTimer);
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.statusBar?.destroy();
    // The only place that ends a shell without the user asking: once the plugin
    // is gone there is nothing left to reattach the sessions to.
    this.terminals?.disposeAll();
  }
}

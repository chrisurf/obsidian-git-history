<p align="center">
  <img src="docs/screenshots/hero.png" alt="Git History for Obsidian" width="100%" />
</p>

# Git History for Obsidian

A full-featured Git management plugin for [Obsidian](https://obsidian.md) that brings **VS Code / GitLens-style** source control directly into your vault.

Stage, commit, push, pull, and browse your entire commit history — without ever leaving Obsidian.

---

## Features

<p align="center">
  <img src="docs/screenshots/overview.png" alt="Git Graph and Source Control panel" width="100%" />
</p>

### Source Control Panel

- **File tree view** with colored icons by file extension
- **Stage, unstage, and discard** changes on file and folder level
- **Commit** with message input, amend, and commit & push
- **Pull, push, fetch, and stash** from the toolbar
- **Branch switching** and creation
- **Auto-refresh** on window focus and external file changes

### Commit Graph

- **GitLens-style table layout** with columns for branch/tag, graph, commit message, author, files changed, date, and SHA
- **Visual commit graph** with colored lanes and merge indicators
- **Ref pills** for branches, remotes, and tags
- **Commit detail popup** with full metadata and changed files
- **Green/red changes bar** showing additions vs deletions per commit
- **Working changes row** showing uncommitted modifications
- **Search and filter** commits by message, author, or hash

### Sidebar Compact Graph

- Quickly browse recent commits without leaving the sidebar
- Toggle between **Changes** and **Graph** tabs
- **Author avatar circles** with initials on each commit
- **Hover tooltip** with author, date, SHA, file stats, and commit message
- **Changes bar** with additions/deletions per commit
- Click a commit to expand details inline

### File History

- View the full commit history for any single file, inside the commit graph
- Follows the file across renames
- Open from the command palette or the context menu in Source Control

### Diff Viewer

- **Side-by-side** and **inline** diff modes
- Syntax-highlighted additions and deletions
- Navigate diffs from the file tree or commit history

---

## Installation

### From source

```bash
git clone https://github.com/chrisurf/obsidian-git-history.git
cd obsidian-git-history
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into your vault's `.obsidian/plugins/git-history/` directory.

### Requirements

- Obsidian 1.5.0 or later
- Git installed and available in PATH
- Desktop only (uses Node.js APIs)

---

## Commands

| Command | Description |
|---------|-------------|
| Open Source Control | Open the source control sidebar |
| Open Git Graph | Open the full commit graph |
| Commit | Open source control to commit |
| Push | Push to remote |
| Pull | Pull from remote |
| Fetch | Fetch from remote |
| Backup: Stage All, Commit & Push | One-click vault backup |
| Show File History | Show the graph filtered to the active file |
| Initialize Git Repository | Init a new repo in the vault |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Commit template | _(empty)_ | Default commit message for backups |
| Pull strategy | merge | merge, rebase, or ff-only |
| Diff view mode | side-by-side | side-by-side or inline |
| Auto-fetch | off | Periodically fetch from remote |
| Auto-fetch interval | 300s | Seconds between auto-fetches |
| Show status bar | on | Git status in the Obsidian status bar |
| Show nested repositories | off | List folders that are Git repositories of their own (they cannot be staged) |
| Debounce | 1000ms | Delay before refreshing after file changes |

---

## License

[MIT](LICENSE)

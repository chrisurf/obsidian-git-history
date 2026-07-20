# CLAUDE.md - Git History Obsidian Plugin

## Project Overview

Obsidian plugin providing full Git management: GitKraken-style commit graph, source control panel, diff viewer, and history browser. Desktop-only (requires Node.js/Electron for Git operations).

## Tech Stack

- **Runtime**: Obsidian Plugin API (desktop, Electron/Node.js)
- **Language**: TypeScript (strict mode)
- **Bundler**: esbuild (`esbuild.config.mjs`)
- **Linting**: ESLint flat config (`eslint.config.mjs`) + Prettier
- **Commits**: Conventional Commits enforced via commitlint + Husky
- **Release**: semantic-release with custom `scripts/version-bump.mjs`

## Key Commands

- `npm run build` — production build (outputs `main.js`)
- `npm run dev` — watch mode for development
- `npm run validate` — full pipeline: typecheck + lint + format:check + build
- `npm run lint` / `npm run lint:fix` — ESLint
- `npm run format` / `npm run format:check` — Prettier
- `npm run typecheck` — `tsc --noEmit`

## Architecture

```
src/
├── main.ts              # Plugin entry point, registers views and commands
├── types.ts             # Shared types and view type constants
├── settings.ts          # Plugin settings tab and defaults
├── git/
│   └── git-service.ts   # Git operations via child_process (Node.js)
├── store/
│   └── repo-store.ts    # Reactive state store (extends Events)
├── components/
│   └── status-bar.ts    # Status bar controller
├── utils/
│   └── graph-layout.ts  # Graph layout computation
└── views/
    ├── source-control-view.ts  # Main source control sidebar
    ├── graph-view.ts           # Full-page commit graph
    ├── history-view.ts         # Commit history list
    └── diff-view.ts            # Side-by-side/unified diff viewer
```

## Conventions

- **Commit messages**: Conventional Commits format (`feat:`, `fix:`, `chore:`, etc.)
- **Branch naming**: `feature/**`, `fix/**`, `chore/**`, `refactor/**`, `docs/**`, `ci/**`, `style/**`
- **No v-prefix on tags**: Obsidian community requires bare semver tags (e.g., `1.0.0`, not `v1.0.0`)
- **No npm publish**: Plugin is distributed via GitHub releases only

## Obsidian Community Plugin Requirements

- Plugin ID must not contain "obsidian" or end with "plugin"
- Description must be ≤250 characters and end with punctuation
- Use `normalizePath()` for file paths, never hardcode `.obsidian`
- Use `createEl()` / `createDiv()` instead of `innerHTML`
- Use `activeDocument` instead of `document` where possible
- Use `window.setTimeout()` instead of bare `setTimeout()`
- Avoid regex lookbehinds (mobile compatibility)
- Avoid `globalThis` mutations

## CI/CD

- **CI** (`.github/workflows/ci.yml`): Runs on feature branches and PRs to main — eslint, typecheck, prettier, build, manifest validation, commitlint
- **Release** (`.github/workflows/release.yml`): Runs on push to main — semantic-release creates GitHub release with `main.js`, `manifest.json`, `styles.css`

## Important Notes

- `skipLibCheck: true` in tsconfig.json due to Obsidian API type definition issues
- Git operations use `child_process.execFile` — only available in desktop Electron
- The store (`RepoStore`) extends Obsidian's `Events` class for reactive updates
- ESLint warnings (no-explicit-any, missing return types) are intentional — not errors

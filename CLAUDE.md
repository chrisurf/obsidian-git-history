# CLAUDE.md - Git History Obsidian Plugin

## Project Overview

Obsidian plugin for Git management: interactive commit graph, source control panel, and diff viewer. Desktop-only (requires Node.js/Electron for Git operations).

## Tech Stack

- **Runtime**: Obsidian Plugin API (desktop, Electron/Node.js)
- **Language**: TypeScript (strict mode)
- **Bundler**: esbuild (`esbuild.config.mjs`)
- **Linting**: ESLint flat config with `eslint-plugin-obsidianmd`, Stylelint, Prettier
- **Commits**: Conventional Commits enforced via commitlint + Husky
- **Release**: semantic-release with custom `scripts/version-bump.mjs`

## Key Commands

- `npm run build` — production build (outputs `main.js`)
- `npm run dev` — watch mode for development
- `npm run validate` — full pipeline: typecheck + lint + lint:css + format:check + test + build
- `npm test` / `npm run test:watch` — Vitest
- `npm run lint` / `npm run lint:fix` — ESLint (zero warnings allowed)
- `npm run lint:review` — ESLint as the community review sees it (no Node types)
- `npm run lint:css` — Stylelint
- `npm run format` / `npm run format:check` — Prettier
- `npm run typecheck` — `tsc --noEmit`

## Testing

Vitest, with two environments:

- **`happy-dom`** for view tests. `vitest.config.ts` aliases the `obsidian`
  import to `tests/mocks/obsidian.ts`, and `tests/setup.ts` installs the DOM
  helpers Obsidian adds to `Element.prototype` (`createDiv`, `setText`,
  `addClass`, …). Extend the mock when a view starts using more of the API.
- **`node`** for the git and layout code, via a `// @vitest-environment node`
  docblock. The git tests build a throwaway repository with real `git` calls.

`tests/setup.ts` replaces `requestAnimationFrame` with a queue that tests flush
via `flushFrames()`, so throttled rendering is deterministic.

Tests are not covered by `tsc --noEmit` (tsconfig only includes `src/`) or by
ESLint, but Prettier does check them.

The graph view tests assert virtualization invariants — bounded row count,
unique row positions, element reuse, no per-row git process — because those
break silently and are the reason the rendering is fast.

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

## Code discipline

`npm run validate` is the gate, and CI fails on any warning. The lint setup is
the same one the Obsidian community review runs
(`eslint-plugin-obsidianmd` + typescript-eslint type-checked + stylelint), so
what passes here passes review. It runs twice: once normally, once against
`tsconfig.review.json`, which drops `@types/node` the way the review does —
Node APIs are `any` there, so anything touching them goes through
`src/utils/node-api.ts`.

Write to the linters, not around them: use Obsidian's APIs over raw DOM and
browser globals, keep state in CSS classes rather than inline styles, never
leave a promise unawaited, and reach for specificity instead of `!important`.
A rule you cannot satisfy is a design question, not a candidate for a disable
comment.

## Verifying UI changes

happy-dom does no layout or paint, so a DOM test cannot tell you a change
*looks* right. For visual work, serve a small HTML harness that links the real
`styles.css`, open it in a browser and look at it.

## Important Notes

- `skipLibCheck: true` in tsconfig.json due to Obsidian API type definition issues
- Git operations use `child_process.execFile` — only available in desktop Electron
- The store (`RepoStore`) extends Obsidian's `Events` class for reactive updates
- ESLint warnings (no-explicit-any, missing return types) are intentional — not errors

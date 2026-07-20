import { execFile } from "child_process";
import { ItemView, WorkspaceLeaf, Notice } from "obsidian";
import { DIFF_VIEW_TYPE, FileDiff, DiffHunk, DiffLine } from "../types";
import { GitService } from "../git/git-service";
import type GitHistoryPlugin from "../main";

type TokenType =
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "property"
  | "punctuation"
  | "operator"
  | "tag"
  | "attribute"
  | "text";

interface Token {
  type: TokenType;
  value: string;
}

const JS_KEYWORDS = new Set([
  "var",
  "let",
  "const",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "try",
  "catch",
  "finally",
  "throw",
  "class",
  "extends",
  "super",
  "this",
  "import",
  "export",
  "from",
  "default",
  "async",
  "await",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
  "void",
  "static",
  "get",
  "set",
]);

const TS_EXTRAS = new Set([
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
  "declare",
  "abstract",
  "implements",
  "readonly",
  "private",
  "protected",
  "public",
  "as",
  "is",
  "keyof",
  "infer",
  "never",
  "unknown",
  "any",
  "string",
  "number",
  "boolean",
  "object",
  "symbol",
  "bigint",
]);

const CSS_KEYWORDS = new Set([
  "display",
  "flex",
  "grid",
  "none",
  "block",
  "inline",
  "position",
  "relative",
  "absolute",
  "fixed",
  "sticky",
  "top",
  "left",
  "right",
  "bottom",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "background",
  "color",
  "font",
  "overflow",
  "opacity",
  "z-index",
  "transition",
  "transform",
  "animation",
  "important",
  "auto",
  "inherit",
  "initial",
  "unset",
]);

function tokenizeJS(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const comment = end === -1 ? text.slice(i) : text.slice(i, end);
      tokens.push({ type: "comment", value: comment });
      i += comment.length;
      continue;
    }

    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const comment = end === -1 ? text.slice(i) : text.slice(i, end + 2);
      tokens.push({ type: "comment", value: comment });
      i += comment.length;
      continue;
    }

    if (text[i] === '"' || text[i] === "'" || text[i] === "`") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\") j++;
        j++;
      }
      const str = text.slice(i, j + 1);
      tokens.push({ type: "string", value: str });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(text[i]) && (i === 0 || !/[a-zA-Z_$]/.test(text[i - 1]))) {
      let j = i;
      while (j < text.length && /[0-9.xXa-fA-F_eEn]/.test(text[j])) j++;
      tokens.push({ type: "number", value: text.slice(i, j) });
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_$]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (JS_KEYWORDS.has(word) || TS_EXTRAS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (j < text.length && text[j] === "(") {
        tokens.push({ type: "function", value: word });
      } else if (word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()) {
        tokens.push({ type: "type", value: word });
      } else {
        tokens.push({ type: "text", value: word });
      }
      i = j;
      continue;
    }

    if (/[{}()[\];,.]/.test(text[i])) {
      tokens.push({ type: "punctuation", value: text[i] });
      i++;
      continue;
    }

    if (/[+\-*/%=<>!&|^~?:]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[+\-*/%=<>!&|^~?:]/.test(text[j])) j++;
      tokens.push({ type: "operator", value: text.slice(i, j) });
      i = j;
      continue;
    }

    tokens.push({ type: "text", value: text[i] });
    i++;
  }

  return tokens;
}

function tokenizeCSS(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const comment = end === -1 ? text.slice(i) : text.slice(i, end + 2);
      tokens.push({ type: "comment", value: comment });
      i += comment.length;
      continue;
    }

    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\") j++;
        j++;
      }
      tokens.push({ type: "string", value: text.slice(i, j + 1) });
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[0-9.%a-zA-Z]/.test(text[j])) j++;
      tokens.push({ type: "number", value: text.slice(i, j) });
      i = j;
      continue;
    }

    if (text[i] === "." || text[i] === "#") {
      let j = i + 1;
      while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
      if (j > i + 1) {
        tokens.push({ type: "tag", value: text.slice(i, j) });
        i = j;
        continue;
      }
    }

    if (/[a-zA-Z_-]/.test(text[i])) {
      let j = i;
      while (j < text.length && /[a-zA-Z0-9_-]/.test(text[j])) j++;
      const word = text.slice(i, j);
      if (CSS_KEYWORDS.has(word)) {
        tokens.push({ type: "keyword", value: word });
      } else if (j < text.length && text[j] === "(") {
        tokens.push({ type: "function", value: word });
      } else {
        tokens.push({ type: "property", value: word });
      }
      i = j;
      continue;
    }

    if (/[{}();:,]/.test(text[i])) {
      tokens.push({ type: "punctuation", value: text[i] });
      i++;
      continue;
    }

    tokens.push({ type: "text", value: text[i] });
    i++;
  }

  return tokens;
}

function tokenizeJSON(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") j++;
        j++;
      }
      const str = text.slice(i, j + 1);
      if (j + 1 < text.length && /\s*:/.test(text.slice(j + 1, j + 3))) {
        tokens.push({ type: "property", value: str });
      } else {
        tokens.push({ type: "string", value: str });
      }
      i = j + 1;
      continue;
    }

    if (/[0-9-]/.test(text[i]) && (i === 0 || !/[a-zA-Z]/.test(text[i - 1]))) {
      let j = i;
      if (text[j] === "-") j++;
      while (j < text.length && /[0-9.eE+-]/.test(text[j])) j++;
      tokens.push({ type: "number", value: text.slice(i, j) });
      i = j;
      continue;
    }

    if (
      text.slice(i, i + 4) === "true" ||
      text.slice(i, i + 5) === "false" ||
      text.slice(i, i + 4) === "null"
    ) {
      const word = text.slice(i, i + (text[i] === "f" ? 5 : 4));
      tokens.push({ type: "keyword", value: word });
      i += word.length;
      continue;
    }

    if (/[{}[\]:,]/.test(text[i])) {
      tokens.push({ type: "punctuation", value: text[i] });
      i++;
      continue;
    }

    tokens.push({ type: "text", value: text[i] });
    i++;
  }

  return tokens;
}

function tokenizeMarkdown(text: string): Token[] {
  const tokens: Token[] = [];

  if (/^#{1,6}\s/.test(text)) {
    const match = text.match(/^(#{1,6}\s)/);
    if (match) {
      tokens.push({ type: "keyword", value: match[1] });
      tokens.push({ type: "type", value: text.slice(match[1].length) });
      return tokens;
    }
  }

  if (/^>\s/.test(text)) {
    tokens.push({ type: "comment", value: text });
    return tokens;
  }

  if (/^[-*+]\s|^\d+\.\s/.test(text)) {
    const match = text.match(/^([-*+]\s|\d+\.\s)/);
    if (match) {
      tokens.push({ type: "keyword", value: match[1] });
      tokens.push({ type: "text", value: text.slice(match[1].length) });
      return tokens;
    }
  }

  tokens.push({ type: "text", value: text });
  return tokens;
}

function tokenizePlain(text: string): Token[] {
  return [{ type: "text", value: text }];
}

function getTokenizer(filePath: string): (text: string) => Token[] {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return tokenizeJS;
    case "css":
    case "scss":
    case "less":
      return tokenizeCSS;
    case "json":
    case "jsonc":
    case "json5":
      return tokenizeJSON;
    case "md":
    case "markdown":
      return tokenizeMarkdown;
    default:
      return tokenizePlain;
  }
}

const TOKEN_COLORS: Record<TokenType, string> = {
  keyword: "#569cd6",
  string: "#ce9178",
  comment: "#6a9955",
  number: "#b5cea8",
  function: "#dcdcaa",
  type: "#4ec9b0",
  property: "#9cdcfe",
  punctuation: "#d4d4d4",
  operator: "#d4d4d4",
  tag: "#d7ba7d",
  attribute: "#92c5f7",
  text: "#d4d4d4",
};

export class DiffView extends ItemView {
  private plugin: GitHistoryPlugin;
  private git: GitService;
  private filePath = "";
  private ref: string | null = null;
  /** Show the index against HEAD instead of the worktree against the index. */
  private staged = false;
  private mode: "side-by-side" | "inline" = "side-by-side";
  private diffContainer: HTMLElement | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapViewport: HTMLElement | null = null;
  private minimapWrap: HTMLElement | null = null;
  private codeScrollEl: HTMLElement | null = null;
  private allLines: DiffLine[] = [];
  private tokenize: (text: string) => Token[] = tokenizePlain;

  constructor(leaf: WorkspaceLeaf, plugin: GitHistoryPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.git = plugin.git;
    this.mode = plugin.settings.diffViewMode;
  }

  getViewType(): string {
    return DIFF_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.filePath ? `Diff: ${this.filePath}` : "Diff";
  }
  getIcon(): string {
    return "file-diff";
  }

  setFile(path: string, ref?: string, staged = false): void {
    this.filePath = path;
    this.ref = ref ?? null;
    this.staged = staged;
    this.tokenize = getTokenizer(path);
    (this.leaf as WorkspaceLeaf & { updateHeader?: () => void }).updateHeader?.();
    if (this.diffContainer) this.loadDiff();
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("git-history-diff-view");

    const toolbar = contentEl.createDiv("git-diff-toolbar");
    this.buildToolbar(toolbar);

    const body = contentEl.createDiv("git-diff-body");
    this.diffContainer = body.createDiv("git-diff-container");

    this.minimapWrap = body.createDiv("git-diff-minimap");
    this.minimapCanvas = this.minimapWrap.createEl("canvas", { cls: "git-diff-minimap-canvas" });
    this.minimapViewport = this.minimapWrap.createDiv("git-diff-minimap-viewport");

    this.setupMinimapInteraction();

    if (this.filePath) {
      this.tokenize = getTokenizer(this.filePath);
      await this.loadDiff();
    }
  }

  private buildToolbar(el: HTMLElement): void {
    const left = el.createDiv("git-diff-toolbar-left");

    const breadcrumb = left.createDiv("git-diff-breadcrumb");
    const parts = this.filePath ? this.filePath.split("/") : ["No file selected"];
    parts.forEach((part, idx) => {
      if (idx > 0) {
        const sep = document.createElement("span");
        sep.className = "git-diff-breadcrumb-sep";
        sep.textContent = "›";
        breadcrumb.appendChild(sep);
      }
      const seg = document.createElement("span");
      seg.className =
        idx === parts.length - 1 ? "git-diff-breadcrumb-file" : "git-diff-breadcrumb-dir";
      seg.textContent = part;
      breadcrumb.appendChild(seg);
    });

    const right = el.createDiv("git-diff-toolbar-right");

    const syncEl = right.createSpan("git-diff-sync");
    syncEl.createSpan("git-diff-sync-label").setText("Sync:");
    syncEl.createSpan("git-diff-sync-stat git-diff-sync-up").setText("↑ 0");
    syncEl.createSpan("git-diff-sync-stat git-diff-sync-down").setText("↓ 0");

    const sxsBtn = right.createEl("button", { cls: "git-diff-mode-btn", text: "Side-by-Side" });
    const inlineBtn = right.createEl("button", { cls: "git-diff-mode-btn", text: "Inline" });

    const updateMode = () => {
      sxsBtn.toggleClass("git-diff-mode-active", this.mode === "side-by-side");
      inlineBtn.toggleClass("git-diff-mode-active", this.mode === "inline");
    };
    updateMode();

    sxsBtn.addEventListener("click", () => {
      this.mode = "side-by-side";
      updateMode();
      this.loadDiff();
    });
    inlineBtn.addEventListener("click", () => {
      this.mode = "inline";
      updateMode();
      this.loadDiff();
    });
  }

  private async loadDiff(): Promise<void> {
    if (!this.diffContainer) return;
    this.diffContainer.empty();
    this.allLines = [];

    try {
      let rawDiff: string;
      if (this.ref) {
        const parentRef = this.ref + "^";
        rawDiff = await this.git.diffCommit(parentRef, this.ref, this.filePath);
      } else if (this.staged) {
        rawDiff = await this.git.diff(this.filePath, true);
      } else {
        rawDiff = await this.git.diff(this.filePath);
        if (!rawDiff) {
          rawDiff = await this.git.diff(this.filePath, true);
        }
      }

      if (!rawDiff) {
        this.diffContainer.createDiv("git-diff-empty").setText("No differences found");
        this.clearMinimap();
        return;
      }

      const diffs = await this.git.parseDiff(rawDiff);
      if (diffs.length === 0) {
        this.diffContainer.createDiv("git-diff-empty").setText("No differences found");
        this.clearMinimap();
        return;
      }

      for (const fileDiff of diffs) {
        if (fileDiff.binary) {
          this.diffContainer.createDiv("git-diff-binary").setText("Binary file changed");
          continue;
        }

        for (const hunk of fileDiff.hunks) {
          this.allLines.push(...hunk.lines);
        }

        if (this.mode === "side-by-side") {
          this.renderSideBySide(fileDiff);
        } else {
          this.renderInline(fileDiff);
        }
      }

      this.updateSyncStats(diffs);
      requestAnimationFrame(() => this.renderMinimap());
    } catch (e: unknown) {
      this.diffContainer
        .createDiv("git-diff-error")
        .setText(`Error loading diff: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private updateSyncStats(diffs: FileDiff[]): void {
    let totalAdd = 0,
      totalDel = 0;
    for (const d of diffs) {
      totalAdd += d.additions;
      totalDel += d.deletions;
    }
    const upEl = this.contentEl.querySelector(".git-diff-sync-up");
    const downEl = this.contentEl.querySelector(".git-diff-sync-down");
    if (upEl) upEl.textContent = `↑ ${totalAdd}`;
    if (downEl) downEl.textContent = `↓ ${totalDel}`;
  }

  private highlightContent(container: HTMLElement, text: string): void {
    const tokens = this.tokenize(text);
    for (const token of tokens) {
      const span = document.createElement("span");
      span.style.color = TOKEN_COLORS[token.type];
      span.textContent = token.value;
      container.appendChild(span);
    }
  }

  private renderSideBySide(fileDiff: FileDiff): void {
    if (!this.diffContainer) return;

    const wrapper = this.diffContainer.createDiv("git-diff-sbs");
    const leftPane = wrapper.createDiv("git-diff-pane git-diff-left");
    const rightPane = wrapper.createDiv("git-diff-pane git-diff-right");

    const leftHeader = leftPane.createDiv("git-diff-pane-header");
    leftHeader.setText(fileDiff.oldPath || fileDiff.path);
    const rightHeader = rightPane.createDiv("git-diff-pane-header");
    const rhPath = rightHeader.createSpan();
    rhPath.setText(fileDiff.path);
    const statsEl = rightHeader.createSpan("git-diff-stats");
    statsEl.createSpan("git-stat-add").setText(`+${fileDiff.additions}`);
    statsEl.createSpan("git-stat-del").setText(` -${fileDiff.deletions}`);

    const leftCode = leftPane.createDiv("git-diff-code");
    const rightCode = rightPane.createDiv("git-diff-code");
    this.codeScrollEl = leftCode;

    for (const hunk of fileDiff.hunks) {
      const leftHunkHeader = leftCode.createDiv("git-diff-hunk-header");
      leftHunkHeader.setText(
        hunk.header ||
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      );
      const rightHunkHeader = rightCode.createDiv("git-diff-hunk-header");
      rightHunkHeader.setText(
        hunk.header ||
          `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      );

      if (!this.ref && !this.staged) {
        const hunkActions = rightHunkHeader.createDiv("git-diff-hunk-actions");
        const stageBtn = hunkActions.createEl("button", {
          cls: "git-diff-hunk-btn",
          text: "Stage Hunk",
        });
        stageBtn.addEventListener("click", () => this.stageHunk(fileDiff.path, hunk));
        const revertBtn = hunkActions.createEl("button", {
          cls: "git-diff-hunk-btn",
          text: "Revert",
        });
        revertBtn.addEventListener("click", () => this.revertHunk(fileDiff.path, hunk));
      }

      const paired = this.pairLines(hunk.lines);

      for (const pair of paired) {
        if (pair.type === "context") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-context");
          leftLine.createSpan("git-diff-linenum").setText(String(pair.left?.oldLineNo ?? ""));
          const leftContent = leftLine.createSpan("git-diff-content");
          this.highlightContent(leftContent, pair.left?.content ?? "");

          const rightLine = rightCode.createDiv("git-diff-line git-diff-context");
          rightLine.createSpan("git-diff-linenum").setText(String(pair.left?.newLineNo ?? ""));
          const rightContent = rightLine.createSpan("git-diff-content");
          this.highlightContent(rightContent, pair.left?.content ?? "");
        } else if (pair.type === "modify") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-del");
          leftLine.createSpan("git-diff-linenum").setText(String(pair.left?.oldLineNo ?? ""));
          const leftContent = leftLine.createSpan("git-diff-content");
          this.renderInlineHighlight(
            leftContent,
            pair.left?.content ?? "",
            pair.right?.content ?? "",
            "del",
          );

          const rightLine = rightCode.createDiv("git-diff-line git-diff-add");
          rightLine.createSpan("git-diff-linenum").setText(String(pair.right?.newLineNo ?? ""));
          const rightContent = rightLine.createSpan("git-diff-content");
          this.renderInlineHighlight(
            rightContent,
            pair.right?.content ?? "",
            pair.left?.content ?? "",
            "add",
          );
        } else if (pair.type === "del") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-del");
          leftLine.createSpan("git-diff-linenum").setText(String(pair.left?.oldLineNo ?? ""));
          const leftContent = leftLine.createSpan("git-diff-content");
          this.highlightContent(leftContent, pair.left?.content ?? "");

          const rightLine = rightCode.createDiv("git-diff-line git-diff-empty");
          rightLine.createSpan("git-diff-linenum");
          rightLine.createSpan("git-diff-content");
        } else if (pair.type === "add") {
          const leftLine = leftCode.createDiv("git-diff-line git-diff-empty");
          leftLine.createSpan("git-diff-linenum");
          leftLine.createSpan("git-diff-content");

          const rightLine = rightCode.createDiv("git-diff-line git-diff-add");
          rightLine.createSpan("git-diff-linenum").setText(String(pair.right?.newLineNo ?? ""));
          const rightContent = rightLine.createSpan("git-diff-content");
          this.highlightContent(rightContent, pair.right?.content ?? "");
        }
      }
    }

    leftCode.addEventListener("scroll", () => {
      rightCode.scrollTop = leftCode.scrollTop;
      rightCode.scrollLeft = leftCode.scrollLeft;
      this.updateMinimapViewport();
    });
    rightCode.addEventListener("scroll", () => {
      leftCode.scrollTop = rightCode.scrollTop;
      leftCode.scrollLeft = rightCode.scrollLeft;
      this.updateMinimapViewport();
    });
  }

  private renderInline(fileDiff: FileDiff): void {
    if (!this.diffContainer) return;

    const wrapper = this.diffContainer.createDiv("git-diff-inline");
    const header = wrapper.createDiv("git-diff-pane-header");
    header.createSpan().setText(fileDiff.path);

    const stats = header.createSpan("git-diff-stats");
    stats.createSpan("git-stat-add").setText(`+${fileDiff.additions}`);
    stats.createSpan("git-stat-del").setText(` -${fileDiff.deletions}`);

    const code = wrapper.createDiv("git-diff-code");
    this.codeScrollEl = code;

    for (const hunk of fileDiff.hunks) {
      const hunkHeader = code.createDiv("git-diff-hunk-header");
      hunkHeader.setText(
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`,
      );

      if (!this.ref && !this.staged) {
        const hunkActions = hunkHeader.createDiv("git-diff-hunk-actions");
        const stageBtn = hunkActions.createEl("button", {
          cls: "git-diff-hunk-btn",
          text: "Stage",
        });
        stageBtn.addEventListener("click", () => this.stageHunk(fileDiff.path, hunk));
      }

      for (const line of hunk.lines) {
        const cls =
          line.type === "add"
            ? "git-diff-add"
            : line.type === "del"
              ? "git-diff-del"
              : "git-diff-context";
        const lineEl = code.createDiv(`git-diff-line ${cls}`);
        const lineNo = lineEl.createSpan("git-diff-linenum");

        if (line.type === "del") {
          lineNo.setText(String(line.oldLineNo ?? ""));
        } else if (line.type === "add") {
          lineNo.setText(String(line.newLineNo ?? ""));
        } else {
          lineNo.setText(String(line.oldLineNo ?? ""));
        }

        const sign = lineEl.createSpan("git-diff-sign");
        sign.setText(line.type === "add" ? "+" : line.type === "del" ? "−" : " ");

        const content = lineEl.createSpan("git-diff-content");
        this.highlightContent(content, line.content);
      }
    }

    code.addEventListener("scroll", () => this.updateMinimapViewport());
  }

  private pairLines(lines: DiffLine[]): Array<{
    type: "context" | "modify" | "add" | "del";
    left?: DiffLine;
    right?: DiffLine;
  }> {
    const result: Array<{
      type: "context" | "modify" | "add" | "del";
      left?: DiffLine;
      right?: DiffLine;
    }> = [];
    let i = 0;

    while (i < lines.length) {
      if (lines[i].type === "context") {
        result.push({ type: "context", left: lines[i] });
        i++;
        continue;
      }

      const delStart = i;
      while (i < lines.length && lines[i].type === "del") i++;
      const dels = lines.slice(delStart, i);

      const addStart = i;
      while (i < lines.length && lines[i].type === "add") i++;
      const adds = lines.slice(addStart, i);

      const pairCount = Math.min(dels.length, adds.length);
      for (let j = 0; j < pairCount; j++) {
        result.push({ type: "modify", left: dels[j], right: adds[j] });
      }
      for (let j = pairCount; j < dels.length; j++) {
        result.push({ type: "del", left: dels[j] });
      }
      for (let j = pairCount; j < adds.length; j++) {
        result.push({ type: "add", right: adds[j] });
      }
    }

    return result;
  }

  private renderInlineHighlight(
    container: HTMLElement,
    text: string,
    other: string,
    side: "add" | "del",
  ): void {
    const diffs = this.charDiff(side === "del" ? text : other, side === "del" ? other : text);

    const segments = side === "del" ? diffs.old : diffs.new;

    for (const seg of segments) {
      if (seg.changed) {
        const mark = document.createElement("span");
        mark.className = side === "del" ? "git-diff-char-del" : "git-diff-char-add";
        const tokens = this.tokenize(seg.value);
        for (const token of tokens) {
          const span = document.createElement("span");
          span.style.color = TOKEN_COLORS[token.type];
          span.textContent = token.value;
          mark.appendChild(span);
        }
        container.appendChild(mark);
      } else {
        const tokens = this.tokenize(seg.value);
        for (const token of tokens) {
          const span = document.createElement("span");
          span.style.color = TOKEN_COLORS[token.type];
          span.textContent = token.value;
          container.appendChild(span);
        }
      }
    }
  }

  private charDiff(
    oldStr: string,
    newStr: string,
  ): {
    old: Array<{ value: string; changed: boolean }>;
    new: Array<{ value: string; changed: boolean }>;
  } {
    const oldWords = this.splitWords(oldStr);
    const newWords = this.splitWords(newStr);

    const lcs = this.lcsWords(oldWords, newWords);

    const oldSegs: Array<{ value: string; changed: boolean }> = [];
    const newSegs: Array<{ value: string; changed: boolean }> = [];

    let oi = 0,
      ni = 0,
      li = 0;

    while (oi < oldWords.length || ni < newWords.length) {
      if (
        li < lcs.length &&
        oi < oldWords.length &&
        ni < newWords.length &&
        oldWords[oi] === lcs[li] &&
        newWords[ni] === lcs[li]
      ) {
        oldSegs.push({ value: oldWords[oi], changed: false });
        newSegs.push({ value: newWords[ni], changed: false });
        oi++;
        ni++;
        li++;
      } else {
        if (oi < oldWords.length && (li >= lcs.length || oldWords[oi] !== lcs[li])) {
          oldSegs.push({ value: oldWords[oi], changed: true });
          oi++;
        }
        if (ni < newWords.length && (li >= lcs.length || newWords[ni] !== lcs[li])) {
          newSegs.push({ value: newWords[ni], changed: true });
          ni++;
        }
      }
    }

    return {
      old: this.mergeSegments(oldSegs),
      new: this.mergeSegments(newSegs),
    };
  }

  private splitWords(text: string): string[] {
    const result: string[] = [];
    let i = 0;
    while (i < text.length) {
      if (/\s/.test(text[i])) {
        let j = i;
        while (j < text.length && /\s/.test(text[j])) j++;
        result.push(text.slice(i, j));
        i = j;
      } else if (/[a-zA-Z0-9_$]/.test(text[i])) {
        let j = i;
        while (j < text.length && /[a-zA-Z0-9_$]/.test(text[j])) j++;
        result.push(text.slice(i, j));
        i = j;
      } else {
        result.push(text[i]);
        i++;
      }
    }
    return result;
  }

  private lcsWords(a: string[], b: string[]): string[] {
    const maxLen = 500;
    if (a.length > maxLen || b.length > maxLen) {
      return [];
    }

    const m = a.length,
      n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const result: string[] = [];
    let i = m,
      j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift(a[i - 1]);
        i--;
        j--;
      } else if (dp[i - 1][j] > dp[i][j - 1]) {
        i--;
      } else {
        j--;
      }
    }

    return result;
  }

  private mergeSegments(
    segs: Array<{ value: string; changed: boolean }>,
  ): Array<{ value: string; changed: boolean }> {
    if (segs.length === 0) return segs;
    const merged: Array<{ value: string; changed: boolean }> = [segs[0]];
    for (let i = 1; i < segs.length; i++) {
      const last = merged[merged.length - 1];
      if (last.changed === segs[i].changed) {
        last.value += segs[i].value;
      } else {
        merged.push({ ...segs[i] });
      }
    }
    return merged;
  }

  private renderMinimap(): void {
    const canvas = this.minimapCanvas;
    const wrap = this.minimapWrap;
    if (!canvas || !wrap || this.allLines.length === 0) {
      this.clearMinimap();
      return;
    }

    wrap.style.display = "flex";
    const height = wrap.clientHeight || 400;
    const width = 80;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, width, height);

    const lineH = Math.min(3, Math.max(1.2, height / this.allLines.length));
    const visibleLines = Math.floor(height / lineH);
    const totalLines = this.allLines.length;

    for (let i = 0; i < Math.min(totalLines, visibleLines); i++) {
      const line = this.allLines[i];
      const y = i * lineH;

      if (line.type === "add") {
        ctx.fillStyle = "rgba(35, 134, 54, 0.5)";
        ctx.fillRect(0, y, width, lineH);
        ctx.fillStyle = "rgba(35, 134, 54, 0.9)";
        ctx.fillRect(width - 3, y, 3, lineH);
      } else if (line.type === "del") {
        ctx.fillStyle = "rgba(248, 81, 73, 0.4)";
        ctx.fillRect(0, y, width, lineH);
        ctx.fillStyle = "rgba(248, 81, 73, 0.9)";
        ctx.fillRect(width - 3, y, 3, lineH);
      }

      const content = line.content || "";
      const indent = content.match(/^(\s*)/)?.[1]?.length ?? 0;
      const textLen = content.trimEnd().length - indent;

      if (textLen > 0) {
        const x = 4 + Math.min(indent, 20) * 0.8;
        const w = Math.min(textLen * 0.6, width - x - 6);
        ctx.fillStyle =
          line.type === "add"
            ? "rgba(100, 200, 120, 0.35)"
            : line.type === "del"
              ? "rgba(220, 100, 100, 0.35)"
              : "rgba(180, 180, 180, 0.15)";
        ctx.fillRect(x, y + lineH * 0.15, Math.max(w, 3), lineH * 0.7);
      }
    }

    this.updateMinimapViewport();
  }

  private updateMinimapViewport(): void {
    const viewport = this.minimapViewport;
    const scrollEl = this.codeScrollEl;
    const wrap = this.minimapWrap;
    if (!viewport || !scrollEl || !wrap) return;

    const wrapH = wrap.clientHeight || 1;
    const scrollH = scrollEl.scrollHeight || 1;
    const clientH = scrollEl.clientHeight || 1;
    const scrollTop = scrollEl.scrollTop;

    const vpTop = (scrollTop / scrollH) * wrapH;
    const vpHeight = Math.max(20, (clientH / scrollH) * wrapH);

    viewport.style.top = vpTop + "px";
    viewport.style.height = vpHeight + "px";
  }

  private clearMinimap(): void {
    if (this.minimapWrap) this.minimapWrap.style.display = "none";
  }

  private setupMinimapInteraction(): void {
    const wrap = this.minimapWrap;
    if (!wrap) return;

    let dragging = false;

    const jumpToPosition = (clientY: number) => {
      const scrollEl = this.codeScrollEl;
      if (!scrollEl) return;
      const rect = wrap.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      scrollEl.scrollTop = ratio * (scrollEl.scrollHeight - scrollEl.clientHeight);
    };

    wrap.addEventListener("mousedown", (e: MouseEvent) => {
      dragging = true;
      jumpToPosition(e.clientY);
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e: MouseEvent) => {
      if (!dragging) return;
      jumpToPosition(e.clientY);
      e.preventDefault();
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  private async stageHunk(path: string, hunk: DiffHunk): Promise<void> {
    try {
      const patch = this.buildPatch(path, hunk);
      const repoRoot = await this.git.getRepoRoot();
      await new Promise<void>((resolve, reject) => {
        const proc = execFile("git", ["apply", "--cached", "-"], { cwd: repoRoot }, (err) =>
          err ? reject(err) : resolve(),
        );
        proc.stdin?.write(patch);
        proc.stdin?.end();
      });
      await this.plugin.store.refresh();
      new Notice("Hunk staged");
      await this.loadDiff();
    } catch (e: unknown) {
      new Notice(`Stage hunk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async revertHunk(path: string, hunk: DiffHunk): Promise<void> {
    try {
      const patch = this.buildPatch(path, hunk, true);
      const repoRoot = await this.git.getRepoRoot();
      await new Promise<void>((resolve, reject) => {
        const proc = execFile("git", ["apply", "-R", "-"], { cwd: repoRoot }, (err) =>
          err ? reject(err) : resolve(),
        );
        proc.stdin?.write(patch);
        proc.stdin?.end();
      });
      await this.plugin.store.refresh();
      new Notice("Hunk reverted");
      await this.loadDiff();
    } catch (e: unknown) {
      new Notice(`Revert hunk failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private buildPatch(path: string, hunk: DiffHunk, _reverse = false): string {
    let patch = `--- a/${path}\n+++ b/${path}\n`;
    patch += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`;
    for (const line of hunk.lines) {
      if (line.type === "add") patch += `+${line.content}\n`;
      else if (line.type === "del") patch += `-${line.content}\n`;
      else patch += ` ${line.content}\n`;
    }
    return patch;
  }

  async onClose(): Promise<void> {
    this.minimapCanvas = null;
    this.minimapViewport = null;
    this.minimapWrap = null;
    this.codeScrollEl = null;
  }
}

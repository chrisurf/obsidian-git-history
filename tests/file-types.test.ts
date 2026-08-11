// @vitest-environment node
import { describe, it, expect } from "vitest";
import type { App } from "obsidian";
import {
  SUPPORTED_EXTENSIONS,
  extensionOf,
  isSupportedPath,
  supportedFileFilter,
} from "../src/utils/file-types";

describe("extensionOf", () => {
  it("reads the extension from a repository path", () => {
    expect(extensionOf("reports/daily/2026-06-25.md")).toBe("md");
    expect(extensionOf("data/features.parquet")).toBe("parquet");
  });

  it("lower-cases it, so PNG and png are the same type", () => {
    expect(extensionOf("Attachments/Scan.PNG")).toBe("png");
  });

  it("gives a dotfile no extension — the dot names the file, it does not type it", () => {
    expect(extensionOf(".gitignore")).toBe("");
    expect(extensionOf("reports/.date")).toBe("");
  });

  it("gives a file without a dot no extension", () => {
    expect(extensionOf("LICENSE")).toBe("");
    expect(extensionOf("scripts/build")).toBe("");
  });
});

describe("isSupportedPath", () => {
  it("keeps what Obsidian opens", () => {
    for (const path of [
      "Note.md",
      "Board.canvas",
      "Table.base",
      "Paper.pdf",
      "img/photo.jpg",
      "img/diagram.svg",
      "audio/take.mp3",
      "video/clip.mp4",
    ]) {
      expect(isSupportedPath(path), path).toBe(true);
    }
  });

  it("drops what it cannot render", () => {
    for (const path of [
      "dashboard/public/data/ranking.json",
      "data/features.parquet",
      "package-lock.json",
      "src/main.ts",
      "reports/.date",
      "LICENSE",
    ]) {
      expect(isSupportedPath(path), path).toBe(false);
    }
  });

  it("defers to a live registry when one is given, so plugin-registered types count", () => {
    const registry = (ext: string) => ext === "csv";
    expect(isSupportedPath("data/table.csv", registry)).toBe(true);
    expect(isSupportedPath("Note.md", registry)).toBe(false);
  });

  it("mirrors the extensions read out of Obsidian itself", () => {
    // Straight from the shipped bundle: images, audio, video, pdf, md, canvas,
    // base. A release that adds a type should update this set.
    for (const ext of ["md", "canvas", "base", "pdf", "avif", "opus", "mkv"]) {
      expect(SUPPORTED_EXTENSIONS.has(ext), ext).toBe(true);
    }
    expect(SUPPORTED_EXTENSIONS.has("json")).toBe(false);
  });
});

describe("supportedFileFilter", () => {
  const appWith = (registered: string[]): App =>
    ({
      viewRegistry: { isExtensionRegistered: (ext: string) => registered.includes(ext) },
    }) as unknown as App;

  it("keeps everything when the setting is off", () => {
    const keep = supportedFileFilter(appWith(["md"]), false);
    expect(["Note.md", "data/x.parquet", ".gitignore"].filter(keep)).toEqual([
      "Note.md",
      "data/x.parquet",
      ".gitignore",
    ]);
  });

  it("asks the view registry when the setting is on", () => {
    const keep = supportedFileFilter(appWith(["md", "csv"]), true);
    expect(["Note.md", "data/table.csv", "data/x.parquet"].filter(keep)).toEqual([
      "Note.md",
      "data/table.csv",
    ]);
  });

  it("falls back to the built-in set when the registry is not reachable", () => {
    const keep = supportedFileFilter({} as App, true);
    expect(["Note.md", "data/x.parquet"].filter(keep)).toEqual(["Note.md"]);
  });
});

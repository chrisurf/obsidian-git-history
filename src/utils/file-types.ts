/**
 * Which files Obsidian is able to open.
 *
 * A commit routinely touches files no Obsidian view can render — lockfiles,
 * `.json` data, build output — and listing them only offers actions that lead
 * nowhere. The authority is Obsidian's own view registry, the very check the
 * file explorer uses to grey a file out, so extensions registered by other
 * plugins count as supported too.
 *
 * The set below is the fallback for when that registry cannot be reached. It
 * mirrors the defaults read out of Obsidian 1.13 and is deliberately a plain
 * value so the filtering can be tested without an app.
 */
import type { App } from "obsidian";

export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents Obsidian edits itself
  "md",
  "canvas",
  "base",
  "pdf",
  // Images
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
  // Audio
  "3gp",
  "flac",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "opus",
  "wav",
  // Video
  "mkv",
  "mov",
  "mp4",
  "ogv",
  "webm",
]);

/**
 * The extension of a repository path, lower-cased and without the dot. A
 * dotfile such as `.gitignore` has none: its leading dot names the file rather
 * than typing it.
 */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Whether Obsidian can open the file at `path`. Pass `isRegistered` to defer to
 * a live view registry; without it the built-in set decides.
 */
export function isSupportedPath(path: string, isRegistered?: (ext: string) => boolean): boolean {
  const ext = extensionOf(path);
  if (!ext) return false;
  return isRegistered ? isRegistered(ext) : SUPPORTED_EXTENSIONS.has(ext);
}

interface ViewRegistryLike {
  isExtensionRegistered?: (ext: string) => boolean;
}

/**
 * The predicate the commit file lists filter by. With the setting off it keeps
 * everything, so callers can filter unconditionally and stay readable.
 */
export function supportedFileFilter(app: App, enabled: boolean): (path: string) => boolean {
  if (!enabled) return () => true;

  // `viewRegistry` is not part of the published API surface, so it is reached
  // for defensively and the built-in list stands in when it is absent.
  const registry = (app as App & { viewRegistry?: ViewRegistryLike }).viewRegistry;
  const check = registry?.isExtensionRegistered;
  const isRegistered =
    typeof check === "function" ? (ext: string) => check.call(registry, ext) : undefined;

  return (path: string) => isSupportedPath(path, isRegistered);
}

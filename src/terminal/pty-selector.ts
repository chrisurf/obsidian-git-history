/**
 * Which backend a session gets, and why it did not get a better one.
 *
 * The "why" is half the point. A terminal that quietly drops to pipes because
 * no python answered looks like a broken terminal; one that can say which
 * backends it tried, in which order, and what each of them was missing is a
 * terminal someone can fix. The attempts are therefore carried out of here
 * alongside the decision, and both the failure panel and the setup report are
 * built from them.
 *
 * The walk is pure apart from the resolver it is handed, so the order — the
 * part that decides what users actually run — is testable without a machine
 * that has or lacks any particular interpreter.
 */
import { PTY_BACKENDS, backendSpec } from "./pty-backend";
import type { BackendPreference, PlatformName, PtyBackendId, PtyBackendSpec } from "./pty-backend";
import type { Resolution } from "../utils/binary-resolver";

export interface BackendAttempt {
  id: PtyBackendId;
  label: string;
  /** The interpreter that answered, or null when none did. */
  interpreter: string | null;
  /** Absolute paths that were probed. Empty for a backend needing none. */
  tried: readonly string[];
  /** Why this backend was passed over, or null when it is the one in use. */
  skipped: string | null;
}

export interface SelectedBackend {
  spec: PtyBackendSpec;
  /** Path of the interpreter, or "" for a backend that needs none. */
  interpreter: string;
  attempts: readonly BackendAttempt[];
}

export interface SelectOptions {
  platform: PlatformName;
  preference: BackendPreference;
  resolve: (interpreter: "python3" | "perl") => Promise<Resolution>;
}

/**
 * Walks the backends and takes the first that can run.
 *
 * A preference set in the settings is moved to the front rather than made
 * exclusive: someone who picked Perl and then uninstalled it should get a
 * working terminal and a report saying what happened, not a panel refusing to
 * open on principle. The last backend needs no interpreter, so the walk always
 * ends somewhere.
 */
export async function selectBackend(opts: SelectOptions): Promise<SelectedBackend> {
  const attempts: BackendAttempt[] = [];

  for (const spec of order(opts.platform, opts.preference)) {
    if (spec.interpreter === null) {
      attempts.push({
        id: spec.id,
        label: spec.label,
        interpreter: null,
        tried: [],
        skipped: null,
      });
      return { spec, interpreter: "", attempts };
    }

    const resolved = await opts.resolve(spec.interpreter);
    if (resolved.binary) {
      attempts.push({
        id: spec.id,
        label: spec.label,
        interpreter: resolved.binary.path,
        tried: resolved.tried,
        skipped: null,
      });
      return { spec, interpreter: resolved.binary.path, attempts };
    }

    attempts.push({
      id: spec.id,
      label: spec.label,
      interpreter: null,
      tried: resolved.tried,
      skipped: `no working ${spec.interpreter} answered (${resolved.tried.length} tried)`,
    });
  }

  // Unreachable while the pipe backend runs everywhere, and cheaper to keep
  // than to make the caller handle a case the table rules out.
  return { spec: backendSpec("pipe"), interpreter: "", attempts };
}

function order(platform: PlatformName, preference: BackendPreference): PtyBackendSpec[] {
  const usable = PTY_BACKENDS.filter((spec) => spec.platforms.includes(platform));
  if (preference === "auto") return usable;
  const preferred = usable.filter((spec) => spec.id === preference);
  return [...preferred, ...usable.filter((spec) => spec.id !== preference)];
}

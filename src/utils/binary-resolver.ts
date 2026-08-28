/**
 * Which binary to run, decided by asking the candidates instead of trusting a
 * name.
 *
 * Spawning `"git"` or `"python3"` and hoping is how the plugin used to work,
 * and it holds exactly as long as the first PATH hit happens to be the real
 * thing. It is not always: macOS puts developer-tool stubs in `/usr/bin` that
 * answer to both names and refuse to run when the Xcode installation behind
 * them is broken, and a `python3` can perfectly well exist while being a build
 * too stripped down to import `pty`.
 *
 * Every candidate is therefore probed — actually run, with a question only a
 * working installation can answer — and the first one that answers correctly is
 * the one that gets used. A candidate that cannot answer is not a candidate,
 * however good its path looks.
 *
 * The ordering and the probing are kept apart on purpose: the order is a
 * decision, it is pure, and it is where the mistakes are, so it is somewhere a
 * unit test can reach without a filesystem.
 */

export type CandidateSource = "configured" | "path" | "known" | "fallback";

export interface Candidate {
  path: string;
  source: CandidateSource;
}

export interface CandidateInput {
  /** Binary name as it would be looked up in PATH, e.g. "git". */
  name: string;
  /** An explicit path the user set in the settings. Always tried first. */
  configured?: string;
  /** Directories of the login PATH, in their original order. */
  pathDirs?: readonly string[];
  /** Absolute locations worth trying when PATH knows nothing, e.g. Homebrew. */
  known?: readonly string[];
  /** Absolute locations to try only once everything else failed. */
  fallback?: readonly string[];
  /** ".exe" on Windows. */
  exeSuffix?: string;
}

/**
 * Every path worth trying, best first.
 *
 * The user's own setting wins, then their PATH, then the places a package
 * manager would have put it, and last the ones that are known to be able to lie
 * about themselves — `/usr/bin/python3` and `/usr/bin/git` are reachable
 * through PATH like anything else, so they are pulled out of that pass and
 * appended at the end rather than merely not being added. They stay in the
 * list: on a machine with working developer tools they are a perfectly good
 * git, and being last costs nothing when something better answers first.
 */
export function candidates(input: CandidateInput): Candidate[] {
  const suffix = input.exeSuffix ?? "";
  const fallback = input.fallback ?? [];
  const demoted = new Set(fallback);

  const ordered: Candidate[] = [];
  if (input.configured?.trim()) {
    ordered.push({ path: input.configured.trim(), source: "configured" });
  }
  for (const dir of input.pathDirs ?? []) {
    ordered.push({ path: `${stripTrailingSlash(dir)}/${input.name}${suffix}`, source: "path" });
  }
  for (const path of input.known ?? []) ordered.push({ path, source: "known" });
  for (const path of fallback) ordered.push({ path, source: "fallback" });

  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    if (candidate.source === "path" && demoted.has(candidate.path)) return false;
    if (seen.has(candidate.path)) return false;
    seen.add(candidate.path);
    return true;
  });
}

function stripTrailingSlash(dir: string): string {
  return dir.endsWith("/") && dir.length > 1 ? dir.slice(0, -1) : dir;
}

/** Runs the binary and says whether it answered the way a working one would. */
export type Probe = (path: string) => Promise<boolean>;

export interface Resolution {
  /** The binary to use, or null when nothing answered. */
  binary: Candidate | null;
  /** Every path that was tried, in order. An error message is built from it. */
  tried: readonly string[];
}

/**
 * The probe travels with the request rather than with the resolver: "does this
 * answer to `--version`" and "does this have a working `pty` module" are
 * different questions, and one resolver answers both.
 */
export interface ResolveRequest extends CandidateInput {
  probe: Probe;
}

export class BinaryResolver {
  private cache = new Map<string, Promise<Resolution>>();

  /**
   * Resolves a binary, at most once per name and configured value.
   *
   * The promise rather than the result is cached, so several sessions opening
   * at the same time share one round of probing instead of racing through it
   * side by side. Failures are cached as well — a machine with no usable
   * python3 should not pay for the whole walk on every new session — which is
   * what `invalidate` is for: the settings tab clears the cache when the user
   * points the plugin somewhere new, and the next attempt starts over.
   */
  resolve(request: ResolveRequest): Promise<Resolution> {
    const key = `${request.name} ${request.configured ?? ""}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const pending = this.walk(request);
    this.cache.set(key, pending);
    return pending;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private async walk(request: ResolveRequest): Promise<Resolution> {
    const tried: string[] = [];
    for (const candidate of candidates(request)) {
      tried.push(candidate.path);
      if (await request.probe(candidate.path)) return { binary: candidate, tried };
    }
    return { binary: null, tried };
  }
}

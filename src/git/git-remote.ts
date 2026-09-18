import type { RemoteInfo } from "../types";

/**
 * What a remote is, said in the words the settings need.
 *
 * A remote is the one piece of a repository that lives somewhere else, and the
 * URL is how git finds it — `https://github.com/you/vault.git`, or the `git@`
 * form of the same thing. Neither is a thing anyone remembers the shape of, so
 * the settings say which host an address points at and which repository on it,
 * and refuse the addresses git would accept and then fail on much later.
 *
 * Everything here is string work on purpose: it is what lets the settings
 * describe and check a remote without running git, and what makes the rules
 * testable without a repository.
 */

/** Hosts under their own names, so a URL reads as "GitHub" rather than a domain. */
const KNOWN_HOSTS: Record<string, string> = {
  "github.com": "GitHub",
  "gitlab.com": "GitLab",
  "bitbucket.org": "Bitbucket",
  "codeberg.org": "Codeberg",
  "dev.azure.com": "Azure DevOps",
  "ssh.dev.azure.com": "Azure DevOps",
  "git.sr.ht": "SourceHut",
};

/** The same products where someone runs them on their own domain. */
const HOST_HINTS: [needle: string, label: string][] = [
  ["github", "GitHub"],
  ["gitlab", "GitLab"],
  ["bitbucket", "Bitbucket"],
  ["gitea", "Gitea"],
  ["forgejo", "Forgejo"],
];

export interface RemoteAddress {
  /** The bare host, without userinfo or port: `github.com`. */
  host: string;
  /** The repository on it, without a leading slash or a `.git` suffix. */
  path: string;
}

/**
 * Splits an address into the two halves worth showing.
 *
 * Both forms git takes are handled: a URL with a scheme, and the `scp`-like
 * `git@host:owner/repo.git` that every host puts on its clone button. A local
 * path is a remote too and has no host, which is why the host may come back
 * empty.
 */
export function parseRemoteUrl(url: string): RemoteAddress | null {
  const trimmed = url.trim();
  if (trimmed === "") return null;

  const scheme = trimmed.indexOf("://");
  if (scheme >= 0) {
    const rest = trimmed.slice(scheme + 3);
    const slash = rest.indexOf("/");
    const authority = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? "" : rest.slice(slash + 1);
    return { host: bareHost(authority), path: cleanPath(path) };
  }

  // `git@github.com:you/vault.git`. A Windows drive letter (`C:/notes`) has a
  // colon too, which is why the host half has to hold a dot to count.
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const authority = trimmed.slice(0, colon);
    if (authority.includes(".")) {
      return { host: bareHost(authority), path: cleanPath(trimmed.slice(colon + 1)) };
    }
  }

  return { host: "", path: cleanPath(trimmed) };
}

/**
 * The host under the name its users call it, or the bare domain.
 *
 * A remote on a folder or a drive has no host and says so: "Local folder" is
 * the one label that cannot be read as a server somewhere.
 */
export function remoteHostLabel(url: string): string {
  const address = parseRemoteUrl(url);
  if (!address) return "No address";
  const host = address.host;
  if (host === "") return "Local folder";
  const known = KNOWN_HOSTS[host.toLowerCase()];
  if (known) return known;
  const hint = HOST_HINTS.find(([needle]) => host.toLowerCase().includes(needle));
  return hint ? `${hint[1]} (${host})` : host;
}

/**
 * Which repository a remote points at, for the line under its name.
 *
 * The host is not in here: it is the badge beside this line, where two words
 * are read at a glance. What is left is the part that tells two remotes on the
 * same host apart.
 *
 * A remote whose push URL differs from its fetch URL says so. That is a
 * deliberate and rare setup, and a row showing one address while pushing to
 * another would be wrong in the way that costs someone an afternoon.
 */
export function describeRemote(remote: RemoteInfo): string {
  const url = remote.fetchUrl || remote.pushUrl;
  const address = parseRemoteUrl(url);
  const parts: string[] = [address?.path || url || "No address"];
  if (remote.pushUrl && remote.fetchUrl && remote.pushUrl !== remote.fetchUrl) {
    parts.push(`pushes to ${remote.pushUrl}`);
  }
  return parts.join(" · ");
}

/**
 * Whether git and the host will both accept an address.
 *
 * Shallow on purpose, in the same way {@link import("./git-identity").emailProblem} is: the
 * point is to catch what is certainly wrong — an empty field, a pasted
 * sentence, a web page rather than a repository — not to be the authority on
 * what a valid URL is. git checks none of it and fails at the first fetch.
 */
export function remoteUrlProblem(url: string): string | null {
  const value = url.trim();
  if (value === "") return "An address is required.";
  if (/\s/.test(value)) return "An address cannot contain spaces.";

  const address = parseRemoteUrl(value);
  if (!address) return "An address is required.";

  const hasScheme = value.includes("://");
  const isScpLike = address.host !== "" && !hasScheme;
  const isLocalPath = value.startsWith("/") || value.startsWith("~") || value.startsWith(".");

  if (!hasScheme && !isScpLike && !isLocalPath) {
    return "This does not look like a Git address. Use the URL your host's clone button gives you.";
  }
  if ((hasScheme || isScpLike) && address.path === "") {
    return "The address names a host but no repository on it.";
  }
  return null;
}

/**
 * Whether a name is one git can use for a remote, and one that is still free.
 *
 * git's own rules are wider than this; these are the names that work
 * everywhere and read as names. The duplicate check is here rather than in the
 * caller because "origin already exists" is the mistake worth catching before
 * a command fails.
 */
export function remoteNameProblem(name: string, taken: readonly string[]): string | null {
  const value = name.trim();
  if (value === "") return "A name is required.";
  if (/[^A-Za-z0-9._-]/.test(value)) {
    return "A name can hold letters, digits, dots, dashes and underscores.";
  }
  if (value.startsWith(".") || value.startsWith("-")) return "A name cannot start with . or -";
  if (taken.includes(value)) return `There is already a remote called "${value}".`;
  return null;
}

/**
 * The name to offer for a new remote: the one git itself would use, until it
 * is taken.
 */
export function suggestedRemoteName(taken: readonly string[]): string {
  if (!taken.includes("origin")) return "origin";
  for (let i = 2; ; i++) {
    const candidate = `origin-${i}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

function bareHost(authority: string): string {
  const at = authority.lastIndexOf("@");
  const host = at < 0 ? authority : authority.slice(at + 1);
  const colon = host.indexOf(":");
  return (colon < 0 ? host : host.slice(0, colon)).trim();
}

function cleanPath(path: string): string {
  let value = path.trim();
  while (value.startsWith("/")) value = value.slice(1);
  while (value.endsWith("/")) value = value.slice(0, -1);
  if (value.toLowerCase().endsWith(".git")) value = value.slice(0, -4);
  return value;
}

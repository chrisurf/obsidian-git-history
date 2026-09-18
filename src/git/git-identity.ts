/**
 * Who git will put on a commit, and where that answer comes from.
 *
 * The value alone is not enough to show anyone. A name in a settings field
 * that was inherited from `~/.gitconfig` and a name that was set for this
 * vault look identical, and the difference is what an edit means: correcting
 * an inherited name here gives this vault an exception to it, and correcting a
 * vault-local one changes only what these notes commit with. So the scope is
 * read alongside the value and carried through to the field that displays it.
 *
 * Read, never chosen. An edit from the plugin is written to this repository
 * and nowhere else — a settings screen in a vault has no business changing the
 * name every other repository on the computer commits under.
 *
 * `git config --show-scope --get-regexp` gives both in one call, and gives
 * them in precedence order: system, then global, then local, each overriding
 * the one before. Reading is therefore taking the last of each key — which is
 * also why the parser keeps what it displaced, so the settings can say what a
 * vault-local name is standing in front of.
 */

/** Every scope git reports. The plugin writes to `local` and reads the rest. */
export type ConfigScope = "system" | "global" | "local" | "worktree" | "command";

export interface IdentityField {
  /** What git would use, or "" when nothing sets it. */
  value: string;
  /** Where that value is written, or null when there is none — or when the
      git in use is too old to say. */
  scope: ConfigScope | null;
  /** The value this one overrides, when it overrides one. */
  shadowed: { value: string; scope: ConfigScope | null } | null;
}

export interface GitIdentity {
  name: IdentityField;
  email: IdentityField;
}

const EMPTY: IdentityField = { value: "", scope: null, shadowed: null };

export const NO_IDENTITY: GitIdentity = { name: EMPTY, email: EMPTY };

const SCOPES: readonly ConfigScope[] = ["system", "global", "local", "worktree", "command"];

/**
 * Reads `git config --show-scope --get-regexp '^user\.(name|email)$'`.
 *
 * Also reads the same command without `--show-scope`, which is what a git
 * older than 2.26 leaves us with: the values are still in precedence order, so
 * everything works except naming the file they came from.
 */
export function parseIdentity(stdout: string): GitIdentity {
  const found: Record<"name" | "email", { value: string; scope: ConfigScope | null }[]> = {
    name: [],
    email: [],
  };

  for (const line of stdout.split("\n")) {
    const entry = parseLine(line);
    if (entry) found[entry.key].push({ value: entry.value, scope: entry.scope });
  }

  return { name: fold(found.name), email: fold(found.email) };
}

/** Whether git has everything it needs to write a commit. */
export function isComplete(identity: GitIdentity): boolean {
  return identity.name.value !== "" && identity.email.value !== "";
}

/** How a field says where it comes from, or null when it has nothing to say. */
export function describeField(field: IdentityField): string | null {
  // Which of the two happens is a property of the machine, not of the vault:
  // where git can read a user name and a hostname it invents an identity and
  // commits with it, and where it cannot it refuses. Both are worth avoiding,
  // and neither can be promised here.
  if (field.value === "")
    return "Not set. Git will either refuse to commit or invent one from your computer.";
  if (field.scope === null) return null;

  const where = scopeLabel(field.scope);
  if (!field.shadowed) return where;
  return `${where}, overriding ${scopeNoun(field.shadowed.scope)} (${field.shadowed.value})`;
}

/**
 * Where a field comes from, in the two pieces a settings row shows it in.
 *
 * `describeField` above says the same thing as one sentence, which is what the
 * modal and the older prose want. A row has a narrow column and an eye that
 * skips it, so it gets a short badge it can colour — "This vault" — and keeps
 * the sentence for what the badge cannot hold.
 */
export interface FieldOrigin {
  /** Two or three words, for a badge. */
  label: string;
  /** How the badge reads: a fact, a deliberate exception, or a problem. */
  tone: "neutral" | "accent" | "warning";
  /** The rest of the story, when there is one. */
  detail: string | null;
}

/**
 * What an inherited value has to say for itself.
 *
 * An edit is written for this vault and nowhere else, so a value that came
 * from somewhere wider is about to be overridden here rather than corrected
 * where it lives. That is worth knowing before typing, not after.
 */
const INHERITED = "An edit here is written for this vault only.";

export function originOf(field: IdentityField): FieldOrigin {
  if (field.value === "") {
    return {
      label: "Not set",
      tone: "warning",
      detail: "Git will either refuse to commit or invent one from your computer.",
    };
  }

  const shadowed = field.shadowed
    ? `Overrides ${scopeNoun(field.shadowed.scope)} (${field.shadowed.value}).`
    : null;

  switch (field.scope) {
    case "local":
      return { label: "This vault", tone: "accent", detail: shadowed };
    case "worktree":
      return { label: "This worktree", tone: "accent", detail: shadowed };
    case "global":
      return { label: "Global Git config", tone: "neutral", detail: INHERITED };
    case "system":
      return { label: "System Git config", tone: "neutral", detail: INHERITED };
    case "command":
      return { label: "Command line", tone: "neutral", detail: INHERITED };
    default:
      // A git older than 2.26 cannot say which config a value came from.
      return { label: "In use", tone: "neutral", detail: null };
  }
}

/** The config named as a thing, for the clause that says what is overridden. */
function scopeNoun(scope: ConfigScope | null): string {
  switch (scope) {
    case "local":
      return "this vault's own config";
    case "worktree":
      return "this worktree's config";
    case "global":
      return "your global Git config";
    case "system":
      return "this computer's system Git config";
    case "command":
      return "the command line";
    default:
      return "a config Git did not name";
  }
}

/** The same config as a statement about the field, for the line under it. */
function scopeLabel(scope: ConfigScope | null): string {
  switch (scope) {
    case "local":
      return "Set for this vault";
    case "worktree":
      return "Set for this worktree";
    case "global":
      return "From your global Git config";
    case "system":
      return "From this computer's system Git config";
    case "command":
      return "Set on the command line";
    default:
      return "Set somewhere Git did not name";
  }
}

/**
 * Whether an address is one git and a remote will both accept.
 *
 * Deliberately shallow: anything beyond "has a name, an @ and a host, and no
 * spaces" starts rejecting addresses that work. Git itself checks none of
 * this, which is how a trailing space ends up on every commit in a repository.
 */
export function emailProblem(value: string): string | null {
  const email = value.trim();
  if (email === "") return "An email address is required.";
  if (/\s/.test(email)) return "An email address cannot contain spaces.";
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return "An email address needs exactly one @.";
  if (!email.slice(at + 1).includes(".")) return "The part after the @ needs a dot.";
  return null;
}

export function nameProblem(value: string): string | null {
  return value.trim() === "" ? "A name is required." : null;
}

/**
 * Whether a failed git command failed for want of an identity.
 *
 * Matched on the message rather than the exit code: git exits 128 for most of
 * what can go wrong with a commit, and this is the one case with an answer the
 * plugin can offer.
 */
export function isMissingIdentityError(message: string): boolean {
  const text = message.toLowerCase();
  return (
    text.includes("please tell me who you are") ||
    text.includes("unable to auto-detect email address") ||
    text.includes("empty ident name") ||
    text.includes("no name was given")
  );
}

interface ParsedLine {
  scope: ConfigScope | null;
  key: "name" | "email";
  value: string;
}

function parseLine(line: string): ParsedLine | null {
  if (line.trim() === "") return null;

  const tab = line.indexOf("\t");
  const scope = tab < 0 ? null : asScope(line.slice(0, tab));
  const rest = tab < 0 ? line : line.slice(tab + 1);

  const space = rest.indexOf(" ");
  const key = (space < 0 ? rest : rest.slice(0, space)).trim();
  if (key !== "user.name" && key !== "user.email") return null;

  return {
    scope,
    key: key === "user.name" ? "name" : "email",
    // Not trimmed: a value git stored with a trailing space is a value the
    // user should see, since it is the one going onto their commits.
    value: space < 0 ? "" : rest.slice(space + 1),
  };
}

function asScope(text: string): ConfigScope | null {
  return SCOPES.find((scope) => scope === text) ?? null;
}

/** The last entry wins, and remembers the one it displaced. */
function fold(entries: { value: string; scope: ConfigScope | null }[]): IdentityField {
  const winner = entries[entries.length - 1];
  if (!winner) return EMPTY;
  const previous = entries[entries.length - 2];
  return {
    value: winner.value,
    scope: winner.scope,
    shadowed: previous ? { value: previous.value, scope: previous.scope } : null,
  };
}

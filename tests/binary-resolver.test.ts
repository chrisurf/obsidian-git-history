// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { BinaryResolver, candidates } from "../src/utils/binary-resolver";

const PATH_DIRS = ["/opt/homebrew/bin", "/usr/bin", "/bin"];
const FALLBACK = ["/usr/bin/git"];

const paths = (input: Parameters<typeof candidates>[0]): string[] =>
  candidates(input).map((c) => c.path);

describe("the order candidates are tried in", () => {
  it("asks the user's setting first", () => {
    const found = candidates({
      name: "git",
      configured: "/opt/git/bin/git",
      pathDirs: PATH_DIRS,
    });
    expect(found[0]).toEqual({ path: "/opt/git/bin/git", source: "configured" });
  });

  it("ignores a setting that is empty or only spaces", () => {
    expect(paths({ name: "git", configured: "   ", pathDirs: ["/bin"] })).toEqual(["/bin/git"]);
  });

  it("walks the login PATH in the order the shell reported it", () => {
    expect(paths({ name: "git", pathDirs: PATH_DIRS, fallback: [] })).toEqual([
      "/opt/homebrew/bin/git",
      "/usr/bin/git",
      "/bin/git",
    ]);
  });

  /**
   * The point of the whole exercise. `/usr/bin/git` and `/usr/bin/python3` are
   * Apple's developer-tool stubs, and they sit in a directory that is on every
   * PATH — so they have to be pulled out of that pass, not merely left off the
   * end of the list.
   */
  it("moves a stub to the back even though PATH puts it in the middle", () => {
    expect(paths({ name: "git", pathDirs: PATH_DIRS, fallback: FALLBACK })).toEqual([
      "/opt/homebrew/bin/git",
      "/bin/git",
      "/usr/bin/git",
    ]);
  });

  it("still offers the stub, because on a healthy machine it is a real git", () => {
    expect(paths({ name: "git", pathDirs: [], fallback: FALLBACK })).toEqual(["/usr/bin/git"]);
  });

  it("falls back to the known install locations after PATH", () => {
    expect(
      paths({
        name: "python3",
        pathDirs: ["/usr/local/bin"],
        known: ["/opt/homebrew/bin/python3"],
        fallback: ["/usr/bin/python3"],
      }),
    ).toEqual(["/usr/local/bin/python3", "/opt/homebrew/bin/python3", "/usr/bin/python3"]);
  });

  it("names each path once, however many lists it appears in", () => {
    const found = paths({
      name: "git",
      configured: "/opt/homebrew/bin/git",
      pathDirs: ["/opt/homebrew/bin", "/opt/homebrew/bin"],
      known: ["/opt/homebrew/bin/git"],
    });
    expect(found).toEqual(["/opt/homebrew/bin/git"]);
  });

  it("tolerates a trailing slash on a PATH entry", () => {
    expect(paths({ name: "git", pathDirs: ["/usr/local/bin/"] })).toEqual(["/usr/local/bin/git"]);
  });

  it("adds the extension on Windows", () => {
    expect(
      paths({ name: "git", pathDirs: ["C:/Program Files/Git/cmd"], exeSuffix: ".exe" }),
    ).toEqual(["C:/Program Files/Git/cmd/git.exe"]);
  });
});

describe("resolving against a probe", () => {
  const request = (probe: (path: string) => Promise<boolean>) => ({
    name: "python3",
    pathDirs: PATH_DIRS,
    fallback: ["/usr/bin/python3"],
    probe,
  });

  it("takes the first candidate that answers", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn((path: string) => Promise.resolve(path === "/bin/python3"));
    const { binary } = await resolver.resolve(request(probe));
    expect(binary).toEqual({ path: "/bin/python3", source: "path" });
  });

  /**
   * A candidate that exists but cannot do the job is not a candidate. This is
   * the case the old code got wrong: it found the stub and used it.
   */
  it("walks past one that exists but cannot answer", async () => {
    const resolver = new BinaryResolver();
    const broken = new Set(["/opt/homebrew/bin/python3"]);
    const probe = vi.fn((path: string) => Promise.resolve(!broken.has(path)));
    const { binary, tried } = await resolver.resolve(request(probe));
    expect(tried[0]).toBe("/opt/homebrew/bin/python3");
    expect(binary?.path).toBe("/bin/python3");
  });

  it("stops probing once something answered", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn(() => Promise.resolve(true));
    await resolver.resolve(request(probe));
    expect(probe).toHaveBeenCalledOnce();
  });

  /** The list the error message is built from, so it has to be complete. */
  it("reports everything it tried when nothing answered", async () => {
    const resolver = new BinaryResolver();
    const { binary, tried } = await resolver.resolve(request(() => Promise.resolve(false)));
    expect(binary).toBeNull();
    expect(tried).toEqual(["/opt/homebrew/bin/python3", "/bin/python3", "/usr/bin/python3"]);
  });

  it("probes once and answers from the cache after that", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn(() => Promise.resolve(true));
    await resolver.resolve(request(probe));
    await resolver.resolve(request(probe));
    expect(probe).toHaveBeenCalledOnce();
  });

  it("shares one round of probing between callers that arrive together", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn(() => Promise.resolve(true));
    await Promise.all([resolver.resolve(request(probe)), resolver.resolve(request(probe))]);
    expect(probe).toHaveBeenCalledOnce();
  });

  it("remembers a failure too, rather than walking the list on every session", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn(() => Promise.resolve(false));
    await resolver.resolve(request(probe));
    await resolver.resolve(request(probe));
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("starts over once the settings changed", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn(() => Promise.resolve(true));
    await resolver.resolve(request(probe));
    resolver.invalidate();
    await resolver.resolve(request(probe));
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("treats a different configured path as a different question", async () => {
    const resolver = new BinaryResolver();
    const probe = vi.fn(() => Promise.resolve(true));
    await resolver.resolve({ ...request(probe), configured: "/one/python3" });
    await resolver.resolve({ ...request(probe), configured: "/two/python3" });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { selectBackend } from "../src/terminal/pty-selector";
import type { Resolution } from "../src/utils/binary-resolver";

const found = (path: string): Resolution => ({
  binary: { path, source: "path" },
  tried: [path],
});
const nothing = (tried: string[]): Resolution => ({ binary: null, tried });

/** A resolver where only the named interpreters answer. */
const answers = (...working: string[]) =>
  vi.fn((interpreter: "python3" | "perl") =>
    Promise.resolve(
      working.includes(interpreter)
        ? found(`/opt/homebrew/bin/${interpreter}`)
        : nothing([`/usr/bin/${interpreter}`, `/opt/homebrew/bin/${interpreter}`]),
    ),
  );

describe("choosing a backend", () => {
  it("takes python when it answers, and asks nothing else", async () => {
    const resolve = answers("python3");
    const selected = await selectBackend({ platform: "mac", preference: "auto", resolve });
    expect(selected.spec.id).toBe("python");
    expect(selected.interpreter).toBe("/opt/homebrew/bin/python3");
    expect(resolve).toHaveBeenCalledOnce();
  });

  /** The case this whole change exists for: python is there and unusable. */
  it("falls through to perl when no python can open a pty", async () => {
    const selected = await selectBackend({
      platform: "mac",
      preference: "auto",
      resolve: answers("perl"),
    });
    expect(selected.spec.id).toBe("perl");
    expect(selected.spec.capabilities.tty).toBe(true);
  });

  it("ends on pipes rather than on nothing when neither answers", async () => {
    const selected = await selectBackend({
      platform: "mac",
      preference: "auto",
      resolve: answers(),
    });
    expect(selected.spec.id).toBe("pipe");
    expect(selected.spec.capabilities.tty).toBe(false);
  });

  it("does not offer perl away from macOS", async () => {
    const resolve = answers("perl");
    const selected = await selectBackend({ platform: "linux", preference: "auto", resolve });
    expect(selected.spec.id).toBe("pipe");
    expect(resolve).toHaveBeenCalledExactlyOnceWith("python3");
  });

  it("has only pipes to offer on Windows", async () => {
    const resolve = answers("python3");
    const selected = await selectBackend({ platform: "win", preference: "auto", resolve });
    expect(selected.spec.id).toBe("pipe");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("a backend chosen in the settings", () => {
  it("is tried before the others", async () => {
    const selected = await selectBackend({
      platform: "mac",
      preference: "perl",
      resolve: answers("python3", "perl"),
    });
    expect(selected.spec.id).toBe("perl");
  });

  /**
   * A preference is a preference, not a promise: someone who pinned Perl and
   * then removed it should get a working terminal and a report saying why,
   * rather than a panel refusing to open.
   */
  it("does not take the terminal down with it when it cannot run", async () => {
    const selected = await selectBackend({
      platform: "mac",
      preference: "perl",
      resolve: answers("python3"),
    });
    expect(selected.spec.id).toBe("python");
    expect(selected.attempts[0]).toMatchObject({ id: "perl", skipped: expect.any(String) });
  });
});

describe("the record of what was tried", () => {
  it("names every backend passed over and why", async () => {
    const selected = await selectBackend({
      platform: "mac",
      preference: "auto",
      resolve: answers(),
    });
    const skipped = selected.attempts.filter((a) => a.skipped);
    expect(skipped.map((a) => a.id)).toEqual(["python", "perl"]);
    expect(skipped[0].skipped).toMatch(/no working python3 answered \(2 tried\)/);
    expect(skipped[0].tried).toHaveLength(2);
  });

  it("marks the one actually in use as not skipped", async () => {
    const selected = await selectBackend({
      platform: "mac",
      preference: "auto",
      resolve: answers("python3"),
    });
    const used = selected.attempts[selected.attempts.length - 1];
    expect(used).toMatchObject({ id: "python", skipped: null });
    expect(used.interpreter).toBe("/opt/homebrew/bin/python3");
  });
});

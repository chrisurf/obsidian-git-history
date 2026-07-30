// @vitest-environment node
import { describe, it, expect } from "vitest";
import { resolveTemplate } from "../src/utils/template";

describe("resolveTemplate", () => {
  it("replaces {{date}} with today's ISO date", () => {
    const result = resolveTemplate("backup {{date}}");
    const today = new Date().toISOString().split("T")[0];
    expect(result).toBe(`backup ${today}`);
  });

  it("replaces multiple {{date}} occurrences", () => {
    const result = resolveTemplate("{{date}} - {{date}}");
    const today = new Date().toISOString().split("T")[0];
    expect(result).toBe(`${today} - ${today}`);
  });

  it("returns the string unchanged when no placeholders are present", () => {
    expect(resolveTemplate("plain commit")).toBe("plain commit");
  });
});

import { describe, it, expect } from "vitest";
import { MIN_SHARED, pairLines, wordDiff } from "../src/utils/word-diff";
import type { Segment } from "../src/utils/word-diff";
import type { DiffLine } from "../src/types";

/** The marked stretches only, which is what a reader's eye goes to. */
const changed = (segments: Segment[]): string[] =>
  segments.filter((s) => s.changed).map((s) => s.value);

const joined = (segments: Segment[]): string => segments.map((s) => s.value).join("");

describe("wordDiff", () => {
  it("marks whole words, umlauts included", () => {
    const words = wordDiff("aber **überladen**: Es", "aber **überfrachtet**: Es");

    expect(words).not.toBeNull();
    expect(changed(words!.old)).toEqual(["überladen"]);
    expect(changed(words!.new)).toEqual(["überfrachtet"]);
  });

  it("marks a replacement of several words as one stretch", () => {
    const words = wordDiff("Chunk-Verfahren usw. Genau", "Chunk-Verfahren und so weiter. Genau");

    expect(changed(words!.old)).toEqual(["usw"]);
    expect(changed(words!.new)).toEqual(["und so weiter"]);
  });

  it("keeps every character of both lines, in order", () => {
    const before = "Kurze Zeile mit Ballast drumherum.";
    const after = "Kurze Zeile mit weniger Ballast drumherum. ";
    const words = wordDiff(before, after)!;

    expect(joined(words.old)).toBe(before);
    expect(joined(words.new)).toBe(after);
  });

  it("marks a change that is only whitespace", () => {
    const words = wordDiff("Ende.", "Ende. ");

    expect(changed(words!.new)).toEqual([" "]);
  });

  it("marks a change deep inside a paragraph far longer than a screen", () => {
    // The previous comparison gave up above 500 words and spaces, and then
    // marked the whole line; an Obsidian paragraph gets there at ~1300 chars.
    const sentence = "Das Plugin ist technisch hervorragend, aber überladen. ";
    const before = sentence.repeat(80);
    const after = before.replace(/überladen(?=\. $)/, "schlank");

    const words = wordDiff(before, after);

    expect(before.length).toBeGreaterThan(4000);
    expect(changed(words!.old)).toEqual(["überladen"]);
    expect(changed(words!.new)).toEqual(["schlank"]);
  });

  it("marks nothing in lines that have too little in common", () => {
    expect(wordDiff("Einkaufsliste für morgen", "function render() { return 1; }")).toBeNull();
  });

  it(`draws the line at ${MIN_SHARED * 100}% shared text, spaces not counted`, () => {
    // Four of ten visible characters shared: related enough to mark.
    expect(wordDiff("aaaa bbbbbb", "aaaa cccccc")).not.toBeNull();
    // Three of ten: not.
    expect(wordDiff("aaa bbbbbbb", "aaa ccccccc")).toBeNull();
  });

  it("has nothing to mark in two empty lines", () => {
    expect(wordDiff("", "")).toBeNull();
  });
});

describe("pairLines", () => {
  const line = (type: DiffLine["type"], content: string): DiffLine => ({ type, content });

  it("pairs removed lines with the added lines after them, in order", () => {
    const pairs = pairLines([
      line("context", "a"),
      line("del", "b"),
      line("del", "c"),
      line("add", "B"),
      line("context", "d"),
    ]);

    expect(pairs.map((p) => [p.type, p.left?.content, p.right?.content])).toEqual([
      ["context", "a", undefined],
      ["modify", "b", "B"],
      ["del", "c", undefined],
      ["context", "d", undefined],
    ]);
  });

  it("leaves added lines without a removed line unpaired", () => {
    const pairs = pairLines([line("add", "x"), line("add", "y")]);
    expect(pairs.map((p) => p.type)).toEqual(["add", "add"]);
  });
});

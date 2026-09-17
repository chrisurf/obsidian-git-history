import { diffWordsWithSpace } from "diff";
import type { DiffLine } from "../types";

/** A stretch of one line's text, and whether it is part of what changed. */
export interface Segment {
  value: string;
  changed: boolean;
}

export interface WordDiff {
  old: Segment[];
  new: Segment[];
}

/**
 * A row of the diff: an unchanged line, a removed line shown against the line
 * that replaced it, or a line removed or added with nothing opposite.
 */
export interface LinePair {
  type: "context" | "modify" | "add" | "del";
  left?: DiffLine;
  right?: DiffLine;
}

/**
 * Below this share of common text, two lines are treated as unrelated: marking
 * the few words they happen to share would highlight nearly the whole line and
 * say less than the line colour already does.
 */
export const MIN_SHARED = 0.4;

/** A word diff that takes longer than this is dropped rather than waited for. */
export const WORD_DIFF_TIMEOUT_MS = 50;

/**
 * Pairs each run of removed lines with the run of added lines after it, in
 * order, so a changed line can be shown next to its replacement. Whatever is
 * left over on either side stays unpaired.
 */
export function pairLines(lines: readonly DiffLine[]): LinePair[] {
  const result: LinePair[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i].type === "context") {
      result.push({ type: "context", left: lines[i] });
      i++;
      continue;
    }

    const delStart = i;
    while (i < lines.length && lines[i].type === "del") i++;
    const dels = lines.slice(delStart, i);

    const addStart = i;
    while (i < lines.length && lines[i].type === "add") i++;
    const adds = lines.slice(addStart, i);

    const pairCount = Math.min(dels.length, adds.length);
    for (let j = 0; j < pairCount; j++) {
      result.push({ type: "modify", left: dels[j], right: adds[j] });
    }
    for (let j = pairCount; j < dels.length; j++) {
      result.push({ type: "del", left: dels[j] });
    }
    for (let j = pairCount; j < adds.length; j++) {
      result.push({ type: "add", right: adds[j] });
    }
  }

  return result;
}

/**
 * The words that differ between the old and the new version of a line, or
 * null when there is nothing worth marking: the lines have too little in
 * common, or comparing them took too long.
 *
 * Words are compared whole, letters beyond ASCII included, so a change to
 * "überladen" marks that word rather than "berladen" next to an unmarked "ü".
 * Whitespace is compared too, since a changed indent or a trailing space is
 * exactly the change nothing else on screen would show.
 */
export function wordDiff(oldText: string, newText: string): WordDiff | null {
  const parts = diffWordsWithSpace(oldText, newText, { timeout: WORD_DIFF_TIMEOUT_MS });
  if (!parts) return null;

  const oldSegs: Segment[] = [];
  const newSegs: Segment[] = [];
  let shared = 0;
  for (const part of parts) {
    if (part.removed) {
      push(oldSegs, part.value, true);
    } else if (part.added) {
      push(newSegs, part.value, true);
    } else {
      push(oldSegs, part.value, false);
      push(newSegs, part.value, false);
      shared += visibleLength(part.value);
    }
  }

  // Whitespace is left out of the share: two unrelated sentences have their
  // spaces in common, and that would pass them off as related.
  const longer = Math.max(visibleLength(oldText), visibleLength(newText));
  if (longer === 0 || shared / longer < MIN_SHARED) return null;
  return { old: oldSegs, new: newSegs };
}

/** Appends to the last segment when it has the same state, so runs stay whole. */
function push(segments: Segment[], value: string, changed: boolean): void {
  const last = segments[segments.length - 1];
  if (last && last.changed === changed) last.value += value;
  else segments.push({ value, changed });
}

function visibleLength(text: string): number {
  return text.replace(/\s/g, "").length;
}

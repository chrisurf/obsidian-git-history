// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * A few rules carry behaviour, not just looks, and no DOM test can catch them:
 * happy-dom does not do hit testing, so a rule that swallows clicks passes every
 * interaction test while the real plugin is unusable.
 */

const css = readFileSync(fileURLToPath(new URL("../styles.css", import.meta.url)), "utf8");

function ruleBody(selector: string): string {
  const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`rule ${selector} not found in styles.css`);
  return match[1];
}

describe("styles.css behavioural rules", () => {
  it("keeps the view interactive while it is loading", () => {
    // .gs-loading is toggled on the Source Control root during every background
    // refresh. pointer-events: none here made Stage All (and every other button)
    // do nothing on an active vault.
    expect(ruleBody(".gs-loading")).not.toMatch(/pointer-events\s*:\s*none/);
  });

  it("keeps section action buttons clickable even though they fade in on hover", () => {
    // opacity: 0 still receives clicks; pointer-events: none would not.
    expect(ruleBody(".gs-section-actions")).not.toMatch(/pointer-events\s*:\s*none/);
  });
});

describe("styles.css — the expanded commit card", () => {
  const zIndex = (selector: string): number => {
    const match = ruleBody(selector).match(/z-index\s*:\s*(\d+)/);
    if (!match) throw new Error(`${selector} has no z-index`);
    return parseInt(match[1], 10);
  };

  it("paints above the commit rows and the graph lanes", () => {
    // The card overlays the rows below the clicked one. A lower z-index lets
    // their text bleed through it, which is unreadable rather than merely ugly.
    expect(zIndex(".gs-commit-popup")).toBeGreaterThan(zIndex(".gs-graph-tbody"));
    expect(zIndex(".gs-commit-popup")).toBeGreaterThan(zIndex(".gs-graph-svg"));
  });

  it("carries an opaque colour layer under the accent wash", () => {
    // The wash on its own is translucent; without the colour beneath it the
    // card would take the list background and stop reading as a panel.
    const body = ruleBody(".gs-commit-popup");
    expect(body).toMatch(/var\(--gs-bg2\)/);
    expect(body).not.toMatch(/background\s*:\s*(transparent|none)\s*;/);
  });

  it("starts after the branch and graph columns so the lane stays visible", () => {
    expect(ruleBody(".gs-commit-popup")).toMatch(/left\s*:\s*calc\(/);
  });
});

import { setIcon } from "obsidian";
import type { BackendAttempt } from "../terminal/pty-selector";

/**
 * What is shown when a shell never started.
 *
 * The panel exists because of what used to be there instead: a page of
 * `xcode-select` and dyld output ending in `[Process exited with code 72]`,
 * dumped into the terminal with nothing to say which part of it was the
 * plugin's doing. Everything a reader needs to act is here — which backend was
 * used, which binary it ran, what else was tried, and what the process printed
 * before it gave up — with the raw output kept last, because it is evidence
 * rather than an explanation.
 */

export interface StartupFailure {
  /** Human-readable backend name, e.g. "Python". */
  backend: string;
  /** The interpreter that was run, or "" when the backend needed none. */
  interpreter: string;
  /** Everything the process wrote before it closed. */
  output: string;
  /** How the backend was chosen, and what was passed over on the way. */
  attempts: readonly BackendAttempt[];
  /** Set when the process stayed alive but never reported a ready terminal. */
  timedOut: boolean;
}

export interface StartupErrorActions {
  onRetry: () => void;
  onOpenSettings: () => void;
  onCheckSetup: () => void;
}

export function renderStartupError(
  parent: HTMLElement,
  failure: StartupFailure,
  actions: StartupErrorActions,
): HTMLElement {
  const panel = parent.createDiv("gs-terminal-error");

  const header = panel.createDiv("gs-terminal-error-header");
  const icon = header.createSpan("gs-terminal-error-icon");
  setIcon(icon, "alert-triangle");
  header.createEl("h3", {
    cls: "gs-terminal-error-title",
    text: failure.timedOut ? "The shell did not report a terminal" : "The shell did not start",
  });

  panel.createEl("p", {
    cls: "gs-terminal-error-lead",
    text: failure.timedOut
      ? `The ${failure.backend} bridge was started but never opened a terminal. ` +
        "That usually means the interpreter is running but cannot allocate one."
      : `The ${failure.backend} bridge ended before it could open a terminal. ` +
        "This is a problem with that program, not with your vault or your repository.",
  });

  const facts = panel.createEl("dl", { cls: "gs-terminal-error-facts" });
  addFact(facts, "Backend", failure.backend);
  if (failure.interpreter) addFact(facts, "Ran", failure.interpreter);

  const passedOver = failure.attempts.filter((attempt) => attempt.skipped);
  for (const attempt of passedOver) {
    addFact(facts, `${attempt.label} skipped`, attempt.skipped ?? "");
  }

  if (failure.output.trim()) {
    panel.createEl("p", {
      cls: "gs-terminal-error-subhead",
      text: "What it printed",
    });
    panel.createEl("pre", {
      cls: "gs-terminal-error-output",
      text: failure.output.trim(),
    });
  }

  const buttons = panel.createDiv("gs-terminal-error-actions");
  addButton(buttons, "Try again", "rotate-cw", actions.onRetry, true);
  addButton(buttons, "Check setup", "stethoscope", actions.onCheckSetup, false);
  addButton(buttons, "Settings", "settings", actions.onOpenSettings, false);

  return panel;
}

function addFact(list: HTMLElement, term: string, value: string): void {
  list.createEl("dt", { text: term });
  list.createEl("dd", { text: value });
}

function addButton(
  parent: HTMLElement,
  label: string,
  icon: string,
  onClick: () => void,
  primary: boolean,
): void {
  const button = parent.createEl("button", { cls: "gs-terminal-error-button" });
  button.toggleClass("mod-cta", primary);
  const glyph = button.createSpan("gs-terminal-error-button-icon");
  setIcon(glyph, icon);
  button.createSpan({ text: label });
  button.addEventListener("click", onClick);
}

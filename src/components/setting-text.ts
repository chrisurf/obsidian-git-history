/**
 * The description half of a settings row, built rather than written.
 *
 * Every row in this tab has the same shape to say: what the setting is, and —
 * for the rows whose value comes from git rather than from the plugin — where
 * that value is right now. Written as one long sentence, the second half is
 * the part nobody reads, and it is the half that decides what an edit does.
 *
 * So it is a badge: three words the eye finds, coloured by what it means, with
 * the detail behind it in a line of its own. The settings row gives the
 * description column, the framework puts it under the name in every Obsidian
 * version, and nothing here positions anything by hand.
 */

export type Tone = "neutral" | "accent" | "warning";

export interface Badge {
  label: string;
  tone: Tone;
  detail: string | null;
}

/**
 * One description: the sentence, then the second line.
 *
 * The second line is either a badge — for a value that comes from git and
 * whose origin decides what an edit does — or plain text, for the caveat a
 * plugin setting carries. Both end up in the same dimmer line, so rows of both
 * kinds read as one list.
 */
export function describeSetting(text: string, extra?: Badge | string | null): DocumentFragment {
  return createFragment((fragment) => {
    fragment.createDiv({ cls: "gs-setting-text", text });
    if (!extra) return;

    const line = fragment.createDiv("gs-setting-status");
    if (typeof extra === "string") {
      line.createSpan({ cls: "gs-setting-detail", text: extra });
      return;
    }
    line.createSpan({ cls: `gs-badge gs-badge-${extra.tone}`, text: extra.label });
    if (extra.detail) line.createSpan({ cls: "gs-setting-detail", text: extra.detail });
  });
}

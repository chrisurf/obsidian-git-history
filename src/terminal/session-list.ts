/**
 * Order, naming and activation of the terminal sessions.
 *
 * Everything here is plain data: no DOM, no xterm, no child process. That half
 * lives in TerminalSession, which needs a real browser and can only be covered
 * end to end — this half is where the decisions are ("which session takes over
 * when the active one closes"), so it is kept where a unit test can reach it.
 */
export interface SessionEntry {
  id: string;
  name: string;
}

export class SessionList {
  private entries: SessionEntry[] = [];
  private active: string | null = null;
  private nextId = 1;

  get sessions(): readonly SessionEntry[] {
    return this.entries;
  }

  get activeId(): string | null {
    return this.active;
  }

  get size(): number {
    return this.entries.length;
  }

  activeEntry(): SessionEntry | null {
    return this.entries.find((e) => e.id === this.active) ?? null;
  }

  entry(id: string): SessionEntry | null {
    return this.entries.find((e) => e.id === id) ?? null;
  }

  indexOf(id: string): number {
    return this.entries.findIndex((e) => e.id === id);
  }

  add(baseName: string): SessionEntry {
    const entry: SessionEntry = { id: `t${this.nextId++}`, name: this.freeName(baseName) };
    this.entries.push(entry);
    this.active = entry.id;
    return entry;
  }

  /**
   * Numbers a repeated shell name the way VS Code does, reusing the lowest free
   * number: opening and closing sessions all day should not drift the list into
   * "zsh (14)" while only two are open.
   */
  private freeName(base: string): string {
    const taken = new Set(this.entries.map((e) => e.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base} (${n})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * Removes a session and hands back what was removed. The neighbour to the
   * right takes over, or the one to the left when the last entry went — never
   * "nothing active" while sessions are left.
   */
  close(id: string): SessionEntry | null {
    const index = this.indexOf(id);
    if (index < 0) return null;
    const [removed] = this.entries.splice(index, 1);
    if (this.active === id) {
      this.active = (this.entries[index] ?? this.entries[index - 1] ?? null)?.id ?? null;
    }
    return removed;
  }

  activate(id: string): boolean {
    if (this.indexOf(id) < 0) return false;
    this.active = id;
    return true;
  }

  /** Moves a session within the strip. Out-of-range indexes are ignored. */
  move(from: number, to: number): boolean {
    if (from === to) return false;
    if (from < 0 || from >= this.entries.length) return false;
    if (to < 0 || to >= this.entries.length) return false;
    const [moved] = this.entries.splice(from, 1);
    this.entries.splice(to, 0, moved);
    return true;
  }

  rename(id: string, name: string): boolean {
    const entry = this.entry(id);
    const trimmed = name.trim();
    if (!entry || !trimmed) return false;
    entry.name = trimmed;
    return true;
  }

  /** Ids of every session but the given one, for "close the others". */
  others(id: string): string[] {
    return this.entries.filter((e) => e.id !== id).map((e) => e.id);
  }

  clear(): void {
    this.entries = [];
    this.active = null;
  }
}

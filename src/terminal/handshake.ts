/**
 * Telling "the shell exited" apart from "the shell never started".
 *
 * Both used to look identical from the outside: a process that wrote something
 * and closed, reported as `[Process exited with code 72]` under a page of
 * developer-tool output. Nothing in that says the bridge never got as far as
 * opening a pty, which is the one thing the reader needs to know.
 *
 * So the bridges announce themselves. Everything a backend writes is held back
 * until the marker arrives; once it does, the announcement is swallowed and the
 * rest goes to the terminal as usual. A process that closes while this is still
 * holding output never started, and what it wrote is the explanation.
 *
 * Bytes rather than text throughout: the marker is ASCII and arrives first, but
 * what follows it is a shell's output, and decoding that in pieces would cut
 * multi-byte characters in half.
 */

/** Stops waiting after this much, so a backend that never announces itself
 *  still shows whatever it did write instead of an empty panel. */
const DEFAULT_LIMIT = 64 * 1024;

export class HandshakeBuffer {
  private marker: Uint8Array;
  private buffer = new Uint8Array(0);
  private settled = false;

  constructor(
    marker: string,
    private limit = DEFAULT_LIMIT,
  ) {
    this.marker = Uint8Array.from(marker, (c) => c.charCodeAt(0));
  }

  /** Whether the marker has arrived, or waiting was given up on. */
  get ready(): boolean {
    return this.settled;
  }

  /**
   * Takes a chunk and hands back what the terminal should show, or null while
   * the marker has not arrived yet and nothing should be shown at all.
   */
  push(chunk: Uint8Array): Uint8Array | null {
    if (this.settled) return chunk;

    this.append(chunk);
    const at = indexOf(this.buffer, this.marker);
    if (at < 0) return this.buffer.length >= this.limit ? this.flush() : null;

    this.settled = true;
    const rest = this.buffer.slice(at + this.marker.length);
    this.buffer = new Uint8Array(0);
    return rest;
  }

  /** Gives up waiting and releases everything held so far. */
  flush(): Uint8Array {
    this.settled = true;
    const all = this.buffer;
    this.buffer = new Uint8Array(0);
    return all;
  }

  /** What was held back, as text, for the failure panel. */
  text(): string {
    return new TextDecoder().decode(this.buffer);
  }

  private append(chunk: Uint8Array): void {
    const grown = new Uint8Array(this.buffer.length + chunk.length);
    grown.set(this.buffer);
    grown.set(chunk, this.buffer.length);
    this.buffer = grown;
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

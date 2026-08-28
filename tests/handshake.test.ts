// @vitest-environment node
import { describe, it, expect } from "vitest";
import { HandshakeBuffer } from "../src/terminal/handshake";

const MARKER = "]7771;gh-ready";
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (data: Uint8Array | null): string | null =>
  data === null ? null : new TextDecoder().decode(data);

describe("waiting for a bridge to announce itself", () => {
  it("shows nothing while the marker has not arrived", () => {
    const buffer = new HandshakeBuffer(MARKER);
    expect(buffer.push(bytes("xcode-select: error"))).toBeNull();
    expect(buffer.ready).toBe(false);
  });

  it("releases what follows the marker, and swallows the marker itself", () => {
    const buffer = new HandshakeBuffer(MARKER);
    expect(text(buffer.push(bytes(`${MARKER}chris@vault % `)))).toBe("chris@vault % ");
    expect(buffer.ready).toBe(true);
  });

  /** A pipe splits where it likes, and the marker is the first thing written. */
  it("finds a marker split across two chunks", () => {
    const buffer = new HandshakeBuffer(MARKER);
    expect(buffer.push(bytes("]7771;gh-"))).toBeNull();
    expect(text(buffer.push(bytes("ready$ ")))).toBe("$ ");
  });

  it("passes everything straight through once it is ready", () => {
    const buffer = new HandshakeBuffer(MARKER);
    buffer.push(bytes(MARKER));
    expect(text(buffer.push(bytes("ls -la")))).toBe("ls -la");
  });

  /**
   * What the failure panel is built from: everything the process wrote while
   * the session was still waiting for a terminal that never came.
   */
  it("keeps what it held back, for the failure panel", () => {
    const buffer = new HandshakeBuffer(MARKER);
    buffer.push(bytes("Symbol not found: _XPCTypeBool\n"));
    buffer.push(bytes("Abort trap: 6"));
    expect(buffer.text()).toBe("Symbol not found: _XPCTypeBool\nAbort trap: 6");
  });

  /**
   * A backend that talks but never announces itself would otherwise hold its
   * whole output forever, which reads as a terminal that hung.
   */
  it("gives up holding output once too much of it piled up", () => {
    const buffer = new HandshakeBuffer(MARKER, 8);
    expect(buffer.push(bytes("1234"))).toBeNull();
    expect(text(buffer.push(bytes("5678")))).toBe("12345678");
    expect(buffer.ready).toBe(true);
  });

  /**
   * Bytes go through untouched rather than being decoded on the way, so a
   * character split across two reads is xterm's problem to reassemble — which
   * it can — instead of being cut in half here, which nothing could undo.
   */
  it("hands on bytes rather than decoded text", () => {
    const buffer = new HandshakeBuffer(MARKER);
    const euro = bytes("€");
    const first = buffer.push(new Uint8Array([...bytes(MARKER), ...euro.slice(0, 1)]));
    const second = buffer.push(euro.slice(1));
    expect(text(new Uint8Array([...(first ?? []), ...(second ?? [])]))).toBe("€");
  });
});

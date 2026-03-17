import { describe, expect, test } from "bun:test";

import type { TerminalFrame } from "../shared/protocol";
import { buildTerminalModePrefix, prependTerminalModePrefix, terminalModeStateKey } from "./terminalModes";

function frame(overrides: Partial<TerminalFrame> = {}): TerminalFrame {
  return {
    id: "term-1",
    cols: 120,
    rows: 40,
    seq: 1,
    chunk: "",
    vt: "",
    previewLines: [],
    altScreen: false,
    cursorVisible: true,
    cursorStyle: "block",
    cursorBlink: true,
    cursorRow: 1,
    cursorCol: 1,
    mouseTrackingMode: "none",
    mouseFormat: "x10",
    focusEvent: false,
    mouseAlternateScroll: false,
    ...overrides,
  };
}

describe("terminalModeStateKey", () => {
  test("captures mouse and focus state", () => {
    expect(
      terminalModeStateKey(frame({ mouseTrackingMode: "button", mouseFormat: "sgr", focusEvent: true })),
    ).toBe("button:sgr:1:0");
  });
});

describe("buildTerminalModePrefix", () => {
  test("enables sgr mouse tracking and alternate scroll", () => {
    const prefix = buildTerminalModePrefix(
      frame({ mouseTrackingMode: "button", mouseFormat: "sgr", focusEvent: true, mouseAlternateScroll: true }),
    );

    expect(prefix).toContain("\u001b[?1002h");
    expect(prefix).toContain("\u001b[?1006h");
    expect(prefix).toContain("\u001b[?1004h");
    expect(prefix).toContain("\u001b[?1007h");
  });
});

describe("prependTerminalModePrefix", () => {
  test("prepends prefixes to string payloads", () => {
    const prefixed = prependTerminalModePrefix("abc", frame({ mouseTrackingMode: "normal" }));

    expect(typeof prefixed).toBe("string");
    expect(prefixed).toContain("\u001b[?1000h");
    expect((prefixed as string).endsWith("abc")).toBe(true);
  });

  test("prepends prefixes to binary payloads", () => {
    const prefixed = prependTerminalModePrefix(new Uint8Array([65, 66, 67]), frame({ mouseFormat: "sgr" }));

    expect(prefixed).toBeInstanceOf(Uint8Array);
    expect((prefixed as Uint8Array).length).toBeGreaterThan(3);
  });
});

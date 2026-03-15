import { describe, expect, test } from "bun:test";

import { decodeTerminalFramePacket, encodeTerminalFramePacket, type TerminalFrame } from "./protocol";

describe("terminal frame binary packet", () => {
  test("round-trips a full frame", () => {
    const frame: TerminalFrame = {
      id: "term-7",
      cols: 120,
      rows: 36,
      seq: 42,
      cwd: "/tmp/demo",
      screenMode: "full",
      screenRows: [
        { index: 0, text: "hello" },
        { index: 1, text: "world" },
      ],
      renderVt: "\u001b[Hhello",
      renderPatchVt: undefined,
      renderPatchKind: undefined,
      altScreen: true,
      chunk: "hello",
      vt: "hello\nworld",
      previewLines: ["hello", "world"],
      cursorVisible: true,
      cursorStyle: "block",
      cursorBlink: false,
      cursorRow: 4,
      cursorCol: 9,
      mouseTrackingMode: "button",
      mouseFormat: "sgr",
      focusEvent: true,
      mouseAlternateScroll: false,
      shellBusy: true,
      shellBusyAtMs: 123456,
    };

    expect(decodeTerminalFramePacket(encodeTerminalFramePacket(frame))).toEqual(frame);
  });

  test("round-trips a sparse patch frame", () => {
    const frame: TerminalFrame = {
      id: "term-2",
      cols: 80,
      rows: 24,
      seq: 7,
      screenMode: "patch",
      screenRows: [{ index: 3, text: "prompt> " }],
      chunk: "",
      vt: "",
      previewLines: [],
      renderPatchVt: "\u001b[4;12H",
      renderPatchKind: "cursor-only",
    };

    expect(decodeTerminalFramePacket(encodeTerminalFramePacket(frame))).toEqual(frame);
  });
});

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
      imageDefinitions: [
        {
          id: 5,
          width: 2,
          height: 1,
          format: "rgba",
          data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]),
        },
      ],
      imageRemovedIds: [3],
      imagePlacements: [
        {
          imageId: 5,
          screenX: 10,
          screenY: 24,
          z: -1,
          cellOffsetX: 1,
          cellOffsetY: 2,
          sourceX: 0,
          sourceY: 0,
          sourceWidth: 2,
          sourceHeight: 1,
          columns: 4,
          rows: 0,
          pixelWidth: 96,
          pixelHeight: 44,
        },
      ],
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
      bracketedPasteMode: true,
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
      imagePlacements: [
        {
          imageId: 9,
          screenX: 0,
          screenY: 3,
          z: 4,
          cellOffsetX: 0,
          cellOffsetY: 0,
          sourceX: 0,
          sourceY: 0,
          sourceWidth: 40,
          sourceHeight: 20,
          columns: 0,
          rows: 0,
          pixelWidth: 22,
          pixelHeight: 18,
        },
      ],
    };

    expect(decodeTerminalFramePacket(encodeTerminalFramePacket(frame))).toEqual(frame);
  });

  test("preserves an explicit empty image placement snapshot", () => {
    const frame: TerminalFrame = {
      id: "term-3",
      cols: 80,
      rows: 24,
      seq: 8,
      screenMode: "patch",
      chunk: "",
      vt: "",
      previewLines: [],
      imagePlacements: [],
    };

    expect(decodeTerminalFramePacket(encodeTerminalFramePacket(frame))).toEqual(frame);
  });
});

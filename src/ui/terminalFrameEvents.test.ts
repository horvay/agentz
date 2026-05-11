import { describe, expect, test } from "bun:test";

import type { TerminalFrame } from "../shared/protocol";
import { splitTerminalFrameEvents } from "./terminalFrameEvents";

function frame(overrides: Partial<TerminalFrame> = {}): TerminalFrame {
  return {
    id: "term-1",
    cols: 80,
    rows: 24,
    seq: 1,
    chunk: "",
    vt: "",
    previewLines: [],
    ...overrides,
  };
}

describe("terminal frame event splitting", () => {
  test("keeps metadata-only frames out of the render path", () => {
    const events = splitTerminalFrameEvents(frame({ cwd: "/tmp", frameCause: "metadata" }));

    expect(events.metadata?.type).toBe("metadata");
    expect(events.render).toBeUndefined();
    expect(events.images).toBeUndefined();
  });

  test("routes full snapshots to render and preview paths", () => {
    const events = splitTerminalFrameEvents(
      frame({
        screenMode: "full",
        renderVt: "hello",
        previewLines: ["hello"],
        frameCause: "snapshot",
      }),
    );

    expect(events.render?.type).toBe("render");
    expect(events.preview?.type).toBe("preview");
  });

  test("routes image-only updates to render and image paths", () => {
    const events = splitTerminalFrameEvents(frame({ imagePlacements: [] }));

    expect(events.render?.type).toBe("render");
    expect(events.images?.type).toBe("images");
  });
});

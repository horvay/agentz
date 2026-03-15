import { describe, expect, test } from "bun:test";
import { previewLinesForPane, previewTextForPane } from "./panePreview";
import type { TerminalFrame } from "../shared/protocol";

function frame(partial?: Partial<TerminalFrame>): TerminalFrame {
  return {
    id: "term-1",
    cols: 120,
    rows: 36,
    seq: 1,
    chunk: "",
    vt: "",
    previewLines: [],
    ...partial,
  };
}

describe("panePreview", () => {
  test("keeps inactive alt-screen previews readable instead of mostly blank", () => {
    const lines = [
      "",
      "",
      "                                # App performance optimization strategies",
      "",
      "                                High-Impact Optimizations",
      "",
      "                                1. Reduce backend line buffer",
      "",
      "                                2. Fix avatar state polling",
      "",
      "                                3. Optimize frame coalescing",
      "",
      "                                4. Reduce terminal scrollback",
      "",
      "                                5. Add frame rate limiting on backend",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "                                Build Big Pickle OpenCode Zen",
      "                                ........ esc interrupt",
      "",
      "",
    ];

    const text = previewTextForPane(frame({ altScreen: true, shellBusy: true, previewLines: lines }));
    const renderedLines = text.split("\n");

    expect(renderedLines.length).toBeLessThanOrEqual(18);
    expect(text).toContain("# App performance optimization strategies");
    expect(text).toContain("3. Optimize frame coalescing");
    expect(text).toContain("Build Big Pickle OpenCode Zen");
    expect(text).toContain("........ esc interrupt");
    expect(text).not.toContain("\n\n\n\n");
    expect(text).not.toContain("                                # App performance optimization strategies");
  });

  test("compacts blank-heavy alt-screen previews", () => {
    const lines = [
      "",
      "# App performance optimization strategies",
      "",
      "High-Impact Optimizations",
      ...Array.from({ length: 20 }, (_, index) => `item ${index + 1}`),
      "",
      "Build Big Pickle OpenCode Zen",
      "........ esc interrupt",
      "",
    ];

    const preview = previewLinesForPane(frame({ altScreen: true, previewLines: lines }));

    expect(preview[0]).toBe("# App performance optimization strategies");
    expect(preview).toContain("...");
    expect(preview[preview.length - 2]).toBe("Build Big Pickle OpenCode Zen");
    expect(preview[preview.length - 1]).toBe("........ esc interrupt");
  });

  test("keeps shell previews tail-focused", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

    const preview = previewLinesForPane(frame({ altScreen: false, previewLines: lines }));

    expect(preview[0]).toBe("line 13");
    expect(preview[preview.length - 1]).toBe("line 30");
  });

  test("falls back to chunk when preview lines are empty", () => {
    const text = previewTextForPane(frame({ chunk: "hello world" }));
    expect(text).toBe("hello world");
  });
});

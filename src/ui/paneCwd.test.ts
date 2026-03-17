import { describe, expect, test } from "bun:test";

import type { TerminalFrame } from "../shared/protocol";
import { folderLabel, resolveNewPaneCwd, resolvePaneCwdFromFrame } from "./paneCwd";

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

describe("folderLabel", () => {
  test("uses the final segment for Windows paths", () => {
    expect(folderLabel("C:\\Users\\ghorvay\\agentz")).toBe("agentz");
  });

  test("keeps drive roots readable", () => {
    expect(folderLabel("C:\\")).toBe("C:\\");
  });
});

describe("resolvePaneCwdFromFrame", () => {
  test("prefers PowerShell prompt cwd when available", () => {
    expect(
      resolvePaneCwdFromFrame(
        frame({
          cwd: "C:\\Users\\ghorvay",
          previewLines: ["PS C:\\Users\\ghorvay\\agentz> "],
        }),
      ),
    ).toBe("C:\\Users\\ghorvay\\agentz");
  });

  test("keeps PowerShell cwd while typing at the prompt", () => {
    expect(
      resolvePaneCwdFromFrame(
        frame({
          cwd: "C:\\Users\\ghorvay",
          previewLines: ["PS C:\\Users\\ghorvay\\agentz> opencode"],
        }),
      ),
    ).toBe("C:\\Users\\ghorvay\\agentz");
  });

  test("prefers cmd prompt cwd when available", () => {
    expect(
      resolvePaneCwdFromFrame(
        frame({
          cwd: "C:\\Users\\ghorvay",
          previewLines: ["C:\\Users\\ghorvay\\agentz>"],
        }),
      ),
    ).toBe("C:\\Users\\ghorvay\\agentz");
  });

  test("keeps the previous cwd while alt screen is active", () => {
    expect(
      resolvePaneCwdFromFrame(
        frame({
          cwd: "C:\\Users\\ghorvay",
          altScreen: true,
          previewLines: ["PS C:\\Users\\ghorvay\\agentz> "],
        }),
        "C:\\Users\\ghorvay\\agentz",
      ),
    ).toBe("C:\\Users\\ghorvay\\agentz");
  });
});

describe("resolveNewPaneCwd", () => {
  test("uses the active session prompt cwd for new panes", () => {
    expect(
      resolveNewPaneCwd(
        "term-1",
        {},
        {
          "term-1": frame({
            cwd: "C:\\Users\\ghorvay",
            previewLines: ["PS C:\\Users\\ghorvay\\work> "],
          }),
        },
      ),
    ).toBe("C:\\Users\\ghorvay\\work");
  });

  test("uses the currently visible background session cwd", () => {
    expect(
      resolveNewPaneCwd(
        "term-1-bg",
        {},
        {
          "term-1": frame({
            cwd: "C:\\Users\\ghorvay\\main",
            previewLines: ["PS C:\\Users\\ghorvay\\main> "],
          }),
          "term-1-bg": frame({
            cwd: "C:\\Users\\ghorvay\\sidecar",
            previewLines: ["PS C:\\Users\\ghorvay\\sidecar> "],
          }),
        },
      ),
    ).toBe("C:\\Users\\ghorvay\\sidecar");
  });

  test("falls back to the stored cwd when no frame exists yet", () => {
    expect(resolveNewPaneCwd("term-2", { "term-2": "C:\\Users\\ghorvay\\work" }, {})).toBe(
      "C:\\Users\\ghorvay\\work",
    );
  });
});

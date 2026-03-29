import { describe, expect, test } from "bun:test";
import { recoverTerminalLayout } from "./terminalRecovery";

describe("recoverTerminalLayout", () => {
  test("restores pane order and background mappings from server sessions", () => {
    expect(recoverTerminalLayout(["term-2-bg", "term-10", "term-2", "term-1", "term-10-bg"])).toEqual({
      paneIds: ["term-1", "term-2", "term-10"],
      backgroundTerminalIds: {
        "term-2": ["term-2-bg"],
        "term-10": ["term-10-bg"],
      },
      visibleSessionIds: {},
    });
  });

  test("keeps a pane visible when only a background session survives", () => {
    expect(recoverTerminalLayout(["term-3-bg"])).toEqual({
      paneIds: ["term-3"],
      backgroundTerminalIds: {
        "term-3": ["term-3-bg"],
      },
      visibleSessionIds: {
        "term-3": "term-3-bg",
      },
    });
  });

  test("sorts multiple recovered background terminals in stack order", () => {
    expect(recoverTerminalLayout(["term-2-bg-3", "term-2-bg", "term-2-bg-2", "term-2"])).toEqual({
      paneIds: ["term-2"],
      backgroundTerminalIds: {
        "term-2": ["term-2-bg", "term-2-bg-2", "term-2-bg-3"],
      },
      visibleSessionIds: {},
    });
  });
});

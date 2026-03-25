import { describe, expect, test } from "bun:test";
import { shouldRestoreTerminalViewport } from "./terminalViewportRestore";

describe("shouldRestoreTerminalViewport", () => {
  test("skips hidden documents", () => {
    expect(shouldRestoreTerminalViewport("hidden", 800, 0, 240)).toBe(false);
  });

  test("skips repeated restores inside the debounce window", () => {
    expect(shouldRestoreTerminalViewport("visible", 399, 200, 240)).toBe(false);
  });

  test("allows visible restores after the debounce window", () => {
    expect(shouldRestoreTerminalViewport("visible", 440, 200, 240)).toBe(true);
  });
});

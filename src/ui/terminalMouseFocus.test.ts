import { describe, expect, test } from "bun:test";

import { shouldBypassPaneFocusForMouseSelection, shouldDeferViewportSyncForMouseDown } from "./terminalMouseFocus";

describe("shouldBypassPaneFocusForMouseSelection", () => {
  test("bypasses pane focus for shift+drag in mouse-reporting TUIs", () => {
    expect(shouldBypassPaneFocusForMouseSelection("drag", { button: 0, shiftKey: true })).toBe(true);
  });

  test("does not bypass focus without shift", () => {
    expect(shouldBypassPaneFocusForMouseSelection("drag", { button: 0, shiftKey: false })).toBe(false);
  });

  test("does not bypass focus when mouse tracking is disabled", () => {
    expect(shouldBypassPaneFocusForMouseSelection("none", { button: 0, shiftKey: true })).toBe(false);
  });

  test("does not bypass focus for non-primary mouse buttons", () => {
    expect(shouldBypassPaneFocusForMouseSelection("any", { button: 1, shiftKey: true })).toBe(false);
  });
});

describe("shouldDeferViewportSyncForMouseDown", () => {
  test("defers viewport sync for primary-button pointer interactions", () => {
    expect(shouldDeferViewportSyncForMouseDown({ button: 0 })).toBe(true);
  });

  test("does not defer viewport sync for non-primary buttons", () => {
    expect(shouldDeferViewportSyncForMouseDown({ button: 1 })).toBe(false);
  });
});

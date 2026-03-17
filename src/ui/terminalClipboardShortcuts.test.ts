import { describe, expect, test } from "bun:test";

import {
  isExplicitCopyShortcutEvent,
  isExplicitPasteShortcutEvent,
  isPasteShortcutEvent,
} from "./terminalClipboardShortcuts";

function keyboardEvent(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    key: "",
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("terminal clipboard shortcuts", () => {
  test("recognizes ctrl+shift+c as explicit copy", () => {
    expect(isExplicitCopyShortcutEvent(keyboardEvent({ ctrlKey: true, shiftKey: true, key: "C" }))).toBe(true);
  });

  test("recognizes ctrl+shift+v as explicit paste", () => {
    expect(isExplicitPasteShortcutEvent(keyboardEvent({ ctrlKey: true, shiftKey: true, key: "V" }))).toBe(true);
  });

  test("still treats ctrl+v as a paste shortcut", () => {
    expect(isPasteShortcutEvent(keyboardEvent({ ctrlKey: true, key: "v" }))).toBe(true);
  });

  test("does not treat plain ctrl+c as explicit copy", () => {
    expect(isExplicitCopyShortcutEvent(keyboardEvent({ ctrlKey: true, key: "c" }))).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import {
  hasKittyKeyboardProtocolQuery,
  modifiedEnterSequence,
  updateKittyKeyboardProtocolState,
} from "./terminalKeyboardProtocol";

function keyboardEvent(
  overrides: Partial<Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">> = {},
): Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey"> {
  return {
    key: "Enter",
    code: "Enter",
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe("updateKittyKeyboardProtocolState", () => {
  test("enables kitty keyboard protocol when requested by the app", () => {
    expect(updateKittyKeyboardProtocolState(false, "\u001b[>1u")).toBe(true);
  });

  test("disables kitty keyboard protocol when the app resets it", () => {
    expect(updateKittyKeyboardProtocolState(true, "\u001b[<u")).toBe(false);
  });

  test("keeps the latest protocol change when a payload contains both", () => {
    expect(updateKittyKeyboardProtocolState(false, "\u001b[>1uhello\u001b[<u")).toBe(false);
  });
});

describe("hasKittyKeyboardProtocolQuery", () => {
  test("detects the kitty keyboard capability query", () => {
    expect(hasKittyKeyboardProtocolQuery("\u001b[?u\u001b[c")).toBe(true);
  });

  test("does not confuse enable and disable sequences for a query", () => {
    expect(hasKittyKeyboardProtocolQuery("\u001b[>1u")).toBe(false);
    expect(hasKittyKeyboardProtocolQuery("\u001b[<u")).toBe(false);
  });
});

describe("modifiedEnterSequence", () => {
  test("encodes shift+enter with modifyOtherKeys", () => {
    expect(modifiedEnterSequence(keyboardEvent({ shiftKey: true }))).toBe("\u001b[27;2;13~");
  });

  test("encodes ctrl+enter with modifyOtherKeys", () => {
    expect(modifiedEnterSequence(keyboardEvent({ ctrlKey: true }))).toBe("\u001b[27;5;13~");
  });

  test("treats numpad enter like enter for modifyOtherKeys", () => {
    expect(modifiedEnterSequence(keyboardEvent({ shiftKey: true, code: "NumpadEnter" }))).toBe("\u001b[27;2;13~");
  });

  test("leaves plain enter alone", () => {
    expect(modifiedEnterSequence(keyboardEvent())).toBeNull();
  });

  test("leaves alt+enter on the native xterm path", () => {
    expect(modifiedEnterSequence(keyboardEvent({ altKey: true }))).toBeNull();
  });
});

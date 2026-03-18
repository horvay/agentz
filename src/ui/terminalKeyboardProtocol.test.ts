import { describe, expect, test } from "bun:test";

import {
  modifiedEnterSequence,
  modifiedEnterNewlineFallback,
  updateEnhancedEnterMode,
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

describe("updateEnhancedEnterMode", () => {
  test("enables kitty keyboard protocol when requested by the app", () => {
    expect(updateEnhancedEnterMode("none", "\u001b[>1u")).toBe("kitty");
  });

  test("disables kitty keyboard protocol when the app resets it", () => {
    expect(updateEnhancedEnterMode("kitty", "\u001b[<u")).toBe("none");
  });

  test("enables modifyOtherKeys when requested by the app", () => {
    expect(updateEnhancedEnterMode("none", "\u001b[>4;1m")).toBe("modify-other-keys");
  });

  test("disables modifyOtherKeys when the app resets it", () => {
    expect(updateEnhancedEnterMode("modify-other-keys", "\u001b[>4;0m")).toBe("none");
  });

  test("keeps the latest protocol change when a payload contains both", () => {
    expect(updateEnhancedEnterMode("none", "\u001b[>1uhello\u001b[>4;1m")).toBe("modify-other-keys");
  });
});

describe("modifiedEnterSequence", () => {
  test("encodes shift+enter with modifyOtherKeys", () => {
    expect(modifiedEnterSequence(keyboardEvent({ shiftKey: true }), "modify-other-keys")).toBe("\u001b[27;2;13~");
  });

  test("encodes ctrl+enter with modifyOtherKeys", () => {
    expect(modifiedEnterSequence(keyboardEvent({ ctrlKey: true }), "modify-other-keys")).toBe("\u001b[27;5;13~");
  });

  test("treats numpad enter like enter for modifyOtherKeys", () => {
    expect(modifiedEnterSequence(keyboardEvent({ shiftKey: true, code: "NumpadEnter" }), "modify-other-keys")).toBe(
      "\u001b[27;2;13~",
    );
  });

  test("encodes shift+enter with kitty keyboard protocol", () => {
    expect(modifiedEnterSequence(keyboardEvent({ shiftKey: true }), "kitty")).toBe("\u001b[13;2u");
  });

  test("leaves plain enter alone", () => {
    expect(modifiedEnterSequence(keyboardEvent(), "none")).toBeNull();
  });

  test("leaves alt+enter on the native xterm path", () => {
    expect(modifiedEnterSequence(keyboardEvent({ altKey: true }), "modify-other-keys")).toBeNull();
  });
});

describe("modifiedEnterNewlineFallback", () => {
  test("maps shift+enter to a literal newline", () => {
    expect(modifiedEnterNewlineFallback(keyboardEvent({ shiftKey: true }))).toBe("\n");
  });

  test("maps ctrl+enter to a literal newline", () => {
    expect(modifiedEnterNewlineFallback(keyboardEvent({ ctrlKey: true }))).toBe("\n");
  });

  test("does not remap plain enter", () => {
    expect(modifiedEnterNewlineFallback(keyboardEvent())).toBeNull();
  });
});

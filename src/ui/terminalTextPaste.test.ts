import { describe, expect, test } from "bun:test";

import { dispatchTerminalTextPaste } from "./terminalTextPaste";

describe("dispatchTerminalTextPaste", () => {
  test("prefers the live terminal paste path when available", () => {
    const calls: string[] = [];
    const rawCalls: string[] = [];

    const result = dispatchTerminalTextPaste(
      "line 1\nline 2",
      (text) => calls.push(text),
      (text) => rawCalls.push(text),
    );

    expect(result).toBe("terminal");
    expect(calls).toEqual(["line 1\nline 2"]);
    expect(rawCalls).toEqual([]);
  });

  test("falls back to raw input when no terminal paste handler is registered", () => {
    const rawCalls: string[] = [];

    const result = dispatchTerminalTextPaste("", undefined, (text) => rawCalls.push(text));

    expect(result).toBe("skip");
    expect(rawCalls).toEqual([]);
  });

  test("uses raw input as a fallback when the terminal is not mounted", () => {
    const rawCalls: string[] = [];

    const result = dispatchTerminalTextPaste("hello", undefined, (text) => rawCalls.push(text));

    expect(result).toBe("raw");
    expect(rawCalls).toEqual(["hello"]);
  });
});

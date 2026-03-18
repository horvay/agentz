import { describe, expect, test } from "bun:test";

import { collectTerminalUrlMatches, isModifierLinkActivation, trimTerminalUrl } from "./terminalLinks";

describe("trimTerminalUrl", () => {
  test("removes terminal punctuation that trails a url", () => {
    expect(trimTerminalUrl("https://agentz.dev/docs.)")).toBe("https://agentz.dev/docs");
  });

  test("keeps balanced parentheses inside a url", () => {
    expect(trimTerminalUrl("https://agentz.dev/docs(test)")).toBe("https://agentz.dev/docs(test)");
  });
});

describe("collectTerminalUrlMatches", () => {
  test("finds http links and trims terminal punctuation", () => {
    expect(collectTerminalUrlMatches("open https://agentz.dev/docs, then continue")).toEqual([
      {
        start: 5,
        end: 28,
        url: "https://agentz.dev/docs",
      },
    ]);
  });

  test("ignores non-http schemes", () => {
    expect(collectTerminalUrlMatches("file://tmp/nope")).toEqual([]);
  });
});

describe("isModifierLinkActivation", () => {
  test("uses control on non-mac platforms", () => {
    expect(isModifierLinkActivation({ ctrlKey: true, metaKey: false }, "Linux x86_64")).toBe(true);
    expect(isModifierLinkActivation({ ctrlKey: false, metaKey: true }, "Linux x86_64")).toBe(false);
  });

  test("uses command on mac platforms", () => {
    expect(isModifierLinkActivation({ ctrlKey: true, metaKey: false }, "MacIntel")).toBe(false);
    expect(isModifierLinkActivation({ ctrlKey: false, metaKey: true }, "MacIntel")).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";

import { buildTerminalHostEnv, resolveTerminalCommand } from "./terminalSession";

describe("resolveTerminalCommand", () => {
  test("falls back when SHELL points at a missing executable", () => {
    const resolved = resolveTerminalCommand(undefined, { SHELL: "/definitely/missing-shell" }, "linux");

    expect(resolved).not.toBe("/definitely/missing-shell");
    expect(resolved.length).toBeGreaterThan(0);
  });

  test("keeps a valid absolute SHELL path", () => {
    const resolved = resolveTerminalCommand(undefined, { SHELL: "/bin/sh" }, "linux");

    expect(resolved).toBe("/bin/sh");
  });
});

describe("buildTerminalHostEnv", () => {
  test("fills in a default PATH when the environment is stripped", () => {
    const env = buildTerminalHostEnv("/bin/sh", undefined, {}, "linux");

    expect(env.PATH).toContain("/usr/bin");
  });

  test("replaces an invalid SHELL when launching the default shell", () => {
    const env = buildTerminalHostEnv("/bin/sh", undefined, { SHELL: "/definitely/missing-shell" }, "linux");

    expect(env.SHELL).toBe("/bin/sh");
  });

  test("does not rewrite SHELL for explicit commands", () => {
    const env = buildTerminalHostEnv("opencode", "opencode", { SHELL: "/definitely/missing-shell" }, "linux");

    expect(env.SHELL).toBe("/definitely/missing-shell");
  });
});

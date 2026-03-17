import { describe, expect, test } from "bun:test";

import { buildTerminalHostEnv, resolveTerminalCommand } from "./terminalSession";

describe("resolveTerminalCommand", () => {
  test("falls back when SHELL points at a missing executable", () => {
    const resolved = resolveTerminalCommand(undefined, { SHELL: "/definitely/missing-shell" }, "linux");

    expect(resolved).not.toBe("/definitely/missing-shell");
    expect(resolved.length).toBeGreaterThan(0);
  });

  test("uses an installed PowerShell by default on Windows", () => {
    const resolved = resolveTerminalCommand(
      undefined,
      {
        PATH: "C:\\Tools;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
      },
      "win32",
    );

    expect(resolved).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  test("falls back to built-in Windows PowerShell when pwsh is unavailable on PATH", () => {
    if (process.platform !== "win32") return;

    const resolved = resolveTerminalCommand(
      undefined,
      {
        PATH: "C:\\Tools",
        PATHEXT: ".COM;.EXE;.BAT;.CMD",
        WINDIR: "C:\\Windows",
      },
      "win32",
    );

    expect(resolved).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  test("keeps unix shell resolution unchanged", () => {
    const resolved = resolveTerminalCommand(undefined, { SHELL: "sh" }, "linux");
    expect(resolved).toBe("sh");
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

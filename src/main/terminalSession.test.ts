import { describe, expect, test } from "bun:test";

import {
  buildTerminalHostEnv,
  resolveLaunchCwd,
  resolveTerminalCommand,
  resolveWindowsLaunchCommand,
} from "./terminalSession";

describe("resolveTerminalCommand", () => {
  test("falls back when SHELL points at a missing executable", () => {
    const resolved = resolveTerminalCommand(undefined, { SHELL: "/definitely/missing-shell" }, "linux");

    expect(resolved).not.toBe("/definitely/missing-shell");
    expect(resolved.length).toBeGreaterThan(0);
  });

  test("uses an installed PowerShell by default on Windows", () => {
    if (process.platform !== "win32") return;

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

  test("drops FORCE_COLOR when NO_COLOR is set", () => {
    const env = buildTerminalHostEnv("/bin/sh", undefined, { NO_COLOR: "1", FORCE_COLOR: "1" }, "linux");

    expect(env.NO_COLOR).toBe("1");
    expect(env.FORCE_COLOR).toBeUndefined();
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

describe("resolveWindowsLaunchCommand", () => {
  test("installs an OSC cwd prompt hook for default PowerShell sessions", () => {
    const launch = resolveWindowsLaunchCommand("pwsh.exe", [], false);

    expect(launch.command).toBe("pwsh.exe");
    expect(launch.args).toContain("-NoExit");
    expect(launch.args.join(" ")).toContain("]7;");
    expect(launch.args.join(" ")).toContain("function global:prompt");
  });

  test("does not wrap explicit commands with the interactive prompt hook", () => {
    const launch = resolveWindowsLaunchCommand("opencode", [], true, {
      PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });

    expect(launch.command.toLowerCase()).toContain("powershell");
    expect(launch.args.join(" ")).not.toContain("function global:prompt");
  });
});

describe("resolveLaunchCwd", () => {
  test("prefers an explicit pane cwd", () => {
    const cwd = resolveLaunchCwd("/tmp/pane", { AGENTZ_LAUNCH_CWD: "/tmp/app" }, "/");

    expect(cwd).toBe("/tmp/pane");
  });

  test("uses AGENTZ_LAUNCH_CWD when available", () => {
    const cwd = resolveLaunchCwd(undefined, { AGENTZ_LAUNCH_CWD: "/tmp/app" }, "/");

    expect(cwd).toBe("/tmp/app");
  });

  test("falls back to HOME when the app launch cwd is root", () => {
    const cwd = resolveLaunchCwd(undefined, { HOME: "/Users/demo" }, "/");

    expect(cwd).toBe("/Users/demo");
  });

  test("keeps a non-root process cwd when no better launch cwd is available", () => {
    const cwd = resolveLaunchCwd(undefined, {}, "/workspace/demo");

    expect(cwd).toBe("/workspace/demo");
  });
});

import { describe, expect, test } from "bun:test";

import { mergeEnvironment, parseShellEnvOutput, resolveMacShellPath } from "./shellEnvironment";

describe("parseShellEnvOutput", () => {
  test("extracts null-delimited variables between markers", () => {
    const stdout = Buffer.from(
      [
        "shell banner before env",
        "__AGENTZ_SHELL_ENV_START__",
        "PATH=/opt/homebrew/bin:/usr/bin\u0000SHELL=/bin/zsh\u0000EMPTY=\u0000",
        "__AGENTZ_SHELL_ENV_END__",
      ].join("\n"),
      "utf8",
    );

    const resolved = parseShellEnvOutput(stdout);

    expect(resolved).toEqual({
      EMPTY: "",
      PATH: "/opt/homebrew/bin:/usr/bin",
      SHELL: "/bin/zsh",
    });
  });

  test("returns null when markers are missing", () => {
    expect(parseShellEnvOutput(Buffer.from("PATH=/usr/bin\u0000", "utf8"))).toBeNull();
  });
});

describe("mergeEnvironment", () => {
  test("overlays shell vars onto the launch env", () => {
    const merged = mergeEnvironment(
      {
        AGENTZ_ROOT: "/tmp/agentz",
        PATH: "/usr/bin:/bin",
      },
      {
        PATH: "/opt/homebrew/bin:/usr/bin:/bin",
        SHELL: "/bin/zsh",
      },
    );

    expect(merged).toEqual({
      AGENTZ_ROOT: "/tmp/agentz",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      SHELL: "/bin/zsh",
    });
  });
});

describe("resolveMacShellPath", () => {
  test("falls back to a known shell when SHELL is unusable", () => {
    expect(resolveMacShellPath({ SHELL: "/definitely/missing-shell" })).toMatch(/^\/bin\/(zsh|bash|sh)$/);
  });
});

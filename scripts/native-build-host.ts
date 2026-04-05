import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveBundledZig, runInherited } from "./runtime";

const rootDir = process.cwd();
const zig = resolveBundledZig(rootDir);
const zigCode = await runInherited([zig, "build", "-Doptimize=ReleaseFast"], {
  cwd: join(rootDir, "src", "native"),
});
if (zigCode !== 0) {
  process.exit(zigCode);
}

if (process.platform !== "linux") {
  process.exit(0);
}

const outputDir = join(rootDir, "src", "native", "zig-out", "bin");
mkdirSync(outputDir, { recursive: true });

if (process.platform === "linux") {
  const helperCode = await runInherited([
    "cc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-o",
    join(outputDir, "agentz-pam-auth-helper"),
    join(rootDir, "src", "native", "pam_auth_helper.c"),
    "-lpam",
  ], {
    cwd: rootDir,
  });
  process.exit(helperCode);
}

if (process.platform === "darwin") {
  const helperCode = await runInherited([
    "cc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-fobjc-arc",
    "-o",
    join(outputDir, "agentz-macos-auth-helper"),
    join(rootDir, "src", "native", "macos_auth_helper.m"),
    "-framework",
    "Foundation",
    "-framework",
    "OpenDirectory",
  ], {
    cwd: rootDir,
  });
  process.exit(helperCode);
}

if (process.platform === "win32") {
  const helperCode = await runInherited([
    zig,
    "cc",
    "-O2",
    "-Wall",
    "-Wextra",
    "-o",
    join(outputDir, "agentz-windows-auth-helper.exe"),
    join(rootDir, "src", "native", "windows_auth_helper.c"),
    "-ladvapi32",
  ], {
    cwd: rootDir,
  });
  process.exit(helperCode);
}

process.exit(0);

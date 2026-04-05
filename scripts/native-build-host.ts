import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveBundledZig, runInherited } from "./runtime";

function ensureGhosttyLibVtBuildPatch(rootDir: string): void {
  const ghosttyBuildPath = join(rootDir, "deps", "ghostty", "build.zig");
  const optionAnchor = '    const config = try buildpkg.Config.init(b, appVersion);\n';
  const optionBlock =
    '    const emit_lib_vt = b.option(\n' +
    '        bool,\n' +
    '        "emit-lib-vt",\n' +
    '        "Build only the exported VT modules/artifacts for downstream consumers.",\n' +
    '    ) orelse false;\n' +
    '    const is_dep = dep: {\n' +
    '        b.build_root.handle.access(@src().file, .{}) catch break :dep true;\n' +
    '        break :dep false;\n' +
    '    };\n';
  const guardAnchor =
    '    // Ghostty resources like terminfo, shell integration, themes, etc.\n';
  const guardBlock =
    "    // Downstream VT-only consumers only need the exported Zig modules.\n" +
    "    // Avoid instantiating the full app/docs/bench graph here because it pulls\n" +
    "    // in vendored font and image packages that are unrelated to libghostty-vt.\n" +
    "    if (emit_lib_vt and is_dep) {\n" +
    "        return;\n" +
    "    }\n" +
    "\n";

  const source = readFileSync(ghosttyBuildPath, "utf8");
  let next = source;

  if (!next.includes('const emit_lib_vt = b.option(')) {
    if (!next.includes(optionAnchor)) {
      throw new Error(`Unable to patch ${ghosttyBuildPath}: missing config anchor`);
    }
    next = next.replace(optionAnchor, optionAnchor + optionBlock);
  }

  if (!next.includes("if (emit_lib_vt and is_dep) {")) {
    if (!next.includes(guardAnchor)) {
      throw new Error(`Unable to patch ${ghosttyBuildPath}: missing resource anchor`);
    }
    next = next.replace(guardAnchor, guardBlock + guardAnchor);
  }

  if (next !== source) {
    writeFileSync(ghosttyBuildPath, next);
  }
}

const rootDir = process.cwd();
ensureGhosttyLibVtBuildPatch(rootDir);
const zig = resolveBundledZig(rootDir);
const zigCode = await runInherited([zig, "build", "-Doptimize=ReleaseFast"], {
  cwd: join(rootDir, "src", "native"),
});
if (zigCode !== 0) {
  process.exit(zigCode);
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

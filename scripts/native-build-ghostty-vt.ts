import { join } from "node:path";
import { getNativeHostBuildError, resolveBundledZig, runInherited } from "./runtime";

const rootDir = process.cwd();
const zig = resolveBundledZig(rootDir);
const code = await runInherited(
  [
    zig,
    "build",
    "lib-vt",
    "-Doptimize=ReleaseFast",
    "-Demit-macos-app=false",
    "-Demit-xcframework=false",
  ],
  {
    cwd: join(rootDir, "deps", "ghostty"),
  },
);
process.exit(code);

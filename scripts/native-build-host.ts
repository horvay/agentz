import { join } from "node:path";
import { resolveBunExecutable, resolveBundledZig, runInherited } from "./runtime";

if (process.platform === "win32") {
  const bun = resolveBunExecutable();
  const code = await runInherited([bun, "x", "electron-rebuild", "-f", "-w", "node-pty"]);
  process.exit(code);
}

const rootDir = process.cwd();
const zig = resolveBundledZig(rootDir);
const code = await runInherited([zig, "build", "-Doptimize=ReleaseFast"], {
  cwd: join(rootDir, "src", "native"),
});
process.exit(code);

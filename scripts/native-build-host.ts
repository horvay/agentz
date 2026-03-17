import { join } from "node:path";
import { resolveBunExecutable, resolveBundledZig, runInherited } from "./runtime";

const rootDir = process.cwd();
const zig = resolveBundledZig(rootDir);
const code = await runInherited([zig, "build", "-Doptimize=ReleaseFast"], {
  cwd: join(rootDir, "src", "native"),
});
process.exit(code);

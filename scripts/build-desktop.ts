import { resolveBunExecutable, runInherited } from "./runtime";

const bun = resolveBunExecutable();

for (const cmd of [
  [bun, "run", "scripts/native-build-host.ts"],
  [bun, "x", "vite", "build"],
  [bun, "run", "electron:build-main"],
]) {
  const code = await runInherited(cmd);
  if (code !== 0) {
    process.exit(code);
  }
}

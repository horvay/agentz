import { resolveBunExecutable, runInherited, spawnInherited } from "./runtime";

const bun = resolveBunExecutable();
const buildCode = await runInherited([bun, "run", "scripts/native-build-host.ts"]);
if (buildCode !== 0) {
  process.exit(buildCode);
}

const proc = spawnInherited([bun, "--watch", "scripts/build-electron.ts"]);
process.exit(await proc.exited);

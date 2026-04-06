import { killDashboardProcesses } from "./kill-dashboard-processes";
import { resolveBunExecutable, runManaged, spawnInherited } from "./runtime";

killDashboardProcesses();

const bun = resolveBunExecutable();
const extraArgs = process.argv.slice(2);
await runManaged([
  spawnInherited([bun, "x", "vite", "--host", "127.0.0.1", "--port", "5173"]),
  spawnInherited([bun, "run", "scripts/electron-watch.ts"]),
  spawnInherited([bun, "run", "scripts/electron-run.ts", ...extraArgs]),
]);

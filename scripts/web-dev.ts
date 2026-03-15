import { getDesktopLaunchEnv, resolveBunExecutable, runInherited, runManaged, spawnInherited } from "./runtime";
import { killDashboardProcesses } from "./kill-dashboard-processes";

killDashboardProcesses();

const bun = resolveBunExecutable();
const buildCode = await runInherited([bun, "run", "scripts/native-build-host.ts"]);
if (buildCode !== 0) {
  process.exit(buildCode);
}

await runManaged([
  spawnInherited([bun, "x", "vite", "--host", "0.0.0.0", "--port", "5173"]),
  spawnInherited([bun, "src/main/web.ts"], {
    env: {
      ...getDesktopLaunchEnv(),
      GHOSTTY_DASHBOARD_RPC_HOST: "0.0.0.0",
    },
  }),
]);

import { getDesktopLaunchEnv, resolveBunExecutable, runInherited, runManaged, spawnInherited } from "./runtime";
import { killDashboardProcesses } from "./kill-dashboard-processes";

killDashboardProcesses();

const bun = resolveBunExecutable();
const buildCode = await runInherited([bun, "run", "scripts/native-build-host.ts"]);
if (buildCode !== 0) {
  process.exit(buildCode);
}

await runManaged([
  // Remote web serving is intentionally disabled until the transport is secured.
  // spawnInherited([bun, "x", "vite", "--host", "0.0.0.0", "--port", "5173"]),
  spawnInherited([bun, "x", "vite", "--host", "127.0.0.1", "--port", "5173"]),
  spawnInherited([bun, "src/main/web.ts"], {
    env: getDesktopLaunchEnv(),
    // env: {
    //   ...getDesktopLaunchEnv(),
    //   AGENTZ_RPC_HOST: "0.0.0.0",
    // },
  }),
]);

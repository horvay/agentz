import { startTerminalRpcServer } from "./server";
import { createDashboardConfigManager } from "./configManager";
import type { LaunchConfig } from "../shared/protocol";

function parseLaunchConfigFromEnv(): LaunchConfig | null {
  const raw = process.env.AGENTZ_LAUNCH;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LaunchConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown launch config error";
    throw new Error(`Invalid AGENTZ_LAUNCH: ${message}`);
  }
}

const launchConfig = parseLaunchConfigFromEnv();
const configManager = createDashboardConfigManager();
const { host, port } = startTerminalRpcServer(launchConfig ?? {}, configManager);

console.log(`Web backend listening on ws://${host}:${port}`);

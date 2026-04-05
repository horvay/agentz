import { startTerminalRpcServer } from "./server";
import { createDashboardConfigManager } from "./configManager";
import { createWebRpcAuth } from "./webAuth";
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
const auth = createWebRpcAuth();
const { host, port } = startTerminalRpcServer(launchConfig ?? {}, configManager, { auth });

console.log(`Web backend listening on ws://${host}:${port}`);

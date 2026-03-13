import { startTerminalRpcServer } from "./server";
import { createDashboardConfigManager } from "./configManager";
import type { LaunchConfig } from "../shared/protocol";

function normalizeLaunchConfig(config: LaunchConfig): LaunchConfig {
  if (Array.isArray(config.panes) && config.panes.length > 0) {
    return {
      ...config,
      panes: config.panes.map((pane) => ({
        command: pane?.command,
        args: pane?.args,
        cwd: pane?.cwd,
      })),
    };
  }
  const legacyPanes = [config.paneA, config.paneB].filter(
    (pane): pane is NonNullable<LaunchConfig["paneA"]> => Boolean(pane),
  );
  if (legacyPanes.length > 0) {
    return {
      ...config,
      panes: legacyPanes,
    };
  }
  return config;
}

function parseLaunchConfigFromEnv(): LaunchConfig | null {
  const raw = process.env.GHOSTTY_DASHBOARD_LAUNCH;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LaunchConfig;
    return normalizeLaunchConfig(parsed);
  } catch {
    return null;
  }
}

const launchConfig = parseLaunchConfigFromEnv();
const configManager = createDashboardConfigManager();
const { host, port } = startTerminalRpcServer(launchConfig ?? {}, configManager);

console.log(`Web backend listening on ws://${host}:${port}`);

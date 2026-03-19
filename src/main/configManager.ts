import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  cloneDashboardConfig,
  DEFAULT_DASHBOARD_CONFIG,
  normalizeDashboardConfig,
  type DashboardConfig,
} from "../shared/config";

export interface DashboardConfigManager {
  getConfig: () => DashboardConfig;
  setConfig: (next: DashboardConfig) => DashboardConfig;
  getConfigPath: () => string;
}

function resolveConfigPath(): string {
  const xdgRoot = process.env.XDG_CONFIG_HOME?.trim();
  const configDir = xdgRoot ? join(xdgRoot, "agentz") : join(homedir(), ".config", "agentz");
  return join(configDir, "config.json");
}

function writeConfigFile(configPath: string, config: DashboardConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function loadConfigFile(configPath: string): DashboardConfig {
  if (!existsSync(configPath)) {
    const initial = cloneDashboardConfig(DEFAULT_DASHBOARD_CONFIG);
    writeConfigFile(configPath, initial);
    return initial;
  }

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return normalizeDashboardConfig(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown config error";
    throw new Error(`Invalid dashboard config at ${configPath}: ${message}`);
  }
}

export function createDashboardConfigManager(): DashboardConfigManager {
  const configPath = resolveConfigPath();
  let config = loadConfigFile(configPath);

  return {
    getConfig: () => cloneDashboardConfig(config),
    setConfig: (next) => {
      config = normalizeDashboardConfig(next);
      writeConfigFile(configPath, config);
      return cloneDashboardConfig(config);
    },
    getConfigPath: () => configPath,
  };
}

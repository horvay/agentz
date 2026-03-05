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
  const configDir = xdgRoot ? join(xdgRoot, "ghostty-dashboard") : join(homedir(), ".config", "ghostty-dashboard");
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
    const normalized = normalizeDashboardConfig(parsed);
    return normalized;
  } catch {
    const fallback = cloneDashboardConfig(DEFAULT_DASHBOARD_CONFIG);
    writeConfigFile(configPath, fallback);
    return fallback;
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

import type { DashboardConfig } from "../shared/config";

export interface AutoUpdateSupport {
  enabled: boolean;
  reason?: string;
}

export function getAutoUpdateSupport(
  config: DashboardConfig,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  isPackaged: boolean,
): AutoUpdateSupport {
  if (!config.enableAutoUpdates) {
    return { enabled: false, reason: "auto updates are disabled in settings" };
  }
  if (!isPackaged) {
    return { enabled: false, reason: "app is not packaged" };
  }
  if (platform === "linux") {
    if (!env.APPIMAGE) {
      return { enabled: false, reason: "APPIMAGE is missing" };
    }
    return { enabled: true };
  }
  if (platform === "darwin" || platform === "win32") {
    return { enabled: true };
  }
  return { enabled: false, reason: `platform ${platform} is not enabled` };
}

import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { getAutoUpdateSupport } from "./autoUpdateSupport";
import type { DashboardConfig } from "../shared/config";

const STARTUP_UPDATE_DELAY_MS = 12_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;

function logAutoUpdate(message: string): void {
  console.log(`[updater] ${message}`);
}

async function promptToDownloadUpdate(version: string, getWindow: () => BrowserWindow | null): Promise<boolean> {
  const targetWindow = getWindow();
  const options = {
    type: "info" as const,
    buttons: ["Download update", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: "Update Available",
    message: `agentz ${version} is available.`,
    detail: "Download the latest AppImage now, or keep working and install it later.",
  };

  const result = targetWindow
    ? await dialog.showMessageBox(targetWindow, options)
    : await dialog.showMessageBox(options);

  return result.response === 0;
}

async function promptToInstallUpdate(version: string, getWindow: () => BrowserWindow | null): Promise<boolean> {
  const targetWindow = getWindow();
  const options = {
    type: "info" as const,
    buttons: ["Restart and install", "Later"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    title: "Update Ready",
    message: `agentz ${version} is ready to install.`,
    detail: "The update has already been downloaded. Restart now to install it, or keep working and it will install the next time you quit the app.",
  };

  const result = targetWindow
    ? await dialog.showMessageBox(targetWindow, options)
    : await dialog.showMessageBox(options);

  return result.response === 0;
}

export function initializeAutoUpdates(
  getWindow: () => BrowserWindow | null,
  getConfig: () => DashboardConfig,
): void {
  const support = getAutoUpdateSupport(getConfig(), process.env, process.platform, app.isPackaged);
  if (!support.enabled) {
    logAutoUpdate(`disabled: ${support.reason ?? "unknown reason"}`);
    return;
  }

  let checkInFlight = false;
  let downloadInFlight = false;
  let downloadedVersion: string | null = null;
  let skippedVersion: string | null = null;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = app.getVersion().includes("-");

  const configAllowsUpdates = (): boolean => {
    const nextSupport = getAutoUpdateSupport(getConfig(), process.env, process.platform, app.isPackaged);
    if (!nextSupport.enabled) {
      logAutoUpdate(`skipping action: ${nextSupport.reason ?? "unknown reason"}`);
      return false;
    }
    return true;
  };

  const runUpdateCheck = async () => {
    if (checkInFlight) return;
    if (!configAllowsUpdates()) return;
    checkInFlight = true;
    try {
      logAutoUpdate("checking for updates");
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[updater] check failed: ${message}`);
    } finally {
      checkInFlight = false;
    }
  };

  autoUpdater.on("checking-for-update", () => {
    logAutoUpdate("contacting release feed");
  });

  autoUpdater.on("update-available", async (info) => {
    logAutoUpdate(`update available: ${info.version}`);
    if (downloadedVersion === info.version || skippedVersion === info.version || downloadInFlight) {
      return;
    }
    if (!configAllowsUpdates()) return;

    const shouldDownload = await promptToDownloadUpdate(info.version, getWindow);
    if (!shouldDownload) {
      skippedVersion = info.version;
      logAutoUpdate(`download skipped for ${info.version}`);
      return;
    }

    skippedVersion = null;
    downloadInFlight = true;
    try {
      logAutoUpdate(`downloading update ${info.version}`);
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[updater] download failed: ${message}`);
    } finally {
      downloadInFlight = false;
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    logAutoUpdate(`already current: ${info.version}`);
  });

  autoUpdater.on("download-progress", (progress) => {
    if (progress.percent <= 0) return;
    logAutoUpdate(`download ${progress.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    if (downloadedVersion === info.version) return;
    downloadedVersion = info.version;
    logAutoUpdate(`update downloaded: ${info.version}`);
    if (!configAllowsUpdates()) return;

    const shouldRestart = await promptToInstallUpdate(info.version, getWindow);
    if (!shouldRestart) return;

    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 150);
  });

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[updater] ${message}`);
  });

  setTimeout(() => {
    void runUpdateCheck();
  }, STARTUP_UPDATE_DELAY_MS);

  const timer = setInterval(() => {
    void runUpdateCheck();
  }, UPDATE_CHECK_INTERVAL_MS);
  timer.unref();
}

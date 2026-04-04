import { app, BrowserWindow, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import { getAutoUpdateSupport } from "./autoUpdateSupport";
import type { DashboardConfig } from "../shared/config";
import type { AppUpdateStatus } from "../shared/protocol";

const STARTUP_UPDATE_DELAY_MS = 12_000;
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1_000;
const SETTINGS_DISABLED_REASON = "auto updates are disabled in settings";

let currentUpdateStatus: AppUpdateStatus = {
  state: "idle",
  message: "Ready to check for updates.",
};
const updateStatusListeners = new Set<(status: AppUpdateStatus) => void>();
let manualUpdateCheck: (() => Promise<void>) | null = null;

function setUpdateStatus(status: AppUpdateStatus): void {
  currentUpdateStatus = status;
  for (const listener of updateStatusListeners) {
    listener(status);
  }
}

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
    detail: "Download the latest release now, or keep working and install it later.",
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
    setUpdateStatus({
      state: support.reason === SETTINGS_DISABLED_REASON ? "disabled" : "unsupported",
      message: support.reason ?? "Auto updates are unavailable.",
    });
    logAutoUpdate(`disabled: ${support.reason ?? "unknown reason"}`);
    if (support.reason !== SETTINGS_DISABLED_REASON) {
      return;
    }
  } else {
    setUpdateStatus({ state: "idle", message: "Ready to check for updates." });
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
      setUpdateStatus({
        state: nextSupport.reason === SETTINGS_DISABLED_REASON ? "disabled" : "unsupported",
        message: nextSupport.reason ?? "Auto updates are unavailable.",
      });
      logAutoUpdate(`skipping action: ${nextSupport.reason ?? "unknown reason"}`);
      return false;
    }
    return true;
  };

  const runUpdateCheck = async () => {
    if (checkInFlight) return;
    if (!configAllowsUpdates()) return;
    checkInFlight = true;
    setUpdateStatus({ state: "checking", message: "Checking for updates..." });
    try {
      logAutoUpdate("checking for updates");
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateStatus({ state: "error", message: `Update check failed: ${message}` });
      console.error(`[updater] check failed: ${message}`);
    } finally {
      checkInFlight = false;
    }
  };
  manualUpdateCheck = runUpdateCheck;

  autoUpdater.on("checking-for-update", () => {
    logAutoUpdate("contacting release feed");
  });

  autoUpdater.on("update-available", async (info) => {
    logAutoUpdate(`update available: ${info.version}`);
    setUpdateStatus({
      state: "available",
      message: `Update ${info.version} is available.`,
    });
    if (downloadedVersion === info.version || skippedVersion === info.version || downloadInFlight) {
      return;
    }
    if (!configAllowsUpdates()) return;

    const shouldDownload = await promptToDownloadUpdate(info.version, getWindow);
    if (!shouldDownload) {
      skippedVersion = info.version;
      setUpdateStatus({
        state: "available",
        message: `Update ${info.version} is available to download.`,
      });
      logAutoUpdate(`download skipped for ${info.version}`);
      return;
    }

    skippedVersion = null;
    downloadInFlight = true;
    setUpdateStatus({
      state: "downloading",
      message: `Downloading update ${info.version}...`,
    });
    try {
      logAutoUpdate(`downloading update ${info.version}`);
      await autoUpdater.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setUpdateStatus({ state: "error", message: `Update download failed: ${message}` });
      console.error(`[updater] download failed: ${message}`);
    } finally {
      downloadInFlight = false;
    }
  });

  autoUpdater.on("update-not-available", (info) => {
    setUpdateStatus({
      state: "up-to-date",
      message: `agentz ${info.version} is up to date.`,
    });
    logAutoUpdate(`already current: ${info.version}`);
  });

  autoUpdater.on("download-progress", (progress) => {
    if (progress.percent <= 0) return;
    setUpdateStatus({
      state: "downloading",
      message: `Downloading update... ${progress.percent.toFixed(0)}%`,
    });
    logAutoUpdate(`download ${progress.percent.toFixed(1)}%`);
  });

  autoUpdater.on("update-downloaded", async (info) => {
    if (downloadedVersion === info.version) return;
    downloadedVersion = info.version;
    setUpdateStatus({
      state: "downloaded",
      message: `Update ${info.version} is ready to install.`,
    });
    logAutoUpdate(`update downloaded: ${info.version}`);
    if (!configAllowsUpdates()) return;

    const shouldRestart = await promptToInstallUpdate(info.version, getWindow);
    if (!shouldRestart) {
      setUpdateStatus({
        state: "downloaded",
        message: `Update ${info.version} is downloaded and ready when you are.`,
      });
      return;
    }

    setTimeout(() => {
      autoUpdater.quitAndInstall();
    }, 150);
  });

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    setUpdateStatus({ state: "error", message: `Updater error: ${message}` });
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

export function subscribeAutoUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void {
  updateStatusListeners.add(listener);
  listener(currentUpdateStatus);
  return () => {
    updateStatusListeners.delete(listener);
  };
}

export function getCurrentAutoUpdateStatus(): AppUpdateStatus {
  return currentUpdateStatus;
}

export async function requestManualUpdateCheck(): Promise<void> {
  if (!manualUpdateCheck) {
    if (currentUpdateStatus.state === "idle") {
      setUpdateStatus({
        state: "unsupported",
        message: "Manual update checks are only available in packaged app builds.",
      });
    }
    return;
  }
  await manualUpdateCheck();
}

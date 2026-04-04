import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startTerminalRpcServer } from "./server";
import { createDashboardConfigManager } from "./configManager";
import { applyMacShellEnvironment } from "./shellEnvironment";
import { initializeAutoUpdates } from "./appUpdater";
import type { LaunchConfig } from "../shared/protocol";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const WINDOW_TITLE = "agentz";
let mainWindow: BrowserWindow | null = null;

interface RendererTarget {
  kind: "url" | "file";
  value: string;
}

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

async function getMainViewTarget(): Promise<RendererTarget> {
  const hmrEnabled = process.env.ELECTRON_HMR === "1";
  if (hmrEnabled) {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      return { kind: "url", value: DEV_SERVER_URL };
    } catch {
      // fall through to packaged view
    }
  }

  const packagedView = join(app.getAppPath(), "dist", "index.html");
  if (!existsSync(packagedView)) {
    throw new Error(`Renderer entrypoint missing at ${packagedView}; run bunx vite build first.`);
  }

  return { kind: "file", value: packagedView };
}

function requestWindowFocus(window: BrowserWindow): void {
  window.show();
  window.focus();
  // Linux/X11 needed an extra renderer-focus nudge; on Windows it can steal
  // focus back from xterm's helper textarea and break non-text keys.
  if (process.platform === "linux") {
    window.webContents.focus();
  }
}

function runFocusBurst(window: BrowserWindow, delaysMs: number[]): void {
  for (const delay of delaysMs) {
    setTimeout(() => {
      requestWindowFocus(window);
    }, delay);
  }
}

function resolveExternalBrowserUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function createMainWindow(): Promise<BrowserWindow> {
  const target = await getMainViewTarget();
  const window = new BrowserWindow({
    title: WINDOW_TITLE,
    width: 1440,
    height: 900,
    x: 120,
    y: 80,
    autoHideMenuBar: true,
    show: true,
    backgroundColor: "#08111c",
    webPreferences: {
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  mainWindow = window;

  window.once("ready-to-show", () => {
    requestWindowFocus(window);
    runFocusBurst(window, [0, 120, 260]);
  });

  window.webContents.on("did-finish-load", () => {
    runFocusBurst(window, [0, 120, 260]);
  });
  window.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    window.setTitle(WINDOW_TITLE);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    const externalUrl = resolveExternalBrowserUrl(url);
    if (externalUrl) {
      void shell.openExternal(externalUrl);
    }
    return { action: "deny" };
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  if (target.kind === "url") {
    await window.loadURL(target.value);
  } else {
    await window.loadFile(target.value);
  }

  return window;
}

async function bootstrap(): Promise<void> {
  applyMacShellEnvironment();

  const launchConfig = parseLaunchConfigFromEnv();
  const configManager = createDashboardConfigManager();
  const rpcServer = startTerminalRpcServer(launchConfig ?? {}, configManager);

  app.on("before-quit", () => {
    rpcServer.close();
  });

  app.whenReady().then(async () => {
    await createMainWindow();
    initializeAutoUpdates(() => mainWindow, () => configManager.getConfig());
    console.log(`RPC listening on ws://${rpcServer.host}:${rpcServer.port}`);
  });

  app.on("activate", async () => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (existing) {
      requestWindowFocus(existing);
      return;
    }
    await createMainWindow();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  app.exit(1);
});

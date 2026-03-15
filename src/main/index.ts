import { app, BrowserWindow } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { startTerminalRpcServer } from "./server";
import { createDashboardConfigManager } from "./configManager";
import type { LaunchConfig } from "../shared/protocol";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const WINDOW_TITLE = "Ghostty Multi-Terminal Dashboard";

interface RendererTarget {
  kind: "url" | "file";
  value: string;
}

function parseLaunchConfigFromEnv(): LaunchConfig | null {
  const raw = process.env.GHOSTTY_DASHBOARD_LAUNCH;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LaunchConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown launch config error";
    throw new Error(`Invalid GHOSTTY_DASHBOARD_LAUNCH: ${message}`);
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
}

function runFocusBurst(window: BrowserWindow, delaysMs: number[]): void {
  for (const delay of delaysMs) {
    setTimeout(() => {
      requestWindowFocus(window);
    }, delay);
  }
}

async function createMainWindow(): Promise<BrowserWindow> {
  const target = await getMainViewTarget();
  const mainWindow = new BrowserWindow({
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

  mainWindow.once("ready-to-show", () => {
    requestWindowFocus(mainWindow);
    runFocusBurst(mainWindow, [0, 120, 260]);
  });

  mainWindow.webContents.on("did-finish-load", () => {
    runFocusBurst(mainWindow, [0, 120, 260]);
  });
  mainWindow.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
    mainWindow.setTitle(WINDOW_TITLE);
  });

  if (target.kind === "url") {
    await mainWindow.loadURL(target.value);
  } else {
    await mainWindow.loadFile(target.value);
  }

  return mainWindow;
}

const launchConfig = parseLaunchConfigFromEnv();
const configManager = createDashboardConfigManager();
const rpcServer = startTerminalRpcServer(launchConfig ?? {}, configManager);

app.on("before-quit", () => {
  rpcServer.close();
});

app.whenReady().then(async () => {
  await createMainWindow();
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

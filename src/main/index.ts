import { app, BrowserWindow, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startTerminalRpcServer, DEFAULT_LOCAL_HOST, DEFAULT_REMOTE_HOST, RPC_PORT } from "./server";
import { createDashboardConfigManager } from "./configManager";
import { applyMacShellEnvironment } from "./shellEnvironment";
import {
  getCurrentAutoUpdateStatus,
  initializeAutoUpdates,
  requestManualUpdateCheck,
  subscribeAutoUpdateStatus,
} from "./appUpdater";
import { TerminalManager } from "./terminalManager";
import { createRemoteAccessController } from "./webAuth";
import type { LaunchConfig } from "../shared/protocol";
import { ensureRemoteTlsContext, REMOTE_RPC_PORT, resolveRemoteAccessUrls } from "./remoteTls";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;
const WINDOW_TITLE = "agentz";
let mainWindow: BrowserWindow | null = null;

function hasCliFlag(name: string): boolean {
  return process.argv.includes(name);
}

const DEBUG_LOGS_ENABLED = hasCliFlag("--debug-logs");

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
  if (DEBUG_LOGS_ENABLED) {
    window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${sourceId}:${line} ${message}`);
    });
  }
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
    const url = new URL(target.value);
    if (DEBUG_LOGS_ENABLED) {
      url.searchParams.set("debugLogs", "1");
    }
    await window.loadURL(url.toString());
  } else {
    await window.loadFile(target.value, {
      query: DEBUG_LOGS_ENABLED ? { debugLogs: "1" } : undefined,
    });
  }

  return window;
}

async function bootstrap(): Promise<void> {
  applyMacShellEnvironment();

  const launchConfig = parseLaunchConfigFromEnv();
  const configManager = createDashboardConfigManager();
  const configDir = dirname(configManager.getConfigPath());
  const remoteAccessDevicesPath = join(configDir, "remote-access-devices.json");
  const loadApprovedDevices = () => {
    if (!existsSync(remoteAccessDevicesPath)) return [];
    try {
      const raw = readFileSync(remoteAccessDevicesPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((value) => {
        if (!value || typeof value !== "object") return [];
        const candidate = value as Record<string, unknown>;
        if (
          typeof candidate.id !== "string" ||
          typeof candidate.label !== "string" ||
          typeof candidate.approvedAt !== "number" ||
          typeof candidate.lastSeenAt !== "number" ||
          typeof candidate.tokenHash !== "string"
        ) {
          return [];
        }
        return [{
          id: candidate.id,
          label: candidate.label,
          approvedAt: candidate.approvedAt,
          lastSeenAt: candidate.lastSeenAt,
          tokenHash: candidate.tokenHash,
        }];
      });
    } catch {
      return [];
    }
  };
  const saveApprovedDevices = (
    devices: Array<{
      id: string;
      label: string;
      approvedAt: number;
      lastSeenAt: number;
      tokenHash: string;
    }>,
  ) => {
    mkdirSync(dirname(remoteAccessDevicesPath), { recursive: true });
    writeFileSync(remoteAccessDevicesPath, `${JSON.stringify(devices, null, 2)}\n`, "utf8");
  };
  const terminals = new TerminalManager();
  const remoteTls = await ensureRemoteTlsContext(configDir);
  const remoteAccess = createRemoteAccessController({
    resolveUrls: () => resolveRemoteAccessUrls(REMOTE_RPC_PORT),
    initialApprovedDevices: loadApprovedDevices(),
    onApprovedDevicesChanged: saveApprovedDevices,
  });
  remoteAccess.setEnabled(configManager.getConfig().remoteAccess.enabled);
  const rpcServer = startTerminalRpcServer(launchConfig ?? {}, configManager, {
    bindings: [
      {
        host: DEFAULT_LOCAL_HOST,
        port: RPC_PORT,
      },
      {
        host: DEFAULT_REMOTE_HOST,
        port: REMOTE_RPC_PORT,
        tls: {
          key: remoteTls.key,
          cert: remoteTls.cert,
        },
      },
    ],
    terminals,
    remoteAccess,
    updates: {
      currentStatus: getCurrentAutoUpdateStatus,
      requestManualCheck: requestManualUpdateCheck,
      subscribe: subscribeAutoUpdateStatus,
    },
    onConfigChanged: (nextConfig) => {
      remoteAccess.setEnabled(nextConfig.remoteAccess.enabled);
    },
  });

  app.on("before-quit", () => {
    void rpcServer.close();
  });

  app.whenReady().then(async () => {
    await createMainWindow();
    initializeAutoUpdates(() => mainWindow, () => configManager.getConfig());
    console.log(`Local RPC listening on ws://${DEFAULT_LOCAL_HOST}:${RPC_PORT}`);
    console.log(`Remote access listening on wss://0.0.0.0:${REMOTE_RPC_PORT}`);
    console.log(`Remote local CA: ${remoteTls.caCertPath}`);
    console.log(`Remote server certificate: ${remoteTls.certPath}`);
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

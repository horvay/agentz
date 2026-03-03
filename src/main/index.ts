import { BrowserWindow, Updater } from "electrobun/bun";
import { startTerminalRpcServer } from "./server";
import type { LaunchConfig } from "../shared/protocol";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

function parseLaunchConfigFromEnv(): LaunchConfig | null {
  const raw = process.env.GHOSTTY_DASHBOARD_LAUNCH;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LaunchConfig;
    return parsed;
  } catch {
    return null;
  }
}

async function getMainViewUrl(): Promise<string> {
  // Opt-in only: avoid accidental hijack by any process on localhost:5173.
  const hmrEnabled = process.env.ELECTROBUN_HMR === "1";
  if (!hmrEnabled) {
    return "views://mainview/index.html";
  }

  const channel = await Updater.localInfo.channel();
  if (channel === "dev") {
    try {
      await fetch(DEV_SERVER_URL, { method: "HEAD" });
      return DEV_SERVER_URL;
    } catch {
      // fall through to packaged view
    }
  }
  return "views://mainview/index.html";
}

const launchConfig = parseLaunchConfigFromEnv();
const { host, port } = startTerminalRpcServer(launchConfig ?? {});
const url = await getMainViewUrl();

new BrowserWindow({
  title: "Ghostty Multi-Terminal Dashboard",
  url,
  frame: {
    width: 1440,
    height: 900,
    x: 120,
    y: 80,
  },
});

console.log(`RPC listening on ws://${host}:${port}`);

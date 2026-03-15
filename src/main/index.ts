import { BrowserWindow } from "electrobun/bun";
import { startTerminalRpcServer } from "./server";
import { createDashboardConfigManager } from "./configManager";
import type { LaunchConfig } from "../shared/protocol";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

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

async function getMainViewUrl(): Promise<string> {
  // Opt-in only: avoid accidental hijack by any process on localhost:5173.
  const hmrEnabled = process.env.ELECTROBUN_HMR === "1";
  if (hmrEnabled) {
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
const configManager = createDashboardConfigManager();
const { host, port } = startTerminalRpcServer(launchConfig ?? {}, configManager);
const url = await getMainViewUrl();

const mainWindow = new BrowserWindow({
  title: "Ghostty Multi-Terminal Dashboard",
  url,
  frame: {
    width: 1440,
    height: 900,
    x: 120,
    y: 80,
  },
});
const WINDOW_TITLE = "Ghostty Multi-Terminal Dashboard";

const requestWindowFocus = () => {
  mainWindow.show();
  mainWindow.focus();
};

const runFocusBurst = (delaysMs: number[]) => {
  for (const delay of delaysMs) {
    setTimeout(() => {
      requestWindowFocus();
    }, delay);
  }
};

// Initial startup activation attempts.
runFocusBurst([0, 120, 260]);

// Re-assert focus once renderer is actually interactive.
mainWindow.webview.on("dom-ready", () => {
  runFocusBurst([0, 120, 260]);
  setTimeout(runX11InputNudge, 420);
});

let x11InputNudged = false;
const runX11InputNudge = () => {
  if (x11InputNudged) return;
  if (process.platform !== "linux") return;
  if (!process.env.DISPLAY) return;
  if (process.env.GHOSTTY_DASHBOARD_DISABLE_X11_INPUT_NUDGE === "1") return;

  const run = (args: string[]) =>
    Bun.spawnSync(args, {
      stdout: "pipe",
      stderr: "pipe",
    });

  const search = run(["xdotool", "search", "--onlyvisible", "--name", WINDOW_TITLE]);
  if (search.exitCode !== 0) return;
  const windowId = search.stdout
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-1)[0];
  if (!windowId) return;

  x11InputNudged = true;
  const mouseLocation = run(["xdotool", "getmouselocation", "--shell"]);
  const originalX = Number(mouseLocation.stdout.toString().match(/X=(\d+)/)?.[1] ?? "");
  const originalY = Number(mouseLocation.stdout.toString().match(/Y=(\d+)/)?.[1] ?? "");
  const geometry = run(["xdotool", "getwindowgeometry", "--shell", windowId]).stdout.toString();
  const width = Number(geometry.match(/WIDTH=(\d+)/)?.[1] ?? "");
  const height = Number(geometry.match(/HEIGHT=(\d+)/)?.[1] ?? "");
  const clickX = Number.isFinite(width) && width > 0 ? Math.max(24, Math.floor(width * 0.5)) : 360;
  const clickY = Number.isFinite(height) && height > 0 ? Math.max(24, Math.floor(height * 0.78)) : 280;

  run(["xdotool", "windowactivate", "--sync", windowId]);
  run(["xdotool", "windowfocus", "--sync", windowId]);
  run([
    "xdotool",
    "keyup",
    "Control_L",
    "Control_R",
    "Shift_L",
    "Shift_R",
    "Alt_L",
    "Alt_R",
    "Super_L",
    "Super_R",
  ]);
  // Work around an Electrobun/X11 quirk where keyboard events do not flow
  // into the webview until it receives the first pointer interaction.
  // Aim the synthetic click into the lower-middle area where the first
  // terminal pane is expected, so startup also focuses terminal input.
  run(["xdotool", "mousemove", "--window", windowId, `${clickX}`, `${clickY}`, "click", "1"]);
  if (Number.isFinite(originalX) && Number.isFinite(originalY)) {
    run(["xdotool", "mousemove", `${originalX}`, `${originalY}`]);
  }
};

setTimeout(runX11InputNudge, 2600);

console.log(`RPC listening on ws://${host}:${port}`);

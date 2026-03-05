import { BrowserWindow, Updater } from "electrobun/bun";
import { startTerminalRpcServer } from "./server";
import type { LaunchConfig } from "../shared/protocol";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

function normalizeLaunchConfig(config: LaunchConfig): LaunchConfig {
  if (Array.isArray(config.panes) && config.panes.length > 0) {
    return {
      ...config,
      panes: config.panes.map((pane) => ({
        command: pane?.command,
        args: pane?.args,
        cwd: pane?.cwd,
      })),
    };
  }
  const legacyPanes = [config.paneA, config.paneB].filter(
    (pane): pane is NonNullable<LaunchConfig["paneA"]> => Boolean(pane),
  );
  if (legacyPanes.length > 0) {
    return {
      ...config,
      panes: legacyPanes,
    };
  }
  return config;
}

function parseLaunchConfigFromEnv(): LaunchConfig | null {
  const raw = process.env.GHOSTTY_DASHBOARD_LAUNCH;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as LaunchConfig;
    return normalizeLaunchConfig(parsed);
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

const focusWebviewInput = () => {
  try {
    mainWindow.webview.executeJavascript(`(() => {
      try {
        window.focus();
        if (document?.documentElement) {
          document.documentElement.tabIndex = -1;
          document.documentElement.focus({ preventScroll: true });
        }
        if (document?.body) {
          document.body.tabIndex = -1;
          document.body.focus({ preventScroll: true });
        }
        const helper = document.querySelector(".xterm-helper-textarea");
        if (helper instanceof HTMLElement) {
          helper.focus({ preventScroll: true });
        }
      } catch {}
    })();`);
  } catch {
    // Webview may not be ready yet.
  }
};

const requestWindowFocus = () => {
  mainWindow.show();
  mainWindow.focus();
};

const runFocusBurst = (delaysMs: number[]) => {
  for (const delay of delaysMs) {
    setTimeout(() => {
      requestWindowFocus();
      focusWebviewInput();
    }, delay);
  }
};

let observedWindowFocus = false;
let lastFocusBoostAt = 0;
mainWindow.on("focus", () => {
  observedWindowFocus = true;
  const now = Date.now();
  if (now - lastFocusBoostAt < 500) return;
  lastFocusBoostAt = now;
  runFocusBurst([0, 70, 180]);
});

// Initial startup activation attempts.
runFocusBurst([0, 80, 200, 420, 900, 1600]);

// Re-assert focus once renderer is actually interactive.
mainWindow.webview.on("dom-ready", () => {
  runFocusBurst([0, 80, 200, 450, 900]);
});

// Last-resort nudge for window managers that ignore early focus requests.
setTimeout(() => {
  if (observedWindowFocus) return;
  mainWindow.setAlwaysOnTop(true);
  requestWindowFocus();
  setTimeout(() => {
    mainWindow.setAlwaysOnTop(false);
  }, 320);
}, 2200);

console.log(`RPC listening on ws://${host}:${port}`);

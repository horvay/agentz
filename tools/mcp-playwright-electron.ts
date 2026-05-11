#!/usr/bin/env bun
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

const projectRoot = resolve(import.meta.dir, "..");

let viteProcess: ChildProcess | null = null;
let electronApp: ElectronApplication | null = null;
let mainWindow: Page | null = null;

function text(content: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof content === "string" ? content : JSON.stringify(content, null, 2),
      },
    ],
  };
}

function electronExecutable() {
  const bin = process.platform === "win32" ? "electron.cmd" : "electron";
  return join(projectRoot, "node_modules", ".bin", bin);
}

async function waitForUrl(url: string, timeoutMs: number) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function ensureVite() {
  if (viteProcess && !viteProcess.killed) return;
  viteProcess = spawn("bun", ["x", "vite", "--host", "127.0.0.1", "--port", "5173"], {
    cwd: projectRoot,
    env: { ...process.env, AGENTZ_ROOT: projectRoot, AGENTZ_LAUNCH_CWD: projectRoot },
    stdio: "ignore",
  });
}

async function getWindow() {
  if (!electronApp) throw new Error("Electron app is not launched. Call electron_launch first.");
  if (!mainWindow || mainWindow.isClosed()) {
    mainWindow = await electronApp.firstWindow({ timeout: 10_000 });
  }
  return mainWindow;
}

async function closeAll() {
  if (electronApp) {
    const app = electronApp;
    electronApp = null;
    mainWindow = null;
    await app.close().catch(() => undefined);
  }
  if (viteProcess) {
    viteProcess.kill();
    viteProcess = null;
  }
}

const server = new McpServer({
  name: "agentz-playwright-electron",
  version: "0.1.0",
});

server.tool(
  "electron_launch",
  "Launch the project Electron app with Playwright Electron. This tests the real Electron webContents, not a browser tab.",
  {
    startVite: z.boolean().default(true).describe("Start Vite dev server on 127.0.0.1:5173 before launching."),
    timeoutMs: z.number().int().positive().default(30_000),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
  },
  async ({ startVite, timeoutMs, width, height }) => {
    if (electronApp) return text({ launched: true, reused: true });
    if (!existsSync(electronExecutable())) throw new Error("Electron binary not found. Run bun install first.");

    if (startVite) {
      ensureVite();
      await waitForUrl("http://127.0.0.1:5173/", timeoutMs);
    }

    electronApp = await electron.launch({
      executablePath: electronExecutable(),
      args: ["."],
      cwd: projectRoot,
      env: {
        ...process.env,
        AGENTZ_ROOT: projectRoot,
        AGENTZ_LAUNCH_CWD: projectRoot,
        ELECTRON_HMR: "1",
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        LIBGL_ALWAYS_SOFTWARE: "1",
      },
      timeout: timeoutMs,
    });
    mainWindow = await electronApp.firstWindow({ timeout: timeoutMs });
    if (width && height) await mainWindow.setViewportSize({ width, height });
    return text({ launched: true, title: await mainWindow.title(), url: mainWindow.url() });
  },
);

server.tool("electron_close", "Close the launched Electron app and dev server.", {}, async () => {
  await closeAll();
  return text({ closed: true });
});

server.tool("electron_window_info", "Return title, URL, viewport, and BrowserWindow bounds for the current Electron window.", {}, async () => {
  const page = await getWindow();
  const bounds = await electronApp!.browserWindow(page).then((win) => win.evaluate((w) => w.getBounds()));
  return text({ title: await page.title(), url: page.url(), viewport: page.viewportSize(), bounds });
});

server.tool(
  "electron_screenshot",
  "Capture a screenshot of the Electron webContents.",
  {
    path: z.string().default("artifacts/electron-mcp-screenshot.png"),
    fullPage: z.boolean().default(false),
  },
  async ({ path, fullPage }) => {
    const page = await getWindow();
    const outPath = resolve(projectRoot, path);
    await page.screenshot({ path: outPath, fullPage });
    return text({ path: outPath });
  },
);

server.tool(
  "electron_click",
  "Click a selector in the Electron renderer.",
  {
    selector: z.string(),
    timeoutMs: z.number().int().positive().default(5_000),
  },
  async ({ selector, timeoutMs }) => {
    const page = await getWindow();
    await page.click(selector, { timeout: timeoutMs });
    return text({ clicked: selector });
  },
);

server.tool(
  "electron_type",
  "Type text into the focused element in the Electron renderer.",
  {
    text: z.string(),
    delayMs: z.number().int().nonnegative().default(0),
  },
  async ({ text: value, delayMs }) => {
    const page = await getWindow();
    await page.keyboard.type(value, { delay: delayMs });
    return text({ typed: value.length });
  },
);

server.tool(
  "electron_key",
  "Press a keyboard key in the Electron renderer, e.g. Enter, Control+L, ArrowDown.",
  { key: z.string() },
  async ({ key }) => {
    const page = await getWindow();
    await page.keyboard.press(key);
    return text({ pressed: key });
  },
);

server.tool(
  "electron_eval_renderer",
  "Evaluate JavaScript in the Electron renderer page. Pass an expression or function body string.",
  { script: z.string() },
  async ({ script }) => {
    const page = await getWindow();
    const result = await page.evaluate((source) => {
      return (0, eval)(source);
    }, script);
    return text(result);
  },
);

server.tool(
  "electron_eval_main",
  "Evaluate JavaScript in Electron's main process. The script receives the Electron module as `electron`.",
  { script: z.string() },
  async ({ script }) => {
    if (!electronApp) throw new Error("Electron app is not launched. Call electron_launch first.");
    const result = await electronApp.evaluate(({ app, BrowserWindow, ipcMain }, source) => {
      const electron = { app, BrowserWindow, ipcMain };
      return Function("electron", `return (${source});`)(electron);
    }, script);
    return text(result);
  },
);

server.tool(
  "agentz_terminal_input",
  "Focus the active xterm helper textarea and type text into the terminal. Optionally press Enter.",
  {
    text: z.string(),
    enter: z.boolean().default(false),
    delayMs: z.number().int().nonnegative().default(0),
  },
  async ({ text: value, enter, delayMs }) => {
    const page = await getWindow();
    await page.locator(".pane-active .xterm-helper-textarea, .xterm-helper-textarea").last().click({ timeout: 5_000 });
    await page.keyboard.type(value, { delay: delayMs });
    if (enter) await page.keyboard.press("Enter");
    return text({ typed: value.length, enter });
  },
);

server.tool(
  "agentz_terminal_bottom_text",
  "Return text from the bottom rows of the active xterm buffer as rendered in the DOM.",
  { rows: z.number().int().positive().default(12) },
  async ({ rows }) => {
    const page = await getWindow();
    const result = await page.evaluate((count) => {
      const active = document.querySelector(".pane-active") ?? document;
      const rowNodes = Array.from(active.querySelectorAll(".xterm-rows > div"));
      return rowNodes.slice(-count).map((node) => node.textContent ?? "");
    }, rows);
    return text(result);
  },
);

process.on("SIGINT", () => void closeAll().finally(() => process.exit(0)));
process.on("SIGTERM", () => void closeAll().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());

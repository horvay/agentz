import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { Type } from "typebox";

const projectRoot = process.cwd();

let viteProcess: ChildProcess | null = null;
let electronApp: ElectronApplication | null = null;
let mainWindow: Page | null = null;

function result(content: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof content === "string" ? content : JSON.stringify(content, null, 2) }],
    details: {},
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

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "electron_launch",
    label: "Electron launch",
    description: "Launch the project Electron app with Playwright Electron. Tests the real Electron webContents, not a browser tab.",
    parameters: Type.Object({
      startVite: Type.Optional(Type.Boolean({ default: true, description: "Start Vite dev server first" })),
      timeoutMs: Type.Optional(Type.Number({ default: 30000 })),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
    }),
    async execute(_id, params: { startVite?: boolean; timeoutMs?: number; width?: number; height?: number }) {
      if (electronApp) return result({ launched: true, reused: true });
      if (!existsSync(electronExecutable())) throw new Error("Electron binary not found. Run bun install first.");
      const timeoutMs = params.timeoutMs ?? 30_000;
      if (params.startVite ?? true) {
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
      if (params.width && params.height) await mainWindow.setViewportSize({ width: params.width, height: params.height });
      return result({ launched: true, title: await mainWindow.title(), url: mainWindow.url() });
    },
  });

  pi.registerTool({
    name: "electron_close",
    label: "Electron close",
    description: "Close the Electron app launched by electron_launch.",
    parameters: Type.Object({}),
    async execute() {
      await closeAll();
      return result({ closed: true });
    },
  });

  pi.registerTool({
    name: "electron_screenshot",
    label: "Electron screenshot",
    description: "Capture a screenshot of the Electron webContents.",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ default: "artifacts/electron-pi-screenshot.png" })),
      fullPage: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params: { path?: string; fullPage?: boolean }) {
      const page = await getWindow();
      const outPath = resolve(projectRoot, params.path ?? "artifacts/electron-pi-screenshot.png");
      await page.screenshot({ path: outPath, fullPage: params.fullPage ?? false });
      return result({ path: outPath });
    },
  });

  pi.registerTool({
    name: "electron_key",
    label: "Electron key",
    description: "Press a key in the Electron renderer, e.g. Enter, Control+L, ArrowDown.",
    parameters: Type.Object({ key: Type.String() }),
    async execute(_id, params: { key: string }) {
      const page = await getWindow();
      await page.keyboard.press(params.key);
      return result({ pressed: params.key });
    },
  });

  pi.registerTool({
    name: "agentz_terminal_input",
    label: "agentz terminal input",
    description: "Focus the active xterm helper textarea and type text into the terminal. Optionally press Enter.",
    parameters: Type.Object({
      text: Type.String(),
      enter: Type.Optional(Type.Boolean({ default: false })),
      delayMs: Type.Optional(Type.Number({ default: 0 })),
    }),
    async execute(_id, params: { text: string; enter?: boolean; delayMs?: number }) {
      const page = await getWindow();
      await page.locator(".pane-active .xterm-helper-textarea, .xterm-helper-textarea").last().click({ timeout: 5_000 });
      await page.keyboard.type(params.text, { delay: params.delayMs ?? 0 });
      if (params.enter) await page.keyboard.press("Enter");
      return result({ typed: params.text.length, enter: params.enter ?? false });
    },
  });

  pi.registerTool({
    name: "agentz_terminal_bottom_text",
    label: "agentz terminal bottom text",
    description: "Return text from the bottom rows of the active xterm buffer as rendered in the DOM.",
    parameters: Type.Object({ rows: Type.Optional(Type.Number({ default: 12 })) }),
    async execute(_id, params: { rows?: number }) {
      const page = await getWindow();
      const rows = Math.max(1, Math.floor(params.rows ?? 12));
      const bottomRows = await page.evaluate((count) => {
        const active = document.querySelector(".pane-active") ?? document;
        const rowNodes = Array.from(active.querySelectorAll(".xterm-rows > div"));
        return rowNodes.slice(-count).map((node) => node.textContent ?? "");
      }, rows);
      return result(bottomRows);
    },
  });

  pi.on("session_end", async () => {
    await closeAll();
  });
}

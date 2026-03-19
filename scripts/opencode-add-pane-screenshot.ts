import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { decodeTerminalFramePacket, type TerminalFrame } from "../src/shared/protocol";
import { killDashboardProcesses } from "./kill-dashboard-processes";
import { getDesktopLaunchEnv, resolveBunExecutable } from "./runtime";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const item of argv) {
    if (!item.startsWith("--")) continue;
    const token = item.slice(2);
    if (!token.includes("=")) {
      out[token] = true;
      continue;
    }
    const [k, ...rest] = token.split("=");
    out[k] = rest.join("=");
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runChecked(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = proc.stdout.toString().trim();
  const stderr = proc.stderr.toString().trim();
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode}): ${stderr || stdout}`);
  }
  return stdout;
}

function runPowerShell(script: string): string {
  return runChecked(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]);
}

function findWindowIdPosix(windowName: string): string | null {
  const search = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", windowName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (search.exitCode !== 0) return null;
  const lines = search.stdout.toString().trim().split("\n").filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

function findWindowIdWindows(windowName: string): string | null {
  const escapedTitle = windowName.replace(/'/g, "''");
  const output = runPowerShell(`
$title = '${escapedTitle}'
$proc = Get-Process |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$title*" } |
  Sort-Object StartTime |
  Select-Object -Last 1
if ($null -ne $proc) {
  [Console]::Out.Write([string]$proc.MainWindowHandle)
}
`);
  return output || null;
}

function findWindowId(windowName: string): string | null {
  return process.platform === "win32" ? findWindowIdWindows(windowName) : findWindowIdPosix(windowName);
}

function prepareWindow(windowId: string): void {
  const width = 1500;
  const height = 1100;

  if (process.platform !== "win32") {
    runChecked(["xdotool", "windowactivate", "--sync", windowId]);
    runChecked(["xdotool", "windowfocus", "--sync", windowId]);
    runChecked([
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
    runChecked(["xdotool", "windowsize", "--sync", windowId, `${width}`, `${height}`]);
    return;
  }

  runPowerShell(`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
}
"@
$handle = [IntPtr]::new([int64]'${windowId}')
[void][Win32]::ShowWindowAsync($handle, 9)
[void][Win32]::MoveWindow($handle, 80, 80, ${width}, ${height}, $true)
[void][Win32]::SetForegroundWindow($handle)
`);
}

function sendAddPaneShortcut(windowId: string): void {
  if (process.platform !== "win32") {
    runChecked(["xdotool", "key", "--clearmodifiers", "ctrl+shift+n"]);
    return;
  }

  runPowerShell(`
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
$handle = [IntPtr]::new([int64]'${windowId}')
[void][Win32]::ShowWindowAsync($handle, 9)
[void][Win32]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 300
[System.Windows.Forms.SendKeys]::SendWait('^+n')
`);
}

function captureWindow(windowId: string, screenshotPath: string): void {
  mkdirSync(dirname(screenshotPath), { recursive: true });
  rmSync(screenshotPath, { force: true });

  if (process.platform !== "win32") {
    runChecked(["import", "-window", windowId, screenshotPath]);
    return;
  }

  const escapedOutput = screenshotPath.replace(/'/g, "''");
  runPowerShell(`
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT {
  public int Left;
  public int Top;
  public int Right;
  public int Bottom;
}
public static class Win32 {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$handle = [IntPtr]::new([int64]'${windowId}')
$rect = New-Object RECT
if (-not [Win32]::GetWindowRect($handle, [ref]$rect)) {
  throw 'GetWindowRect failed'
}
$width = [Math]::Max(1, $rect.Right - $rect.Left)
$height = [Math]::Max(1, $rect.Bottom - $rect.Top)
$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size)
$bitmap.Save('${escapedOutput}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`);
}

type RpcMessage = {
  type?: string;
  ids?: unknown;
  frame?: TerminalFrame;
};

function decodeBinaryFrame(data: unknown): TerminalFrame | null {
  if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
    return decodeTerminalFramePacket(data);
  }
  return null;
}

class RpcSession {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;

  constructor() {
    this.ws = new WebSocket("ws://127.0.0.1:4599");
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          this.ws.close();
        } catch {}
        reject(new Error("RPC websocket timeout"));
      }, 6_000);

      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("RPC websocket error"));
      });
    });
  }

  async listTerminalIds(): Promise<string[]> {
    await this.ready;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error("RPC terminal list timeout"));
      }, 6_000);

      const onMessage = (event: MessageEvent) => {
        let message: RpcMessage | null = null;
        try {
          message = JSON.parse(String(event.data)) as RpcMessage;
        } catch {
          return;
        }
        if (message.type !== "terminal-list" || !Array.isArray(message.ids)) return;
        clearTimeout(timeout);
        this.ws.removeEventListener("message", onMessage);
        resolve(message.ids.filter((entry): entry is string => typeof entry === "string"));
      };

      this.ws.addEventListener("message", onMessage);
      this.ws.send(JSON.stringify({ type: "list" }));
    });
  }

  async waitForTerminalCount(count: number, timeoutMs = 12_000): Promise<string[]> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ids = await this.listTerminalIds();
      if (ids.length >= count) return ids;
      await sleep(250);
    }
    throw new Error(`Timed out waiting for ${count} terminals`);
  }

  async waitForFrame(
    id: string,
    predicate: (frame: TerminalFrame) => boolean,
    timeoutMs = 20_000,
  ): Promise<TerminalFrame> {
    await this.ready;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error(`RPC frame wait timeout for ${id}`));
      }, timeoutMs);

      const onMessage = (event: MessageEvent) => {
        const binaryFrame = decodeBinaryFrame(event.data);
        if (binaryFrame) {
          if (binaryFrame.id !== id || !predicate(binaryFrame)) return;
          clearTimeout(timeout);
          this.ws.removeEventListener("message", onMessage);
          resolve(binaryFrame);
          return;
        }

        let message: RpcMessage | null = null;
        try {
          message = JSON.parse(String(event.data)) as RpcMessage;
        } catch {
          return;
        }
        const frame = message.type === "terminal-frame" ? message.frame : null;
        if (!frame || frame.id !== id || !predicate(frame)) return;
        clearTimeout(timeout);
        this.ws.removeEventListener("message", onMessage);
        resolve(frame);
      };

      this.ws.addEventListener("message", onMessage);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

const flags = parseFlags(process.argv.slice(2));
const screenshotPath =
  typeof flags.out === "string" && flags.out.trim().length > 0
    ? flags.out.trim()
    : "screenshots/opencode-add-pane.png";
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(500, Number(flags["wait-ms"]))
    : 20_000;
const windowName = "agentz";
const launchJson = JSON.stringify({ panes: [{ command: "opencode" }] });

killDashboardProcesses();

const app = Bun.spawn([resolveBunExecutable(), "run", "dev"], {
  env: {
    ...getDesktopLaunchEnv(),
    AGENTZ_LAUNCH: launchJson,
  },
  stdio: ["ignore", "inherit", "inherit"],
});

let failed = false;
let rpc: RpcSession | null = null;

try {
  const start = Date.now();
  let windowId: string | null = null;
  while (!windowId && Date.now() - start < waitMs) {
    await sleep(800);
    windowId = findWindowId(windowName);
  }

  if (!windowId) {
    throw new Error(`Could not find app window within ${waitMs}ms`);
  }

  prepareWindow(windowId);
  await sleep(1_500);

  rpc = new RpcSession();
  const [primaryId] = await rpc.waitForTerminalCount(1);
  if (!primaryId) {
    throw new Error("No initial terminal available");
  }

  await rpc.waitForFrame(primaryId, (frame) => {
    const text = frame.previewLines.join("\n");
    return frame.altScreen === true || text.includes("opencode") || text.includes("Ask anything");
  });

  await sleep(1_000);
  sendAddPaneShortcut(windowId);

  await rpc.waitForTerminalCount(2);
  await sleep(4_000);

  captureWindow(windowId, screenshotPath);
  console.log(`opencode-add-pane: saved ${screenshotPath}`);
} catch (error) {
  failed = true;
  console.error(`opencode-add-pane: ${error instanceof Error ? error.message : "unexpected failure"}`);
} finally {
  rpc?.close();
  app.kill();
  try {
    await app.exited;
  } catch {}
  killDashboardProcesses();
}

if (failed) process.exit(1);

import { dirname } from "node:path";
import { decodeTerminalFramePacket, type TerminalFrame } from "../src/shared/protocol";

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
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString().trim() || proc.stdout.toString().trim()}`,
    );
  }
  return proc.stdout.toString();
}

function bestEffortKill(pattern: string): void {
  Bun.spawnSync(["pkill", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
}

async function stopProcessTree(proc: Bun.Subprocess): Promise<void> {
  try {
    proc.kill();
  } catch {}

  const exited = proc.exited.then(() => true).catch(() => true);
  const timedOut = sleep(4000).then(() => false);
  const cleanExit = await Promise.race([exited, timedOut]);
  if (cleanExit) return;

  bestEffortKill("agentz-dev|ghostty-dashboard-mvp-dev");
  bestEffortKill("electrobun dev --watch");
  bestEffortKill("vite --host 127.0.0.1 --port 5173");
  bestEffortKill("Resources/main.js");
}

function findWindowId(windowName: string): string | null {
  const search = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", windowName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (search.exitCode !== 0) return null;
  const lines = search.stdout.toString().trim().split("\n").filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : null;
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
  private latestFrames = new Map<string, NonNullable<RpcMessage["frame"]>>();

  constructor() {
    this.ws = new WebSocket("ws://127.0.0.1:4599");
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          this.ws.close();
        } catch {}
        reject(new Error("RPC websocket timeout"));
      }, 6000);

      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        this.ws.addEventListener("message", this.handleMessage);
        resolve();
      });

      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("RPC websocket error"));
      });
    });
  }

  private handleMessage = (event: MessageEvent) => {
    const binaryFrame = decodeBinaryFrame(event.data);
    if (binaryFrame) {
      const frame = binaryFrame;
      this.latestFrames.set(frame.id, frame);
      return;
    }
    let message: RpcMessage | null = null;
    try {
      message = JSON.parse(String(event.data)) as RpcMessage;
    } catch {
      return;
    }
    const frame = message.type === "terminal-frame" ? message.frame : null;
    if (!frame?.id) return;
    this.latestFrames.set(frame.id, frame);
  };

  async listTerminalIds(): Promise<string[]> {
    await this.ready;
    return await new Promise<string[]>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error("RPC terminal list timeout"));
      }, 6000);

      const onMessage = (event: MessageEvent) => {
        const binaryFrame = decodeBinaryFrame(event.data);
        if (binaryFrame) {
          const frame = binaryFrame;
          if (frame.id !== id) return;
          if (!predicate(frame)) return;
          clearTimeout(timeout);
          this.ws.removeEventListener("message", onMessage);
          resolve(frame);
          return;
        }
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
    predicate: (frame: NonNullable<RpcMessage["frame"]>) => boolean,
    timeoutMs = 20_000,
  ): Promise<NonNullable<RpcMessage["frame"]>> {
    await this.ready;
    const current = this.latestFrames.get(id);
    if (current && predicate(current)) {
      return current;
    }
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error(`RPC frame wait timeout for ${id}`));
      }, timeoutMs);

      const onMessage = (event: MessageEvent) => {
        let message: RpcMessage | null = null;
        try {
          message = JSON.parse(String(event.data)) as RpcMessage;
        } catch {
          return;
        }
        const frame = message.type === "terminal-frame" ? message.frame : null;
        if (!frame || frame.id !== id) return;
        if (!predicate(frame)) return;
        clearTimeout(timeout);
        this.ws.removeEventListener("message", onMessage);
        resolve(frame);
      };

      this.ws.addEventListener("message", onMessage);
    });
  }

  async sendInput(id: string, data: string): Promise<void> {
    await this.ready;
    this.ws.send(JSON.stringify({ type: "input", id, data }));
  }

  async requestSnapshot(id: string): Promise<void> {
    await this.ready;
    this.ws.send(JSON.stringify({ type: "snapshot", id }));
  }

  latestFrame(id: string): NonNullable<RpcMessage["frame"]> | undefined {
    return this.latestFrames.get(id);
  }

  close(): void {
    try {
      this.ws.removeEventListener("message", this.handleMessage);
      this.ws.close();
    } catch {}
  }
}

function capture(windowId: string, path: string): void {
  runChecked(["mkdir", "-p", dirname(path)]);
  runChecked(["rm", "-f", path]);
  try {
    runChecked(["import", "-window", windowId, path]);
  } catch (error) {
    const grimProbe = Bun.spawnSync(["which", "grim"], { stdout: "pipe", stderr: "pipe" });
    if (grimProbe.exitCode !== 0) throw error;
    runChecked(["grim", path]);
  }
}

function crop(inputPath: string, outputPath: string): void {
  runChecked(["mkdir", "-p", dirname(outputPath)]);
  runChecked(["rm", "-f", outputPath]);
  const cropArgs = [inputPath, "-crop", "360x1080+1040+270", "+repage", outputPath];
  const magickProbe = Bun.spawnSync(["which", "magick"], { stdout: "pipe", stderr: "pipe" });
  if (magickProbe.exitCode === 0) {
    runChecked(["magick", ...cropArgs]);
    return;
  }
  runChecked(["convert", ...cropArgs]);
}

const flags = parseFlags(process.argv.slice(2));
const screenshotPath =
  typeof flags.out === "string" && flags.out.trim().length > 0
    ? flags.out.trim()
    : "screenshots/inactive-pane-preview.png";
const cropPath =
  typeof flags.crop === "string" && flags.crop.trim().length > 0
    ? flags.crop.trim()
    : "screenshots/inactive-pane-preview-crop.png";
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(2000, Number(flags["wait-ms"]))
    : 30_000;
const windowName = "Ghostty Multi-Terminal Dashboard";

const launchJson = JSON.stringify({
  panes: [{ command: "opencode" }, { command: "opencode" }],
});

bestEffortKill("agentz-dev|ghostty-dashboard-mvp-dev");
bestEffortKill("electrobun dev --watch");
bestEffortKill("Resources/main.js");

const app = Bun.spawn(["bash", "-lc", "bun run dev || true"], {
  cwd: process.cwd(),
  env: { ...process.env, GHOSTTY_DASHBOARD_LAUNCH: launchJson },
  stdio: ["ignore", "inherit", "inherit"],
});

let failed = false;
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
  runChecked(["xdotool", "windowsize", "--sync", windowId, "1400", "900"]);
  await sleep(2400);
  runChecked(["xdotool", "mousemove", "--window", windowId, "150", "330", "click", "1"]);

  const rpc = new RpcSession();
  const ids = await rpc.waitForTerminalCount(2);
  const primaryId = ids[0];
  const previewId = ids[1];
  if (!primaryId || !previewId) {
    throw new Error(`Expected 2 terminals, got ${ids.length}`);
  }

  await rpc.requestSnapshot(primaryId);
  await rpc.requestSnapshot(previewId);
  try {
    await rpc.waitForFrame(
      primaryId,
      (frame) => {
        const previewCount = frame.previewLines?.filter((line) => line.trim().length > 0).length ?? 0;
        const screenCount = frame.screenRows?.filter((row) => row.text.trim().length > 0).length ?? 0;
        return frame.altScreen === true && Math.max(previewCount, screenCount) >= 1;
      },
      12_000,
    );
    await rpc.waitForFrame(
      previewId,
      (frame) => {
        const previewCount = frame.previewLines?.filter((line) => line.trim().length > 0).length ?? 0;
        const screenCount = frame.screenRows?.filter((row) => row.text.trim().length > 0).length ?? 0;
        return frame.altScreen === true && Math.max(previewCount, screenCount) >= 1;
      },
      12_000,
    );
  } catch {
    await sleep(12_000);
  }
  await rpc.sendInput(primaryId, "hi\r");
  await sleep(2500);

  capture(windowId, screenshotPath);
  crop(screenshotPath, cropPath);
  rpc.close();
  console.log(`inactive-pane-preview-screenshot: saved ${screenshotPath}`);
  console.log(`inactive-pane-preview-screenshot: saved ${cropPath}`);
} catch (error) {
  failed = true;
  console.error(`inactive-pane-preview-screenshot: ${error instanceof Error ? error.message : "unexpected failure"}`);
} finally {
  await stopProcessTree(app);
}

process.exit(failed ? 1 : 0);

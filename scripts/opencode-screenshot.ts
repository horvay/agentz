import { dirname } from "node:path";

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

function runChecked(cmd: string[]): void {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString().trim() || proc.stdout.toString().trim()}`,
    );
  }
}

function findWindowId(windowName: string): string | null {
  const search = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", windowName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (search.exitCode !== 0) return null;
  const lines = search.stdout.toString().trim().split("\n").filter(Boolean);
  // Newer window IDs are typically at the end of the list.
  return lines.length > 0 ? lines[lines.length - 1] : null;
}

type RpcMessage = {
  type?: string;
  ids?: unknown;
  frame?: {
    id?: string;
    seq?: number;
    altScreen?: boolean;
    previewLines?: string[];
    vt?: string;
  };
};

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
      }, 6000);

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

  async listFirstTerminalId(): Promise<string> {
    await this.ready;
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error("RPC terminal list timeout"));
      }, 6000);

      const onMessage = (event: MessageEvent) => {
        let message: RpcMessage | null = null;
        try {
          message = JSON.parse(String(event.data)) as RpcMessage;
        } catch {
          return;
        }
        if (message.type !== "terminal-list" || !Array.isArray(message.ids)) return;
        const first = message.ids.find((entry): entry is string => typeof entry === "string");
        clearTimeout(timeout);
        this.ws.removeEventListener("message", onMessage);
        if (!first) {
          reject(new Error("No terminals available"));
          return;
        }
        resolve(first);
      };

      this.ws.addEventListener("message", onMessage);
      this.ws.send(JSON.stringify({ type: "list" }));
    });
  }

  async waitForFrame(
    id: string,
    predicate: (frame: NonNullable<RpcMessage["frame"]>) => boolean,
    timeoutMs = 20_000,
  ): Promise<NonNullable<RpcMessage["frame"]>> {
    await this.ready;
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error("RPC frame wait timeout"));
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
    : "screenshots/opencode-hi.png";
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(500, Number(flags["wait-ms"]))
    : 20_000;
const windowName = "Ghostty Multi-Terminal Dashboard";

const launchJson = JSON.stringify({ panes: [{ command: "opencode" }] });

// Ensure only one app instance owns the RPC port and window.
	Bun.spawnSync(["pkill", "-f", "agentz-dev|ghostty-dashboard-mvp-dev"]);
Bun.spawnSync(["pkill", "-f", "electrobun dev --watch"]);
Bun.spawnSync(["pkill", "-f", "Resources/main.js"]);

const app = Bun.spawn(["bash", "-lc", "bun run dev || true"], {
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

  // Ensure the app receives keyboard focus before typing.
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
  await sleep(1200);
  runChecked(["xdotool", "mousemove", "--window", windowId, "140", "180", "click", "1"]);
  await sleep(400);

  const rpc = new RpcSession();
  const terminalId = await rpc.listFirstTerminalId();
  await rpc.waitForFrame(terminalId, (frame) => {
    const text = Array.isArray(frame.previewLines) ? frame.previewLines.join("\n") : "";
    return frame.altScreen === true || text.includes("opencode") || text.includes("Ask anything");
  });
  await sleep(600);
  await rpc.sendInput(terminalId, "hi\r");
  await rpc.waitForFrame(terminalId, (frame) => typeof frame.seq === "number" && frame.seq > 1, 12_000);
  await sleep(5000);

  runChecked(["mkdir", "-p", dirname(screenshotPath)]);
  runChecked(["rm", "-f", screenshotPath]);
  runChecked(["import", "-window", windowId, screenshotPath]);
  rpc.close();
  console.log(`opencode-screenshot: saved ${screenshotPath}`);
} catch (error) {
  failed = true;
  console.error(
    `opencode-screenshot: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
} finally {
  app.kill();
  try {
    await app.exited;
  } catch {}
}

if (failed) process.exit(1);

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

function runChecked(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${proc.exitCode}): ${
        proc.stderr.toString().trim() || proc.stdout.toString().trim()
      }`,
    );
  }
  return proc.stdout.toString();
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
        let message: { type?: string; ids?: unknown } | null = null;
        try {
          message = JSON.parse(String(event.data)) as { type?: string; ids?: unknown };
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

function nonsenseToken(index: number): string {
  const chunks = [
    "snat",
    "oesn",
    "thao",
    "sent",
    "ntha",
    "esnt",
    "haos",
    "te",
  ];
  const width = 3 + (index % 4);
  return Array.from({ length: width }, (_, offset) => chunks[(index + offset) % chunks.length]).join("");
}

const flags = parseFlags(process.argv.slice(2));
const screenshotPath =
  typeof flags.out === "string" && flags.out.trim().length > 0
    ? flags.out.trim()
    : "screenshots/shell-scroll-nonsense.png";
const commandCount =
  typeof flags.count === "string" && Number.isFinite(Number(flags.count))
    ? Math.max(10, Number(flags.count))
    : 24;
const perCommandWaitMs =
  typeof flags["per-command-wait-ms"] === "string" && Number.isFinite(Number(flags["per-command-wait-ms"]))
    ? Math.max(20, Number(flags["per-command-wait-ms"]))
    : 140;
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(1000, Number(flags["wait-ms"]))
    : 25_000;
const windowName = "Ghostty Multi-Terminal Dashboard";

	Bun.spawnSync(["pkill", "-f", "agentz-dev|ghostty-dashboard-mvp-dev"]);
Bun.spawnSync(["pkill", "-f", "electronmon|\\.electron/index\\.js"]);
Bun.spawnSync(["pkill", "-f", "\\.electron/index\\.js"]);

const app = Bun.spawn(["bash", "-lc", "bun run dev || true"], {
  env: { ...process.env },
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
  await sleep(2200);
  runChecked(["xdotool", "mousemove", "--window", windowId, "90", "135", "click", "1"]);

  const rpc = new RpcSession();
  const terminalId = await rpc.listFirstTerminalId();

  for (let index = 0; index < commandCount; index += 1) {
    await rpc.sendInput(terminalId, `${nonsenseToken(index)}\r`);
    await sleep(perCommandWaitMs);
  }

  await sleep(1500);
  capture(windowId, screenshotPath);
  rpc.close();
  console.log(`shell-scroll-screenshot: saved ${screenshotPath}`);
} catch (error) {
  failed = true;
  console.error(
    `shell-scroll-screenshot: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
} finally {
  app.kill();
  try {
    await app.exited;
  } catch {}
}

if (failed) process.exit(1);

import { dirname, join } from "node:path";

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

async function stopProcessTree(proc: Bun.Subprocess): Promise<void> {
  try {
    proc.kill();
  } catch {}

  const exited = proc.exited.then(() => true).catch(() => true);
  const timedOut = sleep(4000).then(() => false);
  const cleanExit = await Promise.race([exited, timedOut]);
  if (cleanExit) return;

  try {
    Bun.spawnSync(["pkill", "-f", "ghostty-dashboard-mvp-dev"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  try {
    Bun.spawnSync(["pkill", "-f", "electrobun dev --watch"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  try {
    Bun.spawnSync(["pkill", "-f", "vite --host 127.0.0.1 --port 5173"], { stdout: "ignore", stderr: "ignore" });
  } catch {}
}

function runChecked(cmd: string[], env?: Record<string, string>): string {
  const proc = Bun.spawnSync(cmd, {
    env: env ? { ...process.env, ...env } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
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
  return lines.at(-1) ?? null;
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

function bestEffortKill(pattern: string): void {
  Bun.spawnSync(["pkill", "-f", pattern], { stdout: "ignore", stderr: "ignore" });
}

const flags = parseFlags(process.argv.slice(2));
const screenshotPath =
  typeof flags.out === "string" && flags.out.trim().length > 0
    ? flags.out.trim()
    : "screenshots/nvim-insert-mode.png";
const fileName =
  typeof flags.file === "string" && flags.file.trim().length > 0 ? flags.file.trim() : "test.txt";
const typedText =
  typeof flags.text === "string" && flags.text.trim().length > 0 ? flags.text : "hello";
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(1000, Number(flags["wait-ms"]))
    : 25_000;
const windowName = "Ghostty Multi-Terminal Dashboard";

const tempRoot = runChecked(["mktemp", "-d", "/tmp/agentz-nvim-XXXXXX"]).trim();
const launchEnv = {
  GHOSTTY_DASHBOARD_LAUNCH_CWD: tempRoot,
};

runChecked(["rm", "-f", join(tempRoot, fileName)]);
bestEffortKill("ghostty-dashboard-mvp-dev");
bestEffortKill("electrobun dev --watch");
bestEffortKill("Resources/main.js");

const app = Bun.spawn(["bun", "run", "dev"], {
  cwd: process.cwd(),
  env: { ...process.env, ...launchEnv },
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
  runChecked(["xdotool", "windowsize", "--sync", windowId, "1200", "900"]);
  await sleep(2200);
  runChecked(["xdotool", "mousemove", "--window", windowId, "110", "150", "click", "1"]);

  const rpc = new RpcSession();
  const terminalId = await rpc.listFirstTerminalId();

  await rpc.sendInput(terminalId, `nvim ${fileName}\r`);
  await sleep(2200);
  await rpc.sendInput(terminalId, `i${typedText}`);
  await sleep(1200);

  capture(windowId, screenshotPath);
  rpc.close();
  console.log(`nvim-screenshot: saved ${screenshotPath}`);
  console.log(`nvim-screenshot: cwd ${tempRoot}`);
} catch (error) {
  failed = true;
  console.error(`nvim-screenshot: ${error instanceof Error ? error.message : "unexpected failure"}`);
} finally {
  await stopProcessTree(app);
}

process.exit(failed ? 1 : 0);

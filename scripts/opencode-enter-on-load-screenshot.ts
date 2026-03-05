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
  return lines.at(-1) ?? null;
}

async function sendInputViaRpc(id: string, data: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:4599");
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("RPC websocket timeout"));
    }, 6000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "input", id, data }));
      setTimeout(() => {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        resolve();
      }, 150);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("RPC websocket error"));
    });
  });
}

async function getFirstTerminalId(): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket("ws://127.0.0.1:4599");
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error("RPC terminal list timeout"));
    }, 6000);

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "list" }));
    });

    ws.addEventListener("message", (event) => {
      let message: { type?: string; ids?: unknown } | null = null;
      try {
        message = JSON.parse(String(event.data)) as { type?: string; ids?: unknown };
      } catch {
        return;
      }
      if (message.type !== "terminal-list" || !Array.isArray(message.ids)) return;
      const first = message.ids.find((entry): entry is string => typeof entry === "string");
      if (!first) {
        clearTimeout(timeout);
        try {
          ws.close();
        } catch {}
        reject(new Error("No terminals available"));
        return;
      }
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {}
      resolve(first);
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("RPC terminal list websocket error"));
    });
  });
}

const flags = parseFlags(process.argv.slice(2));
const screenshotPath =
  typeof flags.out === "string" && flags.out.trim().length > 0
    ? flags.out.trim()
    : "screenshots/enter-on-load-shell.png";
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(500, Number(flags["wait-ms"]))
    : 20_000;
const windowName = "Ghostty Multi-Terminal Dashboard";

Bun.spawnSync(["pkill", "-f", "ghostty-dashboard-mvp-dev"]);
Bun.spawnSync(["pkill", "-f", "electrobun dev --watch"]);
Bun.spawnSync(["pkill", "-f", "Resources/main.js"]);

const app = Bun.spawn(["bun", "run", "dev"], {
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

  // Wait for shell startup, then target pane A and send Enter + text via RPC input path.
  await sleep(2200);
  runChecked(["xdotool", "mousemove", "--window", windowId, "90", "135", "click", "1"]);
  await sleep(120);
  const firstTerminalId = await getFirstTerminalId();
  await sendInputViaRpc(firstTerminalId, "\n");
  await sleep(120);
  await sendInputViaRpc(firstTerminalId, "test");
  await sleep(3200);

  runChecked(["mkdir", "-p", dirname(screenshotPath)]);
  runChecked(["rm", "-f", screenshotPath]);
  runChecked(["import", "-window", windowId, screenshotPath]);
  console.log(`opencode-enter-on-load-screenshot: saved ${screenshotPath}`);
} catch (error) {
  failed = true;
  console.error(
    `opencode-enter-on-load-screenshot: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
} finally {
  app.kill();
  await app.exited;
}

if (failed) process.exit(1);

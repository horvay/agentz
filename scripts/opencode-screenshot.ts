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
  return lines.at(-1) ?? null;
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

const launchJson = JSON.stringify({ paneA: { command: "opencode" } });

// Ensure only one app instance owns the RPC port and window.
Bun.spawnSync(["pkill", "-f", "ghostty-dashboard-mvp-dev"]);
Bun.spawnSync(["pkill", "-f", "electrobun dev --watch"]);
Bun.spawnSync(["pkill", "-f", "Resources/main.js"]);

const app = Bun.spawn(["bun", "run", "dev"], {
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
  await sleep(700);
  runChecked(["xdotool", "mousemove", "--window", windowId, "140", "180", "click", "1"]);
  await sleep(400);
  runChecked(["xdotool", "type", "--window", windowId, "--delay", "80", "hi"]);
  runChecked(["xdotool", "key", "--window", windowId, "Return"]);
  await sleep(3200);
  runChecked(["mkdir", "-p", dirname(screenshotPath)]);
  runChecked(["rm", "-f", screenshotPath]);
  runChecked(["import", "-window", windowId, screenshotPath]);
  console.log(`opencode-screenshot: saved ${screenshotPath}`);
} catch (error) {
  failed = true;
  console.error(
    `opencode-screenshot: ${error instanceof Error ? error.message : "unexpected failure"}`,
  );
} finally {
  app.kill();
  await app.exited;
}

if (failed) process.exit(1);

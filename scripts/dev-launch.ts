import { killDashboardProcesses } from "./kill-dashboard-processes";
import { resolveBunExecutable } from "./runtime";

interface PaneLaunchConfig {
  command?: string;
  args?: string[];
  cwd?: string;
}

export {};

interface LaunchConfig {
  panes?: PaneLaunchConfig[];
}

function parseCsv(input: string | undefined): string[] | undefined {
  if (!input) return undefined;
  const values = input
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

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

function getLaunchConfig(flags: Record<string, string | boolean>): LaunchConfig {
  const panesByIndex = new Map<number, PaneLaunchConfig>();
  const indexedPattern = /^pane-(\d+)-(cmd|args|cwd|opencode)$/;
  for (const [key, value] of Object.entries(flags)) {
    const match = key.match(indexedPattern);
    if (!match) continue;
    const paneIndex = Number(match[1]);
    if (!Number.isFinite(paneIndex) || paneIndex < 1) continue;
    const field = match[2];
    const pane = panesByIndex.get(paneIndex) ?? {};
    if (field === "cmd" && typeof value === "string") pane.command = value;
    if (field === "args" && typeof value === "string") pane.args = parseCsv(value);
    if (field === "cwd" && typeof value === "string") pane.cwd = value;
    if (field === "opencode" && value === true) pane.command = "opencode";
    panesByIndex.set(paneIndex, pane);
  }
  const indexedPanes = [...panesByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, pane]) => pane)
    .filter((pane) => Object.keys(pane).length > 0);
  if (indexedPanes.length > 0) {
    return { panes: indexedPanes };
  }
  return {
    panes: [{}],
  };
}

const flags = parseFlags(process.argv.slice(2));
const launch = getLaunchConfig(flags);
const launchJson = JSON.stringify(launch);

console.log("Launching app with config:", launchJson);

// Ensure only one app instance owns the RPC port.
killDashboardProcesses();

const proc = Bun.spawn([resolveBunExecutable(), "run", "dev"], {
  env: {
    ...process.env,
    AGENTZ_LAUNCH: launchJson,
  },
  stdio: ["inherit", "inherit", "inherit"],
});

const code = await proc.exited;
process.exit(code);

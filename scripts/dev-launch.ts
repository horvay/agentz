interface PaneLaunchConfig {
  command?: string;
  args?: string[];
  cwd?: string;
}

interface LaunchConfig {
  paneA?: PaneLaunchConfig;
  paneB?: PaneLaunchConfig;
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
  const paneA: PaneLaunchConfig = {};
  const paneB: PaneLaunchConfig = {};

  if (typeof flags["pane-a-cmd"] === "string") paneA.command = flags["pane-a-cmd"];
  if (typeof flags["pane-a-args"] === "string") paneA.args = parseCsv(flags["pane-a-args"]);
  if (typeof flags["pane-a-cwd"] === "string") paneA.cwd = flags["pane-a-cwd"];

  if (typeof flags["pane-b-cmd"] === "string") paneB.command = flags["pane-b-cmd"];
  if (typeof flags["pane-b-args"] === "string") paneB.args = parseCsv(flags["pane-b-args"]);
  if (typeof flags["pane-b-cwd"] === "string") paneB.cwd = flags["pane-b-cwd"];

  if (flags["pane-a-opencode"] === true) paneA.command = "opencode";
  if (flags["pane-b-opencode"] === true) paneB.command = "opencode";

  return {
    paneA: Object.keys(paneA).length > 0 ? paneA : undefined,
    paneB: Object.keys(paneB).length > 0 ? paneB : undefined,
  };
}

const flags = parseFlags(process.argv.slice(2));
const launch = getLaunchConfig(flags);
const launchJson = JSON.stringify(launch);

console.log("Launching app with config:", launchJson);

// Ensure only one app instance owns the RPC port.
Bun.spawnSync(["pkill", "-f", "ghostty-dashboard-mvp-dev"]);
Bun.spawnSync(["pkill", "-f", "electrobun dev --watch"]);
Bun.spawnSync(["pkill", "-f", "Resources/main.js"]);

const proc = Bun.spawn(["bun", "run", "dev"], {
  env: {
    ...process.env,
    GHOSTTY_DASHBOARD_LAUNCH: launchJson,
  },
  stdio: ["inherit", "inherit", "inherit"],
});

const code = await proc.exited;
process.exit(code);

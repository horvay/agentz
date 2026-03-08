import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const buildDir = process.env.ELECTROBUN_BUILD_DIR;
const appName = process.env.ELECTROBUN_APP_NAME;
const targetOs = process.env.ELECTROBUN_OS;

if (!buildDir || !appName || !targetOs) {
	throw new Error("Missing Electrobun post-build environment");
}

if (targetOs !== "linux") {
	process.exit(0);
}

const appDir = join(buildDir, appName);
const launcherPath = join(appDir, "bin", "launcher");
const realLauncherPath = join(appDir, "bin", "launcher.real");
const viewsDir = join(appDir, "Resources", "app", "views", "mainview");
const distDir = join(process.cwd(), "dist");

if (!existsSync(launcherPath)) {
	throw new Error(`Launcher not found at ${launcherPath}`);
}

if (!existsSync(realLauncherPath)) {
	renameSync(launcherPath, realLauncherPath);
}

mkdirSync(viewsDir, { recursive: true });
cpSync(join(distDir, "index.html"), join(viewsDir, "index.html"));
cpSync(join(distDir, "assets"), join(viewsDir, "assets"), { recursive: true });

const launcherScript = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export WEBKIT_DISABLE_DMABUF_RENDERER="\${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export LIBGL_ALWAYS_SOFTWARE="\${LIBGL_ALWAYS_SOFTWARE:-1}"
export GHOSTTY_DASHBOARD_LAUNCH_CWD="\${GHOSTTY_DASHBOARD_LAUNCH_CWD:-$PWD}"
cd "$SCRIPT_DIR"
exec "$SCRIPT_DIR/launcher.real" "$@"
`;

const existing = existsSync(launcherPath) ? readFileSync(launcherPath, "utf8") : "";
if (existing !== launcherScript) {
	writeFileSync(launcherPath, launcherScript);
}
chmodSync(launcherPath, 0o755);

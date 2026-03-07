import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

if (!existsSync(launcherPath)) {
	throw new Error(`Launcher not found at ${launcherPath}`);
}

if (!existsSync(realLauncherPath)) {
	renameSync(launcherPath, realLauncherPath);
}

const launcherScript = `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export WEBKIT_DISABLE_DMABUF_RENDERER="\${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export LIBGL_ALWAYS_SOFTWARE="\${LIBGL_ALWAYS_SOFTWARE:-1}"
exec "$SCRIPT_DIR/launcher.real" "$@"
`;

const existing = existsSync(launcherPath) ? readFileSync(launcherPath, "utf8") : "";
if (existing !== launcherScript) {
	writeFileSync(launcherPath, launcherScript);
}
chmodSync(launcherPath, 0o755);

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const targetOs = process.env.ELECTROBUN_OS;
const artifactDir = process.env.ELECTROBUN_ARTIFACT_DIR;
const buildEnv = process.env.ELECTROBUN_BUILD_ENV;
const appName = process.env.ELECTROBUN_APP_NAME;
const appIdentifier = process.env.ELECTROBUN_APP_IDENTIFIER;
const arch = process.env.ELECTROBUN_ARCH;

if (!targetOs || !artifactDir || !buildEnv || !appName || !appIdentifier || !arch) {
	throw new Error("Missing Electrobun post-package environment");
}

if (targetOs !== "linux") {
	process.exit(0);
}

const platformPrefix = `${buildEnv}-linux-${arch}`;
const archiveName = `${platformPrefix}-${appName}.tar.zst`;
const setupName = `${platformPrefix}-${appName}-Setup.tar.gz`;
const archivePath = join(artifactDir, archiveName);
const setupPath = join(artifactDir, setupName);

if (!existsSync(archivePath)) {
	// `electrobun dev --watch` invokes postPackage without producing a portable archive.
	process.exit(0);
}

const stagingDir = join(artifactDir, ".setup-staging");
rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

const installerPath = join(stagingDir, "installer");
const readmePath = join(stagingDir, "README.txt");
const bundledArchivePath = join(stagingDir, archiveName);

const installerScript = `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ARCHIVE_NAME="${archiveName}"
APP_IDENTIFIER="${appIdentifier}"
CHANNEL="${buildEnv}"
COMMAND_NAME="agentz"

INSTALL_ROOT="\${XDG_DATA_HOME:-$HOME/.local/share}/$APP_IDENTIFIER/$CHANNEL"
mkdir -p "$INSTALL_ROOT"
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

tar --zstd -xf "$SCRIPT_DIR/$ARCHIVE_NAME" -C "$TMP_DIR"

APP_DIR_NAME="$(find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type d | head -n 1 | xargs -r basename)"
if [ -z "$APP_DIR_NAME" ]; then
  echo "Failed to find extracted app directory" >&2
  exit 1
fi

TARGET_DIR="$INSTALL_ROOT/$APP_DIR_NAME"
rm -rf "$TARGET_DIR"
mv "$TMP_DIR/$APP_DIR_NAME" "$TARGET_DIR"

LAUNCHER_PATH="$TARGET_DIR/bin/launcher"
WRAPPER_PATH="$BIN_DIR/$COMMAND_NAME"
printf '#!/usr/bin/env bash\nexec %q "$@"\n' "$LAUNCHER_PATH" > "$WRAPPER_PATH"
chmod +x "$WRAPPER_PATH"

echo "Installed to: $TARGET_DIR"
echo "Launcher: $LAUNCHER_PATH"
echo "Command installed to: $WRAPPER_PATH"
case ":$PATH:" in
  *":$BIN_DIR:"*)
    echo "Run with: $COMMAND_NAME"
    ;;
  *)
    echo "Run with: $WRAPPER_PATH"
    echo "Note: add $BIN_DIR to your PATH to run '$COMMAND_NAME' directly."
    ;;
esac
`;

const readme = `${appName} Installer
========================

To install ${appName}:

1. Extract this archive
2. Run: ./installer

The installer will:
- Extract the app under ~/.local/share/${appIdentifier}/${buildEnv}/
- Install a user launcher at ~/.local/bin/agentz
- Print the exact launcher path to run
`;

writeFileSync(installerPath, installerScript);
chmodSync(installerPath, 0o755);
writeFileSync(readmePath, readme);
// Hard link or symlink support is unnecessary; just include the archive file directly in the setup tarball.
writeFileSync(
	join(stagingDir, ".tar-manifest"),
	`${archiveName}\nREADME.txt\ninstaller\n`,
);

await Bun.write(bundledArchivePath, Bun.file(archivePath));

const proc = Bun.spawnSync(
	["tar", "-czf", setupPath, "-C", stagingDir, archiveName, "README.txt", "installer"],
	{ stdio: ["ignore", "inherit", "inherit"] },
);

if (proc.exitCode !== 0) {
	throw new Error(`Failed to create ${setupPath}`);
}

rmSync(stagingDir, { recursive: true, force: true });

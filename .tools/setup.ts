import { $ } from "bun";
import { existsSync } from "fs";
import { join } from "path";

const ZIG_VERSION = "0.15.2";

const TARGETS: Record<string, string> = {
  "linux-x64": `zig-x86_64-linux-${ZIG_VERSION}`,
  "win32-x64": `zig-x86_64-windows-${ZIG_VERSION}`,
  "darwin-x64": `zig-x86_64-macos-${ZIG_VERSION}`,
  "darwin-arm64": `zig-aarch64-macos-${ZIG_VERSION}`,
};

const key = `${process.platform}-${process.arch}`;
const target = TARGETS[key];
if (!target) {
  console.error(`Unsupported platform: ${key}`);
  process.exit(1);
}

const toolsDir = import.meta.dir;
const zigDir = join(toolsDir, target);

if (existsSync(zigDir)) {
  console.log(`Zig ${ZIG_VERSION} already installed at ${zigDir}`);
  process.exit(0);
}

const archiveExt = process.platform === "win32" ? "zip" : "tar.xz";
const url = `https://ziglang.org/download/${ZIG_VERSION}/${target}.${archiveExt}`;
const tarball = join(toolsDir, `zig-${ZIG_VERSION}.${archiveExt}`);

console.log(`Downloading ${url} ...`);
if (process.platform === "win32") {
  await $`curl --ssl-no-revoke -fSL -o ${tarball} ${url}`;
} else {
  await $`curl -fSL -o ${tarball} ${url}`;
}

console.log("Extracting...");
if (process.platform === "win32") {
  await $`powershell -NoProfile -Command Expand-Archive -LiteralPath ${tarball} -DestinationPath ${toolsDir}`;
} else {
  await $`tar -xf ${tarball} -C ${toolsDir}`;
}

console.log("Cleaning up tarball...");
await $`rm ${tarball}`;

console.log(`Zig ${ZIG_VERSION} installed to ${zigDir}`);

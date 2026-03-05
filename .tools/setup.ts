import { $ } from "bun";
import { existsSync } from "fs";
import { join } from "path";

const ZIG_VERSION = "0.15.2";

const TARGETS: Record<string, string> = {
  "linux-x64": `zig-x86_64-linux-${ZIG_VERSION}`,
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

const url = `https://ziglang.org/download/${ZIG_VERSION}/${target}.tar.xz`;
const tarball = join(toolsDir, `zig-${ZIG_VERSION}.tar.xz`);

console.log(`Downloading ${url} ...`);
await $`curl -fSL -o ${tarball} ${url}`;

console.log("Extracting...");
await $`tar -xf ${tarball} -C ${toolsDir}`;

console.log("Cleaning up tarball...");
await $`rm ${tarball}`;

console.log(`Zig ${ZIG_VERSION} installed to ${zigDir}`);

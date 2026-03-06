import { mkdir, access, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const root = process.cwd();
const target = join(root, "node_modules", "node-pty", "prebuilds", "linux-x64", "pty.node");
const fallback = join(root, "node_modules", "node-pty", "build", "Release", "pty.node");

if (!(await exists(target))) {
  if (!(await exists(fallback))) {
    throw new Error(`node-pty binary not found at ${fallback}`);
  }
  await mkdir(dirname(target), { recursive: true });
  await copyFile(fallback, target);
  console.log(`prepare-node-pty: copied ${fallback} -> ${target}`);
} else {
  console.log(`prepare-node-pty: found ${target}`);
}

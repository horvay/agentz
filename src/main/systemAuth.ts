import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";

const AUTH_SUCCESS_EXIT_CODE = 0;
const AUTH_INVALID_EXIT_CODE = 10;
const DEFAULT_PAM_SERVICES = ["login", "system-local-login", "system-login", "system-auth"];

function helperBasenameForPlatform(platform: NodeJS.Platform): string | null {
  if (platform === "linux") return "agentz-pam-auth-helper";
  if (platform === "darwin") return "agentz-macos-auth-helper";
  if (platform === "win32") return "agentz-windows-auth-helper.exe";
  return null;
}

function resolvePamService(): string {
  const configured = process.env.AGENTZ_PAM_SERVICE?.trim();
  if (configured) return configured;

  for (const candidate of DEFAULT_PAM_SERVICES) {
    if (existsSync(join("/etc/pam.d", candidate))) {
      return candidate;
    }
  }

  return "login";
}

export function platformLabel(platform: NodeJS.Platform): string {
  if (platform === "linux") return "Linux";
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return platform;
}

export function suggestedSystemUsername(): string {
  try {
    return os.userInfo().username || "agentz";
  } catch {
    return "agentz";
  }
}

export function resolveSystemAuthHelperPath(
  platform: NodeJS.Platform = process.platform,
  rootCwd = process.env.AGENTZ_ROOT ?? process.cwd(),
): string | null {
  const helperBasename = helperBasenameForPlatform(platform);
  if (!helperBasename) return null;

  const direct = join(rootCwd, "src", "native", "zig-out", "bin", helperBasename);
  if (existsSync(direct)) return direct;

  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (electronResourcesPath) {
    const packaged = join(electronResourcesPath, "bin", helperBasename);
    if (existsSync(packaged)) return packaged;
  }

  const execDir = dirname(process.execPath);
  const packaged = join(execDir, "..", "Resources", "app", "bin", helperBasename);
  if (existsSync(packaged)) return packaged;

  return direct;
}

export async function authenticateSystemUser(
  platform: NodeJS.Platform,
  username: string,
  password: string,
): Promise<boolean> {
  const helperPath = resolveSystemAuthHelperPath(platform);
  if (!helperPath || !existsSync(helperPath)) {
    throw new Error(`System auth helper missing for ${platformLabel(platform)}; run bun run native:build.`);
  }

  const trimmedUsername = username.trim();
  if (!trimmedUsername) {
    return false;
  }

  const args = [trimmedUsername];
  if (platform === "linux") {
    args.push(resolvePamService());
  }

  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(helperPath, args, {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("exit", (code) => {
      if (code === AUTH_SUCCESS_EXIT_CODE) {
        resolve(true);
        return;
      }
      if (code === AUTH_INVALID_EXIT_CODE) {
        resolve(false);
        return;
      }
      reject(new Error(`${platformLabel(platform)} auth helper exited with code ${code ?? "unknown"}.`));
    });

    child.stdin.end(`${password}\n`);
  });
}

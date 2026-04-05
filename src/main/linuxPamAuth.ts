import { existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PAM_HELPER_BASENAME = "agentz-pam-auth-helper";
const AUTH_SUCCESS_EXIT_CODE = 0;
const AUTH_INVALID_EXIT_CODE = 10;
const DEFAULT_PAM_SERVICES = ["login", "system-local-login", "system-login", "system-auth"];

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

export function resolvePamHelperPath(rootCwd = process.env.AGENTZ_ROOT ?? process.cwd()): string {
  return join(rootCwd, "src", "native", "zig-out", "bin", PAM_HELPER_BASENAME);
}

export function suggestedSystemUsername(): string {
  try {
    return os.userInfo().username || "agentz";
  } catch {
    return "agentz";
  }
}

export async function authenticateLinuxSystemUser(username: string, password: string): Promise<boolean> {
  const helperPath = resolvePamHelperPath();
  if (!existsSync(helperPath)) {
    throw new Error(`Linux PAM helper missing at ${helperPath}; run bun run native:build or bun run web.`);
  }

  const trimmedUsername = username.trim();
  if (!trimmedUsername) {
    return false;
  }

  return await new Promise<boolean>((resolve, reject) => {
    const child = spawn(helperPath, [trimmedUsername, resolvePamService()], {
      stdio: ["pipe", "ignore", "ignore"],
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
      reject(new Error(`PAM helper exited with code ${code ?? "unknown"}.`));
    });

    child.stdin.end(`${password}\n`);
  });
}

import { spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";

const SHELL_ENV_START_MARKER = "__AGENTZ_SHELL_ENV_START__";
const SHELL_ENV_END_MARKER = "__AGENTZ_SHELL_ENV_END__";
const SHELL_ENV_COMMAND = [
  `printf '%s\\n' '${SHELL_ENV_START_MARKER}'`,
  "env -0",
  `printf '\\n%s\\n' '${SHELL_ENV_END_MARKER}'`,
].join("; ");
const SHELL_ENV_TIMEOUT_MS = 4_000;
const SHELL_ENV_MAX_BUFFER = 2 * 1024 * 1024;

function isExecutablePath(path: string | undefined): path is string {
  if (!path) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveMacShellPath(env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [env.SHELL?.trim(), "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (isExecutablePath(candidate)) return candidate;
  }
  return "/bin/zsh";
}

export function parseShellEnvOutput(
  stdout: Buffer,
  startMarker = SHELL_ENV_START_MARKER,
  endMarker = SHELL_ENV_END_MARKER,
): NodeJS.ProcessEnv | null {
  const startBytes = Buffer.from(startMarker);
  const endBytes = Buffer.from(endMarker);
  const startIndex = stdout.indexOf(startBytes);
  if (startIndex < 0) return null;
  const payloadStart = startIndex + startBytes.byteLength;
  const endIndex = stdout.indexOf(endBytes, payloadStart);
  if (endIndex < 0) return null;

  let payload = stdout.subarray(payloadStart, endIndex);
  while (payload.byteLength > 0 && (payload[0] === 0x0a || payload[0] === 0x0d)) {
    payload = payload.subarray(1);
  }
  while (
    payload.byteLength > 0 &&
    (payload[payload.byteLength - 1] === 0x00 ||
      payload[payload.byteLength - 1] === 0x0a ||
      payload[payload.byteLength - 1] === 0x0d)
  ) {
    payload = payload.subarray(0, payload.byteLength - 1);
  }

  const resolvedEnv: NodeJS.ProcessEnv = {};
  for (const entry of payload.toString("utf8").split("\u0000")) {
    if (!entry) continue;
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = entry.slice(0, separatorIndex);
    const value = entry.slice(separatorIndex + 1);
    resolvedEnv[key] = value;
  }

  return Object.keys(resolvedEnv).length > 0 ? resolvedEnv : null;
}

export function mergeEnvironment(
  targetEnv: NodeJS.ProcessEnv,
  nextEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  for (const [key, value] of Object.entries(nextEnv)) {
    if (typeof value === "string") {
      targetEnv[key] = value;
    }
  }
  return targetEnv;
}

export function loadMacShellEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv | null {
  const shellPath = resolveMacShellPath(env);
  const result = spawnSync(shellPath, ["-ilc", SHELL_ENV_COMMAND], {
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SHELL_ENV_TIMEOUT_MS,
    maxBuffer: SHELL_ENV_MAX_BUFFER,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  const stdout = result.stdout instanceof Buffer ? result.stdout : Buffer.from(result.stdout ?? "");
  const parsed = parseShellEnvOutput(stdout);
  if (parsed) return parsed;

  if (result.status !== 0) {
    const stderr = result.stderr instanceof Buffer ? result.stderr.toString("utf8").trim() : "";
    throw new Error(
      stderr.length > 0
        ? `shell env probe exited ${result.status}: ${stderr}`
        : `shell env probe exited ${result.status}`,
    );
  }

  return null;
}

export function applyMacShellEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (process.platform !== "darwin") return;
  try {
    const shellEnv = loadMacShellEnvironment(env);
    if (!shellEnv) return;
    mergeEnvironment(env, shellEnv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[shell-env] unable to import macOS shell environment: ${message}`);
  }
}

import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveBunExecutable(): string {
  const execPath = process.execPath || "";
  if (execPath.toLowerCase().includes("bun")) {
    return execPath;
  }
  return "bun";
}

export function getDesktopLaunchEnv(cwd = process.cwd()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTZ_ROOT: cwd,
    AGENTZ_LAUNCH_CWD: cwd,
  };

  if (process.platform !== "win32") {
    env.WEBKIT_DISABLE_DMABUF_RENDERER = "1";
    env.LIBGL_ALWAYS_SOFTWARE = "1";
  }

  return env;
}

export async function runInherited(
  cmd: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<number> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdio: [process.platform === "win32" ? "ignore" : "inherit", "inherit", "inherit"],
  });
  return await proc.exited;
}

export function spawnInherited(
  cmd: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  return Bun.spawn(cmd, {
    cwd: options.cwd,
    env: options.env,
    stdio: [process.platform === "win32" ? "ignore" : "inherit", "inherit", "inherit"],
  });
}

export async function runManaged(children: Array<ReturnType<typeof spawnInherited>>): Promise<never> {
  let settled = false;

  const stopAll = () => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // ignore shutdown errors
      }
    }
  };

  const finish = async (code: number) => {
    if (settled) return;
    settled = true;
    stopAll();
    await Promise.allSettled(children.map((child) => child.exited));
    process.exit(code);
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void finish(0);
    });
  }

  for (const child of children) {
    child.exited.then((code) => {
      void finish(code);
    });
  }

  await new Promise(() => {});
  process.exit(1);
}

export function getNativeHostBuildError(): string {
  return "The native PTY host build failed.";
}

export function resolveBundledZig(rootDir = process.cwd()): string {
  const bundledLinuxZig = join(rootDir, ".tools", "zig-x86_64-linux-0.15.2", "zig");
  if (process.platform === "linux" && existsSync(bundledLinuxZig)) {
    return bundledLinuxZig;
  }
  return "zig";
}

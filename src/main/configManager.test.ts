import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardConfigManager } from "./configManager";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.XDG_CONFIG_HOME;
});

describe("createDashboardConfigManager", () => {
  test("remote access stays session-only and boots disabled", () => {
    const configRoot = mkdtempSync(join(tmpdir(), "agentz-config-"));
    tempDirs.push(configRoot);
    process.env.XDG_CONFIG_HOME = configRoot;

    const manager = createDashboardConfigManager();
    const updated = manager.setConfig({
      ...manager.getConfig(),
      remoteAccess: { enabled: true },
    });

    expect(updated.remoteAccess.enabled).toBe(true);

    const raw = JSON.parse(readFileSync(manager.getConfigPath(), "utf8")) as {
      remoteAccess?: { enabled?: boolean };
    };
    expect(raw.remoteAccess?.enabled).toBe(false);

    const reloaded = createDashboardConfigManager();
    expect(reloaded.getConfig().remoteAccess.enabled).toBe(false);
  });
});

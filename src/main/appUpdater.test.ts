import { describe, expect, test } from "bun:test";

import { getAutoUpdateSupport } from "./autoUpdateSupport";
import { DEFAULT_DASHBOARD_CONFIG } from "../shared/config";

describe("getAutoUpdateSupport", () => {
  test("disables auto updates when the app is not packaged", () => {
    const support = getAutoUpdateSupport(
      DEFAULT_DASHBOARD_CONFIG,
      { APPIMAGE: "/tmp/agentz.AppImage" },
      "linux",
      false,
    );
    expect(support).toEqual({ enabled: false, reason: "app is not packaged" });
  });

  test("disables Linux auto updates without an AppImage runtime path", () => {
    const support = getAutoUpdateSupport(DEFAULT_DASHBOARD_CONFIG, {}, "linux", true);
    expect(support).toEqual({ enabled: false, reason: "APPIMAGE is missing" });
  });

  test("allows Linux auto updates for packaged AppImage runs", () => {
    const support = getAutoUpdateSupport(
      DEFAULT_DASHBOARD_CONFIG,
      { APPIMAGE: "/opt/agentz/agentz.AppImage" },
      "linux",
      true,
    );
    expect(support).toEqual({ enabled: true });
  });

  test("allows packaged macOS auto updates", () => {
    const support = getAutoUpdateSupport(DEFAULT_DASHBOARD_CONFIG, {}, "darwin", true);
    expect(support).toEqual({ enabled: true });
  });

  test("allows packaged Windows auto updates", () => {
    const support = getAutoUpdateSupport(DEFAULT_DASHBOARD_CONFIG, {}, "win32", true);
    expect(support).toEqual({ enabled: true });
  });

  test("disables the updater from settings", () => {
    const support = getAutoUpdateSupport(
      { ...DEFAULT_DASHBOARD_CONFIG, enableAutoUpdates: false },
      { APPIMAGE: "/opt/agentz/agentz.AppImage" },
      "linux",
      true,
    );

    expect(support).toEqual({ enabled: false, reason: "auto updates are disabled in settings" });
  });
});

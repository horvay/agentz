import { describe, expect, test } from "bun:test";

import {
  cloneDashboardConfig,
  DEFAULT_DASHBOARD_CONFIG,
  normalizeDashboardConfig,
} from "./config";

describe("dashboard config shortcuts", () => {
  test("cloneDashboardConfig preserves pane move shortcuts", () => {
    const cloned = cloneDashboardConfig(DEFAULT_DASHBOARD_CONFIG);
    expect(cloned.shortcuts.movePaneLeft).toBe(DEFAULT_DASHBOARD_CONFIG.shortcuts.movePaneLeft);
    expect(cloned.shortcuts.movePaneRight).toBe(DEFAULT_DASHBOARD_CONFIG.shortcuts.movePaneRight);
  });

  test("normalizeDashboardConfig accepts pane move shortcuts", () => {
    const normalized = normalizeDashboardConfig({
      shortcuts: {
        movePaneLeft: "ctrl+alt+shift+left",
        movePaneRight: "ctrl+alt+shift+right",
      },
    });

    expect(normalized.shortcuts.movePaneLeft).toBe("Ctrl+Shift+Alt+ArrowLeft");
    expect(normalized.shortcuts.movePaneRight).toBe("Ctrl+Shift+Alt+ArrowRight");
  });
});

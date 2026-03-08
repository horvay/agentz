import { describe, expect, test } from "bun:test";

import {
  cloneDashboardConfig,
  DEFAULT_DASHBOARD_CONFIG,
  normalizeDashboardConfig,
} from "./config";

describe("dashboard config shortcuts", () => {
  test("cloneDashboardConfig preserves pane shortcuts", () => {
    const cloned = cloneDashboardConfig(DEFAULT_DASHBOARD_CONFIG);
    expect(cloned.shortcuts.movePaneLeft).toBe(DEFAULT_DASHBOARD_CONFIG.shortcuts.movePaneLeft);
    expect(cloned.shortcuts.movePaneRight).toBe(DEFAULT_DASHBOARD_CONFIG.shortcuts.movePaneRight);
    expect(cloned.shortcuts.closePane).toBe(DEFAULT_DASHBOARD_CONFIG.shortcuts.closePane);
  });

  test("normalizeDashboardConfig accepts pane shortcuts", () => {
    const normalized = normalizeDashboardConfig({
      shortcuts: {
        movePaneLeft: "ctrl+alt+shift+left",
        movePaneRight: "ctrl+alt+shift+right",
        closePane: "ctrl+shift+w",
      },
    });

    expect(normalized.shortcuts.movePaneLeft).toBe("Ctrl+Shift+Alt+ArrowLeft");
    expect(normalized.shortcuts.movePaneRight).toBe("Ctrl+Shift+Alt+ArrowRight");
    expect(normalized.shortcuts.closePane).toBe("Ctrl+Shift+W");
  });
});

export const MIN_PANE_WIDTH = 420;
export const MAX_PANE_WIDTH = 1400;
export const DEFAULT_PANE_WIDTH = 780;

export interface DashboardShortcuts {
  addPane: string;
  focusPrevPane: string;
  focusNextPane: string;
  movePaneLeft: string;
  movePaneRight: string;
  openSettings: string;
}

export interface DashboardConfig {
  defaultPaneWidth: number;
  shortcuts: DashboardShortcuts;
}

export const DEFAULT_DASHBOARD_CONFIG: DashboardConfig = {
  defaultPaneWidth: DEFAULT_PANE_WIDTH,
  shortcuts: {
    addPane: "Ctrl+Shift+N",
    focusPrevPane: "Ctrl+Shift+ArrowLeft",
    focusNextPane: "Ctrl+Shift+ArrowRight",
    movePaneLeft: "Ctrl+Alt+Shift+ArrowLeft",
    movePaneRight: "Ctrl+Alt+Shift+ArrowRight",
    openSettings: "Ctrl+Shift+P",
  },
};

function normalizeModifierToken(token: string): "Ctrl" | "Shift" | "Alt" | "Meta" | null {
  const normalized = token.trim().toLowerCase();
  if (normalized === "ctrl" || normalized === "control") return "Ctrl";
  if (normalized === "shift") return "Shift";
  if (normalized === "alt" || normalized === "option") return "Alt";
  if (normalized === "meta" || normalized === "cmd" || normalized === "command") return "Meta";
  return null;
}

function normalizeKeyToken(token: string): string | null {
  const raw = token.trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();

  if (lowered === "left" || lowered === "arrowleft") return "ArrowLeft";
  if (lowered === "right" || lowered === "arrowright") return "ArrowRight";
  if (lowered === "up" || lowered === "arrowup") return "ArrowUp";
  if (lowered === "down" || lowered === "arrowdown") return "ArrowDown";
  if (lowered === "esc" || lowered === "escape") return "Escape";
  if (lowered === "enter" || lowered === "return") return "Enter";
  if (lowered === "tab") return "Tab";
  if (lowered === "backspace") return "Backspace";
  if (lowered === "delete" || lowered === "del") return "Delete";
  if (lowered === "home") return "Home";
  if (lowered === "end") return "End";
  if (lowered === "pageup" || lowered === "pgup") return "PageUp";
  if (lowered === "pagedown" || lowered === "pgdown") return "PageDown";
  if (lowered === "space" || lowered === "spacebar") return "Space";

  if (raw.length === 1) return raw.toUpperCase();
  return raw;
}

export function normalizeShortcutCombo(value: string): string | null {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const modifiers = new Set<"Ctrl" | "Shift" | "Alt" | "Meta">();
  let key: string | null = null;

  for (const part of parts) {
    const modifier = normalizeModifierToken(part);
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    if (key) return null;
    key = normalizeKeyToken(part);
    if (!key) return null;
  }

  if (!key) return null;
  if (modifiers.size === 0) return null;

  const orderedModifiers = ["Ctrl", "Shift", "Alt", "Meta"].filter((modifier) =>
    modifiers.has(modifier as "Ctrl" | "Shift" | "Alt" | "Meta"),
  );
  return [...orderedModifiers, key].join("+");
}

export function cloneDashboardConfig(config: DashboardConfig): DashboardConfig {
  return {
    defaultPaneWidth: config.defaultPaneWidth,
    shortcuts: {
      addPane: config.shortcuts.addPane,
      focusPrevPane: config.shortcuts.focusPrevPane,
      focusNextPane: config.shortcuts.focusNextPane,
      movePaneLeft: config.shortcuts.movePaneLeft,
      movePaneRight: config.shortcuts.movePaneRight,
      openSettings: config.shortcuts.openSettings,
    },
  };
}

export function normalizeDashboardConfig(value: unknown): DashboardConfig {
  const defaults = DEFAULT_DASHBOARD_CONFIG;
  let defaultPaneWidth = defaults.defaultPaneWidth;
  let shortcuts: DashboardShortcuts = { ...defaults.shortcuts };

  if (typeof value === "object" && value) {
    const candidate = value as {
      defaultPaneWidth?: unknown;
      shortcuts?: Partial<Record<keyof DashboardShortcuts, unknown>>;
    };

    if (typeof candidate.defaultPaneWidth === "number" && Number.isFinite(candidate.defaultPaneWidth)) {
      defaultPaneWidth = Math.max(
        MIN_PANE_WIDTH,
        Math.min(MAX_PANE_WIDTH, Math.round(candidate.defaultPaneWidth)),
      );
    }

    if (candidate.shortcuts && typeof candidate.shortcuts === "object") {
      const normalizedAddPane =
        typeof candidate.shortcuts.addPane === "string"
          ? normalizeShortcutCombo(candidate.shortcuts.addPane)
          : null;
      const normalizedFocusPrev =
        typeof candidate.shortcuts.focusPrevPane === "string"
          ? normalizeShortcutCombo(candidate.shortcuts.focusPrevPane)
          : null;
      const normalizedFocusNext =
        typeof candidate.shortcuts.focusNextPane === "string"
          ? normalizeShortcutCombo(candidate.shortcuts.focusNextPane)
          : null;
      const normalizedOpenSettings =
        typeof candidate.shortcuts.openSettings === "string"
          ? normalizeShortcutCombo(candidate.shortcuts.openSettings)
          : null;
      const normalizedMovePrev =
        typeof candidate.shortcuts.movePaneLeft === "string"
          ? normalizeShortcutCombo(candidate.shortcuts.movePaneLeft)
          : null;
      const normalizedMoveNext =
        typeof candidate.shortcuts.movePaneRight === "string"
          ? normalizeShortcutCombo(candidate.shortcuts.movePaneRight)
          : null;

      shortcuts = {
        addPane: normalizedAddPane ?? defaults.shortcuts.addPane,
        focusPrevPane: normalizedFocusPrev ?? defaults.shortcuts.focusPrevPane,
        focusNextPane: normalizedFocusNext ?? defaults.shortcuts.focusNextPane,
        movePaneLeft: normalizedMovePrev ?? defaults.shortcuts.movePaneLeft,
        movePaneRight: normalizedMoveNext ?? defaults.shortcuts.movePaneRight,
        openSettings: normalizedOpenSettings ?? defaults.shortcuts.openSettings,
      };
    }
  }

  return {
    defaultPaneWidth,
    shortcuts,
  };
}

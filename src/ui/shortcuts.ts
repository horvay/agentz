import { normalizeShortcutCombo, type DashboardShortcuts } from "../shared/config";

export const SHORTCUT_FIELD_ORDER: Array<keyof DashboardShortcuts> = [
  "addPane",
  "focusPrevPane",
  "focusNextPane",
  "movePaneLeft",
  "movePaneRight",
  "closePane",
  "openSettings",
];

export const SHORTCUT_FIELD_LABELS: Record<keyof DashboardShortcuts, string> = {
  addPane: "Add pane",
  focusPrevPane: "Focus previous pane",
  focusNextPane: "Focus next pane",
  movePaneLeft: "Move pane left",
  movePaneRight: "Move pane right",
  closePane: "Close pane",
  openSettings: "Open settings",
};

function normalizeEventKey(key: string): string | null {
  if (!key) return null;
  if (key === " ") return "Space";

  const lowered = key.trim().toLowerCase();
  if (!lowered) return null;
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

  if (key.length === 1) return key.toUpperCase();
  return key;
}

export function keyboardEventToShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">): string | null {
  const key = normalizeEventKey(event.key);
  if (!key) return null;
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return null;

  const modifiers: string[] = [];
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.shiftKey) modifiers.push("Shift");
  if (event.altKey) modifiers.push("Alt");
  if (event.metaKey) modifiers.push("Meta");
  if (modifiers.length === 0) return null;

  return [...modifiers, key].join("+");
}

export function doesEventMatchShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const normalizedShortcut = normalizeShortcutCombo(shortcut);
  if (!normalizedShortcut) return false;
  const eventShortcut = keyboardEventToShortcut(event);
  return eventShortcut === normalizedShortcut;
}

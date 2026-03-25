export function shouldRestoreTerminalViewport(
  visibilityState: DocumentVisibilityState,
  nowMs: number,
  lastRestoreAtMs: number,
  debounceMs: number,
): boolean {
  if (visibilityState === "hidden") return false;
  return nowMs - lastRestoreAtMs >= debounceMs;
}

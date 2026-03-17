function isModifierPasteEvent(event: KeyboardEvent, key: string): boolean {
  if (event.altKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === key;
}

export function isPasteShortcutEvent(event: KeyboardEvent): boolean {
  return isModifierPasteEvent(event, "v");
}

export function isExplicitCopyShortcutEvent(event: KeyboardEvent): boolean {
  return event.shiftKey && isModifierPasteEvent(event, "c");
}

export function isExplicitPasteShortcutEvent(event: KeyboardEvent): boolean {
  return event.shiftKey && isModifierPasteEvent(event, "v");
}

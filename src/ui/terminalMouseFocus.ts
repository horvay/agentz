export function shouldBypassPaneFocusForMouseSelection(
  mouseTrackingMode: "none" | "x10" | "vt200" | "drag" | "any" | undefined,
  event: Pick<MouseEvent, "button" | "shiftKey">,
): boolean {
  return event.button === 0 && event.shiftKey && mouseTrackingMode !== undefined && mouseTrackingMode !== "none";
}

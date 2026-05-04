import type { AgentKind } from "./avatarState";

const textDecoder = new TextDecoder();
const ENHANCED_KEYBOARD_SEQUENCE = /\u001b\[(?:(?:>(\d+)u)|(?:=(\d+);1u)|(<u)|(?:>4;(\d+)m))/g;

export type EnhancedEnterMode = "none" | "kitty" | "modify-other-keys";

function payloadText(payload: string | Uint8Array): string {
  return typeof payload === "string" ? payload : textDecoder.decode(payload);
}

export function updateEnhancedEnterMode(
  current: EnhancedEnterMode,
  payload: string | Uint8Array,
): EnhancedEnterMode {
  let next = current;
  const text = payloadText(payload);
  for (const match of text.matchAll(ENHANCED_KEYBOARD_SEQUENCE)) {
    if (match[1] != null || match[2] != null) {
      next = Number(match[1] ?? match[2] ?? "0") > 0 ? "kitty" : "none";
      continue;
    }
    if (match[3] != null) {
      next = "none";
      continue;
    }
    next = Number(match[4] ?? "0") > 0 ? "modify-other-keys" : "none";
  }
  return next;
}

export function modifiedEnterSequence(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  mode: EnhancedEnterMode,
): string | null {
  if (event.key !== "Enter") return null;

  const modifiers =
    (event.shiftKey ? 1 : 0) |
    (event.altKey ? 2 : 0) |
    (event.ctrlKey ? 4 : 0) |
    (event.metaKey ? 8 : 0);
  if (modifiers === 0) return null;

  // Let xterm keep its native Alt+Enter behavior unless another modifier is involved.
  if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
    return null;
  }

  if (mode === "kitty") {
    return `\u001b[13;${modifiers + 1}u`;
  }
  if (mode !== "modify-other-keys") {
    return null;
  }
  return `\u001b[27;${modifiers + 1};13~`;
}

export function modifiedEnterNewlineFallback(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
): string | null {
  if (event.key !== "Enter") return null;
  if (!event.shiftKey && !event.ctrlKey && !event.metaKey) return null;
  if (event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey) return null;
  return "\n";
}

export function resolveModifiedEnterSequence(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
  mode: EnhancedEnterMode,
  agent: AgentKind,
): string | null {
  return (
    modifiedEnterSequence(event, mode) ??
    (agent === "pi" ? modifiedEnterSequence(event, "modify-other-keys") : null) ??
    ((agent === "opencode" || agent === "codex") ? modifiedEnterNewlineFallback(event) : null)
  );
}

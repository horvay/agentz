const textDecoder = new TextDecoder();
const KITTY_PROTOCOL_SEQUENCE = /\u001b\[(?:>(\d+)u|<u)/g;
const KITTY_PROTOCOL_QUERY = /\u001b\[\?u/g;

function payloadText(payload: string | Uint8Array): string {
  return typeof payload === "string" ? payload : textDecoder.decode(payload);
}

export function updateKittyKeyboardProtocolState(current: boolean, payload: string | Uint8Array): boolean {
  let next = current;
  const text = payloadText(payload);
  for (const match of text.matchAll(KITTY_PROTOCOL_SEQUENCE)) {
    if (match[0] === "\u001b[<u") {
      next = false;
      continue;
    }
    next = Number(match[1] ?? "0") > 0;
  }
  return next;
}

export function hasKittyKeyboardProtocolQuery(payload: string | Uint8Array): boolean {
  KITTY_PROTOCOL_QUERY.lastIndex = 0;
  return KITTY_PROTOCOL_QUERY.test(payloadText(payload));
}

export function modifiedEnterSequence(
  event: Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "altKey" | "ctrlKey" | "metaKey">,
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

  return `\u001b[27;${modifiers + 1};13~`;
}

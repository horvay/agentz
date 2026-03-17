import type { TerminalFrame } from "../shared/protocol";

const textEncoder = new TextEncoder();

function privateMode(code: number, enabled: boolean): string {
  return `\u001b[?${code}${enabled ? "h" : "l"}`;
}

function mouseTrackingSequence(mode: TerminalFrame["mouseTrackingMode"]): string {
  const reset = `${privateMode(9, false)}${privateMode(1000, false)}${privateMode(1002, false)}${privateMode(1003, false)}`;
  if (mode === "x10") return `${reset}${privateMode(9, true)}`;
  if (mode === "normal") return `${reset}${privateMode(1000, true)}`;
  if (mode === "button") return `${reset}${privateMode(1002, true)}`;
  if (mode === "any") return `${reset}${privateMode(1003, true)}`;
  return reset;
}

function mouseFormatSequence(format: TerminalFrame["mouseFormat"]): string {
  const reset = `${privateMode(1005, false)}${privateMode(1006, false)}${privateMode(1015, false)}${privateMode(1016, false)}`;
  if (format === "utf8") return `${reset}${privateMode(1005, true)}`;
  if (format === "sgr") return `${reset}${privateMode(1006, true)}`;
  if (format === "urxvt") return `${reset}${privateMode(1015, true)}`;
  if (format === "sgr-pixels") return `${reset}${privateMode(1016, true)}`;
  return reset;
}

export function terminalModeStateKey(frame: TerminalFrame): string {
  return [
    frame.mouseTrackingMode ?? "none",
    frame.mouseFormat ?? "x10",
    frame.focusEvent ? "1" : "0",
    frame.mouseAlternateScroll ? "1" : "0",
  ].join(":");
}

export function buildTerminalModePrefix(frame: TerminalFrame): string {
  return [
    mouseTrackingSequence(frame.mouseTrackingMode ?? "none"),
    mouseFormatSequence(frame.mouseFormat ?? "x10"),
    privateMode(1004, frame.focusEvent === true),
    privateMode(1007, frame.mouseAlternateScroll === true),
  ].join("");
}

export function prependTerminalModePrefix(payload: string | Uint8Array, frame: TerminalFrame): string | Uint8Array {
  const prefix = buildTerminalModePrefix(frame);
  if (prefix.length === 0) return payload;
  if (typeof payload === "string") return `${prefix}${payload}`;

  const prefixBytes = textEncoder.encode(prefix);
  const next = new Uint8Array(prefixBytes.length + payload.length);
  next.set(prefixBytes, 0);
  next.set(payload, prefixBytes.length);
  return next;
}

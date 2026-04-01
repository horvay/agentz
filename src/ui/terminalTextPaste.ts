export function dispatchTerminalTextPaste(
  text: string,
  pasteViaTerminal: ((text: string) => void) | undefined,
  sendRawInput: (text: string) => void,
): "terminal" | "raw" | "skip" {
  if (!text) return "skip";
  if (pasteViaTerminal) {
    pasteViaTerminal(text);
    return "terminal";
  }
  sendRawInput(text);
  return "raw";
}

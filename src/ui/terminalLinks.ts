import type { ILink, ILinkProvider, Terminal } from "xterm";

const TERMINAL_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`{}|\\^\[\]]+/gi;
const SIMPLE_TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?"]);
const WRAPPING_PUNCTUATION: Record<string, string> = {
  ")": "(",
  "]": "[",
  "}": "{",
};

function countChar(text: string, target: string): number {
  let count = 0;
  for (const char of text) {
    if (char === target) count += 1;
  }
  return count;
}

export function trimTerminalUrl(raw: string): string {
  let value = raw;
  while (value.length > 0) {
    const trailing = value.at(-1);
    if (!trailing) break;
    if (SIMPLE_TRAILING_PUNCTUATION.has(trailing)) {
      value = value.slice(0, -1);
      continue;
    }
    const opening = WRAPPING_PUNCTUATION[trailing];
    if (!opening) break;
    if (countChar(value, trailing) > countChar(value, opening)) {
      value = value.slice(0, -1);
      continue;
    }
    break;
  }
  return value;
}

export function isModifierLinkActivation(
  event: Pick<MouseEvent, "ctrlKey" | "metaKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  return /\bMac/i.test(platform) ? event.metaKey : event.ctrlKey;
}

export interface TerminalUrlMatch {
  start: number;
  end: number;
  url: string;
}

export function collectTerminalUrlMatches(lineText: string): TerminalUrlMatch[] {
  const matches: TerminalUrlMatch[] = [];
  for (const match of lineText.matchAll(TERMINAL_URL_PATTERN)) {
    const rawUrl = match[0];
    const start = match.index ?? -1;
    if (start < 0) continue;
    const url = trimTerminalUrl(rawUrl);
    if (!url) continue;
    const end = start + url.length;
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      matches.push({ start, end, url: parsed.toString() });
    } catch {
      continue;
    }
  }
  return matches;
}

export function createTerminalUrlLinkProvider(
  terminal: Terminal,
  openExternalUrl: (url: string) => void,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const line = terminal.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const lineText = line.translateToString(false, 0, terminal.cols);
      const matches = collectTerminalUrlMatches(lineText);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((match) => ({
        text: match.url,
        range: {
          start: { x: match.start + 1, y: bufferLineNumber },
          end: { x: match.end + 1, y: bufferLineNumber },
        },
        activate(event, text) {
          if (!isModifierLinkActivation(event)) return;
          openExternalUrl(text);
        },
        decorations: {
          pointerCursor: true,
          underline: true,
        },
      }));

      callback(links);
    },
  };
}

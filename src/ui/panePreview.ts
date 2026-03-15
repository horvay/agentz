import type { TerminalFrame } from "../shared/protocol";

export const PREVIEW_MAX_LINES = 18;

export function normalizePreviewLines(lines: string[], altScreen = false): string[] {
  const trimmed = lines.map((line) => {
    const withoutTrailing = line.replace(/\s+$/g, "");
    return altScreen ? withoutTrailing.trimStart() : withoutTrailing;
  });
  let start = 0;
  let end = trimmed.length;
  while (start < end && trimmed[start]?.trim() === "") start += 1;
  while (end > start && trimmed[end - 1]?.trim() === "") end -= 1;

  const cropped = trimmed.slice(start, end);
  if (cropped.length === 0) return [];

  const collapsed: string[] = [];
  let lastWasBlank = false;
  for (const line of cropped) {
    const isBlank = line.trim() === "";
    if (isBlank) {
      if (lastWasBlank) continue;
      collapsed.push("");
      lastWasBlank = true;
      continue;
    }
    collapsed.push(line);
    lastWasBlank = false;
  }
  return collapsed;
}

export function samplePreviewLines(lines: string[], altScreen: boolean): string[] {
  if (lines.length <= PREVIEW_MAX_LINES) return lines;
  if (!altScreen) return lines.slice(-PREVIEW_MAX_LINES);

  const headCount = Math.max(4, Math.ceil((PREVIEW_MAX_LINES - 1) * 0.55));
  const tailCount = Math.max(3, PREVIEW_MAX_LINES - headCount - 1);
  return [...lines.slice(0, headCount), "...", ...lines.slice(-tailCount)];
}

export function previewLinesForPane(frame?: TerminalFrame): string[] {
  if (!frame?.previewLines?.length) return [];
  const normalized = normalizePreviewLines(frame.previewLines, frame.altScreen === true);
  if (normalized.length === 0) return [];
  return samplePreviewLines(normalized, frame.altScreen === true);
}

export function previewTextForPane(frame?: TerminalFrame): string {
  const previewLines = previewLinesForPane(frame);
  if (previewLines.length > 0) return previewLines.join("\n");
  const lastChunk = frame?.chunk.trim();
  if (lastChunk) return lastChunk;
  if (frame?.altScreen) {
    return frame.shellBusy
      ? "Interactive application is running in the background.\nFocus this pane to resume live rendering."
      : "Interactive screen is available.\nFocus this pane to resume live rendering.";
  }
  if (frame?.shellBusy) {
    return "Command output is updating in the background.\nFocus this pane to attach a live terminal.";
  }
  return "Focus this pane to attach a live terminal.";
}

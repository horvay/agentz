import type { TerminalFrame } from "../shared/protocol";

function extractWindowsPromptCwd(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;

  const powerShellMatch = /^PS\s+(.+?)>+\s*(?:.*)?$/i.exec(trimmed);
  if (powerShellMatch) return powerShellMatch[1].trim();

  const cmdMatch = /^([A-Za-z]:[\\/].*?)>+\s*(?:.*)?$/.exec(trimmed);
  if (cmdMatch) return cmdMatch[1].trim();

  return undefined;
}

export function resolvePaneCwdFromFrame(frame: TerminalFrame, previousCwd?: string): string | undefined {
  for (let index = frame.previewLines.length - 1; index >= 0; index -= 1) {
    const parsed = extractWindowsPromptCwd(frame.previewLines[index] ?? "");
    if (parsed) return parsed;
  }

  if (frame.altScreen === true && previousCwd) return previousCwd;
  return frame.cwd ?? previousCwd;
}

export function resolveNewPaneCwd(
  activeSessionId: string,
  paneCwds: Record<string, string | undefined>,
  frames: Record<string, TerminalFrame>,
): string | undefined {
  const activeFrame = frames[activeSessionId];
  const previousCwd = paneCwds[activeSessionId];
  if (!activeFrame) return previousCwd;
  return resolvePaneCwdFromFrame(activeFrame, previousCwd);
}

export function folderLabel(cwd?: string): string {
  if (!cwd) return "Starting...";

  const normalized = cwd.replace(/[\\/]+$/, "");
  if (!normalized) return cwd.includes("\\") ? "\\" : "/";

  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.length === 0) return normalized;

  if (/^[A-Za-z]:$/.test(normalized)) return `${normalized}\\`;
  return segments[segments.length - 1] ?? normalized;
}

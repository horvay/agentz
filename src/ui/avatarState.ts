import type { TerminalFrame } from "../shared/protocol";
import type { AvatarVisualState } from "./avatarCatalog";

export type AgentKind = "opencode" | "codex" | "claude" | null;

export interface AvatarInspection {
  state: AvatarVisualState;
  agent: AgentKind;
}

export interface AvatarActivityState {
  lastPreviewText: string;
  lastPreviewChangeAtMs?: number;
}

export const TEXT_CHANGE_WORKING_WINDOW_MS = 3000;

function normalizeTerminalText(raw: string): string {
  return raw
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, " ")
    .replace(/[\x00-\x08\x0B-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function terminalTextWindows(frame?: TerminalFrame): { recent: string; full: string } {
  if (!frame) return { recent: "", full: "" };
  const tailChunk = frame.chunk ? frame.chunk.slice(-2000) : "";
  const tailVt = frame.vt ? frame.vt.slice(-2000) : "";
  const previewLines = frame.previewLines ?? [];
  const screen = previewLines.join("\n");
  return {
    recent: normalizeTerminalText(screen),
    full: normalizeTerminalText(`${screen}\n${tailChunk}\n${tailVt}`),
  };
}

function isOpencodeSession(full: string): boolean {
  const opencodeMarkers = [
    "opencode",
    "opencode zen",
    "ask anything",
    "tab agents",
    "ctrl+p commands",
    "ctrl+t variants",
  ];
  return opencodeMarkers.some((marker) => full.includes(marker));
}

function isCodexSession(recent: string, full: string): boolean {
  const codexMarkers = [
    "openai codex",
    "ask codex to do anything",
    "? for shortcuts",
    "ctrl + t to view transcript",
    "permissions:",
    "agents.md:",
    "context left",
  ];
  return codexMarkers.some((marker) => full.includes(marker) || recent.includes(marker));
}

function isClaudeSession(recent: string, full: string): boolean {
  const claudeMarkers = ["claude code", "claude"];
  const claudeUiMarkers = [
    "esc to interrupt",
    "permission",
    "shift+tab",
    "enter to select",
    "esc to cancel",
    "what should claude do instead?",
  ];
  return (
    claudeMarkers.some((marker) => full.includes(marker) || recent.includes(marker)) &&
    claudeUiMarkers.some((marker) => full.includes(marker) || recent.includes(marker))
  );
}

function hasCodexWorkingText(recent: string): boolean {
  return recent.includes("working (");
}

function hasCodexCallingText(recent: string): boolean {
  return recent.includes("waiting for") && !recent.includes("finished waiting");
}

function hasOpencodeFooterChrome(lines: string[]): boolean {
  return lines.some(
    (line) =>
      line.includes("ctrl+t variants") || line.includes("tab agents") || line.includes("ctrl+p commands") || line.includes("ask anything"),
  );
}

function visibleOpencodeFooterState(frame?: TerminalFrame): "busy" | "idle" | "unknown" {
  const lines = (frame?.previewLines ?? []).map((line) => normalizeTerminalText(line)).filter(Boolean);
  const footer = lines.slice(-6);
  if (!hasOpencodeFooterChrome(footer)) return "unknown";
  const hasSpinnerRow = footer.some((line) => {
    if (!line.includes("esc interrupt")) return false;
    const prefix = line.slice(0, line.indexOf("esc interrupt")).trim();
    if (prefix.length < 2) return false;
    return !/[a-z0-9]/.test(prefix);
  });
  return hasSpinnerRow ? "busy" : "idle";
}

function hasOpencodeBusyFooter(frame?: TerminalFrame): boolean {
  const footer = visibleOpencodeFooterState(frame);
  if (footer === "busy") return true;
  if (!frame?.renderPatchKind) return false;
  const patch = normalizeTerminalText(frame.renderPatchVt ?? "");
  if (!patch.includes("esc interrupt")) return false;
  const lines = (frame?.previewLines ?? []).map((line) => normalizeTerminalText(line)).filter(Boolean);
  const footerLines = lines.slice(-6);
  if (!hasOpencodeFooterChrome(footerLines)) {
    return false;
  }

  const prefix = patch.slice(0, patch.indexOf("esc interrupt")).trim();
  if (prefix.length < 2) return false;
  return !/[a-z0-9]/.test(prefix);
}

function hasOpencodeCallingTranscript(frame?: TerminalFrame): boolean {
  const lines = (frame?.previewLines ?? []).map((line) => normalizeTerminalText(line)).filter(Boolean);
  return lines.some((line) => {
    return (
      line.includes("delegating...") ||
      line.startsWith("task ") ||
      line.startsWith("↳") ||
      line.includes("view subagents") ||
      line.includes("toolcalls")
    );
  });
}

function hasOpencodeQuestionPrompt(recent: string): boolean {
  return recent.includes("↑↓ select") || recent.includes("⇆ select");
}

export function inspectAvatarState(frame?: TerminalFrame): AvatarInspection {
  const windows = terminalTextWindows(frame);
  if (!windows.full) return { state: "idle", agent: null };

  const { recent, full } = windows;
  const opencodeQuestionScreen = recent;
  const standaloneOpencodeQuestion = hasOpencodeQuestionPrompt(recent);
  const opencodeSession = isOpencodeSession(full) || standaloneOpencodeQuestion;
  const codexSession = isCodexSession(recent, full);
  const claudeSession = isClaudeSession(recent, full);
  const agent: AgentKind = opencodeSession ? "opencode" : codexSession ? "codex" : claudeSession ? "claude" : null;
  const opencodeBusyFooter = opencodeSession && hasOpencodeBusyFooter(frame);

  const codexQuestionMarkers = [
    "do you want to approve",
    "yes, just this once",
    "yes, and allow this host for this conversation",
    "yes, and allow this host in the future",
    "no, and tell codex what to do differently",
    "press enter to confirm or esc to cancel",
    "question 1/",
    "what would you like to do next?",
    "tab to add notes",
    "enter to submit answer",
  ];
  const claudeQuestionMarkers = [
    "enter to select",
    "esc to cancel",
    "what aspect of",
    "what should claude do instead?",
    "type something.",
    "chat about this",
    "to navigate",
  ];
  const isQuestion =
    ((opencodeSession || standaloneOpencodeQuestion) && hasOpencodeQuestionPrompt(opencodeQuestionScreen)) ||
    codexQuestionMarkers.some((marker) => recent.includes(marker)) ||
    claudeQuestionMarkers.some((marker) => recent.includes(marker));

  const hasOpencodeCalling = opencodeBusyFooter && hasOpencodeCallingTranscript(frame);
  const hasCodexCalling = codexSession && hasCodexCallingText(recent);
  const isCalling = hasOpencodeCalling || hasCodexCalling;

  const workingMarkers = [
    "esc interrupt",
    "esc again to interrupt",
    "esc to interrupt",
    "_thinking:_",
    "working (",
    "writing command",
    "preparing write",
    "finding files",
    "reading file",
    "searching content",
    "listing directory",
    "fetching from the web",
    "searching code",
    "searching web",
    "preparing edit",
    "preparing patch",
    "updating todos",
    "loading skill",
    "asking questions",
    " queued ",
  ];
  const hasGenericWorkingMarker = claudeSession && workingMarkers.some((marker) => recent.includes(marker));
  const isWorking = hasGenericWorkingMarker || opencodeBusyFooter || (codexSession && hasCodexWorkingText(recent));

  const spinnerChars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const hasSpinner = !opencodeSession && !codexSession && [...spinnerChars].some((ch) => recent.includes(ch));

  const isSupportedAgent =
    opencodeSession || codexSession || isQuestion || isCalling || isWorking || hasSpinner;
  if (!isSupportedAgent) return { state: "idle", agent };

  if (isCalling) return { state: "calling", agent };
  if (isQuestion) return { state: "question", agent };
  if (isWorking || hasSpinner) return { state: "working", agent };
  return { state: "idle", agent };
}

export function detectAvatarState(frame?: TerminalFrame): AvatarVisualState {
  return inspectAvatarState(frame).state;
}

export function resolveAvatarDisplayState(
  frame: TerminalFrame | undefined,
  previous?: AvatarActivityState,
  nowMs = Date.now(),
): AvatarVisualState {
  const inspection = inspectAvatarState(frame);
  if (inspection.state !== "idle") return inspection.state;
  const currentPreviewText = (frame?.previewLines ?? []).join("\n");
  const hasVisibleTextChange =
    currentPreviewText.length > 0 &&
    previous?.lastPreviewText !== undefined &&
    currentPreviewText !== previous.lastPreviewText;
  if (hasVisibleTextChange) {
    return "working";
  }
  if (
    currentPreviewText.length > 0 &&
    typeof previous?.lastPreviewChangeAtMs === "number" &&
    nowMs - previous.lastPreviewChangeAtMs < TEXT_CHANGE_WORKING_WINDOW_MS
  ) {
    return "working";
  }
  return "idle";
}

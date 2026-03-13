import type { TerminalFrame } from "../shared/protocol";
import type { AvatarVisualState } from "./avatarCatalog";

export type AgentKind = "opencode" | "codex" | "claude" | null;
export const CODEX_WORKING_HOLD_MS = 3000;
export const CODEX_ACTIVE_FRAME_GRACE_MS = 1500;
export const OPENCODE_WORKING_HOLD_MS = 900;
export const OPENCODE_BUSY_SIGNAL_HOLD_MS = 2000;

export interface AvatarInspection {
  state: AvatarVisualState;
  agent: AgentKind;
}

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

function hasCodexWorkingSignal(recent: string, full: string): boolean {
  const codexWorkingMarkers = [
    "working (",
    "analyzing (",
    "booting mcp server:",
    "tab to queue message",
    "background terminal running",
    "/ps to view",
  ];
  if (codexWorkingMarkers.some((marker) => recent.includes(marker) || full.includes(marker))) {
    return true;
  }

  // Codex uses a live status header like "• Investigating ... (0s • esc to interrupt)" while streaming.
  return /• [a-z0-9'"/,:+\- ]{1,160}\(\d+s(?: • esc[^)]*)?\)/.test(recent);
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

function hasStandaloneOpencodeQuestionPrompt(recent: string): boolean {
  const markers = [
    "type your own answer",
    "esc dismiss",
    "enter submit",
    "select all that apply",
    "asked 1 question",
    "what should we talk about next?",
  ];
  const markerHits = markers.filter((marker) => recent.includes(marker)).length;
  const hasPrimaryOption = recent.includes("1. ");
  const hasAnotherOption = ["2. ", "3. ", "4. ", "5. ", "6. "].some((marker) => recent.includes(marker));
  return markerHits >= 2 && hasPrimaryOption && hasAnotherOption;
}

export function inspectAvatarState(frame?: TerminalFrame): AvatarInspection {
  const windows = terminalTextWindows(frame);
  if (!windows.full) return { state: "idle", agent: null };

  const { recent, full } = windows;
  const opencodeQuestionScreen = recent;
  const standaloneOpencodeQuestion = hasStandaloneOpencodeQuestionPrompt(recent);
  const opencodeSession = isOpencodeSession(full) || standaloneOpencodeQuestion;
  const codexSession = isCodexSession(recent, full);
  const claudeSession = isClaudeSession(recent, full);
  const agent: AgentKind = opencodeSession ? "opencode" : codexSession ? "codex" : claudeSession ? "claude" : null;
  const opencodeBusyFooter = opencodeSession && hasOpencodeBusyFooter(frame);

  const opencodeQuestionMarkers = [
    "permission required",
    "allow once",
    "allow always",
    "reject permission",
    "type your own answer",
    "tell opencode what to do differently",
    "select all that apply",
    "esc dismiss",
  ];
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
    ((opencodeSession || standaloneOpencodeQuestion) &&
      opencodeQuestionMarkers.some((marker) => opencodeQuestionScreen.includes(marker))) ||
    codexQuestionMarkers.some((marker) => recent.includes(marker)) ||
    claudeQuestionMarkers.some((marker) => recent.includes(marker));

  const codexCallingMarkers = ["subagent", "subagents"];
  const hasOpencodeCalling = opencodeBusyFooter && hasOpencodeCallingTranscript(frame);
  const hasCodexCalling = codexSession && codexCallingMarkers.some((marker) => recent.includes(marker));
  const hasCodexCallingContext = codexSession && recent.includes("subagent") && recent.includes("esc to interrupt");
  const isCalling = hasOpencodeCalling || hasCodexCalling || hasCodexCallingContext;

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
  const hasGenericWorkingMarker = (codexSession || claudeSession) && workingMarkers.some((marker) => recent.includes(marker));
  const isWorking =
    hasGenericWorkingMarker ||
    opencodeBusyFooter ||
    (codexSession && hasCodexWorkingSignal(recent, full));

  const spinnerChars = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
  const hasSpinner = !opencodeSession && [...spinnerChars].some((ch) => recent.includes(ch));

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
  previous:
    | {
        state: AvatarVisualState;
        agent: AgentKind;
        atMs: number;
        lastFrameAtMs: number;
        lastPreviewText: string;
      }
    | undefined,
  nowMs: number,
): AvatarVisualState {
  const inspection = inspectAvatarState(frame);
  const effectiveAgent = inspection.agent ?? previous?.agent ?? null;
  if (
    effectiveAgent === "opencode" &&
    typeof frame?.shellBusyAtMs === "number" &&
    nowMs - frame.shellBusyAtMs <= OPENCODE_BUSY_SIGNAL_HOLD_MS &&
    (inspection.state === "idle" || inspection.state === "working")
  ) {
    if (!frame.shellBusy) return "idle";
    return visibleOpencodeFooterState(frame) === "idle" ? "idle" : "working";
  }
  if (inspection.state !== "idle") return inspection.state;
  const currentPreviewText = (frame?.previewLines ?? []).join("\n");
  const hasVisibleTextChange =
    currentPreviewText.length > 0 &&
    previous?.lastPreviewText !== undefined &&
    currentPreviewText !== previous.lastPreviewText;
  if (
    effectiveAgent === "codex" &&
    previous?.state === "working" &&
    (hasVisibleTextChange ||
      nowMs - previous.lastFrameAtMs <= CODEX_ACTIVE_FRAME_GRACE_MS ||
      nowMs - previous.atMs <= CODEX_WORKING_HOLD_MS)
  ) {
    return "working";
  }
  if (
    effectiveAgent === "opencode" &&
    previous?.state === "working" &&
    frame?.shellBusyAtMs == null &&
    visibleOpencodeFooterState(frame) !== "idle" &&
    nowMs - previous.atMs <= OPENCODE_WORKING_HOLD_MS
  ) {
    return "working";
  }
  if (effectiveAgent === null && frame?.shellBusy) {
    return "working";
  }
  return "idle";
}

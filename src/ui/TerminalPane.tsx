import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "xterm";

import type { TerminalFrame } from "../shared/protocol";
import type { DashboardShortcuts } from "../shared/config";
import type { RpcClient } from "./rpcClient";
import { doesEventMatchShortcut } from "./shortcuts";
import {
  isExplicitCopyShortcutEvent,
  isExplicitPasteShortcutEvent,
  isPasteShortcutEvent,
} from "./terminalClipboardShortcuts";
import {
  type EnhancedEnterMode,
  modifiedEnterNewlineFallback,
  modifiedEnterSequence,
  updateEnhancedEnterMode,
} from "./terminalKeyboardProtocol";
import { createTerminalUrlLinkProvider, isModifierLinkActivation } from "./terminalLinks";
import { shouldBypassPaneFocusForMouseSelection } from "./terminalMouseFocus";
import { prependTerminalModePrefix, terminalModeStateKey } from "./terminalModes";
import { inspectAvatarState } from "./avatarState";
import { DEBUG_LOGS_ENABLED } from "./debugLogs";

const RESIZE_DEBOUNCE_MS = 40;
const RESIZE_SNAPSHOT_DELAY_MS = 140;
const TERMINAL_FONT_SIZE = 14;
const TERMINAL_LINE_HEIGHT = 1;
const TERMINAL_SCROLLBACK = 5_000;
const TERMINAL_FONT_FAMILY = '"JetBrainsMonoNerdFontMonoLocal", "JetBrainsMono Nerd Font Mono", monospace';
const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const TERMINAL_THEME = {
  foreground: "#d9e6ff",
  background: "#0a0f1a",
  cursor: "#ffe066",
  cursorAccent: "#02060d",
  selectionBackground: "rgba(124, 214, 255, 0.24)",
  black: "#10131b",
  red: "#f07178",
  green: "#7fdc8f",
  yellow: "#ffcb6b",
  blue: "#79b8ff",
  magenta: "#c792ea",
  cyan: "#7fd4f9",
  white: "#d0d7e3",
  brightBlack: "#5b6472",
  brightRed: "#ff8b95",
  brightGreen: "#a2f2a8",
  brightYellow: "#ffd98e",
  brightBlue: "#9fccff",
  brightMagenta: "#ddb7ff",
  brightCyan: "#a6e8ff",
  brightWhite: "#f4f8ff",
};
const TERMINAL_DEBUG = DEBUG_LOGS_ENABLED;

interface Props {
  id: string;
  rpc: RpcClient;
  currentFrame?: TerminalFrame;
  pendingFrames?: TerminalFrame[];
  active: boolean;
  autoClaimViewport: boolean;
  accentStyle?: CSSProperties;
  shortcuts: DashboardShortcuts;
  onActivate: (id: string) => void;
  onShortcut: (
    shortcut:
      | "new-pane"
      | "toggle-background"
      | "new-background"
      | "focus-left"
      | "focus-right"
      | "move-left"
      | "move-right"
      | "close-pane"
      | "open-settings",
  ) => void;
  onFramesQueued: (id: string, lastSeq: number) => void;
  onUserInput: (id: string) => void;
  onTextPasteRegister?: (id: string, handler: ((text: string) => void) | null) => void;
}

function hasRenderablePayload(frame: TerminalFrame | undefined): frame is TerminalFrame {
  if (!frame) return false;
  return (
    frame.screenMode === "full" ||
    typeof frame.renderVt === "string" ||
    typeof frame.renderPatchVt === "string" ||
    frame.renderPatchBytes instanceof Uint8Array
  );
}

function framePayload(frame: TerminalFrame): string | Uint8Array {
  if (frame.screenMode === "full") return frame.renderVt ?? "";
  return frame.renderPatchBytes ?? frame.renderPatchVt ?? frame.renderVt ?? "";
}

async function writeTextToClipboard(text: string): Promise<void> {
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

async function readTextFromClipboard(): Promise<string> {
  if (navigator.clipboard?.readText) {
    return navigator.clipboard.readText();
  }

  return "";
}

function openExternalUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function syncTerminalCursor(
  terminal: Terminal,
  screen: HTMLDivElement | null,
  frame: TerminalFrame | undefined,
) {
  const cursorStyle = frame?.cursorStyle ?? "block";
  terminal.options.cursorStyle = cursorStyle;
  terminal.options.cursorBlink = frame?.cursorBlink ?? true;
  terminal.options.cursorInactiveStyle = frame?.cursorVisible === false ? "none" : cursorStyle;
  terminal.options.cursorWidth = 1;
  screen?.classList.toggle("terminal-screen-cursor-hidden", frame?.cursorVisible === false);
}

function measuredCellSize(terminal: Terminal): { width: number; height: number } | null {
  const core = (terminal as Terminal & {
    _core?: {
      _renderService?: {
        _renderer?: {
          value?: {
            dimensions?: {
              css?: {
                cell?: {
                  width?: number;
                  height?: number;
                };
              };
            };
          };
        };
      };
    };
  })._core;
  const cell = core?._renderService?._renderer?.value?.dimensions?.css?.cell;
  const width = cell?.width;
  const height = cell?.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width == null || height == null) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

export function TerminalPane({
  id,
  rpc,
  currentFrame,
  pendingFrames,
  active,
  autoClaimViewport,
  accentStyle,
  shortcuts,
  onActivate,
  onShortcut,
  onFramesQueued,
  onUserInput,
  onTextPasteRegister,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const resizeSyncTimeoutRef = useRef<number | null>(null);
  const snapshotSyncTimeoutRef = useRef<number | null>(null);
  const focusTimeoutRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingFramesRef = useRef<TerminalFrame[]>([]);
  const pendingFrameStartRef = useRef(0);
  const processingFramesRef = useRef(false);
  const lastAppliedSeqRef = useRef(0);
  const lastModeStateKeyRef = useRef<string | null>(null);
  const enhancedEnterModeRef = useRef<EnhancedEnterMode>("none");
  const skipNextActiveFocusRef = useRef(false);
  const pointerInteractionRef = useRef<{ x: number; y: number; moved: boolean; bypassFocus: boolean } | null>(null);
  const shortcutsRef = useRef(shortcuts);
  const shortcutHandlerRef = useRef(onShortcut);
  const framesQueuedHandlerRef = useRef(onFramesQueued);
  const userInputHandlerRef = useRef(onUserInput);
  const currentFrameRef = useRef(currentFrame);
  const hasViewportControlRef = useRef(autoClaimViewport && active);

  shortcutsRef.current = shortcuts;
  shortcutHandlerRef.current = onShortcut;
  framesQueuedHandlerRef.current = onFramesQueued;
  userInputHandlerRef.current = onUserInput;
  currentFrameRef.current = currentFrame;

  const sendResizeSync = (
    cols: number,
    rows: number,
    {
      requestSnapshot = false,
      forceSnapshot = false,
      snapshotDelayMs = 0,
    }: { requestSnapshot?: boolean; forceSnapshot?: boolean; snapshotDelayMs?: number } = {},
  ) => {
    const previous = lastSentSizeRef.current;
    const sizeChanged = !previous || previous.cols !== cols || previous.rows !== rows;
    if (sizeChanged) {
      lastSentSizeRef.current = { cols, rows };
      rpc.send({ type: "resize", id, cols, rows });
    }
    if (requestSnapshot && (forceSnapshot || sizeChanged)) {
      if (snapshotSyncTimeoutRef.current != null) {
        window.clearTimeout(snapshotSyncTimeoutRef.current);
      }
      // Give TUIs a beat to redraw after SIGWINCH before we ask for a fresh frame.
      snapshotSyncTimeoutRef.current = window.setTimeout(() => {
        snapshotSyncTimeoutRef.current = null;
        rpc.send({ type: "snapshot", id });
      }, Math.max(0, snapshotDelayMs));
    }
  };

  const queueResizeSync = (
    cols: number,
    rows: number,
    {
      immediate = false,
      requestSnapshot = false,
      forceSnapshot = false,
      snapshotDelayMs = 0,
    }: { immediate?: boolean; requestSnapshot?: boolean; forceSnapshot?: boolean; snapshotDelayMs?: number } = {},
  ) => {
    if (resizeSyncTimeoutRef.current != null) {
      window.clearTimeout(resizeSyncTimeoutRef.current);
      resizeSyncTimeoutRef.current = null;
    }
    if (immediate) {
      sendResizeSync(cols, rows, { requestSnapshot, forceSnapshot, snapshotDelayMs });
      return;
    }
    resizeSyncTimeoutRef.current = window.setTimeout(() => {
      resizeSyncTimeoutRef.current = null;
      sendResizeSync(cols, rows, { requestSnapshot, forceSnapshot, snapshotDelayMs });
    }, RESIZE_DEBOUNCE_MS);
  };

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const claimViewportControl = () => {
    hasViewportControlRef.current = true;
    rpc.send({ type: "focus-terminal", id });
    syncViewportSizeToServer({
      immediate: IS_WINDOWS,
      requestSnapshot: true,
      forceSnapshot: true,
      snapshotDelayMs: IS_WINDOWS ? 0 : RESIZE_SNAPSHOT_DELAY_MS,
    });
  };

  const syncViewportSizeToServer = (
    {
      immediate = false,
      requestSnapshot = false,
      forceSnapshot = false,
      snapshotDelayMs = 0,
    }: { immediate?: boolean; requestSnapshot?: boolean; forceSnapshot?: boolean; snapshotDelayMs?: number } = {},
  ) => {
    const terminal = terminalRef.current;
    const screen = screenRef.current;
    if (!terminal || !screen) return;
    const screenWidth = screen.clientWidth;
    const screenHeight = screen.clientHeight;
    if (screenWidth <= 0 || screenHeight <= 0) return;
    const cell = measuredCellSize(terminal);
    if (!cell) return;
    const nextCols = Math.max(2, Math.floor(screenWidth / cell.width));
    const nextRows = Math.max(1, Math.floor(screenHeight / cell.height));
    queueResizeSync(nextCols, nextRows, {
      immediate,
      requestSnapshot,
      forceSnapshot,
      snapshotDelayMs,
    });
  };

  const scheduleTerminalFocus = () => {
    if (focusTimeoutRef.current != null) {
      window.clearTimeout(focusTimeoutRef.current);
    }
    // Wait until xterm has attached its helper textarea before focusing.
    focusTimeoutRef.current = window.setTimeout(() => {
      focusTimeoutRef.current = null;
      focusTerminal();
    }, 0);
  };

  const applyFrame = (frame: TerminalFrame, done: () => void) => {
    const terminal = terminalRef.current;
    const screen = screenRef.current;
    if (!terminal) {
      if (TERMINAL_DEBUG) {
        console.log("[terminal-pane] applyFrame skipped: terminal missing", {
          id,
          seq: frame.seq,
          screenMode: frame.screenMode,
          renderVtLen: frame.renderVt?.length ?? 0,
          renderPatchVtLen: frame.renderPatchVt?.length ?? 0,
          renderPatchBytesLen: frame.renderPatchBytes?.length ?? 0,
        });
      }
      done();
      return;
    }

    if (TERMINAL_DEBUG) {
      console.log("[terminal-pane] applyFrame", {
        id,
        seq: frame.seq,
        screenMode: frame.screenMode,
        altScreen: frame.altScreen,
        cols: frame.cols,
        rows: frame.rows,
        termCols: terminal.cols,
        termRows: terminal.rows,
        renderVtLen: frame.renderVt?.length ?? 0,
        renderPatchVtLen: frame.renderPatchVt?.length ?? 0,
        renderPatchBytesLen: frame.renderPatchBytes?.length ?? 0,
      });
    }

    if (frame.cols > 0 && frame.rows > 0 && (frame.cols !== terminal.cols || frame.rows !== terminal.rows)) {
      terminal.resize(frame.cols, frame.rows);
    }

    const payload = framePayload(frame);
    enhancedEnterModeRef.current = updateEnhancedEnterMode(enhancedEnterModeRef.current, payload);
    const nextModeStateKey = terminalModeStateKey(frame);
    const shouldSyncModes =
      lastModeStateKeyRef.current !== nextModeStateKey || (frame.screenMode === "full" && frame.altScreen !== true);
    const payloadWithModes = shouldSyncModes ? prependTerminalModePrefix(payload, frame) : payload;
    if (frame.screenMode === "full") {
      if (payloadWithModes.length === 0) {
        syncTerminalCursor(terminal, screen, frame);
        lastModeStateKeyRef.current = nextModeStateKey;
        if (TERMINAL_DEBUG) {
          console.log("[terminal-pane] applyFrame full empty payload", { id, seq: frame.seq });
        }
        done();
        return;
      }
      if (frame.altScreen && typeof payloadWithModes === "string") {
        // Full alternate-screen frames are authoritative snapshots of the active TUI.
        // Re-enter and clear the alt buffer in place so redraws do not visibly flash.
        terminal.write(`\u001b[?1049h\u001b[H\u001b[2J${payloadWithModes}`, () => {
          syncTerminalCursor(terminal, screen, frame);
          lastModeStateKeyRef.current = nextModeStateKey;
          if (TERMINAL_DEBUG) {
            console.log("[terminal-pane] applyFrame full alt complete", { id, seq: frame.seq });
          }
          done();
        });
        return;
      }
      const activeBuffer = terminal.buffer.active;
      const scrollbackOffset = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY);
      terminal.reset();
      terminal.write(payloadWithModes, () => {
        syncTerminalCursor(terminal, screen, frame);
        lastModeStateKeyRef.current = nextModeStateKey;
        if (TERMINAL_DEBUG) {
          console.log("[terminal-pane] applyFrame full complete", { id, seq: frame.seq });
        }
        if (scrollbackOffset > 0) {
          const nextTarget = Math.max(0, terminal.buffer.active.baseY - scrollbackOffset);
          terminal.scrollToLine(nextTarget);
        } else {
          terminal.scrollToBottom();
        }
        done();
      });
      return;
    }

    if (payloadWithModes.length === 0) {
      syncTerminalCursor(terminal, screen, frame);
      lastModeStateKeyRef.current = nextModeStateKey;
      if (TERMINAL_DEBUG) {
        console.log("[terminal-pane] applyFrame patch empty payload", { id, seq: frame.seq });
      }
      done();
      return;
    }

    terminal.write(payloadWithModes, () => {
      syncTerminalCursor(terminal, screen, frame);
      lastModeStateKeyRef.current = nextModeStateKey;
      if (TERMINAL_DEBUG) {
        console.log("[terminal-pane] applyFrame patch complete", { id, seq: frame.seq });
      }
      done();
    });
  };

  const compactPendingFrames = (force = false) => {
    const start = pendingFrameStartRef.current;
    if (start === 0) return;
    const frames = pendingFramesRef.current;
    if (!force && start < 32 && start * 2 < frames.length) return;
    pendingFramesRef.current = frames.slice(start);
    pendingFrameStartRef.current = 0;
  };

  const drainFrameQueue = () => {
    if (processingFramesRef.current) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nextIndex = pendingFrameStartRef.current;
    const nextFrame = pendingFramesRef.current[nextIndex];
    if (!nextFrame) return;

    if (TERMINAL_DEBUG) {
      console.log("[terminal-pane] drainFrameQueue", {
        id,
        nextIndex,
        queued: pendingFramesRef.current.length,
        seq: nextFrame.seq,
        screenMode: nextFrame.screenMode,
      });
    }

    pendingFrameStartRef.current = nextIndex + 1;
    processingFramesRef.current = true;
    applyFrame(nextFrame, () => {
      lastAppliedSeqRef.current = Math.max(lastAppliedSeqRef.current, nextFrame.seq);
      processingFramesRef.current = false;
      compactPendingFrames();
      if (pendingFrameStartRef.current < pendingFramesRef.current.length) {
        drainFrameQueue();
        return;
      }
      pendingFramesRef.current = [];
      pendingFrameStartRef.current = 0;
      framesQueuedHandlerRef.current(id, lastAppliedSeqRef.current);
    });
  };

  const enqueueFrames = (frames: TerminalFrame[]) => {
    const highestQueuedSeq = pendingFramesRef.current[pendingFramesRef.current.length - 1]?.seq ?? lastAppliedSeqRef.current;
    const nextFrames = frames.filter((frame) => hasRenderablePayload(frame) && frame.seq > highestQueuedSeq);
    if (nextFrames.length === 0) return;
    if (TERMINAL_DEBUG) {
      console.log("[terminal-pane] enqueueFrames", {
        id,
        incoming: frames.map((frame) => ({ seq: frame.seq, screenMode: frame.screenMode })),
        accepted: nextFrames.map((frame) => ({ seq: frame.seq, screenMode: frame.screenMode })),
        highestQueuedSeq,
      });
    }
    pendingFramesRef.current.push(...nextFrames);
    drainFrameQueue();
  };

  const prioritizeFullFrame = (frame: TerminalFrame) => {
    if (!hasRenderablePayload(frame)) return;
    if (frame.seq < lastAppliedSeqRef.current) return;
    if (TERMINAL_DEBUG) {
      console.log("[terminal-pane] prioritizeFullFrame", {
        id,
        seq: frame.seq,
        screenMode: frame.screenMode,
        renderVtLen: frame.renderVt?.length ?? 0,
      });
    }
    pendingFramesRef.current = [frame];
    pendingFrameStartRef.current = 0;
    drainFrameQueue();
  };

  useEffect(() => {
    if (!active) {
      hasViewportControlRef.current = false;
    } else if (autoClaimViewport) {
      hasViewportControlRef.current = true;
    }
  }, [active, autoClaimViewport]);

  useEffect(() => {
    if (!onTextPasteRegister) return;
    onTextPasteRegister(id, (text) => {
      if (!text) return;
      const terminal = terminalRef.current;
      if (!terminal) return;
      userInputHandlerRef.current(id);
      terminal.paste(text);
    });
    return () => onTextPasteRegister(id, null);
  }, [id, onTextPasteRegister]);

  useEffect(() => {
    const screen = screenRef.current;
    const stage = stageRef.current;
    if (!screen || !stage) return;

    const terminal = new Terminal({
      allowTransparency: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      cursorWidth: 1,
      drawBoldTextInBrightColors: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: TERMINAL_SCROLLBACK,
      smoothScrollDuration: 0,
      theme: TERMINAL_THEME,
    });
    const linkProvider = createTerminalUrlLinkProvider(terminal, openExternalUrl);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const agent = inspectAvatarState(currentFrameRef.current).agent;
      const enterSequence =
        modifiedEnterSequence(event, enhancedEnterModeRef.current) ??
        ((agent === "opencode" || agent === "codex") ? modifiedEnterNewlineFallback(event) : null);
      if (enterSequence) {
        event.preventDefault();
        userInputHandlerRef.current(id);
        syncViewportSizeToServer({
          immediate: IS_WINDOWS,
          requestSnapshot: true,
          forceSnapshot: true,
          snapshotDelayMs: IS_WINDOWS ? 0 : RESIZE_SNAPSHOT_DELAY_MS,
        });
        rpc.send({ type: "input", id, data: enterSequence, encoding: "utf8" });
        return false;
      }
      if (isExplicitCopyShortcutEvent(event)) {
        event.preventDefault();
        const selection = terminal.getSelection();
        if (selection) {
          void writeTextToClipboard(selection);
        }
        return false;
      }
      if (isExplicitPasteShortcutEvent(event)) {
        event.preventDefault();
        void readTextFromClipboard().then((text) => {
          if (!text) return;
          userInputHandlerRef.current(id);
          terminal.paste(text);
        });
        return false;
      }
      if (isPasteShortcutEvent(event)) {
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.addPane)) {
        event.preventDefault();
        shortcutHandlerRef.current("new-pane");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.toggleBackgroundTerminal)) {
        event.preventDefault();
        shortcutHandlerRef.current("toggle-background");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.addBackgroundTerminal)) {
        event.preventDefault();
        shortcutHandlerRef.current("new-background");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.focusPrevPane)) {
        event.preventDefault();
        shortcutHandlerRef.current("focus-left");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.focusNextPane)) {
        event.preventDefault();
        shortcutHandlerRef.current("focus-right");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.movePaneLeft)) {
        event.preventDefault();
        shortcutHandlerRef.current("move-left");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.movePaneRight)) {
        event.preventDefault();
        shortcutHandlerRef.current("move-right");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.closePane)) {
        event.preventDefault();
        shortcutHandlerRef.current("close-pane");
        return false;
      }
      if (doesEventMatchShortcut(event, shortcutsRef.current.openSettings)) {
        event.preventDefault();
        shortcutHandlerRef.current("open-settings");
        return false;
      }
      return true;
    });
    terminal.options.linkHandler = {
      activate(event, text) {
        if (!isModifierLinkActivation(event)) return;
        openExternalUrl(text);
      },
      allowNonHttpProtocols: false,
    };

    const dataSubscription = terminal.onData((data) => {
      userInputHandlerRef.current(id);
      syncViewportSizeToServer({
        immediate: IS_WINDOWS,
        requestSnapshot: true,
        forceSnapshot: true,
        snapshotDelayMs: IS_WINDOWS ? 0 : RESIZE_SNAPSHOT_DELAY_MS,
      });
      rpc.send({ type: "input", id, data, encoding: "utf8" });
    });
    const binarySubscription = terminal.onBinary((data) => {
      userInputHandlerRef.current(id);
      syncViewportSizeToServer({
        immediate: IS_WINDOWS,
        requestSnapshot: true,
        forceSnapshot: true,
        snapshotDelayMs: IS_WINDOWS ? 0 : RESIZE_SNAPSHOT_DELAY_MS,
      });
      rpc.send({ type: "input", id, data, encoding: "binary" });
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      queueResizeSync(cols, rows, {
        requestSnapshot: true,
        snapshotDelayMs: IS_WINDOWS ? 0 : RESIZE_SNAPSHOT_DELAY_MS,
      });
    });

    terminal.open(screen);
    const linkProviderDisposable = terminal.registerLinkProvider(linkProvider);
    terminalRef.current = terminal;
    if (TERMINAL_DEBUG) {
      console.log("[terminal-pane] terminal mounted", { id });
    }
    drainFrameQueue();

    const resizeTerminalToStage = () => {
      if (!measuredCellSize(terminal)) {
        window.requestAnimationFrame(resizeTerminalToStage);
        return;
      }
      if (!hasViewportControlRef.current) {
        return;
      }
      syncViewportSizeToServer({
        immediate: IS_WINDOWS,
        requestSnapshot: true,
        snapshotDelayMs: IS_WINDOWS ? 0 : RESIZE_SNAPSHOT_DELAY_MS,
      });
    };

    window.requestAnimationFrame(resizeTerminalToStage);
    if (active) {
      scheduleTerminalFocus();
    }

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(resizeTerminalToStage);
    });
    resizeObserver.observe(stage);

    void document.fonts?.ready.then(() => {
      resizeTerminalToStage();
    });

    return () => {
      resizeObserver.disconnect();
      dataSubscription.dispose();
      binarySubscription.dispose();
      resizeSubscription.dispose();
      linkProviderDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      pendingFramesRef.current = [];
      pendingFrameStartRef.current = 0;
      processingFramesRef.current = false;
      lastAppliedSeqRef.current = 0;
      lastModeStateKeyRef.current = null;
      enhancedEnterModeRef.current = "none";
      lastSentSizeRef.current = null;
      if (resizeSyncTimeoutRef.current != null) {
        window.clearTimeout(resizeSyncTimeoutRef.current);
        resizeSyncTimeoutRef.current = null;
      }
      if (snapshotSyncTimeoutRef.current != null) {
        window.clearTimeout(snapshotSyncTimeoutRef.current);
        snapshotSyncTimeoutRef.current = null;
      }
      if (focusTimeoutRef.current != null) {
        window.clearTimeout(focusTimeoutRef.current);
        focusTimeoutRef.current = null;
      }
    };
  }, [id, rpc]);

  useEffect(() => {
    if (!pendingFrames?.length) return;
    enqueueFrames(pendingFrames);
  }, [pendingFrames]);

  useEffect(() => {
    if (!hasRenderablePayload(currentFrame)) return;
    if (currentFrame.screenMode === "full" || currentFrame.renderVt) {
      prioritizeFullFrame(currentFrame);
      return;
    }
    if (pendingFrames?.length) return;
    if (currentFrame.seq <= lastAppliedSeqRef.current) return;
    enqueueFrames([currentFrame]);
  }, [currentFrame, pendingFrames]);

  useEffect(() => {
    if (active) {
      if (autoClaimViewport || document.hasFocus()) {
        claimViewportControl();
      }
      if (skipNextActiveFocusRef.current) {
        skipNextActiveFocusRef.current = false;
        return;
      }
      scheduleTerminalFocus();
      return () => {
        if (focusTimeoutRef.current != null) {
          window.clearTimeout(focusTimeoutRef.current);
          focusTimeoutRef.current = null;
        }
      };
    }
    const helper = screenRef.current?.querySelector(".xterm-helper-textarea");
    if (helper instanceof HTMLTextAreaElement) {
      helper.blur();
    }
  }, [active, autoClaimViewport, id, rpc]);

  useEffect(() => {
    if (!active) return;
    const onWindowFocus = () => {
      claimViewportControl();
      scheduleTerminalFocus();
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [active, autoClaimViewport, id, rpc]);

  return (
    <section className={`pane-shell ${active ? "pane-active" : ""}`} style={accentStyle}>
      <div
        ref={stageRef}
        className="terminal-stage terminal-stage-selectable"
        onMouseDownCapture={(event) => {
          const bypassFocus = shouldBypassPaneFocusForMouseSelection(
            terminalRef.current?.modes.mouseTrackingMode,
            event,
          );
          pointerInteractionRef.current = {
            x: event.clientX,
            y: event.clientY,
            moved: false,
            bypassFocus,
          };
          claimViewportControl();
          if (bypassFocus) return;
          if (!active) onActivate(id);
          if (!active && event.button === 0) {
            skipNextActiveFocusRef.current = true;
          }
        }}
        onFocusCapture={() => {
          if (!active) return;
          claimViewportControl();
        }}
        onMouseMoveCapture={(event) => {
          const interaction = pointerInteractionRef.current;
          if (!interaction) return;
          const distanceX = Math.abs(event.clientX - interaction.x);
          const distanceY = Math.abs(event.clientY - interaction.y);
          if (distanceX >= 3 || distanceY >= 3) {
            interaction.moved = true;
          }
        }}
        onClick={(event) => {
          const interaction = pointerInteractionRef.current;
          pointerInteractionRef.current = null;
          if (!interaction?.bypassFocus && !active) onActivate(id);
          if (interaction?.bypassFocus) return;
          if (terminalRef.current?.hasSelection()) return;
          if (interaction?.moved) return;
          if (isModifierLinkActivation(event.nativeEvent)) return;
          scheduleTerminalFocus();
        }}
        role="presentation"
      >
        <div ref={screenRef} className="terminal-screen terminal-screen-xterm" />
      </div>
    </section>
  );
}

import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "xterm";

import type { TerminalFrame } from "../shared/protocol";
import type { DashboardShortcuts } from "../shared/config";
import type { RpcClient } from "./rpcClient";
import { doesEventMatchShortcut } from "./shortcuts";

const RESIZE_DEBOUNCE_MS = 40;
const TERMINAL_FONT_SIZE = 14;
const TERMINAL_LINE_HEIGHT = 1.22;
const TERMINAL_SCROLLBACK = 5_000;
const TERMINAL_FONT_FAMILY = '"JetBrainsMonoNerdFontMonoLocal", "JetBrainsMono Nerd Font Mono", monospace';
const IS_WINDOWS = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);
const ALT_SCREEN_FULL_FRAME_MARKER = "\u001b[?1049h\u001b[H";

const TERMINAL_THEME = {
  foreground: "#d9e6ff",
  background: "#0a0f1a",
  cursor: "rgba(0, 0, 0, 0)",
  cursorAccent: "rgba(0, 0, 0, 0)",
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

interface Props {
  id: string;
  rpc: RpcClient;
  currentFrame?: TerminalFrame;
  pendingFrames?: TerminalFrame[];
  active: boolean;
  accentStyle?: CSSProperties;
  shortcuts: DashboardShortcuts;
  onActivate: (id: string) => void;
  onShortcut: (
    shortcut:
      | "new-pane"
      | "toggle-background"
      | "focus-left"
      | "focus-right"
      | "move-left"
      | "move-right"
      | "close-pane"
      | "open-settings",
  ) => void;
  onFramesQueued: (id: string, lastSeq: number) => void;
  onUserInput: (id: string) => void;
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

function loadBestRendererAddon(terminal: Terminal): { dispose(): void } | null {
  if (IS_WINDOWS) {
    return null;
  }
  try {
    const addon = new CanvasAddon();
    terminal.loadAddon(addon);
    return addon;
  } catch {
    return null;
  }
}

function framePayload(frame: TerminalFrame): string | Uint8Array {
  if (frame.screenMode === "full") return frame.renderVt ?? "";
  return frame.renderPatchBytes ?? frame.renderPatchVt ?? frame.renderVt ?? "";
}

function extractAltScreenFullFramePayload(payload: string): string {
  const markerIndex = payload.lastIndexOf(ALT_SCREEN_FULL_FRAME_MARKER);
  if (markerIndex < 0) return payload;
  return payload.slice(markerIndex + ALT_SCREEN_FULL_FRAME_MARKER.length);
}

function isPasteShortcutEvent(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === "v";
}

function syncTerminalCursor(terminal: Terminal, frame: TerminalFrame | undefined) {
  const cursorStyle = frame?.cursorStyle ?? "block";
  terminal.options.cursorStyle = cursorStyle;
  terminal.options.cursorBlink = frame?.cursorBlink ?? true;
  terminal.options.cursorInactiveStyle = frame?.cursorVisible === false ? "none" : cursorStyle;
  terminal.options.cursorWidth = 1;
}

function getTerminalCellMetrics(terminal: Terminal): { cellWidth: number; cellHeight: number } | null {
  const unsafeTerminal = terminal as Terminal & {
    _core?: {
      _renderService?: {
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
  const dimensions = unsafeTerminal._core?._renderService?.dimensions?.css?.cell;
  if (!dimensions?.width || !dimensions?.height) return null;
  return {
    cellWidth: dimensions.width,
    cellHeight: dimensions.height,
  };
}

function refreshTerminalViewport(terminal: Terminal): void {
  if (terminal.rows <= 0) return;
  (terminal as Terminal & { clearTextureAtlas?: () => void }).clearTextureAtlas?.();
  terminal.refresh(0, terminal.rows - 1);
}

export function TerminalPane({
  id,
  rpc,
  currentFrame,
  pendingFrames,
  active,
  accentStyle,
  shortcuts,
  onActivate,
  onShortcut,
  onFramesQueued,
  onUserInput,
}: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const cursorOverlayRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const resizeSyncTimeoutRef = useRef<number | null>(null);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const pendingFramesRef = useRef<TerminalFrame[]>([]);
  const pendingFrameStartRef = useRef(0);
  const processingFramesRef = useRef(false);
  const lastAppliedSeqRef = useRef(0);
  const shortcutsRef = useRef(shortcuts);
  const shortcutHandlerRef = useRef(onShortcut);
  const framesQueuedHandlerRef = useRef(onFramesQueued);
  const userInputHandlerRef = useRef(onUserInput);
  const currentFrameRef = useRef(currentFrame);

  shortcutsRef.current = shortcuts;
  shortcutHandlerRef.current = onShortcut;
  framesQueuedHandlerRef.current = onFramesQueued;
  userInputHandlerRef.current = onUserInput;
  currentFrameRef.current = currentFrame;

  const sendResizeSync = (
    cols: number,
    rows: number,
    { requestSnapshot = false, forceSnapshot = false }: { requestSnapshot?: boolean; forceSnapshot?: boolean } = {},
  ) => {
    const previous = lastSentSizeRef.current;
    const sizeChanged = !previous || previous.cols !== cols || previous.rows !== rows;
    if (sizeChanged) {
      lastSentSizeRef.current = { cols, rows };
      rpc.send({ type: "resize", id, cols, rows });
    }
    if (requestSnapshot && (forceSnapshot || sizeChanged)) {
      rpc.send({ type: "snapshot", id });
    }
  };

  const queueResizeSync = (
    cols: number,
    rows: number,
    {
      immediate = false,
      requestSnapshot = false,
      forceSnapshot = false,
    }: { immediate?: boolean; requestSnapshot?: boolean; forceSnapshot?: boolean } = {},
  ) => {
    if (resizeSyncTimeoutRef.current != null) {
      window.clearTimeout(resizeSyncTimeoutRef.current);
      resizeSyncTimeoutRef.current = null;
    }
    if (immediate) {
      sendResizeSync(cols, rows, { requestSnapshot, forceSnapshot });
      return;
    }
    resizeSyncTimeoutRef.current = window.setTimeout(() => {
      resizeSyncTimeoutRef.current = null;
      sendResizeSync(cols, rows, { requestSnapshot, forceSnapshot });
    }, RESIZE_DEBOUNCE_MS);
  };

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const syncCursorOverlay = () => {
    const overlay = cursorOverlayRef.current;
    const stage = stageRef.current;
    const screen = screenRef.current;
    const terminal = terminalRef.current;
    const frame = currentFrameRef.current;
    if (!overlay || !stage || !screen || !terminal || !frame) {
      if (overlay) overlay.hidden = true;
      return;
    }

    if (frame.cursorVisible === false) {
      overlay.hidden = true;
      return;
    }

    const cursorRow = frame.cursorRow ?? 0;
    const cursorCol = frame.cursorCol ?? 0;
    if (frame.cols <= 0 || frame.rows <= 0 || cursorRow <= 0 || cursorCol <= 0) {
      overlay.hidden = true;
      return;
    }

    const screenRect = screen.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    if (screenRect.width <= 0 || screenRect.height <= 0) {
      overlay.hidden = true;
      return;
    }

    const metrics = getTerminalCellMetrics(terminal);
    if (!metrics) {
      overlay.hidden = true;
      return;
    }

    const viewportRelativeRow = Math.max(0, cursorRow - 1);
    const bufferRow = terminal.buffer.active.viewportY + viewportRelativeRow;
    const bufferLine = terminal.buffer.active.getLine(bufferRow);
    const bufferCell = bufferLine?.getCell(cursorCol - 1);
    const cellChars = bufferCell?.getChars() ?? "";
    const cellWidthUnits = Math.max(1, bufferCell?.getWidth() ?? 1);
    const { cellWidth, cellHeight } = metrics;
    const cursorStyle = frame.cursorStyle ?? "block";
    const width =
      cursorStyle === "bar"
        ? 2
        : Math.max(1, Math.round(cellWidth * cellWidthUnits));
    const height =
      cursorStyle === "underline"
        ? 2
        : Math.max(1, Math.round(cellHeight));
    const left = screenRect.left - stageRect.left + Math.max(0, cursorCol - 1) * cellWidth;
    const top =
      screenRect.top -
      stageRect.top +
      viewportRelativeRow * cellHeight +
      (cursorStyle === "underline" ? Math.max(0, Math.round(cellHeight) - height) : 0);

    overlay.textContent = cursorStyle === "block" ? cellChars || " " : "";
    overlay.className = `terminal-cursor-overlay terminal-cursor-overlay-${cursorStyle}${
      frame.cursorBlink ? " terminal-cursor-overlay-blink" : ""
    }`;
    overlay.style.left = `${Math.round(left)}px`;
    overlay.style.top = `${Math.round(top)}px`;
    overlay.style.width = `${width}px`;
    overlay.style.height = `${height}px`;
    overlay.style.lineHeight = `${Math.max(1, Math.round(cellHeight))}px`;
    overlay.hidden = false;
  };

  const applyFrame = (frame: TerminalFrame, done: () => void) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      done();
      return;
    }

    if (IS_WINDOWS && terminal.cols > 0 && terminal.rows > 0 && (frame.cols !== terminal.cols || frame.rows !== terminal.rows)) {
      queueResizeSync(terminal.cols, terminal.rows, {
        immediate: true,
        requestSnapshot: true,
        forceSnapshot: true,
      });
      done();
      return;
    }

    const payload = framePayload(frame);
    if (frame.screenMode === "full") {
      if (payload.length === 0) {
        syncTerminalCursor(terminal, frame);
        syncCursorOverlay();
        done();
        return;
      }
      if (frame.altScreen && typeof payload === "string") {
        if (IS_WINDOWS) {
          terminal.reset();
          terminal.write(payload, () => {
            done();
          });
          return;
        }
        const altPayload = extractAltScreenFullFramePayload(payload);
        // Repaint full-screen TUIs in place. A hard terminal reset causes visible flashes.
        terminal.write(`\u001b[?1049h\u001b[H\u001b[2J${altPayload}`, () => {
          done();
        });
        return;
      }
      const activeBuffer = terminal.buffer.active;
      const scrollbackOffset = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY);
      terminal.reset();
      terminal.write(payload, () => {
        syncTerminalCursor(terminal, frame);
        syncCursorOverlay();
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

    if (payload.length === 0) {
      syncTerminalCursor(terminal, frame);
      syncCursorOverlay();
      done();
      return;
    }

    terminal.write(payload, () => {
      syncTerminalCursor(terminal, frame);
      syncCursorOverlay();
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
    pendingFramesRef.current.push(...nextFrames);
    drainFrameQueue();
  };

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
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    const rendererAddon = loadBestRendererAddon(terminal);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
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

    const dataSubscription = terminal.onData((data) => {
      userInputHandlerRef.current(id);
      rpc.send({ type: "input", id, data, encoding: "utf8" });
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      queueResizeSync(cols, rows, { requestSnapshot: IS_WINDOWS });
    });

    terminal.open(screen);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitTerminal = () => {
      fitAddon.fit();
      window.requestAnimationFrame(syncCursorOverlay);
      refreshTerminalViewport(terminal);
      queueResizeSync(terminal.cols, terminal.rows, {
        immediate: IS_WINDOWS,
        requestSnapshot: IS_WINDOWS,
      });
    };

    fitTerminal();

    const resizeObserver = new ResizeObserver(() => {
      window.requestAnimationFrame(fitTerminal);
    });
    resizeObserver.observe(stage);

    void document.fonts?.ready.then(() => {
      fitTerminal();
    });

    return () => {
      resizeObserver.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      rendererAddon?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      pendingFramesRef.current = [];
      pendingFrameStartRef.current = 0;
      processingFramesRef.current = false;
      lastAppliedSeqRef.current = 0;
      lastSentSizeRef.current = null;
      if (resizeSyncTimeoutRef.current != null) {
        window.clearTimeout(resizeSyncTimeoutRef.current);
        resizeSyncTimeoutRef.current = null;
      }
    };
  }, [id, rpc]);

  useEffect(() => {
    if (!pendingFrames?.length) return;
    enqueueFrames(pendingFrames);
  }, [pendingFrames]);

  useEffect(() => {
    if (pendingFrames?.length) return;
    if (!hasRenderablePayload(currentFrame)) return;
    if (currentFrame.seq <= lastAppliedSeqRef.current) return;
    enqueueFrames([currentFrame]);
  }, [currentFrame, pendingFrames]);

  useEffect(() => {
    if (active) {
      const focusRaf = window.requestAnimationFrame(() => focusTerminal());
      return () => window.cancelAnimationFrame(focusRaf);
    }
    const helper = screenRef.current?.querySelector(".xterm-helper-textarea");
    if (helper instanceof HTMLTextAreaElement) {
      helper.blur();
    }
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const onWindowFocus = () => {
      window.requestAnimationFrame(() => focusTerminal());
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [active]);

  useEffect(() => {
    const raf = window.requestAnimationFrame(syncCursorOverlay);
    return () => window.cancelAnimationFrame(raf);
  }, [active, currentFrame]);

  return (
    <section className={`pane-shell ${active ? "pane-active" : ""}`} style={accentStyle}>
      <div
        ref={stageRef}
        className="terminal-stage terminal-stage-selectable"
        onMouseDownCapture={() => {
          if (!active) onActivate(id);
        }}
        onClick={() => {
          if (!active) onActivate(id);
          window.requestAnimationFrame(() => focusTerminal());
        }}
        role="presentation"
      >
        <div ref={screenRef} className="terminal-screen terminal-screen-xterm" />
        <div ref={cursorOverlayRef} className="terminal-cursor-overlay terminal-cursor-overlay-block" hidden />
      </div>
    </section>
  );
}

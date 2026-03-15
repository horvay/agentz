import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { CanvasAddon } from "@xterm/addon-canvas";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
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
    shortcut: "new-pane" | "focus-left" | "focus-right" | "move-left" | "move-right" | "close-pane" | "open-settings",
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
  try {
    const addon = new WebglAddon();
    terminal.loadAddon(addon);
    return addon;
  } catch {
    try {
      const addon = new CanvasAddon();
      terminal.loadAddon(addon);
      return addon;
    } catch {
      return null;
    }
  }
}

function framePayload(frame: TerminalFrame): string | Uint8Array {
  if (frame.screenMode === "full") return frame.renderVt ?? "";
  return frame.renderPatchBytes ?? frame.renderPatchVt ?? frame.renderVt ?? "";
}

function isPasteShortcutEvent(event: KeyboardEvent): boolean {
  if (event.altKey) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return event.key.toLowerCase() === "v";
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

  shortcutsRef.current = shortcuts;
  shortcutHandlerRef.current = onShortcut;
  framesQueuedHandlerRef.current = onFramesQueued;
  userInputHandlerRef.current = onUserInput;

  const queueResizeSync = (cols: number, rows: number) => {
    if (resizeSyncTimeoutRef.current != null) {
      window.clearTimeout(resizeSyncTimeoutRef.current);
    }
    resizeSyncTimeoutRef.current = window.setTimeout(() => {
      resizeSyncTimeoutRef.current = null;
      const previous = lastSentSizeRef.current;
      if (previous && previous.cols === cols && previous.rows === rows) return;
      lastSentSizeRef.current = { cols, rows };
      rpc.send({ type: "resize", id, cols, rows });
    }, RESIZE_DEBOUNCE_MS);
  };

  const focusTerminal = () => {
    terminalRef.current?.focus();
  };

  const applyFrame = (frame: TerminalFrame, done: () => void) => {
    const terminal = terminalRef.current;
    if (!terminal) {
      done();
      return;
    }

    const payload = framePayload(frame);
    if (frame.screenMode === "full") {
      if (payload.length === 0) {
        done();
        return;
      }
      const activeBuffer = terminal.buffer.active;
      const scrollbackOffset = Math.max(0, activeBuffer.baseY - activeBuffer.viewportY);
      terminal.reset();
      terminal.write(payload, () => {
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
      done();
      return;
    }

    terminal.write(payload, done);
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
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
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
      queueResizeSync(cols, rows);
    });

    terminal.open(screen);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fitTerminal = () => {
      fitAddon.fit();
      queueResizeSync(terminal.cols, terminal.rows);
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
      </div>
    </section>
  );
}

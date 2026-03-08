import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import { WebglAddon } from "@xterm/addon-webgl";
import type { TerminalFrame } from "../shared/protocol";
import type { DashboardShortcuts } from "../shared/config";
import type { RpcClient } from "./rpcClient";
import { doesEventMatchShortcut } from "./shortcuts";

const RESIZE_DEBOUNCE_MS = 40;
const CURSOR_FILL = "#ffe066";
const CURSOR_TEXT = "#02060d";
const TERMINAL_FONT_FAMILY = "JetBrainsMonoNerdFontMonoLocal, JetBrainsMono Nerd Font Mono, monospace";
const TERMINAL_FONT_SIZE = 14;
const TERMINAL_LINE_HEIGHT = 1.22;

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
}

interface OverlayCursorState {
  visible: boolean;
  style: "block" | "underline" | "bar";
  left: number;
  top: number;
  width: number;
  height: number;
  char: string;
}

interface InputModeState {
  mouseTrackingMode: "none" | "x10" | "normal" | "button" | "any";
  mouseFormat: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
  focusEvent: boolean;
  mouseAlternateScroll: boolean;
}

function shouldUseOverlayCursor(frame?: TerminalFrame): boolean {
  if (!frame) return false;
  if (typeof frame.cursorRow !== "number" || typeof frame.cursorCol !== "number") return false;
  return frame.altScreen === true && (frame.cursorStyle ?? "block") === "block";
}

function getInputModeState(frame?: TerminalFrame): InputModeState | null {
  if (!frame) return null;
  if (
    !frame.mouseTrackingMode &&
    !frame.mouseFormat &&
    typeof frame.focusEvent !== "boolean" &&
    typeof frame.mouseAlternateScroll !== "boolean"
  ) {
    return null;
  }

  return {
    mouseTrackingMode: frame.mouseTrackingMode ?? "none",
    mouseFormat: frame.mouseFormat ?? "x10",
    focusEvent: frame.focusEvent === true,
    mouseAlternateScroll: frame.mouseAlternateScroll === true,
  };
}

function buildInputModePrefix(next: InputModeState, previous?: InputModeState | null): string {
  const privateMode = (code: number, enabled: boolean) => `\x1b[?${code}${enabled ? "h" : "l"}`;
  const writes: string[] = [];
  const writeIfChanged = (code: number, enabled: boolean, prevEnabled: boolean | undefined) => {
    if (prevEnabled === enabled) return;
    writes.push(privateMode(code, enabled));
  };

  writeIfChanged(9, next.mouseTrackingMode === "x10", previous?.mouseTrackingMode === "x10");
  writeIfChanged(1000, next.mouseTrackingMode === "normal", previous?.mouseTrackingMode === "normal");
  writeIfChanged(1002, next.mouseTrackingMode === "button", previous?.mouseTrackingMode === "button");
  writeIfChanged(1003, next.mouseTrackingMode === "any", previous?.mouseTrackingMode === "any");
  writeIfChanged(1004, next.focusEvent, previous?.focusEvent);
  writeIfChanged(1005, next.mouseFormat === "utf8", previous?.mouseFormat === "utf8");
  writeIfChanged(1006, next.mouseFormat === "sgr", previous?.mouseFormat === "sgr");
  writeIfChanged(1007, next.mouseAlternateScroll, previous?.mouseAlternateScroll);
  writeIfChanged(1015, next.mouseFormat === "urxvt", previous?.mouseFormat === "urxvt");
  writeIfChanged(1016, next.mouseFormat === "sgr-pixels", previous?.mouseFormat === "sgr-pixels");
  return writes.join("");
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
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglAddonRef = useRef<WebglAddon | null>(null);
  const canvasAddonRef = useRef<CanvasAddon | null>(null);
  const syncedSizeRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeSyncTimeoutRef = useRef<number | null>(null);
  const refreshRafRef = useRef<number | null>(null);
  const syncOutputActiveRef = useRef(false);
  const syncOutputBufferRef = useRef("");
  const syncOutputTimeoutRef = useRef<number | null>(null);
  const lastInputModeStateRef = useRef<InputModeState | null>(null);
  const renderQueueRef = useRef<
    Array<{
      payload: string;
      reset: boolean;
      dedupeKey?: string;
      patchKind?: "cursor-only" | "row-update" | "alt-row-update";
    }>
  >([]);
  const flushRenderQueueRef = useRef<() => void>(() => {});
  const enqueueRenderRef = useRef<
    (
      payload: string,
      options?: {
        reset?: boolean;
        dedupeKey?: string;
        replaceQueuedFull?: boolean;
        patchKind?: "cursor-only" | "row-update" | "alt-row-update";
      },
    ) => void
  >(() => {});
  const renderInFlightRef = useRef(false);
  const lastAppliedRenderRef = useRef<string>("");
  const altBufferActiveRef = useRef(false);
  const shortcutHandlerRef = useRef(onShortcut);
  const shortcutsRef = useRef(shortcuts);
  const [overlayCursor, setOverlayCursor] = useState<OverlayCursorState | null>(null);
  shortcutHandlerRef.current = onShortcut;
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    const stage = stageRef.current;
    if (
      !terminal ||
      !host ||
      !stage ||
      !shouldUseOverlayCursor(currentFrame) ||
      typeof currentFrame?.cursorRow !== "number" ||
      typeof currentFrame?.cursorCol !== "number"
    ) {
      setOverlayCursor(null);
      return;
    }

    const renderDims = (terminal as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: {
            css?: {
              cell?: { width?: number; height?: number };
            };
          };
        };
      };
    })._core?._renderService?.dimensions?.css;
    const cellWidth = renderDims?.cell?.width ?? 0;
    const cellHeight = renderDims?.cell?.height ?? 0;
    const screen = host.querySelector(".xterm-screen") as HTMLElement | null;
    if (!screen || cellWidth <= 0 || cellHeight <= 0) {
      setOverlayCursor(null);
      return;
    }

    const stageRect = stage.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const rowIndex = Math.max(0, currentFrame.cursorRow - 1);
    const colIndex = Math.max(0, currentFrame.cursorCol - 1);
    const rowText = currentFrame.previewLines[rowIndex] ?? "";
    const char = rowText.charAt(colIndex);

    setOverlayCursor({
      visible: active && (currentFrame.cursorVisible ?? true),
      style: currentFrame.cursorStyle ?? "block",
      left: screenRect.left - stageRect.left + colIndex * cellWidth,
      top: screenRect.top - stageRect.top + rowIndex * cellHeight,
      width: cellWidth,
      height: cellHeight,
      char,
    });
  }, [active, currentFrame]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scheduleFullRefresh = () => {
      if (webglAddonRef.current) return;
      if (refreshRafRef.current) cancelAnimationFrame(refreshRafRef.current);
      refreshRafRef.current = requestAnimationFrame(() => {
        refreshRafRef.current = null;
        if (!terminalRef.current) return;
        terminalRef.current.refresh(0, Math.max(terminalRef.current.rows - 1, 0));
      });
    };

    const flushRenderQueue = () => {
      if (!terminalRef.current) return;
      if (renderInFlightRef.current) return;
      const first = renderQueueRef.current.shift();
      if (!first) return;
      const batch = [first];
      while (renderQueueRef.current.length > 0) {
        const next = renderQueueRef.current[0];
        if (next.reset) break;
        batch.push(renderQueueRef.current.shift()!);
        if (batch.length >= 24) break;
      }
      const payload = batch.map((entry) => entry.payload).join("");
      const last = batch[batch.length - 1];
      renderInFlightRef.current = true;
      if (first.reset) {
        terminalRef.current.reset();
      }
      terminalRef.current.write(payload, () => {
        renderInFlightRef.current = false;
        if (last.dedupeKey) {
          lastAppliedRenderRef.current = last.dedupeKey;
        } else {
          lastAppliedRenderRef.current = "";
        }
        scheduleFullRefresh();
        flushRenderQueue();
      });
    };

    const queueResizeSync = (cols: number, rows: number) => {
      if (resizeSyncTimeoutRef.current) {
        window.clearTimeout(resizeSyncTimeoutRef.current);
      }
      resizeSyncTimeoutRef.current = window.setTimeout(() => {
        resizeSyncTimeoutRef.current = null;
        const prevSize = lastSentSizeRef.current;
        if (prevSize && prevSize.cols === cols && prevSize.rows === rows) return;
        lastSentSizeRef.current = { cols, rows };
        rpc.send({ type: "resize", id, cols, rows });
      }, RESIZE_DEBOUNCE_MS);
    };

    const enqueueRender = (
      payload: string,
      options?: {
        reset?: boolean;
        dedupeKey?: string;
        replaceQueuedFull?: boolean;
        patchKind?: "cursor-only" | "row-update" | "alt-row-update";
      },
    ) => {
      if (options?.dedupeKey && payload === lastAppliedRenderRef.current) return;
      if (options?.replaceQueuedFull) {
        // A new full-frame snapshot supersedes any queued incremental work.
        renderQueueRef.current = [];
      } else if (options?.patchKind === "cursor-only" || options?.patchKind === "alt-row-update") {
        renderQueueRef.current = renderQueueRef.current.filter(
          (queued) => queued.patchKind !== "cursor-only" && queued.patchKind !== "alt-row-update",
        );
      }
      renderQueueRef.current.push({
        payload,
        reset: options?.reset === true,
        dedupeKey: options?.dedupeKey,
        patchKind: options?.patchKind,
      });
      flushRenderQueue();
    };
    flushRenderQueueRef.current = flushRenderQueue;
    enqueueRenderRef.current = enqueueRender;

    const terminal = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      fontWeight: "400",
      fontWeightBold: "700",
      lineHeight: TERMINAL_LINE_HEIGHT,
      letterSpacing: 0,
      cursorBlink: false,
      cursorStyle: "block",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      convertEol: false,
      scrollback: 2000,
      minimumContrastRatio: 4.5,
      theme: {
        background: "#0a0f1a",
        foreground: "#d9e6ff",
        cursor: CURSOR_FILL,
        cursorAccent: CURSOR_TEXT,
        selectionBackground: "rgba(117, 219, 255, 0.25)",
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
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    let canvasAddon: CanvasAddon | null = null;
    const activateCanvasRenderer = () => {
      if (canvasAddon) return;
      canvasAddon = new CanvasAddon();
      terminal.loadAddon(canvasAddon);
      canvasAddonRef.current = canvasAddon;
      webglAddonRef.current = null;
    };
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddonRef.current = null;
        activateCanvasRenderer();
        scheduleFullRefresh();
      });
      terminal.loadAddon(webglAddon);
      webglAddonRef.current = webglAddon;
      canvasAddonRef.current = null;
    } catch {
      activateCanvasRenderer();
    }
    terminal.open(host);
    if (active) {
      requestAnimationFrame(() => terminal.focus());
    }
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey) {
        // Bare Escape is used by terminal apps like Codex for in-band interrupt.
        event.preventDefault();
        rpc.send({ type: "input", id, data: "\x1b" });
        return false;
      }
      const bindings = shortcutsRef.current;
      if (doesEventMatchShortcut(event, bindings.addPane)) {
        event.preventDefault();
        shortcutHandlerRef.current("new-pane");
        return false;
      }
      if (doesEventMatchShortcut(event, bindings.focusPrevPane)) {
        event.preventDefault();
        shortcutHandlerRef.current("focus-left");
        return false;
      }
      if (doesEventMatchShortcut(event, bindings.focusNextPane)) {
        event.preventDefault();
        shortcutHandlerRef.current("focus-right");
        return false;
      }
      if (doesEventMatchShortcut(event, bindings.movePaneLeft)) {
        event.preventDefault();
        shortcutHandlerRef.current("move-left");
        return false;
      }
      if (doesEventMatchShortcut(event, bindings.movePaneRight)) {
        event.preventDefault();
        shortcutHandlerRef.current("move-right");
        return false;
      }
      if (doesEventMatchShortcut(event, bindings.closePane)) {
        event.preventDefault();
        shortcutHandlerRef.current("close-pane");
        return false;
      }
      if (doesEventMatchShortcut(event, bindings.openSettings)) {
        event.preventDefault();
        shortcutHandlerRef.current("open-settings");
        return false;
      }
      return true;
    });

    let raf = 0;
    const fitAndSync = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        fitAddon.fit();
        scheduleFullRefresh();
        const nextCols = terminal.cols;
        const nextRows = terminal.rows;
        queueResizeSync(nextCols, nextRows);
      });
    };

    fitAndSync();

    terminal.onData((data) => rpc.send({ type: "input", id, data, encoding: "utf8" }));
    terminal.onBinary((data) => rpc.send({ type: "input", id, data, encoding: "binary" }));
    terminal.onResize((size) => queueResizeSync(size.cols, size.rows));

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
      syncedSizeRef.current = false;
      renderQueueRef.current = [];
      lastAppliedRenderRef.current = "";
      altBufferActiveRef.current = false;
      lastInputModeStateRef.current = null;

    const onWindowResize = () => fitAndSync();
    const resizeObserver = new ResizeObserver(() => fitAndSync());
    resizeObserver.observe(host);
    if (stageRef.current) resizeObserver.observe(stageRef.current);

    void document.fonts?.ready.then(() => {
      fitAndSync();
      scheduleFullRefresh();
    });

    window.addEventListener("resize", onWindowResize);
    return () => {
      window.removeEventListener("resize", onWindowResize);
      resizeObserver.disconnect();
      if (raf) cancelAnimationFrame(raf);
      if (resizeSyncTimeoutRef.current) window.clearTimeout(resizeSyncTimeoutRef.current);
      if (refreshRafRef.current) cancelAnimationFrame(refreshRafRef.current);
      if (syncOutputTimeoutRef.current) window.clearTimeout(syncOutputTimeoutRef.current);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      webglAddonRef.current = null;
      canvasAddonRef.current = null;
      flushRenderQueueRef.current = () => {};
      enqueueRenderRef.current = () => {};
    };
  }, [id, rpc]);

  useEffect(() => {
    if (!pendingFrames?.length || !terminalRef.current) return;
    const terminal = terminalRef.current;

    for (const frame of pendingFrames) {
      if (frame.cursorStyle) {
        terminal.options.cursorStyle = frame.cursorStyle;
        terminal.options.cursorInactiveStyle = frame.cursorStyle;
      }
      if (typeof frame.cursorBlink === "boolean") {
        terminal.options.cursorBlink = frame.cursorBlink;
      }
      const useOverlayCursor = shouldUseOverlayCursor(frame);
      const cursorVisible = active && (frame.cursorVisible ?? true);
      const nextInputModeState = getInputModeState(frame);
      const inputModePrefix = nextInputModeState
        ? buildInputModePrefix(nextInputModeState, lastInputModeStateRef.current)
        : "";
      if (nextInputModeState) {
        lastInputModeStateRef.current = nextInputModeState;
      }
      const cursorSuffix =
        useOverlayCursor ? "\x1b[?25l" : cursorVisible ? "\x1b[?25h" : "\x1b[?25l";
      const usePrimaryChunkFastPath = frame.altScreen !== true && Boolean(frame.chunk);
      const useAltScreenChunkFastPath =
        frame.altScreen === true &&
        Boolean(frame.chunk) &&
        (frame.renderPatchKind === "cursor-only" || frame.renderPatchKind === "alt-row-update");

      let transition = "";
      const altScreen = frame.altScreen === true;
      const wasAltScreenActive = altBufferActiveRef.current;
      if (altScreen && !wasAltScreenActive) {
        transition = "\x1b[?1049h\x1b[H\x1b[2J";
        altBufferActiveRef.current = true;
      } else if (!altScreen && wasAltScreenActive) {
        transition = "\x1b[?1049l\x1b[H\x1b[2J";
        altBufferActiveRef.current = false;
      } else if (altScreen) {
        altBufferActiveRef.current = true;
      }

      if (usePrimaryChunkFastPath) {
        const payload = `${transition}${inputModePrefix}${frame.chunk}${cursorSuffix}`;
        enqueueRenderRef.current(payload, {
          patchKind: frame.renderPatchKind,
        });
      } else if (useAltScreenChunkFastPath) {
        const payload = `${transition}${inputModePrefix}${frame.chunk}${cursorSuffix}`;
        enqueueRenderRef.current(payload, {
          patchKind: frame.renderPatchKind,
        });
      } else if (frame.renderPatchVt) {
        enqueueRenderRef.current(`${transition}${inputModePrefix}${frame.renderPatchVt}${cursorSuffix}`, {
          patchKind: frame.renderPatchKind,
        });
      } else if (frame.renderVt) {
        const framePrefix = altScreen ? "" : "\x1b[H\x1b[2J";
        const payload = `${transition}${inputModePrefix}${framePrefix}${frame.renderVt}${cursorSuffix}`;
        enqueueRenderRef.current(payload, {
          reset: false,
          dedupeKey: payload,
          replaceQueuedFull: true,
        });
      } else if (frame.chunk) {
        const syncStart = "\x1b[?2026h";
        const syncEnd = "\x1b[?2026l";
        let chunk = frame.chunk;
        const writes: string[] = [];

        const armSyncTimeout = () => {
          if (syncOutputTimeoutRef.current) window.clearTimeout(syncOutputTimeoutRef.current);
          // Match ghostty's safety net: never hang rendering forever.
          syncOutputTimeoutRef.current = window.setTimeout(() => {
            if (!terminalRef.current || !syncOutputActiveRef.current) return;
            syncOutputActiveRef.current = false;
            const buffered = syncOutputBufferRef.current;
            syncOutputBufferRef.current = "";
            if (buffered) terminalRef.current.write(buffered);
          }, 200);
        };

        while (chunk.length > 0) {
          if (syncOutputActiveRef.current) {
            const endIdx = chunk.indexOf(syncEnd);
            if (endIdx < 0) {
              syncOutputBufferRef.current += chunk;
              armSyncTimeout();
              chunk = "";
              break;
            }
            syncOutputBufferRef.current += chunk.slice(0, endIdx);
            const buffered = syncOutputBufferRef.current;
            syncOutputBufferRef.current = "";
            syncOutputActiveRef.current = false;
            if (syncOutputTimeoutRef.current) {
              window.clearTimeout(syncOutputTimeoutRef.current);
              syncOutputTimeoutRef.current = null;
            }
            if (buffered) writes.push(buffered);
            chunk = chunk.slice(endIdx + syncEnd.length);
            continue;
          }

          const startIdx = chunk.indexOf(syncStart);
          if (startIdx < 0) {
            writes.push(chunk);
            chunk = "";
            break;
          }

          const before = chunk.slice(0, startIdx);
          if (before) writes.push(before);
          syncOutputActiveRef.current = true;
          syncOutputBufferRef.current = "";
          armSyncTimeout();
          chunk = chunk.slice(startIdx + syncStart.length);
        }

        if (writes.length > 0) {
          terminal.write(writes.join(""));
        }
      }
    }

    onFramesQueued(id, pendingFrames[pendingFrames.length - 1]?.seq ?? 0);

    if (!syncedSizeRef.current && fitAddonRef.current && terminalRef.current) {
      fitAddonRef.current.fit();
      lastSentSizeRef.current = { cols: terminalRef.current.cols, rows: terminalRef.current.rows };
      rpc.send({
        type: "resize",
        id,
        cols: terminalRef.current.cols,
        rows: terminalRef.current.rows,
      });
      syncedSizeRef.current = true;
    }
  }, [pendingFrames, active, id, onFramesQueued, rpc]);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (active) {
      terminalRef.current.focus();
      const focusRaf = requestAnimationFrame(() => {
        terminalRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(focusRaf);
      };
    }
    terminalRef.current.write("\x1b[?25l");
    terminalRef.current.blur();
  }, [active]);

  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.write(
      active && !shouldUseOverlayCursor(currentFrame)
        ? "\x1b[?25h"
        : "\x1b[?25l",
    );
  }, [active, currentFrame]);

  const overlayCursorStyle: CSSProperties | undefined = overlayCursor
    ? {
        left: `${overlayCursor.left}px`,
        top: `${overlayCursor.top}px`,
        width: `${overlayCursor.width}px`,
        height: `${overlayCursor.height}px`,
        backgroundColor: overlayCursor.style === "block" ? CURSOR_FILL : undefined,
        color: overlayCursor.style === "block" ? CURSOR_TEXT : undefined,
        fontFamily: overlayCursor.style === "block" ? TERMINAL_FONT_FAMILY : undefined,
        fontSize: overlayCursor.style === "block" ? `${TERMINAL_FONT_SIZE}px` : undefined,
        lineHeight: overlayCursor.style === "block" ? TERMINAL_LINE_HEIGHT : undefined,
        fontWeight: overlayCursor.style === "block" ? 400 : undefined,
        paddingLeft: overlayCursor.style === "block" ? "1px" : undefined,
        boxShadow: overlayCursor.style === "block" ? "inset 0 0 0 1px rgba(255, 216, 138, 0.22)" : undefined,
      }
    : undefined;

  return (
    <section className={`pane-shell ${active ? "pane-active" : ""}`} style={accentStyle}>
      <div
        ref={stageRef}
        className="terminal-stage"
        onMouseDownCapture={() => {
          if (!active) onActivate(id);
          terminalRef.current?.focus();
        }}
        onClick={() => {
          if (!active) onActivate(id);
          terminalRef.current?.focus();
        }}
        role="presentation"
      >
        <div ref={hostRef} className="xterm-host" />
        {overlayCursor?.visible && (
          <div
            className={`terminal-cursor-overlay terminal-cursor-overlay-${overlayCursor.style}`}
            style={overlayCursorStyle}
            aria-hidden="true"
          >
            {overlayCursor.style === "block" ? overlayCursor.char || " " : null}
          </div>
        )}
      </div>
    </section>
  );
}

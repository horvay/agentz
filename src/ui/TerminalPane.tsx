import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import type { TerminalFrame } from "../shared/protocol";
import type { DashboardShortcuts } from "../shared/config";
import type { RpcClient } from "./rpcClient";
import { doesEventMatchShortcut } from "./shortcuts";

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
    shortcut: "new-pane" | "focus-left" | "focus-right" | "move-left" | "move-right" | "open-settings",
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
  const canvasAddonRef = useRef<CanvasAddon | null>(null);
  const syncedSizeRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const refreshRafRef = useRef<number | null>(null);
  const syncOutputActiveRef = useRef(false);
  const syncOutputBufferRef = useRef("");
  const syncOutputTimeoutRef = useRef<number | null>(null);
  const renderQueueRef = useRef<Array<{ payload: string; reset: boolean; dedupeKey?: string }>>([]);
  const flushRenderQueueRef = useRef<() => void>(() => {});
  const enqueueRenderRef = useRef<
    (payload: string, options?: { reset?: boolean; dedupeKey?: string; replaceQueuedFull?: boolean }) => void
  >(() => {});
  const renderInFlightRef = useRef(false);
  const lastAppliedRenderRef = useRef<string>("");
  const altBufferActiveRef = useRef(false);
  const activeRef = useRef(active);
  const shortcutHandlerRef = useRef(onShortcut);
  const shortcutsRef = useRef(shortcuts);
  const [overlayCursor, setOverlayCursor] = useState<OverlayCursorState | null>(null);
  activeRef.current = active;
  shortcutHandlerRef.current = onShortcut;
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const terminal = terminalRef.current;
    const host = hostRef.current;
    const stage = stageRef.current;
    if (!terminal || !host || !stage || !currentFrame?.cursorRow || !currentFrame?.cursorCol) {
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
      const next = renderQueueRef.current.shift();
      if (!next) return;
      renderInFlightRef.current = true;
      if (next.reset) {
        terminalRef.current.reset();
      }
      terminalRef.current.write(next.payload, () => {
        renderInFlightRef.current = false;
        if (next.dedupeKey) {
          lastAppliedRenderRef.current = next.dedupeKey;
        } else {
          lastAppliedRenderRef.current = "";
        }
        scheduleFullRefresh();
        if (activeRef.current) {
          terminalRef.current?.focus();
        }
        flushRenderQueue();
      });
    };

      const enqueueRender = (
        payload: string,
        options?: { reset?: boolean; dedupeKey?: string; replaceQueuedFull?: boolean },
      ) => {
        if (options?.dedupeKey && payload === lastAppliedRenderRef.current) return;
        if (options?.replaceQueuedFull) {
          // A new full-frame snapshot supersedes any queued incremental work.
          renderQueueRef.current = [];
        }
        renderQueueRef.current.push({
          payload,
          reset: options?.reset === true,
        dedupeKey: options?.dedupeKey,
      });
      flushRenderQueue();
    };
    flushRenderQueueRef.current = flushRenderQueue;
    enqueueRenderRef.current = enqueueRender;

    const terminal = new Terminal({
      fontFamily: "JetBrainsMonoNerdFontMonoLocal, JetBrainsMono Nerd Font Mono, monospace",
      fontSize: 14,
      fontWeight: "400",
      fontWeightBold: "700",
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: false,
      cursorStyle: "block",
      cursorInactiveStyle: "bar",
      cursorWidth: 2,
      convertEol: false,
      scrollback: 8000,
      minimumContrastRatio: 4.5,
      theme: {
        background: "#0a0f1a",
        foreground: "#d9e6ff",
        cursor: "#ffe066",
        cursorAccent: "#02060d",
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
    const canvasAddon = new CanvasAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(canvasAddon);
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
        const prevSize = lastSentSizeRef.current;
        if (prevSize && prevSize.cols === nextCols && prevSize.rows === nextRows) return;
        lastSentSizeRef.current = { cols: nextCols, rows: nextRows };
        rpc.send({ type: "resize", id, cols: nextCols, rows: nextRows });
      });
    };

    fitAndSync();

    terminal.onData((data) => rpc.send({ type: "input", id, data }));
    terminal.onResize((size) =>
      rpc.send({ type: "resize", id, cols: size.cols, rows: size.rows }),
    );

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    canvasAddonRef.current = canvasAddon;
    syncedSizeRef.current = false;
    renderQueueRef.current = [];
    lastAppliedRenderRef.current = "";
    altBufferActiveRef.current = false;

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
      if (refreshRafRef.current) cancelAnimationFrame(refreshRafRef.current);
      if (syncOutputTimeoutRef.current) window.clearTimeout(syncOutputTimeoutRef.current);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
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
      const useOverlayCursor = typeof frame.cursorRow === "number" && typeof frame.cursorCol === "number";
      const cursorVisible = active && (frame.cursorVisible ?? true);
      const cursorSuffix =
        useOverlayCursor ? "\x1b[?25l" : cursorVisible ? "\x1b[?25h" : "\x1b[?25l";

      if (frame.renderPatchVt) {
        enqueueRenderRef.current(`${frame.renderPatchVt}${cursorSuffix}`);
      } else if (frame.renderVt) {
        let transition = "";
        const altScreen = frame.altScreen === true;
        if (altScreen) {
          transition = "\x1b[?1049h\x1b[H\x1b[2J";
          altBufferActiveRef.current = true;
        } else if (altBufferActiveRef.current) {
          transition = "\x1b[?1049l\x1b[H\x1b[2J";
          altBufferActiveRef.current = altScreen;
        }
        const framePrefix = altScreen ? "" : "\x1b[H\x1b[2J";
        const payload = `${transition}${framePrefix}${frame.renderVt}${cursorSuffix}`;
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
      terminalRef.current.write(currentFrame?.cursorRow && currentFrame?.cursorCol ? "\x1b[?25l" : "\x1b[?25h");
      const focusRaf = requestAnimationFrame(() => {
        terminalRef.current?.focus();
      });
      return () => {
        cancelAnimationFrame(focusRaf);
      };
    }
    terminalRef.current.write("\x1b[?25l");
    terminalRef.current.blur();
  }, [active, currentFrame?.cursorCol, currentFrame?.cursorRow]);

  return (
    <section className={`pane-shell ${active ? "pane-active" : ""}`} style={accentStyle}>
      <div
        ref={stageRef}
        className="terminal-stage"
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
            style={{
              left: `${overlayCursor.left}px`,
              top: `${overlayCursor.top}px`,
              width: `${overlayCursor.width}px`,
              height: `${overlayCursor.height}px`,
            }}
            aria-hidden="true"
          >
            {overlayCursor.style === "block" ? overlayCursor.char || " " : null}
          </div>
        )}
      </div>
    </section>
  );
}

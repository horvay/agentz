import { useEffect, useRef, useState } from "react";
import { Terminal } from "xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalFrame } from "../shared/protocol";
import type { RpcClient } from "./rpcClient";

interface Props {
  id: string;
  rpc: RpcClient;
  frame?: TerminalFrame;
  active: boolean;
  focusRequestSeq: number;
  onActivate: (id: string) => void;
  onShortcut: (shortcut: "new-pane" | "focus-left" | "focus-right") => void;
}

export function TerminalPane({ id, rpc, frame, active, focusRequestSeq, onActivate, onShortcut }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const syncedSizeRef = useRef(false);
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const refreshRafRef = useRef<number | null>(null);
  const syncOutputActiveRef = useRef(false);
  const syncOutputBufferRef = useRef("");
  const syncOutputTimeoutRef = useRef<number | null>(null);
  const pendingRenderVtRef = useRef<{ vt: string; active: boolean; altScreen: boolean } | null>(null);
  const renderTimerRef = useRef<number | null>(null);
  const renderInFlightRef = useRef(false);
  const lastAppliedRenderRef = useRef<string>("");
  const altBufferActiveRef = useRef(false);
  const shortcutHandlerRef = useRef(onShortcut);
  const [terminalMountSeq, setTerminalMountSeq] = useState(0);

  useEffect(() => {
    shortcutHandlerRef.current = onShortcut;
  }, [onShortcut]);

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

    const flushPendingRender = () => {
      if (!terminalRef.current) return;
      if (renderInFlightRef.current) return;
      const pending = pendingRenderVtRef.current;
      if (!pending) return;

      let transition = "";
      if (pending.altScreen !== altBufferActiveRef.current) {
        transition = pending.altScreen ? "\x1b[?1049h\x1b[H\x1b[2J" : "\x1b[?1049l\x1b[H\x1b[2J";
        altBufferActiveRef.current = pending.altScreen;
      }
      const payload = `${transition}${pending.vt}${pending.active ? "\x1b[?25h" : "\x1b[?25l"}`;
      if (payload === lastAppliedRenderRef.current) {
        if (pending.active) terminalRef.current.write("\x1b[?25h");
        else terminalRef.current.write("\x1b[?25l");
        pendingRenderVtRef.current = null;
        return;
      }

      pendingRenderVtRef.current = null;
      renderInFlightRef.current = true;
      terminalRef.current.reset();
      terminalRef.current.write(payload, () => {
        renderInFlightRef.current = false;
        lastAppliedRenderRef.current = payload;
        if (pendingRenderVtRef.current) {
          if (renderTimerRef.current) window.clearTimeout(renderTimerRef.current);
          renderTimerRef.current = window.setTimeout(() => {
            renderTimerRef.current = null;
            flushPendingRender();
          }, 50);
        }
      });
    };

    const terminal = new Terminal({
      fontFamily: "JetBrainsMonoNerdFontMonoLocal, JetBrainsMono Nerd Font Mono, monospace",
      fontSize: 14,
      fontWeight: "400",
      fontWeightBold: "700",
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: false,
      cursorStyle: "block",
      cursorInactiveStyle: "block",
      cursorWidth: 2,
      convertEol: false,
      scrollback: 8000,
      minimumContrastRatio: 4.5,
      rendererType: "dom",
      theme: {
        background: "#0a0f1a",
        foreground: "#d9e6ff",
        cursor: "#ffd88a",
        cursorAccent: "#0a0f1a",
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
    terminal.open(host);
    if (active) {
      requestAnimationFrame(() => terminal.focus());
    }
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      if (!event.ctrlKey || !event.shiftKey) return true;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        shortcutHandlerRef.current("new-pane");
        return false;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        shortcutHandlerRef.current("focus-left");
        return false;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        shortcutHandlerRef.current("focus-right");
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
    syncedSizeRef.current = false;
    setTerminalMountSeq((prev) => prev + 1);

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
      if (renderTimerRef.current) window.clearTimeout(renderTimerRef.current);
      if (syncOutputTimeoutRef.current) window.clearTimeout(syncOutputTimeoutRef.current);
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [id, rpc]);

  useEffect(() => {
    if (!frame || !terminalRef.current) return;
    const terminal = terminalRef.current;

    if (frame.renderVt) {
      // Coalesce high-frequency full-frame updates to reduce visible flashing.
      pendingRenderVtRef.current = { vt: frame.renderVt, active, altScreen: frame.altScreen === true };
      if (!renderTimerRef.current) {
        renderTimerRef.current = window.setTimeout(() => {
          renderTimerRef.current = null;
          if (!terminalRef.current) return;
          if (renderInFlightRef.current) return;
          if (!pendingRenderVtRef.current) return;
          const pending = pendingRenderVtRef.current;
          const framePayload = pending.vt;
          let transition = "";
          if (pending.altScreen !== altBufferActiveRef.current) {
            transition = pending.altScreen ? "\x1b[?1049h\x1b[H\x1b[2J" : "\x1b[?1049l\x1b[H\x1b[2J";
            altBufferActiveRef.current = pending.altScreen;
          }
          const payload = `${transition}${framePayload}${pending.active ? "\x1b[?25h" : "\x1b[?25l"}`;
          if (payload === lastAppliedRenderRef.current) {
            pendingRenderVtRef.current = null;
            return;
          }
          pendingRenderVtRef.current = null;
          renderInFlightRef.current = true;
          if (!pending.altScreen) {
            terminalRef.current.reset();
          }
          terminalRef.current.write(payload, () => {
            renderInFlightRef.current = false;
            lastAppliedRenderRef.current = payload;
            if (!pendingRenderVtRef.current || renderTimerRef.current) return;
            renderTimerRef.current = window.setTimeout(() => {
              renderTimerRef.current = null;
              if (!terminalRef.current || renderInFlightRef.current || !pendingRenderVtRef.current) return;
              const next = pendingRenderVtRef.current;
              const nextFramePayload = next.vt;
              let nextTransition = "";
              if (next.altScreen !== altBufferActiveRef.current) {
                nextTransition = next.altScreen ? "\x1b[?1049h\x1b[H\x1b[2J" : "\x1b[?1049l\x1b[H\x1b[2J";
                altBufferActiveRef.current = next.altScreen;
              }
              const nextPayload = `${nextTransition}${nextFramePayload}${next.active ? "\x1b[?25h" : "\x1b[?25l"}`;
              if (nextPayload === lastAppliedRenderRef.current) {
                pendingRenderVtRef.current = null;
                return;
              }
              pendingRenderVtRef.current = null;
              renderInFlightRef.current = true;
              if (!next.altScreen) {
                terminalRef.current.reset();
              }
              terminalRef.current.write(nextPayload, () => {
                renderInFlightRef.current = false;
                lastAppliedRenderRef.current = nextPayload;
              });
            }, 50);
          });
        }, 50);
      }
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
  }, [frame?.seq, active]);

  useEffect(() => {
    if (!terminalRef.current) return;
    if (active) {
      const focusTerminal = () => {
        if (!terminalRef.current) return;
        window.focus();
        terminalRef.current.focus();
        const helperTextarea = hostRef.current?.querySelector(
          ".xterm-helper-textarea",
        ) as HTMLTextAreaElement | null;
        helperTextarea?.focus({ preventScroll: true });
        terminalRef.current.write("\x1b[?25h");
      };
      focusTerminal();
      const focusRaf = requestAnimationFrame(() => {
        focusTerminal();
      });
      const focusTimeoutA = window.setTimeout(() => {
        focusTerminal();
      }, 120);
      const focusTimeoutB = window.setTimeout(() => {
        focusTerminal();
      }, 320);
      const onWindowFocus = () => {
        focusTerminal();
      };
      const onVisibilityChange = () => {
        if (document.visibilityState === "visible") {
          focusTerminal();
        }
      };
      window.addEventListener("focus", onWindowFocus);
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        window.removeEventListener("focus", onWindowFocus);
        document.removeEventListener("visibilitychange", onVisibilityChange);
        cancelAnimationFrame(focusRaf);
        window.clearTimeout(focusTimeoutA);
        window.clearTimeout(focusTimeoutB);
      };
    }
    terminalRef.current.write("\x1b[?25l");
    terminalRef.current.blur();
  }, [active, focusRequestSeq, terminalMountSeq]);

  return (
    <section className={`pane-shell ${active ? "pane-active" : ""}`}>
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
      </div>
    </section>
  );
}

import { spawn as spawnPty, type IPty } from "node-pty";
import { spawn } from "node:child_process";
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";

import type { TerminalFrame } from "../shared/protocol";

const MAX_ACTIVITY_TEXT_CHARS = 4_000;
const MAX_PREVIEW_LINES = 200;
const MAX_ALT_SCREEN_REPLAY_CHARS = 1_000_000;
const BUSY_POLL_INTERVAL_MS = 700;
const ACTIVE_RENDER_BATCH_MS = 12;
const ALT_SCREEN_RESIZE_SETTLE_MS = 48;
const ALT_SCREEN_RESIZE_FALLBACK_MS = 180;
const WINDOWS_TERM_NAME = "xterm-256color";

interface WritableLikeSocket {
  destroyed?: boolean;
  closed?: boolean;
  writable?: boolean;
  writableEnded?: boolean;
  readyState?: string;
  destroy?: () => void;
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
}

interface WindowsPtyInternals extends IPty {
  _socket?: WritableLikeSocket;
  _isReady?: boolean;
  _writable?: boolean;
  _agent?: {
    exitCode?: number;
    inSocket?: WritableLikeSocket;
  };
}

interface TerminalSessionBackend {
  onData(cb: (frame: TerminalFrame) => void): void;
  onExit(cb: (exitCode: number) => void): void;
  input(data: string, encoding?: "utf8" | "binary"): void;
  setFlowPaused(paused: boolean): void;
  setFrameInterval(intervalMs: number, previewOnly?: boolean): void;
  requestSnapshot(): void;
  resize(cols: number, rows: number): void;
  getCwd(): Promise<string | undefined>;
  kill(): void;
}

function trimActivityText(text: string): string {
  return text.length > MAX_ACTIVITY_TEXT_CHARS ? text.slice(-MAX_ACTIVITY_TEXT_CHARS) : text;
}

function decodeOscPath(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("\\\\")) {
    return trimmed.replace(/\//g, "\\");
  }

  if (trimmed.startsWith("file://")) {
    try {
      const url = new URL(trimmed);
      let path = decodeURIComponent(url.pathname);
      if (/^\/[A-Za-z]:/.test(path)) {
        path = path.slice(1);
      }
      return path.replace(/\//g, "\\");
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function extractCwdFromOsc(data: string): string | undefined {
  const matches = [
    ...data.matchAll(/\u001b]7;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g),
    ...data.matchAll(/\u001b]9;9;([^\u0007\u001b]+)(?:\u0007|\u001b\\)/g),
  ];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const next = decodeOscPath(matches[index]?.[1] ?? "");
    if (next) return next;
  }
  return undefined;
}

function previewLinesFromBuffer(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const start = Math.max(0, buffer.length - MAX_PREVIEW_LINES);
  const lines: string[] = [];
  for (let row = start; row < buffer.length; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    lines.push(line.translateToString(true).slice(0, 512));
  }
  return lines.slice(-MAX_PREVIEW_LINES);
}

function mapMouseTrackingMode(terminal: Terminal): TerminalFrame["mouseTrackingMode"] {
  const mode = terminal.modes.mouseTrackingMode;
  if (mode === "x10") return "x10";
  if (mode === "vt200") return "normal";
  if (mode === "drag") return "button";
  if (mode === "any") return "any";
  return "none";
}

function getCursorVisible(terminal: Terminal): boolean | undefined {
  const hidden = (terminal as Terminal & { _core?: { coreService?: { isCursorHidden?: boolean } } })._core?.coreService
    ?.isCursorHidden;
  return typeof hidden === "boolean" ? !hidden : undefined;
}

function isLikelyShellCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return (
    normalized.endsWith("\\cmd.exe") ||
    normalized.endsWith("\\powershell.exe") ||
    normalized.endsWith("\\pwsh.exe") ||
    normalized === "cmd.exe" ||
    normalized === "powershell.exe" ||
    normalized === "pwsh.exe"
  );
}

function hasDirectChildProcess(parentPid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `if (Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parentPid}" | Select-Object -First 1) { exit 0 } else { exit 1 }`,
      ],
      {
        stdio: "ignore",
      },
    );

    proc.on("exit", (code) => resolve(code === 0));
    proc.on("error", () => resolve(false));
  });
}

function sliceFromAltScreenEnter(data: string): string {
  const markers = ["\u001b[?1049h", "\u001b[?1047h"];
  let markerIndex = -1;
  for (const marker of markers) {
    const nextIndex = data.lastIndexOf(marker);
    if (nextIndex > markerIndex) markerIndex = nextIndex;
  }
  return markerIndex >= 0 ? data.slice(markerIndex) : data;
}

function appendAltScreenReplay(existing: string, chunk: string): string {
  const next = `${existing}${chunk}`;
  if (next.length <= MAX_ALT_SCREEN_REPLAY_CHARS) return next;
  return next.slice(next.length - MAX_ALT_SCREEN_REPLAY_CHARS);
}

interface InternalSerializeAddon extends SerializeAddon {
  _serializeBufferByScrollback?: (terminal: Terminal, buffer: unknown, scrollback?: number) => string;
  _serializeModes?: (terminal: Terminal) => string;
}

function attachSocketErrorSink(socket: WritableLikeSocket | undefined, logError: (error: Error) => void): void {
  socket?.on?.("error", (error) => {
    if (String((error as { code?: string }).code ?? "") !== "ERR_SOCKET_CLOSED") {
      logError(error as Error);
    }
  });
}

function canWriteToPty(pty: WindowsPtyInternals): boolean {
  if (pty._writable === false) return false;
  if (pty._agent?.exitCode !== undefined) return false;

  const inputSocket = pty._agent?.inSocket;
  if (inputSocket) {
    if (inputSocket.destroyed || inputSocket.closed || inputSocket.writable === false || inputSocket.writableEnded) {
      return false;
    }
    if (inputSocket.readyState === "closed") {
      return false;
    }
  }

  const outputSocket = pty._socket;
  if (outputSocket && (outputSocket.destroyed || outputSocket.closed || outputSocket.readyState === "closed")) {
    return false;
  }

  return true;
}

function destroyPtySockets(pty: WindowsPtyInternals): void {
  pty._agent?.inSocket?.destroy?.();
  pty._socket?.destroy?.();
}

export class WindowsTerminalSessionBackend implements TerminalSessionBackend {
  private readonly pty: IPty;
  private readonly terminal: Terminal;
  private readonly serializeAddon: SerializeAddon;
  private readonly busyTracksChildren: boolean;
  private seq = 0;
  private cols: number;
  private rows: number;
  private cwd: string;
  private shellBusy = false;
  private shellBusyAtMs = 0;
  private lastPreviewLines: string[] = [];
  private lastAltScreen = false;
  private lastChunk = "";
  private lastActivityText = "";
  private frameHandler: ((frame: TerminalFrame) => void) | null = null;
  private exitHandler: ((exitCode: number) => void) | null = null;
  private frameIntervalMs = 0;
  private previewOnly = false;
  private hasExited = false;
  private flowPaused = false;
  private lastFrameEmitAtMs = 0;
  private pendingRenderData = "";
  private pendingFullFrame = false;
  private pendingPatchByteCount = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private busyPollTimer: ReturnType<typeof setInterval> | null = null;
  private busyPollInFlight = false;
  private killRequested = false;
  private awaitingAltScreenResizeRedraw = false;
  private altScreenResizeRedrawDeadlineAtMs = 0;
  private altScreenResizeTimer: ReturnType<typeof setTimeout> | null = null;
  private altScreenReplayVt = "";

  constructor(
    readonly id: string,
    cols: number,
    rows: number,
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    explicitCommand: boolean,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.busyTracksChildren = !explicitCommand || isLikelyShellCommand(command);

    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      cursorBlink: true,
      cursorStyle: "block",
      scrollback: 5_000,
      windowsPty: { backend: "conpty" },
    });
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon as unknown as { activate(terminal: Terminal): void; dispose(): void });

    this.pty = spawnPty(command, args, {
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      cwd,
      env,
      name: WINDOWS_TERM_NAME,
      useConpty: true,
    });
    const windowsPty = this.pty as WindowsPtyInternals;
    const logSocketError = (error: Error) => {
      if (!this.hasExited && !String((error as { code?: string }).code ?? "").includes("ERR_SOCKET_CLOSED")) {
        console.error(`[terminal:${this.id}:windows-pty] ${error.message}`);
      }
    };

    (this.pty as IPty & { on(event: "error", listener: (error: Error) => void): void }).on("error", logSocketError);
    attachSocketErrorSink(windowsPty._socket, logSocketError);
    attachSocketErrorSink(windowsPty._agent?.inSocket, logSocketError);

    if (explicitCommand && !this.busyTracksChildren) {
      this.setShellBusy(true);
    }

    this.pty.onData((data) => {
      this.handlePtyData(data);
    });

    this.pty.onExit(({ exitCode }) => {
      this.emitExit(exitCode);
    });

    if (this.busyTracksChildren) {
      this.busyPollTimer = setInterval(() => {
        void this.pollBusyState();
      }, BUSY_POLL_INTERVAL_MS);
    }
  }

  onData(cb: (frame: TerminalFrame) => void): void {
    this.frameHandler = cb;
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitHandler = cb;
  }

  input(data: string, encoding: "utf8" | "binary" = "utf8"): void {
    const windowsPty = this.pty as WindowsPtyInternals;
    if (this.hasExited || this.killRequested || !canWriteToPty(windowsPty)) return;
    try {
      if (encoding === "binary") {
        this.pty.write(Buffer.from(data, "binary"));
      } else {
        this.pty.write(data);
      }
    } catch {
      // The pty can close synchronously during teardown.
    }
  }

  setFlowPaused(paused: boolean): void {
    if (paused === this.flowPaused) return;
    this.flowPaused = paused;
    if (paused) {
      this.pty.pause();
    } else {
      this.pty.resume();
    }
  }

  setFrameInterval(intervalMs: number, previewOnly = false): void {
    this.frameIntervalMs = Math.max(0, Math.trunc(intervalMs));
    const changedPreviewMode = this.previewOnly !== previewOnly;
    this.previewOnly = previewOnly;
    if (changedPreviewMode) {
      this.pendingFullFrame = true;
    }
    this.queueFrameEmission(changedPreviewMode);
  }

  requestSnapshot(): void {
    if (this.terminal.buffer.active.type === "alternate") {
      this.queueFrameEmission(false);
      return;
    }
    this.queueFrameEmission(true);
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(2, Math.trunc(cols));
    this.rows = Math.max(2, Math.trunc(rows));
    const wasAltScreen = this.terminal.buffer.active.type === "alternate";
    this.pty.resize(this.cols, this.rows);
    this.terminal.resize(this.cols, this.rows);
    if (wasAltScreen) {
      this.pendingRenderData = "";
      this.pendingPatchByteCount = 0;
      this.pendingFullFrame = false;
      this.awaitingAltScreenResizeRedraw = true;
      this.altScreenResizeRedrawDeadlineAtMs = Date.now() + ALT_SCREEN_RESIZE_FALLBACK_MS;
      this.altScreenReplayVt = "";
      this.clearEmitTimer();
      this.scheduleAltScreenResizeFrame(ALT_SCREEN_RESIZE_FALLBACK_MS);
      return;
    }
    this.queueFrameEmission(true);
  }

  getCwd(): Promise<string | undefined> {
    return Promise.resolve(this.cwd);
  }

  kill(): void {
    if (this.hasExited) return;
    this.killRequested = true;
    const pid = this.pty.pid;
    if (Number.isFinite(pid) && pid > 0) {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
      killer.on("exit", (code) => {
        if (code === 0) {
          setTimeout(() => {
            if (!this.hasExited) {
              destroyPtySockets(this.pty as WindowsPtyInternals);
            }
          }, 200);
          return;
        }
        if (!this.hasExited) {
          this.pty.kill();
        }
      });
      killer.on("error", () => {
        if (!this.hasExited) {
          this.pty.kill();
        }
      });
      return;
    }
    this.pty.kill();
  }

  private handlePtyData(data: string): void {
    if (this.hasExited) return;
    const wasAltScreen = this.terminal.buffer.active.type === "alternate";

    const nextCwd = extractCwdFromOsc(data);
    if (nextCwd) {
      this.cwd = nextCwd;
    }

    const activityTail = trimActivityText(data);
    this.lastChunk = activityTail;
    if (activityTail.length > 0) {
      this.lastActivityText = trimActivityText(
        this.lastActivityText ? `${this.lastActivityText}\n${activityTail}` : activityTail,
      );
    }
    this.pendingRenderData += data;
    this.pendingPatchByteCount += Buffer.byteLength(data, "utf8");

    this.terminal.write(data, () => {
      this.lastPreviewLines = previewLinesFromBuffer(this.terminal);
      this.lastAltScreen = this.terminal.buffer.active.type === "alternate";
      this.updateAltScreenReplayState(wasAltScreen, this.lastAltScreen, data);
      if (this.awaitingAltScreenResizeRedraw) {
        const remainingMs = Math.max(0, this.altScreenResizeRedrawDeadlineAtMs - Date.now());
        this.scheduleAltScreenResizeFrame(Math.min(ALT_SCREEN_RESIZE_SETTLE_MS, remainingMs));
        return;
      }
      this.queueFrameEmission(false);
    });
  }

  private queueFrameEmission(forceFull: boolean): void {
    if (this.hasExited || !this.frameHandler) return;
    if (forceFull) {
      this.pendingFullFrame = true;
    }

    if (forceFull) {
      this.clearEmitTimer();
      this.emitFrame(this.pendingFullFrame);
      return;
    }

    if (this.frameIntervalMs === 0) {
      if (this.emitTimer) return;
      this.emitTimer = setTimeout(() => {
        this.emitTimer = null;
        this.emitFrame(this.pendingFullFrame);
      }, ACTIVE_RENDER_BATCH_MS);
      return;
    }

    if (this.emitTimer) return;
    const elapsed = Date.now() - this.lastFrameEmitAtMs;
    const waitMs = Math.max(0, this.frameIntervalMs - elapsed);
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emitFrame(this.pendingFullFrame);
    }, waitMs);
  }

  private emitFrame(forceFull: boolean): void {
    if (this.hasExited || !this.frameHandler) return;

    const previewLines = this.lastPreviewLines.length > 0 ? this.lastPreviewLines : previewLinesFromBuffer(this.terminal);
    const altScreen = this.terminal.buffer.active.type === "alternate";
    const buffer = this.terminal.buffer.active;
    const renderData = this.pendingRenderData;
    const shouldRender = !this.previewOnly;

    let screenMode: TerminalFrame["screenMode"];
    let renderVt: string | undefined;
    let renderPatchVt: string | undefined;
    let renderPatchKind: TerminalFrame["renderPatchKind"];
    const shouldResyncAltScreen = false;

    if (shouldRender && altScreen && renderData.length > 0) {
      screenMode = "patch";
      renderPatchVt = renderData;
      renderPatchKind = "alt-row-update";
    } else if (shouldRender && !altScreen && (forceFull || renderData.length === 0 || shouldResyncAltScreen)) {
      screenMode = "full";
      renderVt = this.serializeFullFrameVt(altScreen);
      this.pendingPatchByteCount = 0;
    } else if (shouldRender && renderData.length > 0) {
      screenMode = "patch";
      renderPatchVt = renderData;
      renderPatchKind = altScreen ? "alt-row-update" : "row-update";
    }

    this.pendingRenderData = "";
    this.pendingFullFrame = false;
    this.lastPreviewLines = previewLines;
    this.lastAltScreen = altScreen;
    this.lastFrameEmitAtMs = Date.now();

    this.frameHandler(
      this.snapshot(
        "",
        screenMode,
        renderVt,
        previewLines,
        altScreen,
        renderPatchVt,
        renderPatchKind,
        getCursorVisible(this.terminal),
        this.terminal.options.cursorStyle ?? undefined,
        this.terminal.options.cursorBlink ?? undefined,
        buffer.cursorY + 1,
        buffer.cursorX + 1,
        mapMouseTrackingMode(this.terminal),
        undefined,
        this.terminal.modes.sendFocusMode,
        undefined,
      ),
    );
  }

  private snapshot(
    chunk = "",
    screenMode?: "full" | "patch",
    renderVt?: string,
    previewLines?: string[],
    altScreen?: boolean,
    renderPatchVt?: string,
    renderPatchKind?: "cursor-only" | "row-update" | "alt-row-update",
    cursorVisible?: boolean,
    cursorStyle?: "block" | "underline" | "bar",
    cursorBlink?: boolean,
    cursorRow?: number,
    cursorCol?: number,
    mouseTrackingMode?: "none" | "x10" | "normal" | "button" | "any",
    mouseFormat?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels",
    focusEvent?: boolean,
    mouseAlternateScroll?: boolean,
  ): TerminalFrame {
    this.seq += 1;
    return {
      id: this.id,
      cols: this.cols,
      rows: this.rows,
      seq: this.seq,
      cwd: this.cwd,
      screenMode,
      renderVt,
      renderPatchVt,
      renderPatchKind,
      altScreen,
      chunk: trimActivityText(chunk || this.lastChunk),
      vt: this.lastActivityText,
      previewLines: previewLines ?? this.lastPreviewLines,
      cursorVisible,
      cursorStyle,
      cursorBlink,
      cursorRow,
      cursorCol,
      mouseTrackingMode,
      mouseFormat,
      focusEvent,
      mouseAlternateScroll,
      shellBusy: this.shellBusy,
      shellBusyAtMs: this.shellBusyAtMs,
    };
  }

  private async pollBusyState(): Promise<void> {
    if (this.hasExited || !this.busyTracksChildren || this.busyPollInFlight) return;
    this.busyPollInFlight = true;
    try {
      this.setShellBusy(await hasDirectChildProcess(this.pty.pid));
    } finally {
      this.busyPollInFlight = false;
    }
  }

  private setShellBusy(nextBusy: boolean): void {
    if (this.shellBusy === nextBusy) return;
    this.shellBusy = nextBusy;
    this.shellBusyAtMs = Date.now();
    if (this.frameHandler) {
      this.frameHandler(this.snapshot("", undefined, undefined, this.lastPreviewLines, this.lastAltScreen));
    }
  }

  private clearEmitTimer(): void {
    if (!this.emitTimer) return;
    clearTimeout(this.emitTimer);
    this.emitTimer = null;
  }

  private serializeFullFrameVt(altScreen: boolean): string {
    if (!altScreen) {
      return this.serializeAddon.serialize({
        scrollback: Math.max(this.rows, MAX_PREVIEW_LINES),
      });
    }

    try {
      const internal = this.serializeAddon as InternalSerializeAddon;
      const serializeAltBuffer = internal._serializeBufferByScrollback;
      if (typeof serializeAltBuffer === "function") {
        const altPayload = serializeAltBuffer(this.terminal, this.terminal.buffer.alternate as unknown, undefined);
        const modes = internal._serializeModes?.(this.terminal) ?? "";
        return `\u001b[?1049h\u001b[H\u001b[2J${altPayload}${modes}`;
      }
    } catch {}

    if (this.altScreenReplayVt.length === 0) {
      return this.serializeAddon.serialize({
        scrollback: Math.max(this.rows, MAX_PREVIEW_LINES),
      });
    }

    return this.altScreenReplayVt;
  }

  private updateAltScreenReplayState(wasAltScreen: boolean, isAltScreen: boolean, data: string): void {
    if (!wasAltScreen && isAltScreen) {
      this.altScreenReplayVt = sliceFromAltScreenEnter(data);
      return;
    }
    if (wasAltScreen && isAltScreen) {
      this.altScreenReplayVt = appendAltScreenReplay(this.altScreenReplayVt, data);
      return;
    }
    if (wasAltScreen && !isAltScreen) {
      this.altScreenReplayVt = "";
      return;
    }
    if (!isAltScreen) {
      this.altScreenReplayVt = "";
    }
  }

  private scheduleAltScreenResizeFrame(waitMs: number): void {
    if (this.hasExited || !this.frameHandler) return;
    this.clearAltScreenResizeTimer();
    this.altScreenResizeTimer = setTimeout(() => {
      this.altScreenResizeTimer = null;
      this.awaitingAltScreenResizeRedraw = false;
      this.emitFrame(false);
    }, Math.max(0, waitMs));
  }

  private clearAltScreenResizeTimer(): void {
    if (!this.altScreenResizeTimer) return;
    clearTimeout(this.altScreenResizeTimer);
    this.altScreenResizeTimer = null;
  }

  private emitExit(exitCode: number): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.killRequested = true;
    this.clearEmitTimer();
    this.clearAltScreenResizeTimer();
    destroyPtySockets(this.pty as WindowsPtyInternals);
    (this.terminal as Terminal & { dispose?: () => void }).dispose?.();
    if (this.busyPollTimer) {
      clearInterval(this.busyPollTimer);
      this.busyPollTimer = null;
    }
    this.exitHandler?.(exitCode);
  }
}

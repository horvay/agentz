import { dirname, join } from "node:path";
import { ptyToText } from "ghostty-opentui";

import type { TerminalFrame } from "../shared/protocol";

const MAX_VT_CHARS = 250_000;
const MAX_ACTIVITY_VT_CHARS = 4_000;
const MAX_PREVIEW_LINES = 200;
const MAX_HOST_LINE_CHARS = 12_000_000;
const WORKER_INPUT_BATCH_MS = 8;
let hasWarnedMissingNativeHost = false;

function resolveNativeHostPath(rootCwd: string): string {
  const direct = `${rootCwd}/src/native/zig-out/bin/ghostty-pty-host`;
  if (Bun.file(direct).size > 0) return direct;

  const execDir = dirname(process.execPath);
  const packaged = join(execDir, "..", "Resources", "app", "bin", "ghostty-pty-host");
  if (Bun.file(packaged).size > 0) return packaged;

  return direct;
}



function toPreviewLines(vt: string, cols: number, rows: number): string[] {
  try {
    const plain = ptyToText(vt, {
      cols: Math.max(40, cols),
      rows: Math.max(MAX_PREVIEW_LINES, rows),
    });
    return plain
      .split(/\r?\n/)
      .slice(-MAX_PREVIEW_LINES)
      .map((line) => line.slice(0, 512));
  } catch {
    const noAnsi = vt.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    return noAnsi
      .split(/\r?\n/)
      .slice(-MAX_PREVIEW_LINES)
      .map((line) => line.slice(0, 512));
  }
}

export class TerminalSession {
  private readonly hostHandle: Bun.Subprocess;
  private vtBuffer = "";
  private seq = 0;
  private cols: number;
  private rows: number;
  private cwd: string;
  private shellBusy = false;
  private shellBusyAtMs = 0;
  private lastPreviewLines: string[] = [];
  private exitHandler: ((exitCode: number) => void) | null = null;
  private frameHandler: ((frame: TerminalFrame) => void) | null = null;
  private stdoutLineBuffer = "";
  private hasExited = false;
  private lastAltScreen = false;
  private pendingCwdResolvers = new Set<(cwd?: string) => void>();
  private flowPaused = false;
  private pendingWorkerInput: { data: string; encoding: "utf8" | "binary" }[] = [];
  private workerInputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    cols: number,
    rows: number,
    command?: string,
    args?: string[],
    cwd?: string,
  ) {
    this.cols = cols;
    this.rows = rows;
    const launchBaseCwd = process.env.GHOSTTY_DASHBOARD_LAUNCH_CWD || process.cwd();
    this.cwd = cwd ?? launchBaseCwd;

    const rootCwd = process.env.GHOSTTY_DASHBOARD_ROOT ?? process.cwd();
    const launchCwd = cwd ?? launchBaseCwd;
    const shell = command ?? process.env.SHELL ?? (process.platform === "win32" ? "pwsh.exe" : "bash");
    const shellArgs = args ?? [];
    const hostPath = resolveNativeHostPath(rootCwd);
    const hostBinaryPresent = Bun.file(hostPath).size > 0;

    if (!hostBinaryPresent) {
      if (!hasWarnedMissingNativeHost) {
        hasWarnedMissingNativeHost = true;
        console.warn(`[terminal:${this.id}] native PTY host missing at ${hostPath}; build it with bun run native:build:host.`);
      }
      throw new Error(`ghostty-pty-host missing at ${hostPath}`);
    }

    const startupPayload = JSON.stringify({
      command: shell,
      args: shellArgs,
      cwd: launchCwd,
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
    });

    this.hostHandle = Bun.spawn([hostPath, startupPayload], {
      cwd: rootCwd,
      env: {
        ...process.env,
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    void this.hostHandle.exited.then((code) => {
      this.emitExit(typeof code === "number" ? code : 0);
    });
  }

  onData(cb: (frame: TerminalFrame) => void): void {
    this.frameHandler = cb;
    const handleHostLine = (line: string) => {
      if (!line.trim()) return;
      let message:
        | {
            type: string;
            data?: string;
            code?: number;
            cwd?: string;
            busy?: boolean;
            at_ms?: number;
            vt_b64?: string;
            plain_b64?: string;
            cols?: number;
            rows?: number;
            alt_screen?: boolean;
            cursor_visible?: boolean;
            cursor_style?: "block" | "underline" | "bar";
            cursor_blink?: boolean;
            cursor_row?: number;
            cursor_col?: number;
            patch_kind?: "cursor-only" | "row-update" | "alt-row-update";
            mouse_tracking_mode?: "none" | "x10" | "normal" | "button" | "any";
            mouse_format?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
            focus_event?: boolean;
            mouse_alternate_scroll?: boolean;
            mode?: "full" | "patch";
          }
        | null = null;
      try {
        message = JSON.parse(line) as {
          type: string;
          data?: string;
          code?: number;
          cwd?: string;
          busy?: boolean;
          at_ms?: number;
          vt_b64?: string;
          plain_b64?: string;
          cols?: number;
          rows?: number;
          alt_screen?: boolean;
          cursor_visible?: boolean;
          cursor_style?: "block" | "underline" | "bar";
          cursor_blink?: boolean;
          cursor_row?: number;
          cursor_col?: number;
          patch_kind?: "cursor-only" | "row-update" | "alt-row-update";
          mouse_tracking_mode?: "none" | "x10" | "normal" | "button" | "any";
          mouse_format?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
          focus_event?: boolean;
          mouse_alternate_scroll?: boolean;
          mode?: "full" | "patch";
        };
      } catch {
        return;
      }
      if (message.type === "data" && typeof message.data === "string") {
        const decoded = Buffer.from(message.data, "base64").toString("utf8");
        this.vtBuffer += decoded;
        if (this.vtBuffer.length > MAX_VT_CHARS) {
          this.vtBuffer = this.vtBuffer.slice(-MAX_VT_CHARS);
        }
        return;
      }
      if (message.type === "exit") {
        this.emitExit(typeof message.code === "number" ? message.code : 0);
        return;
      }
      if (message.type === "cwd") {
        if (typeof message.cwd === "string" && message.cwd.length > 0) {
          this.cwd = message.cwd;
        }
        for (const resolve of this.pendingCwdResolvers) resolve(this.cwd);
        this.pendingCwdResolvers.clear();
        return;
      }
      if (message.type === "busy") {
        const nextBusy = message.busy === true;
        const nextBusyAtMs = typeof message.at_ms === "number" ? message.at_ms : Date.now();
        if (nextBusy === this.shellBusy && nextBusyAtMs === this.shellBusyAtMs) return;
        this.shellBusy = nextBusy;
        this.shellBusyAtMs = nextBusyAtMs;
        cb(this.snapshot("", undefined, this.lastPreviewLines, this.lastAltScreen));
        return;
      }
      if (message.type !== "frame" || !this.frameHandler) return;
      this.lastAltScreen = message.alt_screen === true;
      const renderedVt = Buffer.from(message.vt_b64 || "", "base64").toString("utf8");
      const previewLines =
        message.mode === "patch" && message.patch_kind === "cursor-only"
          ? this.lastPreviewLines
          : Buffer.from(message.plain_b64 || "", "base64")
              .toString("utf8")
              .split(/\r?\n/)
              .slice(-MAX_PREVIEW_LINES)
              .map((entry) => entry.slice(0, 512));
      this.lastPreviewLines = previewLines;
      this.cols = Math.max(2, Math.trunc(message.cols ?? this.cols));
      this.rows = Math.max(2, Math.trunc(message.rows ?? this.rows));
      this.frameHandler(
        this.snapshot(
          "",
          message.mode !== "patch" ? renderedVt : undefined,
          previewLines,
          this.lastAltScreen,
          message.mode === "patch" ? renderedVt : undefined,
          message.patch_kind,
          message.cursor_visible,
          message.cursor_style,
          message.cursor_blink,
          message.cursor_row,
          message.cursor_col,
          message.mouse_tracking_mode,
          message.mouse_format,
          message.focus_event,
          message.mouse_alternate_scroll,
        ),
      );
    };

    const pumpStdout = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const decoded = decoder.decode(value, { stream: true });
          this.stdoutLineBuffer += decoded;
          if (this.stdoutLineBuffer.length > MAX_HOST_LINE_CHARS) {
            this.stdoutLineBuffer = this.stdoutLineBuffer.slice(-MAX_HOST_LINE_CHARS);
          }
          let newlineIndex = this.stdoutLineBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = this.stdoutLineBuffer.slice(0, newlineIndex);
            this.stdoutLineBuffer = this.stdoutLineBuffer.slice(newlineIndex + 1);
            handleHostLine(line);
            newlineIndex = this.stdoutLineBuffer.indexOf("\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const pumpStderr = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          const decoded = decoder.decode(value, { stream: true });
          if (decoded.trim()) {
            console.error(`[terminal:${this.id}:native-host] ${decoded.trim()}`);
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const hostOut = this.hostHandle.stdout;
    const hostErr = this.hostHandle.stderr;
    void pumpStdout(typeof hostOut === "number" ? null : hostOut);
    void pumpStderr(typeof hostErr === "number" ? null : hostErr);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitHandler = cb;
  }

  input(data: string, encoding: "utf8" | "binary" = "utf8"): void {
    const last = this.pendingWorkerInput[this.pendingWorkerInput.length - 1];
    if (last?.encoding === encoding) {
      last.data += data;
    } else {
      this.pendingWorkerInput.push({ data, encoding });
    }
    if (this.workerInputTimer) return;
    this.workerInputTimer = setTimeout(() => {
      this.workerInputTimer = null;
      this.flushPendingWorkerInput();
    }, WORKER_INPUT_BATCH_MS);
  }

  setFlowPaused(paused: boolean): void {
    if (paused === this.flowPaused) return;
    this.flowPaused = paused;
    this.flushPendingWorkerInput();
    this.sendHost({ type: "flow", paused });
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(cols, 2);
    this.rows = Math.max(rows, 2);
    this.flushPendingWorkerInput();
    this.sendHost({
      type: "resize",
      cols: this.cols,
      rows: this.rows,
    });
  }

  getCwd(): Promise<string | undefined> {
    if (this.hasExited) return Promise.resolve(this.cwd);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (nextCwd?: string) => {
        if (settled) return;
        settled = true;
        this.pendingCwdResolvers.delete(finish);
        resolve(nextCwd ?? this.cwd);
      };
      this.pendingCwdResolvers.add(finish);
      this.flushPendingWorkerInput();
      this.sendHost({ type: "cwd" });
      setTimeout(() => finish(this.cwd), 250);
    });
  }

  kill(): void {
    this.flushPendingWorkerInput();
    this.sendHost({ type: "kill" });
    this.hostHandle.kill();
  }

  snapshot(
    chunk = "",
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
      renderVt,
      renderPatchVt,
      renderPatchKind,
      altScreen,
      chunk,
      // UI heuristics only inspect the recent VT tail, so don't ship the whole buffer.
      vt: this.vtBuffer.slice(-MAX_ACTIVITY_VT_CHARS),
      previewLines: previewLines ?? toPreviewLines(this.vtBuffer, this.cols, this.rows),
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

  private sendHost(message: object): void {
    const stdin = this.hostHandle.stdin;
    if (typeof stdin === "number" || !stdin) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private flushPendingWorkerInput(): void {
    if (this.workerInputTimer) {
      clearTimeout(this.workerInputTimer);
      this.workerInputTimer = null;
    }
    if (this.pendingWorkerInput.length === 0) return;
    const pending = this.pendingWorkerInput;
    this.pendingWorkerInput = [];
    for (const chunk of pending) {
      this.sendHost({
        type: "input",
        data: Buffer.from(chunk.data, chunk.encoding).toString("base64"),
        encoding: chunk.encoding,
      });
    }
  }

  private emitExit(exitCode: number): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.flushPendingWorkerInput();
    for (const resolve of this.pendingCwdResolvers) resolve(this.cwd);
    this.pendingCwdResolvers.clear();
    this.exitHandler?.(exitCode);
  }
}

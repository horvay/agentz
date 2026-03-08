import { dirname, join } from "node:path";
import { ptyToText } from "ghostty-opentui";

import type { TerminalFrame } from "../shared/protocol";

const MAX_VT_CHARS = 250_000;
const MAX_ACTIVITY_VT_CHARS = 4_000;
const MAX_PREVIEW_LINES = 200;
const MAX_BRIDGE_LINE_CHARS = 12_000_000;
const BRIDGE_FEED_BATCH_MS = 8;
let hasWarnedMissingBridge = false;

function resolvePackagedPtyRoot(): string | null {
  const execDir = dirname(process.execPath);
  const packaged = join(execDir, "..", "Resources", "app", "bun", "node-pty");
  return Bun.file(join(packaged, "lib", "index.js")).size > 0 ? packaged : null;
}

const PTY_WORKER_SOURCE = `
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");
const childProcess = require("node:child_process");

function loadPty() {
  const packagedRoot = process.env.GHOSTTY_PTY_ROOT;
  if (packagedRoot) {
    return require(path.join(packagedRoot, "lib", "index.js"));
  }
  return require("node-pty");
}

const pty = loadPty();

function writeMessage(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

const args = process.argv.slice(1);
const shell = args[0] || process.env.SHELL || "bash";
const shellArgsJson = args[1] || "[]";
const launchCwd = args[2] || process.cwd();
const cols = Number.parseInt(args[3] || "120", 10);
const rows = Number.parseInt(args[4] || "36", 10);
let lastKnownCwd = launchCwd;
let lastPublishedCwd = launchCwd;
let lastBusyState = false;

let shellArgs = [];
try {
  shellArgs = JSON.parse(shellArgsJson);
  if (!Array.isArray(shellArgs)) shellArgs = [];
} catch {
  shellArgs = [];
}

const term = pty.spawn(shell, shellArgs, {
  name: "xterm-256color",
  cols: Math.max(2, cols),
  rows: Math.max(2, rows),
  cwd: launchCwd,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
  },
});

function resolveTermCwd() {
  try {
    if (process.platform === "linux" && Number.isFinite(term.pid)) {
      const liveCwd = fs.realpathSync(\`/proc/\${term.pid}/cwd\`);
      if (typeof liveCwd === "string" && liveCwd.length > 0) {
        lastKnownCwd = liveCwd;
      }
    }
  } catch {}
  return lastKnownCwd;
}

function publishCwd(force = false) {
  const nextCwd = resolveTermCwd();
  if (!force && nextCwd === lastPublishedCwd) return;
  lastPublishedCwd = nextCwd;
  writeMessage({ type: "cwd", cwd: nextCwd });
}

function listChildPids() {
  try {
    if (process.platform === "linux" && Number.isFinite(term.pid)) {
      const raw = fs.readFileSync(\`/proc/\${term.pid}/task/\${term.pid}/children\`, "utf8");
      return raw
        .trim()
        .split(/\\s+/)
        .map((entry) => Number.parseInt(entry, 10))
        .filter((pid) => Number.isFinite(pid) && pid > 0);
    }
  } catch {}

  try {
    const result = childProcess.spawnSync("pgrep", ["-P", String(term.pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return [];
    return String(result.stdout || "")
      .trim()
      .split(/\\s+/)
      .map((entry) => Number.parseInt(entry, 10))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  } catch {
    return [];
  }
}

function resolveBusyState() {
  return listChildPids().length > 0;
}

function publishBusyState(force = false) {
  const nextBusy = resolveBusyState();
  if (!force && nextBusy === lastBusyState) return;
  lastBusyState = nextBusy;
  writeMessage({ type: "busy", busy: nextBusy });
}

term.onData((chunk) => {
  const payload = Buffer.from(chunk, "utf8").toString("base64");
  writeMessage({ type: "data", data: payload });
  publishCwd(false);
});

term.onExit(({ exitCode }) => {
  writeMessage({ type: "exit", code: exitCode });
  process.exit(0);
});

publishBusyState(true);
publishCwd(true);
const busyPoll = setInterval(() => publishBusyState(false), 700);
if (typeof busyPoll.unref === "function") busyPoll.unref();

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "input" && typeof message.data === "string") {
    const encoding = message.encoding === "binary" ? "binary" : "utf8";
    const input = Buffer.from(message.data, "base64");
    term.write(encoding === "binary" ? input : input.toString("utf8"));
    setTimeout(() => publishBusyState(false), 50);
    setTimeout(() => publishBusyState(false), 250);
    return;
  }
  if (
    message.type === "resize" &&
    Number.isFinite(message.cols) &&
    Number.isFinite(message.rows)
  ) {
    term.resize(Math.max(2, Math.trunc(message.cols)), Math.max(2, Math.trunc(message.rows)));
    return;
  }
  if (message.type === "kill") {
    term.kill();
    return;
  }
  if (message.type === "cwd") {
    publishCwd(true);
  }
  if (message.type === "busy") {
    publishBusyState(true);
  }
});
`;

function resolveBridgePath(rootCwd: string): string {
  const direct = `${rootCwd}/src/native/zig-out/bin/ghostty-vt-bridge`;
  if (Bun.file(direct).size > 0) return direct;

  const execDir = dirname(process.execPath);
  const packaged = join(execDir, "..", "Resources", "app", "bin", "ghostty-vt-bridge");
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
  private readonly processHandle: Bun.Subprocess;
  private readonly ghosttyBridgeHandle: Bun.Subprocess | null;
  private vtBuffer = "";
  private seq = 0;
  private cols: number;
  private rows: number;
  private cwd: string;
  private shellBusy = false;
  private lastPreviewLines: string[] = [];
  private pendingBridgeChunk = "";
  private pendingBridgeFeed = "";
  private bridgeFeedTimer: ReturnType<typeof setTimeout> | null = null;
  private bridgeFeedInFlight = false;
  private exitHandler: ((exitCode: number) => void) | null = null;
  private frameHandler: ((frame: TerminalFrame) => void) | null = null;
  private stdoutLineBuffer = "";
  private bridgeLineBuffer = "";
  private hasExited = false;
  private lastAltScreen = false;
  private pendingCwdResolvers = new Set<(cwd?: string) => void>();

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
    const bridgePath = resolveBridgePath(rootCwd);
    const packagedPtyRoot = resolvePackagedPtyRoot();
    const bridgeDisabled = process.env.GHOSTTY_DASHBOARD_DISABLE_BRIDGE === "1";
    const bridgeBinaryPresent = Bun.file(bridgePath).size > 0;

    if (!bridgeDisabled && bridgeBinaryPresent) {
      this.ghosttyBridgeHandle = Bun.spawn(
        [bridgePath, String(cols), String(rows)],
        {
          cwd: rootCwd,
          env: {
            ...process.env,
          },
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      this.sendBridge({ type: "snapshot" });
    } else {
      this.ghosttyBridgeHandle = null;
      if (!bridgeDisabled && !bridgeBinaryPresent && !hasWarnedMissingBridge) {
        hasWarnedMissingBridge = true;
        console.warn(
          `[terminal:${this.id}] ghostty bridge missing at ${bridgePath}; running stream mode (no native bridge build needed).`,
        );
      }
    }

    this.processHandle = Bun.spawn(
      [
        "node",
        "-e",
        PTY_WORKER_SOURCE,
        "--",
        shell,
        JSON.stringify(shellArgs),
        launchCwd,
        String(cols),
        String(rows),
      ],
      {
        cwd: rootCwd,
        env: {
          ...process.env,
          ...(packagedPtyRoot ? { GHOSTTY_PTY_ROOT: packagedPtyRoot } : {}),
        },
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    );

    void this.processHandle.exited.then((code) => {
      this.emitExit(code);
    });
  }

  onData(cb: (frame: TerminalFrame) => void): void {
    this.frameHandler = cb;
    const handleWorkerLine = (line: string) => {
      if (!line.trim()) return;
      let message:
        | { type: string; data?: string; code?: number; cwd?: string; busy?: boolean }
        | null = null;
      try {
        message = JSON.parse(line) as {
          type: string;
          data?: string;
          code?: number;
          cwd?: string;
          busy?: boolean;
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
        if (this.ghosttyBridgeHandle) {
          if (this.lastAltScreen) {
            this.pendingBridgeChunk += decoded;
          } else {
            cb(this.snapshot(decoded, undefined, undefined, false));
          }
          this.pendingBridgeFeed += decoded;
          this.scheduleBridgeFeedFlush();
        } else {
          cb(this.snapshot(decoded));
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
        if (nextBusy === this.shellBusy) return;
        this.shellBusy = nextBusy;
        cb(this.snapshot(""));
      }
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
          let newlineIndex = this.stdoutLineBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = this.stdoutLineBuffer.slice(0, newlineIndex);
            this.stdoutLineBuffer = this.stdoutLineBuffer.slice(newlineIndex + 1);
            handleWorkerLine(line);
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
            console.error(`[terminal:${this.id}:pty-worker] ${decoded.trim()}`);
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const handleBridgeLine = (line: string) => {
      if (!line.trim()) return;
      let message:
        | {
            type: "frame";
            vt_b64: string;
            plain_b64: string;
            cols: number;
            rows: number;
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
          type: "frame";
          vt_b64: string;
          plain_b64: string;
          cols: number;
          rows: number;
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
      if (message.type !== "frame" || !this.frameHandler) return;
      this.bridgeFeedInFlight = false;
      this.lastAltScreen = message.alt_screen === true;
      const renderedVt = Buffer.from(message.vt_b64, "base64").toString("utf8");
      const previewLines =
        message.mode === "patch" && message.patch_kind === "cursor-only"
          ? this.lastPreviewLines
          : Buffer.from(message.plain_b64, "base64")
              .toString("utf8")
              .split(/\r?\n/)
              .slice(-MAX_PREVIEW_LINES)
              .map((entry) => entry.slice(0, 512));
      this.lastPreviewLines = previewLines;
      this.cols = Math.max(2, Math.trunc(message.cols));
      this.rows = Math.max(2, Math.trunc(message.rows));
      this.frameHandler(
        this.snapshot(
          this.lastAltScreen ? this.pendingBridgeChunk : "",
          this.lastAltScreen && message.mode !== "patch" ? renderedVt : undefined,
          previewLines,
          this.lastAltScreen,
          this.lastAltScreen && message.mode === "patch" ? renderedVt : undefined,
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
      this.pendingBridgeChunk = "";
      if (this.pendingBridgeFeed.length > 0) {
        this.scheduleBridgeFeedFlush();
      }
    };

    const pumpBridgeStdout = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          this.bridgeLineBuffer += decoder.decode(value, { stream: true });
          if (this.bridgeLineBuffer.length > MAX_BRIDGE_LINE_CHARS) {
            this.bridgeLineBuffer = this.bridgeLineBuffer.slice(-MAX_BRIDGE_LINE_CHARS);
          }
          let newlineIndex = this.bridgeLineBuffer.indexOf("\n");
          while (newlineIndex >= 0) {
            const line = this.bridgeLineBuffer.slice(0, newlineIndex);
            this.bridgeLineBuffer = this.bridgeLineBuffer.slice(newlineIndex + 1);
            handleBridgeLine(line);
            newlineIndex = this.bridgeLineBuffer.indexOf("\n");
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    const pumpBridgeStderr = async (stream: ReadableStream<Uint8Array> | null | undefined) => {
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
            console.error(`[terminal:${this.id}:ghostty-bridge] ${decoded.trim()}`);
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    if (this.ghosttyBridgeHandle) {
      const bridgeOut = this.ghosttyBridgeHandle.stdout;
      const bridgeErr = this.ghosttyBridgeHandle.stderr;
      void pumpBridgeStdout(typeof bridgeOut === "number" ? null : bridgeOut);
      void pumpBridgeStderr(typeof bridgeErr === "number" ? null : bridgeErr);
    }
    const workerOut = this.processHandle.stdout;
    const workerErr = this.processHandle.stderr;
    void pumpStdout(typeof workerOut === "number" ? null : workerOut);
    void pumpStderr(typeof workerErr === "number" ? null : workerErr);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitHandler = cb;
  }

  input(data: string, encoding: "utf8" | "binary" = "utf8"): void {
    this.sendWorker({
      type: "input",
      data: Buffer.from(data, encoding).toString("base64"),
      encoding,
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(cols, 2);
    this.rows = Math.max(rows, 2);
    this.flushPendingBridgeFeed();
    this.sendWorker({
      type: "resize",
      cols: this.cols,
      rows: this.rows,
    });
    this.sendBridge({
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
      this.sendWorker({ type: "cwd" });
      setTimeout(() => finish(this.cwd), 250);
    });
  }

  kill(): void {
    this.flushPendingBridgeFeed();
    this.sendWorker({ type: "kill" });
    this.sendBridge({ type: "kill" });
    this.ghosttyBridgeHandle?.kill();
    this.processHandle.kill();
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
    };
  }

  private sendWorker(message: object): void {
    const stdin = this.processHandle.stdin;
    if (typeof stdin === "number" || !stdin) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sendBridge(message: object): void {
    if (!this.ghosttyBridgeHandle) return;
    const stdin = this.ghosttyBridgeHandle.stdin;
    if (typeof stdin === "number" || !stdin) return;
    stdin.write(`${JSON.stringify(message)}\n`);
  }

  private scheduleBridgeFeedFlush(): void {
    if (!this.ghosttyBridgeHandle) return;
    if (this.bridgeFeedTimer) return;
    this.bridgeFeedTimer = setTimeout(() => {
      this.bridgeFeedTimer = null;
      this.flushPendingBridgeFeed();
    }, BRIDGE_FEED_BATCH_MS);
  }

  private flushPendingBridgeFeed(): void {
    if (this.bridgeFeedTimer) {
      clearTimeout(this.bridgeFeedTimer);
      this.bridgeFeedTimer = null;
    }
    if (this.bridgeFeedInFlight) return;
    if (!this.ghosttyBridgeHandle || this.pendingBridgeFeed.length === 0) return;
    const payload = this.pendingBridgeFeed;
    this.pendingBridgeFeed = "";
    this.bridgeFeedInFlight = true;
    this.sendBridge({
      type: "feed",
      data_b64: Buffer.from(payload, "utf8").toString("base64"),
    });
  }

  private emitExit(exitCode: number): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.flushPendingBridgeFeed();
    for (const resolve of this.pendingCwdResolvers) resolve(this.cwd);
    this.pendingCwdResolvers.clear();
    this.exitHandler?.(exitCode);
  }
}

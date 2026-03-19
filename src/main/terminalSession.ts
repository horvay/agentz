import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";

import type { TerminalFrame, TerminalScreenRow } from "../shared/protocol";

const MAX_ACTIVITY_TEXT_CHARS = 4_000;
const MAX_PREVIEW_LINES = 200;
const MAX_HOST_PACKET_BYTES = 16 * 1024 * 1024;
const WORKER_INPUT_BATCH_MS = 8;
const DEFAULT_UNIX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const HOST_PACKET_FRAME = 1;
const HOST_PACKET_EXIT = 2;
const HOST_PACKET_CWD = 3;
const HOST_PACKET_BUSY = 4;
const utf8Decoder = new TextDecoder();
let hasWarnedMissingNativeHost = false;

function isIgnorableHostWriteError(error: unknown): boolean {
  const code = String((error as { code?: string } | null | undefined)?.code ?? "").toUpperCase();
  const message = error instanceof Error ? error.message.toUpperCase() : String(error ?? "").toUpperCase();
  return (
    code.includes("EPIPE") ||
    code.includes("ERR_STREAM_DESTROYED") ||
    code.includes("ERR_SOCKET_CLOSED") ||
    message.includes("EPIPE") ||
    message.includes("ERR_STREAM_DESTROYED") ||
    message.includes("ERR_SOCKET_CLOSED")
  );
}

function getNativeHostBasename(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "agentz-pty-host.exe" : "agentz-pty-host";
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "").trim();
}

function getEnvValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (typeof direct === "string") return direct;
  const match = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
  if (!match) return undefined;
  const value = env[match];
  return typeof value === "string" ? value : undefined;
}

function isWindowsAbsoluteExecutable(path: string): boolean {
  if (!path) return false;
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveWindowsCommandOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const trimmed = stripWrappingQuotes(command);
  if (!trimmed) return null;

  if (isAbsolute(trimmed)) {
    return isWindowsAbsoluteExecutable(trimmed) ? trimmed : null;
  }

  const pathValue = getEnvValue(env, "PATH");
  if (!pathValue) return null;

  const pathextValue = getEnvValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  const pathext = pathextValue
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hasExtension = /\.[^\\/]+$/.test(trimmed);
  const candidates = hasExtension ? [trimmed] : [trimmed, ...pathext.map((ext) => `${trimmed}${ext.toLowerCase()}`)];

  for (const rawDir of pathValue.split(delimiter)) {
    const dir = stripWrappingQuotes(rawDir);
    if (!dir) continue;
    for (const candidate of candidates) {
      const fullPath = join(dir, candidate);
      if (isWindowsAbsoluteExecutable(fullPath)) return fullPath;
    }
  }

  return null;
}

function resolveWindowsPowerShellCommand(env: NodeJS.ProcessEnv = process.env): string {
  const pathResolvedPwsh = resolveWindowsCommandOnPath("pwsh.exe", env);
  if (pathResolvedPwsh) return pathResolvedPwsh;

  const programFiles = getEnvValue(env, "ProgramFiles");
  if (programFiles) {
    const powerShell7 = join(programFiles, "PowerShell", "7", "pwsh.exe");
    if (isWindowsAbsoluteExecutable(powerShell7)) return powerShell7;
  }

  const pathResolvedWindowsPowerShell = resolveWindowsCommandOnPath("powershell.exe", env);
  if (pathResolvedWindowsPowerShell) return pathResolvedWindowsPowerShell;

  const windowsDir = getEnvValue(env, "WINDIR") ?? "C:\\Windows";
  const builtInWindowsPowerShell = join(windowsDir, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (isWindowsAbsoluteExecutable(builtInWindowsPowerShell)) return builtInWindowsPowerShell;

  return "powershell.exe";
}

function resolveWindowsLaunchCommand(
  resolvedCommand: string,
  args: string[],
  explicitCommand: boolean,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  if (!explicitCommand) {
    return { command: resolvedCommand, args };
  }

  const commandLine = ["&", quotePowerShellArg(resolvedCommand), ...args.map(quotePowerShellArg)].join(" ");
  return {
    command: resolveWindowsPowerShellCommand(env),
    args: ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", commandLine],
  };
}

function resolveNativeHostPath(rootCwd: string): string {
  const hostBasename = getNativeHostBasename();
  const direct = join(rootCwd, "src", "native", "zig-out", "bin", hostBasename);
  if (existsSync(direct)) return direct;

  const electronResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (electronResourcesPath) {
    const packaged = join(electronResourcesPath, "bin", hostBasename);
    if (existsSync(packaged)) return packaged;
  }

  const execDir = dirname(process.execPath);
  const packaged = join(execDir, "..", "Resources", "app", "bin", hostBasename);
  if (existsSync(packaged)) return packaged;

  return direct;
}

function isExecutablePath(path: string): boolean {
  if (!path) return false;
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveTerminalCommand(
  command?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (command) return command;

  if (platform === "win32") {
    return resolveWindowsPowerShellCommand(env);
  }

  const shell = env.SHELL?.trim();
  if (shell && (!isAbsolute(shell) || isExecutablePath(shell))) {
    return shell;
  }

  for (const candidate of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/sh", "/usr/bin/sh"]) {
    if (isExecutablePath(candidate)) return candidate;
  }

  return "sh";
}

export function buildTerminalHostEnv(
  resolvedCommand: string,
  command?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };

  if (!nextEnv.TERM || nextEnv.TERM.trim().length === 0) {
    nextEnv.TERM = "xterm-256color";
  }
  if (!nextEnv.COLORTERM || nextEnv.COLORTERM.trim().length === 0) {
    nextEnv.COLORTERM = "truecolor";
  }

  if (platform !== "win32" && (!nextEnv.PATH || nextEnv.PATH.trim().length === 0)) {
    nextEnv.PATH = DEFAULT_UNIX_PATH;
  }

  if (!command) {
    const shell = nextEnv.SHELL?.trim();
    if (!shell || (isAbsolute(shell) && !isExecutablePath(shell))) {
      nextEnv.SHELL = resolvedCommand;
    }
  }

  return nextEnv;
}
function trimActivityText(text: string): string {
  return text.length > MAX_ACTIVITY_TEXT_CHARS ? text.slice(-MAX_ACTIVITY_TEXT_CHARS) : text;
}

interface HostFrameMessage {
  type: "frame";
  mode: "full" | "patch";
  vt: string;
  vtBytes?: Uint8Array;
  plain: string;
  screenRows: TerminalScreenRow[];
  cols: number;
  rows: number;
  altScreen: boolean;
  cursorVisible: boolean;
  cursorStyle: "block" | "underline" | "bar";
  cursorBlink: boolean;
  cursorRow: number;
  cursorCol: number;
  patchKind?: "cursor-only" | "row-update" | "alt-row-update";
  mouseTrackingMode: "none" | "x10" | "normal" | "button" | "any";
  mouseFormat: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
  focusEvent: boolean;
  mouseAlternateScroll: boolean;
}

type HostPacket =
  | HostFrameMessage
  | { type: "exit"; code: number }
  | { type: "cwd"; cwd?: string }
  | { type: "busy"; busy: boolean; atMs: number };

function appendBytes(
  existing: Uint8Array<ArrayBufferLike>,
  next: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (existing.byteLength === 0) return next;
  const combined = new Uint8Array(existing.byteLength + next.byteLength);
  combined.set(existing);
  combined.set(next, existing.byteLength);
  return combined;
}

function decodeCursorStyle(value: number): "block" | "underline" | "bar" {
  if (value === 1) return "underline";
  if (value === 2) return "bar";
  return "block";
}

function decodePatchKind(value: number): HostFrameMessage["patchKind"] {
  if (value === 1) return "cursor-only";
  if (value === 2) return "row-update";
  if (value === 3) return "alt-row-update";
  return undefined;
}

function decodeMouseTrackingMode(value: number): HostFrameMessage["mouseTrackingMode"] {
  if (value === 1) return "x10";
  if (value === 2) return "normal";
  if (value === 3) return "button";
  if (value === 4) return "any";
  return "none";
}

function decodeMouseFormat(value: number): HostFrameMessage["mouseFormat"] {
  if (value === 1) return "utf8";
  if (value === 2) return "sgr";
  if (value === 3) return "urxvt";
  if (value === 4) return "sgr-pixels";
  return "x10";
}

function decodeUtf8(bytes: Uint8Array<ArrayBufferLike>): string {
  return utf8Decoder.decode(bytes);
}

function decodeHostPacket(kind: number, payload: Uint8Array<ArrayBufferLike>): HostPacket | null {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

  if (kind === HOST_PACKET_FRAME) {
    if (payload.byteLength < 22) return null;
    const mode = payload[0] === 0 ? "full" : "patch";
    const flags = payload[1] ?? 0;
    const cursorStyle = decodeCursorStyle(payload[2] ?? 0);
    const patchKind = decodePatchKind(payload[3] ?? 0);
    const mouseTrackingMode = decodeMouseTrackingMode(payload[4] ?? 0);
    const mouseFormat = decodeMouseFormat(payload[5] ?? 0);
    const cols = view.getUint16(6, true);
    const rows = view.getUint16(8, true);
    const cursorRow = view.getUint16(10, true);
    const cursorCol = view.getUint16(12, true);
    const vtLength = view.getUint32(14, true);
    const plainLength = view.getUint32(18, true);
    const vtStart = 22;
    const plainStart = vtStart + vtLength;
    const plainEnd = plainStart + plainLength;
    if (plainEnd > payload.byteLength) return null;
    const vtBytes = mode === "patch" ? payload.slice(vtStart, plainStart) : undefined;
    let offset = plainEnd;
    const screenRows: TerminalScreenRow[] = [];
    if (payload.byteLength - offset >= 2) {
      const rowCount = view.getUint16(offset, true);
      offset += 2;
      for (let index = 0; index < rowCount; index += 1) {
        if (payload.byteLength - offset < 6) return null;
        const rowIndex = view.getUint16(offset, true);
        offset += 2;
        const rowLength = view.getUint32(offset, true);
        offset += 4;
        const rowEnd = offset + rowLength;
        if (rowEnd > payload.byteLength) return null;
        screenRows.push({ index: rowIndex, text: decodeUtf8(payload.subarray(offset, rowEnd)) });
        offset = rowEnd;
      }
    }
    return {
      type: "frame",
      mode,
      vt: decodeUtf8(payload.subarray(vtStart, plainStart)),
      vtBytes,
      plain: decodeUtf8(payload.subarray(plainStart, plainEnd)),
      screenRows,
      cols,
      rows,
      altScreen: (flags & 1) !== 0,
      cursorVisible: (flags & 2) !== 0,
      cursorBlink: (flags & 4) !== 0,
      focusEvent: (flags & 8) !== 0,
      mouseAlternateScroll: (flags & 16) !== 0,
      cursorStyle,
      cursorRow,
      cursorCol,
      patchKind,
      mouseTrackingMode,
      mouseFormat,
    };
  }

  if (kind === HOST_PACKET_EXIT) {
    if (payload.byteLength < 4) return null;
    return { type: "exit", code: view.getInt32(0, true) };
  }

  if (kind === HOST_PACKET_CWD) {
    if (payload.byteLength < 4) return null;
    const cwdLength = view.getUint32(0, true);
    if (cwdLength + 4 > payload.byteLength) return null;
    return {
      type: "cwd",
      cwd: cwdLength > 0 ? decodeUtf8(payload.subarray(4, 4 + cwdLength)) : undefined,
    };
  }

  if (kind === HOST_PACKET_BUSY) {
    if (payload.byteLength < 9) return null;
    return {
      type: "busy",
      busy: payload[0] === 1,
      atMs: Number(view.getBigInt64(1, true)),
    };
  }

  return null;
}

function previewLinesFromPlain(plain: string): string[] {
  return plain
    .split(/\r?\n/)
    .slice(-MAX_PREVIEW_LINES)
    .map((entry) => entry.slice(0, 512));
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

class NativeTerminalSessionBackend implements TerminalSessionBackend {
  private readonly hostHandle: ChildProcessWithoutNullStreams;
  private seq = 0;
  private cols: number;
  private rows: number;
  private cwd: string;
  private shellBusy = false;
  private shellBusyAtMs = 0;
  private lastPreviewLines: string[] = [];
  private exitHandler: ((exitCode: number) => void) | null = null;
  private frameHandler: ((frame: TerminalFrame) => void) | null = null;
  private stdoutPacketBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  private hasExited = false;
  private lastAltScreen = false;
  private lastChunk = "";
  private lastActivityText = "";
  private pendingCwdResolvers = new Set<(cwd?: string) => void>();
  private flowPaused = false;
  private frameIntervalMs = 0;
  private previewOnly = false;
  private pendingWorkerInput: { data: string; encoding: "utf8" | "binary" }[] = [];
  private workerInputTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly id: string,
    cols: number,
    rows: number,
    rootCwd: string,
    launchCwd: string,
    shell: string,
    shellArgs: string[],
    hostEnv: NodeJS.ProcessEnv,
  ) {
    this.cols = cols;
    this.rows = rows;
    this.cwd = launchCwd;
    const hostPath = resolveNativeHostPath(rootCwd);
    const hostBinaryPresent = existsSync(hostPath);

      if (!hostBinaryPresent) {
      if (!hasWarnedMissingNativeHost) {
        hasWarnedMissingNativeHost = true;
        console.warn(`[terminal:${this.id}] native PTY host missing at ${hostPath}; build it with bun run native:build:host.`);
      }
      throw new Error(`agentz-pty-host missing at ${hostPath}`);
    }

    const startupPayload = JSON.stringify({
      command: shell,
      args: shellArgs,
      cwd: launchCwd,
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
    });

    this.hostHandle = spawn(hostPath, [startupPayload], {
      cwd: rootCwd,
      env: hostEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.hostHandle.stdin.on("error", (error) => {
      if (!this.hasExited && !isIgnorableHostWriteError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[terminal:${this.id}:native-host-stdin] ${message}`);
      }
    });

    this.hostHandle.on("exit", (code) => {
      this.emitExit(typeof code === "number" ? code : 0);
    });
  }

  onData(cb: (frame: TerminalFrame) => void): void {
    this.frameHandler = cb;
    const handleHostPacket = (message: HostPacket) => {
      if (message.type === "exit") {
        this.emitExit(message.code);
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
        const nextBusyAtMs = Number.isFinite(message.atMs) ? message.atMs : Date.now();
        if (nextBusy === this.shellBusy && nextBusyAtMs === this.shellBusyAtMs) return;
        this.shellBusy = nextBusy;
        this.shellBusyAtMs = nextBusyAtMs;
        cb(this.snapshot("", undefined, undefined, undefined, this.lastPreviewLines, this.lastAltScreen));
        return;
      }
      if (!this.frameHandler) return;
      this.lastAltScreen = message.altScreen === true;
      const renderedVt = message.vt;
      const previewLines =
        message.mode === "patch" && message.patchKind === "cursor-only"
          ? this.lastPreviewLines
          : previewLinesFromPlain(message.plain);
      const previewText = previewLines.join("\n");
      const activityTail = trimActivityText(renderedVt || previewText);
      this.lastPreviewLines = previewLines;
      this.lastChunk = activityTail;
      if (activityTail.length > 0) {
        this.lastActivityText = trimActivityText(
          this.lastActivityText ? `${this.lastActivityText}\n${activityTail}` : activityTail,
        );
      }
      this.cols = Math.max(2, Math.trunc(message.cols ?? this.cols));
      this.rows = Math.max(2, Math.trunc(message.rows ?? this.rows));
      this.frameHandler(
        this.snapshot(
          "",
          message.mode,
          message.screenRows,
          message.mode === "full" ? renderedVt : undefined,
          previewLines,
          this.lastAltScreen,
          message.mode === "patch" ? renderedVt : undefined,
          message.mode === "patch" ? message.vtBytes : undefined,
          message.patchKind,
          message.cursorVisible,
          message.cursorStyle,
          message.cursorBlink,
          message.cursorRow,
          message.cursorCol,
          message.mouseTrackingMode,
          message.mouseFormat,
          message.focusEvent,
          message.mouseAlternateScroll,
        ),
      );
    };

    const pumpStdout = (value: Uint8Array<ArrayBufferLike>) => {
      if (!value.byteLength) return;
      this.stdoutPacketBuffer = appendBytes(this.stdoutPacketBuffer, value);
      let offset = 0;
      while (this.stdoutPacketBuffer.byteLength - offset >= 5) {
        const packetType = this.stdoutPacketBuffer[offset] ?? 0;
        const payloadLength =
          (this.stdoutPacketBuffer[offset + 1] ?? 0) |
          ((this.stdoutPacketBuffer[offset + 2] ?? 0) << 8) |
          ((this.stdoutPacketBuffer[offset + 3] ?? 0) << 16) |
          ((this.stdoutPacketBuffer[offset + 4] ?? 0) << 24);
        if (payloadLength < 0 || payloadLength > MAX_HOST_PACKET_BYTES) {
          throw new Error(`Invalid native host packet length: ${payloadLength}`);
        }
        const packetEnd = offset + 5 + payloadLength;
        if (packetEnd > this.stdoutPacketBuffer.byteLength) break;
        const payload = this.stdoutPacketBuffer.subarray(offset + 5, packetEnd);
        const decoded = decodeHostPacket(packetType, payload);
        if (decoded) {
          handleHostPacket(decoded);
        }
        offset = packetEnd;
      }
      this.stdoutPacketBuffer = this.stdoutPacketBuffer.subarray(offset);
    };

    const stderrDecoder = new TextDecoder();
    const pumpStderr = (value: Uint8Array<ArrayBufferLike>) => {
      if (!value.byteLength) return;
      const decoded = stderrDecoder.decode(value, { stream: true });
      if (decoded.trim()) {
        console.error(`[terminal:${this.id}:native-host] ${decoded.trim()}`);
      }
    };

    this.hostHandle.stdout.on("data", (value: Buffer) => {
      pumpStdout(value);
    });
    this.hostHandle.stderr.on("data", (value: Buffer) => {
      pumpStderr(value);
    });
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

  setFrameInterval(intervalMs: number, previewOnly = false): void {
    const nextIntervalMs = Math.max(0, Math.trunc(intervalMs));
    if (nextIntervalMs === this.frameIntervalMs && previewOnly === this.previewOnly) {
      return;
    }
    this.frameIntervalMs = nextIntervalMs;
    this.previewOnly = previewOnly;
    this.flushPendingWorkerInput();
    this.sendHost({ type: "frame-rate", interval_ms: nextIntervalMs, preview_only: previewOnly });
  }

  requestSnapshot(): void {
    if (this.hasExited) return;
    this.flushPendingWorkerInput();
    this.sendHost({ type: "snapshot" });
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
    screenMode?: "full" | "patch",
    screenRows?: TerminalScreenRow[],
    renderVt?: string,
    previewLines?: string[],
    altScreen?: boolean,
    renderPatchVt?: string,
    renderPatchBytes?: Uint8Array,
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
      screenRows,
      renderVt,
      renderPatchVt,
      renderPatchBytes,
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

  private sendHost(message: object): void {
    const stdin = this.hostHandle.stdin;
    if (this.hasExited || stdin.destroyed || stdin.writableEnded) return;
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      if (!isIgnorableHostWriteError(error)) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`[terminal:${this.id}:native-host-stdin] ${detail}`);
      }
    }
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

export class TerminalSession implements TerminalSessionBackend {
  private readonly backend: TerminalSessionBackend;

  constructor(
    readonly id: string,
    cols: number,
    rows: number,
    command?: string,
    args?: string[],
    cwd?: string,
  ) {
    const launchBaseCwd = process.env.AGENTZ_LAUNCH_CWD || process.cwd();
    const rootCwd = process.env.AGENTZ_ROOT ?? process.cwd();
    const launchCwd = cwd ?? launchBaseCwd;
    const shell = resolveTerminalCommand(command);
    const shellArgs = args ?? [];
    const hostEnv = buildTerminalHostEnv(shell, command);
    const windowsLaunch = resolveWindowsLaunchCommand(shell, shellArgs, Boolean(command), hostEnv);

    this.backend = new NativeTerminalSessionBackend(
      id,
      cols,
      rows,
      rootCwd,
      launchCwd,
      windowsLaunch.command,
      windowsLaunch.args,
      hostEnv,
    );
  }

  onData(cb: (frame: TerminalFrame) => void): void {
    this.backend.onData(cb);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.backend.onExit(cb);
  }

  input(data: string, encoding: "utf8" | "binary" = "utf8"): void {
    this.backend.input(data, encoding);
  }

  setFlowPaused(paused: boolean): void {
    this.backend.setFlowPaused(paused);
  }

  setFrameInterval(intervalMs: number, previewOnly = false): void {
    this.backend.setFrameInterval(intervalMs, previewOnly);
  }

  requestSnapshot(): void {
    this.backend.requestSnapshot();
  }

  resize(cols: number, rows: number): void {
    this.backend.resize(cols, rows);
  }

  getCwd(): Promise<string | undefined> {
    return this.backend.getCwd();
  }

  kill(): void {
    this.backend.kill();
  }
}

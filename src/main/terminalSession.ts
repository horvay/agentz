import { dirname, join } from "node:path";
import { ptyToText } from "ghostty-opentui";

import type { TerminalFrame } from "../shared/protocol";

const MAX_VT_CHARS = 250_000;
const MAX_PREVIEW_LINES = 200;
const MAX_BRIDGE_LINE_CHARS = 12_000_000;
let hasWarnedMissingBridge = false;

function resolvePackagedPtyRoot(): string | null {
  const execDir = dirname(process.execPath);
  const packaged = join(execDir, "..", "Resources", "app", "bun", "node-pty");
  return Bun.file(join(packaged, "lib", "index.js")).size > 0 ? packaged : null;
}

const PTY_WORKER_SOURCE = `
const readline = require("node:readline");
const path = require("node:path");

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

term.onData((chunk) => {
  const payload = Buffer.from(chunk, "utf8").toString("base64");
  writeMessage({ type: "data", data: payload });
});

term.onExit(({ exitCode }) => {
  writeMessage({ type: "exit", code: exitCode });
  process.exit(0);
});

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
    const input = Buffer.from(message.data, "base64").toString("utf8");
    term.write(input);
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
  private exitHandler: ((exitCode: number) => void) | null = null;
  private frameHandler: ((frame: TerminalFrame) => void) | null = null;
  private stdoutLineBuffer = "";
  private bridgeLineBuffer = "";
  private hasExited = false;

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

    const rootCwd = process.env.GHOSTTY_DASHBOARD_ROOT ?? process.cwd();
    const launchCwd = cwd ?? rootCwd;
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
      let message: { type: string; data?: string; code?: number } | null = null;
      try {
        message = JSON.parse(line) as { type: string; data?: string; code?: number };
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
          this.sendBridge({
            type: "feed",
            data_b64: message.data,
          });
        } else {
          cb(this.snapshot(decoded));
        }
        return;
      }
      if (message.type === "exit") {
        this.emitExit(typeof message.code === "number" ? message.code : 0);
      }
    };

    const pumpStdout = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const decoded = decoder.decode(chunk, { stream: true });
        this.stdoutLineBuffer += decoded;
        let newlineIndex = this.stdoutLineBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = this.stdoutLineBuffer.slice(0, newlineIndex);
          this.stdoutLineBuffer = this.stdoutLineBuffer.slice(newlineIndex + 1);
          handleWorkerLine(line);
          newlineIndex = this.stdoutLineBuffer.indexOf("\n");
        }
      }
    };

    const pumpStderr = async (stream: ReadableStream<Uint8Array> | null) => {
      if (!stream) return;
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const decoded = decoder.decode(chunk, { stream: true });
        if (decoded.trim()) {
          console.error(`[terminal:${this.id}:pty-worker] ${decoded.trim()}`);
        }
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
          mode?: "full" | "patch";
        };
      } catch {
        return;
      }
      if (message.type !== "frame" || !this.frameHandler) return;
      const renderedVt = Buffer.from(message.vt_b64, "base64").toString("utf8");
      const plain = Buffer.from(message.plain_b64, "base64").toString("utf8");
      const previewLines = plain
        .split(/\r?\n/)
        .slice(-MAX_PREVIEW_LINES)
        .map((entry) => entry.slice(0, 512));
      this.cols = Math.max(2, Math.trunc(message.cols));
      this.rows = Math.max(2, Math.trunc(message.rows));
      this.frameHandler(
        this.snapshot(
          "",
          message.mode === "patch" ? undefined : renderedVt,
          previewLines,
          message.alt_screen === true,
          message.mode === "patch" ? renderedVt : undefined,
        ),
      );
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
    void pumpStdout(this.processHandle.stdout);
    void pumpStderr(this.processHandle.stderr);
  }

  onExit(cb: (exitCode: number) => void): void {
    this.exitHandler = cb;
  }

  input(data: string): void {
    this.sendWorker({
      type: "input",
      data: Buffer.from(data, "utf8").toString("base64"),
    });
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(cols, 2);
    this.rows = Math.max(rows, 2);
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

  kill(): void {
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
  ): TerminalFrame {
    this.seq += 1;
    return {
      id: this.id,
      cols: this.cols,
      rows: this.rows,
      seq: this.seq,
      renderVt,
      renderPatchVt,
      altScreen,
      chunk,
      vt: this.vtBuffer,
      previewLines: previewLines ?? toPreviewLines(this.vtBuffer, this.cols, this.rows),
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

  private emitExit(exitCode: number): void {
    if (this.hasExited) return;
    this.hasExited = true;
    this.exitHandler?.(exitCode);
  }
}

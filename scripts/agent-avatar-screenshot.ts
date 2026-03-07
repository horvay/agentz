import { dirname } from "node:path";
import type { TerminalFrame } from "../src/shared/protocol";
import type { AvatarVisualState } from "../src/ui/avatarCatalog";
import { detectAvatarState, inspectAvatarState, resolveAvatarDisplayState } from "../src/ui/avatarState";

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const item of argv) {
    if (!item.startsWith("--")) continue;
    const token = item.slice(2);
    if (!token.includes("=")) {
      out[token] = true;
      continue;
    }
    const [k, ...rest] = token.split("=");
    out[k] = rest.join("=");
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runChecked(cmd: string[]): string {
  const proc = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(
      `${cmd.join(" ")} failed (${proc.exitCode}): ${
        proc.stderr.toString().trim() || proc.stdout.toString().trim()
      }`,
    );
  }
  return proc.stdout.toString();
}

function findWindowId(windowName: string): string | null {
  const search = Bun.spawnSync(["xdotool", "search", "--onlyvisible", "--name", windowName], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (search.exitCode !== 0) return null;
  const lines = search.stdout.toString().trim().split("\n").filter(Boolean);
  return lines.at(-1) ?? null;
}

class RpcSession {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private readonly latestFrames = new Map<string, TerminalFrame>();
  private readonly exitedIds = new Map<string, number>();
  private readonly latestDisplayStates = new Map<string, AvatarVisualState>();
  private readonly avatarActivity = new Map<
    string,
    {
      state: AvatarVisualState;
      agent: "opencode" | "codex" | null;
      atMs: number;
      lastFrameAtMs: number;
      lastPreviewText: string;
    }
  >();

  constructor() {
    this.ws = new WebSocket("ws://127.0.0.1:4599");
    this.ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        try {
          this.ws.close();
        } catch {}
        reject(new Error("RPC websocket timeout"));
      }, 6000);

      this.ws.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ws.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("RPC websocket error"));
      });

      this.ws.addEventListener("message", (event) => {
        let message:
          | { type?: string; frame?: TerminalFrame; id?: unknown; exitCode?: unknown }
          | null = null;
        try {
          message = JSON.parse(String(event.data)) as {
            type?: string;
            frame?: TerminalFrame;
            id?: unknown;
            exitCode?: unknown;
          };
        } catch {
          return;
        }
        if (message?.type === "terminal-frame" && typeof message.frame?.id === "string") {
          this.latestFrames.set(message.frame.id, message.frame);
          const nowMs = Date.now();
          const displayState = resolveAvatarDisplayState(
            message.frame,
            this.avatarActivity.get(message.frame.id),
            nowMs,
          );
          this.latestDisplayStates.set(message.frame.id, displayState);
          const nextAgent = inspectAvatarState(message.frame).agent ?? this.avatarActivity.get(message.frame.id)?.agent ?? null;
          const nextPreviewText = (message.frame.previewLines ?? []).join("\n");
          this.avatarActivity.set(
            message.frame.id,
            displayState !== "idle"
              ? {
                  state: displayState,
                  agent: nextAgent,
                  atMs: nowMs,
                  lastFrameAtMs: nowMs,
                  lastPreviewText: nextPreviewText,
                }
              : this.avatarActivity.get(message.frame.id)
                ? {
                    ...this.avatarActivity.get(message.frame.id)!,
                    agent: nextAgent,
                    lastFrameAtMs: nowMs,
                    lastPreviewText: nextPreviewText,
                  }
                : {
                    state: "idle",
                    agent: nextAgent,
                    atMs: nowMs,
                    lastFrameAtMs: nowMs,
                    lastPreviewText: nextPreviewText,
                  },
          );
          return;
        }
        if (message?.type === "terminal-exited" && typeof message.id === "string") {
          this.exitedIds.set(message.id, typeof message.exitCode === "number" ? message.exitCode : 0);
        }
      });
    });
  }

  async listFirstTerminalId(): Promise<string> {
    await this.ready;
    return await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.removeEventListener("message", onMessage);
        reject(new Error("RPC terminal list timeout"));
      }, 6000);

      const onMessage = (event: MessageEvent) => {
        let message: { type?: string; ids?: unknown } | null = null;
        try {
          message = JSON.parse(String(event.data)) as { type?: string; ids?: unknown };
        } catch {
          return;
        }
        if (message.type !== "terminal-list" || !Array.isArray(message.ids)) return;
        const first = message.ids.find((entry): entry is string => typeof entry === "string");
        clearTimeout(timeout);
        this.ws.removeEventListener("message", onMessage);
        if (!first) {
          reject(new Error("No terminals available"));
          return;
        }
        resolve(first);
      };

      this.ws.addEventListener("message", onMessage);
      this.ws.send(JSON.stringify({ type: "list" }));
    });
  }

  async sendInput(id: string, data: string): Promise<void> {
    await this.ready;
    this.ws.send(JSON.stringify({ type: "input", id, data }));
    await sleep(200);
  }

  ensureNotExited(id: string): void {
    if (this.exitedIds.has(id)) {
      throw new Error(`Terminal ${id} exited before screenshot (${this.exitedIds.get(id)})`);
    }
  }

  async waitForAvatarState(
    id: string,
    predicate: (state: AvatarVisualState) => boolean,
    timeoutMs: number,
  ): Promise<AvatarVisualState> {
    await this.ready;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.ensureNotExited(id);
      const state = this.latestDisplayStates.get(id) ?? detectAvatarState(this.latestFrames.get(id));
      if (predicate(state)) return state;
      await sleep(200);
    }
    const finalState = this.latestDisplayStates.get(id) ?? detectAvatarState(this.latestFrames.get(id));
    throw new Error(`Timed out waiting for avatar activity; last state was ${finalState}`);
  }

  async waitForPromptVisible(id: string, promptText: string, timeoutMs: number): Promise<void> {
    await this.ready;
    const target = normalizeText(promptText);
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.ensureNotExited(id);
      const frame = this.latestFrames.get(id);
      const haystack = normalizeText(
        [frame?.previewLines?.join("\n") ?? "", frame?.chunk ?? "", frame?.vt ?? ""].join("\n"),
      );
      if (haystack.includes(target)) return;
      await sleep(200);
    }
    throw new Error(`Timed out waiting for prompt text to appear: ${promptText}`);
  }

  async waitForHiddenWorkingMarker(id: string, minLines: number, timeoutMs: number): Promise<void> {
    await this.ready;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.ensureNotExited(id);
      const frame = this.latestFrames.get(id);
      const displayState = this.latestDisplayStates.get(id) ?? detectAvatarState(frame);
      if (
        displayState === "working" &&
        visibleLineCount(frame) >= minLines &&
        !workingMarkerVisible(frame)
      ) {
        return;
      }
      await sleep(250);
    }
    const frame = this.latestFrames.get(id);
    throw new Error(
      `Timed out waiting for hidden working marker; state=${
        this.latestDisplayStates.get(id) ?? detectAvatarState(frame)
      } lines=${visibleLineCount(frame)} markerVisible=${workingMarkerVisible(frame)}`,
    );
  }

  latestAvatarState(id: string): AvatarVisualState {
    return this.latestDisplayStates.get(id) ?? detectAvatarState(this.latestFrames.get(id));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

function capture(windowId: string, path: string): void {
  runChecked(["mkdir", "-p", dirname(path)]);
  runChecked(["rm", "-f", path]);
  try {
    runChecked(["import", "-window", windowId, path]);
  } catch (error) {
    const grimProbe = Bun.spawnSync(["which", "grim"], { stdout: "pipe", stderr: "pipe" });
    if (grimProbe.exitCode !== 0) throw error;
    runChecked(["grim", path]);
  }
}

function normalizeText(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, " ").trim();
}

function buildCapturePath(basePath: string, label: string, multiple: boolean): string {
  if (!multiple) return basePath;
  const dot = basePath.lastIndexOf(".");
  if (dot <= 0) return `${basePath}-${label}`;
  return `${basePath.slice(0, dot)}-${label}${basePath.slice(dot)}`;
}

function workingMarkerVisible(frame: TerminalFrame | undefined): boolean {
  if (!frame) return false;
  const preview = normalizeText((frame.previewLines ?? []).join("\n"));
  return (
    preview.includes("working (") ||
    preview.includes("analyzing (") ||
    preview.includes("booting mcp server:") ||
    preview.includes("esc to interrupt")
  );
}

function visibleLineCount(frame: TerminalFrame | undefined): number {
  if (!frame?.previewLines) return 0;
  return frame.previewLines.filter((line) => line.trim().length > 0).length;
}

const flags = parseFlags(process.argv.slice(2));
const appName =
  typeof flags.app === "string" && flags.app.trim().length > 0 ? flags.app.trim() : "opencode";
const prompt =
  typeof flags.prompt === "string" && flags.prompt.trim().length > 0
    ? flags.prompt
    : "write a song about terminal windows and moonlight";
const screenshotPath =
  typeof flags.out === "string" && flags.out.trim().length > 0
    ? flags.out.trim()
    : `screenshots/${appName}-avatar-working.png`;
const captureSeriesMs =
  typeof flags["capture-series-ms"] === "string"
    ? flags["capture-series-ms"]
        .split(",")
        .map((entry) => Number(entry.trim()))
        .filter((value) => Number.isFinite(value) && value >= 0)
        .map((value) => Math.trunc(value))
    : [];
const bootWaitMs =
  typeof flags["boot-wait-ms"] === "string" && Number.isFinite(Number(flags["boot-wait-ms"]))
    ? Math.max(1000, Number(flags["boot-wait-ms"]))
    : appName === "codex"
      ? 7000
      : 9000;
const workingWaitMs =
  typeof flags["working-wait-ms"] === "string" && Number.isFinite(Number(flags["working-wait-ms"]))
    ? Math.max(1000, Number(flags["working-wait-ms"]))
    : 20000;
const postWorkingWaitMs =
  typeof flags["post-working-wait-ms"] === "string" && Number.isFinite(Number(flags["post-working-wait-ms"]))
    ? Math.max(0, Number(flags["post-working-wait-ms"]))
    : 0;
const waitForHiddenWorkingMarker =
  flags["wait-for-hidden-working-marker"] === true || flags["wait-for-hidden-working-marker"] === "true";
const hiddenWorkingMarkerWaitMs =
  typeof flags["hidden-working-marker-wait-ms"] === "string" &&
  Number.isFinite(Number(flags["hidden-working-marker-wait-ms"]))
    ? Math.max(1000, Number(flags["hidden-working-marker-wait-ms"]))
    : 60000;
const minVisibleLines =
  typeof flags["min-visible-lines"] === "string" && Number.isFinite(Number(flags["min-visible-lines"]))
    ? Math.max(4, Number(flags["min-visible-lines"]))
    : 12;
const promptWaitMs =
  typeof flags["prompt-wait-ms"] === "string" && Number.isFinite(Number(flags["prompt-wait-ms"]))
    ? Math.max(1000, Number(flags["prompt-wait-ms"]))
    : 10000;
const waitMs =
  typeof flags["wait-ms"] === "string" && Number.isFinite(Number(flags["wait-ms"]))
    ? Math.max(1000, Number(flags["wait-ms"]))
    : 25000;
const windowName = "Ghostty Multi-Terminal Dashboard";
const windowWidth =
  typeof flags["window-width"] === "string" && Number.isFinite(Number(flags["window-width"]))
    ? Math.max(640, Number(flags["window-width"]))
    : 1400;
const windowHeight =
  typeof flags["window-height"] === "string" && Number.isFinite(Number(flags["window-height"]))
    ? Math.max(420, Number(flags["window-height"]))
    : 900;
const launchJson = JSON.stringify({ panes: [{ command: appName }] });

Bun.spawnSync(["pkill", "-f", "ghostty-dashboard-mvp-dev"]);
Bun.spawnSync(["pkill", "-f", "electrobun dev --watch"]);
Bun.spawnSync(["pkill", "-f", "Resources/main.js"]);

const app = Bun.spawn(["bun", "run", "dev"], {
  env: { ...process.env, GHOSTTY_DASHBOARD_LAUNCH: launchJson },
  stdio: ["ignore", "inherit", "inherit"],
});

let failed = false;
let rpc: RpcSession | null = null;
try {
  const start = Date.now();
  let windowId: string | null = null;
  while (!windowId && Date.now() - start < waitMs) {
    await sleep(800);
    windowId = findWindowId(windowName);
  }

  if (!windowId) {
    throw new Error(`Could not find app window within ${waitMs}ms`);
  }

  runChecked(["xdotool", "windowactivate", "--sync", windowId]);
  runChecked(["xdotool", "windowfocus", "--sync", windowId]);
  runChecked([
    "xdotool",
    "keyup",
    "Control_L",
    "Control_R",
    "Shift_L",
    "Shift_R",
    "Alt_L",
    "Alt_R",
    "Super_L",
    "Super_R",
  ]);
  runChecked(["xdotool", "windowsize", "--sync", windowId, String(windowWidth), String(windowHeight)]);
  await sleep(1800);
  runChecked(["xdotool", "mousemove", "--window", windowId, "140", "180", "click", "1"]);

  rpc = new RpcSession();
  const terminalId = await rpc.listFirstTerminalId();
  await sleep(bootWaitMs);
  rpc.ensureNotExited(terminalId);
  await rpc.sendInput(terminalId, prompt);
  await rpc.waitForPromptVisible(terminalId, prompt, promptWaitMs);
  await sleep(250);
  await rpc.sendInput(terminalId, "\r");
  try {
    await rpc.waitForAvatarState(
      terminalId,
      (state) => state === "working" || state === "question" || state === "calling",
      workingWaitMs,
    );
  } catch {}
  if (waitForHiddenWorkingMarker) {
    await rpc.waitForHiddenWorkingMarker(terminalId, minVisibleLines, hiddenWorkingMarkerWaitMs);
  }
  if (captureSeriesMs.length > 0) {
    const sortedCaptures = [...captureSeriesMs].sort((a, b) => a - b);
    const startMs = Date.now();
    for (const captureAtMs of sortedCaptures) {
      const remainingMs = captureAtMs - (Date.now() - startMs);
      if (remainingMs > 0) {
        await sleep(remainingMs);
      }
      rpc.ensureNotExited(terminalId);
      const label = `${Math.round(captureAtMs / 1000)}s`;
      const capturePath = buildCapturePath(screenshotPath, label, true);
      console.log(
        `agent-avatar-screenshot: capture ${label} state ${rpc.latestAvatarState(terminalId)}`,
      );
      capture(windowId, capturePath);
      console.log(`agent-avatar-screenshot: saved ${capturePath}`);
    }
  } else if (postWorkingWaitMs > 0) {
    await sleep(postWorkingWaitMs);
  }
  if (captureSeriesMs.length > 0) {
    rpc.ensureNotExited(terminalId);
  } else {
    rpc.ensureNotExited(terminalId);
    console.log(`agent-avatar-screenshot: observed avatar state ${rpc.latestAvatarState(terminalId)}`);
    capture(windowId, screenshotPath);
    console.log(`agent-avatar-screenshot: saved ${screenshotPath}`);
  }
} catch (error) {
  failed = true;
  console.error(
    `agent-avatar-screenshot: ${
      error instanceof Error ? error.message : "unexpected failure"
    }`,
  );
} finally {
  rpc?.close();
  app.kill();
  await app.exited;
}

if (failed) process.exit(1);

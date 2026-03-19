import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { TerminalManager } from "./terminalManager";
import type { DashboardConfigManager } from "./configManager";
import {
  encodeTerminalFramePacket,
  type ClientMessage,
  type JsonServerMessage,
  type LaunchConfig,
  type TerminalFrame,
} from "../shared/protocol";

const HOST = "127.0.0.1";
// Remote RPC binding is intentionally disabled until the transport is secured.
// const HOST = process.env.AGENTZ_RPC_HOST ?? "127.0.0.1";
const PORT = 4599;
const PASTED_IMAGE_DIR = path.join(os.tmpdir(), "agentz-paste");

function isIgnorableSocketWriteError(error: unknown): boolean {
  const code = String((error as { code?: string } | null | undefined)?.code ?? "").toUpperCase();
  const message = error instanceof Error ? error.message.toUpperCase() : String(error ?? "").toUpperCase();
  return (
    code.includes("EPIPE") ||
    code.includes("ECONNRESET") ||
    code.includes("ERR_SOCKET_CLOSED") ||
    message.includes("EPIPE") ||
    message.includes("ECONNRESET") ||
    message.includes("ERR_SOCKET_CLOSED")
  );
}

function extensionForMimeType(mimeType: string, fileName?: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/png") return "png";
  if (normalized === "image/jpeg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  if (normalized === "image/avif") return "avif";
  if (normalized === "image/bmp") return "bmp";
  if (normalized === "image/tiff") return "tiff";
  if (normalized === "image/svg+xml") return "svg";
  if (fileName) {
    const ext = path.extname(fileName).slice(1).trim().toLowerCase();
    if (ext) return ext.replace(/[^a-z0-9]/g, "") || "png";
  }
  return "png";
}

async function writePastedImage(dataBase64: string, mimeType: string, fileName?: string): Promise<string> {
  const bytes = Buffer.from(dataBase64, "base64");
  if (bytes.byteLength === 0) {
    throw new Error("Pasted image was empty");
  }
  await mkdir(PASTED_IMAGE_DIR, { recursive: true });
  const extension = extensionForMimeType(mimeType, fileName);
  const imagePath = path.join(PASTED_IMAGE_DIR, `clipboard-${Date.now()}.${extension}`);
  await writeFile(imagePath, bytes);
  return imagePath;
}

function parseMessage(raw: string): ClientMessage | null {
  try {
    return JSON.parse(raw) as ClientMessage;
  } catch {
    return null;
  }
}

export function startTerminalRpcServer(
  launchConfig: LaunchConfig,
  configManager: DashboardConfigManager,
): { host: string; port: number; close: () => void } {
  const terminals = new TerminalManager();
  const clients = new Set<WebSocket>();
  const httpServer = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("agentz RPC endpoint");
  });
  const websocketServer = new WebSocketServer({ server: httpServer });

  function dropClient(ws: WebSocket): void {
    clients.delete(ws);
    try {
      ws.close();
    } catch {
      // ignore shutdown errors
    }
  }

  function safeSend(ws: WebSocket, payload: string | Uint8Array): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(payload);
    } catch (error) {
      if (!isIgnorableSocketWriteError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[rpc] websocket send failed: ${message}`);
      }
      dropClient(ws);
    }
  }

  function send(ws: WebSocket, message: JsonServerMessage): void {
    safeSend(ws, JSON.stringify(message));
  }

  function broadcast(message: JsonServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of clients) {
      safeSend(ws, payload);
    }
  }

  function broadcastFrame(frame: TerminalFrame): void {
    const payload = encodeTerminalFramePacket(frame);
    for (const ws of clients) {
      safeSend(ws, payload);
    }
  }

  websocketServer.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    send(ws, { type: "ready", serverVersion: "mvp-0.1.0" });
    send(ws, { type: "config", config: configManager.getConfig() });

    ws.on("close", () => {
      clients.delete(ws);
    });
    ws.on("error", () => {
      clients.delete(ws);
    });

    ws.on("message", async (incoming: RawData) => {
      const parsed = parseMessage(incoming.toString());
      if (!parsed) {
        send(ws, { type: "error", message: "Invalid JSON message" });
        return;
      }

      try {
        switch (parsed.type) {
          case "create": {
            terminals.create(
              parsed.id,
              parsed.cols,
              parsed.rows,
              {
                onFrame: (frame) => broadcastFrame(frame),
                onExit: (id, exitCode) => {
                  broadcast({ type: "terminal-exited", id, exitCode });
                },
              },
              parsed.command,
              parsed.args,
              parsed.cwd,
            );
            broadcast({ type: "terminal-created", id: parsed.id });
            break;
          }
          case "resize": {
            terminals.get(parsed.id)?.resize(parsed.cols, parsed.rows);
            break;
          }
          case "input": {
            terminals.get(parsed.id)?.input(parsed.data, parsed.encoding);
            break;
          }
          case "paste-image": {
            const session = terminals.get(parsed.id);
            if (!session) {
              send(ws, {
                type: "error",
                id: parsed.id,
                message: `Unknown terminal: ${parsed.id}`,
              });
              return;
            }
            const imagePath = await writePastedImage(parsed.dataBase64, parsed.mimeType, parsed.fileName);
            session.input(imagePath, "utf8");
            break;
          }
          case "flow": {
            terminals.get(parsed.id)?.setFlowPaused(parsed.paused);
            break;
          }
          case "frame-rate": {
            terminals.get(parsed.id)?.setFrameInterval(parsed.intervalMs, parsed.previewOnly);
            break;
          }
          case "snapshot": {
            const session = terminals.get(parsed.id);
            if (!session) {
              send(ws, {
                type: "error",
                id: parsed.id,
                message: `Unknown terminal: ${parsed.id}`,
              });
              return;
            }
            session.requestSnapshot();
            break;
          }
          case "list": {
            send(ws, { type: "terminal-list", ids: terminals.listIds() });
            break;
          }
          case "launch-config": {
            send(ws, { type: "launch-config", config: launchConfig });
            break;
          }
          case "get-config": {
            send(ws, { type: "config", config: configManager.getConfig() });
            break;
          }
          case "set-config": {
            const nextConfig = configManager.setConfig(parsed.config);
            broadcast({ type: "config", config: nextConfig });
            break;
          }
          case "kill": {
            terminals.kill(parsed.id);
            break;
          }
          default: {
            const unknown: never = parsed;
            throw new Error(`Unsupported message type ${(unknown as { type: string }).type}`);
          }
        }
      } catch (error) {
        send(ws, {
          type: "error",
          message: error instanceof Error ? error.message : "Unknown server error",
        });
      }
    });
  });

  httpServer.listen(PORT, HOST);

  const close = () => {
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
        // ignore shutdown errors
      }
    }
    clients.clear();
    websocketServer.close();
    httpServer.close();
    terminals.killAll();
  };

  process.on("exit", () => terminals.killAll());
  process.on("SIGINT", () => {
    close();
    process.exit(0);
  });

  return { host: HOST, port: PORT, close };
}

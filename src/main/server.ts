import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { TerminalManager } from "./terminalManager";
import type { DashboardConfigManager } from "./configManager";
import { createDisabledRpcAuth, type RpcAuthController } from "./webAuth";
import {
  encodeTerminalFramePacket,
  type AppUpdateStatus,
  type ClientMessage,
  type JsonServerMessage,
  type LaunchConfig,
  type TerminalFrame,
} from "../shared/protocol";
import type { WebAuthErrorResponse, WebAuthLoginResponse, WebAuthSessionStatus } from "../shared/webAuth";

const HOST = "127.0.0.1";
// Remote RPC binding is intentionally disabled until the transport is secured.
// const HOST = process.env.AGENTZ_RPC_HOST ?? "127.0.0.1";
const PORT = 4599;
const PASTED_IMAGE_DIR = path.join(os.tmpdir(), "agentz-paste");
const MAX_HTTP_BODY_BYTES = 64 * 1024;

interface StartTerminalRpcServerOptions {
  auth?: RpcAuthController;
  updates?: RpcUpdateController;
}

interface RpcUpdateController {
  currentStatus: () => AppUpdateStatus;
  requestManualCheck: () => Promise<void>;
  subscribe: (listener: (status: AppUpdateStatus) => void) => () => void;
}

const UNSUPPORTED_UPDATE_STATUS: AppUpdateStatus = {
  state: "unsupported",
  message: "Manual update checks are only available in packaged app builds.",
};

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

function setCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!origin) return;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  statusCode: number,
  payload: WebAuthSessionStatus | WebAuthLoginResponse | WebAuthErrorResponse,
): void {
  setCorsHeaders(req, res);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function extractWebSocketToken(req: IncomingMessage): string | null {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`,
  );
  socket.destroy();
}

export function startTerminalRpcServer(
  launchConfig: LaunchConfig,
  configManager: DashboardConfigManager,
  options: StartTerminalRpcServerOptions = {},
): { host: string; port: number; close: () => void } {
  const auth = options.auth ?? createDisabledRpcAuth();
  const updates = options.updates ?? {
    currentStatus: () => UNSUPPORTED_UPDATE_STATUS,
    requestManualCheck: async () => {},
    subscribe: () => () => {},
  };
  const terminals = new TerminalManager();
  const clients = new Set<WebSocket>();
  const httpServer = createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const pathname = (() => {
      try {
        return new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`).pathname;
      } catch {
        return "/";
      }
    })();

    if (method === "OPTIONS") {
      setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === "/auth/session" && method === "GET") {
      sendJson(req, res, 200, auth.sessionStatus(extractBearerToken(req)));
      return;
    }

    if (pathname === "/auth/login" && method === "POST") {
      if (!auth.enabled) {
        sendJson(req, res, 404, { message: "Web auth is not enabled for this server." });
        return;
      }

      try {
        const payload = await readJsonBody(req) as { username?: unknown; password?: unknown };
        const username = typeof payload.username === "string" ? payload.username : "";
        const password = typeof payload.password === "string" ? payload.password : "";
        const result = await auth.login(username, password);
        if (!result) {
          sendJson(req, res, 401, { message: "Invalid username or password." });
          return;
        }
        sendJson(req, res, 200, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid login request.";
        sendJson(req, res, 400, { message });
      }
      return;
    }

    if (pathname === "/auth/logout" && method === "POST") {
      auth.logout(extractBearerToken(req));
      setCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    setCorsHeaders(req, res);
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("agentz RPC endpoint");
  });
  const websocketServer = new WebSocketServer({ noServer: true });

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

  httpServer.on("upgrade", (req, socket, head) => {
    if (auth.enabled && !auth.authorizeWebSocket(extractWebSocketToken(req))) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }

    websocketServer.handleUpgrade(req, socket, head, (ws) => {
      websocketServer.emit("connection", ws, req);
    });
  });

  websocketServer.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    send(ws, { type: "ready", serverVersion: "mvp-0.1.0" });
    send(ws, { type: "config", config: configManager.getConfig() });
    send(ws, { type: "update-status", status: updates.currentStatus() });

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
          case "check-updates": {
            await updates.requestManualCheck();
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
  const disposeUpdateStatus = updates.subscribe((status) => {
    broadcast({ type: "update-status", status });
  });

  const close = () => {
    disposeUpdateStatus();
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

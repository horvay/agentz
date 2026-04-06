import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { DashboardConfig } from "../shared/config";
import {
  encodeTerminalFramePacket,
  type AppUpdateStatus,
  type ClientMessage,
  type JsonServerMessage,
  type LaunchConfig,
  type TerminalFrame,
} from "../shared/protocol";
import type {
  RemotePairingStartResponse,
  RemotePairingPollResponse,
  RemoteSessionStatus,
  WebAuthErrorResponse,
} from "../shared/webAuth";
import type { DashboardConfigManager } from "./configManager";
import { TerminalManager } from "./terminalManager";
import { createRemoteAccessController, type RemoteAccessController } from "./webAuth";

const DEFAULT_LOCAL_HOST = "127.0.0.1";
const DEFAULT_REMOTE_HOST = "0.0.0.0";
export const RPC_PORT = 4599;
const PASTED_IMAGE_DIR = path.join(os.tmpdir(), "agentz-paste");
const MAX_HTTP_BODY_BYTES = 64 * 1024;
const RPC_WS_PROTOCOL = "agentz-rpc";
const RPC_WS_AUTH_PROTOCOL_PREFIX = "agentz-auth.";
const WS_CLOSE_UNAUTHORIZED = 4401;
const SESSION_SWEEP_INTERVAL_MS = 30 * 1000;

interface StartTerminalRpcServerOptions {
  host?: string;
  port?: number;
  tls?: {
    key: string | Buffer;
    cert: string | Buffer;
  };
  bindings?: Array<{
    host: string;
    port: number;
    tls?: {
      key: string | Buffer;
      cert: string | Buffer;
    };
  }>;
  terminals?: TerminalManager;
  remoteAccess?: RemoteAccessController;
  updates?: RpcUpdateController;
  onConfigChanged?: (nextConfig: DashboardConfig, previousConfig: DashboardConfig) => void;
}

interface RpcUpdateController {
  currentStatus: () => AppUpdateStatus;
  requestManualCheck: () => Promise<void>;
  subscribe: (listener: (status: AppUpdateStatus) => void) => () => void;
}

interface ClientContext {
  isLocal: boolean;
  sessionToken: string | null;
  terminalPreferences: Map<string, {
    paused: boolean;
    intervalMs: number;
    previewOnly: boolean;
  }>;
}

interface CloseServerOptions {
  killTerminals?: boolean;
}

interface RpcServerBindingInfo {
  host: string;
  port: number;
  secure: boolean;
}

const UNSUPPORTED_UPDATE_STATUS: AppUpdateStatus = {
  state: "unsupported",
  message: "Manual update checks are only available in packaged app builds.",
};

const CONTENT_TYPE_BY_EXT = new Map<string, string>([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

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

function sendJson(
  res: ServerResponse,
  statusCode: number,
  payload:
    | RemoteSessionStatus
    | RemotePairingStartResponse
    | RemotePairingPollResponse
    | WebAuthErrorResponse,
): void {
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
  const header = req.headers["sec-websocket-protocol"];
  const values = Array.isArray(header) ? header : [header];
  for (const value of values) {
    if (!value) continue;
    const protocols = value.split(",").map((part: string) => part.trim());
    const authProtocol = protocols.find((part: string) => part.startsWith(RPC_WS_AUTH_PROTOCOL_PREFIX));
    if (!authProtocol) continue;
    const token = authProtocol.slice(RPC_WS_AUTH_PROTOCOL_PREFIX.length);
    if (token) return token;
  }
  return null;
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

function normalizeRemoteAddress(address: string | undefined): string {
  if (!address) return "";
  if (address.startsWith("::ffff:")) return address.slice(7);
  return address;
}

function isLoopbackRequest(req: IncomingMessage): boolean {
  const remoteAddress = normalizeRemoteAddress(req.socket.remoteAddress);
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1";
}

function resolveWebAssetRoot(): string {
  const candidates = [
    path.join(process.cwd(), "dist"),
    path.join(process.resourcesPath ?? "", "app", "dist"),
    path.join(process.resourcesPath ?? "", "app.asar", "dist"),
    path.join(path.dirname(process.execPath), "..", "Resources", "app", "dist"),
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(process.cwd(), "dist");
}

async function serveWebAsset(res: ServerResponse, pathnameValue: string): Promise<boolean> {
  const assetRoot = resolveWebAssetRoot();
  const normalizedPath = pathnameValue === "/" ? "/index.html" : pathnameValue;
  const decodedPath = decodeURIComponent(normalizedPath);
  const requestedPath = decodedPath.endsWith("/") ? `${decodedPath}index.html` : decodedPath;
  const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  const assetPath = path.join(assetRoot, safePath.startsWith("/") ? safePath.slice(1) : safePath);
  const fallbackToIndex = path.extname(assetPath).length === 0;

  const tryPaths = fallbackToIndex ? [assetPath, path.join(assetRoot, "index.html")] : [assetPath];

  for (const candidate of tryPaths) {
    try {
      const contents = await readFile(candidate);
      const contentType = CONTENT_TYPE_BY_EXT.get(path.extname(candidate).toLowerCase()) ?? "application/octet-stream";
      res.writeHead(200, { "content-type": contentType });
      res.end(contents);
      return true;
    } catch {
      // try next candidate
    }
  }

  return false;
}

export function startTerminalRpcServer(
  launchConfig: LaunchConfig,
  configManager: DashboardConfigManager,
  options: StartTerminalRpcServerOptions = {},
): {
  host: string;
  port: number;
  secure: boolean;
  bindings: RpcServerBindingInfo[];
  close: (closeOptions?: CloseServerOptions) => Promise<void>;
} {
  const bindings = options.bindings?.length
    ? options.bindings
    : [{
        host: options.host ?? DEFAULT_LOCAL_HOST,
        port: options.port ?? RPC_PORT,
        tls: options.tls,
      }];
  const primaryBinding = bindings[0]!;
  const remoteAccess = options.remoteAccess ?? createRemoteAccessController();
  const updates = options.updates ?? {
    currentStatus: () => UNSUPPORTED_UPDATE_STATUS,
    requestManualCheck: async () => {},
    subscribe: () => () => {},
  };
  const terminals = options.terminals ?? new TerminalManager();
  const clients = new Set<WebSocket>();
  const clientContexts = new Map<WebSocket, ClientContext>();
  const terminalResizeOwners = new Map<string, WebSocket>();

  function applyTerminalPreferences(id: string): void {
    const session = terminals.get(id);
    if (!session) return;

    const preferences = [...clientContexts.values()]
      .map((context) => context.terminalPreferences.get(id))
      .filter((value): value is { paused: boolean; intervalMs: number; previewOnly: boolean } => Boolean(value));

    if (preferences.length === 0) {
      session.setFlowPaused(false);
      session.setFrameInterval(0, false);
      return;
    }

    session.setFlowPaused(preferences.every((entry) => entry.paused));
    session.setFrameInterval(
      preferences.reduce((min, entry) => Math.min(min, Math.max(0, entry.intervalMs)), Number.POSITIVE_INFINITY) ||
        0,
      preferences.every((entry) => entry.previewOnly),
    );
  }

  function releaseClient(ws: WebSocket): void {
    const context = clientContexts.get(ws);
    clients.delete(ws);
    clientContexts.delete(ws);
    for (const [id, owner] of terminalResizeOwners.entries()) {
      if (owner === ws) {
        terminalResizeOwners.delete(id);
      }
    }
    if (!context) return;
    for (const id of context.terminalPreferences.keys()) {
      applyTerminalPreferences(id);
    }
  }

  function claimTerminalResizeOwnership(id: string, ws: WebSocket): void {
    terminalResizeOwners.set(id, ws);
  }

  function canResizeTerminal(id: string, ws: WebSocket): boolean {
    const owner = terminalResizeOwners.get(id);
    if (!owner) {
      claimTerminalResizeOwnership(id, ws);
      return true;
    }
    if (owner === ws || owner.readyState !== WebSocket.OPEN || !clients.has(owner)) {
      claimTerminalResizeOwnership(id, ws);
      return true;
    }
    return false;
  }

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    const url = (() => {
      try {
        return new URL(req.url ?? "/", `http://${req.headers.host ?? `${primaryBinding.host}:${primaryBinding.port}`}`);
      } catch {
        return new URL(`http://${primaryBinding.host}:${primaryBinding.port}/`);
      }
    })();
    const pathnameValue = url.pathname;
    const isLocal = isLoopbackRequest(req);

    if (pathnameValue === "/remote-access/status" && method === "GET") {
      const requestId = url.searchParams.get("requestId");
      sendJson(res, 200, remoteAccess.sessionStatus(extractBearerToken(req), requestId));
      return;
    }

    if (pathnameValue === "/remote-access/pairing/start" && method === "POST") {
      if (!remoteAccess.isEnabled()) {
        sendJson(res, 403, { message: "Remote access is disabled on this desktop." });
        return;
      }
      if (isLocal) {
        sendJson(res, 400, { message: "Local clients do not need pairing." });
        return;
      }
      try {
        const payload = await readJsonBody(req) as { passcode?: unknown; deviceName?: unknown; deviceToken?: unknown };
        const passcode = typeof payload.passcode === "string" ? payload.passcode : "";
        const deviceName = typeof payload.deviceName === "string" ? payload.deviceName : "";
        const deviceToken = typeof payload.deviceToken === "string" ? payload.deviceToken : null;
        const response = remoteAccess.startPairing(passcode, deviceName, {
          remoteAddress: normalizeRemoteAddress(req.socket.remoteAddress),
          userAgent: req.headers["user-agent"],
        }, deviceToken);
        sendJson(res, 200, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid pairing request.";
        sendJson(res, 400, { message });
      }
      return;
    }

    if (pathnameValue.startsWith("/remote-access/pairing/") && method === "GET") {
      const requestId = pathnameValue.slice("/remote-access/pairing/".length);
      const status = remoteAccess.getPairingStatus(requestId);
      if (!status) {
        sendJson(res, 404, { message: "Pairing request not found." });
        return;
      }
      sendJson(res, 200, status);
      return;
    }

    if (pathnameValue === "/remote-access/logout" && method === "POST") {
      remoteAccess.revokeSession(extractBearerToken(req));
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathnameValue === "/remote-access/forget-device" && method === "POST") {
      try {
        const payload = await readJsonBody(req) as { deviceToken?: unknown };
        const deviceToken = typeof payload.deviceToken === "string" ? payload.deviceToken : null;
        const revokedTokens = remoteAccess.forgetDeviceToken(deviceToken);
        for (const ws of clients) {
          const context = clientContexts.get(ws);
          if (!context?.sessionToken || !revokedTokens.includes(context.sessionToken)) continue;
          closeUnauthorizedClient(ws, "This browser was disconnected.");
        }
        res.writeHead(204);
        res.end();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid device revoke request.";
        sendJson(res, 400, { message });
      }
      return;
    }

    if (!isLocal) {
      if (!remoteAccess.isEnabled()) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Remote access is disabled.");
        return;
      }
      if (method === "GET" && await serveWebAsset(res, pathnameValue)) {
        return;
      }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("agentz RPC endpoint");
  };
  const websocketServer = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      if (!protocols.has(RPC_WS_PROTOCOL)) {
        return false;
      }
      return RPC_WS_PROTOCOL;
    },
  });

  function closeUnauthorizedClient(ws: WebSocket, reason: string): void {
    releaseClient(ws);
    try {
      ws.close(WS_CLOSE_UNAUTHORIZED, reason);
    } catch {
      try {
        ws.close();
      } catch {
        // ignore shutdown errors
      }
    }
  }

  function dropClient(ws: WebSocket): void {
    releaseClient(ws);
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

  function sendRemoteAccessState(ws: WebSocket): void {
    const context = clientContexts.get(ws);
    if (!context?.isLocal) return;
    send(ws, {
      type: "remote-access-state",
      state: remoteAccess.getState(true),
    });
  }

  const servers = bindings.map((binding) => {
    const server = binding.tls
      ? createHttpsServer({ key: binding.tls.key, cert: binding.tls.cert }, requestHandler)
      : createHttpServer(requestHandler);
    server.on("upgrade", (req, socket, head) => {
      const isLocal = isLoopbackRequest(req);
      const sessionToken = extractWebSocketToken(req);
      if (!remoteAccess.authorizeWebSocket(sessionToken, isLocal)) {
        rejectUpgrade(socket, 401, "Unauthorized");
        return;
      }

      websocketServer.handleUpgrade(req, socket, head, (ws) => {
        clientContexts.set(ws, {
          isLocal,
          sessionToken: sessionToken ?? null,
          terminalPreferences: new Map(),
        });
        websocketServer.emit("connection", ws, req);
      });
    });
    server.listen(binding.port, binding.host);
    return { server, binding };
  });

  websocketServer.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    send(ws, { type: "ready", serverVersion: "mvp-0.1.0" });
    send(ws, { type: "config", config: configManager.getConfig() });
    send(ws, { type: "update-status", status: updates.currentStatus() });
    sendRemoteAccessState(ws);

    ws.on("close", () => {
      releaseClient(ws);
    });
    ws.on("error", () => {
      releaseClient(ws);
    });

    ws.on("message", async (incoming: RawData) => {
      const clientContext = clientContexts.get(ws);
      if (!clientContext) return;
      if (!clientContext.isLocal && !remoteAccess.isSessionValid(clientContext.sessionToken)) {
        closeUnauthorizedClient(ws, "Session expired");
        return;
      }
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
                  terminalResizeOwners.delete(id);
                  broadcast({ type: "terminal-exited", id, exitCode });
                },
              },
              parsed.command,
              parsed.args,
              parsed.cwd,
            );
            claimTerminalResizeOwnership(parsed.id, ws);
            broadcast({ type: "terminal-created", id: parsed.id });
            break;
          }
          case "resize": {
            if (canResizeTerminal(parsed.id, ws)) {
              terminals.get(parsed.id)?.resize(parsed.cols, parsed.rows);
            }
            break;
          }
          case "focus-terminal": {
            claimTerminalResizeOwnership(parsed.id, ws);
            break;
          }
          case "input": {
            claimTerminalResizeOwnership(parsed.id, ws);
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
            claimTerminalResizeOwnership(parsed.id, ws);
            const imagePath = await writePastedImage(parsed.dataBase64, parsed.mimeType, parsed.fileName);
            session.input(imagePath, "utf8");
            break;
          }
          case "flow": {
            clientContext.terminalPreferences.set(parsed.id, {
              paused: parsed.paused,
              intervalMs: clientContext.terminalPreferences.get(parsed.id)?.intervalMs ?? 0,
              previewOnly: clientContext.terminalPreferences.get(parsed.id)?.previewOnly ?? false,
            });
            applyTerminalPreferences(parsed.id);
            break;
          }
          case "frame-rate": {
            clientContext.terminalPreferences.set(parsed.id, {
              paused: clientContext.terminalPreferences.get(parsed.id)?.paused ?? false,
              intervalMs: parsed.intervalMs,
              previewOnly: parsed.previewOnly ?? false,
            });
            applyTerminalPreferences(parsed.id);
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
          case "get-remote-access-state": {
            sendRemoteAccessState(ws);
            break;
          }
          case "set-config": {
            const previousConfig = configManager.getConfig();
            const nextConfig = configManager.setConfig(
              clientContext.isLocal
                ? parsed.config
                : {
                    ...parsed.config,
                    remoteAccess: previousConfig.remoteAccess,
                  },
            );
            broadcast({ type: "config", config: nextConfig });
            options.onConfigChanged?.(nextConfig, previousConfig);
            break;
          }
          case "approve-remote-pairing": {
            if (!clientContext.isLocal) {
              send(ws, { type: "error", message: "Remote clients cannot approve pairings." });
              return;
            }
            if (!remoteAccess.approvePairing(parsed.requestId)) {
              send(ws, { type: "error", message: "Pairing request not found." });
            }
            break;
          }
          case "reject-remote-pairing": {
            if (!clientContext.isLocal) {
              send(ws, { type: "error", message: "Remote clients cannot reject pairings." });
              return;
            }
            if (!remoteAccess.rejectPairing(parsed.requestId)) {
              send(ws, { type: "error", message: "Pairing request not found." });
            }
            break;
          }
          case "forget-remote-device": {
            if (!clientContext.isLocal) {
              send(ws, { type: "error", message: "Remote clients cannot forget approved devices." });
              return;
            }
            const revokedTokens = remoteAccess.forgetDevice(parsed.deviceId);
            for (const client of clients) {
              const context = clientContexts.get(client);
              if (!context?.sessionToken || !revokedTokens.includes(context.sessionToken)) continue;
              closeUnauthorizedClient(client, "This device was removed.");
            }
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

  const disposeUpdateStatus = updates.subscribe((status) => {
    broadcast({ type: "update-status", status });
  });
  const disposeRemoteAccess = remoteAccess.subscribe(() => {
    for (const ws of clients) {
      const context = clientContexts.get(ws);
      if (!context) continue;
      if (context.isLocal) {
        sendRemoteAccessState(ws);
        continue;
      }
      if (!remoteAccess.authorizeWebSocket(context.sessionToken, false)) {
        closeUnauthorizedClient(ws, "Remote access changed");
      }
    }
  });
  const sessionSweepTimer = setInterval(() => {
    for (const ws of clients) {
      const context = clientContexts.get(ws);
      if (!context || context.isLocal) continue;
      if (remoteAccess.isSessionValid(context.sessionToken)) continue;
      closeUnauthorizedClient(ws, "Session expired");
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sessionSweepTimer.unref?.();

  const close = async (closeOptions: CloseServerOptions = {}) => {
    disposeUpdateStatus();
    disposeRemoteAccess();
    clearInterval(sessionSweepTimer);
    for (const ws of clients) {
      try {
        ws.close();
      } catch {
        // ignore shutdown errors
      }
    }
    clients.clear();
    clientContexts.clear();
    websocketServer.close();
    await Promise.all(servers.map(({ server }) => new Promise<void>((resolve) => {
      server.close(() => resolve());
    })));
    if (closeOptions.killTerminals !== false) {
      terminals.killAll();
    }
  };

  return {
    host: primaryBinding.host,
    port: primaryBinding.port,
    secure: Boolean(primaryBinding.tls),
    bindings: bindings.map((binding) => ({
      host: binding.host,
      port: binding.port,
      secure: Boolean(binding.tls),
    })),
    close,
  };
}

export { DEFAULT_LOCAL_HOST, DEFAULT_REMOTE_HOST };

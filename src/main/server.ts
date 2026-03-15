import { createServer } from "node:http";
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
const PORT = 4599;

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
    res.end("Ghostty dashboard RPC endpoint");
  });
  const websocketServer = new WebSocketServer({ server: httpServer });

  function send(ws: WebSocket, message: JsonServerMessage): void {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  function broadcast(message: JsonServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(payload);
    }
  }

  function broadcastFrame(frame: TerminalFrame): void {
    const payload = encodeTerminalFramePacket(frame);
    for (const ws of clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      ws.send(payload);
    }
  }

  websocketServer.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    send(ws, { type: "ready", serverVersion: "mvp-0.1.0" });
    send(ws, { type: "config", config: configManager.getConfig() });

    ws.on("close", () => {
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

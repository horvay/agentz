import type { ServerWebSocket } from "bun";
import { TerminalManager } from "./terminalManager";
import type { DashboardConfigManager } from "./configManager";
import type { ClientMessage, LaunchConfig, ServerMessage } from "../shared/protocol";

const HOST = "127.0.0.1";
const PORT = 4599;

interface WsData {
  id: string;
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
): { host: string; port: number } {
  const terminals = new TerminalManager();
  const clients = new Set<ServerWebSocket<WsData>>();

  function send(ws: ServerWebSocket<WsData>, message: ServerMessage): void {
    ws.send(JSON.stringify(message));
  }

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const ws of clients) ws.send(payload);
  }

  Bun.serve<WsData>({
    hostname: HOST,
    port: PORT,
    fetch(req, server) {
      if (server.upgrade(req, { data: { id: crypto.randomUUID() } })) {
        return undefined;
      }
      return new Response("Ghostty dashboard RPC endpoint", { status: 200 });
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        send(ws, { type: "ready", serverVersion: "mvp-0.1.0" });
        send(ws, { type: "config", config: configManager.getConfig() });
      },
      close(ws) {
        clients.delete(ws);
      },
      message(ws, incoming) {
        const parsed = parseMessage(String(incoming));
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
                  onFrame: (frame) => broadcast({ type: "terminal-frame", frame }),
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
              terminals.get(parsed.id)?.input(parsed.data);
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
              send(ws, { type: "terminal-frame", frame: session.snapshot() });
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
              throw new Error(`Unsupported message type ${(unknown as any).type}`);
            }
          }
        } catch (error) {
          send(ws, {
            type: "error",
            message: error instanceof Error ? error.message : "Unknown server error",
          });
        }
      },
    },
  });

  process.on("exit", () => terminals.killAll());
  process.on("SIGINT", () => {
    terminals.killAll();
    process.exit(0);
  });

  return { host: HOST, port: PORT };
}

import {
  decodeTerminalFramePacket,
  type AppUpdateStatus,
  type ClientMessage,
  type JsonServerMessage,
  type LaunchConfig,
  type TerminalId,
  type TerminalFrame,
} from "../shared/protocol";
import type { DashboardConfig } from "../shared/config";

const RPC_RECONNECT_DELAY_MS = 600;

type FrameHandler = (frame: TerminalFrame) => void;
type ExitHandler = (id: string, exitCode: number) => void;
type ErrorHandler = (message: string) => void;
type CreatedHandler = (id: string) => void;
type ReadyHandler = () => void;
type LaunchConfigHandler = (config: LaunchConfig) => void;
type ConfigHandler = (config: DashboardConfig) => void;
type TerminalListHandler = (ids: TerminalId[]) => void;
type ConnectionHandler = (connected: boolean) => void;
type UpdateStatusHandler = (status: AppUpdateStatus) => void;

function shouldQueueDisconnectedMessage(message: ClientMessage): boolean {
  return (
    message.type === "create" ||
    message.type === "launch-config" ||
    message.type === "get-config" ||
    message.type === "list" ||
    message.type === "set-config"
  );
}

export class RpcClient {
  private readonly url: string;
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private queuedMessages: string[] = [];
  private frameHandlers = new Set<FrameHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private createdHandlers = new Set<CreatedHandler>();
  private readyHandlers = new Set<ReadyHandler>();
  private launchConfigHandlers = new Set<LaunchConfigHandler>();
  private configHandlers = new Set<ConfigHandler>();
  private terminalListHandlers = new Set<TerminalListHandler>();
  private connectionHandlers = new Set<ConnectionHandler>();
  private updateStatusHandlers = new Set<UpdateStatusHandler>();

  constructor(url: string) {
    this.url = url;
    this.connect();
  }

  private connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.connectionHandlers.forEach((cb) => cb(true));
      this.flushQueuedMessages();
    });
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.onMessage(event);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.connectionHandlers.forEach((cb) => cb(false));
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.scheduleReconnect();
    });
    this.ws = ws;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RPC_RECONNECT_DELAY_MS);
  }

  private flushQueuedMessages(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (this.queuedMessages.length === 0) return;
    const pending = this.queuedMessages;
    this.queuedMessages = [];
    pending.forEach((payload) => ws.send(payload));
  }

  private onMessage(event: MessageEvent): void {
    if (event.data instanceof ArrayBuffer) {
      const frame = decodeTerminalFramePacket(event.data);
      this.frameHandlers.forEach((cb) => cb(frame));
      return;
    }

    const message = JSON.parse(String(event.data)) as JsonServerMessage;
    switch (message.type) {
      case "terminal-exited":
        this.exitHandlers.forEach((cb) => cb(message.id, message.exitCode));
        break;
      case "terminal-created":
        this.createdHandlers.forEach((cb) => cb(message.id));
        break;
      case "ready":
        this.readyHandlers.forEach((cb) => cb());
        break;
      case "launch-config":
        this.launchConfigHandlers.forEach((cb) => cb(message.config));
        break;
      case "config":
        this.configHandlers.forEach((cb) => cb(message.config));
        break;
      case "terminal-list":
        this.terminalListHandlers.forEach((cb) => cb(message.ids));
        break;
      case "update-status":
        this.updateStatusHandlers.forEach((cb) => cb(message.status));
        break;
      case "error":
        this.errorHandlers.forEach((cb) => cb(message.message));
        break;
      default:
        break;
    }
  }

  send(message: ClientMessage): void {
    const payload = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
      return;
    }
    if (shouldQueueDisconnectedMessage(message)) {
      this.queuedMessages.push(payload);
    }
    this.connect();
  }

  onFrame(cb: FrameHandler): () => void {
    this.frameHandlers.add(cb);
    return () => this.frameHandlers.delete(cb);
  }

  onExit(cb: ExitHandler): () => void {
    this.exitHandlers.add(cb);
    return () => this.exitHandlers.delete(cb);
  }

  onError(cb: ErrorHandler): () => void {
    this.errorHandlers.add(cb);
    return () => this.errorHandlers.delete(cb);
  }

  onCreated(cb: CreatedHandler): () => void {
    this.createdHandlers.add(cb);
    return () => this.createdHandlers.delete(cb);
  }

  onReady(cb: ReadyHandler): () => void {
    this.readyHandlers.add(cb);
    return () => this.readyHandlers.delete(cb);
  }

  onLaunchConfig(cb: LaunchConfigHandler): () => void {
    this.launchConfigHandlers.add(cb);
    return () => this.launchConfigHandlers.delete(cb);
  }

  onConfig(cb: ConfigHandler): () => void {
    this.configHandlers.add(cb);
    return () => this.configHandlers.delete(cb);
  }

  onTerminalList(cb: TerminalListHandler): () => void {
    this.terminalListHandlers.add(cb);
    return () => this.terminalListHandlers.delete(cb);
  }

  onConnectionChange(cb: ConnectionHandler): () => void {
    this.connectionHandlers.add(cb);
    return () => this.connectionHandlers.delete(cb);
  }

  onUpdateStatus(cb: UpdateStatusHandler): () => void {
    this.updateStatusHandlers.add(cb);
    return () => this.updateStatusHandlers.delete(cb);
  }
}

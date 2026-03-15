import {
  decodeTerminalFramePacket,
  type ClientMessage,
  type JsonServerMessage,
  type LaunchConfig,
  type TerminalFrame,
} from "../shared/protocol";
import type { DashboardConfig } from "../shared/config";

type FrameHandler = (frame: TerminalFrame) => void;
type ExitHandler = (id: string, exitCode: number) => void;
type ErrorHandler = (message: string) => void;
type CreatedHandler = (id: string) => void;
type ReadyHandler = () => void;
type LaunchConfigHandler = (config: LaunchConfig) => void;
type ConfigHandler = (config: DashboardConfig) => void;

export class RpcClient {
  private readonly ws: WebSocket;
  private frameHandlers = new Set<FrameHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private createdHandlers = new Set<CreatedHandler>();
  private readyHandlers = new Set<ReadyHandler>();
  private launchConfigHandlers = new Set<LaunchConfigHandler>();
  private configHandlers = new Set<ConfigHandler>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.ws.addEventListener("message", (event) => this.onMessage(event));
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
      case "error":
        this.errorHandlers.forEach((cb) => cb(message.message));
        break;
      default:
        break;
    }
  }

  send(message: ClientMessage): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
      return;
    }
    this.ws.addEventListener(
      "open",
      () => {
        this.ws.send(JSON.stringify(message));
      },
      { once: true },
    );
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
}

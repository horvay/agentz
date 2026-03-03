import type { ClientMessage, LaunchConfig, ServerMessage, TerminalFrame } from "../shared/protocol";

type FrameHandler = (frame: TerminalFrame) => void;
type ExitHandler = (id: string, exitCode: number) => void;
type ErrorHandler = (message: string) => void;
type CreatedHandler = (id: string) => void;
type ReadyHandler = () => void;
type LaunchConfigHandler = (config: LaunchConfig) => void;

export class RpcClient {
  private readonly ws: WebSocket;
  private frameHandlers = new Set<FrameHandler>();
  private exitHandlers = new Set<ExitHandler>();
  private errorHandlers = new Set<ErrorHandler>();
  private createdHandlers = new Set<CreatedHandler>();
  private readyHandlers = new Set<ReadyHandler>();
  private launchConfigHandlers = new Set<LaunchConfigHandler>();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.addEventListener("message", (event) => this.onMessage(event));
  }

  private onMessage(event: MessageEvent): void {
    const message = JSON.parse(String(event.data)) as ServerMessage;
    switch (message.type) {
      case "terminal-frame":
        this.frameHandlers.forEach((cb) => cb(message.frame));
        break;
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
}

import { TerminalSession } from "./terminalSession";
import type { TerminalFrame } from "../shared/protocol";

interface SessionHooks {
  onFrame: (frame: TerminalFrame) => void;
  onExit: (id: string, exitCode: number) => void;
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  create(
    id: string,
    cols: number,
    rows: number,
    hooks: SessionHooks,
    command?: string,
    args?: string[],
    cwd?: string,
  ): TerminalSession {
    if (this.sessions.has(id)) {
      throw new Error(`Terminal already exists: ${id}`);
    }

    const session = new TerminalSession(id, cols, rows, command, args, cwd);
    session.onData(hooks.onFrame);
    session.onExit((exitCode) => {
      this.sessions.delete(id);
      hooks.onExit(id, exitCode);
    });
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  listIds(): string[] {
    return [...this.sessions.keys()];
  }

  kill(id: string): void {
    this.sessions.get(id)?.kill();
    this.sessions.delete(id);
  }

  killAll(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }
}

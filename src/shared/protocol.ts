import type { DashboardConfig } from "./config";

export type TerminalId = string;

export interface PaneLaunchConfig {
  command?: string;
  args?: string[];
  cwd?: string;
}

export interface LaunchConfig {
  panes?: PaneLaunchConfig[];
  // Legacy shape kept for backward compatibility.
  paneA?: PaneLaunchConfig;
  paneB?: PaneLaunchConfig;
}

export interface TerminalFrame {
  id: TerminalId;
  cols: number;
  rows: number;
  seq: number;
  // Canonical full-frame VT snapshot from libghostty-vt (if available).
  renderVt?: string;
  // Incremental VT patch from libghostty-vt for changed rows/cursor state.
  renderPatchVt?: string;
  // Whether Ghostty VT is currently on alternate screen buffer.
  altScreen?: boolean;
  chunk: string;
  // Raw VT stream captured for now; renderer interprets incrementally.
  vt: string;
  previewLines: string[];
  cursorVisible?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  // True when the interactive shell in this PTY currently has a live child process.
  shellBusy?: boolean;
}

export type ClientMessage =
  | {
      type: "create";
      id: TerminalId;
      cols: number;
      rows: number;
      cwd?: string;
      inheritCwdFromId?: string;
      command?: string;
      args?: string[];
    }
  | {
      type: "resize";
      id: TerminalId;
      cols: number;
      rows: number;
    }
  | {
      type: "input";
      id: TerminalId;
      data: string;
    }
  | {
      type: "snapshot";
      id: TerminalId;
    }
  | {
      type: "list";
    }
  | {
      type: "launch-config";
    }
  | {
      type: "get-config";
    }
  | {
      type: "set-config";
      config: DashboardConfig;
    }
  | {
      type: "kill";
      id: TerminalId;
    };

export type ServerMessage =
  | { type: "ready"; serverVersion: string }
  | { type: "config"; config: DashboardConfig }
  | { type: "terminal-created"; id: TerminalId }
  | { type: "terminal-exited"; id: TerminalId; exitCode: number }
  | { type: "terminal-frame"; frame: TerminalFrame }
  | { type: "terminal-list"; ids: TerminalId[] }
  | { type: "launch-config"; config: LaunchConfig }
  | { type: "error"; id?: TerminalId; message: string };

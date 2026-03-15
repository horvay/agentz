import { useSyncExternalStore } from "react";
import type { TerminalFrame } from "../shared/protocol";
import type { AvatarVisualState } from "./avatarCatalog";

export type PaneRuntimeStatus = "booting" | "running" | "exited" | "error";

export interface PaneRuntimeState {
  frame?: TerminalFrame;
  queuedFrames?: TerminalFrame[];
  avatarState?: AvatarVisualState;
  status?: PaneRuntimeStatus;
}

const EMPTY_PANE_RUNTIME: PaneRuntimeState = Object.freeze({});

class PaneRuntimeStore {
  private panes: Record<string, PaneRuntimeState> = {};
  private listeners = new Set<() => void>();
  private paneListeners = new Map<string, Set<() => void>>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  subscribePane = (id: string, listener: () => void): (() => void) => {
    const listeners = this.paneListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener);
    this.paneListeners.set(id, listeners);
    return () => {
      const current = this.paneListeners.get(id);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.paneListeners.delete(id);
      }
    };
  };

  getSnapshot = (): Record<string, PaneRuntimeState> => this.panes;

  getPane = (id: string): PaneRuntimeState => this.panes[id] ?? EMPTY_PANE_RUNTIME;

  replaceAll(next: Record<string, PaneRuntimeState>): void {
    const previousIds = new Set(Object.keys(this.panes));
    const changedIds = new Set<string>();
    for (const id of Object.keys(next)) {
      previousIds.delete(id);
      changedIds.add(id);
    }
    for (const id of previousIds) {
      changedIds.add(id);
    }
    this.panes = next;
    this.emit(changedIds);
  }

  patchPane(id: string, patch: PaneRuntimeState): void {
    const previous = this.panes[id] ?? EMPTY_PANE_RUNTIME;
    const next: PaneRuntimeState = {
      frame: patch.frame !== undefined ? patch.frame : previous.frame,
      queuedFrames: patch.queuedFrames !== undefined ? patch.queuedFrames : previous.queuedFrames,
      avatarState: patch.avatarState !== undefined ? patch.avatarState : previous.avatarState,
      status: patch.status !== undefined ? patch.status : previous.status,
    };
    if (
      next.frame === previous.frame &&
      next.queuedFrames === previous.queuedFrames &&
      next.avatarState === previous.avatarState &&
      next.status === previous.status
    ) {
      return;
    }
    this.panes = { ...this.panes, [id]: next };
    this.emit(new Set([id]));
  }

  patchMany(updates: Record<string, PaneRuntimeState>): void {
    let nextPanes = this.panes;
    let changed = false;
    const changedIds = new Set<string>();

    for (const [id, patch] of Object.entries(updates)) {
      const previous = nextPanes[id] ?? EMPTY_PANE_RUNTIME;
      const next: PaneRuntimeState = {
        frame: patch.frame !== undefined ? patch.frame : previous.frame,
        queuedFrames: patch.queuedFrames !== undefined ? patch.queuedFrames : previous.queuedFrames,
        avatarState: patch.avatarState !== undefined ? patch.avatarState : previous.avatarState,
        status: patch.status !== undefined ? patch.status : previous.status,
      };
      if (
        next.frame === previous.frame &&
        next.queuedFrames === previous.queuedFrames &&
        next.avatarState === previous.avatarState &&
        next.status === previous.status
      ) {
        continue;
      }
      if (!changed) {
        nextPanes = { ...nextPanes };
        changed = true;
      }
      nextPanes[id] = next;
      changedIds.add(id);
    }

    if (!changed) return;
    this.panes = nextPanes;
    this.emit(changedIds);
  }

  removePane(id: string): void {
    if (!(id in this.panes)) return;
    const next = { ...this.panes };
    delete next[id];
    this.panes = next;
    this.emit(new Set([id]));
  }

  private emit(changedIds: Set<string>): void {
    this.listeners.forEach((listener) => listener());
    changedIds.forEach((id) => {
      this.paneListeners.get(id)?.forEach((listener) => listener());
    });
  }
}

export const paneRuntimeStore = new PaneRuntimeStore();

export function usePaneRuntime(id: string): PaneRuntimeState {
  return useSyncExternalStore(
    (listener) => paneRuntimeStore.subscribePane(id, listener),
    () => paneRuntimeStore.getPane(id),
    () => EMPTY_PANE_RUNTIME,
  );
}

export function usePaneFrameCount(): number {
  return useSyncExternalStore(
    paneRuntimeStore.subscribe,
    () => Object.values(paneRuntimeStore.getSnapshot()).filter((pane) => pane.frame).length,
    () => 0,
  );
}

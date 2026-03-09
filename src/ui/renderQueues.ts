import type { TerminalFrame } from "../shared/protocol";

export const MAX_FRAME_QUEUE_PER_PANE = 24;

type RenderPatchKind = NonNullable<TerminalFrame["renderPatchKind"]>;

export interface TerminalRenderWorkItem {
  payload: string;
  reset: boolean;
  dedupeKey?: string;
  patchKind?: RenderPatchKind;
}

function mergeRenderFrames(current: TerminalFrame, next: TerminalFrame): TerminalFrame {
  return {
    ...current,
    ...next,
    chunk: `${current.chunk}${next.chunk}`,
    renderPatchVt: `${current.renderPatchVt ?? ""}${next.renderPatchVt ?? ""}` || undefined,
    renderPatchKind: next.renderPatchKind ?? current.renderPatchKind,
    seq: next.seq,
  };
}

function trimQueuedFrames(frames: TerminalFrame[]): TerminalFrame[] {
  if (frames.length <= MAX_FRAME_QUEUE_PER_PANE) return frames;

  for (let index = frames.length - 1; index > 0; index -= 1) {
    if (frames[index]?.renderVt) {
      return frames.slice(index);
    }
  }

  return frames;
}

export function coalesceQueuedRenderFrames(existing: TerminalFrame[], nextFrame: TerminalFrame): TerminalFrame[] {
  if (nextFrame.renderVt) return [nextFrame];

  if (nextFrame.altScreen === true && nextFrame.renderPatchKind === "alt-row-update") {
    const queue = existing.filter((queued) => queued.renderPatchKind !== "cursor-only");
    const last = queue[queue.length - 1];
    if (last?.altScreen === true && last.renderPatchKind === "alt-row-update") {
      return trimQueuedFrames([...queue.slice(0, -1), mergeRenderFrames(last, nextFrame)]);
    }
    return trimQueuedFrames([...queue, nextFrame]);
  }

  const nextQueue =
    nextFrame.renderPatchKind === "cursor-only"
      ? [...existing.filter((queued) => queued.renderPatchKind !== "cursor-only"), nextFrame]
      : [...existing, nextFrame];

  return trimQueuedFrames(nextQueue);
}

export function coalesceTerminalRenderQueue(
  existing: TerminalRenderWorkItem[],
  nextItem: TerminalRenderWorkItem,
  replaceQueuedFull = false,
): TerminalRenderWorkItem[] {
  if (replaceQueuedFull) return [nextItem];
  if (nextItem.patchKind === "cursor-only") {
    return [...existing.filter((queued) => queued.patchKind !== "cursor-only"), nextItem];
  }

  const last = existing[existing.length - 1];
  if (
    last &&
    !last.reset &&
    !nextItem.reset &&
    !last.dedupeKey &&
    !nextItem.dedupeKey &&
    last.patchKind !== "cursor-only"
  ) {
    return [...existing.slice(0, -1), { ...nextItem, payload: last.payload + nextItem.payload }];
  }

  return [...existing, nextItem];
}

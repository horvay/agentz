import { describe, expect, test } from "bun:test";
import type { TerminalFrame } from "../shared/protocol";
import {
  MAX_FRAME_QUEUE_PER_PANE,
  coalesceQueuedRenderFrames,
  coalesceTerminalRenderQueue,
} from "./renderQueues";

function frame(seq: number, partial?: Partial<TerminalFrame>): TerminalFrame {
  return {
    id: "term-1",
    cols: 120,
    rows: 40,
    seq,
    chunk: "",
    vt: "",
    previewLines: [],
    ...partial,
  };
}

describe("coalesceQueuedRenderFrames", () => {
  test("merges consecutive alt-screen row patches into one queued frame", () => {
    const first = frame(1, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "first" });
    const second = frame(2, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "second" });

    const queue = coalesceQueuedRenderFrames([first], second);

    expect(queue).toHaveLength(1);
    expect(queue[0]?.seq).toBe(2);
    expect(queue[0]?.renderPatchVt).toBe("firstsecond");
  });

  test("keeps consecutive alt-screen row patches in order", () => {
    const first = frame(1, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "first" });
    const second = frame(2, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "second" });

    const queue = coalesceQueuedRenderFrames([first], second);

    expect(queue.map((entry) => entry.seq)).toEqual([2]);
  });

  test("drops stale cursor-only patches but keeps earlier row updates", () => {
    const rowUpdate = frame(1, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "row" });
    const oldCursor = frame(2, { altScreen: true, renderPatchKind: "cursor-only", renderPatchVt: "old" });
    const nextCursor = frame(3, { altScreen: true, renderPatchKind: "cursor-only", renderPatchVt: "next" });

    const queue = coalesceQueuedRenderFrames([rowUpdate, oldCursor], nextCursor);

    expect(queue.map((entry) => entry.seq)).toEqual([1, 3]);
  });

  test("drops stale cursor-only patches before a later alt row update", () => {
    const rowUpdate = frame(1, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "row" });
    const cursor = frame(2, { altScreen: true, renderPatchKind: "cursor-only", renderPatchVt: "cursor" });
    const nextRow = frame(3, { altScreen: true, renderPatchKind: "alt-row-update", renderPatchVt: "next" });

    const queue = coalesceQueuedRenderFrames([rowUpdate, cursor], nextRow);

    expect(queue).toHaveLength(1);
    expect(queue[0]?.seq).toBe(3);
    expect(queue[0]?.renderPatchVt).toBe("rownext");
  });

  test("does not drop incremental frames just because the queue is long", () => {
    let queue: TerminalFrame[] = [];
    for (let seq = 1; seq <= MAX_FRAME_QUEUE_PER_PANE + 3; seq += 1) {
      queue = coalesceQueuedRenderFrames(queue, frame(seq, { chunk: `chunk-${seq}` }));
    }

    expect(queue).toHaveLength(MAX_FRAME_QUEUE_PER_PANE + 3);
    expect(queue[0]?.seq).toBe(1);
    expect(queue[queue.length - 1]?.seq).toBe(MAX_FRAME_QUEUE_PER_PANE + 3);
  });

  test("lets a full snapshot replace queued incremental work", () => {
    const queue = coalesceQueuedRenderFrames(
      [frame(1, { chunk: "before" }), frame(2, { renderPatchKind: "row-update", renderPatchVt: "patch" })],
      frame(3, { renderVt: "full" }),
    );

    expect(queue.map((entry) => entry.seq)).toEqual([3]);
  });
});

describe("coalesceTerminalRenderQueue", () => {
  test("merges consecutive non-cursor patch writes", () => {
    const queue = coalesceTerminalRenderQueue(
      [{ payload: "row-1", reset: false, patchKind: "alt-row-update" }],
      { payload: "row-2", reset: false, patchKind: "alt-row-update" },
    );

    expect(queue).toEqual([{ payload: "row-1row-2", reset: false, patchKind: "alt-row-update" }]);
  });

  test("keeps alt-screen row patches when a later cursor patch arrives", () => {
    const queue = coalesceTerminalRenderQueue(
      [
        { payload: "row", reset: false, patchKind: "alt-row-update" },
        { payload: "cursor-old", reset: false, patchKind: "cursor-only" },
      ],
      { payload: "cursor-new", reset: false, patchKind: "cursor-only" },
    );

    expect(queue).toEqual([
      { payload: "row", reset: false, patchKind: "alt-row-update" },
      { payload: "cursor-new", reset: false, patchKind: "cursor-only" },
    ]);
  });

  test("does not merge a row patch into a queued cursor patch", () => {
    const queue = coalesceTerminalRenderQueue(
      [{ payload: "cursor", reset: false, patchKind: "cursor-only" }],
      { payload: "row", reset: false, patchKind: "alt-row-update" },
    );

    expect(queue).toEqual([
      { payload: "cursor", reset: false, patchKind: "cursor-only" },
      { payload: "row", reset: false, patchKind: "alt-row-update" },
    ]);
  });

  test("lets queued full renders supersede earlier incremental writes", () => {
    const queue = coalesceTerminalRenderQueue(
      [{ payload: "chunk", reset: false, patchKind: "row-update" }],
      { payload: "full", reset: false },
      true,
    );

    expect(queue).toEqual([{ payload: "full", reset: false }]);
  });
});

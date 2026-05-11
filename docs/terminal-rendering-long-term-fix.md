# Terminal Rendering Long-Term Fix Plan

## Problem

agentz currently renders terminals by combining two different terminal state models:

1. The native PTY host owns the real PTY and maintains a Ghostty VT model.
2. The UI renders into xterm by replaying raw bytes, patch VT, and full VT snapshots produced from Ghostty state.

This creates a fragile situation: xterm has its own buffer, scrollback, cursor state, modes, and viewport, while Ghostty-derived frames periodically try to re-authoritatively repaint that state. During typing, focus, resize, or snapshot requests, stale full frames can race newer live input and briefly leave duplicate or ghost text.

The observed symptom: while typing, text can appear in two places, then settle back to one location after rendering catches up.

## Core Design Goal

A live xterm pane should consume one ordered terminal render stream.

Snapshots should be used for lifecycle recovery, not normal typing.

## Target Invariants

1. Active/live panes render from the ordered PTY stream or strict patches derived from that stream.
2. Full snapshots are rare and explicitly lifecycle-scoped.
3. Metadata updates cannot accidentally become render updates.
4. A stale snapshot can never overwrite newer live input.
5. When a full snapshot is applied, it is destructive and authoritative.
6. Resize/focus/input behavior should not create unnecessary full-frame churn.

## Current Pipeline

Relevant files:

- Native PTY and Ghostty state: `src/native/pty_host_posix.zig`
- Main-process session wrapper: `src/main/terminalSession.ts`
- RPC server: `src/main/server.ts`
- UI frame coalescing: `src/ui/App.tsx`
- xterm rendering: `src/ui/TerminalPane.tsx`
- Frame protocol: `src/shared/protocol.ts`

Current path:

1. User types in xterm.
2. `TerminalPane` sends an `input` RPC message.
3. `syncInputViewportToServer()` may also request a resize/snapshot.
4. Native host flushes input and/or snapshot commands.
5. Ghostty produces full or patch frames.
6. React queues/coalesces frames.
7. `TerminalPane` writes full/patch VT into xterm.

The problematic part is that normal typing can trigger forced snapshots, and full primary snapshots are currently applied non-destructively.

## Phased Plan

### Phase 1: Tactical Stability Fix

Goal: remove the visible ghosting while keeping current architecture intact.

#### 1. Make full primary snapshots clear trailing stale content

In `src/ui/TerminalPane.tsx`, update the full primary render path from:

```ts
terminal.write(`\u001b[?1049l\u001b[?25l\u001b[r\u001b[H${payloadWithModes}\u001b[?25h`, () => {
  finalizeFrame("[terminal-pane] applyFrame full primary complete", true);
});
```

to include erase-to-end after the payload:

```ts
terminal.write(`\u001b[?1049l\u001b[?25l\u001b[r\u001b[H${payloadWithModes}\u001b[J\u001b[?25h`, () => {
  finalizeFrame("[terminal-pane] applyFrame full primary complete", true);
});
```

Rationale: if the authoritative payload is shorter or positioned differently than the prior xterm buffer content, stale rows should be erased.

#### 2. Add focused regression coverage if possible

Add a unit-level replay test that simulates:

1. A full primary frame with input on one row.
2. A second shorter or repositioned full frame.
3. Verification that stale text does not remain below or above the current frame.

Candidate location:

- `src/ui/terminalRowReplay.test.ts`

If xterm/browser behavior makes this hard to test directly, add a smaller test around the generated full-primary sequence.

### Phase 2: Stop Snapshot Churn During Typing

Goal: normal input should not request forced full snapshots.

#### 1. Change `syncInputViewportToServer()` behavior

Current concern in `src/ui/TerminalPane.tsx`:

```ts
const syncInputViewportToServer = () => {
  autoFollowScrollRef.current = true;
  terminalRef.current?.scrollToBottom();
  if (IS_WINDOWS) {
    syncViewportSizeToServer({ immediate: true });
    return;
  }
  syncViewportSizeToServer({
    requestSnapshot: true,
    forceSnapshot: true,
    snapshotDelayMs: RESIZE_SNAPSHOT_DELAY_MS,
  });
};
```

Long-term desired behavior:

- Scroll local xterm to bottom on input.
- Send resize only if size changed.
- Do not force a snapshot for ordinary input.

Proposed behavior:

```ts
const syncInputViewportToServer = () => {
  autoFollowScrollRef.current = true;
  terminalRef.current?.scrollToBottom();
  syncViewportSizeToServer({ immediate: IS_WINDOWS });
};
```

#### 2. Keep snapshots for lifecycle cases

Snapshot requests should remain for:

- Initial attach.
- Reconnect/hydration.
- Switching a session from preview/background to live rendering.
- Resize completion, ideally debounced.
- Explicit recovery/desync handling.

They should not be part of the steady-state keystroke path.

### Phase 3: Add Frame Cause and Epoch Semantics

Goal: make ordering and replacement rules explicit.

Update `TerminalFrame` in `src/shared/protocol.ts` with fields similar to:

```ts
export type TerminalFrameCause =
  | "pty"
  | "snapshot"
  | "resize"
  | "attach"
  | "metadata"
  | "preview";

export interface TerminalFrame {
  // existing fields...
  renderEpoch?: number;
  frameCause?: TerminalFrameCause;
  coversPtySeq?: number;
}
```

Exact naming can change, but the concepts are:

- `renderEpoch`: increments when the render stream is intentionally reset.
- `frameCause`: explains why this frame exists.
- `coversPtySeq`: optional proof that a snapshot includes all PTY output up to a known stream sequence.

#### Frontend rules

In `src/ui/App.tsx` and `src/ui/TerminalPane.tsx`:

1. Drop frames from old epochs.
2. Do not apply a snapshot if newer PTY/render frames have already been applied and the snapshot does not cover them.
3. Let resize/attach snapshots replace queued older patches.
4. Let metadata frames update metadata only.

#### Native/server rules

In `src/native/pty_host_posix.zig` and `src/main/terminalSession.ts`:

1. Mark PTY-driven frames as `frameCause: "pty"`.
2. Mark explicit snapshot command results as `frameCause: "snapshot"` or more specifically from the command source.
3. Mark resize-triggered full frames as `frameCause: "resize"`.
4. Increment epoch when switching render mode in a way that invalidates prior patches, such as preview-only to renderable, alt-screen transition if needed, or explicit reset.

### Phase 4: Separate Render Frames From Metadata Frames

Goal: make it impossible for cwd, busy state, avatar state, or preview updates to disturb xterm rendering.

The current `TerminalFrame` mixes:

- render payloads,
- preview text,
- cwd,
- shell busy state,
- cursor modes,
- image state,
- activity text.

Split into protocol messages such as:

```ts
interface TerminalRenderFrame {
  type: "terminal-render-frame";
  id: TerminalId;
  seq: number;
  renderEpoch: number;
  cause: TerminalFrameCause;
  cols: number;
  rows: number;
  altScreen: boolean;
  payload?: string | Uint8Array;
  payloadKind: "full" | "patch" | "raw" | "cursor-only";
}

interface TerminalMetadataFrame {
  type: "terminal-metadata";
  id: TerminalId;
  cwd?: string;
  shellBusy?: boolean;
  shellBusyAtMs?: number;
  cursorVisible?: boolean;
  cursorStyle?: "block" | "underline" | "bar";
  cursorBlink?: boolean;
  mouseTrackingMode?: "none" | "x10" | "normal" | "button" | "any";
  mouseFormat?: "x10" | "utf8" | "sgr" | "urxvt" | "sgr-pixels";
}

interface TerminalPreviewFrame {
  type: "terminal-preview";
  id: TerminalId;
  previewLines: string[];
  activityText?: string;
}

interface TerminalImageFrame {
  type: "terminal-images";
  id: TerminalId;
  imageDefinitions?: TerminalImageDefinition[];
  imageRemovedIds?: number[];
  imagePlacements?: TerminalImagePlacement[];
}
```

Migration can be incremental. Keep `TerminalFrame` initially, but internally split handling in the UI:

- render queue only receives render payloads,
- activity/avatar store receives preview and metadata,
- image layer receives image updates.

### Phase 5: Make Raw PTY Bytes the Preferred Live Render Path

Goal: xterm should behave like a normal terminal emulator for active panes.

For live/renderable panes:

1. Prefer `renderPatchBytes` or raw PTY bytes when available.
2. Use Ghostty-derived VT patches only when raw bytes are unavailable or unsafe.
3. Use full VT snapshots only for attach/recovery/resize/desync.

This reduces emulator-on-emulator drift.

Implementation considerations:

- Native host already accumulates `pending_vt_bytes` in `src/native/pty_host_posix.zig`.
- The full primary path currently sometimes chooses `buildFullScrollbackVt` for non-alt-screen full frames.
- Patch path can already emit raw `pending_vt_bytes` when not alt-screen and no virtual kitty images are present.

Refine this into an explicit policy:

```text
active primary screen, no image complications: raw bytes
active primary screen with image complications: conservative patches or snapshot
active alternate screen: Ghostty-derived frame unless raw path is proven stable
preview/background: preview-only or throttled metadata
attach/recovery/resize: full snapshot
```

### Phase 6: Desync Detection and Recovery

Goal: keep the live raw path fast while still recovering safely.

Potential desync triggers:

- xterm cols/rows differ from backend cols/rows.
- alt-screen state mismatch.
- frame epoch mismatch.
- image scene mutation requiring authoritative placement.
- queue overflow or dropped frame.
- reconnect.

Recovery action:

1. Increment render epoch.
2. Clear queued patches for that session.
3. Request a full snapshot.
4. Apply it destructively.
5. Resume raw/patch stream from the new epoch.

### Phase 7: Validation Plan

Manual validation target: `opencode`.

Required cases:

1. Start one pane and run `opencode`.
2. Type continuously at a prompt and confirm no duplicate transient text.
3. Submit commands and confirm redraws remain stable.
4. Resize the pane repeatedly and confirm no stale rows remain.
5. Open two live panes with separate sessions and confirm frame isolation.
6. Switch a background terminal into live view and confirm attach snapshot is clean.
7. Test alt-screen tools:
   - `nvim`
   - `less`
   - `tmux` if available
8. Test shell scrollback after long output.
9. Test image paste if kitty image rendering is involved.

Automated checks:

- Protocol encode/decode tests for new fields.
- Render queue tests for snapshot/patch ordering.
- Tests that metadata-only frames do not enter the render queue.
- Tests that old-epoch frames are dropped.
- Tests that a full snapshot replaces queued older patches.

Run existing project checks after implementation:

```bash
bun test
```

## Recommended Implementation Order

1. Add `ESC[J` after full primary payload.
2. Stop forced snapshots on normal input.
3. Add frame cause fields.
4. Add render epoch fields.
5. Update frontend frame queue dropping/replacement rules.
6. Split render vs metadata handling internally while keeping protocol compatibility.
7. Split protocol messages once internal handling is stable.
8. Prefer raw PTY bytes for live primary rendering.
9. Add desync recovery path.

## Success Criteria

- No duplicate transient typing in active panes.
- No stale rows after full-frame redraws.
- Normal typing does not trigger full snapshots.
- Resize still recovers accurately.
- Preview/background panes continue to update without overloading rendering.
- Reconnect and live-session switching still produce clean terminal state.
- `opencode` remains stable in one-pane and two-pane setups.

# Native PTY Host Migration Plan

## Purpose

This document explains how to replace the current `node-pty`-based terminal backend with a native PTY host built in Zig, using `forkpty()` for PTY/session ownership and Ghostty VT for terminal state parsing. It is written so that a new contributor can understand the current system, the target design, the implementation steps, the risks, and the validation flow without already knowing the codebase.

## Why This Work Exists

The current terminal path has too much cross-process text marshaling.

Today the app does all of the following for every terminal session:

1. Spawns a Node subprocess from Bun.
2. Loads `node-pty` inside that subprocess.
3. Reads PTY output in the Node subprocess.
4. Base64-encodes PTY output into JSON lines.
5. Sends those JSON lines back to Bun.
6. Decodes the PTY output in Bun.
7. Re-encodes the same bytes for the native Ghostty VT bridge.
8. Decodes them again in the bridge.
9. Builds VT frames and sends another JSON/base64 payload back to Bun.

This architecture works, but it adds latency, extra memory churn, and unnecessary CPU cost in the hottest terminal data path.

## Current Architecture

### Bun / TypeScript Side

- `src/main/terminalSession.ts`
  - Owns `TerminalSession`.
  - Spawns the inline PTY worker with `node -e`.
  - Spawns the native `ghostty-vt-bridge` subprocess.
  - Batches user input and forwards it to the PTY worker.
  - Buffers VT text and forwards chunks to the native bridge.
  - Converts worker/bridge messages into `TerminalFrame` objects.
- `src/main/terminalManager.ts`
  - Owns session lifetime.
- `src/main/server.ts`
  - Receives RPC commands from the renderer.
- `src/shared/protocol.ts`
  - Defines the `TerminalFrame` shape consumed by the UI.

### Native Side

- `src/native/ghostty_bridge.zig`
  - Owns a Ghostty VT terminal instance.
  - Accepts `feed`, `resize`, and `snapshot` commands over stdin.
  - Emits full or patch frames over stdout.

### UI Side

- `src/ui/App.tsx`
  - Receives terminal frames over RPC.
- `src/ui/TerminalPane.tsx`
  - Applies `chunk`, `renderVt`, and `renderPatchVt` data to the xterm view.

## Target Architecture

Replace the split PTY-worker + VT-bridge pipeline with one native binary.

### New Native Binary

Create a native executable named `ghostty-pty-host` in `src/native/pty_host.zig`.

This binary must own all terminal-critical work for a single pane:

1. Allocate the PTY.
2. Fork the child process with `forkpty()`.
3. `exec` the requested shell or command.
4. Read PTY output from the master fd.
5. Feed those bytes directly into Ghostty VT.
6. Emit terminal frames directly to Bun.
7. Accept input/resize/kill/cwd/busy control commands from Bun.

### Responsibility Split

#### Native Host Responsibilities

- PTY lifecycle.
- Child process lifecycle.
- Environment setup (`TERM`, `COLORTERM`, cwd, argv).
- Terminal output reads.
- Ghostty VT parsing.
- Resize handling (`TIOCSWINSZ`).
- Exit detection.
- Optional cwd and busy detection.

#### Bun Responsibilities

- Session registry.
- WebSocket/RPC integration.
- `TerminalFrame` assembly if needed.
- UI-facing buffering/state that is not terminal-critical.
- Process supervision and logs.

#### UI Responsibilities

- No protocol-breaking changes if possible.
- Continue consuming `TerminalFrame` data exactly as today.

## Key Design Decision

Keep Ghostty VT.

`forkpty()` solves terminal process ownership. It does not solve VT parsing, alternate-screen behavior, cursor state, scroll regions, mouse reporting, or incremental screen diffs. Ghostty VT already solves that part well and is already integrated in the repo.

The best practical solution is therefore:

- native PTY host for process I/O
- Ghostty VT for terminal state
- one native binary instead of two subprocesses and a JS PTY worker

## Protocol Design

The quickest safe migration path is to keep newline-delimited JSON between Bun and the native host.

This is not the final performance ceiling, but it lets us:

- remove `node-pty`
- remove a whole subprocess hop
- remove Bun-to-bridge raw stream forwarding
- keep TypeScript changes localized
- preserve the current `TerminalFrame` contract

### Commands Sent From Bun To Native Host

- `input`
  - Fields: `data`, `encoding`
  - `data` remains base64 for now so binary input continues to work safely over line-oriented JSON.
- `resize`
  - Fields: `cols`, `rows`
- `flow`
  - Field: `paused`
  - Can be implemented as a no-op initially if PTY read throttling is not required immediately.
- `cwd`
  - Requests a cwd publish.
- `busy`
  - Requests a busy-state publish.
- `kill`
  - Ends the session.
- `snapshot`
  - Forces a full frame publish.

### Messages Sent From Native Host To Bun

- `frame`
  - Same payload shape currently produced by `ghostty-vt-bridge`.
- `exit`
  - Fields: `code`
- `cwd`
  - Fields: `cwd`
- `busy`
  - Fields: `busy`
- `data`
  - Optional compatibility event containing the raw terminal chunk so Bun can continue maintaining `vtBuffer` and `chunk` fields without reconstructing them from full frames.

## Compatibility Strategy

The UI expects a `TerminalFrame` with these notable fields:

- `chunk`
- `vt`
- `previewLines`
- `renderVt`
- `renderPatchVt`
- `renderPatchKind`
- `altScreen`
- cursor and mouse metadata
- `shellBusy`

To minimize renderer changes, the native host should emit enough information for `TerminalSession` to keep producing the same `TerminalFrame` structure.

Recommended compatibility approach:

1. Native host emits raw terminal chunks as `data` messages.
2. Native host emits parsed Ghostty VT frame messages in the existing `frame` JSON shape.
3. `TerminalSession` keeps the same public methods and builds the same `TerminalFrame` objects for the UI.

This gives the performance benefit of replacing `node-pty` immediately while keeping UI churn low.

## Implementation Stages

### Stage 1: Add the Native Host Binary

Create `src/native/pty_host.zig`.

Required capabilities:

- Parse startup args:
  - shell/command
  - argv JSON or argv list
  - cwd
  - cols
  - rows
- Create Ghostty terminal state.
- Call `forkpty()` with initial size.
- In the child:
  - `chdir()` to requested cwd if provided.
  - set `TERM=xterm-256color`
  - set `COLORTERM=truecolor`
  - `execvp()` requested command.
- In the parent:
  - poll stdin and PTY master fd.
  - forward PTY output into Ghostty VT.
  - emit raw `data` events.
  - emit `frame` events.
  - handle `resize`, `input`, `kill`, `cwd`, `busy`, and `snapshot`.

### Stage 2: Reuse Existing Ghostty Frame Logic

Move or copy the reusable logic from `src/native/ghostty_bridge.zig` into shared helpers inside `src/native/`.

The reusable pieces are:

- row capture
- full-frame VT generation
- patch VT generation
- plain preview generation
- cursor/mouse metadata generation
- frame JSON writing

Avoid rewriting that logic from scratch unless required by Zig API constraints.

### Stage 3: Wire `TerminalSession` To The Native Host

Refactor `src/main/terminalSession.ts`.

Changes required:

- Remove `PTY_WORKER_SOURCE`.
- Remove `resolvePackagedPtyRoot()`.
- Replace `resolveBridgePath()` with `resolveNativeHostPath()`.
- Spawn `ghostty-pty-host` directly.
- Read one stdout stream instead of separate worker and bridge streams.
- Continue parsing line-delimited JSON.
- Handle message types:
  - `data`
  - `frame`
  - `exit`
  - `cwd`
  - `busy`
- Keep the existing `input()`, `resize()`, `getCwd()`, `kill()`, and `snapshot()` behavior from the TypeScript caller's perspective.

### Stage 4: Build and Packaging Updates

Update:

- `src/native/build.zig`
  - build both `ghostty-vt-bridge` and `ghostty-pty-host` during migration, or only `ghostty-pty-host` once fully switched.
- `src/native/build.zig.zon`
  - include the new source file in package paths.
- `electrobun.config.ts`
  - package the new host binary.
- `package.json`
  - stop calling `prepare:node-pty`
  - make dev/release scripts build the native host
- `.github/workflows/release.yml`
  - build/package the new host

### Stage 5: Remove `node-pty`

After the host is proven working:

- remove `scripts/prepare-node-pty.ts`
- remove `node-pty` packaging copies
- remove `node-pty` dependency from `package.json`
- remove any fallback path logic that tries to load it

## Native Host Detailed Behavior

### Startup Contract

The initial version can mirror the current `TerminalSession` constructor inputs:

- executable path / command
- args array
- cwd
- cols
- rows

These can be passed as argv to the host process.

### Event Loop

Use `poll()` to watch:

- stdin for Bun control messages
- PTY master fd for terminal output

Every time PTY bytes arrive:

1. read bytes from the master fd
2. emit a `data` message with base64 payload
3. feed those bytes into Ghostty VT
4. emit a frame message
5. check whether child exit status changed

### Resize Handling

For `resize`:

1. call `ioctl(master_fd, TIOCSWINSZ, &winsize)`
2. send `SIGWINCH` to the child process group if needed
3. resize Ghostty VT state
4. emit a forced full frame

### Input Handling

For `input`:

1. decode base64 payload
2. write bytes to PTY master fd
3. optionally republish busy state shortly after input if that signal is still process-tree based

### CWD Detection

For Linux, use `/proc/<pid>/cwd` and `realpath`.

If the binary is also built on macOS later, add one of the following:

- `proc_pidinfo`
- shell integration escape sequences
- a platform-specific fallback strategy

The first Linux implementation can match the current behavior closely.

### Busy Detection

Initial Linux implementation can match the current worker behavior:

- inspect `/proc/<pid>/task/<pid>/children`
- fallback to `pgrep -P` if absolutely needed

Long-term better option:

- shell integration markers such as OSC 133 or explicit shell hooks

## Error Handling Requirements

The native host must never silently hang when exec fails.

Handle these cases explicitly:

- command missing
- cwd missing or inaccessible
- `forkpty()` failure
- stdin pipe closed
- PTY master read error
- `execvp()` failure in child

Recommended behavior:

- write a readable error to stderr for diagnostics
- emit an `exit` event when the child dies or startup fails
- exit non-zero if the host itself fails before session startup completes

## File-Level Change List

### New Files

- `docs/native-pty-host-plan.md`
- `src/native/pty_host.zig`
- optionally `src/native/frame_protocol.zig` or `src/native/terminal_frame.zig` if helper extraction makes maintenance easier

### Modified Files

- `src/main/terminalSession.ts`
- `src/native/build.zig`
- `src/native/build.zig.zon`
- `package.json`
- `electrobun.config.ts`
- `.github/workflows/release.yml`

### Removed Later

- `scripts/prepare-node-pty.ts`
- `node-pty` dependency and packaging rules

## Validation Strategy

### Fast Validation

1. Build native host:
   - `bun run native:build:bridge`
2. Run a direct smoke test against `TerminalSession`:
   - `bun run test:opencode`

### Screenshot Validation

At least one screenshot test must pass before this migration is considered working.

Recommended order:

1. `bun run test:shell:scroll:screenshot`
   - simplest shell-driven validation
2. `bun run test:nvim:screenshot`
   - validates alternate screen, cursor movement, and TUI rendering
3. `bun run test:opencode:screenshot`
   - validates more complex interactive CLI behavior

### Manual Validation

Use the repo's required workflow from `AGENTS.md`:

1. Launch the app in dev mode.
2. Open at least one pane.
3. Run `opencode` inside a pane.
4. Verify typing, submission, cursor redraw, resize behavior, and scrollback.
5. Repeat with two panes to confirm session isolation.

## Risks And Mitigations

### Risk: PTY Host Emits Frames Too Often

Mitigation:

- keep the current patch/full frame logic from `ghostty_bridge.zig`
- only emit forced full frames on resize/snapshot/startup

### Risk: JSON/Base64 Is Still Not Ideal

Mitigation:

- accept it in the first native-host version
- remove it later with a binary protocol once correctness is restored

### Risk: Zig/ghostty API Drift

Mitigation:

- move shared frame logic carefully
- compile early and often
- keep helper functions small and well-isolated

### Risk: CWD/Busy Semantics Drift From Current Behavior

Mitigation:

- copy the current Linux `/proc` approach first
- improve semantics only after parity is reached

### Risk: Broken Packaged Builds

Mitigation:

- update `electrobun.config.ts`
- verify dev path and packaged path resolution separately

## Definition Of Done

This migration is done when all of the following are true:

1. `TerminalSession` no longer depends on `node-pty`.
2. A native `forkpty()` host owns terminal process creation.
3. Ghostty VT is still used for frame generation.
4. The app launches panes and accepts input correctly.
5. At least one screenshot test passes.
6. `opencode` or another interactive TUI works without display/input regression.
7. Packaging includes the new native host.

## Future Improvements After Parity

These are intentionally out of scope for the first working migration, but they are the next logical steps:

1. Replace line-delimited JSON with a binary framed protocol.
2. Remove raw `data` compatibility messages if Bun no longer needs them.
3. Move more `TerminalFrame` assembly into native code.
4. Add a Windows ConPTY backend under the same host protocol.
5. Replace busy detection with shell integration markers.
6. Consider bypassing xterm entirely later if the app moves to a more direct renderer.

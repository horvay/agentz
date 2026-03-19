# agentz App

Project bible and implementation guide.

- Last updated: 2026-03-02
- Target platforms: Linux first, then macOS and Windows
- Status: architectural plan + bootstrap instructions

---

## 1) Project Overview

Build a desktop app that:

- Runs multiple independent Ghostty-backed terminals in a tiled, resizable layout.
- Exposes full terminal state (cell grid, styles, cursor, scrollback) in real time.
- Adds a live avatar UI that can react to terminal events.
- Uses one codebase for Linux/macOS/Windows.

### Non-goals for MVP

- Pixel-perfect parity with native Ghostty surfaces on day one.
- Plugin architecture, cloud sync, or team collaboration features.

### Intended Use Case

Each pane is a real PTY-backed terminal session, not a plain textbox with command echoing.
Primary workflows include interactive CLI apps (for example `opencode`, `claude`, `codex`, shells, and TUI tools) that require proper terminal semantics.

To support this, implementation must preserve:

- PTY-based process execution per pane.
- ANSI/VT control handling (cursor movement, alternate screen, colors, scroll regions).
- Interactive input modes (raw mode, bracketed paste, control sequences).
- Correct resize events (`SIGWINCH` / equivalent behavior per platform).
- Scrollback and screen-state fidelity from `libghostty-vt`.

---

## 2) Core Decisions

| Area | Choice | Why |
|---|---|---|
| Desktop framework | Electrobun | Lightweight desktop shell with Bun + native WebView |
| Terminal engine | `libghostty-vt` | Robust VT parsing/state model with direct buffer access |
| UI layer | React + TypeScript in WebView | Fast iteration for layout, controls, and animations |
| Native glue | Zig | Clean integration with C APIs and good cross-platform story |
| Rendering approach | Phase 1: canvas/WebGL from VT state; Phase 2: optional native surfaces | Fast path first, native parity later |
| IPC model | Typed RPC between renderer and main/native layer | Clear API boundary and easier testing |

---

## 3) High-Level Architecture

```text
Desktop App (Electrobun)
├─ Main process (Bun + Zig bridge)
│  ├─ PTY/session manager (N terminals)
│  ├─ libghostty-vt integration
│  └─ RPC handlers (create terminal, send input, resize, read frame)
├─ Renderer (native WebView)
│  ├─ Tiling layout + panes
│  ├─ Terminal canvas/WebGL views
│  ├─ Avatar component
│  └─ RPC client
└─ Optional later: native Ghostty surfaces per pane
```

### Data Flow

1. Renderer sends input/resize events to main process via RPC.
2. Main process writes to PTY and advances VT state.
3. VT state deltas/full frames are returned (or pushed) to renderer.
4. Renderer paints terminal frame and updates avatar state.

---

## 4) Tooling and Dependencies

Treat these as recommended baseline versions. Pin exact versions in `package.json`/lockfiles when you bootstrap.

### Core

- Electrobun `1.x`
- Bun (installed with project tooling)
- Zig `0.14.x`

### Ghostty

- Repository: `https://github.com/ghostty-org/ghostty`
- Library target: `libghostty-vt`
- Useful references:
  - `include/ghostty/vt.h`
  - `example/vt-simple/`
  - `example/vt-html/`

### UI

- React + TypeScript
- Tiling/layout: `react-grid-layout` (or equivalent)
- Avatar animation: `framer-motion` or `lottie-web`
- Terminal renderer: custom canvas/WebGL (optional fallback: xterm.js)

---

## 5) Prerequisites

1. Bun
   - `curl -fsSL https://bun.sh/install | bash`
2. Zig `0.14.x`
3. Git
4. Platform build tools (`gcc`, `make`, headers, etc.)

---

## 6) Quick Start

### Step 1: Create app skeleton

```bash
mkdir agentz
cd agentz
bunx create-electron-app
```

Choose React + TypeScript template if prompted.

### Step 2: Add Ghostty source

```bash
git submodule add https://github.com/ghostty-org/ghostty.git deps/ghostty
cd deps/ghostty
git checkout main
cd ../..
```

### Step 3: Build `libghostty-vt`

```bash
cd deps/ghostty
zig build libghostty-vt -Doptimize=ReleaseFast
cd ../..
```

### Step 4: Install frontend dependencies

```bash
bun add react react-dom framer-motion lottie-web
bun add -d typescript @types/react @types/react-dom
```

### Step 5: Run development build

```bash
bun run dev
```

---

## 7) Suggested Repository Structure

```text
agentz/
├─ src/
│  ├─ main/               # Bun main process + RPC handlers
│  │  ├─ index.ts
│  │  ├─ rpc.ts
│  │  └─ terminals.ts
│  ├─ native/             # Zig bridge and build files
│  │  ├─ ghostty.zig
│  │  └─ build.zig
│  └─ ui/
│     ├─ App.tsx
│     ├─ TerminalView.tsx
│     ├─ Avatar.tsx
│     └─ layout/
├─ deps/
│  └─ ghostty/            # git submodule
├─ Electron builder config (package.json)
├─ package.json
├─ bun.lockb
└─ bible.md
```

---

## 8) Code Skeletons (Illustrative)

These snippets are architecture-oriented examples, not drop-in final code.

### Zig terminal wrapper (`src/native/ghostty.zig`)

```zig
const std = @import("std");
const vt_mod = @import("ghostty").vt; // adjust include path to your setup

pub const Terminal = struct {
    alloc: std.mem.Allocator,
    vt: vt_mod.VT,
    pty: *anyopaque, // replace with your PTY type

    pub fn init(alloc: std.mem.Allocator, cols: u16, rows: u16) !Terminal {
        var term = Terminal{
            .alloc = alloc,
            .vt = try vt_mod.VT.init(alloc, .{ .cols = cols, .rows = rows }),
            .pty = undefined,
        };
        // TODO: spawn PTY and bind to term.pty
        return term;
    }

    pub fn readScreen(self: *Terminal) vt_mod.Screen {
        return self.vt.screen();
    }

    pub fn exportHtml(self: *Terminal) ![]u8 {
        return try self.vt.toHTML(self.alloc);
    }
};
```

### Typed RPC surface (`src/main/rpc.ts`)

```ts
type ScreenBuffer = unknown; // replace with concrete model

interface TerminalApi {
  create(id: string, cols: number, rows: number): Promise<void>;
  resize(id: string, cols: number, rows: number): Promise<void>;
  sendInput(id: string, data: string): Promise<void>;
  getBuffer(id: string): Promise<ScreenBuffer>;
}
```

### Renderer polling loop (`src/ui/TerminalView.tsx`)

```tsx
import { useEffect, useRef } from "react";

export function TerminalView({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const timer = setInterval(async () => {
      // TODO: call RPC and draw frame to canvas
      // const buffer = await rpc.terminals.getBuffer(id);
      // renderBufferToCanvas(buffer, canvasRef.current);
    }, 16);

    return () => clearInterval(timer);
  }, [id]);

  return <canvas ref={canvasRef} className="terminal-canvas" />;
}
```

---

## 9) Delivery Roadmap

1. MVP
   - Two panes, independent shells, input/output loop working.
   - Basic buffer render in canvas.
   - Static avatar panel.
   - Validation target: run `opencode` interactively in at least one pane.
2. Interaction pass
   - Resizable splits, tabbed sessions, keyboard shortcuts.
   - Avatar reactions from terminal events.
3. Performance pass
   - Frame diffing, throttled updates, backpressure handling.
   - Optional migration to native surfaces where justified.
4. Packaging/release
   - Build pipelines for Linux/macOS/Windows.
   - Installer + update strategy.

---

## 10) Risks and Open Questions

- ABI stability and integration friction between app runtime and Ghostty build outputs.
- Cross-platform PTY behavior differences (especially Windows).
- Render performance at high throughput with many panes.
- Whether native surfaces are necessary after Phase 1 optimization.

Track these as explicit issues once implementation starts.

---

## 11) Troubleshooting

- Build cannot find Ghostty headers/libraries:
  - Verify include/library paths in Zig build config.
  - Confirm `libghostty-vt` artifacts exist after build.
- Blank WebView:
  - Verify renderer entry URL/path in Electrobun config.
- High CPU while rendering:
  - Reduce full-frame polling frequency.
  - Move to delta-based frame updates.
- Input lag:
  - Inspect RPC roundtrip and batching strategy.

---

## 12) Next Actions

1. Bootstrap repository and confirm one terminal pane renders text.
2. Define concrete `ScreenBuffer` schema shared by Zig and TypeScript.
3. Add first integration test: launch `opencode`, send input, and verify interactive output is rendered correctly.

Once those three pass, proceed to multi-pane layout and avatar reactions.

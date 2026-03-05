# Ghostty Multi-Terminal Dashboard MVP

MVP desktop app scaffold with Electrobun and real process-backed terminal sessions in a multi-pane tiled UI.

## Setup

```bash
bun install
bun run native:build
bun run native:build:bridge
```

## Run

```bash
# Standard dev run (software rendering fallback enabled on Linux)
bun run dev
```

### Dynamic Terminals + Navigation

- The app starts with one or more terminal panes based on launch config (defaults to one).
- Press `Ctrl+Shift+N` to open another terminal pane.
- Press `Ctrl+Shift+Left` / `Ctrl+Shift+Right` to focus previous/next pane.
- The focused pane is centered in the horizontal strip.
- Drag each pane's right-edge resize handle to change its width (persisted per pane ID).

## Launch With Terminal Commands (CLI Args)

Use `dev:launch` to pass startup commands per pane.

```bash
# Start one pane with opencode
bun run dev:launch -- --pane-1-opencode

# Start multiple panes with different commands
bun run dev:launch -- --pane-1-opencode --pane-2-cmd=bash --pane-2-args=-lc,ls
```

Supported launch flags:
- `--pane-<n>-cmd=<command>`
- `--pane-<n>-args=<arg1,arg2,...>`
- `--pane-<n>-cwd=<path>`
- `--pane-<n>-opencode` (shorthand for command = `opencode`)

Legacy flags still work:
- `--pane-a-*`
- `--pane-b-*`

## Screenshot Check (Render Quality)

```bash
xdotool search --name "Ghostty Multi-Terminal Dashboard" | head -n 1
import -window $(xdotool search --name "Ghostty Multi-Terminal Dashboard" | head -n 1) /tmp/ghostty-dashboard.png
```

## Validate with opencode

Run the automated smoke test:

```bash
bun run test:opencode
```

Run the visual screenshot test (launches first pane with `opencode`, types `hi`, then captures a screenshot):

```bash
bun run test:opencode:screenshot
# optional output path:
bun run test:opencode:screenshot -- --out=screenshots/opencode-hi-custom.png
```

By default screenshots are written to `screenshots/` with stable filenames. Re-running the same test overwrites the existing file instead of creating extra screenshots.

Expected result:
- command exits successfully,
- output shows signs of the interactive `opencode` TUI startup (not `--help`),
- the test sends `hi` into `opencode` and verifies that input appears in terminal output,
- process lifecycle completes cleanly.

## Key Paths

- `src/main/` - main process, terminal manager, RPC server
- `src/ui/` - React UI and terminal pane rendering
- `src/native/` - Zig bridge scaffold against `libghostty-vt`
- `deps/ghostty/` - Ghostty source used to build `libghostty-vt`

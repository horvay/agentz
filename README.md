# Ghostty Multi-Terminal Dashboard MVP

MVP desktop app scaffold with Electrobun, real process-backed terminal sessions, and a two-pane terminal UI.

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

## Launch With Terminal Commands (CLI Args)

Use `dev:launch` to pass startup commands per pane.

```bash
# Start pane A with opencode
bun run dev:launch -- --pane-a-opencode

# Start pane A and pane B with different commands
bun run dev:launch -- --pane-a-opencode --pane-b-cmd=bash --pane-b-args=-lc,ls
```

Supported launch flags:
- `--pane-a-cmd=<command>`
- `--pane-a-args=<arg1,arg2,...>`
- `--pane-a-cwd=<path>`
- `--pane-b-cmd=<command>`
- `--pane-b-args=<arg1,arg2,...>`
- `--pane-b-cwd=<path>`
- `--pane-a-opencode` (shorthand for pane A command = `opencode`)
- `--pane-b-opencode` (shorthand for pane B command = `opencode`)

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

Run the visual screenshot test (launches pane A with `opencode`, types `hi`, then captures a screenshot):

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

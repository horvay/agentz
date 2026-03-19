# agentz

## Basic Description

Agentz is a desktop app for running multiple real PTY-backed terminal sessions side by side in a fast tiled workspace, with native-style alternate-screen behavior for tools like `nvim`, `less`, `tmux`, and `opencode`.

## Video

Video coming soon.

Add your demo link here when it is ready:

```md
[Watch the demo](PASTE_VIDEO_LINK_HERE)
```

## Run Down of Features

- Multiple real terminal panes in one desktop window
- PTY-backed sessions, not fake terminal emulation shortcuts
- Better fullscreen terminal app behavior via the Ghostty VT bridge
- Working alternate-screen mouse input for apps like `nvim`
- Working normal-shell scrollback and prompt behavior
- Resizable panes with keyboard shortcuts for pane management
- Per-pane working directory tracking
- Optional reactive avatar strip UI
- Single-file Windows and Linux release artifacts, plus macOS release assets

## How to Download

Open the latest release here:

- `https://github.com/horvay/agentz/releases/latest`

### What each release file is

The exact filenames may vary a little by channel (`stable` vs `canary`) and architecture, but the release assets follow the same pattern.

- `*.dmg` - Standard macOS installer disk image. This is the easiest option for most macOS users.
- `*.exe` - Windows installer. Download one file, run it, and Agentz installs normally.
- `*.AppImage` - Linux single-file app. Download one file, mark it executable, and run it.

### Which file should you pick?

- macOS: download the `*.dmg`.
- Windows: download the `*.exe`.
- Linux: download the `*.AppImage`.

## Quick Start

### Windows

1. Download the latest `*.exe`.
2. Run the installer.
3. Launch Agentz from the Start menu or desktop shortcut if created.

### Linux

1. Download the Linux `*.AppImage` asset from the latest release.
2. Mark it executable.
3. Run it:

```bash
chmod +x ./agentz-*.AppImage
./agentz-*.AppImage
```

### macOS

1. Download the latest `*.dmg`.
2. Install the app normally.
3. Launch Agentz.

## Keyboard Shortcuts

- `Ctrl+Shift+N` - open a new pane
- `Ctrl+Shift+Left` - focus the previous pane
- `Ctrl+Shift+Right` - focus the next pane
- `Ctrl+Shift+W` - close the active pane

## Launch With Specific Commands

Use `dev:launch` to start panes with predefined commands.

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
- `--pane-<n>-opencode`

Legacy flags still work:

- `--pane-a-*`
- `--pane-b-*`

## For Developers

### Setup

```bash
bun install
bun run native:build
```

### Run in development

```bash
bun run dev
```

### Run web mode locally

```bash
bun run web
```

This serves the UI on `127.0.0.1:5173` and keeps the terminal RPC backend bound to `127.0.0.1:4599`.
Remote/network access is intentionally disabled until that path is secured.

### Build release artifacts locally

```bash
bun run release:portable
bun run release:stable
```

### Validate terminal behavior

```bash
bun run test:opencode
```

Useful screenshot checks:

```bash
bun run test:opencode:screenshot
bun run test:nvim:screenshot
bun run test:shell:scroll:screenshot
```

## Notes

### Linux/X11 input focus note

On some Linux/X11 setups, Electrobun may not forward keyboard input until the first pointer interaction. Agentz applies a one-time startup nudge using `xdotool` to handle that automatically.

To disable it:

```bash
AGENTZ_DISABLE_X11_INPUT_NUDGE=1 bun run dev
```

## Project Layout

- `src/main/` - main process, terminal manager, PTY sessions, RPC server
- `src/ui/` - React UI, pane layout, xterm rendering, input handling
- `src/native/` - Zig Ghostty VT bridge
- `deps/ghostty/` - Ghostty source used for VT behavior research and bridge integration
- `scripts/` - smoke tests, screenshot tests, packaging helpers

## What Agentz is aiming for

Agentz is trying to make terminal-heavy workflows feel good in a pane-based desktop app without giving up the behavior people expect from real terminals.

That means the bar is not just "it renders text". The goal is:

- real PTY sessions
- correct-ish fullscreen app behavior
- working mouse input in terminal TUIs
- normal shell scrollback that feels native
- smooth pane management for multi-agent or multi-tool workflows

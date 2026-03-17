# Agentz

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
- Linux portable and installer-style release builds, plus macOS release assets

## How to Download

Open the latest release here:

- `https://github.com/horvay/agentz/releases/latest`

### What each release file is

The exact filenames may vary a little by channel (`stable` vs `canary`) and architecture, but the release assets follow the same pattern.

- `*.dmg` - Standard macOS installer disk image. This is the easiest option for most macOS users.
- `*.app.tar.zst` - Compressed macOS app bundle. Use this if you want the raw `.app` instead of a DMG.
- `*-linux-*-*.tar.zst` - Portable Linux app bundle. Extract it anywhere and run the launcher inside it.
- `*-linux-*-*-Setup.tar.gz` - Linux setup bundle with an `installer` script. This installs the app into your user directory and creates a user-level `agentz` launcher in `~/.local/bin`.

### Which file should you pick?

- macOS: download the `*.dmg` unless you specifically want the raw app bundle.
- Linux: download the `*-Setup.tar.gz` if you want a simple user install; download the `*.tar.zst` if you want a portable unpack-and-run build.
- Windows: native Windows support is in progress; if you build from source, it now uses the native `ghostty-pty-host.exe` path.

## Quick Start

### Linux portable build

1. Download the Linux `*.tar.zst` asset from the latest release.
2. Extract it.
3. Run the launcher from the extracted app folder.

### Linux setup bundle

1. Download the Linux `*-Setup.tar.gz` asset.
2. Extract it.
3. Run:

```bash
./installer
```

The installer will:

- install the app under your user directory
- create `~/.local/bin/agentz`
- print the final launch path

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

### Run web mode on your local network

```bash
bun run web
```

This serves the UI on port `5173` and the terminal RPC backend on port `4599`.
From another computer on the same network, open:

```bash
http://<your-local-ip>:5173
```

Example:

```bash
http://192.168.1.42:5173
```

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
GHOSTTY_DASHBOARD_DISABLE_X11_INPUT_NUDGE=1 bun run dev
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

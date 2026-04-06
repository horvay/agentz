# agentz

agentz is a desktop terminal workspace built around a live avatar strip that shows what each pane is doing at a glance while still giving you real PTY-backed terminals underneath.

## Demo

[![Watch the agentz demo on YouTube](https://img.youtube.com/vi/K7V8-OH8DiE/hqdefault.jpg)](https://youtu.be/K7V8-OH8DiE)

Watch the full demo on YouTube: https://youtu.be/K7V8-OH8DiE

The avatar strip is the main UI. Each pane gets an assigned avatar, and that avatar updates in real time to reflect pane activity:

- `idle` when the pane is waiting
- `working` when the pane is actively running or streaming work
- `question` when the pane needs input or approval
- `calling` when the pane is delegating or using sub-agents

Under the strip, each avatar maps to a real terminal pane with native-style alternate-screen behavior for tools like `nvim`, `less`, `tmux`, and `opencode`.
Panes can also keep a stack of background terminals so you can cycle between the main session and layered side work without losing context.

## Features

- Live avatar strip that lets you scan pane activity without reading every terminal
- Real-time avatar state changes for idle, working, question, and calling states
- Stable avatar-to-pane mapping so each pane keeps a recognizable identity
- 10 named avatars to assign to panes: Marmalade, Nyx, Byte, Glimmer, Wisp, Rufus, Selene, Bamboo, Mochi, and Pyra
- Multiple real terminal panes in one desktop window
- Per-pane background terminal stacks you can cycle through without replacing the main session
- PTY-backed sessions, not fake terminal emulation shortcuts
- Native-style alternate-screen behavior through the Ghostty VT bridge
- Working mouse input for terminal TUIs like `nvim`
- Shell scrollback and prompt behavior that stays readable
- Resizable panes with drag handles
- Per-pane working directory tracking with automatic folder color assignments
- Inactive pane previews showing shell output when not focused
- Image paste support - paste images from clipboard directly into the terminal (writes to temp file and sends path)
- Settings modal for customization
- Fully customizable keyboard shortcuts
- Configurable default pane width
- Adjustable visible live pane count (1-9, odd numbers for best layout)

## Downloads

Latest release:

- `https://github.com/horvay/agentz/releases/latest`

Release assets:

- `*.dmg` for macOS
- `*.exe` for Windows
- `*.AppImage` for Linux

## Install And Run

### macOS

1. Download the latest `*.dmg`.
2. Install the app normally.
3. Launch `agentz`.

Use the `.dmg` release asset on macOS rather than a raw app bundle or zip export.

### Windows

1. Download the latest `*.exe`.
2. Run the installer.
3. Launch `agentz`.

### Linux

1. Download the latest `*.AppImage`.
2. Mark it executable.
3. Run it.

```bash
chmod +x ./agentz-*.AppImage
./agentz-*.AppImage
```

## Keyboard Shortcuts

All shortcuts are customizable in the Settings modal (Ctrl+Shift+P):

| Action | Default Shortcut |
|--------|-----------------|
| Add pane | `Ctrl+Shift+N` |
| Cycle pane terminals | `Ctrl+B` |
| Add background terminal | `Ctrl+Shift+B` |
| Focus previous pane | `Ctrl+Shift+ArrowLeft` |
| Focus next pane | `Ctrl+Shift+ArrowRight` |
| Move pane left | `Ctrl+Alt+Shift+ArrowLeft` |
| Move pane right | `Ctrl+Alt+Shift+ArrowRight` |
| Close pane | `Ctrl+Shift+W` |
| Open settings | `Ctrl+Shift+P` |

Shortcuts require at least one modifier key and are validated for conflicts.

## Development

### Setup

```bash
bun install
bun run native:build
```

### Run The Desktop App

```bash
bun run dev
```

### Run Web Mode

```bash
bun run scripts/web-dev.ts
```

Web mode stays local-only:

- UI: `http://127.0.0.1:5173`
- RPC backend: `ws://127.0.0.1:4599`

Remote/network access is intentionally disabled until that path is secured.

Web mode now requires a browser login backed by the machine account on the host OS:

- Linux: PAM-backed login using the same account you use to sign into the machine
- macOS: OpenDirectory-backed login using the same account you use to sign into the machine
- Windows: Win32 `LogonUser` login using the same account you use to sign into the machine

Linux-only option:

- `AGENTZ_PAM_SERVICE` overrides the PAM service name used for Linux authentication

### Launch Panes With Predefined Commands

```bash
# Start one pane with opencode
bun run dev:launch -- --pane-1-opencode

# Start multiple panes with different commands
bun run dev:launch -- --pane-1-opencode --pane-2-cmd=bash --pane-2-args=-lc,ls
```

Supported flags:

- `--pane-<n>-cmd=<command>`
- `--pane-<n>-args=<arg1,arg2,...>`
- `--pane-<n>-cwd=<path>`
- `--pane-<n>-opencode`

## Testing

Primary interactive validation target:

- `opencode`

Manual validation workflow:

```bash
bun run dev
```

Then:

- open at least one terminal pane
- start `opencode` inside the pane
- verify typing, submission, cursor redraw, resize behavior, and scrollback
- repeat with two panes to confirm session isolation

## Release Builds

Build a local release artifact:

```bash
bun run release:stable
```

Current packaged outputs:

- Linux: `AppImage`
- macOS: `dmg`
- Windows: `nsis` installer

Packaged Linux `AppImage`, macOS, and Windows releases check GitHub Releases for updates, ask before downloading, and ask again before restarting to install.

Release publishing needs to include the updater feed files alongside those installers:

- Linux: `latest-linux*.yml`
- macOS: `zip` plus `latest-mac*.yml`
- Windows: `latest.yml`

You can turn update prompts on or off in Settings under App Updates.

### macOS Release Signing

GitHub Releases should only publish macOS installers from a signed and notarized CI build.

Required repository secrets for the macOS release job:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY_P8`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

For local development builds on macOS, Gatekeeper quarantine can block an unsigned app bundle. If you trust your own local build and need to test it manually:

```bash
xattr -dr com.apple.quarantine /path/to/agentz.app
```

## Configuration

agentz stores its configuration at:

- Linux: `~/.config/agentz/config.json` (XDG compliant, or `XDG_CONFIG_HOME/agentz/config.json`)
- macOS: `~/.config/agentz/config.json`
- Windows: `%APPDATA%\agentz\config.json`

The config file is created automatically on first run. You can edit it directly or use the Settings modal (Ctrl+Shift+P).

## Notes

### Linux X11 Focus

On some Linux/X11 setups, Electrobun may not forward keyboard input until the first pointer interaction. agentz applies a one-time startup nudge using `xdotool` to handle that automatically.

To disable it:

```bash
AGENTZ_DISABLE_X11_INPUT_NUDGE=1 bun run dev
```

## Project Layout

- `src/main/` main process, terminal manager, PTY sessions, RPC server
- `src/ui/` React UI, pane layout, xterm rendering, input handling
- `src/native/` Zig native PTY host and Ghostty VT integration
- `deps/ghostty/` Ghostty source used for VT behavior research and bridge integration
- `scripts/` smoke tests, screenshot tests, and packaging helpers

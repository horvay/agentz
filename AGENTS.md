# AGENTS

Ghostty Multi-Terminal Dashboard is a desktop app that runs multiple real PTY-backed terminal sessions in a tiled interface with full VT state rendering and an optional reactive avatar UI.

## UI Implementation Rule

Always use the `frontend-design` skill when creating or modifying any UI, including components, layouts, styling, or visual interaction behavior.

## Testing

Use `opencode` as the primary interactive validation target for terminal behavior.

1. Launch the app in dev mode and open at least one terminal pane.
2. Start `opencode` inside that pane and confirm it initializes without display/input issues.
3. Verify interactive behavior:
   - typing and command submission work normally,
   - cursor movement and redraws render correctly,
   - resize events do not break the session,
   - scrollback remains readable and consistent.
4. Repeat with two panes running separate sessions to confirm isolation.

## Visual Debugging Pattern

When diagnosing rendering or blank-screen issues, always use this loop:

1. Run the app (`bun run dev`) and wait for the window to appear.
2. Capture a screenshot of the app window (use CLI tools such as `xdotool` + `import` on X11/Xwayland, or `grim`/`slurp` on Wayland).
3. Read the screenshot file to confirm what is actually rendered (for example: all white, partial UI, or fully loaded UI).
4. Apply a fix, rerun the app, and repeat screenshot capture/inspection until the visual issue is resolved.

## Execution Persistence Rule

When solving a user request, continue iterating until the task is fully complete or all discovered issues are fixed. Do not stop to ask whether you should continue unless a true blocker requires user input or approval.

## No Fallbacks Rule

Do not add fallback implementations, compatibility shims, alternate rendering paths, or backup behaviors unless the user explicitly asks for a fallback. Fix the real path first and keep the implementation single-path by default.

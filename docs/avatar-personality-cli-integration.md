# Avatar Personality Injection For Claude Code, OpenCode, and Codex

Last updated: March 28, 2026

## Why This Document Exists

This document records the research and recommended implementation strategy for injecting avatar personality prompts into the terminal UIs launched by `agentz`.

The goal is simple:

- each pane has an assigned avatar,
- each avatar has a small personality markdown file,
- when the pane launches an AI terminal UI such as Claude Code, OpenCode, or Codex,
- `agentz` should append or inject that avatar personality into the tool's system/developer instruction flow,
- without mutating the user's real config or project files.

This file is intentionally verbose so we do not have to re-research the CLIs later.

## Current Avatar Personality Assets

Avatar personalities currently live at:

- `assets/avatars/<avatar>/personality.md`

Examples:

- `assets/avatars/selene/personality.md`
- `assets/avatars/mochi/personality.md`
- `assets/avatars/rufus/personality.md`

These are written in prompt-ready second-person form such as:

> You are a scruffy tan pup named Rufus...

## Current `agentz` Launch Model

Today, `agentz` can launch a pane with:

- `command`
- `args`
- `cwd`

It does **not** currently support per-pane environment variables in its launch protocol.

Relevant local code:

- pane launch shape: `src/shared/protocol.ts`
- UI sends create requests: `src/ui/App.tsx`
- RPC server creates sessions: `src/main/server.ts`
- terminal manager passes launch values through: `src/main/terminalManager.ts`
- terminal session builds the child environment: `src/main/terminalSession.ts`

Important implication:

- if we want robust prompt injection for Claude Code, OpenCode, and Codex, we should add per-pane `env` support,
- otherwise we will be forced into shell-wrapper tricks such as `bash -lc 'FOO=bar opencode'`.

That would work, but first-class `env` support is cleaner and safer.

## Research Summary

We researched this in three ways:

1. Official documentation on the public web.
2. Local CLI help output for installed tools.
3. Source inspection of cloned upstream repos saved in:
   - `.research/codex`
   - `.research/opencode`

### Official docs and references

Claude Code:

- CLI reference: <https://code.claude.com/docs/en/cli-reference>
- Memory docs: <https://code.claude.com/docs/en/memory>

Codex:

- AGENTS.md guide: <https://developers.openai.com/codex/guides/agents-md>
- Config docs entrypoint: <https://developers.openai.com/codex/config-reference>

OpenCode:

- CLI docs: <https://opencode.ai/docs/cli/>
- Config docs: <https://opencode.ai/docs/config/>
- Agents docs: <https://opencode.ai/docs/agents/>
- Rules docs: <https://opencode.ai/docs/rules>

## Tool-By-Tool Findings

## Claude Code

### What the CLI supports

Claude Code has a clean, official append surface:

- `--append-system-prompt <prompt>`
- `--append-system-prompt-file <path>`

This is the best-case integration because it preserves the built-in system prompt instead of replacing it.

### Why this is good for us

We do not need to copy Claude config files.
We do not need to edit `CLAUDE.md`.
We do not need to mutate the user's project.

We can simply launch Claude with a pane-specific personality file.

### Example

```bash
claude --append-system-prompt-file /tmp/agentz/panes/term-1/personality.md
```

### Recommendation

For Claude Code, use the CLI flag directly.

This part of the integration is low risk and should be considered the reference implementation style.

## OpenCode

### Public docs result

OpenCode does not expose a public CLI flag equivalent to Claude's `--append-system-prompt-file`.

However, the docs and source both show strong config-based injection surfaces.

### Source-level findings

The OpenCode source makes several important things explicit.

#### 1. OpenCode has a dedicated `instructions` config field

In the config schema, `instructions` is defined as:

> Additional instruction files or patterns to include

Source:

- `.research/opencode/packages/opencode/src/config/config.ts`

This is very important because it means we do **not** need to replace the main agent prompt in order to append personality.

#### 2. OpenCode merges instruction arrays across config layers

The config merger concatenates arrays for `instructions`.

That means pane-specific config can add one more instruction file on top of existing config.

Source:

- `.research/opencode/packages/opencode/src/config/config.ts`

#### 3. OpenCode loads multiple instruction file sources automatically

Its instruction loader includes:

- project `AGENTS.md`
- project `CLAUDE.md`
- project `CONTEXT.md` (deprecated)
- config-dir `AGENTS.md`
- global config `AGENTS.md`
- optionally `~/.claude/CLAUDE.md`
- any paths or URLs listed in `config.instructions`

Source:

- `.research/opencode/packages/opencode/src/session/instruction.ts`

This means OpenCode already has a rich instruction aggregation model.

#### 4. OpenCode exposes useful environment variables

Interesting env vars from source:

- `OPENCODE_CONFIG`
- `OPENCODE_CONFIG_DIR`
- `OPENCODE_CONFIG_CONTENT`
- `OPENCODE_DISABLE_PROJECT_CONFIG`
- `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`

Source:

- `.research/opencode/packages/opencode/src/flag/flag.ts`

These are more useful than any hidden CLI flag we found.

#### 5. OpenCode does have internal hidden agents, but they are not the right integration point

Hidden agents such as `compaction`, `title`, and `summary` exist in source.

Source:

- `.research/opencode/packages/opencode/src/agent/agent.ts`

These are internal workflow pieces, not a good place to inject avatar personality.

### Local CLI findings

Useful supported commands:

- `opencode debug config`
- `opencode debug agent <name>`
- `opencode debug paths`

These are good for verification.

### What we should do

Use a pane-scoped temp config and add our personality file through `instructions`.

There are two good ways to do this:

#### Option A: `OPENCODE_CONFIG_CONTENT`

Pass a JSON string directly through env.

Example:

```json
{
  "instructions": ["/tmp/agentz/panes/term-1/personality.md"]
}
```

Launch:

```bash
OPENCODE_CONFIG_CONTENT='{"instructions":["/tmp/agentz/panes/term-1/personality.md"]}' opencode
```

Pros:

- no temp config file needed
- easiest to generate

Cons:

- env quoting is annoying
- harder to debug visually

#### Option B: `OPENCODE_CONFIG`

Write a temp JSON file and point OpenCode at it.

Example config:

```json
{
  "instructions": [
    "/tmp/agentz/panes/term-1/personality.md"
  ]
}
```

Launch:

```bash
OPENCODE_CONFIG=/tmp/agentz/panes/term-1/opencode.json opencode
```

Pros:

- easy to inspect
- easier to debug and log
- simpler for `agentz`

Cons:

- requires temp file management

### Recommendation

Use a pane-specific temp `opencode.json` and set `OPENCODE_CONFIG` for that pane.

That is cleaner than trying to locate and copy whatever original agent file OpenCode uses internally.

## Codex

### Initial assumption

At first glance, Codex looked like a tool where we might need to rely on `AGENTS.md`.

Codex does indeed read:

- global docs from `CODEX_HOME`
- project docs from the project root down to the current working directory
- `AGENTS.override.md` takes precedence over `AGENTS.md`

Source:

- official guide: <https://developers.openai.com/codex/guides/agents-md>
- source: `.research/codex/codex-rs/core/src/project_doc.rs`

### Important source-level discovery

While inspecting the Codex repo, we found something better than "copy AGENTS.md":

- Codex supports `model_instructions_file`
- this can be passed via CLI config override with `-c model_instructions_file="..."`
- the test suite explicitly verifies this behavior

Sources:

- `.research/codex/codex-rs/core/tests/suite/cli_stream.rs`
- `.research/codex/codex-rs/core/src/config_loader/mod.rs`

This is the most important Codex finding in the whole research pass.

### Deprecated path we should not use

Codex also contains `experimental_instructions_file`, but source shows it is deprecated and ignored.

Source:

- `.research/codex/codex-rs/core/src/codex.rs`

The replacement is:

- `model_instructions_file`

### How Codex combines instructions

Codex builds `user_instructions` from:

1. base instructions loaded from config / home
2. project docs discovered through `AGENTS.md`
3. optional extra sections such as JS REPL instructions

Source:

- `.research/codex/codex-rs/core/src/project_doc.rs`
- `.research/codex/codex-rs/core/src/config/mod.rs`

This is good news for us:

- if we inject personality through `model_instructions_file`,
- Codex should still keep the user's normal project `AGENTS.md` chain.

That is better than copying project `AGENTS.md` into a fake temp repo.

### `CODEX_HOME`

If `CODEX_HOME` is unset, Codex defaults to `~/.codex`.

Source:

- official AGENTS guide
- `.research/codex/codex-rs/core/src/config/mod.rs`

`CODEX_HOME` is still useful for isolation, but the cleaner personality hook appears to be `model_instructions_file`.

### Example

```bash
codex -c 'model_instructions_file="/tmp/agentz/panes/term-1/personality.md"'
```

### Recommendation

Prefer `model_instructions_file` over copying `AGENTS.md`.

This is a better solution than our earlier idea of assuming every repo has a project `AGENTS.md` and cloning it.

## Hidden Or Less-Visible CLI Findings

## Codex hidden/internal CLI items

These exist, but they are not useful for avatar personality injection:

- hidden subcommand `execpolicy`
- hidden subcommand `responses-api-proxy`
- hidden subcommand `stdio-to-uds`
- hidden `debug clear-memories`
- hidden login flags:
  - `--experimental_issuer`
  - `--experimental_client-id`

Source:

- `.research/codex/codex-rs/cli/src/main.rs`

These are internal plumbing, debug, or auth-related surfaces.

## OpenCode hidden/internal findings

The most useful hidden-ish surfaces are env/config driven rather than CLI-flag driven:

- `OPENCODE_CONFIG`
- `OPENCODE_CONFIG_DIR`
- `OPENCODE_CONFIG_CONTENT`
- `OPENCODE_DISABLE_PROJECT_CONFIG`
- `OPENCODE_DISABLE_CLAUDE_CODE_PROMPT`

Source:

- `.research/opencode/packages/opencode/src/flag/flag.ts`

This is enough for our implementation.

We did **not** find a hidden equivalent to:

- `--append-system-prompt-file`

for OpenCode.

## Recommended Final Design

This is the recommended launch-time design for `agentz`.

### Core idea

For each pane:

1. resolve the pane's assigned avatar
2. locate that avatar's `personality.md`
3. write a pane-specific temp prompt file, optionally wrapping the raw personality with an `agentz` header
4. transform the launch command depending on the target CLI
5. launch the tool with pane-scoped args and/or env

### Temp file layout

Recommended temp root:

```text
/tmp/agentz/panes/<pane-or-session-id>/
```

Recommended contents:

```text
/tmp/agentz/panes/term-1/
  personality.md
  opencode.json
  launch-meta.json
```

If we later want pane/session persistence across reconnects, we can switch to:

```text
$XDG_STATE_HOME/agentz/panes/<session-id>/
```

or another managed app-state directory.

## Recommended behavior by tool

### Claude Code

Use:

```bash
claude --append-system-prompt-file /tmp/agentz/panes/term-1/personality.md
```

### OpenCode

Generate:

```json
{
  "instructions": [
    "/tmp/agentz/panes/term-1/personality.md"
  ]
}
```

Launch with:

```bash
OPENCODE_CONFIG=/tmp/agentz/panes/term-1/opencode.json opencode
```

### Codex

Use:

```bash
codex -c 'model_instructions_file="/tmp/agentz/panes/term-1/personality.md"'
```

This should coexist with the normal project `AGENTS.md` chain.

## Implementation Section

This is the application-level implementation plan we should follow inside `agentz`.

The important shift is this:

- we should not try to catch every way a user might manually type `claude`, `opencode`, or `codex`,
- we should make `agentz` the primary launcher for those tools,
- and we should preserve the user's current terminal work instead of typing into it.

That leads to a cleaner product and a much more reliable prompt-injection path.

## Product behavior

### Primary UX

Each avatar chip in the top strip should get three tiny launcher buttons on the right side:

- `OC` for OpenCode
- `CC` for Claude Code
- `CX` for Codex

These should be actual buttons with tooltips, for example:

- `Launch OpenCode as Selene`
- `Launch Claude Code as Rufus`
- `Launch Codex as Mochi`

This gives us a first-class way to launch each tool through `agentz`, which means:

- prompt injection becomes deterministic
- avatar binding becomes explicit
- we do not need to rely on shell aliases, PATH shims, or command interception

### Keyboard shortcuts

We should add three matching shortcuts and expose them in settings:

- `launchOpenCode`: default `Ctrl+Shift+1`
- `launchClaudeCode`: default `Ctrl+Shift+2`
- `launchCodex`: default `Ctrl+Shift+3`

These should target the active pane.

Relevant shortcut/config code that will need updating:

- `src/shared/config.ts`
- `src/ui/shortcuts.ts`
- `src/ui/App.tsx`
- the settings UI already reads from `DashboardConfig.shortcuts`, so these actions should become part of the normal settings flow

### Foreground/background terminal behavior

When the user launches `OC`, `CC`, or `CX` for a pane, `agentz` should **not** type into the currently visible terminal.

Instead:

1. whatever is currently visible for that pane becomes the preserved background terminal
2. a newly launched AI session becomes the visible main terminal for that pane
3. that new AI session gets the pane's avatar personality injected at launch time

This matches the app's existing main/background terminal model much better than keystroke simulation.

The current code already has the right conceptual building blocks:

- background terminal creation and toggling in `src/ui/App.tsx`
- visible stack behavior in `src/ui/App.tsx`
- existing shortcut handling in `src/ui/TerminalPane.tsx` and `src/ui/App.tsx`

### Session transition rule

The simplest rule is:

- preserve the current visible session as the pane's background session
- replace the pane's foreground session with a newly created managed AI session

In other words:

- background = "what the user was already doing"
- foreground = "the requested AI terminal UI with personality injection"

If the AI session later exits or is closed, `agentz` should reveal the preserved background session again.

This is safer than trying to send `claude`, `opencode`, or `codex` into an already-running shell because typing into the shell can fail when:

- the shell is not at a prompt
- the user is in `vim`, `less`, or `tmux`
- the shell has partially typed input
- the launch needs injected args or env that a plain text command does not capture

## Code architecture

### 1. Extend the pane launch protocol

Today `PaneLaunchConfig` only supports:

- `command`
- `args`
- `cwd`

We should extend it to carry the data needed for managed AI launches:

```ts
interface PaneLaunchConfig {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  avatarId?: string;
  aiTool?: "claude" | "opencode" | "codex";
}
```

This will need to be threaded through:

- `src/shared/protocol.ts`
- `src/ui/App.tsx`
- `src/main/server.ts`
- `src/main/terminalManager.ts`
- `src/main/terminalSession.ts`

`avatarId` is important because the main process does not currently own avatar assignment.

`aiTool` is also important because inferring the target only from `command` gets messy fast once shells or wrappers enter the picture.

### 2. Add first-class per-pane env support

This is still one of the most important implementation improvements.

In `TerminalSession`, merge pane launch env on top of the base host env rather than replacing it.

Why this matters:

- Claude primarily needs args
- OpenCode wants env cleanly through `OPENCODE_CONFIG`
- future integrations will likely need env too
- shell-string wrappers become unnecessary

Without this, OpenCode becomes much more awkward than it needs to be.

### 3. Add a main-process launch transformation layer

Create a dedicated module, for example:

- `src/main/aiLauncher.ts`

This module should:

1. accept the requested pane launch
2. resolve the pane avatar personality source
3. generate pane-scoped temp files
4. transform the launch for the selected tool
5. return the final launch payload

Suggested shape:

```ts
interface ResolvedLaunch {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}
```

Input shape can be richer internally if needed:

```ts
interface AiLaunchRequest {
  paneId: string;
  sessionId: string;
  cwd?: string;
  avatarId: string;
  aiTool: "claude" | "opencode" | "codex";
}
```

### 4. Materialize pane-scoped prompt assets

Even though we already have `assets/avatars/<avatar>/personality.md`, we should still generate a pane-specific temp prompt file.

Why:

- packaged builds should not depend on raw asset paths at launch time
- we may want to prepend an `agentz` header
- debugging becomes easier
- future per-pane prompt decoration becomes easier

Suggested temp layout:

```text
/tmp/agentz/panes/<pane-or-session-id>/
  personality.md
  opencode.json
  launch-meta.json
```

Suggested generated personality content:

```md
# Agentz Avatar Personality

The following instructions are injected by agentz based on the pane's assigned avatar.
Keep the tool's normal instructions, safety behavior, and approval flow intact.

You are a tiny vampire girl named Selene...
```

### 5. Apply tool-specific launch transforms

#### Claude Code

Transform:

```bash
claude --append-system-prompt-file /tmp/agentz/panes/term-1/personality.md
```

#### OpenCode

Generate:

```json
{
  "instructions": [
    "/tmp/agentz/panes/term-1/personality.md"
  ]
}
```

Launch with:

```bash
OPENCODE_CONFIG=/tmp/agentz/panes/term-1/opencode.json opencode
```

#### Codex

Transform:

```bash
codex -c 'model_instructions_file="/tmp/agentz/panes/term-1/personality.md"'
```

This should preserve the user's normal Codex `AGENTS.md` chain while adding our pane personality.

## UI implementation outline

Because this is a real UI change, the implementation should be done with the existing top-strip avatar chip component rather than bolted on somewhere else.

Likely touch points:

- `AvatarChip` in `src/ui/App.tsx`
- the top strip rendering in `src/ui/App.tsx`
- the shared shortcut definitions in `src/shared/config.ts`
- shortcut labels/order in `src/ui/shortcuts.ts`
- the settings UI that already edits shortcut config

### Avatar chip behavior

Each avatar chip should:

- still focus the pane when the main chip is clicked
- expose three smaller launcher buttons on the right edge
- keep those launcher buttons distinct from the main "focus pane" click target

Recommended behavior:

- always visible for the active pane
- visible on hover and keyboard focus for inactive panes
- clear hover/focus affordances
- tooltips for each launcher

### Shortcut behavior

The new shortcuts should behave exactly like clicking the chip launchers, but on the active pane:

- `Ctrl+Shift+1` launches OpenCode
- `Ctrl+Shift+2` launches Claude Code
- `Ctrl+Shift+3` launches Codex

These should create managed AI foreground sessions rather than send text into the terminal.

### Launch action wiring

We should add a new UI action that is conceptually something like:

```ts
launchAiToolForPane(paneId, "opencode" | "claude" | "codex")
```

That action should:

1. read the pane's assigned avatar id
2. preserve the currently visible session as background
3. create or recreate the foreground session with the chosen AI tool
4. pass `avatarId` and `aiTool` through the launch request
5. make the new foreground session active and visible

## Manual typing and why we are not optimizing for it first

If a user opens a plain shell and manually types:

- `claude`
- `opencode`
- `codex`

we cannot guarantee interception.

PATH shims and shell wrappers are only best-effort because:

- aliases and shell functions resolve before `PATH`
- absolute paths bypass `PATH`
- users may wrap these tools in their own scripts

That is why the top-strip launcher buttons and shortcuts should be the primary experience.

We can still explore shell-level best-effort helpers later, but they should not be the core implementation path.

## Updated implementation order

The best order now looks like this:

1. extend `DashboardShortcuts` with `launchOpenCode`, `launchClaudeCode`, and `launchCodex`
2. add the new top-strip avatar launcher buttons
3. add a pane-level launch action that preserves the current session as background and creates a managed AI foreground session
4. extend `PaneLaunchConfig` with `env`, `avatarId`, and `aiTool`
5. thread those fields through the RPC and terminal-launch stack
6. add main-process temp prompt generation
7. wire Claude launch transforms
8. wire OpenCode launch transforms
9. wire Codex launch transforms
10. add debug logging and verification tooling

This order gives us a usable feature early while keeping the actual injection work on the robust path.

## Concrete Examples

## Example 1: Claude + Selene

Requested command:

```json
{
  "command": "claude",
  "args": [],
  "cwd": "/repo"
}
```

Resolved launch:

```json
{
  "command": "claude",
  "args": [
    "--append-system-prompt-file",
    "/tmp/agentz/panes/term-1/personality.md"
  ],
  "cwd": "/repo"
}
```

## Example 2: OpenCode + Rufus

Requested command:

```json
{
  "command": "opencode",
  "args": [],
  "cwd": "/repo"
}
```

Generated temp config:

```json
{
  "instructions": [
    "/tmp/agentz/panes/term-2/personality.md"
  ]
}
```

Resolved launch:

```json
{
  "command": "opencode",
  "args": [],
  "cwd": "/repo",
  "env": {
    "OPENCODE_CONFIG": "/tmp/agentz/panes/term-2/opencode.json"
  }
}
```

## Example 3: Codex + Mochi

Requested command:

```json
{
  "command": "codex",
  "args": [],
  "cwd": "/repo"
}
```

Resolved launch:

```json
{
  "command": "codex",
  "args": [
    "-c",
    "model_instructions_file=\"/tmp/agentz/panes/term-3/personality.md\""
  ],
  "cwd": "/repo"
}
```

## Rejected Approaches

## 1. Mutate the user's real config or AGENTS files, then revert

Rejected because:

- race conditions between panes
- crash risk leaves files modified
- dirties repos or home config
- difficult cleanup

## 2. Copy Codex project `AGENTS.md` into a temp repo and append personality

Rejected because:

- Codex already has a cleaner `model_instructions_file` hook
- Codex instruction resolution is hierarchical, not single-file
- copying one guessed file can miss part of the real instruction chain

## 3. Copy OpenCode agent prompt source files

Rejected because:

- OpenCode already supports additive `instructions`
- there is no need to replace the agent prompt
- config/env injection is cleaner and more stable

## Risks And Edge Cases

## 1. Manual command typing is not fully interceptable

Even with PATH shims, we still cannot guarantee interception if the user relies on:

- shell aliases
- shell functions
- scripts that call absolute binary paths

That is why the primary product path should be explicit `agentz`-managed launch buttons and shortcuts, not shell interception.

Possible future solution:

- best-effort shell wrappers or PATH shims inside managed panes

## 2. Resume/fork behavior

Tools with resumed sessions may preserve prior prompt state.

This means avatar changes may not fully take effect if a session is resumed instead of freshly launched.

We should decide whether:

- personality is bound to pane identity
- personality is bound to process launch
- personality is bound to session resume state

## 3. Windows quoting

CLI argument quoting must be handled carefully for:

- `codex -c model_instructions_file=...`
- Claude path arguments

This is another reason to prefer first-class `args` and `env` over shell strings.

## 4. Packaged app path resolution

Do not assume asset paths are stable in packaged builds.

Prefer generating temp prompt files from the avatar source content rather than passing bundle asset paths straight through.

## 5. Personality should be additive, not destructive

Our injected personality text should not tell the model to ignore tool safety, approvals, or built-in instruction hierarchy.

Each generated personality file should clearly behave as flavor, tone, and lightweight role guidance.

## Verification Plan

For each tool:

1. Launch a pane with a known avatar personality.
2. Open the tool through `agentz`.
3. Ask the model a trivial question that reveals voice/style.
4. Verify the response tone reflects the avatar personality.
5. Verify normal safety and tool behavior still work.
6. Verify launch still succeeds on reconnect/restart.
7. Verify personality isolation across two panes with different avatars.

Suggested manual checks:

- Claude pane with Selene sounds vampire-like
- OpenCode pane with Rufus sounds dog-like and upbeat
- Codex pane with Mochi sounds gentle and companion-bot-like

## Recommended Next Step

If we implement this now, the best order is:

1. add the `OC`, `CC`, and `CX` avatar launcher UI and matching shortcuts
2. make those launches preserve the current session as background and create a managed AI foreground session
3. add per-pane `env`, `avatarId`, and `aiTool` support in the launch protocol
4. add prompt-injection temp file generation
5. wire Claude Code integration
6. wire OpenCode via `OPENCODE_CONFIG`
7. wire Codex via `-c model_instructions_file=...`
8. add debug logging and validation

## Final Recommendation

The best current strategy is:

- Claude Code: use `--append-system-prompt-file`
- OpenCode: use pane-specific temp config with `instructions`
- Codex: use `-c model_instructions_file="..."`

This is cleaner, safer, and more maintainable than mutating user files or trying to clone internal prompt sources.

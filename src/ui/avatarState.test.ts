import { describe, expect, test } from "bun:test";
import type { TerminalFrame } from "../shared/protocol";
import {
  CODEX_ACTIVE_FRAME_GRACE_MS,
  CODEX_WORKING_HOLD_MS,
  OPENCODE_BUSY_SIGNAL_HOLD_MS,
  OPENCODE_WORKING_HOLD_MS,
  detectAvatarState,
  inspectAvatarState,
  resolveAvatarDisplayState,
} from "./avatarState";

function frameFromText(text: string, extra: Partial<TerminalFrame> = {}): TerminalFrame {
  return {
    id: "term-1",
    cols: 120,
    rows: 40,
    seq: 1,
    chunk: "",
    vt: text,
    previewLines: text.split("\n"),
    ...extra,
  };
}

describe("detectAvatarState", () => {
  test("detects opencode bottom-left build animation as working", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "opencode",
          "Build GPT-5.4 OpenAI · high",
          "⬝⬝⬝■⬩⬪⬝⬝ esc interrupt",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        { cursorRow: 4 },
      ),
    );

    expect(state).toBe("working");
  });

  test("detects opencode working even when cursor is far from the footer", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "# earlier transcript",
          "Some long answer content",
          "More content here",
          "Build GPT-5.4 OpenAI · high",
          "⬝⬝⬝■⬩⬪⬝⬝ esc interrupt",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        { cursorRow: 2 },
      ),
    );

    expect(state).toBe("working");
  });

  test("detects opencode working with varied footer glyphs", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Transcript line one",
          "Transcript line two",
          "Build GPT-5.4 OpenAI · high",
          ". . . . ■ . . esc interrupt",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
      ),
    );

    expect(state).toBe("working");
  });

  test("detects opencode working from footer patch updates", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Older transcript line",
          "Another earlier line",
          "GPT-5.4 OpenAI · high",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        {
          renderPatchKind: "row-update",
          renderPatchVt: "......... esc interrupt",
          cursorRow: 1,
        },
      ),
    );

    expect(state).toBe("working");
  });

  test("treats opencode alt-row footer patches as visible busy updates", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Older transcript line",
          "Another earlier line",
          "GPT-5.4 OpenAI · high",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        {
          renderPatchKind: "alt-row-update",
          renderPatchVt: "......... esc interrupt",
          previewLines: [
            "Older transcript line",
            "Another earlier line",
            "GPT-5.4 OpenAI · high",
            "......... esc interrupt",
            "ctrl+t variants  tab agents  ctrl+p commands",
          ],
        },
      ),
    );

    expect(state).toBe("working");
  });

  test("does not require the opencode agent label to detect working", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Earlier transcript",
          "GPT-5.4 OpenAI · high",
          "......... esc interrupt",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
      ),
    );

    expect(state).toBe("working");
  });

  test("keeps opencode idle when visible footer has no spinner even if old patch text exists", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Transcript line",
          "Tool execution aborted",
          "GPT-5.4 OpenAI · high",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        {
          renderPatchKind: "row-update",
          renderPatchVt: "",
          chunk: "......... esc interrupt",
          vt: [
            "Transcript line",
            "GPT-5.4 OpenAI · high",
            "......... esc interrupt",
            "ctrl+t variants  tab agents  ctrl+p commands",
          ].join("\n"),
        },
      ),
    );

    expect(state).toBe("idle");
  });

  test("limits opencode working detection to the build footer", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "opencode",
          "Thinking: reading file",
          '* Read "src/ui/avatarState.ts"',
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        { cursorRow: 4 },
      ),
    );

    expect(state).toBe("idle");
  });

  test("does not apply build-footer working detection outside opencode", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "agentz",
          "Build GPT-5.4 OpenAI · high",
          "⬝⬝⬝■⬩⬪⬝⬝ esc interrupt",
        ].join("\n"),
        { cursorRow: 3 },
      ),
    );

    expect(state).toBe("idle");
  });

  test("detects codex idle shell", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "› Ask Codex to do anything",
          "? for shortcuts                                                                100% context left",
        ].join("\n"),
      ),
    );

    expect(state).toBe("idle");
  });

  test("treats a non-agent shell with a live child process as working", () => {
    const state = resolveAvatarDisplayState(
      {
        ...frameFromText(
          [
            "agentz master",
            "$ bun run dev",
            "Server started at http://localhost:50001",
          ].join("\n"),
        ),
        shellBusy: true,
      },
      undefined,
      Date.now(),
    );

    expect(state).toBe("working");
  });

  test("does not use generic shell-busy fallback for recognized agent sessions", () => {
    const state = resolveAvatarDisplayState(
      {
        ...frameFromText(
          [
            "OpenAI Codex",
            "› Ask Codex to do anything",
            "? for shortcuts                                                                100% context left",
          ].join("\n"),
        ),
        shellBusy: true,
      },
      undefined,
      Date.now(),
    );

    expect(state).toBe("idle");
  });

  test("uses fresh shellBusy signal for opencode when footer has not redrawn yet", () => {
    const state = resolveAvatarDisplayState(
      {
        ...frameFromText(
          [
            "opencode",
            "Build GPT-5.4 OpenAI · high",
            "......... esc interrupt",
            "ctrl+t variants  tab agents  ctrl+p commands",
          ].join("\n"),
        ),
        shellBusy: true,
        shellBusyAtMs: 5_000,
      },
        {
          state: "idle",
          agent: "opencode",
          atMs: 4_000,
          lastFrameAtMs: 4_000,
          lastPreviewText: "opencode\nBuild GPT-5.4 OpenAI · high",
        },
        5_000 + OPENCODE_BUSY_SIGNAL_HOLD_MS - 1,
      );

    expect(state).toBe("working");
  });

  test("lets opencode return idle on fresh shellBusy=false even if footer still looks stale", () => {
    const state = resolveAvatarDisplayState(
      {
        ...frameFromText(
          [
            "opencode",
            "Build GPT-5.4 OpenAI · high",
            "......... esc interrupt",
            "ctrl+t variants  tab agents  ctrl+p commands",
          ].join("\n"),
        ),
        shellBusy: false,
        shellBusyAtMs: 8_000,
      },
      {
        state: "working",
        agent: "opencode",
        atMs: 7_000,
        lastFrameAtMs: 7_000,
        lastPreviewText: "opencode\nBuild GPT-5.4 OpenAI · high",
      },
      8_000 + 100,
    );

    expect(state).toBe("idle");
  });


  test("detects codex working state", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "OpenAI Codex",
          "• Working (0s • esc to interrupt)",
          "100% context left",
        ].join("\n"),
      ),
    );

    expect(state).toBe("working");
  });

  test("detects codex streaming footer as working even when the generic label is gone", () => {
    const inspection = inspectAvatarState(
      frameFromText(
        [
          "OpenAI Codex",
          "verse one line one",
          "verse one line two",
          "tab to queue message                                       100% context left",
        ].join("\n"),
      ),
    );

    expect(inspection.agent).toBe("codex");
    expect(inspection.state).toBe("working");
  });

  test("keeps codex avatar working briefly through redraw gaps", () => {
    const frame = frameFromText(
      [
        "OpenAI Codex",
        "› Ask Codex to do anything",
        "? for shortcuts                                                                100% context left",
      ].join("\n"),
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "codex",
          atMs: 1_000,
          lastFrameAtMs: 1_000,
          lastPreviewText: "OpenAI Codex\n› Ask Codex to do anything\n? for shortcuts",
        },
        1_000 + CODEX_WORKING_HOLD_MS - 1,
      ),
    ).toBe(
      "working",
    );
    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "codex",
          atMs: 1_000,
          lastFrameAtMs: 1_000,
          lastPreviewText: frame.previewLines.join("\n"),
        },
        1_000 + Math.max(CODEX_WORKING_HOLD_MS, CODEX_ACTIVE_FRAME_GRACE_MS) + 1,
      ),
    ).toBe(
      "idle",
    );
  });

  test("keeps codex avatar working while fresh frames are still arriving", () => {
    const frame = frameFromText(
      [
        "OpenAI Codex",
        "verse nineteen",
        "verse twenty",
        "? for shortcuts                                                                100% context left",
      ].join("\n"),
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "codex",
          atMs: 1_000,
          lastFrameAtMs: 5_000,
          lastPreviewText: "OpenAI Codex\nverse eighteen\nverse nineteen",
        },
        5_000 + CODEX_ACTIVE_FRAME_GRACE_MS - 1,
      ),
    ).toBe("working");
  });

  test("keeps codex working when codex markers have scrolled off screen", () => {
    const frame = frameFromText(
      [
        "Verse 3",
        "A stranger smiles once",
        "Kindness lights the block",
        "Rain dries on the curb",
        "Puddles keep the sky",
        "I walk a little slower",
        "To hear the world reply",
      ].join("\n"),
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "codex",
          atMs: 1_000,
          lastFrameAtMs: 6_000,
          lastPreviewText: "Verse 2\nEarlier line\nAnother earlier line",
        },
        6_000 + 500,
      ),
    ).toBe("working");
  });

  test("keeps codex working when visible preview lines are changing", () => {
    const frame = frameFromText(
      [
        "Verse 7",
        "Voices fill the hall",
        "Laughter skips ahead",
        "A lantern wakes below",
      ].join("\n"),
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "codex",
          atMs: 1_000,
          lastFrameAtMs: 2_000,
          lastPreviewText: "Verse 6\nCloud shadows move fast\nOver brick and glass",
        },
        10_000,
      ),
    ).toBe("working");
  });

  test("detects codex approval prompt as question", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          'Do you want to approve network access to "example.com"?',
          "› 1. Yes, just this once (y)",
          "4. No, and tell Codex what to do differently (esc)",
          "Press enter to confirm or esc to cancel",
        ].join("\n"),
      ),
    );

    expect(state).toBe("question");
  });

  test("detects codex request-user-input prompt as question", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Question 1/1 (1 unanswered)",
          "What would you like to do next?",
          "tab to add notes | enter to submit answer | esc to interrupt",
        ].join("\n"),
      ),
    );

    expect(state).toBe("question");
  });

  test("detects claude selection prompt as question", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "Hello! I'm here to help you with your work on the agentz project.",
          "Use a sub agent to look through the code in this app. Tell me how it uses ghostty",
          "Interrupted - What should Claude do instead?",
          "Good call! Let me ask:",
          "What aspect of ghostty usage in this codebase would you like to understand?",
          "1. Build & Release Process",
          "2. Runtime Integration",
          "5. Type something.",
          "6. Chat about this",
          "Enter to select · ↑/↓ to navigate · Esc to cancel",
        ].join("\n"),
      ),
    );

    expect(state).toBe("question");
  });

  test("treats opencode transcript-only tool output as idle", () => {
    const inspection = inspectAvatarState(
      frameFromText(
        [
          "opencode",
          "# Avatar misinterpreting user prompt; sub-agent task issue",
          "# Todos",
          "[·] Inspect avatar state logic for question vs subagent task",
          "Thinking: Exploring file searching options",
          '* Glob "**/*avatar*" in . (39 matches)',
          '* Grep "subagent|question|thinking|avatar|task" in . (126 matches)',
          "-> Read src/ui/avatarState.ts",
          "△",
        ].join("\n"),
      ),
    );

    expect(inspection.agent).toBe("opencode");
    expect(inspection.state).toBe("idle");
  });

  test("detects opencode question even when cursor is not near the question block", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "# Earlier transcript",
          "Some older answer line",
          "Another older answer line",
          "Which avatar state should we verify right now?",
          "1. Question (Recommended)",
          "2. Working",
          "3. Calling",
          "4. Type your own answer",
          "↑↓ select  enter submit  esc dismiss",
          "Build GPT-5.4 OpenAI · high",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        { cursorRow: 2 },
      ),
    );

    expect(state).toBe("question");
  });

  test("detects opencode question prompt even after the header scrolls off", () => {
    const inspection = inspectAvatarState(
      frameFromText(
        [
          "# Greeting / Quick check-in",
          "Asked 1 question",
          "Build GPT-5.4",
          "What should we talk about next?",
          "1. Code help",
          "2. Repo tour",
          "3. Just chat",
          "4. Type your own answer",
          "↑↓ select  enter submit  esc dismiss",
        ].join("\n"),
      ),
    );

    expect(inspection.agent).toBe("opencode");
    expect(inspection.state).toBe("question");
  });

  test("keeps opencode idle when old tool transcript is visible above the prompt", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "# Avatar misinterpreting user prompt; sub-agent task issue",
          "Thinking: Exploring file searching options",
          '* Glob "**/*avatar*" in . (39 matches)',
          '* Grep "subagent|question|thinking|avatar|task" in . (126 matches)',
          "-> Read src/ui/avatarState.ts",
          "",
          "Fixed the avatar classifier so subagent/tool-work transcripts stop tripping the question badge.",
          "",
          "If you want, next I can:",
          "1. Run a live screenshot repro to visually confirm the badge in-app.",
          "2. Add a dedicated screenshot regression for this exact subagent scenario.",
          "",
          "Build GPT-5.4 OpenAI · high",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        { cursorRow: 13 },
      ),
    );

    expect(state).toBe("idle");
  });

  test("clears opencode question state once the prompt is gone", () => {
    const frame = frameFromText(
      [
        "opencode",
        "Answer recorded.",
        "GPT-5.4 OpenAI · high",
        "ctrl+t variants  tab agents  ctrl+p commands",
      ].join("\n"),
      { cursorRow: 4 },
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "question",
          agent: "opencode",
          atMs: 1_000,
          lastFrameAtMs: 1_000,
          lastPreviewText: "Question 1/1\nWhat should we verify next?\nenter to submit answer",
        },
        1_500,
      ),
    ).toBe("idle");
  });

  test("holds opencode working briefly across missing footer frames", () => {
    const frame = frameFromText(
      [
        "opencode",
        "Transcript continues here",
        "More transcript lines",
      ].join("\n"),
      { cursorRow: 1 },
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "opencode",
          atMs: 1_000,
          lastFrameAtMs: 1_000,
          lastPreviewText: "Build GPT-5.4 OpenAI · high\n......... esc interrupt",
        },
        1_000 + OPENCODE_WORKING_HOLD_MS - 1,
      ),
    ).toBe("working");

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "opencode",
          atMs: 1_000,
          lastFrameAtMs: 1_000,
          lastPreviewText: "Build GPT-5.4 OpenAI · high\n......... esc interrupt",
        },
        1_000 + OPENCODE_WORKING_HOLD_MS + 1,
      ),
    ).toBe("idle");
  });

  test("does not hold opencode working when the visible footer is idle", () => {
    const frame = frameFromText(
      [
        "Transcript continues here",
        "GPT-5.4 OpenAI · high",
        "ctrl+t variants  tab agents  ctrl+p commands",
      ].join("\n"),
    );

    expect(
      resolveAvatarDisplayState(
        frame,
        {
          state: "working",
          agent: "opencode",
          atMs: 1_000,
          lastFrameAtMs: 1_000,
          lastPreviewText: "Build GPT-5.4 OpenAI · high\n......... esc interrupt",
        },
        1_000 + 100,
      ),
    ).toBe("idle");
  });

  test("prefers calling state when subagent activity and question footer overlap", () => {
    const inspection = inspectAvatarState(
      frameFromText(
        [
          "opencode",
          "Task scan server timeouts",
          "ctrl+x down view subagents",
          "toolcalls active",
          "Build GPT-5.4 OpenAI · high",
          "⬝⬝⬝■⬩⬪⬝⬝ esc interrupt",
          "ctrl+t variants  tab agents  ctrl+p commands",
          "type your own answer",
          "select all that apply",
        ].join("\n"),
        { cursorRow: 8 },
      ),
    );

    expect(inspection.agent).toBe("opencode");
    expect(inspection.state).toBe("calling");
  });

  test("prefers calling over build animation when subagent work is active", () => {
    const inspection = inspectAvatarState(
      frameFromText(
        [
          "opencode",
          "subagent session",
          "view subagents",
          "toolcalls",
          "Build GPT-5.4 OpenAI · high",
          "⬝⬝⬝■⬩⬪⬝⬝ esc interrupt",
          "ctrl+t variants  tab agents  ctrl+p commands",
        ].join("\n"),
        { cursorRow: 7 },
      ),
    );

    expect(inspection.state).toBe("calling");
  });
});

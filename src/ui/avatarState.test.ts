import { describe, expect, test } from "bun:test";
import type { TerminalFrame } from "../shared/protocol";
import {
  CODEX_ACTIVE_FRAME_GRACE_MS,
  CODEX_WORKING_HOLD_MS,
  detectAvatarState,
  inspectAvatarState,
  resolveAvatarDisplayState,
} from "./avatarState";

function frameFromText(text: string): TerminalFrame {
  return {
    id: "term-1",
    cols: 120,
    rows: 40,
    seq: 1,
    chunk: "",
    vt: text,
    previewLines: text.split("\n"),
  };
}

describe("detectAvatarState", () => {
  test("keeps opencode working detection", () => {
    const state = detectAvatarState(
      frameFromText(
        [
          "opencode",
          "Thinking: reading file",
          "esc interrupt",
          "tab agents",
          "ctrl+p commands",
        ].join("\n"),
      ),
    );

    expect(state).toBe("working");
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
});

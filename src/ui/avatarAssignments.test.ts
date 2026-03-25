import { describe, expect, test } from "bun:test";
import { assignPaneAvatars, pickDeterministicAvatar } from "./avatarAssignments";
import type { AvatarId } from "./avatarCatalog";

const avatarIds: AvatarId[] = ["marmalade", "nyx", "byte", "glimmer", "wisp"];

describe("assignPaneAvatars", () => {
  test("stays stable for the same pane ids", () => {
    const first = assignPaneAvatars(["term-1", "term-2", "term-3"], [...avatarIds]);
    const second = assignPaneAvatars(["term-1", "term-2", "term-3"], [...avatarIds]);
    expect(second).toEqual(first);
  });

  test("preserves previous assignments when rehydrating", () => {
    const next = assignPaneAvatars(["term-1", "term-2", "term-3"], [...avatarIds], {
      "term-1": avatarIds[2],
      "term-2": avatarIds[0],
    });

    expect(next["term-1"]).toBe(avatarIds[2]);
    expect(next["term-2"]).toBe(avatarIds[0]);
    expect(next["term-3"]).toBeDefined();
    expect(next["term-3"]).not.toBe(avatarIds[2]);
    expect(next["term-3"]).not.toBe(avatarIds[0]);
    expect(assignPaneAvatars(["term-1", "term-2", "term-3"], [...avatarIds], next)).toEqual(next);
  });
});

describe("pickDeterministicAvatar", () => {
  test("never picks an already used avatar", () => {
    const used = new Set<AvatarId>([avatarIds[0], avatarIds[1], avatarIds[2]]);
    const picked = pickDeterministicAvatar("term-9", [...avatarIds], used);
    expect(picked).toBeDefined();
    expect(used.has(picked!)).toBe(false);
  });
});

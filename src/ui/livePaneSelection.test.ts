import { describe, expect, test } from "bun:test";
import { selectLivePaneIds } from "./livePaneSelection";

describe("selectLivePaneIds", () => {
  test("returns all visible panes when under the cap", () => {
    expect(selectLivePaneIds(["a", "b", "c"], ["a", "b"], "a", 3)).toEqual(["a", "b"]);
  });

  test("keeps the active pane centered when possible", () => {
    expect(selectLivePaneIds(["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e"], "c", 3)).toEqual([
      "b",
      "c",
      "d",
    ]);
  });

  test("biases toward the active edge when the active pane is near one side", () => {
    expect(selectLivePaneIds(["a", "b", "c", "d", "e"], ["a", "b", "c", "d", "e"], "a", 3)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  test("falls back to the nearest visible panes when the active pane is not currently visible", () => {
    expect(selectLivePaneIds(["a", "b", "c", "d", "e"], ["c", "d", "e"], "a", 3)).toEqual(["c", "d", "e"]);
  });
});

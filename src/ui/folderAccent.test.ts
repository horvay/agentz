import { describe, expect, test } from "bun:test";

import {
  folderAccentKey,
  resolveFolderAccentAssignments,
} from "./folderAccent";

describe("folder accent assignment", () => {
  test("keeps existing live folder colors stable when another folder changes", () => {
    const first = resolveFolderAccentAssignments(
      ["/repo/a", "/repo/b"],
      {},
      {},
    );

    const second = resolveFolderAccentAssignments(
      ["/repo/a", "/repo/c"],
      first.liveAssignments,
      first.historicalAssignments,
    );

    expect(second.liveAssignments["/repo/a"]).toBe(first.liveAssignments["/repo/a"]);
    expect(second.liveAssignments["/repo/c"]).toBeDefined();
  });

  test("reuses a folder's historical color when it comes back and the slot is free", () => {
    const first = resolveFolderAccentAssignments(
      ["/repo/a", "/repo/b"],
      {},
      {},
    );
    const aSlot = first.liveAssignments["/repo/a"];

    const second = resolveFolderAccentAssignments(
      ["/repo/b"],
      first.liveAssignments,
      first.historicalAssignments,
    );

    const third = resolveFolderAccentAssignments(
      ["/repo/a", "/repo/b"],
      second.liveAssignments,
      second.historicalAssignments,
    );

    expect(third.liveAssignments["/repo/a"]).toBe(aSlot);
  });

  test("normalizes empty cwd to the shared placeholder key", () => {
    expect(folderAccentKey(undefined)).toBe("unknown-folder");
    expect(folderAccentKey("")).toBe("unknown-folder");
    expect(folderAccentKey("/tmp")).toBe("/tmp");
  });
});

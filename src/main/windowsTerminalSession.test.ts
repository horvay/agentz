import { describe, expect, test } from "bun:test";

import { canWriteToPty, isIgnorablePtySocketError } from "./windowsTerminalSession";

describe("isIgnorablePtySocketError", () => {
  test("treats teardown socket failures as ignorable", () => {
    expect(isIgnorablePtySocketError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))).toBe(true);
    expect(
      isIgnorablePtySocketError(Object.assign(new Error("socket already closed"), { code: "ERR_SOCKET_CLOSED" })),
    ).toBe(true);
    expect(isIgnorablePtySocketError(Object.assign(new Error("read EIO"), { code: "EIO" }))).toBe(true);
    expect(isIgnorablePtySocketError(new Error("This socket has been ended by the other party"))).toBe(true);
  });

  test("keeps unrelated errors visible", () => {
    expect(isIgnorablePtySocketError(new Error("permission denied"))).toBe(false);
  });
});

describe("canWriteToPty", () => {
  test("rejects PTYs whose sockets have already closed", () => {
    expect(
      canWriteToPty({
        _writable: true,
        _agent: { inSocket: { destroyed: false, writable: true, writableEnded: false } },
        _socket: { destroyed: false, closed: false, readyState: "open" },
      } as never),
    ).toBe(true);

    expect(
      canWriteToPty({
        _writable: true,
        _agent: { inSocket: { destroyed: true, writable: true, writableEnded: false } },
        _socket: { destroyed: false, closed: false, readyState: "open" },
      } as never),
    ).toBe(false);

    expect(
      canWriteToPty({
        _writable: true,
        _agent: { exitCode: 0, inSocket: { destroyed: false, writable: true, writableEnded: false } },
        _socket: { destroyed: false, closed: false, readyState: "open" },
      } as never),
    ).toBe(false);

    expect(
      canWriteToPty({
        _writable: true,
        _agent: { inSocket: { destroyed: false, writable: true, writableEnded: false } },
        _socket: { destroyed: false, closed: true, readyState: "closed" },
      } as never),
    ).toBe(false);
  });
});

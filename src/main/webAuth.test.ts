import { describe, expect, test } from "bun:test";
import { createDisabledRpcAuth, createWebRpcAuth } from "./webAuth";

describe("createDisabledRpcAuth", () => {
  test("always reports auth as disabled", async () => {
    const auth = createDisabledRpcAuth();
    expect(auth.enabled).toBe(false);
    expect(auth.sessionStatus()).toEqual({
      enabled: false,
      authenticated: true,
      provider: "disabled",
      supported: true,
    });
    expect(auth.authorizeWebSocket()).toBe(true);
    expect(await auth.login("ignored", "ignored")).toBeNull();
  });
});

describe("createWebRpcAuth", () => {
  test("reports system auth for macOS", () => {
    const auth = createWebRpcAuth("darwin");
    expect(auth.enabled).toBe(true);
    expect(auth.sessionStatus()).toMatchObject({
      enabled: true,
      authenticated: false,
      provider: "system",
      supported: true,
      platformLabel: "macOS",
    });
    expect(auth.authorizeWebSocket()).toBe(false);
  });

  test("reports system auth for Windows", () => {
    const auth = createWebRpcAuth("win32");
    expect(auth.sessionStatus()).toMatchObject({
      enabled: true,
      authenticated: false,
      provider: "system",
      supported: true,
      platformLabel: "Windows",
    });
  });
});

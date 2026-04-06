import { describe, expect, test } from "bun:test";
import { REMOTE_ACCESS_MAX_FAILED_PASSCODE_ATTEMPTS } from "../shared/webAuth";
import { createRemoteAccessController } from "./webAuth";

describe("createRemoteAccessController", () => {
  test("starts disabled", () => {
    const controller = createRemoteAccessController();
    expect(controller.getState(true)).toEqual({
      enabled: false,
      pairingsLocked: false,
      failedPasscodeAttempts: 0,
      maxFailedPasscodeAttempts: REMOTE_ACCESS_MAX_FAILED_PASSCODE_ATTEMPTS,
      passcode: undefined,
      pendingRequests: [],
      approvedDevices: [],
      urls: [],
    });
  });

  test("enabling remote access generates a passcode", () => {
    const controller = createRemoteAccessController();
    controller.setEnabled(true);
    const state = controller.getState(true);
    expect(state.enabled).toBe(true);
    expect(state.passcode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(controller.getState(false).passcode).toBeUndefined();
  });

  test("locks pairings after three failed passcode attempts", () => {
    const controller = createRemoteAccessController();
    controller.setEnabled(true);

    expect(() => controller.startPairing("bad", "Phone", { remoteAddress: "10.0.0.9" })).toThrow();
    expect(() => controller.startPairing("bad", "Phone", { remoteAddress: "10.0.0.9" })).toThrow();
    expect(() => controller.startPairing("bad", "Phone", { remoteAddress: "10.0.0.9" })).toThrow(
      "Pairing is locked until the desktop app restarts.",
    );

    const state = controller.getState(true);
    expect(state.failedPasscodeAttempts).toBe(3);
    expect(state.pairingsLocked).toBe(true);
  });

  test("supports passcode pairing, approval, and known-device reconnect with passcode", () => {
    const controller = createRemoteAccessController();
    controller.setEnabled(true);
    const passcode = controller.getState(true).passcode!;

    const pairing = controller.startPairing(passcode, "Safari on MacBook", {
      remoteAddress: "10.0.0.9",
      userAgent: "Safari",
    });
    expect(pairing.session.pendingPairing).toBe(true);

    expect(controller.approvePairing(pairing.requestId)).toBe(true);
    const approved = controller.getPairingStatus(pairing.requestId);
    expect(approved?.status).toBe("approved");
    expect(approved?.deviceToken).toBeString();
    expect(approved?.token).toBeString();

    const restored = controller.startPairing(passcode, "Safari on MacBook", {
      remoteAddress: "10.0.0.9",
      userAgent: "Safari",
    }, approved?.deviceToken);
    expect(restored.session.authenticated).toBe(true);
    expect(restored.session.deviceLabel).toBe("Safari on MacBook");
    expect(restored.token).toBeString();
    expect(controller.authorizeWebSocket(restored.token, false)).toBe(true);
  });

  test("forgetDeviceToken revokes approved devices", () => {
    const controller = createRemoteAccessController();
    controller.setEnabled(true);
    const passcode = controller.getState(true).passcode!;

    const pairing = controller.startPairing(passcode, "Edge on Surface", {
      remoteAddress: "10.0.0.12",
    });
    controller.approvePairing(pairing.requestId);
    const approved = controller.getPairingStatus(pairing.requestId);
    const revokedSessions = controller.forgetDeviceToken(approved?.deviceToken);

    expect(revokedSessions.length).toBeGreaterThan(0);
    expect(controller.getState(true).approvedDevices).toHaveLength(0);
    const passcodeAgain = controller.getState(true).passcode!;
    const nextAttempt = controller.startPairing(passcodeAgain, "Edge on Surface", {
      remoteAddress: "10.0.0.12",
    }, approved?.deviceToken);
    expect(nextAttempt.session.pendingPairing).toBe(true);
  });

  test("approved devices survive disable and re-enable but still require the passcode", () => {
    const controller = createRemoteAccessController();
    controller.setEnabled(true);
    const passcode = controller.getState(true).passcode!;

    const pairing = controller.startPairing(passcode, "Chrome on iPad", {
      remoteAddress: "10.0.0.25",
    });
    controller.approvePairing(pairing.requestId);
    const approved = controller.getPairingStatus(pairing.requestId);

    controller.setEnabled(false);
    expect(controller.getState(true).approvedDevices).toHaveLength(1);
    expect(() => controller.startPairing(passcode, "Chrome on iPad", {
      remoteAddress: "10.0.0.25",
    }, approved?.deviceToken)).toThrow();

    controller.setEnabled(true);
    const nextPasscode = controller.getState(true).passcode!;
    const restored = controller.startPairing(nextPasscode, "Chrome on iPad", {
      remoteAddress: "10.0.0.25",
    }, approved?.deviceToken);
    expect(restored?.session.authenticated).toBe(true);
    expect(restored?.session.deviceLabel).toBe("Chrome on iPad");
  });
});

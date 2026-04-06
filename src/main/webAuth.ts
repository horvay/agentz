import { createHash, randomBytes } from "node:crypto";
import {
  REMOTE_ACCESS_MAX_FAILED_PASSCODE_ATTEMPTS,
  REMOTE_ACCESS_SESSION_TTL_MS,
  type RemoteAccessApprovedDevice,
  type RemoteAccessPairingRequest,
  type RemoteAccessState,
  type RemotePairingPollResponse,
  type RemotePairingStartResponse,
  type RemoteSessionStatus,
} from "../shared/webAuth";

interface ApprovedDeviceRecord extends RemoteAccessApprovedDevice {
  tokenHash: string;
}

interface SessionRecord {
  deviceId: string;
  expiresAt: number;
}

interface PairingRequestRecord extends RemoteAccessPairingRequest {
  status: "pending" | "approved" | "rejected";
  deviceId?: string;
  deviceToken?: string;
  sessionToken?: string;
}

interface CreateRemoteAccessControllerOptions {
  now?: () => number;
  resolveUrls?: () => string[];
  initialApprovedDevices?: Array<{
    id: string;
    label: string;
    approvedAt: number;
    lastSeenAt: number;
    tokenHash: string;
  }>;
  onApprovedDevicesChanged?: (
    devices: Array<{
      id: string;
      label: string;
      approvedAt: number;
      lastSeenAt: number;
      tokenHash: string;
    }>,
  ) => void;
}

interface RemoteRequestContext {
  remoteAddress: string;
  userAgent?: string;
}

export interface RemoteAccessController {
  isEnabled: () => boolean;
  setEnabled: (enabled: boolean) => void;
  getState: (includeSecret?: boolean) => RemoteAccessState;
  subscribe: (listener: (state: RemoteAccessState) => void) => () => void;
  sessionStatus: (sessionToken?: string | null, requestId?: string | null) => RemoteSessionStatus;
  startPairing: (
    passcode: string,
    deviceName: string,
    context: RemoteRequestContext,
    deviceToken?: string | null,
  ) => RemotePairingStartResponse;
  getPairingStatus: (requestId: string) => RemotePairingPollResponse | null;
  approvePairing: (requestId: string) => boolean;
  rejectPairing: (requestId: string) => boolean;
  forgetDevice: (deviceId: string) => string[];
  forgetDeviceToken: (deviceToken?: string | null) => string[];
  revokeSession: (sessionToken?: string | null) => void;
  authorizeWebSocket: (sessionToken: string | null | undefined, isLocal: boolean) => boolean;
  isSessionValid: (sessionToken?: string | null) => boolean;
}

function cloneApprovedDeviceRecords(devices: Iterable<ApprovedDeviceRecord>): ApprovedDeviceRecord[] {
  return [...devices].map((device) => ({
    id: device.id,
    label: device.label,
    approvedAt: device.approvedAt,
    lastSeenAt: device.lastSeenAt,
    tokenHash: device.tokenHash,
  }));
}

function normalizePasscode(value: string): string {
  return value.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function createPasscode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function createOpaqueToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

export function createRemoteAccessController(options: CreateRemoteAccessControllerOptions = {}): RemoteAccessController {
  const listeners = new Set<(state: RemoteAccessState) => void>();
  const approvedDevices = new Map<string, ApprovedDeviceRecord>(
    (options.initialApprovedDevices ?? []).map((device) => [
      device.id,
      {
        id: device.id,
        label: device.label,
        approvedAt: device.approvedAt,
        lastSeenAt: device.lastSeenAt,
        tokenHash: device.tokenHash,
      },
    ]),
  );
  const sessions = new Map<string, SessionRecord>();
  const pairings = new Map<string, PairingRequestRecord>();
  const now = options.now ?? Date.now;
  const resolveUrls = options.resolveUrls ?? (() => []);
  const onApprovedDevicesChanged = options.onApprovedDevicesChanged;
  let enabled = false;
  let passcode = "";
  let failedPasscodeAttempts = 0;
  let pairingsLocked = false;

  const pruneExpiredSessions = (): void => {
    const currentTime = now();
    for (const [token, session] of sessions.entries()) {
      if (session.expiresAt <= currentTime) {
        sessions.delete(token);
      }
    }
  };

  const buildState = (includeSecret: boolean): RemoteAccessState => ({
    enabled,
    pairingsLocked,
    failedPasscodeAttempts,
    maxFailedPasscodeAttempts: REMOTE_ACCESS_MAX_FAILED_PASSCODE_ATTEMPTS,
    passcode: includeSecret && enabled ? passcode : undefined,
    pendingRequests: [...pairings.values()]
      .filter((pairing) => pairing.status === "pending")
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((pairing) => ({
        id: pairing.id,
        deviceName: pairing.deviceName,
        requestedAt: pairing.requestedAt,
        remoteAddress: pairing.remoteAddress,
        userAgent: pairing.userAgent,
      })),
    approvedDevices: [...approvedDevices.values()]
      .sort((a, b) => a.approvedAt - b.approvedAt)
      .map((device) => ({
        id: device.id,
        label: device.label,
        approvedAt: device.approvedAt,
        lastSeenAt: device.lastSeenAt,
      })),
    urls: enabled ? resolveUrls() : [],
  });

  const syncApprovedDevices = (): void => {
    onApprovedDevicesChanged?.(cloneApprovedDeviceRecords(approvedDevices.values()));
  };

  const emit = (): void => {
    const state = buildState(true);
    listeners.forEach((listener) => listener(state));
  };

  const createAnonymousStatus = (requestId?: string | null, message?: string): RemoteSessionStatus => {
    if (!enabled) {
      return {
        enabled: false,
        authenticated: false,
        pairingsLocked: false,
        pendingPairing: false,
        message: "Remote access is disabled on this desktop.",
      };
    }

    if (requestId) {
      const pairing = pairings.get(requestId);
      if (pairing?.status === "pending") {
        return {
          enabled: true,
          authenticated: false,
          pairingsLocked,
          pendingPairing: true,
          requestId,
          message: "Waiting for approval in the desktop app.",
        };
      }
    }

    return {
      enabled: true,
      authenticated: false,
      pairingsLocked,
      pendingPairing: false,
      requestId: undefined,
      message: message ?? (
        pairingsLocked
          ? "Pairing is locked until the desktop app restarts."
          : "Enter the pairing passcode shown in the desktop app to request access."
      ),
    };
  };

  const createSessionForDevice = (device: ApprovedDeviceRecord): { token: string; session: RemoteSessionStatus } => {
    pruneExpiredSessions();
    const token = createOpaqueToken();
    const currentTime = now();
    device.lastSeenAt = currentTime;
    syncApprovedDevices();
    sessions.set(token, {
      deviceId: device.id,
      expiresAt: currentTime + REMOTE_ACCESS_SESSION_TTL_MS,
    });
    return {
      token,
      session: {
        enabled: true,
        authenticated: true,
        pairingsLocked,
        pendingPairing: false,
        deviceLabel: device.label,
        message: `Connected as ${device.label}.`,
      },
    };
  };

  const forgetDeviceById = (deviceId: string): string[] => {
    const device = approvedDevices.get(deviceId);
    if (!device) return [];
    approvedDevices.delete(deviceId);
    const revokedSessions: string[] = [];
    for (const [token, session] of sessions.entries()) {
      if (session.deviceId !== deviceId) continue;
      sessions.delete(token);
      revokedSessions.push(token);
    }
    syncApprovedDevices();
    emit();
    return revokedSessions;
  };

  return {
    isEnabled: () => enabled,
    setEnabled: (nextEnabled) => {
      if (enabled === nextEnabled) return;
      enabled = nextEnabled;
      failedPasscodeAttempts = 0;
      pairingsLocked = false;
      pairings.clear();
      sessions.clear();
      passcode = nextEnabled ? createPasscode() : "";
      emit();
    },
    getState: (includeSecret = false) => buildState(includeSecret),
    subscribe: (listener) => {
      listeners.add(listener);
      listener(buildState(true));
      return () => {
        listeners.delete(listener);
      };
    },
    sessionStatus: (sessionToken, requestId) => {
      pruneExpiredSessions();
      if (sessionToken) {
        const session = sessions.get(sessionToken);
        if (session) {
          const device = approvedDevices.get(session.deviceId);
          if (device) {
            device.lastSeenAt = now();
            return {
              enabled: true,
              authenticated: true,
              pairingsLocked,
              pendingPairing: false,
              deviceLabel: device.label,
              message: `Connected as ${device.label}.`,
            };
          }
        }
      }
      return createAnonymousStatus(requestId);
    },
    startPairing: (rawPasscode, deviceName, context, deviceToken) => {
      if (!enabled) {
        throw new Error("Remote access is disabled.");
      }
      if (pairingsLocked) {
        throw new Error("Pairing is locked until the desktop app restarts.");
      }

      const normalizedPasscode = normalizePasscode(rawPasscode);
      if (!normalizedPasscode || normalizedPasscode !== normalizePasscode(passcode)) {
        failedPasscodeAttempts += 1;
        if (failedPasscodeAttempts >= REMOTE_ACCESS_MAX_FAILED_PASSCODE_ATTEMPTS) {
          pairingsLocked = true;
        }
        emit();
        throw new Error(
          pairingsLocked
            ? "Pairing is locked until the desktop app restarts."
            : "Incorrect pairing passcode.",
        );
      }

      const approvedDevice =
        deviceToken
          ? [...approvedDevices.values()].find((entry) => entry.tokenHash === hashToken(deviceToken))
          : undefined;
      if (approvedDevice) {
        const session = createSessionForDevice(approvedDevice);
        emit();
        return {
          token: session.token,
          deviceToken,
          session: session.session,
        };
      }

      const requestId = createOpaqueToken(18);
      const currentTime = now();
      pairings.set(requestId, {
        id: requestId,
        deviceName: deviceName.trim() || "Unknown device",
        requestedAt: currentTime,
        remoteAddress: context.remoteAddress,
        userAgent: context.userAgent,
        status: "pending",
      });
      emit();
      return {
        requestId,
        session: createAnonymousStatus(requestId, "Waiting for approval in the desktop app."),
      };
    },
    getPairingStatus: (requestId) => {
      const pairing = pairings.get(requestId);
      if (!pairing || !enabled) {
        return null;
      }
      if (pairing.status === "pending") {
        return {
          status: "pending",
          session: createAnonymousStatus(requestId, "Waiting for approval in the desktop app."),
        };
      }
      if (pairing.status === "rejected") {
        return {
          status: "rejected",
          session: createAnonymousStatus(undefined, "That pairing request was rejected."),
        };
      }
      const device = pairing.deviceId ? approvedDevices.get(pairing.deviceId) : undefined;
      return {
        status: "approved",
        token: pairing.sessionToken,
        deviceToken: pairing.deviceToken,
        session: {
          enabled: true,
          authenticated: true,
          pairingsLocked,
          pendingPairing: false,
          deviceLabel: device?.label ?? pairing.deviceName,
          message: `Connected as ${device?.label ?? pairing.deviceName}.`,
        },
      };
    },
    approvePairing: (requestId) => {
      const pairing = pairings.get(requestId);
      if (!enabled || !pairing || pairing.status !== "pending") {
        return false;
      }
      const currentTime = now();
      const deviceId = createOpaqueToken(12);
      const deviceToken = createOpaqueToken(24);
      const deviceLabel = pairing.deviceName;
      const device: ApprovedDeviceRecord = {
        id: deviceId,
        label: deviceLabel,
        approvedAt: currentTime,
        lastSeenAt: currentTime,
        tokenHash: hashToken(deviceToken),
      };
      approvedDevices.set(deviceId, device);
      syncApprovedDevices();
      const session = createSessionForDevice(device);
      pairing.status = "approved";
      pairing.deviceId = deviceId;
      pairing.deviceToken = deviceToken;
      pairing.sessionToken = session.token;
      emit();
      return true;
    },
    rejectPairing: (requestId) => {
      const pairing = pairings.get(requestId);
      if (!pairing || pairing.status !== "pending") {
        return false;
      }
      pairing.status = "rejected";
      emit();
      return true;
    },
    forgetDevice: (deviceId) => forgetDeviceById(deviceId),
    forgetDeviceToken: (deviceToken) => {
      if (!deviceToken) return [];
      const tokenHash = hashToken(deviceToken);
      const device = [...approvedDevices.values()].find((entry) => entry.tokenHash === tokenHash);
      if (!device) return [];
      return forgetDeviceById(device.id);
    },
    revokeSession: (sessionToken) => {
      if (!sessionToken) return;
      sessions.delete(sessionToken);
    },
    authorizeWebSocket: (sessionToken, isLocal) => {
      if (isLocal) return true;
      if (!enabled) return false;
      return Boolean(sessionToken && sessions.has(sessionToken));
    },
    isSessionValid: (sessionToken) => {
      pruneExpiredSessions();
      if (!sessionToken) return false;
      return sessions.has(sessionToken);
    },
  };
}

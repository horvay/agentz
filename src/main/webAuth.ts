import { randomBytes } from "node:crypto";
import type { WebAuthLoginResponse, WebAuthSessionStatus } from "../shared/webAuth";
import { authenticateLinuxSystemUser, suggestedSystemUsername } from "./linuxPamAuth";

const SESSION_TTL_MS = 1000 * 60 * 60 * 12;

interface SessionRecord {
  username: string;
  expiresAt: number;
}

export interface RpcAuthController {
  readonly enabled: boolean;
  sessionStatus: (token?: string | null) => WebAuthSessionStatus;
  login: (username: string, password: string) => Promise<WebAuthLoginResponse | null>;
  logout: (token?: string | null) => void;
  authorizeWebSocket: (token?: string | null) => boolean;
}

function pruneExpiredSessions(sessions: Map<string, SessionRecord>, now = Date.now()): void {
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt <= now) {
      sessions.delete(token);
    }
  }
}

function createUnsupportedSystemRpcAuth(platform: NodeJS.Platform): RpcAuthController {
  const platformLabel = platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform;

  return {
    enabled: true,
    sessionStatus: () => ({
      enabled: true,
      authenticated: false,
      provider: "system",
      supported: false,
      platformLabel,
      message: "System-account web login is currently implemented only on Linux.",
    }),
    login: async () => null,
    logout: () => {},
    authorizeWebSocket: () => false,
  };
}

function createLinuxPamRpcAuth(): RpcAuthController {
  const sessions = new Map<string, SessionRecord>();
  const usernameHint = suggestedSystemUsername();

  const sessionStatus = (token?: string | null): WebAuthSessionStatus => {
    pruneExpiredSessions(sessions);
    if (!token) {
      return {
        enabled: true,
        authenticated: false,
        provider: "system",
        supported: true,
        platformLabel: "Linux",
        suggestedUsername: usernameHint,
        message: "Sign in with the Linux account on this machine.",
      };
    }

    const session = sessions.get(token);
    if (!session) {
      return {
        enabled: true,
        authenticated: false,
        provider: "system",
        supported: true,
        platformLabel: "Linux",
        suggestedUsername: usernameHint,
        message: "Sign in with the Linux account on this machine.",
      };
    }

    return {
      enabled: true,
      authenticated: true,
      provider: "system",
      supported: true,
      platformLabel: "Linux",
      username: session.username,
      suggestedUsername: usernameHint,
      message: "Authenticated with the Linux account on this machine.",
    };
  };

  console.log("[web-auth] Web login enabled via Linux system authentication.");

  return {
    enabled: true,
    sessionStatus,
    login: async (username, password) => {
      pruneExpiredSessions(sessions);
      const valid = await authenticateLinuxSystemUser(username, password);
      if (!valid) {
        return null;
      }

      const normalizedUsername = username.trim();
      const token = randomBytes(24).toString("base64url");
      sessions.set(token, {
        username: normalizedUsername,
        expiresAt: Date.now() + SESSION_TTL_MS,
      });

      return {
        token,
        session: {
          enabled: true,
          authenticated: true,
          provider: "system",
          supported: true,
          platformLabel: "Linux",
          username: normalizedUsername,
          suggestedUsername: usernameHint,
          message: "Authenticated with the Linux account on this machine.",
        },
      };
    },
    logout: (token) => {
      if (!token) return;
      sessions.delete(token);
    },
    authorizeWebSocket: (token) => {
      pruneExpiredSessions(sessions);
      if (!token) return false;
      return sessions.has(token);
    },
  };
}

export function createDisabledRpcAuth(): RpcAuthController {
  return {
    enabled: false,
    sessionStatus: () => ({
      enabled: false,
      authenticated: true,
      provider: "disabled",
      supported: true,
    }),
    login: async () => null,
    logout: () => {},
    authorizeWebSocket: () => true,
  };
}

export function createWebRpcAuth(platform: NodeJS.Platform = process.platform): RpcAuthController {
  if (platform === "linux") {
    return createLinuxPamRpcAuth();
  }
  return createUnsupportedSystemRpcAuth(platform);
}

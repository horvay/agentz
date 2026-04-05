import { randomBytes } from "node:crypto";
import type { WebAuthLoginResponse, WebAuthSessionStatus } from "../shared/webAuth";
import { authenticateSystemUser, platformLabel, suggestedSystemUsername } from "./systemAuth";

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

function createSystemRpcAuth(platform: NodeJS.Platform): RpcAuthController {
  const sessions = new Map<string, SessionRecord>();
  const usernameHint = suggestedSystemUsername();
  const label = platformLabel(platform);
  const loginPrompt = `Sign in with the ${label} account on this machine.`;
  const loginSuccess = `Authenticated with the ${label} account on this machine.`;

  const sessionStatus = (token?: string | null): WebAuthSessionStatus => {
    pruneExpiredSessions(sessions);
    if (!token) {
      return {
        enabled: true,
        authenticated: false,
        provider: "system",
        supported: true,
        platformLabel: label,
        suggestedUsername: usernameHint,
        message: loginPrompt,
      };
    }

    const session = sessions.get(token);
    if (!session) {
      return {
        enabled: true,
        authenticated: false,
        provider: "system",
        supported: true,
        platformLabel: label,
        suggestedUsername: usernameHint,
        message: loginPrompt,
      };
    }

    return {
      enabled: true,
      authenticated: true,
      provider: "system",
      supported: true,
      platformLabel: label,
      username: session.username,
      suggestedUsername: usernameHint,
      message: loginSuccess,
    };
  };

  console.log(`[web-auth] Web login enabled via ${label} system authentication.`);

  return {
    enabled: true,
    sessionStatus,
    login: async (username, password) => {
      pruneExpiredSessions(sessions);
      const valid = await authenticateSystemUser(platform, username, password);
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
          platformLabel: label,
          username: normalizedUsername,
          suggestedUsername: usernameHint,
          message: loginSuccess,
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
  if (platform === "linux" || platform === "darwin" || platform === "win32") {
    return createSystemRpcAuth(platform);
  }
  return {
    enabled: true,
    sessionStatus: () => ({
      enabled: true,
      authenticated: false,
      provider: "system",
      supported: false,
      platformLabel: platformLabel(platform),
      message: `System-account web login is not supported on ${platformLabel(platform)}.`,
    }),
    login: async () => null,
    logout: () => {},
    authorizeWebSocket: () => false,
  };
}

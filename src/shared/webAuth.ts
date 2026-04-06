export const REMOTE_ACCESS_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
export const REMOTE_ACCESS_MAX_FAILED_PASSCODE_ATTEMPTS = 3;

export interface RemoteAccessPairingRequest {
  id: string;
  deviceName: string;
  requestedAt: number;
  remoteAddress: string;
  userAgent?: string;
}

export interface RemoteAccessApprovedDevice {
  id: string;
  label: string;
  approvedAt: number;
  lastSeenAt: number;
}

export interface RemoteAccessState {
  enabled: boolean;
  pairingsLocked: boolean;
  failedPasscodeAttempts: number;
  maxFailedPasscodeAttempts: number;
  passcode?: string;
  pendingRequests: RemoteAccessPairingRequest[];
  approvedDevices: RemoteAccessApprovedDevice[];
  urls: string[];
}

export interface RemoteSessionStatus {
  enabled: boolean;
  authenticated: boolean;
  pairingsLocked: boolean;
  pendingPairing: boolean;
  deviceLabel?: string;
  requestId?: string;
  message?: string;
}

export interface RemotePairingStartResponse {
  session: RemoteSessionStatus;
  requestId?: string;
  token?: string;
  deviceToken?: string;
}

export interface RemotePairingPollResponse {
  status: "pending" | "approved" | "rejected";
  session: RemoteSessionStatus;
  token?: string;
  deviceToken?: string;
}

export interface WebSocketCloseInfo {
  code: number;
  reason: string;
}

export interface WebAuthErrorResponse {
  message: string;
}

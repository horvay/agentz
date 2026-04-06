import type {
  RemotePairingStartResponse,
  RemotePairingPollResponse,
  RemoteSessionStatus,
  WebAuthErrorResponse,
} from "../shared/webAuth";

const REMOTE_DEVICE_TOKEN_STORAGE_KEY = "agentz.remoteDeviceToken.v1";
const REMOTE_PAIRING_REQUEST_STORAGE_KEY = "agentz.remotePairingRequest.v1";
const REMOTE_SESSION_TOKEN_STORAGE_KEY = "agentz.remoteSessionToken.v1";
const LOCAL_RPC_HTTP_BASE_URL = "http://127.0.0.1:4599";
const LOCAL_RPC_WS_BASE_URL = "ws://127.0.0.1:4599";
const RPC_WS_PROTOCOL = "agentz-rpc";
const RPC_WS_AUTH_PROTOCOL_PREFIX = "agentz-auth.";

function authHeaders(token?: string | null): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function isElectronRenderer(): boolean {
  if (typeof navigator === "undefined") return false;
  return /\bElectron\/\d+/i.test(navigator.userAgent);
}

function isRemoteWebRuntime(): boolean {
  return typeof window !== "undefined" && window.location.protocol !== "file:" && !isElectronRenderer();
}

function resolveHttpBaseUrl(): string {
  if (isRemoteWebRuntime()) {
    return window.location.origin;
  }
  return LOCAL_RPC_HTTP_BASE_URL;
}

async function parseResponseJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T | WebAuthErrorResponse;
  if (!response.ok) {
    const message =
      typeof (payload as WebAuthErrorResponse).message === "string"
        ? (payload as WebAuthErrorResponse).message
        : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export function resolveRpcUrl(): string {
  if (isRemoteWebRuntime()) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${window.location.host}`;
  }
  return new URL(LOCAL_RPC_WS_BASE_URL).toString();
}

export function resolveRpcProtocols(token?: string | null): string[] {
  const protocols = [RPC_WS_PROTOCOL];
  if (token) {
    protocols.push(`${RPC_WS_AUTH_PROTOCOL_PREFIX}${token}`);
  }
  return protocols;
}

export function loadStoredRemoteDeviceToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(REMOTE_DEVICE_TOKEN_STORAGE_KEY);
}

export function storeRemoteDeviceToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    window.localStorage.setItem(REMOTE_DEVICE_TOKEN_STORAGE_KEY, token);
    return;
  }
  window.localStorage.removeItem(REMOTE_DEVICE_TOKEN_STORAGE_KEY);
}

export function loadPendingPairingRequestId(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(REMOTE_PAIRING_REQUEST_STORAGE_KEY);
}

export function storePendingPairingRequestId(requestId: string | null): void {
  if (typeof window === "undefined") return;
  if (requestId) {
    window.sessionStorage.setItem(REMOTE_PAIRING_REQUEST_STORAGE_KEY, requestId);
    return;
  }
  window.sessionStorage.removeItem(REMOTE_PAIRING_REQUEST_STORAGE_KEY);
}

export function loadStoredRemoteSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(REMOTE_SESSION_TOKEN_STORAGE_KEY);
}

export function storeRemoteSessionToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    window.sessionStorage.setItem(REMOTE_SESSION_TOKEN_STORAGE_KEY, token);
    return;
  }
  window.sessionStorage.removeItem(REMOTE_SESSION_TOKEN_STORAGE_KEY);
}

export async function fetchRemoteAccessStatus(
  sessionToken?: string | null,
  requestId?: string | null,
): Promise<RemoteSessionStatus> {
  const url = new URL(`${resolveHttpBaseUrl()}/remote-access/status`);
  if (requestId) {
    url.searchParams.set("requestId", requestId);
  }
  const response = await fetch(url, {
    method: "GET",
    headers: authHeaders(sessionToken),
  });
  return parseResponseJson<RemoteSessionStatus>(response);
}

export async function startRemotePairing(
  passcode: string,
  deviceName: string,
  deviceToken?: string | null,
): Promise<RemotePairingStartResponse> {
  const response = await fetch(`${resolveHttpBaseUrl()}/remote-access/pairing/start`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ passcode, deviceName, deviceToken }),
  });
  return parseResponseJson<RemotePairingStartResponse>(response);
}

export async function pollRemotePairing(requestId: string): Promise<RemotePairingPollResponse> {
  const response = await fetch(`${resolveHttpBaseUrl()}/remote-access/pairing/${encodeURIComponent(requestId)}`, {
    method: "GET",
  });
  return parseResponseJson<RemotePairingPollResponse>(response);
}

export async function logoutRemoteSession(token?: string | null): Promise<void> {
  await fetch(`${resolveHttpBaseUrl()}/remote-access/logout`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

export async function forgetRemoteDevice(deviceToken?: string | null): Promise<void> {
  await fetch(`${resolveHttpBaseUrl()}/remote-access/forget-device`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ deviceToken }),
  });
}

export function describeThisDevice(): string {
  if (typeof navigator === "undefined") return "Unknown device";
  const platform = navigator.platform?.trim() || "Unknown platform";
  const agent = navigator.userAgent;
  if (/iphone|ipad/i.test(agent)) return `Safari on ${platform}`;
  if (/edg/i.test(agent)) return `Edge on ${platform}`;
  if (/chrome/i.test(agent)) return `Chrome on ${platform}`;
  if (/firefox/i.test(agent)) return `Firefox on ${platform}`;
  if (/safari/i.test(agent)) return `Safari on ${platform}`;
  return `Browser on ${platform}`;
}

export { isRemoteWebRuntime };

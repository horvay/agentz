import type { WebAuthErrorResponse, WebAuthLoginResponse, WebAuthSessionStatus } from "../shared/webAuth";

const AUTH_TOKEN_STORAGE_KEY = "agentz.webAuthToken.v1";
const RPC_HTTP_BASE_URL = "http://127.0.0.1:4599";
const RPC_WS_BASE_URL = "ws://127.0.0.1:4599";

function authHeaders(token?: string | null): HeadersInit {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
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

export function resolveRpcUrl(token?: string | null): string {
  const url = new URL(RPC_WS_BASE_URL);
  if (token) {
    url.searchParams.set("token", token);
  }
  return url.toString();
}

export function loadStoredWebAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
}

export function storeWebAuthToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) {
    window.sessionStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    return;
  }
  window.sessionStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

export async function fetchWebAuthSession(token?: string | null): Promise<WebAuthSessionStatus> {
  const response = await fetch(`${RPC_HTTP_BASE_URL}/auth/session`, {
    method: "GET",
    headers: authHeaders(token),
  });
  return parseResponseJson<WebAuthSessionStatus>(response);
}

export async function loginWebAuth(username: string, password: string): Promise<WebAuthLoginResponse> {
  const response = await fetch(`${RPC_HTTP_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ username, password }),
  });
  return parseResponseJson<WebAuthLoginResponse>(response);
}

export async function logoutWebAuth(token?: string | null): Promise<void> {
  await fetch(`${RPC_HTTP_BASE_URL}/auth/logout`, {
    method: "POST",
    headers: authHeaders(token),
  });
}

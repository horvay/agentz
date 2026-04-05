export type WebAuthProvider = "disabled" | "system";

export interface WebAuthSessionStatus {
  enabled: boolean;
  authenticated: boolean;
  provider?: WebAuthProvider;
  supported?: boolean;
  username?: string;
  suggestedUsername?: string;
  platformLabel?: string;
  message?: string;
}

export interface WebAuthLoginResponse {
  token: string;
  session: WebAuthSessionStatus;
}

export interface WebAuthErrorResponse {
  message: string;
}

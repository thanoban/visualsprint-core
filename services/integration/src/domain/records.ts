export type CalendarProviderName = "google" | "microsoft";
export type ConnectionStatus =
  | "authorizing"
  | "exchanging"
  | "exchange_unknown"
  | "initializing"
  | "connected"
  | "reauth_required"
  | "configuration_error"
  | "disconnected";
export type Connection = {
  workspaceId: string;
  id: string;
  ownerId: string;
  sessionId: string;
  provider: CalendarProviderName;
  status: ConnectionStatus;
  calendarId: string;
  calendarName: string;
  version: number;
  oauthHash: string;
  oauthCipher: string | null;
  oauthExpiresAt: Date;
  tokenCipher: string | null;
  tokenExpiresAt: Date | null;
  exchangeAt: Date | null;
  errorCode: string | null;
  grantId: string | null;
  automatic: boolean;
  leaseToken: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
};
export type Calendar = { id: string; name: string; primary: boolean };
export type Tokens = { accessToken: string; refreshToken: string; expiresAt: Date };

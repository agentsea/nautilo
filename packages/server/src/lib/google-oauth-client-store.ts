import {
  decodeGoogleOAuthClientJsonFromEnv,
  encodeGoogleOAuthClientJsonForEnv,
  GOOGLE_OAUTH_CLIENT_JSON_ENV,
  transaction,
  validateGoogleOAuthClientJsonText,
  type GoogleOAuthClientJsonValidationResult,
} from "@nautilo/config-guard";

export { GOOGLE_OAUTH_CLIENT_JSON_ENV };

export type ValidateGoogleOAuthClientJsonResult = GoogleOAuthClientJsonValidationResult;

/** Validate plain Google OAuth client JSON (not base64). Never throws. */
export function validateGoogleOAuthClientJson(
  text: string,
): ValidateGoogleOAuthClientJsonResult {
  return validateGoogleOAuthClientJsonText(text);
}

export function getGoogleOAuthClient(): string | null {
  const raw = process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
  if (!raw?.trim()) return null;
  const decoded = decodeGoogleOAuthClientJsonFromEnv(raw);
  if (!decoded) return null;
  const validation = validateGoogleOAuthClientJson(decoded);
  return validation.ok ? decoded : null;
}

export function isGoogleOAuthClientConfigured(): boolean {
  return getGoogleOAuthClient() !== null;
}

export type SetGoogleOAuthClientSuccess = {
  configured: true;
  clientId: string;
};

export type SetGoogleOAuthClientFailure = {
  configured: false;
  detail: string;
};

export type SetGoogleOAuthClientResult =
  | SetGoogleOAuthClientSuccess
  | SetGoogleOAuthClientFailure;

export async function setGoogleOAuthClient(
  json: string,
): Promise<SetGoogleOAuthClientResult> {
  const validation = validateGoogleOAuthClientJson(json);
  if (!validation.ok) {
    return { configured: false, detail: validation.detail };
  }

  const encoded = encodeGoogleOAuthClientJsonForEnv(json.trim());
  const result = await transaction({
    operations: [{ type: "set", key: GOOGLE_OAUTH_CLIENT_JSON_ENV, value: encoded }],
    healthCheck: "none",
    overwrite: true,
    reason: "Google OAuth client JSON uploaded via server API",
    actor: "agent",
  });

  if (!result.success) {
    return {
      configured: false,
      detail: result.error ?? "config-guard transaction failed",
    };
  }

  process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV] = encoded;
  return { configured: true, clientId: validation.maskedClientId };
}

export async function clearGoogleOAuthClient(): Promise<boolean> {
  const result = await transaction({
    operations: [{ type: "remove", key: GOOGLE_OAUTH_CLIENT_JSON_ENV }],
    healthCheck: "none",
    overwrite: true,
    reason: "Google OAuth client JSON cleared via server API",
    actor: "agent",
  });

  if (!result.success) {
    return false;
  }

  delete process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
  return true;
}

export function googleOAuthClientStatus(): {
  configured: boolean;
  clientId: string | null;
} {
  const raw = process.env[GOOGLE_OAUTH_CLIENT_JSON_ENV];
  if (!raw?.trim()) {
    return { configured: false, clientId: null };
  }
  const decoded = decodeGoogleOAuthClientJsonFromEnv(raw);
  if (!decoded) {
    return { configured: false, clientId: null };
  }
  const validation = validateGoogleOAuthClientJson(decoded);
  if (!validation.ok) {
    return { configured: false, clientId: null };
  }
  return { configured: true, clientId: validation.maskedClientId };
}

/** @internal Exported for unit tests — inject config-guard transaction. */
export type GoogleOAuthClientStoreDeps = {
  setGoogleOAuthClient: typeof setGoogleOAuthClient;
  clearGoogleOAuthClient: typeof clearGoogleOAuthClient;
  googleOAuthClientStatus: typeof googleOAuthClientStatus;
  getGoogleOAuthClient: typeof getGoogleOAuthClient;
};

export const defaultGoogleOAuthClientStoreDeps: GoogleOAuthClientStoreDeps = {
  setGoogleOAuthClient,
  clearGoogleOAuthClient,
  googleOAuthClientStatus,
  getGoogleOAuthClient,
};

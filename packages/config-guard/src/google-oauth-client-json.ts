/**
 * M196 — shared validation for Google OAuth client JSON stored base64-encoded
 * in `GOOGLE_OAUTH_CLIENT_JSON` (instance.env via config-guard).
 */

export const GOOGLE_OAUTH_CLIENT_JSON_ENV = "GOOGLE_OAUTH_CLIENT_JSON";

export type GoogleOAuthClientJsonValidationSuccess = {
  ok: true;
  clientId: string;
  maskedClientId: string;
};

export type GoogleOAuthClientJsonValidationFailure = {
  ok: false;
  detail: string;
};

export type GoogleOAuthClientJsonValidationResult =
  | GoogleOAuthClientJsonValidationSuccess
  | GoogleOAuthClientJsonValidationFailure;

function extractOAuthCredentials(
  parsed: unknown,
): { clientId: string; clientSecret: string } | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const creds = root["installed"] ?? root["web"];
  if (!creds || typeof creds !== "object" || Array.isArray(creds)) return null;
  const block = creds as Record<string, unknown>;
  const clientId = block["client_id"];
  const clientSecret = block["client_secret"];
  if (typeof clientId !== "string" || typeof clientSecret !== "string") return null;
  if (clientId.trim() === "" || clientSecret.trim() === "") return null;
  return { clientId, clientSecret };
}

/** Mask client id for operator surfaces (prefix + ellipsis). */
export function maskGoogleOAuthClientId(clientId: string): string {
  const trimmed = clientId.trim();
  if (trimmed.length <= 12) return `${trimmed.slice(0, 4)}…`;
  return `${trimmed.slice(0, 12)}…`;
}

/** Validate plain UTF-8 Google OAuth client JSON text (not base64). */
export function validateGoogleOAuthClientJsonText(
  text: string,
): GoogleOAuthClientJsonValidationResult {
  const trimmed = text.trim();
  if (trimmed === "") {
    return { ok: false, detail: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, detail: "invalid JSON" };
  }

  const creds = extractOAuthCredentials(parsed);
  if (!creds) {
    return {
      ok: false,
      detail: "missing installed or web object with client_id and client_secret",
    };
  }

  return {
    ok: true,
    clientId: creds.clientId,
    maskedClientId: maskGoogleOAuthClientId(creds.clientId),
  };
}

function isValidBase64Payload(value: string): boolean {
  const t = value.trim();
  if (t.length === 0) return false;
  if (t.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return false;
  try {
    Buffer.from(t, "base64");
    return true;
  } catch {
    return false;
  }
}

/** Config-guard validator: base64 env value decoding to valid OAuth client JSON. */
export function validateGoogleOAuthClientJsonBase64Env(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return "required";
  if (!isValidBase64Payload(trimmed)) {
    return "must be valid base64-encoded UTF-8 JSON";
  }

  let decoded: string;
  try {
    decoded = Buffer.from(trimmed, "base64").toString("utf8");
  } catch {
    return "must be valid base64-encoded UTF-8 JSON";
  }

  const result = validateGoogleOAuthClientJsonText(decoded);
  return result.ok ? null : result.detail;
}

export function encodeGoogleOAuthClientJsonForEnv(json: string): string {
  return Buffer.from(json, "utf8").toString("base64");
}

export function decodeGoogleOAuthClientJsonFromEnv(encoded: string): string | null {
  const trimmed = encoded.trim();
  if (trimmed === "") return null;
  if (!isValidBase64Payload(trimmed)) return null;
  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

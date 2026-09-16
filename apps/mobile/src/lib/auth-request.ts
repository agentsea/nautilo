import { HANDLE_RE, normalizeHandle } from "@nautilo/types";

/** The stable Native Logto authorization contract used by every mobile mode. */
const NATIVE_AUTH_SCOPES = ["openid", "profile", "offline_access"] as const;

/**
 * Deliberately narrow: invite enrollment may influence only Logto's hosted
 * first screen and (when canonical) its handle hint.  Invite bearer/state,
 * PINs, recovery material, server credentials, and token custody cannot be
 * passed through this public auth option.
 */
export type NativeAuthMode =
  | Readonly<{ kind: "sign-in" }>
  | Readonly<{ kind: "invite-registration"; loginHint?: string }>;

export interface NativeAuthRequestConfig {
  clientId: string;
  redirectUri: string;
  resource: string | null;
}

export interface NativeAuthRequestParameters {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  usePKCE: true;
  extraParams: Record<string, string>;
}

export interface NativeCodeExchangeInput extends NativeAuthRequestConfig {
  code: string;
  codeVerifier: string;
}

export interface NativeCodeExchangeParameters {
  clientId: string;
  code: string;
  redirectUri: string;
  extraParams: Record<string, string>;
}

export type NativeAuthFailureCode =
  | "cancelled"
  | "callback-error"
  | "missing-authorization-code"
  | "missing-logto-config"
  | "exchange-failed";

export type NativeAuthPromptResult =
  | Readonly<{ type: "cancel" | "dismiss" | "opened" | "locked" }>
  | Readonly<{
      type: "success" | "error";
      params: Readonly<Record<string, string>>;
      error?: unknown;
    }>;

export type NativeAuthPromptOutcome =
  | Readonly<{ kind: "authorization-code"; code: string }>
  | Readonly<{ kind: "failure"; code: NativeAuthFailureCode }>;

/** Typed, provider-text-free error consumed by the ordinary auth provider. */
export class NativeAuthError extends Error {
  readonly code: NativeAuthFailureCode;

  constructor(code: NativeAuthFailureCode) {
    super(authFailureMessage(code));
    this.name = "NativeAuthError";
    this.code = code;
  }
}

/**
 * Login hints are advisory. The handle form owns validation; this boundary
 * merely normalizes a canonical handle and omits malformed/empty input so it
 * can never become an unbounded provider parameter.
 */
function normalizeRegistrationLoginHint(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeHandle(value);
  return HANDLE_RE.test(normalized) ? normalized : null;
}

export function createNativeAuthRequestParameters(
  config: NativeAuthRequestConfig,
  mode: NativeAuthMode = { kind: "sign-in" },
): NativeAuthRequestParameters {
  const extraParams: Record<string, string> = {
    // Native Logto needs consent to issue offline_access. Ordinary sign-in
    // must also force fresh account entry: the platform auth sheet can retain
    // Logto's browser session after local sign-out and otherwise silently
    // restore the previous Human. Invite registration already forces Logto's
    // registration screen, so it keeps the narrower consent prompt.
    prompt: mode.kind === "sign-in" ? "login consent" : "consent",
    ...(config.resource ? { resource: config.resource } : {}),
  };

  if (mode.kind === "invite-registration") {
    extraParams.first_screen = "register";
    const loginHint = normalizeRegistrationLoginHint(mode.loginHint);
    if (loginHint) extraParams.login_hint = loginHint;
  }

  return {
    clientId: config.clientId,
    redirectUri: config.redirectUri,
    scopes: NATIVE_AUTH_SCOPES,
    usePKCE: true,
    extraParams,
  };
}

/**
 * The authorization response is intentionally exchanged through the same
 * per-server resource contract. Registration routing is authorization-page
 * only and never rides the token exchange.
 */
export function createNativeCodeExchangeParameters(
  input: NativeCodeExchangeInput,
): NativeCodeExchangeParameters {
  return {
    clientId: input.clientId,
    code: input.code,
    redirectUri: input.redirectUri,
    extraParams: {
      code_verifier: input.codeVerifier,
      ...(input.resource ? { resource: input.resource } : {}),
    },
  };
}

/**
 * Pure classification keeps native-module tests out of the failure taxonomy.
 * Expo v57 returns cancel/dismiss separately and places callback errors in an
 * `error` result; none of their raw diagnostic text crosses this boundary.
 */
export function classifyAuthPromptResult(result: NativeAuthPromptResult): NativeAuthPromptOutcome {
  switch (result.type) {
    case "cancel":
    case "dismiss":
    case "opened":
    case "locked":
      return { kind: "failure", code: "cancelled" };
    case "error":
      return { kind: "failure", code: "callback-error" };
    case "success": {
      const code = result.params.code?.trim();
      return code
        ? { kind: "authorization-code", code }
        : { kind: "failure", code: "missing-authorization-code" };
    }
  }
}

/** Safe display copy; UI needs only this code/message, never provider text. */
export function authFailureMessage(code: NativeAuthFailureCode): string {
  switch (code) {
    case "cancelled":
      return "Sign-in cancelled";
    case "missing-logto-config":
      return "This server isn't configured for mobile sign-in (missing Logto).";
    case "callback-error":
    case "missing-authorization-code":
    case "exchange-failed":
      return "Sign-in failed";
  }
}

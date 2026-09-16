/**
 * M057 — RFC 8628 Device Authorization Grant client.
 *
 * Pure functions over `fetch`, unit-testable in isolation. The state-machine
 * is exposed as an async generator so CLI callers can drive terminal output by
 * pattern-matching on each event.
 *
 * M062 — `revokeRefreshToken` uses `@nautilo/logger` for warn lines only;
 * everything else remains fetch-only.
 */

import { warn } from "@nautilo/logger";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  /**
   * RFC 8628 §3.2 marks this OPTIONAL with a 5s default. Logto OSS
   * omits it (as of v1.38). `runDeviceFlow` substitutes 5 when
   * undefined; consumers should treat this field as advisory.
   */
  interval?: number;
}

export interface TokenResponse {
  access_token: string;
  /**
   * Required since M060. The legacy-named `Nautilo TUI` device-flow app ships
   * with `customClientMetadata.alwaysIssueRefreshToken: true` (alongside
   * `isDeviceFlow: true`), so every device-grant + refresh-grant token
   * response from Logto carries a refresh_token. If a future Logto
   * config regression strips it, `runDeviceFlow` callers blow up at
   * the type boundary instead of silently bouncing the user back to
   * the device-code prompt every hour.
   */
  refresh_token: string;
  id_token: string;
  expires_in: number;
}

export type DeviceFlowEvent =
  | { type: "code"; data: DeviceCodeResponse }
  | { type: "polling"; intervalMs: number }
  | { type: "success"; data: TokenResponse }
  | { type: "error"; message: string; recoverable: boolean };

export interface DeviceFlowConfig {
  endpoint: string; // LOGTO_ENDPOINT, e.g. "http://127.0.0.1:3301"
  appId: string;    // legacy compatibility key: LOGTO_TUI_APP_ID
  resource: string; // LOGTO_RESOURCE / API audience
  scope?: string;   // default "openid offline_access profile email"
  signal?: AbortSignal;
  /**
   * D112 Phase 8 — query params merged onto Logto verification URLs from the device-code response
   * (e.g. `first_screen=reset_password`).
   */
  verificationUriExtraParams?: Record<string, string> | undefined;
}

const DEFAULT_SCOPE = "openid offline_access profile email";

function mergeVerificationUriParams(
  code: DeviceCodeResponse,
  extra?: Record<string, string>  ,
): DeviceCodeResponse {
  if (!extra || Object.keys(extra).length === 0) return code;
  const apply = (url: string | undefined): string | undefined => {
    if (!url) return url;
    try {
      const u = new URL(url);
      for (const [k, v] of Object.entries(extra)) {
        u.searchParams.set(k, v);
      }
      return u.toString();
    } catch {
      return url;
    }
  };
  const mergedComplete =
    code.verification_uri_complete !== undefined
      ? apply(code.verification_uri_complete)
      : undefined;
  return {
    ...code,
    verification_uri: apply(code.verification_uri) ?? code.verification_uri,
    ...(mergedComplete !== undefined ? { verification_uri_complete: mergedComplete } : {}),
  };
}

/**
 * Allow tests to inject a stub fetch without monkey-patching the global.
 * Overridable via `__setDeviceFlowFetch` in unit tests.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);

export function __setDeviceFlowFetch(impl: FetchLike | null): void {
  fetchImpl = impl ?? ((input, init) => fetch(input, init));
}

type SleepLike = (ms: number, signal?: AbortSignal) => Promise<void>;
let sleepImpl: SleepLike = defaultSleep;

export function __setDeviceFlowSleep(impl: SleepLike | null): void {
  sleepImpl = impl ?? defaultSleep;
}

export async function* runDeviceFlow(
  config: DeviceFlowConfig,
): AsyncGenerator<DeviceFlowEvent> {
  let codeRes: Response;
  try {
    // Logto exposes the RFC 8628 Device Authorization endpoint at
    // `/oidc/device/auth` (matching its OIDC discovery
    // `device_authorization_endpoint`). `/oidc/device` is the
    // user-facing verification PAGE — POSTing there 302's to
    // `/device?error=TypeError` and the redirect-following fetch
    // loops, surfacing as "redirected too many times".
    codeRes = await fetchImpl(`${config.endpoint}/oidc/device/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.appId,
        scope: config.scope ?? DEFAULT_SCOPE,
        resource: config.resource,
        // M060 — Logto OSS gates `offline_access` scope grant (and
        // therefore refresh-token issuance) behind explicit OAuth
        // `prompt=consent`. Without it, first-party Native sign-in
        // completes with `scope: ""` (empty) and no refresh_token.
        // The flag is auto-confirmed for first-party apps so it
        // adds no UX surface — see sign-in.ts for full rationale.
        // RFC 8628 device flow accepts `prompt` as an Extension
        // Param (Logto threads it through to the same /oidc/auth
        // logic as the auth-code flow).
        prompt: "consent",
      }).toString(),
      ...(config.signal ? { signal: config.signal } : {}),
    });
  } catch (err) {
    yield {
      type: "error",
      message: `Cannot reach Logto: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: true,
    };
    return;
  }
  if (!codeRes.ok) {
    yield {
      type: "error",
      message: `Device code request failed: ${codeRes.status}`,
      recoverable: false,
    };
    return;
  }
  const codeRaw = (await codeRes.json()) as DeviceCodeResponse;
  const code = mergeVerificationUriParams(codeRaw, config.verificationUriExtraParams);
  yield { type: "code", data: code };

  // RFC 8628 §3.2: `interval` is OPTIONAL — clients SHOULD default to
  // 5s when omitted. Logto OSS (as of v1.38) never sends it, so a naive
  // `code.interval * 1000` produces `NaN`, setTimeout coerces NaN to 0,
  // and the loop tight-polls Logto's token endpoint. Logto then 400's
  // with an unrecognized error → falls through to the `default` case
  // and the dialog flips to "Sign-in failed."
  const intervalSeconds =
    typeof code.interval === "number" && code.interval > 0
      ? code.interval
      : 5;
  let interval = intervalSeconds * 1000;
  const expiresAt = Date.now() + code.expires_in * 1000;

  while (Date.now() < expiresAt) {
    if (config.signal?.aborted) return;
    yield { type: "polling", intervalMs: interval };
    try {
      await sleepImpl(interval, config.signal);
    } catch {
      return;
    }

    let tokenRes: Response;
    try {
      tokenRes = await fetchImpl(`${config.endpoint}/oidc/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code.device_code,
          client_id: config.appId,
        }).toString(),
        ...(config.signal ? { signal: config.signal } : {}),
      });
    } catch (err) {
      yield {
        type: "error",
        message: `Token poll failed: ${err instanceof Error ? err.message : String(err)}`,
        recoverable: true,
      };
      return;
    }

    if (tokenRes.ok) {
      const data = (await tokenRes.json()) as TokenResponse;
      yield { type: "success", data };
      return;
    }

    const errBody = (await tokenRes.json().catch(() => ({}))) as { error?: string };
    switch (errBody.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5_000;
        continue;
      case "expired_token":
        yield {
          type: "error",
          message: "Sign-in code expired. Press Enter to retry.",
          recoverable: true,
        };
        return;
      case "access_denied":
        yield {
          type: "error",
          message: "Sign-in was cancelled.",
          recoverable: true,
        };
        return;
      default:
        yield {
          type: "error",
          message: `Token poll failed: ${errBody.error ?? tokenRes.status}`,
          recoverable: false,
        };
        return;
    }
  }

  yield {
    type: "error",
    message: "Sign-in expired (no response within ~30 min). Press Enter to retry.",
    recoverable: true,
  };
}

/**
 * M069 — refresh-token grant outcome. `invalid_grant` is authoritative
 * re-sign-in; `transient` keeps the on-disk session for retry.
 */
export type RefreshOutcome =
  | { kind: "ok"; tokens: TokenResponse }
  | { kind: "invalid_grant" }
  | { kind: "transient"; reason: string };

/**
 * Refresh-token grant (RFC 6749 form body on `POST …/oidc/token`).
 *
 * `resource` is REQUIRED for Nautilo: Logto OSS issues an opaque
 * access token from the device-code grant (`/oidc/me` only), and the
 * Nautilo server's verifier requires a JWT bearer with
 * `aud = https://api.nautilo.local`. The refresh-grant call with
 * `resource=...` is what produces that JWT — see Logto docs §"API
 * resources and organizations".
 */
export async function refreshAccessToken(args: {
  endpoint: string;
  appId: string;
  refreshToken: string;
  resource: string;
}): Promise<RefreshOutcome> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: args.refreshToken,
    client_id: args.appId,
    resource: args.resource,
  });
  let res: Response;
  try {
    res = await fetchImpl(`${args.endpoint}/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch (err) {
    return {
      kind: "transient",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  if (res.status === 400) {
    let parsed: { error?: string } = {};
    try {
      parsed = (await res.json()) as { error?: string };
    } catch {
      /* body was not JSON */
    }
    if (parsed.error === "invalid_grant") return { kind: "invalid_grant" };
    return { kind: "transient", reason: `400 ${parsed.error ?? "unknown"}` };
  }
  if (!res.ok) {
    return { kind: "transient", reason: `http ${res.status}` };
  }

  let raw: Record<string, unknown>;
  try {
    raw = (await res.json()) as Record<string, unknown>;
  } catch {
    return { kind: "transient", reason: "malformed body" };
  }
  if (typeof raw["access_token"] !== "string" || typeof raw["refresh_token"] !== "string") {
    return { kind: "transient", reason: "missing tokens in response" };
  }
  const expiresIn = raw["expires_in"];
  if (typeof expiresIn !== "number" || !Number.isFinite(expiresIn)) {
    return { kind: "transient", reason: "missing expires_in in response" };
  }
  const idToken = typeof raw["id_token"] === "string" ? raw["id_token"] : "";
  const tokens: TokenResponse = {
    access_token: raw["access_token"],
    refresh_token: raw["refresh_token"],
    id_token: idToken,
    expires_in: expiresIn,
  };
  return { kind: "ok", tokens };
}

/** RFC 7009 token revocation (Logto OSS: POST `${endpoint}/oidc/token/revocation`). */
export interface RevokeArgs {
  endpoint: string;
  appId: string;
  refreshToken: string;
}

/**
 * Best-effort refresh-token revocation at the IdP. Logs and swallows network
 * errors and non-2xx — never throws.
 */
export async function revokeRefreshToken(args: RevokeArgs): Promise<void> {
  const url = `${args.endpoint}/oidc/token/revocation`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: args.appId,
        token: args.refreshToken,
        token_type_hint: "refresh_token",
      }).toString(),
    });
    if (!res.ok) {
      warn(`[device-flow] Token revocation failed: HTTP ${res.status}`);
    }
  } catch (err) {
    warn(
      `[device-flow] Token revocation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    });
  });
}

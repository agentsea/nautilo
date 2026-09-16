/**
 * M055 — silent refresh-token rotation.
 *
 * Decision #13 (research/logto-integration-v1.md §8.3): use the new
 * access token first, then write the new bundle to disk. A crash
 * between use and write means the user has to re-sign-in next launch
 * — acceptable. The "use first" is implicit because callers await
 * the returned bundle before persisting; we only need to make sure
 * the write captures the rotated `refresh_token` (Logto rotates per
 * the OAuth 2.1 default).
 *
 * Dependency-injected; test the success / failure / rotation paths
 * with a stubbed fetch.
 */
import { warn } from "@nautilo/logger";
import type { TokenBundle } from "./token-store";

export interface RefreshConfig {
  endpoint: string;
  appId: string;
  /**
   * RFC 8707 — must match the `resource` used on the original
   * authorization-code exchange so the rotated access token keeps
   * the correct audience. Without this Logto downgrades the token
   * to its userinfo audience and the server's JWT verifier rejects
   * with audience mismatch → silent fall-through to guest.
   */
  resource: string;
}

export interface RefreshDeps {
  fetchImpl: typeof fetch;
  loadTokens: () => TokenBundle | null;
  saveTokens: (b: TokenBundle) => void;
  /** Best-effort clear when refresh fails (caller broadcasts signed-out). */
  clearTokens: () => void;
}

interface RefreshResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in: number;
}

function tryDecodeJwtKid(accessToken: string): string | undefined {
  const parts = accessToken.split(".");
  if (parts.length < 2) return undefined;
  try {
    const headerJson = Buffer.from(parts[0]!, "base64url").toString("utf8");
    const h = JSON.parse(headerJson) as { kid?: unknown };
    return typeof h.kid === "string" ? h.kid : undefined;
  } catch {
    return undefined;
  }
}

// TODO(M0??-token-lifecycle): proactive refresh timer (Phase 14a) — schedule
// refresh before expiry; deferred to sibling PR per ISSUE-M097.

export async function refreshTokens(
  config: RefreshConfig,
  deps: RefreshDeps,
): Promise<TokenBundle | null> {
  const current = deps.loadTokens();
  if (!current) return null;
  // M060 — `loadTokens` enforces `refresh_token: string`, so a
  // non-null bundle is guaranteed to have one. Any prior bundle
  // missing the field would have been rejected at the validator and
  // returned null above.

  warn("[auth] auth.refresh.attempted", {});

  let res: Response;
  try {
    res = await deps.fetchImpl(`${config.endpoint}/oidc/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id: config.appId,
        resource: config.resource,
      }),
    });
  } catch {
    warn("[auth] auth.refresh.failed", { reason: "fetch_error" as const });
    deps.clearTokens();
    return null;
  }
  if (!res.ok) {
    warn("[auth] auth.refresh.failed", {
      reason: "non_ok" as const,
      status: res.status,
    });
    deps.clearTokens();
    return null;
  }

  let json: RefreshResponse;
  try {
    json = (await res.json()) as RefreshResponse;
  } catch {
    warn("[auth] auth.refresh.failed", { reason: "json_parse_error" as const });
    deps.clearTokens();
    return null;
  }

  const next: TokenBundle = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? current.refresh_token,
    id_token: json.id_token ?? current.id_token,
    expires_in: json.expires_in,
    refreshed_at: Date.now(),
  };
  deps.saveTokens(next);
  const kid = tryDecodeJwtKid(json.access_token);
  warn("[auth] auth.refresh.succeeded", {
    ...(kid !== undefined ? { kid } : {}),
    expires_in: json.expires_in,
  });
  return next;
}

/** Returns true when the access token is within `skewMs` of expiry. */
export function isAccessTokenExpiring(
  bundle: TokenBundle,
  skewMs = 60_000,
): boolean {
  return Date.now() >= bundle.refreshed_at + bundle.expires_in * 1000 - skewMs;
}

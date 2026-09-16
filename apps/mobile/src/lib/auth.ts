// D369 Phase 2 — Logto auth (per the M199 contract in ISSUE-D369).
// Per-server PKCE sign-in via expo-auth-session; token bundles persisted
// per-server (server-store); silent refresh. NEVER hardcode the app id —
// it's discovered per server from /health (logtoMobileAppId).
import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import { NautiloApiClient } from "@nautilo/api-client/browser";

import { tokenNeedsRefresh } from "@/lib/artifact-bytes";
import {
  NativeAuthError,
  classifyAuthPromptResult,
  createNativeAuthRequestParameters,
  createNativeCodeExchangeParameters,
  type NativeAuthMode,
} from "@/lib/auth-request";
import {
  clearTokens,
  clearTokensIfRevision,
  loadTokenSnapshot,
  loadTokens,
  saveTokensIfRevision,
  type TokenBundle,
} from "@/lib/server-store";

WebBrowser.maybeCompleteAuthSession();

// Logto may rotate refresh tokens. Collapse simultaneous expiry recovery from
// parallel screens into one exchange per server so one request cannot consume
// the refresh token while another turns the same healthy session into a
// spurious logout.
const refreshInFlightByServer = new Map<string, Promise<TokenBundle | null>>();

// M199: the seeded redirect for the mobile Native Logto app.
const REDIRECT_URI = AuthSession.makeRedirectUri({ scheme: "nautilo", path: "callback" });

interface LogtoConfig {
  endpoint: string;
  appId: string;
  resource: string | null;
}

/**
 * The normal sign-in flow requests consent so Logto issues offline_access.
 * Sensitive Settings mutations use `reauthenticate`, which deliberately
 * requires the identity provider to present a fresh login prompt instead.
 */
export type InteractiveAuthMode = "sign-in" | "reauthenticate";

/** Registration changes only the hosted Logto first screen; custody stays outside OAuth. */
export interface SignInToServerOptions {
  mode?: NativeAuthMode;
}

export { NativeAuthError, type NativeAuthFailureCode, type NativeAuthMode } from "@/lib/auth-request";

/**
 * Build the authorization parameters for an interactive Logto flow.
 *
 * Kept pure so ordinary sign-in and fresh reauthentication cannot silently
 * drift apart. `prompt=login` is intentionally exclusive to reauthentication:
 * existing sign-in must continue to request consent for refresh-token access.
 */
function interactiveAuthParams(
  resource: string | null,
  mode: InteractiveAuthMode,
): Record<string, string> {
  return {
    prompt: mode === "reauthenticate" ? "login" : "consent",
    ...(resource ? { resource } : {}),
  };
}

/** Read the server's Logto config from unauthenticated /health. */
async function loadLogtoConfig(baseUrl: string): Promise<LogtoConfig | null> {
  // Health is deliberately fetched with an unauthenticated, short-lived
  // client. Importing the authenticated singleton here creates api -> auth ->
  // api, and /health neither needs nor should trigger token recovery.
  const health = await new NautiloApiClient(baseUrl).getHealth();
  if (!health.logtoEndpoint || !health.logtoMobileAppId) return null;
  return {
    endpoint: health.logtoEndpoint,
    appId: health.logtoMobileAppId,
    resource: health.logtoResource ?? null,
  };
}

function discoveryFor(config: LogtoConfig): Promise<AuthSession.DiscoveryDocument> {
  // Logto's OIDC issuer is <endpoint>/oidc.
  const issuer = `${config.endpoint.replace(/\/+$/, "")}/oidc`;
  return AuthSession.fetchDiscoveryAsync(issuer);
}

function tokenBundleFrom(
  res: AuthSession.TokenResponse,
  fallbackRefresh?: string,
  userId?: string,
): TokenBundle {
  return {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken ?? fallbackRefresh ?? "",
    // expiresIn is seconds from issue; guard with a 1h default.
    expiresAt: Date.now() + (res.expiresIn ?? 3600) * 1000,
    ...(userId ? { userId } : {}),
  };
}

async function performInteractiveAuth(
  baseUrl: string,
  mode: InteractiveAuthMode | NativeAuthMode,
): Promise<TokenBundle> {
  const config = await loadLogtoConfig(baseUrl);
  if (!config) {
    throw new NativeAuthError("missing-logto-config");
  }
  const discovery = await discoveryFor(config);

  const requestParameters = typeof mode === "string"
    ? {
        clientId: config.appId,
        redirectUri: REDIRECT_URI,
        scopes: ["openid", "profile", "offline_access"],
        usePKCE: true as const,
        extraParams: interactiveAuthParams(config.resource, mode),
      }
    : createNativeAuthRequestParameters({
        clientId: config.appId,
        redirectUri: REDIRECT_URI,
        resource: config.resource,
      }, mode);

  const request = new AuthSession.AuthRequest({
    ...requestParameters,
    scopes: [...requestParameters.scopes],
  });

  const promptOutcome = classifyAuthPromptResult(await request.promptAsync(discovery));
  if (promptOutcome.kind === "failure") throw new NativeAuthError(promptOutcome.code);

  let token: AuthSession.TokenResponse;
  try {
    token = await AuthSession.exchangeCodeAsync(
      createNativeCodeExchangeParameters({
        clientId: config.appId,
        code: promptOutcome.code,
        redirectUri: REDIRECT_URI,
        resource: config.resource,
        codeVerifier: request.codeVerifier ?? "",
      }),
      discovery,
    );
  } catch {
    throw new NativeAuthError("exchange-failed");
  }

  return tokenBundleFrom(token);
}

/**
 * Full interactive PKCE sign-in against a server's Logto.
 *
 * The exchanged bundle is deliberately uncommitted. AuthProvider verifies
 * that the server selection and operation generation are still current, then
 * revision-fences the SecureStore commit. This is the same two-phase shape as
 * sensitive reauthentication and prevents a removed/switched server's late
 * browser callback from restoring credentials.
 */
export async function signInToServer(
  _serverId: string,
  baseUrl: string,
  options: SignInToServerOptions = {},
): Promise<TokenBundle> {
  return performInteractiveAuth(baseUrl, options.mode ?? { kind: "sign-in" });
}

/**
 * Reauthenticate the existing user before a sensitive Settings action.
 *
 * This deliberately shares the established PKCE/browser flow with sign-in;
 * only the OIDC prompt differs. Unlike sign-in, the exchanged bundle is not
 * persisted here: AuthProvider must verify the same viewer before committing
 * it, so cancellation, network failure, server switching, or account changes
 * leave the prior valid session intact.
 */
export async function reauthenticateToServer(
  _serverId: string,
  baseUrl: string,
): Promise<TokenBundle> {
  return performInteractiveAuth(baseUrl, "reauthenticate");
}

/** Silent refresh using the stored refresh token; clears tokens if it fails. */
async function refreshServerTokens(
  serverId: string,
  baseUrl: string,
): Promise<TokenBundle | null> {
  const inFlight = refreshInFlightByServer.get(serverId);
  if (inFlight) return inFlight;

  const refresh = (async (): Promise<TokenBundle | null> => {
    const snapshot = await loadTokenSnapshot(serverId);
    const existing = snapshot.tokens;
    if (!existing?.refreshToken) return null;
    const config = await loadLogtoConfig(baseUrl);
    if (!config) return null;
    try {
      const discovery = await discoveryFor(config);
      const token = await AuthSession.refreshAsync(
        {
          clientId: config.appId,
          refreshToken: existing.refreshToken,
          extraParams: config.resource ? { resource: config.resource } : {},
        },
        discovery,
      );
      const bundle = tokenBundleFrom(token, existing.refreshToken, existing.userId);
      const committed = await saveTokensIfRevision(serverId, bundle, snapshot.revision);
      return committed ? bundle : await loadTokens(serverId);
    } catch {
      // Refresh dead → force re-auth (D369 §11: seamless while valid, else re-auth).
      const cleared = await clearTokensIfRevision(serverId, snapshot.revision);
      return cleared ? null : await loadTokens(serverId);
    }
  })();
  refreshInFlightByServer.set(serverId, refresh);
  return refresh.finally(() => {
    if (refreshInFlightByServer.get(serverId) === refresh) {
      refreshInFlightByServer.delete(serverId);
    }
  });
}

/**
 * Return a valid access token for the server, refreshing if near/at expiry.
 *
 * `opts.forceRefresh` (D424 Phase 3.1) bypasses the 60s freshness guard and
 * always attempts a silent refresh using the stored refresh token. Used by the
 * artifact-byte transport after a native `401` to retry once before declaring
 * the session dead. When refresh is unavailable/dead the stored tokens are
 * cleared (by `refreshServerTokens`) and `null` is returned — the caller treats
 * that as auth-dead. The shared `setTokenProvider` contract is unchanged; this
 * is a mobile-only recovery knob. The pure freshness decision
 * (`tokenNeedsRefresh`) lives in `@/lib/artifact-bytes` so it is unit-testable
 * without this module's native transitive imports.
 */
export async function ensureValidToken(
  serverId: string,
  baseUrl: string,
  opts?: { forceRefresh?: boolean },
): Promise<string | null> {
  const existing = await loadTokens(serverId);
  if (!existing) return null;
  if (!tokenNeedsRefresh(existing.expiresAt, Date.now(), opts?.forceRefresh === true)) {
    return existing.accessToken;
  }
  const refreshed = await refreshServerTokens(serverId, baseUrl);
  return refreshed?.accessToken ?? null;
}

export async function signOutServer(serverId: string): Promise<void> {
  await clearTokens(serverId);
}

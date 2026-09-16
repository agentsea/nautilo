import type { HealthResponse } from "@nautilo/api-client";
import type { LogtoConfig } from "@logto/browser";

const MOBILE_WEB_ROOT_PATH = "/mobile";
export const MOBILE_WEB_CALLBACK_PATH = "/mobile/callback";

const CALLBACK_SECRET_KEYS = new Set([
  "access_token",
  "code",
  "error",
  "error_description",
  "id_token",
  "refresh_token",
  "session_state",
  "state",
]);

export interface MobileWebAuthBootstrap {
  readonly logto: LogtoConfig;
  readonly resource: string;
  readonly redirectUri: string;
  readonly postLogoutRedirectUri: string;
}

function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function equivalentAdvertisedOrigin(current: string, advertised: string): boolean {
  if (current === advertised) return true;
  const left = new URL(current);
  const right = new URL(advertised);
  return left.protocol === right.protocol
    && left.port === right.port
    && isLoopbackHost(left.hostname)
    && isLoopbackHost(right.hostname);
}

/**
 * Build the public-client configuration discovered from the server serving
 * this page. No client secret or native app id is accepted by this boundary.
 */
export function mobileWebAuthBootstrap(
  health: HealthResponse,
  currentOrigin: string,
): MobileWebAuthBootstrap | null {
  const origin = exactOrigin(currentOrigin);
  if (!origin || !health.logtoEndpoint || !health.logtoMobileWebAppId) return null;

  const advertisedOrigins = [health.serverUrl, health.workbenchUrl]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(exactOrigin)
    .filter((value): value is string => value !== null);
  if (
    advertisedOrigins.length > 0
    && !advertisedOrigins.some((advertised) => equivalentAdvertisedOrigin(origin, advertised))
  ) return null;

  const resource = health.logtoResource?.trim();
  if (!resource) return null;
  return {
    logto: {
      endpoint: health.logtoEndpoint,
      appId: health.logtoMobileWebAppId,
      resources: [resource],
      scopes: ["openid", "offline_access", "profile", "email"],
    },
    resource,
    redirectUri: new URL(MOBILE_WEB_CALLBACK_PATH, origin).href,
    postLogoutRedirectUri: new URL(MOBILE_WEB_ROOT_PATH, origin).href,
  };
}

export function ownsMobileWebCallback(value: string, currentOrigin: string): boolean {
  try {
    const candidate = new URL(value, currentOrigin);
    return candidate.origin === new URL(currentOrigin).origin
      && candidate.pathname === MOBILE_WEB_CALLBACK_PATH;
  } catch {
    return false;
  }
}

/** Accept only same-origin Mobile routes and never retain OAuth material. */
export function sanitizeMobileWebReturnPath(
  value: string | null | undefined,
  currentOrigin: string,
): string {
  if (!value) return MOBILE_WEB_ROOT_PATH;
  try {
    const origin = new URL(currentOrigin).origin;
    const candidate = new URL(value, origin);
    if (candidate.origin !== origin) return MOBILE_WEB_ROOT_PATH;
    if (candidate.pathname !== MOBILE_WEB_ROOT_PATH && !candidate.pathname.startsWith(`${MOBILE_WEB_ROOT_PATH}/`)) {
      return MOBILE_WEB_ROOT_PATH;
    }
    for (const key of candidate.searchParams.keys()) {
      if (CALLBACK_SECRET_KEYS.has(key.toLowerCase())) return MOBILE_WEB_ROOT_PATH;
    }
    if (candidate.hash && /(?:^|[&#])(access_token|code|error|id_token|refresh_token|state)=/i.test(candidate.hash)) {
      return MOBILE_WEB_ROOT_PATH;
    }
    return `${candidate.pathname}${candidate.search}${candidate.hash}`;
  } catch {
    return MOBILE_WEB_ROOT_PATH;
  }
}

/** The callback is replaced, never pushed, so Back cannot replay its query. */
export function mobileWebCallbackCleanupUrl(currentOrigin: string): string {
  return new URL(MOBILE_WEB_ROOT_PATH, currentOrigin).href;
}

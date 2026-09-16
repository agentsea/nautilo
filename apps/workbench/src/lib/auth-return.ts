/**
 * A normal Logto sign-in may return to a small set of known protected
 * administrator destinations. Store an ID, never a pathname or URL supplied
 * by the browser, so this cannot become an open redirect or a second routing
 * authority.
 */
export const AUTH_RETURN_STORAGE_KEY = "nautilo.authReturn.v1";

const AUTH_RETURN_DESTINATIONS = {
  "server-guide": "/help/server",
  "configure-server": "/admin#server",
  "invite-team": "/admin#invites",
  "configure-providers": "/admin#provider-credentials",
  "settings-security": "/settings#security",
  product: "/",
} as const;

export type AuthReturnDestinationId = keyof typeof AUTH_RETURN_DESTINATIONS;

type AuthReturnLocation = { readonly pathname: string; readonly hash?: string };

interface StoredAuthReturn {
  readonly version: 1;
  readonly destination: AuthReturnDestinationId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAuthReturnDestinationId(value: unknown): value is AuthReturnDestinationId {
  return typeof value === "string" && Object.hasOwn(AUTH_RETURN_DESTINATIONS, value);
}

export function authReturnDestinationForLocation(
  location: AuthReturnLocation,
): AuthReturnDestinationId | null {
  const hash = location.hash ?? "";
  if (location.pathname === "/help" || location.pathname === "/help/server") return "server-guide";
  if (location.pathname === "/admin" && hash === "#server") return "configure-server";
  if (location.pathname === "/admin" && hash === "#invites") return "invite-team";
  if (location.pathname === "/admin" && hash === "#provider-credentials") return "configure-providers";
  if (location.pathname === "/settings" && hash === "#keys") return "configure-providers";
  if (location.pathname === "/settings" && hash === "#security") return "settings-security";
  if (location.pathname === "/") return "product";
  return null;
}

function authReturnPath(destination: AuthReturnDestinationId): string {
  return AUTH_RETURN_DESTINATIONS[destination];
}

/**
 * Capture callback intent from the initial URL. Logto removes `?code` while
 * its hook finishes the exchange, so rereading the live URL after loading can
 * misclassify a real callback as a bookmarked empty route and race the
 * success continuation back to product root.
 */
export function authCallbackStartedWithCode(search: string): boolean {
  try {
    return Boolean(new URLSearchParams(search).get("code"));
  } catch {
    return false;
  }
}

function sessionStore(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}

function parse(raw: string): StoredAuthReturn | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !isAuthReturnDestinationId(parsed["destination"])) {
    return null;
  }
  return { version: 1, destination: parsed["destination"] };
}

function clearAuthReturn(): void {
  try {
    sessionStore()?.removeItem(AUTH_RETURN_STORAGE_KEY);
  } catch {
    // If browser session storage is unavailable, the safe fallback is root.
  }
}

/** Capture only the known current route immediately before normal sign-in. */
export function captureAuthReturn(location: AuthReturnLocation): AuthReturnDestinationId | null {
  const destination = authReturnDestinationForLocation(location);
  if (destination === null) {
    clearAuthReturn();
    return null;
  }
  try {
    const storage = sessionStore();
    if (storage === undefined) return null;
    const serialized = JSON.stringify({ version: 1, destination } satisfies StoredAuthReturn);
    storage.setItem(AUTH_RETURN_STORAGE_KEY, serialized);
    return storage.getItem(AUTH_RETURN_STORAGE_KEY) === serialized ? destination : null;
  } catch {
    return null;
  }
}

/** Read without consuming, for a recoverable Logto callback error screen. */
function peekAuthReturnPath(): string | null {
  try {
    const raw = sessionStore()?.getItem(AUTH_RETURN_STORAGE_KEY);
    if (!raw) return null;
    const stored = parse(raw);
    if (stored === null) {
      clearAuthReturn();
      return null;
    }
    return authReturnPath(stored.destination);
  } catch {
    return null;
  }
}

/** Consume exactly once after a successful ordinary sign-in. */
export function consumeAuthReturnPath(): string | null {
  const path = peekAuthReturnPath();
  clearAuthReturn();
  return path;
}

/**
 * Claim/invite continuations are precedence-sensitive and must never consume
 * a normal sign-in return. The caller owns reading its existing session
 * handoffs; this pure resolver makes that ordering explicit and testable.
 */
export interface AuthCallbackContinuationInput {
  readonly ownerClaimStage?: "awaiting-signup" | "awaiting-bind" | "preview" | "profile";
  readonly ordinaryInvite?: { readonly token: string; readonly stage: "awaiting-signup" | "awaiting-bind" | "profile" } | null;
}

function continuationDestination(input: AuthCallbackContinuationInput): string | null {
  if (
    input.ownerClaimStage === "awaiting-signup" ||
    input.ownerClaimStage === "awaiting-bind" ||
    input.ownerClaimStage === "profile"
  ) {
    return "/claim";
  }
  if (input.ordinaryInvite?.stage === "awaiting-signup") {
    return `/invite/${encodeURIComponent(input.ordinaryInvite.token)}`;
  }
  return null;
}

export function resolveAuthCallbackDestination(input: AuthCallbackContinuationInput): string {
  const continuation = continuationDestination(input);
  if (continuation !== null) return continuation;
  return consumeAuthReturnPath() ?? "/";
}

/** Error/back navigation keeps claim/invite precedence but does not consume a normal return. */
export function resolveAuthCallbackErrorDestination(input: AuthCallbackContinuationInput): string {
  return continuationDestination(input) ?? peekAuthReturnPath() ?? "/";
}

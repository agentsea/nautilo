import type { UnauthorizedResponse } from "@nautilo/api-client/browser";

/**
 * A 401 is not sufficient evidence that the app session died: proof, ticket,
 * and step-up routes also use it for a rejected operation. Only the server's
 * canonical bearer/session failures may drive the global sign-out gate.
 */
const DEAD_SESSION_ERRORS = new Set([
  "authentication required",
  "authentication_required",
  "unauthorized",
  "missing_bearer",
  "invalid_token",
  "sign in to pair a device",
  "sign in to list devices",
  "sign in to revoke devices",
]);

export function isDeadSessionResponse(response: UnauthorizedResponse): boolean {
  const error = response.error?.trim().toLowerCase() ?? "";
  return DEAD_SESSION_ERRORS.has(error);
}

export type AuthGateDestination = "/(onboarding)/add-server" | "/(onboarding)/sign-in" | null;

export function signedInLandingDestination(
  authStatus: "loading" | "signed-in" | "signed-out",
): "/(drawer)/(tabs)" | null {
  return authStatus === "signed-in" ? "/(drawer)/(tabs)" : null;
}

export function authGateDestination(input: {
  serversLoading: boolean;
  authStatus: "loading" | "signed-in" | "signed-out";
  hasActiveServer: boolean;
  rootSegment: string | undefined;
}): AuthGateDestination {
  if (input.serversLoading || input.authStatus === "loading") return null;
  if (input.rootSegment === "(onboarding)" || input.rootSegment === "callback") return null;
  if (!input.hasActiveServer) return "/(onboarding)/add-server";
  return input.authStatus === "signed-out" ? "/(onboarding)/sign-in" : null;
}

export function shouldHandleAuthDead(input: {
  activeServerId: string | null;
  rejectedServerId: string;
  authStatus: "loading" | "signed-in" | "signed-out";
}): boolean {
  // During cold-start hydration, child screens may issue requests before the
  // SecureStore bearer has been loaded into the API client. A resulting 401
  // does not prove the persisted session is dead and must never erase it.
  return input.activeServerId === input.rejectedServerId && input.authStatus === "signed-in";
}

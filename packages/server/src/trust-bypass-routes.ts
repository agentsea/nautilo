/**
 * Routes whose handlers run **before** the session-based trust preHandler
 * resolves `policyContext` / `memoryEnvelope` from a Bearer token.
 *
 * Keep this list in sync with `createApp`'s preHandler skip logic — the
 * integration meta-test asserts sensitive routes never appear here.
 */
const TRUST_BYPASS_ROUTE_TEMPLATES = [
  "/health",
  "/health/live",
  "/health/ready",
  "/health/status",
  "/api/auth/session",
  "/api/auth/verify-and-resume",
  "/api/health/modes",
  "/api/config/setup-flags",
  "/api/profile/status",
  "/api/onboarding/*",
  "/api/account/password/recover-with-code",
  "/api/account/password/recovery-relay/:sessionId",
  "/api/internal/logto/email-webhook",
  "/pair/:code",
  "/pair/:code/cert",
  "/pair/:code/profile",
  "/.well-known/webfinger",
  "/api/profile/:handle",
  "/api/invites/:token",
  "/api/invites/:token/redeem",
  // M105 Phase C — browser-mediated invite redeem (Logto-hosted sign-up).
  // The invite token is the auth on prepare; the two bearer routes verify
  // the Logto JWT inline because the users row does not exist (bind) or
  // has a NULL handle (complete) at call time.
  "/api/invites/:token/prepare-logto-signup",
  "/api/bind-logto-user",
  "/api/invites/:token/complete-profile",
  // D488 — hosted first-owner claim capability is accepted only in these
  // protected POST bodies. They mirror the browser-mediated invite flow:
  // preview/prepare are anonymous-capability operations, and complete
  // verifies the Logto bearer inline while the just-bound user is still in
  // the setup transition.
  "/api/owner-claim/preview",
  "/api/owner-claim/prepare-auth",
  "/api/owner-claim/prepare-logto-signup",
  "/api/owner-claim/complete-profile",
  "/api/setup/validate-handle",
  "/api/test/security-scan",
  "/api/test/ping",
  // D456 — provider OAuth returns to a static, secret-free completion page.
  // The durable request is inspected only through the authenticated API.
  "/connections/oauth/complete",
] as const;

const TRUST_BYPASS_SET = new Set<string>(TRUST_BYPASS_ROUTE_TEMPLATES);

/** Frozen list for meta-tests + docs. */
export const TRUST_BYPASS_ROUTE_LIST: readonly string[] = TRUST_BYPASS_ROUTE_TEMPLATES;

/**
 * Fastify's `request.routeOptions.url` for a matched route — exact
 * template strings like `/api/onboarding/*` or `/pair/:code`.
 */
export function routeSkipsTrustPreHandler(routeTemplate: string | undefined): boolean {
  if (!routeTemplate) return false;
  return TRUST_BYPASS_SET.has(routeTemplate);
}

/** Routes that must never skip the trust preHandler (regression guard). */
export const MUST_NOT_BYPASS_TRUST_ROUTES: readonly string[] = [
  "/api/setup/owner-claim/redeem",
  "/api/chat",
  "/api/rooms/:roomId/messages",
  "/api/jobs",
  "/api/jobs/:id",
  "/api/owner",
  "/api/security/posture",
  "/api/costs",
  "/api/admin/users",
  "/api/admin/users/:id",
  "/api/admin/users/:id/disable",
  "/api/admin/users/:id/enable",
  "/api/admin/users/:id/reset-password",
  "/api/relay/pair",
  "/api/relay/devices/v2",
  "/api/relay/devices/v2/:deviceManagementId",
  "/api/relay/devices/v2/historical/cleanup",
  "/api/memory",
  "/api/memory/search",
  "/api/memory/brief",
  "/api/memory/brief/readonly",
  "/api/memory/:id",
  "/api/file/invoke-direct",
  "/api/workspace/artifacts/:id/share",
  "/api/workspace/shared-with-me",
  "/api/workspace/artifacts",
  "/api/workspace/artifacts/:id",
  "/api/workspace/artifacts/:id/bytes",
  "/api/workspace/artifacts/:id/content",
  "/api/workspace/artifacts/:id/patch",
  "/api/workspace/artifacts/:id/patches",
  "/api/workspace/artifacts/events",
  // D121-P3 — artifact state bridge (postMessage RPC backing routes).
  "/api/workspace/artifacts/:id/state/:key",
  // D429 Phase 7.4.2 — authenticated verified-byte explainer media. Never
  // public: unauthenticated requests must fail closed with 401.
  "/api/explainers/:id/media",
  // D445 Phase 1 — provider-key admin routes use normal bearer resolution
  // so the trust preHandler can populate the caller's session/capability
  // context. Loopback/bootstrap remain honored inside each handler; the
  // bypass list must never short-circuit them.
  "/api/health/keys",
  "/api/health/keys/validate",
  "/api/setup/keys",
];

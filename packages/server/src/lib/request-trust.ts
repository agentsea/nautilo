import type { FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { isLocalhostIp } from "@nautilo/config-guard";
import { resolveInstance } from "@nautilo/config";
import { bootstrapDirForInstance, isBootstrapUsed } from "@nautilo/operator-secrets";
import { isBootstrapOwnerBound } from "@nautilo/trust";

/**
 * Durable bootstrap retirement is represented by the existing local
 * `.bootstrap/.used` sentinel. It deliberately applies only to remote bearer
 * authority: local Compose/loopback recovery continues to work as before.
 */
function isRemoteBootstrapAuthorityRetired(
  instanceId: string = resolveInstance().instanceId,
): boolean {
  // The cache is hydrated from canonical database owner facts at boot, so a
  // restore/restart remains closed even if the best-effort filesystem marker
  // was unavailable when the first owner completed setup.
  return isBootstrapOwnerBound() || isBootstrapUsed(bootstrapDirForInstance(instanceId));
}

/**
 * Loopback / Unix-socket callers trusted for `claimInvitePathHint` and
 * Phase 6 claim-redeem session mint (same bar as setup-status).
 */
export function requestAllowsLoopbackTrust(request: FastifyRequest): boolean {
  if (isLocalhostIp(request.ip)) return true;
  const ra = request.socket.remoteAddress;
  if ((ra === undefined || ra === "") && request.ip === "") {
    return true;
  }
  return false;
}

/**
 * D120 A5 — privileged setup writes (POST /api/setup/keys and siblings) trust either:
 *   - the same loopback / unix-socket bar as requestAllowsLoopbackTrust, OR
 *   - a constant-time-matched `Authorization: Bearer <token>` against
 *     process.env.NAUTILO_BOOTSTRAP_TOKEN (cloud-deploy path).
 *
 * If no NAUTILO_BOOTSTRAP_TOKEN is configured AND the request isn't loopback,
 * this returns false unconditionally — fail-closed.
 */
export function requestAllowsPrivilegedSetup(request: FastifyRequest): boolean {
  if (requestAllowsLoopbackTrust(request)) return true;

  if (isRemoteBootstrapAuthorityRetired()) return false;

  const configuredToken = process.env["NAUTILO_BOOTSTRAP_TOKEN"]?.trim();
  if (!configuredToken) return false;

  const auth = request.headers["authorization"];
  if (typeof auth !== "string" || !auth.startsWith("Bearer ")) return false;
  const presented = auth.slice("Bearer ".length).trim();

  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(configuredToken, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * M115 — allow either loopback callers OR authenticated owner sessions.
 *
 * Replaces bare `isLocalhostIp(request.ip)` gates on routes that were
 * historically loopback-only because the workbench ran on the same
 * machine as the server. Remote SSH compose deploys (M115) put the
 * workbench on a different host, so the gate needs the wider "owner
 * identity" definition. Loopback is preserved for the dev-mode
 * single-machine path.
 *
 * Owner identity comes from the trust preHandler's `policyContext`
 * (set by trust middleware before any route handler runs).
 */
export function requestAllowsOwnerOrLoopback(request: FastifyRequest): boolean {
  if (requestAllowsLoopbackTrust(request)) return true;
  return request.policyContext?.actorRole === "owner";
}

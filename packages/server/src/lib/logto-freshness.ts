import type { FastifyReply, FastifyRequest } from "fastify";

export const DEFAULT_LOGTO_FRESHNESS_MAX_AGE_MS = 5 * 60 * 1000;

export function isLogtoAccessTokenFresh(
  request: FastifyRequest,
  maxAgeMs: number = DEFAULT_LOGTO_FRESHNESS_MAX_AGE_MS,
): boolean {
  const iat = request.accessTokenIssuedAt;
  if (typeof iat !== "number" || !Number.isFinite(iat) || iat <= 0) return false;
  const issuedAtMs = iat * 1000;
  const ageMs = Date.now() - issuedAtMs;
  return ageMs >= 0 && ageMs <= maxAgeMs;
}

export async function requireFreshLogtoAccessToken(
  request: FastifyRequest,
  reply: FastifyReply,
  maxAgeMs: number = DEFAULT_LOGTO_FRESHNESS_MAX_AGE_MS,
): Promise<boolean> {
  if (isLogtoAccessTokenFresh(request, maxAgeMs)) return false;
  await reply.code(401).send({
    error: "fresh_reauth_required",
    message:
      "This action requires a recently-issued access token. Re-authenticate with prompt=login and retry.",
    maxAgeMs,
  });
  return true;
}

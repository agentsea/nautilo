import type { onRequestHookHandler } from "fastify";

/**
 * One exact 16K-Domain plan and authorization encode to roughly 27 MiB of
 * base64url JSON at the measured maximum identifier width. The 42 MiB route
 * budget admits the schema's complete current request plus its separately
 * bounded protected payload fields without widening Fastify globally.
 */
export const LIVE_SHADOW_LARGE_REQUEST_BODY_LIMIT_BYTES = 42 * 1024 * 1024;

/**
 * Fastify parses JSON before application preHandlers. Reject the cheap,
 * unambiguous no-bearer cases before accepting a multi-megabyte body; complete
 * bearer resolution and device admission remain centralized preHandlers.
 */
const requireStructurallyValidBearerBeforeLargeBody:
  onRequestHookHandler = (request, reply, done) => {
    const authorization = request.headers.authorization;
    if (
      typeof authorization === "string"
      && /^Bearer [^\s]+$/u.test(authorization)
    ) {
      done();
      return;
    }
    void reply.code(401).send({ error: "unauthorized" });
  };

export const liveShadowLargeRequestRouteOptions = Object.freeze({
  bodyLimit: LIVE_SHADOW_LARGE_REQUEST_BODY_LIMIT_BYTES,
  onRequest: requireStructurallyValidBearerBeforeLargeBody,
});

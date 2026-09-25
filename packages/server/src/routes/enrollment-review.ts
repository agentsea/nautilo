import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { applicantEnrollmentReview, ModerationError, verifyLogtoAccessToken } from "@nautilo/trust";
import { checkInviteIpLimit } from "../lib/invite-rate-limit";

/** Pending applicants have no admitted session. Authenticate the same OIDC
 * bearer as profile completion, then require its exact durable Invite binding.
 */
export function enrollmentReviewRoutes(app: FastifyInstance, deps = {
  verify: verifyLogtoAccessToken, review: applicantEnrollmentReview, rateLimit: checkInviteIpLimit,
}): void {
  app.route<{ Params: { token: string } }>({ method: ["GET", "POST"], url: "/api/invites/:token/enrollment-review",
    async handler(request, reply) {
      reply.header("cache-control", "no-store");
      if (!deps.rateLimit(request.ip)) return reply.code(429).send({ error: "rate_limited" });
      const bearer = request.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) return reply.code(401).send({ error: "missing_bearer" });
      let subject: string;
      try { subject = (await deps.verify(bearer)).sub; }
      catch { return reply.code(401).send({ error: "invalid_token" }); }
      if (!/^inv_[A-Za-z0-9_-]{32}$/.test(request.params.token)) return reply.code(404).send({ error: "target_unavailable" });
      const parsed = request.method === "POST" ? z.object({ message: z.string().trim().min(1) }).strict().safeParse(request.body) : null;
      if (parsed && !parsed.success) return reply.code(400).send({ error: "join_message_required" });
      try {
        return await deps.review({ inviteToken: request.params.token, subject, issuer: process.env["LOGTO_ISSUER"] ?? "",
          ...(parsed?.success ? { message: parsed.data.message } : {}),
        });
      } catch (error) {
        if (error instanceof ModerationError) return reply.code(error.code === "target_unavailable" ? 404 : 403).send({ error: error.code });
        return reply.code(503).send({ error: "enrollment_unavailable" });
      }
    },
  });
}

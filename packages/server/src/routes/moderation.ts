import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  applyModeration, getServerModerationPerson, searchServerModerationPeople, ModerationError, readModerationReceipt,
  readServerModerationPolicy, updateServerModerationPolicy, userHasCapability,
  type ModerationDelivery,
  listEnrollmentReviews, decideEnrollmentReview,
} from "@nautilo/trust";
import { normalizeAdminDirectoryLimit } from "../lib/admin-directory-pagination";
import type { ServerModerationPolicy } from "@nautilo/types";

const personQuery = z.union([
  z.object({ userId: z.string().uuid() }).strict(),
  z.object({ handle: z.string().trim().min(1) }).strict(),
]);
const policyInput = z.object({ enabled: z.boolean(), joinsPaused: z.boolean(), approvalRequired: z.boolean(), revision: z.number().int().positive() }).strict();

class ModerationAuthenticationError extends Error {}

type Services = {
  hasCapability: typeof userHasCapability;
  policy: typeof readServerModerationPolicy;
  updatePolicy: typeof updateServerModerationPolicy;
  person: typeof getServerModerationPerson;
  people: typeof searchServerModerationPeople;
  act: typeof applyModeration;
  receipt: typeof readModerationReceipt;
  reviews: typeof listEnrollmentReviews;
  decideReview: typeof decideEnrollmentReview;
};

/** Initial Server controls reuse the canonical moderation and enrollment owners.
 * Room and participation actions remain unavailable until their full journeys qualify.
 */
export function moderationRoutes(app: FastifyInstance, deps: {
  delivery: ModerationDelivery;
  policyChanged: (callerUserId: string, policy: ServerModerationPolicy) => Promise<void>;
  reviewDecided: (callerUserId: string, input: Parameters<typeof decideEnrollmentReview>[1]) => Promise<void>;
  services?: Services;
}): void {
  const services = deps.services ?? { hasCapability: userHasCapability, policy: readServerModerationPolicy,
    updatePolicy: updateServerModerationPolicy, person: getServerModerationPerson, people: searchServerModerationPeople,
    act: applyModeration, receipt: readModerationReceipt, reviews: listEnrollmentReviews, decideReview: decideEnrollmentReview };
  app.register((routes, _options, done) => {
    routes.addHook("preHandler", async (request, reply) => {
      reply.header("cache-control", "no-store");
      if (!request.sessionUserId) throw new ModerationAuthenticationError("unauthorized");
      const capabilities = ["ban_server_members", "kick_server_members", "view_server_moderation", "manage_server_enrollment"] as const;
      let allowed = false;
      for (const capability of capabilities) if (await services.hasCapability(request.sessionUserId, capability)) { allowed = true; break; }
      if (!allowed) throw new ModerationError("forbidden_scope");
    });
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof ModerationAuthenticationError) return reply.code(401).send({ error: "unauthorized" });
      // Parent authentication runs before this plugin's handlers. Preserve its
      // denial through Fastify's child error boundary instead of reporting an
      // unavailable moderation service for a pending or withdrawn account.
      if (error instanceof Error && "statusCode" in error
        && (error.statusCode === 401 || error.statusCode === 403)) throw error;
      if (!(error instanceof ModerationError)) { routes.log.error("Moderation request failed"); return reply.code(503).send({ error: "moderation_unavailable" }); }
      const status = error.code === "invalid_request" ? 400 : error.code === "target_unavailable" ? 404
        : ["stale_revision", "idempotency_conflict", "restriction_inactive", "moderation_disabled"].includes(error.code) ? 409 : 403;
      return reply.code(status).send({ error: error.code });
    });
    routes.get("/api/moderation/policy", async () => services.policy());
    routes.get("/api/moderation/enrollment", async (request, reply) => {
      const query = z.object({ limit: z.coerce.number().optional(), search: z.string().trim().optional(), afterInviteId: z.string().uuid().optional(), afterUserId: z.string().uuid().optional() }).strict().safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "invalid_request" });
      const limit = normalizeAdminDirectoryLimit(query.data.limit);
      if (limit === null || Boolean(query.data.afterInviteId) !== Boolean(query.data.afterUserId)) return reply.code(400).send({ error: "invalid_request" });
      return services.reviews(request.sessionUserId!, { limit, ...(query.data.search ? { search: query.data.search } : {}), ...(query.data.afterInviteId && query.data.afterUserId
        ? { after: { inviteId: query.data.afterInviteId, userId: query.data.afterUserId } } : {}) });
    });
    routes.post("/api/moderation/enrollment/decision", async (request, reply) => {
      const parsed = z.object({ inviteId: z.string().uuid(), userId: z.string().uuid(), revision: z.number().int().positive(),
        decision: z.enum(["approved", "rejected"]),
      }).strict().safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      await services.decideReview(request.sessionUserId!, parsed.data, deps.delivery.issuer);
      let auditRecorded = true;
      try { await deps.reviewDecided(request.sessionUserId!, parsed.data); } catch { auditRecorded = false; }
      return { ok: true, auditRecorded };
    });
    routes.put("/api/moderation/policy", async (request, reply) => {
      const parsed = policyInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const policy = await services.updatePolicy(request.sessionUserId!, parsed.data);
      let auditRecorded = true;
      try { await deps.policyChanged(request.sessionUserId!, policy); } catch { auditRecorded = false; }
      return { ...policy, auditRecorded };
    });
    routes.get("/api/moderation/people", async (request, reply) => {
      const query = z.object({ search: z.string().trim().min(1), limit: z.coerce.number().optional(), after: z.string().uuid().optional(), activeOnly: z.enum(["true", "false"]).optional() }).strict().safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "invalid_request" });
      const limit = normalizeAdminDirectoryLimit(query.data.limit);
      if (limit === null) return reply.code(400).send({ error: "invalid_request" });
      return services.people(request.sessionUserId!, { search: query.data.search, ...(query.data.after ? { after: query.data.after } : {}), ...(query.data.activeOnly !== undefined ? { activeOnly: query.data.activeOnly === "true" } : {}), limit });
    });
    routes.get("/api/moderation/person", async (request, reply) => {
      const parsed = personQuery.safeParse(request.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      return services.person(request.sessionUserId!, parsed.data);
    });
    routes.post("/api/moderation/actions", async (request, reply) => {
      const body = request.body as Record<string, unknown> | null;
      if (!body || body["roomId"] !== null || !["ban", "kick", "lift"].includes(String(body["action"]))) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      if (!(await services.policy()).enabled) throw new ModerationError("moderation_disabled");
      return services.act(request.sessionUserId!, body, deps.delivery);
    });
    routes.get<{ Params: { operationId: string } }>("/api/moderation/actions/:operationId", async (request, reply) => {
      if (!z.string().uuid().safeParse(request.params.operationId).success) return reply.code(400).send({ error: "invalid_request" });
      return services.receipt(request.sessionUserId!, request.params.operationId);
    });
    done();
  });
}

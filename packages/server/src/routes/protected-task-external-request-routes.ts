import type { FastifyInstance, onRequestHookHandler } from "fastify";
import {
  protectedTaskExternalRequestBindingSchema,
  protectedTaskExternalRequestListSchema,
  protectedTaskExternalRequestPlanBodySchema,
  protectedTaskExternalRequestPlanSchema,
  protectedTaskExternalRequestReadBodySchema,
  protectedTaskExternalRequestReadSchema,
  protectedTaskExternalRequestRespondBodySchema,
  protectedTaskExternalRequestRespondSchema,
} from "@nautilo/api-client";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import { getMaintenanceGate } from "@nautilo/runtime";
import { parseDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import { requireAgentInvocation, type AssertCanInvokeAgent } from "../lib/agent-invocation-admission";
import { isMaintenanceDrainError, replyMaintenanceRejection } from "../lib/maintenance-rejection";
import type { createProtectedTaskExternalRequests } from "./protected-task-external-requests";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";

type Service = ReturnType<typeof createProtectedTaskExternalRequests>;
const unavailable = Object.freeze({ status: "unavailable" as const });
const noStoreBeforeBody: onRequestHookHandler = function(request, reply, done) {
  reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
  liveShadowLargeRequestRouteOptions.onRequest.call(this, request, reply, done);
};
const routeOptions = Object.freeze({ ...liveShadowLargeRequestRouteOptions, onRequest: noStoreBeforeBody });

export function protectedTaskExternalRequestRoutes(app: FastifyInstance, input: Readonly<{
  service(): Promise<Service | null>;
  assertCanInvokeAgent?: AssertCanInvokeAgent;
}>) {
  app.post("/api/tasks/external-requests", routeOptions, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
    if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = protectedTaskExternalRequestBindingSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const service = await input.service();
      if (service === null) return unavailable;
      const requests = await service.list({ userId: request.sessionUserId, humanActorId: request.sessionActorId,
        clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId });
      return protectedTaskExternalRequestListSchema.parse({ status: "ready", requests });
    } catch { return unavailable; }
  });
  app.post("/api/tasks/external-requests/plan", routeOptions, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
    if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = protectedTaskExternalRequestPlanBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    try {
      const service = await input.service();
      if (service === null) return unavailable;
      const planned = await service.plan({ requestId: parsed.data.requestId,
        binding: { userId: request.sessionUserId, humanActorId: request.sessionActorId,
          clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId } });
      if (planned.status !== "authorization_required") return unavailable;
      try {
        const plan = parseDomainForegroundAuthorizationPlanV2(planned.authorizationPlanBytes);
        if (plan === null) return unavailable;
        try {
          return protectedTaskExternalRequestPlanSchema.parse({ status: planned.status, challengeId: planned.challengeId, roomId: plan.roomId,
            deadlineAt: planned.deadlineAt, requestDeadlineAt: planned.requestDeadlineAt,
            authorizationPlanBytesBase64url: Buffer.from(planned.authorizationPlanBytes).toString("base64url"),
            recipientPublicKeyBase64url: Buffer.from(planned.recipientPublicKey).toString("base64url") });
        } finally { destroyDomainForegroundAuthorizationPlanV2(plan); }
      } finally { planned.authorizationPlanBytes.fill(0); planned.recipientPublicKey.fill(0); }
    } catch { return unavailable; }
  });
  app.post("/api/tasks/external-requests/read", routeOptions, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
    if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = protectedTaskExternalRequestReadBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const bytes = Buffer.from(parsed.data.authorizationBytesBase64url, "base64url");
    try {
      if (bytes.length === 0 || bytes.toString("base64url") !== parsed.data.authorizationBytesBase64url) {
        return reply.code(400).send({ error: "invalid_request" });
      }
      const service = await input.service();
      if (service === null) return unavailable;
      return protectedTaskExternalRequestReadSchema.parse(await service.read({ challengeId: parsed.data.challengeId,
        authorizationBytes: bytes, binding: { userId: request.sessionUserId, humanActorId: request.sessionActorId,
          clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId } }));
    } catch { return unavailable; }
    finally { bytes.fill(0); }
  });
  app.post("/api/tasks/external-requests/respond", routeOptions, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
    if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const parsed = protectedTaskExternalRequestRespondBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (!await requireAgentInvocation({ humanUserId: request.sessionUserId, origin: "foreground_resume" },
      reply, input.assertCanInvokeAgent)) return;
    try {
      await getMaintenanceGate().assertAcceptingNewWork();
    } catch (error) {
      if (isMaintenanceDrainError(error)) return replyMaintenanceRejection(reply, error);
      throw error;
    }
    try {
      const service = await input.service();
      if (service === null) return unavailable;
      return protectedTaskExternalRequestRespondSchema.parse(await service.respond({ responseCapability: parsed.data.responseCapability,
        binding: { userId: request.sessionUserId, humanActorId: request.sessionActorId,
          clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId },
        response: { ...parsed.data.response, ownerId: request.sessionUserId, requestId: parsed.data.requestId },
        invocationAuthority: createAcceptedInvocationAuthority(request.sessionUserId) }));
    } catch { return unavailable; }
  });
}

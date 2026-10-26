import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { liveShadowMessagePlanRequestV1Schema } from "@nautilo/api-client";
import type { createProtectedTaskPendingAttention } from "./protected-task-pending-attention";
import type { LiveShadowMessageClientSessionInspector } from "./live-shadow-message";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";

const bindingSchema = z.object({
  clientActionSessionId: liveShadowMessagePlanRequestV1Schema.shape.clientActionSessionId,
  authorizationDeviceId: liveShadowMessagePlanRequestV1Schema.shape.clientDeviceId,
}).strict();
const pageSchema = bindingSchema.extend({ cursor: z.string().regex(/^[A-Za-z0-9_-]+$/u).optional() });
const readSchema = bindingSchema.extend({ taskId: z.string().uuid(), taskRunId: z.string().uuid(),
  challengeId: z.string().uuid(), authorizationBytesBase64url: z.string().min(1) });

export function protectedTaskPendingAttentionRoutes(app: FastifyInstance, options: Readonly<{
  service: Pick<ReturnType<typeof createProtectedTaskPendingAttention>, "page" | "read">;
  clientSessions: LiveShadowMessageClientSessionInspector;
}>) {
  app.post<{ Body: z.infer<typeof pageSchema> }>("/api/tasks/pending-attention",
    liveShadowLargeRequestRouteOptions, async (request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
      if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = pageSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({ clientActionSessionId: parsed.data.clientActionSessionId,
        actorId: request.sessionActorId });
      if (session?.initiatingClientSurface !== "workbench.browser" && session?.initiatingClientSurface !== "workbench.desktop") {
        return reply.code(403).send({ error: "client_unavailable" });
      }
      try {
        return await options.service.page({ userId: request.sessionUserId, humanActorId: request.sessionActorId,
          clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId }, parsed.data.cursor);
      } catch {
        return { status: "unavailable", nextCursor: null };
      }
    });
  app.post<{ Body: z.infer<typeof readSchema> }>("/api/tasks/pending-attention/read",
    liveShadowLargeRequestRouteOptions, async (request, reply) => {
      reply.header("Cache-Control", "private, no-store").header("Vary", "Authorization");
      if (!request.sessionUserId || !request.sessionActorId || request.policyContext?.actorRole === "guest") {
        return reply.code(401).send({ error: "unauthorized" });
      }
      const parsed = readSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
      const session = options.clientSessions.inspect({ clientActionSessionId: parsed.data.clientActionSessionId,
        actorId: request.sessionActorId });
      if (session?.initiatingClientSurface !== "workbench.browser" && session?.initiatingClientSurface !== "workbench.desktop") {
        return reply.code(403).send({ error: "client_unavailable" });
      }
      const bytes = Buffer.from(parsed.data.authorizationBytesBase64url, "base64url");
      try {
        if (bytes.length === 0 || bytes.toString("base64url") !== parsed.data.authorizationBytesBase64url) {
          return reply.code(400).send({ error: "invalid_request" });
        }
        return await options.service.read({ userId: request.sessionUserId, humanActorId: request.sessionActorId,
          clientDeviceId: parsed.data.authorizationDeviceId, clientActionSessionId: parsed.data.clientActionSessionId },
          parsed.data.taskId, parsed.data.taskRunId, parsed.data.challengeId, bytes);
      } catch {
        return { status: "unavailable", events: [] };
      } finally { bytes.fill(0); }
    });
}

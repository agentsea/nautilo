import type { FastifyInstance, FastifyReply } from "fastify";
import {
  connectedWebOperationIdSchema,
  connectedWebOperationProjectionSchema,
  connectedWebOperationStopRequestSchema,
  connectedWebOperationStopResponseSchema,
  connectedWebOperationWatchRequestSchema,
  connectedWebOperationWatchSchema,
  type ConnectedWebOperationProjection,
} from "@nautilo/types";
import { ConnectedWebAccountStoreError } from "../connected-web-accounts/store";

export interface ConnectedWebOperationRoutesController {
  get(input: { readonly ownerUserId: string; readonly operationId: string; readonly activityBefore?: number }): Promise<ConnectedWebOperationProjection>;
  watch(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<{ readonly liveViewUrl: string }>;
  stop(input: { readonly ownerUserId: string; readonly operationId: string }): Promise<ConnectedWebOperationProjection>;
}

function owner(request: { readonly sessionUserId: string | null; readonly policyContext?: { readonly actorRole?: string } | null }, reply: FastifyReply): string | null {
  if (!request.sessionUserId) { reply.code(401).send({ error: "Authentication required" }); return null; }
  if (request.policyContext?.actorRole === "guest") { reply.code(403).send({ error: "Forbidden" }); return null; }
  return request.sessionUserId;
}

function operationId(params: unknown, reply: FastifyReply): string | null {
  const parsed = connectedWebOperationIdSchema.safeParse((params as { operationId?: unknown }).operationId);
  if (!parsed.success) { reply.code(400).send({ error: "Invalid connected web operation request" }); return null; }
  return parsed.data;
}

function replyForError(error: unknown, reply: FastifyReply): never {
  if (error instanceof ConnectedWebAccountStoreError) {
    if (error.kind === "not_found") return reply.code(404).send({ error: "connected_web_operation_not_found" }) as never;
    if (error.kind === "conflict") return reply.code(409).send({ error: "connected_web_operation_conflict" }) as never;
    return reply.code(503).send({ error: "connected_web_operation_provider_unavailable" }) as never;
  }
  throw error;
}

/** Owner-only public surface. It has no Genie, Room, lane, or provider-reference bypass. */
export function connectedWebOperationRoutes(app: FastifyInstance, deps: { readonly controller: ConnectedWebOperationRoutesController }): void {
  app.get<{ Params: { operationId: string }; Querystring: { activityBefore?: string } }>("/api/connected-web-operations/:operationId", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = operationId(request.params, reply); if (!id) return;
    const activityBefore = request.query.activityBefore === undefined ? undefined : Number(request.query.activityBefore);
    if (activityBefore !== undefined && (!Number.isSafeInteger(activityBefore) || activityBefore < 1)) return reply.code(400).send({ error: "Invalid activity cursor" });
    reply.header("cache-control", "no-store");
    try { return reply.send(connectedWebOperationProjectionSchema.parse(await deps.controller.get({ ownerUserId, operationId: id, ...(activityBefore === undefined ? {} : { activityBefore }) }))); }
    catch (error) { return replyForError(error, reply); }
  });
  app.post<{ Params: { operationId: string } }>("/api/connected-web-operations/:operationId/watch", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = operationId(request.params, reply); if (!id) return;
    if (!connectedWebOperationWatchRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web operation request" });
    try {
      reply.header("cache-control", "no-store");
      return reply.send(connectedWebOperationWatchSchema.parse(await deps.controller.watch({ ownerUserId, operationId: id })));
    } catch (error) { return replyForError(error, reply); }
  });
  app.post<{ Params: { operationId: string } }>("/api/connected-web-operations/:operationId/stop", async (request, reply) => {
    const ownerUserId = owner(request, reply); if (!ownerUserId) return;
    const id = operationId(request.params, reply); if (!id) return;
    if (!connectedWebOperationStopRequestSchema.safeParse(request.body).success) return reply.code(400).send({ error: "Invalid connected web operation request" });
    try { return reply.send(connectedWebOperationStopResponseSchema.parse({ operation: await deps.controller.stop({ ownerUserId, operationId: id }) })); }
    catch (error) { return replyForError(error, reply); }
  });
}

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import {
  bolterConnectRequestSchema, bolterConnectionUpdateSchema, bolterRevisionRequestSchema,
  bolterCreateRoomRequestSchema, bolterBindingUpdateSchema, bolterReviewedMessageRequestSchema, bolterDeliverySelectionSchema,
} from "@nautilo/types";
import { BolterControlError, type BolterController } from "../messaging/bolter-controller";
import { BolterBridgeAuthorityError, BolterBridgeIdentityConflictError } from "@nautilo/db";

type HumanRequest = FastifyRequest & { sessionUserId: string | null };
function owner(request: HumanRequest, reply: FastifyReply): string | null {
  if (!request.sessionUserId || request.policyContext?.actorRole === "guest") {
    reply.code(request.sessionUserId ? 403 : 401).send({ code: "authentication_required" }); return null;
  }
  return request.sessionUserId;
}
function failure(reply: FastifyReply, error: unknown) {
  if (error instanceof BolterControlError) return reply.code(error.code === "not_found" ? 404 : 409).send({ code: error.code });
  if (error instanceof BolterBridgeIdentityConflictError) return reply.code(409).send({ code: "conflict" });
  if (error instanceof BolterBridgeAuthorityError) return reply.code(409).send({ code: "authority_changed" });
  return reply.code(503).send({ code: "runtime_unavailable" });
}

/** Authenticated Human controls; browser input never supplies Relay authority. */
export function bolterRoutes(app: FastifyInstance, controller: BolterController): void {
  app.get("/api/bolter/connections", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    try { return await controller.connections(userId); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/bolter/connections/connect", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const body = bolterConnectRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.connect(userId, body.data.relayId); } catch (error) { return failure(reply, error); }
  });
  app.get("/api/bolter/operations/:id", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    try { return controller.operation(userId, params.data.id); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/bolter/operations/:id/cancel", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = z.object({}).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.cancelOperation(userId, params.data.id); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/bolter/connections/:id/check", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = z.object({}).strict().safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.check(userId, params.data.id); } catch (error) { return failure(reply, error); }
  });
  app.patch("/api/bolter/connections/:id", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = bolterConnectionUpdateSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.updateConnection(userId, params.data.id, body.data.expectedRevision, body.data.enabled); } catch (error) { return failure(reply, error); }
  });
  app.delete("/api/bolter/connections/:id", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = bolterRevisionRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.updateConnection(userId, params.data.id, body.data.expectedRevision, false, true); } catch (error) { return failure(reply, error); }
  });
  app.get("/api/bolter/connections/:id/conversations", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.conversations(userId, params.data.id); } catch (error) { return failure(reply, error); }
  });
  app.get("/api/bolter/connections/:id/rooms", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.connectionRooms(userId, params.data.id); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/bolter/connections/:id/rooms", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = bolterCreateRoomRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.createRoom(userId, params.data.id, body.data); } catch (error) { return failure(reply, error); }
  });
  app.get("/api/bolter/rooms/:roomId", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ roomId: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.room(userId, params.data.roomId); } catch (error) { return failure(reply, error); }
  });
  app.patch("/api/bolter/bindings/:id", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = bolterBindingUpdateSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.updateBinding(userId, params.data.id, body.data.expectedRevision, body.data.state); } catch (error) { return failure(reply, error); }
  });
  app.post("/api/bolter/bindings/:id/messages", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const body = bolterReviewedMessageRequestSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.sendReviewed(userId, params.data.id, body.data); } catch (error) { return failure(reply, error); }
  });
  app.get("/api/bolter/bindings/:id/deliveries", async (request, reply) => {
    const userId = owner(request, reply); if (!userId) return;
    const params = z.object({ id: z.uuid() }).strict().safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: "invalid_request" });
    const query = bolterDeliverySelectionSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ code: "invalid_request" });
    try { return await controller.deliveries(userId, params.data.id, query.data); } catch (error) { return failure(reply, error); }
  });
}

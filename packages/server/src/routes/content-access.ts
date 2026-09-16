import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import {
  isScopeMemoryEnvelope,
  findActorByOwnerId,
  inspectContentAccess,
  type ContentAccessAdmission,
  type ContentAccessCommand,
  type ContentAccessFailure,
  type ContentAccessPreparation,
  type ContentAccessReceipt,
  type createContentAccessCoordinator,
} from "@nautilo/trust";

const uuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "Must be a canonical UUID",
);
const objectSchema = z.object({
  kind: z.enum(["memory", "artifact"]),
  id: uuidSchema,
}).strict();
const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant_people"), selectedUserIds: z.array(uuidSchema).min(1) }).strict(),
  z.object({ kind: z.literal("grant_room"), targetRoomId: uuidSchema }).strict(),
  z.object({ kind: z.literal("remove_person"), actorId: uuidSchema }).strict(),
  z.object({ kind: z.literal("detach_room"), targetRoomId: uuidSchema }).strict(),
  z.object({ kind: z.literal("make_private") }).strict(),
]);
const publicPrepareBodySchema = z.object({
  operationId: uuidSchema,
  object: objectSchema,
  change: changeSchema,
}).strict();
const coordinatorChangeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("grant_people"), selectedActorIds: z.array(uuidSchema).min(1) }).strict(),
  z.object({ kind: z.literal("grant_room"), targetRoomId: uuidSchema }).strict(),
  z.object({ kind: z.literal("remove_person"), actorId: uuidSchema }).strict(),
  z.object({ kind: z.literal("detach_room"), targetRoomId: uuidSchema }).strict(),
  z.object({ kind: z.literal("make_private") }).strict(),
]);
const commitBodySchema = z.object({
  operationId: uuidSchema,
  object: objectSchema,
  change: coordinatorChangeSchema,
  previewToken: z.string().min(1),
}).strict();
const sourceQuerySchema = z.object({ roomId: uuidSchema }).strict();

export const HUMAN_MANAGE_CONTENT_ACCESS_APPROVAL_CONTEXT =
  "nautilo/content-access/human-manage-access/v1";

export type ContentAccessCoordinatorPort = Pick<
  ReturnType<typeof createContentAccessCoordinator>,
  "prepare" | "commit"
>;

export interface ContentAccessRouteDependencies {
  coordinator: ContentAccessCoordinatorPort;
  findActor?: typeof findActorByOwnerId;
  inspect?: typeof inspectContentAccess;
  loadPolicy?: () => Promise<{ mode: string }>;
}

type CoordinatorResult = ContentAccessPreparation | ContentAccessReceipt | ContentAccessFailure;

const statusForFailure = (outcome: ContentAccessFailure["outcome"]): 403 | 409 | 503 =>
  outcome === "denied" ? 403 : outcome === "stale" ? 409 : 503;

function failureMessage(outcome: ContentAccessFailure["outcome"]): string {
  if (outcome === "denied") return "Content access denied";
  if (outcome === "stale") return "Content access changed. Prepare again.";
  return "Content access result unavailable";
}

function sendFailure(reply: FastifyReply, failure: ContentAccessFailure) {
  return reply.code(statusForFailure(failure.outcome)).send({
    error: failureMessage(failure.outcome),
    outcome: failure.outcome,
    stateChanged: failure.stateChanged,
    receiptPersisted: failure.receiptPersisted,
    recovery: failure.recovery,
  });
}

function commandProjection(command: ContentAccessCommand): ContentAccessCommand {
  let change: ContentAccessCommand["change"];
  switch (command.change.kind) {
    case "grant_people":
      change = { kind: "grant_people", selectedActorIds: [...command.change.selectedActorIds] };
      break;
    case "grant_room":
    case "detach_room":
      change = { kind: command.change.kind, targetRoomId: command.change.targetRoomId };
      break;
    case "remove_person":
      change = { kind: "remove_person", actorId: command.change.actorId };
      break;
    case "make_private":
      change = { kind: "make_private" };
      break;
  }
  return {
    operationId: command.operationId,
    object: { kind: command.object.kind, id: command.object.id },
    change,
  };
}

function preparedProjection(prepared: ContentAccessPreparation) {
  return {
    outcome: "prepared" as const,
    previewToken: prepared.previewToken,
    expiresAt: prepared.expiresAt,
    command: commandProjection(prepared.command),
    preview: {
      humanActorIds: [...prepared.preview.humanActorIds],
      people: prepared.preview.people.map((person) => ({ actorId: person.actorId,
        displayName: person.displayName, userHandle: person.userHandle })),
      ...(prepared.preview.targetRoomId === undefined
        ? {} : { targetRoomId: prepared.preview.targetRoomId }),
      ...(prepared.preview.targetRoomLabel === undefined
        ? {} : { targetRoomLabel: prepared.preview.targetRoomLabel }),
      publicRoom: prepared.preview.publicRoom,
      skippedAttachmentCount: prepared.preview.skippedAttachmentCount,
    },
  };
}

function receiptProjection(receipt: ContentAccessReceipt) {
  return {
    operationId: receipt.operationId,
    outcome: receipt.outcome,
    stateChanged: receipt.stateChanged,
    originalStateChanged: receipt.originalStateChanged,
    replayed: receipt.replayed,
    attachedCount: receipt.attachedCount,
    detachedCount: receipt.detachedCount,
    skippedCount: receipt.skippedCount,
  };
}

function terminalReceiptFailure(reply: FastifyReply, receipt: ContentAccessReceipt) {
  const outcome = receipt.outcome as ContentAccessFailure["outcome"];
  return reply.code(statusForFailure(outcome)).send({
    error: failureMessage(outcome),
    outcome,
    stateChanged: receipt.stateChanged,
    receiptPersisted: true,
    recovery: "prepare_again",
  });
}

function admissionFromRequest(
  request: FastifyRequest,
  roomId: string,
): ContentAccessAdmission | null {
  const envelope = request.memoryEnvelope;
  if (!request.sessionUserId || !envelope || isScopeMemoryEnvelope(envelope)
    || envelope.ownerId !== request.sessionUserId
    || !envelope.actorId || !envelope.roomId || envelope.roomId !== roomId) return null;
  return {
    principal: {
      kind: "human",
      userId: request.sessionUserId,
      actorId: envelope.actorId,
      sourceRoomId: envelope.roomId,
      ...(envelope.agentId ? { agentId: envelope.agentId } : {}),
    },
    audienceContract: "invoking_room",
    approvalContext: HUMAN_MANAGE_CONTENT_ACCESS_APPROVAL_CONTEXT,
  };
}

function isFailure(result: CoordinatorResult): result is ContentAccessFailure {
  return "receiptPersisted" in result;
}

function unavailable(reply: FastifyReply, stateChanged: false | "unknown") {
  return sendFailure(reply, {
    outcome: "failed",
    stateChanged,
    receiptPersisted: false,
    recovery: stateChanged === "unknown" ? "retry_receipt" : "prepare_again",
  });
}

export function contentAccessRoutes(app: FastifyInstance, dependencies: ContentAccessRouteDependencies) {
  const { coordinator } = dependencies;
  const findActor = dependencies.findActor ?? findActorByOwnerId;
  app.get("/api/content-access", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const query = z.object({ roomId: uuidSchema, kind: z.enum(["memory", "artifact"]), id: uuidSchema }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "A valid object and roomId are required" });
    if (!request.sessionUserId) return reply.code(401).send({ error: "Authentication required" });
    const admission = admissionFromRequest(request, query.data.roomId);
    if (!admission) return reply.code(403).send({ error: "Human Room context required" });
    const summary = await (dependencies.inspect ?? inspectContentAccess)(admission, { kind: query.data.kind, id: query.data.id });
    if ("receiptPersisted" in summary) return sendFailure(reply, summary);
    return { object: { kind: summary.object.kind, id: summary.object.id },
      people: summary.people.map((person) => ({ actorId: person.actorId, displayName: person.displayName,
        userHandle: person.userHandle, canRemove: person.canRemove,
        sources: person.sources.map((source) => source.kind === "immutable"
          ? { kind: source.kind, boundaryCount: source.boundaryCount }
          : { kind: source.kind, roomId: source.roomId, label: source.label, publicRoom: source.publicRoom }) })),
      rooms: summary.rooms.map((room) => ({ roomId: room.roomId, label: room.label,
        publicRoom: room.publicRoom, canDetach: room.canDetach })),
      otherAccessCount: summary.otherAccessCount };
  });
  app.post<{ Querystring: unknown; Body: unknown }>(
    "/api/content-access/prepare",
    async (request, reply) => {
      const query = sourceQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "A valid roomId is required" });
      if (!request.sessionUserId) return reply.code(401).send({ error: "Authentication required" });
      const admission = admissionFromRequest(request, query.data.roomId);
      if (!admission) return reply.code(403).send({ error: "Human Room context required" });
      const parsed = publicPrepareBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid content access request" });
      // Directory identity resolution is not a mode-detection side channel.
      // Commit deliberately omits this early gate: an authenticated historical
      // receipt can still be recovered across a later mode change.
      try {
        if ((await (dependencies.loadPolicy ?? currentStrictShadowPolicy)()).mode !== "plaintext_only") {
          return sendFailure(reply, { outcome: "stale", stateChanged: false, receiptPersisted: false, recovery: "prepare_again" });
        }
      } catch { return unavailable(reply, false); }
      let coordinatorCommand: ContentAccessCommand;
      if (parsed.data.change.kind === "grant_people") {
        const selectedUserIds = [...new Set(parsed.data.change.selectedUserIds)].sort();
        let selectedActors: Awaited<ReturnType<typeof findActorByOwnerId>>[];
        try {
          selectedActors = await Promise.all(selectedUserIds.map((userId) => findActor(userId)));
        } catch {
          return unavailable(reply, false);
        }
        const selectedActorIds = selectedActors.map((actor) => actor?.id);
        if (selectedActorIds.some((actorId) => !uuidSchema.safeParse(actorId).success)) {
          return reply.code(404).send({ error: "Person is no longer available" });
        }
        coordinatorCommand = {
          operationId: parsed.data.operationId,
          object: parsed.data.object,
          change: {
            kind: "grant_people",
            selectedActorIds: selectedActorIds as string[],
          },
        };
      } else {
        coordinatorCommand = parsed.data as ContentAccessCommand;
      }
      let result: Awaited<ReturnType<ContentAccessCoordinatorPort["prepare"]>>;
      try {
        result = await coordinator.prepare(admission, coordinatorCommand);
      } catch {
        return unavailable(reply, false);
      }
      if (isFailure(result)) return sendFailure(reply, result);
      return preparedProjection(result);
    },
  );

  app.post<{ Querystring: unknown; Body: unknown }>(
    "/api/content-access/commit",
    async (request, reply) => {
      const query = sourceQuerySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ error: "A valid roomId is required" });
      if (!request.sessionUserId) return reply.code(401).send({ error: "Authentication required" });
      const admission = admissionFromRequest(request, query.data.roomId);
      if (!admission) return reply.code(403).send({ error: "Human Room context required" });
      const parsed = commitBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "Invalid content access request" });
      const { previewToken, ...command } = parsed.data;
      let result: Awaited<ReturnType<ContentAccessCoordinatorPort["commit"]>>;
      try {
        result = await coordinator.commit(admission, command, previewToken);
      } catch {
        return unavailable(reply, "unknown");
      }
      if (isFailure(result)) return sendFailure(reply, result);
      if (result.outcome === "denied" || result.outcome === "stale" || result.outcome === "failed") {
        return terminalReceiptFailure(reply, result);
      }
      return receiptProjection(result);
    },
  );
}

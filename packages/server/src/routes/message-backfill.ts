import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2, MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
} from "@nautilo/lattice-crypto/wire-limits";
import {
  messageBackfillNextRequestSchema, messageBackfillClaimRequestSchema,
  messageBackfillPublishRequestSchema, messageBackfillAckRequestSchema,
  messageBackfillNextResponseSchema, messageBackfillSourceResponseSchema,
  messageBackfillPublishResponseSchema, messageBackfillAckResponseSchema, messageBackfillProgressSchema,
} from "@nautilo/api-client";
import { createProductionMessageBackfillComposition, type MessageBackfillSubject } from "./message-backfill-composition";
import { selectRoomHistoryResponseMetadata } from "./room-history-response-metadata";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";

// The exact JSON wrapper and four independently bounded base64url wire fields.
// Whitespace is not needed by the canonical client encoder.
const publicationBodyBytes = JSON.stringify({claimId: "00000000-0000-4000-8000-000000000000",
  requestBytesBase64url: "", payloadBytesBase64url: "", manifestBytesBase64url: "",
  envelopeBytesBase64url: ""}).length + [
    MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
    MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2, MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
    MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  ].reduce((total, bytes) => total + Math.ceil(bytes * 4 / 3), 0);

function subject(request: FastifyRequest): MessageBackfillSubject {
  const admission = request.cryptoDeviceAdmission;
  if (!request.sessionUserId || !request.sessionActorId || !admission
    || admission.expiresAt <= Date.now()) {
    throw Object.assign(new Error("Current device admission is required"), {statusCode: 428});
  }
  return {userId: request.sessionUserId, humanActorId: request.sessionActorId,
    deviceId: admission.deviceId, admission};
}

/** Authentication identifies the Human and admitted device; bodies contain no authority selector. */
export function messageBackfillRoutes(app: FastifyInstance,
  composition = createProductionMessageBackfillComposition(),
): void {
  app.post("/api/message-backfill/next", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const parsed = messageBackfillNextRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error: "Invalid Message repair selection"});
    return messageBackfillNextResponseSchema.parse(await composition.next(subject(request), parsed.data.urgent));
  });
  app.post("/api/message-backfill/source", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const parsed = messageBackfillClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error: "Invalid Message repair claim"});
    const response = messageBackfillSourceResponseSchema.parse(
      await composition.source(subject(request), parsed.data.claimId),
    );
    return response.status === "protected"
      ? { ...response, history: selectRoomHistoryResponseMetadata(response.history, request.query) }
      : response;
  });
  app.post("/api/message-backfill/publish", {
    ...liveShadowLargeRequestRouteOptions, bodyLimit: publicationBodyBytes,
  }, async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const parsed = messageBackfillPublishRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error: "Invalid Message repair publication"});
    return messageBackfillPublishResponseSchema.parse(await composition.publish(subject(request), parsed.data));
  });
  app.post("/api/message-backfill/ack", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const parsed = messageBackfillAckRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error: "Invalid Message repair acknowledgement"});
    return messageBackfillAckResponseSchema.parse(await composition.ack(subject(request), parsed.data));
  });
  app.get("/api/message-backfill/progress", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    if (!request.sessionUserId || !request.sessionActorId) return reply.code(401).send({error: "Authentication required"});
    return messageBackfillProgressSchema.parse(await composition.progress({
      userId: request.sessionUserId, humanActorId: request.sessionActorId,
    }));
  });
}

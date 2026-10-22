import {
  HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1,
  LATTICE_LIMITS,
} from "@nautilo/lattice-crypto/wire-limits";
import { z } from "zod";

import {
  roomHistoryShadowReadIntentV1Schema,
  roomHistoryShadowReadReadyResponseV1Schema,
} from "./room-history-shadow-read";

const canonicalUuid = z.string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const cursor = z.string().min(1).max(LATTICE_LIMITS.idBytes * 4)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine((value) => value.length % 4 !== 1, {
    message: "Task transcript cursor must be canonical unpadded base64url",
  });

export const protectedTaskTranscriptReadRequestV1Schema = z.object({
  readVersion: z.literal(1),
  agentId: canonicalUuid,
  cursor: cursor.optional(),
  limit: z.number().int().positive()
    .max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1).optional(),
  historyRead: roomHistoryShadowReadIntentV1Schema,
}).strict();

const identity = {
  readVersion: z.literal(1),
  taskId: canonicalUuid,
  taskRunId: canonicalUuid,
  agentId: canonicalUuid,
} as const;

const entry = z.object({
  sessionId: canonicalUuid,
  messageId: z.string().regex(/^[1-9][0-9]*$/u),
  editRevision: z.number().int().nonnegative().safe(),
  role: z.enum(["assistant", "tool", "system"]),
  createdAt: z.string().datetime(),
}).strict();

export const protectedTaskTranscriptReadResponseV1Schema =
  z.discriminatedUnion("status", [
    z.object({
      ...identity,
      status: z.literal("ready"),
      sourceRoomId: canonicalUuid,
      entries: z.array(entry).min(1)
        .max(HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1),
      nextCursor: cursor.nullable(),
      history: roomHistoryShadowReadReadyResponseV1Schema,
    }).strict(),
    z.object({
      ...identity,
      status: z.literal("waiting"),
      reason: z.literal("transcript_not_mapped"),
    }).strict(),
    z.object({
      ...identity,
      status: z.literal("unavailable"),
      reason: z.enum([
        "transcript_not_protected",
        "not_in_message_audience",
        "message_history_unavailable",
        "device_not_ready",
        "authority_changed",
        "integrity_failure",
      ]),
    }).strict(),
  ]);

export type ProtectedTaskTranscriptReadRequestV1 = z.infer<
  typeof protectedTaskTranscriptReadRequestV1Schema
>;
export type ProtectedTaskTranscriptReadResponseV1 = z.infer<
  typeof protectedTaskTranscriptReadResponseV1Schema
>;
export type ProtectedTaskTranscriptReadReadyResponseV1 = Extract<
  ProtectedTaskTranscriptReadResponseV1,
  { status: "ready" }
>;

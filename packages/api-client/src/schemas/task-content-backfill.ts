import { z } from "zod";
import {
  LATTICE_LIMITS,
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.positive();
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
const wireBytes = (maximum: number) => z.string().min(1)
  .max(Math.ceil(maximum * 4 / 3))
  .regex(/^[A-Za-z0-9_-]+$/u)
  .refine(value => value.length % 4 !== 1);

const definitionCandidateSchema = z.object({
  kind: z.literal("definition"),
  taskId: z.string().uuid(),
  sourceCreatedAt: counter,
  sourceUpdatedAt: counter,
  sourceRevision: counter,
  sourceStatus: z.string().min(1),
}).strict();

const resultCandidateSchema = z.object({
  kind: z.literal("result"),
  taskId: z.string().uuid(),
  taskRunId: z.string().uuid(),
  sourceUpdatedAt: counter,
  sourceStartedAt: counter,
  sourceCompletedAt: counter,
  sourceRevision: counter,
  sourceStatus: z.enum(["completed", "errored", "cancelled"]),
}).strict();

export const taskContentBackfillCandidateSchema = z.discriminatedUnion("kind", [
  definitionCandidateSchema,
  resultCandidateSchema,
]);

export const taskContentBackfillClaimSchema = z.object({
  claimId: z.string().uuid(),
  humanActorId: z.string().uuid(),
  requesterUserId: z.string().uuid(),
  deviceId: z.string().min(1),
  policyRevision: positiveCounter,
  expiresAt: counter,
  candidate: taskContentBackfillCandidateSchema,
}).strict();

const taskContentCoordinateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("definition"),
    taskId: z.string().uuid(),
    contentRevision: z.literal(1),
  }).strict(),
  z.object({
    kind: z.literal("run_result"),
    taskId: z.string().uuid(),
    taskRunId: z.string().uuid(),
    contentRevision: z.literal(1),
  }).strict(),
]);

export const taskContentBackfillPublicationPlanSchema = z.object({
  planVersion: z.literal(1),
  claimId: z.string().uuid(),
  operationId: z.string().min(1).max(LATTICE_LIMITS.idBytes),
  coordinate: taskContentCoordinateSchema,
  objectId: z.string().regex(/^task-historical:v1:[0-9a-f]{64}$/u),
  namespaceId: z.string().uuid(),
  domainId: z.string().min(1).max(LATTICE_LIMITS.idBytes),
  requesterHumanId: z.string().uuid(),
  deviceId: z.string().min(1).max(LATTICE_LIMITS.idBytes),
  hostAuthorizationRevision: counter,
  expectedAccessRevision: counter,
  expectedPolicyRevision: positiveCounter,
  keyGeneration: counter,
  bindingHashBase64url: digest,
  sourceDigestBase64url: digest,
  sourcePayloadHashBase64url: digest,
  operationalFieldsDigestBase64url: digest,
  planDigestBase64url: digest,
  expiresAt: counter,
}).strict();

const inactiveResponseSchema = z.object({
  status: z.enum(["inactive", "unauthorized"]),
}).strict();

const discoverySchema = z.discriminatedUnion("status", [
  z.object({ status: z.enum(["disabled", "full_wait", "more"]) }).strict(),
  z.object({ status: z.literal("waiting"), resumeAt: counter.nullable() }).strict(),
  z.object({ status: z.literal("swept"), resumeAt: counter }).strict(),
  z.object({ status: z.literal("claimed"), claim: taskContentBackfillClaimSchema }).strict(),
  z.object({
    status: z.literal("candidate"),
    candidate: taskContentBackfillCandidateSchema,
    policyRevision: positiveCounter,
  }).strict(),
]);

export const taskContentBackfillDiscoverResponseSchema = z.union([
  inactiveResponseSchema,
  z.object({ status: z.literal("ready"), value: discoverySchema }).strict(),
]);

export const taskContentBackfillClaimRequestSchema = z.object({
  candidate: taskContentBackfillCandidateSchema,
  policyRevision: positiveCounter,
}).strict();

export const taskContentBackfillClaimResponseSchema = z.union([
  inactiveResponseSchema,
  z.object({
    status: z.literal("ready"),
    value: z.discriminatedUnion("status", [
      z.object({ status: z.literal("claimed"), claim: taskContentBackfillClaimSchema }).strict(),
      z.object({ status: z.enum(["stale", "held", "disabled", "deferred"]) }).strict(),
    ]),
  }).strict(),
]);

export const taskContentBackfillClaimIdRequestSchema = z.object({
  claimId: z.string().uuid(),
}).strict();

const activeSourceResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("source"),
    sourceRoomId: z.string().uuid(),
    plan: taskContentBackfillPublicationPlanSchema,
    payloadBytesBase64url: wireBytes(LATTICE_LIMITS.plaintextBytes),
  }).strict(),
  z.object({
    status: z.enum([
      "stale", "waiting_for_authority", "unsupported", "no_content",
      "waiting_parent", "integrity",
    ]),
    resumeAt: counter.nullable(),
  }).strict(),
]);

export const taskContentBackfillSourceResponseSchema = z.union([
  z.object({ status: z.literal("inactive") }).strict(),
  activeSourceResponseSchema,
]);

export const taskContentBackfillPublishRequestSchema = z.object({
  claimId: z.string().uuid(),
  requestBytesBase64url: wireBytes(
    MAX_HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  ),
  payloadBytesBase64url: wireBytes(MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2),
  manifestBytesBase64url: wireBytes(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5),
  envelopeBytesBase64url: wireBytes(MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2),
}).strict();

export const taskContentBackfillPublishResponseSchema = z.union([
  z.object({ status: z.literal("inactive") }).strict(),
  z.object({
    status: z.enum([
      "published", "replayed", "stale", "waiting_for_authority", "integrity",
    ]),
  }).strict(),
]);

export const taskContentBackfillRecoverResponseSchema = z.union([
  z.object({ status: z.literal("inactive") }).strict(),
  z.object({
    status: z.enum([
      "mapped", "pending", "stale", "waiting_for_authority", "integrity",
    ]),
  }).strict(),
]);

const progressSchema = z.object({
  eligibleDefinitions: counter,
  mappedDefinitions: counter,
  eligibleResults: counter,
  mappedResults: counter,
  claimedRepairing: counter,
  waiting: counter,
  unsupported: counter,
  failed: counter,
  noContent: counter,
  pending: counter,
}).strict();

export const taskContentBackfillProgressResponseSchema = z.union([
  inactiveResponseSchema,
  z.object({ status: z.literal("ready"), value: progressSchema.nullable() }).strict(),
]);

export const taskContentBackfillReleaseRequestSchema = z.object({
  claimId: z.string().uuid(),
  advance: z.boolean(),
}).strict();

export const taskContentBackfillReleaseResponseSchema = z.union([
  inactiveResponseSchema,
  z.object({ status: z.literal("ready"), value: z.boolean() }).strict(),
]);

export const taskContentBackfillOutcomeSchema = z.enum([
  "mapped", "unsupported", "no_content", "integrity", "waiting_parent",
]);

export const taskContentBackfillAckRequestSchema = z.object({
  claimId: z.string().uuid(),
  outcome: taskContentBackfillOutcomeSchema,
}).strict();

export const taskContentBackfillAckResponseSchema = z.union([
  inactiveResponseSchema,
  z.object({
    status: z.literal("ready"),
    value: z.enum([
      "acknowledged", "lease_lost", "source_changed", "not_mapped", "disabled",
    ]),
  }).strict(),
]);

export type TaskContentBackfillCandidate = z.infer<typeof taskContentBackfillCandidateSchema>;
export type TaskContentBackfillClaim = z.infer<typeof taskContentBackfillClaimSchema>;
export type TaskContentBackfillPublicationPlan = z.infer<typeof taskContentBackfillPublicationPlanSchema>;
export type TaskContentBackfillDiscoverResponse = z.infer<typeof taskContentBackfillDiscoverResponseSchema>;
export type TaskContentBackfillClaimRequest = z.infer<typeof taskContentBackfillClaimRequestSchema>;
export type TaskContentBackfillClaimResponse = z.infer<typeof taskContentBackfillClaimResponseSchema>;
export type TaskContentBackfillSourceResponse = z.infer<typeof taskContentBackfillSourceResponseSchema>;
export type TaskContentBackfillPublishRequest = z.infer<typeof taskContentBackfillPublishRequestSchema>;
export type TaskContentBackfillPublishResponse = z.infer<typeof taskContentBackfillPublishResponseSchema>;
export type TaskContentBackfillRecoverResponse = z.infer<typeof taskContentBackfillRecoverResponseSchema>;
export type TaskContentBackfillProgressResponse = z.infer<typeof taskContentBackfillProgressResponseSchema>;
export type TaskContentBackfillReleaseRequest = z.infer<typeof taskContentBackfillReleaseRequestSchema>;
export type TaskContentBackfillReleaseResponse = z.infer<typeof taskContentBackfillReleaseResponseSchema>;
export type TaskContentBackfillOutcome = z.infer<typeof taskContentBackfillOutcomeSchema>;
export type TaskContentBackfillAckRequest = z.infer<typeof taskContentBackfillAckRequestSchema>;
export type TaskContentBackfillAckResponse = z.infer<typeof taskContentBackfillAckResponseSchema>;

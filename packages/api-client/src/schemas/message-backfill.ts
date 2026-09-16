import { z } from "zod";
import {
  LATTICE_LIMITS, MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2, MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
} from "@nautilo/lattice-crypto/wire-limits";
import { roomHistoryShadowReadResponseV1Schema } from "./room-history-shadow-read";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u);
const keyClass = z.enum(["human", "ai"]);

export const messageBackfillCoordinateSchema = z.object({
  sessionId: z.string().uuid(), messageId: counter.positive(), revision: counter,
  roomId: z.string().uuid(), namespaceId: z.string().uuid(),
  role: z.enum(["user", "assistant", "tool", "system"]), logicalMessageKey: z.string().min(1),
}).strict();

export const messageBackfillClaimSchema = z.object({
  version: z.literal(1), claimId: z.string().uuid(), operationId: z.string().min(1),
  coordinate: messageBackfillCoordinateSchema,
  /** Exact Tool transcript generation; other roles depend only on their own revision. */
  sourceRevision: counter.nullable(),
  action: z.enum(["encrypt", "verify", "restore"]),
  subjectHumanId: z.string().uuid(), deviceId: z.string().min(1),
  serverInstanceId: z.string().min(1), deviceGeneration: counter.positive(),
  lineageGeneration: counter, membershipEpoch: counter, membershipSecurityRevision: counter,
  membershipHeadDigestBase64url: digest,
  hostAuthorizationRevision: counter,
  policyRevision: counter.positive(),
  keyClass, namespaceAccessRevision: counter, namespaceKeyGeneration: counter,
  namespaceHeadDigestBase64url: digest,
  domainId: z.string().min(1), domainGeneration: counter,
  domainAuthorizationRevision: counter, domainHeadDigestBase64url: digest,
  namespaceBundleRevision: counter, namespaceBundleDigestBase64url: digest,
  repairIdentityDigestBase64url: digest,
  createdAt: counter, authorHumanTurnId: z.string().nullable(), sessionAgentId: z.string().uuid().nullable(),
  cryptoObjectId: z.string().min(1),
  issuedAt: counter, expiresAt: counter,
}).strict().refine(claim => claim.coordinate.role === "tool"
  ? claim.sourceRevision !== null : claim.sourceRevision === null, {
  message: "Only Tool claims require a transcript source revision",
}).refine((claim) => claim.expiresAt > claim.issuedAt, {
  message: "Claim expiry must follow issuance",
});

export const messageBackfillOutcomeSchema = z.enum([
  "reconciled", "waiting_for_authority", "stale", "unsupported", "integrity_failure", "parity_mismatch",
]);

export const messageBackfillNextRequestSchema = z.object({
  urgent: messageBackfillCoordinateSchema.pick({messageId: true, revision: true, roomId: true}).optional(),
}).strict();
export const messageBackfillClaimRequestSchema = z.object({ claimId: z.string().uuid() }).strict();

export const messageBackfillNextResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), claim: messageBackfillClaimSchema }).strict(),
  z.object({ status: z.literal("prepare_authority"), coordinate: messageBackfillCoordinateSchema,
    keyClass, resumeAt: counter }).strict(),
  z.object({ status: z.enum(["more", "waiting", "caught_up", "disabled"]),
    resumeAt: counter.nullable(), snapshotAt: counter, complete: z.boolean(),
    resolvedSelection: messageBackfillCoordinateSchema.pick({roomId: true, messageId: true, revision: true}).optional() }).strict(),
]);

const wireBytes = (maximum: number) => z.string().min(1).max(Math.ceil(maximum * 4 / 3))
  .regex(/^[A-Za-z0-9_-]+$/u).refine(value => value.length % 4 !== 1);
const sourceBytes = wireBytes(LATTICE_LIMITS.plaintextBytes);
export const messageBackfillSourceResponseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ordinary"), claim: messageBackfillClaimSchema,
    payloadBytesBase64url: sourceBytes, sourceDigestBase64url: digest }).strict(),
  z.object({ status: z.literal("protected"), claim: messageBackfillClaimSchema,
    history: roomHistoryShadowReadResponseV1Schema,
    ordinaryPayloadBytesBase64url: sourceBytes.nullable(),
    sourceDigestBase64url: digest.nullable(),
  }).strict(),
  z.object({ status: z.enum(["stale", "waiting_for_authority", "unsupported", "integrity_failure"]),
    resumeAt: counter }).strict(),
]);

export const messageBackfillPublishRequestSchema = z.object({
  claimId: z.string().uuid(),
  requestBytesBase64url: wireBytes(MAX_HUMAN_EXISTING_MESSAGE_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1),
  payloadBytesBase64url: wireBytes(MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2),
  manifestBytesBase64url: wireBytes(MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5),
  envelopeBytesBase64url: wireBytes(MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2),
}).strict();

export const messageBackfillPublishResponseSchema = z.object({
  status: z.enum(["published", "replayed", "stale", "waiting_for_authority", "integrity_failure"]),
}).strict();

export const messageBackfillAckResponseSchema = z.object({
  status: z.enum(["more", "waiting", "caught_up", "stale"]), resumeAt: counter.nullable(),
}).strict();

export const messageBackfillAckRequestSchema = z.object({
  claimId: z.string().uuid(), outcome: messageBackfillOutcomeSchema,
  claimDigestBase64url: digest,
  sourceDigestBase64url: digest.nullable(),
  manifestDigestBase64url: digest.nullable(),
  signatureBase64url: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/u),
}).strict();

export const messageBackfillProgressSchema = z.object({
  status: z.enum(["active", "waiting", "failed", "caught_up", "disabled"]),
  snapshotAt: counter,
  snapshotComplete: z.boolean(),
  caughtUp: z.boolean(),
  lastSweepAt: counter.nullable(),
  activeLease: z.boolean(),
  counts: z.object({
    eligible: counter,
    alreadyAuthenticated: counter,
    independentlyParityVerified: counter,
    claimedRepairing: counter,
    repairedAndVerified: counter,
    unsupported: counter,
    failed: counter,
  }).strict(),
  waiting: z.object({
    authorizedDevice: counter.nullable(),
    authority: counter.nullable(),
  }).strict(),
}).strict();

export type MessageBackfillCoordinate = z.infer<typeof messageBackfillCoordinateSchema>;
export type MessageBackfillUrgentSelection = NonNullable<z.infer<typeof messageBackfillNextRequestSchema>["urgent"]>;
export type MessageBackfillClaim = z.infer<typeof messageBackfillClaimSchema>;
export type MessageBackfillOutcome = z.infer<typeof messageBackfillOutcomeSchema>;
export type MessageBackfillNextResponse = z.infer<typeof messageBackfillNextResponseSchema>;
export type MessageBackfillSourceResponse = z.infer<typeof messageBackfillSourceResponseSchema>;
export type MessageBackfillPublishRequest = z.infer<typeof messageBackfillPublishRequestSchema>;
export type MessageBackfillPublishResponse = z.infer<typeof messageBackfillPublishResponseSchema>;
export type MessageBackfillAckResponse = z.infer<typeof messageBackfillAckResponseSchema>;
export type MessageBackfillAckRequest = z.infer<typeof messageBackfillAckRequestSchema>;
export type MessageBackfillProgress = z.infer<typeof messageBackfillProgressSchema>;

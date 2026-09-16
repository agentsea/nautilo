import { z } from "zod";

const nonNegativeInteger = z.number().int().nonnegative();
const isoTimestamp = z.string().datetime({ offset: true });

export const reflectionSemanticSchedulerStateSchema = z.enum([
  "disabled",
  "running",
  "cooldown",
  "pressure_paused",
]);

export const reflectionSemanticPressureReasonSchema = z.enum([
  "repeated_failure",
  "elapsed_budget",
  "backlog_growth",
  "recursive_amplification",
]);

export type ReflectionSemanticPressureReason = z.infer<
  typeof reflectionSemanticPressureReasonSchema
>;

const reflectionLatencyDistributionSchema = z.object({
  samples: nonNegativeInteger,
  p50Ms: nonNegativeInteger,
  p90Ms: nonNegativeInteger,
  maximumMs: nonNegativeInteger,
}).strict();

const reflectionLaneLatencySchema = z.object({
  endToEnd: reflectionLatencyDistributionSchema,
  queue: reflectionLatencyDistributionSchema,
  candidate: reflectionLatencyDistributionSchema,
  model: reflectionLatencyDistributionSchema,
  publication: reflectionLatencyDistributionSchema,
}).strict();

export const reflectionSemanticSchedulerStatusSchema = z.object({
  state: reflectionSemanticSchedulerStateSchema,
  pauseReason: reflectionSemanticPressureReasonSchema.nullable(),
  recoveryIntervalMs: nonNegativeInteger,
  nextEligiblePollAt: isoTimestamp.nullable(),
  lastPoll: z.object({
    elapsedMs: nonNegativeInteger,
    claims: nonNegativeInteger,
    databaseWork: nonNegativeInteger,
    modelCalls: nonNegativeInteger,
    modelFailures: nonNegativeInteger,
    authorityElapsedMs: nonNegativeInteger,
    searchProjectionElapsedMs: nonNegativeInteger,
    candidateElapsedMs: nonNegativeInteger,
    modelElapsedMs: nonNegativeInteger,
    publicationElapsedMs: nonNegativeInteger,
    deterministicNoChanges: nonNegativeInteger,
    sameRoomPlans: nonNegativeInteger,
    crossRoomPlans: nonNegativeInteger,
    sameRoomCompletions: nonNegativeInteger,
    crossRoomCompletions: nonNegativeInteger,
    candidatesOpened: nonNegativeInteger,
    unsupportedAuthorityShapes: nonNegativeInteger,
    stalePlans: nonNegativeInteger,
    capacityOutcomes: nonNegativeInteger,
    noEffectiveAudience: nonNegativeInteger,
    protectedExecutionUnavailable: nonNegativeInteger,
  }).strict().nullable(),
  window: z.object({
    polls: nonNegativeInteger,
    admitted: nonNegativeInteger,
    completed: nonNegativeInteger,
    created: nonNegativeInteger,
  }).strict(),
  backlog: z.object({
    size: nonNegativeInteger,
    oldestAgeMs: nonNegativeInteger,
  }).strict(),
  latency: z.object({
    sameRoom: reflectionLaneLatencySchema,
    crossRoom: reflectionLaneLatencySchema,
  }).strict(),
  amplification: z.enum(["normal", "watch", "pressure"]),
}).strict();

export type ReflectionSemanticSchedulerStatus = z.infer<
  typeof reflectionSemanticSchedulerStatusSchema
>;

const EMPTY_LATENCY_DISTRIBUTION = Object.freeze({
  samples: 0,
  p50Ms: 0,
  p90Ms: 0,
  maximumMs: 0,
});
const EMPTY_LANE_LATENCY = Object.freeze({
  endToEnd: EMPTY_LATENCY_DISTRIBUTION,
  queue: EMPTY_LATENCY_DISTRIBUTION,
  candidate: EMPTY_LATENCY_DISTRIBUTION,
  model: EMPTY_LATENCY_DISTRIBUTION,
  publication: EMPTY_LATENCY_DISTRIBUTION,
});

export const EMPTY_REFLECTION_SEMANTIC_LATENCY = Object.freeze({
  sameRoom: EMPTY_LANE_LATENCY,
  crossRoom: EMPTY_LANE_LATENCY,
}) satisfies ReflectionSemanticSchedulerStatus["latency"];

export const reflectionSemanticStageSchema = z.enum([
  "authority_projection",
  "search_projection",
  "organization",
]);

export const reflectionSemanticFailureCodeSchema = z.enum([
  "authority_unavailable",
  "record_unavailable",
  "embedding_unavailable",
  "projection_unavailable",
  "candidate_unavailable",
  "invalid_model_output",
  "publication_unavailable",
  "unexpected_failure",
  "retry_exhausted",
]);

const exactCount = z.string().regex(/^(0|[1-9][0-9]*)$/u);

/** Content-free PR1 authority-maintenance facts. This does not report model
 * Reflection, and its device wait cannot distinguish connectivity from keys. */
export const reflectionProtectedAuthorityStatusSchema = z.object({
  dtoVersion: z.literal(1),
  scope: z.literal("authority_maintenance_only"),
  current: z.object({
    awaitingRecipient: exactCount,
    awaitingEligibleDeviceAndKeys: exactCount,
    readyOrRunning: exactCount,
    reconciliationPending: exactCount,
    retirementPending: exactCount,
    verifiedAuthority: exactCount,
    terminalOrStale: exactCount,
  }).strict(),
  last24h: z.object({
    verifiedAuthority: exactCount,
    terminalOrStale: exactCount,
  }).strict(),
}).strict();

export type ReflectionProtectedAuthorityStatus = z.infer<
  typeof reflectionProtectedAuthorityStatusSchema
>;

/** Content-free operator projection for the durable Reflection/Sleep worker. */
export const reflectionAdminStatusSchema = z.object({
  generatedAt: isoTimestamp,
  window: z.object({
    since: isoTimestamp,
    until: isoTimestamp,
  }).strict(),
  health: z.enum(["healthy", "delayed", "degraded"]),
  scheduler: reflectionSemanticSchedulerStatusSchema,
  current: z.object({
    totalRecords: nonNegativeInteger,
    backlog: nonNegativeInteger,
    due: nonNegativeInteger,
    claimed: nonNegativeInteger,
    checkpointed: nonNegativeInteger,
    deferred: nonNegativeInteger,
    complete: nonNegativeInteger,
    quarantined: nonNegativeInteger,
    recoveryEligible: nonNegativeInteger,
    maximumRecoveryRound: nonNegativeInteger,
    staleLeases: nonNegativeInteger,
    oldestOverdueMs: nonNegativeInteger,
    maximumAttempts: nonNegativeInteger,
    currentParentViolations: nonNegativeInteger,
  }).strict(),
  stages: z.object({
    authorityProjection: nonNegativeInteger,
    searchProjection: nonNegativeInteger,
    organization: nonNegativeInteger,
  }).strict(),
  projections: z.object({
    availableRecords: nonNegativeInteger,
    current: nonNegativeInteger,
    pending: nonNegativeInteger,
    incompatible: nonNegativeInteger,
  }).strict(),
  last24h: z.object({
    completedWork: nonNegativeInteger,
    syntheticParentsCreated: nonNegativeInteger,
  }).strict(),
  lastCompletedAt: isoTimestamp.nullable(),
  nextRecoveryAt: isoTimestamp.nullable(),
  currentFailures: z.array(z.object({
    stage: reflectionSemanticStageSchema,
    errorCode: reflectionSemanticFailureCodeSchema,
    occurredAt: isoTimestamp,
    attemptCount: nonNegativeInteger,
  }).strict()).max(5),
  protectedAuthority: reflectionProtectedAuthorityStatusSchema.optional(),
}).strict();

export type ReflectionAdminStatus = z.infer<typeof reflectionAdminStatusSchema>;

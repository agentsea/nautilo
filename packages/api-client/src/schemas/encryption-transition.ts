import { z } from "zod";

export const LIVE_SHADOW_ENCRYPTION_TRANSITION_MODES = [
  "plaintext_only",
  "shadow_encryption",
  "encrypted_only",
] as const;

export const ENABLE_SHADOW_ENCRYPTION_CONFIRMATION =
  "Enable Shadow encryption; authorized readers may restore ordinary copies from protected content.";
export const ENABLE_FULL_ENCRYPTION_CONFIRMATION =
  "Enable Full encryption for new supported content. Existing plaintext is not erased. Unavailable protected content and unsupported operations are withheld. Custom Soul and authored Skills remain ordinary plaintext; these are the only Full encryption exceptions.";
export const DISABLE_SHADOW_ENCRYPTION_CONFIRMATION =
  "Return to Plaintext only; protected shadows remain stored.";
export const ENABLE_STRICT_SHADOW_CONFIRMATION =
  "Enable Strict Shadow; ordinary plaintext remains stored but cannot substitute at protected consumers.";
export const USE_FALLBACK_SHADOW_CONFIRMATION =
  "Use Fallback Shadow; protected failures remain visible while ordinary plaintext may substitute.";

export const liveShadowEncryptionTransitionModeSchema = z.enum(
  LIVE_SHADOW_ENCRYPTION_TRANSITION_MODES,
);
export const liveShadowEncryptionTransitionBehaviorSchema = z.enum([
  "fallback",
  "strict",
]);

export const strictShadowBoundaryStateSchema = z.enum([
  "verified",
  "waiting_for_authority",
  "repairing",
  "unsupported",
  "failed",
]);
export const strictShadowBoundaryReasonSchema = z.enum([
  "none",
  "device_membership_converging",
  "domain_authority_converging",
  "namespace_authority_converging",
  "missing_protected_sibling",
  "unsupported_operation",
  "device_not_enrolled",
  "device_stale",
  "device_removed",
  "recovery_required",
  "authority_unrecoverable",
  "integrity_failure",
  "parity_mismatch",
  "publication_failure",
  "deadline_expired",
  "stale_authority",
  "unknown_boundary",
  "unknown_result",
]);
export const strictShadowProtectedContentRequiredErrorSchema = z.object({
  error: z.literal("strict_shadow_protected_content_required"),
  state: strictShadowBoundaryStateSchema,
  reason: strictShadowBoundaryReasonSchema,
  retryable: z.boolean(),
}).strict();

const exactCountSchema = z.string().regex(/^(0|[1-9][0-9]*)$/u);
const percentageSchema = z.number().finite().min(0).max(100).nullable();
const ratioSchema = z.object({
  verified: exactCountSchema,
  eligible: exactCountSchema,
  percent: percentageSchema,
}).strict();
const coverageRatioSchema = z.object({
  verified: exactCountSchema,
  total: exactCountSchema,
  percent: percentageSchema,
}).strict();

export const encryptionTransitionOperationSchema = z.enum([
  "create",
  "update",
  "access_update",
  "read",
  "read_repair",
  "unsupported",
]);

export const encryptionTransitionAttemptOutcomeSchema = z.discriminatedUnion(
  "outcome",
  [
    z.object({
      operation: encryptionTransitionOperationSchema,
      outcome: z.literal("verified"),
      reason: z.literal("none"),
      count: exactCountSchema,
    }).strict(),
    z.object({
      operation: encryptionTransitionOperationSchema,
      outcome: z.literal("pending"),
      reason: z.literal("none"),
      count: exactCountSchema,
    }).strict(),
    z.object({
      operation: encryptionTransitionOperationSchema,
      outcome: z.literal("reconciling"),
      reason: z.literal("response_lost"),
      count: exactCountSchema,
    }).strict(),
    z.object({
      operation: encryptionTransitionOperationSchema,
      outcome: z.literal("unavailable"),
      reason: z.enum([
        "unmigrated",
        "unsupported_operation",
        "client_crypto_unavailable",
        "client_crypto_preparation_failed",
        "client_custody_unavailable",
        "current_read_authority_unavailable",
        "retained_key_material_unavailable",
        "signer_evidence_unavailable",
        "live_shadow_lifecycle_unavailable",
        "namespace_encryption_not_ready",
        "stale_authority_product",
        "client_observation_expired",
      ]),
      count: exactCountSchema,
    }).strict(),
    z.object({
      operation: encryptionTransitionOperationSchema,
      outcome: z.literal("failed"),
      reason: z.enum([
        "parity_mismatch",
        "integrity_failure",
        "publication_failure",
      ]),
      count: exactCountSchema,
    }).strict(),
  ],
);

export const encryptionTransitionFamilyMetricSchema = z.object({
  family: z.enum(["message", "memory", "artifact", "record", "overall"]),
  attemptSuccess: ratioSchema,
  touchedCoverage: coverageRatioSchema,
  storedCoverage: coverageRatioSchema,
  pendingLifecycle: z.object({
    operations: exactCountSchema,
    oldestPendingAt: z.string().datetime().nullable(),
  }).strict(),
  attemptOutcomes: z.array(encryptionTransitionAttemptOutcomeSchema).max(64),
}).strict();

export const liveShadowTurnStageSchema = z.enum([
  "browser_human_prepare",
  "server_human_open_parity",
  "human_durable_mapping",
  "agent_protected_input",
  "agent_stream_frame_chain",
  "browser_stream_frame_chain",
  "assistant_tool_call_boundary",
  "tool_result_boundary",
  "transcript_durable_mappings",
  "browser_durable_transcript_parity",
  "browser_terminal_acknowledgement",
]);

export const liveShadowEntityKindSchema = z.enum([
  "human_message",
  "final_agent_message",
  "tool_call",
  "tool_result",
]);

const liveShadowTurnTerminalStageSchema = z.enum([
  "plan",
  "session_establishment",
  "session_reuse",
  "human_admission",
  "agent_input",
  "assistant_stream",
  "assistant_message",
  "tool_call",
  "tool_result",
  "durable_transcript",
  "client_verification",
  "shutdown",
]);

const liveShadowTurnTerminalReasonSchema = z.enum([
  "device_unavailable",
  "agent_authority_unavailable",
  "domain_unavailable",
  "namespace_unavailable",
  "reservation_unavailable",
  "protected_unavailable",
  "stale_authority",
  "integrity_failure",
  "parity_mismatch",
  "deadline_expired",
  "recipient_lost",
  "cancelled",
  "product_conflict",
]);

export const liveShadowTurnMetricsSchema = z.object({
  scope: z.literal("live_new_browser_private_room_turns"),
  completeRoundTrip: ratioSchema,
  pending: z.object({
    turns: exactCountSchema,
    oldestPendingAt: z.string().datetime().nullable(),
  }).strict(),
  stages: z.array(z.object({
    stage: liveShadowTurnStageSchema,
    verified: exactCountSchema,
    eligible: exactCountSchema,
    percent: percentageSchema,
  }).strict()).length(11),
  entities: z.array(z.object({
    entity: liveShadowEntityKindSchema,
    verified: exactCountSchema,
    eligible: exactCountSchema,
    percent: percentageSchema,
  }).strict()).length(4),
  fallbacks: z.array(z.object({
    stage: liveShadowTurnTerminalStageSchema,
    reason: liveShadowTurnTerminalReasonSchema,
    count: exactCountSchema,
  }).strict()).max(80),
}).strict().superRefine((value, context) => {
  const expected = liveShadowTurnStageSchema.options;
  if (value.stages.some((stage, index) => stage.stage !== expected[index])) {
    context.addIssue({
      code: "custom",
      path: ["stages"],
      message: "live Shadow turn stages must be complete and ordered",
    });
  }
  const expectedEntities = liveShadowEntityKindSchema.options;
  if (value.entities.some((entity, index) =>
    entity.entity !== expectedEntities[index]
  )) {
    context.addIssue({
      code: "custom",
      path: ["entities"],
      message: "live Shadow entities must be complete and ordered",
    });
  }
});

export const encryptionTransitionStatusSchema = z.object({
  dtoVersion: z.literal(2),
  policy: z.object({
    mode: liveShadowEncryptionTransitionModeSchema,
    shadowBehavior: liveShadowEncryptionTransitionBehaviorSchema,
    revision: z.number().int().nonnegative(),
    shadowEncryptionStartedAt: z.string().datetime().nullable(),
    updatedAt: z.string().datetime(),
  }).strict(),
  coverageReadiness: z.object({
    registered: exactCountSchema,
    protected: exactCountSchema,
    unsupported: exactCountSchema,
    unexercised: exactCountSchema,
  }).strict(),
  runtimeHealth: z.object({
    policyRevision: z.number().int().nonnegative(),
    verified: exactCountSchema,
    waitingForAuthority: exactCountSchema,
    repairing: exactCountSchema,
    unsupported: exactCountSchema,
    failed: exactCountSchema,
    unexercised: exactCountSchema,
    lastObservedAt: z.string().datetime().nullable(),
    boundaries: z.array(z.object({
      boundaryId: z.string().min(1),
      family: z.string().min(1),
      operation: z.string().min(1),
      actorClass: z.enum([
        "human",
        "agent",
        "conductor",
        "tool",
        "background",
      ]),
      state: z.union([
        strictShadowBoundaryStateSchema,
        z.literal("unexercised"),
      ]),
      reason: z.string().min(1),
      occurrenceCount: exactCountSchema,
      lastObservedAt: z.string().datetime().nullable(),
    }).strict()),
  }).strict(),
  observationPressure: z.object({
    retainedRows: exactCountSchema,
    capacityRows: exactCountSchema,
    pendingAdmissions: exactCountSchema,
    admissionCapacity: exactCountSchema,
    maximumRetentionMs: z.number().int().positive(),
  }).strict(),
  domainKeyAuthority: z.object({
    scope: z.literal("domain_key_v2"),
    catchUp: z.object({
      requested: exactCountSchema,
      waiting: exactCountSchema,
      delivered: exactCountSchema,
      acknowledged: exactCountSchema,
      stale: exactCountSchema,
      expired: exactCountSchema,
      unrecoverable: exactCountSchema,
    }).strict(),
    authority: z.object({
      humanDomainHeads: exactCountSchema,
      aiDomainHeads: exactCountSchema,
      humanNamespaceBundles: exactCountSchema,
      aiNamespaceBundles: exactCountSchema,
      humanNamespaceBundleAdvances: exactCountSchema,
      aiNamespaceBundleAdvances: exactCountSchema,
    }).strict(),
  }).strict(),
  liveTurns: liveShadowTurnMetricsSchema,
  humanPeerLive: z.object({
    scope: z.literal("browser_human_only_live_messages"),
    writes: z.object({
      published: exactCountSchema,
      eligible: exactCountSchema,
      pending: exactCountSchema,
      fallback: exactCountSchema,
      failed: exactCountSchema,
      percent: percentageSchema,
    }).strict(),
    recipientReads: z.object({
      verified: exactCountSchema,
      attempted: exactCountSchema,
      fallback: exactCountSchema,
      percent: percentageSchema,
    }).strict(),
  }).strict(),
  sharedAgentLive: z.object({
    scope: z.literal("browser_multi_human_single_agent_live_messages"),
    writes: z.object({
      published: exactCountSchema,
      eligible: exactCountSchema,
      pending: exactCountSchema,
      fallback: exactCountSchema,
      failed: exactCountSchema,
      percent: percentageSchema,
    }).strict(),
    recipientReads: z.object({
      verified: exactCountSchema,
      attempted: exactCountSchema,
      fallback: exactCountSchema,
      percent: percentageSchema,
    }).strict(),
    recipientCoverage: z.object({
      totalHumans: exactCountSchema,
      protectedHumans: exactCountSchema,
      plaintextOnlyHumans: exactCountSchema,
      protectedDevices: exactCountSchema,
    }).strict(),
    planningFallbacks: z.object({
      unavailable: exactCountSchema,
      deviceUnavailable: exactCountSchema,
      namespaceUnavailable: exactCountSchema,
      recipientSyncRequired: exactCountSchema,
    }).strict(),
    agentRecipientReads: z.object({
      verified: exactCountSchema,
      attempted: exactCountSchema,
      fallback: exactCountSchema,
      percent: percentageSchema,
    }).strict(),
    conductor: z.object({
      awaitingUser: exactCountSchema,
      notSelected: exactCountSchema,
      selected: exactCountSchema,
      unavailable: exactCountSchema,
      eligible: exactCountSchema,
      awaitingAuthorization: exactCountSchema,
      authorizationEstablished: exactCountSchema,
      authorizationReused: exactCountSchema,
      currentInputVerified: exactCountSchema,
      deterministic: exactCountSchema,
      floorManager: exactCountSchema,
      historyNotRequested: exactCountSchema,
      historyVerified: exactCountSchema,
      historyUnavailable: exactCountSchema,
      verifiedWake: exactCountSchema,
      verifiedAwaitingUser: exactCountSchema,
      verifiedSilent: exactCountSchema,
      fallback: exactCountSchema,
      selectedAgentExecutions: exactCountSchema,
      fallbackReasons: z.array(z.object({
        reason: z.string().regex(/^conductor_fallback_[a-z0-9_]+$/u),
        count: exactCountSchema,
      }).strict()),
    }).strict(),
    executions: z.object({
      awaitingAuthorization: exactCountSchema,
      authorized: exactCountSchema,
      running: exactCountSchema,
      completed: exactCountSchema,
      fallback: exactCountSchema,
      failed: exactCountSchema,
      protectedInputs: exactCountSchema,
    }).strict(),
    resumes: z.object({
      attempted: exactCountSchema,
      awaitingAuthorization: exactCountSchema,
      authorized: exactCountSchema,
      running: exactCountSchema,
      completed: exactCountSchema,
      fallback: exactCountSchema,
      failed: exactCountSchema,
    }).strict(),
    authorization: z.object({
      established: exactCountSchema,
      reused: exactCountSchema,
      unavailable: exactCountSchema,
      expired: exactCountSchema,
      revoked: exactCountSchema,
    }).strict(),
    outputStages: z.object({
      streamStarted: exactCountSchema,
      streamCompleted: exactCountSchema,
      assistantPublished: exactCountSchema,
      toolResultsPublished: exactCountSchema,
    }).strict(),
  }).strict(),
  historyReads: z.object({
    scope: z.literal("browser_room_history_shadow_reads"),
    pagesAttempted: exactCountSchema,
    pagesPending: exactCountSchema,
    selected: exactCountSchema,
    verified: exactCountSchema,
    eligible: exactCountSchema,
    pending: exactCountSchema,
    unavailable: exactCountSchema,
    percent: percentageSchema,
    outcomes: z.array(encryptionTransitionAttemptOutcomeSchema).max(16),
  }).strict().superRefine((value, context) => {
    if (value.outcomes.some((outcome) => outcome.operation !== "read")) {
      context.addIssue({
        code: "custom",
        path: ["outcomes"],
        message: "history read outcomes must use the read operation",
      });
    }
  }),
  metrics: z.array(encryptionTransitionFamilyMetricSchema).length(5),
}).strict().superRefine((value, context) => {
  const expected = [
    "message", "memory", "artifact", "record", "overall",
  ] as const;
  if (value.metrics.some((metric, index) => metric.family !== expected[index])) {
    context.addIssue({
      code: "custom",
      path: ["metrics"],
      message: "metrics must contain message, memory, artifact, record, and overall in order",
    });
  }
});

export const encryptionTransitionUpdateRequestSchema = z.object({
  requestVersion: z.literal(2),
  expectedRevision: z.number().int().nonnegative(),
  targetMode: liveShadowEncryptionTransitionModeSchema,
  targetShadowBehavior: liveShadowEncryptionTransitionBehaviorSchema,
  confirmation: z.string(),
}).strict().superRefine((value, context) => {
  if (
    value.targetMode === "plaintext_only"
    && value.targetShadowBehavior !== "fallback"
  ) {
    context.addIssue({
      code: "custom",
      path: ["targetShadowBehavior"],
      message: "Plaintext-only mode requires fallback Shadow behavior",
    });
  }
  const expected = value.targetMode === "plaintext_only"
    ? DISABLE_SHADOW_ENCRYPTION_CONFIRMATION
    : value.targetMode === "encrypted_only"
    ? ENABLE_FULL_ENCRYPTION_CONFIRMATION
    : value.targetShadowBehavior === "strict"
    ? ENABLE_STRICT_SHADOW_CONFIRMATION
    : value.confirmation === ENABLE_SHADOW_ENCRYPTION_CONFIRMATION
    ? ENABLE_SHADOW_ENCRYPTION_CONFIRMATION
    : USE_FALLBACK_SHADOW_CONFIRMATION;
  if (value.confirmation !== expected) {
    context.addIssue({
      code: "custom",
      path: ["confirmation"],
      message: "confirmation does not match the selected transition",
    });
  }
});

export const encryptionTransitionPolicyStatusSchema = z.object({
  responseVersion: z.literal(1),
  policy: z.object({
    mode: liveShadowEncryptionTransitionModeSchema,
    shadowBehavior: liveShadowEncryptionTransitionBehaviorSchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  }).strict(),
  requiresCryptoDevice: z.boolean(),
  canManage: z.boolean(),
  coveragePreview: z.object({
    protected: exactCountSchema,
    unsupported: exactCountSchema,
    unexercised: exactCountSchema,
  }).strict(),
}).strict();

export type LiveShadowEncryptionTransitionMode = z.infer<
  typeof liveShadowEncryptionTransitionModeSchema
>;
export type LiveShadowEncryptionTransitionBehavior = z.infer<
  typeof liveShadowEncryptionTransitionBehaviorSchema
>;
export type StrictShadowBoundaryState = z.infer<
  typeof strictShadowBoundaryStateSchema
>;
export type StrictShadowBoundaryReason = z.infer<
  typeof strictShadowBoundaryReasonSchema
>;
export type StrictShadowProtectedContentRequiredErrorBody = z.infer<
  typeof strictShadowProtectedContentRequiredErrorSchema
>;
export type EncryptionTransitionAttemptOutcome = z.infer<
  typeof encryptionTransitionAttemptOutcomeSchema
>;
export type EncryptionTransitionFamilyMetric = z.infer<
  typeof encryptionTransitionFamilyMetricSchema
>;
export type LiveShadowTurnMetrics = z.infer<
  typeof liveShadowTurnMetricsSchema
>;
export type EncryptionTransitionStatus = z.infer<
  typeof encryptionTransitionStatusSchema
>;
export type EncryptionTransitionUpdateRequest = z.infer<
  typeof encryptionTransitionUpdateRequestSchema
>;
export type EncryptionTransitionPolicyStatus = z.infer<
  typeof encryptionTransitionPolicyStatusSchema
>;

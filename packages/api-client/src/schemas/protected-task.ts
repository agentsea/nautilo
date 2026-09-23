import {
  LATTICE_LIMITS,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";
import { z } from "zod";
import { SELECTION_PROFILES } from "@nautilo/types";
import type {
  TaskContentDetailV1,
  TaskContentListV1,
  TaskContentSummaryV1,
} from "@nautilo/types";

const portableId = z.string().min(1).max(LATTICE_LIMITS.idBytes)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u);
const canonicalLowerUuid = z.string().uuid().refine(
  (value) => value === value.toLowerCase(),
  { message: "UUID must use canonical lowercase form" },
);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveCounter = counter.min(1);
const utf8 = new TextEncoder();

function boundedUtf8String(
  label: string,
  maximumBytes: number,
  options: Readonly<{ allowEmpty: boolean }>,
) {
  return z.string().refine((value) =>
    (options.allowEmpty || utf8.encode(value).length > 0)
      && utf8.encode(value).length <= maximumBytes, {
    message: `${label} exceeds its UTF-8 byte bound`,
  });
}

const taskOperationalText = (label: string) => boundedUtf8String(
  label,
  LATTICE_LIMITS.plaintextBytes,
  { allowEmpty: false },
);
const taskOperationalId = (label: string) => boundedUtf8String(
  label,
  LATTICE_LIMITS.idBytes,
  { allowEmpty: false },
);

const selectionAxisSchema = z.enum(["privacy", "smart", "cheap"]);
const selectionSpecSchema = z.object({
  band: selectionAxisSchema.optional(),
  objective: selectionAxisSchema,
  absoluteFloors: z.object({
    privacy: z.number().optional(),
    intelligenceRank: z.number().optional(),
    maxCost: z.number().optional(),
  }).strict().optional(),
}).strict();

const taskOperationalFields = {
  scheduleKind: z.enum(["now", "one_shot", "cron"]).optional(),
  runAt: taskOperationalText("Task runAt").optional(),
  cron: taskOperationalText("Task cron").optional(),
  timezone: taskOperationalText("Task timezone").optional(),
  targetChat: z.enum(["orphan", "last_in_namespace", "new_in_namespace"]).optional(),
  tools: z.array(taskOperationalId("Task tool id"))
    .max(LATTICE_LIMITS.batchItems).optional(),
  resultDelivery: z.enum(["wake", "raw", "raw_and_wake"]).optional(),
  timeLimitSeconds: z.number().int().positive().nullable().optional(),
  selectionProfile: z.enum(SELECTION_PROFILES).optional(),
  selectionSpec: selectionSpecSchema.nullable().optional(),
  requestedModelId: taskOperationalId("Task requested model id").nullable().optional(),
};

function validateTaskOperationalWireBudget(
  value: object,
  context: z.RefinementCtx,
): void {
  if (utf8.encode(JSON.stringify(value)).length > LATTICE_LIMITS.plaintextBytes) {
    context.addIssue({
      code: "custom",
      message: "Task operational fields exceed the lattice plaintext byte bound",
    });
  }
}

export const taskOperationalCreateV1Schema = z.object({
  ...taskOperationalFields,
  useScope: z.boolean().optional(),
  scopeId: canonicalLowerUuid.optional().nullable(),
  parentTaskId: canonicalLowerUuid.optional().nullable(),
}).strict().superRefine(validateTaskOperationalWireBudget);

export const taskOperationalUpdateV1Schema = z.object(taskOperationalFields)
  .strict().superRefine(validateTaskOperationalWireBudget);

const protectedContentSchema = z.discriminatedUnion("status", [
  z.object({
    dtoVersion: z.literal(1),
    status: z.literal("protected"),
    objectId: portableId,
    contentRevision: positiveCounter,
    cryptoAccessRevision: counter,
  }).strict(),
  z.object({
    dtoVersion: z.literal(1),
    status: z.literal("unavailable"),
    reason: z.enum([
      "waiting_for_authorization", "device_not_ready", "authority_changed",
      "unsupported_client", "integrity_failure",
    ]),
  }).strict(),
]);

const taskPreparationSchema = z.object({
  stage: z.enum([
    "preparing_model", "waiting_model", "model_responding", "using_tools",
    "preparing_scanners", "scanner_started", "scanner_finished", "recording_evidence",
    "research_ready", "inventory_progress",
  ]),
  probe: z.enum(["gitleaks", "osv_scanner", "trivy", "semgrep"]).optional(),
  filesObserved: counter.optional(),
  directoriesObserved: counter.optional(),
  activity: z.enum([
    "reading_source", "searching_source", "mapping_repository", "loading_research",
    "saving_research", "checkpoint_saved", "review_saved", "hypothesis_saved",
    "evidence_saved", "finding_saved", "coverage_saved", "validating_report",
    "recovering_context",
  ]).optional(),
  contextRecovery: z.object({
    pendingInputs: counter,
    phase: z.enum(["inactive", "reading", "consolidation_required"]).optional(),
    recoveredInputBytes: counter.optional(),
    retainedUnconsolidatedPages: counter.optional(),
  }).strict().optional(),
  contextPage: z.object({ startByte: counter, endByte: counter, totalBytes: counter }).strict().optional(),
  research: z.object({
    unitsTotal: counter, unitsCompleted: counter, unitsPending: counter,
    filesTotal: counter, filesAssigned: counter,
  }).strict().optional(),
  researchWork: z.object({
    role: z.enum(["coordinator", "investigator", "reviewer"]),
    subject: z.string().optional(),
    reviewDecision: z.enum(["accepted", "follow_up"]).optional(),
  }).strict().optional(),
  taskRunId: portableId,
  updatedAt: z.string(),
}).strict();

const summaryLifecycleSchema = z.object({
  id: canonicalLowerUuid,
  parentTaskId: canonicalLowerUuid.nullable(),
  depth: counter,
  status: z.string(),
  preset: z.string(),
  harnessId: z.string().nullable().optional(),
  canResumeResearch: z.boolean().optional(),
  preparation: taskPreparationSchema.optional(),
  scheduleKind: z.string(),
  cron: z.string().nullable().optional(),
  nextFireAt: z.string().nullable(),
  callingRoomId: canonicalLowerUuid.nullable(),
  agentId: portableId.nullable().optional(),
  agentName: z.string().nullable().optional(),
  targetRoomId: canonicalLowerUuid.nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  lastModelId: z.string().nullable().optional(),
  requestedModelId: z.string().nullable().optional(),
});

const ordinarySummaryContentSchema = z.object({
  dtoVersion: z.literal(1), status: z.literal("ordinary"),
  promptPreview: z.string(), lastError: z.string().nullable(),
}).strict();

export const taskContentSummaryV1Schema: z.ZodType<TaskContentSummaryV1> =
  summaryLifecycleSchema.extend({
    content: z.union([ordinarySummaryContentSchema, protectedContentSchema]),
  }).strict().transform((value) => value as unknown as TaskContentSummaryV1);

export const taskContentListV1Schema: z.ZodType<TaskContentListV1> =
  z.array(taskContentSummaryV1Schema);

/** Protected transport projection: ordinary prompt previews are never valid. */
export const protectedTaskContentListV1Schema: z.ZodType<TaskContentListV1> =
  z.array(summaryLifecycleSchema.extend({ content: protectedContentSchema }).strict())
    .transform((value) => value as unknown as TaskContentListV1);

const ordinaryDefinitionSchema = z.object({
  dtoVersion: z.literal(1), status: z.literal("ordinary"),
  prompt: z.string(), expectedOutput: z.string().nullable(),
  lastError: z.string().nullable(),
}).strict();

const taskRunTranscriptSchema = z.object({
  role: z.string(), content: z.string(), toolName: z.string().nullable(),
  toolCalls: z.array(z.object({
    name: z.string(), args: z.record(z.string(), z.unknown()), id: z.string().nullable(),
  }).strict()).nullable(),
  toolCallId: z.string().optional(),
  toolStatus: z.enum(["success", "error"]).optional(),
  createdAt: z.string(),
}).strict();

const taskRunSchema = z.object({
  id: canonicalLowerUuid,
  status: z.string(),
  modelId: z.string().nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  content: z.union([
    z.object({
      dtoVersion: z.literal(1), status: z.literal("ordinary"),
      resultText: z.string().nullable(), lastError: z.string().nullable(),
      transcript: z.array(taskRunTranscriptSchema),
    }).strict(),
    z.object({
      dtoVersion: z.literal(1), status: z.literal("unavailable"),
      reason: z.enum([
        "waiting_for_authorization", "device_not_ready", "authority_changed",
        "unsupported_client", "integrity_failure",
      ]),
    }).strict(),
  ]),
}).strict();

export const taskContentDetailV1Schema: z.ZodType<TaskContentDetailV1> = z.object({
  task: summaryLifecycleSchema.extend({
    cron: z.string().nullable(),
    runAt: z.string().nullable(),
    timezone: z.string(),
    targetChat: z.string(),
    resultDelivery: z.string(),
    useScope: z.boolean(),
    scopeId: canonicalLowerUuid.nullable(),
    toolsMode: z.string(),
    toolsWhitelist: z.array(z.string()),
    selectionProfile: z.enum(SELECTION_PROFILES),
    selectionSpec: selectionSpecSchema.nullable(),
    requestedModelId: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }).strict(),
  definition: z.union([ordinaryDefinitionSchema, protectedContentSchema]),
  runs: z.array(taskRunSchema),
}).strict().transform((value) => value as unknown as TaskContentDetailV1);

const digestBase64url = z.string().length(43).regex(/^[A-Za-z0-9_-]+$/u);

function unpaddedBase64url(maxBytes: number, label: string) {
  return z.string().min(1).max(Math.ceil(maxBytes * 4 / 3))
    .regex(/^[A-Za-z0-9_-]+$/u)
    .refine((value) => value.length % 4 !== 1, {
      message: `${label} must be unpadded base64url`,
    });
}

const encryptedPayloadBase64url = unpaddedBase64url(
  LATTICE_LIMITS.ciphertextBytes,
  "encrypted Task payload",
);
const accessManifestBase64url = unpaddedBase64url(
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  "Task access manifest",
);
const namespaceEnvelopeBase64url = unpaddedBase64url(
  LATTICE_LIMITS.ciphertextBytes,
  "Task Namespace envelope",
);
const signedPublicationRequestBase64url = unpaddedBase64url(
  LATTICE_LIMITS.plaintextBytes,
  "signed Task publication request",
);
const ordinaryPayloadBase64url = unpaddedBase64url(
  LATTICE_LIMITS.plaintextBytes,
  "ordinary Task payload",
);

const exactTaskNamespaceIdsSchema = z.tuple([canonicalLowerUuid]);
const exactTaskNamespaceEnvelopesSchema = z.tuple([z.object({
  namespaceId: canonicalLowerUuid,
  envelopeBytesBase64url: namespaceEnvelopeBase64url,
}).strict()]);

const protectedTaskPreparedPublicationBaseV1Schema = z.object({
  requestVersion: z.literal(1),
  operationId: portableId,
  planDigestBase64url: digestBase64url,
  taskId: canonicalLowerUuid,
  expectedContentRevision: counter,
  nextContentRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  resultCryptoAccessRevision: z.literal(0),
  cryptoObjectId: portableId,
  payloadVersion: z.literal(1),
  requiredNamespaceIds: exactTaskNamespaceIdsSchema,
  encryptedPayloadBytesBase64url: encryptedPayloadBase64url,
  accessManifestBytesBase64url: accessManifestBase64url,
  namespaceEnvelopes: exactTaskNamespaceEnvelopesSchema,
  signedPublicationRequestBytesBase64url: signedPublicationRequestBase64url,
}).strict();

function validateExactTaskNamespace(
  value: Readonly<{
    requiredNamespaceIds: readonly [string];
    namespaceEnvelopes: readonly [Readonly<{ namespaceId: string }>];
  }>,
  context: z.RefinementCtx,
): void {
  if (value.namespaceEnvelopes[0].namespaceId !== value.requiredNamespaceIds[0]) {
    context.addIssue({
      code: "custom",
      message: "prepared Task envelope must match its exact content Namespace",
      path: ["namespaceEnvelopes"],
    });
  }
}

const protectedTaskPreparedCreateRequestFieldsV1Schema =
  protectedTaskPreparedPublicationBaseV1Schema.extend({
    task: taskOperationalCreateV1Schema,
    operation: z.literal("create"),
    expectedContentRevision: z.literal(0),
    nextContentRevision: z.literal(1),
    expectedCryptoAccessRevision: z.literal(0),
  }).strict();

export const protectedTaskPreparedCreateRequestV1Schema =
  protectedTaskPreparedCreateRequestFieldsV1Schema
    .superRefine(validateExactTaskNamespace);

const protectedTaskPreparedUpdateRequestFieldsV1Schema =
  protectedTaskPreparedPublicationBaseV1Schema.extend({
    task: taskOperationalUpdateV1Schema,
    operation: z.literal("update"),
    expectedContentRevision: positiveCounter,
    nextContentRevision: positiveCounter,
  }).strict();

function validateTaskUpdateRevision(
  value: Readonly<{ expectedContentRevision: number; nextContentRevision: number }>,
  context: z.RefinementCtx,
): void {
  if (value.nextContentRevision !== value.expectedContentRevision + 1) {
    context.addIssue({
      code: "custom",
      message: "protected Task update revision must advance exactly once",
      path: ["nextContentRevision"],
    });
  }
}

export const protectedTaskPreparedUpdateRequestV1Schema =
  protectedTaskPreparedUpdateRequestFieldsV1Schema.superRefine((value, context) => {
    validateExactTaskNamespace(value, context);
    validateTaskUpdateRevision(value, context);
  });

export const dualTaskPreparedCreateRequestV1Schema =
  protectedTaskPreparedCreateRequestFieldsV1Schema.extend({
    representation: z.literal("dual"),
    ordinaryPayloadBytesBase64url: ordinaryPayloadBase64url,
  }).strict().superRefine(validateExactTaskNamespace);

export const dualTaskPreparedUpdateRequestV1Schema =
  protectedTaskPreparedUpdateRequestFieldsV1Schema.extend({
    representation: z.literal("dual"),
    ordinaryPayloadBytesBase64url: ordinaryPayloadBase64url,
  }).strict().superRefine((value, context) => {
    validateExactTaskNamespace(value, context);
    validateTaskUpdateRevision(value, context);
  });

export const protectedTaskPreparedPublicationRequestV1Schema =
  z.discriminatedUnion("operation", [
    protectedTaskPreparedCreateRequestV1Schema,
    protectedTaskPreparedUpdateRequestV1Schema,
  ]);

export const protectedTaskPublicationPlanRequestV1Schema = z.discriminatedUnion(
  "operation",
  [
    z.object({
      requestVersion: z.literal(1),
      operation: z.literal("create"),
      operationId: portableId,
      task: taskOperationalCreateV1Schema,
    }).strict(),
    z.object({
      requestVersion: z.literal(1),
      operation: z.literal("update"),
      operationId: portableId,
      task: taskOperationalUpdateV1Schema,
    }).strict(),
  ],
);

export const protectedTaskPublicationPlanV1Schema = z.object({
  planVersion: z.literal(1),
  operation: z.enum(["create", "update"]),
  operationId: portableId,
  taskId: canonicalLowerUuid,
  expectedContentRevision: counter,
  nextContentRevision: positiveCounter,
  expectedCryptoAccessRevision: counter,
  planDigestBase64url: digestBase64url,
  authority: z.object({
    requesterHumanId: canonicalLowerUuid,
    sourceRoomId: canonicalLowerUuid,
    namespaceId: canonicalLowerUuid,
    domainId: portableId,
    expectedAccessRevision: counter,
    expectedPolicyRevision: positiveCounter,
    bindingHashBase64url: digestBase64url,
    keyGeneration: counter,
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.nextContentRevision !== value.expectedContentRevision + 1) {
    context.addIssue({
      code: "custom",
      message: "protected Task publication plan must advance exactly once",
      path: ["nextContentRevision"],
    });
  }
  if (value.operation === "create" && (
    value.expectedContentRevision !== 0
    || value.expectedCryptoAccessRevision !== 0
  )) {
    context.addIssue({
      code: "custom",
      message: "protected Task create plan must begin at revision zero",
      path: ["expectedContentRevision"],
    });
  }
});

const taskAccessSignerEvidenceV1Schema = z.union([
  z.object({
    kind: z.enum(["agent_runtime_publication", "processor_authorization"]),
    evidenceBytesBase64url: encryptedPayloadBase64url,
  }).strict(),
  z.object({
    kind: z.literal("human_device"),
    subjectHumanId: canonicalLowerUuid,
    committerDeviceId: portableId,
    hostAuthorizationRevision: counter,
    signingPublicKeyBase64url: digestBase64url,
  }).strict(),
  z.object({
    kind: z.literal("evidence_issuer_human_device"),
    subjectHumanId: canonicalLowerUuid,
    deviceId: portableId,
    hostAuthorizationRevision: counter,
    signingPublicKeyBase64url: digestBase64url,
  }).strict(),
  z.object({
    kind: z.literal("foreground_agent_accepted_execution"),
    planBytesBase64url: encryptedPayloadBase64url,
    planDigestBase64url: digestBase64url,
  }).strict(),
]);

/**
 * Exact protected definition bytes. Signer evidence is verification material,
 * not a trust assertion: clients must authenticate it against their trusted
 * device/evidence history before opening the ciphertext.
 */
const protectedTaskDefinitionReadReferenceV1Fields = {
  readVersion: z.literal(1),
  taskId: canonicalLowerUuid,
  objectId: portableId,
  contentRevision: positiveCounter,
  cryptoAccessRevision: counter,
};

const protectedTaskDefinitionReadReadyEnvelopeV1Schema = z.object({
  ...protectedTaskDefinitionReadReferenceV1Fields,
  status: z.literal("ready"),
  cryptoAccessRevision: z.literal(0),
  namespaceId: canonicalLowerUuid,
  encryptedPayloadBytesBase64url: encryptedPayloadBase64url,
  accessManifestBytesBase64url: accessManifestBase64url,
  accessManifestProofBytesBase64url: z.tuple([]),
  namespaceEnvelopeBytesBase64url: namespaceEnvelopeBase64url,
  signerEvidence: z.array(taskAccessSignerEvidenceV1Schema).superRefine((entries, context) => {
    const keys = entries.map((entry) => entry.kind === "human_device"
      ? `${entry.kind}:${entry.subjectHumanId}:${entry.committerDeviceId}:${entry.hostAuthorizationRevision}`
      : entry.kind === "evidence_issuer_human_device"
      ? `${entry.kind}:${entry.subjectHumanId}:${entry.deviceId}:${entry.hostAuthorizationRevision}`
      : entry.kind === "foreground_agent_accepted_execution"
      ? `${entry.kind}:${entry.planDigestBase64url}`
      : `${entry.kind}:${entry.evidenceBytesBase64url}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Task access signer evidence must be unique",
      });
    }
    const encodedBytes = entries.reduce((total, entry) => total + (
      entry.kind === "human_device" || entry.kind === "evidence_issuer_human_device"
        ? entry.signingPublicKeyBase64url.length
        : entry.kind === "foreground_agent_accepted_execution"
        ? entry.planBytesBase64url.length + entry.planDigestBase64url.length
        : entry.evidenceBytesBase64url.length
    ), 0);
    if (encodedBytes > 1_398_102) {
      context.addIssue({
        code: "custom",
        message: "Task access signer evidence exceeds the profile ceiling",
      });
    }
  }),
}).strict();

const protectedTaskDefinitionReadUnavailableEnvelopeV1Schema = z.object({
  ...protectedTaskDefinitionReadReferenceV1Fields,
  status: z.literal("unavailable"),
  reason: z.literal("unsupported_crypto_access_revision"),
}).strict();

export const protectedTaskDefinitionReadEnvelopeV1Schema = z.discriminatedUnion(
  "status",
  [
    protectedTaskDefinitionReadReadyEnvelopeV1Schema,
    protectedTaskDefinitionReadUnavailableEnvelopeV1Schema,
  ],
);

export type ProtectedTaskPreparedCreateRequestV1 = z.infer<
  typeof protectedTaskPreparedCreateRequestV1Schema
>;
export type ProtectedTaskPreparedUpdateRequestV1 = z.infer<
  typeof protectedTaskPreparedUpdateRequestV1Schema
>;
export type DualTaskPreparedCreateRequestV1 = z.infer<
  typeof dualTaskPreparedCreateRequestV1Schema
>;
export type DualTaskPreparedUpdateRequestV1 = z.infer<
  typeof dualTaskPreparedUpdateRequestV1Schema
>;
export type ProtectedTaskPreparedPublicationRequestV1 = z.infer<
  typeof protectedTaskPreparedPublicationRequestV1Schema
>;
export type ProtectedTaskPublicationPlanRequestV1 = z.infer<
  typeof protectedTaskPublicationPlanRequestV1Schema
>;
export type ProtectedTaskPublicationPlanV1 = z.infer<
  typeof protectedTaskPublicationPlanV1Schema
>;
export type ProtectedTaskDefinitionReadEnvelopeV1 = z.infer<
  typeof protectedTaskDefinitionReadEnvelopeV1Schema
>;
export type ProtectedTaskDefinitionReadReadyEnvelopeV1 = z.infer<
  typeof protectedTaskDefinitionReadReadyEnvelopeV1Schema
>;

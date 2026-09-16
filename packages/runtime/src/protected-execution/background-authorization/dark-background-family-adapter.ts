import { createHash } from "node:crypto";

import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES,
  BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequest,
  markBackgroundAuthorizationRunning,
  parseBackgroundAuthorizationRequestSnapshot,
  type BackgroundAuthorizationAgentSubject,
  type BackgroundAuthorizationRequestSnapshot,
} from "./lifecycle";
import type {
  BackgroundAuthorizationPurpose,
  BackgroundAuthorizationWorkKind,
} from "./repository";

export const DARK_BACKGROUND_MAX_SYNTHETIC_PAYLOAD_BYTES = 16 * 1024;
export const DARK_BACKGROUND_MAX_SYNTHETIC_CIPHERTEXT_BYTES = 32 * 1024;
export const DARK_BACKGROUND_DEFAULT_PENDING_DELAY_MS = 30_000;
export const DARK_BACKGROUND_MAX_PENDING_DELAY_MS = 5 * 60_000;

export type DarkBackgroundDeferredOwningWave =
  | "wave12_memory"
  | "wave14_agent_task_job_content";

export type DarkBackgroundSyntheticEntrypointId =
  | "memory.review.main"
  | "memory.review.fork"
  | "memory.exit_flush"
  | "task.dispatch.now"
  | "task.dispatch.one_shot"
  | "task.dispatch.recurring"
  | "task.dispatch.async"
  | "task.dispatch.retry"
  | "task.execute"
  | "task.resume.unpause"
  | "task.resume.approval";

export type DarkBackgroundInventoryOnlyEntrypointId =
  | "task.resume.await_reply"
  | "job.background.generic"
  | "job.background.deep_research";

export type DarkBackgroundEntrypointInventory =
  | Readonly<{
    readonly entrypointId:
      | "memory.review.main"
      | "memory.review.fork"
      | "memory.exit_flush";
    readonly adapterStatus: "protected_adapter";
    readonly sourcePath: string;
    readonly sourceAnchor: string;
    readonly productionCaller: "present" | "absent";
    readonly actorClassification: "configured_agent";
    readonly subjectKind: "agent";
    readonly workKind: "memory.review" | "memory.exit_flush";
    readonly purpose: "memory.review" | "memory.exit_flush";
    readonly deferredOwningWave: "wave12_memory";
  }>
  | Readonly<{
    readonly entrypointId: DarkBackgroundSyntheticEntrypointId;
    readonly adapterStatus: "synthetic_adapter";
    readonly sourcePath: string;
    readonly sourceAnchor: string;
    readonly productionCaller: "present" | "absent";
    readonly actorClassification: "configured_agent";
    readonly subjectKind: "agent";
    readonly workKind: BackgroundAuthorizationWorkKind;
    readonly purpose: BackgroundAuthorizationPurpose;
    readonly deferredOwningWave: DarkBackgroundDeferredOwningWave;
  }>
  | Readonly<{
    readonly entrypointId: DarkBackgroundInventoryOnlyEntrypointId;
    readonly adapterStatus: "inventory_only";
    readonly sourcePath: string;
    readonly sourceAnchor: string;
    readonly productionCaller: "present";
    readonly actorClassification:
      | "configured_agent_protocol_gap"
      | "unresolved_actor";
    readonly subjectKind: "agent" | null;
    readonly workKind: null;
    readonly purpose: null;
    readonly deferredOwningWave: "wave14_agent_task_job_content";
  }>;

/**
 * Grounded Wave 10 inventory. These are synthetic adapters, not production
 * wiring. In particular, the Memory helpers run on behalf of the configured
 * Agent that completed the turn; they are not neutral processors.
 *
 * Two real gaps remain intentionally unadapted:
 * - await-reply resume has no distinct closed work-kind in the v1 protocol;
 * - generic/deep-research Jobs do not durably carry a configured Agent
 *   identity, so assigning either an Agent grant or a processor credential
 *   here would invent authority.
 */
export const DARK_BACKGROUND_ENTRYPOINT_INVENTORY = Object.freeze([
  {
    entrypointId: "memory.review.main",
    adapterStatus: "protected_adapter",
    sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background-entrypoints.ts",
    sourceAnchor: "export function enqueueProtectedAgentMemoryBackgroundEntrypoint",
    productionCaller: "absent",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "memory.review",
    purpose: "memory.review",
    deferredOwningWave: "wave12_memory",
  },
  {
    entrypointId: "memory.review.fork",
    adapterStatus: "protected_adapter",
    sourcePath: "packages/runtime/src/protected-execution/background-authorization/protected-agent-memory-background-entrypoints.ts",
    sourceAnchor: "export function enqueueProtectedAgentMemoryBackgroundEntrypoint",
    productionCaller: "absent",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "memory.review",
    purpose: "memory.review",
    deferredOwningWave: "wave12_memory",
  },
  {
    entrypointId: "memory.exit_flush",
    adapterStatus: "protected_adapter",
    sourcePath: "packages/agent/src/memory/exit-flush.ts",
    sourceAnchor: "export async function runExitFlush",
    productionCaller: "absent",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "memory.exit_flush",
    purpose: "memory.exit_flush",
    deferredOwningWave: "wave12_memory",
  },
  {
    entrypointId: "task.dispatch.now",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/task-observer.ts",
    sourceAnchor: "await dispatchTaskRun(task",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.dispatch",
    purpose: "task.dispatch",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.dispatch.one_shot",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/task-observer.ts",
    sourceAnchor: "await dispatchTaskRun(task",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.dispatch",
    purpose: "task.dispatch",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.dispatch.recurring",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/task-observer.ts",
    sourceAnchor: "await dispatchTaskRun(task",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.dispatch",
    purpose: "task.dispatch",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.dispatch.async",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/dispatch-task-run.ts",
    sourceAnchor: "export async function dispatchTaskRun",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.dispatch",
    purpose: "task.dispatch",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.dispatch.retry",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/task-observer.ts",
    sourceAnchor: "released claim for retry",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.dispatch",
    purpose: "task.dispatch",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.execute",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/task-run-executor.ts",
    sourceAnchor: "export const taskRunExecutor",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.execute",
    purpose: "task.execute",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.resume.unpause",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/dispatch-task-run.ts",
    sourceAnchor: "const isResume = resumableRun !== undefined",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.dispatch",
    purpose: "task.dispatch",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.resume.approval",
    adapterStatus: "synthetic_adapter",
    sourcePath: "packages/runtime/src/tasks/resume-task-approval.ts",
    sourceAnchor: "export async function runTaskApprovalResume",
    productionCaller: "present",
    actorClassification: "configured_agent",
    subjectKind: "agent",
    workKind: "task.approval_resume",
    purpose: "task.approval_resume",
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "task.resume.await_reply",
    adapterStatus: "inventory_only",
    sourcePath: "packages/server/src/messaging/await-resume.ts",
    sourceAnchor: "export async function maybeResumeAwaitingTask",
    productionCaller: "present",
    actorClassification: "configured_agent_protocol_gap",
    subjectKind: "agent",
    workKind: null,
    purpose: null,
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "job.background.generic",
    adapterStatus: "inventory_only",
    sourcePath: "packages/runtime/src/job-manager.ts",
    sourceAnchor: "async createBackgroundJob(",
    productionCaller: "present",
    actorClassification: "unresolved_actor",
    subjectKind: null,
    workKind: null,
    purpose: null,
    deferredOwningWave: "wave14_agent_task_job_content",
  },
  {
    entrypointId: "job.background.deep_research",
    adapterStatus: "inventory_only",
    sourcePath: "packages/runtime/src/executors/deep-research-executor.ts",
    sourceAnchor: "export async function* deepResearchExecutor",
    productionCaller: "present",
    actorClassification: "unresolved_actor",
    subjectKind: null,
    workKind: null,
    purpose: null,
    deferredOwningWave: "wave14_agent_task_job_content",
  },
] as const satisfies readonly DarkBackgroundEntrypointInventory[]);

type SyntheticDefinition = Extract<
  (typeof DARK_BACKGROUND_ENTRYPOINT_INVENTORY)[number],
  { readonly adapterStatus: "synthetic_adapter" }
>;

const SYNTHETIC_DEFINITIONS = new Map<
  DarkBackgroundSyntheticEntrypointId,
  SyntheticDefinition
>(
  DARK_BACKGROUND_ENTRYPOINT_INVENTORY
    .filter(
      (entrypoint): entrypoint is SyntheticDefinition =>
        entrypoint.adapterStatus === "synthetic_adapter",
    )
    .map((entrypoint) => [entrypoint.entrypointId, entrypoint]),
);

export type DarkBackgroundSyntheticSource = Readonly<{
  readonly kind: "synthetic_payload";
  readonly payloadId: string;
  readonly generation: number;
  /** Canonical lowercase SHA-256 hex. */
  readonly fingerprint: string;
}>;

export type DarkBackgroundSyntheticDescriptor = Readonly<{
  readonly formatVersion: 1;
  readonly entrypointId: DarkBackgroundSyntheticEntrypointId;
  readonly workKind: BackgroundAuthorizationWorkKind;
  readonly purpose: BackgroundAuthorizationPurpose;
  readonly workId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly subject: BackgroundAuthorizationAgentSubject;
  readonly operations: readonly ["decrypt"];
  readonly source: DarkBackgroundSyntheticSource;
  readonly bounds: Readonly<{
    readonly maximumInputObjectCount: 1;
    readonly maximumOutputObjectCount: 0;
    readonly maximumPlaintextBytes: number;
    readonly maximumCiphertextBytes: number;
  }>;
  readonly expectedDomainEpoch: number;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly deferredOwningWave: DarkBackgroundDeferredOwningWave;
}>;

export type DarkBackgroundSyntheticPlan = Readonly<{
  readonly formatVersion: 1;
  readonly descriptor: DarkBackgroundSyntheticDescriptor;
  readonly descriptorDigest: string;
  readonly request: BackgroundAuthorizationRequestSnapshot;
}>;

export type PlanDarkBackgroundSyntheticWorkInput = Readonly<{
  readonly entrypointId: DarkBackgroundSyntheticEntrypointId;
  readonly requestId: string;
  readonly workId: string;
  readonly namespaceId: string;
  readonly domainId: string;
  readonly syntheticPayloadId: string;
  readonly syntheticPayloadGeneration: number;
  readonly syntheticPayloadFingerprint: Uint8Array;
  readonly maximumPlaintextBytes: number;
  readonly maximumCiphertextBytes: number;
  readonly expectedDomainEpoch: number;
  readonly expectedNamespaceAccessRevision: number;
  readonly expectedPolicyRevision: number;
  readonly subject: BackgroundAuthorizationAgentSubject;
  readonly now: number;
}>;

const PLAN_INPUT_FIELDS = new Set([
  "domainId",
  "entrypointId",
  "expectedDomainEpoch",
  "expectedNamespaceAccessRevision",
  "expectedPolicyRevision",
  "maximumCiphertextBytes",
  "maximumPlaintextBytes",
  "namespaceId",
  "now",
  "requestId",
  "subject",
  "syntheticPayloadFingerprint",
  "syntheticPayloadGeneration",
  "syntheticPayloadId",
  "workId",
]);
const SUBJECT_FIELDS = new Set([
  "agentId",
  "authorizationRevision",
  "kind",
  "runtimeGeneration",
]);
const AGENT_CREDENTIAL_FIELDS = new Set([
  "agentId",
  "authorizationRevision",
  "descriptorDigest",
  "expiresAt",
  "family",
  "namespaceId",
  "requestId",
  "runtimeGeneration",
  "workId",
]);
const PROCESSOR_CREDENTIAL_FIELDS = new Set([
  "authorizationRevision",
  "descriptorDigest",
  "expiresAt",
  "family",
  "namespaceId",
  "processorKind",
  "processorVersion",
  "requestId",
  "workId",
]);
const RUN_INPUT_FIELDS = new Set([
  "claimExpiresAt",
  "claimId",
  "execute",
  "now",
  "plan",
  "readSyntheticPayload",
  "resolveAuthority",
]);
const AUTHORITY_READY_FIELDS = new Set([
  "credential",
  "snapshot",
  "status",
]);
const AUTHORITY_UNAVAILABLE_FIELDS = new Set([
  "reason",
  "status",
]);
const AUTHORITY_UNAVAILABLE_RETRY_FIELDS = new Set([
  "reason",
  "retryAfterMs",
  "status",
]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;
const textEncoder = new TextEncoder();
const issuedSyntheticPlans = new WeakSet<object>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): boolean {
  const keys = Object.keys(value);
  return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function requireExactFields(
  label: string,
  value: unknown,
  fields: ReadonlySet<string>,
): asserts value is Record<string, unknown> {
  if (!isRecord(value) || !hasExactFields(value, fields)) {
    throw new TypeError(`${label} has an invalid field set`);
  }
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && IDENTIFIER_PATTERN.test(value)
    && textEncoder.encode(value).length <=
      BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES;
}

function requireIdentifier(label: string, value: unknown): asserts value is string {
  if (!validIdentifier(value)) throw new TypeError(`${label} is invalid`);
}

function validCounter(value: unknown): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= 0
    && Number(value) <= Number.MAX_SAFE_INTEGER;
}

function validTimestamp(value: unknown): value is number {
  return validCounter(value)
    && Number(value) <= BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS;
}

function normalizeSubject(value: unknown): BackgroundAuthorizationAgentSubject {
  requireExactFields("Dark background Agent subject", value, SUBJECT_FIELDS);
  if (
    value["kind"] !== "agent"
    || !validIdentifier(value["agentId"])
    || !validCounter(value["runtimeGeneration"])
    || !validCounter(value["authorizationRevision"])
  ) {
    throw new TypeError("Dark background Agent subject is invalid");
  }
  return Object.freeze({
    kind: "agent",
    agentId: value["agentId"],
    runtimeGeneration: value["runtimeGeneration"],
    authorizationRevision: value["authorizationRevision"],
  });
}

function normalizeDigest(label: string, value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function sameSubject(
  left: BackgroundAuthorizationAgentSubject,
  right: BackgroundAuthorizationAgentSubject,
): boolean {
  return left.agentId === right.agentId
    && left.runtimeGeneration === right.runtimeGeneration
    && left.authorizationRevision === right.authorizationRevision;
}

/**
 * Create a content-free synthetic descriptor and the initial shared lifecycle
 * snapshot. The exact-field check deliberately rejects foreground
 * sessions/handles and all other ambient capabilities.
 */
export function planDarkBackgroundSyntheticWork(
  input: PlanDarkBackgroundSyntheticWorkInput,
): DarkBackgroundSyntheticPlan {
  requireExactFields("Dark background planning input", input, PLAN_INPUT_FIELDS);
  const definition = SYNTHETIC_DEFINITIONS.get(input.entrypointId);
  if (definition === undefined) {
    throw new TypeError(
      "Dark background entrypoint does not have a Wave 10 synthetic adapter",
    );
  }
  requireIdentifier("Dark background request id", input.requestId);
  requireIdentifier("Dark background work id", input.workId);
  requireIdentifier("Dark background Namespace id", input.namespaceId);
  requireIdentifier("Dark background Domain id", input.domainId);
  requireIdentifier(
    "Dark background synthetic payload id",
    input.syntheticPayloadId,
  );
  if (!validCounter(input.syntheticPayloadGeneration)) {
    throw new TypeError("Dark background synthetic payload generation is invalid");
  }
  if (
    !(input.syntheticPayloadFingerprint instanceof Uint8Array)
    || input.syntheticPayloadFingerprint.length !== 32
  ) {
    throw new TypeError(
      "Dark background synthetic payload fingerprint must be 32 bytes",
    );
  }
  if (
    !Number.isSafeInteger(input.maximumPlaintextBytes)
    || input.maximumPlaintextBytes < 1
    || input.maximumPlaintextBytes >
      DARK_BACKGROUND_MAX_SYNTHETIC_PAYLOAD_BYTES
  ) {
    throw new RangeError("Dark background plaintext byte bound is invalid");
  }
  if (
    !Number.isSafeInteger(input.maximumCiphertextBytes)
    || input.maximumCiphertextBytes < 1
    || input.maximumCiphertextBytes >
      DARK_BACKGROUND_MAX_SYNTHETIC_CIPHERTEXT_BYTES
  ) {
    throw new RangeError("Dark background ciphertext byte bound is invalid");
  }
  if (
    !validCounter(input.expectedDomainEpoch)
    || !validCounter(input.expectedNamespaceAccessRevision)
    || !validCounter(input.expectedPolicyRevision)
    || !validTimestamp(input.now)
  ) {
    throw new TypeError("Dark background authority coordinates are invalid");
  }
  const subject = normalizeSubject(input.subject);
  const descriptor: DarkBackgroundSyntheticDescriptor = Object.freeze({
    formatVersion: 1,
    entrypointId: definition.entrypointId,
    workKind: definition.workKind,
    purpose: definition.purpose,
    workId: input.workId,
    namespaceId: input.namespaceId,
    domainId: input.domainId,
    subject,
    operations: Object.freeze(["decrypt"] as const),
    source: Object.freeze({
      kind: "synthetic_payload",
      payloadId: input.syntheticPayloadId,
      generation: input.syntheticPayloadGeneration,
      fingerprint: Buffer.from(input.syntheticPayloadFingerprint).toString(
        "hex",
      ),
    }),
    bounds: Object.freeze({
      maximumInputObjectCount: 1,
      maximumOutputObjectCount: 0,
      maximumPlaintextBytes: input.maximumPlaintextBytes,
      maximumCiphertextBytes: input.maximumCiphertextBytes,
    }),
    expectedDomainEpoch: input.expectedDomainEpoch,
    expectedNamespaceAccessRevision:
      input.expectedNamespaceAccessRevision,
    expectedPolicyRevision: input.expectedPolicyRevision,
    deferredOwningWave: definition.deferredOwningWave,
  });
  const descriptorDigest = createHash("sha256")
    .update(JSON.stringify(descriptor))
    .digest("hex");
  const request = createBackgroundAuthorizationRequest({
    requestId: input.requestId,
    workId: input.workId,
    namespaceId: input.namespaceId,
    credentialSubject: subject,
    now: input.now,
  });
  const plan = Object.freeze({
    formatVersion: 1,
    descriptor,
    descriptorDigest,
    request,
  });
  issuedSyntheticPlans.add(plan);
  return plan;
}

export type DarkBackgroundSyntheticAgentCredential = Readonly<{
  readonly family: "agent";
  readonly requestId: string;
  readonly workId: string;
  readonly namespaceId: string;
  readonly descriptorDigest: string;
  readonly agentId: string;
  readonly runtimeGeneration: number;
  readonly authorizationRevision: number;
  readonly expiresAt: number;
}>;

export type DarkBackgroundSyntheticProcessorCredential = Readonly<{
  readonly family: "processor";
  readonly requestId: string;
  readonly workId: string;
  readonly namespaceId: string;
  readonly descriptorDigest: string;
  readonly processorKind: "stenographer";
  readonly processorVersion: 1;
  readonly authorizationRevision: number;
  readonly expiresAt: number;
}>;

export type DarkBackgroundSyntheticCredential =
  | DarkBackgroundSyntheticAgentCredential
  | DarkBackgroundSyntheticProcessorCredential;

export type DarkBackgroundAuthorityUnavailableReason =
  | "no_eligible_device"
  | "device_offline"
  | "authority_not_current"
  | "recipient_unavailable";

export type DarkBackgroundSyntheticAuthorityResult =
  | Readonly<{
    readonly status: "unavailable";
    readonly reason: DarkBackgroundAuthorityUnavailableReason;
    readonly retryAfterMs?: number;
  }>
  | Readonly<{
    readonly status: "ready";
    readonly snapshot: BackgroundAuthorizationRequestSnapshot;
    readonly credential: DarkBackgroundSyntheticCredential;
  }>;

export type DarkBackgroundSyntheticSkipReason =
  | "authority_invalid"
  | "credential_family_mismatch"
  | "credential_expired"
  | "credential_coordinates_mismatch"
  | "payload_unavailable"
  | "payload_bounds_exceeded"
  | "payload_fingerprint_mismatch";

export type DarkBackgroundSyntheticRunResult<Value> =
  | Readonly<{
    readonly status: "pending";
    readonly reason: DarkBackgroundAuthorityUnavailableReason;
    readonly snapshot: BackgroundAuthorizationRequestSnapshot;
    readonly nextAttemptAt: number;
  }>
  | Readonly<{
    readonly status: "skipped";
    readonly reason: DarkBackgroundSyntheticSkipReason;
    readonly snapshot: BackgroundAuthorizationRequestSnapshot;
  }>
  | Readonly<{
    readonly status: "completed";
    readonly snapshot: BackgroundAuthorizationRequestSnapshot;
    readonly value: Value;
  }>;

export type RunDarkBackgroundSyntheticWorkInput<Value> = Readonly<{
  readonly plan: DarkBackgroundSyntheticPlan;
  readonly now: number;
  readonly claimId: string;
  readonly claimExpiresAt: number;
  readonly resolveAuthority: (
    plan: DarkBackgroundSyntheticPlan,
  ) =>
    | DarkBackgroundSyntheticAuthorityResult
    | PromiseLike<DarkBackgroundSyntheticAuthorityResult>;
  readonly readSyntheticPayload: (
    source: DarkBackgroundSyntheticSource,
  ) => Uint8Array | null | PromiseLike<Uint8Array | null>;
  readonly execute: (payload: Uint8Array) => Value | PromiseLike<Value>;
}>;

function skipped(
  plan: DarkBackgroundSyntheticPlan,
  reason: DarkBackgroundSyntheticSkipReason,
  snapshot: BackgroundAuthorizationRequestSnapshot = plan.request,
): DarkBackgroundSyntheticRunResult<never> {
  return Object.freeze({ status: "skipped", reason, snapshot });
}

function normalizeAgentCredential(
  value: DarkBackgroundSyntheticCredential,
): DarkBackgroundSyntheticAgentCredential | null {
  if (!isRecord(value) || value["family"] !== "agent") return null;
  if (!hasExactFields(value, AGENT_CREDENTIAL_FIELDS)) return null;
  if (
    !validIdentifier(value["requestId"])
    || !validIdentifier(value["workId"])
    || !validIdentifier(value["namespaceId"])
    || !validIdentifier(value["agentId"])
    || !validCounter(value["runtimeGeneration"])
    || !validCounter(value["authorizationRevision"])
    || !validTimestamp(value["expiresAt"])
  ) {
    return null;
  }
  let descriptorDigest: string;
  try {
    descriptorDigest = normalizeDigest(
      "Dark background credential descriptor digest",
      value["descriptorDigest"],
    );
  } catch {
    return null;
  }
  return Object.freeze({
    family: "agent",
    requestId: value["requestId"],
    workId: value["workId"],
    namespaceId: value["namespaceId"],
    descriptorDigest,
    agentId: value["agentId"],
    runtimeGeneration: value["runtimeGeneration"],
    authorizationRevision: value["authorizationRevision"],
    expiresAt: value["expiresAt"],
  });
}

function isProcessorCredential(
  value: unknown,
): value is DarkBackgroundSyntheticProcessorCredential {
  return isRecord(value)
    && value["family"] === "processor"
    && hasExactFields(value, PROCESSOR_CREDENTIAL_FIELDS);
}

function boundedPendingDelay(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    return DARK_BACKGROUND_DEFAULT_PENDING_DELAY_MS;
  }
  return Math.min(Number(value), DARK_BACKGROUND_MAX_PENDING_DELAY_MS);
}

/**
 * Exercise the real shared request/claim/run/complete lifecycle with a
 * synthetic payload owned by an injected test/non-production port.
 *
 * This function accepts neither a foreground session nor a protected handle.
 * Authority is exact Agent-family evidence for the planned work; a
 * Stenographer processor credential is rejected before the payload port runs.
 */
export async function runDarkBackgroundSyntheticWork<Value>(
  input: RunDarkBackgroundSyntheticWorkInput<Value>,
): Promise<DarkBackgroundSyntheticRunResult<Value>> {
  requireExactFields("Dark background run input", input, RUN_INPUT_FIELDS);
  if (!issuedSyntheticPlans.has(input.plan)) {
    return skipped(input.plan, "authority_invalid");
  }
  if (!validTimestamp(input.now)) {
    throw new TypeError("Dark background run timestamp is invalid");
  }
  requireIdentifier("Dark background claim id", input.claimId);
  if (
    !validTimestamp(input.claimExpiresAt)
    || input.claimExpiresAt <= input.now
    || input.claimExpiresAt - input.now >
      BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS
  ) {
    throw new TypeError("Dark background claim expiry is invalid");
  }

  const authority = await input.resolveAuthority(input.plan);
  if (!isRecord(authority)) {
    return skipped(input.plan, "authority_invalid");
  }
  if (authority.status === "unavailable") {
    if (
      !hasExactFields(authority, AUTHORITY_UNAVAILABLE_FIELDS)
      && !hasExactFields(authority, AUTHORITY_UNAVAILABLE_RETRY_FIELDS)
    ) {
      return skipped(input.plan, "authority_invalid");
    }
    if (
      authority.reason !== "no_eligible_device"
      && authority.reason !== "device_offline"
      && authority.reason !== "authority_not_current"
      && authority.reason !== "recipient_unavailable"
    ) {
      return skipped(input.plan, "authority_invalid");
    }
    const delay = boundedPendingDelay(authority.retryAfterMs);
    return Object.freeze({
      status: "pending",
      reason: authority.reason,
      snapshot: input.plan.request,
      nextAttemptAt: Math.min(
        input.now + delay,
        BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
      ),
    });
  }
  if (
    authority.status !== "ready"
    || !hasExactFields(authority, AUTHORITY_READY_FIELDS)
  ) {
    return skipped(input.plan, "authority_invalid");
  }

  if (isProcessorCredential(authority.credential)) {
    return skipped(input.plan, "credential_family_mismatch");
  }
  const credential = normalizeAgentCredential(authority.credential);
  if (credential === null) {
    return skipped(input.plan, "authority_invalid");
  }
  if (credential.expiresAt <= input.now) {
    return skipped(input.plan, "credential_expired");
  }

  let snapshot: BackgroundAuthorizationRequestSnapshot;
  try {
    snapshot = parseBackgroundAuthorizationRequestSnapshot(
      authority.snapshot,
    );
  } catch {
    return skipped(input.plan, "authority_invalid");
  }
  if (
    snapshot.state !== "grant_ready"
    || snapshot.requestId !== input.plan.request.requestId
    || snapshot.workId !== input.plan.request.workId
    || snapshot.namespaceId !== input.plan.request.namespaceId
    || snapshot.descriptorDigest !== input.plan.descriptorDigest
    || snapshot.credentialSubject.kind !== "agent"
    || !sameSubject(
      snapshot.credentialSubject,
      input.plan.descriptor.subject,
    )
    || snapshot.acceptedResponse?.kind !== "agent"
  ) {
    return skipped(input.plan, "authority_invalid");
  }
  if (
    credential.requestId !== input.plan.request.requestId
    || credential.workId !== input.plan.request.workId
    || credential.namespaceId !== input.plan.request.namespaceId
    || credential.descriptorDigest !== input.plan.descriptorDigest
    || credential.agentId !== input.plan.descriptor.subject.agentId
    || credential.runtimeGeneration !==
      input.plan.descriptor.subject.runtimeGeneration
    || credential.authorizationRevision !==
      input.plan.descriptor.subject.authorizationRevision
  ) {
    return skipped(input.plan, "credential_coordinates_mismatch");
  }

  let running: BackgroundAuthorizationRequestSnapshot;
  try {
    const claimed = claimBackgroundAuthorizationRequest(
      snapshot,
      input.claimId,
      input.now,
      input.claimExpiresAt,
    );
    running = markBackgroundAuthorizationRunning(claimed, input.now);
  } catch {
    return skipped(input.plan, "authority_invalid");
  }

  const payload = await input.readSyntheticPayload(
    input.plan.descriptor.source,
  );
  if (!(payload instanceof Uint8Array)) {
    return skipped(input.plan, "payload_unavailable", running);
  }
  const ownedPayload = new Uint8Array(payload);
  try {
    if (
      ownedPayload.length < 1
      || ownedPayload.length >
        input.plan.descriptor.bounds.maximumPlaintextBytes
    ) {
      return skipped(input.plan, "payload_bounds_exceeded", running);
    }
    const fingerprint = createHash("sha256")
      .update(ownedPayload)
      .digest("hex");
    if (fingerprint !== input.plan.descriptor.source.fingerprint) {
      return skipped(input.plan, "payload_fingerprint_mismatch", running);
    }
    const value = await input.execute(ownedPayload);
    const completed = completeBackgroundAuthorizationRequest(
      running,
      input.now,
    );
    return Object.freeze({ status: "completed", snapshot: completed, value });
  } finally {
    ownedPayload.fill(0);
  }
}

import { createHash, randomUUID } from "node:crypto";

import {
  TaskRuntimeRecipientRegistry,
  type DomainForegroundSecretEntry,
  type TaskRuntimeRecipientAttempt,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import type { TaskRunResultPayloadV1 } from "@nautilo/lattice-bridge";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  encodeTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  parseDomainForegroundAuthorizationPlanV2,
  type DomainForegroundAuthorizationPlanV2,
  type DomainForegroundAuthorizationPublicCurrentAuthorityV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  StartProtectedTaskRunInput,
  StartProtectedTaskRunResult,
} from "@nautilo/db";
import {
  deriveTaskContentCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";
import type {
  CurrentTaskRuntimeAuthority,
} from "@nautilo/lattice-bridge/server";
import {
  copyTaskScopeMemoryBinding,
  type TaskScopeMemoryBinding,
} from "@nautilo/lattice-bridge/server";

import type { JobExecutor } from "../../job";
import type {
  ProtectedTaskExecutionCandidate,
  ProtectedTaskJobSchedulingFacts,
} from "../../tasks/protected-task-execution-candidate";
import type { ProtectedTaskJobReferenceV1 } from
  "../../tasks/protected-task-job-reference";
import type {
  ClaimedProtectedTaskOccurrence,
  ClaimProtectedTaskOccurrenceResult,
  ProtectedTaskOccurrenceClaimPort,
} from "../../tasks/protected-task-occurrence-coordinator";
import type { ProtectedTaskOccurrence } from "../../tasks/task-observer";
import {
  BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES,
  advanceBackgroundAuthorizationGeneration,
  attachBackgroundAuthorizationRecipient,
  claimBackgroundAuthorizationRequest,
  completeBackgroundAuthorizationRequest,
  failBackgroundAuthorizationRequest,
  markBackgroundAuthorizationRunning,
} from "./lifecycle";
import {
  TASK_RUNTIME_STABLE_IDEMPOTENCY_PREFIX,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "./repository";

type HeldTaskRuntimeAuthority = Readonly<{
  foreground: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  namespaceRequirements: CurrentTaskRuntimeAuthority["namespaceRequirements"];
}>;

type CurrentTaskRuntimeAuthorityPort = <Value>(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  use(
    current: HeldTaskRuntimeAuthority,
  ): Value | Promise<Value>;
}>) => Promise<Value | null>;

export type TaskRuntimeRecipientDeviceBinding = Readonly<{
  userId: string;
  humanActorId: string;
  deviceId: string;
}>;

export type TaskRuntimeRecipientCurrentAuthority = Readonly<{
  device: CurrentTaskRuntimeAuthority["device"];
  domains: CurrentTaskRuntimeAuthority["domains"];
  namespaceRequirements: CurrentTaskRuntimeAuthority["namespaceRequirements"];
  policyRevision: number;
  sourceRoomId: string;
  scopeMemory?: TaskScopeMemoryBinding;
}>;

export type TaskRuntimeRecipientAuthorityPort = <Value>(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  binding: TaskRuntimeRecipientDeviceBinding;
  targetRoomId: string;
  scopeMemory?: TaskScopeMemoryBinding;
  use(
    current: TaskRuntimeRecipientCurrentAuthority,
  ): Value | Promise<Value>;
}>) => Promise<Value | null>;

export type BindTaskRuntimeRecipientResult = Readonly<{
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  requestBytes: Uint8Array;
}> | null;

type TaskRuntimeResultBinding = Readonly<{
  taskId: string;
  taskRunId: string;
  contentRevision: 1;
  objectId: string;
  signerAgentId: string;
  namespace: Readonly<{
    namespaceId: string;
    domainId: string;
    operations: readonly ["encrypt"];
    expectedAccessRevision: number;
    expectedPolicyRevision: number;
  }>;
}>;

export type TaskRuntimeGrantClaimPlan = Readonly<{
  stableIdentity: TaskRuntimeGrantStableIdentity;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  reference: ProtectedTaskJobReferenceV1;
  scheduling: ProtectedTaskJobSchedulingFacts;
  executor: JobExecutor;
  scopeMemory?: TaskScopeMemoryBinding;
  modelAttribution?: "external";
  startProtectedTaskRun(
    input: StartProtectedTaskRunInput,
  ): Promise<StartProtectedTaskRunResult>;
  recipientAttempt(input: Readonly<{
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    now: number;
  }>): Readonly<{ recipientKeyId: string; expiresAt: number }>;
  buildRequest(input: Readonly<{
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    attempt: TaskRuntimeRecipientAttempt;
    binding: TaskRuntimeRecipientDeviceBinding;
    authority: TaskRuntimeRecipientCurrentAuthority;
  }>): TaskRuntimeBackgroundAuthorizationRequestV1;
  openTransientInput(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    domains: readonly DomainForegroundSecretEntry[];
    evidence: TaskRuntimeExecutionEvidence;
    signal: AbortSignal;
  }>): Promise<Record<string, unknown>>;
  publishResult(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    payload: TaskRunResultPayloadV1;
    domains: readonly DomainForegroundSecretEntry[];
    evidence: TaskRuntimeExecutionEvidence;
    signal: AbortSignal;
  }>): Promise<void>;
}>;

export type TaskRuntimeGrantStableIdentity = Readonly<{
  taskId: string;
  taskRunId: string;
  executionSegment: number;
  resumeContinuationFingerprint: string | null;
  ownerId: string;
  requestorId: string;
  agentId: string;
  callingRoomId: string | null;
  scheduleKind: ProtectedTaskOccurrence["task"]["scheduleKind"];
  graphThreadId: string;
  startedAt: number;
  sourceRoomId: string;
  targetRoomId: string;
  targetUserIds: readonly string[];
  outputRoomId: string | null;
  outputNamespaceId: string | null;
  memoryMode: "scope" | "wide" | "namespace";
  scopeId: string | null;
  contentRepresentation: ProtectedTaskOccurrence["task"]["contentRepresentation"];
  contentNamespaceId: string;
  contentRevision: number;
  contentObjectId: string;
  contentAccessRevision: number;
  requiredNamespaceFingerprint: string;
}>;

/** Routing commitment retained independently of temporary grant records. */
function taskRuntimeStableRoutingTuple(
  identity: Omit<TaskRuntimeGrantStableIdentity,
    "executionSegment" | "resumeContinuationFingerprint">,
): readonly unknown[] {
  const canonicalTargetUserIds = [...identity.targetUserIds].sort();
  // Retain the exact initial-segment preimage for already durable requests.
  return [
    identity.taskId,
    identity.taskRunId,
    identity.ownerId,
    identity.requestorId,
    identity.agentId,
    identity.callingRoomId,
    identity.scheduleKind,
    identity.graphThreadId,
    identity.startedAt,
    identity.sourceRoomId,
    identity.targetRoomId,
    canonicalTargetUserIds,
    identity.outputRoomId,
    identity.outputNamespaceId,
    identity.memoryMode,
    identity.scopeId,
    identity.contentRepresentation,
    identity.contentNamespaceId,
    identity.contentRevision,
    identity.contentObjectId,
    identity.contentAccessRevision,
    identity.requiredNamespaceFingerprint,
  ];
}

export function taskRuntimeStableRoutingDigest(
  identity: Omit<TaskRuntimeGrantStableIdentity,
    "executionSegment" | "resumeContinuationFingerprint"> & Readonly<{
      widePrimaryWriteNamespaceId: string | null;
    }>,
): Uint8Array {
  return new Uint8Array(createHash("sha256")
    .update(JSON.stringify([
      "task-runtime-stable-routing:v1",
      taskRuntimeStableRoutingTuple(identity),
      identity.widePrimaryWriteNamespaceId,
    ]))
    .digest());
}

/** Durable commitment to immutable Task/run/routing facts, excluding inventory. */
export function taskRuntimeStableIdempotencyKey(
  identity: TaskRuntimeGrantStableIdentity,
): string {
  const fingerprint = identity.resumeContinuationFingerprint;
  if (!Number.isSafeInteger(identity.executionSegment)
    || identity.executionSegment < 1
    || (identity.executionSegment === 1
      ? fingerprint !== null
      : typeof fingerprint !== "string"
        || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(fingerprint))) {
    throw new TypeError("Task Runtime execution segment identity is invalid");
  }
  const initial = taskRuntimeStableRoutingTuple(identity);
  const digest = createHash("sha256")
    .update(JSON.stringify(identity.executionSegment === 1 ? initial : [
      "task-runtime-continuation:v1",
      initial,
      identity.executionSegment,
      fingerprint,
    ]))
    .digest("base64url");
  const key = `${TASK_RUNTIME_STABLE_IDEMPOTENCY_PREFIX}:${identity.taskRunId}:${digest}`;
  if (
    new TextEncoder().encode(key).length
      > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
  ) {
    throw new TypeError("Task Runtime stable identity is too long");
  }
  return key;
}

export interface TaskRuntimeGrantClaimDependencies {
  repository: BackgroundAuthorizationTaskRuntimeReplacementRepository;
  recipients: TaskRuntimeRecipientRegistry;
  plan(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<TaskRuntimeGrantClaimPlan> | TaskRuntimeGrantClaimPlan;
  withCurrentAuthority: CurrentTaskRuntimeAuthorityPort;
  now?: () => number;
  claimId?: () => string;
}

export type PrepareUnclaimedParkedTaskRuntimeAuthorityResult = Readonly<{
  status: "created" | "exact_replay" | "replaced" | "active" | "inactive" | "stale";
}>;

export type PrepareUnclaimedParkedTaskRuntimeAuthorityInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  stableIdentity: TaskRuntimeGrantStableIdentity;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  repository: BackgroundAuthorizationTaskRuntimeReplacementRepository;
  recipients: TaskRuntimeRecipientRegistry;
  now: () => number;
}>;

function isTaskRuntimeRecord(
  record: BackgroundAuthorizationRecord,
): record is BackgroundAuthorizationTaskRuntimeRecordV3 {
  return record.snapshot.formatVersion === 3
    && record.snapshot.credentialSubject.kind === "runtime"
    && record.snapshot.credentialSubject.runtimeKind === "task"
    && record.snapshot.credentialSubject.runtimeVersion === 1
    && record.authoritySet !== undefined;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function sameDomainAuthority(
  left: DomainForegroundAuthorizationPlanV2["domains"][number],
  right: DomainForegroundAuthorizationPlanV2["domains"][number],
): boolean {
  return left.domainId === right.domainId
    && left.sourceNamespaceId === right.sourceNamespaceId
    && sameBytes(left.participantDigest, right.participantDigest)
    && left.participantCount === right.participantCount
    && left.keyClass === right.keyClass
    && left.domainKeyGeneration === right.domainKeyGeneration
    && left.authorizationRevision === right.authorizationRevision
    && sameBytes(left.headDigest, right.headDigest)
    && sameBytes(
      left.activeNamespaceBindingSetDigest,
      right.activeNamespaceBindingSetDigest,
    )
    && left.activeNamespaceBindingCount === right.activeNamespaceBindingCount;
}

function recipientAuthorityIsCurrent(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  binding: TaskRuntimeRecipientDeviceBinding;
  scopeMemory?: TaskScopeMemoryBinding;
  authority: TaskRuntimeRecipientCurrentAuthority;
}>): boolean {
  const { binding, authority, record } = input;
  const namespaces = authority.namespaceRequirements;
  const durableNamespaces = record.authoritySet.namespaceRequirements;
  const durableDomains = record.authoritySet.domainRequirements;
  return binding.userId === input.occurrence.task.requestorId
    && (input.scopeMemory === undefined
      ? authority.scopeMemory === undefined
      : authority.scopeMemory !== undefined
        && sameTaskScopeMemoryBinding(input.scopeMemory, authority.scopeMemory))
    && authority.device.userId === binding.userId
    && authority.device.humanActorId === binding.humanActorId
    && authority.device.deviceId === binding.deviceId
    && authority.policyRevision === record.expectedPolicyRevision
    && namespaces.length === durableNamespaces.length
    && namespaces.every((current, index) => {
      const durable = durableNamespaces[index];
      return durable !== undefined
        && current.ordinal === durable.ordinal
        && current.namespaceId === durable.namespaceId
        && current.domainId === durable.domainId
        && current.operations.length === durable.operations.length
        && current.operations.every((operation, operationIndex) =>
          operation === durable.operations[operationIndex])
        && current.expectedAccessRevision === durable.expectedAccessRevision
        && current.expectedPolicyRevision === durable.expectedPolicyRevision;
    })
    && authority.domains.length === durableDomains.length
    && authority.domains.every((current, index) => {
      const durable = durableDomains[index];
      return durable !== undefined
        && current.domainId === durable.domainId
        && current.domainKeyGeneration === durable.expectedEpoch
        && current.authorizationRevision
          === durable.expectedAuthorizationRevision;
    });
}

function sameTaskScopeMemoryBinding(
  left: TaskScopeMemoryBinding,
  right: TaskScopeMemoryBinding,
): boolean {
  return left.scopeId === right.scopeId
    && left.memoryRoomId === right.memoryRoomId
    && left.originWritableNamespaceId === right.originWritableNamespaceId
    && left.readableNamespaceIds.length === right.readableNamespaceIds.length
    && left.readableNamespaceIds.every(
      (namespaceId, index) => namespaceId === right.readableNamespaceIds[index],
    );
}

function exactOccurrenceRecord(
  occurrence: ProtectedTaskOccurrence,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const contentRequirements = record.authoritySet.namespaceRequirements.filter(
    (requirement) =>
      requirement.namespaceId === occurrence.task.contentNamespaceId,
  );
  const content = contentRequirements[0];
  return occurrence.task.cryptoAccessRevision === 0
    && occurrence.task.cryptoObjectId === deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: occurrence.task.id,
      contentRevision: occurrence.task.contentRevision,
    })
    && record.snapshot.workId === occurrence.run.id
    && record.snapshot.namespaceId === occurrence.task.contentNamespaceId
    && record.workKind === "task.execute"
    && record.purpose === "task.execute"
    && record.processorAuthorizationRevision === null
    && record.expectedDomainEpoch !== null
    && contentRequirements.length === 1
    && content !== undefined
    && content.domainId === record.domainId
    && content.expectedAccessRevision
      === record.expectedNamespaceAccessRevision
    && content.expectedPolicyRevision === record.expectedPolicyRevision
    && content.operations.length === 2
    && content.operations[0] === "decrypt"
    && content.operations[1] === "encrypt";
}

function parkedStableIdentityMatchesOccurrence(
  occurrence: ProtectedTaskOccurrence,
  identity: TaskRuntimeGrantStableIdentity,
): boolean {
  const canonicalTargetUserIds = [...identity.targetUserIds].sort();
  return occurrence.run.jobId !== null
    && identity.executionSegment > 1
    && identity.resumeContinuationFingerprint !== null
    && identity.taskId === occurrence.task.id
    && identity.taskRunId === occurrence.run.id
    && identity.ownerId === occurrence.task.ownerId
    && identity.requestorId === occurrence.task.requestorId
    && identity.agentId === occurrence.task.agentId
    && identity.callingRoomId === occurrence.task.callingRoomId
    && identity.scheduleKind === occurrence.task.scheduleKind
    && identity.graphThreadId === occurrence.run.graphThreadId
    && identity.startedAt === occurrence.run.startedAt.getTime()
    && identity.sourceRoomId.length > 0
    && identity.targetRoomId.length > 0
    && identity.targetUserIds.length > 0
    && identity.targetUserIds.includes(identity.requestorId)
    && new Set(identity.targetUserIds).size === identity.targetUserIds.length
    && identity.targetUserIds.every(
      (value, index) => value === canonicalTargetUserIds[index],
    )
    && identity.outputRoomId === occurrence.task.callingRoomId
    && ((identity.outputRoomId === null) === (identity.outputNamespaceId === null))
    && (identity.memoryMode === "scope"
      ? identity.scopeId !== null && identity.scopeId.length > 0
      : identity.scopeId === null)
    && identity.contentRepresentation === occurrence.task.contentRepresentation
    && identity.contentNamespaceId === occurrence.task.contentNamespaceId
    && identity.contentRevision === occurrence.task.contentRevision
    && identity.contentObjectId === occurrence.task.cryptoObjectId
    && identity.contentAccessRevision === occurrence.task.cryptoAccessRevision
    && identity.requiredNamespaceFingerprint === Buffer.from(
      occurrence.task.cryptoRequiredNamespaceFingerprint,
    ).toString("base64url");
}

function exactUnclaimedParkedInitialRecord(
  occurrence: ProtectedTaskOccurrence,
  stableIdentity: TaskRuntimeGrantStableIdentity,
  initial: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return exactOccurrenceRecord(occurrence, initial)
    && parkedStableIdentityMatchesOccurrence(occurrence, stableIdentity)
    && initial.idempotencyKey === taskRuntimeStableIdempotencyKey(stableIdentity)
    && initial.snapshot.state === "awaiting_recipient"
    && initial.snapshot.recipientGeneration === 0
    && initial.snapshot.recipient === null
    && initial.snapshot.acceptedResponse === null
    && initial.snapshot.claimId === null
    && initial.snapshot.claimExpiresAt === null
    && initial.snapshot.requestRevision === 0
    && initial.descriptorBytes === null
    && initial.acceptedMaterial === null
    && initial.finishedAt === null;
}

function sameDurablePlan(
  current: BackgroundAuthorizationTaskRuntimeRecordV3,
  initial: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return current.snapshot.requestId === initial.snapshot.requestId
    && current.snapshot.workId === initial.snapshot.workId
    && current.snapshot.namespaceId === initial.snapshot.namespaceId
    && JSON.stringify(current.snapshot.credentialSubject)
      === JSON.stringify(initial.snapshot.credentialSubject)
    && (
      current.idempotencyKey === initial.idempotencyKey
      || current.idempotencyKey === `task-run:${initial.snapshot.workId}`
    )
    && sameBytes(current.workIdentityHash, initial.workIdentityHash)
    && current.workKind === initial.workKind
    && current.purpose === initial.purpose
    && current.domainId === initial.domainId
    && current.processorAuthorizationRevision
      === initial.processorAuthorizationRevision
    && current.expectedDomainEpoch === initial.expectedDomainEpoch
    && current.expectedNamespaceAccessRevision
      === initial.expectedNamespaceAccessRevision
    && current.expectedPolicyRevision === initial.expectedPolicyRevision
    && JSON.stringify(current.authoritySet)
      === JSON.stringify(initial.authoritySet);
}

function stableIdentityMatchesOccurrence(
  occurrence: ProtectedTaskOccurrence,
  plan: TaskRuntimeGrantClaimPlan,
): boolean {
  const identity = plan.stableIdentity;
  const canonicalTargetUserIds = [...identity.targetUserIds].sort();
  // This coordinator still owns initial starts. A continuation must use the
  // dedicated proof-consuming start plan before it can attach a recipient.
  return identity.executionSegment === 1
    && identity.resumeContinuationFingerprint === null
    && plan.reference.executionSegment === 1
    && !Object.hasOwn(plan.reference, "resumeAcceptanceId")
    && !Object.hasOwn(plan.reference, "resumeContinuationFingerprint")
    && identity.taskId === occurrence.task.id
    && identity.taskRunId === occurrence.run.id
    && identity.ownerId === occurrence.task.ownerId
    && identity.requestorId === occurrence.task.requestorId
    && identity.agentId === occurrence.task.agentId
    && identity.callingRoomId === occurrence.task.callingRoomId
    && identity.scheduleKind === occurrence.task.scheduleKind
    && identity.graphThreadId === occurrence.run.graphThreadId
    && identity.startedAt === occurrence.run.startedAt.getTime()
    && identity.sourceRoomId.length > 0
    && identity.targetRoomId === plan.scheduling.roomId
    && identity.targetUserIds.length > 0
    && identity.targetUserIds.includes(identity.requestorId)
    && new Set(identity.targetUserIds).size === identity.targetUserIds.length
    && identity.targetUserIds.every(
      (value, index) => value === canonicalTargetUserIds[index],
    )
    && identity.outputRoomId === occurrence.task.callingRoomId
    && ((identity.outputRoomId === null) === (identity.outputNamespaceId === null))
    && (
      identity.memoryMode === "scope"
        ? identity.scopeId !== null && identity.scopeId.length > 0
        : identity.scopeId === null
    )
    && identity.contentRepresentation
      === occurrence.task.contentRepresentation
    && identity.contentNamespaceId === occurrence.task.contentNamespaceId
    && identity.contentRevision === occurrence.task.contentRevision
    && identity.contentObjectId === occurrence.task.cryptoObjectId
    && identity.contentAccessRevision === occurrence.task.cryptoAccessRevision
    && identity.requiredNamespaceFingerprint === Buffer.from(
      occurrence.task.cryptoRequiredNamespaceFingerprint,
    ).toString("base64url")
    && plan.initialRecord.idempotencyKey
      === taskRuntimeStableIdempotencyKey(identity);
}

function exactScopeNamespaceRequirements(
  plan: TaskRuntimeGrantClaimPlan,
  scopeMemory: TaskScopeMemoryBinding,
): boolean {
  const contentNamespaceId = plan.stableIdentity.contentNamespaceId;
  const outputNamespaceId = plan.stableIdentity.outputNamespaceId;
  const expectedIds = [...new Set([
    ...scopeMemory.readableNamespaceIds,
    contentNamespaceId,
    ...(outputNamespaceId === null ? [] : [outputNamespaceId]),
  ])].sort();
  const encryptable = new Set([
    scopeMemory.originWritableNamespaceId,
    contentNamespaceId,
    ...(outputNamespaceId === null ? [] : [outputNamespaceId]),
  ]);
  const requirements = plan.initialRecord.authoritySet.namespaceRequirements;
  return requirements.length === expectedIds.length
    && requirements.every((requirement, index) => {
      const namespaceId = expectedIds[index];
      if (namespaceId === undefined) return false;
      const expectedOperations = encryptable.has(namespaceId)
        ? (["decrypt", "encrypt"] as const)
        : (["decrypt"] as const);
      return requirement.ordinal === index
        && requirement.namespaceId === namespaceId
        && requirement.operations.length === expectedOperations.length
        && requirement.operations.every(
          (operation, operationIndex) =>
            operation === expectedOperations[operationIndex],
        );
    });
}

function assertPlan(
  occurrence: ProtectedTaskOccurrence,
  plan: TaskRuntimeGrantClaimPlan,
  scopeMemory: TaskScopeMemoryBinding | undefined,
): TaskRuntimeResultBinding {
  const initial = plan.initialRecord;
  const resultObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "run_result",
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    contentRevision: 1,
  });
  const outputNamespaces = initial.authoritySet?.namespaceRequirements.filter(
    (requirement) =>
      requirement.namespaceId === occurrence.task.contentNamespaceId,
  ) ?? [];
  const outputNamespace = outputNamespaces[0];
  const outputDomains = outputNamespace === undefined
    ? []
    : initial.authoritySet?.domainRequirements.filter((requirement) =>
      requirement.domainId === outputNamespace.domainId
    ) ?? [];
  const outputDomain = outputDomains[0];
  if (
    !isTaskRuntimeRecord(initial)
    || !exactOccurrenceRecord(occurrence, initial)
    || !stableIdentityMatchesOccurrence(occurrence, plan)
    || (plan.stableIdentity.memoryMode === "scope"
      ? scopeMemory === undefined
        || scopeMemory.scopeId !== plan.stableIdentity.scopeId
        || !exactScopeNamespaceRequirements(plan, scopeMemory)
      : scopeMemory !== undefined)
    || initial.snapshot.state !== "awaiting_recipient"
    || initial.snapshot.recipientGeneration !== 0
    || initial.snapshot.recipient !== null
    || initial.snapshot.acceptedResponse !== null
    || initial.snapshot.claimId !== null
    || initial.snapshot.claimExpiresAt !== null
    || initial.snapshot.requestRevision !== 0
    || initial.descriptorBytes !== null
    || initial.acceptedMaterial !== null
    || initial.finishedAt !== null
    || plan.reference.taskId !== occurrence.task.id
    || plan.reference.taskRunId !== occurrence.run.id
    || plan.reference.resultObjectId !== resultObjectId
    || plan.reference.inputObjectId !== occurrence.task.cryptoObjectId
    || plan.reference.authorizationRequestId !== initial.snapshot.requestId
    || plan.reference.policyRevision !== initial.expectedPolicyRevision
    || plan.scheduling.ownerId !== occurrence.task.ownerId
    || plan.scheduling.requestorId !== occurrence.task.requestorId
    || plan.scheduling.agentId !== occurrence.task.agentId
    || plan.scheduling.callingRoomId !== occurrence.task.callingRoomId
    || plan.scheduling.graphThreadId !== occurrence.run.graphThreadId
    || outputNamespaces.length !== 1
    || outputNamespace === undefined
    || outputNamespace.domainId !== initial.domainId
    || outputNamespace.operations.length !== 2
    || outputNamespace.operations[0] !== "decrypt"
    || outputNamespace.operations[1] !== "encrypt"
    || outputNamespace.expectedAccessRevision
      !== initial.expectedNamespaceAccessRevision
    || outputNamespace.expectedPolicyRevision !== initial.expectedPolicyRevision
    || outputDomains.length !== 1
    || outputDomain === undefined
    || outputDomain.expectedEpoch !== initial.expectedDomainEpoch
    || typeof plan.executor !== "function"
    || typeof plan.startProtectedTaskRun !== "function"
    || typeof plan.openTransientInput !== "function"
    || typeof plan.publishResult !== "function"
  ) throw new TypeError("Task Runtime grant plan disagrees with its occurrence");
  return Object.freeze({
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    contentRevision: 1 as const,
    objectId: resultObjectId,
    signerAgentId: occurrence.task.agentId,
    namespace: Object.freeze({
      namespaceId: outputNamespace.namespaceId,
      domainId: outputNamespace.domainId,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: outputNamespace.expectedAccessRevision,
      expectedPolicyRevision: outputNamespace.expectedPolicyRevision,
    }),
  });
}

function resultBindingMatchesRecord(
  result: TaskRuntimeResultBinding,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const namespaces = record.authoritySet.namespaceRequirements.filter(
    (requirement) => requirement.namespaceId === result.namespace.namespaceId,
  );
  const namespace = namespaces[0];
  const domains = record.authoritySet.domainRequirements.filter(
    (requirement) => requirement.domainId === result.namespace.domainId,
  );
  const domain = domains[0];
  return record.snapshot.workId === result.taskRunId
    && record.snapshot.namespaceId === result.namespace.namespaceId
    && record.domainId === result.namespace.domainId
    && record.expectedNamespaceAccessRevision
      === result.namespace.expectedAccessRevision
    && record.expectedPolicyRevision === result.namespace.expectedPolicyRevision
    && namespaces.length === 1
    && namespace !== undefined
    && namespace.domainId === result.namespace.domainId
    && namespace.operations.length === 2
    && namespace.operations[0] === "decrypt"
    && namespace.operations[1] === "encrypt"
    && namespace.expectedAccessRevision
      === result.namespace.expectedAccessRevision
    && namespace.expectedPolicyRevision
      === result.namespace.expectedPolicyRevision
    && domains.length === 1
    && domain !== undefined
    && domain.expectedEpoch === record.expectedDomainEpoch;
}

function currentMatchesResult(
  result: TaskRuntimeResultBinding,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  current: HeldTaskRuntimeAuthority,
): boolean {
  const namespaces = current.namespaceRequirements.filter((requirement) =>
    requirement.namespaceId === result.namespace.namespaceId
  );
  const namespace = namespaces[0];
  const domains = current.foreground.domains.filter((domain) =>
    domain.domainId === result.namespace.domainId
  );
  const domain = domains[0];
  const durableDomains = record.authoritySet.domainRequirements.filter(
    (requirement) => requirement.domainId === result.namespace.domainId,
  );
  const durableNamespaces = record.authoritySet.namespaceRequirements.filter(
    (requirement) => requirement.namespaceId === result.namespace.namespaceId,
  );
  const durableDomain = durableDomains[0];
  const durableNamespace = durableNamespaces[0];
  return resultBindingMatchesRecord(result, record)
    && current.foreground.policyRevision
      === result.namespace.expectedPolicyRevision
    && namespaces.length === 1
    && namespace !== undefined
    && durableNamespaces.length === 1
    && durableNamespace !== undefined
    && namespace.ordinal === durableNamespace.ordinal
    && namespace.domainId === result.namespace.domainId
    && namespace.operations.length === 2
    && namespace.operations[0] === "decrypt"
    && namespace.operations[1] === "encrypt"
    && namespace.expectedAccessRevision
      === result.namespace.expectedAccessRevision
    && namespace.expectedPolicyRevision
      === result.namespace.expectedPolicyRevision
    && domains.length === 1
    && domain !== undefined
    && durableDomains.length === 1
    && durableDomain !== undefined
    && domain.domainKeyGeneration === durableDomain.expectedEpoch
    && domain.authorizationRevision
      === durableDomain.expectedAuthorizationRevision;
}

function exactRequest(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
  attempt: TaskRuntimeRecipientAttempt,
  request: TaskRuntimeBackgroundAuthorizationRequestV1,
): boolean {
  return request.requestId === record.snapshot.requestId
    && request.workId === record.snapshot.workId
    && request.workKind === "task.execute"
    && request.workPurpose === "task.execute"
    && request.recipientGeneration === record.snapshot.recipientGeneration
    && request.recipientGeneration === attempt.recipientGeneration
    && request.recipientKeyId === attempt.recipientKeyId
    && sameBytes(request.recipientPublicKey, attempt.recipientPublicKey)
    && request.deadlineAt === attempt.expiresAt
    && request.issuedAt < request.deadlineAt;
}

function exactBoundRequest(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  attempt: TaskRuntimeRecipientAttempt;
  binding: TaskRuntimeRecipientDeviceBinding;
  authority: TaskRuntimeRecipientCurrentAuthority;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  now: number;
}>): boolean {
  if (!exactRequest(input.record, input.attempt, input.request)) return false;
  const plan = parseDomainForegroundAuthorizationPlanV2(
    input.request.authorizationPlanBytes,
  );
  if (plan === null) return false;
  try {
    return input.request.sourceRoomId === input.authority.sourceRoomId
      && input.request.episodeId === plan.sessionId
      && plan.roomId === input.authority.sourceRoomId
      && input.request.issuedAt === plan.issuedAt
      && input.request.deadlineAt === plan.deadlineAt
      && input.request.issuedAt <= input.now
      && plan.authorizationId === input.record.snapshot.requestId
      && plan.policyRevision === input.record.expectedPolicyRevision
      && plan.policyRevision === input.authority.policyRevision
      && plan.subjectHumanId === input.binding.humanActorId
      && plan.committerDeviceId === input.binding.deviceId
      && plan.committerDeviceSigningGeneration
        === input.authority.device.deviceGeneration
      && plan.hostAuthorizationRevision
        === input.authority.device.securityRevision
      && plan.recipientKind === "runtime"
      && plan.recipientPrincipalId === "nautilo_task_runtime"
      && plan.recipientAuthorizationRevision === 0
      && plan.recipientRuntimeGeneration === input.attempt.recipientGeneration
      && plan.recipientKeyId === input.attempt.recipientKeyId
      && plan.operations.length === 2
      && plan.operations[0] === "decrypt"
      && plan.operations[1] === "encrypt"
      && plan.domains.length === input.authority.domains.length
      && plan.domains.every((domain, index) => {
        const current = input.authority.domains[index];
        return current !== undefined && sameDomainAuthority(domain, current);
      });
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
  }
}

function activeRecipient(
  recipients: TaskRuntimeRecipientRegistry,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  const recipient = record.snapshot.recipient;
  return recipient !== null && recipients.hasAttempt({
    requestId: record.snapshot.requestId,
    workId: record.snapshot.workId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: recipient.recipientKeyId,
  });
}

function requestFromRecord(
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): TaskRuntimeBackgroundAuthorizationRequestV1 | null {
  if (record.descriptorBytes === null) return null;
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    record.descriptorBytes,
  );
  if (request === null) return null;
  const recipient = record.snapshot.recipient;
  if (
    recipient === null
    || request.requestId !== record.snapshot.requestId
    || request.workId !== record.snapshot.workId
    || request.recipientGeneration !== record.snapshot.recipientGeneration
    || request.recipientKeyId !== recipient.recipientKeyId
    || Buffer.from(request.recipientPublicKey).toString("base64url")
      !== recipient.recipientPublicKey
    || request.deadlineAt !== recipient.expiresAt
  ) {
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    return null;
  }
  return request;
}

function currentMatchesRequest(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
  request: TaskRuntimeBackgroundAuthorizationRequestV1,
): boolean {
  return current.authorizationId === request.requestId
    && current.sessionId === request.episodeId
    && current.roomId === request.sourceRoomId
    && current.recipientKind === "runtime"
    && current.recipientPrincipalId === "nautilo_task_runtime"
    && current.recipientAuthorizationRevision === 0
    && current.recipientRuntimeGeneration === request.recipientGeneration
    && current.recipientKeyId === request.recipientKeyId
    && current.recipientAuthorized
    && current.committerDeviceActive;
}

function copyCurrentAuthority(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): DomainForegroundAuthorizationPublicCurrentAuthorityV2 {
  return Object.freeze({
    ...current,
    committerDeviceSigningPublicKey:
      current.committerDeviceSigningPublicKey.slice(),
    domains: Object.freeze(current.domains.map((domain) => Object.freeze({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
    }))),
  });
}

function destroyCurrentAuthority(
  current: DomainForegroundAuthorizationPublicCurrentAuthorityV2,
): void {
  current.committerDeviceSigningPublicKey.fill(0);
  for (const domain of current.domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.activeNamespaceBindingSetDigest.fill(0);
  }
}

function staleClaimResult(
  current: BackgroundAuthorizationRecord | null,
): ClaimProtectedTaskOccurrenceResult {
  return current?.snapshot.state === "claimed"
    || current?.snapshot.state === "running"
    ? Object.freeze({ status: "already_claimed" as const })
    : Object.freeze({ status: "inactive" as const });
}

function stableReplacementRecordIdentity(
  current: BackgroundAuthorizationTaskRuntimeRecordV3,
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3,
): boolean {
  return current.snapshot.requestId === replacement.snapshot.requestId
    && current.snapshot.workId === replacement.snapshot.workId
    && current.snapshot.namespaceId === replacement.snapshot.namespaceId
    && JSON.stringify(current.snapshot.credentialSubject)
      === JSON.stringify(replacement.snapshot.credentialSubject)
    && current.idempotencyKey === replacement.idempotencyKey
    && current.workKind === replacement.workKind
    && current.purpose === replacement.purpose
    && current.processorAuthorizationRevision
      === replacement.processorAuthorizationRevision;
}

function staleReplacementResult(
  current: BackgroundAuthorizationRecord | null,
  replacement: BackgroundAuthorizationTaskRuntimeRecordV3,
): ClaimProtectedTaskOccurrenceResult {
  if (current?.snapshot.state === "claimed"
    || current?.snapshot.state === "running") {
    return Object.freeze({ status: "already_claimed" as const });
  }
  return current !== null
      && isTaskRuntimeRecord(current)
      && sameDurablePlan(current, replacement)
    ? Object.freeze({ status: "awaiting_authorization" as const })
    : Object.freeze({ status: "inactive" as const });
}

/**
 * Prepare one continuation Runtime request while its server owner holds the
 * exact parked Task authority. This never claims work or creates a Job.
 */
export async function prepareUnclaimedParkedTaskRuntimeAuthority(
  input: PrepareUnclaimedParkedTaskRuntimeAuthorityInput,
): Promise<PrepareUnclaimedParkedTaskRuntimeAuthorityResult> {
  const repository = input.repository;
  const recipients = input.recipients;
  const now = input.now;
  const occurrence: ProtectedTaskOccurrence = Object.freeze({
    task: Object.freeze({
      ...input.occurrence.task,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(
        input.occurrence.task.cryptoRequiredNamespaceFingerprint,
      ),
    }),
    run: Object.freeze({
      ...input.occurrence.run,
      startedAt: new Date(input.occurrence.run.startedAt.getTime()),
    }),
  });
  const stableIdentity: TaskRuntimeGrantStableIdentity = Object.freeze({
    ...input.stableIdentity,
    targetUserIds: Object.freeze([...input.stableIdentity.targetUserIds]),
  });
  const parsedInitial = parseBackgroundAuthorizationRecord(input.initialRecord);
  if (typeof repository?.get !== "function"
    || typeof repository.create !== "function"
    || typeof repository.replaceUnclaimedTaskRuntimeAuthority !== "function"
    || typeof recipients?.delete !== "function"
    || typeof now !== "function"
    || !isTaskRuntimeRecord(parsedInitial)
    || !exactUnclaimedParkedInitialRecord(
      occurrence,
      stableIdentity,
      parsedInitial,
    )) {
    throw new TypeError("Parked Task Runtime authority preparation is invalid");
  }
  const initial = parsedInitial;

  const classify = async (
    record: BackgroundAuthorizationRecord,
  ): Promise<PrepareUnclaimedParkedTaskRuntimeAuthorityResult> => {
    if (!isTaskRuntimeRecord(record)
      || !exactOccurrenceRecord(occurrence, record)
      || !stableReplacementRecordIdentity(record, initial)) {
      throw new TypeError("Parked Task Runtime durable record was substituted");
    }
    if (record.snapshot.state === "claimed"
      || record.snapshot.state === "running") {
      return Object.freeze({ status: "active" as const });
    }
    if (![
      "awaiting_recipient",
      "awaiting_device",
      "grant_ready",
    ].includes(record.snapshot.state)) {
      return Object.freeze({ status: "inactive" as const });
    }
    if (sameDurablePlan(record, initial)) {
      return Object.freeze({ status: "exact_replay" as const });
    }
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new TypeError("Parked Task Runtime preparation clock is invalid");
    }
    const replaced = await repository.replaceUnclaimedTaskRuntimeAuthority({
      expected: record,
      replacement: initial,
      now: timestamp,
    });
    if (replaced.status === "stale") {
      return Object.freeze({ status: "stale" as const });
    }
    recipients.delete(
      record.snapshot.requestId,
      record.snapshot.recipientGeneration,
    );
    return Object.freeze({ status: "replaced" as const });
  };

  const existing = await repository.get(initial.snapshot.requestId);
  if (existing !== null) return classify(existing);
  const created = await repository.create(initial);
  return created.status === "created"
    ? Object.freeze({ status: "created" as const })
    : classify(created.record);
}

function createCandidate(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  claimed: BackgroundAuthorizationTaskRuntimeRecordV3;
  plan: TaskRuntimeGrantClaimPlan;
  dependencies: TaskRuntimeGrantClaimDependencies;
  claimId: string;
  result: TaskRuntimeResultBinding;
}>): ProtectedTaskExecutionCandidate {
  let state: "ready" | "starting" | "started" | "running" | "finished" =
    "ready";
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    input.dependencies.recipients.delete(
      input.claimed.snapshot.requestId,
      input.claimed.snapshot.recipientGeneration,
    );
  };
  return Object.freeze({
    async start(jobId: string): Promise<StartProtectedTaskRunResult> {
      if (state !== "ready") {
        throw new Error("Task Runtime execution candidate is one-use");
      }
      state = "starting";
      try {
        const result = await input.plan.startProtectedTaskRun({
          taskId: input.occurrence.task.id,
          taskRunId: input.occurrence.run.id,
          graphThreadId: input.occurrence.run.graphThreadId,
          jobId,
          contentRepresentation:
            input.occurrence.task.contentRepresentation,
          contentNamespaceId: input.occurrence.task.contentNamespaceId,
          contentRevision: input.occurrence.task.contentRevision,
          cryptoObjectId: input.occurrence.task.cryptoObjectId,
          cryptoAccessRevision: input.occurrence.task.cryptoAccessRevision,
          cryptoRequiredNamespaceFingerprint:
            input.occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
          jobReference: input.plan.reference,
        });
        if (state !== "starting") {
          release();
          return Object.freeze({ status: "stale" as const });
        }
        if (result.status === "stale") {
          state = "finished";
          release();
          return result;
        }
        if (result.status !== "started") {
          throw new TypeError("Task Runtime start returned an invalid result");
        }
        state = "started";
        return result;
      } catch (error) {
        state = "finished";
        release();
        throw error;
      }
    },
    async run<Value>(work: (
      transientInput: Record<string, unknown>,
      authorizationSignal: AbortSignal,
      publication: Readonly<{
        publish(payload: TaskRunResultPayloadV1): Promise<void>;
        awaitPublished(): Promise<boolean>;
      }>,
    ) => Promise<Value>): Promise<Value> {
      if (state === "ready") {
        throw new Error("Task Runtime execution candidate has not started");
      }
      if (state !== "started") {
        throw new Error("Task Runtime execution candidate is one-use");
      }
      state = "running";
      try {
        const current = await input.dependencies.repository.get(
          input.claimed.snapshot.requestId,
        );
        if (
          current === null
          || !isTaskRuntimeRecord(current)
          || current.snapshot.state !== "claimed"
          || current.snapshot.claimId !== input.claimId
          || current.snapshot.claimExpiresAt === null
          || current.acceptedMaterial === null
          || !exactOccurrenceRecord(input.occurrence, current)
          || !resultBindingMatchesRecord(input.result, current)
        ) throw new Error("Task Runtime durable claim is no longer current");
        const request = requestFromRecord(current);
        if (request === null) {
          throw new Error("Task Runtime authorization request is unavailable");
        }
        try {
          const authority = await input.dependencies.withCurrentAuthority({
            occurrence: input.occurrence,
            record: current,
            request,
            use: (held) => currentMatchesRequest(held.foreground, request)
                && currentMatchesResult(input.result, current, held)
              ? Object.freeze({
                foreground: copyCurrentAuthority(held.foreground),
                namespaceRequirements: Object.freeze(
                  held.namespaceRequirements.map((requirement) => Object.freeze({
                    ordinal: requirement.ordinal,
                    namespaceId: requirement.namespaceId,
                    domainId: requirement.domainId,
                    operations: Object.freeze([...requirement.operations]),
                    expectedAccessRevision: requirement.expectedAccessRevision,
                    expectedPolicyRevision: requirement.expectedPolicyRevision,
                  })),
                ),
              })
              : null,
          });
          if (authority === null) {
            throw new Error("Task Runtime authority is no longer current");
          }
          try {
            const opened = await input.dependencies.recipients.withOpenedGrant({
              requestId: request.requestId,
              workId: request.workId,
              recipientGeneration: request.recipientGeneration,
              recipientKeyId: request.recipientKeyId,
              claimId: input.claimId,
              claimExpiresAt: current.snapshot.claimExpiresAt,
              authorizationBytes: current.acceptedMaterial.responseBytes,
              current: authority.foreground,
              currentNamespaceRequirements: authority.namespaceRequirements,
              result: input.result,
              operation: async (domains, signal, evidence) => {
                const transientInput = await input.plan.openTransientInput({
                  occurrence: input.occurrence,
                  record: current,
                  domains,
                  evidence,
                  signal,
                });
                signal.throwIfAborted();
                const runningAt = input.dependencies.now?.() ?? Date.now();
                const runningRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
                  ...current,
                  snapshot: markBackgroundAuthorizationRunning(
                    current.snapshot,
                    runningAt,
                  ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
                };
                const running = await input.dependencies.repository.compareAndSwap({
                  expectedRequestRevision: current.snapshot.requestRevision,
                  next: runningRecord,
                });
                const storedRunning = running.status === "updated"
                  ? running.record
                  : null;
                if (
                  storedRunning === null
                  || !isTaskRuntimeRecord(storedRunning)
                  || storedRunning.snapshot.state !== "running"
                  || storedRunning.snapshot.claimId !== input.claimId
                  || !exactOccurrenceRecord(input.occurrence, storedRunning)
                ) {
                  throw new Error("Task Runtime execution start could not be recorded");
                }
                let publicationCalls = 0;
                let publicationCompleted = false;
                let publicationOpen = true;
                const pendingPublications: Promise<void>[] = [];
                const publication = Object.freeze({
                  publish: (payload: TaskRunResultPayloadV1): Promise<void> => {
                    if (!publicationOpen || publicationCalls !== 0) {
                      throw new Error("Task Runtime result publication is one-use");
                    }
                    publicationCalls += 1;
                    signal.throwIfAborted();
                    const pending = input.plan.publishResult({
                      occurrence: input.occurrence,
                      record: storedRunning,
                      payload,
                      domains,
                      evidence,
                      signal,
                    }).then(() => {
                      publicationCompleted = true;
                    });
                    pendingPublications.push(pending);
                    return pending;
                  },
                  awaitPublished: async (): Promise<boolean> => {
                    await Promise.all(pendingPublications);
                    return publicationCalls === 1 && publicationCompleted;
                  },
                });
                try {
                  const result = await work(transientInput, signal, publication);
                  await Promise.all(pendingPublications);
                  signal.throwIfAborted();
                  if (publicationCalls === 1) {
                    const completedAt = input.dependencies.now?.() ?? Date.now();
                    const completedRecord:
                      BackgroundAuthorizationTaskRuntimeRecordV3 = {
                        ...storedRunning,
                        snapshot: completeBackgroundAuthorizationRequest(
                          storedRunning.snapshot,
                          completedAt,
                        ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
                        finishedAt: completedAt,
                      };
                    const completed = await input.dependencies.repository
                      .compareAndSwap({
                        expectedRequestRevision:
                          storedRunning.snapshot.requestRevision,
                        next: completedRecord,
                      });
                    if (completed.status !== "updated") {
                      throw new Error(
                        "Task Runtime execution completion could not be recorded",
                      );
                    }
                  }
                  return result;
                } catch (error) {
                  await Promise.allSettled(pendingPublications);
                  throw error;
                } finally {
                  publicationOpen = false;
                }
              },
            });
            if (opened.status !== "opened") {
              throw new Error("Task Runtime authorization could not be opened");
            }
            return opened.value;
          } finally {
            destroyCurrentAuthority(authority.foreground);
          }
        } finally {
          destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
        }
      } finally {
        state = "finished";
        release();
      }
    },
    onIneligible(): void {
      if (state === "running" || state === "finished") return;
      state = "finished";
      release();
    },
  });
}

/**
 * Dark Task Runtime grant/claim composition. It can prepare and atomically
 * claim an accepted device grant, but does not mount the protected executor.
 */
class TaskRuntimeGrantClaim implements ProtectedTaskOccurrenceClaimPort {
  readonly #now: () => number;
  readonly #claimId: () => string;

  constructor(private readonly dependencies: TaskRuntimeGrantClaimDependencies) {
    this.#now = dependencies.now ?? Date.now;
    this.#claimId = dependencies.claimId ?? randomUUID;
  }

  async #replaceChangedPreclaimPlan(
    current: BackgroundAuthorizationTaskRuntimeRecordV3,
    replacement: BackgroundAuthorizationTaskRuntimeRecordV3,
  ): Promise<ClaimProtectedTaskOccurrenceResult> {
    if (!stableReplacementRecordIdentity(current, replacement)) {
      throw new TypeError(
        "Task Runtime authority replacement changed stable identity",
      );
    }
    if (current.snapshot.state === "claimed"
      || current.snapshot.state === "running") {
      return Object.freeze({ status: "already_claimed" as const });
    }
    if (!["awaiting_recipient", "awaiting_device", "grant_ready"]
      .includes(current.snapshot.state)) {
      return Object.freeze({ status: "inactive" as const });
    }
    const replaced = await this.dependencies.repository
      .replaceUnclaimedTaskRuntimeAuthority({
        expected: current,
        replacement,
        now: this.#now(),
      });
    if (replaced.status === "stale") {
      return staleReplacementResult(replaced.current, replacement);
    }
    this.dependencies.recipients.delete(
      current.snapshot.requestId,
      current.snapshot.recipientGeneration,
    );
    return Object.freeze({ status: "awaiting_authorization" as const });
  }

  async bindAwaitingRecipientForDevice(input: Readonly<{
    occurrence: ProtectedTaskOccurrence;
    binding: TaskRuntimeRecipientDeviceBinding;
    withCurrentAuthority: TaskRuntimeRecipientAuthorityPort;
  }>): Promise<BindTaskRuntimeRecipientResult> {
    if (input.binding.userId !== input.occurrence.task.requestorId) {
      return null;
    }
    const plan = await this.dependencies.plan(input.occurrence);
    const scopeMemory = plan.scopeMemory === undefined
      ? undefined
      : copyTaskScopeMemoryBinding(plan.scopeMemory);
    const targetRoomId = plan.stableIdentity.targetRoomId;
    assertPlan(input.occurrence, plan, scopeMemory);
    const durable = await this.dependencies.repository.get(
      plan.initialRecord.snapshot.requestId,
    );
    if (
      durable === null
      || !isTaskRuntimeRecord(durable)
      || !exactOccurrenceRecord(input.occurrence, durable)
    ) throw new TypeError("Task Runtime durable record was substituted");
    if (!sameDurablePlan(durable, plan.initialRecord)) {
      await this.#replaceChangedPreclaimPlan(durable, plan.initialRecord);
      return null;
    }
    if (
      durable.snapshot.state !== "awaiting_recipient"
      || durable.snapshot.recipient !== null
      || durable.snapshot.descriptorDigest !== null
      || durable.descriptorBytes !== null
    ) {
      return null;
    }
    let used = false;
    const bound = await input.withCurrentAuthority({
      occurrence: input.occurrence,
      record: durable,
      binding: input.binding,
      targetRoomId,
      ...(scopeMemory === undefined ? {} : { scopeMemory }),
      use: async (authority) => {
        if (used) throw new TypeError("Task Runtime recipient binder is one-use");
        used = true;
        if (!recipientAuthorityIsCurrent({
          occurrence: input.occurrence,
          record: durable,
          binding: input.binding,
          ...(scopeMemory === undefined ? {} : { scopeMemory }),
          authority,
        })) return null;
        const now = this.#now();
        const recipient = plan.recipientAttempt({ record: durable, now });
        const attempt = await this.dependencies.recipients.createAttempt({
          requestId: durable.snapshot.requestId,
          workId: durable.snapshot.workId,
          recipientGeneration: durable.snapshot.recipientGeneration,
          recipientKeyId: recipient.recipientKeyId,
          expiresAt: recipient.expiresAt,
        });
        if (attempt.status !== "created") return null;
        let retain = false;
        let request: TaskRuntimeBackgroundAuthorizationRequestV1 | null = null;
        try {
          request = plan.buildRequest({
            record: durable,
            attempt: attempt.attempt,
            binding: input.binding,
            authority,
          });
          if (!exactBoundRequest({
            occurrence: input.occurrence,
            record: durable,
            attempt: attempt.attempt,
            binding: input.binding,
            authority,
            request,
            now,
          })) throw new TypeError("Task Runtime request was substituted");
          const descriptorBytes =
            encodeTaskRuntimeBackgroundAuthorizationRequestV1(request);
          const descriptorDigest = createHash("sha256")
            .update(descriptorBytes)
            .digest("hex");
          const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
            ...durable,
            snapshot: attachBackgroundAuthorizationRecipient(
              durable.snapshot,
              {
                recipientGeneration: durable.snapshot.recipientGeneration,
                descriptorDigest,
                recipientKeyId: attempt.attempt.recipientKeyId,
                recipientPublicKey: Buffer.from(
                  attempt.attempt.recipientPublicKey,
                ).toString("base64url"),
                expiresAt: attempt.attempt.expiresAt,
                now,
              },
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
            descriptorBytes,
          };
          const stored = await this.dependencies.repository.compareAndSwap({
            expectedRequestRevision: durable.snapshot.requestRevision,
            next,
          });
          if (stored.status !== "updated") return null;
          const storedRecipient = stored.record.snapshot.recipient;
          if (
            !isTaskRuntimeRecord(stored.record)
            || !exactOccurrenceRecord(input.occurrence, stored.record)
            || !sameDurablePlan(stored.record, plan.initialRecord)
            || stored.record.snapshot.state !== "awaiting_device"
            || stored.record.snapshot.descriptorDigest !== descriptorDigest
            || stored.record.descriptorBytes === null
            || !sameBytes(stored.record.descriptorBytes, descriptorBytes)
            || storedRecipient === null
            || storedRecipient.recipientKeyId
              !== attempt.attempt.recipientKeyId
            || storedRecipient.recipientPublicKey !== Buffer.from(
              attempt.attempt.recipientPublicKey,
            ).toString("base64url")
            || storedRecipient.expiresAt !== attempt.attempt.expiresAt
          ) throw new TypeError("Task Runtime recipient binding was substituted");
          retain = true;
          return Object.freeze({
            record: stored.record,
            requestBytes: descriptorBytes.slice(),
          });
        } finally {
          if (request !== null) {
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
          }
          if (!retain) {
            this.dependencies.recipients.delete(
              durable.snapshot.requestId,
              durable.snapshot.recipientGeneration,
            );
          }
        }
      },
    });
    return bound;
  }

  async prepareOrClaimExact(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ClaimProtectedTaskOccurrenceResult> {
    const plan = await this.dependencies.plan(occurrence);
    const scopeMemory = plan.scopeMemory === undefined
      ? undefined
      : copyTaskScopeMemoryBinding(plan.scopeMemory);
    const result = assertPlan(occurrence, plan, scopeMemory);
    const existing = await this.dependencies.repository.get(
      plan.initialRecord.snapshot.requestId,
    );
    const durable = existing ?? (await this.dependencies.repository.create(
      plan.initialRecord,
    )).record;
    if (!isTaskRuntimeRecord(durable)
      || !exactOccurrenceRecord(occurrence, durable)) {
      throw new TypeError("Task Runtime durable record was substituted");
    }
    if (!sameDurablePlan(durable, plan.initialRecord)) {
      return this.#replaceChangedPreclaimPlan(durable, plan.initialRecord);
    }
    const current = durable;

    if (current.snapshot.state === "awaiting_recipient") {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }

    if (current.snapshot.state === "awaiting_device"
      || current.snapshot.state === "grant_ready") {
      const now = this.#now();
      const recipient = current.snapshot.recipient;
      if (recipient !== null && (now >= recipient.expiresAt
        || !activeRecipient(this.dependencies.recipients, current))) {
        const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
          ...current,
          snapshot: advanceBackgroundAuthorizationGeneration(
            current.snapshot,
            {
              reason: now >= recipient.expiresAt
                ? "attempt_expired" : "recipient_lost",
              now,
              nextAttemptAt: now,
            },
          ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          descriptorBytes: null,
          acceptedMaterial: null,
        };
        const rotated = await this.dependencies.repository.compareAndSwap({
          expectedRequestRevision: current.snapshot.requestRevision,
          next,
        });
        if (rotated.status === "updated") {
          this.dependencies.recipients.delete(
            current.snapshot.requestId,
            current.snapshot.recipientGeneration,
          );
        }
        return Object.freeze({ status: "awaiting_authorization" as const });
      }
      if (current.snapshot.state === "awaiting_device") {
        return Object.freeze({ status: "awaiting_authorization" as const });
      }
    }
    if (current.snapshot.state === "claimed" || current.snapshot.state === "running") {
      const now = this.#now();
      if (
        current.snapshot.claimExpiresAt !== null
        && now >= current.snapshot.claimExpiresAt
      ) {
        const wasRunning = current.snapshot.state === "running";
        const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
          ...current,
          snapshot: (wasRunning
            ? failBackgroundAuthorizationRequest(
              current.snapshot,
              "provider_outcome_unknown",
              now,
            )
            : advanceBackgroundAuthorizationGeneration(
              current.snapshot,
              { reason: "claim_expired", now, nextAttemptAt: now },
            )) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          ...(wasRunning
            ? { finishedAt: now }
            : { descriptorBytes: null, acceptedMaterial: null }),
        };
        const expired = await this.dependencies.repository.compareAndSwap({
          expectedRequestRevision: current.snapshot.requestRevision,
          next,
        });
        if (expired.status === "updated") {
          this.dependencies.recipients.delete(
            current.snapshot.requestId,
            current.snapshot.recipientGeneration,
          );
          return Object.freeze({
            status: wasRunning ? "inactive" as const : "awaiting_authorization" as const,
          });
        }
        return staleClaimResult(expired.current);
      }
      return Object.freeze({ status: "already_claimed" as const });
    }
    if (
      current.snapshot.state !== "grant_ready"
      || current.acceptedMaterial === null
      || current.snapshot.recipient === null
      || !activeRecipient(this.dependencies.recipients, current)
    ) return Object.freeze({ status: "inactive" as const });

    const request = requestFromRecord(current);
    if (request === null) return Object.freeze({ status: "inactive" as const });
    const now = this.#now();
    const claimExpiresAt = Math.min(
      current.snapshot.recipient.expiresAt,
      current.acceptedMaterial.authorizationExpiresAt,
      now + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
    );
    if (
      now >= current.acceptedMaterial.authorizationExpiresAt
      || claimExpiresAt <= now
    ) {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
      return Object.freeze({ status: "inactive" as const });
    }
    const claimId = this.#claimId();
    try {
      const claimed = await this.dependencies.withCurrentAuthority({
        occurrence,
        record: current,
        request,
        use: async (authority) => {
          if (
            !currentMatchesRequest(authority.foreground, request)
            || !currentMatchesResult(result, current, authority)
          ) return null;
          const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
            ...current,
            snapshot: claimBackgroundAuthorizationRequest(
              current.snapshot,
              claimId,
              now,
              claimExpiresAt,
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          };
          return this.dependencies.repository.compareAndSwap({
            expectedRequestRevision: current.snapshot.requestRevision,
            next,
          });
        },
      });
      if (claimed === null) return Object.freeze({ status: "inactive" as const });
      if (claimed.status === "stale") return staleClaimResult(claimed.current);
      if (!isTaskRuntimeRecord(claimed.record)) {
        throw new TypeError("Task Runtime claim changed credential family");
      }
      const candidate = createCandidate({
        occurrence,
        claimed: claimed.record,
        plan,
        dependencies: this.dependencies,
        claimId,
        result,
      });
      const dispatch: ClaimedProtectedTaskOccurrence = Object.freeze({
        reference: plan.reference,
        scheduling: plan.scheduling,
        executor: plan.executor,
        candidate,
        ...(plan.modelAttribution === undefined
          ? {}
          : { modelAttribution: plan.modelAttribution }),
      });
      return Object.freeze({ status: "claimed" as const, dispatch });
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    }
  }
}

export function createTaskRuntimeGrantClaim(
  dependencies: TaskRuntimeGrantClaimDependencies,
): TaskRuntimeGrantClaim {
  return new TaskRuntimeGrantClaim(dependencies);
}

import { ProtectedTaskExecutionDidNotBeginError } from "../../tasks/protected-task-execution-candidate";
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
  ProtectedTaskExecutionStartResult,
  ProtectedTaskJobSchedulingFacts,
} from "../../tasks/protected-task-execution-candidate";
import type { ProtectedTaskJobReferenceV1 } from
  "../../tasks/protected-task-job-reference";
import type {
  ClaimedProtectedTaskOccurrence,
  ClaimProtectedTaskOccurrenceResult,
  ProtectedTaskOccurrenceClaimPort,
} from "../../tasks/protected-task-occurrence-coordinator";
import type {
  ProtectedTaskAuthorityOccurrence,
  ProtectedTaskOccurrence,
  ProtectedTaskRunningOccurrence,
} from "../../tasks/task-observer";
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
  sameBackgroundAuthorizationRecord,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "./repository";
import { isExactCompletedTaskRuntimeSuccessor } from
  "./task-runtime-completion";

type HeldTaskRuntimeAuthority = Readonly<{
  foreground: DomainForegroundAuthorizationPublicCurrentAuthorityV2;
  namespaceRequirements: CurrentTaskRuntimeAuthority["namespaceRequirements"];
}>;

type CurrentTaskRuntimeAuthorityPort = <Value>(input: Readonly<{
  occurrence: ProtectedTaskAuthorityOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  use(
    current: HeldTaskRuntimeAuthority,
  ): Value | Promise<Value>;
}>) => Promise<Value | null>;

type CurrentTaskRuntimeClaimAuthorityPort = <Value>(input: Readonly<{
  occurrence: ProtectedTaskOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
  now(): number;
  use(
    current: HeldTaskRuntimeAuthority,
    repository: Pick<
      BackgroundAuthorizationTaskRuntimeReplacementRepository,
      "compareAndSwap"
    >,
    claimedAt: number,
    claimExpiresAt: number,
  ): Value | Promise<Value>;
}>) => Promise<Value | null>;

/** Held parked authority owner for the exact grant_ready -> claimed CAS. */
export type ParkedTaskRuntimeClaimAuthorityPort =
  CurrentTaskRuntimeClaimAuthorityPort;

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
    repository: Pick<BackgroundAuthorizationTaskRuntimeReplacementRepository,
      "get" | "compareAndSwap">,
  ): Value | Promise<Value>;
}>) => Promise<Value | null>;

export type BindTaskRuntimeRecipientResult = Readonly<{
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  requestBytes: Uint8Array;
}> | null;

/** Exact request construction retained by both initial and parked Task owners. */
export type TaskRuntimeRecipientRequestPlan = Readonly<{
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  scopeMemory?: TaskScopeMemoryBinding;
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
}>;

export type AttachExactTaskRuntimeRecipientInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  /** Durable row used by the caller to enter its current-authority owner. */
  selected: BackgroundAuthorizationTaskRuntimeRecordV3;
  plan: TaskRuntimeRecipientRequestPlan;
  binding: TaskRuntimeRecipientDeviceBinding;
  authority: TaskRuntimeRecipientCurrentAuthority;
  repository: Pick<BackgroundAuthorizationTaskRuntimeReplacementRepository,
    "get" | "compareAndSwap">;
  recipients: TaskRuntimeRecipientRegistry;
  now: () => number;
}>;

export type RotateExpiredTaskRuntimeRecipientResult = Readonly<{
  status: "rotated" | "not_due" | "stale" | "inactive";
}>;

export type RotateExpiredTaskRuntimeRecipientInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  /** Durable row selected before entering the mutation boundary. */
  selected: BackgroundAuthorizationTaskRuntimeRecordV3;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  repository: Pick<BackgroundAuthorizationTaskRuntimeReplacementRepository,
    "get" | "compareAndSwap">;
  recipients: TaskRuntimeRecipientRegistry;
  now: () => number;
}>;

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

type TaskRuntimeExecutionOpenInput = Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  reference: ProtectedTaskJobReferenceV1;
  domains: readonly DomainForegroundSecretEntry[];
  evidence: TaskRuntimeExecutionEvidence;
  signal: AbortSignal;
}>;

type TaskRuntimeExecutionPublishInput = TaskRuntimeExecutionOpenInput & Readonly<{
  payload: TaskRunResultPayloadV1;
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
  deferBeforeExecution?(input: StartProtectedTaskRunInput): Promise<boolean>;
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
  openTransientInput(
    input: TaskRuntimeExecutionOpenInput,
  ): Promise<Record<string, unknown>>;
  publishResult(input: TaskRuntimeExecutionPublishInput): Promise<void>;
}>;

export type ParkedTaskRuntimeExecutionStartInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  claimed: BackgroundAuthorizationTaskRuntimeRecordV3;
  claimId: string;
  jobId: string;
  reference: ProtectedTaskJobReferenceV1;
}>;

export type ParkedTaskRuntimeGrantClaimPlan = Readonly<{
  stableIdentity: TaskRuntimeGrantStableIdentity;
  initialRecord: BackgroundAuthorizationTaskRuntimeRecordV3;
  reference: ProtectedTaskJobReferenceV1;
  scheduling: ProtectedTaskJobSchedulingFacts;
  executor: JobExecutor;
  scopeMemory?: TaskScopeMemoryBinding;
  modelAttribution?: "external";
  start(
    input: ParkedTaskRuntimeExecutionStartInput,
  ): Promise<ProtectedTaskExecutionStartResult>;
  deferBeforeExecution?(
    input: ParkedTaskRuntimeExecutionStartInput,
  ): Promise<boolean>;
  openTransientInput(
    input: TaskRuntimeExecutionOpenInput,
  ): Promise<Record<string, unknown>>;
  publishResult(input: TaskRuntimeExecutionPublishInput): Promise<void>;
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
  withCurrentClaimAuthority: CurrentTaskRuntimeClaimAuthorityPort;
  withCurrentAuthority: CurrentTaskRuntimeAuthorityPort;
  now?: () => number;
  claimId?: () => string;
}

export interface ParkedTaskRuntimeGrantClaimDependencies {
  repository: Pick<
    BackgroundAuthorizationTaskRuntimeReplacementRepository,
    "get" | "compareAndSwap"
  >;
  recipients: TaskRuntimeRecipientRegistry;
  plan(
    occurrence: ProtectedTaskOccurrence,
  ): Promise<ParkedTaskRuntimeGrantClaimPlan | null>
    | ParkedTaskRuntimeGrantClaimPlan
    | null;
  withCurrentClaimAuthority: ParkedTaskRuntimeClaimAuthorityPort;
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
  occurrence: ProtectedTaskAuthorityOccurrence,
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

export function sameTaskRuntimeAuthorityPlan(
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

function parkedScopeNamespaceRequirements(
  plan: ParkedTaskRuntimeGrantClaimPlan,
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
  return expectedIds.every(namespaceId => {
    const matches = requirements.filter(requirement =>
      requirement.namespaceId === namespaceId
    );
    const requiredOperations = encryptable.has(namespaceId)
      ? (["decrypt", "encrypt"] as const)
      : (["decrypt"] as const);
    return matches.length === 1
      && requiredOperations.every(operation =>
        matches[0]!.operations.includes(operation)
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

function assertParkedPlan(
  occurrence: ProtectedTaskOccurrence,
  plan: ParkedTaskRuntimeGrantClaimPlan,
  scopeMemory: TaskScopeMemoryBinding | undefined,
): TaskRuntimeResultBinding {
  const initial = plan.initialRecord;
  const identity = plan.stableIdentity;
  const resultObjectId = deriveTaskContentCryptoObjectIdV1({
    kind: "run_result",
    taskId: occurrence.task.id,
    taskRunId: occurrence.run.id,
    contentRevision: 1,
  });
  const outputNamespaces = initial.authoritySet?.namespaceRequirements.filter(
    requirement => requirement.namespaceId === occurrence.task.contentNamespaceId,
  ) ?? [];
  const outputNamespace = outputNamespaces[0];
  const outputDomains = outputNamespace === undefined
    ? []
    : initial.authoritySet?.domainRequirements.filter(requirement =>
      requirement.domainId === outputNamespace.domainId
    ) ?? [];
  const outputDomain = outputDomains[0];
  if (
    !isTaskRuntimeRecord(initial)
    || !exactUnclaimedParkedInitialRecord(occurrence, identity, initial)
    || initial.idempotencyKey !== taskRuntimeStableIdempotencyKey(identity)
    || (identity.memoryMode === "scope"
      ? scopeMemory === undefined
        || scopeMemory.scopeId !== identity.scopeId
        || !parkedScopeNamespaceRequirements(plan, scopeMemory)
      : scopeMemory !== undefined)
    || plan.reference.taskId !== occurrence.task.id
    || plan.reference.taskRunId !== occurrence.run.id
    || plan.reference.resultObjectId !== resultObjectId
    || plan.reference.inputObjectId !== occurrence.task.cryptoObjectId
    || plan.reference.authorizationRequestId !== initial.snapshot.requestId
    || plan.reference.policyRevision !== initial.expectedPolicyRevision
    || plan.reference.executionSegment !== identity.executionSegment
    || !Object.hasOwn(plan.reference, "resumeContinuationFingerprint")
    || Object.hasOwn(plan.reference, "resumeAcceptanceId")
    || plan.reference.resumeContinuationFingerprint
      !== identity.resumeContinuationFingerprint
    || plan.scheduling.ownerId !== occurrence.task.ownerId
    || plan.scheduling.requestorId !== occurrence.task.requestorId
    || plan.scheduling.agentId !== occurrence.task.agentId
    || plan.scheduling.roomId !== identity.targetRoomId
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
    || typeof plan.start !== "function"
    || typeof plan.openTransientInput !== "function"
    || typeof plan.publishResult !== "function"
  ) throw new TypeError("Parked Task Runtime grant plan disagrees with its occurrence");
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

function copyRecipientCurrentAuthority(
  authority: TaskRuntimeRecipientCurrentAuthority,
): TaskRuntimeRecipientCurrentAuthority {
  return Object.freeze({
    ...authority,
    device: Object.freeze({
      ...authority.device,
      signingPublicKey: authority.device.signingPublicKey.slice(),
      headDigest: authority.device.headDigest.slice(),
    }),
    domains: Object.freeze(authority.domains.map((domain) => Object.freeze({
      ...domain,
      participantDigest: domain.participantDigest.slice(),
      headDigest: domain.headDigest.slice(),
      activeNamespaceBindingSetDigest:
        domain.activeNamespaceBindingSetDigest.slice(),
    }))),
    namespaceRequirements: Object.freeze(
      authority.namespaceRequirements.map((requirement) => Object.freeze({
        ...requirement,
        operations: Object.freeze([...requirement.operations]),
      })),
    ),
    ...(authority.scopeMemory === undefined
      ? {}
      : { scopeMemory: copyTaskScopeMemoryBinding(authority.scopeMemory) }),
  });
}

function copyOccurrence(
  occurrence: ProtectedTaskOccurrence,
): ProtectedTaskOccurrence {
  return Object.freeze({
    task: Object.freeze({
      ...occurrence.task,
      cryptoRequiredNamespaceFingerprint:
        occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
    }),
    run: Object.freeze({
      ...occurrence.run,
      startedAt: new Date(occurrence.run.startedAt.getTime()),
    }),
  });
}

function copyTaskRuntimeRecord(
  value: BackgroundAuthorizationTaskRuntimeRecordV3,
  message: string,
): BackgroundAuthorizationTaskRuntimeRecordV3 {
  const parsed = parseBackgroundAuthorizationRecord(value);
  if (!isTaskRuntimeRecord(parsed)) throw new TypeError(message);
  return parsed;
}

/**
 * Attach one process-local Task recipient while the caller holds its exact
 * initial or parked authority. The supplied repository must be bound to that
 * authority callback; this helper never replaces a changed durable plan.
 */
export async function attachExactTaskRuntimeRecipient(
  input: AttachExactTaskRuntimeRecipientInput,
): Promise<BindTaskRuntimeRecipientResult> {
  const occurrence = copyOccurrence(input.occurrence);
  const selected = copyTaskRuntimeRecord(
    input.selected,
    "Task Runtime selected recipient record is invalid",
  );
  const initial = copyTaskRuntimeRecord(
    input.plan.initialRecord,
    "Task Runtime recipient plan is invalid",
  );
  const binding = Object.freeze({ ...input.binding });
  const authority = copyRecipientCurrentAuthority(input.authority);
  const scopeMemory = input.plan.scopeMemory === undefined
    ? undefined
    : copyTaskScopeMemoryBinding(input.plan.scopeMemory);
  const recipientAttempt = input.plan.recipientAttempt.bind(input.plan);
  const buildRequest = input.plan.buildRequest.bind(input.plan);
  const repository = input.repository;
  const recipients = input.recipients;
  const nowClock = input.now;
  if (typeof repository?.get !== "function"
    || typeof repository.compareAndSwap !== "function"
    || typeof recipients?.createAttempt !== "function"
    || typeof recipients.delete !== "function"
    || typeof nowClock !== "function"
    || typeof recipientAttempt !== "function"
    || typeof buildRequest !== "function"
    || !exactOccurrenceRecord(occurrence, selected)
    || !sameTaskRuntimeAuthorityPlan(selected, initial)
    || selected.snapshot.state !== "awaiting_recipient"
    || selected.snapshot.recipient !== null
    || selected.snapshot.descriptorDigest !== null
    || selected.descriptorBytes !== null) {
    throw new TypeError("Task Runtime recipient attachment is invalid");
  }

  const loaded = await repository.get(selected.snapshot.requestId);
  if (loaded === null) return null;
  if (!isTaskRuntimeRecord(loaded)
    || !exactOccurrenceRecord(occurrence, loaded)) {
    throw new TypeError("Task Runtime durable record was substituted");
  }
  if (loaded.snapshot.requestRevision !== selected.snapshot.requestRevision
    || !sameTaskRuntimeAuthorityPlan(loaded, initial)
    || loaded.snapshot.state !== "awaiting_recipient"
    || loaded.snapshot.recipient !== null
    || loaded.snapshot.descriptorDigest !== null
    || loaded.descriptorBytes !== null) return null;
  const durable = copyTaskRuntimeRecord(
    loaded,
    "Task Runtime durable record was substituted",
  );
  if (!recipientAuthorityIsCurrent({
    occurrence,
    record: durable,
    binding,
    ...(scopeMemory === undefined ? {} : { scopeMemory }),
    authority,
  })) return null;

  const now = nowClock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Task Runtime recipient clock is invalid");
  }
  const recipient = recipientAttempt({ record: durable, now });
  const attempt = await recipients.createAttempt({
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
    request = buildRequest({
      record: durable,
      attempt: attempt.attempt,
      binding,
      authority,
    });
    if (!exactBoundRequest({
      occurrence,
      record: durable,
      attempt: attempt.attempt,
      binding,
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
      snapshot: attachBackgroundAuthorizationRecipient(durable.snapshot, {
        recipientGeneration: durable.snapshot.recipientGeneration,
        descriptorDigest,
        recipientKeyId: attempt.attempt.recipientKeyId,
        recipientPublicKey: Buffer.from(
          attempt.attempt.recipientPublicKey,
        ).toString("base64url"),
        expiresAt: attempt.attempt.expiresAt,
        now,
      }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
      descriptorBytes,
    };
    const stored = await repository.compareAndSwap({
      expectedRequestRevision: durable.snapshot.requestRevision,
      next,
    });
    if (stored.status !== "updated") return null;
    const storedRecipient = stored.record.snapshot.recipient;
    if (!isTaskRuntimeRecord(stored.record)
      || !exactOccurrenceRecord(occurrence, stored.record)
      || !sameTaskRuntimeAuthorityPlan(stored.record, initial)
      || stored.record.snapshot.state !== "awaiting_device"
      || stored.record.snapshot.descriptorDigest !== descriptorDigest
      || stored.record.descriptorBytes === null
      || !sameBytes(stored.record.descriptorBytes, descriptorBytes)
      || storedRecipient === null
      || storedRecipient.recipientKeyId !== attempt.attempt.recipientKeyId
      || storedRecipient.recipientPublicKey !== Buffer.from(
        attempt.attempt.recipientPublicKey,
      ).toString("base64url")
      || storedRecipient.expiresAt !== attempt.attempt.expiresAt) {
      throw new TypeError("Task Runtime recipient binding was substituted");
    }
    const finishedAt = nowClock();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < now
      || finishedAt >= storedRecipient.expiresAt) {
      throw new TypeError("Task Runtime recipient expired before commit");
    }
    retain = true;
    return Object.freeze({
      record: stored.record,
      requestBytes: descriptorBytes.slice(),
    });
  } finally {
    if (request !== null) destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    if (!retain) {
      recipients.delete(
        durable.snapshot.requestId,
        durable.snapshot.recipientGeneration,
      );
    }
  }
}

/** Rotate only a durably expired Task recipient; local absence is not expiry. */
export async function rotateExpiredTaskRuntimeRecipient(
  input: RotateExpiredTaskRuntimeRecipientInput,
): Promise<RotateExpiredTaskRuntimeRecipientResult> {
  const occurrence = copyOccurrence(input.occurrence);
  const selected = copyTaskRuntimeRecord(
    input.selected,
    "Task Runtime selected recipient record is invalid",
  );
  const initial = copyTaskRuntimeRecord(
    input.initialRecord,
    "Task Runtime recipient plan is invalid",
  );
  const repository = input.repository;
  const recipients = input.recipients;
  const nowClock = input.now;
  if (typeof repository?.get !== "function"
    || typeof repository.compareAndSwap !== "function"
    || typeof recipients?.delete !== "function"
    || typeof nowClock !== "function"
    || !exactOccurrenceRecord(occurrence, selected)
    || !sameTaskRuntimeAuthorityPlan(selected, initial)) {
    throw new TypeError("Task Runtime recipient rotation is invalid");
  }
  const loaded = await repository.get(selected.snapshot.requestId);
  if (loaded === null) return Object.freeze({ status: "stale" as const });
  if (!isTaskRuntimeRecord(loaded)
    || !exactOccurrenceRecord(occurrence, loaded)) {
    throw new TypeError("Task Runtime durable record was substituted");
  }
  if (loaded.snapshot.requestRevision !== selected.snapshot.requestRevision
    || !sameTaskRuntimeAuthorityPlan(loaded, initial)) {
    return Object.freeze({ status: "stale" as const });
  }
  if (loaded.snapshot.state !== "awaiting_device"
    && loaded.snapshot.state !== "grant_ready") {
    return Object.freeze({ status: "inactive" as const });
  }
  const recipient = loaded.snapshot.recipient;
  if (recipient === null) return Object.freeze({ status: "inactive" as const });
  const now = nowClock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError("Task Runtime recipient clock is invalid");
  }
  if (now < recipient.expiresAt) {
    return Object.freeze({ status: "not_due" as const });
  }
  const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
    ...loaded,
    snapshot: advanceBackgroundAuthorizationGeneration(loaded.snapshot, {
      reason: "attempt_expired",
      now,
      nextAttemptAt: now,
    }) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
    descriptorBytes: null,
    acceptedMaterial: null,
  };
  const rotated = await repository.compareAndSwap({
    expectedRequestRevision: loaded.snapshot.requestRevision,
    next,
  });
  if (rotated.status !== "updated") {
    return Object.freeze({ status: "stale" as const });
  }
  if (!isTaskRuntimeRecord(rotated.record)
    || !exactOccurrenceRecord(occurrence, rotated.record)
    || !sameTaskRuntimeAuthorityPlan(rotated.record, initial)
    || rotated.record.snapshot.state !== "awaiting_recipient"
    || rotated.record.snapshot.recipientGeneration
      !== loaded.snapshot.recipientGeneration + 1
    || rotated.record.snapshot.lastRetryReason !== "attempt_expired"
    || rotated.record.snapshot.recipient !== null
    || rotated.record.descriptorBytes !== null
    || rotated.record.acceptedMaterial !== null) {
    throw new TypeError("Task Runtime recipient rotation was substituted");
  }
  recipients.delete(
    loaded.snapshot.requestId,
    loaded.snapshot.recipientGeneration,
  );
  return Object.freeze({ status: "rotated" as const });
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
      && sameTaskRuntimeAuthorityPlan(current, replacement)
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
    if (sameTaskRuntimeAuthorityPlan(record, initial)) {
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

type TaskRuntimeExecutionCandidateInput = Readonly<{
  occurrence: ProtectedTaskOccurrence;
  claimed: BackgroundAuthorizationTaskRuntimeRecordV3;
  reference: ProtectedTaskJobReferenceV1;
  repository: Pick<
    BackgroundAuthorizationTaskRuntimeReplacementRepository,
    "get" | "compareAndSwap"
  >;
  recipients: TaskRuntimeRecipientRegistry;
  withCurrentAuthority: CurrentTaskRuntimeAuthorityPort;
  now: () => number;
  claimId: string;
  result: TaskRuntimeResultBinding;
  start(jobId: string): Promise<ProtectedTaskExecutionStartResult>;
  deferBeforeExecution?(jobId: string): Promise<boolean>;
  openTransientInput(
    input: TaskRuntimeExecutionOpenInput,
  ): Promise<Record<string, unknown>>;
  publishResult(input: TaskRuntimeExecutionPublishInput): Promise<void>;
}>;

function executionTimestamp(
  now: () => number,
  minimum: number,
  message: string,
): number {
  const timestamp = now();
  if (!Number.isSafeInteger(timestamp) || timestamp < minimum) {
    throw new TypeError(message);
  }
  return timestamp;
}

function createTaskRuntimeExecutionCandidate(
  input: TaskRuntimeExecutionCandidateInput,
): ProtectedTaskExecutionCandidate {
  let state: "ready" | "starting" | "started" | "running" | "finished" =
    "ready";
  let runningOccurrence: ProtectedTaskRunningOccurrence | null = null;
  let released = false;
  let startedJobId: string | null = null;
  let deferral: Promise<boolean> | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    input.recipients.delete(
      input.claimed.snapshot.requestId,
      input.claimed.snapshot.recipientGeneration,
    );
  };
  return Object.freeze({
    async start(jobId: string): Promise<StartProtectedTaskRunResult> {
      if (state !== "ready") {
        throw new Error("Task Runtime execution candidate is one-use");
      }
      if (typeof jobId !== "string" || jobId.trim().length === 0) {
        throw new TypeError("Task Runtime Job identity is invalid");
      }
      state = "starting";
      startedJobId = jobId;
      try {
        const result = await input.start(jobId);
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
        runningOccurrence = Object.freeze({
          task: Object.freeze({
            ...input.occurrence.task,
            cryptoRequiredNamespaceFingerprint:
              input.occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
          }),
          run: Object.freeze({
            ...input.occurrence.run,
            jobId,
            status: "running" as const,
            startedAt: new Date(input.occurrence.run.startedAt.getTime()),
          }),
        });
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
      settlement: Readonly<{
        publish(payload: TaskRunResultPayloadV1): Promise<void>;
        park(settle: (parkedAt: number) => Promise<boolean>): Promise<void>;
        awaitSettled(): Promise<boolean>;
      }>,
    ) => Promise<Value>): Promise<Value> {
      if (state === "ready") {
        throw new Error("Task Runtime execution candidate has not started");
      }
      if (state !== "started") {
        throw new Error("Task Runtime execution candidate is one-use");
      }
      const occurrence = runningOccurrence;
      if (occurrence === null) {
        throw new Error("Task Runtime running occurrence is unavailable");
      }
      state = "running";
      let workInvoked = false;
      try {
        const current = await input.repository.get(
          input.claimed.snapshot.requestId,
        );
        if (
          current === null
          || !isTaskRuntimeRecord(current)
          || current.snapshot.state !== "claimed"
          || current.snapshot.claimId !== input.claimId
          || current.snapshot.claimExpiresAt === null
          || current.acceptedMaterial === null
          || !exactOccurrenceRecord(occurrence, current)
          || !resultBindingMatchesRecord(input.result, current)
        ) throw new Error("Task Runtime durable claim is no longer current");
        const request = requestFromRecord(current);
        if (request === null) {
          throw new Error("Task Runtime authorization request is unavailable");
        }
        try {
          const authority = await input.withCurrentAuthority({
            occurrence,
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
            const opened = await input.recipients.withOpenedGrant({
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
                const transientInput = await input.openTransientInput({
                  occurrence,
                  record: current,
                  reference: input.reference,
                  domains,
                  evidence,
                  signal,
                });
                signal.throwIfAborted();
                const runningAt = executionTimestamp(
                  input.now,
                  0,
                  "Task Runtime execution clock is invalid",
                );
                const runningRecord: BackgroundAuthorizationTaskRuntimeRecordV3 = {
                  ...current,
                  snapshot: markBackgroundAuthorizationRunning(
                    current.snapshot,
                    runningAt,
                  ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
                };
                const running = await input.repository.compareAndSwap({
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
                  || !exactOccurrenceRecord(occurrence, storedRunning)
                ) {
                  throw new Error("Task Runtime execution start could not be recorded");
                }
                let settlementCalls = 0;
                let settlementCompleted = false;
                let settlementOpen = true;
                let settlementKind: "published" | "parked" | null = null;
                let parkedAt: number | null = null;
                const pendingSettlements: Promise<void>[] = [];
                const settlement = Object.freeze({
                  publish: (payload: TaskRunResultPayloadV1): Promise<void> => {
                    if (!settlementOpen || settlementCalls !== 0) {
                      throw new Error("Task Runtime execution settlement is one-use");
                    }
                    settlementCalls += 1;
                    settlementKind = "published";
                    signal.throwIfAborted();
                    const pending = input.publishResult({
                      occurrence,
                      record: storedRunning,
                      reference: input.reference,
                      payload,
                      domains,
                      evidence,
                      signal,
                    }).then(() => {
                      settlementCompleted = true;
                    });
                    pendingSettlements.push(pending);
                    return pending;
                  },
                  park: (
                    settle: (parkedAt: number) => Promise<boolean>,
                  ): Promise<void> => {
                    if (!settlementOpen || settlementCalls !== 0
                      || typeof settle !== "function") {
                      throw new Error("Task Runtime execution settlement is one-use");
                    }
                    settlementCalls += 1;
                    settlementKind = "parked";
                    signal.throwIfAborted();
                    parkedAt = executionTimestamp(
                      input.now,
                      runningAt,
                      "Task Runtime park clock is invalid",
                    );
                    const timestamp = parkedAt;
                    const pending = (async () => {
                      if (!await settle(timestamp)) {
                        throw new Error("Task Runtime park settlement was rejected");
                      }
                      settlementCompleted = true;
                    })();
                    pendingSettlements.push(pending);
                    return pending;
                  },
                  awaitSettled: async (): Promise<boolean> => {
                    await Promise.all(pendingSettlements);
                    return settlementCalls === 1 && settlementCompleted;
                  },
                });
                try {
                  workInvoked = true;
                  const result = await work(transientInput, signal, settlement);
                  await Promise.all(pendingSettlements);
                  if (settlementKind !== "parked") signal.throwIfAborted();
                  if (settlementCalls === 1 && settlementCompleted) {
                    const completedAt = parkedAt ?? executionTimestamp(
                      input.now,
                      runningAt,
                      "Task Runtime completion clock is invalid",
                    );
                    const completedRecord:
                      BackgroundAuthorizationTaskRuntimeRecordV3 = {
                        ...storedRunning,
                        snapshot: completeBackgroundAuthorizationRequest(
                          storedRunning.snapshot,
                          completedAt,
                        ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
                        finishedAt: completedAt,
                      };
                    const isExactSettlementSuccessor = (
                      current: BackgroundAuthorizationRecord | null,
                    ): boolean => isExactCompletedTaskRuntimeSuccessor(
                      current,
                      storedRunning,
                    ) && (settlementKind !== "parked" || (
                      current !== null
                      && current.snapshot.updatedAt === completedAt
                      && current.finishedAt === completedAt
                    ));
                    let completionRecorded = false;
                    try {
                      const completed = await input.repository
                        .compareAndSwap({
                          expectedRequestRevision:
                            storedRunning.snapshot.requestRevision,
                          next: completedRecord,
                        });
                      completionRecorded = completed.status === "updated"
                        ? sameBackgroundAuthorizationRecord(
                            completed.record,
                            completedRecord,
                          )
                        : isExactSettlementSuccessor(completed.current);
                    } catch {
                      const current = await input.repository.get(
                        storedRunning.snapshot.requestId,
                      );
                      completionRecorded = isExactSettlementSuccessor(current);
                    }
                    if (!completionRecorded) {
                      throw new Error(
                        "Task Runtime execution completion could not be recorded",
                      );
                    }
                  }
                  return result;
                } catch (error) {
                  await Promise.allSettled(pendingSettlements);
                  throw error;
                } finally {
                  settlementOpen = false;
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
      } catch (error) {
        // The outer finally releases recipient custody before the caller sees this.
        if (!workInvoked) throw new ProtectedTaskExecutionDidNotBeginError();
        throw error;
      } finally {
        state = "finished";
        release();
      }
    },
    deferBeforeExecution(jobId: string): Promise<boolean> {
      if (state !== "finished" || startedJobId !== jobId
        || input.deferBeforeExecution === undefined) {
        return Promise.resolve(false);
      }
      deferral ??= input.deferBeforeExecution(jobId);
      return deferral;
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
    if (!sameTaskRuntimeAuthorityPlan(durable, plan.initialRecord)) {
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
    let attached: BindTaskRuntimeRecipientResult = null;
    const clearAttempt = () => {
      if (attached === null) return;
      this.dependencies.recipients.delete(
        attached.record.snapshot.requestId,
        attached.record.snapshot.recipientGeneration,
      );
      attached.requestBytes.fill(0);
    };
    try {
      const bound = await input.withCurrentAuthority({
        occurrence: input.occurrence,
        record: durable,
        binding: input.binding,
        targetRoomId,
        ...(scopeMemory === undefined ? {} : { scopeMemory }),
        use: async (authority, repository) => {
          if (used) throw new TypeError("Task Runtime recipient binder is one-use");
          used = true;
          attached = await attachExactTaskRuntimeRecipient({
            occurrence: input.occurrence,
            selected: durable,
            plan,
            binding: input.binding,
            authority,
            repository,
            recipients: this.dependencies.recipients,
            now: this.#now,
          });
          return attached;
        },
      });
      if (bound !== attached) {
        clearAttempt();
        if (bound !== null) {
          throw new TypeError("Task Runtime recipient owner changed its receipt");
        }
      }
      return bound;
    } catch (error) {
      clearAttempt();
      throw error;
    }
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
    if (!sameTaskRuntimeAuthorityPlan(durable, plan.initialRecord)) {
      return this.#replaceChangedPreclaimPlan(durable, plan.initialRecord);
    }
    const current = durable;

    if (current.snapshot.state === "awaiting_recipient") {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }

    if (current.snapshot.state === "awaiting_device"
      || current.snapshot.state === "grant_ready") {
      const rotation = await rotateExpiredTaskRuntimeRecipient({
        occurrence,
        selected: current,
        initialRecord: plan.initialRecord,
        repository: this.dependencies.repository,
        recipients: this.dependencies.recipients,
        now: this.#now,
      });
      if (rotation.status === "rotated" || rotation.status === "stale") {
        return Object.freeze({ status: "awaiting_authorization" as const });
      }
      if (current.snapshot.state === "awaiting_device") {
        return Object.freeze({ status: "awaiting_authorization" as const });
      }
      // A different process can retain the live recipient. Its absence from
      // this registry cannot invalidate the durable grant before expiry.
      if (current.snapshot.recipient !== null
        && !activeRecipient(this.dependencies.recipients, current)) {
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
    const recipient = current.snapshot.recipient;
    const acceptedMaterial = current.acceptedMaterial;
    const claimId = this.#claimId();
    try {
      const claimed = await this.dependencies.withCurrentClaimAuthority({
        occurrence,
        record: current,
        request,
        now: this.#now,
        use: async (authority, repository, claimedAt, claimExpiresAt) => {
          const expectedClaimExpiresAt = Math.min(
            request.deadlineAt,
            recipient.expiresAt,
            acceptedMaterial.authorizationExpiresAt,
            claimedAt + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
          );
          if (
            !Number.isSafeInteger(claimedAt)
            || claimedAt < 0
            || claimedAt >= acceptedMaterial.authorizationExpiresAt
            || claimExpiresAt !== expectedClaimExpiresAt
            || claimExpiresAt <= claimedAt
            || !currentMatchesRequest(authority.foreground, request)
            || !currentMatchesResult(result, current, authority)
          ) return null;
          const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
            ...current,
            snapshot: claimBackgroundAuthorizationRequest(
              current.snapshot,
              claimId,
              claimedAt,
              claimExpiresAt,
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          };
          return repository.compareAndSwap({
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
      let startInput: StartProtectedTaskRunInput | null = null;
      const candidate = createTaskRuntimeExecutionCandidate({
        occurrence,
        claimed: claimed.record,
        reference: plan.reference,
        repository: this.dependencies.repository,
        recipients: this.dependencies.recipients,
        withCurrentAuthority: this.dependencies.withCurrentAuthority,
        now: this.#now,
        claimId,
        result,
        start: (jobId) => {
          startInput = {
            taskId: occurrence.task.id,
            taskRunId: occurrence.run.id,
            graphThreadId: occurrence.run.graphThreadId,
            jobId,
            contentRepresentation: occurrence.task.contentRepresentation,
            contentNamespaceId: occurrence.task.contentNamespaceId,
            contentRevision: occurrence.task.contentRevision,
            cryptoObjectId: occurrence.task.cryptoObjectId,
            cryptoAccessRevision: occurrence.task.cryptoAccessRevision,
            cryptoRequiredNamespaceFingerprint:
              occurrence.task.cryptoRequiredNamespaceFingerprint.slice(),
            jobReference: plan.reference,
          };
          return plan.startProtectedTaskRun(startInput);
        },
        ...(plan.deferBeforeExecution === undefined
          ? {}
          : {
              deferBeforeExecution: (jobId: string) => {
                const exact = startInput;
                if (exact === null || exact.jobId !== jobId) {
                  return Promise.resolve(false);
                }
                return plan.deferBeforeExecution!(exact);
              },
            }),
        openTransientInput: plan.openTransientInput,
        publishResult: plan.publishResult,
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

/** Claims only an already prepared continuation request for one parked run. */
class ParkedTaskRuntimeGrantClaim implements ProtectedTaskOccurrenceClaimPort {
  readonly #now: () => number;
  readonly #claimId: () => string;

  constructor(
    private readonly dependencies: ParkedTaskRuntimeGrantClaimDependencies,
  ) {
    this.#now = dependencies.now ?? Date.now;
    this.#claimId = dependencies.claimId ?? randomUUID;
  }

  async prepareOrClaimExact(
    observed: ProtectedTaskOccurrence,
  ): Promise<ClaimProtectedTaskOccurrenceResult> {
    const occurrence = copyOccurrence(observed);
    const plan = await this.dependencies.plan(occurrence);
    if (plan === null) {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }
    const scopeMemory = plan.scopeMemory === undefined
      ? undefined
      : copyTaskScopeMemoryBinding(plan.scopeMemory);
    const result = assertParkedPlan(occurrence, plan, scopeMemory);
    const loaded = await this.dependencies.repository.get(
      plan.initialRecord.snapshot.requestId,
    );
    if (loaded === null) {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }
    if (!isTaskRuntimeRecord(loaded)
      || !exactOccurrenceRecord(occurrence, loaded)) {
      throw new TypeError("Parked Task Runtime durable record was substituted");
    }
    if (!sameTaskRuntimeAuthorityPlan(loaded, plan.initialRecord)
      || loaded.idempotencyKey
        !== taskRuntimeStableIdempotencyKey(plan.stableIdentity)) {
      throw new TypeError("Parked Task Runtime durable authority was substituted");
    }
    if (loaded.snapshot.state === "claimed"
      || loaded.snapshot.state === "running") {
      return Object.freeze({ status: "already_claimed" as const });
    }
    if (loaded.snapshot.state === "awaiting_recipient"
      || loaded.snapshot.state === "awaiting_device") {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }
    if (loaded.snapshot.state !== "grant_ready"
      || loaded.acceptedMaterial === null
      || loaded.snapshot.recipient === null) {
      return Object.freeze({ status: "inactive" as const });
    }
    const now = executionTimestamp(
      this.#now,
      0,
      "Parked Task Runtime claim clock is invalid",
    );
    if (now >= loaded.snapshot.recipient.expiresAt
      || now >= loaded.acceptedMaterial.authorizationExpiresAt
      || !activeRecipient(this.dependencies.recipients, loaded)) {
      return Object.freeze({ status: "awaiting_authorization" as const });
    }

    const request = requestFromRecord(loaded);
    if (request === null) return Object.freeze({ status: "inactive" as const });
    const recipient = loaded.snapshot.recipient;
    const acceptedMaterial = loaded.acceptedMaterial;
    const claimId = this.#claimId();
    try {
      const claimed = await this.dependencies.withCurrentClaimAuthority({
        occurrence,
        record: loaded,
        request,
        now: this.#now,
        use: async (authority, repository, claimedAt, claimExpiresAt) => {
          const expectedClaimExpiresAt = Math.min(
            request.deadlineAt,
            recipient.expiresAt,
            acceptedMaterial.authorizationExpiresAt,
            claimedAt + BACKGROUND_AUTHORIZATION_MAX_CLAIM_LEASE_MS,
          );
          if (!Number.isSafeInteger(claimedAt)
            || claimedAt < now
            || claimedAt >= acceptedMaterial.authorizationExpiresAt
            || claimExpiresAt !== expectedClaimExpiresAt
            || claimExpiresAt <= claimedAt
            || !currentMatchesRequest(authority.foreground, request)
            || !currentMatchesResult(result, loaded, authority)) return null;
          const next: BackgroundAuthorizationTaskRuntimeRecordV3 = {
            ...loaded,
            snapshot: claimBackgroundAuthorizationRequest(
              loaded.snapshot,
              claimId,
              claimedAt,
              claimExpiresAt,
            ) as BackgroundAuthorizationTaskRuntimeRecordV3["snapshot"],
          };
          return repository.compareAndSwap({
            expectedRequestRevision: loaded.snapshot.requestRevision,
            next,
          });
        },
      });
      if (claimed === null) return Object.freeze({ status: "inactive" as const });
      if (claimed.status === "stale") return staleClaimResult(claimed.current);
      if (!isTaskRuntimeRecord(claimed.record)
        || claimed.record.snapshot.state !== "claimed"
        || claimed.record.snapshot.claimId !== claimId
        || !exactOccurrenceRecord(occurrence, claimed.record)
        || !sameTaskRuntimeAuthorityPlan(claimed.record, plan.initialRecord)
        || claimed.record.idempotencyKey
          !== taskRuntimeStableIdempotencyKey(plan.stableIdentity)) {
        throw new TypeError("Parked Task Runtime claim changed exact authority");
      }

      const claimedRecord = claimed.record;
      let startInput: ParkedTaskRuntimeExecutionStartInput | null = null;
      const candidate = createTaskRuntimeExecutionCandidate({
        occurrence,
        claimed: claimedRecord,
        reference: plan.reference,
        repository: this.dependencies.repository,
        recipients: this.dependencies.recipients,
        withCurrentAuthority: this.dependencies.withCurrentAuthority,
        now: this.#now,
        claimId,
        result,
        start: (jobId) => {
          if (jobId === occurrence.run.jobId) {
            throw new TypeError(
              "Parked Task Runtime continuation requires a fresh Job",
            );
          }
          const exact: ParkedTaskRuntimeExecutionStartInput = Object.freeze({
            occurrence,
            claimed: claimedRecord,
            claimId,
            jobId,
            reference: plan.reference,
          });
          startInput = exact;
          return plan.start(exact);
        },
        ...(plan.deferBeforeExecution === undefined
          ? {}
          : {
              deferBeforeExecution: (jobId: string) => {
                const exact = startInput;
                if (exact === null || exact.jobId !== jobId) {
                  return Promise.resolve(false);
                }
                return plan.deferBeforeExecution!(exact);
              },
            }),
        openTransientInput: plan.openTransientInput,
        publishResult: plan.publishResult,
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

export function createParkedTaskRuntimeGrantClaim(
  dependencies: ParkedTaskRuntimeGrantClaimDependencies,
): ProtectedTaskOccurrenceClaimPort {
  return new ParkedTaskRuntimeGrantClaim(dependencies);
}

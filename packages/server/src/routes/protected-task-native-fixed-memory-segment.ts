import { parseProtectedTaskCheckpointAadBinding } from "@nautilo/db";
import {
  createProtectedTaskAdditionalAuthorityResumeMapV1,
  createProtectedTaskCheckpointPauseController,
  type RunScopeSubagentOpts,
  type ProtectedTaskHumanResumeBindingV1,
} from "@nautilo/agent";
import {
  protectedTaskDefinitionSupportsPolicy,
  type PostgresJsBridgeConnection,
  type SealAndParkProtectedTaskHumanRunInput,
  type SealAndParkProtectedTaskRunInput,
  type SealAndParkProtectedTaskCheckpointRunInput,
} from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  type EncryptionDataOperationOwner,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedMemoryAuthority,
  type ProtectedTaskExecutionSignerAuthority,
  type TaskRunResultPayloadV1,
  type TaskPayloadV1,
} from "@nautilo/lattice-bridge";
import {
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  verifyCryptoPostgresHandle,
  withNativeProtectedTaskDefinitionV1,
  withNativeTaskHumanReplyV1,
  createNativeTaskHumanReplyReadTargetV1,
  type ConversationProductCanonicalTransactionRunner,
  type ConversationProductPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestBase,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  createProtectedTaskFailurePayload,
  createProtectedTaskTranscriptPort,
  ProtectedTaskExecutionDidNotBeginError,
  runProtectedTaskNativeSegment,
  withNativeProtectedTaskCheckpointManifest,
  assertProtectedTaskJobReferenceV1,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type ProtectedTaskNativeExecution,
  type ProtectedTaskOccurrence,
  type ProtectedTaskRunningOccurrence,
  type ProtectedTaskPredispatchPlan,
  type ProtectedTaskTranscriptMessagePublisher,
  type RunProtectedTaskNativeSegmentInput,
  type TaskRuntimeGrantClaimPlan,
} from "@nautilo/runtime";
import type {
  ProtectedRepoDocsExecutionPort,
  ProtectedRepoDocsOpenedSelection,
  ProtectedTaskProjectFilePort,
} from "@nautilo/agent";
import {
  isNamespaceMemoryEnvelope,
  isScopeMemoryEnvelope,
} from "@nautilo/trust";
import { log } from "@nautilo/logger";

import {
  withCurrentProtectedTaskMemoryAuthority,
  type ProtectedTaskMemoryAuthorityInput,
} from "./current-protected-task-memory-authority";
import {
  createCurrentNativeProtectedTaskDefinitionOccurrenceLoader,
} from "./protected-task-native-definition-occurrence";
import {
  withProtectedTaskNativeMemoryRepository,
  type ProtectedTaskNativeMemoryRepositoryInput,
} from "./protected-task-native-memory-repository";
import type {
  ProtectedTaskRuntimeGrantPlanBuilderDependencies,
  ProtectedTaskRuntimeMemoryPolicy,
} from "./protected-task-runtime-grant-plan";
import { withProtectedTaskRuntimeSigner } from "./protected-task-runtime-signer";
import { createProtectedTaskDefinitionForegroundAuthorizationResolver } from
  "./protected-task-runtime-access-lineage";

import { createProtectedTaskNativeReplyAuthorityResolver, createProtectedTaskHistoricalHumanReplySignerResolver } from "./protected-task-native-reply-authority";
import { scheduleProtectedTaskCheckpointRefresh } from "./protected-task-checkpoint-refresh";
import {
  openProtectedTaskRepoDocsSelection,
  type ProtectedTaskRepoDocsSelection,
} from "./protected-task-repo-docs-selection";

type PrepareExecution =
  ProtectedTaskRuntimeGrantPlanBuilderDependencies["prepareExecution"];
type MemoryRepositoryInput = ProtectedTaskNativeMemoryRepositoryInput<unknown>;
type DedicatedPoolFactory = Parameters<
  typeof withNativeProtectedTaskCheckpointManifest
>[0]["createDedicatedPool"];
type MemoryHandoff = NonNullable<
  RunScopeSubagentOpts["protectedTaskMemoryHandoff"]
>;
type FixedExecutionContext = Omit<
  ProtectedTaskNativeExecution,
  | "parentThreadId"
  | "parentTurnId"
  | "parentOwnerId"
  | "causalHumanUserId"
  | "brief"
  | "expectedOutput"
  | "subEnvelope"
  | "actorRole"
  | "roomId"
  | "callingRoomId"
  | "protectedRepoDocs"
> & Readonly<{
  protectedRepoDocsExecutionPort?: ProtectedRepoDocsExecutionPort;
  createProtectedRepoDocsProjectFilePort?: (
    workDir: string,
  ) => ProtectedTaskProjectFilePort;
}>;

export type ProtectedTaskNativeFixedMemorySegmentInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  product: Readonly<{
    handle: ConversationProductPostgresHandle;
    canonicalRunner: ConversationProductCanonicalTransactionRunner;
  }>;
  agentProduct: MemoryRepositoryInput["agentProduct"];
  owner: EncryptionDataOperationOwner;
  embedding: ProtectedAgentMemoryEmbeddingPort;
  createDedicatedPool: DedicatedPoolFactory;
  parkSegment(input: SealAndParkProtectedTaskRunInput
    | SealAndParkProtectedTaskHumanRunInput
    | SealAndParkProtectedTaskCheckpointRunInput): Promise<boolean>;
  /**
   * Fresh local-relay availability check at the last pre-effect boundary.
   * A false result is deferred by the existing unstarted-segment recovery.
   */
  localExecutionReadyBeforeStart?(input: Readonly<{
    occurrence: ProtectedTaskRunningOccurrence;
    signal: AbortSignal;
  }>): Promise<boolean>;
  resolveExecutionContext(input: Readonly<{
    occurrence: ProtectedTaskRunningOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
    protectedMetadata: TaskPayloadV1["protectedMetadata"];
    repoDocs?: ProtectedRepoDocsOpenedSelection;
    signal: AbortSignal;
    assertCurrentTaskAuthority(): Promise<void>;
  }>): FixedExecutionContext | Promise<FixedExecutionContext>;
  /**
   * Construct one segment-local publisher while its Runtime signer and Domain
   * keys are held. The callback and returned publisher must not retain those
   * borrowed values beyond the callback-owned segment run.
   */
  createTranscriptPublisher(input: Readonly<{
    occurrence: ProtectedTaskRunningOccurrence;
    record: BackgroundAuthorizationTaskRuntimeRecordV3;
    request: TaskRuntimeBackgroundAuthorizationRequestV1;
    current: ProtectedTaskMemoryAuthorityInput;
    policy: ProtectedTaskRuntimeMemoryPolicy;
    humanTurnId: string;
    assertCurrentTaskAuthority(): Promise<void>;
    /** Borrowed only while the current Runtime signer owner remains open. */
    domains: readonly DomainForegroundSecretEntry[];
    signer: ProtectedTaskExecutionSignerAuthority;
    resolveHistoricalSignerPublicationManager:
      MemoryRepositoryInput["resolveHistoricalSignerPublicationManager"];
  }>): ProtectedTaskTranscriptMessagePublisher
    | Promise<ProtectedTaskTranscriptMessagePublisher>;
  now?: () => number;
}>;

type SignerUseInput = Readonly<{
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  use(
    signer: ProtectedTaskExecutionSignerAuthority,
    resolveHistoricalSignerPublicationManager:
      MemoryRepositoryInput["resolveHistoricalSignerPublicationManager"],
  ): Promise<unknown>;
}>;

type Dependencies = Readonly<{
  decodeRequest(bytes: Uint8Array, crypto: LatticeCrypto):
    TaskRuntimeBackgroundAuthorizationRequestV1 | null;
  destroyRequest: typeof destroyTaskRuntimeBackgroundAuthorizationRequestV1;
  createDefinitionLoader:
    typeof createCurrentNativeProtectedTaskDefinitionOccurrenceLoader;
  openDefinition: typeof withNativeProtectedTaskDefinitionV1;
  withMemoryRepository: typeof withProtectedTaskNativeMemoryRepository;
  withCheckpointSaver: typeof withNativeProtectedTaskCheckpointManifest;
  createTranscriptPort: typeof createProtectedTaskTranscriptPort;
  runSegment: typeof runProtectedTaskNativeSegment;
  openReply: typeof withNativeTaskHumanReplyV1;
  createReplyAuthority: typeof createProtectedTaskNativeReplyAuthorityResolver;
  replyTarget: typeof createNativeTaskHumanReplyReadTargetV1;
  verifyReplyHandle: typeof verifyCryptoPostgresHandle;
  withCurrentMemoryAuthority: typeof withCurrentProtectedTaskMemoryAuthority;
  withSigner<Value>(input: Omit<SignerUseInput, "use"> & Readonly<{
    use(
      signer: ProtectedTaskExecutionSignerAuthority,
      resolveHistoricalSignerPublicationManager:
        MemoryRepositoryInput["resolveHistoricalSignerPublicationManager"],
    ): Promise<Value>;
  }>): Promise<Value>;
}>;


const productionDependencies: Dependencies = Object.freeze({
  decodeRequest: (bytes, crypto) =>
    decodeTaskRuntimeBackgroundAuthorizationRequestBase(crypto, bytes),
  destroyRequest: destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  createDefinitionLoader:
    createCurrentNativeProtectedTaskDefinitionOccurrenceLoader,
  openDefinition: withNativeProtectedTaskDefinitionV1,
  withMemoryRepository: withProtectedTaskNativeMemoryRepository,
  withCheckpointSaver: withNativeProtectedTaskCheckpointManifest,
  createTranscriptPort: createProtectedTaskTranscriptPort,
  runSegment: runProtectedTaskNativeSegment,
  openReply: withNativeTaskHumanReplyV1,
  createReplyAuthority: createProtectedTaskNativeReplyAuthorityResolver,
  replyTarget: createNativeTaskHumanReplyReadTargetV1,
  verifyReplyHandle: verifyCryptoPostgresHandle,
  withCurrentMemoryAuthority: withCurrentProtectedTaskMemoryAuthority,
  withSigner: withProtectedTaskRuntimeSigner,
});

const TRANSIENT_SEGMENT = "protectedTaskNativeFixedMemorySegment";

type ProtectedTaskFixedMemoryFailurePhase =
  | "PTFMS001" | "PTFMS002" | "PTFMS003" | "PTFMS004"
  | "PTFMS005" | "PTFMS006" | "PTFMS007";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function sameOccurrenceIdentity(
  left: ProtectedTaskOccurrence | ProtectedTaskRunningOccurrence,
  right: ProtectedTaskOccurrence | ProtectedTaskRunningOccurrence,
): boolean {
  return left.task.id === right.task.id
    && left.task.ownerId === right.task.ownerId
    && left.task.requestorId === right.task.requestorId
    && left.task.agentId === right.task.agentId
    && left.task.callingRoomId === right.task.callingRoomId
    && left.task.scheduleKind === right.task.scheduleKind
    && left.task.contentRepresentation === right.task.contentRepresentation
    && left.task.contentNamespaceId === right.task.contentNamespaceId
    && left.task.contentRevision === right.task.contentRevision
    && left.task.cryptoObjectId === right.task.cryptoObjectId
    && left.task.cryptoAccessRevision === right.task.cryptoAccessRevision
    && sameBytes(
      left.task.cryptoRequiredNamespaceFingerprint,
      right.task.cryptoRequiredNamespaceFingerprint,
    )
    && left.run.id === right.run.id
    && left.run.taskId === right.run.taskId
    && left.run.graphThreadId === right.run.graphThreadId
    && left.run.startedAt.getTime() === right.run.startedAt.getTime();
}

function sameOccurrence(
  left: ProtectedTaskOccurrence,
  right: ProtectedTaskOccurrence,
): boolean {
  return sameOccurrenceIdentity(left, right)
    && left.run.jobId === right.run.jobId
    && left.run.status === right.run.status;
}

function sameJobReference(
  left: TaskRuntimeGrantClaimPlan["reference"],
  right: TaskRuntimeGrantClaimPlan["reference"],
): boolean {
  const leftKeys = Object.keys(left).sort().join(",");
  const rightKeys = Object.keys(right).sort().join(",");
  return leftKeys === rightKeys
    && left.kind === right.kind
    && left.taskId === right.taskId
    && left.taskRunId === right.taskRunId
    && left.inputObjectId === right.inputObjectId
    && left.resultObjectId === right.resultObjectId
    && left.authorizationRequestId === right.authorizationRequestId
    && left.policyRevision === right.policyRevision
    && left.executionSegment === right.executionSegment
    && ("resumeAcceptanceId" in left
      ? "resumeAcceptanceId" in right
        && left.resumeAcceptanceId === right.resumeAcceptanceId
      : !("resumeAcceptanceId" in right))
    && ("resumeContinuationFingerprint" in left
      ? "resumeContinuationFingerprint" in right
        && left.resumeContinuationFingerprint
          === right.resumeContinuationFingerprint
      : !("resumeContinuationFingerprint" in right));
}

function executablePolicyMode(
  value: unknown,
): value is "shadow_encryption" | "encrypted_only" {
  return value === "shadow_encryption" || value === "encrypted_only";
}

function exactPreparation(input: Parameters<PrepareExecution>[0]): void {
  const {
    additionalAuthorityResume,
    humanResume,
    occurrence,
    predispatch,
    policy,
    reference,
  } = input;
  assertProtectedTaskJobReferenceV1(reference);
  if (!sameOccurrence(occurrence, predispatch.occurrence)
    || predispatch.scheduling.ownerId !== occurrence.task.ownerId
    || predispatch.scheduling.requestorId !== occurrence.task.requestorId
    || predispatch.scheduling.agentId !== occurrence.task.agentId
    || predispatch.scheduling.graphThreadId !== occurrence.run.graphThreadId
    || predispatch.scheduling.roomId !== predispatch.target.roomId
    || predispatch.scheduling.callingRoomId !== occurrence.task.callingRoomId
    || !Number.isSafeInteger(policy.revision)
    || policy.revision < 1
    || (policy.shadowBehavior !== "fallback"
      && policy.shadowBehavior !== "strict")
    || policy.revision !== reference.policyRevision
    || !executablePolicyMode(policy.mode)
    || !protectedTaskDefinitionSupportsPolicy(
      occurrence.task.contentRepresentation,
      policy.mode,
    )
    || reference.taskId !== occurrence.task.id
    || reference.taskRunId !== occurrence.run.id
    || reference.inputObjectId !== occurrence.task.cryptoObjectId
    || reference.executionSegment > 1 && input.checkpointAadBinding === undefined
    || input.checkpointAadBinding !== undefined && (
      parseProtectedTaskCheckpointAadBinding(input.checkpointAadBinding) === null
      || input.checkpointAadBinding.namespaceId !== occurrence.task.contentNamespaceId
      || input.checkpointAadBinding.policyRevision > policy.revision
      || reference.executionSegment === 1)
    || input.checkpointResume !== undefined && input.checkpointResume !== true
    || (reference.executionSegment === 1
      ? reference.authorizationRequestId
          !== `task-run-authorization:${occurrence.run.id}`
        || "resumeContinuationFingerprint" in reference
        || "resumeAcceptanceId" in reference
        || additionalAuthorityResume !== undefined
        || humanResume !== undefined
        || input.checkpointResume !== undefined
      : "resumeAcceptanceId" in reference
        ? "resumeContinuationFingerprint" in reference
          || additionalAuthorityResume !== undefined
          || humanResume === undefined
          || input.checkpointResume !== undefined
        : !("resumeContinuationFingerprint" in reference)
          || humanResume !== undefined
          || (input.checkpointResume === true
            ? additionalAuthorityResume !== undefined
              || reference.authorizationRequestId !== `task-checkpoint-continuation:${occurrence.run.id}:${reference.executionSegment}:${reference.resumeContinuationFingerprint}`
            : additionalAuthorityResume === undefined
              || additionalAuthorityResume.authorizationRequestId !== reference.authorizationRequestId))
    || !(input.stableRoutingDigest instanceof Uint8Array)
    || input.stableRoutingDigest.length !== 32) {
    throw new TypeError("Protected Task fixed Memory preparation is not exact");
  }
  const envelope = predispatch.memory.envelope;
  if (envelope.ownerId !== occurrence.task.requestorId
    || envelope.agentId !== occurrence.task.agentId
    || (isScopeMemoryEnvelope(envelope)
      ? input.scopeMemory === undefined
        || input.scopeWorkIdentity === undefined
        || input.scopeWorkIdentity.length === 0
        || input.scopeMemory.scopeId !== envelope.scopeId
        || input.scopeMemory.memoryRoomId !== envelope.roomId
        || !("originWritableNamespaceId" in envelope)
        || input.scopeMemory.originWritableNamespaceId
          !== envelope.originWritableNamespaceId
      : input.scopeMemory !== undefined
        || input.scopeWorkIdentity !== undefined
        || !isNamespaceMemoryEnvelope(envelope))) {
    throw new TypeError("Protected Task fixed Memory envelope is not exact");
  }
}

function frozenArrayCopy<Value>(values: readonly Value[]): Value[] {
  const copied = [...values];
  Object.freeze(copied);
  return copied;
}

function freezeTree(value: unknown, seen: WeakSet<object>): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    freezeTree(Reflect.get(value, key), seen);
  }
  Object.freeze(value);
}

function frozenClone<Value>(value: Value): Value {
  const copied = structuredClone(value);
  freezeTree(copied, new WeakSet());
  return copied;
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
      startedAt: new Date(occurrence.run.startedAt),
    }),
  });
}

function copyPredispatch(
  plan: ProtectedTaskPredispatchPlan,
  occurrence: ProtectedTaskOccurrence,
): ProtectedTaskPredispatchPlan {
  const envelope = plan.memory.envelope;
  const copiedEnvelope = isNamespaceMemoryEnvelope(envelope)
    ? Object.freeze({
        ...envelope,
        readableNamespaces: frozenArrayCopy(envelope.readableNamespaces),
        mutableNamespaces: frozenArrayCopy(envelope.mutableNamespaces),
        writableNamespaces: frozenArrayCopy(envelope.writableNamespaces),
        toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
      })
    : Object.freeze({
        ...envelope,
        toolPolicy: Object.freeze({ ...envelope.toolPolicy }),
      });
  return Object.freeze({
    occurrence,
    scheduling: Object.freeze({ ...plan.scheduling }),
    target: Object.freeze({
      ...plan.target,
      targetUserIds: Object.freeze([...plan.target.targetUserIds]),
    }),
    memory: Object.freeze({
      ...plan.memory,
      envelope: copiedEnvelope,
    }),
  });
}

function subjectFromRecord(
  occurrence: ProtectedTaskRunningOccurrence,
  record: BackgroundAuthorizationTaskRuntimeRecordV3,
): ProtectedTaskMemoryAuthorityInput["subject"] {
  const accepted = record.snapshot.acceptedResponse;
  if (accepted === null
    || accepted.kind !== "runtime"
    || accepted.issuingHumanId.length === 0
    || accepted.issuingDeviceId.length === 0) {
    throw new TypeError("Protected Task fixed Memory subject is unavailable");
  }
  return Object.freeze({
    userId: occurrence.task.requestorId,
    humanActorId: accepted.issuingHumanId,
    deviceId: accepted.issuingDeviceId,
  });
}

function exactGrant(input: Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  policy: ProtectedTaskRuntimeMemoryPolicy;
  reference: TaskRuntimeGrantClaimPlan["reference"];
  openedReference: TaskRuntimeGrantClaimPlan["reference"];
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  evidence: TaskRuntimeExecutionEvidence;
  signal: AbortSignal;
}>): void {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  const { occurrence, record, evidence, reference } = input;
  if (!(input.signal instanceof AbortSignal)
    || record.snapshot.state !== "claimed"
    || !sameJobReference(reference, input.openedReference)
    || record.snapshot.requestId !== reference.authorizationRequestId
    || record.snapshot.workId !== occurrence.run.id
    || record.expectedPolicyRevision !== input.policy.revision
    || record.descriptorBytes === null
    || evidence.requestId !== reference.authorizationRequestId
    || evidence.workId !== occurrence.run.id
    || evidence.policyRevision !== input.policy.revision
    || evidence.result.taskId !== occurrence.task.id
    || evidence.result.taskRunId !== occurrence.run.id
    || evidence.result.objectId !== reference.resultObjectId
    || evidence.result.signerAgentId !== occurrence.task.agentId) {
    throw new TypeError("Protected Task fixed Memory grant is not exact");
  }
}

function memoryAuthority(input: Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  predispatch: ProtectedTaskPredispatchPlan;
  subject: ProtectedTaskMemoryAuthorityInput["subject"];
  scopeMemory?: Parameters<PrepareExecution>[0]["scopeMemory"];
}>): ProtectedMemoryAuthority {
  const envelope = input.predispatch.memory.envelope;
  if (envelope.actorId !== input.subject.humanActorId
    || envelope.ownerId !== input.subject.userId
    || envelope.agentId !== input.occurrence.task.agentId) {
    throw new TypeError("Protected Task fixed Memory subject changed");
  }
  if (isNamespaceMemoryEnvelope(envelope)) {
    if (input.scopeMemory !== undefined
      || envelope.writableNamespaces.length === 0) {
      throw new TypeError("Protected Task fixed Namespace Memory is unavailable");
    }
    return Object.freeze({
      mode: "namespace" as const,
      subjectUserId: input.subject.userId,
      agentId: input.occurrence.task.agentId,
      readableNamespaceIds: Object.freeze([
        ...envelope.readableNamespaces,
      ].sort()),
      mutableNamespaceIds: Object.freeze([
        ...envelope.mutableNamespaces,
      ].sort()),
      writableNamespaceId: envelope.writableNamespaces[0]!,
    });
  }
  const scopeMemory = input.scopeMemory;
  if (!isScopeMemoryEnvelope(envelope)
    || scopeMemory === undefined
    || scopeMemory.scopeId !== envelope.scopeId
    || scopeMemory.memoryRoomId !== envelope.roomId
    || !("originWritableNamespaceId" in envelope)
    || scopeMemory.originWritableNamespaceId
      !== envelope.originWritableNamespaceId) {
    throw new TypeError("Protected Task fixed Scope Memory is unavailable");
  }
  return Object.freeze({
    mode: "scope" as const,
    subjectUserId: input.subject.userId,
    agentId: input.occurrence.task.agentId,
    scopeId: scopeMemory.scopeId,
    originWritableNamespaceId: scopeMemory.originWritableNamespaceId,
  });
}

function exactRequest(input: Readonly<{
  occurrence: ProtectedTaskRunningOccurrence;
  reference: TaskRuntimeGrantClaimPlan["reference"];
  evidence: TaskRuntimeExecutionEvidence;
  request: TaskRuntimeBackgroundAuthorizationRequestV1;
}>): void {
  if (input.request.requestId !== input.reference.authorizationRequestId
    || input.request.workId !== input.occurrence.run.id
    || input.request.episodeId !== input.evidence.episodeId
    || input.request.sourceRoomId !== input.evidence.sourceRoomId) {
    throw new TypeError("Protected Task fixed Memory request is not exact");
  }
}

function exactExecutorInput(
  input: Record<string, unknown>,
  occurrence: ProtectedTaskOccurrence | ProtectedTaskRunningOccurrence,
  predispatch: ProtectedTaskPredispatchPlan,
): Readonly<{
  run(
    transientInput: Record<string, unknown>,
    jobId: string,
    jobSignal: AbortSignal,
  ): Promise<void>;
}> {
  const token = input[TRANSIENT_SEGMENT];
  if (input["taskId"] !== occurrence.task.id
    || input["currentTaskId"] !== occurrence.task.id
    || input["taskRunId"] !== occurrence.run.id
    || input["turnId"] !== occurrence.run.id
    || input["graphThreadId"] !== occurrence.run.graphThreadId
    || input["ownerId"] !== occurrence.task.ownerId
    || input["requestorId"] !== occurrence.task.requestorId
    || input["agentId"] !== occurrence.task.agentId
    || input["roomId"] !== predispatch.scheduling.roomId
    || input["callingRoomId"] !== (occurrence.task.callingRoomId ?? "")
    || typeof input["protectedTaskResultPublication"] !== "object"
    || input["protectedTaskResultPublication"] === null
    || typeof (input["protectedTaskResultPublication"] as {
      publish?: unknown;
    }).publish !== "function"
    || typeof (input["protectedTaskResultPublication"] as {
      park?: unknown;
    }).park !== "function"
    || typeof (input["protectedTaskResultPublication"] as {
      awaitSettled?: unknown;
    }).awaitSettled !== "function"
    || typeof token !== "object"
    || token === null
    || typeof (token as { run?: unknown }).run !== "function") {
    throw new TypeError("Protected Task fixed Memory executor identity changed");
  }
  return token as Readonly<{
    run(
      transientInput: Record<string, unknown>,
      jobId: string,
      jobSignal: AbortSignal,
    ): Promise<void>;
  }>;
}

type ResultPublication = Readonly<{
  publish(payload: TaskRunResultPayloadV1): Promise<void>;
  park(settle: (parkedAt: number) => Promise<boolean>): Promise<void>;
  awaitSettled(): Promise<boolean>;
}>;

function resultPublication(input: Record<string, unknown>): ResultPublication {
  const value = input["protectedTaskResultPublication"];
  if (typeof value !== "object" || value === null
    || typeof (value as { publish?: unknown }).publish !== "function"
    || typeof (value as { park?: unknown }).park !== "function"
    || typeof (value as { awaitSettled?: unknown }).awaitSettled !== "function") {
    throw new TypeError(
      "Protected Task fixed Memory result publication changed",
    );
  }
  return value as ResultPublication;
}

function exactExecutionContext(
  value: FixedExecutionContext,
): FixedExecutionContext {
  if (typeof value !== "object" || value === null
    || typeof value.modelId !== "string" || value.modelId.length === 0
    || !Number.isSafeInteger(value.subagentDepth) || value.subagentDepth < 0
    || !Number.isSafeInteger(value.subagentMaxDepth)
    || value.subagentMaxDepth < value.subagentDepth
    || !Array.isArray(value.roomRoster)
    || value.toolWhitelist?.includes("security_scan") === true
    || value.resume !== undefined
    || value.protectedTaskHumanResume !== undefined
    || value.continueFromCheckpoint === true
    || value.awaitReply !== undefined
    || (value.protectedRepoDocsExecutionPort !== undefined
      && (typeof value.protectedRepoDocsExecutionPort.plan !== "function"
        || typeof value.protectedRepoDocsExecutionPort.execute !== "function"
        || typeof value.protectedRepoDocsExecutionPort.inspect !== "function"))
    || (value.createProtectedRepoDocsProjectFilePort !== undefined
      && typeof value.createProtectedRepoDocsProjectFilePort !== "function")) {
    throw new TypeError("Protected Task fixed Memory execution context is invalid");
  }
  return Object.freeze({
    ...value,
    ...(value.toolWhitelist === undefined
      ? {}
      : { toolWhitelist: frozenArrayCopy(value.toolWhitelist) }),
    roomRoster: frozenClone(value.roomRoster),
    ...(value.artifactRefs === undefined
      ? {}
      : { artifactRefs: frozenClone(value.artifactRefs) }),
    ...(value.focusedResources === undefined
      ? {}
      : { focusedResources: frozenClone(value.focusedResources) }),
    ...(value.relayCapabilities === undefined
      ? {}
      : { relayCapabilities: frozenClone(value.relayCapabilities) }),
  });
}

function openFixedProtectedMetadata(
  metadata: TaskPayloadV1["protectedMetadata"],
  repoDocsSelection?: ProtectedTaskRepoDocsSelection,
): ProtectedRepoDocsOpenedSelection | undefined {
  const allowed = new Set(["preparation", "lastInterruption"]);
  if (repoDocsSelection === undefined) {
    if (!Reflect.ownKeys(metadata).some(key =>
      typeof key !== "string" || !allowed.has(key)
    )) return undefined;
    throw new TypeError(
      "Protected Task fixed Memory definition requires a specialized route",
    );
  }
  const opened = openProtectedTaskRepoDocsSelection(repoDocsSelection, metadata);
  if (opened === null) {
    throw new TypeError("Protected repo docs definition changed");
  }
  return opened;
}

/**
 * Build an unmounted native Task preparation whose fixed Memory repository,
 * signer and checkpoint saver remain alive only while one graph segment runs.
 */
export function createProtectedTaskNativeFixedMemorySegment(
  input: ProtectedTaskNativeFixedMemorySegmentInput,
  overrides: Partial<Dependencies> = {},
  options: Readonly<{ repoDocsSelection?: ProtectedTaskRepoDocsSelection }> = {},
): PrepareExecution {
  if (input.serverScope.trim().length === 0
    || input.product.handle.role !== "nautilo"
    || input.agentProduct.handle.role !== "nautilo_agent") {
    throw new TypeError("Protected Task fixed Memory composition is unavailable");
  }
  const dependencies = Object.freeze({ ...productionDependencies, ...overrides });
  const now = input.now ?? Date.now;
  const loadDefinition = dependencies.createDefinitionLoader(
    {},
    options.repoDocsSelection === undefined
      ? { requireNativeExecution: true }
      : { requireRepoDocsSelection: options.repoDocsSelection },
  );

  return preparation => {
    exactPreparation(preparation);
    const occurrence = copyOccurrence(preparation.occurrence);
    const predispatch = copyPredispatch(preparation.predispatch, occurrence);
    const policy = Object.freeze({ ...preparation.policy });
    const reference = Object.freeze({ ...preparation.reference });
    const stableRoutingDigest = preparation.stableRoutingDigest.slice();
    const checkpointAadBinding = preparation.checkpointAadBinding === undefined
      ? undefined : Object.freeze({ ...preparation.checkpointAadBinding });
    const checkpointPauseController = createProtectedTaskCheckpointPauseController();
    let checkpointPauseRequestId: string | null = null;
    const requestCheckpointPause: NonNullable<TaskRuntimeGrantClaimPlan["requestCheckpointPause"]> = (reason, requestId) => {
      if (reason !== "grant_refresh" && (typeof requestId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(requestId))
        || reason === "grant_refresh" && requestId !== undefined) return false;
      if (!checkpointPauseController.request(reason)) return false;
      checkpointPauseRequestId = requestId ?? null;
      return true;
    };
    const humanResume = preparation.humanResume === undefined
      ? undefined : frozenClone(preparation.humanResume);
    const additionalAuthorityResume = preparation.additionalAuthorityResume
      === undefined
      ? undefined
      : createProtectedTaskAdditionalAuthorityResumeMapV1(
          preparation.additionalAuthorityResume,
        );
    const scopeMemory = preparation.scopeMemory === undefined
      ? undefined
      : Object.freeze({
          ...preparation.scopeMemory,
          readableNamespaceIds: Object.freeze([
            ...preparation.scopeMemory.readableNamespaceIds,
          ]),
        });
    const scopeWorkIdentity = preparation.scopeWorkIdentity;
    if (scopeMemory !== undefined && scopeWorkIdentity === undefined) {
      throw new TypeError("Protected Task fixed Scope Memory identity is unavailable");
    }

    const issuedSegmentTokens = new WeakSet<object>();
    const executor: TaskRuntimeGrantClaimPlan["executor"] = async function* (
      transientInput,
      jobId,
      laneKey,
      jobSignal,
    ) {
      if (laneKey !== `task:${occurrence.task.id}`
        || typeof jobId !== "string" || jobId.length === 0
        || !(jobSignal instanceof AbortSignal)) {
        throw new TypeError("Protected Task fixed Memory Job identity changed");
      }
      const token = exactExecutorInput(transientInput, occurrence, predispatch);
      if (!issuedSegmentTokens.has(token)) {
        throw new TypeError("Protected Task fixed Memory segment was reused or not issued");
      }
      issuedSegmentTokens.delete(token);
      await token.run(transientInput, jobId, jobSignal);
      yield* [];
    };

    const openTransientInput: TaskRuntimeGrantClaimPlan["openTransientInput"] =
      async grant => {
        if (grant.occurrence.run.status !== "running"
          || typeof grant.occurrence.run.jobId !== "string"
          || grant.occurrence.run.jobId.length === 0
          || !sameOccurrenceIdentity(occurrence, grant.occurrence)) {
          throw new TypeError("Protected Task fixed Memory occurrence changed");
        }
        const runningOccurrence = grant.occurrence;
        exactGrant({
          occurrence: runningOccurrence,
          policy,
          reference,
          openedReference: grant.reference,
          record: grant.record,
          evidence: grant.evidence,
          signal: grant.signal,
        });
        if (input.localExecutionReadyBeforeStart !== undefined
          && !await input.localExecutionReadyBeforeStart({
            occurrence: runningOccurrence,
            signal: grant.signal,
          })) {
          throw new ProtectedTaskExecutionDidNotBeginError();
        }
        grant.signal.throwIfAborted();
        const subject = subjectFromRecord(runningOccurrence, grant.record);
        const authority = memoryAuthority({
          occurrence: runningOccurrence,
          predispatch,
          subject,
          ...(scopeMemory === undefined ? {} : { scopeMemory }),
        });
        let used = false;
        const run = async (
          transientInput: Record<string, unknown>,
          jobId: string,
          jobSignal: AbortSignal,
        ): Promise<void> => {
          if (used) {
            throw new TypeError("Protected Task fixed Memory segment was reused");
          }
          used = true;
          if (jobId !== runningOccurrence.run.jobId) {
            throw new TypeError("Protected Task fixed Memory Job changed");
          }
          exactGrant({
            occurrence: runningOccurrence,
            policy,
            reference,
            openedReference: grant.reference,
            record: grant.record,
            evidence: grant.evidence,
            signal: grant.signal,
          });
          if (transientInput[TRANSIENT_SEGMENT] !== token) {
            throw new TypeError("Protected Task fixed Memory segment was substituted");
          }
          exactExecutorInput(transientInput, runningOccurrence, predispatch);
          const signal = AbortSignal.any([grant.signal, jobSignal]);
          signal.throwIfAborted();
          const descriptorBytes = grant.record.descriptorBytes;
          if (descriptorBytes === null) {
            throw new TypeError("Protected Task fixed Memory request is unavailable");
          }
          const request = dependencies.decodeRequest(descriptorBytes, input.crypto);
          if (request === null) {
            throw new TypeError("Protected Task fixed Memory request is unavailable");
          }
          const closeRefresh = scheduleProtectedTaskCheckpointRefresh({
            expiresAt: grant.evidence.expiresAt, signal,
            requestPause: () => requestCheckpointPause("grant_refresh"),
          }, { now, schedule: (callback, delayMs) => setTimeout(callback, delayMs), cancel: clearTimeout });
          try {
            exactRequest({ occurrence: runningOccurrence, reference,
              evidence: grant.evidence, request });
            const publication = resultPublication(transientInput);
            const current: ProtectedTaskMemoryAuthorityInput = Object.freeze({
              runner: input.product.canonicalRunner,
              restricted: input.restricted,
              crypto: input.crypto,
              serverScope: input.serverScope,
              subject,
              occurrence: runningOccurrence,
              record: grant.record,
              request,
              evidence: grant.evidence,
              jobId,
              executionRoomId: predispatch.scheduling.roomId,
              ...(scopeMemory === undefined ? {} : {
                scopeMemory: Object.freeze({
                  binding: scopeMemory,
                  targetRoomId: predispatch.target.roomId,
                  workIdentity: scopeWorkIdentity!,
                }),
              }),
              reference,
              now,
              signal,
            });
            const assertCurrentTaskAuthority = async (): Promise<void> => {
              const currentResult = await dependencies.withCurrentMemoryAuthority(
                current,
                async held => {
                  await held.assertCurrent();
                  return held.policy.mode === policy.mode
                    && held.policy.shadowBehavior === policy.shadowBehavior
                    && held.policy.revision === policy.revision;
                },
              );
              if (currentResult !== true) {
                throw new TypeError(
                  "Protected Task fixed Memory authority is unavailable",
                );
              }
            };
            let failurePhase: ProtectedTaskFixedMemoryFailurePhase = "PTFMS001";
            const outcome = await Promise.resolve().then(() =>
              dependencies.openDefinition({
                restricted: input.restricted,
                crypto: input.crypto,
                serverScope: input.serverScope,
                evidence: grant.evidence,
                domains: grant.domains,
                signal,
                loadCurrentOccurrence: () => loadDefinition(current),
                resolveForegroundAgentAcceptedExecutionEvidence: principal =>
                  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver({
                    product: input.product.handle,
                    crypto: input.crypto,
                    rejectInvalidSelectedEvidence: true,
                  })(principal),
                resolveTaskDefinitionForegroundAuthorization: async evidence => {
                  const resolver = await createProtectedTaskDefinitionForegroundAuthorizationResolver({
                    product: input.product,
                    handle: await verifyCryptoPostgresHandle(input.restricted),
                    crypto: input.crypto, requesterHumanId: subject.humanActorId,
                    task: runningOccurrence.task,
                  });
                  return resolver === null ? null : resolver(evidence);
                },
                execute: async payload => {
                  const repoDocs = openFixedProtectedMetadata(
                    payload.protectedMetadata,
                    options.repoDocsSelection,
                  );
                  failurePhase = "PTFMS002";
                  const context = exactExecutionContext(
                    await input.resolveExecutionContext({
                      occurrence: runningOccurrence,
                      predispatch,
                      protectedMetadata: payload.protectedMetadata,
                      ...(repoDocs === undefined ? {} : { repoDocs }),
                      signal,
                      assertCurrentTaskAuthority,
                    }),
                  );
                  if ((repoDocs === undefined)
                    !== (context.protectedRepoDocsExecutionPort === undefined)
                    || (repoDocs === undefined)
                    !== (context.createProtectedRepoDocsProjectFilePort === undefined)) {
                    throw new TypeError("Protected repo docs execution port is unavailable");
                  }
                  const {
                    protectedRepoDocsExecutionPort,
                    createProtectedRepoDocsProjectFilePort,
                    ...baseExecutionContext
                  } = context;
                  const humanTurnId = runningOccurrence.run.id;
                  failurePhase = "PTFMS003";
                  return dependencies.withSigner({
                    restricted: input.restricted,
                    crypto: input.crypto,
                    evidence: grant.evidence,
                    domains: grant.domains,
                    use: async (signer, history) => {
                      failurePhase = "PTFMS004";
                      const publish = await input.createTranscriptPublisher({
                        occurrence: runningOccurrence,
                        record: grant.record,
                        request,
                        current,
                        policy,
                        humanTurnId,
                        assertCurrentTaskAuthority,
                        domains: grant.domains,
                        signer,
                        resolveHistoricalSignerPublicationManager: history,
                      });
                      const transcriptPort = dependencies.createTranscriptPort({
                        identity: {
                          taskId: runningOccurrence.task.id,
                          taskRunId: runningOccurrence.run.id,
                          graphThreadId: runningOccurrence.run.graphThreadId,
                          roomId: predispatch.scheduling.roomId,
                          humanTurnId,
                          agentId: runningOccurrence.task.agentId,
                        },
                        signal,
                        publish,
                      });
                      let transcriptClose:
                        | Promise<void>
                        | undefined;
                      const quiesceTranscript = (): Promise<void> => {
                        transcriptClose ??= transcriptPort.quiesce().then(
                          result => {
                            if (result.failedPublicationCount !== 0) {
                              throw new Error(
                                "Protected Task transcript publication did not complete",
                              );
                            }
                          },
                        );
                        return transcriptClose;
                      };
                      failurePhase = "PTFMS005";
                      const segmentOutcome = await Promise.resolve().then(() =>
                        dependencies.withMemoryRepository({
                          authority,
                          policy,
                          current,
                          domains: grant.domains,
                          signer,
                          resolveHistoricalSignerPublicationManager: history,
                          product: input.product,
                          agentProduct: input.agentProduct,
                          owner: input.owner,
                          embedding: input.embedding,
                          execute: (repository, projection, access) => {
                            failurePhase = "PTFMS006";
                            return dependencies.withCheckpointSaver({
                            restricted: input.restricted,
                            crypto: input.crypto,
                            owner: input.owner,
                            serverScope: input.serverScope,
                            evidence: grant.evidence,
                            identity: {
                              taskId: runningOccurrence.task.id,
                              taskRunId: runningOccurrence.run.id,
                              sourceRoomId: request.sourceRoomId,
                              namespaceId:
                                grant.evidence.result.namespace.namespaceId,
                              domainId: grant.evidence.result.namespace.domainId,
                              expectedAccessRevision:
                                grant.evidence.result.namespace
                                  .expectedAccessRevision,
                              expectedPolicyRevision: policy.revision,
                              graphThreadId: runningOccurrence.run.graphThreadId,
                            },
                            ...(checkpointAadBinding === undefined ? {} : { checkpointAadBinding }),
                            domains: grant.domains,
                            signal,
                            now,
                            assertCurrentTaskAuthority,
                            createDedicatedPool: input.createDedicatedPool,
                            execute: async checkpointSaver => {
                              const memoryHandoff: MemoryHandoff = Object.freeze({
                                search: repository,
                                repository,
                                projection,
                                access,
                                fullEncryptionOnly:
                                  policy.mode === "encrypted_only",
                              });
                              const segment: RunProtectedTaskNativeSegmentInput = {
                                mode: repoDocs === undefined ? "native" : "repo_docs",
                                taskId: runningOccurrence.task.id,
                                taskRunId: runningOccurrence.run.id,
                                graphThreadId:
                                  runningOccurrence.run.graphThreadId,
                                signal,
                                checkpointSaver,
                                transcriptPort,
                                memoryHandoff,
                                transientInput,
                                execution: Object.freeze({
                                  ...baseExecutionContext,
                                  parentThreadId:
                                    runningOccurrence.task.callingRoomId === null
                                      ? `task:${runningOccurrence.task.id}`
                                      : `room:${runningOccurrence.task.callingRoomId}`,
                                  parentTurnId: runningOccurrence.run.id,
                                  parentOwnerId: runningOccurrence.task.ownerId,
                                  causalHumanUserId:
                                    runningOccurrence.task.requestorId,
                                  brief: payload.prompt,
                                  ...(repoDocs === undefined ? {} : {
                                    protectedRepoDocs: Object.freeze({
                                      selection: repoDocs,
                                      executionPort: protectedRepoDocsExecutionPort!,
                                      createProjectFilePort:
                                        createProtectedRepoDocsProjectFilePort!,
                                    }),
                                  }),
                                  ...(payload.expectedOutput === null
                                    ? {}
                                    : { expectedOutput: payload.expectedOutput }),
                                  subEnvelope: predispatch.memory.envelope,
                                  actorRole: "owner",
                                  roomId: predispatch.scheduling.roomId,
                                  ...(additionalAuthorityResume === undefined
                                    ? {}
                                    : { resume: additionalAuthorityResume }),

                                  ...(runningOccurrence.task.callingRoomId === null
                                    ? {}
                                    : {
                                        callingRoomId:
                                          runningOccurrence.task.callingRoomId,
                                      }),
                                }),
                              };
                              const runSegment = (binding?: ProtectedTaskHumanResumeBindingV1) => {
                                failurePhase = "PTFMS007";
                                return dependencies.runSegment({ ...segment,
                                  protectedTaskCheckpointPauseController: checkpointPauseController,
                                  execution: {
                                  ...segment.execution,
                                  ...(preparation.checkpointResume === true ? { continueFromCheckpoint: true } : {}),
                                  ...(binding === undefined ? {} : { protectedTaskHumanResume: binding }),
                                } });
                              };
                              const segmentOutcome = await Promise.resolve()
                                .then(async () => {
                                  if (humanResume?.kind !== "await_reply") return runSegment(humanResume);
                                  type SegmentResult = Awaited<ReturnType<typeof runSegment>>;
                                  const resolved = await input.owner.read<never, SegmentResult, SegmentResult>({
                                    ordinary: () => { throw new ClassifiedDataOperationError(
                                      "authority", "Protected Task reply requires current encrypted authority",
                                    ); },
                                    protected: async () => {
                                      const resolver = dependencies.createReplyAuthority({
                                        policy,
                                        occurrence: runningOccurrence, evidence: grant.evidence,
                                        acceptedBy: humanResume.acceptedBy, message: humanResume.message,
                                        runner: input.product.canonicalRunner, restricted: input.restricted,
                                        signal, assertCurrentTaskAuthority,
                                      });
                                      const authority = await resolver.readCurrent();
                                      if (authority === null) throw new ClassifiedDataOperationError(
                                        "authority", "Protected Task reply authority is unavailable",
                                      );
                                      const handle = await dependencies.verifyReplyHandle(input.restricted);
                                      return dependencies.openReply<SegmentResult>({
                                        restricted: input.restricted, crypto: input.crypto,
                                        serverScope: input.serverScope, evidence: grant.evidence,
                                        domains: grant.domains, signal,
                                        target: dependencies.replyTarget(authority),
                                        resolveCurrentAuthority: () => resolver.readCurrent(),
                                        resolveHistoricalHumanSigner:
                                          createProtectedTaskHistoricalHumanReplySignerResolver(handle),
                                        execute: (reply, assertCurrentReply) => {
                                          if (reply.role !== "user" || typeof reply.content !== "string"
                                            || reply.content.trim().length === 0
                                            || reply.toolCalls !== undefined || reply.toolName !== undefined) {
                                            throw new TypeError("Protected Task reply payload is invalid");
                                          }
                                          return assertCurrentReply().then(() => runSegment({
                                            kind: "await_reply", interruptId: humanResume.interruptId,
                                            reply: reply.content, fromUserId: humanResume.message.sourceUserId,
                                          }));
                                        },
                                      });
                                    },
                                    consumeOrdinary: value => value,
                                    consumeProtected: value => value,
                                    classifyFailure: () => "integrity",
                                  });
                                  return resolved.value;
                                })
                                .then(
                                  value => ({ status: "fulfilled", value } as const),
                                  (error: unknown) =>
                                    ({ status: "rejected", error } as const),
                                );
                              await quiesceTranscript();
                              if (segmentOutcome.status === "rejected") {
                                throw segmentOutcome.error;
                              }
                              return segmentOutcome.value;
                            },
                          });
                          },
                        })).then(
                        value => ({ status: "fulfilled", value } as const),
                        (error: unknown) =>
                          ({ status: "rejected", error } as const),
                      );
                      await quiesceTranscript();
                      if (segmentOutcome.status === "rejected") {
                        throw segmentOutcome.error;
                      }
                      return segmentOutcome.value;
                    },
                  });
                },
              })).then(
              value => ({ status: "fulfilled", value } as const),
              (error: unknown) => ({ status: "rejected", error } as const),
            );
            if (outcome.status === "rejected") {
              signal.throwIfAborted();
              log(`[task-observer] protected fixed Memory segment rejected code=${failurePhase}`);
              try {
                await publication.publish(createProtectedTaskFailurePayload());
              } catch (error) {
                log(`[task-observer] protected fixed Memory failure publication rejected code=PTFMS008 source=${failurePhase}`);
                throw error;
              }
              return;
            }
            const terminalPayload = outcome.value.value;
            if ("status" in terminalPayload) {
              if (terminalPayload.status === "checkpoint_paused") {
                signal.throwIfAborted();
                if (terminalPayload.threadId !== runningOccurrence.run.graphThreadId
                  || terminalPayload.reason !== checkpointPauseController.currentRequestedReason()) {
                  throw new TypeError("Protected Task checkpoint pause is not exact");
                }
                await publication.park(parkedAt => input.parkSegment(Object.freeze({
                  park: Object.freeze({
                    taskId: runningOccurrence.task.id, taskRunId: runningOccurrence.run.id,
                    graphThreadId: runningOccurrence.run.graphThreadId, jobId,
                    generation: grant.record.snapshot.recipientGeneration,
                    executionSegment: reference.executionSegment,
                    interrupts: Object.freeze([] as const), parkedAt: new Date(parkedAt), jobReference: reference,
                    checkpointAadBinding: outcome.value.checkpointAadBinding,
                  }),
                  segment: Object.freeze({ route: "native_langgraph_v1" as const, checkpoint: outcome.value.manifest }),
                  continuation: Object.freeze({ kind: "checkpoint_safe_v1" as const,
                    reason: terminalPayload.reason, effectDisposition: "none_v1" as const }),
                  pauseRequestId: checkpointPauseRequestId,
                  stableRoutingDigest: Uint8Array.from(stableRoutingDigest),
                })));
                return;
              }
              if (terminalPayload.status === "aborted") {
                signal.throwIfAborted();
              }
              if (terminalPayload.status === "interrupted") {
                signal.throwIfAborted();
                const additionalAuthority = terminalPayload.additionalAuthority;
                if (terminalPayload.threadId !== runningOccurrence.run.graphThreadId
                  || terminalPayload.interruptCoordinates.length === 0
                  || (additionalAuthority === undefined
                    && terminalPayload.interruptCoordinates.some(
                      coordinate => coordinate.kind === "additional_authority",
                    ))) {
                  throw new TypeError("Protected Task interruption is not exact");
                }
                await publication.park(parkedAt => {
                  if (!Number.isSafeInteger(parkedAt) || parkedAt < 0) {
                    throw new TypeError(
                      "Protected Task fixed Memory park clock is invalid",
                    );
                  }
                  return input.parkSegment(Object.freeze({
                    park: Object.freeze({
                      taskId: runningOccurrence.task.id,
                      taskRunId: runningOccurrence.run.id,
                      graphThreadId: runningOccurrence.run.graphThreadId,
                      jobId,
                      generation: grant.record.snapshot.recipientGeneration,
                      executionSegment: reference.executionSegment,
                      interrupts: terminalPayload.interruptCoordinates,
                      parkedAt: new Date(parkedAt),
                      jobReference: reference,
                      checkpointAadBinding: outcome.value.checkpointAadBinding,
                    }),
                    segment: Object.freeze({
                      route: "native_langgraph_v1" as const,
                      checkpoint: outcome.value.manifest,
                    }),
                    ...(additionalAuthority === undefined
                      ? { stableRoutingDigest: stableRoutingDigest.slice() }
                      : { continuation: Object.freeze({
                          ...additionalAuthority,
                          stableRoutingDigest: stableRoutingDigest.slice(),
                        }) }),
                  }));
                });
                return;
              }
              throw new TypeError(
                "Protected Task fixed Memory continuation is unavailable",
              );
            }
            signal.throwIfAborted();
            await publication.publish(terminalPayload);
          } finally {
            closeRefresh();
            dependencies.destroyRequest(request);
          }
        };
        const token = Object.freeze({ run });
        issuedSegmentTokens.add(token);
        return Promise.resolve(Object.freeze({ [TRANSIENT_SEGMENT]: token }));
      };

    return Promise.resolve(Object.freeze({ executor, openTransientInput, requestCheckpointPause }));
  };
}

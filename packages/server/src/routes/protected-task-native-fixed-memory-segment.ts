import type { RunScopeSubagentOpts } from "@nautilo/agent";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  ClassifiedDataOperationError,
  withProtectedTaskResultSigner,
  type EncryptionDataOperationOwner,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedMemoryAuthority,
  type ProtectedTaskResultSignerAuthority,
  type TaskRunResultPayloadV1,
  type TaskPayloadV1,
} from "@nautilo/lattice-bridge";
import {
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  withNativeProtectedTaskDefinitionV1,
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
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  type TaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  createProtectedTaskTranscriptPort,
  runProtectedTaskNativeSegment,
  withNativeProtectedTaskCheckpointSaver,
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
import {
  isNamespaceMemoryEnvelope,
  isScopeMemoryEnvelope,
} from "@nautilo/trust";

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
import {
  withProtectedTaskResultSignerHistory,
} from "./protected-task-result-signer-history";

type PrepareExecution =
  ProtectedTaskRuntimeGrantPlanBuilderDependencies["prepareExecution"];
type MemoryRepositoryInput = ProtectedTaskNativeMemoryRepositoryInput<unknown>;
type DedicatedPoolFactory = Parameters<
  typeof withNativeProtectedTaskCheckpointSaver
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
>;

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
  resolveExecutionContext(input: Readonly<{
    occurrence: ProtectedTaskRunningOccurrence;
    predispatch: ProtectedTaskPredispatchPlan;
    protectedMetadata: TaskPayloadV1["protectedMetadata"];
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
    humanTurnId: string;
    assertCurrentTaskAuthority(): Promise<void>;
    /** Borrowed only while the current Runtime signer owner remains open. */
    domains: readonly DomainForegroundSecretEntry[];
    signer: ProtectedTaskResultSignerAuthority;
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
    signer: ProtectedTaskResultSignerAuthority,
    resolveHistoricalSignerPublicationManager:
      MemoryRepositoryInput["resolveHistoricalSignerPublicationManager"],
  ): Promise<unknown>;
}>;

type Dependencies = Readonly<{
  decodeRequest: typeof decodeTaskRuntimeBackgroundAuthorizationRequestV1;
  destroyRequest: typeof destroyTaskRuntimeBackgroundAuthorizationRequestV1;
  createDefinitionLoader:
    typeof createCurrentNativeProtectedTaskDefinitionOccurrenceLoader;
  openDefinition: typeof withNativeProtectedTaskDefinitionV1;
  withMemoryRepository: typeof withProtectedTaskNativeMemoryRepository;
  withCheckpointSaver: typeof withNativeProtectedTaskCheckpointSaver;
  createTranscriptPort: typeof createProtectedTaskTranscriptPort;
  runSegment: typeof runProtectedTaskNativeSegment;
  withCurrentMemoryAuthority: typeof withCurrentProtectedTaskMemoryAuthority;
  withSigner<Value>(input: Omit<SignerUseInput, "use"> & Readonly<{
    use(
      signer: ProtectedTaskResultSignerAuthority,
      resolveHistoricalSignerPublicationManager:
        MemoryRepositoryInput["resolveHistoricalSignerPublicationManager"],
    ): Promise<Value>;
  }>): Promise<Value>;
}>;

function wipeNested(value: unknown): void {
  if (value instanceof Uint8Array) value.fill(0);
  else if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) wipeNested(nested);
  }
}

async function withCurrentRuntimeSigner<Value>(input: Omit<
  SignerUseInput,
  "use"
> & Readonly<{
  use(
    signer: ProtectedTaskResultSignerAuthority,
    resolveHistoricalSignerPublicationManager:
      MemoryRepositoryInput["resolveHistoricalSignerPublicationManager"],
  ): Promise<Value>;
}>): Promise<Value> {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  const domains = input.domains.filter(domain =>
    domain.domainId === input.evidence.result.namespace.domainId
  );
  const domain = domains[0];
  if (domains.length !== 1 || domain === undefined || domain.keyClass !== "ai") {
    throw new ClassifiedDataOperationError(
      "authority",
      "Protected Task Memory result Domain is unavailable",
    );
  }
  const handle = await verifyCryptoPostgresHandle(input.restricted);
  const storage = new PostgresLatticeStorage(handle);
  const state = await storage.getAgentRuntimeAtomicState(
    input.evidence.result.signerAgentId,
  );
  let authorizationRevision: number;
  let runtimeGeneration: number;
  try {
    if (state === null
      || state.runtime.agentId !== input.evidence.result.signerAgentId) {
      throw new ClassifiedDataOperationError(
        "authority",
        "Protected Task Memory Runtime signer is unavailable",
      );
    }
    authorizationRevision = state.runtime.authorizationRevision;
    runtimeGeneration = state.runtime.runtimeGeneration;
  } finally {
    wipeNested(state);
  }
  return withProtectedTaskResultSignerHistory({
    handle,
    crypto: input.crypto,
    agentId: input.evidence.result.signerAgentId,
    domainId: domain.domainId,
    domainEpoch: domain.domainKeyGeneration,
    expectedAgentAuthorizationRevision: authorizationRevision,
    expectedRuntimeGeneration: runtimeGeneration,
    use: async history => {
      const opened = await withProtectedTaskResultSigner({
        crypto: input.crypto,
        storage,
        evidence: input.evidence,
        domain,
        expectedAgentAuthorizationRevision: authorizationRevision,
        resolveHistoricalRuntimeCommitter:
          history.resolveHistoricalRuntimeCommitter,
        resolveHistoricalSignerPublicationManager:
          history.resolveHistoricalSignerPublicationManager,
        execute: signer => input.use(
          signer,
          history.resolveHistoricalSignerPublicationManager,
        ),
      });
      if (opened.status !== "executed") {
        throw new ClassifiedDataOperationError(
          "authority",
          "Protected Task Memory Runtime signer is unavailable",
        );
      }
      return opened.value;
    },
  });
}

const productionDependencies: Dependencies = Object.freeze({
  decodeRequest: decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyRequest: destroyTaskRuntimeBackgroundAuthorizationRequestV1,
  createDefinitionLoader:
    createCurrentNativeProtectedTaskDefinitionOccurrenceLoader,
  openDefinition: withNativeProtectedTaskDefinitionV1,
  withMemoryRepository: withProtectedTaskNativeMemoryRepository,
  withCheckpointSaver: withNativeProtectedTaskCheckpointSaver,
  createTranscriptPort: createProtectedTaskTranscriptPort,
  runSegment: runProtectedTaskNativeSegment,
  withCurrentMemoryAuthority: withCurrentProtectedTaskMemoryAuthority,
  withSigner: withCurrentRuntimeSigner,
});

const TRANSIENT_SEGMENT = "protectedTaskNativeFixedMemorySegment";

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

function executablePolicyMode(
  value: unknown,
): value is "shadow_encryption" | "encrypted_only" {
  return value === "shadow_encryption" || value === "encrypted_only";
}

function exactPreparation(input: Parameters<PrepareExecution>[0]): void {
  const { occurrence, predispatch, policy, reference } = input;
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
    || (policy.mode === "shadow_encryption"
      ? occurrence.task.contentRepresentation !== "dual"
      : policy.mode !== "encrypted_only"
        || occurrence.task.contentRepresentation !== "protected")
    || reference.taskId !== occurrence.task.id
    || reference.taskRunId !== occurrence.run.id
    || reference.inputObjectId !== occurrence.task.cryptoObjectId
    || reference.authorizationRequestId
      !== `task-run-authorization:${occurrence.run.id}`
    || reference.executionSegment !== 1) {
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
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  evidence: TaskRuntimeExecutionEvidence;
  signal: AbortSignal;
}>): void {
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  const { occurrence, record, evidence, reference } = input;
  if (!(input.signal instanceof AbortSignal)
    || record.snapshot.state !== "claimed"
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
      || envelope.writableNamespaces.length !== 1) {
      throw new TypeError("Protected Task fixed Namespace Memory is unavailable");
    }
    return Object.freeze({
      mode: "namespace" as const,
      subjectUserId: input.subject.userId,
      agentId: input.occurrence.task.agentId,
      readableNamespaceIds: Object.freeze([...envelope.readableNamespaces]),
      mutableNamespaceIds: Object.freeze([...envelope.mutableNamespaces]),
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

function resultPublication(
  input: Record<string, unknown>,
): Readonly<{ publish(payload: TaskRunResultPayloadV1): Promise<void> }> {
  const value = input["protectedTaskResultPublication"];
  if (typeof value !== "object" || value === null
    || typeof (value as { publish?: unknown }).publish !== "function") {
    throw new TypeError(
      "Protected Task fixed Memory result publication changed",
    );
  }
  return value as Readonly<{
    publish(payload: TaskRunResultPayloadV1): Promise<void>;
  }>;
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
    || value.continueFromCheckpoint === true
    || value.awaitReply !== undefined) {
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

function assertNativeProtectedMetadata(
  metadata: TaskPayloadV1["protectedMetadata"],
): void {
  const allowed = new Set(["preparation", "lastInterruption"]);
  if (Reflect.ownKeys(metadata).some(key =>
    typeof key !== "string" || !allowed.has(key)
  )) {
    throw new TypeError(
      "Protected Task fixed Memory definition requires a specialized route",
    );
  }
}

/**
 * Build an unmounted native Task preparation whose fixed Memory repository,
 * signer and checkpoint saver remain alive only while one graph segment runs.
 */
export function createProtectedTaskNativeFixedMemorySegment(
  input: ProtectedTaskNativeFixedMemorySegmentInput,
  overrides: Partial<Dependencies> = {},
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
    { requireNativeExecution: true },
  );

  return preparation => {
    exactPreparation(preparation);
    const occurrence = copyOccurrence(preparation.occurrence);
    const predispatch = copyPredispatch(preparation.predispatch, occurrence);
    const policy = Object.freeze({ ...preparation.policy });
    const reference = Object.freeze({ ...preparation.reference });
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
      await token.run(transientInput, jobId, jobSignal);
      yield* [];
    };

    const openTransientInput: TaskRuntimeGrantClaimPlan["openTransientInput"] =
      grant => {
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
          record: grant.record,
          evidence: grant.evidence,
          signal: grant.signal,
        });
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
          const request = dependencies.decodeRequest(descriptorBytes);
          if (request === null) {
            throw new TypeError("Protected Task fixed Memory request is unavailable");
          }
          try {
            exactRequest({ occurrence: runningOccurrence, reference,
              evidence: grant.evidence, request });
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
            const terminalPayload = await dependencies.openDefinition({
              restricted: input.restricted,
              crypto: input.crypto,
              serverScope: input.serverScope,
              evidence: grant.evidence,
              domains: grant.domains,
              signal,
              loadCurrentOccurrence: () => loadDefinition(current),
              execute: async payload => {
                assertNativeProtectedMetadata(payload.protectedMetadata);
                const context = exactExecutionContext(
                  await input.resolveExecutionContext({
                    occurrence: runningOccurrence,
                    predispatch,
                    protectedMetadata: payload.protectedMetadata,
                  }),
                );
                const humanTurnId = runningOccurrence.run.id;
                return dependencies.withSigner({
                  restricted: input.restricted,
                  crypto: input.crypto,
                  evidence: grant.evidence,
                  domains: grant.domains,
                  use: async (signer, history) => {
                    const publish = await input.createTranscriptPublisher({
                      occurrence: runningOccurrence,
                      record: grant.record,
                      request,
                      current,
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
                    return dependencies.withMemoryRepository({
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
                      execute: repository => dependencies.withCheckpointSaver({
                        restricted: input.restricted,
                        crypto: input.crypto,
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
                        domains: grant.domains,
                        signal,
                        now,
                        assertCurrentTaskAuthority,
                        createDedicatedPool: input.createDedicatedPool,
                        execute: async checkpointSaver => {
                          const memoryHandoff: MemoryHandoff = Object.freeze({
                            search: repository,
                            repository,
                            fullEncryptionOnly:
                              policy.mode === "encrypted_only",
                          });
                          const segment: RunProtectedTaskNativeSegmentInput = {
                            mode: "native",
                            taskId: runningOccurrence.task.id,
                            taskRunId: runningOccurrence.run.id,
                            graphThreadId: runningOccurrence.run.graphThreadId,
                            signal,
                            checkpointSaver,
                            transcriptPort,
                            memoryHandoff,
                            transientInput,
                            execution: Object.freeze({
                              ...context,
                              parentThreadId:
                                runningOccurrence.task.callingRoomId === null
                                  ? `task:${runningOccurrence.task.id}`
                                  : `room:${runningOccurrence.task.callingRoomId}`,
                              parentTurnId: runningOccurrence.run.id,
                              parentOwnerId: runningOccurrence.task.ownerId,
                              causalHumanUserId:
                                runningOccurrence.task.requestorId,
                              brief: payload.prompt,
                              ...(payload.expectedOutput === null
                                ? {}
                                : { expectedOutput: payload.expectedOutput }),
                              subEnvelope: predispatch.memory.envelope,
                              actorRole: "owner",
                              roomId: predispatch.scheduling.roomId,
                              ...(runningOccurrence.task.callingRoomId === null
                                ? {}
                                : {
                                    callingRoomId:
                                      runningOccurrence.task.callingRoomId,
                                  }),
                            }),
                          };
                          const outcome = await Promise.resolve()
                            .then(() => dependencies.runSegment(segment))
                            .then(
                              value => ({ status: "fulfilled", value } as const),
                              (error: unknown) => ({ status: "rejected", error } as const),
                            );
                          const transcriptClose = await transcriptPort.quiesce();
                          if (outcome.status === "rejected") throw outcome.error;
                          if (transcriptClose.failedPublicationCount !== 0) {
                            throw new Error(
                              "Protected Task transcript publication did not complete",
                            );
                          }
                          const result = outcome.value;
                          if ("status" in result) {
                            throw new TypeError(
                              "Protected Task fixed Memory continuation is unavailable",
                            );
                          }
                          return result;
                        },
                      }),
                    });
                  },
                });
              },
            });
            signal.throwIfAborted();
            await resultPublication(transientInput).publish(terminalPayload);
          } finally {
            dependencies.destroyRequest(request);
          }
        };
        const token = Object.freeze({ run });
        return Promise.resolve(Object.freeze({ [TRANSIENT_SEGMENT]: token }));
      };

    return Promise.resolve(Object.freeze({ executor, openTransientInput }));
  };
}

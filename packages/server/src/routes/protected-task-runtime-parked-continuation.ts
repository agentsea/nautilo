import { resolveProtectedTaskCheckpointAadBinding } from "./protected-task-checkpoint-aad-binding";
import { createProtectedTaskRuntimeAccessLineageReader } from "./protected-task-runtime-access-lineage";
import {
  getEncryptionTransitionPolicy,
  getProtectedTaskRunOutputBinding,
  startParkedProtectedTaskCheckpointSegment,
  startParkedProtectedTaskRunAdditionalAuthoritySegment,
  startParkedProtectedTaskHumanRunSegment,
  type DirectDatabase,
  type ParkedProtectedTaskCheckpointContinuation,
  type PostgresJsBridgeConnection,
  type StartParkedProtectedTaskHumanRunSegmentInput,
  type StartParkedProtectedTaskCheckpointSegmentInput,
  type ParkedProtectedTaskHumanContinuation,
  type ProtectedTaskDurableJobReference,
  type StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput,
} from "@nautilo/db";
import type { LatticeCrypto, TaskRuntimeRecipientRegistry } from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  createParkedTaskRuntimeGrantClaim,
  readProtectedTaskCheckpointPhysicalManifest,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type BackgroundAuthorizationTaskRuntimeReplacementRepository,
  type ParkedTaskRuntimeGrantClaimDependencies,
  type ParkedTaskRuntimeGrantClaimPlan,
  type ParkedTaskRuntimeExecutionStartInput,
  type ProtectedTaskOccurrence,
} from "@nautilo/runtime";
import type { PolicyResolver } from "@nautilo/trust";
import { createProtectedTaskRuntimeParkedMemoryPlanResolver } from "./protected-task-runtime-parked-memory-plan";
import {
  createParkedTaskRuntimeAuthorizationPlanResolver,
  discoverParkedProtectedTaskContinuation,
  type ParkedTaskRuntimeAuthorizationPlan,
  type ParkedProtectedTaskContinuation,
} from "./protected-task-runtime-parked-plan";
import { createProtectedTaskRuntimeParkedClaimAuthority } from "./protected-task-runtime-parked-claim-authority";
import type { ProtectedTaskRuntimeGrantPlanBuilderDependencies, ProtectedTaskHumanResumePreparation } from "./protected-task-runtime-grant-plan";

type StartInput = StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput
  | StartParkedProtectedTaskCheckpointSegmentInput
  | StartParkedProtectedTaskHumanRunSegmentInput;
type Dependencies = Readonly<{
  resolvePlan: ReturnType<typeof createParkedTaskRuntimeAuthorizationPlanResolver>;
  authority: ReturnType<typeof createProtectedTaskRuntimeParkedClaimAuthority>;
  readManifest: typeof readProtectedTaskCheckpointPhysicalManifest;
  start: typeof startParkedProtectedTaskRunAdditionalAuthoritySegment;
  startCheckpoint: typeof startParkedProtectedTaskCheckpointSegment;
  startHuman: typeof startParkedProtectedTaskHumanRunSegment;
}>;

function isCheckpointContinuation(
  expected: ParkedProtectedTaskContinuation,
): expected is ParkedProtectedTaskCheckpointContinuation {
  return !("acceptance" in expected) && "stableRoutingDigest" in expected;
}

function startInput(
  resolved: ParkedTaskRuntimeAuthorizationPlan,
  value: ParkedTaskRuntimeExecutionStartInput,
  checkpointManifest: StartInput["checkpointManifest"],
): StartInput {
  const { occurrence, priorJob } = resolved.expected;
  const common = {
    ...(priorJob.checkpointAadBinding === undefined ? {} : { checkpointAadBinding: priorJob.checkpointAadBinding }),
    taskId: occurrence.task.id, taskRunId: occurrence.run.id,
    graphThreadId: occurrence.run.graphThreadId,
    priorJobId: priorJob.id, jobId: value.jobId,
    generation: priorJob.generation, interrupts: priorJob.interrupts,
    parkedAt: priorJob.parkedAt,
    contentRepresentation: occurrence.task.contentRepresentation,
    contentNamespaceId: occurrence.task.contentNamespaceId,
    contentRevision: occurrence.task.contentRevision,
    cryptoObjectId: occurrence.task.cryptoObjectId,
    cryptoAccessRevision: occurrence.task.cryptoAccessRevision,
    cryptoRequiredNamespaceFingerprint: occurrence.task.cryptoRequiredNamespaceFingerprint,
    priorJobReference: priorJob.reference,
    jobReference: value.reference,
    checkpointManifest,
  };
  if ("acceptance" in resolved.expected) return {
    ...common, acceptance: resolved.expected.acceptance,
    stableRoutingDigest: resolved.expected.stableRoutingDigest.slice(),
  };
  if (isCheckpointContinuation(resolved.expected)) return {
    ...common,
    interrupts: [] as const,
    stableRoutingDigest: resolved.expected.stableRoutingDigest.slice(),
    continuationFingerprint: resolved.expected.continuationFingerprint,
  };
  const { proof } = resolved.expected;
  return { ...common, continuation: {
    interruptId: proof.continuation.interruptId!,
    operationId: proof.continuation.operationId!,
    requestDigest: proof.continuation.requestDigest!,
    requiredAuthorityDigest: proof.continuation.requiredAuthorityDigest!,
    stableRoutingDigest: proof.continuation.stableRoutingDigest,
    semanticAuthorityRequirements: proof.continuation.semanticAuthorityRequirements,
  } };

}

function humanResumePreparation(
  expected: ParkedProtectedTaskHumanContinuation,
): ProtectedTaskHumanResumePreparation {
  const { interrupt, response, acceptedBy } = expected.acceptance;
  if (response.kind !== interrupt.kind) throw new TypeError("Task Human response changed kind");
  if (response.kind === "approval") {
    if (interrupt.requestId === undefined) throw new TypeError("Task approval request is missing");
    return { kind: "approval", interruptId: interrupt.id,
      requestId: interrupt.requestId, verb: response.verb };
  }
  if (response.kind === "prove_it") return {
    kind: "prove_it", interruptId: interrupt.id, approved: response.approved,
  };
  if (response.kind === "identity") return {
    kind: "identity", interruptId: interrupt.id, verified: true,
    ...(interrupt.requestId === undefined ? {} : { requestId: interrupt.requestId }),
  };
  return { kind: "await_reply", interruptId: interrupt.id,
    acceptedBy: { ...acceptedBy }, message: { ...response.message } };
}

/** Accepted parked grants resume the existing graph thread through one new Job. */
export function createProtectedTaskRuntimeParkedContinuation(input: Readonly<{
  db: DirectDatabase;
  restricted: PostgresJsBridgeConnection;
  crypto: LatticeCrypto;
  serverScope: string;
  resolver: PolicyResolver;
  recipients: TaskRuntimeRecipientRegistry;
  repository: BackgroundAuthorizationTaskRuntimeReplacementRepository;
  withCurrentAuthority: ParkedTaskRuntimeGrantClaimDependencies["withCurrentAuthority"];
  prepareExecution: ProtectedTaskRuntimeGrantPlanBuilderDependencies["prepareExecution"];
  publishResult: ParkedTaskRuntimeGrantClaimPlan["publishResult"];
  createDedicatedPool: Parameters<typeof readProtectedTaskCheckpointPhysicalManifest>[0]["createDedicatedPool"];
  recoverUnstarted(start: StartInput, claimed: BackgroundAuthorizationTaskRuntimeRecordV3): Promise<boolean>;
  recoverClaim(input: Readonly<{
    expected: ParkedProtectedTaskContinuation;
    jobReference: ProtectedTaskDurableJobReference;
  }>, claimed: BackgroundAuthorizationTaskRuntimeRecordV3): Promise<boolean>;
  now(): number;
}>, overrides: Partial<Dependencies> = {}) {
  const resolvePlan = overrides.resolvePlan ?? createParkedTaskRuntimeAuthorizationPlanResolver({
    db: input.db, discover: discoverParkedProtectedTaskContinuation,
    readAccessLineage: createProtectedTaskRuntimeAccessLineageReader({ db: input.db, crypto: input.crypto, restricted: () => input.restricted }),
    readPolicy: getEncryptionTransitionPolicy, readOutput: getProtectedTaskRunOutputBinding,
    resolveMemory: createProtectedTaskRuntimeParkedMemoryPlanResolver({
      db: input.db, resolver: input.resolver,
    }),
  });
  const authority = overrides.authority ?? createProtectedTaskRuntimeParkedClaimAuthority({
    ...input, resolvePlan,
  });
  const readManifest = overrides.readManifest ?? readProtectedTaskCheckpointPhysicalManifest;
  const start = overrides.start ?? startParkedProtectedTaskRunAdditionalAuthoritySegment;
  const startCheckpoint = overrides.startCheckpoint
    ?? startParkedProtectedTaskCheckpointSegment;
  const startHuman = overrides.startHuman ?? startParkedProtectedTaskHumanRunSegment;
  const plan = async (observed: ProtectedTaskOccurrence): Promise<ParkedTaskRuntimeGrantClaimPlan | null> => {
    const occurrence = structuredClone(observed);
    const resolved = await resolvePlan({ occurrence, taskRunId: occurrence.run.id });
    const selected = resolved === null ? null
      : await input.repository.get(resolved.expected.authorizationRequestId);
    if (selected === null || selected.snapshot.formatVersion !== 3
      || selected.snapshot.state !== "grant_ready" || selected.descriptorBytes === null) {
      return null;
    }
    const record = selected as BackgroundAuthorizationTaskRuntimeRecordV3;
    const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(record.descriptorBytes!);
    if (request === null) return null;
    try {
      const prepared = await authority.withPlan({ occurrence, record, request }, held => Promise.resolve({
        resolved: held.resolved, canonical: held.canonical,
      }));
      if (prepared === null) return null;
      const { resolved: pinned, canonical } = prepared;
      const { expected, memory, policy } = pinned;
      const segment = "acceptance" in expected ? expected.segment : expected.proof.segment;
      if (policy.mode === "plaintext_only"
        || segment.checkpointDigest === null
        || segment.checkpointBlobDigest === null
        || segment.pendingWriteDigest === null) return null;
      const reference = Object.freeze({
        kind: "protected_task_run_v1" as const,
        taskId: occurrence.task.id, taskRunId: occurrence.run.id,
        inputObjectId: occurrence.task.cryptoObjectId,
        resultObjectId: expected.priorJob.reference.resultObjectId,
        authorizationRequestId: expected.authorizationRequestId,
        policyRevision: canonical.authority.policyRevision,
        executionSegment: expected.nextExecutionSegment,
        ...("acceptance" in expected
          ? { resumeAcceptanceId: expected.acceptance.acceptanceId }
          : { resumeContinuationFingerprint: expected.continuationFingerprint }),
      });
      const scheduling = Object.freeze({
        ownerId: occurrence.task.ownerId, requestorId: occurrence.task.requestorId,
        agentId: occurrence.task.agentId, roomId: memory.routing.targetRoomId,
        callingRoomId: occurrence.task.callingRoomId, graphThreadId: occurrence.run.graphThreadId,
      });
      const checkpointAadBinding = await resolveProtectedTaskCheckpointAadBinding(expected, input.repository);
      if (checkpointAadBinding === null) return null;
      const execution = await input.prepareExecution({
        checkpointAadBinding,
        occurrence, reference, policy: { ...policy, mode: policy.mode },
        predispatch: { occurrence, scheduling,
          target: { roomId: memory.routing.targetRoomId, targetUserIds: memory.routing.targetUserIds },
          memory: memory.resolution },
        ...("acceptance" in expected ? {
          stableRoutingDigest: expected.stableRoutingDigest.slice(),
          humanResume: humanResumePreparation(expected),
        } : isCheckpointContinuation(expected) ? {
          stableRoutingDigest: expected.stableRoutingDigest.slice(),
          checkpointResume: true as const,
        } : {
          stableRoutingDigest: expected.proof.continuation.stableRoutingDigest.slice(),
          additionalAuthorityResume: {
            interruptId: expected.proof.continuation.interruptId!,
            authorizationRequestId: expected.authorizationRequestId,
            effectDisposition: "not_started_v1" as const,
            operationId: expected.proof.continuation.operationId!,
            requestDigest: expected.proof.continuation.requestDigest!.slice(),
            requiredAuthorityDigest: expected.proof.continuation.requiredAuthorityDigest!.slice(),
          },
        }),
        ...(memory.scopeMemory === undefined ? {} : {
          scopeMemory: memory.scopeMemory, scopeWorkIdentity: canonical.scopeWorkIdentity,
        }),
      });
      const executionKeys = execution !== null && typeof execution === "object"
        ? Object.keys(execution).sort().join(",")
        : "";
      if ((executionKeys !== "executor,openTransientInput"
          && executionKeys !== "executor,modelAttribution,openTransientInput"
          && executionKeys !== "executor,openTransientInput,requestCheckpointPause"
          && executionKeys
            !== "executor,modelAttribution,openTransientInput,requestCheckpointPause")
        || typeof execution.executor !== "function"
        || typeof execution.openTransientInput !== "function"
        || (Object.hasOwn(execution, "requestCheckpointPause")
          && typeof execution.requestCheckpointPause !== "function")
        || (execution.modelAttribution !== undefined
          && execution.modelAttribution !== "external")) {
        throw new TypeError("Parked Task execution preparation is invalid");
      }
      const priorManifest: StartInput["checkpointManifest"] = {
        contract: "encrypted_langgraph_v1",
        expectedCheckpointCount: segment.expectedCheckpointCount,
        checkpointOrderedDigest: segment.checkpointDigest.slice(),
        expectedBlobCount: segment.expectedCheckpointBlobCount,
        blobOrderedDigest: segment.checkpointBlobDigest.slice(),
        expectedPendingWriteCount: segment.expectedPendingWriteCount,
        pendingWriteOrderedDigest: segment.pendingWriteDigest.slice(),
      };
      return {
        stableIdentity: canonical.stableIdentity, initialRecord: canonical.initialRecord,
        reference, scheduling, executor: execution.executor,
        openTransientInput: execution.openTransientInput,
        ...(execution.requestCheckpointPause === undefined ? {} : {
          requestCheckpointPause: execution.requestCheckpointPause,
        }),
        ...(execution.modelAttribution === undefined ? {} : {
          modelAttribution: execution.modelAttribution,
        }),
        ...(memory.scopeMemory === undefined ? {} : { scopeMemory: memory.scopeMemory }),
        publishResult: input.publishResult,
        persistJob: async value => {
          if (value.claimed.snapshot.state !== "claimed"
            || value.claimed.snapshot.claimId !== value.claimId
            || Object.keys(value.reference).length !== Object.keys(reference).length
            || Object.entries(reference).some(([key, expectedValue]) =>
              Reflect.get(value.reference, key) !== expectedValue)) {
            throw new Error("Parked Task persistence authority is stale");
          }
          const claimedRequest = value.claimed.descriptorBytes === null ? null
            : decodeTaskRuntimeBackgroundAuthorizationRequestV1(value.claimed.descriptorBytes);
          if (claimedRequest === null) throw new Error("Parked Task persistence request is missing");
          try {
            const jobId = await authority.withPlan({ occurrence: value.occurrence,
              record: value.claimed, request: claimedRequest }, held =>
              held.persistJob(value.payload));
            if (jobId === null) throw new Error("Parked Task persistence authority is stale");
            return jobId;
          } finally {
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(claimedRequest);
          }
        },
        recoverBeforeExecution: value => input.recoverClaim({
          expected: pinned.expected, jobReference: value.reference,
        }, value.claimed),
        start: async value => {
          if (value.claimed.snapshot.state !== "claimed"
            || value.claimed.snapshot.claimId !== value.claimId
            || Object.keys(value.reference).length !== Object.keys(reference).length
            || Object.entries(reference).some(([key, expectedValue]) =>
              Reflect.get(value.reference, key) !== expectedValue)) {
            return { status: "stale" };
          }
          const claimedRequest = value.claimed.descriptorBytes === null ? null
            : decodeTaskRuntimeBackgroundAuthorizationRequestV1(value.claimed.descriptorBytes);
          if (claimedRequest === null) return { status: "stale" };
          let startValue: StartInput | null;
          try {
            startValue = await authority.withPlan({ occurrence: value.occurrence,
              record: value.claimed, request: claimedRequest }, async held => {
              const manifest = await readManifest({
                logicalThreadId: held.resolved.expected.occurrence.run.graphThreadId,
                createDedicatedPool: input.createDedicatedPool,
              });
              return startInput(held.resolved, value, manifest);
            });
          } finally {
            destroyTaskRuntimeBackgroundAuthorizationRequestV1(claimedRequest);
          }
          if (startValue === null) return { status: "stale" };
          // Both the held product/crypto owner and fresh physical pool are closed.
          const result = "acceptance" in startValue
            ? await startHuman(input.db, startValue)
            : "continuationFingerprint" in startValue
              ? await startCheckpoint(input.db, startValue)
              : await start(input.db, startValue);
          return { status: result.status === "rejected" ? "stale" : "started" };
        },
        deferBeforeExecution: value => input.recoverUnstarted(
          startInput(pinned, value, priorManifest), value.claimed,
        ),
      };
    } finally {
      destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    }
  };
  const claim = createParkedTaskRuntimeGrantClaim({
    repository: input.repository, recipients: input.recipients,
    plan, withCurrentClaimAuthority: authority.claim,
    withCurrentAuthority: input.withCurrentAuthority, now: input.now,
  });
  return Object.freeze({
    prepareOrClaimExact: (occurrence: ProtectedTaskOccurrence) =>
      claim.prepareOrClaimExact(occurrence),
    plan,
  });
}

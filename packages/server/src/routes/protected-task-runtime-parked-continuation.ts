import {
  discoverParkedProtectedTaskAdditionalAuthority,
  getEncryptionTransitionPolicy,
  getProtectedTaskRunOutputBinding,
  startParkedProtectedTaskRunAdditionalAuthoritySegment,
  type DirectDatabase,
  type PostgresJsBridgeConnection,
  type ParkedProtectedTaskAdditionalAuthority,
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
  type ParkedTaskRuntimeAuthorizationPlan,
} from "./protected-task-runtime-parked-plan";
import { createProtectedTaskRuntimeParkedClaimAuthority } from "./protected-task-runtime-parked-claim-authority";
import type { ProtectedTaskRuntimeGrantPlanBuilderDependencies } from "./protected-task-runtime-grant-plan";

type StartInput = StartParkedProtectedTaskRunAdditionalAuthoritySegmentInput;
type Dependencies = Readonly<{
  resolvePlan: ReturnType<typeof createParkedTaskRuntimeAuthorizationPlanResolver>;
  authority: ReturnType<typeof createProtectedTaskRuntimeParkedClaimAuthority>;
  readManifest: typeof readProtectedTaskCheckpointPhysicalManifest;
  start: typeof startParkedProtectedTaskRunAdditionalAuthoritySegment;
}>;

function startInput(
  resolved: ParkedTaskRuntimeAuthorizationPlan,
  value: ParkedTaskRuntimeExecutionStartInput,
  checkpointManifest: StartInput["checkpointManifest"],
): StartInput {
  const { occurrence, priorJob, proof } = resolved.expected;
  return {
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
    continuation: {
      interruptId: proof.continuation.interruptId!,
      operationId: proof.continuation.operationId!,
      requestDigest: proof.continuation.requestDigest!,
      requiredAuthorityDigest: proof.continuation.requiredAuthorityDigest!,
      stableRoutingDigest: proof.continuation.stableRoutingDigest,
      semanticAuthorityRequirements: proof.continuation.semanticAuthorityRequirements,
    },
  };
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
    expected: ParkedProtectedTaskAdditionalAuthority;
    jobReference: ProtectedTaskDurableJobReference;
  }>, claimed: BackgroundAuthorizationTaskRuntimeRecordV3): Promise<boolean>;
  now(): number;
}>, overrides: Partial<Dependencies> = {}) {
  const resolvePlan = overrides.resolvePlan ?? createParkedTaskRuntimeAuthorizationPlanResolver({
    db: input.db, discover: discoverParkedProtectedTaskAdditionalAuthority,
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
      if (policy.mode === "plaintext_only"
        || expected.proof.segment.checkpointDigest === null
        || expected.proof.segment.checkpointBlobDigest === null
        || expected.proof.segment.pendingWriteDigest === null) return null;
      const reference = Object.freeze({
        kind: "protected_task_run_v1" as const,
        taskId: occurrence.task.id, taskRunId: occurrence.run.id,
        inputObjectId: occurrence.task.cryptoObjectId,
        resultObjectId: expected.priorJob.reference.resultObjectId,
        authorizationRequestId: expected.authorizationRequestId,
        policyRevision: canonical.authority.policyRevision,
        executionSegment: expected.nextExecutionSegment,
        resumeContinuationFingerprint: expected.continuationFingerprint,
      });
      const scheduling = Object.freeze({
        ownerId: occurrence.task.ownerId, requestorId: occurrence.task.requestorId,
        agentId: occurrence.task.agentId, roomId: memory.routing.targetRoomId,
        callingRoomId: occurrence.task.callingRoomId, graphThreadId: occurrence.run.graphThreadId,
      });
      const execution = await input.prepareExecution({
        occurrence, reference, policy: { ...policy, mode: policy.mode },
        predispatch: { occurrence, scheduling,
          target: { roomId: memory.routing.targetRoomId, targetUserIds: memory.routing.targetUserIds },
          memory: memory.resolution },
        stableRoutingDigest: expected.proof.continuation.stableRoutingDigest.slice(),
        additionalAuthorityResume: {
          interruptId: expected.proof.continuation.interruptId!,
          authorizationRequestId: expected.authorizationRequestId,
          effectDisposition: "not_started_v1",
          operationId: expected.proof.continuation.operationId!,
          requestDigest: expected.proof.continuation.requestDigest!.slice(),
          requiredAuthorityDigest: expected.proof.continuation.requiredAuthorityDigest!.slice(),
        },
        ...(memory.scopeMemory === undefined ? {} : {
          scopeMemory: memory.scopeMemory, scopeWorkIdentity: canonical.scopeWorkIdentity,
        }),
      });
      const priorManifest: StartInput["checkpointManifest"] = {
        contract: "encrypted_langgraph_v1",
        expectedCheckpointCount: expected.proof.segment.expectedCheckpointCount,
        checkpointOrderedDigest: expected.proof.segment.checkpointDigest.slice(),
        expectedBlobCount: expected.proof.segment.expectedCheckpointBlobCount,
        blobOrderedDigest: expected.proof.segment.checkpointBlobDigest.slice(),
        expectedPendingWriteCount: expected.proof.segment.expectedPendingWriteCount,
        pendingWriteOrderedDigest: expected.proof.segment.pendingWriteDigest.slice(),
      };
      return {
        stableIdentity: canonical.stableIdentity, initialRecord: canonical.initialRecord,
        reference, scheduling, ...execution,
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
          const result = await start(input.db, startValue);
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

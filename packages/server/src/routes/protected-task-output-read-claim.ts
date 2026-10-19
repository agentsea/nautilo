import { isDeepStrictEqual } from "node:util";

import { protectedTaskRunWakeJobId } from "@nautilo/db";
import type {
  TaskRuntimeRecipientRegistry,
  TaskRuntimeRunResultReadEvidence,
  TaskRuntimeRunResultReadPartitions,
  TaskRuntimeRunResultReadProof,
  TaskRuntimeWakeForegroundEvidence,
} from "@nautilo/lattice-crypto";
import {
  parseBackgroundAuthorizationRecord,
  sameTaskRuntimeAuthorityPlan,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
} from "@nautilo/runtime";
import {
  createProtectedTaskPublicationClaim,
  type TaskPublicationClaimDependencies,
  type TaskPublicationClaimInput,
} from "./protected-task-cancellation-claim";
import type { ProtectedTaskOutputReadAuthorityPort } from "./protected-task-output-read-authority";
import type { ProtectedTaskOutputReadPlan } from "./protected-task-output-read-plan";
import { readCommittedProtectedTaskWakePark, type ProtectedTaskWakeCommittedPark } from "./protected-task-output-read-product";

type WorkKind = "task.deliver_result" | "task.delivery_wake";
export type ProtectedTaskOutputReadPublication = (input: Readonly<{
  plan: ProtectedTaskOutputReadPlan;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  partitions: TaskRuntimeRunResultReadPartitions;
  evidence: TaskRuntimeRunResultReadEvidence;
  wakeEvidence?: TaskRuntimeWakeForegroundEvidence;
  signal: AbortSignal;
  assertCurrentClaim(): Promise<void>;
}>) => Promise<void | Readonly<{ status: "parked"; receipt: ProtectedTaskWakeCommittedPark }>>;

export type ProtectedTaskOutputReadParkCompletion = Readonly<{
  plan: ProtectedTaskOutputReadPlan;
  record: BackgroundAuthorizationTaskRuntimeRecordV3;
  receipt: ProtectedTaskWakeCommittedPark;
}>;

export type ProtectedTaskOutputReadClaimDependencies = Readonly<{
  workKind: WorkKind;
  authority: ProtectedTaskOutputReadAuthorityPort;
  recipients: Pick<TaskRuntimeRecipientRegistry, "withOpenedRunResultReadGrant" | "delete">;
  repository: TaskPublicationClaimDependencies<ProtectedTaskOutputReadPlan>["repository"];
  publish: ProtectedTaskOutputReadPublication;
  finishParkedWake?(input: ProtectedTaskOutputReadParkCompletion): Promise<BackgroundAuthorizationTaskRuntimeRecordV3 | null>;
  now?: () => number;
  claimId?: () => string;
}>;

function projections(plan: ProtectedTaskOutputReadPlan) {
  const namespaces = plan.initialRecord.authoritySet.namespaceRequirements;
  const source = namespaces.find(n => n.namespaceId === plan.intent.contentNamespaceId);
  const destination = plan.additionalMutationDestination;
  const mutation = destination === undefined ? undefined
    : namespaces.find(n => n.namespaceId === destination.namespaceId);
  if (source === undefined || destination !== undefined && (mutation === undefined
    || plan.intent.invocation.kind !== "wake"
    || destination.namespaceId === source.namespaceId
    || plan.foregroundNamespaceIds.includes(destination.namespaceId)
    || !/^[0-9a-f]{64}$/u.test(destination.semanticDigest)
    || !isDeepStrictEqual(mutation.operations, ["encrypt"]))) return null;
  return {
    result: { ...source, operations: ["decrypt"] as const },
    additionalMutationDestination: destination === undefined || mutation === undefined ? undefined
      : Object.freeze({ roomId: destination.roomId, semanticDigest: destination.semanticDigest,
        namespace: Object.freeze({ ...mutation, operations: Object.freeze(["encrypt"] as const) }) }),
    foreground: namespaces.filter(n => plan.foregroundNamespaceIds.includes(n.namespaceId))
      .map(n => ({ ...n, operations: plan.intent.invocation.kind === "raw"
        ? ["encrypt"] as const : ["decrypt", "encrypt"] as const })),
  };
}

function resultProof(plan: ProtectedTaskOutputReadPlan): TaskRuntimeRunResultReadProof | null {
  const source = projections(plan)?.result;
  return source === undefined ? null : Object.freeze({ ...plan.intent.result,
    genesisManifestHash: Uint8Array.from(plan.intent.result.genesisManifestHash),
    namespace: Object.freeze({ namespaceId: source.namespaceId, domainId: source.domainId,
      operations: Object.freeze(["decrypt"] as const),
      expectedAccessRevision: source.expectedAccessRevision,
      expectedPolicyRevision: source.expectedPolicyRevision }),
  });
}

function matchesPlan(record: BackgroundAuthorizationTaskRuntimeRecordV3,
  plan: ProtectedTaskOutputReadPlan, workKind: WorkKind): boolean {
  const { intent } = plan;
  const wake = intent.invocation.kind === "wake";
  const workId = wake ? protectedTaskRunWakeJobId(intent.result.taskRunId) : intent.result.taskRunId;
  const expectedRequest = wake ? `task-wake-authorization:${workId}`
    : `task-run-delivery-result-authorization:${workId}`;
  const projection = projections(plan);
  if (projection === null || workKind !== (wake ? "task.delivery_wake" : "task.deliver_result")
    || wake && intent.invocation.kind === "wake" && intent.invocation.jobId !== workId
    || record.workKind !== workKind || record.purpose !== workKind
    || record.snapshot.workId !== workId || record.snapshot.requestId !== expectedRequest
    || record.snapshot.namespaceId !== intent.contentNamespaceId
    || record.expectedPolicyRevision !== intent.expectedPolicyRevision
    || record.idempotencyKey !== plan.initialRecord.idempotencyKey
    || !/^task-output-read:[0-9a-f]{64}$/u.test(record.idempotencyKey)
    || plan.sourceRoomId !== intent.invocation.roomId
    || !sameTaskRuntimeAuthorityPlan(record, plan.initialRecord)
    || plan.foregroundNamespaceIds.length === 0
    || new Set(plan.foregroundNamespaceIds).size !== plan.foregroundNamespaceIds.length
    || projection.foreground.length !== plan.foregroundNamespaceIds.length
    || !wake && projection.foreground.length !== 1) return false;
  return record.authoritySet.namespaceRequirements.every(n => {
    const foreground = plan.foregroundNamespaceIds.includes(n.namespaceId);
    const expected = [
      ...(n.namespaceId === intent.contentNamespaceId || wake && foreground ? ["decrypt"] : []),
      ...(foreground || n.namespaceId === plan.additionalMutationDestination?.namespaceId ? ["encrypt"] : []),
    ];
    return expected.length > 0 && isDeepStrictEqual(n.operations, expected);
  });
}

/** One fresh claim for an exact terminal result and independently admitted destination. */
export function createProtectedTaskOutputReadClaim(dependencies: ProtectedTaskOutputReadClaimDependencies) {
  const claim = createProtectedTaskPublicationClaim<ProtectedTaskOutputReadPlan>({
    ...dependencies,
    coordinates: plan => ({ workId: plan.initialRecord.snapshot.workId,
      requesterUserId: plan.intent.requesterUserId }),
    matchesPlan: (record, plan) => matchesPlan(record, plan, dependencies.workKind),
    withAccepted: ({ plan, use, ...operation }) => dependencies.authority.withAccepted({
      ...operation,
      intent: plan.intent,
      use: async (current, ...handles) => {
        const projection = projections(plan);
        const result = resultProof(plan);
        if (projection === null || result === null
          || !isDeepStrictEqual(current.occurrence, {
            requesterHumanId: plan.intent.requesterHumanId,
            result, invocation: plan.intent.invocation,
          })
          || current.plan.authorizationId !== plan.initialRecord.snapshot.requestId
          || current.plan.subjectHumanId !== plan.intent.requesterHumanId
          || current.domains.length !== plan.initialRecord.authoritySet.domainRequirements.length
          || !current.domains.every(domain => plan.initialRecord.authoritySet.domainRequirements.some(
            expected => expected.domainId === domain.domainId
              && expected.expectedEpoch === domain.domainKeyGeneration
              && expected.expectedAuthorizationRevision === domain.authorizationRevision))
          || current.plan.sessionId !== plan.intent.invocation.sessionId
          || current.plan.roomId !== plan.sourceRoomId
          || current.policyRevision !== plan.intent.expectedPolicyRevision
          || !isDeepStrictEqual(current.namespaceRequirements,
            plan.initialRecord.authoritySet.namespaceRequirements)
          || !isDeepStrictEqual(current.resultNamespaceRequirement, projection.result)
          || !isDeepStrictEqual(current.foregroundNamespaceRequirements, projection.foreground)
          || !isDeepStrictEqual(current.namespaceAuthority.additionalMutationFact?.destination,
            plan.additionalMutationDestination)) return null;
        return use(current, ...handles);
      },
    }),
    openGrant: async ({ plan, request, certifiedSigning, authorizationBytes,
      record, claimId, claimExpiresAt, authority, signal, assertCurrentClaim }) => {
      const result = resultProof(plan);
      const projection = projections(plan);
      if (result === null || projection === null
        || request.episodeId !== plan.intent.invocation.sessionId
        || !isDeepStrictEqual(authority.namespaceRequirements,
          record.authoritySet.namespaceRequirements)) return false;
      const expectedPublication = Object.freeze(plan.intent.invocation.kind === "wake" ? {
        kind: "task.delivery_wake" as const,
        taskId: result.taskId,
        taskRunId: result.taskRunId,
        contentRevision: result.contentRevision,
        jobId: plan.intent.invocation.jobId,
        workIdentityHash: Uint8Array.from(record.workIdentityHash),
      } : {
        kind: "task.deliver_result" as const,
        taskId: result.taskId,
        taskRunId: result.taskRunId,
        contentRevision: 1 as const,
        workIdentityHash: Uint8Array.from(record.workIdentityHash),
      });
      try {
        const opened = await dependencies.recipients.withOpenedRunResultReadGrant({
          requestId: request.requestId, workId: request.workId,
          workKind: dependencies.workKind,
          recipientGeneration: record.snapshot.recipientGeneration,
          recipientKeyId: request.recipientKeyId, claimId, claimExpiresAt,
          authorizationBytes,
          current: authority.foreground, requesterHumanId: plan.intent.requesterHumanId,
          result, invocation: plan.intent.invocation,
          currentNamespaceRequirements: authority.namespaceRequirements,
          currentForegroundNamespaceRequirements: projection.foreground,
          ...(projection.additionalMutationDestination === undefined ? {} : {
            currentAdditionalMutationDestination: projection.additionalMutationDestination,
          }), signal,
          certifiedSigning: Object.freeze({
            ...certifiedSigning, expectedPublication,
          }),
          operation: async (partitions, activeSignal, evidence, wakeEvidence) => {
            await assertCurrentClaim();
            return dependencies.publish({ plan, record, partitions, evidence,
              signal: activeSignal, assertCurrentClaim,
              ...(wakeEvidence == null ? {} : { wakeEvidence }) });
          },
        });
        if (opened.status !== "opened") return false;
        if (opened.value === undefined) return true;
        if (dependencies.workKind !== "task.delivery_wake" || opened.value.status !== "parked"
          || dependencies.finishParkedWake === undefined) throw new TypeError("Task publication park is unavailable");
        readCommittedProtectedTaskWakePark(opened.value.receipt, plan.intent, record.snapshot.recipientGeneration);
        const parked = await dependencies.finishParkedWake({ plan, record, receipt: opened.value.receipt });
        if (parked === null) throw new Error("Task wake park authorization rotation is pending");
        return { status: "parked" as const, record: parked };
      } finally {
        result.genesisManifestHash.fill(0);
        expectedPublication.workIdentityHash.fill(0);
      }
    },
  });
  return (input: TaskPublicationClaimInput<ProtectedTaskOutputReadPlan>) => {
    // Borrowed authority may await; retain no caller-mutable proof bytes across it.
    const intent = input.plan.intent;
    const plan: ProtectedTaskOutputReadPlan = Object.freeze({ ...input.plan,
      initialRecord: parseBackgroundAuthorizationRecord(input.plan.initialRecord) as BackgroundAuthorizationTaskRuntimeRecordV3,
      foregroundNamespaceIds: Object.freeze([...input.plan.foregroundNamespaceIds]),
      ...(input.plan.additionalMutationDestination === undefined ? {} : {
        additionalMutationDestination: Object.freeze({ ...input.plan.additionalMutationDestination }),
      }),
      intent: Object.freeze({ ...intent,
        ...(intent.continuation === undefined ? {} : { continuation: structuredClone(intent.continuation) }),
        result: Object.freeze({ ...intent.result, genesisManifestHash: Uint8Array.from(intent.result.genesisManifestHash) }),
        invocation: Object.freeze(intent.invocation.kind === "raw" ? { ...intent.invocation }
          : { ...intent.invocation, reference: Object.freeze({ ...intent.invocation.reference }) }),
      }),
    });
    return claim({ ...input, plan });
  };
}

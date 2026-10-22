import { createHash } from "node:crypto";
import type { ProtectedTaskCancellationOutputIntent } from "@nautilo/db";
import { deriveTaskContentCryptoObjectIdV1 } from "@nautilo/lattice-bridge";
import type { InitialTaskRuntimeNamespaceAuthority } from "@nautilo/lattice-bridge/server";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { TaskRuntimeBackgroundAuthorizationRequestV3 } from
  "@nautilo/lattice-crypto/background";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type TaskRuntimeRecipientRequestPlan,
} from "@nautilo/runtime";
import { createProtectedTaskCancellationRecipientRequestPlan } from
  "./protected-task-runtime-recipient-request-plan";

export type ProtectedTaskCancellationPlan = TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
> & Readonly<{
  intent: ProtectedTaskCancellationOutputIntent;
  sourceRoomId: string;
}>;

export function protectedTaskCancellationRequestId(taskRunId: string): string {
  return `task-run-cancellation-result-authorization:${taskRunId}`;
}

function cancellationStableIdentity(intent: ProtectedTaskCancellationOutputIntent): string {
  return JSON.stringify([
    "nautilo/task-cancellation-result/v1", intent.taskId, intent.taskRunId,
    intent.requesterUserId, intent.agentId, intent.contentNamespaceId,
    intent.resultOperationId, intent.resultObjectId, intent.terminalAt.getTime(),
  ]);
}

export function protectedTaskCancellationIdempotencyKey(
  intent: ProtectedTaskCancellationOutputIntent,
): string {
  return `task-cancellation:${createHash("sha256").update(cancellationStableIdentity(intent)).digest("hex")}`;
}

/** A fixed publication identity, independent of every original execution Job. */
export function createProtectedTaskCancellationPlan(input: Readonly<{
  intent: ProtectedTaskCancellationOutputIntent;
  namespaceAuthority: InitialTaskRuntimeNamespaceAuthority;
  crypto: Pick<LatticeCrypto, "hash">;
  now: number;
  recipientTtlMs: number;
}>): ProtectedTaskCancellationPlan {
  const intent = Object.freeze({ ...input.intent,
    terminalAt: new Date(input.intent.terminalAt.getTime()),
  });
  const authority = input.namespaceAuthority;
  const fact = authority.facts[0];
  const coordinate = { kind: "run_result" as const, taskId: intent.taskId,
    taskRunId: intent.taskRunId, contentRevision: 2 };
  if (intent.taskStatus !== "cancelled" || intent.runStatus !== "cancelled"
    || intent.resultRevision !== 2
    || intent.resultObjectId !== deriveTaskContentCryptoObjectIdV1(coordinate)
    || intent.resultOperationId !== `task-run-cancelled-result:${intent.taskRunId}`
    || !Number.isSafeInteger(intent.terminalAt.getTime())
    || intent.terminalAt.getTime() > input.now
    || authority.sourceNamespaceId !== intent.contentNamespaceId
    || authority.facts.length !== 1 || fact === undefined
    || fact.namespaceId !== intent.contentNamespaceId
    || fact.expectedPolicyRevision !== intent.policyRevision) {
    throw new TypeError("Cancellation result plan does not match its stopped intent");
  }
  const namespaces = Object.freeze([Object.freeze({
    ordinal: 0, namespaceId: fact.namespaceId, domainId: fact.domainId,
    operations: Object.freeze(["encrypt"] as const),
    expectedAccessRevision: fact.expectedAccessRevision,
    expectedPolicyRevision: intent.policyRevision,
  })]);
  const domains = Object.freeze([Object.freeze({
    ordinal: 0, domainId: fact.domainId,
    expectedEpoch: fact.expectedDomainEpoch,
    expectedAuthorizationRevision: fact.expectedAuthorizationRevision,
  })]);
  const stableIdentity = cancellationStableIdentity(intent);
  const record = parseBackgroundAuthorizationRecord({
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({
      requestId: protectedTaskCancellationRequestId(intent.taskRunId),
      workId: intent.taskRunId, namespaceId: intent.contentNamespaceId, now: input.now,
    }),
    workIdentityHash: createHash("sha256").update(JSON.stringify([
      stableIdentity, authority.sourceRoomId, intent.representation,
      intent.policyRevision, namespaces, domains,
    ])).digest(),
    idempotencyKey: protectedTaskCancellationIdempotencyKey(intent),
    workKind: "task.cancel_result", purpose: "task.cancel_result",
    domainId: fact.domainId, processorAuthorizationRevision: null,
    expectedDomainEpoch: fact.expectedDomainEpoch,
    expectedNamespaceAccessRevision: fact.expectedAccessRevision,
    expectedPolicyRevision: intent.policyRevision,
    descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
    authoritySet: { namespaceRequirements: namespaces, domainRequirements: domains },
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
  return Object.freeze({
    intent, sourceRoomId: authority.sourceRoomId, initialRecord: record,
    ...createProtectedTaskCancellationRecipientRequestPlan({
      intent, initialRecord: record, sourceRoomId: authority.sourceRoomId,
      authority: { policyRevision: intent.policyRevision, namespaces, domains },
      crypto: input.crypto, createdAt: input.now, recipientTtlMs: input.recipientTtlMs,
    }),
  });
}

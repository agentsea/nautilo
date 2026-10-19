import { createHash } from "node:crypto";
import type { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { TaskRuntimeBackgroundAuthorizationRequestV3 } from
  "@nautilo/lattice-crypto/background";
import type { TaskOutputNamespaceAuthority } from "@nautilo/lattice-bridge/server";
import {
  createBackgroundAuthorizationTaskRuntimeRequestV3,
  parseBackgroundAuthorizationRecord,
  type BackgroundAuthorizationTaskRuntimeRecordV3,
  type TaskRuntimeRecipientRequestPlan,
} from "@nautilo/runtime";
import type { ProtectedTaskOutputReadIntent } from "./protected-task-output-read-product";
import { createProtectedTaskOutputReadRecipientRequestPlan } from "./protected-task-runtime-recipient-request-plan";

export type ProtectedTaskOutputReadPlan = TaskRuntimeRecipientRequestPlan<
  TaskRuntimeBackgroundAuthorizationRequestV3
> & Readonly<{
  intent: ProtectedTaskOutputReadIntent;
  foregroundNamespaceIds: readonly string[];
  sourceRoomId: string;
  additionalMutationDestination?: NonNullable<TaskOutputNamespaceAuthority["additionalMutationFact"]>["destination"];
}>;

/** Content-free result/invocation identity plus the current canonical grant partitions. */
export function createProtectedTaskOutputReadPlan(input: Readonly<{
  intent: ProtectedTaskOutputReadIntent;
  authority: TaskOutputNamespaceAuthority;
  crypto: Pick<LatticeCrypto, "hash">;
  now: number;
  recipientTtlMs: number;
}>): ProtectedTaskOutputReadPlan {
  const intent = Object.freeze({ ...input.intent,
    ...(input.intent.continuation === undefined ? {} : { continuation: structuredClone(input.intent.continuation) }),
    result: Object.freeze({ ...input.intent.result,
      genesisManifestHash: Uint8Array.from(input.intent.result.genesisManifestHash) }),
    invocation: Object.freeze(input.intent.invocation.kind === "raw" ? { ...input.intent.invocation }
      : { ...input.intent.invocation, reference: Object.freeze({ ...input.intent.invocation.reference }) }),
  });
  const { authority } = input;
  const privateFact = authority.resultFact;
  const factIsCurrent = (candidate: typeof privateFact) => authority.facts.some(f =>
    f.namespaceId === candidate.namespaceId && f.domainId === candidate.domainId
    && f.expectedAccessRevision === candidate.expectedAccessRevision
    && f.expectedPolicyRevision === candidate.expectedPolicyRevision
    && f.expectedDomainEpoch === candidate.expectedDomainEpoch
    && f.expectedAuthorizationRevision === candidate.expectedAuthorizationRevision);
  const foregroundNamespaceIds = Object.freeze(authority.foregroundFacts.map(n => n.namespaceId).sort());
  if (authority.sourceRoomId !== intent.invocation.roomId
    || authority.sourceNamespaceId !== intent.contentNamespaceId
    || privateFact.namespaceId !== intent.contentNamespaceId
    || privateFact.expectedPolicyRevision !== intent.expectedPolicyRevision
    || !factIsCurrent(privateFact)
    || authority.foregroundFacts.some(f => !factIsCurrent(f))) {
    throw new TypeError("Protected Task result-read planning authority changed");
  }
  const wake = intent.invocation.kind === "wake";
  const additional = authority.additionalMutationFact;
  if (additional !== undefined && (!wake || !factIsCurrent(additional.namespace)
    || additional.destination.namespaceId !== additional.namespace.namespaceId
    || additional.namespace.namespaceId === intent.contentNamespaceId
    || foregroundNamespaceIds.includes(additional.namespace.namespaceId)
    || !/^[0-9a-f]{64}$/u.test(additional.destination.semanticDigest))) {
    throw new TypeError("Protected Task mutation partition changed");
  }
  const mutation = additional === undefined ? undefined : Object.freeze({ ...additional.destination });
  const ids = [...new Set([intent.contentNamespaceId, ...foregroundNamespaceIds,
    ...(mutation === undefined ? [] : [mutation.namespaceId])])].sort();
  if (authority.facts.length !== ids.length) throw new TypeError("Protected Task result-read Namespace partition is incomplete");
  const namespaces = Object.freeze(authority.facts.map((fact, ordinal) => {
    if (fact.namespaceId !== ids[ordinal] || fact.expectedPolicyRevision !== intent.expectedPolicyRevision) {
      throw new TypeError("Protected Task result-read Namespace partition changed");
    }
    const foreground = foregroundNamespaceIds.includes(fact.namespaceId);
    return Object.freeze({ ordinal, namespaceId: fact.namespaceId, domainId: fact.domainId,
      operations: Object.freeze([
        ...(fact.namespaceId === intent.contentNamespaceId || wake && foreground ? ["decrypt" as const] : []),
        ...(foreground || mutation?.namespaceId === fact.namespaceId ? ["encrypt" as const] : []),
      ]), expectedAccessRevision: fact.expectedAccessRevision,
      expectedPolicyRevision: fact.expectedPolicyRevision });
  }));
  const byDomain = new Map<string, Readonly<{ domainId: string; expectedEpoch: number; expectedAuthorizationRevision: number }>>();
  for (const fact of authority.facts) {
    const prior = byDomain.get(fact.domainId);
    if (prior !== undefined && (prior.expectedEpoch !== fact.expectedDomainEpoch
      || prior.expectedAuthorizationRevision !== fact.expectedAuthorizationRevision)) {
      throw new TypeError("Protected Task result-read Domain partition changed");
    }
    byDomain.set(fact.domainId, Object.freeze({ domainId: fact.domainId,
      expectedEpoch: fact.expectedDomainEpoch, expectedAuthorizationRevision: fact.expectedAuthorizationRevision }));
  }
  const domains = Object.freeze([...byDomain.values()].sort((a, b) => a.domainId.localeCompare(b.domainId))
    .map((fact, ordinal) => Object.freeze({ ordinal, ...fact })));
  const workKind = wake ? "task.delivery_wake" : "task.deliver_result";
  const workId = intent.invocation.kind === "wake" ? intent.invocation.jobId : intent.result.taskRunId;
  const requestId = wake ? `task-wake-authorization:${workId}` : `task-run-delivery-result-authorization:${workId}`;
  const identity = (accessRevision: number) => JSON.stringify([
    "nautilo/task-output-read/v1", intent.requesterUserId, intent.requesterHumanId,
    intent.agentId, intent.contentNamespaceId, intent.representation, intent.acceptedPolicyRevision,
    intent.result.taskId, intent.result.taskRunId, intent.result.terminalStatus,
    intent.result.contentRevision, intent.result.objectId, accessRevision,
    Array.from(intent.result.genesisManifestHash), intent.result.signerAgentId, intent.invocation,
  ]);
  // Access-head changes rotate unclaimed authority, not the durable delivery identity.
  // Preserve the original head-zero key; the exact current head remains signed in the work hash.
  const stableIdentity = identity(0);
  const workIdentity = identity(intent.result.cryptoAccessRevision);
  const continuation = intent.continuation;
  const mutationIdentity = mutation === undefined ? [] : [mutation,
    ...(continuation === undefined ? [] : [[continuation.segment, continuation.priorRecipientGeneration,
      continuation.additionalAuthorizationRequestId, continuation.interruptId, continuation.operationId,
      Array.from(continuation.requestDigest), Array.from(continuation.requiredAuthorityDigest),
      Array.from(continuation.destinationAuthorityDigest), continuation.retainedSourceNamespaceIds,
      Array.from(continuation.sourceEnvelopeDigest), continuation.initialPolicyRevision,
      continuation.initialAgentAuthorizationRevision]])];
  const initialRecord = parseBackgroundAuthorizationRecord({
    snapshot: createBackgroundAuthorizationTaskRuntimeRequestV3({ requestId, workId,
      namespaceId: intent.contentNamespaceId, now: input.now }),
    workKind, purpose: workKind,
    workIdentityHash: createHash("sha256").update(JSON.stringify([workIdentity, namespaces, domains, ...mutationIdentity])).digest(),
    idempotencyKey: `task-output-read:${createHash("sha256").update(stableIdentity).digest("hex")}`,
    domainId: privateFact.domainId, expectedDomainEpoch: privateFact.expectedDomainEpoch,
    expectedNamespaceAccessRevision: privateFact.expectedAccessRevision,
    expectedPolicyRevision: intent.expectedPolicyRevision,
    processorAuthorizationRevision: null, descriptorBytes: null, acceptedMaterial: null, finishedAt: null,
    authoritySet: { namespaceRequirements: namespaces, domainRequirements: domains },
  }) as BackgroundAuthorizationTaskRuntimeRecordV3;
  return Object.freeze({ intent, foregroundNamespaceIds, initialRecord, sourceRoomId: authority.sourceRoomId,
    ...(mutation === undefined ? {} : { additionalMutationDestination: mutation }),
    ...createProtectedTaskOutputReadRecipientRequestPlan({ intent, foregroundNamespaceIds,
      ...(mutation === undefined ? {} : { additionalMutationDestination: mutation }),
      initialRecord, sourceRoomId: authority.sourceRoomId,
      authority: { policyRevision: intent.expectedPolicyRevision, namespaces, domains },
      crypto: input.crypto, createdAt: input.now, recipientTtlMs: input.recipientTtlMs }) });
}

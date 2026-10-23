import type { DomainForegroundSecretEntry, TaskRuntimeWakeForegroundEvidence, TaskRuntimeRunResultReadEvidence } from "@nautilo/lattice-crypto";
import { withTaskRuntimeWakeForegroundEvidenceV1 } from
  "../../../lattice-crypto/src/background/task-runtime-wake-foreground-evidence-v1.ts";
import { withTaskRuntimeRunResultReadEvidenceV1 } from
  "../../../lattice-crypto/src/background/task-runtime-run-result-read-evidence-v1.ts";
import { deriveTaskContentCryptoObjectIdV1 } from "../../src/task/task-content-repository.ts";

export async function withWakeEvidence<Value>(input: Readonly<{
  now: number; clock?: () => number; signal?: AbortSignal;
  domain: DomainForegroundSecretEntry; namespaceId: string;
  accessRevision: number; policyRevision: number; signerAgentId: string;
  additionalMutationDestination?: TaskRuntimeWakeForegroundEvidence["additionalMutationDestination"];
  execute(evidence: TaskRuntimeWakeForegroundEvidence, read: TaskRuntimeRunResultReadEvidence): Promise<Value> | Value;
}>): Promise<Value> {
  const taskId = "10000000-0000-4000-8000-000000000001";
  const taskRunId = "20000000-0000-4000-8000-000000000001";
  const jobId = "b863875e-d415-573f-8fb6-7b2f08303f3f";
  const bindingId = `task-run-output:${taskRunId}`;
  const operationId = `task-run-delivery-wake:${taskRunId}`;
  const objectId = deriveTaskContentCryptoObjectIdV1({ kind: "run_result", taskId, taskRunId, contentRevision: 1 });
  const publicDomain = { domainId: input.domain.domainId, sourceNamespaceId: input.domain.sourceNamespaceId,
    keyClass: "ai" as const, participantCount: input.domain.participantCount,
    participantDigest: input.domain.participantDigest, domainKeyGeneration: input.domain.domainKeyGeneration,
    authorizationRevision: input.domain.authorizationRevision, headDigest: input.domain.headDigest,
    activeNamespaceBindingCount: 2, activeNamespaceBindingSetDigest: new Uint8Array(32).fill(3) };
  return withTaskRuntimeRunResultReadEvidenceV1({ now: input.clock ?? (() => input.now),
    signal: input.signal ?? new AbortController().signal,
    evidence: {
      purpose: "task.runtime.run_result_read", workKind: "task.delivery_wake",
      requestId: `task-wake-authorization:${jobId}`, workId: jobId, claimId: "wake-claim",
      claimExpiresAt: input.now + 60_000, recipientExpiresAt: input.now + 60_000,
      authorizationExpiresAt: input.now + 60_000, expiresAt: input.now + 60_000,
      recipientGeneration: 1, recipientKeyId: "wake-recipient", authorizationDigest: new Uint8Array(32).fill(4),
      requesterHumanId: "wake-human", policyRevision: input.policyRevision,
      episodeId: "50000000-0000-4000-8000-000000000001", sourceRoomId: "40000000-0000-4000-8000-000000000001",
      hostAuthorizationRevision: 2, recipientAuthorizationRevision: 0, operations: ["decrypt"],
      result: { taskId, taskRunId, terminalStatus: "completed", contentRevision: 1, objectId,
        cryptoAccessRevision: 0, genesisManifestHash: new Uint8Array(32).fill(5), signerAgentId: input.signerAgentId,
        namespace: { namespaceId: "private-result", domainId: input.domain.domainId, operations: ["decrypt"],
          expectedAccessRevision: 1, expectedPolicyRevision: input.policyRevision } },
      invocation: { kind: "wake", bindingId, operationId, roomId: "40000000-0000-4000-8000-000000000001",
        sessionId: "50000000-0000-4000-8000-000000000001", jobId,
        reference: { kind: "protected_task_delivery_v1", taskId, taskRunId, bindingId,
          resultObjectId: objectId, wakeOperationId: operationId } },
      resultDomain: publicDomain, messageWrite: null,
    },
    execute: read => withTaskRuntimeWakeForegroundEvidenceV1({ readEvidence: read,
      committerDeviceId: "wake-device", committerDeviceSigningGeneration: 1,
      committerDeviceSigningPublicKeyHash: new Uint8Array(32).fill(6),
      ...(input.additionalMutationDestination === undefined ? {} : { additionalMutationDestination: input.additionalMutationDestination }),
      namespaceRequirements: [{ ordinal: 1, namespaceId: input.namespaceId, domainId: input.domain.domainId,
        operations: ["decrypt", "encrypt"], expectedAccessRevision: input.accessRevision,
        expectedPolicyRevision: input.policyRevision }], domainRequirements: [publicDomain],
      execute: evidence => input.execute(evidence, read),
    }),
  });
}

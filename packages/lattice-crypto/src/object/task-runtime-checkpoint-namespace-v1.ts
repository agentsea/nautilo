import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../background/task-runtime-execution-evidence-v1.ts";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  assertVerifiedNamespaceBindingHead,
  namespaceKeyringEnvelopeHash,
} from "../namespace/bindings.ts";
import { openNamespaceKeyring } from "../namespace/keyrings.ts";
import type { TaskRuntimeResultNamespaceSourceV1 } from
  "./task-runtime-result-preparation-v1.ts";

export type TaskRuntimeCheckpointNamespaceMaterialV1 = Readonly<{
  namespaceId: string;
  domainId: string;
  accessRevision: number;
  policyRevision: number;
  currentGeneration: number;
  generations: readonly Readonly<{ generation: number; key: Uint8Array }>[];
}>;

export type TaskRuntimeCheckpointIdentityV1 = Readonly<{
  taskId: string;
  taskRunId: string;
  sourceRoomId: string;
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Opens every retained AI Namespace generation only inside the live Task
 * grant. The caller supplies a fresh product/crypto authority check before
 * checkpoint COMMIT; no foreground grant or server-stored private key enters.
 */
export async function withTaskRuntimeCheckpointNamespaceV1<Value>(input: Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidenceV1;
  identity: TaskRuntimeCheckpointIdentityV1;
  namespace: TaskRuntimeResultNamespaceSourceV1;
  signal: AbortSignal;
  assertCurrentTaskAuthority(): Promise<void>;
  execute(
    material: TaskRuntimeCheckpointNamespaceMaterialV1,
    assertCommitAllowed: () => Promise<void>,
    assertActive: () => void,
  ): Value | PromiseLike<Value>;
}>): Promise<Value> {
  input.signal.throwIfAborted();
  assertAuthenticTaskRuntimeExecutionEvidenceV1(input.evidence);
  assertVerifiedNamespaceBindingHead(input.namespace.trustedHead);
  const evidence = input.evidence;
  const expected = input.identity;
  const head = input.namespace.trustedHead;
  const binding = head.binding;
  const requirements = evidence.namespaceRequirements.filter((requirement) =>
    requirement.namespaceId === expected.namespaceId);
  const requirement = requirements[0];
  const domains = evidence.domainRequirements.filter((domain) =>
    domain.domainId === expected.domainId);
  const domain = domains[0];
  const envelope = input.namespace.aiKeyringEnvelope;
  const envelopeHash = namespaceKeyringEnvelopeHash(envelope);
  try {
    if (
      evidence.result.taskId !== expected.taskId
      || evidence.result.taskRunId !== expected.taskRunId
      || evidence.workId !== expected.taskRunId
      || evidence.sourceRoomId !== expected.sourceRoomId
      || evidence.policyRevision !== expected.expectedPolicyRevision
      || evidence.result.namespace.namespaceId !== expected.namespaceId
      || evidence.result.namespace.domainId !== expected.domainId
      || requirements.length !== 1
      || requirement === undefined
      || requirement.domainId !== expected.domainId
      || requirement.expectedAccessRevision !== expected.expectedAccessRevision
      || requirement.expectedPolicyRevision !== expected.expectedPolicyRevision
      || requirement.operations.length !== 2
      || requirement.operations[0] !== "decrypt"
      || requirement.operations[1] !== "encrypt"
      || domains.length !== 1
      || domain === undefined
      || head.namespaceId !== expected.namespaceId
      || head.accessRevision !== expected.expectedAccessRevision
      || binding.namespaceId !== expected.namespaceId
      || binding.domainId !== expected.domainId
      || binding.accessRevision !== expected.expectedAccessRevision
      || binding.domainEpoch !== domain.domainKeyGeneration
      || envelope.keyClass !== "ai"
      || envelope.namespaceId !== expected.namespaceId
      || envelope.domainId !== expected.domainId
      || envelope.domainEpoch !== binding.domainEpoch
      || envelope.accessRevision !== expected.expectedAccessRevision
      || envelope.currentGeneration !== binding.aiCurrentGeneration
      || !sameBytes(envelopeHash, binding.aiKeyringEnvelopeHash)
    ) throw new TypeError("Task checkpoint Namespace authority was substituted");
  } finally {
    envelopeHash.fill(0);
  }

  await input.assertCurrentTaskAuthority();
  input.signal.throwIfAborted();
  assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);

  const keyring = openNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: input.namespace.currentDomainRoot,
    envelope,
    resolveHistoricalCommitter: input.namespace.resolveHistoricalCommitter,
  });
  try {
    if (keyring.namespaceId !== expected.namespaceId
      || keyring.keyClass !== "ai"
      || keyring.accessRevision !== expected.expectedAccessRevision
      || keyring.currentGeneration !== binding.aiCurrentGeneration
      || keyring.generations.length === 0) {
      throw new TypeError("Task checkpoint Namespace keyring was substituted");
    }
    const assertActive = (): void => {
      input.signal.throwIfAborted();
      assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
    };
    const assertCommitAllowed = async (): Promise<void> => {
      assertActive();
      await input.assertCurrentTaskAuthority();
      assertActive();
      assertVerifiedNamespaceBindingHead(head);
    };
    const material: TaskRuntimeCheckpointNamespaceMaterialV1 = Object.freeze({
      namespaceId: expected.namespaceId,
      domainId: expected.domainId,
      accessRevision: expected.expectedAccessRevision,
      policyRevision: expected.expectedPolicyRevision,
      currentGeneration: keyring.currentGeneration,
      generations: Object.freeze(keyring.generations.map((entry) => Object.freeze({
        generation: entry.generation,
        key: entry.key,
      }))),
    });
    assertActive();
    const value = await input.execute(material, assertCommitAllowed, assertActive);
    assertActive();
    return value;
  } finally {
    for (const entry of keyring.generations) entry.key.fill(0);
  }
}

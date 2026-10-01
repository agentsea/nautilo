import {
  assertAuthenticTaskRuntimeExecutionEvidence,
  accessRevision,
  namespaceBindingHash,
  namespaceId,
  verifyBindingEnvelopePair,
  verifyNamespaceBindingProof,
  type DomainForegroundSecretEntry,
  type HistoricalCommitterResolver,
  type LatticeCrypto,
  type LatticeStorage,
  type TaskRuntimeExecutionEvidence,
  type TaskRuntimeResultNamespaceSource,
} from "@nautilo/lattice-crypto";
import {
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/**
 * Lend the current result Namespace source inside an opened Task grant. The
 * current product/TaskRun authority is checked by the caller before and after
 * this read, and again by the result repository at commit.
 */
export async function withProtectedTaskResultNamespaceSource<Value>(input: Readonly<{
  crypto: LatticeCrypto;
  storage: Pick<LatticeStorage, "getNamespaceHead" | "getBinding">;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  signal: AbortSignal;
  resolveHistoricalCommitter: HistoricalCommitterResolver;
  assertCurrentTaskAuthority(): Promise<void>;
  execute(source: TaskRuntimeResultNamespaceSource): Value | PromiseLike<Value>;
}>): Promise<Value> {
  input.signal.throwIfAborted();
  assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  const result = input.evidence.result.namespace;
  const requirements = input.evidence.namespaceRequirements.filter((entry) =>
    entry.namespaceId === result.namespaceId
  );
  const domainRequirements = input.evidence.domainRequirements.filter((entry) =>
    entry.domainId === result.domainId
  );
  const matchingDomains = input.domains.filter((entry) =>
    entry.domainId === result.domainId
  );
  const requirement = requirements[0];
  const expectedDomain = domainRequirements[0];
  const openedDomain = matchingDomains[0];
  if (
    input.evidence.result.taskRunId !== input.evidence.workId
    || result.expectedPolicyRevision !== input.evidence.policyRevision
    || result.operations.length !== 1
    || result.operations[0] !== "encrypt"
    || requirements.length !== 1
    || requirement === undefined
    || requirement.domainId !== result.domainId
    || requirement.expectedAccessRevision !== result.expectedAccessRevision
    || requirement.expectedPolicyRevision !== result.expectedPolicyRevision
    || requirement.operations.length !== 2
    || requirement.operations[0] !== "decrypt"
    || requirement.operations[1] !== "encrypt"
    || domainRequirements.length !== 1
    || expectedDomain === undefined
    || matchingDomains.length !== 1
    || openedDomain === undefined
    || openedDomain.sourceNamespaceId !== expectedDomain.sourceNamespaceId
    || openedDomain.participantCount !== expectedDomain.participantCount
    || openedDomain.keyClass !== "ai"
    || openedDomain.domainKeyGeneration
      !== expectedDomain.domainKeyGeneration
    || openedDomain.authorizationRevision
      !== expectedDomain.authorizationRevision
    || !sameBytes(
      openedDomain.participantDigest,
      expectedDomain.participantDigest,
    )
    || !sameBytes(openedDomain.headDigest, expectedDomain.headDigest)
  ) throw new TypeError("Task result Domain authority was substituted");

  await input.assertCurrentTaskAuthority();
  input.signal.throwIfAborted();
  const [head, record] = await Promise.all([
    input.storage.getNamespaceHead(result.namespaceId),
    input.storage.getBinding(
      result.namespaceId,
      result.expectedAccessRevision,
    ),
  ]);
  if (head === null || record === null) {
    throw new TypeError("Task result Namespace source is unavailable");
  }
  const binding = parseNamespaceBindingV2(record.signedBindingBytes);
  const humanEnvelope = parseNamespaceKeyringEnvelopeV2(
    record.humanKeyringEnvelopeBytes,
  );
  const aiEnvelope = parseNamespaceKeyringEnvelopeV2(
    record.aiKeyringEnvelopeBytes,
  );
  const bindingHash = namespaceBindingHash(binding);
  try {
    if (
      head.namespaceId !== result.namespaceId
      || head.accessRevision !== result.expectedAccessRevision
      || head.domainId !== result.domainId
      || head.domainEpoch !== expectedDomain.domainKeyGeneration
      || record.namespaceId !== head.namespaceId
      || record.revision !== head.accessRevision
      || binding.namespaceId !== head.namespaceId
      || binding.accessRevision !== head.accessRevision
      || binding.domainId !== head.domainId
      || binding.domainEpoch !== head.domainEpoch
      || !sameBytes(bindingHash, head.bindingHash)
      || !sameBytes(bindingHash, record.bindingHash)
      || !verifyBindingEnvelopePair(binding, humanEnvelope, aiEnvelope)
    ) throw new TypeError("Task result Namespace binding was substituted");

    // The current head is the product-authority anchor. The verifier still
    // authenticates the signed binding before issuing its process-local proof.
    const trustedHead = verifyNamespaceBindingProof({
      crypto: input.crypto,
      anchor: {
        namespaceId: namespaceId(head.namespaceId),
        accessRevision: accessRevision(head.accessRevision),
        bindingHash: head.bindingHash,
      },
      proof: [binding],
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    await input.assertCurrentTaskAuthority();
    input.signal.throwIfAborted();
    assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
    return await input.execute(Object.freeze({
      trustedHead,
      aiKeyringEnvelope: aiEnvelope,
      currentDomainRoot: openedDomain.domainKey,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    }));
  } finally {
    bindingHash.fill(0);
  }
}

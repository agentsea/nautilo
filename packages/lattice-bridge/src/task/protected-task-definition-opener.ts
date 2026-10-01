import {
  accessRevision,
  assertAuthenticTaskRuntimeExecutionEvidence,
  assertVerifiedNamespaceBindingHead,
  decryptObjectThroughNamespace,
  namespaceKeyringEnvelopeHash,
  objectId,
  openNamespaceKeyring,
  verifyCommonObjectAccessManifestChain,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  type LatticeStorage,
  type ResolveCommonHistoricalHumanDeviceSigningPublicKey,
  type TaskRuntimeExecutionEvidence,
  type TaskRuntimeResultNamespaceSource,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  deriveTaskContentCryptoObjectIdV1,
  TASK_DEFINITION_OBJECT_TYPE_V1,
} from "./task-content-repository.ts";
import {
  decodeTaskPayloadV1,
  type TaskPayloadV1,
} from "./task-payload-v1.ts";

export type ProtectedTaskDefinitionOccurrenceV1 = Readonly<{
  taskId: string;
  requesterHumanId: string;
  objectId: string;
  contentRevision: number;
  cryptoAccessRevision: 0;
  namespaceId: string;
  domainId: string;
  expectedAccessRevision: number;
  expectedPolicyRevision: number;
}>;

export type ProtectedTaskDefinitionNamespaceSourceV1 = Omit<
  TaskRuntimeResultNamespaceSource,
  "currentDomainRoot"
>;

export type OpenProtectedTaskDefinitionInputV1<Value> = Readonly<{
  crypto: LatticeCrypto;
  evidence: TaskRuntimeExecutionEvidence;
  domains: readonly DomainForegroundSecretEntry[];
  storage: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
  namespace: ProtectedTaskDefinitionNamespaceSourceV1;
  resolveHistoricalHumanDeviceSigningPublicKey:
    ResolveCommonHistoricalHumanDeviceSigningPublicKey;
  signal: AbortSignal;
  loadCurrentOccurrence():
    Promise<ProtectedTaskDefinitionOccurrenceV1 | null>;
  execute(
    payload: TaskPayloadV1,
    assertCurrentOccurrence: () => Promise<void>,
  ): Value | PromiseLike<Value>;
}>;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameOccurrence(
  left: ProtectedTaskDefinitionOccurrenceV1,
  right: ProtectedTaskDefinitionOccurrenceV1,
): boolean {
  return left.taskId === right.taskId
    && left.requesterHumanId === right.requesterHumanId
    && left.objectId === right.objectId
    && left.contentRevision === right.contentRevision
    && left.cryptoAccessRevision === right.cryptoAccessRevision
    && left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.expectedAccessRevision === right.expectedAccessRevision
    && left.expectedPolicyRevision === right.expectedPolicyRevision;
}

function exactDomain(
  evidence: TaskRuntimeExecutionEvidence,
  domains: readonly DomainForegroundSecretEntry[],
  domainId: string,
): Readonly<{
  requirement: TaskRuntimeExecutionEvidence["domainRequirements"][number];
  secret: DomainForegroundSecretEntry;
}> {
  const requirements = evidence.domainRequirements.filter((entry) =>
    entry.domainId === domainId
  );
  const secrets = domains.filter((entry) => entry.domainId === domainId);
  const requirement = requirements[0];
  const secret = secrets[0];
  if (
    requirements.length !== 1
    || secrets.length !== 1
    || requirement === undefined
    || secret === undefined
    || secret.sourceNamespaceId !== requirement.sourceNamespaceId
    || !sameBytes(secret.participantDigest, requirement.participantDigest)
    || secret.participantCount !== requirement.participantCount
    || secret.keyClass !== "ai"
    || secret.domainKeyGeneration !== requirement.domainKeyGeneration
    || secret.authorizationRevision !== requirement.authorizationRevision
    || !sameBytes(secret.headDigest, requirement.headDigest)
  ) throw new TypeError("Task definition Domain authority was substituted");
  return Object.freeze({ requirement, secret });
}

function assertOccurrenceAuthority(
  evidence: TaskRuntimeExecutionEvidence,
  occurrence: ProtectedTaskDefinitionOccurrenceV1,
): void {
  const requirements = evidence.namespaceRequirements.filter((entry) =>
    entry.namespaceId === occurrence.namespaceId
  );
  const requirement = requirements[0];
  if (
    evidence.result.taskId !== occurrence.taskId
    || evidence.result.namespace.operations.length !== 1
    || evidence.result.namespace.operations[0] !== "encrypt"
    || evidence.result.namespace.namespaceId !== occurrence.namespaceId
    || evidence.result.namespace.domainId !== occurrence.domainId
    || evidence.result.namespace.expectedAccessRevision
      !== occurrence.expectedAccessRevision
    || evidence.result.namespace.expectedPolicyRevision
      !== occurrence.expectedPolicyRevision
    || evidence.policyRevision !== occurrence.expectedPolicyRevision
    || occurrence.objectId !== deriveTaskContentCryptoObjectIdV1({
      kind: "definition",
      taskId: occurrence.taskId,
      contentRevision: occurrence.contentRevision,
    })
    || occurrence.cryptoAccessRevision !== 0
    || requirements.length !== 1
    || requirement === undefined
    || requirement.domainId !== occurrence.domainId
    || requirement.expectedAccessRevision !== occurrence.expectedAccessRevision
    || requirement.expectedPolicyRevision !== occurrence.expectedPolicyRevision
    || requirement.operations.length !== 2
    || requirement.operations[0] !== "decrypt"
    || requirement.operations[1] !== "encrypt"
  ) throw new TypeError("Task definition occurrence authority was substituted");
}

/**
 * Opens one current protected Task definition only inside its live Task Runtime
 * grant. Task and Namespace source resolution remain with the caller; this
 * helper authenticates their exact coordinates and never releases plaintext
 * bytes or opened Namespace keys from the callback scope.
 */
export async function withProtectedTaskDefinitionV1<Value>(
  input: OpenProtectedTaskDefinitionInputV1<Value>,
): Promise<Value> {
  const assertActive = (): void => {
    input.signal.throwIfAborted();
    assertAuthenticTaskRuntimeExecutionEvidence(input.evidence);
  };
  assertActive();
  const occurrence = await input.loadCurrentOccurrence();
  assertActive();
  if (occurrence === null) {
    throw new TypeError("Current protected Task definition is unavailable");
  }
  assertOccurrenceAuthority(input.evidence, occurrence);
  const { requirement: domainRequirement, secret: domain } = exactDomain(
    input.evidence,
    input.domains,
    occurrence.domainId,
  );

  assertVerifiedNamespaceBindingHead(input.namespace.trustedHead);
  const head = input.namespace.trustedHead;
  const binding = head.binding;
  const envelope = input.namespace.aiKeyringEnvelope;
  const envelopeHash = namespaceKeyringEnvelopeHash(envelope);
  let domainRoot: Uint8Array | undefined;
  let keyring: ReturnType<typeof openNamespaceKeyring> | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    if (
      head.namespaceId !== occurrence.namespaceId
      || head.accessRevision !== occurrence.expectedAccessRevision
      || binding.namespaceId !== occurrence.namespaceId
      || binding.domainId !== occurrence.domainId
      || binding.domainEpoch !== domainRequirement.domainKeyGeneration
      || binding.accessRevision !== occurrence.expectedAccessRevision
      || envelope.keyClass !== "ai"
      || envelope.namespaceId !== occurrence.namespaceId
      || envelope.domainId !== occurrence.domainId
      || envelope.domainEpoch !== binding.domainEpoch
      || envelope.accessRevision !== binding.accessRevision
      || envelope.currentGeneration !== binding.aiCurrentGeneration
      || !sameBytes(envelopeHash, binding.aiKeyringEnvelopeHash)
    ) throw new TypeError("Task definition Namespace authority was substituted");

    const [storedObject, access] = await Promise.all([
      input.storage.getObject(occurrence.objectId),
      input.storage.getObjectAccessState(occurrence.objectId),
    ]);
    assertActive();
    if (
      storedObject === null
      || access === null
      || storedObject.objectId !== occurrence.objectId
      || access.head.objectId !== occurrence.objectId
      || access.head.accessRevision !== 0
      || access.namespaceEnvelopes.length !== 1
      || access.namespaceEnvelopes[0]?.namespaceId !== occurrence.namespaceId
    ) throw new TypeError("Task definition ciphertext is incomplete");

    const payload = decodeEncryptedPayloadV2(storedObject.payloadBytes);
    const namespaceEnvelope = decodeNamespaceObjectEnvelopeV2(
      access.namespaceEnvelopes[0].envelopeBytes,
    );
    const payloadHash = input.crypto.hash(storedObject.payloadBytes);
    const manifestHash = input.crypto.hash(access.head.manifestBytes);
    const storedEnvelopeHash = input.crypto.hash(
      access.namespaceEnvelopes[0].envelopeBytes,
    );
    try {
      if (
        payload.context.objectId !== occurrence.objectId
        || payload.context.objectType !== TASK_DEFINITION_OBJECT_TYPE_V1
        || payload.context.keyClass !== "ai"
        || !sameBytes(manifestHash, access.head.manifestHash)
        || !sameBytes(
          storedEnvelopeHash,
          access.namespaceEnvelopes[0].envelopeHash,
        )
        || namespaceEnvelope.context.objectId !== occurrence.objectId
        || namespaceEnvelope.context.namespaceId !== occurrence.namespaceId
        || namespaceEnvelope.context.keyClass !== "ai"
        || namespaceEnvelope.context.bindingRevisionAtWrap
          !== occurrence.expectedAccessRevision
      ) throw new TypeError("Task definition ciphertext coordinates are invalid");

      const verified = verifyCommonObjectAccessManifestChain(input.crypto, {
        manifestBytes: access.head.manifestBytes,
        proof: [],
        trustedMinimumHead: {
          objectId: objectId(occurrence.objectId),
          payloadHash,
          accessRevision: accessRevision(0),
          manifestHash: access.head.manifestHash,
        },
        resolveHistoricalHumanDeviceSigningPublicKey:
          input.resolveHistoricalHumanDeviceSigningPublicKey,
        resolveAgentRuntimeSignerPublicKey: () => null,
        resolveProcessorSignerAuthorizationBytes: () => null,
        resolveHistoricalProcessorIssuingDevicePublicKey: () => null,
      });
      try {
        if (
          verified.manifest.accessRevision !== 0
          || verified.manifest.previousManifestHash !== null
          || verified.manifest.signer.kind !== "human_device"
          || verified.manifest.signer.subjectHumanId
            !== occurrence.requesterHumanId
          || verified.manifest.envelopeHashes.length !== 1
          || !sameBytes(
            verified.manifest.envelopeHashes[0]!,
            storedEnvelopeHash,
          )
        ) throw new TypeError("Task definition access manifest is invalid");
      } finally {
        verified.manifest.payloadHash.fill(0);
        verified.manifest.envelopeHashes.forEach((hash) => hash.fill(0));
        verified.manifest.signature.fill(0);
        verified.manifestBytes.fill(0);
        verified.manifestHash.fill(0);
      }

      domainRoot = domain.domainKey.slice();
      keyring = openNamespaceKeyring({
        crypto: input.crypto,
        domainRoot,
        envelope,
        resolveHistoricalCommitter: input.namespace.resolveHistoricalCommitter,
      });
      const generation = keyring.generations.find((entry) =>
        entry.generation === namespaceEnvelope.context.keyGeneration
      );
      if (
        keyring.namespaceId !== occurrence.namespaceId
        || keyring.keyClass !== "ai"
        || keyring.accessRevision !== occurrence.expectedAccessRevision
        || keyring.currentGeneration !== binding.aiCurrentGeneration
        || generation === undefined
        || generation.generation !== namespaceEnvelope.context.keyGeneration
      ) throw new TypeError("Task definition Namespace key is unavailable");
      plaintext = decryptObjectThroughNamespace(
        input.crypto,
        generation.key,
        namespaceEnvelope,
        payload,
      ) ?? undefined;
      if (plaintext === undefined) {
        throw new TypeError("Task definition ciphertext could not be opened");
      }
      const decoded = decodeTaskPayloadV1(plaintext);
      assertActive();
      const assertCurrentOccurrence = async (): Promise<void> => {
        assertActive();
        const current = await input.loadCurrentOccurrence();
        assertActive();
        if (current === null || !sameOccurrence(occurrence, current)) {
          throw new TypeError("Protected Task definition changed while open");
        }
      };
      const value = await input.execute(decoded, assertCurrentOccurrence);
      await assertCurrentOccurrence();
      return value;
    } finally {
      payloadHash.fill(0);
      manifestHash.fill(0);
      storedEnvelopeHash.fill(0);
      payload.ciphertext.fill(0);
      namespaceEnvelope.wrappedDek.fill(0);
    }
  } finally {
    plaintext?.fill(0);
    domainRoot?.fill(0);
    if (keyring !== undefined) {
      for (const generation of keyring.generations) generation.key.fill(0);
    }
    envelopeHash.fill(0);
  }
}

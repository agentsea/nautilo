import type { LatticeCrypto } from "../crypto/index.ts";
import {
  assertCanonicalNamespaceKeyring,
  assertNamespaceKeyringEnvelope,
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
  namespaceKeyringEnvelopeAad,
  namespaceKeyringEnvelopeSigningBytes,
} from "../format/namespace-keyring-v2.ts";
import {
  type CurrentCommitterResolverV2,
  type HistoricalCommitterResolverV2,
  type NamespaceCommitterContextV2,
} from "./authorization.ts";
import {
  HASH_BYTES,
  NAMESPACE_KEY_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  type NamespaceKeyClass,
  type NamespaceKeyringEnvelopeV2,
  type NamespaceKeyringPlaintextV2,
  type NamespaceKeyringResealMetadataV2,
  type NamespaceKeyringSealMetadataV2,
} from "./types.ts";
import {
  type NamespaceId,
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

function assertBytes(
  label: string,
  value: unknown,
  expectedLength: number,
): asserts value is Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== expectedLength) {
    throw new RangeError(`${label} must contain exactly ${expectedLength} bytes`);
  }
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function freezeKeyring(
  keyring: NamespaceKeyringPlaintextV2,
): NamespaceKeyringPlaintextV2 {
  const generations = keyring.generations.map((entry) =>
    Object.freeze({
      generation: entry.generation,
      key: copyOwnedBytesV2(entry.key),
    })
  );
  return Object.freeze({
    ...keyring,
    generations: Object.freeze(generations),
  });
}

function wipeKeyring(
  keyring: NamespaceKeyringPlaintextV2 | null,
): void {
  if (keyring === null) return;
  for (const generation of keyring.generations) {
    generation.key.fill(0);
  }
}

function committerContext(
  envelope: NamespaceKeyringEnvelopeV2,
): NamespaceCommitterContextV2 {
  return Object.freeze({
    purpose: "namespace-keyring-envelope",
    namespaceId: envelope.namespaceId,
    domainId: envelope.domainId,
    domainEpoch: envelope.domainEpoch,
    accessRevision: envelope.accessRevision,
    committerDeviceId: envelope.committerDeviceId,
    previousBindingHash: envelope.previousBindingHash,
  });
}

function initialKeyring(
  crypto: LatticeCrypto,
  targetNamespaceId: NamespaceId,
  keyClass: NamespaceKeyClass,
): NamespaceKeyringPlaintextV2 {
  const key = crypto.randomBytes(NAMESPACE_KEY_BYTES);
  try {
    assertBytes("Random Namespace key", key, NAMESPACE_KEY_BYTES);
    return freezeKeyring({
      formatVersion: 2,
      namespaceId: targetNamespaceId,
      keyClass,
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(0),
      generations: [{ generation: namespaceGeneration(0), key }],
    });
  } finally {
    key.fill(0);
  }
}

export function createInitialNamespaceKeyrings(
  crypto: LatticeCrypto,
  targetNamespaceId: NamespaceId,
): Readonly<{
  human: NamespaceKeyringPlaintextV2;
  ai: NamespaceKeyringPlaintextV2;
}> {
  namespaceId(targetNamespaceId);
  let human: NamespaceKeyringPlaintextV2 | null = null;
  let ai: NamespaceKeyringPlaintextV2 | null = null;
  let transferred = false;
  try {
    human = initialKeyring(
      crypto,
      targetNamespaceId,
      "human",
    );
    ai = initialKeyring(
      crypto,
      targetNamespaceId,
      "ai",
    );
    transferred = true;
    return Object.freeze({ human, ai });
  } finally {
    if (!transferred) {
      wipeKeyring(ai);
      wipeKeyring(human);
    }
  }
}

export function appendNamespaceGeneration(
  crypto: LatticeCrypto,
  keyring: NamespaceKeyringPlaintextV2,
): NamespaceKeyringPlaintextV2 {
  assertCanonicalNamespaceKeyring(keyring);
  if (
    keyring.generations.length >= V2_LIMITS.retainedNamespaceGenerations
  ) {
    throw new RangeError(
      "Namespace keyring reached the 4,096 generation maintenance ceiling",
    );
  }
  const nextNumber = Number(keyring.currentGeneration) + 1;
  const nextGeneration = namespaceGeneration(nextNumber);
  const key = crypto.randomBytes(NAMESPACE_KEY_BYTES);
  try {
    assertBytes("Random Namespace key", key, NAMESPACE_KEY_BYTES);
    return freezeKeyring({
      ...keyring,
      currentGeneration: nextGeneration,
      generations: [
        ...keyring.generations,
        { generation: nextGeneration, key },
      ],
    });
  } finally {
    key.fill(0);
  }
}

export interface SealNamespaceKeyringInputV2 {
  readonly crypto: LatticeCrypto;
  readonly domainRoot: Uint8Array;
  readonly keyring: NamespaceKeyringPlaintextV2;
  readonly metadata: NamespaceKeyringSealMetadataV2;
  readonly committerSigningPrivateKey: Uint8Array;
  readonly resolveCurrentCommitter: CurrentCommitterResolverV2;
}

export function sealNamespaceKeyring(
  input: SealNamespaceKeyringInputV2,
): NamespaceKeyringEnvelopeV2 {
  assertCanonicalNamespaceKeyring(input.keyring);
  assertBytes("Domain root", input.domainRoot, NAMESPACE_KEY_BYTES);
  assertBytes(
    "Committer signing private key",
    input.committerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  cryptoDomainId(input.metadata.domainId);
  domainEpoch(input.metadata.domainEpoch);
  cryptoDeviceId(input.metadata.committerDeviceId);
  if (input.metadata.previousBindingHash !== null) {
    assertBytes(
      "Previous binding hash",
      input.metadata.previousBindingHash,
      HASH_BYTES,
    );
  }
  const unsigned: NamespaceKeyringEnvelopeV2 = {
    formatVersion: 2,
    namespaceId: input.keyring.namespaceId,
    keyClass: input.keyring.keyClass,
    domainId: input.metadata.domainId,
    domainEpoch: input.metadata.domainEpoch,
    accessRevision: input.keyring.accessRevision,
    currentGeneration: input.keyring.currentGeneration,
    previousBindingHash: input.metadata.previousBindingHash === null
      ? null
      : copyOwnedBytesV2(input.metadata.previousBindingHash),
    ciphertext: new Uint8Array(40),
    committerDeviceId: input.metadata.committerDeviceId,
    signature: new Uint8Array(V2_LIMITS.signatureBytes),
  };
  const currentPublicKey = input.resolveCurrentCommitter(
    committerContext(unsigned),
  );
  if (currentPublicKey === null) {
    throw new Error(
      "Namespace keyring current committer is not authorized and unrevoked",
    );
  }
  assertBytes(
    "Current committer signing public key",
    currentPublicKey,
    SIGNING_PUBLIC_KEY_BYTES,
  );
  const plaintext = encodeNamespaceKeyring(input.keyring);
  try {
    const ciphertext = input.crypto.aeadSeal(
      input.domainRoot,
      plaintext,
      namespaceKeyringEnvelopeAad(unsigned),
    );
    const withCiphertext = {
      ...unsigned,
      ciphertext: copyOwnedBytesV2(ciphertext),
    };
    const signature = input.crypto.sign(
      input.committerSigningPrivateKey,
      namespaceKeyringEnvelopeSigningBytes(withCiphertext),
    );
    const envelope: NamespaceKeyringEnvelopeV2 = {
      ...withCiphertext,
      signature: copyOwnedBytesV2(signature),
    };
    if (
      !input.crypto.verify(
        currentPublicKey,
        namespaceKeyringEnvelopeSigningBytes(envelope),
        envelope.signature,
      )
    ) {
      throw new Error(
        "Namespace keyring committer private key does not match the registered device",
      );
    }
    assertNamespaceKeyringEnvelope(envelope);
    return Object.freeze(envelope);
  } finally {
    plaintext.fill(0);
  }
}

export interface VerifyNamespaceKeyringInputV2 {
  readonly crypto: LatticeCrypto;
  readonly envelope: NamespaceKeyringEnvelopeV2;
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}

export function verifyNamespaceKeyringEnvelope(
  input: VerifyNamespaceKeyringInputV2,
): true {
  assertNamespaceKeyringEnvelope(input.envelope);
  const publicKey = input.resolveHistoricalCommitter(
    committerContext(input.envelope),
  );
  if (publicKey === null) {
    throw new Error(
      "Namespace keyring committer is absent from the authenticated historical roster",
    );
  }
  assertBytes(
    "Historical committer signing public key",
    publicKey,
    SIGNING_PUBLIC_KEY_BYTES,
  );
  if (
    !input.crypto.verify(
      publicKey,
      namespaceKeyringEnvelopeSigningBytes(input.envelope),
      input.envelope.signature,
    )
  ) {
    throw new Error("Namespace keyring envelope signature is invalid");
  }
  return true;
}

export interface OpenNamespaceKeyringInputV2
  extends VerifyNamespaceKeyringInputV2 {
  readonly domainRoot: Uint8Array;
}

export function openNamespaceKeyring(
  input: OpenNamespaceKeyringInputV2,
): NamespaceKeyringPlaintextV2 {
  assertBytes("Domain root", input.domainRoot, NAMESPACE_KEY_BYTES);
  verifyNamespaceKeyringEnvelope(input);
  const plaintext = input.crypto.aeadOpen(
    input.domainRoot,
    input.envelope.ciphertext,
    namespaceKeyringEnvelopeAad(input.envelope),
  );
  if (plaintext === null) {
    throw new Error("Namespace keyring envelope failed to decrypt");
  }
  let keyring: NamespaceKeyringPlaintextV2 | null = null;
  let transferred = false;
  try {
    keyring = decodeNamespaceKeyring(plaintext);
    if (
      keyring.namespaceId !== input.envelope.namespaceId
      || keyring.keyClass !== input.envelope.keyClass
      || keyring.accessRevision !== input.envelope.accessRevision
      || keyring.currentGeneration !== input.envelope.currentGeneration
    ) {
      throw new Error(
        "Namespace keyring inner and outer metadata do not match",
      );
    }
    transferred = true;
    return keyring;
  } finally {
    if (!transferred) wipeKeyring(keyring);
    plaintext.fill(0);
  }
}

export interface ResealNamespaceKeyringInputV2 {
  readonly crypto: LatticeCrypto;
  readonly oldDomainRoot: Uint8Array;
  readonly oldEnvelope: NamespaceKeyringEnvelopeV2;
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
  readonly newDomainRoot: Uint8Array;
  readonly newMetadata: NamespaceKeyringResealMetadataV2;
  readonly newCommitterSigningPrivateKey: Uint8Array;
  readonly resolveSourceCommitter: CurrentCommitterResolverV2;
  readonly resolveCurrentCommitter: CurrentCommitterResolverV2;
  readonly rotateGeneration: boolean;
}

/**
 * Build the detached plaintext for a verified keyring transition. Callers
 * that preflight a batch can use this after all authorization and opening
 * work has completed, without resolving historical state a second time.
 */
export function prepareNamespaceKeyringRevision(
  crypto: LatticeCrypto,
  opened: NamespaceKeyringPlaintextV2,
  nextAccessRevision: number,
  rotateGeneration: boolean,
): NamespaceKeyringPlaintextV2 {
  assertCanonicalNamespaceKeyring(opened);
  const nextRevision = accessRevision(nextAccessRevision);
  if (Number(nextRevision) !== Number(opened.accessRevision) + 1) {
    throw new RangeError(
      "Namespace keyring reseal must advance access revision exactly once",
    );
  }
  const retained = rotateGeneration
    ? appendNamespaceGeneration(crypto, opened)
    : freezeKeyring(opened);
  try {
    return freezeKeyring({
      ...retained,
      accessRevision: nextRevision,
    });
  } finally {
    wipeKeyring(retained);
  }
}

export function resealNamespaceKeyring(
  input: ResealNamespaceKeyringInputV2,
): NamespaceKeyringEnvelopeV2 {
  let opened: NamespaceKeyringPlaintextV2 | null = null;
  let revised: NamespaceKeyringPlaintextV2 | null = null;
  try {
    opened = openNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: input.oldDomainRoot,
      envelope: input.oldEnvelope,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    const targetContext: NamespaceCommitterContextV2 = Object.freeze({
      purpose: "namespace-keyring-envelope",
      namespaceId: opened.namespaceId,
      domainId: input.newMetadata.domainId,
      domainEpoch: input.newMetadata.domainEpoch,
      accessRevision: input.newMetadata.accessRevision,
      committerDeviceId: input.newMetadata.committerDeviceId,
      previousBindingHash:
        input.newMetadata.previousBindingHash === null
          ? null
          : copyOwnedBytesV2(
            input.newMetadata.previousBindingHash,
          ),
    });
    const sourceContext: NamespaceCommitterContextV2 = Object.freeze({
      purpose: "namespace-keyring-envelope",
      namespaceId: opened.namespaceId,
      domainId: input.oldEnvelope.domainId,
      domainEpoch: input.oldEnvelope.domainEpoch,
      accessRevision: input.oldEnvelope.accessRevision,
      committerDeviceId: input.newMetadata.committerDeviceId,
      previousBindingHash:
        input.newMetadata.previousBindingHash === null
          ? null
          : copyOwnedBytesV2(
            input.newMetadata.previousBindingHash,
          ),
    });
    const sourcePublicKey = input.resolveSourceCommitter(sourceContext);
    if (sourcePublicKey === null) {
      throw new Error(
        "Namespace keyring transition committer is not authorized in the source context",
      );
    }
    assertBytes(
      "Source committer signing public key",
      sourcePublicKey,
      SIGNING_PUBLIC_KEY_BYTES,
    );
    const targetPublicKey = input.resolveCurrentCommitter(targetContext);
    if (targetPublicKey === null) {
      throw new Error(
        "Namespace keyring current committer is not authorized and unrevoked",
      );
    }
    assertBytes(
      "Current committer signing public key",
      targetPublicKey,
      SIGNING_PUBLIC_KEY_BYTES,
    );
    if (!equalBytes(sourcePublicKey, targetPublicKey)) {
      throw new Error(
        "Namespace keyring transition committer differs between source and target contexts",
      );
    }
    revised = prepareNamespaceKeyringRevision(
      input.crypto,
      opened,
      input.newMetadata.accessRevision,
      input.rotateGeneration,
    );
    return sealNamespaceKeyring({
      crypto: input.crypto,
      domainRoot: input.newDomainRoot,
      keyring: revised,
      metadata: input.newMetadata,
      committerSigningPrivateKey: input.newCommitterSigningPrivateKey,
      resolveCurrentCommitter: () => targetPublicKey,
    });
  } finally {
    wipeKeyring(revised);
    wipeKeyring(opened);
  }
}

export function namespaceKeyringsEqual(
  left: NamespaceKeyringPlaintextV2,
  right: NamespaceKeyringPlaintextV2,
): boolean {
  return (
    left.namespaceId === right.namespaceId
    && left.keyClass === right.keyClass
    && left.accessRevision === right.accessRevision
      && left.currentGeneration === right.currentGeneration
      && left.generations.length === right.generations.length
      && left.generations.every((entry, index) => {
        const other = right.generations[index]!;
        return (
          entry.generation === other.generation
          && equalBytes(entry.key, other.key)
        );
      })
  );
}

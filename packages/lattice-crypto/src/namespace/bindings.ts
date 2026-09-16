import { sha256 } from "@noble/hashes/sha2.js";
import type { LatticeCrypto } from "../crypto/index.ts";
import {
  assertNamespaceBinding,
  namespaceBindingSigningBytes,
  serializeNamespaceBinding,
} from "../format/namespace-binding-v2.ts";
import {
  assertNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../format/namespace-keyring-v2.ts";
import {
  type CurrentCommitterResolverV2,
  type HistoricalCommitterResolverV2,
  type NamespaceCommitterContextV2,
} from "./authorization.ts";
import {
  HASH_BYTES,
  SIGNING_PUBLIC_KEY_BYTES,
  type NamespaceBindingAnchorV2,
  type NamespaceBindingV2,
  type NamespaceKeyringEnvelopeV2,
  type VerifiedNamespaceBindingHeadV2,
} from "./types.ts";
import {
  accessRevision,
  namespaceId,
} from "../v2-types/ids.ts";
import { V2_LIMITS, assertV2Range } from "../v2-types/limits.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

interface VerifiedNamespaceBindingSnapshotV2 {
  readonly bindingHash: Uint8Array;
  readonly bindingBytes: Uint8Array;
}

const verifiedNamespaceBindingHeads = new WeakMap<
  object,
  VerifiedNamespaceBindingSnapshotV2
>();

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
  return left.every((byte, index) => byte === right[index]);
}

function bindingContext(
  binding: NamespaceBindingV2,
): NamespaceCommitterContextV2 {
  return Object.freeze({
    purpose: "namespace-binding",
    namespaceId: binding.namespaceId,
    domainId: binding.domainId,
    domainEpoch: binding.domainEpoch,
    accessRevision: binding.accessRevision,
    committerDeviceId: binding.committerDeviceId,
    previousBindingHash: binding.previousBindingHash === null
      ? null
      : copyOwnedBytesV2(binding.previousBindingHash),
  });
}

function metadataMatches(
  left: NamespaceKeyringEnvelopeV2,
  right: NamespaceKeyringEnvelopeV2,
): boolean {
  return (
    left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && left.accessRevision === right.accessRevision
    && left.committerDeviceId === right.committerDeviceId
    && (
      left.previousBindingHash === null
      || equalBytes(left.previousBindingHash, right.previousBindingHash!)
    )
  );
}

export function namespaceKeyringEnvelopeHash(
  envelope: NamespaceKeyringEnvelopeV2,
): Uint8Array {
  assertNamespaceKeyringEnvelope(envelope);
  return sha256(serializeNamespaceKeyringEnvelope(envelope));
}

export interface CreateNamespaceBindingInputV2 {
  readonly crypto: LatticeCrypto;
  readonly humanEnvelope: NamespaceKeyringEnvelopeV2;
  readonly aiEnvelope: NamespaceKeyringEnvelopeV2;
  readonly committerSigningPrivateKey: Uint8Array;
  readonly resolveCurrentCommitter: CurrentCommitterResolverV2;
}

export function createNamespaceBinding(
  input: CreateNamespaceBindingInputV2,
): NamespaceBindingV2 {
  assertNamespaceKeyringEnvelope(input.humanEnvelope);
  assertNamespaceKeyringEnvelope(input.aiEnvelope);
  if (
    input.humanEnvelope.keyClass !== "human"
    || input.aiEnvelope.keyClass !== "ai"
    || !metadataMatches(input.humanEnvelope, input.aiEnvelope)
  ) {
    throw new Error(
      "Namespace binding requires one matching Human and AI keyring envelope",
    );
  }
  assertBytes(
    "Committer signing private key",
    input.committerSigningPrivateKey,
    V2_LIMITS.signingPrivateKeyBytes,
  );
  const currentContext: NamespaceCommitterContextV2 = Object.freeze({
    purpose: "namespace-binding",
    namespaceId: input.humanEnvelope.namespaceId,
    domainId: input.humanEnvelope.domainId,
    domainEpoch: input.humanEnvelope.domainEpoch,
    accessRevision: input.humanEnvelope.accessRevision,
    committerDeviceId: input.humanEnvelope.committerDeviceId,
    previousBindingHash:
      input.humanEnvelope.previousBindingHash === null
        ? null
        : copyOwnedBytesV2(
          input.humanEnvelope.previousBindingHash,
        ),
  });
  const currentPublicKey = input.resolveCurrentCommitter(currentContext);
  if (currentPublicKey === null) {
    throw new Error(
      "Namespace binding current committer is not authorized and unrevoked",
    );
  }
  assertBytes(
    "Current committer signing public key",
    currentPublicKey,
    SIGNING_PUBLIC_KEY_BYTES,
  );
  const unsigned: NamespaceBindingV2 = {
    formatVersion: 2,
    namespaceId: input.humanEnvelope.namespaceId,
    domainId: input.humanEnvelope.domainId,
    domainEpoch: input.humanEnvelope.domainEpoch,
    accessRevision: input.humanEnvelope.accessRevision,
    humanCurrentGeneration: input.humanEnvelope.currentGeneration,
    aiCurrentGeneration: input.aiEnvelope.currentGeneration,
    previousBindingHash:
      input.humanEnvelope.previousBindingHash === null
        ? null
        : copyOwnedBytesV2(
          input.humanEnvelope.previousBindingHash,
        ),
    humanKeyringEnvelopeHash: namespaceKeyringEnvelopeHash(input.humanEnvelope),
    aiKeyringEnvelopeHash: namespaceKeyringEnvelopeHash(input.aiEnvelope),
    committerDeviceId: input.humanEnvelope.committerDeviceId,
    signature: new Uint8Array(V2_LIMITS.signatureBytes),
  };
  const signature = input.crypto.sign(
    input.committerSigningPrivateKey,
    namespaceBindingSigningBytes(unsigned),
  );
  const binding: NamespaceBindingV2 = {
    ...unsigned,
    signature: copyOwnedBytesV2(signature),
  };
  if (
    !input.crypto.verify(
      currentPublicKey,
      namespaceBindingSigningBytes(binding),
      binding.signature,
    )
  ) {
    throw new Error(
      "Namespace binding committer private key does not match the registered device",
    );
  }
  assertNamespaceBinding(binding);
  return Object.freeze(binding);
}

export interface VerifyNamespaceBindingInputV2 {
  readonly crypto: LatticeCrypto;
  readonly binding: NamespaceBindingV2;
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}

export function verifyNamespaceBinding(
  input: VerifyNamespaceBindingInputV2,
): true {
  assertNamespaceBinding(input.binding);
  const publicKey = input.resolveHistoricalCommitter(
    bindingContext(input.binding),
  );
  if (publicKey === null) {
    throw new Error(
      "Namespace binding committer is absent from the authenticated historical roster",
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
      namespaceBindingSigningBytes(input.binding),
      input.binding.signature,
    )
  ) {
    throw new Error("Namespace binding signature is invalid");
  }
  return true;
}

export function verifyBindingEnvelopePair(
  binding: NamespaceBindingV2,
  humanEnvelope: NamespaceKeyringEnvelopeV2,
  aiEnvelope: NamespaceKeyringEnvelopeV2,
): boolean {
  try {
    assertNamespaceBinding(binding);
    assertNamespaceKeyringEnvelope(humanEnvelope);
    assertNamespaceKeyringEnvelope(aiEnvelope);
    return (
      humanEnvelope.keyClass === "human"
      && aiEnvelope.keyClass === "ai"
      && metadataMatches(humanEnvelope, aiEnvelope)
      && binding.namespaceId === humanEnvelope.namespaceId
      && binding.domainId === humanEnvelope.domainId
      && binding.domainEpoch === humanEnvelope.domainEpoch
      && binding.accessRevision === humanEnvelope.accessRevision
      && binding.committerDeviceId === humanEnvelope.committerDeviceId
      && binding.humanCurrentGeneration === humanEnvelope.currentGeneration
      && binding.aiCurrentGeneration === aiEnvelope.currentGeneration
      && (
        binding.previousBindingHash === null
        || equalBytes(
          binding.previousBindingHash,
          humanEnvelope.previousBindingHash!,
        )
      )
      && equalBytes(
        binding.humanKeyringEnvelopeHash,
        namespaceKeyringEnvelopeHash(humanEnvelope),
      )
      && equalBytes(
        binding.aiKeyringEnvelopeHash,
        namespaceKeyringEnvelopeHash(aiEnvelope),
      )
    );
  } catch {
    return false;
  }
}

export function namespaceBindingHash(
  binding: NamespaceBindingV2,
): Uint8Array {
  return sha256(serializeNamespaceBinding(binding));
}

export interface VerifyNamespaceBindingProofInputV2 {
  readonly crypto: LatticeCrypto;
  readonly anchor: NamespaceBindingAnchorV2 | null;
  readonly proof: readonly NamespaceBindingV2[];
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
}

/**
 * Reject structurally forged/copy-constructed "verified" heads. The capability
 * is process-local and is issued only after the full anchored proof and every
 * historical signature have passed.
 */
export function assertVerifiedNamespaceBindingHead(
  head: VerifiedNamespaceBindingHeadV2,
): void {
  const snapshot = verifiedNamespaceBindingHeads.get(head);
  if (
    snapshot === undefined
    || !equalBytes(head.bindingHash, snapshot.bindingHash)
    || !equalBytes(
      serializeNamespaceBinding(head.binding),
      snapshot.bindingBytes,
    )
  ) {
    throw new TypeError(
      "Namespace binding head requires an anchored proof-verifier capability",
    );
  }
}

function assertAnchor(anchor: NamespaceBindingAnchorV2): void {
  namespaceId(anchor.namespaceId);
  accessRevision(anchor.accessRevision);
  assertBytes("Namespace binding anchor hash", anchor.bindingHash, HASH_BYTES);
}

export function verifyNamespaceBindingProof(
  input: VerifyNamespaceBindingProofInputV2,
): VerifiedNamespaceBindingHeadV2 {
  assertV2Range(
    "Namespace binding proof entries",
    input.proof.length,
    1,
    V2_LIMITS.proofEntriesPerSegment,
  );
  if (input.anchor !== null) assertAnchor(input.anchor);

  let previousRevision =
    input.anchor === null ? -1 : Number(input.anchor.accessRevision);
  let previousHash =
    input.anchor === null ? null : input.anchor.bindingHash;
  let targetNamespaceId =
    input.anchor === null ? null : input.anchor.namespaceId;

  for (let index = 0; index < input.proof.length; index++) {
    const binding = input.proof[index]!;
    assertNamespaceBinding(binding);
    if (
      targetNamespaceId !== null
      && binding.namespaceId !== targetNamespaceId
    ) {
      throw new Error("Namespace binding proof crosses Namespace identity");
    }
    targetNamespaceId ??= binding.namespaceId;
    const revision = Number(binding.accessRevision);
    let bindingHash: Uint8Array | null = null;

    if (index === 0 && revision === previousRevision) {
      bindingHash = namespaceBindingHash(binding);
      if (!equalBytes(bindingHash, previousHash!)) {
        throw new Error(
          "Namespace binding proof changes bytes at the trusted revision",
        );
      }
    } else {
      if (revision !== previousRevision + 1) {
        throw new Error("Namespace binding proof has a revision gap or fork");
      }
      if (
        previousHash !== null
        && !equalBytes(binding.previousBindingHash!, previousHash)
      ) {
        throw new Error("Namespace binding proof has broken hash linkage");
      }
    }
    verifyNamespaceBinding({
      crypto: input.crypto,
      binding,
      resolveHistoricalCommitter: input.resolveHistoricalCommitter,
    });
    bindingHash ??= namespaceBindingHash(binding);
    previousRevision = revision;
    previousHash = bindingHash;
  }

  const head = input.proof[input.proof.length - 1]!;
  const verified = Object.freeze({
    namespaceId: head.namespaceId,
    accessRevision: head.accessRevision,
    bindingHash: previousHash!,
    binding: head,
  });
  verifiedNamespaceBindingHeads.set(verified, {
    bindingHash: copyOwnedBytesV2(verified.bindingHash),
    bindingBytes: serializeNamespaceBinding(verified.binding),
  });
  return verified;
}

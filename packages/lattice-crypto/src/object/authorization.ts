import type { LatticeCrypto } from "../crypto/index.ts";
import {
  decodeNamespaceObjectEnvelopeV2,
  type ObjectKeyClassV2,
} from "../format/object-v2.ts";
import {
  assertVerifiedNamespaceBindingHead,
  namespaceKeyringEnvelopeHash,
} from "../namespace/bindings.ts";
import type { HistoricalCommitterResolverV2 } from "../namespace/authorization.ts";
import { openNamespaceKeyring } from "../namespace/keyrings.ts";
import type {
  NamespaceKeyringEnvelopeV2,
  VerifiedNamespaceBindingHeadV2,
} from "../namespace/types.ts";
import {
  namespaceId,
  objectId,
  type NamespaceId,
  type ObjectId,
} from "../v2-types/ids.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  assertEnvelopeAuthorizedV2,
  type VerifiedObjectAccessManifestV2,
} from "./access-manifest.ts";

export interface NamespaceObjectAuthorizationIdentityV2 {
  readonly objectId: ObjectId;
  readonly namespaceId: NamespaceId;
  readonly keyClass: ObjectKeyClassV2;
}

export interface ResolveAuthorizedNamespaceObjectKeyInputV2 {
  readonly crypto: LatticeCrypto;
  readonly verifiedManifest: VerifiedObjectAccessManifestV2;
  readonly envelopeBytes: Uint8Array;
  readonly trustedNamespaceHead: VerifiedNamespaceBindingHeadV2;
  readonly currentKeyringEnvelope: NamespaceKeyringEnvelopeV2;
  readonly currentDomainRoot: Uint8Array;
  readonly resolveHistoricalCommitter: HistoricalCommitterResolverV2;
  readonly expected: NamespaceObjectAuthorizationIdentityV2;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  // Both inputs are authenticated fixed-width keyring-envelope hashes.
  return left.reduce(
    (difference, byte, index) => difference | (byte ^ right[index]!),
    0,
  ) === 0;
}

function assertKeyClass(
  value: unknown,
): asserts value is ObjectKeyClassV2 {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("object key class must be human or ai");
  }
}

function validateExpectedIdentity(
  expected: NamespaceObjectAuthorizationIdentityV2,
): NamespaceObjectAuthorizationIdentityV2 {
  if (typeof expected !== "object" || expected === null) {
    throw new TypeError("expected object authorization identity is required");
  }
  assertKeyClass(expected.keyClass);
  return Object.freeze({
    objectId: objectId(expected.objectId),
    namespaceId: namespaceId(expected.namespaceId),
    keyClass: expected.keyClass,
  });
}

function validateTrustedHead(
  head: VerifiedNamespaceBindingHeadV2,
): void {
  if (typeof head !== "object" || head === null) {
    throw new TypeError("trusted Namespace head must be an object");
  }
  assertVerifiedNamespaceBindingHead(head);
}

function bindingKeyringEnvelopeHash(
  head: VerifiedNamespaceBindingHeadV2,
  keyClass: ObjectKeyClassV2,
): Uint8Array {
  return keyClass === "human"
    ? head.binding.humanKeyringEnvelopeHash
    : head.binding.aiKeyringEnvelopeHash;
}

export function resolveAuthorizedNamespaceObjectKeyV2(
  input: ResolveAuthorizedNamespaceObjectKeyInputV2,
): Uint8Array {
  const expected = validateExpectedIdentity(input.expected);

  // This check also requires the non-forgeable capability returned by the
  // trusted-head manifest verifier. A structurally identical copy is rejected.
  assertEnvelopeAuthorizedV2(
    input.crypto,
    input.verifiedManifest,
    input.envelopeBytes,
  );
  const envelope = decodeNamespaceObjectEnvelopeV2(input.envelopeBytes);
  if (envelope.context.objectId !== expected.objectId) {
    throw new Error("Namespace object envelope object identity mismatch");
  }
  if (envelope.context.namespaceId !== expected.namespaceId) {
    throw new Error("Namespace object envelope Namespace identity mismatch");
  }
  if (envelope.context.keyClass !== expected.keyClass) {
    throw new Error("Namespace object envelope key class mismatch");
  }

  validateTrustedHead(input.trustedNamespaceHead);
  const head = input.trustedNamespaceHead;
  if (
    envelope.context.bindingRevisionAtWrap > head.accessRevision
  ) {
    throw new Error(
      "Namespace object envelope claims a future binding revision",
    );
  }

  const currentEnvelopeHash = namespaceKeyringEnvelopeHash(
    input.currentKeyringEnvelope,
  );
  if (
    !equalBytes(
      currentEnvelopeHash,
      bindingKeyringEnvelopeHash(head, expected.keyClass),
    )
  ) {
    throw new Error(
      "authenticated current keyring envelope does not match the trusted Namespace binding",
    );
  }
  const keyring = openNamespaceKeyring({
    crypto: input.crypto,
    domainRoot: input.currentDomainRoot,
    envelope: input.currentKeyringEnvelope,
    resolveHistoricalCommitter: input.resolveHistoricalCommitter,
  });
  try {
    const historical = keyring.generations.find(
      (entry) => entry.generation === envelope.context.keyGeneration,
    );
    if (historical === undefined) {
      throw new Error(
        "Namespace object envelope historical generation is absent from the current complete keyring",
      );
    }
    return copyOwnedBytesV2(historical.key);
  } finally {
    for (const generation of keyring.generations) {
      generation.key.fill(0);
    }
  }
}

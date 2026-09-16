import type {
  NamespaceBindingRecordV2,
  NamespaceHeadExpectationV2,
  NamespaceHeadV2,
} from "../storage/v2-records.ts";
import {
  cloneOpaqueBytes,
  copyOwnedBytesV2,
} from "../v2-types/opaque.ts";
import type {
  NamespaceBindingCasAuthorizationV2,
  NamespaceCommitterContextV2,
} from "./authorization.ts";

declare const authorizedNamespaceBindingWriteBrand: unique symbol;

/**
 * Process-local proof that one binding/head write passed fresh committer
 * authorization and cryptographic verification in the Namespace coordinator.
 * Public fields keep the durable CAS adapter-implementable; callers cannot
 * construct the nominal capability or its private WeakMap provenance.
 */
export type AuthorizedNamespaceBindingWriteV2 = Readonly<{
  readonly expected: NamespaceHeadExpectationV2 | null;
  readonly binding: NamespaceBindingRecordV2;
  readonly next: NamespaceHeadV2;
  readonly authorization: NamespaceBindingCasAuthorizationV2;
  readonly [authorizedNamespaceBindingWriteBrand]: true;
}>;

export interface AuthorizedNamespaceBindingWriteSnapshotV2 {
  readonly expected: NamespaceHeadExpectationV2 | null;
  readonly binding: NamespaceBindingRecordV2;
  readonly next: NamespaceHeadV2;
  readonly authorization: NamespaceBindingCasAuthorizationV2;
}

const authorizedNamespaceBindingWrites = new WeakMap<
  object,
  AuthorizedNamespaceBindingWriteSnapshotV2
>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function equalNullableBytes(
  left: Uint8Array | null,
  right: Uint8Array | null,
): boolean {
  if (left === null || right === null) return left === right;
  return equalBytes(left, right);
}

function cloneExpected(
  expected: NamespaceHeadExpectationV2 | null,
): NamespaceHeadExpectationV2 | null {
  return expected === null
    ? null
    : Object.freeze({
      namespaceId: expected.namespaceId,
      accessRevision: expected.accessRevision,
      bindingHash: copyOwnedBytesV2(expected.bindingHash),
    });
}

function cloneHead(head: NamespaceHeadV2): NamespaceHeadV2 {
  return Object.freeze({
    namespaceId: head.namespaceId,
    accessRevision: head.accessRevision,
    bindingHash: copyOwnedBytesV2(head.bindingHash),
    domainId: head.domainId,
    domainEpoch: head.domainEpoch,
  });
}

function cloneBinding(
  binding: NamespaceBindingRecordV2,
): NamespaceBindingRecordV2 {
  return Object.freeze({
    namespaceId: binding.namespaceId,
    revision: binding.revision,
    bindingHash: copyOwnedBytesV2(binding.bindingHash),
    previousBindingHash: binding.previousBindingHash === null
      ? null
      : copyOwnedBytesV2(binding.previousBindingHash),
    signedBindingBytes: copyOwnedBytesV2(binding.signedBindingBytes),
    humanKeyringEnvelope:
      cloneOpaqueBytes(binding.humanKeyringEnvelope),
    aiKeyringEnvelope:
      cloneOpaqueBytes(binding.aiKeyringEnvelope),
  });
}

function cloneCommitter(
  value: NamespaceCommitterContextV2,
): NamespaceCommitterContextV2 {
  return Object.freeze({
    purpose: value.purpose,
    namespaceId: value.namespaceId,
    domainId: value.domainId,
    domainEpoch: value.domainEpoch,
    accessRevision: value.accessRevision,
    committerDeviceId: value.committerDeviceId,
    previousBindingHash: value.previousBindingHash === null
      ? null
      : copyOwnedBytesV2(value.previousBindingHash),
  });
}

function cloneAuthorization(
  value: NamespaceBindingCasAuthorizationV2,
): NamespaceBindingCasAuthorizationV2 {
  return Object.freeze({
    bindingCommitter: cloneCommitter(value.bindingCommitter),
    keyringCommitter: cloneCommitter(value.keyringCommitter),
    committerSigningPublicKeyHash:
      copyOwnedBytesV2(value.committerSigningPublicKeyHash),
  });
}

function sameCommitterCoordinates(
  left: NamespaceCommitterContextV2,
  right: NamespaceCommitterContextV2,
): boolean {
  return left.namespaceId === right.namespaceId
    && left.domainId === right.domainId
    && left.domainEpoch === right.domainEpoch
    && left.accessRevision === right.accessRevision
    && left.committerDeviceId === right.committerDeviceId
    && equalNullableBytes(
      left.previousBindingHash,
      right.previousBindingHash,
    );
}

function cloneWrite(
  input: Readonly<{
    readonly expected: NamespaceHeadExpectationV2 | null;
    readonly binding: NamespaceBindingRecordV2;
    readonly next: NamespaceHeadV2;
    readonly authorization: NamespaceBindingCasAuthorizationV2;
  }>,
): AuthorizedNamespaceBindingWriteSnapshotV2 {
  return Object.freeze({
    expected: cloneExpected(input.expected),
    binding: cloneBinding(input.binding),
    next: cloneHead(input.next),
    authorization: cloneAuthorization(input.authorization),
  });
}

/**
 * Every capability object and nested record is frozen at mint time, so scalar
 * coordinates and object references cannot change. Uint8Array contents remain
 * mutable in JavaScript and are therefore the complete post-mint mutation
 * surface that must be compared with the detached private snapshot.
 */
function mutableBytesAreUnchanged(
  value: AuthorizedNamespaceBindingWriteV2,
  snapshot: AuthorizedNamespaceBindingWriteSnapshotV2,
): boolean {
  return (value.expected === null
    || equalBytes(
      value.expected.bindingHash,
      snapshot.expected!.bindingHash,
    ))
    && equalBytes(value.binding.bindingHash, snapshot.binding.bindingHash)
    && (value.binding.previousBindingHash === null
      || equalBytes(
        value.binding.previousBindingHash,
        snapshot.binding.previousBindingHash!,
      ))
    && equalBytes(
      value.binding.signedBindingBytes,
      snapshot.binding.signedBindingBytes,
    )
    && equalBytes(
      value.binding.humanKeyringEnvelope.ciphertext,
      snapshot.binding.humanKeyringEnvelope.ciphertext,
    )
    && equalBytes(
      value.binding.aiKeyringEnvelope.ciphertext,
      snapshot.binding.aiKeyringEnvelope.ciphertext,
    )
    && equalBytes(value.next.bindingHash, snapshot.next.bindingHash)
    && equalNullableBytes(
      value.authorization.bindingCommitter.previousBindingHash,
      snapshot.authorization.bindingCommitter.previousBindingHash,
    )
    && equalNullableBytes(
      value.authorization.keyringCommitter.previousBindingHash,
      snapshot.authorization.keyringCommitter.previousBindingHash,
    )
    && equalBytes(
      value.authorization.committerSigningPublicKeyHash,
      snapshot.authorization.committerSigningPublicKeyHash,
    );
}

/** Internal minting boundary; the sole production caller is the coordinator. */
export function authorizeNamespaceBindingWriteV2(
  input: Readonly<{
    readonly expected: NamespaceHeadExpectationV2 | null;
    readonly binding: NamespaceBindingRecordV2;
    readonly next: NamespaceHeadV2;
    readonly authorization: NamespaceBindingCasAuthorizationV2;
  }>,
): AuthorizedNamespaceBindingWriteV2 {
  const { bindingCommitter, keyringCommitter } = input.authorization;
  if (
    bindingCommitter.purpose !== "namespace-binding"
    || keyringCommitter.purpose !== "namespace-keyring-envelope"
    || !sameCommitterCoordinates(bindingCommitter, keyringCommitter)
    || bindingCommitter.namespaceId !== input.next.namespaceId
    || bindingCommitter.domainId !== input.next.domainId
    || bindingCommitter.domainEpoch !== input.next.domainEpoch
    || bindingCommitter.accessRevision !== input.next.accessRevision
    || input.authorization.committerSigningPublicKeyHash.length !== 32
    || !equalNullableBytes(
      bindingCommitter.previousBindingHash,
      input.expected?.bindingHash ?? null,
    )
  ) {
    throw new TypeError(
      "Namespace write authorization does not match the exact CAS transition",
    );
  }
  const snapshot = cloneWrite(input);
  const authorized = Object.freeze({
    expected: cloneExpected(snapshot.expected),
    binding: cloneBinding(snapshot.binding),
    next: cloneHead(snapshot.next),
    authorization: cloneAuthorization(snapshot.authorization),
  }) as AuthorizedNamespaceBindingWriteV2;
  authorizedNamespaceBindingWrites.set(authorized, snapshot);
  return authorized;
}

/**
 * Consume and detach one capability before the reference store decides. A
 * retry must pass through fresh coordinator authorization and mint a new one.
 */
export function consumeAuthorizedNamespaceBindingWriteV2(
  value: AuthorizedNamespaceBindingWriteV2,
): AuthorizedNamespaceBindingWriteSnapshotV2 {
  const snapshot = authorizedNamespaceBindingWrites.get(value as object);
  authorizedNamespaceBindingWrites.delete(value as object);
  if (
    snapshot === undefined
    || !mutableBytesAreUnchanged(value, snapshot)
  ) {
    throw new TypeError(
      "Namespace binding CAS requires an authorized write capability",
    );
  }
  return cloneWrite(snapshot);
}

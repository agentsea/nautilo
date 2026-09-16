import type {
  ProviderPublicHeadV2,
} from "./provider-candidate.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";
import {
  cloneProviderHeadV2,
  providerHeadsEqualV2,
} from "./provider-candidate.ts";
import type {
  ProviderTransitionAuthorizationContextV2,
} from "./provider-coordinator.ts";

declare const authorizedProviderHeadWriteBrand: unique symbol;

/**
 * Process-local proof that one provider-head write passed the coordinator's
 * candidate authentication and fresh host-authorization boundary.
 *
 * The fields remain public so a durable storage adapter can implement the
 * single CAS without knowing crypto internals. The nominal brand and private
 * WeakMap provenance prevent supported callers from constructing the proof.
 */
export type AuthorizedProviderHeadWriteV2 = Readonly<{
  readonly expected: ProviderPublicHeadV2;
  readonly next: ProviderPublicHeadV2;
  readonly nextRosterBytes: Uint8Array;
  readonly authorization: ProviderTransitionAuthorizationContextV2;
  readonly [authorizedProviderHeadWriteBrand]: true;
}>;

interface AuthorizedProviderHeadWriteSnapshotV2 {
  readonly expected: ProviderPublicHeadV2;
  readonly next: ProviderPublicHeadV2;
  readonly nextRosterBytes: Uint8Array;
  readonly authorization: ProviderTransitionAuthorizationContextV2;
}

const authorizedProviderHeadWrites = new WeakMap<
  object,
  AuthorizedProviderHeadWriteSnapshotV2
>();

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.every((byte, index) => byte === right[index]);
}

function cloneAuthorization(
  value: ProviderTransitionAuthorizationContextV2,
): ProviderTransitionAuthorizationContextV2 {
  return Object.freeze({
    providerId: value.providerId,
    domainId: value.domainId,
    authorizationRevision: value.authorizationRevision,
    actorDeviceId: value.actorDeviceId,
    operation: value.operation,
    targetHumanId: value.targetHumanId,
    targetDeviceId: value.targetDeviceId,
    currentHead: cloneProviderHeadV2(value.currentHead),
    nextHead: cloneProviderHeadV2(value.nextHead),
    candidateId: value.candidateId,
    publicTransitionDigest:
      copyOwnedBytesV2(value.publicTransitionDigest),
  });
}

function authorizationsEqual(
  left: ProviderTransitionAuthorizationContextV2,
  right: ProviderTransitionAuthorizationContextV2,
): boolean {
  // Both records are frozen clones made by this module from the same mint
  // input. Their scalar properties and nested head records cannot be changed
  // after minting; only the Uint8Array leaves remain mutable. Re-authenticate
  // exactly those caller-mutable leaves against the private snapshot.
  return equalBytes(left.currentHead.stateHash, right.currentHead.stateHash)
    && equalBytes(left.nextHead.stateHash, right.nextHead.stateHash)
    && equalBytes(
      left.publicTransitionDigest,
      right.publicTransitionDigest,
    );
}

function cloneWrite(
  input: Readonly<{
    readonly expected: ProviderPublicHeadV2;
    readonly next: ProviderPublicHeadV2;
    readonly nextRosterBytes: Uint8Array;
    readonly authorization: ProviderTransitionAuthorizationContextV2;
  }>,
): AuthorizedProviderHeadWriteSnapshotV2 {
  return Object.freeze({
    expected: cloneProviderHeadV2(input.expected),
    next: cloneProviderHeadV2(input.next),
    nextRosterBytes: copyOwnedBytesV2(input.nextRosterBytes),
    authorization: cloneAuthorization(input.authorization),
  });
}

/**
 * Internal minting boundary. This module is intentionally not exported from
 * the supported package root; the sole production caller is the provider
 * transition coordinator after its fresh resolver succeeds.
 */
export function authorizeProviderHeadWriteV2(
  input: Readonly<{
    readonly expected: ProviderPublicHeadV2;
    readonly next: ProviderPublicHeadV2;
    readonly nextRosterBytes: Uint8Array;
    readonly authorization: ProviderTransitionAuthorizationContextV2;
  }>,
): AuthorizedProviderHeadWriteV2 {
  if (
    !providerHeadsEqualV2(input.expected, input.authorization.currentHead)
    || !providerHeadsEqualV2(input.next, input.authorization.nextHead)
    || input.expected.providerId !== input.authorization.providerId
    || input.expected.domainId !== input.authorization.domainId
  ) {
    throw new TypeError(
      "Provider-head write authorization does not match the exact CAS pair",
    );
  }
  const snapshot = cloneWrite(input);
  const authorized = Object.freeze({
    expected: cloneProviderHeadV2(snapshot.expected),
    next: cloneProviderHeadV2(snapshot.next),
    nextRosterBytes: copyOwnedBytesV2(snapshot.nextRosterBytes),
    authorization: cloneAuthorization(snapshot.authorization),
  }) as AuthorizedProviderHeadWriteV2;
  authorizedProviderHeadWrites.set(authorized, snapshot);
  return authorized;
}

/**
 * Authenticate, consume, and detach one write capability.
 *
 * Consumption happens before any storage decision. An adapter exception has
 * ambiguous outcome, so an explicit coordinator retry must obtain a new fresh
 * authorization and a new capability rather than replaying an old one.
 */
export function consumeAuthorizedProviderHeadWriteV2(
  value: AuthorizedProviderHeadWriteV2,
): AuthorizedProviderHeadWriteSnapshotV2 {
  const snapshot = authorizedProviderHeadWrites.get(value);
  authorizedProviderHeadWrites.delete(value);
  if (
    snapshot === undefined
    || !providerHeadsEqualV2(value.expected, snapshot.expected)
    || !providerHeadsEqualV2(value.next, snapshot.next)
    || !equalBytes(value.nextRosterBytes, snapshot.nextRosterBytes)
    || !authorizationsEqual(value.authorization, snapshot.authorization)
  ) {
    throw new TypeError(
      "Domain provider CAS requires an authorized provider-head write capability",
    );
  }
  return cloneWrite(snapshot);
}

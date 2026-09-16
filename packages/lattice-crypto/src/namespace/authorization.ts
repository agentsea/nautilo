import type {
  AccessRevision,
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
  NamespaceId,
} from "../v2-types/ids.ts";

export type NamespaceCommitterPurpose =
  | "namespace-keyring-envelope"
  | "namespace-binding";

/**
 * This context is cryptographic event context, never current product state.
 * Historical verification must resolve the signing key from an authenticated
 * roster/transition record at exactly `domainEpoch`.
 */
export interface NamespaceCommitterContextV2 {
  readonly purpose: NamespaceCommitterPurpose;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly accessRevision: AccessRevision;
  readonly committerDeviceId: CryptoDeviceId;
  readonly previousBindingHash: Uint8Array | null;
}

/**
 * Exact current-authority evidence bound to one Namespace binding/head CAS.
 * Durable adapters can recheck these coordinates atomically with the write.
 */
export interface NamespaceBindingCasAuthorizationV2 {
  readonly bindingCommitter: NamespaceCommitterContextV2;
  readonly keyringCommitter: NamespaceCommitterContextV2;
  readonly committerSigningPublicKeyHash: Uint8Array;
}

/**
 * A non-null key attests that the device is currently registered, authorized,
 * and unrevoked. For a non-initial binding, the resolver must also use
 * `previousBindingHash` to attest the same committer in every source and
 * target transition context required by the authenticated transition plan.
 */
export type CurrentCommitterResolverV2 = (
  context: NamespaceCommitterContextV2,
) => Uint8Array | null;

/**
 * A non-null key attests authorization from the authenticated historical
 * roster/transition record, including both sides of a membership transition
 * when applicable. Current product authorization or later revocation is not
 * an input to this resolver.
 */
export type HistoricalCommitterResolverV2 = (
  context: NamespaceCommitterContextV2,
) => Uint8Array | null;

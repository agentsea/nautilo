import type {
  AccessRevision,
  CryptoDeviceId,
  CryptoDomainId,
  DomainEpoch,
  NamespaceId,
  NamespaceKeyGeneration,
} from "../v2-types/ids.ts";
import { V2_LIMITS } from "../v2-types/limits.ts";

export const NAMESPACE_KEY_BYTES = 32;
export const HASH_BYTES = 32;
export const SIGNING_PUBLIC_KEY_BYTES = V2_LIMITS.signingPublicKeyBytes;

export type NamespaceKeyClass = "human" | "ai";

export interface NamespaceKeyEntryV2 {
  readonly generation: NamespaceKeyGeneration;
  readonly key: Uint8Array;
}

export interface NamespaceKeyringPlaintextV2 {
  readonly formatVersion: 2;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly accessRevision: AccessRevision;
  readonly currentGeneration: NamespaceKeyGeneration;
  readonly generations: readonly NamespaceKeyEntryV2[];
}

export interface NamespaceKeyringEnvelopeV2 {
  readonly formatVersion: 2;
  readonly namespaceId: NamespaceId;
  readonly keyClass: NamespaceKeyClass;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly accessRevision: AccessRevision;
  readonly currentGeneration: NamespaceKeyGeneration;
  readonly previousBindingHash: Uint8Array | null;
  readonly ciphertext: Uint8Array;
  readonly committerDeviceId: CryptoDeviceId;
  readonly signature: Uint8Array;
}

export interface NamespaceKeyringSealMetadataV2 {
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly previousBindingHash: Uint8Array | null;
  readonly committerDeviceId: CryptoDeviceId;
}

export interface NamespaceKeyringResealMetadataV2
  extends NamespaceKeyringSealMetadataV2 {
  readonly accessRevision: AccessRevision;
}

export interface NamespaceBindingV2 {
  readonly formatVersion: 2;
  readonly namespaceId: NamespaceId;
  readonly domainId: CryptoDomainId;
  readonly domainEpoch: DomainEpoch;
  readonly accessRevision: AccessRevision;
  readonly humanCurrentGeneration: NamespaceKeyGeneration;
  readonly aiCurrentGeneration: NamespaceKeyGeneration;
  readonly previousBindingHash: Uint8Array | null;
  readonly humanKeyringEnvelopeHash: Uint8Array;
  readonly aiKeyringEnvelopeHash: Uint8Array;
  readonly committerDeviceId: CryptoDeviceId;
  readonly signature: Uint8Array;
}

export interface NamespaceBindingAnchorV2 {
  readonly namespaceId: NamespaceId;
  readonly accessRevision: AccessRevision;
  readonly bindingHash: Uint8Array;
}

export interface VerifiedNamespaceBindingHeadV2
  extends NamespaceBindingAnchorV2 {
  readonly binding: NamespaceBindingV2;
}

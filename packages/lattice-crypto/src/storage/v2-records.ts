/** Server-visible v2 record shapes: public metadata and opaque ciphertext only. */

import type {
  AgentRuntimeConfigInventoryCommitmentV2,
  AgentRuntimeRotationStateV2,
} from "../agent-runtime/runtime-rotation-v2.ts";
import type { ProviderPublicHeadV2 } from "../transition/provider-candidate.ts";
import type {
  OpaqueAgentRuntimeConfigDekV2,
  OpaqueBytes,
} from "../v2-types/opaque.ts";

export interface CryptoDomainPublicRecordV2 {
  readonly id: string;
  readonly participantDigest: Uint8Array;
  readonly participants: readonly string[];
  readonly epoch: number;
  readonly authorizationRevision: number;
  readonly rosterBytes: Uint8Array;
}

export interface NamespaceBindingRecordV2 {
  readonly namespaceId: string;
  readonly revision: number;
  readonly bindingHash: Uint8Array;
  readonly previousBindingHash: Uint8Array | null;
  readonly signedBindingBytes: Uint8Array;
  readonly humanKeyringEnvelope: OpaqueBytes<"human-keyring-envelope">;
  readonly aiKeyringEnvelope: OpaqueBytes<"ai-keyring-envelope">;
}

export interface NamespaceBindingWireRecordV2 {
  readonly namespaceId: string;
  readonly revision: number;
  readonly bindingHash: Uint8Array;
  readonly previousBindingHash: Uint8Array | null;
  readonly signedBindingBytes: Uint8Array;
  readonly humanKeyringEnvelopeBytes: Uint8Array;
  readonly aiKeyringEnvelopeBytes: Uint8Array;
}

export interface NamespaceHeadV2 {
  readonly namespaceId: string;
  readonly accessRevision: number;
  readonly bindingHash: Uint8Array;
  readonly domainId: string;
  readonly domainEpoch: number;
}

export interface NamespaceHeadExpectationV2 {
  readonly namespaceId: string;
  readonly accessRevision: number;
  readonly bindingHash: Uint8Array;
}

export interface OpaqueEncryptedObjectRecordV2 {
  readonly objectId: string;
  readonly payloadBytes: OpaqueBytes<"encrypted-payload">;
}

export interface EncryptedObjectWireRecordV2 {
  readonly objectId: string;
  readonly payloadBytes: Uint8Array;
}

/**
 * Signed public head metadata. `manifestBytes` is authenticated public data,
 * while every wrapped DEK remains behind the opaque ciphertext boundary.
 */
export interface ObjectAccessManifestStorageHeadV2 {
  readonly objectId: string;
  readonly accessRevision: number;
  readonly manifestHash: Uint8Array;
  readonly manifestBytes: Uint8Array;
}

export interface OpaqueNamespaceObjectEnvelopeRecordV2 {
  readonly namespaceId: string;
  readonly envelopeHash: Uint8Array;
  readonly envelopeBytes: OpaqueBytes<"namespace-object-envelope">;
}

export interface ObjectAccessStorageStateV2 {
  readonly head: ObjectAccessManifestStorageHeadV2;
  readonly namespaceEnvelopes:
    readonly OpaqueNamespaceObjectEnvelopeRecordV2[];
}

export interface NamespaceObjectEnvelopeWireRecordV2 {
  readonly namespaceId: string;
  readonly envelopeHash: Uint8Array;
  readonly envelopeBytes: Uint8Array;
}

export interface ObjectAccessStorageWireStateV2 {
  readonly head: ObjectAccessManifestStorageHeadV2;
  readonly namespaceEnvelopes:
    readonly NamespaceObjectEnvelopeWireRecordV2[];
}

export type ObjectAccessStateCasStatusV2 =
  | "applied"
  | "duplicate"
  | "stale";

export interface OpaqueAgentRuntimeConfigRecordV2 {
  readonly agentId: string;
  readonly objectId: string;
  readonly configRevision: number;
  readonly runtimeGeneration: number;
  readonly wrappedDekHash: Uint8Array;
  readonly wrappedDek: OpaqueAgentRuntimeConfigDekV2;
}

export interface OpaqueAgentRuntimeDomainEnvelopeRecordV2 {
  readonly agentId: string;
  readonly domainId: string;
  readonly domainEpoch: number;
  readonly agentAuthorizationRevision: number;
  readonly runtimeGeneration: number;
  readonly committerDeviceId: string;
  readonly envelopeHash: Uint8Array;
  readonly envelopeBytes: OpaqueBytes<"agent-runtime-domain-envelope">;
}

export interface AgentRuntimeChallengeConsumptionRecordV2 {
  readonly challengeHash: Uint8Array;
  readonly consumed: boolean;
}

/**
 * The complete server-visible state changed by one global Runtime rotation.
 * It contains public coordinates, opaque ciphertext, hashes, and one-time
 * consumption bits only.
 */
export interface AgentRuntimeAtomicStorageStateV2 {
  readonly runtime: AgentRuntimeRotationStateV2;
  readonly configInventory: AgentRuntimeConfigInventoryCommitmentV2;
  readonly configObjects: readonly OpaqueAgentRuntimeConfigRecordV2[];
  readonly domainEnvelopes:
    readonly OpaqueAgentRuntimeDomainEnvelopeRecordV2[];
  readonly challengeConsumptions:
    readonly AgentRuntimeChallengeConsumptionRecordV2[];
}

export interface AgentRuntimeRotationStorageExpectationV2 {
  readonly runtime: AgentRuntimeRotationStateV2;
  readonly configInventory: AgentRuntimeConfigInventoryCommitmentV2;
  readonly configObjects: readonly Readonly<{
    readonly agentId: string;
    readonly objectId: string;
    readonly configRevision: number;
    readonly runtimeGeneration: number;
    readonly wrappedDekHash: Uint8Array;
  }>[];
  readonly challengeConsumptions:
    readonly AgentRuntimeChallengeConsumptionRecordV2[];
}

export type AgentRuntimeRotationCasStatusV2 =
  | "applied"
  | "duplicate"
  | "stale";

export type AgentRuntimeAuthorizationTransitionCasStatusV2 =
  AgentRuntimeRotationCasStatusV2;

export interface AgentRuntimeChallengeReservationExpectationV2 {
  readonly runtime: AgentRuntimeRotationStateV2;
  readonly challengeConsumptions:
    readonly AgentRuntimeChallengeConsumptionRecordV2[];
}

export type AgentRuntimeChallengeReservationCasStatusV2 =
  | "applied"
  | "duplicate"
  | "stale";

export interface OpaqueGrantRecordV2 {
  readonly grantId: string;
  readonly grantBytes: OpaqueBytes<"grant">;
  readonly consumed: boolean;
}

export interface GrantWireRecordV2 {
  readonly grantId: string;
  readonly grantBytes: Uint8Array;
  readonly consumed: boolean;
}

export interface OpaqueRecoveryPackageRecordV2 {
  readonly humanId: string;
  readonly recoveryKeyGeneration: number;
  readonly archiveBytes: OpaqueBytes<"recovery-archive">;
}

export interface RecoveryArchiveWireRecordV2 {
  readonly humanId: string;
  readonly recoveryKeyGeneration: number;
  readonly archiveBytes: Uint8Array;
}

/**
 * Durable wire form of a complete Runtime row. Byte fields deliberately have
 * domain-specific names; callers cannot use this surface to mint a generic
 * opaque capability or a standalone Runtime config-DEK capability.
 */
export interface AgentRuntimeAtomicStorageWireV2 {
  readonly runtime: AgentRuntimeRotationStateV2;
  readonly configInventory: AgentRuntimeConfigInventoryCommitmentV2;
  readonly configObjects: readonly Readonly<{
    readonly agentId: string;
    readonly objectId: string;
    readonly configRevision: number;
    readonly runtimeGeneration: number;
    readonly wrappedDekHash: Uint8Array;
    readonly wrappedDekBytes: Uint8Array;
  }>[];
  readonly domainEnvelopes: readonly Readonly<{
    readonly agentId: string;
    readonly domainId: string;
    readonly domainEpoch: number;
    readonly agentAuthorizationRevision: number;
    readonly runtimeGeneration: number;
    readonly committerDeviceId: string;
    readonly envelopeHash: Uint8Array;
    readonly envelopeBytes: Uint8Array;
  }>[];
  readonly challengeConsumptions:
    readonly AgentRuntimeChallengeConsumptionRecordV2[];
}

export interface RecoveryArchiveStorageExpectationV2 {
  readonly humanId: string;
  readonly recoveryKeyGeneration: number;
  readonly archiveHash: Uint8Array;
}

export type RecoveryArchiveCasStatusV2 =
  | "applied"
  | "duplicate"
  | "stale";

export type CreateDomainResultV2 = {
  readonly status: "created" | "existing";
  readonly domain: CryptoDomainPublicRecordV2;
};

export interface DomainProviderPublicStateV2 {
  readonly head: ProviderPublicHeadV2;
  readonly rosterBytes: Uint8Array;
}

export type DomainProviderHeadCasStatusV2 =
  | "applied"
  | "duplicate"
  | "stale";

export type NamespaceBindingHeadCasStatusV2 =
  | "applied"
  | "duplicate"
  | "stale";

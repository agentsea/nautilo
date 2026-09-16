/**
 * Stable compatibility surface for Wave 2 storage.
 *
 * Internal code should depend on the narrow records, contract, policy, or
 * reference-store module. Existing consumers may continue importing here.
 */

export { InMemoryV2Store } from "./in-memory-v2-store.ts";
export {
  encryptedObjectWriteRecordV2,
  grantWriteRecordV2,
  namespaceBindingWriteRecordV2,
  recoveryArchiveWriteRecordV2,
} from "./v2-record-policy.ts";
export type { V2Storage } from "./v2-storage-contract.ts";
export type {
  CryptoDomainPublicRecordV2,
  NamespaceBindingRecordV2,
  NamespaceBindingWireRecordV2,
  NamespaceHeadV2,
  NamespaceHeadExpectationV2,
  OpaqueEncryptedObjectRecordV2,
  EncryptedObjectWireRecordV2,
  ObjectAccessManifestStorageHeadV2,
  OpaqueNamespaceObjectEnvelopeRecordV2,
  ObjectAccessStorageStateV2,
  NamespaceObjectEnvelopeWireRecordV2,
  ObjectAccessStorageWireStateV2,
  ObjectAccessStateCasStatusV2,
  OpaqueAgentRuntimeConfigRecordV2,
  OpaqueAgentRuntimeDomainEnvelopeRecordV2,
  AgentRuntimeChallengeConsumptionRecordV2,
  AgentRuntimeAtomicStorageStateV2,
  AgentRuntimeRotationStorageExpectationV2,
  AgentRuntimeRotationCasStatusV2,
  AgentRuntimeAuthorizationTransitionCasStatusV2,
  AgentRuntimeChallengeReservationExpectationV2,
  AgentRuntimeChallengeReservationCasStatusV2,
  OpaqueGrantRecordV2,
  GrantWireRecordV2,
  OpaqueRecoveryPackageRecordV2,
  RecoveryArchiveWireRecordV2,
  AgentRuntimeAtomicStorageWireV2,
  RecoveryArchiveStorageExpectationV2,
  RecoveryArchiveCasStatusV2,
  CreateDomainResultV2,
  DomainProviderPublicStateV2,
  DomainProviderHeadCasStatusV2,
  NamespaceBindingHeadCasStatusV2,
} from "./v2-records.ts";

/** Durable adapter contract for Wave 2 compare-and-swap operations. */

import type { AuthorizedAgentRuntimeInitializationWriteV2 } from "../agent-runtime/initialization-authorized-write.ts";
import type { AgentRuntimeSignerPublicationV1 } from "../agent-runtime/signer-publication-v1.ts";
import type {
  AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  AuthorizedAgentRuntimeChallengeReservationWriteV2,
  AuthorizedAgentRuntimeRotationWriteV2,
} from "../agent-runtime/storage-authorized-write.ts";
import type { AuthorizedNamespaceBindingWriteV2 } from "../namespace/authorized-write.ts";
import type { AuthorizedObjectAccessWriteV2 } from "../object/authorized-write.ts";
import type { AuthorizedProviderHeadWriteV2 } from "../transition/provider-authorized-write.ts";
import type { ProviderPublicHeadV2 } from "../transition/provider-candidate.ts";
import type {
  CryptoDomainPublicRecordV2,
  NamespaceBindingWireRecordV2,
  NamespaceHeadV2,
  OpaqueEncryptedObjectRecordV2,
  EncryptedObjectWireRecordV2,
  ObjectAccessStorageWireStateV2,
  ObjectAccessStateCasStatusV2,
  AgentRuntimeRotationCasStatusV2,
  AgentRuntimeAuthorizationTransitionCasStatusV2,
  AgentRuntimeChallengeReservationCasStatusV2,
  OpaqueGrantRecordV2,
  GrantWireRecordV2,
  OpaqueRecoveryPackageRecordV2,
  RecoveryArchiveWireRecordV2,
  AgentRuntimeAtomicStorageWireV2,
  RecoveryArchiveStorageExpectationV2,
  RecoveryArchiveCasStatusV2,
  CreateDomainResultV2,
  DomainProviderHeadCasStatusV2,
  NamespaceBindingHeadCasStatusV2,
} from "./v2-records.ts";

export interface V2Storage {
  findDomain(
    participantDigest: Uint8Array,
    exactParticipants: readonly string[],
  ): Promise<CryptoDomainPublicRecordV2 | null>;
  createDomainIfAbsent(
    domain: CryptoDomainPublicRecordV2,
  ): Promise<CreateDomainResultV2>;
  putDomainProviderHeadIfAbsent(
    head: ProviderPublicHeadV2,
    rosterBytes: Uint8Array,
  ): Promise<"inserted" | "existing">;
  getDomainProviderHead(
    domainId: string,
  ): Promise<ProviderPublicHeadV2 | null>;
  compareAndSwapDomainProviderHead(
    authorized: AuthorizedProviderHeadWriteV2,
  ): Promise<DomainProviderHeadCasStatusV2>;

  getBinding(
    namespaceId: string,
    revision: number,
  ): Promise<NamespaceBindingWireRecordV2 | null>;
  getNamespaceHead(namespaceId: string): Promise<NamespaceHeadV2 | null>;
  compareAndSwapNamespaceBindingAndHead(
    authorized: AuthorizedNamespaceBindingWriteV2,
  ): Promise<NamespaceBindingHeadCasStatusV2>;

  putObject(object: OpaqueEncryptedObjectRecordV2): Promise<void>;
  getObject(objectId: string): Promise<EncryptedObjectWireRecordV2 | null>;
  getObjectAccessState(
    objectId: string,
  ): Promise<ObjectAccessStorageWireStateV2 | null>;
  compareAndSwapObjectAccessState(
    authorized: AuthorizedObjectAccessWriteV2,
  ): Promise<ObjectAccessStateCasStatusV2>;

  putAgentRuntimeAtomicStateIfAbsent(
    authorized: AuthorizedAgentRuntimeInitializationWriteV2,
  ): Promise<"inserted" | "existing" | "stale">;
  getAgentRuntimeAtomicState(
    agentId: string,
  ): Promise<AgentRuntimeAtomicStorageWireV2 | null>;
  getAgentRuntimeSignerPublication(
    agentId: string,
    runtimeGeneration: number,
  ): Promise<AgentRuntimeSignerPublicationV1 | null>;
  compareAndSwapAgentRuntimeChallengeReservations(
    authorized: AuthorizedAgentRuntimeChallengeReservationWriteV2,
  ): Promise<AgentRuntimeChallengeReservationCasStatusV2>;
  compareAndSwapAgentRuntimeRotation(
    authorized: AuthorizedAgentRuntimeRotationWriteV2,
  ): Promise<AgentRuntimeRotationCasStatusV2>;
  compareAndSwapAgentRuntimeAuthorizationTransition(
    authorized: AuthorizedAgentRuntimeAuthorizationTransitionWriteV2,
  ): Promise<AgentRuntimeAuthorizationTransitionCasStatusV2>;

  putGrant(grant: OpaqueGrantRecordV2): Promise<void>;
  getGrant(grantId: string): Promise<GrantWireRecordV2 | null>;
  consumeGrant(grantId: string): Promise<GrantWireRecordV2 | null>;

  compareAndSwapRecoveryArchive(
    expected: RecoveryArchiveStorageExpectationV2 | null,
    intended: OpaqueRecoveryPackageRecordV2,
  ): Promise<RecoveryArchiveCasStatusV2>;
  getRecoveryArchive(
    humanId: string,
  ): Promise<RecoveryArchiveWireRecordV2 | null>;
}

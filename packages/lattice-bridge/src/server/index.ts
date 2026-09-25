export {
  HumanMemoryCryptoServiceUnavailableError,
  isHumanMemoryCryptoServiceUnavailable,
} from "./memory/human-memory-crypto-availability.ts";
export {
  createStenographerDataOperationPort,
  StenographerAuthorizationWaitingError,
  withVerifiedStenographerOrdinarySiblings,
  createStenographerCandidateDataOperationPort,
  type StenographerAttemptBoundary,
  type StenographerCompactionIntent,
  type StenographerCompactionAdapterInput,
  type StenographerDataOperationPort,
  type StenographerExtractionIntent,
  type StenographerExtractionAdapterInput,
  type StenographerExtractionLane,
  type StenographerIntentAdapter,
  type StenographerLegacyConversionIntent,
  type StenographerLegacyConversionAdapterInput,
  type StenographerOperationOutcome,
  type StenographerRebuildIntent,
  type StenographerRebuildAdapterInput,
  type StenographerPreparedOperation,
  type StenographerPublicationContext,
} from "./journal/stenographer-data-operation.ts";
export {
  PostgresHumanMessageEditPlanner,
  type HumanMessageEditPlanResult,
} from "./message/postgres-human-message-edit-plan.ts";
export {
  admitForegroundSessionHumanLiveShadowMessage,
  type AdmittedForegroundSessionHumanLiveShadowMessage,
  type AdmitForegroundSessionHumanLiveShadowMessageInput,
} from "../message/human-foreground-session-live-shadow-message-admission.ts";
export {
  authenticateForegroundRuntimeRecipientKeyPair,
  destroyProtectedInvocationRecipient,
  withProtectedInvocationRecipientPrivateKey,
} from "../invocation/protected-grant-invocation.ts";
export type { ForegroundRuntimeRecipient } from
  "../invocation/protected-grant-invocation.ts";
export {
  ArtifactCryptoCompletionConflictError,
  createPostgresArtifactCryptoCompletion,
} from "./artifact/postgres-artifact-crypto-completion.ts";
export {
  PostgresArtifactProductPublication,
} from "./artifact/postgres-artifact-product-publication.ts";
export {
  createHumanArtifactRoutePorts,
} from "./artifact/human-artifact-route-ports.ts";
export type {
  HumanArtifactCryptoCompletionPort,
  HumanArtifactProductPlanPort,
  HumanArtifactProductReadPort,
  HumanArtifactProductPublicationPort,
  HumanArtifactRoutePorts,
} from "./artifact/human-artifact-route-ports.ts";
export {
  authenticateHumanArtifactPublication,
  readAuthenticatedHumanArtifactPublication,
} from "./artifact/human-artifact-prepared-publication.ts";
export type {
  AuthenticatedHumanArtifactPublication,
  HumanArtifactPublicationAuthorityContext,
  ResolveHumanArtifactPublicationAuthority,
} from "./artifact/human-artifact-prepared-publication.ts";
export {
  PostgresHumanArtifactCryptoCompletion,
} from "./artifact/postgres-human-artifact-crypto-completion.ts";
export {
  PostgresHumanArtifactProductRoute,
} from "./artifact/postgres-human-artifact-product-route.ts";
export {
  PostgresHumanArtifactProtectedProductRoute,
} from "./artifact/postgres-human-artifact-protected-product-route.ts";
export {
  PostgresDeviceAdmissionRepository,
} from "./device/postgres-device-admission-repository.ts";
export type {
  CurrentDeviceAdmissionAuthority,
  DeviceAdmissionStatus,
} from "./device/postgres-device-admission-repository.ts";
export type {
  HumanArtifactPublicationBindingFact,
  HumanArtifactRouteAuthority,
  ResolveHumanArtifactPublicationBindings,
} from "./artifact/postgres-human-artifact-product-route.ts";
export {
  createHumanArtifactExactAccessRoutePorts,
} from "./artifact/human-artifact-exact-access-route-ports.ts";
export type {
  HumanArtifactExactAccessCryptoRoutePort,
  HumanArtifactExactAccessProductRoutePort,
  HumanArtifactExactAccessRoutePorts,
} from "./artifact/human-artifact-exact-access-route-ports.ts";
export {
  deriveHumanArtifactExactAccessChange,
  fingerprintHumanArtifactExactAccessTarget,
  targetAfterHumanArtifactAuthorizedViewDeletion,
} from "./artifact/human-artifact-exact-access.ts";
export type {
  HumanArtifactExactAccessAuthority,
  HumanArtifactExactAccessChange,
} from "./artifact/human-artifact-exact-access.ts";
export {
  PostgresHumanArtifactExactAccessCryptoCompletion,
} from "./artifact/postgres-human-artifact-exact-access-crypto.ts";
export type {
  AuthenticatedHumanArtifactExactAccessPrepared,
  ResolveHumanArtifactExactAccessPolicyRevision,
} from "./artifact/postgres-human-artifact-exact-access-crypto.ts";
export {
  PostgresHumanArtifactExactAccessProduct,
} from "./artifact/postgres-human-artifact-exact-access-product.ts";
export type {
  HumanArtifactExactAccessAuthorityFacts,
  HumanArtifactExactAccessBindingFact,
  HumanArtifactExactAccessCommitResult,
  HumanArtifactExactAccessCryptoObservation,
  HumanArtifactExactAccessCryptoReceipt,
  HumanArtifactExactAccessPlan,
  HumanArtifactExactAccessPlanResult,
  HumanArtifactExactAccessReconcileResult,
  HumanArtifactExactAccessReplayLookup,
  HumanArtifactExactAccessTarget,
} from "./artifact/postgres-human-artifact-exact-access-product.ts";

export {
  AgentRuntimeSignerHistoryUnavailableError,
  LATTICE_STORAGE_NATIVE_V2_TABLE_NAMES,
  PostgresLatticeStorage,
  POSTGRES_LATTICE_STORAGE_OPERATION_MAP,
  createPostgresLatticeStorage,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  assertVerifiedCryptoPostgresHandle,
  verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
  type CryptoPostgresTransaction,
} from "./storage/postgres-lattice-storage.ts";
export {
  PostgresProcessorTransformObjectPort,
  createPostgresProcessorTransformObjectPort,
} from "./storage/postgres-processor-transform-object-port.ts";
export {
  AgentRuntimeSignerHistoryInvalidError,
  authenticateHistoricalAgentRuntimeSignerPublication,
} from "./storage/agent-runtime-signer-history.ts";
export type {
  HistoricalAgentRuntimeSignerManagerAuthority,
  ResolveHistoricalAgentRuntimeSignerManagerAuthority,
} from "./storage/agent-runtime-signer-history.ts";
export {
  bindConversationProductCanonicalTransactionRunner,
  assertConversationProductCanonicalTransactionRunner,
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  PostgresConversationProductStore,
  assertVerifiedConversationProductPostgresHandle,
  verifyConversationProductPostgresHandle,
} from "./message/postgres-conversation-product-store.ts";
export type {
  CompiledConversationProductQuery,
} from "./message/postgres-conversation-product-store.ts";
export {
  createLiveShadowAgentTurnSession,
} from "./message/live-shadow-agent-session.ts";
export {
  createPostgresForegroundJournalSelectionPort,
} from "./journal/postgres-foreground-journal-selection.ts";
export {
  FOREGROUND_JOURNAL_EVENT_OBJECT_TYPE,
  FOREGROUND_JOURNAL_ROLLUP_OBJECT_TYPE,
  FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
  attachPostgresForegroundJournalRepair,
  restorePostgresForegroundJournalOrdinary,
  attachPostgresForegroundRecordRepair,
  restorePostgresForegroundRecordOrdinary,
  loadPostgresForegroundJournalRepairSources,
  loadPostgresForegroundRecordRepairSources,
  validatePostgresForegroundJournalRepairSource,
  validatePostgresForegroundRecordRepairSource,
  type ForegroundJournalRepairSource,
  type ForegroundRecordRepairSource,
} from "./journal/postgres-foreground-journal-repair.ts";
export {
  ForegroundAuthorityConvergingError,
  ForegroundProductChangedError,
  isForegroundAuthorityConvergingError,
  isForegroundProductChangedError,
} from "./foreground-product-changed.ts";
export {
  createForegroundMessageHistoryRepairer,
} from "./message/foreground-message-history-repair.ts";
export type {
  ForegroundMessageEntityCryptoInvocation,
  ForegroundMessageRepairPublication,
  ForegroundMessageRepairPublicationScope,
  ForegroundMessageHistoryResult,
  ForegroundMessageRepairSource,
} from "./message/foreground-message-history-repair.ts";
export {
  loadPostgresForegroundMessageRepairSources,
} from "./message/postgres-foreground-message-repair-source.ts";
export {
  createDomainCompressedLiveShadowSessionCapability,
  destroyDomainCompressedLiveShadowSessionCapability,
  inspectDomainCompressedLiveShadowSessionCapability,
  withDomainCompressedLiveShadowSessionCapabilityEntries,
} from "./message/domain-compressed-live-shadow-session-capability.ts";
export type {
  DomainCompressedLiveShadowSessionCapability,
  DomainCompressedLiveShadowSessionCapabilityDescription,
} from "./message/domain-compressed-live-shadow-session-capability.ts";
export type {
  LiveShadowAgentMessageReservation,
  LiveShadowAgentOrdinaryPublication,
  LiveShadowAgentPublishedMessage,
  LiveShadowAgentSessionFailureReason,
  LiveShadowAgentSessionFailureStage,
  LiveShadowAgentSessionResult,
  LiveShadowAgentTurnExecutionResult,
  LiveShadowAgentStreamFrameResult,
  LiveShadowAgentStreamReservation,
  LiveShadowAgentTurnSession,
} from "./message/live-shadow-agent-session.ts";
export {
  PostgresMemoryProductStore,
} from "./memory/postgres-memory-product-store.ts";
export * from "./task/postgres-task-content-product-store.ts";
export * from "./task/postgres-task-content-crypto-completion.ts";
export * from "./task/task-content-repository-composition.ts";
export {
  PostgresAgentMemoryProductPort,
} from "./memory/postgres-agent-memory-product-port.ts";
export type {
  AgentMemoryPublicationBoundary,
  ProtectedAgentBackgroundMemoryOutputPlanInput,
} from "./memory/postgres-agent-memory-product-port.ts";
export {
  PostgresAgentBackgroundMemoryPublicationReconciler,
} from "./memory/postgres-agent-background-memory-publication-reconciler.ts";
export type {
  ProtectedAgentBackgroundMemoryPublicationReconciliationOutcome,
  ProtectedAgentBackgroundMemoryPublicationRecord,
} from "./memory/postgres-agent-background-memory-publication-reconciler.ts";
export {
  PostgresAgentBackgroundMemoryRevisionReader,
} from "./memory/postgres-agent-background-memory-reader.ts";
export {
  PostgresAgentBackgroundMessageRevisionReader,
} from "./message/postgres-agent-background-message-reader.ts";
export {
  MemoryCryptoCompletionConflictError,
  createPostgresAgentMemoryExactAccessCryptoCompletion,
  createPostgresMemoryCryptoCompletion,
} from "./memory/postgres-memory-crypto-completion.ts";
export {
  attachPostgresForegroundMemoryRepair,
  restorePostgresForegroundMemoryOrdinary,
  loadPostgresForegroundMemoryRepairSources,
  validatePostgresForegroundMemoryRepairSource,
  type ForegroundMemoryRepairSource,
} from "./memory/postgres-foreground-memory-repair.ts";
export {
  publishPostgresHumanMemoryRepresentationRepair,
} from "./memory/postgres-human-memory-representation-repair.ts";
export type {
  HumanMemoryRepairNativeAuthorityResolver,
  HumanMemoryRepresentationRepairResult,
  PublishPostgresHumanMemoryRepresentationRepairInput,
} from "./memory/postgres-human-memory-representation-repair.ts";
export {
  createPostgresHumanMemoryRepresentationRepairCrypto,
} from "./memory/postgres-human-memory-crypto-completion.ts";
export type {
  HumanMemoryRepresentationRepairCryptoInput,
  PostgresHumanMemoryRepresentationRepairCrypto,
} from "./memory/postgres-human-memory-crypto-completion.ts";
export type {
  PostgresMemoryCryptoCompletion,
  ResolveAgentMemoryExactAccessPolicyRevision,
} from "./memory/postgres-memory-crypto-completion.ts";
export {
  readVerifiedDeviceWrappedAgentObject,
} from "./memory/postgres-memory-crypto-completion.ts";
export type {
  VerifiedDeviceWrappedAgentObject,
} from "./memory/postgres-memory-crypto-completion.ts";
export {
  persistDeviceWrappedAgentObject,
} from "./object/postgres-device-wrapped-agent-object.ts";
export {
  PostgresAgentMemoryExactAccessProduct,
} from "./memory/postgres-agent-memory-exact-access-product.ts";
export {
  createPostgresForegroundAgentAcceptedExecutionEvidenceResolver,
  createPostgresForegroundAgentSignerResolver,
} from "./message/postgres-foreground-agent-signer.ts";
export type {
  ForegroundAgentAcceptedExecutionEvidence,
  ResolveForegroundAgentAcceptedExecutionEvidence,
} from "./message/postgres-foreground-agent-signer.ts";
export type {
  AgentMemoryExactAccessAuthorityFacts,
  AgentMemoryExactAccessProductPlanResult,
  AgentMemoryExactAccessReconcileResult,
  ResolveAgentMemoryExactAccessAuthority,
  ResolveAgentMemoryGrantUserNamespace,
} from "./memory/postgres-agent-memory-exact-access-product.ts";
export {
  authenticatePreparedHumanMemoryCreate,
  authenticatePreparedHumanMemoryUpdate,
  bindPreparedHumanMemoryProductAllocation,
  readPreparedHumanMemoryUpdateSnapshot,
} from "./memory/human-memory-prepared-update.ts";
export type {
  AuthenticatedHumanMemoryPreparedCreate,
  AuthenticatedHumanMemoryPreparedUpdate,
  HistoricalHumanMemoryDeviceAuthority,
  HumanMemoryPreparedAuthorityContext,
  HumanMemoryPreparedUpdateSnapshot,
  HumanMemoryProductAllocationCertificate,
  PreparedHumanMemoryUpdate,
  PreparedHumanMemoryCreate,
  ResolveHistoricalHumanMemoryDeviceAuthority,
} from "./memory/human-memory-prepared-update.ts";
export {
  createHumanMemoryPreparedCreateRoutePort,
} from "./memory/human-memory-prepared-create-composition.ts";
export type {
  HumanMemoryPreparedCreateRouteAuthority,
  HumanMemoryPreparedCreateRoutePort,
} from "./memory/human-memory-prepared-create-composition.ts";
export {
  createHumanMemoryProtectedRoutePorts,
  createHumanMemoryProtectedRoutePortsFromTrustedPorts,
  type HumanMemoryProtectedRouteAssembly,
} from "./memory/human-memory-protected-route-ports.ts";
export type {
  HumanMemoryProtectedExactAccessCryptoPort,
  HumanMemoryProtectedExactAccessProductPort,
  HumanMemoryExactAccessReadinessRequired,
  HumanMemoryProtectedProductRoutePort,
  HumanMemoryProtectedRouteAuthority,
  HumanMemoryProtectedRoutePorts,
  HumanMemoryProtectedRouteTestAuthority,
  HumanMemoryProtectedSemanticEmbedding,
  HumanMemoryProtectedTierAction,
  HumanMemoryProtectedTierReceipt,
} from "./memory/human-memory-protected-route-ports.ts";
export {
  createHumanMemoryPreparedUpdateRoutePort,
} from "./memory/human-memory-prepared-update-composition.ts";
export type {
  CreateBoundHumanMemoryCryptoCompletion,
  HumanMemoryPreparedUpdateRouteAuthority,
  HumanMemoryPreparedUpdateRoutePort,
  ResolveHumanMemoryRouteHumanId,
} from "./memory/human-memory-prepared-update-composition.ts";
export {
  PostgresHumanMemoryProductUpdate,
  humanMemoryAllocationRequestDigest,
} from "./memory/postgres-human-memory-product-update.ts";
export {
  PostgresHumanMemoryAuthorityResolver,
} from "./memory/postgres-human-memory-authority.ts";
export type {
  HumanMemoryActualEmbedding,
  HumanMemoryAuthoredPublication,
  HumanMemoryPublicationBoundary,
  HumanMemoryProductCreateAuthority,
  HumanMemoryProductCreateInspection,
  HumanMemoryProductCreatePort,
  HumanMemoryProductAuthority,
  HumanMemoryProductInspection,
  HumanMemoryProductProjection,
  HumanMemoryReservationReplay,
  HumanMemoryProductUpdatePort,
} from "./memory/postgres-human-memory-product-update.ts";
export {
  HumanMemoryCryptoCompletionConflictError,
  createPostgresHumanMemoryCryptoCompletion,
} from "./memory/postgres-human-memory-crypto-completion.ts";
export {
  createPostgresHumanMemoryProtectedProductRoutePort,
} from "./memory/postgres-human-memory-protected-product-route.ts";
export type {
  CurrentHumanMemoryWriteAuthorization,
  CurrentHumanMemoryWriteAuthorizationContext,
  PostgresHumanMemoryCryptoCompletion,
  ResolveCurrentHumanMemoryWriteAuthorization,
  ResolveStoredHumanMemorySignerAuthority,
  StoredHumanMemorySignerAuthority,
  StoredHumanMemorySignerContext,
  VerifiedHumanMemoryCryptoRevisionContent,
} from "./memory/postgres-human-memory-crypto-completion.ts";
export type {
  ConversationProductCanonicalTransactionConnection,
  ConversationProductCanonicalTransactionRunner,
  ConversationProductDatabaseRow,
  ConversationProductPostgresConnection,
  ConversationProductPostgresExecutor,
  ConversationProductPostgresHandle,
  ConversationProductPostgresIsolationLevel,
  ConversationProductPostgresScalar,
  ConversationProductPostgresTransaction,
} from "./message/postgres-conversation-product-store.ts";
export {
  createPostgresConversationProtectedReadPort,
} from "./message/postgres-conversation-protected-read.ts";
export {
  createCurrentDomainKeyRoomHistoryAuthorityResolver,
  createCurrentHumanDomainKeyRoomHistoryAuthorityResolver,
  createHumanEditedRepresentationAuthorityResolver,
  createPostgresRoomHistoryShadowProjection,
} from "./message/postgres-room-history-shadow-projection.ts";
export type {
  PostgresRoomHistoryShadowProjectionOptions,
  ResolveRoomHistoryHumanPeerAuthority,
  ResolveRoomHistoryCurrentAuthority,
  RoomHistoryCurrentAuthority,
  RoomHistoryHumanPeerAuthorityResolution,
  RoomHistoryCurrentAuthorityResolution,
  RoomHistorySelectedCoordinate,
  RoomHistoryShadowProjection,
  RoomHistoryShadowProjectionRecord,
  RoomHistorySignerEvidenceTransportV1,
} from "./message/postgres-room-history-shadow-projection.ts";
export {
  createProtectedConversationAgentContentOpener,
} from "./message/protected-conversation-agent-content-opener.ts";
export type {
  ConversationProtectedCryptoReadPort,
  ConversationProtectedMessageDtoV2,
  ConversationProtectedProductReadAuthority,
  ConversationProtectedProductReadOperation,
  PostgresConversationProtectedReadOptions,
  ResolveConversationProtectedProductReadAuthorization,
} from "./message/postgres-conversation-protected-read.ts";
export type {
  ConversationProtectedAgentContentAuthorityPort,
  ConversationProtectedAgentUnavailableReason,
  ProtectedConversationAgentContentOpenerOptions,
} from "./message/protected-conversation-agent-content-opener.ts";
export {
  createProtectedJournalAgentContentOpener,
} from "./journal/protected-journal-agent-content-opener.ts";
export {
  createPostgresProtectedJournalProductReadPort,
  PROTECTED_JOURNAL_EVENT_PROJECTION_SQL,
} from "./journal/postgres-protected-journal-product-read.ts";
export type {
  PostgresProtectedJournalProductReadOptions,
  ProtectedJournalProductReadAuthority,
  ProtectedJournalProductReadOperation,
  ResolveProtectedJournalProductReadAuthorization,
} from "./journal/postgres-protected-journal-product-read.ts";
export type {
  ProtectedJournalAgentContentAuthorityPort,
  ProtectedJournalAgentContentOpenerOptions,
  ProtectedJournalProcessorObjectVerifierPort,
  VerifiedProtectedJournalProcessorObject,
} from "./journal/protected-journal-agent-content-opener.ts";
export {
  PostgresProtectedJournalProcessorObjectVerifier,
} from "./journal/postgres-protected-journal-processor-object-verifier.ts";
export {
  PostgresProcessorTransformCommitVerifier,
} from "./journal/postgres-processor-transform-commit-verifier.ts";
export type {
  ProcessorTransformCommitVerifierPort,
  VerifiedProcessorTransformCommit,
} from "./journal/postgres-processor-transform-commit-verifier.ts";
export {
  JOURNAL_CRYPTO_TOMBSTONE_MAX_OBJECTS,
  PostgresJournalCryptoTombstoneRepository,
} from "./journal/postgres-journal-crypto-tombstone.ts";
export type {
  JournalCryptoTombstonePort,
  JournalCryptoTombstoneResult,
} from "./journal/postgres-journal-crypto-tombstone.ts";
export {
  ConversationCryptoReadUnavailableError,
  ConversationCryptoCompletionConflictError,
  createPostgresConversationCryptoCompletion,
  readVerifiedStoredConversationCryptoRevision,
} from "./storage/postgres-conversation-crypto-completion.ts";
export {
  PostgresHumanDeviceSignerHistory,
} from "./storage/postgres-human-device-signer-history.ts";
export type {
  HistoricalHumanObjectAccessGenesisSignerAuthority,
  HistoricalHumanObjectAccessGenesisSignerContext,
  ResolveHistoricalHumanObjectAccessGenesisSigner,
  VerifiedStoredConversationCryptoRead,
} from "./storage/postgres-conversation-crypto-completion.ts";
export {
  DormantCryptoServerBoundaryError,
  createDormantCryptoServerBoundary,
} from "./dormant-crypto-server-boundary.ts";
export type {
  DormantCryptoServerBoundary,
  DormantCryptoServerBoundaryErrorCode,
  DormantCryptoServerOperation,
} from "./dormant-crypto-server-boundary.ts";
export {
  PostgresInitialDeviceBootstrapRepository,
} from "./device/postgres-initial-bootstrap-repository.ts";
export {
  PostgresInitialHumanDomainRepository,
} from "./device/postgres-initial-human-domain-repository.ts";
export type {
  InitialHumanDomainActivationResult,
  InitialHumanDomainAuthority,
  InitialHumanDomainPlanResult,
} from "./device/postgres-initial-human-domain-repository.ts";
export {
  createPostgresInitialDeviceReadinessComposition,
  decodeInitialHumanDomainSubmission,
} from "./device/production-initial-device-readiness.ts";
export type {
  PostgresInitialDeviceReadinessComposition,
} from "./device/production-initial-device-readiness.ts";
export {
  createPostgresAdditionalDeviceComposition,
  destroyEnrollmentAuthorization,
  destroyPendingAdditionalDeviceEnrollment,
  enrollmentDto,
  prepareEnrollmentAuthorization,
} from "./device/production-additional-device.ts";
export type {
  PostgresAdditionalDeviceComposition,
} from "./device/production-additional-device.ts";
export {
  InitialDeviceBootstrapError,
  InitialDeviceBootstrapService,
} from "./device/initial-bootstrap-service.ts";
export type {
  AuthorizeInitialDeviceBootstrap,
  AuthorizeInitialDeviceBootstrapReceiptLookup,
  InitialDeviceBootstrapAuthorization,
  InitialDeviceBootstrapErrorCode,
  InitialDeviceBootstrapRepository,
} from "./device/initial-bootstrap-service.ts";
export {
  AdditionalDeviceEnrollmentError,
  AdditionalDeviceEnrollmentService,
} from "./device/additional-device-enrollment-service.ts";
export {
  PostgresAdditionalDeviceEnrollmentRepository,
} from "./device/postgres-additional-device-enrollment-repository.ts";
export {
  PostgresHumanDeviceGroupRepository,
} from "./device/postgres-human-device-group-repository.ts";
export type {
  HumanDeviceGroupStatus,
  HumanDeviceMembershipState,
  PendingHumanDeviceJoin,
} from "./device/postgres-human-device-group-repository.ts";
export {
  PostgresDeviceFanoutAdmissionRepository,
} from "./device/postgres-device-fanout-admission-repository.ts";
export type {
  DeviceFanoutAdmissionResult,
} from "./device/postgres-device-fanout-admission-repository.ts";
export {
  PostgresDeviceRevocationAdmissionRepository,
} from "./device/postgres-device-revocation-admission-repository.ts";
export type {
  DeviceRevocationAdmissionResult,
} from "./device/postgres-device-revocation-admission-repository.ts";
export {
  PostgresDeviceRevocationFinalizationRepository,
} from "./device/postgres-device-revocation-finalization-repository.ts";
export type {
  DeviceRevocationFinalizationResult,
} from "./device/postgres-device-revocation-finalization-repository.ts";
export {
  PostgresDeviceJoinPackageRepository,
} from "./device/postgres-device-join-package-repository.ts";
export type {
  ClaimDeviceJoinPackageResult,
  PublishDeviceJoinPackagesResult,
} from "./device/postgres-device-join-package-repository.ts";
export {
  PostgresDeliveryAcknowledgementRepository,
} from "./delivery/postgres-delivery-acknowledgement-repository.ts";
export type {
  PersistDeliveryAcknowledgementResult,
} from "./delivery/postgres-delivery-acknowledgement-repository.ts";
export {
  PostgresDeliveryMaintenanceRepository,
} from "./delivery/postgres-delivery-maintenance-repository.ts";
export {
  PostgresDeliveryOperationReconciler,
} from "./delivery/postgres-delivery-operation-reconciler.ts";
export type {
  ClaimedDeliveryOperation,
  ReconcileDeliveryOperationResult,
} from "./delivery/postgres-delivery-operation-reconciler.ts";
export {
  PostgresCryptoOutboxRepository,
} from "./delivery/postgres-crypto-outbox-repository.ts";
export type {
  ClaimedCryptoOutboxEvent,
  FailCryptoOutboxResult,
} from "./delivery/postgres-crypto-outbox-repository.ts";
export {
  PostgresDeviceDeliveryFetchRepository,
} from "./delivery/postgres-device-delivery-fetch-repository.ts";
export type {
  DeviceDeliveryMessage,
  FetchDeviceDeliveriesResult,
} from "./delivery/postgres-device-delivery-fetch-repository.ts";
export {
  PostgresDomainTransitionLeaseRepository,
} from "./delivery/postgres-domain-transition-lease-repository.ts";
export type {
  ClaimedDomainTransition,
} from "./delivery/postgres-domain-transition-lease-repository.ts";
export {
  PostgresDomainTransitionSubmissionRepository,
} from "./delivery/postgres-domain-transition-submission-repository.ts";
export type {
  DomainTransitionSubmissionResult,
} from "./delivery/postgres-domain-transition-submission-repository.ts";
export {
  PostgresHumanMembershipAdmissionRepository,
} from "./delivery/postgres-human-membership-admission-repository.ts";
export type {
  HumanMembershipAdmissionResult,
} from "./delivery/postgres-human-membership-admission-repository.ts";
export {
  PostgresHumanMembershipTargetDomainRepository,
} from "./delivery/postgres-human-membership-target-domain-repository.ts";
export type {
  HumanMembershipTargetDomainResult,
} from "./delivery/postgres-human-membership-target-domain-repository.ts";
export {
  PostgresHumanMembershipRebindRepository,
} from "./delivery/postgres-human-membership-rebind-repository.ts";
export type {
  HumanMembershipRebindStagingResult,
} from "./delivery/postgres-human-membership-rebind-repository.ts";
export {
  NamespaceKeyPublicationAuthorityDriftError,
  PostgresNamespaceProductAuthority,
} from "./delivery/postgres-namespace-product-authority.ts";
export type {
  HumanPeerNamespaceWriteAuthorityResult,
  NamespaceProductAuthoritySnapshot,
  SharedAgentNamespaceWriteAuthorityResult,
} from
  "./delivery/postgres-namespace-product-authority.ts";
export {
  createPostgresDomainKeyAuthorityRepositoryFactory,
  DOMAIN_KEY_AUTHORITY_OPERATION_TTL_MS,
  PostgresDomainKeyAuthorityRepository,
  resolveAdditionalDevicePersonalAuthorityAnchor,
} from "./delivery/postgres-domain-key-authority.ts";
export type {
  DomainForegroundNamespaceAuthorityInspectionV2,
  DomainKeyAuthorityHeadPlan,
  DomainKeyAuthorityPublicationResult,
  DomainKeyAuthorityUnavailableReason,
  DomainKeyEnvelopeAcknowledgementResult,
  DomainKeyEnvelopeFetchResult,
  DomainKeyRecipientFulfilmentResult,
  DomainKeyRecipientRequestResult,
  DomainNamespaceBundlePlan,
  DomainNamespaceBundlePublicationResult,
  PendingDomainKeyRecipientRequest,
} from "./delivery/postgres-domain-key-authority.ts";
export {
  PostgresHumanMembershipActivationRepository,
} from "./delivery/postgres-human-membership-activation-repository.ts";
export type {
  HumanMembershipActivationResult,
} from "./delivery/postgres-human-membership-activation-repository.ts";
export {
  HumanMembershipAtomicCoordinator,
} from "./delivery/human-membership-atomic-coordinator.ts";
export type {
  HumanMembershipAtomicActivationRequest,
  HumanMembershipAtomicActivationResult,
  HumanMembershipAtomicPort,
} from "./delivery/human-membership-atomic-coordinator.ts";
export {
  PostgresDeviceActivationRepository,
} from "./device/postgres-device-activation-repository.ts";
export type {
  DeviceActivationResult,
} from "./device/postgres-device-activation-repository.ts";
export {
  PostgresRecoveryRotationRepository,
} from "./recovery/postgres-recovery-rotation-repository.ts";
export type {
  RecoveryRotationResult,
} from "./recovery/postgres-recovery-rotation-repository.ts";
export {
  PostgresRecoveryChallengeRepository,
} from "./recovery/postgres-recovery-challenge-repository.ts";
export type {
  RecoveryChallengePublicationResult,
} from "./recovery/postgres-recovery-challenge-repository.ts";
export {
  PostgresRecoveryFanoutAdmissionRepository,
} from "./recovery/postgres-recovery-fanout-admission-repository.ts";
export type {
  RecoveryFanoutAdmissionResult,
} from "./recovery/postgres-recovery-fanout-admission-repository.ts";
export type {
  AdditionalDeviceEnrollmentAuthorization,
  AdditionalDeviceEnrollmentErrorCode,
  AdditionalDeviceEnrollmentRepository,
  AuthorizeAdditionalDeviceEnrollment,
} from "./device/additional-device-enrollment-service.ts";
export {
  deriveHumanMemoryExactAccessChange,
  fingerprintHumanMemoryExactAccessTarget,
  targetAfterAuthorizedViewDeletion,
} from "./memory/human-memory-exact-access.ts";
export type {
  HumanMemoryExactAccessAuthority,
  HumanMemoryExactAccessChange,
} from "./memory/human-memory-exact-access.ts";
export {
  LIVE_SHADOW_RECIPIENTS_PER_CLIENT_SESSION,
  LiveShadowRecipientRegistry,
} from "./message/live-shadow-recipient-registry.ts";
export type {
  LiveShadowRecipientEntry,
  LiveShadowRuntimeRecipientEntry,
} from "./message/live-shadow-recipient-registry.ts";
export {
  createPostgresLiveShadowTurnPlanner,
  inspectDomainKeyV2CryptoAuthority,
  LIVE_SHADOW_FOREGROUND_AUTHORIZATION_TTL_MS,
  PostgresLiveShadowTurnPlanner,
} from "./message/postgres-live-shadow-turn-plan.ts";
export type {
  DomainKeyV2CryptoAuthority,
  SharedAgentForegroundExecutionPlanInput,
  SharedAgentForegroundExecutionPlanResult,
  RuntimeInvocationForegroundAuthorizationPlanInput,
  RuntimeInvocationForegroundAuthorizationPlanResult,
  RuntimeInvocationForegroundCurrentAuthority,
} from
  "./message/postgres-live-shadow-turn-plan.ts";
export {
  createPostgresHumanPeerLiveShadowPlanner,
  PostgresHumanPeerLiveShadowPlanner,
} from "./message/postgres-human-peer-live-shadow-plan.ts";
export type {
  HumanPeerLiveShadowPlanInput,
  HumanPeerLiveShadowPlanResult,
} from "./message/postgres-human-peer-live-shadow-plan.ts";
export {
  createPostgresSharedAgentLiveShadowPlanner,
  PostgresSharedAgentLiveShadowPlanner,
} from "./message/postgres-shared-agent-live-shadow-plan.ts";
export type {
  SharedAgentLiveShadowPlanInput,
  SharedAgentLiveShadowPlanResult,
  SharedAgentExecutionReservation,
  SharedAgentRuntimeInvocationReservation,
  SharedAgentRuntimeInvocationExecutionAttachment,
  SharedAgentRuntimeResumeReservationResult,
  SharedAgentConductorResolution,
  RuntimeInvocationConductorClaimResult,
  RuntimeInvocationConductorRoutePath,
  RuntimeInvocationConductorHistoryStatus,
  RuntimeInvocationConductorOutcome,
} from "./message/postgres-shared-agent-live-shadow-plan.ts";
export {
  openPostgresSharedAgentProtectedInputSet,
  openPostgresRuntimeInvocationProtectedInputSet,
  openPostgresRuntimeInvocationProtectedHistoryHits,
} from
  "./message/postgres-shared-agent-live-shadow-input-opener.ts";
export type {
  SharedAgentProtectedInputOpenResult,
  RuntimeInvocationProtectedHistoryHit,
} from
  "./message/postgres-shared-agent-live-shadow-input-opener.ts";
export { admitAndPersistHumanPeerLiveShadowMessage } from
  "./message/human-peer-live-shadow-admission.ts";
export type {
  HumanPeerLiveShadowAdmissionDependencies,
  HumanPeerLiveShadowAdmissionResult,
  HumanPeerLiveShadowPreparedAttempt,
} from "./message/human-peer-live-shadow-admission.ts";
export { admitAndPersistSharedAgentLiveShadowMessage } from
  "./message/shared-agent-live-shadow-admission.ts";
export type {
  SharedAgentLiveShadowAdmissionDependencies,
  SharedAgentLiveShadowAdmissionResult,
  SharedAgentLiveShadowPreparedAttempt,
} from "./message/shared-agent-live-shadow-admission.ts";
export { admitAndPersistHumanAiReadableLiveShadowMessage } from
  "./message/human-ai-readable-live-shadow-admission.ts";
export type {
  HumanAiReadableLiveShadowAdmissionDependencies,
  HumanAiReadableLiveShadowAdmissionResult,
  HumanAiReadableLiveShadowPreparedAttempt,
} from "./message/human-ai-readable-live-shadow-admission.ts";
export type {
  LiveShadowTurnPlanInput,
  LiveShadowTurnPlanResult,
  LiveShadowTurnFallbackInput,
  LiveShadowTurnJobBindingInput,
  LiveShadowTurnFallbackReason,
  LiveShadowTurnFallbackStage,
  LiveShadowNamespaceAuthorityScheme,
  LiveShadowForegroundAuthorizationPlanPort,
  LiveShadowForegroundAuthorizationScope,
  AgentLiveShadowForegroundAuthorizationScope,
  RuntimeLiveShadowForegroundAuthorizationScope,
  LiveShadowReusableForegroundAuthorization,
  ResolveLiveShadowReadableNamespaces,
} from "./message/postgres-live-shadow-turn-plan.ts";
export { persistForegroundSessionHumanLiveShadowMessage } from
  "./message/live-shadow-human-message-admission.ts";
export type {
  LiveShadowHumanAdmissionDependencies,
  LiveShadowHumanAdmissionResult,
  LiveShadowHumanPreparedAttempt,
  LiveShadowExecutionCapability,
  ForegroundLiveShadowSessionExecutionCapability,
} from "./message/live-shadow-human-message-admission.ts";
export { inspectPostgresHumanLiveShadowReplay } from
  "./message/postgres-live-shadow-human-replay.ts";
export type { HumanLiveShadowCommittedReplay } from
  "./message/postgres-live-shadow-human-replay.ts";
export { createPostgresDomainKeyV2LiveShadowCurrentAuthority } from
  "./message/postgres-domain-key-v2-live-shadow-authority.ts";
export type { DomainKeyV2LiveShadowCurrentAuthority } from
  "./message/postgres-domain-key-v2-live-shadow-authority.ts";
export {
  recoverPostgresLiveShadowTurn,
  resolveRoomHistoryReaderSigningPublicKey,
  verifyAndRecordLiveShadowClientVerification,
} from
  "./message/postgres-live-shadow-client-verification.ts";
export { recoverPostgresPublishedHumanMessage } from
  "./message/postgres-published-human-message-recovery.ts";
export type { PublishedHumanMessageRecoveryResult } from
  "./message/postgres-published-human-message-recovery.ts";
export type {
  LiveShadowClientVerificationInput,
  LiveShadowClientVerificationResult,
  LiveShadowTurnRecoveryResult,
  RoomHistoryReaderSigningAuthorityInput,
} from "./message/postgres-live-shadow-client-verification.ts";
export {
  withCurrentHumanDeviceSigningAuthority,
  type CurrentHumanDeviceSigningAuthorityCoordinates,
} from "./device/postgres-current-human-device-signing-authority.ts";
export { publishHumanDeviceOrdinaryRepairV2 } from
  "./message/human-device-ordinary-repair-attestation.ts";
export {
  authenticateHumanMemoryExactAccessPrepared,
  PostgresHumanMemoryExactAccessCryptoCompletion,
  readAuthenticatedHumanMemoryExactAccessAuthority,
} from "./memory/postgres-human-memory-exact-access-crypto.ts";
export type {
  AuthenticatedHumanMemoryExactAccessPrepared,
} from "./memory/postgres-human-memory-exact-access-crypto.ts";
export {
  PostgresHumanMemoryExactAccessProduct,
} from "./memory/postgres-human-memory-exact-access-product.ts";
export {
  memoryNativeAccessEntriesAuthentic,
  memoryNativeAccessEntryMatchesBindingRow,
  lockMemoryNativeAccessEntries,
  lockCurrentMemoryNativeAccessEntries,
} from
  "./memory/native-memory-access-authority.ts";
export { persistForegroundAgentMemoryNativeExactAccess } from
  "./memory/postgres-foreground-agent-memory-exact-access.ts";
export { createPostgresHumanMemoryNamespaceAuthorityResolver } from
  "./memory/postgres-human-memory-namespace-authority.ts";
export type {
  HumanMemoryExactAccessCommitResult,
  HumanMemoryExactAccessCryptoObservation,
  HumanMemoryExactAccessCryptoReceipt,
  HumanMemoryExactAccessPlan,
  HumanMemoryExactAccessPlanResult,
  HumanMemoryExactAccessReconcileResult,
  HumanMemoryExactAccessReplayLookup,
  HumanMemoryExactAccessTarget,
} from "./memory/postgres-human-memory-exact-access-product.ts";
export {
  createFilesystemEncryptedArtifactBlobStoreV1,
  type ArtifactBlobFilesystemFileV1,
  type ArtifactBlobFilesystemV1,
  type EncryptedArtifactBlobInspectionV1,
  type EncryptedArtifactBlobPublicationV1,
  type EncryptedArtifactBlobReconciliationV1,
  type EncryptedArtifactBlobReferenceV1,
  type EncryptedArtifactBlobStoreV1,
  type EncryptedArtifactBlobStoredFactsV1,
  type EncryptedArtifactBlobVerificationV1,
} from "../artifact/filesystem-blob-store.ts";
export * from "./message/postgres-message-backfill-scan.ts";
export * from "./message/postgres-message-backfill-discovery.ts";
export * from "./message/postgres-message-backfill-progress.ts";
export * from "./message/postgres-message-backfill-source.ts";
export * from "./message/message-backfill-authority.ts";
export * from "./message/message-backfill-tool-context.ts";

export {withCurrentStenographerAuthority, matchesCurrentStenographerAuthority, matchesStenographerRequestAdmission,
  type StenographerRequestAdmission} from "./journal/current-stenographer-authority.ts";
export { matchesCurrentReflectionAuthority, withCurrentReflectionAuthority } from "./journal/current-reflection-authority.ts";
export {
  withCurrentTaskRuntimeAuthority,
  type CurrentTaskRuntimeAuthority,
  type TaskRuntimeAuthoritySubject,
  type TaskRuntimeDomainAuthorityRequirement,
  type TaskRuntimeNamespaceAuthorityRequirement,
} from "./task/current-task-runtime-authority.ts";
export { bindReflectionSemanticDataOperationPort,
  type ReflectionSemanticDataOperationPorts } from "./reflection/semantic-data-operation-port.ts";

export {createPostgresCurrentProcessorTransformObjectPort, type WithCurrentProcessorPublicationAuthority, type CurrentProcessorHeldAuthority, type CurrentProcessorReconciliationAttachment} from "./storage/postgres-current-processor-transform-object-port.ts";
export {verifyStoredObjectAccessManifestChainV5, destroyVerifiedStoredObjectAccessManifestChainV5} from "./storage/postgres-object-access-manifest-v5.ts";

export {createPostgresCurrentProcessorReconciliationObjectVerifier} from "./storage/postgres-current-processor-reconciliation-input.ts";

export {createPostgresStenographerAuthorizationWaitPort, type StenographerAuthorizationWaitPort} from "./journal/postgres-stenographer-authorization-wait.ts";
export { readPostgresStenographerProtectionStatus } from
  "./journal/postgres-stenographer-protection-status.ts";

export {validatePostgresStenographerOutputRepairPlan, withPostgresStenographerOutputRepairSources,
  attachPostgresStenographerOutputRepair} from "./journal/postgres-stenographer-output-repair.ts";
export {listPostgresStenographerFallbackCandidates, selectPostgresStenographerFallback,
  selectPostgresStenographerFallbackInTransaction, buildStenographerOutputRepairPlan,
  type PostgresStenographerFallbackCandidate, type PostgresStenographerFallbackCandidateCursor,
  type PostgresStenographerFallbackCandidatePage, type PostgresStenographerFallbackReceiptSelection,
  type PostgresStenographerFallbackSelectionResult} from "./journal/postgres-stenographer-fallback-selection.ts";
export {createPostgresReflectionAuthorityObjectPort, createPostgresReflectionSemanticObjectPort} from "./reflection/postgres-authority-object-port.ts";
export {readPostgresReflectionAuthoritySourcePlan, withPostgresReflectionAuthoritySourcePlan, validatePostgresReflectionAuthorityReprojection,
  type ReflectionAuthoritySourcePlan, type ReflectionAuthorityPlanCoordinates} from "./reflection/postgres-authority-plan.ts";

export {resolveReflectionSemanticStageAdmission} from "./reflection/semantic-data-operation-port.ts";
export {readPostgresReflectionAuthoritySavedOutput, validatePostgresReflectionAuthorityRecovery, validatePostgresReflectionSemanticRecovery,
  type PostgresReflectionAuthoritySavedOutput} from "./reflection/postgres-authority-recovery.ts";
export { readPostgresReflectionAuthorityStatus } from
  "./reflection/postgres-authority-status.ts";

export {readPostgresReflectionSemanticSourcePlan, validatePostgresReflectionSemanticPlan, withPostgresReflectionSemanticSourcePlan, type ReflectionSemanticPlanCoordinates, type ReflectionSemanticSourcePlan} from "./reflection/postgres-semantic-plan.ts";

export type {ReflectionSemanticOperationPort, ReflectionSemanticOperationRequest} from "./reflection/semantic-operation.ts";
export {createProtectedReflectionSearchProjection, type ProtectedReflectionSearchMetadata, type ProtectedReflectionSearchProjectionPorts} from "./reflection/protected-search-projection.ts";
export {PostgresProtectedReflectionSearchMetadata} from "./reflection/protected-search-metadata.ts";

export {prepareReflectionSemanticQuestion, type PreparedReflectionSemanticQuestion} from "./reflection/prepared-semantic-question.ts";

export {createProtectedReflectionSemanticQuestions, type ProtectedReflectionSemanticQuestionsPorts, type ProtectedReflectionSemanticQuestionValue} from "./reflection/protected-semantic-questions.ts";

export {PostgresProtectedOrganizerMetadata, type ProtectedOrganizerRoomBindingPort, type ProtectedOrganizerRecordMetadata, type ProtectedOrganizerMemoryMetadata, type ProtectedOrganizerMemoryMetadataResult} from "./reflection/protected-organizer-metadata.ts";


export {PostgresProtectedReflectionMessageMetadata, type ProtectedReflectionMessageMetadata} from "./reflection/protected-message-metadata.ts";

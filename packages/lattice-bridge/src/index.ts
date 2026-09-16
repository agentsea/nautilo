export {
  decodeHumanMemoryReadAcknowledgementV1,
  encodeHumanMemoryReadAcknowledgementV1,
  humanMemoryReadAcknowledgementSigningBytesV1,
  prepareHumanMemoryReadAcknowledgementV1,
  verifyHumanMemoryReadAcknowledgementV1,
  type HumanMemoryReadAcknowledgementUnsignedV1,
  type HumanMemoryReadAcknowledgementV1,
} from "./memory/human-memory-read-acknowledgement.ts";

export {
  createForegroundMemoryProcessorRecipient,
  sealForegroundMemoryProcessorRequest,
} from "./memory/foreground-memory-processor-transport.ts";
export { createHumanMemoryProcessorTransport } from "./client/memory/human-memory-processor-transport.ts";
export {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  ARTIFACT_CONTROL_VERSION_V1,
  ARTIFACT_MIME_CLASSES,
  ARTIFACT_SIZE_BUCKETS,
  artifactCryptoRevisionReference,
  artifactPublicationRequestDigest,
  assertArtifactPublicationPlan,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactBlobPublicationReference,
  type ArtifactBlobVerificationPort,
  type ArtifactCryptoRevisionReference,
  type ArtifactMimeClass,
  type ArtifactProductPublicationPort,
  type ArtifactPublicationLifecycle,
  type ArtifactPublicationOperationType,
  type ArtifactPublicationPlanInput,
  type ArtifactProductPublishResult,
  type ArtifactProductReserveResult,
  type ArtifactSizeBucket,
  type AtomicArtifactCryptoCompletionPort,
  type PreparedArtifactCryptoRevision,
  type VerifiedArtifactCryptoRevision,
} from "./artifact/artifact-repository.ts";
export type {
  ForegroundJournalProtectedMapping,
  ForegroundJournalHistoryResult,
  ForegroundJournalSelectedEvent,
  ForegroundJournalSelectedRollup,
  ForegroundJournalSelectionPort,
  ForegroundJournalSelectionSnapshot,
} from "./journal/foreground-journal-selection.ts";
export {
  createDormantArtifactShadowRepository,
  type ArtifactPublicationResult,
} from "./artifact/artifact-shadow-saga.ts";
export {
  createPreparedArtifactCryptoRevision,
  readPreparedArtifactCryptoRevisionSnapshot,
  type ArtifactCryptoRevisionSnapshot,
} from "./artifact/artifact-prepared-revision.ts";
export {
  describeProtectedMemoryUnavailable,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemorySearchPort,
  type ProtectedAgentMemoryAccessAction,
  type ProtectedAgentMemoryAccessApprovalPreview,
  type ProtectedAgentMemoryAccessApprovalReference,
  type ProtectedAgentMemoryAccessPort,
  type ProtectedAgentMemoryProjectionApprovalPreview,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryProjectionPreparation,
  type ProtectedAgentMemoryProjectionReference,
  type ProtectedMemoryAuthority,
  type ProtectedMemoryOpenedItem,
  type ProtectedMemoryResult,
  type ProtectedMemoryUnavailableReason,
} from "./memory/active-memory-repository.ts";
export {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  classifyDataOperationFailure,
  fallbackEligible,
  type AtomicDataOperationMutationInput,
  type DataOperationFailureClass,
  type DataOperationMutationInput,
  type DataOperationPolicyBinding,
  type DataOperationPolicySnapshot,
  type DataOperationPublicationContext,
  type DataOperationReadInput,
  type DataOperationReadResult,
  type EncryptionDataOperationOwner,
} from "./transition/encryption-data-operation-owner.ts";
export {
  AuthorizedHumanMemoryUnavailableError,
  createAuthorizedHumanMemoryClient,
  type AuthorizedHumanMemoryClient,
  type AuthorizedHumanMemoryPreparedMutationJournal,
  type AuthorizedHumanMemoryDeviceContentPort,
  type AuthorizedHumanMemoryOpenedV1,
  type AuthorizedHumanMemoryReadResultV1,
  type AuthorizedHumanMemoryTestAuthority,
  type AuthorizedHumanMemoryUnavailableReason,
  type AuthorizedHumanMemoryWriteIntentV1,
} from "./client/memory/authorized-human-memory-client.ts";
export {
  createVaultAuthorizedHumanMemoryDeviceContentPort,
  type VaultHumanMemoryDeviceContentInput,
} from "./client/memory/vault-human-memory-device-content.ts";
export {
  createInvocationBoundProtectedAgentMemoryRepository,
  type AgentMemoryEmbedding,
  type ProtectedAgentMemoryCryptoSessionPort,
  type ProtectedAgentMemoryEmbeddingPort,
  type ProtectedAgentMemoryProductPort,
  type ProtectedMemoryCandidate,
  type ProtectedMemorySaveCandidateSelection,
  type ProtectedMemoryMutationPlan,
  type ProtectedMemoryMutationTarget,
  type ProtectedMemoryReplacementPlan,
  type ProtectedMemorySessionOpenedItem,
} from "./memory/active-memory-composition.ts";
export {
  nautiloActorId,
  nautiloDeviceId,
  nautiloGroupId,
  nautiloNamespaceId,
  nautiloRoomId,
  nautiloUserId,
  productIdIsValid,
} from "./identity/product-ids.ts";
export {
  MEMORY_PAYLOAD_FORMAT_VERSION_V1,
  MEMORY_PAYLOAD_MAX_CONTENT_BYTES_V1,
  MEMORY_PAYLOAD_MAX_TYPE_BYTES_V1,
  MEMORY_PAYLOAD_MAX_WIRE_BYTES_V1,
  decodeMemoryPayloadV1,
  encodeMemoryPayloadV1,
  type MemoryPayloadV1,
} from "./memory/memory-payload-v1.ts";
export {
  commitMemoryMutationV1,
  type MemoryMutationCommitmentInput,
} from "./memory/memory-mutation-commitment.ts";
export type {
  ForegroundMemoryContextItem,
  ForegroundMemoryHistoryResult,
  ForegroundMemoryRepairSelection,
  ForegroundMemoryStructuralSelection,
} from "./memory/foreground-memory-history.ts";
export {
  MAX_HUMAN_MEMORY_REPAIR_ATTESTATION_WIRE_BYTES_V1,
  assertHumanMemoryRepairAttestationV1,
  decodeHumanMemoryRepairAttestationV1,
  encodeHumanMemoryRepairAttestationV1,
  humanMemoryRepairAttestationSigningDigestV1,
  humanMemoryRepairPayloadDigestV1,
  prepareHumanMemoryRepairAttestationV1,
} from "./memory/human-memory-repair-attestation.ts";
export {
  decodeHumanMemoryOrdinaryFallbackRequestV1,
  digestHumanMemoryOrdinaryFallbackRequestV1,
  encodeHumanMemoryOrdinaryFallbackRequestV1,
  prepareHumanMemoryOrdinaryFallbackRequestV1,
  verifyHumanMemoryOrdinaryFallbackRequestV1,
} from "./memory/human-memory-ordinary-fallback-request.ts";
export type {
  AuthenticatedHumanMemoryOrdinaryFallbackRequestV1,
  HumanMemoryOrdinaryFallbackRequestV1,
  HumanMemoryOrdinaryFallbackUnsignedRequestV1,
} from "./memory/human-memory-ordinary-fallback-request.ts";
export type {
  HumanMemoryRepairAttestationUnsignedV1,
  HumanMemoryRepairAttestationV1,
  HumanMemoryRepairDirectionV1,
  HumanMemoryRepairNamespaceAuthorityV1,
} from "./memory/human-memory-repair-attestation.ts";
export {
  prepareAgentMemoryCryptoRevision,
  type PrepareAgentMemoryCryptoRevisionInput,
} from "./memory/agent-memory-crypto.ts";
export {
  prepareDeviceWrappedAgentObject,
  type DeviceWrappedAgentObjectNamespaceMaterial,
  type PreparedDeviceWrappedAgentObject,
} from "./object/device-wrapped-agent-object-crypto.ts";
export type {
  ForegroundAgentEntityCryptoInvocation,
  ForegroundAgentEntityCryptoOperation,
  ForegroundAgentEntityCryptoResult,
  ForegroundAgentEntityNamespaceAuthority,
} from "./object/foreground-agent-entity-crypto.ts";
export {
  createForegroundAgentObjectRepairer,
  type ForegroundAgentObjectRepairResult,
  type ForegroundAgentObjectRepairSource,
  type VerifiedForegroundAgentObject,
} from "./object/foreground-agent-object-repair.ts";
export type {
  ForegroundRecordContextItem,
  ForegroundRecordHistoryResult,
  ForegroundRecordRepairSelection,
  ForegroundRecordSourceSelection,
  ForegroundRecordStructuralSelection,
} from "./object/foreground-record-history.ts";
export {
  createProtectedAgentMemorySessionContentPort,
  type ProtectedAgentMemoryAuthorizeCommitInput,
  type ProtectedAgentMemoryOpenManyInput,
  type ProtectedAgentMemoryPrepareInput,
  type ProtectedAgentMemorySessionContentPort,
  type ProtectedAgentMemorySessionContentResult,
  type ProtectedAgentMemorySessionContentUnavailableReason,
  type VerifiedAgentMemoryCryptoRevisionContent,
  type VerifiedAgentMemoryCryptoRevisionReader,
  type VerifiedAgentMemoryNamespaceEnvelope,
} from "./memory/agent-memory-session-content.ts";
export {
  agentMemoryExactAccessRequestDigest,
  foregroundAgentMemoryNativeExactAccessDigest,
  createProtectedAgentMemoryExactAccessContentPort,
  readPreparedAgentMemoryExactAccessSnapshot,
  type AgentMemoryExactAccessBindingFact,
  type ForegroundAgentMemoryNativeExactAccessPublication,
  type ForegroundAgentMemoryNativeExactAccessPlan,
  type AgentMemoryExactAccessCryptoCompletionPort,
  type AgentMemoryExactAccessCryptoObservation,
  type AgentMemoryExactAccessCryptoReceipt,
  type AgentMemoryExactAccessPlan,
  type PreparedAgentMemoryExactAccess,
  type ProtectedAgentMemoryExactAccessContentPort,
} from "./memory/agent-memory-exact-access.ts";
export type {
  ProtectedAgentBackgroundMemoryRevisionReader,
  ProtectedAgentBackgroundMemoryRevisionReference,
  ProtectedAgentBackgroundMessageRevisionReader,
  ProtectedAgentBackgroundMessageRevisionReference,
  ProtectedAgentBackgroundProductAuthority,
  VerifiedAgentBackgroundMessageRevisionContent,
} from "./memory/agent-background-revision-reader.ts";
export {
  createProtectedAgentBackgroundMemoryWorkPort,
  type ProtectedAgentBackgroundMemoryProductPort,
  type ProtectedAgentBackgroundMemoryPublicationOutcome,
  type ProtectedAgentBackgroundMemoryWorkInput,
  type ProtectedAgentBackgroundMemoryWorkOutput,
  type ProtectedAgentBackgroundMemoryWorkPort,
  type ProtectedAgentBackgroundMemoryWorkResult,
} from "./memory/agent-background-memory-work.ts";
export {
  readPreparedMemoryCryptoRevisionSnapshot,
  type MemoryCryptoRevisionSnapshot,
} from "./memory/memory-prepared-revision.ts";
export {
  MemoryAuthorityResolutionError,
  resolveRequiredMemoryNamespaceIds,
  type ResolveRequiredMemoryNamespaceIdsInput,
} from "./memory/required-namespace-set.ts";
export {
  MEMORY_OBJECT_ID_VERSION,
  MEMORY_OBJECT_TYPE,
  MEMORY_PAYLOAD_VERSION,
  MEMORY_RECONCILE_MAX_ATTEMPTS,
  MEMORY_RECONCILE_MAX_BATCH,
  assertMemoryRevisionLifecycle,
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type AtomicMemoryCryptoCompletionPort,
  type MemoryCompletionResult,
  type MemoryCryptoRevisionReference,
  type MemoryFailureCode,
  type MemoryProductMapping,
  type MemoryProductMappingCasResult,
  type MemoryProductStorePort,
  type MemoryReconciliationOutcome,
  type MemoryRepository,
  type MemoryRevisionDisposition,
  type MemoryRevisionLifecycle,
  type MemoryRevisionState,
  type PreparedMemoryCryptoRevision,
  type VerifiedMemoryCryptoRevision,
} from "./memory/memory-repository.ts";
export {
  createDormantMemoryShadowRepository,
} from "./memory/memory-shadow-saga.ts";
export {
  MEMORY_CONTENT_EMBEDDING_MAX_BYTES,
  MEMORY_EMBEDDING_DIMENSIONS,
  MEMORY_FOREGROUND_PROCESSOR_CONTRACT_VERSION,
  MEMORY_FOREGROUND_PROCESSOR_MAX_DEADLINE_MS,
  MEMORY_QUERY_EMBEDDING_MAX_BYTES,
  MemoryForegroundProcessorValidationError,
  createMemoryForegroundEmbeddingProcessor,
  validateMemoryForegroundEmbeddingRequest,
} from "./memory/foreground-embedding-processor.ts";
export type {
  MemoryEmbeddingProviderPort,
  MemoryEmbeddingPurpose,
  MemoryForegroundEmbeddingProcessor,
  MemoryForegroundEmbeddingRequest,
  MemoryForegroundEmbeddingResult,
  MemoryForegroundEmbeddingUnavailableReason,
  MemoryForegroundProcessorRateLimitPort,
} from "./memory/foreground-embedding-processor.ts";
export {
  MESSAGE_PAYLOAD_FORMAT_VERSION_V2,
  MESSAGE_PAYLOAD_MAX_ATTACHMENTS_V2,
  MESSAGE_PAYLOAD_MAX_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_CAPTION_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_JSON_DEPTH_V2,
  MESSAGE_PAYLOAD_MAX_JSON_NODES_V2,
  MESSAGE_PAYLOAD_MAX_METADATA_ENTRIES_V2,
  MESSAGE_PAYLOAD_MAX_METADATA_TEXT_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_MIME_TYPE_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_NAME_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_TEXT_BYTES_V2,
  MESSAGE_PAYLOAD_MAX_TOOL_CALLS_V2,
  decodeMessagePayloadV2,
  encodeMessagePayloadV2,
} from "./message/message-payload-v2.ts";
export type {
  CanonicalJsonArray,
  CanonicalJsonObject,
  CanonicalJsonValue,
  CanonicalToolCallV2,
  EncryptedAttachmentReferenceKindV2,
  EncryptedAttachmentReferenceV2,
  MessagePayloadV2,
  MessageRoleV2,
} from "./message/message-payload-v2.ts";
export {
  ROOM_EVENT_PAYLOAD_FORMAT_VERSION_V1,
  ROOM_EVENT_PAYLOAD_KIND_V1,
  ROOM_EVENT_PAYLOAD_KINDS_V1,
  ROOM_EVENT_PAYLOAD_MAX_SOURCE_MESSAGES_V1,
  ROOM_EVENT_PAYLOAD_MAX_STATEMENT_BYTES_V1,
  ROOM_EVENT_PAYLOAD_MAX_STATEMENT_CODE_POINTS_V1,
  assertRoomEventPayloadBindingV1,
  decodeRoomEventPayloadV1,
  encodeRoomEventPayloadV1,
} from "./journal/room-event-payload-v1.ts";
export type {
  RoomEventPayloadBindingV1,
  RoomEventPayloadKindV1,
  RoomEventPayloadV1,
} from "./journal/room-event-payload-v1.ts";
export {
  ROOM_EVENT_ROLLUP_PAYLOAD_FORMAT_VERSION_V1,
  ROOM_EVENT_ROLLUP_PAYLOAD_KIND_V1,
  ROOM_EVENT_ROLLUP_PAYLOAD_MAX_CONTENT_BYTES_V1,
  ROOM_EVENT_ROLLUP_PAYLOAD_MAX_CONTENT_CODE_POINTS_V1,
  assertRoomEventRollupPayloadBindingV1,
  decodeRoomEventRollupPayloadV1,
  encodeRoomEventRollupPayloadV1,
} from "./journal/room-event-rollup-payload-v1.ts";
export {stenographerOrdinaryOutputFingerprint, type StenographerOrdinaryOutputProvenance} from "./journal/stenographer-ordinary-output-provenance.ts";
export {
  STENOGRAPHER_OUTPUT_REPAIR_PLAN_VERSION,
  decodeStenographerOutputRepairPlan,
  encodeStenographerOutputRepairPlan,
  type StenographerOutputRepairPlan,
} from "./journal/stenographer-output-repair-plan.ts";
export type {
  RoomEventRollupPayloadBindingV1,
  RoomEventRollupPayloadV1,
} from "./journal/room-event-rollup-payload-v1.ts";
export {
  PROTECTED_JOURNAL_MAX_CONTEXT_BYTES,
  PROTECTED_JOURNAL_MAX_EVENTS,
} from "./journal/protected-journal-reader.ts";
export type {
  ProtectedJournalAgentContentOpener,
  ProtectedJournalOpenedRecord,
  ProtectedJournalProductReadAuthorization,
  ProtectedJournalProductReadBatch,
  ProtectedJournalProductReadPort,
  ProtectedJournalProductRecord,
} from "./journal/protected-journal-reader.ts";
export {
  CONVERSATION_DURABLE_KEY_MAX_BYTES,
  CONVERSATION_MESSAGE_OBJECT_TYPE,
  CONVERSATION_MESSAGE_OBJECT_ID_VERSION,
  CONVERSATION_MESSAGE_PAYLOAD_VERSION,
  CONVERSATION_RECONCILE_MAX_ATTEMPTS,
  CONVERSATION_RECONCILE_MAX_BATCH,
  CONVERSATION_RECONCILE_LEASE_SECONDS,
  IMMUTABLE_ROOM_NAMESPACE_INVARIANT,
  assertConversationAuthorRole,
  assertConversationDurableKey,
  assertConversationMessageId,
  assertConversationMessageKeyClass,
  assertConversationNotificationEligibility,
  assertConversationRevision,
  assertConversationSessionId,
  assertConversationSubthreadReplyClassification,
  conversationAppendRequestDigest,
  conversationDeleteRequestDigest,
  conversationEditRequestDigest,
  conversationExistingRepresentationRepairIdentityDigest,
  deriveLiveShadowMessageCryptoObjectIdV1,
  deriveMessageCryptoObjectIdV2,
} from "./message/conversation-repository.ts";
export type {
  AtomicConversationCryptoCompletionPort,
  ConversationAllocatedRevision,
  ConversationEditAllocationResult,
  ConversationAppendInput,
  ConversationAuthorRole,
  LiveShadowMessageObjectCoordinatesV1,
  ConversationCompletionResult,
  ConversationDeleteEffects,
  ConversationExistingRepresentationAllocationResult,
  ConversationExistingRepresentationProductStorePort,
  ConversationFailureCode,
  ConversationMessageKeyClass,
  ConversationNotificationEligibility,
  ConversationParityStatus,
  ConversationProductAppendInput,
  ConversationProductAppendResult,
  ConversationProductDeleteResult,
  ConversationProductEditResult,
  ConversationProductMappingCasResult,
  ConversationProductMessage,
  ConversationProductStorePort,
  ConversationProtectedAgentContentOpener,
  ConversationProtectedAgentObjectOutcome,
  ConversationProtectedAgentReadBatch,
  ConversationProtectedProductReadAuthorization,
  ConversationProtectedProductReadPort,
  ConversationProtectedProductReadRecord,
  ConversationReconciliationOutcome,
  ConversationRepository,
  ConversationRevisionCompletion,
  ConversationRevisionCoordinates,
  ConversationRevisionDisposition,
  ConversationRevisionLifecycle,
  ConversationRevisionState,
  ConversationRepairPublicationEvidence,
  ConversationRepairPublisherKind,
  ConversationTerminalOperationType,
  ConversationSubthreadReplyClassification,
  PreparedConversationCryptoRevision,
  VerifiedConversationCryptoRevision,
} from "./message/conversation-repository.ts";
export {
  createDormantConversationShadowRepository,
} from "./message/conversation-shadow-saga.ts";
export {
  admitHumanExistingMessageRepresentation,
  admitHumanExistingMessageRepresentationReplay,
} from "./message/human-existing-message-representation-admission.ts";
export type {
  AdmittedHumanExistingMessageRepresentation,
  AdmittedHumanExistingMessageRepresentationReplay,
  AdmitHumanExistingMessageRepresentationInput,
  AdmitHumanExistingMessageRepresentationReplayInput,
  HumanExistingMessageRepresentationProductPlan,
} from "./message/human-existing-message-representation-admission.ts";
export {
  prepareHumanExistingMessageRepresentationCryptoRevision,
  prepareHumanPeerLiveShadowCryptoRevision,
} from "./message/human-existing-message-representation-crypto.ts";
export type {
  PrepareHumanExistingMessageRepresentationCryptoRevisionInput,
  PrepareHumanPeerLiveShadowCryptoRevisionInput,
} from "./message/human-existing-message-representation-crypto.ts";
export {
  admitHumanPeerLiveShadowMessage,
  admitHumanPeerLiveShadowMessageExactReplay,
} from
  "./message/human-peer-live-shadow-message-admission.ts";
export type {
  AdmittedHumanPeerLiveShadowMessage,
  AdmitHumanPeerLiveShadowMessageInput,
  AdmitHumanPeerLiveShadowMessageExactReplayInput,
} from "./message/human-peer-live-shadow-message-admission.ts";
export {
  admitSharedAgentLiveShadowMessage,
  admitSharedAgentLiveShadowMessageExactReplay,
} from "./message/shared-agent-live-shadow-message-admission.ts";
export type {
  AdmittedSharedAgentLiveShadowMessage,
  AdmitSharedAgentLiveShadowMessageInput,
  AdmitSharedAgentLiveShadowMessageExactReplayInput,
} from "./message/shared-agent-live-shadow-message-admission.ts";
export {
  admitHumanAiReadableLiveShadowMessage,
  admitHumanAiReadableLiveShadowMessageExactReplay,
} from "./message/human-ai-readable-live-shadow-message-admission.ts";
export type {
  AdmittedHumanAiReadableLiveShadowMessage,
  AdmitHumanAiReadableLiveShadowMessageInput,
  AdmitHumanAiReadableLiveShadowMessageExactReplayInput,
} from "./message/human-ai-readable-live-shadow-message-admission.ts";
export {
  createPreparedConversationCryptoRevision,
  readPreparedConversationCryptoRevision,
} from "./message/conversation-prepared-revision.ts";
export type {
  ConversationCryptoRevisionSnapshot,
} from "./message/conversation-prepared-revision.ts";
export {
  createProtectedAgentConversationSessionCryptoPreparer,
} from "./message/protected-agent-conversation-preparer.ts";
export type {
  ProtectedAgentConversationPreparationInput,
  ProtectedAgentConversationPreparationResult,
  ProtectedAgentConversationPreparationUnavailableReason,
  ProtectedAgentConversationSessionCryptoPreparer,
} from "./message/protected-agent-conversation-preparer.ts";
export type {
  NautiloActorId,
  NautiloDeviceId,
  NautiloGroupId,
  NautiloNamespaceId,
  NautiloProductId,
  NautiloRoomId,
  NautiloUserId,
  TranslationFailure,
  TranslationFailureCode,
  TranslationResult,
} from "./identity/product-ids.ts";
export {
  authenticateForegroundRuntimeRecipientKeyPair,
  authenticateProtectedInvocationRecipientKeyPair,
  createProtectedInvocationRecipient,
  createProtectedInvocationCapability,
  destroyProtectedInvocationCapability,
  destroyProtectedInvocationRecipient,
  executeProtectedGrantCapabilityOperation,
  executeProtectedGrantAuthoritySetCapabilityOperationV2,
  executeProtectedGrantSessionAuthoritySetCapabilityOperationV2,
  executeProtectedGrantSessionCapabilityOperation,
  executeProtectedGrantOperation,
  inspectProtectedInvocationCapability,
} from "./invocation/protected-grant-invocation.ts";
export type {
  EphemeralForegroundRecipient,
  ForegroundRuntimeRecipient,
  ProtectedGrantAuthorityPort,
  ProtectedGrantAuthoritySetFactsV2,
  ProtectedGrantAuthoritySetPortV2,
  ProtectedGrantOperation,
  ProtectedGrantOperationFacts,
  ProtectedGrantOperationResult,
  ProtectedGrantUnavailableReason,
  ProtectedInvocationCapability,
  ProtectedInvocationCapabilityDescription,
  ProtectedInvocationCoordinates,
  ProtectedInvocationLease,
  ProtectedInvocationRecipient,
} from "./invocation/protected-grant-invocation.ts";
export {
  ProtectedCheckpointCryptoError,
  createProtectedCheckpointCellCrypto,
  createProtectedCheckpointNamespaceSessionContentExecutor,
} from "./checkpoint/protected-checkpoint-cell-crypto.ts";
export type {
  ProtectedCheckpointAuthorizationOperation,
  ProtectedCheckpointAuthorizedOperationContext,
  ProtectedCheckpointCellAuthorityPort,
  ProtectedCheckpointCellCoordinate,
  ProtectedCheckpointCellCrypto,
  ProtectedCheckpointCryptoErrorCode,
  ProtectedCheckpointInvocationScope,
  ProtectedCheckpointNamespaceContentResult,
  ProtectedCheckpointNamespaceMaterial,
  ProtectedCheckpointNamespaceOperationContext,
  ProtectedCheckpointNamespaceSessionContentExecutor,
} from "./checkpoint/protected-checkpoint-cell-crypto.ts";
export {
  PROTECTED_AGENT_RUNTIME_FOREGROUND_ENTRYPOINT_IDS,
  createProtectedAgentRuntimeContentExecutor,
  createProtectedAgentRuntimeSessionContentExecutor,
  executeProtectedAgentRuntimeCapabilityOperation,
  executeProtectedAgentRuntimeSessionCapabilityOperation,
  withProtectedAgentRuntimeConfiguration,
  withProtectedAgentRuntimeGeneration,
} from "./invocation/protected-agent-runtime.ts";
export type {
  ProtectedAgentRuntimeForegroundEntrypointId,
  ProtectedAgentRuntimeSessionContentExecutor,
} from "./invocation/protected-agent-runtime.ts";
export {
  planAgentRuntimeAuthorizationGraphTransition,
} from "./invocation/agent-runtime-authorization-graph.ts";
export {
  coordinateProtectedAgentRuntimeRotation,
  createProtectedAgentRuntimeRotationSourcePort,
  createProtectedAgentRuntimeRotationTargetPort,
} from "./invocation/protected-agent-runtime-rotation.ts";
export {
  coordinateProtectedAgentRuntimeAuthorizationTransition,
  createProtectedAgentRuntimeAuthorizationTransitionSourcePort,
} from "./invocation/protected-agent-runtime-authorization-transition.ts";
export type {
  ProtectedAgentRuntimeAuthorizationTransitionResult,
  ProtectedAgentRuntimeAuthorizationTransitionSourcePort,
} from "./invocation/protected-agent-runtime-authorization-transition.ts";
export type {
  ProtectedAgentRuntimeRotationResult,
  ProtectedAgentRuntimeRotationSourcePort,
  ProtectedAgentRuntimeRotationTargetPort,
} from "./invocation/protected-agent-runtime-rotation.ts";
export type {
  AgentRuntimeAuthorizationDomainAuthority,
  AgentRuntimeAuthorizationGraphPlan,
  AgentRuntimeAuthorizationGraphSnapshot,
  AgentRuntimeAuthorizationGraphTransition,
  AgentRuntimeAuthorizationNamespaceEdge,
} from "./invocation/agent-runtime-authorization-graph.ts";
export type {
  ProtectedAgentRuntimeCapabilityResult,
  ProtectedAgentRuntimeCapabilityUnavailableReason,
  ProtectedAgentRuntimeContentExecutor,
  ProtectedAgentRuntimeResult,
  ProtectedAgentRuntimeUnavailableReason,
} from "./invocation/protected-agent-runtime.ts";
export {
  exactHumanSetsMatch,
  translateHumanParticipant,
  translateParticipants,
} from "./identity/participants.ts";
export type {
  AgentActorFact,
  CosmosIdentityFact,
  DeviceIdentityFact,
  ExactHumanSet,
  GroupIdentityFact,
  HumanActorFact,
  NamespaceIdentityFact,
  ProductParticipantFact,
  RoomIdentityFact,
  UserIdentityFact,
} from "./identity/participants.ts";
export {
  translateNamespaceDomainCoordinates,
  translateNamespaceId,
} from "./identity/namespace-domain.ts";
export type {
  NamespaceCryptoDomainReference,
  NamespaceDomainCoordinates,
  NamespaceDomainTranslationInput,
} from "./identity/namespace-domain.ts";
export {
  RECOVERY_KIT_DOCUMENT_HEADER,
  RECOVERY_KIT_ENTROPY_BYTES,
  RECOVERY_KIT_FORMAT_VERSION,
  RECOVERY_KIT_WORDS,
  RecoveryKitFormatError,
  createRecoveryMnemonicCredential,
  decodeRecoveryMnemonic,
  deriveRecoveryCredentialFromMnemonic,
  encodeRecoveryMnemonic,
} from "./recovery/recovery-kit.ts";
export type {
  OpenedRecoveryCredential,
  RecoveryKitFormatErrorCode,
  RecoveryMnemonicCredential,
} from "./recovery/recovery-kit.ts";
export {
  InitialDeviceRecoveryCeremonyError,
  prepareInitialDeviceBootstrapRequest,
} from "./device/initial-bootstrap-ceremony.ts";
export type {
  InitialDeviceRecoveryCeremonyErrorCode,
  InitialDeviceRecoveryKitPresentation,
  InitialDeviceRecoveryKitPresentationResult,
  PresentInitialDeviceRecoveryKit,
} from "./device/initial-bootstrap-ceremony.ts";
export {
  InitialDeviceClientCeremonyError,
  resumeInitialDeviceClientCeremony,
  runInitialDeviceClientCeremony,
} from "./device/initial-bootstrap-client-ceremony.ts";
export type {
  InitialDeviceBootstrapClientPort,
  InitialDeviceClientCeremonyErrorCode,
} from "./device/initial-bootstrap-client-ceremony.ts";
export {
  CLIENT_PROFILE_VAULT_FORMAT_VERSION,
  CLIENT_PROFILE_VAULT_MAX_BYTES,
  CLIENT_PROFILE_VAULT_MAX_PROFILES,
} from "./client-vault/types.ts";
export {
  INITIAL_DEVICE_BOOTSTRAP_CHALLENGE_BYTES,
  INITIAL_DEVICE_BOOTSTRAP_FORMAT_VERSION,
  INITIAL_DEVICE_BOOTSTRAP_TTL_MS,
  assertInitialDeviceBootstrapChallenge,
  createInitialDeviceBootstrapProof,
  initialDeviceBootstrapAuditRef,
  initialDeviceBootstrapAuthorizationDigest,
  initialDeviceBootstrapSigningBytes,
} from "./device/initial-bootstrap.ts";
export {
  ADDITIONAL_DEVICE_CHALLENGE_TTL_MS,
  ADDITIONAL_DEVICE_ENROLLMENT_FORMAT_VERSION,
  MAX_ACTIVE_CRYPTO_DEVICES_PER_HUMAN,
  MAX_ADDITIONAL_DEVICE_INVENTORY_RECORDS,
  MAX_PENDING_CRYPTO_DEVICES_PER_HUMAN,
  additionalDeviceAuthorizationDigest,
  assertBeginAdditionalDeviceEnrollment,
  assertPendingAdditionalDeviceEnrollment,
} from "./device/additional-device-enrollment.ts";
export {
  DEVICE_ADMISSION_CHALLENGE_TTL_MS,
  DEVICE_ADMISSION_FORMAT_VERSION,
  DEVICE_ADMISSION_NONCE_BYTES,
  assertDeviceAdmissionChallenge,
  createDeviceAdmissionProof,
  deviceAdmissionChallengeFromDto,
  deviceAdmissionProofToDto,
  deviceAdmissionSigningBytes,
  verifyDeviceAdmissionProof,
} from "./device/device-admission.ts";
export type {
  DeviceAdmissionChallenge,
  DeviceAdmissionProof,
} from "./device/device-admission.ts";
export type {
  BeginAdditionalDeviceEnrollment,
  PendingAdditionalDeviceEnrollment,
} from "./device/additional-device-enrollment.ts";
export {
  OPAQUE_DELIVERY_ARTIFACT_FORMAT_VERSION,
  OPAQUE_DELIVERY_ARTIFACT_MAX_BYTES,
  OPAQUE_DELIVERY_ARTIFACT_MAX_CHUNKS,
  OPAQUE_DELIVERY_CHUNK_PAYLOAD_BYTES,
  OPAQUE_DELIVERY_ROW_MAX_BYTES,
  chunkOpaqueDeliveryArtifact,
  decodeOpaqueDeliveryArtifactChunk,
  reassembleOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "./delivery/opaque-artifact.ts";
export type {
  OpaqueDeliveryArtifactChunk,
  OpaqueDeliveryArtifactKind,
} from "./delivery/opaque-artifact.ts";
export {
  MAX_ACTIVE_DOMAINS_PER_DEVICE,
  MAX_FANOUT_PAYLOAD_BYTES,
  MAX_FANOUT_ROWS_PER_OPERATION,
  MAX_NAMESPACES_PER_DOMAIN_TRANSITION,
  assertDeviceFanoutPlan,
  createDeviceFanoutProgress,
  deriveDeviceFanoutOperationState,
  evaluateDeviceActivationGate,
} from "./delivery/device-fanout.ts";
export type {
  DeviceActivationGate,
  DeviceFanoutDomainPlan,
  DeviceFanoutDomainProgress,
  DeviceFanoutDomainState,
  DeviceFanoutMethod,
  DeviceFanoutNamespacePlan,
  DeviceFanoutNamespaceState,
  DeviceFanoutOperationState,
  DeviceFanoutPlan,
  DeviceFanoutProgress,
} from "./delivery/device-fanout.ts";
export {
  DEVICE_FANOUT_DELIVERY_TTL_MS,
  DEVICE_FANOUT_OUTBOX_MAX_BYTES,
  createDeviceFanoutAdmission,
} from "./delivery/device-fanout-admission.ts";
export {
  assertVerifiedHumanMembershipTransition,
  createHumanMembershipTransition,
} from "./delivery/human-membership-transition.ts";
export type {
  HumanMembershipTransition,
  HumanMembershipTransitionKind,
  HumanMembershipTargetRoomRole,
} from "./delivery/human-membership-transition.ts";
export {
  HUMAN_MEMBERSHIP_TARGET_DOMAIN_FORMAT_VERSION,
  HUMAN_MEMBERSHIP_TARGET_DOMAIN_MAX_DEVICES,
  createHumanMembershipTargetDomainSubmission,
  humanMembershipTargetDomainChainDigest,
  humanMembershipTargetDomainSigningBytes,
  verifyHumanMembershipTargetDomainSubmission,
} from "./delivery/human-membership-target-domain.ts";
export type {
  HumanMembershipTargetDomainAddition,
  HumanMembershipTargetDomainExpectedDevice,
  HumanMembershipTargetDomainSubmission,
  VerifiedHumanMembershipTargetDomain,
} from "./delivery/human-membership-target-domain.ts";
export {
  HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_FORMAT_VERSION,
  HUMAN_MEMBERSHIP_TARGET_DOMAIN_DELIVERY_TTL_MS,
  createHumanMembershipTargetDomainDelivery,
  decodeHumanMembershipTargetDomainDeliveryArtifact,
  serializeHumanMembershipTargetDomainDeliveryArtifact,
} from "./delivery/human-membership-target-domain-delivery.ts";
export type {
  HumanMembershipTargetDomainDeliveryArtifact,
  HumanMembershipTargetDomainDeliveryMessage,
} from "./delivery/human-membership-target-domain-delivery.ts";
export type {
  DeviceFanoutAdmission,
  DeviceFanoutAdmissionOutbox,
  DeviceFanoutDeliveryMessage,
} from "./delivery/device-fanout-admission.ts";
export {
  DEVICE_JOIN_PACKAGE_FORMAT_VERSION,
  DEVICE_JOIN_PACKAGE_MAX_BYTES,
  DEVICE_JOIN_PACKAGE_TTL_MS,
  createDeviceJoinPackage,
  deviceJoinPackageSigningBytes,
  verifyDeviceJoinPackage,
} from "./delivery/device-join-package.ts";
export type {
  DeviceJoinPackageEnvelope,
  DeviceJoinRequestPublic,
  ResolveJoinPackageDevice,
  ResolveJoinPackageProviderHead,
  VerifiedDeviceJoinPackage,
} from "./delivery/device-join-package.ts";
export {
  DELIVERY_ACKNOWLEDGEMENT_FORMAT_VERSION,
  createDeliveryAcknowledgementProof,
  deliveryAcknowledgementSigningBytes,
  verifyDeliveryAcknowledgementProof,
} from "./delivery/delivery-acknowledgement.ts";
export type {
  DeliveryAcknowledgementProof,
  DeliveryMessageReceiptTarget,
  ResolveAcknowledgingDevice,
  VerifiedDeliveryAcknowledgement,
} from "./delivery/delivery-acknowledgement.ts";
export {
  assertDeviceDeliveryFetchProof,
  createDeviceDeliveryFetchProof,
  DEVICE_DELIVERY_FETCH_FORMAT_VERSION,
  DEVICE_DELIVERY_FETCH_MAX_MESSAGES,
  DEVICE_DELIVERY_FETCH_MAX_PAYLOAD_BYTES,
  DEVICE_DELIVERY_FETCH_MIN_PAYLOAD_BYTES,
  DEVICE_DELIVERY_FETCH_PROOF_TTL_MS,
  deviceDeliveryFetchSigningBytes,
} from "./delivery/device-delivery-fetch.ts";
export type {
  DeviceDeliveryFetchProof,
} from "./delivery/device-delivery-fetch.ts";
export {
  DOMAIN_TRANSITION_DELIVERY_FORMAT_VERSION,
  DOMAIN_TRANSITION_DELIVERY_MAX_BYTES,
  DOMAIN_TRANSITION_DELIVERY_TTL_MS,
  createDomainTransitionDelivery,
  decodeDomainTransitionDeliveryArtifact,
  serializeDomainTransitionDeliveryArtifact,
} from "./delivery/domain-transition-delivery.ts";
export type {
  DomainTransitionDelivery,
  DomainTransitionDeliveryArtifact,
  DomainTransitionDeliveryMessage,
} from "./delivery/domain-transition-delivery.ts";
export {
  PROVIDER_TRANSITION_SUBMISSION_MAX_BYTES,
  PROVIDER_TRANSITION_SUBMISSION_FORMAT_VERSION,
  createProviderTransitionSubmission,
  decodeProviderTransitionSubmission,
  providerTransitionSubmissionSigningBytes,
  serializeProviderTransitionSubmission,
  verifyProviderTransitionSubmission,
} from "./delivery/provider-transition-submission.ts";
export type {
  ProviderTransitionCurrentState,
  ProviderTransitionExpectation,
  ProviderTransitionSubmission,
  ResolveActiveTransitionCommitter,
  VerifiedProviderTransitionSubmission,
} from "./delivery/provider-transition-submission.ts";
export {
  NAMESPACE_TRANSITION_SUBMISSION_FORMAT_VERSION,
  NAMESPACE_TRANSITION_SUBMISSION_MAX_BYTES,
  createNamespaceTransitionSubmission,
  decodeNamespaceTransitionSubmission,
  namespaceTransitionCandidatesDigest,
  namespaceTransitionSubmissionSigningBytes,
  serializeNamespaceTransitionSubmission,
  verifyNamespaceTransitionSubmission,
} from "./delivery/namespace-transition-submission.ts";
export type {
  NamespaceTransitionCandidate,
  NamespaceTransitionExpectedHead,
  NamespaceTransitionSubmission,
  VerifiedNamespaceTransitionSubmission,
} from "./delivery/namespace-transition-submission.ts";
export {
  HUMAN_MEMBERSHIP_REBIND_SUBMISSION_FORMAT_VERSION,
  HUMAN_MEMBERSHIP_REBIND_SUBMISSION_MAX_BYTES,
  assertCanonicalHumanMembershipRebindSubmission,
  createHumanMembershipRebindSubmission,
  decodeHumanMembershipRebindSubmission,
  humanMembershipRebindCandidateDigest,
  humanMembershipRebindSubmissionSigningBytes,
  assertVerifiedHumanMembershipRebindSubmission,
  serializeHumanMembershipRebindSubmission,
  verifyHumanMembershipRebindSubmission,
} from "./delivery/human-membership-rebind-submission.ts";
export type {
  HumanMembershipRebindCandidate,
  HumanMembershipRebindCommitter,
  HumanMembershipRebindCommitterContext,
  HumanMembershipRebindExpectedHead,
  HumanMembershipRebindKind,
  HumanMembershipRebindSubmission,
  ResolveHumanMembershipRebindCommitter,
  VerifiedHumanMembershipRebindSubmission,
  VerifyHumanMembershipRebindExpected,
} from "./delivery/human-membership-rebind-submission.ts";
export {
  HUMAN_MEMBERSHIP_REBIND_DELIVERY_TTL_MS,
  createHumanMembershipRebindDelivery,
} from "./delivery/human-membership-rebind-delivery.ts";
export type {
  HumanMembershipRebindDelivery,
  HumanMembershipRebindDeliveryMessage,
} from "./delivery/human-membership-rebind-delivery.ts";
export {
  RECOVERY_ROTATION_SUBMISSION_FORMAT_VERSION,
  createRecoveryRotationSubmission,
  normalizeRecoveryRotationSubmission,
  recoveryRotationSubmissionSigningBytes,
  verifyRecoveryRotationSubmission,
} from "./recovery/recovery-rotation.ts";
export type {
  RecoveryRotationSubmission,
  ResolveActiveRecoveryRotationIssuer,
  VerifiedRecoveryRotationSubmission,
} from "./recovery/recovery-rotation.ts";
export {
  DELIVERY_LEASE_HEARTBEAT_MS,
  DELIVERY_LEASE_TTL_MS,
  DELIVERY_MAXIMUM_ATTEMPTS,
  DELIVERY_RETRY_BASE_MS,
  DELIVERY_RETRY_CAP_MS,
  claimDeliveryWorkLease,
  deliveryRetryAtMs,
  deliveryRetryDelayMs,
  failDeliveryWorkLease,
  heartbeatDeliveryWorkLease,
} from "./delivery/delivery-work-lease.ts";
export type {
  DeliveryWorkLease,
  DeliveryWorkState,
} from "./delivery/delivery-work-lease.ts";
export {
  ADDITIONAL_DEVICE_APPROVAL_MANIFEST_FORMAT_VERSION,
  additionalDeviceApprovalManifestSigningBytes,
  createAdditionalDeviceApprovalManifest,
  verifyAdditionalDeviceApproval,
} from "./device/additional-device-approval.ts";
export type {
  AdditionalDeviceApprovalManifest,
  ResolveActiveApprovingDevice,
  VerifiedAdditionalDeviceApproval,
} from "./device/additional-device-approval.ts";
export {
  BACKGROUND_AUTHORIZATION_DEVICE_CREDENTIAL_TTL_MS,
  BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_CIPHERTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_INPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_OUTPUT_OBJECTS,
  BACKGROUND_AUTHORIZATION_DEVICE_MAX_PLAINTEXT_BYTES,
  BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION,
  BackgroundAuthorizationDeviceResponderError,
  fulfillProcessorBackgroundAuthorizationRequest,
} from "./device/background-authorization-responder.ts";
export type {
  BackgroundAuthorizationDeviceAuthority,
  BackgroundAuthorizationDeviceAuthorityContext,
  BackgroundAuthorizationDeviceFulfillment,
  BackgroundAuthorizationDeviceRequest,
  BackgroundAuthorizationDeviceResponderErrorCode,
  ResolveCurrentBackgroundAuthorizationDeviceAuthority,
} from "./device/background-authorization-responder.ts";
export {
  fulfillAgentBackgroundAuthorizationRequest,
} from "./device/agent-background-authorization-responder.ts";
export type {
  AgentBackgroundAuthorizationDeviceAuthority,
  AgentBackgroundAuthorizationDeviceAuthorityContext,
  AgentBackgroundAuthorizationDeviceFulfillment,
  ResolveCurrentAgentBackgroundAuthorizationDeviceAuthority,
} from "./device/agent-background-authorization-responder.ts";
export {
  AGENT_BACKGROUND_AUTHORIZATION_DEVICE_FULFILLMENT_FORMAT_VERSION_V2,
  AGENT_BACKGROUND_AUTHORIZATION_DEVICE_REQUEST_FORMAT_VERSION_V2,
  fulfillAgentBackgroundAuthorizationRequestV2,
} from "./device/agent-background-authorization-responder-v2.ts";
export type {
  AgentBackgroundAuthorizationDeviceAuthorityContextV2,
  AgentBackgroundAuthorizationDeviceAuthorityV2,
  AgentBackgroundAuthorizationDeviceFulfillmentV2,
  AgentBackgroundAuthorizationDevicePublicAuthorityV2,
  AgentBackgroundAuthorizationDeviceRequestV2,
  AgentBackgroundAuthorizationDomainAuthorityV2,
  AgentBackgroundAuthorizationDomainPublicAuthorityV2,
  AgentBackgroundAuthorizationNamespaceAuthorityV2,
  ResolveCurrentAgentBackgroundAuthorizationDeviceAuthorityV2,
} from "./device/agent-background-authorization-responder-v2.ts";
export {
  verifyCurrentAgentBackgroundAuthorizationDeviceResponseV2,
} from "./device/agent-background-authorization-response-verifier-v2.ts";
export type {
  ExpectedAgentBackgroundAuthorizationResponseV2,
  ResolveCurrentAgentBackgroundAuthorizationDevicePublicAuthorityV2,
  VerifiedAgentBackgroundAuthorizationDeviceResponseV2,
  VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInputV2,
} from "./device/agent-background-authorization-response-verifier-v2.ts";
export {
  verifyCurrentBackgroundAuthorizationDeviceResponse,
} from "./device/background-authorization-response-verifier.ts";
export type {
  BackgroundAuthorizationCurrentIssuerContext,
  ExpectedAgentBackgroundAuthorizationResponse,
  ExpectedBackgroundAuthorizationResponse,
  ExpectedBackgroundAuthorizationResponseBase,
  ExpectedProcessorBackgroundAuthorizationResponse,
  ResolveCurrentBackgroundAuthorizationIssuingDevicePublicKey,
  VerifiedAgentBackgroundAuthorizationDeviceResponse,
  VerifiedBackgroundAuthorizationDeviceResponse,
  VerifiedBackgroundAuthorizationDeviceResponseBase,
  VerifiedProcessorBackgroundAuthorizationDeviceResponse,
  VerifiedProcessorSignerAuthorizationEvidence,
  VerifyCurrentAgentBackgroundAuthorizationDeviceResponseInput,
  VerifyCurrentBackgroundAuthorizationDeviceResponseInput,
  VerifyCurrentProcessorBackgroundAuthorizationDeviceResponseInput,
} from "./device/background-authorization-response-verifier.ts";
export {
  DEVICE_REVOCATION_MANIFEST_FORMAT_VERSION,
  createDeviceRevocationManifest,
  deviceRevocationManifestSigningBytes,
  verifyDeviceRevocationManifest,
} from "./device/device-revocation.ts";
export type {
  DeviceRevocationDomainHead,
  DeviceRevocationManifest,
  DeviceRevocationManifestUnsigned,
  DeviceRevocationNamespaceHead,
  DeviceRevocationRegistryDevice,
  DeviceRevocationRegistryState,
  ResolveDeviceRevocationDevice,
  VerifiedDeviceRevocationManifest,
} from "./device/device-revocation.ts";
export type {
  BeginInitialDeviceBootstrap,
  InitialDeviceBootstrapChallenge,
  InitialDeviceBootstrapCompletion,
  InitialDeviceBootstrapContext,
  InitialDeviceBootstrapReceipt,
  InitialDeviceBootstrapReceiptQuery,
} from "./device/initial-bootstrap.ts";
export type {
  ClientProfileCoordinates,
  ClientProfilePublicState,
  ClientProfileVaultAvailability,
  ClientProfileVaultStatus,
  CryptoClientKind,
  PublicClientProfile,
} from "./client-vault/types.ts";
export {
  CLIENT_DEVICE_PROFILE_MAX_BYTES,
  CLIENT_DEVICE_PROFILE_MAX_GENERATIONS,
  CLIENT_DEVICE_PROFILE_MAX_KEYRINGS,
  CLIENT_DEVICE_PROFILE_V1_DOMAIN,
  CLIENT_DEVICE_PROFILE_V2_DOMAIN,
  authenticateClientDeviceProfile,
  createClientDeviceProfileV2Candidate,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV1,
  encodeClientDeviceProfileV2,
  replaceClientDeviceProfileWithV2,
  type ClientNamespaceKeyClass,
  type OpenedClientDeviceProfile,
  type OpenedClientDeviceProfileV1,
  type OpenedClientDeviceProfileV2,
  type RetainedClientNamespaceKeyringV2,
} from "./client-vault/profile-v2.ts";
export {
  CLIENT_DEVICE_PROFILE_MAX_PROVIDER_SNAPSHOTS,
  CLIENT_DEVICE_PROFILE_MAX_OBJECT_ACCESS_ANCHORS,
  CLIENT_DEVICE_PROFILE_V3_DOMAIN,
  addClientDomainProviderSnapshot,
  authenticateClientDeviceProfileV3,
  createClientDeviceProfileV3Candidate,
  createClientProfileObjectAccessAnchorPort,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
  replaceClientDeviceProfileWithV3,
  stageAndActivateClientDomainProviderSnapshot,
  stageAndActivateClientDeviceProfileV3,
  updateClientDeviceProfileV3,
  withClientDomainRoots,
  type ClientDomainProviderSnapshotV3,
  type OpenedClientDeviceProfileV3,
} from "./client-vault/profile-v3.ts";
export {
  CLIENT_DEVICE_PROFILE_MAX_SIGNER_EVIDENCE,
  CLIENT_DEVICE_PROFILE_V4_DOMAIN,
  CLIENT_DEVICE_PROFILE_V4_MAX_BYTES,
  addClientSignerEvidenceV4,
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
  withClientObjectAccessSignerResolversV4,
  type ClientAgentRuntimeSignerEvidenceV4,
  type ClientObjectAccessSignerResolversV4,
  type ClientProcessorSignerEvidenceV4,
  type ClientSignerEvidenceV4,
  type OpenedClientDeviceProfileV4,
} from "./client-vault/profile-v4.ts";
export {
  CLIENT_KEYRING_DELIVERY_MAX_BYTES,
  CLIENT_KEYRING_DELIVERY_MAX_MESSAGES,
  ingestAndReplaceClientKeyringDeliveryHistory,
  ingestClientKeyringDeliveryHistory,
  type ClientKeyringDeliveryMessage,
  type ResolveClientDeviceTransferAuthority,
} from "./delivery/client-keyring-delivery.ts";
export {
  withClientNamespaceKeyring,
  writeClientNamespaceKeyrings,
  type ClientNamespaceKeyringMaterial,
} from "./device/client-namespace-keyring.ts";
export {
  PREPARED_ARTIFACT_CIPHERTEXT_MAX_BYTES,
  assertPreparedArtifactCiphertextSidecarReference,
  createPreparedArtifactMutationJournal,
  type PreparedArtifactCiphertextSidecarPort,
  type PreparedArtifactCiphertextSidecarReference,
} from "./client/artifact/prepared-artifact-ciphertext-sidecar.ts";
export {
  prepareVaultHumanLiveShadowMessageV4,
  type PreparedHumanLiveShadowMessageV1,
  type PrepareVaultHumanLiveShadowMessageInputV1,
  type PrepareVaultHumanLiveShadowMessageInputV4,
  type PrepareVaultHumanLiveShadowMessageResultV1,
} from "./client/message/vault-human-live-shadow-message.ts";
export type {
  NamespaceAuthorityClient,
  NamespaceAuthorityResult,
  NamespaceGenerationAuthority,
  OpenedNamespaceGeneration,
  OpenedRetainedRoomAuthority,
  RetainedRoomAuthorityClient,
  RetainedRoomReadPlan,
} from "./client/message/namespace-authority-client.ts";
export {
  prepareVaultHumanPeerLiveShadowMessage,
  type PreparedHumanPeerLiveShadowMessage,
  type PrepareVaultHumanPeerLiveShadowMessageInput,
  type PrepareVaultHumanPeerLiveShadowMessageResult,
} from "./client/message/vault-human-peer-live-shadow-message.ts";
export {
  prepareVaultSharedAgentLiveShadowMessage,
  type PreparedSharedAgentLiveShadowMessage,
  type PrepareVaultSharedAgentLiveShadowMessageInput,
  type PrepareVaultSharedAgentLiveShadowMessageResult,
} from "./client/message/vault-shared-agent-live-shadow-message.ts";
export {
  prepareVaultHumanAiReadableLiveShadowMessage,
  type PreparedHumanAiReadableLiveShadowMessage,
  type PrepareVaultHumanAiReadableLiveShadowMessageInput,
  type PrepareVaultHumanAiReadableLiveShadowMessageResult,
} from "./client/message/vault-human-ai-readable-live-shadow-message.ts";
export {
  createVaultSharedAgentLiveShadowMessageReceiver,
  type SharedAgentLiveShadowReceiveResult,
  type SharedAgentLiveShadowReceiverApiPort,
  type VaultSharedAgentLiveShadowMessageReceiver,
} from "./client/message/vault-shared-agent-live-shadow-message-receiver.ts";
export {
  createVaultHumanPeerLiveShadowMessageReceiver,
  type HumanPeerLiveShadowReceiveResult,
  type HumanPeerLiveShadowReceiverApiPort,
  type VaultHumanPeerLiveShadowMessageReceiver,
} from "./client/message/vault-human-peer-live-shadow-message-receiver.ts";
export {
  createVaultRoomHistoryShadowMessageReader,
  type ConversationProtectedMessageClientDtoV2,
  type RoomHistoryShadowAuthorityTransportV1,
  type RoomHistoryShadowDomainKeyAuthorityTransportV2,
  type RoomHistoryShadowFallbackReasonV1,
  type RoomHistoryShadowRecordTransportV1,
  type RoomHistoryShadowSignerEvidenceTransportV1,
  type VaultRoomHistoryShadowMessageReader,
  type VaultRoomHistoryShadowReadInputV1,
  type VaultRoomHistoryShadowReadResultV1,
  type VaultRoomHistoryShadowRecordResultV1,
} from "./client/message/vault-room-history-shadow-message-reader.ts";
export {
  encodeLiveShadowDurableEventEvidenceV1,
  liveShadowDurableEventDigestV1,
  type LiveShadowDurableEventEvidenceV1,
  encodeFullEncryptionDurableEventEvidenceV2,
  fullEncryptionDurableEventDigestV2,
  type FullEncryptionDurableEventEvidenceV2,
} from "./message/live-shadow-realtime-evidence.ts";
export {
  createAuthorizedHumanLiveShadowMessageClient,
  type AuthorizedHumanLiveShadowMessageClient,
  type CreateAuthorizedHumanLiveShadowMessageClientInput,
  type HumanLiveShadowMessageApiPort,
} from "./client/message/authorized-human-live-shadow-message-client.ts";
export {
  createVaultHumanArtifactDeviceContentPort,
  type AuthorizedHumanArtifactContentIntentV1,
  type PreparedHumanArtifactContentPublicationV1,
  type VaultHumanArtifactDeviceContentInput,
} from "./client/artifact/vault-human-artifact-device-content.ts";
export {
  AuthorizedHumanArtifactUnavailableError,
  createAuthorizedHumanArtifactClient,
  createAuthorizedHumanArtifactViewerByteSource,
  type AuthorizedHumanArtifactClient,
  type AuthorizedHumanArtifactContentPort,
  type AuthorizedHumanArtifactMutationJournal,
  type AuthorizedHumanArtifactTestAuthority,
  type AuthorizedHumanArtifactViewerByteSourceInput,
} from "./client/artifact/authorized-human-artifact-client.ts";
export {
  inspectPreparedMutationCustodyFacts,
  type PreparedHumanArtifactMutation,
  type PreparedHumanLiveShadowMessageMutation,
  type PreparedHumanMutation,
  type PreparedMutationCustodyFacts,
} from "./client/memory/prepared-mutation-journal.ts";
export {
  ENCRYPTION_TRANSITION_MODES,
  LIVE_SHADOW_ENCRYPTION_TRANSITION_BEHAVIORS,
  selectLiveShadowEncryptionTransitionPolicy,
  selectLiveEncryptionRepresentationPolicy,
  type LiveEncryptionRepresentationPolicy,
  LIVE_SHADOW_SELECTABLE_ENCRYPTION_TRANSITION_MODES,
  type EncryptionTransitionMode,
  type EncryptionTransitionPolicy,
  type LiveShadowEncryptionTransitionPolicy,
  type LiveShadowEncryptionTransitionBehavior,
  type LiveShadowEncryptionTransitionPolicySelectionResult,
  type LiveShadowSelectableEncryptionTransitionMode,
} from "./transition/encryption-transition-policy.ts";
export {
  createShadowTransitionCoordinator,
  type ShadowContentFamily,
  type ShadowTransitionCandidate,
  type ShadowTransitionCoordinator,
  type ShadowTransitionCurrentVerification,
  type ShadowTransitionMappingInvalidation,
  type ShadowTransitionObservation,
  type ShadowTransitionOperation,
  type ShadowTransitionOutcome,
  type ShadowTransitionTask,
  type ShadowTransitionTrigger,
} from "./transition/shadow-transition-coordinator.ts";
export {
  STRICT_SHADOW_STATES,
  STRICT_SHADOW_ACTOR_CLASSES,
  STRICT_SHADOW_REASONS,
  StrictShadowEnforcementError,
  enforceStrictShadowDecision,
  requireStrictShadowConsumer,
  classifyHumanDeviceMembershipState,
  type StrictShadowState,
  type StrictShadowActorClass,
  type StrictShadowReason,
  type StrictShadowBoundaryDecision,
  type StrictShadowEnforcementPolicy,
  type StrictShadowEnforcementResult,
  type HumanDeviceMembershipState,
} from "./transition/strict-shadow-enforcement.ts";
export {
  humanDeviceOrdinaryRepairPayloadDigestV2,
  humanDeviceOrdinaryRepairSigningDigestV2,
  prepareHumanDeviceOrdinaryRepairAttestationV2,
  type HumanDeviceOrdinaryRepairAttestationUnsignedV2,
  type HumanDeviceOrdinaryRepairAttestationV2,
} from "./message/human-device-ordinary-repair-attestation-v2.ts";
export * from "./message/message-backfill-ack.ts";
export * from "./message/message-backfill-state.ts";
export { PROTECTED_TOP_LEVEL_ROOM_KINDS, isProtectedTopLevelRoomKind } from "./message/protected-room-topology.ts";

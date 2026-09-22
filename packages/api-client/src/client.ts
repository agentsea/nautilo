import type { CheckSummary, KeyReport, TransactionDetail } from "@nautilo/config-guard";
import { z } from "zod";
import {
  eventFeedErrorResponseSchema,
  eventFeedListOptionsSchema,
  eventFeedMarkAllReadResultSchema,
  eventFeedPageSchema,
  eventFeedPreferenceSchema,
  eventFeedReadMutationResultSchema,
  eventFeedUnreadCountSchema,
  type EventFeedErrorCode,
  type EventFeedListOptions,
  type EventFeedMarkAllReadResult,
  type EventFeedPage,
  type EventFeedPreference,
  type EventFeedReadMutationResult,
  type EventFeedUnreadCount,
  type LiveDocumentVersion,
} from "@nautilo/types";
import {
  protectedMemoryRepairPlanResponseV1Schema,
  protectedMemoryPreparedRepairRequestV1Schema,
  protectedMemoryRepairResponseV1Schema,
  type ProtectedMemoryRepairPlanResponseV1,
  type ProtectedMemoryPreparedRepairRequestV1,
  type ProtectedMemoryRepairResponseV1,
} from "./schemas/protected-memory-repair";
import {
  memoryProcessorRecipientV1Schema,
  memoryProcessorSealedRequestV1Schema,
  type MemoryProcessorRecipientV1,
  type MemoryProcessorSealedRequestV1,
} from "./schemas/memory-processor-transport";
import {
  memoryAdminStatusSchema,
  memoryRetryResponseSchema,
  type MemoryAdminStatus,
  connectedWebAccountCancelLoginResponseSchema,
  connectedWebAccountCancelReadResponseSchema,
  connectedWebAccountClosePageResponseSchema,
  connectedWebAccountDisconnectResponseSchema,
  connectedWebAccountListResponseSchema,
  connectedWebAccountLoginResponseSchema,
  connectedWebAccountReadActivitySchema,
  connectedWebAccountReadWatchSchema,
  connectedWebAccountActionActivitySchema,
  connectedWebAccountActionWatchSchema,
  connectedWebAccountStopActionResponseSchema,
  connectedWebOperationProjectionSchema,
  connectedWebOperationStopResponseSchema,
  connectedWebOperationWatchSchema,
  connectedWebAccountSchema,
  type ConnectedWebAccount,
  type ConnectedWebAccountCreateRequest,
  type ConnectedWebAccountDisconnectResponse,
  type ConnectedWebAccountListResponse,
  type ConnectedWebAccountLoginResponse,
  type ConnectedWebAccountReadActivity,
  type ConnectedWebAccountReadWatch,
  type ConnectedWebAccountActionActivity,
  type ConnectedWebAccountActionWatch,
  type ConnectedWebOperationProjection,
} from "@nautilo/types";
import {
  setupStatusResponseSchema,
  serverProfileUpdateResponseSchema,
  avatarRefSchema,
  type SetupStatusResponse,
} from "./schemas/setup-status";
import {
  listGroupsResponseSchema,
  listGroupMembersResponseSchema,
  type ListGroupMembersResponse,
  type ListGroupsResponse,
} from "./schemas/groups";
import {
  standingApprovalsListSchema,
  type CommandApprovalRow,
} from "./schemas/standing-approvals";
import {
  skillDeleteResponseSchema,
  skillDetailResponseSchema,
  skillToolOptionsResponseSchema,
  skillsListResponseSchema,
  type SaveSkillRequest,
  type SkillDetail,
  type SkillToolOption,
  type SkillsListResponse,
} from "./schemas/skills";
import {
  accessControlCatalogueSchema,
  accessControlHumanListSchema,
  effectiveAccessResponseSchema,
  type AccessControlCatalogue,
  type AccessControlHumanList,
  type EffectiveAccessResponse,
} from "./schemas/access-control";
import {
  applyResponseSchema,
  previewResponseSchema,
  type AccessControlOperation as AccessControlMutationOperation,
  type ApplyRequestBody,
  type ApplyResponse as ApplyMutationResponse,
  type PreviewRequestBody,
  type PreviewResponse as PreviewMutationResponse,
} from "./schemas/access-control-mutations";
import {
  mediaGenerationStatusDtoV1Schema,
  videoGenerationTakeStatusDtoV1Schema,
  videoGenerationTakeListDtoV1Schema,
  videoGenerationPrepareRequestV1Schema,
  videoGenerationReviewDtoV1Schema,
  videoGenerationSubmitDtoV1Schema,
  videoHostAttestationDtoV1Schema,
  type MediaGenerationStatusDtoV1,
  type VideoGenerationTakeListDtoV1,
  type VideoGenerationTakeStatusDtoV1,
  type VideoGenerationPrepareRequestV1,
  type VideoGenerationReviewDtoV1,
  type VideoGenerationSubmitDtoV1,
  type VideoHostAttestationDtoV1,
} from "./media-generations";
import {
  agentPhotoLibraryCreateResponseSchema,
  agentPhotoLibraryCurrentResponseSchema,
  agentPhotoLibraryEntryLifecycleResponseSchema,
  agentPhotoLibraryEntryResponseSchema,
  agentPhotoLibraryErrorEnvelopeSchema,
  agentPhotoLibraryListResponseSchema,
  agentPhotoLibraryPresetsResponseSchema,
  agentPhotoLibrarySelectionResponseSchema,
  humanEditLeaseStoreResultSchema,
  parseDocumentMutationCommittedEvent,
  registerHumanEditLeaseRequestSchema,
  releaseHumanEditLeaseRequestSchema,
  renewHumanEditLeaseRequestSchema,
  updateHumanEditLeaseRequestSchema,
  createContentReportResponseSchema,
  contentReportListResponseSchema,
  ConnectedAppsResponseSchema,
  ConnectedAppOAuthStartResponseSchema,
  ConnectedAppOAuthAttemptResponseSchema,
  ConnectedAppProviderSetupSchema,
  ConnectedAppDisconnectResponseSchema,
  type ConnectedAppsResponse,
  type ConnectedAppOAuthStartResponse,
  type ConnectedAppOAuthAttemptResponse,
  type ConnectedAppProviderId,
  type ConnectedAppProviderSetup,
  type ConnectedAppProviderSetupRequest,
  type ConnectedAppDisconnectResponse,
} from "@nautilo/types";
import {
  createRemotePairingChallengeResponseSchema,
  consumeRemotePairingChallengeResponseSchema,
  listRemoteControllersResponseSchema,
  listRemoteHostsResponseSchema,
  remoteMutationResponseSchema,
  prepareManualRemotePairingResponseSchema,
  listRemoteHostFilesResponseSchema,
  statRemoteHostFileResponseSchema,
  readRemoteHostFilePreviewResponseSchema,
  selectRemoteHostCurrentFolderResponseSchema,
  type CreateRemotePairingChallengeRequest,
  type CreateRemotePairingChallengeResponse,
  type ConsumeRemotePairingChallengeRequest,
  type ConsumeRemotePairingChallengeResponse,
  type ListRemoteControllersResponse,
  type ListRemoteHostsResponse,
  type RenameRemoteControllerRequest,
  type PrepareManualRemotePairingRequest,
  type PrepareManualRemotePairingResponse,
  type ListRemoteHostFilesRequest,
  type ListRemoteHostFilesResponse,
  type StatRemoteHostFileRequest,
  type StatRemoteHostFileResponse,
  type ReadRemoteHostFilePreviewRequest,
  type ReadRemoteHostFilePreviewResponse,
  type SelectRemoteHostCurrentFolderRequest,
  type SelectRemoteHostCurrentFolderResponse,
} from "./schemas/remote-control";
import {
  mobilePushInstallationBadgePreferenceRequestSchema,
  mobilePushInstallationBadgePreferenceResponseSchema,
  mobilePushInstallationDisableRequestSchema,
  mobilePushInstallationErrorCodeSchema,
  mobilePushInstallationProofRevokeRequestSchema,
  mobilePushInstallationRegisterRequestSchema,
  mobilePushInstallationStatusSchema,
  mobilePushInstallationTestRequestSchema,
  mobilePushInstallationTestResponseSchema,
} from "./schemas/push-notifications";
import {
  encryptionTransitionPolicyStatusSchema,
  encryptionTransitionStatusSchema,
  strictShadowProtectedContentRequiredErrorSchema,
  type EncryptionTransitionPolicyStatus,
  type EncryptionTransitionStatus,
  type EncryptionTransitionUpdateRequest,
  type StrictShadowBoundaryReason,
  type StrictShadowBoundaryState,
} from "./schemas/encryption-transition";
import {
  personalEncryptionCoverageV1Schema,
  type PersonalEncryptionCoverageV1,
} from "./schemas/personal-encryption-coverage";
import {
  deviceAdmissionChallengeResponseSchema,
  deviceAdmissionProofResponseSchema,
  deviceAdmissionStatusSchema,
  type DeviceAdmissionChallengeRequest,
  type DeviceAdmissionChallengeResponse,
  type DeviceAdmissionProofRequest,
  type DeviceAdmissionProofResponse,
  type DeviceAdmissionStatus,
} from "./schemas/device-admission";
import {
  domainKeyAuthorityPlanRequestV2Schema,
  domainKeyAuthorityPlanResponseV2Schema,
  domainKeyAuthorityPublishRequestV2Schema,
  domainKeyAuthorityPublishResponseV2Schema,
  domainKeyEnvelopeAcknowledgeRequestV2Schema,
  domainKeyEnvelopeAcknowledgeResponseV2Schema,
  domainKeyEnvelopeFetchRequestV2Schema,
  domainKeyEnvelopeFetchResponseV2Schema,
  domainKeyPendingRequestListV2Schema,
  domainKeyPendingRequestListResponseV2Schema,
  domainKeyPendingSourceListV2Schema,
  domainKeyPendingSourceListResponseV2Schema,
  domainKeyRecipientFulfilRequestV2Schema,
  domainKeyRecipientFulfilResponseV2Schema,
  domainKeyRecipientRequestV2Schema,
  domainKeyRecipientRequestResponseV2Schema,
  domainNamespaceBundlePlanRequestV2Schema,
  domainNamespaceBundlePlanResponseV2Schema,
  domainNamespaceBundlePublishRequestV2Schema,
  domainNamespaceBundlePublishResponseV2Schema,
  type DomainKeyAuthorityPlanRequestV2,
  type DomainKeyAuthorityPlanResponseV2,
  type DomainKeyAuthorityPublishRequestV2,
  type DomainKeyAuthorityPublishResponseV2,
  type DomainKeyEnvelopeAcknowledgeRequestV2,
  type DomainKeyEnvelopeAcknowledgeResponseV2,
  type DomainKeyEnvelopeFetchRequestV2,
  type DomainKeyEnvelopeFetchResponseV2,
  type DomainKeyPendingRequestListV2,
  type DomainKeyPendingRequestListResponseV2,
  type DomainKeyPendingSourceListV2,
  type DomainKeyPendingSourceListResponseV2,
  type DomainKeyRecipientFulfilRequestV2,
  type DomainKeyRecipientFulfilResponseV2,
  type DomainKeyRecipientRequestV2,
  type DomainKeyRecipientRequestResponseV2,
  type DomainNamespaceBundlePlanRequestV2,
  type DomainNamespaceBundlePlanResponseV2,
  type DomainNamespaceBundlePublishRequestV2,
  type DomainNamespaceBundlePublishResponseV2,
} from "./schemas/domain-key-authority";
import {
  liveShadowMessagePlanRequestSchema,
  liveShadowMessagePlanResponseV1Schema,
  liveShadowMessageClientVerificationRequestV1Schema,
  liveShadowMessageClientVerificationResponseV1Schema,
  liveShadowMessageRecoveryResponseV1Schema,
  liveShadowMessageSendAttemptV1Schema,
  type LiveShadowMessagePlanRequest,
  type LiveShadowMessagePlanResponseV1,
  type LiveShadowMessageSendAttemptV1,
  type LiveShadowMessageClientVerificationRequestV1,
  type LiveShadowMessageClientVerificationResponseV1,
  humanPeerLiveShadowAcknowledgementRequestV1Schema,
  humanPeerLiveShadowAcknowledgementResponseV1Schema,
  type HumanPeerLiveShadowAcknowledgementRequestV1,
  type HumanPeerLiveShadowAcknowledgementResponseV1,
  humanPeerLiveShadowAcknowledgementPlanRequestV1Schema,
  humanPeerLiveShadowAcknowledgementPlanResponseV1Schema,
  type HumanPeerLiveShadowAcknowledgementPlanRequestV1,
  type HumanPeerLiveShadowAcknowledgementPlanResponseV1,
  sharedAgentLiveShadowAcknowledgementRequestV1Schema,
  sharedAgentLiveShadowAcknowledgementResponseV1Schema,
  sharedAgentLiveShadowAcknowledgementPlanRequestV1Schema,
  sharedAgentLiveShadowAcknowledgementPlanResponseV1Schema,
  type SharedAgentLiveShadowAcknowledgementRequestV1,
  type SharedAgentLiveShadowAcknowledgementResponseV1,
  type SharedAgentLiveShadowAcknowledgementPlanRequestV1,
  type SharedAgentLiveShadowAcknowledgementPlanResponseV1,
  sharedAgentOutputReadPlanRequestV1Schema,
  sharedAgentOutputReadPlanResponseV1Schema,
  type SharedAgentOutputReadPlanRequestV1,
  type SharedAgentOutputReadPlanResponseV1,
  sharedAgentExecutionAuthorizationRequestV1Schema,
  sharedAgentExecutionAuthorizationResponseV1Schema,
  type SharedAgentExecutionAuthorizationRequestV1,
  type SharedAgentExecutionAuthorizationResponseV1,
  runtimeInvocationAuthorizationRequestV1Schema,
  runtimeInvocationAuthorizationResponseV1Schema,
  type RuntimeInvocationAuthorizationRequestV1,
  type RuntimeInvocationAuthorizationResponseV1,
  type LiveShadowMessageRecoveryResponseV1,
  humanMessageEditPlanRequestV1Schema,
  humanMessageEditPlanResponseV1Schema,
  humanMessageEditPreparedRequestV1Schema,
  humanMessageEditPreparedResponseV1Schema,
  type HumanMessageEditPlanRequestV1,
  type HumanMessageEditPlanResponseV1,
  type HumanMessageEditPreparedRequestV1,
  type HumanMessageEditPreparedResponseV1,
} from "./schemas/live-shadow-message";
import {
  roomHistoryShadowReadAcknowledgementRequestV1Schema,
  roomHistoryShadowReadAcknowledgementResponseV1Schema,
  roomHistoryShadowReadIntentV1Schema,
  roomMessageShadowReadRequestV1Schema,
  roomHistoryShadowReadResponseV1Schema,
  type RoomHistoryShadowReadAcknowledgementRequestV1,
  type RoomHistoryShadowReadAcknowledgementResponseV1,
  type RoomHistoryShadowReadIntentV1,
  type RoomMessageShadowReadRequestV1,
  type RoomHistoryShadowReadResponseV1,
} from "./schemas/room-history-shadow-read";
import {
  messageBackfillAckRequestSchema,
  messageBackfillAckResponseSchema,
  messageBackfillClaimRequestSchema,
  messageBackfillNextRequestSchema,
  messageBackfillNextResponseSchema,
  messageBackfillProgressSchema,
  messageBackfillPublishRequestSchema,
  messageBackfillPublishResponseSchema,
  messageBackfillSourceResponseSchema,
  type MessageBackfillAckRequest,
  type MessageBackfillAckResponse,
  type MessageBackfillUrgentSelection,
  type MessageBackfillNextResponse,
  type MessageBackfillProgress,
  type MessageBackfillPublishRequest,
  type MessageBackfillPublishResponse,
  type MessageBackfillSourceResponse,
} from "./schemas/message-backfill";
import {
  backgroundAuthorizationListRequestSchema,
  backgroundAuthorizationListResponseSchema,
  backgroundAuthorizationRespondRequestSchema,
  backgroundAuthorizationRespondResponseSchema,
  type BackgroundAuthorizationListResponse,
  type BackgroundAuthorizationRespondResponse,
} from "./schemas/background-authorization";
import {
  protectedShadowAttemptObservationResponseV2Schema,
  protectedShadowAttemptObservationV2Schema,
  type ProtectedShadowAttemptObservationResponseV2,
  type ProtectedShadowAttemptObservationV2,
} from "./schemas/protected-shadow-attempt";
import {
  protectedMemoryBriefResponseV1Schema,
  protectedMemoryArchiveRequestV1Schema,
  protectedMemoryArchiveResponseV1Schema,
  protectedMemoryCreatePlanSlotResponseV1Schema,
  protectedMemoryOrdinaryFallbackCreatePlanV1Schema,
  protectedMemoryDetailResponseV1Schema,
  protectedMemoryListResponseV1Schema,
  protectedMemorySubmittedCreateRequestV1Schema,
  protectedMemorySubmittedUpdateRequestV1Schema,
  protectedMemoryPreparedUpdateResponseV1Schema,
  protectedMemoryRestoreRequestV1Schema,
  protectedMemoryRestoreResponseV1Schema,
  protectedMemorySearchResponseV1Schema,
  protectedMemoryTierTransitionRequestV1Schema,
  protectedMemoryTierTransitionResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
  protectedMemoryAccessPlanRequestV1Schema,
  protectedMemoryAccessPlanResponseV1Schema,
  protectedMemoryPreparedAccessRequestV1Schema,
  protectedMemoryAccessUpdateResponseV1Schema,
  type ProtectedMemoryBriefResponseV1,
  type ProtectedMemoryArchiveRequestV1,
  type ProtectedMemoryArchiveResponseV1,
  type ProtectedMemoryCreatePlanResponseV1,
  type ProtectedMemoryDetailResponseV1,
  type ProtectedMemoryListResponseV1,
  type ProtectedMemorySubmittedCreateRequestV1,
  type ProtectedMemorySubmittedUpdateRequestV1,
  type ProtectedMemoryPreparedUpdateResponseV1,
  type ProtectedMemoryRestoreRequestV1,
  type ProtectedMemoryRestoreResponseV1,
  type ProtectedMemorySearchResponseV1,
  type ProtectedMemoryTierTransitionRequestV1,
  type ProtectedMemoryTierTransitionResponseV1,
  type ProtectedMemoryUnavailableResponseV1,
  type ProtectedMemoryAccessOperationV1,
  type ProtectedMemoryAccessPlanResponseV1,
  type ProtectedMemoryPreparedAccessRequestV1,
  type ProtectedMemoryAccessUpdateResponseV1,
} from "./schemas/protected-memory";
import {
  protectedArtifactCiphertextStageResponseV1Schema,
  protectedArtifactDtoV1Schema,
  protectedArtifactListResponseV1Schema,
  protectedArtifactPreparedPublicationRequestV1Schema,
  protectedArtifactPublicationPlanRequestV1Schema,
  protectedArtifactPublicationPlanResponseV1Schema,
  protectedArtifactPublicationResponseV1Schema,
  protectedArtifactUnavailableResponseV1Schema,
  protectedArtifactAccessPlanRequestV1Schema,
  protectedArtifactAccessPlanResponseV1Schema,
  protectedArtifactPreparedAccessRequestV1Schema,
  protectedArtifactAccessUpdateResponseV1Schema,
  type ProtectedArtifactCiphertextStageResponseV1,
  type ProtectedArtifactCiphertextRangeV1,
  type ProtectedArtifactDtoV1,
  type ProtectedArtifactListResponseV1,
  type ProtectedArtifactPreparedPublicationRequestV1,
  type ProtectedArtifactPublicationPlanRequestV1,
  type ProtectedArtifactPublicationPlanResponseV1,
  type ProtectedArtifactPublicationResponseV1,
  type ProtectedArtifactUnavailableResponseV1,
  type ProtectedArtifactAccessPlanRequestV1,
  type ProtectedArtifactAccessPlanResponseV1,
  type ProtectedArtifactPreparedAccessRequestV1,
  type ProtectedArtifactAccessUpdateResponseV1,
} from "./schemas/protected-artifact";
import {
  protectedAdditionalDeviceAcknowledgementRequestV1Schema,
  protectedAdditionalDeviceActivationRequestV1Schema,
  protectedAdditionalDeviceActivationV1Schema,
  protectedAdditionalDeviceApprovalRequestV1Schema,
  protectedAdditionalDeviceApprovalResponseV1Schema,
  protectedAdditionalDeviceBeginRequestV1Schema,
  protectedAdditionalDeviceDeliveriesRequestV1Schema,
  protectedAdditionalDeviceDeliveriesV1Schema,
  protectedAdditionalDeviceJoinPackagesRequestV1Schema,
  protectedAdditionalDevicePendingListRequestV1Schema,
  protectedAdditionalDevicePendingListV1Schema,
  protectedAdditionalDevicePlanV1Schema,
  protectedAdditionalDeviceTransitionPlanRequestV1Schema,
  protectedAdditionalDeviceTransitionPlanV1Schema,
  protectedAdditionalDeviceTransitionsRequestV1Schema,
  protectedAdditionalDeviceBeginRequestV2Schema,
  protectedAdditionalDeviceJoinPackagesRequestV2Schema,
  protectedAdditionalDevicePendingListRequestV2Schema,
  protectedAdditionalDevicePendingListV2Schema,
  protectedAdditionalDevicePlanPageRequestV2Schema,
  protectedAdditionalDevicePlanV2Schema,
  protectedAdditionalDeviceTransitionPlanRequestV2Schema,
  protectedAdditionalDeviceTransitionPlanV2Schema,
  protectedAdditionalDeviceTransitionsRequestV2Schema,
  type ProtectedAdditionalDeviceAcknowledgementRequestV1,
  type ProtectedAdditionalDeviceActivationRequestV1,
  type ProtectedAdditionalDeviceActivationV1,
  type ProtectedAdditionalDeviceApprovalRequestV1,
  type ProtectedAdditionalDeviceApprovalResponseV1,
  type ProtectedAdditionalDeviceBeginRequestV1,
  type ProtectedAdditionalDeviceDeliveriesRequestV1,
  type ProtectedAdditionalDeviceDeliveriesV1,
  type ProtectedAdditionalDeviceJoinPackagesRequestV1,
  type ProtectedAdditionalDevicePendingListRequestV1,
  type ProtectedAdditionalDevicePendingListV1,
  type ProtectedAdditionalDevicePlanV1,
  type ProtectedAdditionalDeviceTransitionPlanRequestV1,
  type ProtectedAdditionalDeviceTransitionPlanV1,
  type ProtectedAdditionalDeviceTransitionsRequestV1,
  type ProtectedAdditionalDeviceBeginRequestV2,
  type ProtectedAdditionalDeviceJoinPackagesRequestV2,
  type ProtectedAdditionalDevicePendingListRequestV2,
  type ProtectedAdditionalDevicePendingListV2,
  type ProtectedAdditionalDevicePlanPageRequestV2,
  type ProtectedAdditionalDevicePlanV2,
  type ProtectedAdditionalDeviceTransitionPlanRequestV2,
  type ProtectedAdditionalDeviceTransitionPlanV2,
  type ProtectedAdditionalDeviceTransitionsRequestV2,
} from "./schemas/protected-additional-device";
import {
  humanDeviceMembershipAcknowledgementRequestV1Schema,
  humanDeviceMembershipAddRequestV1Schema,
  humanDeviceMembershipBeginRequestV1Schema,
  humanDeviceMembershipBeginV1Schema,
  humanDeviceMembershipInitialRequestV1Schema,
  humanDeviceMembershipJoinRequestV1Schema,
  humanDeviceMembershipMutationV1Schema,
  humanDeviceMembershipPendingRequestV1Schema,
  humanDeviceMembershipPendingV1Schema,
  humanDeviceMembershipRemoveRequestV1Schema,
  humanDeviceMembershipRecoveryBeginRequestV1Schema,
  humanDeviceMembershipRecoveryBeginV1Schema,
  humanDeviceMembershipRecoveryCompleteRequestV1Schema,
  humanDeviceMembershipRosterRequestV1Schema,
  humanDeviceMembershipRosterV1Schema,
  humanDeviceMembershipStatusRequestV1Schema,
  humanDeviceMembershipStatusV1Schema,
  type HumanDeviceMembershipAcknowledgementRequestV1,
  type HumanDeviceMembershipAddRequestV1,
  type HumanDeviceMembershipBeginRequestV1,
  type HumanDeviceMembershipBeginV1,
  type HumanDeviceMembershipInitialRequestV1,
  type HumanDeviceMembershipJoinRequestV1,
  type HumanDeviceMembershipMutationV1,
  type HumanDeviceMembershipPendingRequestV1,
  type HumanDeviceMembershipPendingV1,
  type HumanDeviceMembershipRemoveRequestV1,
  type HumanDeviceMembershipRecoveryBeginRequestV1,
  type HumanDeviceMembershipRecoveryBeginV1,
  type HumanDeviceMembershipRecoveryCompleteRequestV1,
  type HumanDeviceMembershipRosterRequestV1,
  type HumanDeviceMembershipRosterV1,
  type HumanDeviceMembershipStatusRequestV1,
  type HumanDeviceMembershipStatusV1,
} from "./schemas/human-device-membership";
import {
  protectedInitialDeviceBeginRequestV1Schema,
  protectedInitialDeviceChallengeV1Schema,
  protectedInitialDeviceCompleteRequestV1Schema,
  protectedInitialDeviceReceiptRequestV1Schema,
  protectedInitialDeviceReceiptV1Schema,
  protectedInitialHumanDomainPlanRequestV1Schema,
  protectedInitialHumanDomainPlanResponseV1Schema,
  protectedInitialHumanDomainRequestV1Schema,
  protectedInitialHumanDomainReceiptV1Schema,
  type ProtectedInitialDeviceBeginRequestV1,
  type ProtectedInitialDeviceChallengeV1,
  type ProtectedInitialDeviceCompleteRequestV1,
  type ProtectedInitialDeviceReceiptRequestV1,
  type ProtectedInitialDeviceReceiptV1,
  type ProtectedInitialHumanDomainPlanRequestV1,
  type ProtectedInitialHumanDomainPlanResponseV1,
  type ProtectedInitialHumanDomainRequestV1,
  type ProtectedInitialHumanDomainReceiptV1,
} from "./schemas/protected-device-readiness";
import {
  humanMemoryReadObservationRequestV1Schema,
  humanMemoryReadObservationResponseV1Schema,
  type HumanMemoryReadObservationRequestV1,
  type HumanMemoryReadObservationResponseV1,
} from "./schemas/human-memory-read-observation";
import type {
  ActiveMiniAppRequestContext,
  AgentPhotoLibraryCreateResponse,
  AgentPhotoLibraryCurrentResponse,
  AgentPhotoLibraryCurrentStateDto,
  AgentPhotoLibraryEntryLifecycleResponse,
  AgentPhotoLibraryEntryResponse,
  AgentPhotoLibraryErrorCodeDto,
  AgentPhotoLibraryListResponse,
  AgentPhotoLibraryPresetsResponse,
  AgentPhotoLibraryScopeDto,
  AgentPhotoLibrarySelectionResponse,
  AgentPhotoSelectionOriginDto,
  AgentPhotoSelectionTargetDto,
  AgentProfileMutation,
  AgentProfileResponse,
  AvatarRef,
  ChatArtifactRef,
  ChatUploadedAttachmentRef,
  RoomMessageSendResponse,
  SendMessageRequest,
  SendMessageResponse,
  CreateBackgroundJobRequest,
  CreateBackgroundJobResponse,
  JobStatusResponse,
  JobStopResponse,
  RoomStopResponse,
  RoomActiveJobsResponse,
  ListTasksQuery,
  TaskSummary,
  TaskDetail,
  TaskLifecycleResponse,
  ServerEvent,
  ApprovalReplyVerb,
  WhoamiResponse,
  ListRoomsResponse,
  RoomDetailResponse,
  CreateRoomRequest,
  RenameRoomRequest,
  SetRoomVisibilityRequest,
  MarkRoomReadRequest,
  MarkRoomReadResponse,
  MessageReadStateDto,
  MessageAttachmentRef,
  MessageArtifactOpenRef,
  NotificationLevel,
  NotificationPreferencesDto,
  NotificationStateResponse,
  RoomNotificationPreferenceDto,
  ConnectionAuditResponse,
  ConnectionListResponse,
  DeleteConnectionResponse,
  StoreConnectionResponse,
  DocumentPatchApplied,
  DocumentPatchEvent,
  DocumentPatchRejected,
  DocumentPatchRequest,
  DocumentMutationCommittedEvent,
  ApplyAcceptedLiveProposalErrorCode,
  ApplyAcceptedLiveProposalRequest,
  ApplyAcceptedLiveProposalResponse,
  InvalidateLiveProposalReviewRequest,
  InvalidateLiveProposalReviewResponse,
  ResolveLiveProposalReviewRequest,
  ResolveLiveProposalReviewResponse,
  IssueLiveMiniAppSessionRequest,
  IssueLiveMiniAppSessionResponse,
  RefreshLiveMiniAppSessionRequest,
  RevokeLiveMiniAppSessionRequest,
  ListPendingLiveProposalReviewsRequest,
  ListPendingLiveProposalReviewsResponse,
  ThreadDetailResponse,
  SubthreadSummary,
  CreateSubthreadRequest,
  CreateSubthreadResponse,
  HumanEditLeaseStoreResult,
  EditableRoomMessageConflictDto,
  RegisterHumanEditLeaseRequest,
  UpdateHumanEditLeaseRequest,
  RenewHumanEditLeaseRequest,
  ReleaseHumanEditLeaseRequest,
  ModelControlSelection,
  ChatSearchOptions,
  ChatSearchPage,
  RoomMessageSearchOptions,
  RoomMessageSearchPage,
  RoomMessagesAroundOptions,
  RoomMessagesAroundPage,
  EditRoomMessageRequest,
  EditRoomMessageResponse,
  MobilePushInstallationBadgePreferenceRequest,
  MobilePushInstallationBadgePreferenceResponse,
  MobilePushInstallationErrorCode,
  MobilePushInstallationDisableRequest,
  MobilePushInstallationProofRevokeRequest,
  MobilePushInstallationRegisterRequest,
  MobilePushInstallationStatus,
  MobilePushInstallationTestResponse,
  RemoteOrdinaryRequestProof,
} from "@nautilo/types";
import {
  stenographerAdminStatusSchema,
  type StenographerAdminStatus,
  stenographerProtectionStatusSchema,
  type StenographerProtectionStatus,
  reflectionAdminStatusSchema,
  type ReflectionAdminStatus,
} from "@nautilo/types";
import {
  codexAccountStatusSchema,
  codexAccountLoginCancelSchema,
  codexConnectionSummarySchema,
  codexLoginStartSchema,
  codexProfileConnectSchema,
  codexModelCatalogSchema,
  codexRoomRequestListSchema,
  codexPermissionSelectionResponseSchema,
  codexRequestResponseReceiptSchema,
  codexRequestResponseSchema,
  codexUserPreferenceSchema,
  codexProfileSchema,
  codexRateLimitsSchema,
  codexRuntimeSummarySchema,
  codexUsageSchema,
  type CodexRequestResponse,
  type CodexRoomRequestList,
  type CodexPosture,
} from "@nautilo/types";
import {
  claudeConnectionSummarySchema,
} from "@nautilo/types";
import type {
  CatalogQuery,
  CatalogResponse,
  VoiceCustomizationHydrationResponse,
} from "@nautilo/types";
import type { GroupChip, RoleSlug } from "@nautilo/types";
// ID-free semantic record/scope types for the portable Genie
// profile bundle client. Type-only: no runtime dependency on the contract pkg.
import type { semantic } from "@nautilo/profile-portability";
import type {
  MemoryListResponse,
  MemorySearchResponse,
  MemoryDetailResponse,
  MemoryMode,
} from "./types";
// re-export memory DTOs with the other client-owned public types.
export type {
  MemoryMode,
  MemoryActionAuthority,
  MemoryAccessEntry,
  MemoryListItem,
  MemoryDetail,
  MemorySearchResult,
  MemoryListResponse,
  MemorySearchResponse,
  MemoryDetailResponse,
} from "./types";

export type ServerProfile = NonNullable<SetupStatusResponse["serverProfile"]>;

/** Exact success response from the signed-in Human portrait upload route. */
export interface HumanAvatarUploadResponse {
  avatar: AvatarRef;
}

/**
 * Binary value that the host FormData implementation can serialize. Browser
 * callers pass a `Blob` or `File`; Expo callers pass an `expo-file-system`
 * `File`, whose `bytes()` method is what Winter fetch recognizes. Deliberately
 * excludes React Native's `{ uri, name, type }` descriptor, which Winter
 * cannot serialize as a multipart part.
 */
export type AgentAvatarUploadInput =
  | Blob
  | {
      name?: string;
      bytes: () => Uint8Array | Promise<Uint8Array>;
    };

/** Identity captured when a photo-library request starts. */
export interface AgentPhotoLibraryFence {
  readonly serverInstanceId: string;
  readonly viewerUserId: string;
  readonly agentId: string;
  /** Optional exact revision checks for reads that must not merge across snapshots. */
  readonly selectionRevision?: string;
  readonly libraryRevision?: string;
  /** Local UI generation; server/Agent/viewer switches increment the current value. */
  readonly requestGeneration: number;
  readonly getCurrentGeneration: () => number;
}

export interface AgentPhotoLibraryRequestOptions {
  readonly signal?: AbortSignal;
  readonly fence?: AgentPhotoLibraryFence;
}

export interface AgentPhotoLibraryMutationOptions extends AgentPhotoLibraryRequestOptions {
  /** Stable across transport retries of this exact semantic mutation. */
  readonly idempotencyKey: string;
  readonly origin: AgentPhotoSelectionOriginDto;
}

/** Shared fields for PIN enrollment and ordinary PIN changes. */
export interface PinMutationRequest {
  /** Omit only for first-time enrollment, or after a fresh Logto step-up. */
  currentPin?: string;
  newPin: string;
}

function codexHostRequest(relayId: string | null | undefined): {
  readonly headers?: Record<string, string>;
} {
  return relayId
    ? { headers: { "x-nautilo-codex-relay-id": relayId } }
    : {};
}

function claudeHostRequest(relayId: string | null | undefined): {
  readonly headers?: Record<string, string>;
} {
  return relayId ? { headers: { "x-nautilo-claude-relay-id": relayId } } : {};
}

const harnessCapabilityStateSchema = z.enum(["supported", "unsupported", "unknown"]);
export const acpHarnessDescriptorSchema = z.object({
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(512),
  setup: z.object({
    installation: z.enum(["not_required", "manual", "on_demand"]),
    activation: z.enum(["user_initiated", "automatic"]),
  }).strict(),
  integration: z.object({
    authentication: z.enum(["none", "existing_session", "interactive"]),
    resume: z.enum(["new_session_only", "resume_existing_session", "runtime_decides"]),
  }).strict(),
  declaredCapabilities: z.object({
    execution: harnessCapabilityStateSchema,
    resume: harnessCapabilityStateSchema,
    stop: harnessCapabilityStateSchema,
    steer: harnessCapabilityStateSchema,
    requests: harnessCapabilityStateSchema,
  }).strict(),
}).strict();
export const acpHarnessListSchema = z.object({
  harnesses: z.array(acpHarnessDescriptorSchema).max(16),
}).strict();
const acpHarnessRecoveryActionSchema = z.string().min(1).max(1_024);
export const acpHarnessReadinessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ready"), action: z.null() }).strict(),
  z.object({ state: z.literal("missing"), action: acpHarnessRecoveryActionSchema }).strict(),
  z.object({ state: z.literal("incompatible"), action: acpHarnessRecoveryActionSchema }).strict(),
  z.object({ state: z.literal("authentication_required"), action: acpHarnessRecoveryActionSchema }).strict(),
  z.object({ state: z.literal("unavailable"), action: acpHarnessRecoveryActionSchema }).strict(),
]);
export type AcpHarnessDescriptor = z.infer<typeof acpHarnessDescriptorSchema>;
export type AcpHarnessReadiness = z.infer<typeof acpHarnessReadinessSchema>;

/** Optional graph-resume context accepted by the existing `POST /api/auth/pin` route. */
export interface PostAuthPinRequest extends PinMutationRequest {
  threadId?: string;
  laneKey?: string;
  clientActionSessionId?: string;
  authorizationDeviceId?: string;
}

export interface ForegroundResumeCryptoBinding {
  clientActionSessionId?: string;
  authorizationDeviceId?: string;
}

/** Socket- and device-bound request for one canonical awaiting checkpoint. */
export interface RoomPendingAttentionPageRequest {
  clientActionSessionId: string;
  authorizationDeviceId: string;
  cursor?: string;
}

/** Fresh ephemeral recipient challenge for a protected checkpoint read. */
export interface RoomPendingAttentionChallenge {
  challengeId: string;
  authorizationPlanBytesBase64url: string;
  recipientPublicKeyBase64url: string;
  deadlineAt: number;
  roomId: string;
}

export interface RoomPendingAttentionPageResponse {
  events: ServerEvent[];
  challenge?: RoomPendingAttentionChallenge | undefined;
  nextCursor: string | null;
  status: "ready" | "unavailable";
}

/** One-use Human-device authorization for the page's protected checkpoint. */
export interface RoomPendingAttentionReadRequest {
  clientActionSessionId: string;
  authorizationDeviceId: string;
  challengeId: string;
  authorizationBytesBase64url: string;
}

export interface RoomPendingAttentionReadResponse {
  status: "read" | "unavailable";
  events: ServerEvent[];
}

export interface RoomPendingAttentionRecoveryResponse {
  status: "ready" | "unavailable";
  events: ServerEvent[];
}

export type RoomPendingAttentionEvent = Extract<ServerEvent, {
  type: "approval.ask" | "prove_it.challenge" | "identity.challenge";
}>;

const UUID_LANE_COMPONENT_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const UUID_LANE_COMPONENT = new RegExp(`^${UUID_LANE_COMPONENT_PATTERN}$`, "i");
const GROUP_ROOM_LANE_PATTERN = new RegExp(
  `^room:([^:]+):user:(${UUID_LANE_COMPONENT_PATTERN}):bot:(${UUID_LANE_COMPONENT_PATTERN})$`,
  "i",
);

/**
 * Admit only exact server-authored Room approval lanes. This deliberately
 * rejects arbitrary room-prefixed suffixes: group lanes carry the exact
 * Human actor and Agent coordinates used by the Conductor.
 */
export function isRoomPendingAttentionEventForViewer(
  event: ServerEvent,
  expected: Readonly<{
    roomId: string;
    userId: string;
    humanActorId: string;
  }>,
): boolean {
  if (event.type !== "approval.ask"
    && event.type !== "prove_it.challenge"
    && event.type !== "identity.challenge") return false;
  if (!UUID_LANE_COMPONENT.test(expected.roomId)
    || !UUID_LANE_COMPONENT.test(expected.humanActorId)) return false;
  if (event.userId !== expected.userId || event.threadId.length === 0) return false;
  if (event.laneKey === `room:${expected.roomId}`) return true;
  const groupLane = GROUP_ROOM_LANE_PATTERN.exec(event.laneKey);
  return groupLane !== null
    && groupLane[1] === expected.roomId
    && groupLane[2]?.toLowerCase() === expected.humanActorId.toLowerCase();
}

function isPendingAttentionTool(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const tool = value as Record<string, unknown>;
  return typeof tool["name"] === "string"
    && tool["name"].length > 0
    && typeof tool["args"] === "object"
    && tool["args"] !== null
    && !Array.isArray(tool["args"]);
}

function isPendingAttentionEvent(value: unknown): value is RoomPendingAttentionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (typeof event["userId"] !== "string" || event["userId"].length === 0
    || typeof event["threadId"] !== "string" || event["threadId"].length === 0
    || typeof event["laneKey"] !== "string" || event["laneKey"].length === 0) return false;
  if (event["type"] === "prove_it.challenge") {
    return Array.isArray(event["tools"])
      && event["tools"].every(isPendingAttentionTool);
  }
  if (event["type"] === "identity.challenge") {
    return typeof event["challengeId"] === "string"
      && event["challengeId"].length > 0
      && typeof event["expiresAt"] === "string"
      && event["expiresAt"].length > 0
      && (event["mode"] === undefined
        || event["mode"] === "verify" || event["mode"] === "enrollPin");
  }
  if (event["type"] !== "approval.ask") return false;
  return typeof event["approvalId"] === "string"
    && event["approvalId"].length > 0
    && Array.isArray(event["tools"])
    && event["tools"].every(isPendingAttentionTool)
    && typeof event["reason"] === "string" && event["reason"].length > 0
    && (event["reasonCode"] === "command-scanner-medium"
      || event["reasonCode"] === "command-scanner-high"
      || event["reasonCode"] === "external-binary"
      || event["reasonCode"] === "destructive-tool"
      || event["reasonCode"] === "network-egress-denied"
      || event["reasonCode"] === "tier-bump")
    && Array.isArray(event["allowedVerbs"])
    && event["allowedVerbs"].length > 0
    && event["allowedVerbs"].every((verb) =>
      verb === "once" || verb === "room" || verb === "always" || verb === "deny"
    );
}

const pendingAttentionEventSchema = z.custom<RoomPendingAttentionEvent>(
  isPendingAttentionEvent,
);
const roomPendingAttentionChallengeSchema: z.ZodType<RoomPendingAttentionChallenge> =
  z.object({
    challengeId: z.string().min(1),
    authorizationPlanBytesBase64url: z.string().min(1),
    recipientPublicKeyBase64url: z.string().min(1),
    deadlineAt: z.number().int().nonnegative(),
    roomId: z.string().min(1),
  }).strict();
const roomPendingAttentionPageResponseSchema: z.ZodType<RoomPendingAttentionPageResponse> =
  z.object({
    events: z.array(pendingAttentionEventSchema),
    challenge: roomPendingAttentionChallengeSchema.optional(),
    nextCursor: z.string().min(1).nullable(),
    status: z.enum(["ready", "unavailable"]),
  }).strict();
const roomPendingAttentionReadResponseSchema: z.ZodType<RoomPendingAttentionReadResponse> =
  z.object({
    status: z.enum(["read", "unavailable"]),
    events: z.array(pendingAttentionEventSchema),
  }).strict();

/** First-time PIN enrollment returns recovery codes exactly once. */
export interface PinEnrollmentResponse {
  ok: true;
  enrolled: true;
  recoveryCodes: string[];
}

/** An ordinary PIN change does not mint or retain one-time recovery material. */
export interface PinChangeResponse {
  ok: true;
  enrolled?: never;
  recoveryCodes?: never;
}

export type PinMutationResponse = PinEnrollmentResponse | PinChangeResponse;

const humanAvatarUploadResponseSchema: z.ZodType<HumanAvatarUploadResponse> = z.object({
  avatar: avatarRefSchema,
});

const pinMutationResponseSchema: z.ZodType<PinMutationResponse> = z.union([
  z.object({
    ok: z.literal(true),
    enrolled: z.literal(true),
    recoveryCodes: z.array(z.string()),
  }).passthrough(),
  z.object({ ok: z.literal(true) }).strict(),
]);

const protectedMemoryListRouteResponseV1Schema = z.union([
  protectedMemoryListResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryDetailRouteResponseV1Schema = z.union([
  protectedMemoryDetailResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemorySearchRouteResponseV1Schema = z.union([
  protectedMemorySearchResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryBriefRouteResponseV1Schema = z.union([
  protectedMemoryBriefResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryCreatePlanRouteResponseV1Schema = z.union([
  protectedMemoryCreatePlanSlotResponseV1Schema,
  protectedMemoryOrdinaryFallbackCreatePlanV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryPublicationRouteResponseV1Schema = z.union([
  protectedMemoryPreparedUpdateResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryArchiveRouteResponseV1Schema = z.union([
  protectedMemoryArchiveResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryTierTransitionRouteResponseV1Schema = z.union([
  protectedMemoryTierTransitionResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryRestoreRouteResponseV1Schema = z.union([
  protectedMemoryRestoreResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryAccessPlanRouteResponseV1Schema = z.union([
  protectedMemoryAccessPlanResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);
const protectedMemoryAccessUpdateRouteResponseV1Schema = z.union([
  protectedMemoryAccessUpdateResponseV1Schema,
  protectedMemoryUnavailableResponseV1Schema,
]);

function exactStringInventory(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

/** aggregated reaction row for a room message (tap-to-react). */
export interface RoomReactionAggregate {
  emoji: string;
  count: number;
  actorIds?: string[];
  truncated?: boolean;
}

/**
 * `DELETE /api/memory/:id?mode=archive|hard` status envelope.
 * `archive` yields `{ status: "archived", memoryMode }`; `hard` yields the
 * server's `result.status` (e.g. `detached` / `deleted`) with the mode.
 */
export interface MemoryMutationStatusResponse {
  status: string;
  memoryMode: MemoryMode;
}

/**
 * `POST /api/memory/:id/grant` response. The room path sets
 * `namespaceId`; the handle path sets `roomLabel` + `minted`.
 */
export interface MemoryGrantResponse {
  status: string;
  namespaceId?: string;
  roomLabel?: string;
  minted?: boolean;
}

/** `POST /api/memory/:id/revoke` response. */
export interface MemoryRevokeResponse {
  status: string;
  reHomed: number;
  skipped: string[];
}

/** `POST /api/memory/:id/make_private` response. */
export interface MemoryMakePrivateResponse {
  status: string;
  skipped: string[];
}

/** Role ladder rank (highest first). Empty `groups` → `guest`. */
const ROLE_LADDER: readonly RoleSlug[] = [
  "owner",
  "admin",
  "superuser",
  "member",
  "contributor",
  "guest",
] as const;

export function pickHighestRoleSlug(groups: GroupChip[]): RoleSlug {
  if (groups.length === 0) return "guest";
  const rank = (slug: string): number => {
    const i = ROLE_LADDER.indexOf(slug as RoleSlug);
    return i === -1 ? ROLE_LADDER.length : i;
  };
  let best: RoleSlug = "guest";
  for (const g of groups) {
    const r = g.roleSlug;
    if (rank(r) < rank(best)) best = r as RoleSlug;
  }
  return best;
}

export const whoamiResponseSchema = z.object({
  sessionUserId: z.string().nullable(),
  sessionActorId: z.string().nullable(),
  userIdentity: z.string().nullable(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  externalId: z.string().nullable(),
  instanceId: z.string(),
  mustChangePassword: z.boolean(),
  groups: z
    .array(
      z.object({
        id: z.string(),
        type: z.string(),
        label: z.string(),
        roleSlug: z.string(),
      }),
    )
    .default([]),
  // String (not enum) so we tolerate unknown slugs from a newer
  // server; consumers filter with `isCapabilitySlug`.
  capabilities: z.array(z.string()).default([]),
  features: z
    .object({
      office: z
        .object({
          enabled: z.boolean().default(false),
        })
        .default({ enabled: false }),
    })
    .default({ office: { enabled: false } }),
  // highest-rank Role slug across the viewer's Groups (or null).
  // Replaces the retired `serverRole` enum for role-badge display. String
  // (not enum) to tolerate unknown slugs from a newer server.
  highestRole: z.string().nullable().default(null),
});

const groupChipSchema = z.object({
  id: z.string(),
  type: z.string(),
  label: z.string(),
  roleSlug: z.string(),
});

export const adminUserRowSchema = z.object({
  id: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  groups: z.array(groupChipSchema),
  server: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  disabledAt: z.string().nullable(),
  disabledBy: z.string().nullable(),
  disabledReason: z.string().nullable(),
});

export const adminUsersListResponseSchema = z.object({
  users: z.array(adminUserRowSchema),
  nextCursor: z.string().nullable(),
  page: z.object({
    returned: z.number().int().nonnegative(),
    complete: z.boolean(),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
    continuationAvailable: z.boolean(),
  }).strict().optional(),
});

// server-wide model config. `conductorModel` empty ⇒ inherit the
// default chat model. `fallbackChain` is an ordered list of catalog model ids.
export const serverModelConfigSchema = z.object({
  defaultChatModel: z.string(),
  conductorModel: z.string(),
  stenographerModel: z.string(),
  reflectionModel: z.string(),
  memoryReviewModel: z.string().nullable(),
  embeddingModel: z.string().nullable().optional().default(null),
  effectiveEmbeddingModel: z.string().nullable().optional().default(null),
  embeddingSelectionPending: z.boolean().optional().default(false),
  embeddingModels: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    available: z.boolean(),
  })).optional().default([]),
  catalogModels: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    provider: z.string(),
    workload: z.string(),
    availability: z.string(),
    unavailableReason: z.string().optional(),
    input: z.array(z.string()),
    output: z.array(z.string()),
    features: z.object({
      tools: z.boolean().nullable(),
      structuredOutputs: z.boolean().nullable(),
      reasoning: z.boolean().nullable(),
      visualGrounding: z.boolean().nullable(),
      webSearch: z.boolean().nullable(),
      e2ee: z.boolean().nullable(),
    }),
    decision: z.object({ operations: z.array(z.string()) }).nullable().optional(),
  })).optional(),
  imageModel: z.string().nullable().optional().default(null),
  musicModel: z.string().nullable().optional().default(null),
  videoModel: z.string().nullable().optional().default(null),
  speechModel: z.string().nullable().optional().default(null),
  effectiveSpeechModel: z.string().nullable().optional().default(null),
  speechModels: z.array(z.object({
    id: z.string(), displayName: z.string(), provider: z.string(), available: z.boolean(),
    unavailableReason: z.string().optional(),
  })).optional().default([]),
  effectiveImageModel: z.string().nullable().optional().default(null),
  effectiveMusicModel: z.string().nullable().optional().default(null),
  effectiveVideoModel: z.string().nullable().optional().default(null),
  imageModels: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    provider: z.string(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
  })).optional().default([]),
  musicModels: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    provider: z.string(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
  })).optional().default([]),
  videoModels: z.array(z.object({
    id: z.string(),
    displayName: z.string(),
    provider: z.string(),
    available: z.boolean(),
    unavailableReason: z.string().optional(),
  })).optional().default([]),
  fallbackChain: z.array(z.string()),
  reasoningOutput: z.record(z.string(), z.boolean()),
  reasoningPolicy: z.object({
    defaultEffort: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullable(),
    overrides: z.record(z.string(), z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])),
  }),
});

export const serverContextConfigSchema = z.object({
  recentConversationLimit: z.number().int().min(10).max(100),
  minimumFullTurns: z.number().int().min(0).max(10),
  maxRoomContextPercent: z.number().int().min(30).max(80),
  stenographerPriorConversationLimit: z.number().int().min(0).max(50),
  passiveRecallEnabled: z.boolean(),
  reflectionSleepEnabled: z.boolean(),
  memoryReviewEnabled: z.boolean().nullable(),
});

// shared rooms owned by a user that block their deletion, with the
// members eligible to receive ownership (non-federated humans).
const sharedRoomMemberSchema = z.object({
  userId: z.string(),
  handle: z.string().nullable(),
  displayName: z.string(),
  federated: z.boolean(),
});
export const ownedSharedRoomSchema = z.object({
  roomId: z.string(),
  label: z.string(),
  eligibleNewOwners: z.array(sharedRoomMemberSchema),
});
export const ownedSharedRoomsResponseSchema = z.object({
  rooms: z.array(ownedSharedRoomSchema),
});

const okResponseSchema = z.object({ ok: z.boolean() });
const adminUserMutationReceiptSchema = z.object({
  stateChanged: z.union([z.boolean(), z.literal("unknown")]),
  auditRecorded: z.union([z.boolean(), z.literal("unknown")]),
  retrySafe: z.union([z.boolean(), z.literal("unknown")]),
  receiptId: z.string().nullable(),
  recovery: z.array(z.object({
    kind: z.string(),
    userId: z.string().optional(),
  }).strict()),
}).strict();
const adminUserMutationResponseSchema = z.object({
  ok: z.boolean(),
  mutation: adminUserMutationReceiptSchema.optional(),
});
// Group membership mutations surface the audit-append
// outcome (`auditRecorded`) so a silent audit failure is visible to the
// client. Optional for backward compatibility with older servers that only
// returned `{ ok }`.
const groupMutationResponseSchema = z.object({
  ok: z.boolean(),
  auditRecorded: z.boolean().optional(),
});
const adminPasswordResetResponseSchema = z.object({
  ok: z.boolean(),
  delivery: z.enum(["one_time_url", "temporary_password"]).optional(),
  url: z.string().optional(),
  token: z.string().optional(),
  temporaryPassword: z.string().optional(),
  mustChangePassword: z.literal(true).optional(),
  mutation: adminUserMutationReceiptSchema.optional(),
});
const adminProvisionMemberResponseSchema = z.object({
  ok: z.literal(true),
  receiptId: z.string(),
  memberId: z.string(),
  actorId: z.string().nullable(),
  landingRoomId: z.string().nullable(),
  roleSlug: z.string(),
  idempotent: z.boolean(),
  auditRecorded: z.boolean(),
  credential: z.discriminatedUnion("disposition", [
    z.object({
      disposition: z.literal("issued"),
      temporaryPassword: z.string(),
      pin: z.string(),
      recoveryCodes: z.array(z.string()),
    }).strict(),
    z.object({
      disposition: z.literal("provided"),
      recoveryCodes: z.array(z.string()),
    }).strict(),
    z.object({ disposition: z.literal("not_reissued") }).strict(),
  ]),
}).strict();
const adminRolloutPlanResponseSchema = z.object({
  ok: z.literal(true),
  schemaVersion: z.literal(1),
  fingerprint: z.string(),
  serverInstanceId: z.string(),
  operations: z.array(z.object({
    index: z.number().int().nonnegative(),
    handle: z.string(),
    displayName: z.string(),
    email: z.string().optional(),
    roleSlug: z.string(),
    idempotencyKey: z.string(),
  }).strict()),
  warnings: z.array(z.string()),
  bounds: z.object({ maxMembers: z.number().int().positive(), requestedMembers: z.number().int().positive() }).strict(),
}).strict();
const adminRolloutItemSchema = z.object({
  sequence: z.number().int().nonnegative(),
  handle: z.string(),
  roleSlug: z.string(),
  state: z.string(),
  receiptId: z.string().nullable(),
  memberId: z.string().nullable(),
  errorCode: z.string().nullable(),
  credentialDisposition: z.string(),
  updatedAt: z.string(),
}).strict();
const adminRolloutStatusResponseSchema = z.object({
  ok: z.literal(true),
  rolloutId: z.string(),
  fingerprint: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  items: z.array(adminRolloutItemSchema),
}).strict();
const adminRolloutApplyResponseSchema = adminRolloutStatusResponseSchema.extend({
  idempotent: z.boolean().optional(),
  credentials: z.array(z.object({
    sequence: z.number().int().nonnegative(),
    handle: z.string(),
    temporaryPassword: z.string(),
    pin: z.string(),
    recoveryCodes: z.array(z.string()),
  }).strict()),
}).strict();
const adminUserDeleteResponseSchema = z.object({
  ok: z.boolean(),
  logtoRevoked: z.boolean().optional(),
  mutation: adminUserMutationReceiptSchema.optional(),
});

export type AdminUserRow = z.infer<typeof adminUserRowSchema>;
export type AdminUsersPage = NonNullable<z.infer<typeof adminUsersListResponseSchema>["page"]>;
export type AdminUsersListResponse = {
  users: AdminUserRow[];
  nextCursor: string | null;
  page: AdminUsersPage;
};
export type AdminUserMutationReceipt = z.infer<typeof adminUserMutationReceiptSchema>;
export type AdminUserMutationResponse = { ok: boolean; mutation: AdminUserMutationReceipt };
export type AdminPasswordResetResponse = {
  ok: boolean;
  mutation: AdminUserMutationReceipt;
} & (
  | { delivery: "one_time_url"; url: string; token: string }
  | { delivery: "temporary_password"; temporaryPassword: string; mustChangePassword: true }
);
export type AdminProvisionMemberResponse = z.infer<typeof adminProvisionMemberResponseSchema>;
export interface AdminProvisionMemberInput {
  handle: string;
  displayName: string;
  email?: string | undefined;
  roleSlug: "admin" | "superuser" | "member" | "contributor" | "guest";
  permanentCredential?: { password: string; pin: string } | undefined;
}
export interface AdminPermanentCredentialInput { password: string; pin: string }
export interface AdminPermanentCredentialResponse {
  ok: true;
  memberId: string;
  auditRecorded: boolean;
}
export type AdminRolloutPlanResponse = z.infer<typeof adminRolloutPlanResponseSchema>;
export type AdminRolloutStatusResponse = z.infer<typeof adminRolloutStatusResponseSchema>;
export type AdminRolloutApplyResponse = z.infer<typeof adminRolloutApplyResponseSchema>;
export type AdminUserDeleteResponse = {
  ok: boolean;
  logtoRevoked: boolean | "unknown";
  mutation: AdminUserMutationReceipt;
};
export type ServerModelConfig = z.infer<typeof serverModelConfigSchema>;
export type ServerContextConfig = z.infer<typeof serverContextConfigSchema>;
export type OwnedSharedRoom = z.infer<typeof ownedSharedRoomSchema>;
export type OwnedSharedRoomsResponse = z.infer<typeof ownedSharedRoomsResponseSchema>;
export type {
  GroupRow,
  GroupMemberRow,
  ListGroupsResponse,
  ListGroupMembersResponse,
} from "./schemas/groups";
export interface AdminUsersListOptions {
  cursor?: string | undefined;
  limit?: number | undefined;
  includeFederated?: boolean | undefined;
  search?: string | undefined;
}

function guestWhoamiFallback(): WhoamiResponse {
  return {
    sessionUserId: null,
    sessionActorId: null,
    userIdentity: null,
    handle: null,
    displayName: null,
    externalId: null,
    instanceId: "",
    mustChangePassword: false,
    groups: [],
    capabilities: [],
    features: { office: { enabled: false } },
    highestRole: null,
  };
}

function bearerIsAtOrPastJwtExpiry(token: string | null, now: number): boolean {
  if (token === null) return false;
  const payload = token.split(".")[1];
  if (payload === undefined) return false;
  try {
    const normalized = payload.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (value) => value.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof decoded !== "object" || decoded === null) return false;
    const expiresAt = (decoded as { exp?: unknown }).exp;
    return typeof expiresAt === "number"
      && Number.isFinite(expiresAt)
      && expiresAt <= now / 1_000;
  } catch {
    return false;
  }
}

// Mirrors `category: "llm" | "llm+embeddings"` entries in
// `packages/config-guard/src/key-registry.ts`. Kept hand-maintained because
// `api-client` is browser-loadable; do not import config-guard runtime here
// (its `index.ts` transitively pulls `node:path` via `@nautilo/config`,
// which Vite externalizes and crashes the renderer on first evaluation).
const LLM_KEY_IDS = new Set<string>([
  "anthropic",
  "openai",
  "openrouter",
  "nautilo-gateway",
  "gateway",
  "google",
  "fireworks",
  "venice",
]);

function computeHasLlmFromKeys(keys: KeyReport[]): boolean {
  // A masked Gateway key report cannot prove that its separate API root is
  // usable. Keep this browser-side projection conservative; authoritative
  // setup readiness comes from config-guard's server-side summary.
  return keys.some(
    (k) =>
      k.id !== "nautilo-gateway"
      && LLM_KEY_IDS.has(k.id)
      && (k.status === "present" || k.status === "verified"),
  );
}

/**
 * Public `/health` payload.
 *
 * The original contract (`status`, `authRequired`, `enrolled`)
 * is preserved verbatim. Logto discovery fields let unauthenticated clients
 * wire auth before they have a token.
 * `logtoResource` tells the workbench which audience to
 * request access tokens for.
 */
export interface HealthResponse {
  status: string;
  authRequired?: boolean;
  enrolled?: boolean;
  logtoEndpoint?: string | null;
  logtoWorkbenchAppId?: string | null;
  logtoTuiAppId?: string | null;
  /** legacy-named CLI loopback PKCE app id (sibling to `logtoTuiAppId`). */
  logtoTuiLoopbackAppId?: string | null;
  /**
   * Logto Native application id for the Electron desktop's
   * loopback PKCE flow. Distinct from `logtoWorkbenchAppId` because
   * RFC 8252 §7.3 port-flex on `127.0.0.1` is honoured only for
   * Native apps. May be null when not configured.
   */
  logtoDesktopAppId?: string | null;
  /**
   * Logto Native application id for the mobile (Expo) client's
   * custom-scheme PKCE flow (`nautilo://callback`). Distinct from the
   * desktop / workbench app ids; discovered per-server. May be null
   * when not configured.
   */
  logtoMobileAppId?: string | null;
  /**
   * dedicated Logto SPA application id for Mobile Web. It owns only
   * the exact current-origin `/mobile/callback` flow and is intentionally
   * distinct from both Workbench and native Mobile transaction storage.
   */
  logtoMobileWebAppId?: string | null;
  logtoResource?: string | null;
  /**
   * Canonical browser origins for Workbench OIDC redirects.
   * Browser code uses these to avoid localhost / 127.0.0.1 exact-match drift.
   */
  serverUrl?: string | null;
  workbenchUrl?: string | null;
  passwordRecoveryDriver?: string | null;
  /**
   * Immutable fingerprint of the server image that served this response.
   * Empty or absent on source/development runs where no immutable image is
   * available to compare.
   */
  deploymentIdentity?: string | null;
  /**
   * payload-free durable maintenance state. Optional so Workbench
   * clients remain compatible with servers deployed before the field.
   */
  maintenanceState?: "normal" | "draining" | "applying";
  /** grouped relay-device HTTP contract advertised by this server. */
  relayPairingContractVersion?: 2;
}

export interface SetupKeysResult {
  success: boolean;
  applied?: number;
  skipped?: number;
  snapshot?: string | null;
  details?: TransactionDetail[];
  error?: string;
}

const eligibleModelReasoningLevelSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

/**
 * strict public DTO for `GET /api/config/models`. Provider selectors
 * and provenance intentionally do not exist in this schema: callers choose a
 * catalog profile id and the server owns translation to a provider request.
 */
export const assistantModelSummarySchema = z
  .object({
    id: z.string(),
    displayName: z.string(),
    priority: z.number().int(),
    enabled: z.boolean(),
    costCoefficient: z.number(),
    /** First segment of `provider:rest` — echoed by `/api/config/models` when present. */
    provider: z.string().optional(),
    /** Venice upstream routing class when applicable. */
    routing: z.enum(["venice-hosted", "western-anonymized", "china-anonymized", "unknown"]).optional(),
    availability: z
      .enum([
        "selectable",
        "missing-key",
        "filtered",
        "unsupported-capability",
        "unknown-model",
      ])
      .optional(),
    unavailableReason: z.string().optional(),
    capabilities: z
      .object({
        tools: z.boolean(),
        vision: z.boolean(),
        reasoning: z.boolean(),
        e2ee: z.boolean(),
        webSearch: z.boolean(),
      })
      .strict()
      .optional(),
    controls: z
      .object({
        reasoning: z
          .object({
            levels: z.array(eligibleModelReasoningLevelSchema),
            defaultLevel: z.union([eligibleModelReasoningLevelSchema, z.literal("off")]),
            canDisable: z.boolean(),
            mandatory: z.boolean(),
          })
          .strict()
          .optional(),
        serving: z
          .object({
            defaultProfile: z.string(),
            profiles: z.array(
              z
                .object({
                  id: z.string(),
                  label: z.string(),
                  description: z.string().optional(),
                  intent: z.enum(["balanced", "reliability", "throughput"]),
                  pricing: z
                    .object({
                      inputPerMtok: z.number().nonnegative(),
                      cachedInputPerMtok: z.number().nonnegative(),
                      outputPerMtok: z.number().nonnegative(),
                    })
                    .strict()
                    .optional(),
                })
                .strict(),
            ),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type AssistantModelSummary = z.infer<typeof assistantModelSummarySchema>;

/**
 * Read-only slash-command catalogue entry. Command visibility and enabled
 * state are decided by the server for the authenticated speaker; clients use
 * this only for discovery and leave expansion to the message send path.
 */
export const commandListItemSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  source: z.string(),
  tokenEstimate: z.number(),
  updatedAt: z.string(),
  official: z.boolean(),
  forked: z.boolean(),
  version: z.number().optional(),
});

export const commandsListResponseSchema = z.object({
  commands: z.array(commandListItemSchema),
  summary: z.object({
    total: z.number(),
    enabled: z.number(),
    disabled: z.number(),
  }),
});

export type CommandListItem = z.infer<typeof commandListItemSchema>;
export type CommandsListResponse = z.infer<typeof commandsListResponseSchema>;

export const commandDetailSchema = commandListItemSchema.extend({ body: z.string() });
export const commandDetailResponseSchema = z.object({ command: commandDetailSchema });
export const putCommandRequestSchema = z.object({
  name: z.string(),
  description: z.string(),
  body: z.string(),
  enabled: z.boolean(),
});
export const commandDeleteResponseSchema = z.object({ ok: z.literal(true) });

export type CommandDetail = z.infer<typeof commandDetailSchema>;
export type PutCommandRequest = z.infer<typeof putCommandRequestSchema>;

/** Browser selection DTO: neutral catalog ids only, never provider selectors. */
export const modelControlSelectionSchema = z
  .object({
    modelId: z.string().min(1),
    reasoningEffort: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
      .optional(),
    servingProfileId: z.string().min(1).optional(),
  })
  .strict();

export const modelControlSelectionResponseSchema = z
  .object({ selection: modelControlSelectionSchema.nullable() })
  .strict();

function normalizeModelControlSelection(
  selection: z.infer<typeof modelControlSelectionSchema> | null,
): ModelControlSelection | null {
  if (selection === null) return null;
  return {
    modelId: selection.modelId,
    ...(selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort }),
    ...(selection.servingProfileId === undefined
      ? {}
      : { servingProfileId: selection.servingProfileId }),
  };
}

/** Query flags for `GET /api/config/models` — forwarded to `getEligibleModels`. */
export interface GetEligibleModelsQuery {
  includeUnavailable?: boolean;
  allowChinaUpstream?: boolean;
  purpose?:
    | "chat"
    | "chat-tools"
    | "vision"
    | "vision-tools"
    | "image-generation"
    | "embeddings"
    | "task-tool-free"
    | "task-tools";
}

export interface SecurityPostureResponse {
  deploymentMode: "server" | "desktop-permissive" | "desktop-locked";
  securityLevel: "yolo" | "permissive" | "standard" | "cautious" | "paranoid";
  allowUncontainedHostCommands: boolean;
  networkPolicy:
    | { mode: "host" }
    | { mode: "isolated" }
    | {
        mode: "proxy-allowlist";
        allow: readonly (
          | { type: "domain"; host: string; ports?: readonly number[] | undefined }
          | { type: "wildcard"; suffix: string; ports?: readonly number[] | undefined }
          | { type: "cidr"; cidr: string; ports?: readonly number[] | undefined }
        )[];
        defaultPort?: 443 | undefined;
      };
  capabilities: readonly string[];
  actorRole: string;
  writablePaths: readonly string[];
  readOnlyPaths: readonly string[];
  backend: {
    kind: "bubblewrap" | "sandbox-exec" | "passthrough";
    procSupported?: boolean;
  };
}

export interface SecurityAuditEvent {
  kind: string;
  ts: string;
  actorId: string | null;
  ip?: string;
  userAgent?: string;
  [key: string]: unknown;
}

export interface McpAdminSummary {
  id: string;
  name: string;
  host: string;
  enabled: boolean;
  trustTier: string | null;
  health: string;
  toolCount: number;
  lastCheckStatus: string | null;
  lastCheckFailureCode: string | null;
  lastCheckedAt: string | null;
  lastConnectedAt: string | null;
  revision: string;
}

export interface McpAdminToolSummary {
  name: string;
  enabled: boolean;
}

export interface McpAdminMutationReceipt {
  server: McpAdminSummary;
  tools?: McpAdminToolSummary[];
}

function projectMcpAdminSummary(row: Record<string, unknown>): McpAdminSummary {
  return {
    id: typeof row["id"] === "string" ? row["id"] : "",
    name: typeof row["name"] === "string" ? row["name"] : "",
    host: typeof row["host"] === "string" ? row["host"] : "",
    enabled: row["enabled"] === true,
    trustTier: typeof row["trustTier"] === "string" ? row["trustTier"] : null,
    health: typeof row["health"] === "string" ? row["health"] : "unknown",
    toolCount: typeof row["toolCount"] === "number" ? row["toolCount"] : 0,
    lastCheckStatus: typeof row["lastCheckStatus"] === "string" ? row["lastCheckStatus"] : null,
    lastCheckFailureCode: typeof row["lastCheckFailureCode"] === "string" ? row["lastCheckFailureCode"] : null,
    lastCheckedAt: typeof row["lastCheckedAt"] === "string" ? row["lastCheckedAt"] : null,
    lastConnectedAt: typeof row["lastConnectedAt"] === "string" ? row["lastConnectedAt"] : null,
    revision: typeof row["updatedAt"] === "string" ? row["updatedAt"] : "",
  };
}

function projectMcpAdminTool(tool: Record<string, unknown>): McpAdminToolSummary {
  return {
    name: typeof tool["name"] === "string" ? tool["name"] : "",
    enabled: tool["enabled"] === true,
  };
}

export interface LogtoRecoveryCodesSummary {
  remaining: number;
  total: number;
  lastGeneratedAt: string | null;
}

export interface AccountSecurityResponse {
  linkedToLogto: boolean;
  requiresPasswordChange: boolean;
  passwordChangeReason: string | null;
  requiredSince: string | null;
  completedAt: string | null;
  /** Present when `linkedToLogto` is true — Logto password recovery codes. */
  logtoRecoveryCodes: LogtoRecoveryCodesSummary | null;
}

export type AccountDeletionEligibility =
  | { eligible: true }
  | { eligible: false; code: "user_not_found" | "federated_user" | "protected_custody" | "active_media_operation" | "last_owner" }
  | { eligible: false; code: "owns_shared_rooms"; sharedRoomCount: number };

export interface AccountDeletionResponse {
  ok: true;
  logtoRevoked: boolean;
  reconciliationPending: boolean;
}

// The canonical kind
// set is `{claim, server}`. `claim` is bootstrap-only and cannot be POSTed.
// `agent` and the transitional `group`/`room` kinds are retired — the
// server returns 400 `invalid_kind` for any other value.
export type InviteKind = "server" | "claim";

export interface CreateInviteInput {
  kind: "server";
  /**
   * Required. The canonical Group rung the invitee joins on redeem.
   * One of the six ladder slugs: owner / admin / superuser / member /
   * contributor / guest.
   */
  targetGroupRoleSlug:
    | "owner"
    | "admin"
    | "superuser"
    | "member"
    | "contributor"
    | "guest";
  /**
   * Optional. When set, the invitee is ALSO added to this Room on
   * redeem (in addition to the canonical Group). Inviter must own the
   * Room (or be a server admin).
   */
  targetRoomId?: string | undefined;
  maxUses?: number | null | undefined;
  expiresAt?: string | null | undefined;
  displayName?: string | null | undefined;
}

export interface CreateInviteResult {
  id: string;
  url: string;
  token: string;
  kind: InviteKind;
  expiresAt: string | null;
  maxUses: number | null;
  mutation: InviteMutationReceipt;
}

export interface InviteMutationReceipt {
  stateChanged: boolean | "unknown";
  auditRecorded: boolean | "unknown";
  retrySafe: boolean | "unknown";
  receiptId: string | null;
  recovery: Array<{ kind: string; inviteId?: string | undefined }>;
}

export interface InviteSummary {
  id: string;
  kind: InviteKind;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  displayName: string | null;
  targetRoomId: string | null;
  targetRoomLabel: string | null;
  targetRoleSlug: string | null;
}

export interface InvitePage {
  returned: number;
  complete: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  continuationAvailable: boolean;
}

export interface InviteListOptions {
  all?: boolean | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface InviteListResult {
  invites: InviteSummary[];
  page: InvitePage;
}

export interface RevokeInviteResult {
  ok: true;
  mutation: InviteMutationReceipt;
}

const inviteMutationReceiptSchema = z.object({
  stateChanged: z.union([z.boolean(), z.literal("unknown")]),
  auditRecorded: z.union([z.boolean(), z.literal("unknown")]),
  retrySafe: z.union([z.boolean(), z.literal("unknown")]),
  receiptId: z.string().nullable(),
  recovery: z.array(z.object({
    kind: z.string().min(1),
    inviteId: z.string().optional(),
  }).strict()),
}).strict();

const createInviteResultSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  token: z.string().min(1),
  kind: z.literal("server"),
  expiresAt: z.string().datetime().nullable(),
  maxUses: z.number().int().positive().nullable(),
  mutation: inviteMutationReceiptSchema.optional(),
}).strict();

const inviteSummarySchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["server", "claim"]),
  maxUses: z.number().int().positive().nullable(),
  usedCount: z.number().int().nonnegative(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  displayName: z.string().nullable(),
  targetRoomId: z.string().nullable(),
  targetRoomLabel: z.string().nullable(),
  targetRoleSlug: z.string().nullable(),
}).strict();

const invitePageSchema = z.object({
  returned: z.number().int().nonnegative(),
  complete: z.boolean(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  continuationAvailable: z.boolean(),
}).strict();

const inviteListResultSchema = z.object({
  invites: z.array(inviteSummarySchema),
  page: invitePageSchema.optional(),
}).strict();

const revokeInviteResultSchema = z.object({
  ok: z.literal(true),
  mutation: inviteMutationReceiptSchema.optional(),
}).strict();

export interface InvitePreview {
  kind: string;
  inviterHandle: string;
  targetAgentDisplayName?: string | undefined;
  targetRoomLabel?: string | undefined;
  /** Role the invitee receives when joining the inviter's agent group (M-5). */
  targetRoleSlug?: string | undefined;
  targetRoleLabel?: string | undefined;
  expiresAt: string | null;
  usesRemaining: number | null;
}

/** Browser-owner protocol state projected by a raw claim capability. */
export type OwnerClaimContinuation = "new-owner" | "resume-owner";

/**
 * Strict body-only preview for hosted first-owner claims. `continuation` is
 * normalized at the client boundary: older servers omit it, which means the
 * new coordinator begins the new-owner branch rather than reviving legacy UI.
 */
export interface OwnerClaimPreview extends InvitePreview {
  kind: "claim";
  continuation: OwnerClaimContinuation;
}

export interface RedeemInput {
  handle: string;
  displayName: string;
  password: string;
  pin: string;
  email?: string | undefined;
  forcePasswordChange?: boolean | undefined;
}

export interface RedeemLogtoSession {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresIn: number;
  idToken?: string | undefined;
}

export interface RedeemResult {
  ok: boolean;
  recoveryCodes?: string[];
  landingRoomId?: string;
  sessionToken?: string;
  logtoSub?: string;
  logtoSession?: RedeemLogtoSession;
}

/** Strict, body-authorized result of direct first-owner seeding. */
export interface RedeemOwnerClaimResponse {
  schemaVersion: 1;
  state: "owner-bound";
  recoveryCodes: string[];
}

/**
 * Response shape. The route no longer mints a
 * Logto one-time-token — Logto OSS 1.x can't pre-fill `username` via
 * OTT, so the workbench stores the chosen handle in localStorage and
 * drives Logto sign-up via `@logto/react`'s standard `signIn({
 * extraParams: { first_screen: "register" } })`. After the OIDC
 * callback the workbench POSTs `state` to `/api/bind-logto-user`,
 * which unpacks the handle + invite token.
 *
 * The previous shape additionally carried `oneTimeToken`, `email`, and
 * `expiresAt`. Those fields are gone; renderers that still read them
 * will see `undefined` and should be updated.
 */
export interface PrepareLogtoSignupResponse {
  /** Opaque state to thread through Logto sign-up and post to /api/bind-logto-user. */
  state: string;
  /** Echo of the lowercased handle the user picked in the wizard preview step. */
  handle: string;
}

/**
 * Unified browser-owner preparation result. The server, not the Human,
 * resolves the handle for a durable reservation before ordinary Logto sign-in.
 */
export interface PrepareOwnerClaimAuthResponse {
  continuation: OwnerClaimContinuation;
  state: string;
  handle: string;
}

export interface BindLogtoUserResponse {
  ok: true;
  actorId: string;
  userId: string;
  requiresProfileCompletion: true;
}

export interface CompleteInviteProfileResponse {
  ok: true;
  recoveryCodes: string[];
  landingRoomId: string | null;
}

const bindLogtoUserResponseSchema: z.ZodType<BindLogtoUserResponse> = z.object({
  ok: z.literal(true),
  actorId: z.string(),
  userId: z.string(),
  requiresProfileCompletion: z.literal(true),
});

const completeInviteProfileResponseSchema: z.ZodType<CompleteInviteProfileResponse> = z.object({
  ok: z.literal(true),
  recoveryCodes: z.array(z.string()),
  landingRoomId: z.string().nullable(),
});

const redeemOwnerClaimResponseSchema: z.ZodType<RedeemOwnerClaimResponse> = z.object({
  schemaVersion: z.literal(1),
  state: z.literal("owner-bound"),
  recoveryCodes: z.array(z.string().regex(/^[a-f0-9]{24}$/u)).length(8)
    .refine((codes) => new Set(codes).size === codes.length),
}).strict();

const ownerClaimPreviewResponseSchema = z.object({
  kind: z.literal("claim"),
  inviterHandle: z.string(),
  expiresAt: z.string().nullable(),
  usesRemaining: z.number().int().nonnegative().nullable(),
  // Optional only for rolling rollback compatibility with an already-published
  // server. The returned public client type is normalized below.
  continuation: z.enum(["new-owner", "resume-owner"]).optional(),
}).strict();

const prepareOwnerClaimAuthResponseSchema: z.ZodType<PrepareOwnerClaimAuthResponse> = z.object({
  continuation: z.enum(["new-owner", "resume-owner"]),
  state: z.string().min(1),
  handle: z.string().min(1),
}).strict();

/** Logto access bundle from redeem flows. */
export const logtoSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  expiresIn: z.number(),
  idToken: z.string().optional(),
});

export type LogtoSession = z.infer<typeof logtoSessionSchema>;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Safe recovery text from the video preparation boundary, before any spend. */
export class VideoGenerationPreparationError extends ApiError {
  constructor(readonly code: "request_invalid" | "quote_unavailable", recovery: string) {
    super(422, recovery);
    this.name = "VideoGenerationPreparationError";
  }
}

/** Stable event-feed query/mutation failure returned by the server boundary. */
export class EventFeedApiError extends ApiError {
  constructor(status: number, readonly code: EventFeedErrorCode) {
    super(status, code);
    this.name = "EventFeedApiError";
  }
}

function eventFeedApiError(
  status: number,
  body: Record<string, unknown> & { error?: unknown },
): EventFeedApiError {
  const parsed = eventFeedErrorResponseSchema.safeParse(body);
  return new EventFeedApiError(
    status,
    parsed.success ? parsed.data.code : "invalid_input",
  );
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) {
    const delay = Math.round(seconds * 1_000);
    return Number.isFinite(delay) && delay >= 0 ? delay : undefined;
  }
  const dateMs = Date.parse(value);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - Date.now());
}

/** stable denial for either direction of an exact Human DM block. */
export class DirectHumanInteractionBlockedError extends ApiError {
  readonly code = "direct_human_interaction_blocked" as const;

  constructor() {
    super(403, "Direct messaging is unavailable for this person.");
    this.name = "DirectHumanInteractionBlockedError";
  }
}

/** Stable server denial when the authenticated Human cannot invoke Agents. */
export class AgentInvocationRequiredError extends ApiError {
  readonly code = "invoke_agents_required" as const;
  readonly capability = "invoke_agents" as const;

  constructor() {
    super(403, "invoke_agents_required");
    this.name = "AgentInvocationRequiredError";
  }
}

/** Content-free typed rejection from a Strict Shadow consumer boundary. */
export class StrictShadowProtectedContentRequiredError extends ApiError {
  readonly code = "strict_shadow_protected_content_required" as const;

  constructor(
    status: 409 | 425,
    readonly state: StrictShadowBoundaryState,
    readonly reason: StrictShadowBoundaryReason,
    readonly retryable: boolean,
  ) {
    super(
      status,
      `strict_shadow_protected_content_required:${state}:${reason}:${
        retryable ? "retryable" : "terminal"
      }`,
    );
    this.name = "StrictShadowProtectedContentRequiredError";
  }
}

function strictShadowProtectedContentRequiredError(
  status: 409 | 425,
  body: Record<string, unknown>,
): ApiError {
  const parsed = strictShadowProtectedContentRequiredErrorSchema.safeParse(body);
  return parsed.success
    ? new StrictShadowProtectedContentRequiredError(
      status,
      parsed.data.state,
      parsed.data.reason,
      parsed.data.retryable,
    )
    : new ApiError(status, "strict_shadow_protected_content_required");
}

/** Stable server denial when the authenticated Human cannot mutate Artifacts. */
export class ArtifactWriteRequiredError extends ApiError {
  readonly code = "write_artifacts_required" as const;
  readonly capability = "write_artifacts" as const;

  constructor() {
    super(403, "write_artifacts_required");
    this.name = "ArtifactWriteRequiredError";
  }
}

function isAgentInvocationRequiredBody(
  status: number,
  body: Record<string, unknown>,
): boolean {
  return status === 403 &&
    body["error"] === "invoke_agents_required" &&
    body["code"] === "invoke_agents_required" &&
    body["capability"] === "invoke_agents";
}

function isArtifactWriteRequiredBody(
  status: number,
  body: Record<string, unknown>,
): boolean {
  return status === 403 &&
    body["error"] === "write_artifacts_required" &&
    body["code"] === "write_artifacts_required" &&
    body["capability"] === "write_artifacts";
}

/**
 * A server-declared failure while binding or completing a claim/profile flow.
 *
 * The owner-claim coordinator must make recovery decisions from the server's
 * canonical result, not from a generic 409/"Conflict" string. `code` is the
 * exact server code when one was supplied; `serverCode` is null only for a
 * client-side fallback. That leaves a newer server's actionable error intact
 * during a rolling upgrade.
 */
export class OwnerClaimApiError extends ApiError {
  constructor(
    status: number,
    readonly code: string,
    readonly serverCode: string | null = code,
  ) {
    super(status, code);
    this.name = "OwnerClaimApiError";
  }
}

/**
 * A first-owner write whose final server result was not observable by this
 * client. It is deliberately not retried blindly: callers must reobserve the
 * canonical claim state before offering a safe next action.
 */
export class OwnerClaimAmbiguousWriteError extends OwnerClaimApiError {
  readonly recovery = "reobserve" as const;

  constructor(readonly operation: "bind" | "complete-profile" | "redeem") {
    super(0, "ambiguous_write", null);
    this.name = "OwnerClaimAmbiguousWriteError";
  }
}

function ownerClaimServerError(
  status: number,
  body: Record<string, unknown> & { error?: unknown },
  fallbackCode: string,
): OwnerClaimApiError {
  const rawCode = typeof body["code"] === "string"
    ? body["code"]
    : typeof body.error === "string"
      ? body.error
      : null;
  return new OwnerClaimApiError(status, rawCode ?? fallbackCode, rawCode);
}

/** Structured failure shared by browser, Electron, iOS, and Android. */
export class AgentPhotoLibraryApiError extends ApiError {
  readonly code: AgentPhotoLibraryErrorCodeDto;
  readonly retryable: boolean;
  readonly scope: AgentPhotoLibraryScopeDto | undefined;
  readonly current: AgentPhotoLibraryCurrentStateDto | undefined;

  constructor(input: {
    status: number;
    code: AgentPhotoLibraryErrorCodeDto;
    message: string;
    retryable: boolean;
    scope?: AgentPhotoLibraryScopeDto;
    current?: AgentPhotoLibraryCurrentStateDto;
  }) {
    super(input.status, input.message);
    this.name = "AgentPhotoLibraryApiError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.scope = input.scope;
    this.current = input.current;
  }
}

/** typed, content-free installation failure for Mobile reconciliation. */
export class MobilePushInstallationApiError extends ApiError {
  readonly code: MobilePushInstallationErrorCode;

  constructor(status: number, code: MobilePushInstallationErrorCode, message: string) {
    super(status, message);
    this.name = "MobilePushInstallationApiError";
    this.code = code;
  }
}

function mobilePushInstallationApiError(
  status: number,
  body: Record<string, unknown> & { error?: unknown },
): ApiError {
  const code = mobilePushInstallationErrorCodeSchema.safeParse(body["code"]);
  if (!code.success) {
    return new ApiError(
      status,
      typeof body.error === "string" && body.error.length > 0
        ? body.error
        : "Push notifications are unavailable",
    );
  }
  return new MobilePushInstallationApiError(
    status,
    code.data,
    typeof body.error === "string" && body.error.length > 0
      ? body.error
      : "Push notifications are unavailable",
  );
}

const pushInstallationStatusErrors: Record<
  number,
  (body: Record<string, unknown> & { error?: unknown }) => ApiError
> = {
  400: (body) => mobilePushInstallationApiError(400, body),
  403: (body) => mobilePushInstallationApiError(403, body),
  404: (body) => mobilePushInstallationApiError(404, body),
  409: (body) => mobilePushInstallationApiError(409, body),
  410: (body) => mobilePushInstallationApiError(410, body),
  429: (body) => mobilePushInstallationApiError(429, body),
  503: (body) => mobilePushInstallationApiError(503, body),
};

/**
 * The largest Artifact payload accepted by the bounded preview transport.
 * Preview consumers may choose a smaller budget for their own format, but may
 * not raise this acquisition ceiling.
 */
const MAX_WORKSPACE_ARTIFACT_STREAM_BYTES = 100 * 1024 * 1024;

export type WorkspaceArtifactBytesOptions = {
  roomId?: string;
  /** Cancels both fetch and an already-open response reader. */
  signal?: AbortSignal;
  /**
   * Size obtained from already-authorized Artifact metadata. It is checked
   * before fetching and again after the response completes.
   */
  expectedBytes?: number;
  /** Defaults to {@link MAX_WORKSPACE_ARTIFACT_STREAM_BYTES}. */
  maxBytes?: number;
};

export type WorkspaceArtifactStreamErrorCode =
  | "redirect"
  | "response"
  | "content_length"
  | "truncated"
  | "size";

/** A bounded, body-free failure from the authenticated Artifact byte route. */
class WorkspaceArtifactStreamError extends Error {
  constructor(
    readonly code: WorkspaceArtifactStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceArtifactStreamError";
  }
}

function createAbortError(): DOMException {
  return new DOMException("The Artifact byte request was aborted.", "AbortError");
}

function validByteCount(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkspaceArtifactStreamError("size", `${label} must be a non-negative integer.`);
  }
  return value;
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw)) {
    throw new WorkspaceArtifactStreamError("content_length", "Artifact response has an invalid content length.");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new WorkspaceArtifactStreamError("content_length", "Artifact response has an invalid content length.");
  }
  return parsed;
}

/**
 * Fixed-size staging blocks keep unknown-length responses bounded without
 * retaining every arbitrary network chunk. A single exact ArrayBuffer is made
 * only after the complete response passes its integrity checks.
 */
class BoundedByteCollector {
  private static readonly blockBytes = 64 * 1024;
  private readonly blocks: Uint8Array[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(chunk: Uint8Array): void {
    if (chunk.byteLength > this.maxBytes - this.bytes) {
      throw new WorkspaceArtifactStreamError("size", "Artifact is too large to preview.");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      const block = this.blocks.at(-1);
      const used = this.bytes % BoundedByteCollector.blockBytes;
      if (block === undefined || used === 0) {
        this.blocks.push(
          new Uint8Array(
            Math.min(BoundedByteCollector.blockBytes, this.maxBytes - this.bytes),
          ),
        );
      }
      const target = this.blocks.at(-1)!;
      const targetOffset = this.bytes % BoundedByteCollector.blockBytes;
      const count = Math.min(target.byteLength - targetOffset, chunk.byteLength - offset);
      target.set(chunk.subarray(offset, offset + count), targetOffset);
      this.bytes += count;
      offset += count;
    }
  }

  toArrayBuffer(): ArrayBuffer {
    const output = new Uint8Array(this.bytes);
    let offset = 0;
    for (const block of this.blocks) {
      const count = Math.min(block.byteLength, this.bytes - offset);
      if (count === 0) break;
      output.set(block.subarray(0, count), offset);
      offset += count;
    }
    return output.buffer;
  }

  get byteLength(): number {
    return this.bytes;
  }
}

/** complete notification state cannot fit the fixed v1 detail bound. */
export class NotificationStateTooLargeApiError extends ApiError {
  readonly code = "notification_state_too_large";

  constructor() {
    super(413, "notification_state_too_large");
    this.name = "NotificationStateTooLargeApiError";
  }
}

/** stale optimistic message edit with the latest safe canonical value. */
export class MessageEditConflictError extends ApiError {
  constructor(readonly current: EditableRoomMessageConflictDto) {
    super(409, "message_edit_conflict");
    this.name = "MessageEditConflictError";
  }
}

export interface UnauthorizedResponse {
  readonly url: string;
  readonly method: string;
  readonly error: string | null;
  readonly retryAttempted: boolean;
}

export type UnauthorizedResponseHandler = (
  response: UnauthorizedResponse,
) => string | null | void | Promise<string | null | void>;

export type DeviceAdmissionRequiredHandler = (code:
  | "device_admission_required"
  | "device_admission_expired"
  | "device_removed_or_stale"
  | "device_admission_unavailable"
) => void;

/** Fetch-compatible transport seam without Bun's non-callable `preconnect`. */
export type NautiloApiFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** password login rejected (HTTP 401). */
export class InvalidCredentialsError extends ApiError {
  constructor(message = "invalid_credentials") {
    super(401, message);
    this.name = "InvalidCredentialsError";
  }
}

/** Current password mismatch on change (HTTP 422). */
export class WrongCurrentPasswordError extends ApiError {
  constructor(message = "Current password is incorrect.") {
    super(422, message);
    this.name = "WrongCurrentPasswordError";
  }
}

/** rate-limited password attempts (HTTP 423). */
export class LockedOutError extends ApiError {
  readonly retryAfterSeconds?: number | undefined;
  constructor(message = "locked_out", retryAfterSeconds?: number) {
    super(423, message);
    this.name = "LockedOutError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** cannot remove the last owner from the owners Group (HTTP 409). */
export class LastOwnerError extends ApiError {
  constructor(message = "last_owner") {
    super(409, message);
    this.name = "LastOwnerError";
  }
}

/** self-join rejected because the room is not open (HTTP 403). */
export class RoomNotOpenError extends ApiError {
  constructor(message = "not_open") {
    super(403, message);
    this.name = "RoomNotOpenError";
  }
}

/** workspace artifact save conflict (HTTP 409 external_change). */
export class ConflictError extends Error {
  constructor(public readonly currentSha256: string | null) {
    super("Workspace artifact changed externally");
    this.name = "ConflictError";
  }
}

/**
 * `DELETE /api/memory/:id?mode=hard` rejected because the
 * memory is shared across multiple namespaces. The server returns the
 * namespace count, the namespace IDs, and a hint telling the caller to retry
 * with `confirmShared=true` (namespace mode) — scope mode omits the hint.
 * Mirrors `MemoryHardDeleteConflictError` in
 * `apps/workbench/src/lib/memory-api.ts` and the 409 body in
 * `packages/server/src/routes/memory.ts`. 400/403/404 stay `ApiError`.
 */
export class MemoryHardDeleteConflictError extends Error {
  readonly namespaceCount: number;
  readonly namespaceIds: string[];
  readonly hint?: string;

  constructor(body: {
    error?: string;
    namespaceCount: number;
    namespaceIds: string[];
    hint?: string;
  }) {
    super(body.error ?? "Memory is shared across multiple namespaces");
    this.name = "MemoryHardDeleteConflictError";
    this.namespaceCount = body.namespaceCount;
    this.namespaceIds = body.namespaceIds;
    if (body.hint !== undefined) this.hint = body.hint;
  }
}

/** workspace artifact patch apply conflict (HTTP 409). */
export class DocumentPatchConflictError extends Error {
  constructor(public readonly rejection: DocumentPatchRejected) {
    super(`Document patch rejected: ${rejection.kind}`);
    this.name = "DocumentPatchConflictError";
  }
}

export class LiveProposalAcceptanceError extends ApiError {
  constructor(
    status: number,
    readonly code: ApplyAcceptedLiveProposalErrorCode,
  ) {
    super(status, code);
    this.name = "LiveProposalAcceptanceError";
  }
}

export interface InvitableAgent {
  agentId: string;
  handle: string;
  displayName: string;
}

export interface InvitableRoom {
  roomId: string;
  label: string;
  type: string;
}

/** How to attach auth (and when to add `Content-Type: application/json` for JSON bodies). */
type AuthMode = "none" | "session" | "session-fresh";

/**
 * Maps HTTP status codes to typed errors (e.g. 401 → InvalidCredentialsError).
 * Mapper receives the parsed error JSON object (including optional `retryAfterSeconds`, etc.).
 *
 * `error` is typed as `unknown` because the helper does not validate the body
 * shape — the JSON.parse fallback in `request<T>` returns `{}` on parse failure
 * and the server contract for `error` is "string when present" but a malformed
 * response could send anything. Mappers MUST narrow with a `typeof` guard
 * before reading `error` as a string.
 */
type StatusErrorMap = Record<
  number,
  (body: Record<string, unknown> & { error?: unknown }) => Error
>;

/**
 * Options for {@link NautiloApiClient.request}. Intended for phased migration of all
 * internal `_fetch` JSON call sites.
 */
interface RequestOpts<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path beginning with `/` (joined with `this.baseUrl`). */
  path: string;
  /** Default `"session"` — bearer from `authHeaders()` / `jsonHeaders()` rules below. */
  auth?: AuthMode;
  /** When set, serialized with `JSON.stringify` and sent as the request body. */
  body?: unknown;
  /** When set, validates the success JSON with Zod before returning. */
  schema?: z.ZodType<T>;
  /** The endpoint succeeds with an intentionally empty 204 response. */
  emptyResponse?: boolean;
  statusErrors?: StatusErrorMap;
  /** Message prefix for generic `ApiError` when `!res.ok` and no typed mapper matches. */
  defaultErrorPrefix?: string;
  /** Extra request headers merged after auth/content-type headers (e.g. a per-request bearer). */
  headers?: Record<string, string>;
  /** Opt out only when a caller needs an independent GET lifetime/fence. */
  singleFlight?: boolean;
  /** Abort this transport attempt. Signalled GETs deliberately bypass shared single-flight. */
  signal?: AbortSignal;
}

export interface ConditionalReadOptions {
  /** Opaque validator returned by an earlier response from the same representation scope. */
  ifNoneMatch?: string;
}

export type ConditionalReadResult<T> =
  | { readonly status: 200; readonly body: T; readonly etag: string | null }
  | { readonly status: 304; readonly etag: string | null };

export interface ArtifactDto {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
  revision: number;
  updatedAt: string;
  createdAt: string;
  namespaceIds: string[];
  canWrite: boolean;
}

export interface SharedWorkspaceArtifactDto {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
  revision: number;
  updatedAt: string;
  sharedAt: string;
  sharedBy: string;
  roomId: string;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactDto[];
}

export interface ListArtifactPageResponse extends ListArtifactsResponse {
  nextCursor: string | null;
}

const contentAccessUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "Must be a canonical UUID",
);

const contentAccessObjectSchema = z.object({
  kind: z.enum(["memory", "artifact"]),
  id: contentAccessUuidSchema,
}).strict();

const contentAccessPrepareChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grant_people"),
    selectedUserIds: z.array(contentAccessUuidSchema).min(1),
  }).strict(),
  z.object({ kind: z.literal("grant_room"), targetRoomId: contentAccessUuidSchema }).strict(),
  z.object({ kind: z.literal("remove_person"), actorId: contentAccessUuidSchema }).strict(),
  z.object({ kind: z.literal("detach_room"), targetRoomId: contentAccessUuidSchema }).strict(),
  z.object({ kind: z.literal("make_private") }).strict(),
]);

const contentAccessNormalizedChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grant_people"),
    selectedActorIds: z.array(contentAccessUuidSchema).min(1),
  }).passthrough(),
  z.object({ kind: z.literal("grant_room"), targetRoomId: contentAccessUuidSchema }).passthrough(),
  z.object({ kind: z.literal("remove_person"), actorId: contentAccessUuidSchema }).passthrough(),
  z.object({ kind: z.literal("detach_room"), targetRoomId: contentAccessUuidSchema }).passthrough(),
  z.object({ kind: z.literal("make_private") }).passthrough(),
]);

const contentAccessCommitChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("grant_people"),
    selectedActorIds: z.array(contentAccessUuidSchema).min(1),
  }).strict(),
  z.object({ kind: z.literal("grant_room"), targetRoomId: contentAccessUuidSchema }).strict(),
  z.object({ kind: z.literal("remove_person"), actorId: contentAccessUuidSchema }).strict(),
  z.object({ kind: z.literal("detach_room"), targetRoomId: contentAccessUuidSchema }).strict(),
  z.object({ kind: z.literal("make_private") }).strict(),
]);

export const contentAccessPrepareRequestSchema = z.object({
  operationId: contentAccessUuidSchema,
  object: contentAccessObjectSchema,
  change: contentAccessPrepareChangeSchema,
}).strict();

export const contentAccessNormalizedCommandSchema = z.object({
  operationId: contentAccessUuidSchema,
  object: contentAccessObjectSchema.passthrough(),
  change: contentAccessNormalizedChangeSchema,
}).passthrough();

export const contentAccessCommitRequestSchema = z.object({
  operationId: contentAccessUuidSchema,
  object: contentAccessObjectSchema,
  change: contentAccessCommitChangeSchema,
  previewToken: z.string().min(1),
}).strict();

export const contentAccessPreparedResponseSchema = z.object({
  outcome: z.literal("prepared"),
  command: contentAccessNormalizedCommandSchema,
  previewToken: z.string().min(1),
  expiresAt: z.number().int().nonnegative(),
  preview: z.object({
    humanActorIds: z.array(contentAccessUuidSchema),
    people: z.array(z.object({ actorId: contentAccessUuidSchema, displayName: z.string(),
      userHandle: z.string().nullable() })).optional(),
    targetRoomId: contentAccessUuidSchema.optional(),
    targetRoomLabel: z.string().optional(),
    publicRoom: z.boolean(),
    skippedAttachmentCount: z.number().int().nonnegative(),
  }).passthrough(),
}).passthrough();

export const contentAccessReceiptSchema = z.object({
  operationId: contentAccessUuidSchema,
  outcome: z.enum(["applied", "already_applied", "partial"]),
  stateChanged: z.boolean(),
  originalStateChanged: z.boolean(),
  replayed: z.boolean(),
  attachedCount: z.number().int().nonnegative(),
  detachedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
}).passthrough();

export const contentAccessSummarySchema = z.object({
  object: contentAccessObjectSchema,
  people: z.array(z.object({ actorId: contentAccessUuidSchema, displayName: z.string(),
    userHandle: z.string().nullable(), canRemove: z.boolean(),
    sources: z.array(z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("immutable"), boundaryCount: z.number().int().positive() }).passthrough(),
      z.object({ kind: z.literal("room"), roomId: contentAccessUuidSchema, label: z.string(), publicRoom: z.boolean() }).passthrough(),
    ])),
  }).passthrough()),
  rooms: z.array(z.object({ roomId: contentAccessUuidSchema, label: z.string(),
    publicRoom: z.boolean(), canDetach: z.boolean() }).passthrough()),
  otherAccessCount: z.number().int().nonnegative(),
}).passthrough();
export type ContentAccessSummary = z.infer<typeof contentAccessSummarySchema>;

export const contentAccessFailureSchema = z.object({
  error: z.string().min(1),
  outcome: z.enum(["denied", "stale", "failed"]),
  stateChanged: z.union([z.literal(false), z.literal("unknown")]),
  receiptPersisted: z.boolean(),
  recovery: z.enum(["prepare_again", "retry_operation", "retry_receipt"]),
}).passthrough();

export type ContentAccessPrepareRequest = z.infer<typeof contentAccessPrepareRequestSchema>;
export type ContentAccessNormalizedCommand = z.infer<typeof contentAccessNormalizedCommandSchema>;
export type ContentAccessCommitRequest = z.infer<typeof contentAccessCommitRequestSchema>;
export type ContentAccessPreparedResponse = z.infer<typeof contentAccessPreparedResponseSchema>;
export type ContentAccessReceipt = z.infer<typeof contentAccessReceiptSchema>;
export type ContentAccessFailure = z.infer<typeof contentAccessFailureSchema>;

export const ordinaryContentAccessRecoveryCoordinateSchema = z.object({
  originalJobId: z.string().min(1),
  checkpointId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  agentId: z.string().min(1),
}).strict();

export const ordinaryContentAccessRecoveriesSchema = z.object({
  recoveries: z.array(ordinaryContentAccessRecoveryCoordinateSchema),
  nextCursor: z.string().min(1).nullable().optional(),
}).strict();

export const ordinaryContentAccessRecoveryResultSchema = z.object({
  outcome: z.enum(["completed", "busy", "unavailable", "retry_required"]),
}).strict();

export type OrdinaryContentAccessRecoveryCoordinate = z.infer<
  typeof ordinaryContentAccessRecoveryCoordinateSchema
>;
export type OrdinaryContentAccessRecoveries = z.infer<
  typeof ordinaryContentAccessRecoveriesSchema
>;
export type OrdinaryContentAccessRecoveryResult = z.infer<
  typeof ordinaryContentAccessRecoveryResultSchema
>;

export const taskContentAccessRecoveryCoordinateSchema = z.object({
  taskId: z.string().min(1),
  taskRunId: z.string().min(1),
  checkpointId: z.string().min(1),
  toolCallId: z.string().min(1),
}).strict();

export const taskContentAccessRecoveryResponseSchema = z.object({
  recovery: taskContentAccessRecoveryCoordinateSchema.nullable(),
}).strict();

export const taskContentAccessRecoveryResultSchema = z.object({
  outcome: z.enum(["completed", "busy", "unavailable", "retry_required"]),
}).strict();

export type TaskContentAccessRecoveryCoordinate = z.infer<
  typeof taskContentAccessRecoveryCoordinateSchema
>;
export type TaskContentAccessRecoveryResponse = z.infer<
  typeof taskContentAccessRecoveryResponseSchema
>;
export type TaskContentAccessRecoveryResult = z.infer<
  typeof taskContentAccessRecoveryResultSchema
>;

export interface ContentAccessRequestOptions {
  roomId: string;
  signal?: AbortSignal;
}

/** Typed content-access denial, staleness, or indeterminate commit result. */
export class ContentAccessApiError extends ApiError {
  constructor(
    status: 403 | 409 | 503,
    message: string,
    readonly outcome: ContentAccessFailure["outcome"],
    readonly stateChanged: ContentAccessFailure["stateChanged"],
    readonly receiptPersisted: boolean,
    readonly recovery: ContentAccessFailure["recovery"],
  ) {
    super(status, message);
    this.name = "ContentAccessApiError";
  }
}

function contentAccessError(
  status: 403 | 409 | 503,
  body: Record<string, unknown> & { error?: unknown },
): Error {
  const failure = contentAccessFailureSchema.safeParse(body);
  if (!failure.success) {
    return new ApiError(
      status,
      typeof body.error === "string" && body.error.length > 0
        ? body.error
        : `Content access request failed: ${status}`,
    );
  }
  return new ContentAccessApiError(
    status,
    failure.data.error,
    failure.data.outcome,
    failure.data.stateChanged,
    failure.data.receiptPersisted,
    failure.data.recovery,
  );
}

const contentAccessStatusErrors: StatusErrorMap = {
  403: (body) => contentAccessError(403, body),
  409: (body) => contentAccessError(409, body),
  503: (body) => contentAccessError(503, body),
};

function contentAccessCommitRequest(
  command: ContentAccessNormalizedCommand,
  previewToken: string,
): ContentAccessCommitRequest {
  let change: ContentAccessCommitRequest["change"];
  switch (command.change.kind) {
    case "grant_people":
      change = {
        kind: "grant_people",
        selectedActorIds: [...command.change.selectedActorIds],
      };
      break;
    case "grant_room":
    case "detach_room":
      change = { kind: command.change.kind, targetRoomId: command.change.targetRoomId };
      break;
    case "remove_person":
      change = { kind: "remove_person", actorId: command.change.actorId };
      break;
    case "make_private":
      change = { kind: "make_private" };
      break;
  }
  return contentAccessCommitRequestSchema.parse({
    operationId: command.operationId,
    object: { kind: command.object.kind, id: command.object.id },
    change,
    previewToken,
  });
}

const workspaceArtifactDtoSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  path: z.string(),
  mimeType: z.string().min(1),
  size: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
  createdAt: z.string().min(1),
  namespaceIds: z.array(z.string().min(1)),
  canWrite: z.boolean(),
}).passthrough();

const listArtifactPageResponseSchema = z.object({
  artifacts: z.array(workspaceArtifactDtoSchema),
  nextCursor: z.string().min(1).nullable(),
}).passthrough();

export interface SlideTemplateSummaryDto {
  id: string;
  name: string;
}

export interface SlideTemplateListPageDto {
  templates: SlideTemplateSummaryDto[];
  nextCursor: string | null;
}

export interface SlideTemplateContentDto {
  content: string;
}

/**
 * one discussion room attached to a workspace artifact.
 * Mirrors the server route `GET /api/workspace/artifacts/:id/discussion-rooms`
 * in `packages/server/src/routes/workspace-artifacts.ts`. `kind` is the
 * server's room-kind string (e.g. `"private"` / `"group"`); no namespace ids
 * are exposed here.
 */
export interface ArtifactDiscussionRoom {
  id: string;
  label: string;
  kind: string;
}

/** `{ rooms: [...] }` envelope for the discussion-rooms read. */
export interface ListArtifactDiscussionRoomsResponse {
  rooms: ArtifactDiscussionRoom[];
}

export interface ListWorkspaceArtifactsOptions {
  pathPrefix?: string;
  limit?: number;
  roomId?: string;
}

export interface ListWorkspaceArtifactPageOptions {
  pathPrefix?: string;
  limit?: number;
  roomId?: string;
  cursor?: string;
  signal?: AbortSignal;
}

export interface ListWorkspaceArtifactsCompleteOptions {
  pathPrefix?: string;
  pageSize?: number;
  roomId?: string;
  signal?: AbortSignal;
}

export type WorkspaceArtifactEvent =
  | {
      type: "changed";
      id: string;
      artifactId: string;
      path: string;
      clientMutationId?: string | undefined;
      reloadRequired?: boolean | undefined;
    }
  | { type: "renamed"; id: string; oldPath: string; newPath: string }
  | { type: "deleted"; id: string; artifactId: string }
  | {
      type: "document.patch.applied";
      target: DocumentPatchEvent["target"];
      patchId: string;
      requestId?: string;
      revision: number | null;
      sha256: string;
      previousRevision: number | null;
      previousSha256: string;
      patch: DocumentPatchEvent["patch"];
      author: DocumentPatchEvent["author"];
      clientMutationId?: string;
      rebased?: boolean;
    }
  /**
   * Durable mutation truth emitted after the coordinator has committed the
   * Workspace artifact update. Consumers must use `editorSave.anchoredPatch`
   * when present and safely reload for snapshots or non-editor mutations.
   */
  | DocumentMutationCommittedEvent;

export type {
  DocumentPatchApplied,
  DocumentPatchEvent,
  DocumentPatchRejected,
  DocumentPatchRequest,
};

export interface MiniAppCreateActionDto {
  id: string;
  label: string;
  defaultFilename: string;
  mimeType: string;
  targetSurfaces: Array<"workspace" | "currentFolder">;
  template: {
    kind: "file";
    path: string;
  };
  openAfterCreate?: boolean;
}

export interface MiniAppContentAssociationDto {
  id: string;
  kind: "html-script-json";
  scriptId: string;
  scriptType: string;
  match: Record<string, string | number | boolean | null>;
}

export interface MiniAppConversionImportDto {
  id: string;
  label: string;
  from: {
    extensions?: string[];
    mimeTypes?: string[];
  };
  sourceSurfaces: Array<"workspace" | "currentFolder">;
  tool: string;
  target: {
    surface: "workspace" | "currentFolder";
    extension: string;
  };
  openAfterImport?: boolean;
}

export interface MiniAppPreparedExport {
  content: string;
  encoding: "base64";
  mimeType: string;
  byteLength: number;
  sourceSha256: string;
  warnings: string[];
}

export interface MiniAppConversionExportDto {
  /** Offer current-chat or source-location placement during export confirmation. */
  selectWorkspaceDestination?: boolean;
  /** Render in the open app, then validate and save through its server conversion. */
  prepareInApp?: boolean;
  id: string;
  label: string;
  to: {
    extension: string;
    mimeType: string;
  };
  tool: string;
  targetSurfaces: Array<"workspace" | "currentFolder">;
}

export interface MiniAppConversionsDto {
  import?: MiniAppConversionImportDto[];
  export?: MiniAppConversionExportDto[];
}

export interface PublicMiniAppDto {
  id: string;
  name: string | null;
  /** optional one-line description from the manifest (Apps panel rows). */
  description: string | null;
  display?: {
    groupId?: string;
    groupName?: string;
    groupOrder?: number;
    appOrder?: number;
    defaultCollapsed?: boolean;
  } | null;
  version: string | null;
  status: "ready" | "invalid_manifest" | "needs_dependencies";
  /** ISO "installed at" (manifest mtime proxy) for Apps-page sorting. */
  installedAt: string | null;
  sourceHash: string | null;
  /** false when the operator disabled the app. Disabled apps stay
   * installed but are hidden from file associations + the agent tool catalog. */
  enabled: boolean;
  fileAssociations: {
    extensions?: string[];
    mimeTypes?: string[];
  } | null;
  createActions?: MiniAppCreateActionDto[] | null;
  contentAssociations?: MiniAppContentAssociationDto[] | null;
  conversions?: MiniAppConversionsDto | null;
  canEditSource: boolean;
}

export interface ListMiniAppsResponse {
  apps: PublicMiniAppDto[];
}

export interface MiniAppRuntimeResponse {
  appId: string;
  sourceHash: string;
  srcDoc: string;
  /** Server-derived first-party services; absent for third-party or edited app source. */
  hostCapabilities?: { assets?: true; assetReadRaster?: true; mediaProxy?: true; videoGeneration?: true };
  manifest: {
    id: string;
    name: string;
    version: string;
    fileAssociations: NonNullable<PublicMiniAppDto["fileAssociations"]>;
    capabilities: unknown;
    agent?: unknown;
    liveReview?: { enabled: true };
    conversions?: MiniAppConversionsDto;
  };
}

export interface MiniAppConversionRunRequest {
  /** Explicit placement within the caller's existing authority; never a namespace ID. */
  workspaceDestination?: "current" | "source";
  preparedExport?: MiniAppPreparedExport;
  actionId: string;
  direction: "import" | "export";
  source: { surface: "workspace" | "currentFolder"; path: string };
  target?: { surface: "workspace" | "currentFolder"; path: string };
  /**
   * Optional Design SVG selection. The conversion route accepts this only for
   * Nautilo Design's `export-svg` action and validates handle syntax there.
   */
  scope?: { pageHandle: string; nodeHandles?: string[] };
  /**
   * Active Room for a workspace source. The conversion route uses this to
   * resolve the same namespace envelope that authorized the opened artifact,
   * so derived workspace artifacts stay beside their source.
   */
  roomId?: string;
  /** Advisory absolute paths for zone resolution when a surface is currentFolder. */
  currentFolder?: string;
  workspacePath?: string;
  /**
   * overwrite an existing target instead of getting a conflict result.
   * Default false: the server returns a `status:"conflict"` tool result so the
   * UI can prompt overwrite / rename / cancel.
   */
  overwrite?: boolean;
  /** Source hash acknowledged after reviewing conversion fidelity warnings. */
  acknowledgedSourceSha256?: string;
}

export interface MiniAppConversionRunResponse {
  ok: true;
  /** Raw result from the referenced conversion tool (shape is tool-defined). */
  result: unknown;
}

export interface MiniAppCreateTemplateResponse {
  appId: string;
  actionId: string;
  content: string;
  mimeType: string;
  sha256: string;
}

export interface AppSourceTreeEntry {
  path: string;
  kind: "file" | "directory";
  size?: number;
}

export interface AppSourceTreeResponse {
  files: AppSourceTreeEntry[];
}

export interface AppSourceFileResponse {
  path: string;
  content: string;
  sha256: string;
}

export interface SaveAppSourceFileRequest {
  content: string;
  baseSha256: string;
}

export interface SaveAppSourceFileResponse {
  ok: true;
  path: string;
  sha256: string;
  sourceHash: string;
  status: "ready" | "invalid_manifest" | "needs_dependencies";
}

export type MiniAppSourceEvent =
  | { type: "changed"; appId: string; sourceHash: string }
  | { type: "status"; appId: string; status: string };

/** optional desktop bridge for artifact export (see `saveArtifactToDisk`). */
export type NautiloDesktopArtifactSaveBridge = {
  dialog?: {
    showSaveDialog?: (opts: { defaultPath?: string }) => Promise<{
      canceled: boolean;
      filePath?: string;
    }>;
  };
  fs?: {
    writeFileBytes?: (filePath: string, data: ArrayBuffer) => Promise<void>;
  };
};

/** Minimal DOM surface for anchor download (api-client avoids `lib: ["dom"]`). */
type AnchorDownloadDocument = {
  createElement: (tag: string) => {
    href: string;
    download: string;
    style: { display: string };
    click: () => void;
  };
  body: {
    appendChild: (n: unknown) => void;
    removeChild: (n: unknown) => void;
  };
};

function readNautiloDesktopBridge(): NautiloDesktopArtifactSaveBridge | undefined {
  const win = (globalThis as unknown as { window?: { nautiloDesktop?: NautiloDesktopArtifactSaveBridge } })
    .window;
  return win?.nautiloDesktop;
}

function readBrowserDocument(): AnchorDownloadDocument | undefined {
  return (globalThis as unknown as { document?: AnchorDownloadDocument }).document;
}

/**
 * persist artifact bytes locally. Uses native save only when
 * both `showSaveDialog` and `fs.writeFileBytes` are exposed on
 * `window.nautiloDesktop` (preload is not wired yet).
 * Otherwise triggers a download via `URL.createObjectURL` + anchor click.
 */
export async function saveArtifactToDisk(
  data: Blob | ArrayBuffer,
  suggestedFilename: string,
): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data]);
  const bytes = await blob.arrayBuffer();
  const desk = readNautiloDesktopBridge();
  const pickPath = desk?.dialog?.showSaveDialog;
  const writeBytes = desk?.fs?.writeFileBytes;
  if (typeof pickPath === "function" && typeof writeBytes === "function") {
    const picked = await pickPath({ defaultPath: suggestedFilename });
    if (picked.canceled) return;
    const fp = picked.filePath;
    if (typeof fp === "string" && fp.length > 0) {
      await writeBytes(fp, bytes);
      return;
    }
  }
  const doc = readBrowserDocument();
  if (doc === undefined) {
    throw new ApiError(500, "saveArtifactToDisk requires a browser environment (document is missing).");
  }
  const objectUrl = URL.createObjectURL(blob);
  const anchor = doc.createElement("a");
  anchor.href = objectUrl;
  anchor.download = suggestedFilename;
  anchor.style.display = "none";
  doc.body.appendChild(anchor);
  anchor.click();
  doc.body.removeChild(anchor);
  URL.revokeObjectURL(objectUrl);
}

/** Representation-affecting request headers included in GET single-flight keys. */
const GET_SINGLE_FLIGHT_REPR_HEADERS = [
  "accept",
  "accept-language",
  "if-none-match",
  "if-match",
] as const;

export class NautiloApiClient {
  private token: string | null = null;
  private tokenProvider: (() => Promise<string | null>) | null = null;
  private unauthorizedResponseHandler: UnauthorizedResponseHandler | null = null;
  private unauthorizedRecoveryInFlight: Promise<string | null | void> | null = null;
  private unauthorizedRecoveryGeneration: number | null = null;
  /** bumps only when the normalized bearer value changes in {@link setToken}. */
  private credentialGeneration = 0;
  private readonly inFlightGets = new Map<string, Promise<unknown>>();
  private readonly unixSocketPath: string | undefined;
  private readonly fetchImpl: NautiloApiFetch | undefined;
  private readonly workspaceArtifactObjectUrlCache = new Map<string, string>();
  private notificationStateInvalidated: (() => void) | null = null;
  private actionCapabilityDenied: (() => void) | null = null;
  private deviceAdmissionRequired: DeviceAdmissionRequiredHandler | null = null;

  /**
   * Accept an optional `unixSocketPath`. When set,
   * every internal fetch call routes through `_fetch()`, which forwards
   * Bun's `unix:` request init so HTTP requests against `baseUrl =
   * "http://localhost"` are tunnelled over the local Unix socket forwarder
   * (`~/.nautilo<inst>/server.sock`) instead of `localhost:80`. Pass
   * `transport.unixSocketPath` from `resolveServerForCommand()` /
   * `resolveTransport()` for active local profiles. When absent, behaviour
   * is identical to plain `fetch()`.
   */
  constructor(
    private readonly baseUrl: string,
    opts?: {
      unixSocketPath?: string | undefined;
      fetchImpl?: NautiloApiFetch | undefined;
    },
  ) {
    if (opts?.unixSocketPath !== undefined && opts.fetchImpl !== undefined) {
      throw new Error("unixSocketPath and fetchImpl are mutually exclusive transports");
    }
    this.unixSocketPath = opts?.unixSocketPath;
    this.fetchImpl = opts?.fetchImpl;
  }

  /** Typed Connections administration; server derives relay/profile authority. */
  readonly codex = {
    summary: (relayId?: string | null) => this.request({ path: "/api/codex", ...codexHostRequest(relayId), schema: codexConnectionSummarySchema, defaultErrorPrefix: "GET /api/codex" }),
    inspectRuntime: (relayId?: string | null) => this.request({ method: "POST", path: "/api/codex/runtime/inspect", ...codexHostRequest(relayId), body: {}, schema: codexRuntimeSummarySchema, defaultErrorPrefix: "POST /api/codex/runtime/inspect" }),
    installRuntime: (relayId?: string | null) => this.request({ method: "POST", path: "/api/codex/runtime/install", ...codexHostRequest(relayId), body: {}, schema: codexRuntimeSummarySchema, defaultErrorPrefix: "POST /api/codex/runtime/install" }),
    cancelRuntimeInstall: (relayId?: string | null) => this.request({ method: "POST", path: "/api/codex/runtime/cancel", ...codexHostRequest(relayId), body: {}, schema: codexRuntimeSummarySchema, defaultErrorPrefix: "POST /api/codex/runtime/cancel" }),
    activateRuntime: (runtimeGeneration: number, relayId?: string | null) => this.request({ method: "POST", path: "/api/codex/runtime/activate", ...codexHostRequest(relayId), body: { runtimeGeneration }, schema: codexRuntimeSummarySchema, defaultErrorPrefix: "POST /api/codex/runtime/activate" }),
    createProfile: (relayId?: string | null) => this.request({ method: "POST", path: "/api/codex/profiles", ...codexHostRequest(relayId), body: {}, schema: codexProfileConnectSchema, defaultErrorPrefix: "POST /api/codex/profiles" }),
    renameProfile: (profileId: string, label: string, expectedRevision: number) => this.request({ method: "PATCH", path: `/api/codex/profiles/${encodeURIComponent(profileId)}`, body: { label, expectedRevision }, schema: codexProfileSchema, defaultErrorPrefix: "PATCH /api/codex/profiles" }),
    startLogin: (profileId: string) => this.request({ method: "POST", path: `/api/codex/profiles/${encodeURIComponent(profileId)}/login`, body: {}, schema: codexLoginStartSchema, defaultErrorPrefix: "POST /api/codex/profiles/login" }),
    cancelLogin: (profileId: string, loginRef: string) => this.request({ method: "POST", path: `/api/codex/profiles/${encodeURIComponent(profileId)}/login/cancel`, body: { loginRef }, schema: codexAccountLoginCancelSchema, defaultErrorPrefix: "POST /api/codex/profiles/login/cancel" }),
    readAccount: (profileId: string) => this.request({ method: "POST", path: `/api/codex/profiles/${encodeURIComponent(profileId)}/account`, body: {}, schema: codexAccountStatusSchema, defaultErrorPrefix: "POST /api/codex/profiles/account" }),
    logout: (profileId: string) => this.request({ method: "POST", path: `/api/codex/profiles/${encodeURIComponent(profileId)}/logout`, body: {}, schema: codexAccountStatusSchema, defaultErrorPrefix: "POST /api/codex/profiles/logout" }),
    removeProfile: (profileId: string, expectedRevision: number): Promise<void> => this.request<void>({ method: "DELETE", path: `/api/codex/profiles/${encodeURIComponent(profileId)}`, body: { expectedRevision }, emptyResponse: true, defaultErrorPrefix: "DELETE /api/codex/profiles" }),
    usage: (profileId: string) => this.request({ path: `/api/codex/profiles/${encodeURIComponent(profileId)}/usage`, schema: codexUsageSchema, defaultErrorPrefix: "GET /api/codex/profiles/usage" }),
    rateLimits: (profileId: string) => this.request({ path: `/api/codex/profiles/${encodeURIComponent(profileId)}/rate-limits`, schema: codexRateLimitsSchema, defaultErrorPrefix: "GET /api/codex/profiles/rate-limits" }),
    models: (profileId: string) => this.request({ path: `/api/codex/profiles/${encodeURIComponent(profileId)}/models`, schema: codexModelCatalogSchema, defaultErrorPrefix: "GET /api/codex/profiles/models" }),
    /**
     * Recovers only durable native user-input requests for one owned Room.
     * Native approval requests remain live-only and are never returned here.
     */
    listUserInputRequests: (roomId: string): Promise<CodexRoomRequestList> => this.request({
      path: `/api/codex/rooms/${encodeURIComponent(roomId)}/requests`,
      schema: codexRoomRequestListSchema,
      // Recovery reads are fenced to a particular owner/Room/generation; do
      // not reuse an older A→B→A promise through the general GET coalescer.
      singleFlight: false,
      defaultErrorPrefix: "GET /api/codex/rooms/:roomId/requests",
    }),
    userPreference: () => this.request({ path: "/api/codex/preference", schema: codexUserPreferenceSchema, defaultErrorPrefix: "GET /api/codex/preference" }),
    setUserPreference: (
      input: {
        profileId: string | null;
        enabled: boolean;
        posture: CodexPosture;
        expectedRevision: number;
      },
    ) => this.request({
      method: "PUT",
      path: "/api/codex/preference",
      body: input,
      schema: codexUserPreferenceSchema,
      defaultErrorPrefix: "PUT /api/codex/preference",
    }),
    respondRequest: (requestRef: string, response: CodexRequestResponse) => this.request({
      method: "POST",
      path: `/api/codex/requests/${encodeURIComponent(requestRef)}/respond`,
      body: (response.kind === "permission_selection_required"
        ? codexPermissionSelectionResponseSchema
        : codexRequestResponseSchema).parse(response),
      schema: codexRequestResponseReceiptSchema,
      defaultErrorPrefix: "POST /api/codex/requests/:requestRef/respond",
    }),
  };

  /** Narrow user-scoped Claude Connections onboarding; no credential or account form surface. */
  readonly claudeConnections = {
    summary: (relayId?: string | null) => this.request({ path: "/api/claude-connections", ...claudeHostRequest(relayId), schema: claudeConnectionSummarySchema, defaultErrorPrefix: "GET /api/claude-connections" }),
    toggle: (enabled: boolean, relayId?: string | null) => this.request({ method: "POST", path: "/api/claude-connections/toggle", ...claudeHostRequest(relayId), body: { enabled }, schema: claudeConnectionSummarySchema, defaultErrorPrefix: "POST /api/claude-connections/toggle" }),
    checkAgain: (relayId?: string | null) => this.request({ method: "POST", path: "/api/claude-connections/check", ...claudeHostRequest(relayId), body: {}, schema: claudeConnectionSummarySchema, defaultErrorPrefix: "POST /api/claude-connections/check" }),
    selectModel: (modelId: string | null, relayId?: string | null) => this.request({ method: "POST", path: "/api/claude-connections/model", ...claudeHostRequest(relayId), body: { modelId }, schema: claudeConnectionSummarySchema, defaultErrorPrefix: "POST /api/claude-connections/model" }),
  };

  /** Read-only external-harness catalogue and explicit desktop readiness. */
  readonly acp = {
    harnesses: () => this.request({
      path: "/api/acp/harnesses",
      schema: acpHarnessListSchema,
      defaultErrorPrefix: "GET /api/acp/harnesses",
    }),
    readiness: (harnessId: string, relayId?: string | null) => this.request({
      method: "POST",
      path: `/api/acp/harnesses/${encodeURIComponent(harnessId)}/readiness`,
      body: relayId ? { relayId } : {},
      schema: acpHarnessReadinessSchema,
      defaultErrorPrefix: "POST /api/acp/harnesses/:harnessId/readiness",
    }),
  };

  /**
   * active-client lifecycle seam. Workbench registers its state
   * provider; successful read/preference mutations invalidate the snapshot
   * without coupling this transport package to React or browser globals.
   */
  setNotificationStateInvalidationHandler(
    handler: (() => void) | null,
  ): void {
    this.notificationStateInvalidated = handler;
  }

  /** stale capability denial invalidates only the viewer projection. */
  setActionCapabilityDenialHandler(handler: (() => void) | null): void {
    this.actionCapabilityDenied = handler;
  }

  async observeProtectedShadowAttempt(
    input: ProtectedShadowAttemptObservationV2,
  ): Promise<ProtectedShadowAttemptObservationResponseV2> {
    const body = protectedShadowAttemptObservationV2Schema.parse(input);
    return this.request({
      method: "POST",
      path: "/api/protected/shadow-attempts/observe",
      body,
      schema: protectedShadowAttemptObservationResponseV2Schema,
      defaultErrorPrefix: "POST /api/protected/shadow-attempts/observe",
    });
  }

  readonly admin = {
    users: {
      planRollout: async (manifest: unknown): Promise<AdminRolloutPlanResponse> => {
        return this.request({
          method: "POST",
          path: "/api/admin/users/rollout/plan",
          body: manifest,
          schema: adminRolloutPlanResponseSchema,
          defaultErrorPrefix: "POST /api/admin/users/rollout/plan",
        });
      },
      applyRollout: async (
        manifest: unknown,
        fingerprint: string,
        idempotencyKey: string,
      ): Promise<AdminRolloutApplyResponse> => this.request({
        method: "POST",
        path: "/api/admin/users/rollout/apply",
        body: { manifest, fingerprint },
        headers: { "Idempotency-Key": idempotencyKey },
        schema: adminRolloutApplyResponseSchema,
        defaultErrorPrefix: "POST /api/admin/users/rollout/apply",
      }),
      rolloutStatus: async (rolloutId: string): Promise<AdminRolloutStatusResponse> => this.request({
        method: "GET",
        path: `/api/admin/users/rollout/${encodeURIComponent(rolloutId)}`,
        schema: adminRolloutStatusResponseSchema,
        defaultErrorPrefix: "GET /api/admin/users/rollout/:rolloutId",
      }),
      acknowledgeRollout: async (
        rolloutId: string,
        sequences: number[],
      ): Promise<AdminRolloutStatusResponse> => this.request({
        method: "POST",
        path: `/api/admin/users/rollout/${encodeURIComponent(rolloutId)}/acknowledge`,
        body: { sequences },
        schema: adminRolloutStatusResponseSchema,
        defaultErrorPrefix: "POST /api/admin/users/rollout/:rolloutId/acknowledge",
      }),
      resumeRollout: async (rolloutId: string): Promise<AdminRolloutApplyResponse> => this.request({
        method: "POST",
        path: `/api/admin/users/rollout/${encodeURIComponent(rolloutId)}/resume`,
        body: {},
        schema: adminRolloutApplyResponseSchema,
        defaultErrorPrefix: "POST /api/admin/users/rollout/:rolloutId/resume",
      }),
      provision: async (
        input: AdminProvisionMemberInput,
        idempotencyKey: string,
      ): Promise<AdminProvisionMemberResponse> => {
        return this.request({
          method: "POST",
          path: "/api/admin/users/provision",
          body: input,
          headers: { "Idempotency-Key": idempotencyKey },
          schema: adminProvisionMemberResponseSchema,
          defaultErrorPrefix: "POST /api/admin/users/provision",
        });
      },
      setPermanentCredentials: async (
        id: string,
        input: AdminPermanentCredentialInput,
      ): Promise<AdminPermanentCredentialResponse> => this.request({
        method: "PUT",
        path: `/api/admin/users/${encodeURIComponent(id)}/permanent-credentials`,
        body: input,
        schema: z.object({
          ok: z.literal(true),
          memberId: z.string(),
          auditRecorded: z.boolean(),
        }).strict(),
        defaultErrorPrefix: `PUT /api/admin/users/${id}/permanent-credentials`,
      }),
      list: async (options?: AdminUsersListOptions): Promise<AdminUsersListResponse> => {
        const params = new URLSearchParams();
        if (options?.cursor !== undefined) params.set("cursor", options.cursor);
        if (options?.limit !== undefined) params.set("limit", String(options.limit));
        if (options?.includeFederated === true) params.set("include_federated", "true");
        if (options?.search !== undefined) params.set("search", options.search);
        const qs = params.toString();
        const result = await this.request<z.infer<typeof adminUsersListResponseSchema>>({
          path: `/api/admin/users${qs ? `?${qs}` : ""}`,
          schema: adminUsersListResponseSchema,
          defaultErrorPrefix: "GET /api/admin/users",
        });
        return {
          users: result.users,
          nextCursor: result.nextCursor,
          page: result.page ?? {
            returned: result.users.length,
            complete: result.nextCursor === null,
            hasMore: result.nextCursor !== null,
            nextCursor: result.nextCursor,
            continuationAvailable: result.nextCursor !== null,
          },
        };
      },
      get: async (id: string): Promise<AdminUserRow> => {
        return this.request<AdminUserRow>({
          path: `/api/admin/users/${encodeURIComponent(id)}`,
          schema: adminUserRowSchema,
          defaultErrorPrefix: `GET /api/admin/users/${id}`,
        });
      },
      disable: async (id: string, reason?: string): Promise<AdminUserMutationResponse> => {
        const result = await this.request<z.infer<typeof adminUserMutationResponseSchema>>({
          method: "POST",
          path: `/api/admin/users/${encodeURIComponent(id)}/disable`,
          body: reason !== undefined ? { reason } : {},
          schema: adminUserMutationResponseSchema,
          defaultErrorPrefix: `POST /api/admin/users/${id}/disable`,
          statusErrors: {
            409: (body) =>
              body["code"] === "last_owner"
                ? new LastOwnerError()
                : new ApiError(409, "Conflict"),
            422: (body) =>
              body["code"] === "federated_user"
                ? new ApiError(422, "Federated users are managed on their home server.")
                : new ApiError(422, "Unprocessable entity"),
          },
        });
        return {
          ok: result.ok,
          mutation: result.mutation ?? {
            stateChanged: "unknown",
            auditRecorded: "unknown",
            retrySafe: true,
            receiptId: id,
            recovery: [{ kind: "enable_member", userId: id }],
          },
        };
      },
      enable: async (id: string): Promise<AdminUserMutationResponse> => {
        const result = await this.request<z.infer<typeof adminUserMutationResponseSchema>>({
          method: "POST",
          path: `/api/admin/users/${encodeURIComponent(id)}/enable`,
          body: {},
          schema: adminUserMutationResponseSchema,
          defaultErrorPrefix: `POST /api/admin/users/${id}/enable`,
        });
        return {
          ok: result.ok,
          mutation: result.mutation ?? {
            stateChanged: "unknown",
            auditRecorded: "unknown",
            retrySafe: true,
            receiptId: id,
            recovery: [],
          },
        };
      },
      resetPassword: async (id: string): Promise<AdminPasswordResetResponse> => {
        const result = await this.request<z.infer<typeof adminPasswordResetResponseSchema>>({
          method: "POST",
          path: `/api/admin/users/${encodeURIComponent(id)}/reset-password`,
          body: {},
          schema: adminPasswordResetResponseSchema,
          defaultErrorPrefix: `POST /api/admin/users/${id}/reset-password`,
        });
        const mutation = result.mutation ?? {
            stateChanged: true,
            auditRecorded: "unknown",
            retrySafe: false,
            receiptId: id,
            recovery: [{ kind: "reset_password", userId: id }],
          };
        if (
          (result.delivery === undefined || result.delivery === "one_time_url") &&
          typeof result.url === "string" &&
          typeof result.token === "string"
        ) {
          return { ok: result.ok, delivery: "one_time_url", url: result.url, token: result.token, mutation };
        }
        if (
          result.delivery === "temporary_password" &&
          typeof result.temporaryPassword === "string" &&
          result.mustChangePassword === true
        ) {
          return {
            ok: result.ok,
            delivery: "temporary_password",
            temporaryPassword: result.temporaryPassword,
            mustChangePassword: true,
            mutation,
          };
        }
        throw new ApiError(502, "Invalid password-reset response from server");
      },
      // Irreversible hard delete. 409 `last_owner` maps to
      // LastOwnerError so the UI can surface it the same way as the matrix.
      delete: async (id: string): Promise<AdminUserDeleteResponse> => {
        const result = await this.request<z.infer<typeof adminUserDeleteResponseSchema>>({
          method: "DELETE",
          path: `/api/admin/users/${encodeURIComponent(id)}`,
          schema: adminUserDeleteResponseSchema,
          defaultErrorPrefix: `DELETE /api/admin/users/${id}`,
          statusErrors: {
            409: (body) => {
              if (body["code"] === "last_owner") return new LastOwnerError();
              if (body["code"] === "owns_shared_rooms") {
                return new ApiError(
                  409,
                  "This user owns shared rooms with other members. Reassign or delete those rooms before deleting the account.",
                );
              }
              if (body["code"] === "active_media_operation") {
                return new ApiError(
                  409,
                  "This user has active provider media work. Wait for it to finish and its cleanup to complete before deleting the account.",
                );
              }
              return new ApiError(409, "Conflict");
            },
          },
        });
        const logtoRevoked = result.logtoRevoked ?? "unknown";
        return {
          ok: result.ok,
          logtoRevoked,
          mutation: result.mutation ?? {
            stateChanged: true,
            auditRecorded: "unknown",
            retrySafe: false,
            receiptId: id,
            recovery: logtoRevoked === true
              ? []
              : [{ kind: "reconcile_logto_user", userId: id }],
          },
        };
      },
      // shared rooms owned by a user that block deletion (+ eligible
      // new owners for the transfer recovery path).
      ownedSharedRooms: async (userId: string): Promise<OwnedSharedRoomsResponse> => {
        return this.request<OwnedSharedRoomsResponse>({
          path: `/api/admin/users/${encodeURIComponent(userId)}/owned-shared-rooms`,
          schema: ownedSharedRoomsResponseSchema,
          defaultErrorPrefix: `GET /api/admin/users/${userId}/owned-shared-rooms`,
        });
      },
    },
    // admin room recovery actions (offboarding).
    rooms: {
      transferOwner: async (
        roomId: string,
        newOwnerUserId: string,
      ): Promise<{ ok: boolean }> => {
        return this.request<{ ok: boolean }>({
          method: "POST",
          path: `/api/admin/rooms/${encodeURIComponent(roomId)}/transfer-owner`,
          body: { newOwnerUserId },
          schema: okResponseSchema,
          defaultErrorPrefix: `POST /api/admin/rooms/${roomId}/transfer-owner`,
        });
      },
      archive: async (roomId: string): Promise<{ ok: boolean }> => {
        return this.request<{ ok: boolean }>({
          method: "POST",
          path: `/api/admin/rooms/${encodeURIComponent(roomId)}/archive`,
          body: {},
          schema: okResponseSchema,
          defaultErrorPrefix: `POST /api/admin/rooms/${roomId}/archive`,
        });
      },
      unarchive: async (roomId: string): Promise<{ ok: boolean }> => {
        return this.request<{ ok: boolean }>({
          method: "POST",
          path: `/api/admin/rooms/${encodeURIComponent(roomId)}/unarchive`,
          body: {},
          schema: okResponseSchema,
          defaultErrorPrefix: `POST /api/admin/rooms/${roomId}/unarchive`,
        });
      },
    },
    // server-wide model config (default chat / Conductor / fallback).
    // GET requires `read_server_settings`; set requires `manage_server_operations`.
    serverModels: {
      get: async (): Promise<ServerModelConfig> => {
        return this.request<ServerModelConfig>({
          path: "/api/admin/server-models",
          schema: serverModelConfigSchema,
          defaultErrorPrefix: "GET /api/admin/server-models",
        });
      },
      set: async (patch: {
        defaultChatModel?: string;
        conductorModel?: string;
        stenographerModel?: string;
        reflectionModel?: string;
        memoryReviewModel?: string | null;
        embeddingModel?: string | null;
        imageModel?: string | null;
        musicModel?: string | null;
        videoModel?: string | null;
        speechModel?: string | null;
        fallbackChain?: string[];
        reasoningOutput?: Record<string, boolean>;
        reasoningPolicy?: {
          defaultEffort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null;
          overrides: Record<string, "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
        };
      }): Promise<ServerModelConfig> => {
        return this.request<ServerModelConfig>({
          method: "POST",
          path: "/api/admin/server-models",
          body: patch,
          schema: serverModelConfigSchema,
          defaultErrorPrefix: "POST /api/admin/server-models",
        });
      },
    },
    // server-wide bounded foreground Room context policy.
    // GET requires `read_server_settings`; set requires `manage_server_operations`.
    serverContext: {
      get: async (): Promise<ServerContextConfig> => {
        return this.request<ServerContextConfig>({
          path: "/api/admin/server-context",
          schema: serverContextConfigSchema,
          defaultErrorPrefix: "GET /api/admin/server-context",
        });
      },
      set: async (patch: Partial<{
        recentConversationLimit: number;
        minimumFullTurns: number;
        maxRoomContextPercent: number;
        stenographerPriorConversationLimit: number;
        passiveRecallEnabled: boolean;
        reflectionSleepEnabled: boolean;
        memoryReviewEnabled: boolean | null;
      }>): Promise<ServerContextConfig> => {
        return this.request<ServerContextConfig>({
          method: "POST",
          path: "/api/admin/server-context",
          body: patch,
          schema: serverContextConfigSchema,
          defaultErrorPrefix: "POST /api/admin/server-context",
        });
      },
    },
    // manual, server-wide encryption transition control plane.
    encryptionTransition: {
      getPolicy: async (
        options?: { signal?: AbortSignal },
      ): Promise<EncryptionTransitionPolicyStatus> => {
        return this.request<EncryptionTransitionPolicyStatus>({
          path: "/api/encryption-transition/policy",
          auth: "session-fresh",
          schema: encryptionTransitionPolicyStatusSchema,
          defaultErrorPrefix: "GET /api/encryption-transition/policy",
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      },
      get: async (): Promise<EncryptionTransitionStatus> => {
        return this.request<EncryptionTransitionStatus>({
          path: "/api/admin/encryption-transition",
          schema: encryptionTransitionStatusSchema,
          defaultErrorPrefix: "GET /api/admin/encryption-transition",
        });
      },
      update: async (
        input: EncryptionTransitionUpdateRequest,
      ): Promise<EncryptionTransitionStatus> => {
        return this.request<EncryptionTransitionStatus>({
          method: "POST",
          path: "/api/admin/encryption-transition",
          body: input,
          schema: encryptionTransitionStatusSchema,
          defaultErrorPrefix: "POST /api/admin/encryption-transition",
        });
      },
    },
    // content-free Room Stenographer operational health.
    // Requires `read_server_settings`.
    memoryStatus: {
      get: async (): Promise<MemoryAdminStatus> => this.request({
        path: "/api/admin/memory-status", schema: memoryAdminStatusSchema,
        defaultErrorPrefix: "GET /api/admin/memory-status",
      }),
      retry: async (): Promise<{ requested: number }> => this.request({
        method: "POST", path: "/api/admin/memory-retry", body: {},
        schema: memoryRetryResponseSchema,
        defaultErrorPrefix: "POST /api/admin/memory-retry",
      }),
    },
    stenographerStatus: {
      get: async (): Promise<StenographerAdminStatus> => {
        return this.request<StenographerAdminStatus>({
          path: "/api/admin/stenographer-status",
          schema: stenographerAdminStatusSchema,
          defaultErrorPrefix: "GET /api/admin/stenographer-status",
        });
      },
      getProtection: async (): Promise<StenographerProtectionStatus> => {
        return this.request<StenographerProtectionStatus>({
          path: "/api/admin/stenographer-status/protection",
          schema: stenographerProtectionStatusSchema,
          defaultErrorPrefix: "GET /api/admin/stenographer-status/protection",
        });
      },
    },
    // content-free durable Reflection/Sleep operational health.
    // Requires `read_server_settings`.
    reflectionStatus: {
      get: async (): Promise<ReflectionAdminStatus> => {
        return this.request<ReflectionAdminStatus>({
          path: "/api/admin/reflection-status",
          schema: reflectionAdminStatusSchema,
          defaultErrorPrefix: "GET /api/admin/reflection-status",
        });
      },
    },
    // Admin access-control reads. Requires at least one
    // of `manage_members | manage_groups | manage_roles`.
    accessControl: {
      getEffectiveAccess: async (userId: string): Promise<EffectiveAccessResponse> => {
        return this.request<EffectiveAccessResponse>({
          path: `/api/admin/access-control/users/${encodeURIComponent(userId)}/effective-access`,
          schema: effectiveAccessResponseSchema,
          defaultErrorPrefix: `GET /api/admin/access-control/users/${userId}/effective-access`,
        });
      },
      getCatalogue: async (): Promise<AccessControlCatalogue> => {
        return this.request<AccessControlCatalogue>({
          path: "/api/admin/access-control/catalogue",
          schema: accessControlCatalogueSchema,
          defaultErrorPrefix: "GET /api/admin/access-control/catalogue",
        });
      },
      // Minimal Human directory for custom Group
      // owner/member selection. Same coarse gate as the other Access
      // Control reads (any of manage_members | manage_groups |
      // manage_roles); returns only { userId, displayName, handle }.
      listHumans: async (): Promise<AccessControlHumanList> => {
        return this.request<AccessControlHumanList>({
          path: "/api/admin/access-control/users",
          schema: accessControlHumanListSchema,
          defaultErrorPrefix: "GET /api/admin/access-control/users",
        });
      },
      // Preview/apply mutation engine. Preview is
      // read-only (always 200 with structured checks/failures + fingerprint);
      // apply re-validates in one tx and returns 409 stale_preview on drift.
      previewChange: async (
        operation: AccessControlMutationOperation,
      ): Promise<PreviewMutationResponse> => {
        const body: PreviewRequestBody = { operation };
        return this.request<PreviewMutationResponse>({
          method: "POST",
          path: "/api/admin/access-control/changes/preview",
          body,
          schema: previewResponseSchema,
          defaultErrorPrefix: "POST /api/admin/access-control/changes/preview",
        });
      },
      applyChange: async (
        operation: AccessControlMutationOperation,
        fingerprint: string,
      ): Promise<ApplyMutationResponse> => {
        const body: ApplyRequestBody = { operation, fingerprint };
        return this.request<ApplyMutationResponse>({
          method: "POST",
          path: "/api/admin/access-control/changes/apply",
          body,
          schema: applyResponseSchema,
          defaultErrorPrefix: "POST /api/admin/access-control/changes/apply",
          statusErrors: {
            409: (errJson) => {
              const code = typeof errJson["code"] === "string" ? errJson["code"] : "";
              if (code === "stale_preview") {
                return new ApiError(409, "stale_preview");
              }
              return new ApiError(409, "Conflict");
            },
          },
        });
      },
    },
  } as const;

  // aggregate encryption coverage scoped to the authenticated Human.
  readonly encryptionCoverage = {
    getPersonal: async (
      options?: { signal?: AbortSignal },
    ): Promise<PersonalEncryptionCoverageV1> => {
      return this.request<PersonalEncryptionCoverageV1>({
        path: "/api/encryption/coverage/me",
        schema: personalEncryptionCoverageV1Schema,
        defaultErrorPrefix: "GET /api/encryption/coverage/me",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    },
  } as const;

  readonly deviceAdmission = {
    status: async (
      options?: { signal?: AbortSignal },
    ): Promise<DeviceAdmissionStatus> => {
      return this.request<DeviceAdmissionStatus>({
        path: "/api/crypto-device-admission/status",
        schema: deviceAdmissionStatusSchema,
        defaultErrorPrefix: "GET /api/crypto-device-admission/status",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    challenge: async (
      input: DeviceAdmissionChallengeRequest,
      options?: { signal?: AbortSignal },
    ): Promise<DeviceAdmissionChallengeResponse> => {
      return this.request<DeviceAdmissionChallengeResponse>({
        method: "POST",
        path: "/api/crypto-device-admission/challenge",
        body: input,
        schema: deviceAdmissionChallengeResponseSchema,
        defaultErrorPrefix: "POST /api/crypto-device-admission/challenge",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    },
    prove: async (
      input: DeviceAdmissionProofRequest,
      options?: { signal?: AbortSignal },
    ): Promise<DeviceAdmissionProofResponse> => {
      return this.request<DeviceAdmissionProofResponse>({
        method: "POST",
        path: "/api/crypto-device-admission/proof",
        body: input,
        schema: deviceAdmissionProofResponseSchema,
        defaultErrorPrefix: "POST /api/crypto-device-admission/proof",
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
    },
  } as const;

  readonly groups = {
    listGroups: async (): Promise<ListGroupsResponse> => {
      return this.request<ListGroupsResponse>({
        path: "/api/groups",
        schema: listGroupsResponseSchema,
        defaultErrorPrefix: "GET /api/groups",
      });
    },
    listGroupMembers: async (groupId: string): Promise<ListGroupMembersResponse> => {
      return this.request<ListGroupMembersResponse>({
        path: `/api/groups/${encodeURIComponent(groupId)}/members`,
        schema: listGroupMembersResponseSchema,
        defaultErrorPrefix: `GET /api/groups/${groupId}/members`,
      });
    },
    addGroupMember: async (
      groupId: string,
      userId: string,
    ): Promise<{ ok: boolean; auditRecorded?: boolean | undefined }> => {
      return this.request<{ ok: boolean; auditRecorded?: boolean | undefined }>({
        method: "PUT",
        path: `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
        schema: groupMutationResponseSchema,
        defaultErrorPrefix: `PUT /api/groups/${groupId}/members/${userId}`,
      });
    },
    removeGroupMember: async (
      groupId: string,
      userId: string,
      opts?: { bypass?: boolean },
    ): Promise<{ ok: boolean; auditRecorded?: boolean | undefined }> => {
      const qs = opts?.bypass === true ? "?bypass=true" : "";
      return this.request<{ ok: boolean; auditRecorded?: boolean | undefined }>({
        method: "DELETE",
        path: `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}${qs}`,
        schema: groupMutationResponseSchema,
        defaultErrorPrefix: `DELETE /api/groups/${groupId}/members/${userId}`,
        statusErrors: {
          409: (body) => {
            if (body["code"] === "last_owner") return new LastOwnerError();
            return new ApiError(409, "Conflict");
          },
        },
      });
    },
  } as const;

  // Self effective-access read (authentication only).
  readonly accessControl = {
    getMyEffectiveAccess: async (): Promise<EffectiveAccessResponse> => {
      return this.request<EffectiveAccessResponse>({
        path: "/api/access-control/me/effective-access",
        schema: effectiveAccessResponseSchema,
        defaultErrorPrefix: "GET /api/access-control/me/effective-access",
      });
    },
  } as const;

  /**
   * Single fetch shim for the entire client. Inject Bun's `unix:` option
   * when the client is bound to a Unix socket transport. All other behaviour
   * (headers, body, abort signals, etc.) flows through unchanged.
   */
  private transportFetch(url: string, init?: RequestInit): Promise<Response> {
    if (this.unixSocketPath) {
      return fetch(url, { ...(init ?? {}), unix: this.unixSocketPath } as RequestInit & {
        unix?: string;
      });
    }
    return this.fetchImpl
      ? this.fetchImpl(url, init)
      : fetch(url, init);
  }

  private async unauthorizedResponse(
    response: Response,
    url: string,
    init: RequestInit | undefined,
    retryAttempted: boolean,
  ): Promise<string | null | void> {
    const body = (await response.clone().json().catch(() => null)) as {
      error?: unknown;
    } | null;
    try {
      return await this.unauthorizedResponseHandler?.({
        url,
        method: init?.method ?? "GET",
        error: typeof body?.error === "string" ? body.error : null,
        retryAttempted,
      });
    } catch {
      // Recovery/navigation hooks must never replace the real API error.
      return undefined;
    }
  }

  private recoverUnauthorizedResponse(
    response: Response,
    url: string,
    init: RequestInit | undefined,
    expectedCredentialGeneration: number,
  ): Promise<string | null | void> {
    if (
      this.unauthorizedRecoveryInFlight &&
      this.unauthorizedRecoveryGeneration === expectedCredentialGeneration
    ) return this.unauthorizedRecoveryInFlight;
    const recovery = (async () => {
      const replacement = await this.unauthorizedResponse(response, url, init, false);
      if (this.credentialGeneration !== expectedCredentialGeneration) return null;
      // Publish the replacement before releasing parallel stale responses.
      // This closes the microtask-sized gap where a second 401 could otherwise
      // begin another rotating-refresh-token exchange.
      if (typeof replacement === "string" && replacement.length > 0) {
        this.setToken(replacement);
      }
      return replacement;
    })();
    this.unauthorizedRecoveryInFlight = recovery;
    this.unauthorizedRecoveryGeneration = expectedCredentialGeneration;
    return recovery.finally(() => {
      if (this.unauthorizedRecoveryInFlight === recovery) {
        this.unauthorizedRecoveryInFlight = null;
        this.unauthorizedRecoveryGeneration = null;
      }
    });
  }

  private async _fetch(url: string, init?: RequestInit): Promise<Response> {
    const requestCredentialGeneration = this.credentialGeneration;
    const authorization = new Headers(init?.headers).get("authorization");
    const canonicalAuthorization = this.token ? `Bearer ${this.token}` : null;
    const sentCanonicalSessionBearer =
      canonicalAuthorization !== null && authorization === canonicalAuthorization;
    let response = await this.transportFetch(url, init);

    if (response.status === 401 && this.unauthorizedResponseHandler && sentCanonicalSessionBearer) {
      // Only observe rejection of this client's canonical session bearer.
      // Invite, WOPI, and other endpoint-scoped bearer credentials must not
      // invalidate the signed-in Human session. Capture this at dispatch time:
      // another request may rotate the client token while this response is in
      // flight, in which case reuse that replacement instead of refreshing a
      // second time or leaking this stale 401 to the caller.
      const currentAuthorization = this.token ? `Bearer ${this.token}` : null;
      const replacement = currentAuthorization && currentAuthorization !== authorization
        ? this.token
        : await this.recoverUnauthorizedResponse(
          response,
          url,
          init,
          requestCredentialGeneration,
        );
      if (typeof replacement === "string" && replacement.length > 0) {
        if (this.token !== replacement) return response;
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set("Authorization", `Bearer ${replacement}`);
        const retryInit = { ...(init ?? {}), headers: retryHeaders };
        response = await this.transportFetch(url, retryInit);
        if (response.status === 401) {
          await this.unauthorizedResponse(response, url, retryInit, true);
        }
      }
    }
    if (
      (response.status === 428 || response.status === 503)
      && this.deviceAdmissionRequired
    ) {
      const body = (await response.clone().json().catch(() => null)) as {
        code?: unknown;
      } | null;
      const code = body?.code;
      if (
        code === "device_admission_required"
        || code === "device_admission_expired"
        || code === "device_removed_or_stale"
        || code === "device_admission_unavailable"
      ) this.deviceAdmissionRequired(code);
    }
    return response;
  }

  /**
   * single JSON request/response helper over {@link NautiloApiClient._fetch}.
   * Centralizes JSON envelopes, authentication headers, and typed status errors.
   *
   * Session authentication adds `Content-Type: application/json` only when a body is present.
   * Status-error mappers receive the complete parsed error object so typed errors can preserve
   * safe fields such as `retryAfterSeconds`.
   */
  private async request<T>(opts: RequestOpts<T>): Promise<T> {
    const method = opts.method ?? "GET";
    if (method === "GET" && opts.singleFlight !== false && opts.signal === undefined) {
      return this.requestGetWithSingleFlight(opts);
    }
    return this.executeRequest(opts);
  }

  /**
   * share one parsed GET promise among concurrent callers with the
   * same normalized key. Mutations and direct `_fetch` sites bypass this path.
   */
  private async requestGetWithSingleFlight<T>(opts: RequestOpts<T>): Promise<T> {
    const auth = opts.auth ?? "session";
    let preResolvedAuthHeaders: Record<string, string> | undefined;
    if (auth === "session-fresh") {
      preResolvedAuthHeaders = await this.authHeadersFresh();
    }

    const headers = this.buildRequestHeaders(opts, preResolvedAuthHeaders);
    const key = this.buildGetInFlightKey(opts.path, auth, headers);
    const existing = this.inFlightGets.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }

    const promise = this.executeRequest<T>(opts, preResolvedAuthHeaders).finally(() => {
      if (this.inFlightGets.get(key) === promise) {
        this.inFlightGets.delete(key);
      }
    });
    this.inFlightGets.set(key, promise);
    return promise;
  }

  /**
   * conditional JSON GETs share one parsed result while exposing
   * response validators and representing 304 without attempting to consume its empty body.
   */
  private async conditionalGet<T>(
    opts: RequestOpts<T>,
    parseResponse: (response: Response) => Promise<T>,
  ): Promise<ConditionalReadResult<T>> {
    const auth = opts.auth ?? "session";
    let preResolvedAuthHeaders: Record<string, string> | undefined;
    if (auth === "session-fresh") {
      preResolvedAuthHeaders = await this.authHeadersFresh();
    }

    const headers = this.buildRequestHeaders(opts, preResolvedAuthHeaders);
    const key = `${this.buildGetInFlightKey(opts.path, auth, headers)}|conditional`;
    const existing = this.inFlightGets.get(key);
    if (existing !== undefined) {
      return existing as Promise<ConditionalReadResult<T>>;
    }

    const promise = (async (): Promise<ConditionalReadResult<T>> => {
      const response = await this._fetch(`${this.baseUrl}${opts.path}`, {
        method: "GET",
        headers,
        // Keeps the response body and validator together in application
        // memory. Chromium's HTTP cache must not add its own implicit
        // If-None-Match after a renderer reload: that can produce a 304 when
        // the application cache has no body, leaving identity hydration stuck
        // on the persisted guest shell. Explicit validators in `headers`
        // remain authoritative.
        cache: "no-store",
      });
      const etag = response.headers.get("etag");
      if (response.status === 304) return { status: 304, etag };
      return { status: 200, body: await parseResponse(response), etag };
    })().finally(() => {
      if (this.inFlightGets.get(key) === promise) {
        this.inFlightGets.delete(key);
      }
    });
    this.inFlightGets.set(key, promise);
    return promise;
  }

  private async parseConditionalJsonResponse<T>(
    response: Response,
    opts: RequestOpts<T>,
  ): Promise<T> {
    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      if (isAgentInvocationRequiredBody(response.status, errJson)) {
        this.actionCapabilityDenied?.();
        throw new AgentInvocationRequiredError();
      }
      if (isArtifactWriteRequiredBody(response.status, errJson)) {
        this.actionCapabilityDenied?.();
        throw new ArtifactWriteRequiredError();
      }
      const typed = opts.statusErrors?.[response.status];
      if (typed) throw typed(errJson);
      throw new ApiError(
        response.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `${opts.defaultErrorPrefix ?? `GET ${opts.path}`} failed: ${response.status}`,
        parseRetryAfterMs(response.headers.get("retry-after")),
      );
    }
    const json: unknown = await response.json();
    return opts.schema ? opts.schema.parse(json) : (json as T);
  }

  private buildRequestHeaders(
    opts: RequestOpts<unknown>,
    preResolvedAuthHeaders?: Record<string, string>,
  ): Record<string, string> {
    const { auth = "session", body, headers: extraHeaders } = opts;
    const headers: Record<string, string> =
      auth === "none"
        ? body !== undefined
          ? { "Content-Type": "application/json" }
          : {}
        : auth === "session-fresh"
          ? {
              ...(preResolvedAuthHeaders ?? {}),
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            }
          : {
              ...this.authHeaders(),
              ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            };
    if (extraHeaders) Object.assign(headers, extraHeaders);
    return headers;
  }

  /** Sort query params so equivalent GET paths share one in-flight key. */
  private normalizeRequestPath(path: string): string {
    const qIdx = path.indexOf("?");
    if (qIdx === -1) return path;

    const pathname = path.slice(0, qIdx);
    const query = path.slice(qIdx + 1);
    if (query.length === 0) return pathname;

    const params = new URLSearchParams(query);
    const sorted = new URLSearchParams();
    const keys = [...new Set([...params.keys()])].sort();
    for (const key of keys) {
      for (const value of params.getAll(key)) {
        sorted.append(key, value);
      }
    }
    const qs = sorted.toString();
    return qs.length > 0 ? `${pathname}?${qs}` : pathname;
  }

  private representationHeaderKey(headers: Record<string, string>): string {
    const lower = new Map<string, string>();
    for (const [name, value] of Object.entries(headers)) {
      lower.set(name.toLowerCase(), value);
    }
    const parts: string[] = [];
    for (const name of GET_SINGLE_FLIGHT_REPR_HEADERS) {
      const value = lower.get(name);
      if (value !== undefined) {
        parts.push(`${name}=${value}`);
      }
    }
    return parts.join("&");
  }

  private buildGetInFlightKey(
    path: string,
    auth: AuthMode,
    headers: Record<string, string>,
  ): string {
    const normalizedPath = this.normalizeRequestPath(path);
    const transport = this.unixSocketPath ?? "";
    const credPart =
      auth === "none" ? "" : `:cred=${this.credentialGeneration}`;
    const repr = this.representationHeaderKey(headers);
    return `${this.baseUrl}|${transport}|GET|${normalizedPath}|auth=${auth}${credPart}|${repr}`;
  }

  private async executeRequest<T>(
    opts: RequestOpts<T>,
    preResolvedAuthHeaders?: Record<string, string>,
  ): Promise<T> {
    const {
      method = "GET",
      path,
      body,
      schema,
      emptyResponse,
      statusErrors,
      defaultErrorPrefix,
    } = opts;

    const resolvedAuthHeaders =
      opts.auth === "session-fresh" && preResolvedAuthHeaders === undefined
        ? await this.authHeadersFresh()
        : preResolvedAuthHeaders;
    const headers = this.buildRequestHeaders(opts, resolvedAuthHeaders);
    const init: RequestInit = {
      method,
      headers,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };
    if (body !== undefined) init.body = JSON.stringify(body);

    const res = await this._fetch(`${this.baseUrl}${path}`, init);

    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      if (isAgentInvocationRequiredBody(res.status, errJson)) {
        this.actionCapabilityDenied?.();
        throw new AgentInvocationRequiredError();
      }
      if (isArtifactWriteRequiredBody(res.status, errJson)) {
        this.actionCapabilityDenied?.();
        throw new ArtifactWriteRequiredError();
      }
      const typed = statusErrors?.[res.status];
      if (typed) throw typed(errJson);
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `${defaultErrorPrefix ?? `${method} ${path}`} failed: ${res.status}`,
        parseRetryAfterMs(res.headers.get("retry-after")),
      );
    }

    if (emptyResponse) return undefined as T;

    // Success path: do NOT swallow JSON parse errors — legacy `await res.json()` sites throw on
    // non-JSON 2xx responses, and the helper must preserve that.
    const json: unknown = await res.json();
    if (schema) return schema.parse(json);
    return json as T;
  }

  /**
   * register a refresh-aware token provider. A client implementation
   * silently refreshes the access token if it's within 60s of expiry,
   * mirrors the result via `setToken(fresh)`, and returns the bearer
   * (or `null` to flip the SignInDialog back on).
   *
   * Protected requests call the provider before building auth headers
   * so Electron/Logto sessions do not keep using an expired cached token.
   */
  setTokenProvider(provider: (() => Promise<string | null>) | null): void {
    this.tokenProvider = provider;
  }

  /** Recover or observe authenticated HTTP 401s from every request path. */
  setUnauthorizedResponseHandler(handler: UnauthorizedResponseHandler | null): void {
    this.unauthorizedResponseHandler = handler;
  }

  setDeviceAdmissionRequiredHandler(
    handler: DeviceAdmissionRequiredHandler | null,
  ): void {
    this.deviceAdmissionRequired = handler;
  }

  getTokenProvider(): (() => Promise<string | null>) | null {
    return this.tokenProvider;
  }

  setToken(token: string | null): void {
    // Normalize null + empty-string to null. Callers use `setToken("")` to clear
    // the bearer; without this normalization `hasToken()`
    // would return true for "" but `authHeaders()` treats "" as
    // falsy, producing requests with no Authorization header that
    // nonetheless pass `useAuth().viewer`'s gate — so whoami lands
    // bearer-less and returns guest.
    const normalized = token && token.length > 0 ? token : null;
    if (normalized !== this.token) {
      this.token = normalized;
      this.credentialGeneration += 1;
    }
  }

  /** non-secret credential generation for single-flight keys and later auth sync. */
  getCredentialGeneration(): number {
    return this.credentialGeneration;
  }

  /** read-only in-flight GET single-flight count (tests/diagnostics). */
  getInFlightGetCount(): number {
    return this.inFlightGets.size;
  }

  hasToken(): boolean {
    return this.token !== null && this.token.length > 0;
  }

  /**
   * read-only accessor for the bearer the api client has
   * latched. Used to feed `createWsRealtimeClient`'s
   * `getToken` provider so HTTP and WS authenticate with the same
   * token without a parallel ref. Returns null when no token is
   * set.
   */
  getToken(): string | null {
    return this.token;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    return headers;
  }

  private async authHeadersFresh(): Promise<Record<string, string>> {
    if (this.tokenProvider) {
      this.setToken(await this.tokenProvider());
    }
    return this.authHeaders();
  }

  private jsonHeaders(): Record<string, string> {
    return { "Content-Type": "application/json", ...this.authHeaders() };
  }

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>({
      path: "/health",
      auth: "none",
      defaultErrorPrefix: "GET /health",
    });
  }

  /**
   * setup surface and provider state. Without a session the
   * payload omits `viewer` and `providers`, but still includes
   * `recommendedSetupSurface` for setup cards. With a valid bearer the
   * response adds `viewer`, `providers`, and a role-aware surface.
   */
  async getSetupStatus(
    requestOptions?: { signal?: AbortSignal },
  ): Promise<SetupStatusResponse> {
    return this.request<SetupStatusResponse>({
      path: "/api/setup/status",
      auth: "session-fresh",
      schema: setupStatusResponseSchema,
      defaultErrorPrefix: "GET /api/setup/status",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** caller-owned durable controller bindings only. */
  async listRemoteControllers(): Promise<ListRemoteControllersResponse> {
    return this.request({
      path: "/api/remote/controllers",
      schema: listRemoteControllersResponseSchema,
      defaultErrorPrefix: "GET /api/remote/controllers",
    });
  }

  /** caller-owned desktop hosts, with no relay credential data. */
  async listRemoteHosts(options?: {
    mobileOriginProof?: RemoteOrdinaryRequestProof;
  }): Promise<ListRemoteHostsResponse> {
    return this.request({
      path: "/api/remote/hosts",
      ...(options?.mobileOriginProof
        ? {
            headers: {
              "X-Nautilo-Mobile-Origin": JSON.stringify(options.mobileOriginProof),
            },
          }
        : {}),
      schema: listRemoteHostsResponseSchema,
      defaultErrorPrefix: "GET /api/remote/hosts",
    });
  }

  /**
   * browse one paired Mac's explicitly selected root. Every
   * selector is in the POST body and therefore bound into the phone proof.
   */
  async listRemoteHostFiles(
    input: ListRemoteHostFilesRequest,
    options: { mobileOriginProof: RemoteOrdinaryRequestProof },
  ): Promise<ListRemoteHostFilesResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/host-files/list",
      body: input,
      headers: { "X-Nautilo-Mobile-Origin": JSON.stringify(options.mobileOriginProof) },
      schema: listRemoteHostFilesResponseSchema,
      defaultErrorPrefix: "POST /api/remote/host-files/list",
    });
  }

  async statRemoteHostFile(
    input: StatRemoteHostFileRequest,
    options: { mobileOriginProof: RemoteOrdinaryRequestProof },
  ): Promise<StatRemoteHostFileResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/host-files/stat",
      body: input,
      headers: { "X-Nautilo-Mobile-Origin": JSON.stringify(options.mobileOriginProof) },
      schema: statRemoteHostFileResponseSchema,
      defaultErrorPrefix: "POST /api/remote/host-files/stat",
    });
  }

  async readRemoteHostFilePreview(
    input: ReadRemoteHostFilePreviewRequest,
    options: { mobileOriginProof: RemoteOrdinaryRequestProof },
  ): Promise<ReadRemoteHostFilePreviewResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/host-files/read",
      body: input,
      headers: { "X-Nautilo-Mobile-Origin": JSON.stringify(options.mobileOriginProof) },
      schema: readRemoteHostFilePreviewResponseSchema,
      defaultErrorPrefix: "POST /api/remote/host-files/read",
    });
  }

  async selectRemoteHostCurrentFolder(
    input: SelectRemoteHostCurrentFolderRequest,
    options: { mobileOriginProof: RemoteOrdinaryRequestProof },
  ): Promise<SelectRemoteHostCurrentFolderResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/current-folder/select",
      body: input,
      headers: { "X-Nautilo-Mobile-Origin": JSON.stringify(options.mobileOriginProof) },
      schema: selectRemoteHostCurrentFolderResponseSchema,
      defaultErrorPrefix: "POST /api/remote/current-folder/select",
    });
  }

  /** Requires a freshly acquired Logto access token on the server. */
  async createRemotePairingChallenge(
    input: CreateRemotePairingChallengeRequest,
  ): Promise<CreateRemotePairingChallengeResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/challenges",
      auth: "session-fresh",
      body: input,
      schema: createRemotePairingChallengeResponseSchema,
      defaultErrorPrefix: "POST /api/remote/challenges",
    });
  }

  /** Consumes a one-time verifier after server-verified Ed25519 possession proof. */
  async consumeRemotePairingChallenge(
    input: ConsumeRemotePairingChallengeRequest,
  ): Promise<ConsumeRemotePairingChallengeResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/challenges/consume",
      auth: "session-fresh",
      body: input,
      schema: consumeRemotePairingChallengeResponseSchema,
      defaultErrorPrefix: "POST /api/remote/challenges/consume",
    });
  }

  /** Manual-code flow resolves only signing inputs; it never reveals verifier state. */
  async prepareManualRemotePairing(
    input: PrepareManualRemotePairingRequest,
  ): Promise<PrepareManualRemotePairingResponse> {
    return this.request({
      method: "POST",
      path: "/api/remote/challenges/manual/prepare",
      auth: "session-fresh",
      body: input,
      schema: prepareManualRemotePairingResponseSchema,
      defaultErrorPrefix: "POST /api/remote/challenges/manual/prepare",
    });
  }

  async renameRemoteController(
    bindingId: string,
    input: RenameRemoteControllerRequest,
  ): Promise<{ ok: true }> {
    return this.request({
      method: "PATCH",
      path: `/api/remote/controllers/${encodeURIComponent(bindingId)}`,
      auth: "session-fresh",
      body: input,
      schema: remoteMutationResponseSchema,
      defaultErrorPrefix: "PATCH /api/remote/controllers/:bindingId",
    });
  }

  async revokeRemoteController(bindingId: string): Promise<{ ok: true }> {
    return this.request({
      method: "DELETE",
      path: `/api/remote/controllers/${encodeURIComponent(bindingId)}`,
      auth: "session-fresh",
      schema: remoteMutationResponseSchema,
      defaultErrorPrefix: "DELETE /api/remote/controllers/:bindingId",
    });
  }

  /**
   * server identity (name, optional description, icon) from the
   * pre-auth `base` block of setup status. Switcher and login surfaces bind
   * here instead of duplicating instance config. Returns `undefined` when
   * talking to an older server that predates the server-profile substrate.
   */
  async getServerProfile(): Promise<ServerProfile | undefined> {
    const status = await this.getSetupStatus();
    return status.serverProfile;
  }

  /**
   * update server identity (name, description, visibility). Requires
   * `manage_server_operations` on the server. Returns the resolved profile.
   */
  async updateServerProfile(patch: {
    name?: string | null;
    description?: string | null;
    descriptionVisibility?: "public" | "members";
    reviewed?: true;
  }): Promise<ServerProfile> {
    const { serverProfile } = await this.request<{ serverProfile: ServerProfile }>({
      method: "POST",
      path: "/api/server/profile",
      body: patch,
      schema: serverProfileUpdateResponseSchema,
      defaultErrorPrefix: "POST /api/server/profile",
    });
    return serverProfile;
  }

  /**
   * upload a server icon image (multipart). Requires
   * `manage_server_operations`. Returns the resolved profile including the new
   * icon ref.
   */
  async uploadServerIcon(file: File | Blob): Promise<ServerProfile> {
    const form = new FormData();
    const filename =
      file instanceof File && file.name.length > 0 ? file.name : "server-icon.png";
    form.append("file", file, filename);
    const res = await this._fetch(`${this.baseUrl}/api/server/icon`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/server/icon failed: ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    return serverProfileUpdateResponseSchema.parse(json).serverProfile;
  }

  // Keep the parsed response typed as the shared WhoamiResponse contract. The schema and
  // shared interface intentionally tolerate fields from newer servers.
  async whoami(): Promise<WhoamiResponse> {
    const result = await this.whoamiConditional();
    if (result.status === 304) {
      throw new ApiError(304, "GET /api/auth/whoami returned 304 without If-None-Match");
    }
    return result.body;
  }

  async whoamiConditional(
    options: ConditionalReadOptions = {},
  ): Promise<ConditionalReadResult<WhoamiResponse>> {
    const bearerAtDispatch = this.token;
    const requestOptions: RequestOpts<WhoamiResponse> = {
      path: "/api/auth/whoami",
      defaultErrorPrefix: "GET /api/auth/whoami",
      ...(options.ifNoneMatch
        ? { headers: { "If-None-Match": options.ifNoneMatch } }
        : {}),
    };
    return this.conditionalGet(requestOptions, async (response) => {
      // `useViewerAuth.checkViewer()` obtains and latches a fresh bearer immediately
      // before this call. The default session auth mode deliberately does not invoke
      // the token provider a second time.
      if (!response.ok && response.status >= 500) {
        throw new ApiError(
          response.status,
          `GET /api/auth/whoami failed: ${response.status}`,
        );
      }
      const json: unknown = await response.json();
      const parsed = whoamiResponseSchema.safeParse(json);
      const result = parsed.success
        ? (parsed.data as WhoamiResponse)
        : guestWhoamiFallback();
      if (
        result.sessionUserId === null
        && bearerIsAtOrPastJwtExpiry(bearerAtDispatch, Date.now())
      ) {
        // Logto estimates cache expiry from requestedAt + expiresIn, while the
        // server verifies the signed JWT exp. At that narrow boundary the SDK
        // can return the old bearer once after the server has rejected it.
        // Keep this response transient so the next viewer tick can acquire the
        // refreshed token instead of signing out the still-valid session.
        throw new ApiError(401, "GET /api/auth/whoami rejected an expired session bearer");
      }
      return result;
    });
  }

  /** Device authorization is unavailable in this client build. */
  deviceFlowStart(): Promise<{ verification_uri: string; user_code: string }> {
    return Promise.reject(
      new ApiError(501, "Device authorization flow is not available in this client build."),
    );
  }

  pollDeviceFlow(): Promise<{ access_token: string; expires_in: number; refresh_token?: string; id_token?: string }> {
    return Promise.reject(
      new ApiError(501, "Device authorization flow is not available in this client build."),
    );
  }

  /**
   * Logto-linked account security flags (temp-password rotation, etc.).
   */
  async getAccountSecurity(): Promise<AccountSecurityResponse> {
    return this.request<AccountSecurityResponse>({
      path: "/api/account/security",
      defaultErrorPrefix: "GET /api/account/security",
    });
  }

  async getAccountDeletionEligibility(): Promise<AccountDeletionEligibility> {
    return this.request<AccountDeletionEligibility>({
      path: "/api/account/deletion/eligibility",
      defaultErrorPrefix: "GET /api/account/deletion/eligibility",
    });
  }

  async deleteAccount(): Promise<AccountDeletionResponse> {
    return this.request<AccountDeletionResponse>({
      method: "DELETE",
      path: "/api/account",
      body: { confirmation: "DELETE MY ACCOUNT" },
      defaultErrorPrefix: "DELETE /api/account",
      statusErrors: {
        400: () => new ApiError(400, "Account deletion confirmation was rejected."),
        409: (body) => new ApiError(
          409,
          body["code"] === "last_owner"
            ? "Transfer server ownership before deleting this account."
            : body["code"] === "owns_shared_rooms"
              ? "Reassign or delete shared Rooms owned by this account first."
              : body["code"] === "active_media_operation"
                ? "Wait for active media work to reach a safe terminal state before deleting this account."
              : "Account deletion is currently blocked.",
        ),
        422: () => new ApiError(422, "This account is managed by another server."),
      },
    });
  }

  /**
   * change the signed-in user's Logto password (server must
   * run with Logto auth). Throws `ApiError` with HTTP status on failure.
   */
  async changePassword(args: {
    currentPassword: string;
    newPassword: string;
    confirmPassword?: string;
  }): Promise<{ ok: true }> {
    await this.request<unknown>({
      method: "POST",
      path: "/api/account/password/change",
      body: args,
      defaultErrorPrefix: "POST /api/account/password/change",
      statusErrors: {
        401: (body) =>
          new InvalidCredentialsError(
            typeof body.error === "string" ? body.error : "Unauthorized",
          ),
        422: (body) =>
          new WrongCurrentPasswordError(
            typeof body.error === "string" ? body.error : "Current password is incorrect.",
          ),
        423: (body) =>
          new LockedOutError(typeof body.error === "string" ? body.error : "locked_out"),
      },
    });
    return { ok: true };
  }

  /**
   * after a user completes Logto hosted password recovery and signs
   * back in, clear Nautilo's local forced-password-change flag.
   */
  async markPasswordRecoveryCompleted(args: {
    sessionId: string;
    sessionToken: string;
  }): Promise<{ ok: true }> {
    await this.request<unknown>({
      method: "POST",
      path: "/api/account/password/recovery-completed",
      body: args,
      defaultErrorPrefix: "POST /api/account/password/recovery-completed",
    });
    return { ok: true };
  }

  /** account recovery codes status (signed in). */
  async getLogtoRecoveryCodeStatus(): Promise<LogtoRecoveryCodesSummary> {
    const body = await this.request<{
      remaining?: unknown;
      total?: unknown;
      lastGeneratedAt?: string | null;
    }>({
      path: "/api/account/recovery-codes/status",
      defaultErrorPrefix: "GET /api/account/recovery-codes/status",
    });
    return {
      remaining: Number(body.remaining ?? 0),
      total: Number(body.total ?? 0),
      lastGeneratedAt:
        typeof body.lastGeneratedAt === "string" ? body.lastGeneratedAt : null,
    };
  }

  /**
   * regenerate account recovery codes. Plaintext codes appear only in this response.
   */
  async regenerateLogtoRecoveryCodes(args?: {
    pin?: string;
  }): Promise<{ recoveryCodes: string[] }> {
    const body: Record<string, string> = {};
    if (args?.pin !== undefined && args.pin.length > 0) {
      body["pin"] = args.pin;
    }
    const res = await this.request<{ recoveryCodes?: string[] }>({
      method: "POST",
      path: "/api/account/recovery-codes/regenerate",
      body,
      defaultErrorPrefix: "POST /api/account/recovery-codes/regenerate",
    });
    return { recoveryCodes: res.recoveryCodes ?? [] };
  }

  async getPinEnrollment(): Promise<{ enrolled: boolean }> {
    const body = await this.request<{ enrolled?: boolean }>({
      path: "/api/auth/pin-enrollment",
      defaultErrorPrefix: "GET /api/auth/pin-enrollment",
    });
    return { enrolled: body.enrolled === true };
  }

  async changePin(args: PinMutationRequest): Promise<PinMutationResponse> {
    const payload: PinMutationRequest = {
      newPin: args.newPin,
    };
    if (args.currentPin !== undefined && args.currentPin.length > 0) {
      payload.currentPin = args.currentPin;
    }
    return this.postAuthPin(payload);
  }

  /**
   * localhost-only recovery. Sends Bearer when set (required once
   * trust preHandler runs on this route).
   *
   * `auth: "session-fresh"` forces the helper to call the
   * registered `tokenProvider` before each request. The default `"session"`
   * mode reads the cached token only; if the provider hasn't pushed a
   * fresh token to the apiClient yet (still racing the user's click,
   * common right after sign-in or a state-change rebroadcast), the
   * request goes out with no Authorization header and the server
   * returns 401 "Authentication required". The same race burned us in
   * the invite-redeem wizard and the forgot-pin dialog QA.
   */
  async recoverPin(
    recoveryCode: string,
    newPin: string,
  ): Promise<{ codesRemaining: number; ok?: boolean }> {
    return this.request<{ codesRemaining: number; ok?: boolean }>({
      method: "POST",
      path: "/api/auth/recover",
      auth: "session-fresh",
      body: { recoveryCode, newPin },
      defaultErrorPrefix: "POST /api/auth/recover",
    });
  }

  async recoverPinWithFreshJwt(newPin: string): Promise<{ ok: true; codesRemaining: number }> {
    const body = await this.request<{ ok?: boolean; codesRemaining?: number }>({
      method: "POST",
      path: "/api/auth/recover",
      auth: "session-fresh",
      body: { newPin },
      defaultErrorPrefix: "POST /api/auth/recover",
      statusErrors: {
        400: (b) =>
          new ApiError(
            400,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "Invalid input",
          ),
        401: (b) => {
          if (b.error === "fresh_reauth_required") {
            return new ApiError(
              401,
              typeof b["message"] === "string" && b["message"].length > 0
                ? b["message"]
                : "This action requires a recently-issued access token. Re-authenticate with prompt=login and retry.",
            );
          }
          return new ApiError(
            401,
            typeof b.error === "string" && b.error.length > 0
              ? b.error
              : "Authentication required",
          );
        },
        403: (b) =>
          new ApiError(
            403,
            typeof b.error === "string" && b.error.length > 0
              ? b.error
              : "PIN recovery is only allowed from localhost",
          ),
      },
    });
    return { ok: true, codesRemaining: Number(body.codesRemaining ?? 0) };
  }

  /**
   * Recovery-code relay for hosted password reset.
   *
   * Proves the Nautilo recovery code and opens a short-lived recovery
   * session. Nautilo never collects the new password: the response carries
   * the Logto hosted reset URL plus a `sessionId` / `sessionToken` the caller
   * uses with {@link getRecoveryRelayCode} to read the Logto verification
   * code once Logto delivers it. The new password is entered only on Logto's
   * hosted page.
   *
   * `newPassword` is no longer part of the request; callers that still pass it
   * are tolerated server-side but should drop the field.
   */
  async recoverPasswordWithCode(input: {
    handle: string;
    recoveryCode: string;
  }): Promise<{
    ok: true;
    sessionId: string;
    sessionToken: string;
    resetUrl: string;
    email: string;
  }> {
    return this.request<{
      ok: true;
      sessionId: string;
      sessionToken: string;
      resetUrl: string;
      email: string;
    }>({
      method: "POST",
      path: "/api/account/password/recover-with-code",
      auth: "none",
      body: input,
      defaultErrorPrefix: "POST /api/account/password/recover-with-code",
      statusErrors: {
        400: (b) => {
          if (b.error === "invalid_handle" || b["code"] === "invalid_handle") {
            return new ApiError(400, "invalid_handle");
          }
          if (b.error === "invalid_email" || b["code"] === "invalid_email") {
            return new ApiError(400, "invalid_email");
          }
          return new ApiError(
            400,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "Invalid input",
          );
        },
        401: () => new ApiError(401, "Recovery request could not be completed."),
        403: () =>
          new ApiError(
            403,
            "Password recovery with a code is only allowed from localhost.",
          ),
        429: () => new ApiError(429, "Too many recovery attempts. Try again later."),
        500: () => new ApiError(500, "Recovery request could not be completed."),
        502: () => new ApiError(502, "Recovery request could not be completed."),
      },
    });
  }

  /**
   * poll for the Logto ForgotPassword verification code relayed
   * through the HTTP Email connector, authenticated by the `sessionToken`
   * from {@link recoverPasswordWithCode}. Returns `{ status: "pending" }`
   * until Logto delivers the code, then `{ status: "ready", code }`.
   */
  async getRecoveryRelayCode(input: {
    sessionId: string;
    sessionToken: string;
  }): Promise<
    { status: "pending" } | { status: "ready"; code: string }
  > {
    const relaySchema = z.discriminatedUnion("status", [
      z.object({ status: z.literal("pending") }),
      z.object({ status: z.literal("ready"), code: z.string().min(1) }),
    ]);
    return this.request<
      { status: "pending" } | { status: "ready"; code: string }
    >({
      method: "GET",
      path: `/api/account/password/recovery-relay/${encodeURIComponent(input.sessionId)}`,
      auth: "none",
      headers: { Authorization: `Bearer ${input.sessionToken}` },
      schema: relaySchema,
      defaultErrorPrefix: "GET /api/account/password/recovery-relay",
      statusErrors: {
        400: () => new ApiError(400, "Recovery request could not be completed."),
        403: () =>
          new ApiError(
            403,
            "Password recovery with a code is only allowed from localhost.",
          ),
        404: () => new ApiError(404, "Recovery session not found or expired."),
        429: () => new ApiError(429, "Too many recovery attempts. Try again later."),
      },
    });
  }

  private async ownerClaimMutation<T>(
    operation: "bind" | "complete-profile" | "redeem",
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof OwnerClaimApiError) throw error;
      if (error instanceof ApiError) {
        // The server did reply, but this client did not recognize the status
        // contract. Preserve that fact for a coordinator rather than making
        // it look like a normal transport failure.
        throw new OwnerClaimApiError(
          error.status,
          "unexpected_owner_claim_error",
          error.message,
        );
      }
      // Fetch rejection, an interrupted response, or malformed success JSON
      // can all occur after the server accepted a mutation. Do not encourage
      // a blind retry; reobserve the canonical server state first.
      throw new OwnerClaimAmbiguousWriteError(operation);
    }
  }

  async bindLogtoUser(input: { state: string }): Promise<BindLogtoUserResponse> {
    return this.ownerClaimMutation("bind", () =>
      this.request<BindLogtoUserResponse>({
        method: "POST",
        path: "/api/bind-logto-user",
        body: input,
        schema: bindLogtoUserResponseSchema,
        defaultErrorPrefix: "POST /api/bind-logto-user",
        statusErrors: {
          400: (body) => ownerClaimServerError(400, body, "invalid_bind_request"),
          401: (body) => ownerClaimServerError(401, body, "authentication_required"),
          404: (body) => ownerClaimServerError(404, body, "logto_user_not_found"),
          409: (body) => ownerClaimServerError(409, body, "claim_reserved"),
          410: (body) => ownerClaimServerError(410, body, "used_up"),
          422: (body) => ownerClaimServerError(422, body, "invalid_state"),
          502: (body) => ownerClaimServerError(502, body, "logto_lookup_failed"),
          503: (body) => ownerClaimServerError(503, body, "logto_unconfigured"),
          500: (body) => ownerClaimServerError(500, body, "bind_invariant_failed"),
        },
      }),
    );
  }

  async getRecoveryCodeStatus(): Promise<{ total: number; used: number; remaining: number }> {
    return this.request<{ total: number; used: number; remaining: number }>({
      path: "/api/auth/recovery-codes/status",
      defaultErrorPrefix: "GET /api/auth/recovery-codes/status",
    });
  }

  async regenerateRecoveryCodes(args?: { pin?: string }): Promise<{ recoveryCodes: string[] }> {
    // `session-fresh` for the same race reason as recoverPin.
    return this.request<{ recoveryCodes: string[] }>({
      method: "POST",
      path: "/api/auth/recovery-codes/regenerate",
      auth: "session-fresh",
      body: args ?? {},
      defaultErrorPrefix: "POST /api/auth/recovery-codes/regenerate",
    });
  }

  /**
   * enroll first PIN (Logto) or change PIN; mirrors workbench enrollPin.
   * Omit `currentPin` when not yet enrolled.
   */
  async postAuthPin(body: PostAuthPinRequest): Promise<PinMutationResponse> {
    return this.request<PinMutationResponse>({
      method: "POST",
      path: "/api/auth/pin",
      body,
      schema: pinMutationResponseSchema,
      defaultErrorPrefix: "POST /api/auth/pin",
    });
  }

  async verifyAndResume(
    pin: string,
    threadId: string,
    laneKey?: string,
  ): Promise<{ token: string }> {
    return this.request<{ token: string }>({
      method: "POST",
      path: "/api/auth/verify-and-resume",
      auth: "none",
      body: { pin, threadId, ...(laneKey !== undefined ? { laneKey } : {}) },
      defaultErrorPrefix: "POST /api/auth/verify-and-resume",
    });
  }

  async proveItAndResume(
    pin: string,
    threadId: string,
    laneKey?: string,
    cryptoBinding?: ForegroundResumeCryptoBinding,
    challengeId?: string,
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/auth/prove-and-resume",
      body: { pin, threadId, laneKey, ...cryptoBinding, ...(challengeId === undefined ? {} : { challengeId }) },
      defaultErrorPrefix: "POST /api/auth/prove-and-resume",
    });
  }

  /**
   * verify PIN + resume an `identity_challenge` interrupt (Logto session).
   */
  async identityVerifyResume(
    pin: string,
    threadId: string,
    laneKey?: string,
    cryptoBinding?: ForegroundResumeCryptoBinding,
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/auth/identity-verify-resume",
      body: { pin, threadId, laneKey, ...cryptoBinding },
      defaultErrorPrefix: "POST /api/auth/identity-verify-resume",
    });
  }

  async denyProveIt(
    threadId: string,
    laneKey?: string,
    cryptoBinding?: ForegroundResumeCryptoBinding,
    challengeId?: string,
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/auth/prove-and-resume",
      body: { denied: true, threadId, laneKey, ...cryptoBinding, ...(challengeId === undefined ? {} : { challengeId }) },
      defaultErrorPrefix: "POST /api/auth/prove-and-resume",
    });
  }

  /**
   * ask-verb reply. Sibling of `proveItAndResume` but for
   * the light-approval (no-PIN) flow. Server resumes the graph with
   * `{ approved: verb !== "deny", verb }`.
   */
  async approvalReply(
    verb: ApprovalReplyVerb,
    threadId: string,
    laneKey?: string,
    approvalId?: string,
    localMcpInstallDigest?: string,
    mediaGeneration?: {
      readonly digest: string;
      readonly quoteDigest: string;
      readonly revision: number;
    },
    cryptoBinding?: ForegroundResumeCryptoBinding,
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/auth/approval-reply",
      body: {
        verb,
        threadId,
        ...(laneKey !== undefined ? { laneKey } : {}),
        ...(approvalId !== undefined ? { approvalId } : {}),
        ...(localMcpInstallDigest !== undefined ? { localMcpInstallDigest } : {}),
        ...(mediaGeneration !== undefined
          ? {
              mediaGenerationDigest: mediaGeneration.digest,
              mediaGenerationQuoteDigest: mediaGeneration.quoteDigest,
              mediaGenerationRevision: mediaGeneration.revision,
            }
          : {}),
        ...cryptoBinding,
      },
      defaultErrorPrefix: "POST /api/auth/approval-reply",
    });
  }

  async hostChoiceReply(
    choiceId: string,
    selector: string,
    threadId: string,
    laneKey?: string,
  ): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>({
      method: "POST",
      path: "/api/auth/host-choice-reply",
      body: {
        choiceId,
        selector,
        threadId,
        ...(laneKey !== undefined ? { laneKey } : {}),
      },
      defaultErrorPrefix: "POST /api/auth/host-choice-reply",
    });
  }

  /** Electron-main only: mint one request-bound ordinary-origin credential. */
  async mintElectronOriginCredential(
    body: {
      requestId: string;
      relayId: string;
      desktopSessionId: string;
      method: "POST";
      path: string;
      bodySha256: string;
    },
    relayToken: string,
  ): Promise<{ credential: string; expiresAt: string }> {
    return this.request<{ credential: string; expiresAt: string }>({
      method: "POST",
      path: "/api/relay/electron-origin-credential",
      body,
      headers: { "X-Nautilo-Relay-Token": relayToken },
      defaultErrorPrefix: "POST /api/relay/electron-origin-credential",
    });
  }

  /**
   * Uses GET /api/health/keys without provider pings. `hasLlm`
   * conservatively recognizes self-contained provider credentials. Managed
   * Gateway readiness is derived server-side because it also requires a valid
   * API root. The normal session bearer lets the trust
   * preHandler resolve the caller's capability. Throws `ApiError` with `.status`
   * so callers (e.g. the settings page) can distinguish 401 (no
   * session) / 403 (lacks `manage_server_settings`) from transport
   * errors.
   */
  async getKeySummary(): Promise<{ keys: KeyReport[]; hasLlm: boolean }> {
    const keys = await this.request<KeyReport[]>({
      path: "/api/health/keys",
      defaultErrorPrefix: "GET /api/health/keys",
    });
    return { keys, hasLlm: computeHasLlmFromKeys(keys) };
  }

  /** Read the administrator-visible Nautilo Gateway API root. */
  async getNautiloGateway(): Promise<{ baseUrl: string | null }> {
    return this.request({
      path: "/api/setup/nautilo-gateway",
      defaultErrorPrefix: "GET /api/setup/nautilo-gateway",
    });
  }

  /** Update the Nautilo Gateway API root. */
  async updateNautiloGateway(baseUrl: string): Promise<{ baseUrl: string }> {
    return this.request({
      method: "PUT",
      path: "/api/setup/nautilo-gateway",
      auth: "session-fresh",
      body: { baseUrl },
      defaultErrorPrefix: "PUT /api/setup/nautilo-gateway",
    });
  }

  /** Read the bounded web-research policy. Requires `read_server_settings`. */
  async getResearchProvider(): Promise<{
    provider: "auto" | "duckduckgo_html";
    tavilyConfigured?: boolean;
  }> {
    return this.request({
      path: "/api/setup/research-provider",
      defaultErrorPrefix: "GET /api/setup/research-provider",
    });
  }

  /** Update the bounded web-research policy. Requires `manage_server_operations`. */
  async updateResearchProvider(provider: "auto" | "duckduckgo_html"): Promise<{
    provider: "auto" | "duckduckgo_html";
    tavilyConfigured?: boolean;
  }> {
    return this.request({
      method: "PUT",
      path: "/api/setup/research-provider",
      auth: "session-fresh",
      body: { provider },
      defaultErrorPrefix: "PUT /api/setup/research-provider",
    });
  }

  /** Read caller-scoped connected-Desktop research availability. */
  async getResearchStatus(): Promise<{
    desktopReaderAvailable: boolean;
    keylessSearchAvailable: boolean;
  }> {
    return this.request({
      path: "/api/setup/research-status",
      defaultErrorPrefix: "GET /api/setup/research-status",
    });
  }

  /**
   * Creates a canonical room message with `POST /api/rooms/:roomId/messages`.
   * `roomId` is the URL path param only; do not embed `roomId` or legacy `message` in `body`
   * (use `content`).
   */
  async sendRoomMessage(
    roomId: string,
    body: {
      content?: string;
      /** optional server-minted socket-local foreground session. */
      clientActionSessionId?: string;
      /** picker-authored stable Human recipients. */
      mentionedHumanUserIds?: string[];
      replyToMessageId?: number;
      attachments?: ChatUploadedAttachmentRef[];
      voiceMode?: boolean;
      /** Ephemeral, client-selected approval posture for this turn. Server-side policy remains authoritative. */
      autoApprove?: boolean;
      currentFolder?: string | null;
      /** sender-bound relay identity for the Current Folder. */
      currentFolderRelayId?: string | null;
      workspacePath?: string | null;
      laneKey?: string;
      /** optional UI-selected bot (opens/continues focus without `@`). */
      uiSelectedBotActorId?: string | null;
      /** ask_user resume: original human row's turn id (dedup the re-send). */
      resumeTurnId?: string | null;
      /** original persisted human message id (exclude from bot context block). */
      resumeMessageId?: number | null;
      /** client-detected IANA timezone; server validates + resolves. */
      userTimezone?: string;
      /** compact active mini-app context from the Workbench app surface. */
      activeMiniApp?: ActiveMiniAppRequestContext | null;
      /** metadata-only "focus on these artifacts" references (no upload). */
      artifactRefs?: ChatArtifactRef[] | null;
      /** Closed, server-validated neutral presentation for a card-owned continuation. */
      cardContinuation?: "advanced_video";
      /**
       * Optional per-turn model override, resolved by the server with `getModelById`.
       * When absent or unknown to the server, normal model selection applies.
       */
      model?: string;
      /** exact prepared Browser live Shadow sibling for this one send. */
      liveShadow?: LiveShadowMessageSendAttemptV1;
    },
    options?: {
      mobileOriginProof?: RemoteOrdinaryRequestProof;
      /** Electron-main only; a renderer never receives this opaque value. */
      electronOriginCredential?: string;
    },
  ): Promise<RoomMessageSendResponse> {
    const requestBody = body.liveShadow === undefined
      ? body
      : {
          ...body,
          liveShadow: liveShadowMessageSendAttemptV1Schema.parse(
            body.liveShadow,
          ),
        };
    return this.request<RoomMessageSendResponse>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages`,
      body: requestBody,
      ...(options?.mobileOriginProof || options?.electronOriginCredential
        ? {
            headers: {
              ...(options.mobileOriginProof
                ? { "X-Nautilo-Mobile-Origin": JSON.stringify(options.mobileOriginProof) }
                : {}),
              ...(options.electronOriginCredential
                ? { "X-Nautilo-Electron-Origin": options.electronOriginCredential }
                : {}),
            },
          }
        : {}),
      defaultErrorPrefix: `POST /api/rooms/${roomId}/messages`,
      statusErrors: {
        403: (responseBody) =>
          responseBody["code"] === "direct_human_interaction_blocked"
            ? new DirectHumanInteractionBlockedError()
            : new ApiError(
                403,
                typeof responseBody.error === "string"
                  ? responseBody.error
                  : "Forbidden",
              ),
        409: (responseBody) =>
          strictShadowProtectedContentRequiredError(409, responseBody),
        425: (responseBody) =>
          strictShadowProtectedContentRequiredError(425, responseBody),
      },
    });
  }

  /** Read one canonical awaiting-checkpoint page without resuming execution. */
  async getRoomPendingAttention(
    roomId: string,
    input: RoomPendingAttentionPageRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<RoomPendingAttentionPageResponse> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/pending-attention`,
      body: input,
      schema: roomPendingAttentionPageResponseSchema,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/pending-attention`,
    });
  }

  /** Open one protected awaiting checkpoint with fresh decrypt-only custody. */
  async readRoomPendingAttention(
    roomId: string,
    input: RoomPendingAttentionReadRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<RoomPendingAttentionReadResponse> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/pending-attention/read`,
      body: input,
      schema: roomPendingAttentionReadResponseSchema,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/pending-attention/read`,
    });
  }

  /** Exhaust ordinary pending-attention pages; protected pages require custody. */
  async recoverOrdinaryRoomPendingAttention(
    roomId: string,
    input: Omit<RoomPendingAttentionPageRequest, "cursor">,
    options: Readonly<{
      signal?: AbortSignal;
      isCurrent?: () => boolean;
      expectedUserId: string;
      expectedHumanActorId: string;
    }>,
  ): Promise<RoomPendingAttentionRecoveryResponse> {
    const current = (): boolean => {
      if (options.signal?.aborted) return false;
      try {
        return options.isCurrent?.() ?? true;
      } catch {
        return false;
      }
    };
    const events: ServerEvent[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    try {
      for (;;) {
        if (!current()) return { status: "unavailable", events: [] };
        const page = await this.getRoomPendingAttention(roomId, {
          ...input,
          ...(cursor === undefined ? {} : { cursor }),
        }, options.signal === undefined ? undefined : { signal: options.signal });
        if (!current() || page.status !== "ready" || page.challenge !== undefined
          || page.events.some((event) => !isRoomPendingAttentionEventForViewer(
            event,
            {
              roomId,
              userId: options.expectedUserId,
              humanActorId: options.expectedHumanActorId,
            },
          ))) {
          return { status: "unavailable", events: [] };
        }
        events.push(...page.events);
        if (page.nextCursor === null) return { status: "ready", events };
        if (seenCursors.has(page.nextCursor)) {
          return { status: "unavailable", events: [] };
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }
    } catch {
      return { status: "unavailable", events: [] };
    }
  }

  /** Reserve one exact Browser/private-Room live Shadow turn before custody opens. */
  async planLiveShadowRoomMessage(
    roomId: string,
    input: LiveShadowMessagePlanRequest,
  ): Promise<LiveShadowMessagePlanResponseV1> {
    const body = liveShadowMessagePlanRequestSchema.parse(input);
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/plan`,
      body,
      schema: liveShadowMessagePlanResponseV1Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/plan`,
    });
  }

  /** Best-effort explicit logout teardown for process-local Agent authority. */
  async teardownLiveShadowForegroundAuthorizationSessions(): Promise<void> {
    return this.request<void>({
      method: "DELETE",
      path: "/api/live-shadow/foreground-authorization-sessions",
      emptyResponse: true,
      defaultErrorPrefix:
        "DELETE /api/live-shadow/foreground-authorization-sessions",
    });
  }

  /** Submit the current Browser device's exact terminal turn verification. */
  async verifyLiveShadowRoomMessage(
    roomId: string,
    operationId: string,
    input: LiveShadowMessageClientVerificationRequestV1,
  ): Promise<LiveShadowMessageClientVerificationResponseV1> {
    const body = liveShadowMessageClientVerificationRequestV1Schema.parse(
      input,
    );
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/${
        encodeURIComponent(operationId)
      }/verify`,
      body,
      schema: liveShadowMessageClientVerificationResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/${operationId}/verify`,
    });
  }

  /** Record one receiving Browser device's Human-peer parity result. */
  async acknowledgeHumanPeerLiveShadowMessage(
    roomId: string,
    operationId: string,
    input: HumanPeerLiveShadowAcknowledgementRequestV1,
  ): Promise<HumanPeerLiveShadowAcknowledgementResponseV1> {
    const body = humanPeerLiveShadowAcknowledgementRequestV1Schema.parse(
      input,
    );
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/human-peer/${
        encodeURIComponent(operationId)
      }/ack`,
      body,
      schema: humanPeerLiveShadowAcknowledgementResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/human-peer/${operationId}/ack`,
    });
  }

  async planHumanPeerLiveShadowAcknowledgement(
    roomId: string,
    operationId: string,
    input: HumanPeerLiveShadowAcknowledgementPlanRequestV1,
  ): Promise<HumanPeerLiveShadowAcknowledgementPlanResponseV1> {
    const body = humanPeerLiveShadowAcknowledgementPlanRequestV1Schema.parse(
      input,
    );
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/human-peer/${
        encodeURIComponent(operationId)
      }/ack-plan`,
      body,
      schema: humanPeerLiveShadowAcknowledgementPlanResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/human-peer/${operationId}/ack-plan`,
    });
  }

  /** Record one receiving Browser device's shared-Agent Human-message result. */
  async acknowledgeSharedAgentLiveShadowMessage(
    roomId: string,
    operationId: string,
    input: SharedAgentLiveShadowAcknowledgementRequestV1,
  ): Promise<SharedAgentLiveShadowAcknowledgementResponseV1> {
    const body = sharedAgentLiveShadowAcknowledgementRequestV1Schema.parse(
      input,
    );
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/shared-agent/${
        encodeURIComponent(operationId)
      }/ack`,
      body,
      schema: sharedAgentLiveShadowAcknowledgementResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/shared-agent/${operationId}/ack`,
    });
  }

  async planSharedAgentLiveShadowAcknowledgement(
    roomId: string,
    operationId: string,
    input: SharedAgentLiveShadowAcknowledgementPlanRequestV1,
  ): Promise<SharedAgentLiveShadowAcknowledgementPlanResponseV1> {
    const body = sharedAgentLiveShadowAcknowledgementPlanRequestV1Schema.parse(
      input,
    );
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/shared-agent/${
        encodeURIComponent(operationId)
      }/ack-plan`,
      body,
      schema: sharedAgentLiveShadowAcknowledgementPlanResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/shared-agent/${operationId}/ack-plan`,
    });
  }

  async planSharedAgentOutputRead(
    roomId: string,
    executionId: string,
    input: SharedAgentOutputReadPlanRequestV1,
  ): Promise<SharedAgentOutputReadPlanResponseV1> {
    const body = sharedAgentOutputReadPlanRequestV1Schema.parse(input);
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/shared-agent-output/${
        encodeURIComponent(executionId)
      }/read-plan`,
      body,
      schema: sharedAgentOutputReadPlanResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/shared-agent-output/${executionId}/read-plan`,
    });
  }

  async acknowledgeSharedAgentOutput(
    roomId: string,
    executionId: string,
    input: SharedAgentLiveShadowAcknowledgementRequestV1,
  ): Promise<SharedAgentLiveShadowAcknowledgementResponseV1> {
    const body = sharedAgentLiveShadowAcknowledgementRequestV1Schema.parse(
      input,
    );
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/shared-agent-output/${
        encodeURIComponent(executionId)
      }/ack`,
      body,
      schema: sharedAgentLiveShadowAcknowledgementResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/shared-agent-output/${executionId}/ack`,
    });
  }

  /** Complete a Conductor-selected shared-Room foreground authorization. */
  async authorizeSharedAgentExecution(
    roomId: string,
    executionId: string,
    input: SharedAgentExecutionAuthorizationRequestV1,
  ): Promise<SharedAgentExecutionAuthorizationResponseV1> {
    const body = sharedAgentExecutionAuthorizationRequestV1Schema.parse(input);
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/shared-agent/${
        encodeURIComponent(executionId)
      }/authorize`,
      body,
      schema: sharedAgentExecutionAuthorizationResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/shared-agent/${executionId}/authorize`,
    });
  }

  /** Complete an Agent-free foreground Runtime invocation authorization. */
  async authorizeRuntimeInvocation(
    roomId: string,
    invocationId: string,
    input: RuntimeInvocationAuthorizationRequestV1,
  ): Promise<RuntimeInvocationAuthorizationResponseV1> {
    const body = runtimeInvocationAuthorizationRequestV1Schema.parse(input);
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/runtime-invocation/${
        encodeURIComponent(invocationId)
      }/authorize`,
      body,
      schema: runtimeInvocationAuthorizationResponseV1Schema,
      defaultErrorPrefix:
        `POST /api/rooms/${roomId}/live-shadow/runtime-invocation/${invocationId}/authorize`,
    });
  }

  /** Recover durable live-turn evidence without replaying the Agent run. */
  async recoverLiveShadowRoomMessage(
    roomId: string,
    operationId: string,
  ): Promise<LiveShadowMessageRecoveryResponseV1> {
    return this.request({
      method: "GET",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/${
        encodeURIComponent(operationId)
      }/recovery`,
      schema: liveShadowMessageRecoveryResponseV1Schema,
      defaultErrorPrefix:
        `GET /api/rooms/${roomId}/live-shadow/${operationId}/recovery`,
    });
  }


  /** Resolve the class-bound V2 Domain head and this exact device envelope. */
  async planDomainKeyAuthorityV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyAuthorityPlanRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyAuthorityPlanResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/plan`,
      body: domainKeyAuthorityPlanRequestV2Schema.parse(input),
      schema: domainKeyAuthorityPlanResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/plan`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async publishDomainKeyAuthorityV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyAuthorityPublishRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyAuthorityPublishResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/publish`,
      body: domainKeyAuthorityPublishRequestV2Schema.parse(input),
      schema: domainKeyAuthorityPublishResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/publish`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async requestDomainKeyRecipientV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyRecipientRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyRecipientRequestResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/recipient/request`,
      body: domainKeyRecipientRequestV2Schema.parse(input),
      schema: domainKeyRecipientRequestResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/recipient/request`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async listPendingDomainKeyRequestsV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyPendingRequestListV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyPendingRequestListResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/recipient/pending`,
      body: domainKeyPendingRequestListV2Schema.parse(input),
      schema: domainKeyPendingRequestListResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/recipient/pending`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async listPendingDomainKeySourceWorkV2(
    input: DomainKeyPendingSourceListV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyPendingSourceListResponseV2> {
    return this.request({
      method: "POST",
      path: "/api/live-shadow/domain-key/source/pending",
      body: domainKeyPendingSourceListV2Schema.parse(input),
      schema: domainKeyPendingSourceListResponseV2Schema,
      defaultErrorPrefix: "POST /api/live-shadow/domain-key/source/pending",
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async fulfilDomainKeyRecipientV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyRecipientFulfilRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyRecipientFulfilResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/recipient/fulfil`,
      body: domainKeyRecipientFulfilRequestV2Schema.parse(input),
      schema: domainKeyRecipientFulfilResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/recipient/fulfil`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async fetchDomainKeyEnvelopeV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyEnvelopeFetchRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyEnvelopeFetchResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/recipient/fetch`,
      body: domainKeyEnvelopeFetchRequestV2Schema.parse(input),
      schema: domainKeyEnvelopeFetchResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/recipient/fetch`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async acknowledgeDomainKeyEnvelopeV2(
    roomId: string,
    namespaceId: string,
    input: DomainKeyEnvelopeAcknowledgeRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainKeyEnvelopeAcknowledgeResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/recipient/acknowledge`,
      body: domainKeyEnvelopeAcknowledgeRequestV2Schema.parse(input),
      schema: domainKeyEnvelopeAcknowledgeResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/recipient/acknowledge`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async planDomainNamespaceBundleV2(
    roomId: string,
    namespaceId: string,
    input: DomainNamespaceBundlePlanRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainNamespaceBundlePlanResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/bundle/plan`,
      body: domainNamespaceBundlePlanRequestV2Schema.parse(input),
      schema: domainNamespaceBundlePlanResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/bundle/plan`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async publishDomainNamespaceBundleV2(
    roomId: string,
    namespaceId: string,
    input: DomainNamespaceBundlePublishRequestV2,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<DomainNamespaceBundlePublishResponseV2> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/live-shadow/domain-key/${encodeURIComponent(namespaceId)}/bundle/publish`,
      body: domainNamespaceBundlePublishRequestV2Schema.parse(input),
      schema: domainNamespaceBundlePublishResponseV2Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/live-shadow/domain-key/bundle/publish`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }


  /** add the caller's reaction to a room message. */
  async addReaction(
    roomId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ reactions: RoomReactionAggregate[] }> {
    return this.request<{ reactions: RoomReactionAggregate[] }>({
      method: "PUT",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      defaultErrorPrefix: `PUT /api/rooms/${roomId}/messages/${messageId}/reactions/${emoji}`,
    });
  }

  /** remove the caller's reaction from a room message. */
  async removeReaction(
    roomId: string,
    messageId: string,
    emoji: string,
  ): Promise<{ reactions: RoomReactionAggregate[] }> {
    return this.request<{ reactions: RoomReactionAggregate[] }>({
      method: "DELETE",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      defaultErrorPrefix: `DELETE /api/rooms/${roomId}/messages/${messageId}/reactions/${emoji}`,
    });
  }

  /** hard-delete a room message (gone from API, transcript, search). */
  async deleteRoomMessage(roomId: string, messageId: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>({
      method: "DELETE",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      auth: "session-fresh",
      defaultErrorPrefix: `DELETE /api/rooms/${roomId}/messages/${messageId}`,
    });
  }

  /** edit the caller's persisted Human message using revision CAS. */
  async editRoomMessage(
    roomId: string,
    messageId: string,
    body: EditRoomMessageRequest,
  ): Promise<EditRoomMessageResponse> {
    return this.request<EditRoomMessageResponse>({
      method: "PATCH",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`,
      body,
      auth: "session-fresh",
      statusErrors: {
        409: (errorBody) => {
          const current = errorBody["current"];
          const currentRecord =
            current && typeof current === "object"
              ? (current as Record<string, unknown>)
              : null;
          if (
            currentRecord &&
            typeof currentRecord["id"] === "string" &&
            typeof currentRecord["logicalMessageKey"] === "string" &&
            typeof currentRecord["content"] === "string" &&
            (typeof currentRecord["editedAt"] === "string" ||
              currentRecord["editedAt"] === null) &&
            typeof currentRecord["editRevision"] === "number"
          ) {
            return new MessageEditConflictError({
              id: currentRecord["id"],
              logicalMessageKey: currentRecord["logicalMessageKey"],
              content: currentRecord["content"],
              editedAt: currentRecord["editedAt"],
              editRevision: currentRecord["editRevision"],
            });
          }
          return new ApiError(409, "message_edit_conflict");
        },
      },
      defaultErrorPrefix: `PATCH /api/rooms/${roomId}/messages/${messageId}`,
    });
  }

  async planProtectedHumanMessageEdit(
    roomId: string,
    messageId: string,
    body: HumanMessageEditPlanRequestV1,
  ): Promise<HumanMessageEditPlanResponseV1> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/edit-plan`,
      body: humanMessageEditPlanRequestV1Schema.parse(body),
      auth: "session-fresh",
      schema: humanMessageEditPlanResponseV1Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/messages/${messageId}/edit-plan`,
    });
  }

  async publishProtectedHumanMessageEdit(
    roomId: string,
    messageId: string,
    body: HumanMessageEditPreparedRequestV1,
  ): Promise<HumanMessageEditPreparedResponseV1> {
    return this.request({
      method: "PATCH",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/protected`,
      body: humanMessageEditPreparedRequestV1Schema.parse(body),
      auth: "session-fresh",
      schema: humanMessageEditPreparedResponseV1Schema,
      defaultErrorPrefix: `PATCH /api/rooms/${roomId}/messages/${messageId}/protected`,
    });
  }

  /**
   * mark every visible message in a room as read for the caller, up to an
   * optional `upToMessageId` (inclusive). Idempotent; `marked` is the number of
   * rows that actually flipped unread → read.
   */
  async markRoomRead(
    roomId: string,
    opts?: MarkRoomReadRequest,
  ): Promise<MarkRoomReadResponse> {
    const result = await this.request<MarkRoomReadResponse>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/read`,
      body: opts ?? {},
      auth: "session-fresh",
      defaultErrorPrefix: `POST /api/rooms/${roomId}/read`,
    });
    this.notificationStateInvalidated?.();
    return result;
  }

  /**
   * mark a single message read for the caller. Uses the refreshing
   * (`session-fresh`) auth path so the desktop renderer can't 401 on a stale
   * cached bearer.
   */
  async markMessageRead(messageId: number): Promise<{ ok: true }> {
    const result = await this.request<{ ok: true }>({
      method: "POST",
      path: `/api/messages/${messageId}/read`,
      body: {},
      auth: "session-fresh",
      defaultErrorPrefix: `POST /api/messages/${messageId}/read`,
    });
    this.notificationStateInvalidated?.();
    return result;
  }

  /**
   * fetch aggregated read/delivery state for a message via the
   * refreshing auth path.
   */
  async getMessageReadState(messageId: number): Promise<MessageReadStateDto> {
    return this.request<MessageReadStateDto>({
      method: "GET",
      path: `/api/messages/${messageId}/read-state`,
      auth: "session-fresh",
      defaultErrorPrefix: `GET /api/messages/${messageId}/read-state`,
    });
  }

  /** active room silence window for banner display. */
  async getRoomSilence(roomId: string): Promise<{
    silence: {
      id: string;
      kind: "mute" | "deaf";
      botActorId: string | null;
      botDisplayName: string | null;
      setByDisplayName: string;
      expiresAt: string;
    } | null;
    canManage: boolean;
  }> {
    return this.request({
      path: `/api/rooms/${encodeURIComponent(roomId)}/silence`,
      defaultErrorPrefix: `GET /api/rooms/${roomId}/silence`,
    });
  }

  /** open a mute/deaf window (manage_rooms gated). */
  async setRoomSilence(
    roomId: string,
    body: {
      kind: "mute" | "deaf";
      botActorId?: string | null;
      durationMs?: number;
    },
  ): Promise<{
    silence: {
      id: string;
      kind: "mute" | "deaf";
      botActorId: string | null;
      botDisplayName: string | null;
      setByDisplayName: string;
      expiresAt: string;
    };
  }> {
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/silence`,
      body,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/silence`,
    });
  }

  /** clear active silence window(s) early (manage_rooms gated). */
  async clearRoomSilence(roomId: string): Promise<{
    ok: true;
    cleared: number;
    silence: {
      id: string;
      kind: "mute" | "deaf";
      botActorId: string | null;
      botDisplayName: string | null;
      setByDisplayName: string;
      expiresAt: string;
    } | null;
  }> {
    return this.request({
      method: "DELETE",
      path: `/api/rooms/${encodeURIComponent(roomId)}/silence`,
      defaultErrorPrefix: `DELETE /api/rooms/${roomId}/silence`,
    });
  }

  /**
   * the requesting user's active focus links in a room (private to
   * the requester). `focusId` is required for {@link clearRoomFocus}.
   */
  async getRoomFocus(roomId: string): Promise<{
    foci: Array<{
      focusId: string;
      botActorId: string;
      handle: string;
      expiresAt: string;
      source?: "mention" | "reply" | "ui" | "inferred" | null;
    }>;
    /** Requester-private global focus access recency, filtered to this room's eligible Genies. */
    recentBotActorIds: string[];
  }> {
    return this.request<{
      foci: Array<{
        focusId: string;
        botActorId: string;
        handle: string;
        expiresAt: string;
        source?: "mention" | "reply" | "ui" | "inferred" | null;
      }>;
      recentBotActorIds: string[];
    }>({
      path: `/api/rooms/${encodeURIComponent(roomId)}/focus`,
      defaultErrorPrefix: `GET /api/rooms/${roomId}/focus`,
    });
  }

  /** open (or extend) a focus on a bot via the UI (no message sent). */
  async openRoomFocus(
    roomId: string,
    botActorId: string,
  ): Promise<{
    focusId: string;
    botActorId: string;
    expiresAt: string;
    clearedBotActorIds?: string[];
  }> {
    return this.request<{
      focusId: string;
      botActorId: string;
      expiresAt: string;
      clearedBotActorIds?: string[];
    }>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/focus`,
      body: { botActorId },
      defaultErrorPrefix: `POST /api/rooms/${roomId}/focus`,
    });
  }

  /** explicitly clear one of the requester's focus links. */
  async clearRoomFocus(
    roomId: string,
    focusId: string,
  ): Promise<{ ok: true }> {
    return this.request<{ ok: true }>({
      method: "DELETE",
      path: `/api/rooms/${encodeURIComponent(roomId)}/focus/${encodeURIComponent(focusId)}`,
      defaultErrorPrefix: `DELETE /api/rooms/${roomId}/focus/${focusId}`,
    });
  }

  /** @deprecated Use {@link sendRoomMessage} — this alias still posts to `POST /api/chat`. */
  async sendMessage(
    request: SendMessageRequest
  ): Promise<SendMessageResponse> {
    return this.request<SendMessageResponse>({
      method: "POST",
      path: "/api/chat",
      body: request,
      defaultErrorPrefix: "POST /api/chat",
    });
  }

  /** read the authenticated Human's account default and Room overrides. */
  async getNotificationPreferences(): Promise<NotificationPreferencesDto> {
    return this.request<NotificationPreferencesDto>({
      path: "/api/notifications/preferences",
      defaultErrorPrefix: "GET /api/notifications/preferences",
    });
  }

  /** fetch one complete authoritative notification-state snapshot. */
  async getNotificationState(): Promise<NotificationStateResponse> {
    return this.request<NotificationStateResponse>({
      path: "/api/notifications/state",
      statusErrors: {
        413: () => new NotificationStateTooLargeApiError(),
      },
      defaultErrorPrefix: "GET /api/notifications/state",
    });
  }

  /** list one page of the authenticated Human's durable event feed. */
  async listEventFeed(options: EventFeedListOptions = {}): Promise<EventFeedPage> {
    const parsed = eventFeedListOptionsSchema.parse(options);
    const query = new URLSearchParams();
    if (parsed.cursor !== undefined) query.set("cursor", parsed.cursor);
    if (parsed.unreadOnly !== undefined) {
      query.set("unreadOnly", String(parsed.unreadOnly));
    }
    for (const type of parsed.types ?? []) query.append("types", type);
    if (parsed.limit !== undefined) query.set("limit", String(parsed.limit));
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request<EventFeedPage>({
      path: `/api/event-feed${suffix}`,
      schema: eventFeedPageSchema,
      statusErrors: {
        400: (body) => eventFeedApiError(400, body),
      },
      defaultErrorPrefix: "GET /api/event-feed",
    });
  }

  /** Read personal Events attention independently of chat notification policy. */
  async getEventFeedPreference(): Promise<EventFeedPreference> {
    return this.request({
      path: "/api/event-feed/preference",
      schema: eventFeedPreferenceSchema,
      defaultErrorPrefix: "GET /api/event-feed/preference",
    });
  }

  async setEventFeedPreference(preference: EventFeedPreference): Promise<EventFeedPreference> {
    return this.request({
      method: "PUT",
      path: "/api/event-feed/preference",
      body: eventFeedPreferenceSchema.parse(preference),
      schema: eventFeedPreferenceSchema,
      statusErrors: { 400: (body) => eventFeedApiError(400, body) },
      defaultErrorPrefix: "PUT /api/event-feed/preference",
    });
  }

  /** Fetch the authoritative unread count, independently of attention policy. */
  async getEventFeedUnreadCount(): Promise<EventFeedUnreadCount> {
    return this.request<EventFeedUnreadCount>({
      path: "/api/event-feed/unread-count",
      schema: eventFeedUnreadCountSchema,
      defaultErrorPrefix: "GET /api/event-feed/unread-count",
    });
  }

  /** idempotently mark one caller-owned feed entry read or unread. */
  async setEventFeedReadState(
    eventId: string,
    read: boolean,
  ): Promise<EventFeedReadMutationResult> {
    return this.request<EventFeedReadMutationResult>({
      method: "PUT",
      path: `/api/event-feed/${encodeURIComponent(eventId)}/read`,
      body: { read },
      schema: eventFeedReadMutationResultSchema,
      statusErrors: {
        400: (body) => eventFeedApiError(400, body),
        404: (body) => eventFeedApiError(404, body),
      },
      defaultErrorPrefix: `PUT /api/event-feed/${eventId}/read`,
    });
  }

  /** mark every currently unread caller-owned feed entry read. */
  async markAllEventFeedRead(): Promise<EventFeedMarkAllReadResult> {
    return this.request<EventFeedMarkAllReadResult>({
      method: "POST",
      path: "/api/event-feed/mark-all-read",
      schema: eventFeedMarkAllReadResultSchema,
      defaultErrorPrefix: "POST /api/event-feed/mark-all-read",
    });
  }

  /** update the authenticated Human's account notification default. */
  async setDefaultNotificationLevel(
    defaultLevel: NotificationLevel,
  ): Promise<NotificationPreferencesDto> {
    const result = await this.request<NotificationPreferencesDto>({
      method: "PUT",
      path: "/api/notifications/preferences",
      body: { defaultLevel },
      defaultErrorPrefix: "PUT /api/notifications/preferences",
    });
    this.notificationStateInvalidated?.();
    return result;
  }

  /** set or inherit one top-level Room notification preference. */
  async setRoomNotificationPreference(
    roomId: string,
    level: "inherit" | NotificationLevel,
  ): Promise<RoomNotificationPreferenceDto> {
    const result = await this.request<RoomNotificationPreferenceDto>({
      method: "PUT",
      path: `/api/rooms/${encodeURIComponent(roomId)}/notification-preference`,
      body: { level },
      defaultErrorPrefix: `PUT /api/rooms/${roomId}/notification-preference`,
    });
    this.notificationStateInvalidated?.();
    return result;
  }

  /**
   * authenticated create/rotate for one server-scoped Mobile binding.
   * The server owns encryption and stores only a digest of `revokeProof`.
   */
  async registerPushInstallation(
    input: MobilePushInstallationRegisterRequest,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<MobilePushInstallationStatus> {
    return this.request<MobilePushInstallationStatus>({
      method: "POST",
      path: "/api/push/installations",
      auth: "session-fresh",
      body: mobilePushInstallationRegisterRequestSchema.parse(input),
      schema: mobilePushInstallationStatusSchema,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "POST /api/push/installations",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** Read one authenticated caller-owned binding; token and proof never return. */
  async getPushInstallationStatus(
    bindingId: string,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<MobilePushInstallationStatus> {
    return this.request<MobilePushInstallationStatus>({
      path: `/api/push/installations/${encodeURIComponent(bindingId)}`,
      auth: "session-fresh",
      schema: mobilePushInstallationStatusSchema,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "GET /api/push/installations/:bindingId",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** Synchronize installation-local app-badge policy without rotating a token. */
  async setPushInstallationBadgePreference(
    input: MobilePushInstallationBadgePreferenceRequest,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<MobilePushInstallationBadgePreferenceResponse> {
    const parsed = mobilePushInstallationBadgePreferenceRequestSchema.parse(input);
    return this.request<MobilePushInstallationBadgePreferenceResponse>({
      method: "PUT",
      path: `/api/push/installations/${encodeURIComponent(parsed.bindingId)}/badge-preference`,
      auth: "session-fresh",
      body: parsed,
      schema: mobilePushInstallationBadgePreferenceResponseSchema,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "PUT /api/push/installations/:bindingId/badge-preference",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /**
   * Authenticated permission-off state transition. The caller can only
   * disable its own known binding; it cannot submit an Expo token or copy.
   */
  async disablePushInstallation(
    input: MobilePushInstallationDisableRequest,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<MobilePushInstallationStatus> {
    const parsed = mobilePushInstallationDisableRequestSchema.parse(input);
    return this.request<MobilePushInstallationStatus>({
      method: "PATCH",
      path: `/api/push/installations/${encodeURIComponent(parsed.bindingId)}`,
      auth: "session-fresh",
      body: parsed,
      schema: mobilePushInstallationStatusSchema,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "PATCH /api/push/installations/:bindingId",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** Authenticated deletion remains idempotent and cannot read another binding. */
  async revokePushInstallation(
    bindingId: string,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<void> {
    return this.request<void>({
      method: "DELETE",
      path: `/api/push/installations/${encodeURIComponent(bindingId)}`,
      auth: "session-fresh",
      emptyResponse: true,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "DELETE /api/push/installations/:bindingId",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /**
   * Bounded proof-only cleanup for offline removal. This verb never gains
   * read/register/rotate/test authority and does not require a bearer token.
   */
  async revokePushInstallationWithProof(
    input: MobilePushInstallationProofRevokeRequest,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<void> {
    const parsed = mobilePushInstallationProofRevokeRequestSchema.parse(input);
    return this.request<void>({
      method: "POST",
      path: `/api/push/installations/${encodeURIComponent(parsed.bindingId)}/revoke`,
      auth: "none",
      body: parsed,
      emptyResponse: true,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "POST /api/push/installations/:bindingId/revoke",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** Server maps this to fixed generic copy; caller cannot author a payload. */
  async sendPushInstallationTest(
    bindingId: string,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<MobilePushInstallationTestResponse> {
    return this.request<MobilePushInstallationTestResponse>({
      method: "POST",
      path: `/api/push/installations/${encodeURIComponent(bindingId)}/test`,
      auth: "session-fresh",
      body: mobilePushInstallationTestRequestSchema.parse({ version: 1 }),
      schema: mobilePushInstallationTestResponseSchema,
      statusErrors: pushInstallationStatusErrors,
      defaultErrorPrefix: "POST /api/push/installations/:bindingId/test",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /**
   * direct-invoke endpoint for user-initiated
   * history commands (undo / undo_turn / redo / list_revisions /
   * pin_revision / unpin_revision). Bypasses the LLM entirely —
   * powers `/undo`, `⌘Z` keybinds, and the undo/redo toolbar.
   *
   * Returns `{ result, duration, toolCallId }` on any non-error
   * HTTP status; the `result` string is the raw tool output (JSON
   * envelope for staged patches, error string otherwise — same
   * shape the LLM would see in its tool-message).
   *
   * 4xx responses (missing auth, bad command, disabled flag)
   * surface as `{ result: "Error: ..." }` so callers treat
   * transport errors and handler errors uniformly.
   */
  // Uses the same envelope-synthesis rationale as invokeDirect:
  // !res.ok composes `result: "Error: <body.error or HTTP <status>>"` into the success-shaped
  // return value, which the helper's fallbackOnError cannot do.
  async invokeDirect(request: {
    command: string;
    args?: Record<string, unknown>;
    roomId?: string | undefined;
    workspacePath?: string | null;
    currentFolder?: string | null;
  }): Promise<{
    result: string;
    duration: number;
    toolCallId: string;
  }> {
    const res = await this._fetch(`${this.baseUrl}/api/file/invoke-direct`, {
      method: "POST",
      headers: this.jsonHeaders(),
      body: JSON.stringify(request),
    });
    const body = (await res
      .json()
      .catch(() => ({ error: "non-JSON response" }))) as {
      result?: string;
      duration?: number;
      toolCallId?: string;
      error?: string;
    };
    if (!res.ok) {
      return {
        result: `Error: ${body.error ?? `HTTP ${res.status}`}`,
        duration: 0,
        toolCallId: "",
      };
    }
    return {
      result: body.result ?? "",
      duration: body.duration ?? 0,
      toolCallId: body.toolCallId ?? "",
    };
  }

  async getSecurityPosture(): Promise<SecurityPostureResponse> {
    return this.request<SecurityPostureResponse>({
      path: "/api/security/posture",
      defaultErrorPrefix: "GET /api/security/posture",
    });
  }

  async updateSecurityPosture(request: {
    deploymentMode?: SecurityPostureResponse["deploymentMode"];
    securityLevel?: SecurityPostureResponse["securityLevel"];
    allowUncontainedHostCommands?: boolean;
    pin: string;
  }): Promise<{ changed: boolean } & SecurityPostureResponse> {
    return this.request<{ changed: boolean } & SecurityPostureResponse>({
      method: "PUT",
      path: "/api/security/posture",
      body: request,
      defaultErrorPrefix: "PUT /api/security/posture",
    });
  }

  async getSecurityAuditLog(options?: {
    limit?: number;
    since?: string;
    actorId?: string;
    correlationId?: string;
    kinds?: readonly string[];
    cursor?: string;
  }): Promise<{ events: readonly SecurityAuditEvent[]; hasMore: boolean; nextCursor: string | null }> {
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.since !== undefined) params.set("since", options.since);
    if (options?.actorId !== undefined) params.set("actorId", options.actorId);
    if (options?.correlationId !== undefined) params.set("correlationId", options.correlationId);
    if (options?.kinds !== undefined && options.kinds.length > 0) {
      params.set("kinds", options.kinds.join(","));
    }
    if (options?.cursor !== undefined) params.set("cursor", options.cursor);
    const qs = params.toString();
    return this.request<{ events: readonly SecurityAuditEvent[]; hasMore: boolean; nextCursor: string | null }>({
      path: `/api/security/audit-log${qs ? `?${qs}` : ""}`,
      defaultErrorPrefix: "GET /api/security/audit-log",
    });
  }

  async listStandingApprovals(): Promise<CommandApprovalRow[]> {
    const result = await this.request({
      path: "/api/security/standing-approvals",
      schema: standingApprovalsListSchema,
      defaultErrorPrefix: "GET /api/security/standing-approvals",
    });
    return result.approvals;
  }

  async revokeStandingApproval(id: string): Promise<{ ok: boolean }> {
    return this.request({
      method: "DELETE",
      path: `/api/security/standing-approvals/${encodeURIComponent(id)}`,
      schema: okResponseSchema,
      defaultErrorPrefix: `DELETE /api/security/standing-approvals/${id}`,
    });
  }

  async listMcpAdminSummaries(): Promise<McpAdminSummary[]> {
    const result = await this.request<{ servers: Array<Record<string, unknown>> }>({
      path: "/api/mcp-servers",
      defaultErrorPrefix: "GET /api/mcp-servers",
    });
    return result.servers.map(projectMcpAdminSummary)
      .filter((row) => row.id.length > 0 && row.name.length > 0);
  }

  async getMcpAdminTools(name: string): Promise<McpAdminToolSummary[]> {
    const result = await this.request<{ tools: Array<Record<string, unknown>> }>({
      path: `/api/mcp-servers/${encodeURIComponent(name)}/tools`,
      defaultErrorPrefix: "GET /api/mcp-servers/:name/tools",
    });
    return result.tools.map(projectMcpAdminTool).filter((tool) => tool.name.length > 0);
  }

  async setMcpAdminEnabled(name: string, enabled: boolean, expectedRevision: string): Promise<McpAdminSummary> {
    const result = await this.request<{ server: Record<string, unknown> }>({
      method: "PATCH",
      path: `/api/mcp-servers/${encodeURIComponent(name)}/enabled`,
      body: { enabled, expectedRevision },
      defaultErrorPrefix: "PATCH /api/mcp-servers/:name/enabled",
    });
    return projectMcpAdminSummary(result.server);
  }

  async checkMcpAdminServer(name: string): Promise<McpAdminSummary> {
    const result = await this.request<{ server: Record<string, unknown> }>({
      method: "POST",
      path: `/api/mcp-servers/${encodeURIComponent(name)}/check`,
      body: {},
      defaultErrorPrefix: "POST /api/mcp-servers/:name/check",
    });
    return projectMcpAdminSummary(result.server);
  }

  async setMcpAdminToolEnabled(
    name: string,
    tool: string,
    enabled: boolean,
    expectedRevision: string,
  ): Promise<McpAdminMutationReceipt> {
    const result = await this.request<{
      server: Record<string, unknown>;
      tools?: Array<Record<string, unknown>>;
    }>({
      method: "PATCH",
      path: `/api/mcp-servers/${encodeURIComponent(name)}/tools/${encodeURIComponent(tool)}`,
      body: { enabled, expectedRevision },
      defaultErrorPrefix: "PATCH /api/mcp-servers/:name/tools/:tool",
    });
    return {
      server: projectMcpAdminSummary(result.server),
      tools: (result.tools ?? []).map(projectMcpAdminTool).filter((row) => row.name.length > 0),
    };
  }

  async getGoogleIntegrationStatus(): Promise<{
    configured: boolean;
    providerSetupStatus: "managed" | "setup_required" | "ready";
    canManageProviderSetup: boolean;
    clientId: string | null;
  }> {
    const result = await this.request<{
      configured?: unknown;
      providerSetupStatus?: unknown;
      canManageProviderSetup?: unknown;
      clientId?: unknown;
    }>({
      path: "/api/integrations/google/status",
      defaultErrorPrefix: "GET /api/integrations/google/status",
    });
    const providerSetupStatus =
      result.providerSetupStatus === "managed" ||
      result.providerSetupStatus === "ready"
        ? result.providerSetupStatus
        : "setup_required";
    return {
      configured: result.configured === true,
      providerSetupStatus,
      canManageProviderSetup: result.canManageProviderSetup === true,
      clientId:
        typeof result.clientId === "string" ? result.clientId : null,
    };
  }

  async listConnectedApps(): Promise<ConnectedAppsResponse> {
    return this.request({
      path: "/api/connected-apps",
      schema: ConnectedAppsResponseSchema,
      defaultErrorPrefix: "GET /api/connected-apps",
    });
  }

  async getConnectedAppResultMedia(
    ref: string,
    opts: { roomId: string; signal?: AbortSignal },
  ): Promise<Blob> {
    if (!/^[A-Za-z0-9_-]+$/u.test(ref)) throw new TypeError("Connected app preview reference is invalid.");
    if (opts.roomId.trim().length === 0) throw new TypeError("Connected app preview requires a Room.");
    const params = new URLSearchParams({ ref, roomId: opts.roomId });
    const response = await this._fetch(
      `${this.baseUrl}/api/connected-apps/result-media?${params.toString()}`,
      {
        headers: await this.authHeadersFresh(),
        redirect: "error",
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        response.status,
        typeof error.error === "string" ? error.error : "connected_app_preview_unavailable",
      );
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      throw new ApiError(502, "connected_app_preview_invalid");
    }
    return response.blob();
  }

  async startNotionConnection(): Promise<ConnectedAppOAuthStartResponse> {
    return this.startConnectedApp("notion");
  }

  async startConnectedApp(providerId: ConnectedAppProviderId): Promise<ConnectedAppOAuthStartResponse> {
    return this.request({
      method: "POST",
      path: `/api/connected-apps/${encodeURIComponent(providerId)}/oauth`,
      body: {},
      schema: ConnectedAppOAuthStartResponseSchema,
      defaultErrorPrefix: `POST /api/connected-apps/${providerId}/oauth`,
    });
  }

  async inspectNotionConnection(attemptId: string): Promise<ConnectedAppOAuthAttemptResponse> {
    return this.inspectConnectedApp("notion", attemptId);
  }

  async inspectConnectedApp(providerId: ConnectedAppProviderId, attemptId: string): Promise<ConnectedAppOAuthAttemptResponse> {
    return this.request({
      path: `/api/connected-apps/${encodeURIComponent(providerId)}/oauth/${encodeURIComponent(attemptId)}`,
      schema: ConnectedAppOAuthAttemptResponseSchema,
      defaultErrorPrefix: `GET /api/connected-apps/${providerId}/oauth/:attemptId`,
    });
  }

  async cancelNotionConnectionAttempt(attemptId: string): Promise<ConnectedAppOAuthAttemptResponse> {
    return this.cancelConnectedAppAttempt("notion", attemptId);
  }

  async cancelConnectedAppAttempt(providerId: ConnectedAppProviderId, attemptId: string): Promise<ConnectedAppOAuthAttemptResponse> {
    return this.request({
      method: "DELETE",
      path: `/api/connected-apps/${encodeURIComponent(providerId)}/oauth/${encodeURIComponent(attemptId)}`,
      schema: ConnectedAppOAuthAttemptResponseSchema,
      defaultErrorPrefix: `DELETE /api/connected-apps/${providerId}/oauth/:attemptId`,
    });
  }

  async getNotionProviderSetup(): Promise<ConnectedAppProviderSetup> {
    return this.getConnectedAppProviderSetup("notion");
  }

  async getConnectedAppProviderSetup(providerId: ConnectedAppProviderId): Promise<ConnectedAppProviderSetup> {
    return this.request({
      path: `/api/connected-apps/${encodeURIComponent(providerId)}/setup`,
      schema: ConnectedAppProviderSetupSchema,
      defaultErrorPrefix: `GET /api/connected-apps/${providerId}/setup`,
    });
  }

  async configureNotionProvider(input: ConnectedAppProviderSetupRequest): Promise<ConnectedAppProviderSetup> {
    return this.configureConnectedAppProvider("notion", input);
  }

  async configureConnectedAppProvider(
    providerId: ConnectedAppProviderId,
    input: ConnectedAppProviderSetupRequest,
  ): Promise<ConnectedAppProviderSetup> {
    return this.request({
      method: "PUT",
      path: `/api/connected-apps/${encodeURIComponent(providerId)}/setup`,
      body: input,
      schema: ConnectedAppProviderSetupSchema,
      defaultErrorPrefix: `PUT /api/connected-apps/${providerId}/setup`,
    });
  }

  async disconnectNotionConnection(): Promise<ConnectedAppDisconnectResponse> {
    return this.disconnectConnectedApp("notion");
  }

  async disconnectConnectedApp(providerId: ConnectedAppProviderId): Promise<ConnectedAppDisconnectResponse> {
    return this.request({
      method: "DELETE",
      path: `/api/connected-apps/${encodeURIComponent(providerId)}`,
      schema: ConnectedAppDisconnectResponseSchema,
      defaultErrorPrefix: `DELETE /api/connected-apps/${providerId}`,
    });
  }

  async configureGoogleOAuthClient(
    oauthClientJson: Blob,
  ): Promise<{ configured: boolean; clientId: string | null }> {
    const form = new FormData();
    form.append("file", oauthClientJson, "google-oauth-client.json");
    const response = await this._fetch(`${this.baseUrl}/api/integrations/google/oauth-client`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        response.status,
        typeof error.error === "string" ? error.error : "google_oauth_configuration_failed",
      );
    }
    const result = (await response.json()) as { configured?: unknown; clientId?: unknown };
    return {
      configured: result.configured === true,
      clientId: typeof result.clientId === "string" ? result.clientId : null,
    };
  }

  async removeGoogleOAuthClient(): Promise<{ configured: boolean }> {
    const result = await this.request<{ configured?: unknown }>({
      method: "DELETE",
      path: "/api/integrations/google/oauth-client",
      defaultErrorPrefix: "DELETE /api/integrations/google/oauth-client",
    });
    return { configured: result.configured === true };
  }

  /** server-owned Skills catalogue for the signed-in Human's Agent. */
  async listSkills(): Promise<SkillsListResponse> {
    return this.request({
      path: "/api/skills",
      auth: "session-fresh",
      schema: skillsListResponseSchema,
      defaultErrorPrefix: "GET /api/skills",
    });
  }

  async listSkillToolOptions(): Promise<SkillToolOption[]> {
    const result = await this.request({
      path: "/api/skills/tool-options",
      auth: "session-fresh",
      schema: skillToolOptionsResponseSchema,
      defaultErrorPrefix: "GET /api/skills/tool-options",
    });
    return result.tools;
  }

  async getSkill(name: string): Promise<SkillDetail> {
    const result = await this.request({
      path: `/api/skills/${encodeURIComponent(name)}`,
      auth: "session-fresh",
      schema: skillDetailResponseSchema,
      defaultErrorPrefix: "GET /api/skills/:name",
    });
    return result.skill;
  }

  async saveSkill(input: SaveSkillRequest): Promise<SkillDetail> {
    const result = await this.request({
      method: "PUT",
      path: "/api/skills",
      auth: "session-fresh",
      body: input,
      schema: skillDetailResponseSchema,
      defaultErrorPrefix: "PUT /api/skills",
    });
    return result.skill;
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<SkillDetail> {
    const result = await this.request({
      method: "PATCH",
      path: `/api/skills/${encodeURIComponent(name)}`,
      auth: "session-fresh",
      body: { enabled },
      schema: skillDetailResponseSchema,
      defaultErrorPrefix: "PATCH /api/skills/:name",
    });
    return result.skill;
  }

  async customizeSkill(name: string): Promise<SkillDetail> {
    const result = await this.request({
      method: "POST",
      path: `/api/skills/${encodeURIComponent(name)}/customize`,
      auth: "session-fresh",
      body: {},
      schema: skillDetailResponseSchema,
      defaultErrorPrefix: "POST /api/skills/:name/customize",
    });
    return result.skill;
  }

  async resetSkill(name: string): Promise<{ ok: true }> {
    return this.request({
      method: "POST",
      path: `/api/skills/${encodeURIComponent(name)}/reset`,
      auth: "session-fresh",
      body: {},
      schema: skillDeleteResponseSchema,
      defaultErrorPrefix: "POST /api/skills/:name/reset",
    });
  }

  async deleteSkill(name: string): Promise<{ ok: true }> {
    return this.request({
      method: "DELETE",
      path: `/api/skills/${encodeURIComponent(name)}`,
      auth: "session-fresh",
      schema: skillDeleteResponseSchema,
      defaultErrorPrefix: "DELETE /api/skills/:name",
    });
  }

  async getConnections(): Promise<ConnectionListResponse> {
    return this.request<ConnectionListResponse>({
      path: "/api/connections",
      defaultErrorPrefix: "GET /api/connections",
    });
  }

  async storeConnection(request: {
    service: string;
    field: string;
    value: string;
    category?: "user";
    expiresAt?: string | null;
  }): Promise<StoreConnectionResponse> {
    return this.request<StoreConnectionResponse>({
      method: "POST",
      path: "/api/connections",
      body: request,
      defaultErrorPrefix: "POST /api/connections",
    });
  }

  async deleteConnection(
    service: string,
    field: string,
  ): Promise<DeleteConnectionResponse> {
    return this.request<DeleteConnectionResponse>({
      method: "DELETE",
      path: `/api/connections/${encodeURIComponent(service)}/${encodeURIComponent(field)}`,
      defaultErrorPrefix: "DELETE /api/connections",
    });
  }

  async auditConnections(): Promise<ConnectionAuditResponse> {
    return this.request<ConnectionAuditResponse>({
      method: "POST",
      path: "/api/connections/audit",
      defaultErrorPrefix: "POST /api/connections/audit",
    });
  }

  /** Personal website-account lifecycle. The response schemas intentionally omit provider coordinates. */
  async listConnectedWebAccounts(): Promise<ConnectedWebAccountListResponse> {
    return this.request({
      path: "/api/connected-web-accounts",
      schema: connectedWebAccountListResponseSchema,
      defaultErrorPrefix: "GET /api/connected-web-accounts",
    });
  }

  async createConnectedWebAccount(
    request: ConnectedWebAccountCreateRequest,
  ): Promise<ConnectedWebAccountLoginResponse> {
    return this.request({
      method: "POST",
      path: "/api/connected-web-accounts",
      body: request,
      schema: connectedWebAccountLoginResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts",
    });
  }

  async finishConnectedWebAccount(id: string): Promise<ConnectedWebAccount> {
    return this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/finish`,
      body: {},
      schema: connectedWebAccountSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/finish",
    });
  }

  async reconnectConnectedWebAccount(id: string): Promise<ConnectedWebAccountLoginResponse> {
    return this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/reconnect`,
      body: {},
      schema: connectedWebAccountLoginResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/reconnect",
    });
  }

  /**
   * Opens one owner-authorized connected page in the protected foreground
   * browser. The returned live view is consumed only by the local UI; no
   * provider coordinate belongs in a tool result or ordinary transcript.
   */
  async openConnectedWebAccountPage(id: string): Promise<ConnectedWebAccountLoginResponse> {
    return this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/open-page`,
      body: {},
      schema: connectedWebAccountLoginResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/open-page",
    });
  }

  /** Stop one owner-authorized protected-page browser resource. */
  async closeConnectedWebAccountPage(id: string): Promise<ConnectedWebAccount> {
    const response = await this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/close-page`,
      body: {},
      schema: connectedWebAccountClosePageResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/close-page",
    });
    return response.account;
  }

  async cancelConnectedWebAccountLogin(id: string): Promise<ConnectedWebAccount> {
    const response = await this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/cancel-login`,
      body: {},
      schema: connectedWebAccountCancelLoginResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/cancel-login",
    });
    return response.account;
  }

  /** Safe, coarse activity only; provider event payloads and identifiers stay server-side. */
  async getConnectedWebAccountReadActivity(id: string): Promise<ConnectedWebAccountReadActivity> {
    return this.request({
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/read-activity`,
      schema: connectedWebAccountReadActivitySchema,
      defaultErrorPrefix: "GET /api/connected-web-accounts/:id/read-activity",
    });
  }

  /** Fetch the short-lived live browser capability for the local owner UI only. */
  async watchConnectedWebAccountRead(id: string): Promise<ConnectedWebAccountReadWatch> {
    return this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/watch-read`,
      body: {},
      schema: connectedWebAccountReadWatchSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/watch-read",
    });
  }

  async cancelConnectedWebAccountRead(id: string): Promise<ConnectedWebAccount> {
    const response = await this.request({
      method: "POST",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}/cancel-read`,
      body: {},
      schema: connectedWebAccountCancelReadResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-accounts/:id/cancel-read",
    });
    return response.account;
  }

  async getConnectedWebAccountActionActivity(deliveryId: string): Promise<ConnectedWebAccountActionActivity> {
    return this.request({ path: `/api/connected-web-actions/${encodeURIComponent(deliveryId)}/activity`, schema: connectedWebAccountActionActivitySchema, defaultErrorPrefix: "GET /api/connected-web-actions/:deliveryId/activity" });
  }
  async watchConnectedWebAccountAction(deliveryId: string): Promise<ConnectedWebAccountActionWatch> {
    return this.request({ method: "POST", path: `/api/connected-web-actions/${encodeURIComponent(deliveryId)}/watch`, body: {}, schema: connectedWebAccountActionWatchSchema, defaultErrorPrefix: "POST /api/connected-web-actions/:deliveryId/watch" });
  }
  async stopConnectedWebAccountAction(deliveryId: string): Promise<ConnectedWebAccountActionActivity> {
    const response = await this.request({ method: "POST", path: `/api/connected-web-actions/${encodeURIComponent(deliveryId)}/stop`, body: {}, schema: connectedWebAccountStopActionResponseSchema, defaultErrorPrefix: "POST /api/connected-web-actions/:deliveryId/stop" });
    return response.activity;
  }

  /** Exact owner operation projection; never resolves by account label or delivery aliases. */
  async getConnectedWebOperation(operationId: string, activityBefore?: number): Promise<ConnectedWebOperationProjection> {
    return this.request({
      path: `/api/connected-web-operations/${encodeURIComponent(operationId)}${activityBefore === undefined ? "" : `?activityBefore=${encodeURIComponent(activityBefore)}`}`,
      schema: connectedWebOperationProjectionSchema,
      defaultErrorPrefix: "GET /api/connected-web-operations/:operationId",
    });
  }

  async watchConnectedWebOperation(operationId: string): Promise<{ readonly liveViewUrl: string }> {
    return this.request({
      method: "POST",
      path: `/api/connected-web-operations/${encodeURIComponent(operationId)}/watch`,
      body: {},
      schema: connectedWebOperationWatchSchema,
      defaultErrorPrefix: "POST /api/connected-web-operations/:operationId/watch",
    });
  }

  async stopConnectedWebOperation(operationId: string): Promise<ConnectedWebOperationProjection> {
    const response = await this.request({
      method: "POST",
      path: `/api/connected-web-operations/${encodeURIComponent(operationId)}/stop`,
      body: {},
      schema: connectedWebOperationStopResponseSchema,
      defaultErrorPrefix: "POST /api/connected-web-operations/:operationId/stop",
    });
    return response.operation;
  }

  /** Resume exactly one owner-private connected-web action after sign-in. */
  async replyConnectedWebActionAttention(
    input: { threadId: string; laneKey: string; toolCallId: string; decision: "done" | "cancel" },
    cryptoBinding?: ForegroundResumeCryptoBinding,
  ): Promise<{ ok: true }> {
    return this.request({
      method: "POST",
      path: "/api/auth/connected-web-action-reply",
      body: { ...input, ...cryptoBinding },
      schema: z.object({ ok: z.literal(true) }).strict(),
      defaultErrorPrefix: "POST /api/auth/connected-web-action-reply",
    });
  }

  async disconnectConnectedWebAccount(id: string): Promise<ConnectedWebAccountDisconnectResponse> {
    return this.request({
      method: "DELETE",
      path: `/api/connected-web-accounts/${encodeURIComponent(id)}`,
      schema: connectedWebAccountDisconnectResponseSchema,
      defaultErrorPrefix: "DELETE /api/connected-web-accounts/:id",
    });
  }

  async createBackgroundJob(
    request: CreateBackgroundJobRequest
  ): Promise<CreateBackgroundJobResponse> {
    return this.request<CreateBackgroundJobResponse>({
      method: "POST",
      path: "/api/jobs",
      body: request,
      defaultErrorPrefix: "POST /api/jobs",
    });
  }

  async getJobStatus(jobId: string): Promise<JobStatusResponse> {
    return this.request<JobStatusResponse>({
      path: `/api/jobs/${jobId}`,
      defaultErrorPrefix: `GET /api/jobs/${jobId}`,
    });
  }

  /**
   * stop any live job by id (foreground turn, fork, task run, or
   * background). `stopped: false` means the job was already terminal / not
   * live (still a 200). Owner-only on the server (404 for another owner's job).
   */
  async stopJob(jobId: string): Promise<JobStopResponse> {
    return this.request<JobStopResponse>({
      method: "POST",
      path: `/api/jobs/${jobId}/stop`,
      defaultErrorPrefix: `POST /api/jobs/${jobId}/stop`,
    });
  }

  /**
   * stop the active conversation in one room: abort live jobs and
   * suppress queued/coalesced continuation for that room.
   */
  async stopRoom(roomId: string): Promise<RoomStopResponse> {
    return this.request<RoomStopResponse>({
      method: "POST",
      path: `/api/rooms/${roomId}/stop`,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/stop`,
    });
  }

  /**
   * list currently-running job ids for a room (reconnect run-state
   * reconcile). Read counterpart to `stopRoom`.
   */
  async getRoomActiveJobs(roomId: string): Promise<RoomActiveJobsResponse> {
    return this.request<RoomActiveJobsResponse>({
      method: "GET",
      path: `/api/rooms/${roomId}/active-jobs`,
      defaultErrorPrefix: `GET /api/rooms/${roomId}/active-jobs`,
    });
  }

  /**
   * List non-terminal tasks for the current owner (pending, running, paused,
   * awaiting). The server excludes terminal rows by default — no query params.
   */
  async listActiveTasks(): Promise<TaskSummary[]> {
    return this.request<TaskSummary[]>({
      path: "/api/tasks",
      defaultErrorPrefix: "GET /api/tasks",
    });
  }

  /**
   * List the current owner's Tasks with optional bounded recent terminal
   * history. Terminal inclusion is explicit and the server enforces its cap.
   */
  async listTasks(query: ListTasksQuery = {}): Promise<TaskSummary[]> {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set("status", query.status);
    if (query.includeTerminal !== undefined) {
      params.set("includeTerminal", String(query.includeTerminal));
    }
    if (query.recentTerminalLimit !== undefined) {
      params.set("recentTerminalLimit", String(query.recentTerminalLimit));
    }
    const suffix = params.size > 0 ? `?${params.toString()}` : "";
    return this.request<TaskSummary[]>({
      path: `/api/tasks${suffix}`,
      defaultErrorPrefix: "GET /api/tasks",
    });
  }

  /** Full task detail including run transcripts (`GET /api/tasks/:id`). */
  async getTask(taskId: string): Promise<TaskDetail> {
    return this.request<TaskDetail>({
      path: `/api/tasks/${encodeURIComponent(taskId)}`,
      defaultErrorPrefix: `GET /api/tasks/${taskId}`,
    });
  }

  /** Pending owner-private Task approvals reconstructed from durable checkpoints. */
  async listPendingTaskAttention(): Promise<ServerEvent[]> {
    return this.request<ServerEvent[]>({
      path: "/api/tasks/pending-attention",
      defaultErrorPrefix: "GET /api/tasks/pending-attention",
    });
  }

  /**
   * Stop a live task by id. Owner-only on the server (404 for another owner's
   * task).
   */
  async stopTask(taskId: string): Promise<TaskLifecycleResponse> {
    return this.request<TaskLifecycleResponse>({
      method: "POST",
      path: `/api/tasks/${taskId}/stop`,
      defaultErrorPrefix: `POST /api/tasks/${taskId}/stop`,
    });
  }

  /**
   * Pause a running or pending task by id. Owner-only on the server.
   */
  async pauseTask(taskId: string): Promise<TaskLifecycleResponse> {
    return this.request<TaskLifecycleResponse>({
      method: "POST",
      path: `/api/tasks/${taskId}/pause`,
      defaultErrorPrefix: `POST /api/tasks/${taskId}/pause`,
    });
  }

  /**
   * Unpause a paused task by id. Owner-only on the server.
   */
  async unpauseTask(taskId: string): Promise<TaskLifecycleResponse> {
    return this.request<TaskLifecycleResponse>({
      method: "POST",
      path: `/api/tasks/${taskId}/unpause`,
      defaultErrorPrefix: `POST /api/tasks/${taskId}/unpause`,
    });
  }

  private assertAgentPhotoFence(
    scope: AgentPhotoLibraryScopeDto | null,
    fence: AgentPhotoLibraryFence | undefined,
    validateRevisions = true,
    validateGeneration = true,
  ): void {
    if (!fence) return;
    const staleGeneration = validateGeneration
      && fence.getCurrentGeneration() !== fence.requestGeneration;
    const staleScope = scope !== null && (
      scope.serverInstanceId !== fence.serverInstanceId
      || scope.viewerUserId !== fence.viewerUserId
      || scope.agentId !== fence.agentId
      || (validateRevisions && fence.selectionRevision !== undefined
        && scope.selectionRevision !== fence.selectionRevision)
      || (validateRevisions && fence.libraryRevision !== undefined
        && scope.libraryRevision !== fence.libraryRevision)
    );
    if (!staleGeneration && !staleScope) return;
    throw new AgentPhotoLibraryApiError({
      status: 409,
      code: "stale_viewer_scope",
      message: "The selected Server, viewer, Agent, or photo-library generation changed",
      retryable: false,
      ...(scope ? { scope } : {}),
    });
  }

  private async requestAgentPhotoJson<T extends { scope: AgentPhotoLibraryScopeDto }>(input: {
    readonly method?: "GET" | "POST";
    readonly path: string;
    readonly schema: z.ZodType<T>;
    readonly body?: unknown;
    readonly headers?: Record<string, string>;
    readonly options?: AgentPhotoLibraryRequestOptions;
    /** Mutations return canonical advanced revisions; only identity/generation remain exact. */
    readonly acceptAdvancedRevisions?: boolean;
  }): Promise<T> {
    this.assertAgentPhotoFence(null, input.options?.fence);
    const headers = {
      ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(await this.authHeadersFresh()),
      ...(input.headers ?? {}),
    };
    let response: Response;
    try {
      response = await this._fetch(`${this.baseUrl}${input.path}`, {
        method: input.method ?? "GET",
        headers,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(input.options?.signal ? { signal: input.options.signal } : {}),
      });
    } catch (error) {
      if (input.options?.signal?.aborted) throw error;
      throw new AgentPhotoLibraryApiError({
        status: 0,
        code: "offline",
        message: "Nautilo could not be reached",
        retryable: true,
      });
    }
    if (!response.ok) {
      const error = await this.parseAgentPhotoError(response);
      this.assertAgentPhotoFence(error.scope ?? null, input.options?.fence, false);
      throw error;
    }
    const parsed = input.schema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new AgentPhotoLibraryApiError({
        status: 502,
        code: "photo_library_unavailable",
        message: "Nautilo returned an invalid photo-library response",
        retryable: true,
      });
    }
    const confirmedMutation = input.acceptAdvancedRevisions === true;
    this.assertAgentPhotoFence(
      parsed.data.scope,
      input.options?.fence,
      !confirmedMutation,
      !confirmedMutation,
    );
    return parsed.data;
  }

  private async parseAgentPhotoError(response: Response): Promise<AgentPhotoLibraryApiError> {
    const parsed = agentPhotoLibraryErrorEnvelopeSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (parsed.success) {
      return new AgentPhotoLibraryApiError({
        status: response.status,
        code: parsed.data.error.code,
        message: parsed.data.error.message,
        retryable: parsed.data.error.retryable,
        ...(parsed.data.error.scope ? { scope: parsed.data.error.scope } : {}),
        ...(parsed.data.error.current ? { current: parsed.data.error.current } : {}),
      });
    }
    return new AgentPhotoLibraryApiError({
      status: response.status,
      code: response.status === 401 ? "authentication_required" : "photo_library_unavailable",
      message: response.status === 401
        ? "Sign in to use your Agent photo library"
        : "Nautilo returned an invalid photo-library error",
      retryable: response.status >= 500,
    });
  }

  async getAgentPhotoLibraryCurrent(
    options?: AgentPhotoLibraryRequestOptions,
  ): Promise<AgentPhotoLibraryCurrentResponse> {
    return this.requestAgentPhotoJson({
      path: "/api/profile/agent-photo-library/current",
      schema: agentPhotoLibraryCurrentResponseSchema,
      ...(options ? { options } : {}),
    });
  }

  async listAgentPhotoLibrary(input: {
    readonly projection?: "recent" | "deleted";
    readonly limit?: number;
    readonly cursor?: string;
  } & AgentPhotoLibraryRequestOptions = {}): Promise<AgentPhotoLibraryListResponse> {
    const params = new URLSearchParams();
    if (input.projection !== undefined) params.set("projection", input.projection);
    if (input.limit !== undefined) params.set("limit", String(input.limit));
    if (input.cursor !== undefined) params.set("cursor", input.cursor);
    const query = params.toString();
    return this.requestAgentPhotoJson({
      path: `/api/profile/agent-photo-library${query ? `?${query}` : ""}`,
      schema: agentPhotoLibraryListResponseSchema,
      options: input,
    });
  }

  async listAgentPhotoLibraryPresets(
    options?: AgentPhotoLibraryRequestOptions,
  ): Promise<AgentPhotoLibraryPresetsResponse> {
    return this.requestAgentPhotoJson({
      path: "/api/profile/agent-photo-library/presets",
      schema: agentPhotoLibraryPresetsResponseSchema,
      ...(options ? { options } : {}),
    });
  }

  async getAgentPhotoLibraryEntry(
    entryId: string,
    options?: AgentPhotoLibraryRequestOptions,
  ): Promise<AgentPhotoLibraryEntryResponse> {
    return this.requestAgentPhotoJson({
      path: `/api/profile/agent-photo-library/entries/${encodeURIComponent(entryId)}`,
      schema: agentPhotoLibraryEntryResponseSchema,
      ...(options ? { options } : {}),
    });
  }

  async getAgentPhotoLibraryMedia(
    entryId: string,
    size: "thumb" | "full",
    options?: AgentPhotoLibraryRequestOptions,
  ): Promise<{ blob: Blob; contentType: "image/png" | "image/webp" }> {
    this.assertAgentPhotoFence(null, options?.fence);
    let response: Response;
    try {
      response = await this._fetch(
        `${this.baseUrl}/api/profile/agent-photo-library/entries/${encodeURIComponent(entryId)}/media?size=${size}`,
        {
          headers: await this.authHeadersFresh(),
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      if (options?.signal?.aborted) throw error;
      throw new AgentPhotoLibraryApiError({
        status: 0,
        code: "offline",
        message: "Nautilo could not be reached",
        retryable: true,
      });
    }
    if (!response.ok) {
      const error = await this.parseAgentPhotoError(response);
      this.assertAgentPhotoFence(error.scope ?? null, options?.fence, false);
      throw error;
    }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
    if (contentType !== "image/png" && contentType !== "image/webp") {
      throw new AgentPhotoLibraryApiError({
        status: 502,
        code: "photo_library_unavailable",
        message: "Nautilo returned invalid Agent photo media",
        retryable: true,
      });
    }
    const blob = await response.blob();
    if (blob.size < 1) {
      throw new AgentPhotoLibraryApiError({
        status: 502,
        code: "photo_blob_missing",
        message: "The requested Agent photo bytes are missing",
        retryable: false,
      });
    }
    this.assertAgentPhotoFence(null, options?.fence);
    return { blob, contentType };
  }

  async uploadAgentPhotoLibraryEntry(
    file: AgentAvatarUploadInput,
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibraryCreateResponse> {
    this.assertAgentPhotoFence(null, options.fence);
    const form = new FormData();
    const namedFile = file as { name?: unknown };
    const filename = typeof namedFile.name === "string" && namedFile.name.length > 0
      ? namedFile.name
      : "agent-photo.png";
    form.append("file", file as Blob, filename);
    let response: Response;
    try {
      response = await this._fetch(`${this.baseUrl}/api/profile/agent-photo-library/upload`, {
        method: "POST",
        headers: {
          ...(await this.authHeadersFresh()),
          "Idempotency-Key": options.idempotencyKey,
          "X-Agent-Photo-Origin": options.origin,
        },
        body: form,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new AgentPhotoLibraryApiError({
        status: 0,
        code: "offline",
        message: "Nautilo could not be reached",
        retryable: true,
      });
    }
    if (!response.ok) {
      const error = await this.parseAgentPhotoError(response);
      this.assertAgentPhotoFence(error.scope ?? null, options.fence, false);
      throw error;
    }
    const parsed = agentPhotoLibraryCreateResponseSchema.safeParse(
      await response.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new AgentPhotoLibraryApiError({ status: 502, code: "photo_library_unavailable", message: "Nautilo returned an invalid photo-library response", retryable: true });
    }
    // A websocket notification for this same accepted upload can advance the
    // caller's local read generation before the HTTP response arrives. The
    // parsed response still proves the exact server/viewer/Agent identity, so
    // return it and let the UI reconcile instead of misclassifying success as
    // an ambiguous result that is safe to replay.
    this.assertAgentPhotoFence(parsed.data.scope, options.fence, false, false);
    return parsed.data;
  }

  async generateAgentPhotoLibraryEntries(
    input: { readonly prompt: string; readonly count: 1 | 2 | 3 | 4 },
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibraryCreateResponse> {
    return this.requestAgentPhotoJson({
      method: "POST",
      path: "/api/profile/agent-photo-library/generate",
      schema: agentPhotoLibraryCreateResponseSchema,
      body: input,
      headers: {
        "Idempotency-Key": options.idempotencyKey,
        "X-Agent-Photo-Origin": options.origin,
      },
      options,
      acceptAdvancedRevisions: true,
    });
  }

  async selectAgentPhotoLibraryEntry(
    input: {
      readonly target: AgentPhotoSelectionTargetDto;
      readonly expectedSelectionRevision: string;
    },
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibrarySelectionResponse> {
    return this.requestAgentPhotoJson({
      method: "POST",
      path: "/api/profile/agent-photo-library/select",
      schema: agentPhotoLibrarySelectionResponseSchema,
      body: input,
      headers: {
        "Idempotency-Key": options.idempotencyKey,
        "X-Agent-Photo-Origin": options.origin,
      },
      options,
      acceptAdvancedRevisions: true,
    });
  }

  async undoAgentPhotoLibrarySelection(
    input: { readonly revisionId: string; readonly expectedSelectionRevision: string },
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibrarySelectionResponse> {
    return this.requestAgentPhotoJson({
      method: "POST",
      path: "/api/profile/agent-photo-library/undo",
      schema: agentPhotoLibrarySelectionResponseSchema,
      body: input,
      headers: {
        "Idempotency-Key": options.idempotencyKey,
        "X-Agent-Photo-Origin": options.origin,
      },
      options,
      acceptAdvancedRevisions: true,
    });
  }

  private async mutateAgentPhotoLibraryEntry(
    entryId: string,
    operation: "delete" | "restore",
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibraryEntryLifecycleResponse> {
    return this.requestAgentPhotoJson({
      method: "POST",
      path: `/api/profile/agent-photo-library/entries/${encodeURIComponent(entryId)}/${operation}`,
      schema: agentPhotoLibraryEntryLifecycleResponseSchema,
      headers: {
        "Idempotency-Key": options.idempotencyKey,
        "X-Agent-Photo-Origin": options.origin,
      },
      options,
      acceptAdvancedRevisions: true,
    });
  }

  async deleteAgentPhotoLibraryEntry(
    entryId: string,
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibraryEntryLifecycleResponse> {
    return this.mutateAgentPhotoLibraryEntry(entryId, "delete", options);
  }

  async restoreAgentPhotoLibraryEntry(
    entryId: string,
    options: AgentPhotoLibraryMutationOptions,
  ): Promise<AgentPhotoLibraryEntryLifecycleResponse> {
    return this.mutateAgentPhotoLibraryEntry(entryId, "restore", options);
  }

  async getProfile(options?: { fresh?: boolean }): Promise<AgentProfileResponse> {
    // ProfileProvider already resolves a bearer via useAuth().session.getAccessToken()
    // immediately before calling this method. Do not use "session-fresh" here:
    // a transient Logto SDK loading pulse can make the global provider return
    // null and overwrite the freshly latched token, causing /api/profile to
    // return the guest shell profile in a verified Workbench.
    return this.request<AgentProfileResponse>({
      path: "/api/profile",
      auth: options?.fresh === true ? "session-fresh" : "session",
      defaultErrorPrefix: "GET /api/profile",
    });
  }

  async updateProfile(data: AgentProfileMutation): Promise<AgentProfileResponse> {
    return this.request<AgentProfileResponse>({
      method: "PUT",
      path: "/api/profile",
      auth: "session-fresh",
      body: data,
      defaultErrorPrefix: "PUT /api/profile",
    });
  }

  /** Upload the authenticated caller's Human portrait as multipart `file`. */
  async uploadHumanAvatar(file: AgentAvatarUploadInput): Promise<HumanAvatarUploadResponse> {
    const form = new FormData();
    const namedFile = file as { name?: unknown };
    const filename = typeof namedFile.name === "string" && namedFile.name.length > 0
      ? namedFile.name
      : "human-avatar.png";
    form.append("file", file as Blob, filename);
    const res = await this._fetch(`${this.baseUrl}/api/profile/avatar`, {
      method: "POST",
      headers: await this.authHeadersFresh(),
      body: form,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(res.status, typeof body.error === "string" && body.error ? body.error : `POST /api/profile/avatar failed: ${res.status}`);
    }
    return humanAvatarUploadResponseSchema.parse(await res.json());
  }

  /**
   * set the Agent's @handle (without the leading "@"). The server
   * validates format and uniqueness; a taken handle returns 409.
   */
  async updateAgentHandle(handle: string): Promise<{ handle: string }> {
    return this.request<{ handle: string }>({
      method: "PATCH",
      path: "/api/profile/agent-handle",
      auth: "session-fresh",
      body: { handle },
      defaultErrorPrefix: "PATCH /api/profile/agent-handle",
    });
  }

  /** set/replace one voice slot (`default` or BCP-47 lang key). */
  async upsertVoiceAssignment(
    language: string,
    ref: { voiceId: string; voiceName: string },
  ): Promise<{ voices: Record<string, { voiceId: string; voiceName: string }> }> {
    return this.request({
      method: "PUT",
      path: `/api/profile/voices/${encodeURIComponent(language)}`,
      auth: "session-fresh",
      body: ref,
      defaultErrorPrefix: `PUT /api/profile/voices/${language}`,
    });
  }

  /** remove a per-language voice slot (not `default`). */
  async removeVoiceAssignment(
    language: string,
  ): Promise<{ voices: Record<string, { voiceId: string; voiceName: string }> }> {
    return this.request({
      method: "DELETE",
      path: `/api/profile/voices/${encodeURIComponent(language)}`,
      auth: "session-fresh",
      defaultErrorPrefix: `DELETE /api/profile/voices/${language}`,
    });
  }

  /**
   * hydrate Genie customization voice choices without requesting the
   * provider-account catalog. Remote non-guests receive only curated rows and
   * the optional-voice capability; owner/loopback retains the Desktop shape.
   */
  async getVoiceCustomizationHydration(): Promise<VoiceCustomizationHydrationResponse> {
    return this.request<VoiceCustomizationHydrationResponse>({
      path: "/api/voices",
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/voices",
    });
  }

  /**
   * emotion-compatible ElevenLabs shared voice catalog (server proxy).
   * Requires an authenticated non-guest session; returns shared catalog rows.
   */
  async listVoiceCatalog(query?: CatalogQuery): Promise<CatalogResponse> {
    const params = new URLSearchParams();
    if (query?.language !== undefined) params.set("language", query.language);
    if (query?.category !== undefined) params.set("category", query.category);
    if (query?.gender !== undefined) params.set("gender", query.gender);
    if (query?.age !== undefined) params.set("age", query.age);
    if (query?.accent !== undefined) params.set("accent", query.accent);
    if (query?.use_cases !== undefined) params.set("use_cases", query.use_cases);
    if (query?.search !== undefined) params.set("search", query.search);
    if (query?.page !== undefined) params.set("page", String(query.page));
    if (query?.page_size !== undefined) params.set("page_size", String(query.page_size));
    const qs = params.toString();
    return this.request<CatalogResponse>({
      path: `/api/voices/catalog${qs ? `?${qs}` : ""}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/voices/catalog",
    });
  }

  /**
   * synthesize a short server-selected speech-model preview for a catalog voice.
   * Pass `{ text }` for a custom Genie sample line; omit for the server default audition script.
   */
  async previewVoice(voiceId: string, input?: { text?: string }): Promise<Blob> {
    const headers: Record<string, string> = {
      ...(await this.authHeadersFresh()),
    };
    const init: RequestInit = { method: "POST", headers };
    if (input?.text !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ text: input.text });
    }
    const res = await this._fetch(
      `${this.baseUrl}/api/voices/${encodeURIComponent(voiceId)}/preview`,
      init,
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/voices/${voiceId}/preview failed: ${res.status}`,
      );
    }
    const contentType = res.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("audio/")) {
      throw new ApiError(502, "Voice preview did not return provider audio.");
    }
    const audio = await res.blob();
    if (audio.size === 0) throw new ApiError(502, "Voice preview returned empty provider audio.");
    return audio;
  }

  /**
   * fetch verified explainer MP4 bytes for a catalog id.
   *
   * Bearer-authenticated through the normal trust preHandler. The browser
   * sees only the local API response: no CDN/media URL, no provider identity,
   * no AgentSea reader token is ever exposed. The server verifies exact
   * byteLength + SHA-256 before responding, so the returned Blob is trusted
   * bytes; the caller should play it via a revocable Blob URL.
   *
   * Returns the Blob plus its byte length and format. Throws `ApiError` on
   * any non-2xx (401 unauthenticated, 404 unknown id, 502 verification failure,
   * 503 catalog unavailable).
   */
  async fetchExplainerMedia(id: string): Promise<{ blob: Blob; byteLength: number; format: "mp4" }> {
    const res = await this._fetch(
      `${this.baseUrl}/api/explainers/${encodeURIComponent(id)}/media`,
      { method: "GET", headers: await this.authHeadersFresh() },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/explainers/${id}/media failed: ${res.status}`,
      );
    }
    const blob = await res.blob();
    return { blob, byteLength: blob.size, format: "mp4" };
  }

  /**
   * Update the per-user fallback policy.
   *
   * Server validates each chain entry against the catalog (`getModelById`)
   * and rejects with 400 if any are unknown. Empty chain is allowed.
   * Owner-gated (same as `updateProfile`).
   *
   * Returns the updated `{ enabled, chain }` echoed from the server.
   */
  async updateFallbackPolicy(policy: {
    enabled: boolean;
    chain: string[];
  }): Promise<{ enabled: boolean; chain: string[] }> {
    return this.request<{ enabled: boolean; chain: string[] }>({
      method: "PATCH",
      path: "/api/profile/fallback",
      auth: "session-fresh",
      body: policy,
      defaultErrorPrefix: "PATCH /api/profile/fallback",
    });
  }

  async generateSoul(input: Record<string, unknown>): Promise<{ soulFile: string }> {
    return this.request<{ soulFile: string }>({
      method: "POST",
      path: "/api/profile/generate-soul",
      body: input,
      defaultErrorPrefix: "POST /api/profile/generate-soul",
    });
  }

  /** Dormant protected Artifact inventory; never falls back to plaintext routes. */
  async listProtectedArtifacts(options?: Readonly<{
    cursor?: string;
    limit?: number;
    includeArchive?: boolean;
  }>): Promise<ProtectedArtifactListResponseV1 | ProtectedArtifactUnavailableResponseV1> {
    const query = new URLSearchParams();
    if (options?.cursor !== undefined) query.set("cursor", options.cursor);
    if (options?.limit !== undefined) query.set("limit", String(options.limit));
    if (options?.includeArchive === true) query.set("includeArchive", "true");
    const suffix = query.toString();
    return this.request({
      path: `/api/protected/artifacts${suffix.length === 0 ? "" : `?${suffix}`}`,
      auth: "session-fresh",
      schema: z.union([
        protectedArtifactListResponseV1Schema,
        protectedArtifactUnavailableResponseV1Schema,
      ]),
      defaultErrorPrefix: "GET /api/protected/artifacts",
    });
  }

  async getProtectedArtifact(
    artifactId: string,
  ): Promise<ProtectedArtifactDtoV1 | ProtectedArtifactUnavailableResponseV1> {
    const response = await this.request({
      path: `/api/protected/artifacts/${encodeURIComponent(artifactId)}`,
      auth: "session-fresh",
      schema: z.union([
        protectedArtifactDtoV1Schema,
        protectedArtifactUnavailableResponseV1Schema,
      ]),
      defaultErrorPrefix: "GET /api/protected/artifacts/:id",
    });
    if ("artifactId" in response && response.artifactId !== artifactId) {
      throw new TypeError("Protected Artifact detail was substituted");
    }
    return response;
  }

  async getProtectedArtifactCiphertextRange(
    artifactId: string,
    input: Readonly<{ start: number; endExclusive: number; signal?: AbortSignal }>,
  ): Promise<
    ProtectedArtifactCiphertextRangeV1 | ProtectedArtifactUnavailableResponseV1
  > {
    if (
      !Number.isSafeInteger(input.start)
      || !Number.isSafeInteger(input.endExclusive)
      || input.start < 0
      || input.endExclusive < input.start
      || input.endExclusive - input.start > 1_048_576
    ) throw new RangeError("Protected Artifact range is invalid");
    const response = await this._fetch(
      `${this.baseUrl}/api/protected/artifacts/${encodeURIComponent(artifactId)}/ciphertext?start=${input.start}&endExclusive=${input.endExclusive}`,
      {
        headers: await this.authHeadersFresh(),
        redirect: "error",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
    );
    if (!response.ok) {
      throw new ApiError(response.status,
        `GET protected Artifact ciphertext range failed: ${response.status}`);
    }
    if (!response.headers.get("content-type")?.startsWith(
      "application/vnd.nautilo.artifact-blob-range-v1",
    )) {
      return protectedArtifactUnavailableResponseV1Schema.parse(
        await response.json(),
      );
    }
    const header = (name: string): string => {
      const value = response.headers.get(name);
      if (value === null) throw new TypeError(`Protected Artifact range omitted ${name}`);
      return value;
    };
    const integer = (name: string, minimum = 0): number => {
      const value = header(name);
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
        throw new TypeError(`Protected Artifact range ${name} is invalid`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < minimum) {
        throw new TypeError(`Protected Artifact range ${name} is invalid`);
      }
      return parsed;
    };
    const maximumBodyBytes = 2 * (1_048_576 + 44);
    const declared = contentLength(response);
    if (declared === undefined || declared < 0 || declared > maximumBodyBytes) {
      throw new TypeError("Protected Artifact encrypted range length is invalid");
    }
    if (response.body === null) throw new TypeError(
      "Protected Artifact encrypted range body is unavailable",
    );
    const output = new Uint8Array(declared);
    const reader = response.body.getReader();
    let offset = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value as Uint8Array;
        if (chunk.length > output.length - offset) {
          throw new TypeError("Protected Artifact encrypted range exceeded its length");
        }
        output.set(chunk, offset);
        offset += chunk.length;
      }
      if (offset !== output.length) throw new TypeError(
        "Protected Artifact encrypted range ended early",
      );
      const digest = header("x-nautilo-ciphertext-sha256");
      if (!/^[A-Za-z0-9_-]{43}$/u.test(digest)) {
        throw new TypeError("Protected Artifact ciphertext hash is invalid");
      }
      const artifactIdHeader = header("x-nautilo-artifact-id");
      if (artifactIdHeader !== artifactId) {
        throw new TypeError("Protected Artifact range identity was substituted");
      }
      const blobId = header("x-nautilo-blob-id");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(blobId)) {
        throw new TypeError("Protected Artifact range blob ID is invalid");
      }
      const plaintextLength = integer("x-nautilo-plaintext-length");
      const chunkPlaintextBytes = integer("x-nautilo-chunk-plaintext-bytes", 1);
      const chunkCount = integer("x-nautilo-chunk-count", 1);
      const firstChunkIndex = integer("x-nautilo-first-chunk-index");
      const returnedChunkCount = integer("x-nautilo-returned-chunk-count");
      const expectedChunkCount = Math.max(1, Math.ceil(plaintextLength / 1_048_576));
      const expectedFirstChunk = Math.floor(input.start / 1_048_576);
      const expectedReturned = input.start === input.endExclusive
        ? 0
        : Math.floor((input.endExclusive - 1) / 1_048_576)
          - expectedFirstChunk + 1;
      if (
        chunkPlaintextBytes !== 1_048_576
        || chunkCount !== expectedChunkCount
        || firstChunkIndex !== expectedFirstChunk
        || returnedChunkCount !== expectedReturned
      ) throw new TypeError("Protected Artifact encrypted range framing is invalid");
      let frameOffset = 0;
      for (let index = 0; index < returnedChunkCount; index += 1) {
        if (frameOffset + 4 > output.length) {
          throw new TypeError("Protected Artifact encrypted range frame is truncated");
        }
        const sealedLength = new DataView(
          output.buffer,
          output.byteOffset + frameOffset,
          4,
        ).getUint32(0, false);
        const chunkIndex = firstChunkIndex + index;
        const chunkStart = chunkIndex * 1_048_576;
        const plaintextChunkLength = Math.max(0, Math.min(
          1_048_576,
          plaintextLength - chunkStart,
        ));
        if (sealedLength !== plaintextChunkLength + 40) {
          throw new TypeError("Protected Artifact encrypted chunk length is invalid");
        }
        frameOffset += 4 + sealedLength;
      }
      if (frameOffset !== output.length) {
        throw new TypeError("Protected Artifact encrypted range has trailing bytes");
      }
      return Object.freeze({
        status: "encrypted_chunks" as const,
        artifactId: artifactIdHeader,
        artifactRevision: integer("x-nautilo-artifact-revision", 1),
        cryptoAccessRevision: integer("x-nautilo-crypto-access-revision"),
        blobId,
        blobGeneration: integer("x-nautilo-blob-generation", 1),
        plaintextLength,
        ciphertextLength: integer("x-nautilo-ciphertext-length", 1),
        ciphertextSha256Base64url: digest,
        chunkPlaintextBytes: 1_048_576,
        chunkCount,
        firstChunkIndex,
        returnedChunkCount,
        body: output,
      });
    } catch (error) {
      output.fill(0);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }


  async beginProtectedInitialDeviceBootstrap(
    input: ProtectedInitialDeviceBeginRequestV1,
  ): Promise<ProtectedInitialDeviceChallengeV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/initial-bootstrap/begin",
      auth: "session-fresh",
      body: protectedInitialDeviceBeginRequestV1Schema.parse(input),
      schema: protectedInitialDeviceChallengeV1Schema,
      defaultErrorPrefix: "POST protected initial-device bootstrap begin",
    });
  }

  async beginProtectedAdditionalDevice(
    input: ProtectedAdditionalDeviceBeginRequestV1,
  ): Promise<ProtectedAdditionalDevicePlanV1> {
    const body = protectedAdditionalDeviceBeginRequestV1Schema.parse(input);
    const response = await this.request({
      method: "POST",
      path: "/api/protected/devices/additional/begin",
      auth: "session-fresh",
      body,
      schema: protectedAdditionalDevicePlanV1Schema,
      defaultErrorPrefix: "POST protected additional-device begin",
    });
    if (response.enrollment.deviceId !== body.deviceId) {
      throw new TypeError("Protected additional-device enrollment was substituted");
    }
    return response;
  }

  async beginProtectedAdditionalDeviceV2(
    input: ProtectedAdditionalDeviceBeginRequestV2,
  ): Promise<ProtectedAdditionalDevicePlanV2> {
    const body = protectedAdditionalDeviceBeginRequestV2Schema.parse(input);
    const response = await this.request({
      method: "POST",
      path: "/api/protected/devices/additional/begin",
      auth: "session-fresh",
      body,
      schema: protectedAdditionalDevicePlanV2Schema,
      defaultErrorPrefix: "POST protected additional-device begin V2",
    });
    if (response.enrollment.deviceId !== body.deviceId) {
      throw new TypeError("Protected additional-device enrollment was substituted");
    }
    return response;
  }

  async loadProtectedAdditionalDevicePlanPageV2(
    operationId: string,
    input: ProtectedAdditionalDevicePlanPageRequestV2,
  ): Promise<ProtectedAdditionalDevicePlanV2> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/plan-page`,
      auth: "session-fresh",
      body: protectedAdditionalDevicePlanPageRequestV2Schema.parse(input),
      schema: protectedAdditionalDevicePlanV2Schema,
      defaultErrorPrefix: "POST protected additional-device plan page V2",
    });
    if (
      response.enrollment.operationId !== operationId
      || response.enrollment.deviceId !== input.deviceId
    ) {
      throw new TypeError("Protected additional-device plan page was substituted");
    }
    return response;
  }

  async listProtectedAdditionalDevicePending(
    input: ProtectedAdditionalDevicePendingListRequestV1,
  ): Promise<ProtectedAdditionalDevicePendingListV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/additional/pending",
      auth: "session-fresh",
      body: protectedAdditionalDevicePendingListRequestV1Schema.parse(input),
      schema: protectedAdditionalDevicePendingListV1Schema,
      defaultErrorPrefix: "POST protected additional-device pending list",
    });
  }

  async listProtectedAdditionalDevicePendingV2(
    input: ProtectedAdditionalDevicePendingListRequestV2,
  ): Promise<ProtectedAdditionalDevicePendingListV2> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/additional/pending",
      auth: "session-fresh",
      body: protectedAdditionalDevicePendingListRequestV2Schema.parse(input),
      schema: protectedAdditionalDevicePendingListV2Schema,
      defaultErrorPrefix: "POST protected additional-device pending list V2",
    });
  }

  async publishProtectedAdditionalDeviceJoinPackages(
    operationId: string,
    input: ProtectedAdditionalDeviceJoinPackagesRequestV1,
  ): Promise<{ readonly status: "published" | "duplicate" }> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/join-packages`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceJoinPackagesRequestV1Schema.parse(input),
      schema: z.object({ status: z.enum(["published", "duplicate"]) }).strict(),
      defaultErrorPrefix: "POST protected additional-device join packages",
    });
  }

  async publishProtectedAdditionalDeviceJoinPackagesV2(
    operationId: string,
    input: ProtectedAdditionalDeviceJoinPackagesRequestV2,
  ): Promise<{ readonly status: "published" | "duplicate" }> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/join-packages`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceJoinPackagesRequestV2Schema.parse(input),
      schema: z.object({ status: z.enum(["published", "duplicate"]) }).strict(),
      defaultErrorPrefix: "POST protected additional-device join packages V2",
    });
  }

  async approveProtectedAdditionalDevice(
    operationId: string,
    input: ProtectedAdditionalDeviceApprovalRequestV1,
  ): Promise<ProtectedAdditionalDeviceApprovalResponseV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/approve`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceApprovalRequestV1Schema.parse(input),
      schema: protectedAdditionalDeviceApprovalResponseV1Schema,
      defaultErrorPrefix: "POST protected additional-device approval",
    });
    if (response.operationId !== operationId) {
      throw new TypeError("Protected additional-device approval was substituted");
    }
    return response;
  }

  async planProtectedAdditionalDeviceTransitions(
    operationId: string,
    input: ProtectedAdditionalDeviceTransitionPlanRequestV1,
  ): Promise<ProtectedAdditionalDeviceTransitionPlanV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/transition-plan`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceTransitionPlanRequestV1Schema.parse(input),
      schema: protectedAdditionalDeviceTransitionPlanV1Schema,
      defaultErrorPrefix: "POST protected additional-device transition plan",
    });
    if (response.operationId !== operationId) {
      throw new TypeError("Protected additional-device transition plan was substituted");
    }
    return response;
  }

  async planProtectedAdditionalDeviceTransitionsV2(
    operationId: string,
    input: ProtectedAdditionalDeviceTransitionPlanRequestV2,
  ): Promise<ProtectedAdditionalDeviceTransitionPlanV2> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/transition-plan`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceTransitionPlanRequestV2Schema.parse(input),
      schema: protectedAdditionalDeviceTransitionPlanV2Schema,
      defaultErrorPrefix: "POST protected additional-device transition plan V2",
    });
    if (response.operationId !== operationId) {
      throw new TypeError("Protected additional-device transition plan was substituted");
    }
    return response;
  }

  async submitProtectedAdditionalDeviceTransitions(
    operationId: string,
    input: ProtectedAdditionalDeviceTransitionsRequestV1,
  ): Promise<ProtectedAdditionalDeviceApprovalResponseV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/transitions`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceTransitionsRequestV1Schema.parse(input),
      schema: protectedAdditionalDeviceApprovalResponseV1Schema,
      defaultErrorPrefix: "POST protected additional-device transitions",
    });
    if (response.operationId !== operationId) {
      throw new TypeError("Protected additional-device transition receipt was substituted");
    }
    return response;
  }

  async submitProtectedAdditionalDeviceTransitionsV2(
    operationId: string,
    input: ProtectedAdditionalDeviceTransitionsRequestV2,
  ): Promise<ProtectedAdditionalDeviceApprovalResponseV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/transitions`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceTransitionsRequestV2Schema.parse(input),
      schema: protectedAdditionalDeviceApprovalResponseV1Schema,
      defaultErrorPrefix: "POST protected additional-device transitions V2",
    });
    if (response.operationId !== operationId) {
      throw new TypeError("Protected additional-device transition receipt was substituted");
    }
    return response;
  }

  async loadProtectedAdditionalDeviceDeliveries(
    operationId: string,
    input: ProtectedAdditionalDeviceDeliveriesRequestV1,
  ): Promise<ProtectedAdditionalDeviceDeliveriesV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/deliveries`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceDeliveriesRequestV1Schema.parse(input),
      schema: protectedAdditionalDeviceDeliveriesV1Schema,
      defaultErrorPrefix: "POST protected additional-device deliveries",
    });
    if (response.operationId !== operationId || response.deviceId !== input.deviceId) {
      throw new TypeError("Protected additional-device deliveries were substituted");
    }
    return response;
  }

  async acknowledgeProtectedAdditionalDeviceDelivery(
    operationId: string,
    input: ProtectedAdditionalDeviceAcknowledgementRequestV1,
  ): Promise<{ readonly status: "acknowledged" | "duplicate" }> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/ack`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceAcknowledgementRequestV1Schema.parse(input),
      schema: z.object({ status: z.enum(["acknowledged", "duplicate"]) }).strict(),
      defaultErrorPrefix: "POST protected additional-device acknowledgement",
    });
  }

  async activateProtectedAdditionalDevice(
    operationId: string,
    input: ProtectedAdditionalDeviceActivationRequestV1,
  ): Promise<ProtectedAdditionalDeviceActivationV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/devices/additional/${encodeURIComponent(operationId)}/activate`,
      auth: "session-fresh",
      body: protectedAdditionalDeviceActivationRequestV1Schema.parse(input),
      schema: protectedAdditionalDeviceActivationV1Schema,
      defaultErrorPrefix: "POST protected additional-device activation",
    });
    if (response.operationId !== operationId || response.deviceId !== input.deviceId) {
      throw new TypeError("Protected additional-device activation was substituted");
    }
    return response;
  }

  async loadHumanDeviceMembership(
    input: HumanDeviceMembershipStatusRequestV1,
  ): Promise<HumanDeviceMembershipStatusV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/status",
      auth: "session-fresh",
      body: humanDeviceMembershipStatusRequestV1Schema.parse(input),
      schema: humanDeviceMembershipStatusV1Schema,
      defaultErrorPrefix: "POST Human device membership status",
    });
  }

  async establishHumanDeviceMembership(
    input: HumanDeviceMembershipInitialRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/initial",
      auth: "session-fresh",
      body: humanDeviceMembershipInitialRequestV1Schema.parse(input),
      schema: humanDeviceMembershipMutationV1Schema,
      defaultErrorPrefix: "POST Human device membership initial",
    });
  }

  async beginHumanDeviceMembership(
    input: HumanDeviceMembershipBeginRequestV1,
  ): Promise<HumanDeviceMembershipBeginV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/begin",
      auth: "session-fresh",
      body: humanDeviceMembershipBeginRequestV1Schema.parse(input),
      schema: humanDeviceMembershipBeginV1Schema,
      defaultErrorPrefix: "POST Human device membership begin",
    });
  }

  async publishHumanDeviceMembershipJoin(
    operationId: string,
    input: HumanDeviceMembershipJoinRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/membership/${encodeURIComponent(operationId)}/join`,
      auth: "session-fresh",
      body: humanDeviceMembershipJoinRequestV1Schema.parse(input),
      schema: humanDeviceMembershipMutationV1Schema,
      defaultErrorPrefix: "POST Human device membership join",
    });
  }

  async listHumanDeviceMembershipPending(
    input: HumanDeviceMembershipPendingRequestV1,
  ): Promise<HumanDeviceMembershipPendingV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/pending",
      auth: "session-fresh",
      body: humanDeviceMembershipPendingRequestV1Schema.parse(input),
      schema: humanDeviceMembershipPendingV1Schema,
      defaultErrorPrefix: "POST Human device membership pending",
    });
  }

  async listHumanDeviceMembershipRoster(
    input: HumanDeviceMembershipRosterRequestV1,
  ): Promise<HumanDeviceMembershipRosterV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/roster",
      auth: "session-fresh",
      body: humanDeviceMembershipRosterRequestV1Schema.parse(input),
      schema: humanDeviceMembershipRosterV1Schema,
      defaultErrorPrefix: "POST Human device membership roster",
    });
  }

  async publishHumanDeviceMembershipAdd(
    operationId: string,
    input: HumanDeviceMembershipAddRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/membership/${encodeURIComponent(operationId)}/add`,
      auth: "session-fresh",
      body: humanDeviceMembershipAddRequestV1Schema.parse(input),
      schema: humanDeviceMembershipMutationV1Schema,
      defaultErrorPrefix: "POST Human device membership Add",
    });
  }

  async publishHumanDeviceMembershipRemove(
    operationId: string,
    input: HumanDeviceMembershipRemoveRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/membership/${encodeURIComponent(operationId)}/remove`,
      auth: "session-fresh",
      body: humanDeviceMembershipRemoveRequestV1Schema.parse(input),
      schema: humanDeviceMembershipMutationV1Schema,
      defaultErrorPrefix: "POST Human device membership Remove",
    });
  }

  async beginHumanDeviceMembershipRecovery(
    input: HumanDeviceMembershipRecoveryBeginRequestV1,
  ): Promise<HumanDeviceMembershipRecoveryBeginV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/recovery/begin",
      body: humanDeviceMembershipRecoveryBeginRequestV1Schema.parse(input),
      schema: humanDeviceMembershipRecoveryBeginV1Schema,
      defaultErrorPrefix: "POST Human-device membership recovery begin",
    });
  }

  async completeHumanDeviceMembershipRecovery(
    operationId: string,
    input: HumanDeviceMembershipRecoveryCompleteRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1> {
    return this.request({
      method: "POST",
      path: `/api/protected/devices/membership/${
        encodeURIComponent(operationId)
      }/recovery`,
      body: humanDeviceMembershipRecoveryCompleteRequestV1Schema.parse(input),
      schema: humanDeviceMembershipMutationV1Schema,
      defaultErrorPrefix: "POST Human-device membership recovery complete",
    });
  }

  async acknowledgeHumanDeviceMembership(
    input: HumanDeviceMembershipAcknowledgementRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/membership/acknowledge",
      auth: "session-fresh",
      body: humanDeviceMembershipAcknowledgementRequestV1Schema.parse(input),
      schema: humanDeviceMembershipMutationV1Schema,
      defaultErrorPrefix: "POST Human device membership acknowledgement",
    });
  }

  async completeProtectedInitialDeviceBootstrap(
    input: ProtectedInitialDeviceCompleteRequestV1,
  ): Promise<ProtectedInitialDeviceReceiptV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/initial-bootstrap/complete",
      auth: "session-fresh",
      body: protectedInitialDeviceCompleteRequestV1Schema.parse(input),
      schema: protectedInitialDeviceReceiptV1Schema,
      defaultErrorPrefix: "POST protected initial-device bootstrap complete",
    });
  }

  async resolveProtectedInitialDeviceBootstrapReceipt(
    input: ProtectedInitialDeviceReceiptRequestV1,
  ): Promise<ProtectedInitialDeviceReceiptV1 | null> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/initial-bootstrap/receipt",
      auth: "session-fresh",
      body: protectedInitialDeviceReceiptRequestV1Schema.parse(input),
      schema: protectedInitialDeviceReceiptV1Schema.nullable(),
      defaultErrorPrefix: "POST protected initial-device bootstrap receipt",
    });
  }

  async activateProtectedInitialHumanDomain(
    input: ProtectedInitialHumanDomainRequestV1,
  ): Promise<ProtectedInitialHumanDomainReceiptV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/devices/initial-domain",
      auth: "session-fresh",
      body: protectedInitialHumanDomainRequestV1Schema.parse(input),
      schema: protectedInitialHumanDomainReceiptV1Schema,
      defaultErrorPrefix: "POST protected initial Human Domain",
    });
  }

  async planProtectedInitialHumanDomain(
    input: ProtectedInitialHumanDomainPlanRequestV1,
  ): Promise<ProtectedInitialHumanDomainPlanResponseV1> {
    const body = protectedInitialHumanDomainPlanRequestV1Schema.parse(input);
    const response = await this.request({
      method: "POST",
      path: "/api/protected/devices/initial-domain/plan",
      auth: "session-fresh",
      body,
      schema: protectedInitialHumanDomainPlanResponseV1Schema,
      defaultErrorPrefix: "POST protected initial Human Domain plan",
    });
    if (response.status === "planned" && response.deviceId !== body.deviceId) {
      throw new TypeError("Protected initial Human Domain plan was substituted");
    }
    return response;
  }

  async planProtectedArtifactAccess(
    artifactId: string,
    input: ProtectedArtifactAccessPlanRequestV1,
  ): Promise<ProtectedArtifactAccessPlanResponseV1> {
    const body = protectedArtifactAccessPlanRequestV1Schema.parse(input);
    const response = await this.request({
      method: "POST",
      path: `/api/protected/artifacts/${encodeURIComponent(artifactId)}/access-plan`,
      auth: "session-fresh",
      body,
      schema: protectedArtifactAccessPlanResponseV1Schema,
      defaultErrorPrefix: "POST protected Artifact access plan",
    });
    if (response.status !== "unavailable" && response.artifactId !== artifactId) {
      throw new TypeError("Protected Artifact access plan was substituted");
    }
    return response;
  }

  async commitProtectedArtifactAccess(
    artifactId: string,
    input: ProtectedArtifactPreparedAccessRequestV1,
  ): Promise<
    ProtectedArtifactAccessUpdateResponseV1 | ProtectedArtifactUnavailableResponseV1
  > {
    const body = protectedArtifactPreparedAccessRequestV1Schema.parse(input);
    if (body.artifactId !== artifactId) {
      throw new TypeError("Protected Artifact access request identity disagrees");
    }
    const response = await this.request({
      method: "POST",
      path: `/api/protected/artifacts/${encodeURIComponent(artifactId)}/access`,
      auth: "session-fresh",
      body,
      schema: z.union([
        protectedArtifactAccessUpdateResponseV1Schema,
        protectedArtifactUnavailableResponseV1Schema,
      ]),
      defaultErrorPrefix: "POST protected Artifact access",
    });
    if (response.status !== "unavailable" && (
      response.artifactId !== artifactId
      || response.operationId !== body.operationId
      || response.cryptoAccessRevision !== body.nextCryptoAccessRevision
    )) throw new TypeError("Protected Artifact access receipt was substituted");
    return response;
  }

  async planProtectedArtifactPublication(
    input: ProtectedArtifactPublicationPlanRequestV1,
  ): Promise<ProtectedArtifactPublicationPlanResponseV1> {
    const body = protectedArtifactPublicationPlanRequestV1Schema.parse(input);
    const response = await this.request({
      method: "POST",
      path: "/api/protected/artifacts/publication-plan",
      auth: "session-fresh",
      body,
      schema: protectedArtifactPublicationPlanResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/artifacts/publication-plan",
    });
    if (
      response.status === "planned"
      && body.artifactId !== null
      && response.artifactId !== body.artifactId
    ) throw new TypeError("Protected Artifact publication plan was substituted");
    return response;
  }

  async stageProtectedArtifactCiphertext(input: Readonly<{
    artifactId: string;
    operationId: string;
    blobId: string;
    blobGeneration: number;
    ciphertextLength: number;
    ciphertextSha256Base64url: string;
    ciphertext: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
  }>): Promise<ProtectedArtifactCiphertextStageResponseV1> {
    let iterator: AsyncIterator<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start() {
        iterator = input.ciphertext[Symbol.asyncIterator]();
      },
      async pull(controller) {
        const next = await iterator!.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
      async cancel() {
        await iterator?.return?.();
      },
    });
    const response = await this._fetch(
      `${this.baseUrl}/api/protected/artifacts/${encodeURIComponent(input.artifactId)}/ciphertext/${encodeURIComponent(input.operationId)}`,
      {
        method: "PUT",
        headers: {
          ...(await this.authHeadersFresh()),
          "Content-Type": "application/vnd.nautilo.artifact-blob-v1",
          "Content-Length": String(input.ciphertextLength),
          "X-Nautilo-Blob-Id": input.blobId,
          "X-Nautilo-Blob-Generation": String(input.blobGeneration),
          "X-Nautilo-Ciphertext-SHA256": input.ciphertextSha256Base64url,
        },
        body,
        redirect: "error",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...({ duplex: "half" } as object),
      },
    );
    if (!response.ok) {
      throw new ApiError(response.status, `PUT protected Artifact ciphertext failed: ${response.status}`);
    }
    const parsed = protectedArtifactCiphertextStageResponseV1Schema.parse(
      await response.json(),
    );
    if (
      parsed.operationId !== input.operationId
      || parsed.artifactId !== input.artifactId
      || parsed.blobId !== input.blobId
      || parsed.blobGeneration !== input.blobGeneration
      || parsed.ciphertextLength !== input.ciphertextLength
      || parsed.ciphertextSha256Base64url !== input.ciphertextSha256Base64url
    ) throw new TypeError("Protected Artifact ciphertext receipt was substituted");
    return parsed;
  }

  async publishProtectedArtifact(
    prepared: ProtectedArtifactPreparedPublicationRequestV1,
  ): Promise<ProtectedArtifactPublicationResponseV1 | ProtectedArtifactUnavailableResponseV1> {
    const body = protectedArtifactPreparedPublicationRequestV1Schema.parse(prepared);
    const response = await this.request({
      method: "POST",
      path: `/api/protected/artifacts/${encodeURIComponent(body.artifactId)}/publication`,
      auth: "session-fresh",
      body,
      schema: z.union([
        protectedArtifactPublicationResponseV1Schema,
        protectedArtifactUnavailableResponseV1Schema,
      ]),
      defaultErrorPrefix: "POST /api/protected/artifacts/:id/publication",
    });
    if (
      "artifactId" in response
      && (response.artifactId !== body.artifactId
        || response.operationId !== body.operationId
        || response.artifactRevision !== body.nextArtifactRevision
        || response.blobId !== body.resultBlobId
        || response.blobGeneration !== body.resultBlobGeneration)
    ) throw new TypeError("Protected Artifact publication response was substituted");
    return response;
  }

  /**
   * Dormant protected-mode read. This deliberately targets the same
   * authenticated route as the legacy facade but accepts only the canonical
   * encrypted DTO (or its typed unavailable envelope). A plaintext success is
   * a schema error; this method never retries through the legacy facade.
   */
  async listProtectedMemories(opts?: {
    cursor?: string;
    limit?: number;
    includeArchive?: boolean;
    room?: string;
    person?: string;
    audience?: "private";
  }): Promise<
    ProtectedMemoryListResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.includeArchive) params.set("includeArchive", "true");
    if (opts?.room) params.set("room", opts.room);
    if (opts?.person) params.set("person", opts.person);
    if (opts?.audience) params.set("audience", opts.audience);
    const query = params.toString();
    return this.request({
      path: `/api/memory${query.length === 0 ? "" : `?${query}`}`,
      auth: "session-fresh",
      schema: protectedMemoryListRouteResponseV1Schema,
      defaultErrorPrefix: "GET /api/memory (protected)",
    });
  }

  async getProtectedMemory(
    memoryId: string,
  ): Promise<
    ProtectedMemoryDetailResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    const response = await this.request({
      path: `/api/memory/${encodeURIComponent(memoryId)}`,
      auth: "session-fresh",
      schema: protectedMemoryDetailRouteResponseV1Schema,
      defaultErrorPrefix: "GET /api/memory/:id (protected)",
    });
    if (
      "memory" in response
      && response.memory.projection.memoryId !== memoryId
    ) {
      throw new TypeError(
        "Protected Memory detail does not match the requested Memory",
      );
    }
    return response;
  }

  async getMemoryProcessorRecipient(): Promise<MemoryProcessorRecipientV1> {
    return this.request({
      path: "/api/memory/processor-recipient",
      auth: "session-fresh",
      schema: memoryProcessorRecipientV1Schema,
      defaultErrorPrefix: "GET /api/memory/processor-recipient",
    });
  }

  async searchProtectedMemories(opts: {
    sealedQuery: MemoryProcessorSealedRequestV1;
    mode: "text" | "semantic";
    limit?: number;
    includeArchive?: boolean;
  }): Promise<
    ProtectedMemorySearchResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    return this.request({
      method: "POST",
      path: "/api/memory/search",
      auth: "session-fresh",
      body: {
        sealedQuery: memoryProcessorSealedRequestV1Schema.parse(opts.sealedQuery),
        mode: opts.mode,
        ...(opts.limit === undefined ? {} : { limit: opts.limit }),
        ...(opts.includeArchive === undefined
          ? {}
          : { includeArchive: opts.includeArchive }),
      },
      schema: protectedMemorySearchRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/memory/search (protected)",
    });
  }

  async getProtectedMemoryBrief(opts?: {
    readonly?: boolean;
  }): Promise<
    ProtectedMemoryBriefResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    return this.request({
      path: opts?.readonly === true
        ? "/api/memory/brief/readonly"
        : "/api/memory/brief",
      auth: "session-fresh",
      schema: protectedMemoryBriefRouteResponseV1Schema,
      defaultErrorPrefix: "GET /api/memory/brief (protected)",
    });
  }

  async planProtectedMemoryCreate(): Promise<
    ProtectedMemoryCreatePlanResponseV1
    | ProtectedMemoryUnavailableResponseV1
  > {
    return this.request({
      method: "POST",
      path: "/api/memory/protected-create-plan",
      auth: "session-fresh",
      schema: protectedMemoryCreatePlanRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/memory/protected-create-plan",
    });
  }

  async createProtectedMemory(
    prepared: ProtectedMemorySubmittedCreateRequestV1,
    sealedContentEmbeddingRequest: MemoryProcessorSealedRequestV1,
  ): Promise<
    ProtectedMemoryPreparedUpdateResponseV1
    | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemorySubmittedCreateRequestV1Schema.parse(prepared);
    const response = await this.request({
      method: "POST",
      path: "/api/memory/protected-create",
      auth: "session-fresh",
      body: {
        ...body,
        ...("publicationKind" in body
          ? { signedOrdinaryFallbackRequestBytesBase64url: undefined }
          : { signedContentEmbeddingRequestBytesBase64url: undefined }),
        sealedContentEmbeddingRequest:
          memoryProcessorSealedRequestV1Schema.parse(sealedContentEmbeddingRequest),
      },
      schema: protectedMemoryPublicationRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/memory/protected-create",
    });
    if (
      !("publicationKind" in body) && "memory" in response
      && (
        response.memory.projection.memoryId !== body.memoryId
        || response.memory.projection.contentRevision !== 1
        || response.memory.projection.cryptoAccessRevision !== 0
        || !exactStringInventory(
          response.memory.projection.requiredNamespaceIds,
          body.requiredNamespaceIds,
        )
        || response.memory.protectedPayload.status !== "encrypted"
        || response.memory.protectedPayload.cryptoObjectId
          !== body.cryptoObjectId
      )
    ) {
      throw new TypeError(
        "Protected Memory create response does not match its publication",
      );
    }
    return response;
  }

  async updateProtectedMemory(
    memoryId: string,
    prepared: ProtectedMemorySubmittedUpdateRequestV1,
    sealedContentEmbeddingRequest: MemoryProcessorSealedRequestV1,
  ): Promise<
    ProtectedMemoryPreparedUpdateResponseV1
    | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemorySubmittedUpdateRequestV1Schema.parse(prepared);
    const response = await this.request({
      method: "PATCH",
      path: `/api/memory/${encodeURIComponent(memoryId)}`,
      auth: "session-fresh",
      body: {
        ...body,
        ...("publicationKind" in body
          ? { signedOrdinaryFallbackRequestBytesBase64url: undefined }
          : { signedContentEmbeddingRequestBytesBase64url: undefined }),
        sealedContentEmbeddingRequest:
          memoryProcessorSealedRequestV1Schema.parse(sealedContentEmbeddingRequest),
      },
      schema: protectedMemoryPublicationRouteResponseV1Schema,
      defaultErrorPrefix: "PATCH /api/memory/:id (protected)",
    });
    if (
      !("publicationKind" in body) && "memory" in response
      && (
        response.memory.projection.memoryId !== memoryId
        || response.memory.projection.contentRevision
          !== body.nextContentRevision
        || response.memory.projection.cryptoAccessRevision !== 0
        || !exactStringInventory(
          response.memory.projection.requiredNamespaceIds,
          body.requiredNamespaceIds,
        )
        || response.memory.protectedPayload.status !== "encrypted"
        || response.memory.protectedPayload.cryptoObjectId
          !== body.cryptoObjectId
      )
    ) {
      throw new TypeError(
        "Protected Memory update response does not match its publication",
      );
    }
    return response;
  }

  async planProtectedMemoryAccess(
    memoryId: string,
    operation: ProtectedMemoryAccessOperationV1,
  ): Promise<
    ProtectedMemoryAccessPlanResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemoryAccessPlanRequestV1Schema.parse({
      requestVersion: 1,
      operation,
    });
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/access-plan`,
      auth: "session-fresh",
      body,
      schema: protectedMemoryAccessPlanRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/access-plan",
    });
    if ("memoryId" in response && response.memoryId !== memoryId) {
      throw new TypeError("Protected Memory access plan was substituted");
    }
    return response;
  }

  async planProtectedMemoryRepair(memoryId: string): Promise<ProtectedMemoryRepairPlanResponseV1> {
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/repair-plan`,
      auth: "session-fresh",
      body: { requestVersion: 1 },
      schema: protectedMemoryRepairPlanResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/repair-plan",
    });
    if ("memoryId" in response && response.memoryId !== memoryId) {
      throw new TypeError("Protected Memory repair source was substituted");
    }
    return response;
  }

  async observeHumanMemoryRead(
    input: HumanMemoryReadObservationRequestV1,
  ): Promise<HumanMemoryReadObservationResponseV1> {
    return this.request({
      method: "POST",
      path: "/api/protected/memories/read-observation",
      auth: "session-fresh",
      body: humanMemoryReadObservationRequestV1Schema.parse(input),
      schema: humanMemoryReadObservationResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/read-observation",
    });
  }

  async commitProtectedMemoryRepair(memoryId: string,
    prepared: ProtectedMemoryPreparedRepairRequestV1): Promise<ProtectedMemoryRepairResponseV1> {
    const body = protectedMemoryPreparedRepairRequestV1Schema.parse(prepared);
    if (body.memoryId !== memoryId) throw new TypeError("Protected Memory repair targets another Memory");
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/repair`,
      auth: "session-fresh",
      body,
      schema: protectedMemoryRepairResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/repair",
    });
    if ("memoryId" in response && (response.memoryId !== memoryId
      || response.operationId !== body.operationId || response.direction !== body.direction)) {
      throw new TypeError("Protected Memory repair receipt was substituted");
    }
    return response;
  }

  async commitProtectedMemoryAccess(
    memoryId: string,
    prepared: ProtectedMemoryPreparedAccessRequestV1,
  ): Promise<
    ProtectedMemoryAccessUpdateResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemoryPreparedAccessRequestV1Schema.parse(prepared);
    if (body.memoryId !== memoryId) {
      throw new TypeError("Protected Memory access update targets another Memory");
    }
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/access`,
      auth: "session-fresh",
      body,
      schema: protectedMemoryAccessUpdateRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/access",
    });
    if (
      "memoryId" in response
      && (response.memoryId !== memoryId
        || response.operationId !== body.operationId
        || response.cryptoAccessRevision !== body.nextCryptoAccessRevision)
    ) throw new TypeError("Protected Memory access response was substituted");
    return response;
  }

  async archiveProtectedMemory(
    memoryId: string,
    request: ProtectedMemoryArchiveRequestV1,
  ): Promise<
    ProtectedMemoryArchiveResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemoryArchiveRequestV1Schema.parse(request);
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/archive`,
      auth: "session-fresh",
      body,
      schema: protectedMemoryArchiveRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/archive",
    });
    if (
      "memoryId" in response
      && (response.memoryId !== memoryId
        || response.operationId !== body.operationId)
    ) {
      throw new TypeError("Protected Memory archive response was substituted");
    }
    return response;
  }

  async transitionProtectedMemoryTier(
    memoryId: string,
    request: ProtectedMemoryTierTransitionRequestV1,
  ): Promise<
    ProtectedMemoryTierTransitionResponseV1
    | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemoryTierTransitionRequestV1Schema.parse(request);
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/tier`,
      auth: "session-fresh",
      body,
      schema: protectedMemoryTierTransitionRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/tier",
    });
    if (
      "memoryId" in response
      && (response.memoryId !== memoryId
        || response.operationId !== body.operationId)
    ) {
      throw new TypeError("Protected Memory tier response was substituted");
    }
    return response;
  }

  async restoreProtectedMemory(
    memoryId: string,
    request: ProtectedMemoryRestoreRequestV1,
  ): Promise<
    ProtectedMemoryRestoreResponseV1 | ProtectedMemoryUnavailableResponseV1
  > {
    const body = protectedMemoryRestoreRequestV1Schema.parse(request);
    const response = await this.request({
      method: "POST",
      path: `/api/protected/memories/${encodeURIComponent(memoryId)}/restore`,
      auth: "session-fresh",
      body,
      schema: protectedMemoryRestoreRouteResponseV1Schema,
      defaultErrorPrefix: "POST /api/protected/memories/:id/restore",
    });
    if (
      "memoryId" in response
      && (response.memoryId !== memoryId
        || response.operationId !== body.operationId)
    ) {
      throw new TypeError("Protected Memory restore response was substituted");
    }
    return response;
  }

  async getMemoryBrief(): Promise<{ brief: string }> {
    return this.request<{ brief: string }>({
      path: "/api/memory/brief",
      defaultErrorPrefix: "GET /api/memory/brief",
    });
  }

  /**
   * `GET /api/memory`. Paginated list with optional
   * namespace-mode access filters (`room` / `person` / `audience=private`).
   * This surface is read-only; there are no edit or archive verbs.
   * `roomId` scoping is the caller's responsibility under the fail-closed
   * access contract. This wrapper does not validate membership; it only
   * forwards the request and surfaces non-2xx as `ApiError`.
   */
  async listMemories(opts?: {
    cursor?: string;
    limit?: number;
    includeArchive?: boolean;
    room?: string;
    person?: string;
    audience?: "private";
  }): Promise<MemoryListResponse> {
    const params = new URLSearchParams();
    if (opts?.cursor) params.set("cursor", opts.cursor);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.includeArchive) params.set("includeArchive", "true");
    if (opts?.room) params.set("room", opts.room);
    if (opts?.person) params.set("person", opts.person);
    if (opts?.audience) params.set("audience", opts.audience);
    const qs = params.toString();
    return this.request<MemoryListResponse>({
      path: `/api/memory${qs ? `?${qs}` : ""}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/memory",
    });
  }

  /**
   * `GET /api/memory/search`. The client accepts the
   * workbench-facing `mode: "text" | "semantic"` and translates `semantic` to
   * the server's wire `mode=vector` (matching `searchMemories` in
   * `memory-api.ts`). `q` is required server-side; callers that omit it get a
   * 400 surfaced as `ApiError`.
   */
  async searchMemories(opts: {
    q: string;
    mode: "text" | "semantic";
    limit?: number;
    includeArchive?: boolean;
  }): Promise<MemorySearchResponse> {
    const params = new URLSearchParams({
      q: opts.q,
      mode: opts.mode === "semantic" ? "vector" : "text",
    });
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.includeArchive) params.set("includeArchive", "true");
    return this.request<MemorySearchResponse>({
      path: `/api/memory/search?${params.toString()}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/memory/search",
    });
  }

  /**
   * `GET /api/memory/:id`. Single-memory detail. `id` is
   * URL-encoded; the server validates UUID shape and returns 400/403/404,
   * surfaced here as `ApiError`.
   */
  async getMemory(id: string): Promise<MemoryDetailResponse> {
    return this.request<MemoryDetailResponse>({
      path: `/api/memory/${encodeURIComponent(id)}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/memory/:id",
    });
  }

  /**
   * `PATCH /api/memory/:id`. Updates content and/or
   * importance (namespace mode also accepts `namespaceId` to re-home). Returns
   * the refreshed detail envelope. Mirrors `updateMemory` in
   * `apps/workbench/src/lib/memory-api.ts` and the server route in
   * `packages/server/src/routes/memory.ts`. 400 (invalid id) / 403
   * (`manage_memories` capability / not writable / scope guard) / 404 (not
   * found) are surfaced as `ApiError`.
   */
  async updateMemory(
    id: string,
    input: { content?: string; importance?: number; namespaceId?: string },
  ): Promise<MemoryDetailResponse> {
    return this.request<MemoryDetailResponse>({
      method: "PATCH",
      path: `/api/memory/${encodeURIComponent(id)}`,
      auth: "session-fresh",
      body: input,
      defaultErrorPrefix: "PATCH /api/memory/:id",
    });
  }

  /**
   * `DELETE /api/memory/:id?mode=archive`. Soft-delete
   * (demote) the memory. Returns the server's status envelope
   * (`{ status: "archived", memoryMode }`). 400/403/404 → `ApiError`.
   */
  async archiveMemory(id: string): Promise<MemoryMutationStatusResponse> {
    return this.request<MemoryMutationStatusResponse>({
      method: "DELETE",
      path: `/api/memory/${encodeURIComponent(id)}?mode=archive`,
      auth: "session-fresh",
      defaultErrorPrefix: "DELETE /api/memory/:id",
    });
  }

  /**
   * `DELETE /api/memory/:id?mode=hard[&confirmShared=true]`.
   * Irreversible hard delete. When the memory is shared across multiple
   * namespaces the server returns 409 with `namespaceCount`, `namespaceIds`,
   * and (namespace mode) a `hint`; that is modeled as
   * {@link MemoryHardDeleteConflictError} so the UI can prompt for
   * `confirmShared: true`. 400/403/404 stay `ApiError`.
   */
  async hardDeleteMemory(
    id: string,
    opts?: { confirmShared?: boolean },
  ): Promise<MemoryMutationStatusResponse> {
    const params = new URLSearchParams({ mode: "hard" });
    if (opts?.confirmShared) params.set("confirmShared", "true");
    return this.request<MemoryMutationStatusResponse>({
      method: "DELETE",
      path: `/api/memory/${encodeURIComponent(id)}?${params.toString()}`,
      auth: "session-fresh",
      defaultErrorPrefix: "DELETE /api/memory/:id",
      statusErrors: {
        409: (body) => {
          const namespaceCount =
            typeof body["namespaceCount"] === "number" ? body["namespaceCount"] : 0;
          const namespaceIdsRaw = body["namespaceIds"];
          const namespaceIds = Array.isArray(namespaceIdsRaw)
            ? namespaceIdsRaw.filter(
                (x): x is string => typeof x === "string",
              )
            : [];
          const error =
            typeof body["error"] === "string" ? body["error"] : undefined;
          const hint =
            typeof body["hint"] === "string" ? body["hint"] : undefined;
          return new MemoryHardDeleteConflictError({
            namespaceCount,
            namespaceIds,
            ...(error !== undefined ? { error } : {}),
            ...(hint !== undefined ? { hint } : {}),
          });
        },
      },
    });
  }

  /**
   * `POST /api/memory/:id/grant`. Shares the memory with a
   * room (`{ roomId }`, everyone in the room) XOR a single person
   * (`{ userHandle }`, via an exact-set access room). The room path returns
   * `namespaceId`; the handle path returns `roomLabel` + `minted`.
   * 400/403/404 → `ApiError`.
   */
  async grantMemory(
    id: string,
    target: { roomId: string } | { userHandle: string },
  ): Promise<MemoryGrantResponse> {
    const body =
      "roomId" in target ? { room_id: target.roomId } : { user_handle: target.userHandle };
    return this.request<MemoryGrantResponse>({
      method: "POST",
      path: `/api/memory/${encodeURIComponent(id)}/grant`,
      auth: "session-fresh",
      body,
      defaultErrorPrefix: "POST /api/memory/:id/grant",
    });
  }

  /**
   * `POST /api/memory/:id/revoke`. Re-homes the memory so
   * `userHandle` loses access while everyone else keeps it. You cannot revoke
   * yourself (the server returns 400; use {@link makeMemoryPrivate}). Returns
   * `{ status, reHomed, skipped }`. 400/403/404 → `ApiError`; the
   * "requester actor not found" / "no private namespace" 409s are not the
   * shared-hard-delete conflict and stay `ApiError`.
   */
  async revokeMemory(
    id: string,
    userHandle: string,
  ): Promise<MemoryRevokeResponse> {
    return this.request<MemoryRevokeResponse>({
      method: "POST",
      path: `/api/memory/${encodeURIComponent(id)}/revoke`,
      auth: "session-fresh",
      body: { user_handle: userHandle },
      defaultErrorPrefix: "POST /api/memory/:id/revoke",
    });
  }

  /**
   * `POST /api/memory/:id/make_private`. Strips all access
   * except the requester's own private namespace. Returns
   * `{ status, skipped }`. 400/403/404 → `ApiError`; the "no private
   * namespace" 409 stays `ApiError`.
   */
  async makeMemoryPrivate(
    id: string,
  ): Promise<MemoryMakePrivateResponse> {
    return this.request<MemoryMakePrivateResponse>({
      method: "POST",
      path: `/api/memory/${encodeURIComponent(id)}/make_private`,
      auth: "session-fresh",
      body: {},
      defaultErrorPrefix: "POST /api/memory/:id/make_private",
    });
  }

  async getLatestSession(options?: {
    limit?: number;
    offset?: number;
    /** when set, load latest session for the room’s graph thread (owner only). */
    roomId?: string;
  }): Promise<{
    session: { id: string; threadId: string; title: string | null; messageCount: number; startedAt: string } | null;
    messages: Array<{
      id: string;
      logicalMessageKey?: string;
      role: string;
      content: string;
      toolCalls?: string | null;
      toolName?: string | null;
      displayContent?: string;
      createdAt: string;
      editedAt?: string | null;
      editRevision?: number;
      replyToMessageId?: number | null;
      replyCount?: number;
      lastReplyAt?: string | null;
      summaryRevision?: number;
      sourceUserId?: string;
      authorAgentId?: string;
      authorHarnessId?: string;
      attachments?: MessageAttachmentRef[];
    }>;
    pageInfo?: {
      hasMoreBefore: boolean;
      oldestCursor: { id: string; createdAt: string } | null;
    };
  }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    if (options?.roomId) params.set("roomId", options.roomId);
    const qs = params.toString();
    return this.request<{
      session: { id: string; threadId: string; title: string | null; messageCount: number; startedAt: string } | null;
      messages: Array<{
        id: string;
        logicalMessageKey?: string;
        role: string;
        content: string;
        toolCalls?: string | null;
        toolName?: string | null;
        displayContent?: string;
        createdAt: string;
        editedAt?: string | null;
        editRevision?: number;
        attachments?: MessageAttachmentRef[];
      }>;
      pageInfo?: {
        hasMoreBefore: boolean;
        oldestCursor: { id: string; createdAt: string } | null;
      };
    }>({
      path: `/api/sessions/latest${qs ? `?${qs}` : ""}`,
      defaultErrorPrefix: "GET /api/sessions/latest",
    });
  }

  async getOlderRoomMessages(options: {
    roomId: string;
    beforeId: string;
    beforeCreatedAt: string;
    limit?: number;
    shadowRead?: RoomHistoryShadowReadIntentV1;
  }): Promise<{
    messages: Array<{
      id: string;
      logicalMessageKey?: string;
      role: string;
      content: string;
      toolCalls?: string | null;
      toolName?: string | null;
      displayContent?: string;
      createdAt: string;
      editedAt?: string | null;
      editRevision?: number;
      replyToMessageId?: number | null;
      sourceUserId?: string;
      authorAgentId?: string;
      authorHarnessId?: string;
      attachments?: MessageAttachmentRef[];
      artifacts?: MessageArtifactOpenRef[];
    }>;
    pageInfo: {
      hasMoreBefore: boolean;
      oldestCursor: { id: string; createdAt: string } | null;
    };
    shadowEncryption?: RoomHistoryShadowReadResponseV1;
  }> {
    const params = new URLSearchParams();
    params.set("beforeId", options.beforeId);
    params.set("beforeCreatedAt", options.beforeCreatedAt);
    if (options.limit) params.set("limit", String(options.limit));
    if (options.shadowRead !== undefined) {
      const intent = roomHistoryShadowReadIntentV1Schema.parse(
        options.shadowRead,
      );
      params.set("shadowReadVersion", String(intent.requestVersion));
      params.set("shadowReadMetadataVersion", "1");
      params.set("shadowReadRequestKey", intent.clientRequestKey);
      if (intent.readerDeviceId !== undefined) {
        params.set("shadowReadDeviceId", intent.readerDeviceId);
      }
    }
    const response = await this.request<{
      messages: Array<{
        id: string;
        logicalMessageKey?: string;
        role: string;
        content: string;
        toolCalls?: string | null;
        toolName?: string | null;
        displayContent?: string;
        createdAt: string;
        editedAt?: string | null;
        editRevision?: number;
        replyToMessageId?: number | null;
        replyCount?: number;
        lastReplyAt?: string | null;
        summaryRevision?: number;
        sourceUserId?: string;
        authorAgentId?: string;
        authorHarnessId?: string;
        attachments?: MessageAttachmentRef[];
        artifacts?: MessageArtifactOpenRef[];
      }>;
      pageInfo: {
        hasMoreBefore: boolean;
        oldestCursor: { id: string; createdAt: string } | null;
      };
      shadowEncryption?: unknown;
    }>({
      path: `/api/rooms/${encodeURIComponent(options.roomId)}/messages?${params.toString()}`,
      defaultErrorPrefix: `GET /api/rooms/${options.roomId}/messages`,
    });
    const { shadowEncryption, ...ordinary } = response;
    return {
      ...ordinary,
      ...(shadowEncryption === undefined
        ? {}
        : {
          shadowEncryption: roomHistoryShadowReadResponseV1Schema.parse(
            shadowEncryption,
          ),
        }),
    };
  }

  async acknowledgeRoomHistoryShadowRead(
    roomId: string,
    input: RoomHistoryShadowReadAcknowledgementRequestV1,
    options?: Readonly<{signal?: AbortSignal}>,
  ): Promise<RoomHistoryShadowReadAcknowledgementResponseV1> {
    const body = roomHistoryShadowReadAcknowledgementRequestV1Schema.parse(
      input,
    );
    return this.request<RoomHistoryShadowReadAcknowledgementResponseV1>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/messages/shadow-read/${encodeURIComponent(body.operationId)}/ack`,
      auth: "session-fresh",
      body,
      schema: roomHistoryShadowReadAcknowledgementResponseV1Schema,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/messages/shadow-read/:operationId/ack`,
      ...(options?.signal === undefined ? {} : {signal: options.signal}),
    });
  }

  async getRoomMessageShadowRead(options: Readonly<{
    roomId: string;
    intent: RoomHistoryShadowReadIntentV1;
    coordinate: RoomMessageShadowReadRequestV1["coordinate"];
  }>): Promise<RoomHistoryShadowReadResponseV1> {
    const body = roomMessageShadowReadRequestV1Schema.parse({
      intent: options.intent,
      coordinate: options.coordinate,
    });
    return this.request<RoomHistoryShadowReadResponseV1>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(options.roomId)}/messages/shadow-read?shadowReadMetadataVersion=1`,
      auth: "session-fresh",
      body,
      schema: roomHistoryShadowReadResponseV1Schema,
      defaultErrorPrefix: `POST /api/rooms/${options.roomId}/messages/shadow-read`,
    });
  }

  async nextMessageBackfill(input: Readonly<{
    urgent?: MessageBackfillUrgentSelection;
  }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<MessageBackfillNextResponse> {
    return this.request({
      method: "POST",
      path: "/api/message-backfill/next",
      auth: "session-fresh",
      body: messageBackfillNextRequestSchema.parse(input),
      schema: messageBackfillNextResponseSchema,
      defaultErrorPrefix: "POST /api/message-backfill/next",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async readMessageBackfillSource(
    input: Readonly<{ claimId: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<MessageBackfillSourceResponse> {
    return this.request({
      method: "POST",
      path: "/api/message-backfill/source?shadowReadMetadataVersion=1",
      auth: "session-fresh",
      body: messageBackfillClaimRequestSchema.parse(input),
      schema: messageBackfillSourceResponseSchema,
      defaultErrorPrefix: "POST /api/message-backfill/source",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async publishMessageBackfill(
    input: MessageBackfillPublishRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<MessageBackfillPublishResponse> {
    return this.request({
      method: "POST",
      path: "/api/message-backfill/publish",
      auth: "session-fresh",
      body: messageBackfillPublishRequestSchema.parse(input),
      schema: messageBackfillPublishResponseSchema,
      defaultErrorPrefix: "POST /api/message-backfill/publish",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async acknowledgeMessageBackfill(
    input: MessageBackfillAckRequest,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<MessageBackfillAckResponse> {
    return this.request({
      method: "POST",
      path: "/api/message-backfill/ack",
      auth: "session-fresh",
      body: messageBackfillAckRequestSchema.parse(input),
      schema: messageBackfillAckResponseSchema,
      defaultErrorPrefix: "POST /api/message-backfill/ack",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async getMessageBackfillProgress(
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<MessageBackfillProgress> {
    return this.request({
      path: "/api/message-backfill/progress",
      auth: "session-fresh",
      schema: messageBackfillProgressSchema,
      defaultErrorPrefix: "GET /api/message-backfill/progress",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async listBackgroundAuthorizationRequests(
    input: Readonly<{ continuation?: string }> = {},
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<BackgroundAuthorizationListResponse> {
    return this.request({
      method: "POST",
      path: "/api/background-authorization/requests/list",
      auth: "session-fresh",
      body: backgroundAuthorizationListRequestSchema.parse({
        requestVersion: 1,
        ...input,
      }),
      schema: backgroundAuthorizationListResponseSchema,
      defaultErrorPrefix: "POST /api/background-authorization/requests/list",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async respondBackgroundAuthorizationRequest(
    input: Readonly<{ responseBytesBase64url: string }>,
    options?: Readonly<{ signal?: AbortSignal }>,
  ): Promise<BackgroundAuthorizationRespondResponse> {
    return this.request({
      method: "POST",
      path: "/api/background-authorization/respond",
      auth: "session-fresh",
      body: backgroundAuthorizationRespondRequestSchema.parse({
        requestVersion: 1,
        ...input,
      }),
      schema: backgroundAuthorizationRespondResponseSchema,
      defaultErrorPrefix: "POST /api/background-authorization/respond",
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** fetch exactly one newest-first Room transcript search page. */
  async searchRoomMessages(
    options: RoomMessageSearchOptions,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<RoomMessageSearchPage> {
    const params = new URLSearchParams();
    params.set("query", options.query);
    params.set("mode", options.mode);
    if (options.ignoreCase !== undefined) params.set("ignoreCase", String(options.ignoreCase));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) {
      params.set("cursorCreatedAt", options.cursor.createdAt);
      params.set("cursorMessageId", options.cursor.messageId);
    }
    if (options.asOf) {
      params.set("asOfCreatedAt", options.asOf.createdAt);
      params.set("asOfMessageId", options.asOf.messageId);
    }
    return this.request<RoomMessageSearchPage>({
      path: `/api/rooms/${encodeURIComponent(options.roomId)}/messages/search?${params.toString()}`,
      defaultErrorPrefix: `GET /api/rooms/${options.roomId}/messages/search`,
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** fetch exactly one cursor-paged authorized Chats-wide search page. */
  async searchChats(
    options: ChatSearchOptions,
    requestOptions?: { signal?: AbortSignal },
  ): Promise<ChatSearchPage> {
    const params = new URLSearchParams();
    params.set("query", options.query);
    params.set("mode", options.mode);
    if (options.archiveScope !== undefined) params.set("archiveScope", options.archiveScope);
    if (options.ignoreCase !== undefined) params.set("ignoreCase", String(options.ignoreCase));
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.cursor) {
      params.set("cursorCreatedAt", options.cursor.createdAt);
      params.set("cursorMessageId", options.cursor.messageId);
    }
    if (options.asOf) {
      params.set("asOfCreatedAt", options.asOf.createdAt);
      params.set("asOfMessageId", options.asOf.messageId);
    }
    return this.request<ChatSearchPage>({
      path: `/api/rooms/search?${params.toString()}`,
      defaultErrorPrefix: "GET /api/rooms/search",
      ...(requestOptions?.signal !== undefined ? { signal: requestOptions.signal } : {}),
    });
  }

  /** fetch one bounded chronological Room page around an exact message. */
  async getRoomMessagesAround(
    options: RoomMessagesAroundOptions & Readonly<{ shadowRead?: RoomHistoryShadowReadIntentV1 }>,
  ): Promise<RoomMessagesAroundPage & Readonly<{ shadowEncryption?: RoomHistoryShadowReadResponseV1 }>> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.shadowRead !== undefined) {
      const intent = roomHistoryShadowReadIntentV1Schema.parse(options.shadowRead);
      params.set("shadowReadVersion", String(intent.requestVersion));
      params.set("shadowReadMetadataVersion", "1");
      params.set("shadowReadRequestKey", intent.clientRequestKey);
      if (intent.readerDeviceId !== undefined) params.set("shadowReadDeviceId", intent.readerDeviceId);
    }
    const qs = params.toString();
    const response = await this.request<RoomMessagesAroundPage & Readonly<{ shadowEncryption?: unknown }>>({
      path: `/api/rooms/${encodeURIComponent(options.roomId)}/messages/${encodeURIComponent(options.messageId)}/around${qs ? `?${qs}` : ""}`,
      defaultErrorPrefix: `GET /api/rooms/${options.roomId}/messages/${options.messageId}/around`,
    });
    const { shadowEncryption, ...ordinary } = response;
    return {
      ...ordinary,
      ...(shadowEncryption === undefined
        ? {}
        : {
          shadowEncryption: roomHistoryShadowReadResponseV1Schema.parse(
            shadowEncryption,
          ),
        }),
    };
  }

  /** list rooms for the signed-in owner (`GET /api/rooms`). */
  async listRooms(): Promise<ListRoomsResponse> {
    return this.request<ListRoomsResponse>({
      path: "/api/rooms",
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/rooms",
    });
  }

  /** resolve/join the server-owned safe initial Room fallback. */
  async resolveLandingRoom(): Promise<RoomDetailResponse> {
    return this.request<RoomDetailResponse>({
      method: "POST",
      path: "/api/rooms/resolve-landing",
      auth: "session-fresh",
      defaultErrorPrefix: "POST /api/rooms/resolve-landing",
    });
  }

  /** list rooms the caller may manage members for (`GET /api/rooms/manageable`). */
  async listManageableRooms(opts?: { includeArchived?: boolean }): Promise<ListRoomsResponse> {
    const q =
      opts?.includeArchived === true ? "?includeArchived=true" : "";
    return this.request<ListRoomsResponse>({
      path: `/api/rooms/manageable${q}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/rooms/manageable",
    });
  }

  /** room detail for members (`GET /api/rooms/:id`). */
  async getRoom(roomId: string): Promise<RoomDetailResponse> {
    return this.request<RoomDetailResponse>({
      path: `/api/rooms/${encodeURIComponent(roomId)}`,
      auth: "session-fresh",
      defaultErrorPrefix: `GET /api/rooms/${roomId}`,
    });
  }

  /** canonical thread hydration without paging parent history. */
  async getThreadDetail(subthreadRoomId: string): Promise<ThreadDetailResponse> {
    return this.request<ThreadDetailResponse>({
      path: `/api/rooms/${encodeURIComponent(subthreadRoomId)}/thread-detail`,
      auth: "session-fresh",
      defaultErrorPrefix: `GET /api/rooms/${subthreadRoomId}/thread-detail`,
    });
  }

  /** List canonical child Rooms anchored in one parent Room. */
  async listSubthreads(parentRoomId: string): Promise<{ subthreads: SubthreadSummary[] }> {
    return this.request<{ subthreads: SubthreadSummary[] }>({
      path: `/api/rooms/${encodeURIComponent(parentRoomId)}/subthreads`,
      auth: "session-fresh",
      defaultErrorPrefix: `GET /api/rooms/${parentRoomId}/subthreads`,
    });
  }

  /** Create or resolve the canonical child Room for one message. */
  async createSubthread(
    parentRoomId: string,
    anchorMessageId: number,
    body: CreateSubthreadRequest = {},
  ): Promise<CreateSubthreadResponse> {
    return this.request<CreateSubthreadResponse>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(parentRoomId)}/messages/${encodeURIComponent(String(anchorMessageId))}/subthreads`,
      auth: "session-fresh",
      body,
      defaultErrorPrefix: `POST /api/rooms/${parentRoomId}/messages/${anchorMessageId}/subthreads`,
    });
  }

  /** room roster for members-management UI (`GET /api/rooms/:id/manage-detail`). */
  async getRoomManageDetail(roomId: string): Promise<RoomDetailResponse> {
    return this.request<RoomDetailResponse>({
      path: `/api/rooms/${encodeURIComponent(roomId)}/manage-detail`,
      auth: "session-fresh",
      defaultErrorPrefix: `GET /api/rooms/${roomId}/manage-detail`,
    });
  }

  /** create room (`POST /api/rooms`). Returns created room detail (201). */
  async createRoom(body: CreateRoomRequest): Promise<RoomDetailResponse> {
    return this.request<RoomDetailResponse>({
      method: "POST",
      path: "/api/rooms",
      body,
      defaultErrorPrefix: "POST /api/rooms",
    });
  }

  /** open rooms the caller may self-join (`GET /api/rooms/discoverable`). */
  async listDiscoverableRooms(): Promise<ListRoomsResponse> {
    return this.request<ListRoomsResponse>({
      path: "/api/rooms/discoverable",
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/rooms/discoverable",
    });
  }

  /** self-join an open room (`POST /api/rooms/:id/join`). Idempotent. */
  async joinOpenRoom(roomId: string): Promise<RoomDetailResponse> {
    return this.request<RoomDetailResponse>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/join`,
      auth: "session-fresh",
      defaultErrorPrefix: `POST /api/rooms/${roomId}/join`,
      statusErrors: {
        403: (body) => {
          if (body["code"] === "not_open") return new RoomNotOpenError();
          return new ApiError(
            403,
            typeof body.error === "string" && body.error.length > 0 ? body.error : "Forbidden",
          );
        },
      },
    });
  }

  /** rename private room (`PATCH /api/rooms/:id`). */
  async renameRoom(roomId: string, body: RenameRoomRequest): Promise<RoomDetailResponse> {
    return this.request<RoomDetailResponse>({
      method: "PATCH",
      path: `/api/rooms/${encodeURIComponent(roomId)}`,
      body,
      defaultErrorPrefix: `PATCH /api/rooms/${roomId}`,
    });
  }

  /** agents the caller may manage (`GET /api/agents`). */
  async listAgents(): Promise<Array<{ agentId: string; handle: string; displayName: string }>> {
    const body = await this.request<{
      agents: Array<{ agentId: string; handle: string; displayName: string }>;
    }>({
      path: "/api/agents",
      defaultErrorPrefix: "GET /api/agents",
    });
    return body.agents;
  }

  // The legacy `POST/DELETE /api/agents/:id/members`
  // mutation methods AND the read-only `getAgentMembers` /
  // `listAddableUsersForAgent` methods are RETIRED. The mutations mutated
  // server-wide canonical Groups with only agent-management auth
  // (Admin→Owner escalation); the reads exposed the server-wide roster /
  // user directory through a personal-Agent auth path (the per-Agent model
  // is false. The verbs now return 410 Gone server-side;
  // callers must use `groups.listGroups` / `groups.listGroupMembers` /
  // `groups.addGroupMember` / `groups.removeGroupMember` (shared RBAC
  // engine) or the Access Control catalogue instead. `listAgents` (the
  // manageable/personal Agent listing) is preserved above.

  async addRoomMember(
    roomId: string,
    body:
      | { kind: "user"; userId: string; roomRole: "admin" | "member" }
      | { kind: "agent"; agentId: string; roomRole: "admin" | "member" },
  ): Promise<{
    ok: true;
    actorId: string;
    kind: "user" | "agent";
    protectedEncryption?: {
      status: "pending";
      namespaceId: string;
      accessRevision: number;
    };
  }> {
    return this.request<{
      ok: true;
      actorId: string;
      kind: "user" | "agent";
      protectedEncryption?: {
        status: "pending";
        namespaceId: string;
        accessRevision: number;
      };
    }>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/members`,
      body,
      defaultErrorPrefix: `POST /api/rooms/${roomId}/members`,
    });
  }

  async removeRoomMember(
    roomId: string,
    actorId: string,
    opts?: { bypass?: boolean },
  ): Promise<{
    ok: true;
    kind: "user" | "agent";
    protectedEncryption?: {
      status: "pending";
      namespaceId: string;
      accessRevision: number;
    };
  }> {
    const q = opts?.bypass ? "?bypass=true" : "";
    return this.request<{
      ok: true;
      kind: "user" | "agent";
      protectedEncryption?: {
        status: "pending";
        namespaceId: string;
        accessRevision: number;
      };
    }>({
      method: "DELETE",
      path: `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(actorId)}${q}`,
      defaultErrorPrefix: "DELETE room member",
    });
  }

  /**
   * flip an agent member's `agent_response_mode` for this room.
   * Server gates on owner / server-admin role; non-managers get 403.
   * 404 if (room, actor) row doesn't exist or the actor is not an agent.
   */
  async updateRoomMemberMode(
    roomId: string,
    actorId: string,
    agentResponseMode: "active" | "mention_only" | "observe",
  ): Promise<{ actorId: string; agentResponseMode: "active" | "mention_only" | "observe" }> {
    return this.request<{
      actorId: string;
      agentResponseMode: "active" | "mention_only" | "observe";
    }>({
      method: "PATCH",
      path: `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(actorId)}`,
      body: { agentResponseMode },
      defaultErrorPrefix: "PATCH room member mode",
    });
  }

  /** Flip a human member's room_role (`PATCH /api/rooms/:id/members/:actorId`). */
  async updateRoomMemberRole(
    roomId: string,
    actorId: string,
    roomRole: "admin" | "member",
  ): Promise<{ actorId: string; roomRole: "admin" | "member" }> {
    return this.request<{ actorId: string; roomRole: "admin" | "member" }>({
      method: "PATCH",
      path: `/api/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(actorId)}`,
      body: { roomRole },
      defaultErrorPrefix: "PATCH room member role",
    });
  }

  /** fetch this viewer's durable model-control override for one Room + owned Agent. */
  async getRoomModelControlSelection(
    roomId: string,
    agentId: string,
  ): Promise<ModelControlSelection | null> {
    const response = await this.request<z.infer<typeof modelControlSelectionResponseSchema>>({
      path: `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/model-control-selection`,
      schema: modelControlSelectionResponseSchema,
      defaultErrorPrefix: `GET room model control selection`,
    });
    return normalizeModelControlSelection(response.selection);
  }

  /**
   * write or reset this viewer's Room-scoped model-control override.
   * `null` resets the Room layer and exposes the Agent/default fallback.
   */
  async updateRoomModelControlSelection(
    roomId: string,
    agentId: string,
    selection: ModelControlSelection | null,
  ): Promise<ModelControlSelection | null> {
    const response = await this.request<z.infer<typeof modelControlSelectionResponseSchema>>({
      method: "PUT",
      path: `/api/rooms/${encodeURIComponent(roomId)}/agents/${encodeURIComponent(agentId)}/model-control-selection`,
      body: { selection },
      schema: modelControlSelectionResponseSchema,
      defaultErrorPrefix: `PUT room model control selection`,
    });
    return normalizeModelControlSelection(response.selection);
  }

  /** flip persistent room smart-routing policy. */
  async setRoomConductorMode(
    roomId: string,
    conductorMode: "advanced" | "standard",
  ): Promise<{ conductorMode: "advanced" | "standard" }> {
    return this.request<{ conductorMode: "advanced" | "standard" }>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/conductor-mode`,
      body: { conductorMode },
      defaultErrorPrefix: "POST room conductor mode",
    });
  }

  /** soft-archive a room (`POST /api/rooms/:id/archive`). */
  async archiveRoom(roomId: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/archive`,
      auth: "session-fresh",
      defaultErrorPrefix: `POST /api/rooms/${roomId}/archive`,
    });
  }

  /** restore a soft-archived room (`POST /api/rooms/:id/unarchive`). */
  async unarchiveRoom(roomId: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/unarchive`,
      auth: "session-fresh",
      defaultErrorPrefix: `POST /api/rooms/${roomId}/unarchive`,
    });
  }

  /** flip room visibility public ↔ private (`POST /api/rooms/:id/visibility`). */
  async setRoomVisibility(roomId: string, isPublic: boolean): Promise<{ ok: true }> {
    const body: SetRoomVisibilityRequest = { public: isPublic };
    return this.request<{ ok: true }>({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/visibility`,
      body,
      auth: "session-fresh",
      defaultErrorPrefix: `POST /api/rooms/${roomId}/visibility`,
      statusErrors: {
        403: (b) =>
          new ApiError(
            403,
            b["code"] === "admin_required"
              ? "You need manage_rooms to change room visibility."
              : typeof b.error === "string" && b.error.length > 0
                ? b.error
                : "Forbidden",
          ),
        409: (b) =>
          new ApiError(
            409,
            b["code"] === "invalid_kind_for_visibility"
              ? "This room type cannot be made public or private."
              : typeof b.error === "string" && b.error.length > 0
                ? b.error
                : "Conflict",
          ),
      },
    });
  }

  async listAddableUsersForRoom(
    roomId: string,
  ): Promise<Array<{ userId: string; handle: string; displayName: string }>> {
    const body = await this.request<{
      users: Array<{ userId: string; handle: string; displayName: string }>;
    }>({
      path: `/api/rooms/${encodeURIComponent(roomId)}/addable-users`,
      defaultErrorPrefix: "GET room addable-users",
    });
    return body.users;
  }

  async listDirectoryHumans(): Promise<
    Array<{ userId: string; handle: string; displayName: string }>
  > {
    const body = await this.request<{
      users: Array<{ userId: string; handle: string; displayName: string }>;
    }>({
      path: "/api/directory/humans",
      defaultErrorPrefix: "GET directory humans",
    });
    return body.users;
  }

  async listBlockedHumanUserIds(): Promise<string[]> {
    const body = await this.request<{ blockedUserIds: string[] }>({
      path: "/api/human-blocks",
      defaultErrorPrefix: "GET human blocks",
    });
    return body.blockedUserIds;
  }

  async getHumanBlockStatus(
    userId: string,
  ): Promise<import("@nautilo/types").HumanBlockStatusResponse> {
    return this.request({
      path: `/api/human-blocks/${encodeURIComponent(userId)}`,
      defaultErrorPrefix: "GET human block status",
    });
  }

  async blockHuman(
    userId: string,
  ): Promise<import("@nautilo/types").HumanBlockStatusResponse> {
    return this.request({
      method: "PUT",
      path: `/api/human-blocks/${encodeURIComponent(userId)}`,
      body: {},
      defaultErrorPrefix: "PUT human block",
    });
  }

  async unblockHuman(
    userId: string,
  ): Promise<import("@nautilo/types").HumanBlockStatusResponse> {
    return this.request({
      method: "DELETE",
      path: `/api/human-blocks/${encodeURIComponent(userId)}`,
      defaultErrorPrefix: "DELETE human block",
    });
  }

  async createContentReport(
    input: import("@nautilo/types").CreateContentReportRequest,
  ): Promise<import("@nautilo/types").CreateContentReportResponse> {
    return this.request({
      method: "POST",
      path: "/api/content-reports",
      body: input,
      schema: createContentReportResponseSchema,
      defaultErrorPrefix: "POST content report",
    });
  }

  async listContentReports(input?: {
    status?: "open" | "closed";
    limit?: number;
    cursor?: string;
  }): Promise<import("@nautilo/types").ContentReportListResponse> {
    const query = new URLSearchParams();
    if (input?.status) query.set("status", input.status);
    if (input?.limit !== undefined) query.set("limit", String(input.limit));
    if (input?.cursor) query.set("cursor", input.cursor);
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    return this.request({
      path: `/api/admin/content-reports${suffix}`,
      schema: contentReportListResponseSchema,
      defaultErrorPrefix: "GET content reports",
    });
  }

  async actOnContentReport(
    reportId: string,
    action: import("@nautilo/types").ContentReportAdminAction["action"],
  ): Promise<{ reportId: string; status: "closed" }> {
    return this.request({
      method: "POST",
      path: `/api/admin/content-reports/${encodeURIComponent(reportId)}/actions`,
      body: { action },
      schema: z.object({ reportId: z.string().uuid(), status: z.literal("closed") }),
      defaultErrorPrefix: "POST content report action",
    });
  }

  async getMobileUserAgreementState(): Promise<import("@nautilo/types").MobileUserAgreementStateResponse> {
    return this.request({
      path: "/api/mobile-user-agreement",
      defaultErrorPrefix: "GET Mobile user agreement",
    });
  }

  async acceptMobileUserAgreement(
    agreementVersion: string,
  ): Promise<import("@nautilo/types").MobileUserAgreementStateResponse> {
    return this.request({
      method: "PUT",
      path: "/api/mobile-user-agreement",
      body: { agreementVersion },
      defaultErrorPrefix: "PUT Mobile user agreement",
    });
  }

  async withdrawMobileUserAgreement(): Promise<import("@nautilo/types").MobileUserAgreementStateResponse> {
    return this.request({
      method: "DELETE",
      path: "/api/mobile-user-agreement",
      defaultErrorPrefix: "DELETE Mobile user agreement",
    });
  }

  /**
   * unified, recency-ranked directory search
   * (`GET /api/directory/search`). Returns humans + agents in one call so
   * the member picker no longer loads the whole directory. `lastContactAt`
   * is derived from `MAX(session_messages.created_at)` over rooms the
   * caller and target both share (excluding task/access rooms).
   */
  async searchDirectory(params?: {
    q?: string;
    kind?: "user" | "agent" | "both";
    limit?: number;
    offset?: number;
    agentScope?: "owned";
  }): Promise<
    Array<{
      kind: "user" | "agent";
      id: string;
      handle: string;
      displayName: string;
      agentOwnerUserId?: string;
      agentOwnerHandle?: string | null;
      agentOwnerDisplayName?: string | null;
      lastContactAt: string | null;
      actionable: boolean;
      actionReason: "available" | "invoke_agents_required";
    }>
  > {
    const qs = new URLSearchParams();
    if (params?.q !== undefined && params.q !== "") qs.set("q", params.q);
    if (params?.kind) qs.set("kind", params.kind);
    if (params?.limit !== undefined) qs.set("limit", String(params.limit));
    if (params?.offset !== undefined) qs.set("offset", String(params.offset));
    if (params?.agentScope) qs.set("agentScope", params.agentScope);
    const suffix = qs.toString();
    const body = await this.request<{
      results: Array<{
        kind: "user" | "agent";
        id: string;
        handle: string;
        displayName: string;
        agentOwnerUserId?: string;
        agentOwnerHandle?: string | null;
        agentOwnerDisplayName?: string | null;
        lastContactAt: string | null;
        actionable: boolean;
        actionReason: "available" | "invoke_agents_required";
      }>;
    }>({
      path: `/api/directory/search${suffix ? `?${suffix}` : ""}`,
      defaultErrorPrefix: "GET directory search",
    });
    return body.results;
  }

  async listAddableAgentsForRoom(
    roomId: string,
  ): Promise<
    Array<{
      agentId: string;
      handle: string;
      displayName: string;
      agentOwnerUserId?: string;
      agentOwnerHandle?: string | null;
      agentOwnerDisplayName?: string | null;
    }>
  > {
    const body = await this.request<{
      agents: Array<{
        agentId: string;
        handle: string;
        displayName: string;
        agentOwnerUserId?: string;
        agentOwnerHandle?: string | null;
        agentOwnerDisplayName?: string | null;
      }>;
    }>({
      path: `/api/rooms/${encodeURIComponent(roomId)}/addable-agents`,
      defaultErrorPrefix: "GET room addable-agents",
    });
    return body.agents;
  }

  async getModels(query?: GetEligibleModelsQuery): Promise<AssistantModelSummary[]> {
    const params = new URLSearchParams();
    if (query?.includeUnavailable === true) params.set("includeUnavailable", "true");
    if (query?.allowChinaUpstream === true) params.set("allowChinaUpstream", "true");
    if (query?.purpose) params.set("purpose", query.purpose);
    const qs = params.toString();
    const models = await this.request<unknown>({
      path: `/api/config/models${qs ? `?${qs}` : ""}`,
      defaultErrorPrefix: "GET /api/config/models",
    });
    return z.array(assistantModelSummarySchema).parse(models);
  }

  async resolveRetainedModels(
    ids: readonly string[],
    query?: Omit<GetEligibleModelsQuery, "includeUnavailable">,
  ): Promise<AssistantModelSummary[]> {
    const models = await this.request<unknown>({
      method: "POST",
      path: "/api/config/models/resolve",
      body: {
        ids,
        ...(query?.purpose ? { purpose: query.purpose } : {}),
        ...(query?.allowChinaUpstream === undefined
          ? {}
          : { allowChinaUpstream: query.allowChinaUpstream }),
      },
      defaultErrorPrefix: "POST /api/config/models/resolve",
    });
    return z.array(assistantModelSummarySchema).parse(models);
  }

  /**
   * List the authenticated speaker's authoritative command catalogue.
   * This deliberately does not expose command bodies: selection inserts plain
   * `/name ` text and the server expands it when the message is dispatched.
   */
  async getCommands(): Promise<CommandsListResponse> {
    return this.request({
      path: "/api/commands",
      auth: "session-fresh",
      schema: commandsListResponseSchema,
      defaultErrorPrefix: "GET /api/commands",
    });
  }

  async getCommand(name: string): Promise<CommandDetail> {
    const response = await this.request({
      path: `/api/commands/${encodeURIComponent(name)}`,
      auth: "session-fresh",
      schema: commandDetailResponseSchema,
      defaultErrorPrefix: "GET /api/commands/:name",
    });
    return response.command;
  }

  async putCommand(input: PutCommandRequest): Promise<CommandDetail> {
    const response = await this.request({
      method: "PUT",
      path: "/api/commands",
      auth: "session-fresh",
      body: putCommandRequestSchema.parse(input),
      schema: commandDetailResponseSchema,
      defaultErrorPrefix: "PUT /api/commands",
    });
    return response.command;
  }

  async setCommandEnabled(name: string, enabled: boolean): Promise<CommandDetail> {
    const response = await this.request({
      method: "PATCH",
      path: `/api/commands/${encodeURIComponent(name)}`,
      auth: "session-fresh",
      body: { enabled },
      schema: commandDetailResponseSchema,
      defaultErrorPrefix: "PATCH /api/commands/:name",
    });
    return response.command;
  }

  async customizeCommand(name: string): Promise<CommandDetail> {
    const response = await this.request({
      method: "POST",
      path: `/api/commands/${encodeURIComponent(name)}/customize`,
      auth: "session-fresh",
      body: {},
      schema: commandDetailResponseSchema,
      defaultErrorPrefix: "POST /api/commands/:name/customize",
    });
    return response.command;
  }

  async resetCommand(name: string): Promise<void> {
    await this.request({
      method: "POST",
      path: `/api/commands/${encodeURIComponent(name)}/reset`,
      auth: "session-fresh",
      body: {},
      schema: commandDeleteResponseSchema,
      defaultErrorPrefix: "POST /api/commands/:name/reset",
    });
  }

  async deleteCommand(name: string): Promise<void> {
    await this.request({
      method: "DELETE",
      path: `/api/commands/${encodeURIComponent(name)}`,
      auth: "session-fresh",
      schema: commandDeleteResponseSchema,
      defaultErrorPrefix: "DELETE /api/commands/:name",
    });
  }

  async validateKeys(): Promise<{ keys: KeyReport[]; summary: CheckSummary }> {
    return this.request<{ keys: KeyReport[]; summary: CheckSummary }>({
      method: "POST",
      path: "/api/health/keys/validate",
      defaultErrorPrefix: "POST /api/health/keys/validate",
    });
  }

  /**
   * Safer-by-default: `overwrite=false` so callers must opt in to
   * clobbering an existing value. The settings-page editor explicitly
   * passes `true` because the user's intent is "change this key".
   */
  async setupKeys(
    keys: Record<string, string>,
    overwrite = false,
  ): Promise<SetupKeysResult> {
    return this.request<SetupKeysResult>({
      method: "POST",
      path: "/api/setup/keys",
      body: { keys, overwrite },
      defaultErrorPrefix: "POST /api/setup/keys",
    });
  }

  async mintClaimInvite(bootstrapToken: string): Promise<{ token: string }> {
    const res = await this._fetch(`${this.baseUrl}/api/setup/mint-claim-invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bootstrapToken}`,
      },
      body: "{}",
    });
    if (res.status === 409) {
      throw new ApiError(409, "claim invite already unredeemed");
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof body.error === "string" && body.error.length > 0
          ? body.error
          : `POST /api/setup/mint-claim-invite failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as { token?: unknown };
    if (typeof body.token !== "string" || body.token.length === 0) {
      throw new ApiError(502, "mint-claim-invite: server returned no token");
    }
    return { token: body.token };
  }

  // ---------------------------------------------------------------------------
  // relay device management
  //
  // The pair endpoint is intentionally NOT exposed here: pairing happens
  // exclusively in Electron's main process (it has the Logto access token,
  // and the resulting plaintext relay token must be persisted via
  // `safeStorage`, which the renderer can't reach). The workbench only
  // lists + revokes.
  // ---------------------------------------------------------------------------

  async listRelayDevices(): Promise<RelayDevice[]> {
    return this.request<RelayDevice[]>({
      path: "/api/relay/devices",
      defaultErrorPrefix: "GET /api/relay/devices",
    });
  }

  // The endpoint returns 204 (no body) on success; the
  // helper's success path unconditionally calls `await res.json()`, which throws SyntaxError
  // on an empty body. Returning `Promise<void>` through the helper would require widening
  // RequestOpts<T> to support no-body success responses — not worth it for one method.
  async revokeRelayDevice(id: string): Promise<void> {
    const res = await this._fetch(
      `${this.baseUrl}/api/relay/devices/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: this.authHeaders(),
      },
    );
    if (!res.ok && res.status !== 204) {
      throw new ApiError(
        res.status,
        `DELETE /api/relay/devices/${id} failed: ${res.status}`,
      );
    }
  }

  /** Version 2 — truthful physical-device projection (v1 remains above for compatibility). */
  async listGroupedRelayDevices(): Promise<RelayDeviceListResponse> {
    return this.request<RelayDeviceListResponse>({
      path: "/api/relay/devices/v2",
      defaultErrorPrefix: "GET /api/relay/devices/v2",
    });
  }

  async getGroupedRelayDevice(deviceManagementId: string): Promise<RelayDeviceDetailResponse> {
    return this.request<RelayDeviceDetailResponse>({
      path: `/api/relay/devices/v2/${encodeURIComponent(deviceManagementId)}`,
      defaultErrorPrefix: "GET /api/relay/devices/v2/:deviceManagementId",
    });
  }

  async revokeGroupedRelayDevice(
    deviceManagementId: string,
    expectedPairingCount: number,
  ): Promise<RelayDeviceMutationResult> {
    return this.request<RelayDeviceMutationResult>({
      method: "DELETE",
      path: `/api/relay/devices/v2/${encodeURIComponent(deviceManagementId)}`,
      body: { expectedPairingCount },
      defaultErrorPrefix: "DELETE /api/relay/devices/v2/:deviceManagementId",
    });
  }

  async cleanupHistoricalRelayPairings(
    expectedPairingCount: number,
  ): Promise<RelayDeviceMutationResult> {
    return this.request<RelayDeviceMutationResult>({
      method: "POST",
      path: "/api/relay/devices/v2/historical/cleanup",
      body: { confirm: true, expectedPairingCount },
      defaultErrorPrefix: "POST /api/relay/devices/v2/historical/cleanup",
    });
  }

  // ---------------------------------------------------------------------------
  // invites (mint / preview / redeem / list / agents / rooms)
  // ---------------------------------------------------------------------------

  async createInvite(input: CreateInviteInput): Promise<CreateInviteResult> {
    const result = await this.request<z.infer<typeof createInviteResultSchema>>({
      method: "POST",
      path: "/api/invites",
      body: input,
      schema: createInviteResultSchema,
      defaultErrorPrefix: "POST /api/invites",
    });
    return {
      ...result,
      mutation: result.mutation ?? {
        stateChanged: true,
        auditRecorded: "unknown",
        retrySafe: false,
        receiptId: result.id,
        recovery: [{ kind: "revoke_invite", inviteId: result.id }],
      },
    };
  }

  async listInvites(options: InviteListOptions = {}): Promise<InviteListResult> {
    const params = new URLSearchParams();
    if (options.all === true) params.set("all", "true");
    if (options.cursor !== undefined) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    const result = await this.request<z.infer<typeof inviteListResultSchema>>({
      path: `/api/invites${query.length > 0 ? `?${query}` : ""}`,
      schema: inviteListResultSchema,
      defaultErrorPrefix: "GET /api/invites",
      statusErrors: {
        401: () => new ApiError(401, "Authentication required"),
        403: (b) =>
          new ApiError(
            403,
            typeof b.error === "string" && b.error.length > 0
              ? b.error
              : "You do not have permission to list invites.",
          ),
        404: (b) =>
          new ApiError(
            404,
            typeof b.error === "string" && b.error.length > 0
              ? b.error
              : "Invites were not found.",
          ),
      },
    });
    return {
      invites: result.invites,
      page: result.page ?? {
        returned: result.invites.length,
        complete: false,
        hasMore: false,
        nextCursor: null,
        continuationAvailable: false,
      },
    };
  }

  async listMyInvites(): Promise<InviteListResult> {
    return this.listInvites();
  }

  async revokeInvite(inviteId: string): Promise<RevokeInviteResult> {
    const enc = encodeURIComponent(inviteId);
    const result = await this.request<z.infer<typeof revokeInviteResultSchema>>({
      method: "DELETE",
      path: `/api/invites/${enc}`,
      schema: revokeInviteResultSchema,
      defaultErrorPrefix: `DELETE /api/invites/${inviteId}`,
      statusErrors: {
        401: () => new ApiError(401, "Authentication required"),
        403: (b) =>
          new ApiError(
            403,
            typeof b.error === "string" && b.error.length > 0
              ? b.error
              : "You do not have permission to revoke this invite.",
          ),
        404: (b) =>
          new ApiError(
            404,
            typeof b.error === "string" && b.error.length > 0
              ? b.error
              : "Invite not found.",
          ),
      },
    });
    return {
      ok: true,
      mutation: result.mutation ?? {
        stateChanged: "unknown",
        auditRecorded: "unknown",
        retrySafe: true,
        receiptId: inviteId,
        recovery: [],
      },
    };
  }

  // The 404 -> null mapping is a status-specific success
  // case (not an error), but `statusErrors` only takes `(body) => Error` mappers. Expressing
  // this cleanly would need a separate `statusReturns?: Record<number, => T>` knob; one
  // call site doesn't justify it. Inline is correct here.
  async previewInvite(token: string): Promise<InvitePreview | null> {
    const enc = encodeURIComponent(token.replace(/^\/redeem\//, ""));
    const res = await this._fetch(`${this.baseUrl}/api/invites/${enc}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new ApiError(res.status, `GET /api/invites/:token failed: ${res.status}`);
    }
    return (await res.json()) as InvitePreview;
  }

  /**
   * Hosted first-owner claims deliberately travel only in a POST body. Unlike
   * legacy ordinary invites, they must never become an HTTP request path.
  */
  async previewOwnerClaim(input: { claim: string }): Promise<OwnerClaimPreview | null> {
    let response: z.infer<typeof ownerClaimPreviewResponseSchema>;
    try {
      response = await this.request<z.infer<typeof ownerClaimPreviewResponseSchema>>({
        method: "POST",
        path: "/api/owner-claim/preview",
        auth: "none",
        body: input,
        schema: ownerClaimPreviewResponseSchema,
        defaultErrorPrefix: "POST /api/owner-claim/preview",
        statusErrors: {
          404: () => new ApiError(404, "not_found"),
          410: (body) => ownerClaimServerError(410, body, "used_up"),
          429: () => new ApiError(429, "rate_limited"),
          500: (body) => ownerClaimServerError(500, body, "owner_claim_preview_failed"),
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    return {
      ...response,
      // Absence is only a wire-rollback adapter. It is normalized before the
      // coordinator sees it, never used to select the old owner UI.
      continuation: response.continuation ?? "new-owner",
    };
  }

  /**
   * Prepare the next hosted-auth operation without placing claim material in
   * a URL. New owners supply a handle; resumed owners receive the durable
   * reserved handle from the server and use ordinary Logto sign-in.
   */
  async prepareOwnerClaimAuth(
    input: { claim: string; handle?: string },
  ): Promise<PrepareOwnerClaimAuthResponse> {
    return this.request<PrepareOwnerClaimAuthResponse>({
      method: "POST",
      path: "/api/owner-claim/prepare-auth",
      auth: "none",
      body: input,
      schema: prepareOwnerClaimAuthResponseSchema,
      defaultErrorPrefix: "POST /api/owner-claim/prepare-auth",
      statusErrors: {
        400: (response) => ownerClaimServerError(400, response, "invalid_prepare_auth_request"),
        404: (response) => ownerClaimServerError(404, response, "not_found"),
        410: (response) => ownerClaimServerError(410, response, "used_up"),
        429: () => new ApiError(429, "rate_limited"),
        500: (response) => ownerClaimServerError(500, response, "claim_reservation_invariant"),
      },
    });
  }

  async redeemInvite(
    token: string,
    input: RedeemInput,
  ): Promise<RedeemResult> {
    const enc = encodeURIComponent(token.replace(/^\/redeem\//, ""));
    return this.request<RedeemResult>({
      method: "POST",
      path: `/api/invites/${enc}/redeem`,
      auth: "none",
      body: input,
      // Legacy generic fallback was `redeem failed: ${status}` — matches `${prefix} failed: ${status}` with prefix `redeem`.
      defaultErrorPrefix: "redeem",
    });
  }

  /**
   * Direct first-owner seed. The raw claim is body-only authorization and is
   * never interpolated into the URL. A malformed or lost success response is
   * ambiguous because recovery codes are minted exactly once.
   */
  async redeemOwnerClaim(
    input: {
      claim: string;
      handle: string;
      displayName: string;
      password: string;
      pin: string;
    },
  ): Promise<RedeemOwnerClaimResponse> {
    return this.ownerClaimMutation("redeem", () =>
      this.request<RedeemOwnerClaimResponse>({
        method: "POST",
        path: "/api/setup/owner-claim/redeem",
        auth: "none",
        body: { schemaVersion: 1, ...input },
        schema: redeemOwnerClaimResponseSchema,
        defaultErrorPrefix: "POST /api/setup/owner-claim/redeem",
        statusErrors: {
          400: (body) => ownerClaimServerError(400, body, "invalid_redeem_request"),
          403: (body) => ownerClaimServerError(403, body, "bootstrap_authority_retired_or_invalid"),
          404: (body) => ownerClaimServerError(404, body, "not_found"),
          409: (body) => ownerClaimServerError(409, body, "owner_claim_conflict"),
          410: (body) => ownerClaimServerError(410, body, "used_up"),
          423: (body) => ownerClaimServerError(423, body, "locked_out"),
          429: (body) => ownerClaimServerError(429, body, "rate_limited"),
          503: (body) => ownerClaimServerError(503, body, "logto_unconfigured"),
        },
      }),
    );
  }

  /**
   * Invite-redeem wizard preview step — exchange the invite token + the
   * user-chosen handle for an opaque `state` that the renderer threads
   * through Logto sign-up.
   *
   * Primary input is `handle`. The `email` field is
   * accepted as a deprecated alias for one release; if present, the
   * server derives a handle from its local-part and logs a deprecation
   * warning.
   */
  async prepareLogtoSignup(
    token: string,
    input: { handle: string; /** @deprecated Pass `handle`. */ email?: string },
  ): Promise<PrepareLogtoSignupResponse> {
    const enc = encodeURIComponent(token.replace(/^\/redeem\//, ""));
    return this.request<PrepareLogtoSignupResponse>({
      method: "POST",
      path: `/api/invites/${enc}/prepare-logto-signup`,
      auth: "none",
      body: input,
      defaultErrorPrefix: "POST /api/invites/:token/prepare-logto-signup",
      statusErrors: {
        400: (b) => {
          if (b.error === "invalid_handle" || b["code"] === "invalid_handle") {
            return new ApiError(400, "invalid_handle");
          }
          if (b.error === "missing_identifier" || b["code"] === "missing_identifier") {
            return new ApiError(400, "missing_identifier");
          }
          if (b.error === "invalid_email" || b["code"] === "invalid_email") {
            return new ApiError(400, "invalid_email");
          }
          return new ApiError(
            400,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "Invalid request",
          );
        },
        404: () => new ApiError(404, "not_found"),
        410: (b) =>
          new ApiError(
            410,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "Invite no longer valid",
          ),
        429: () => new ApiError(429, "rate_limited"),
        503: () => new ApiError(503, "logto_unconfigured"),
      },
    });
  }

  /** Body-only counterpart for the hosted first-owner claim handoff. */
  async prepareOwnerClaimLogtoSignup(
    input: { claim: string; handle: string },
  ): Promise<PrepareLogtoSignupResponse> {
    return this.request<PrepareLogtoSignupResponse>({
      method: "POST",
      path: "/api/owner-claim/prepare-logto-signup",
      auth: "none",
      body: input,
      defaultErrorPrefix: "POST /api/owner-claim/prepare-logto-signup",
      statusErrors: {
        400: (body) => {
          if (body.error === "invalid_handle" || body["code"] === "invalid_handle") {
            return new ApiError(400, "invalid_handle");
          }
          if (body.error === "missing_identifier" || body["code"] === "missing_identifier") {
            return new ApiError(400, "missing_identifier");
          }
          return new ApiError(400, "Invalid request");
        },
        404: () => new ApiError(404, "not_found"),
        410: () => new ApiError(410, "expired"),
        429: () => new ApiError(429, "rate_limited"),
        503: () => new ApiError(503, "logto_unconfigured"),
      },
    });
  }

  /**
   * Invite-redeem wizard profile step — set the user's displayName + PIN.
   *
   * `handle` is no longer accepted in the input — it was
   * pinned at bind time (in `/api/bind-logto-user`). The server tolerates
   * a stray `handle` field in the request body for one release but
   * returns 409 `handle_mismatch` if it disagrees with the persisted row.
   */
  async completeInviteProfile(
    token: string,
    input: { displayName: string; pin: string },
  ): Promise<CompleteInviteProfileResponse> {
    const enc = encodeURIComponent(token.replace(/^\/redeem\//, ""));
    const body = await this.request<{
      ok?: boolean;
      recoveryCodes?: unknown;
      landingRoomId?: string | null;
    }>({
      method: "POST",
      path: `/api/invites/${enc}/complete-profile`,
      body: input,
      defaultErrorPrefix: "POST /api/invites/:token/complete-profile",
      statusErrors: {
        400: (body) => ownerClaimServerError(400, body, "invalid_profile"),
        401: (body) => ownerClaimServerError(401, body, "authentication_required"),
        404: (body) => ownerClaimServerError(404, body, "not_found"),
        409: (body) => ownerClaimServerError(409, body, "not_bound"),
        410: (body) => ownerClaimServerError(410, body, "used_up"),
        429: (body) => ownerClaimServerError(429, body, "rate_limited"),
        500: (body) => ownerClaimServerError(500, body, "profile_completion_failed"),
      },
    });
    const codes = Array.isArray(body.recoveryCodes)
      ? body.recoveryCodes.filter((x): x is string => typeof x === "string")
      : [];
    const landing =
      body.landingRoomId === undefined || body.landingRoomId === null
        ? null
        : String(body.landingRoomId);
    return { ok: true, recoveryCodes: codes, landingRoomId: landing };
  }

  /** Body-only counterpart for hosted first-owner profile completion. */
  async completeOwnerClaimProfile(
    input: { claim: string; displayName: string; pin: string },
  ): Promise<CompleteInviteProfileResponse> {
    const body = await this.ownerClaimMutation("complete-profile", () =>
      this.request<CompleteInviteProfileResponse>({
        method: "POST",
        path: "/api/owner-claim/complete-profile",
        body: input,
        schema: completeInviteProfileResponseSchema,
        defaultErrorPrefix: "POST /api/owner-claim/complete-profile",
        statusErrors: {
          400: (response) => ownerClaimServerError(400, response, "invalid_profile"),
          401: (response) => ownerClaimServerError(401, response, "authentication_required"),
          404: (response) => ownerClaimServerError(404, response, "not_found"),
          409: (response) => ownerClaimServerError(409, response, "not_bound"),
          410: (response) => ownerClaimServerError(410, response, "used_up"),
          429: (response) => ownerClaimServerError(429, response, "rate_limited"),
          500: (response) => ownerClaimServerError(500, response, "profile_completion_failed"),
        },
      }),
    );
    return {
      ok: true,
      recoveryCodes: body.recoveryCodes,
      landingRoomId: body.landingRoomId,
    };
  }

  async listInvitableAgents(): Promise<InvitableAgent[]> {
    const j = await this.request<{ agents: InvitableAgent[] }>({
      path: "/api/invites/invitable-agents",
      defaultErrorPrefix: "GET invitable agents",
    });
    return j.agents;
  }

  async listInvitableRooms(): Promise<InvitableRoom[]> {
    const j = await this.request<{ rooms: InvitableRoom[] }>({
      path: "/api/invitable-rooms",
      defaultErrorPrefix: "GET invitable rooms",
    });
    return j.rooms;
  }

  /**
   * @deprecated Use {@link listInvitableRooms}. The agentId argument is ignored.
   */
  async listInvitableRoomsForAgent(_agentId: string): Promise<InvitableRoom[]> {
    return this.listInvitableRooms();
  }

  async listMiniApps(): Promise<ListMiniAppsResponse> {
    const result = await this.listMiniAppsConditional();
    if (result.status === 304) {
      throw new ApiError(304, "GET /api/apps returned 304 without If-None-Match");
    }
    return result.body;
  }

  async listMiniAppsConditional(
    options: ConditionalReadOptions = {},
  ): Promise<ConditionalReadResult<ListMiniAppsResponse>> {
    const requestOptions: RequestOpts<ListMiniAppsResponse> = {
      path: "/api/apps",
      defaultErrorPrefix: "GET /api/apps",
      ...(options.ifNoneMatch
        ? { headers: { "If-None-Match": options.ifNoneMatch } }
        : {}),
    };
    return this.conditionalGet(requestOptions, (response) =>
      this.parseConditionalJsonResponse(response, requestOptions),
    );
  }

  async getMiniApp(appId: string): Promise<PublicMiniAppDto | null> {
    const enc = encodeURIComponent(appId);
    const res = await this._fetch(`${this.baseUrl}/api/apps/${enc}`, {
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/apps/${appId} failed: ${res.status}`,
      );
    }
    return (await res.json()) as PublicMiniAppDto;
  }

  /** toggle an installed app's enabled state (disabled apps stay
   * installed but are hidden from associations + the agent tool catalog). */
  async setMiniAppEnabled(appId: string, enabled: boolean): Promise<PublicMiniAppDto> {
    const enc = encodeURIComponent(appId);
    const action = enabled ? "enable" : "disable";
    return this.request<PublicMiniAppDto>({
      method: "POST",
      path: `/api/apps/${enc}/${action}`,
      defaultErrorPrefix: `POST /api/apps/${appId}/${action}`,
      statusErrors: {
        404: (b) =>
          new ApiError(
            404,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "app not found",
          ),
      },
    });
  }

  async getMiniAppRuntime(appId: string): Promise<MiniAppRuntimeResponse> {
    const enc = encodeURIComponent(appId);
    return this.request<MiniAppRuntimeResponse>({
      path: `/api/apps/${enc}/runtime`,
      defaultErrorPrefix: `GET /api/apps/${appId}/runtime`,
      statusErrors: {
        404: (b) =>
          new ApiError(
            404,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "app not found",
          ),
        409: (b) =>
          new ApiError(
            409,
            typeof b["message"] === "string" && b["message"].length > 0
              ? b["message"]
              : typeof b.error === "string" && b.error.length > 0
                ? b.error
                : "App runtime unavailable",
          ),
        500: (b) =>
          new ApiError(
            500,
            typeof b["message"] === "string" && b["message"].length > 0
              ? b["message"]
              : "App runtime build failed",
          ),
      },
    });
  }

  async receiveLiveAppCommand(appId: string, sessionToken: string, signal: AbortSignal): Promise<{
    command: { requestId: string; documentVersion: LiveDocumentVersion; deadline: number; command: unknown } | null;
    renewed?: boolean;
  }> {
    return this.request({ method: "POST", path: `/api/apps/${encodeURIComponent(appId)}/live-session/receive-command`, body: { sessionToken }, signal });
  }

  async completeLiveAppCommand(appId: string, sessionToken: string, requestId: string, result: unknown): Promise<{ accepted: boolean }> {
    return this.request({ method: "POST", path: `/api/apps/${encodeURIComponent(appId)}/live-session/complete-command`, body: { sessionToken, requestId, result } });
  }

  async issueLiveMiniAppSession(
    appId: string,
    body: IssueLiveMiniAppSessionRequest,
  ): Promise<IssueLiveMiniAppSessionResponse> {
    return this.request<IssueLiveMiniAppSessionResponse>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session`,
      body,
      defaultErrorPrefix: `POST /api/apps/${appId}/live-session`,
    });
  }

  async refreshLiveMiniAppSession(
    appId: string,
    body: RefreshLiveMiniAppSessionRequest,
  ): Promise<IssueLiveMiniAppSessionResponse> {
    return this.request<IssueLiveMiniAppSessionResponse>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session/refresh`,
      body,
      defaultErrorPrefix: `POST /api/apps/${appId}/live-session/refresh`,
    });
  }

  async revokeLiveMiniAppSession(
    appId: string,
    body: RevokeLiveMiniAppSessionRequest,
  ): Promise<void> {
    await this.request<{ ok: true }>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session/revoke`,
      body,
      defaultErrorPrefix: `POST /api/apps/${appId}/live-session/revoke`,
    });
  }

  async listPendingLiveProposalReviews(
    appId: string,
    body: ListPendingLiveProposalReviewsRequest,
  ): Promise<ListPendingLiveProposalReviewsResponse> {
    return this.request<ListPendingLiveProposalReviewsResponse>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session/reviews`,
      body,
      defaultErrorPrefix: "Pending live proposal reviews",
    });
  }

  async applyAcceptedLiveProposal(
    appId: string,
    body: ApplyAcceptedLiveProposalRequest,
  ): Promise<ApplyAcceptedLiveProposalResponse> {
    const errorFor = (
      status: number,
      fallback: ApplyAcceptedLiveProposalErrorCode,
    ) => (response: Record<string, unknown> & { error?: unknown }) => {
      const raw = response.error;
      const allowed: readonly ApplyAcceptedLiveProposalErrorCode[] = [
        "session_closed",
        "stale_version",
        "relay_unavailable",
        "local_target_forbidden",
        "proposal_closed",
        "acceptance_conflict",
        "invalid_request",
        "payload_too_large",
      ];
      const code =
        typeof raw === "string" &&
        allowed.includes(raw as ApplyAcceptedLiveProposalErrorCode)
          ? raw as ApplyAcceptedLiveProposalErrorCode
          : fallback;
      return new LiveProposalAcceptanceError(status, code);
    };
    return this.request<ApplyAcceptedLiveProposalResponse>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session/apply-accepted`,
      body,
      defaultErrorPrefix: "Live proposal acceptance",
      statusErrors: {
        400: errorFor(400, "invalid_request"),
        403: errorFor(403, "local_target_forbidden"),
        409: errorFor(409, "proposal_closed"),
        413: errorFor(413, "payload_too_large"),
        503: errorFor(503, "relay_unavailable"),
      },
    });
  }

  async resolveLiveProposalReview(
    appId: string,
    body: ResolveLiveProposalReviewRequest,
  ): Promise<ResolveLiveProposalReviewResponse> {
    return this.request<ResolveLiveProposalReviewResponse>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session/resolve-review`,
      body,
      defaultErrorPrefix: "Live proposal review resolution",
    });
  }

  async invalidateLiveProposalReview(
    appId: string,
    body: InvalidateLiveProposalReviewRequest,
  ): Promise<InvalidateLiveProposalReviewResponse> {
    return this.request<InvalidateLiveProposalReviewResponse>({
      method: "POST",
      path: `/api/apps/${encodeURIComponent(appId)}/live-session/invalidate-review`,
      body,
      defaultErrorPrefix: "Live proposal review invalidation",
    });
  }

  /**
   * run a manifest-declared conversion (import/export) through the app's
   * deployed conversion tool. Format-agnostic: the referenced tool + the
   * `office.run` host primitive own all format + zone knowledge. Returns the
   * raw tool result (target path + sha, etc.).
   */
  async runMiniAppConversion(
    appId: string,
    body: MiniAppConversionRunRequest,
  ): Promise<MiniAppConversionRunResponse> {
    const enc = encodeURIComponent(appId);
    const roomQuery = body.roomId
      ? `?roomId=${encodeURIComponent(body.roomId)}`
      : "";
    return this.request<MiniAppConversionRunResponse>({
      method: "POST",
      path: `/api/apps/${enc}/conversions/run${roomQuery}`,
      body,
      defaultErrorPrefix: `POST /api/apps/${appId}/conversions/run`,
      statusErrors: {
        404: (b) =>
          new ApiError(
            404,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "conversion not found",
          ),
        422: (b) =>
          new ApiError(
            422,
            typeof b.error === "string" && b.error.length > 0 ? b.error : "conversion failed",
          ),
      },
    });
  }

  async getMiniAppCreateTemplate(
    appId: string,
    actionId: string,
  ): Promise<MiniAppCreateTemplateResponse> {
    const encApp = encodeURIComponent(appId);
    const encAction = encodeURIComponent(actionId);
    return this.request<MiniAppCreateTemplateResponse>({
      path: `/api/apps/${encApp}/create-templates/${encAction}`,
      defaultErrorPrefix: `GET /api/apps/${appId}/create-templates/${actionId}`,
    });
  }

  async listSlideTemplates(cursor?: string): Promise<SlideTemplateListPageDto> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return this.request<SlideTemplateListPageDto>({
      path: `/api/apps/nautilo-presentation/slide-templates${query}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET Slides templates",
    });
  }

  async readSlideTemplate(id: string): Promise<SlideTemplateContentDto> {
    return this.request<SlideTemplateContentDto>({
      path: `/api/apps/nautilo-presentation/slide-templates/${encodeURIComponent(id)}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET Slides template",
    });
  }

  async saveSlideTemplate(input: { name: string; content: string }): Promise<SlideTemplateSummaryDto> {
    return this.request<SlideTemplateSummaryDto>({
      method: "POST",
      path: "/api/apps/nautilo-presentation/slide-templates",
      body: input,
      auth: "session-fresh",
      defaultErrorPrefix: "POST Slides template",
    });
  }

  async removeSlideTemplate(id: string): Promise<void> {
    await this.request<unknown>({
      method: "DELETE",
      path: `/api/apps/nautilo-presentation/slide-templates/${encodeURIComponent(id)}`,
      auth: "session-fresh",
      defaultErrorPrefix: "DELETE Slides template",
    });
  }

  async listMiniAppSourceTree(appId: string): Promise<AppSourceTreeResponse> {
    const enc = encodeURIComponent(appId);
    return this.request<AppSourceTreeResponse>({
      path: `/api/apps/${enc}/source/tree`,
      defaultErrorPrefix: `GET /api/apps/${appId}/source/tree`,
    });
  }

  async getMiniAppSourceFile(appId: string, path: string): Promise<AppSourceFileResponse> {
    const encApp = encodeURIComponent(appId);
    const params = new URLSearchParams({ path });
    return this.request<AppSourceFileResponse>({
      path: `/api/apps/${encApp}/source/file?${params.toString()}`,
      defaultErrorPrefix: `GET /api/apps/${appId}/source/file`,
    });
  }

  async saveMiniAppSourceFile(
    appId: string,
    path: string,
    input: SaveAppSourceFileRequest,
  ): Promise<SaveAppSourceFileResponse> {
    const encApp = encodeURIComponent(appId);
    const params = new URLSearchParams({ path });
    const res = await this._fetch(
      `${this.baseUrl}/api/apps/${encApp}/source/file?${params.toString()}`,
      {
        method: "PUT",
        headers: this.jsonHeaders(),
        body: JSON.stringify(input),
      },
    );
    if (res.status === 409) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        currentSha256?: unknown;
      };
      const currentSha256 =
        typeof errJson.currentSha256 === "string" ? errJson.currentSha256 : null;
      throw new ConflictError(currentSha256);
    }
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `PUT /api/apps/${appId}/source/file failed: ${res.status}`,
      );
    }
    return (await res.json()) as SaveAppSourceFileResponse;
  }

  subscribeMiniAppEvents(handler: (e: MiniAppSourceEvent) => void): () => void {
    if (typeof EventSource !== "function") {
      throw new ApiError(501, "EventSource not available");
    }
    const token = this.getToken();
    if (!token || token.length === 0) {
      throw new ApiError(401, "Bearer token required");
    }
    const url = `${this.baseUrl}/api/apps/events?token=${encodeURIComponent(token)}`;
    const EventSourceCtor = EventSource as unknown as new (src: string) => EventSource;
    const es = new EventSourceCtor(url);
    const parseChanged = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as {
          appId?: unknown;
          sourceHash?: unknown;
        };
        if (typeof data.appId !== "string" || data.appId.length === 0) return;
        if (typeof data.sourceHash !== "string" || data.sourceHash.length === 0) return;
        handler({ type: "changed", appId: data.appId, sourceHash: data.sourceHash });
      } catch {
        // ignore malformed SSE payloads
      }
    };
    const parseStatus = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(String(ev.data)) as {
          appId?: unknown;
          status?: unknown;
        };
        if (typeof data.appId !== "string" || data.appId.length === 0) return;
        if (typeof data.status !== "string" || data.status.length === 0) return;
        handler({ type: "status", appId: data.appId, status: data.status });
      } catch {
        // ignore malformed SSE payloads
      }
    };
    type SseListener = Parameters<typeof es.addEventListener>[1];
    es.addEventListener("changed", parseChanged as unknown as SseListener);
    es.addEventListener("status", parseStatus as unknown as SseListener);
    return () => {
      es.removeEventListener("changed", parseChanged as unknown as SseListener);
      es.removeEventListener("status", parseStatus as unknown as SseListener);
      es.close();
    };
  }

  async prepareContentAccess(
    input: ContentAccessPrepareRequest,
    options: ContentAccessRequestOptions,
  ): Promise<ContentAccessPreparedResponse> {
    const roomId = contentAccessUuidSchema.parse(options.roomId);
    const params = new URLSearchParams({ roomId });
    return this.request({
      method: "POST",
      path: `/api/content-access/prepare?${params.toString()}`,
      body: contentAccessPrepareRequestSchema.parse(input),
      schema: contentAccessPreparedResponseSchema,
      statusErrors: contentAccessStatusErrors,
      defaultErrorPrefix: "POST /api/content-access/prepare",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async getContentAccess(
    object: ContentAccessPrepareRequest["object"],
    options: ContentAccessRequestOptions,
  ): Promise<ContentAccessSummary> {
    const subject = contentAccessObjectSchema.parse(object);
    const params = new URLSearchParams({ roomId: contentAccessUuidSchema.parse(options.roomId), ...subject });
    return this.request({ method: "GET", path: `/api/content-access?${params.toString()}`,
      schema: contentAccessSummarySchema, statusErrors: contentAccessStatusErrors,
      defaultErrorPrefix: "GET /api/content-access",
      ...(options.signal === undefined ? {} : { signal: options.signal }) });
  }

  async commitContentAccess(
    command: ContentAccessNormalizedCommand,
    previewToken: string,
    options: ContentAccessRequestOptions,
  ): Promise<ContentAccessReceipt> {
    const roomId = contentAccessUuidSchema.parse(options.roomId);
    const params = new URLSearchParams({ roomId });
    return this.request({
      method: "POST",
      path: `/api/content-access/commit?${params.toString()}`,
      body: contentAccessCommitRequest(command, previewToken),
      schema: contentAccessReceiptSchema,
      statusErrors: contentAccessStatusErrors,
      defaultErrorPrefix: "POST /api/content-access/commit",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async discoverOrdinaryContentAccessRecoveries(
    options: ContentAccessRequestOptions & { cursor?: string },
  ): Promise<OrdinaryContentAccessRecoveries> {
    const roomId = contentAccessUuidSchema.parse(options.roomId);
    const params = new URLSearchParams();
    if (options.cursor !== undefined) params.set("cursor", z.string().min(1).parse(options.cursor));
    const suffix = params.size === 0 ? "" : `?${params.toString()}`;
    return this.request({
      method: "GET",
      path: `/api/rooms/${encodeURIComponent(roomId)}/content-access-recovery${suffix}`,
      schema: ordinaryContentAccessRecoveriesSchema,
      defaultErrorPrefix: "GET content access recovery",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /** Traverse every bounded Room recovery page without a hidden page cap. */
  async discoverAllOrdinaryContentAccessRecoveries(
    options: ContentAccessRequestOptions,
  ): Promise<OrdinaryContentAccessRecoveryCoordinate[]> {
    const recoveries: OrdinaryContentAccessRecoveryCoordinate[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const page = await this.discoverOrdinaryContentAccessRecoveries({
        ...options,
        ...(cursor === null ? {} : { cursor }),
      });
      recoveries.push(...page.recoveries);
      const nextCursor = page.nextCursor ?? null;
      if (nextCursor !== null) {
        if (seenCursors.has(nextCursor)) {
          throw new Error("Content access recovery cursor cycle");
        }
        seenCursors.add(nextCursor);
      }
      cursor = nextCursor;
    } while (cursor !== null);
    return recoveries;
  }

  async recoverOrdinaryContentAccess(
    coordinate: OrdinaryContentAccessRecoveryCoordinate,
    options: ContentAccessRequestOptions,
  ): Promise<OrdinaryContentAccessRecoveryResult> {
    const roomId = contentAccessUuidSchema.parse(options.roomId);
    return this.request({
      method: "POST",
      path: `/api/rooms/${encodeURIComponent(roomId)}/content-access-recovery`,
      body: ordinaryContentAccessRecoveryCoordinateSchema.parse(coordinate),
      schema: ordinaryContentAccessRecoveryResultSchema,
      defaultErrorPrefix: "POST content access recovery",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async getTaskContentAccessRecovery(
    taskId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskContentAccessRecoveryResponse> {
    const parsedTaskId = z.string().min(1).parse(taskId);
    return this.request({
      method: "GET",
      path: `/api/tasks/${encodeURIComponent(parsedTaskId)}/content-access-recovery`,
      schema: taskContentAccessRecoveryResponseSchema,
      defaultErrorPrefix: "GET Task content access recovery",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async recoverTaskContentAccess(
    taskId: string,
    coordinate: TaskContentAccessRecoveryCoordinate,
    options: { signal?: AbortSignal } = {},
  ): Promise<TaskContentAccessRecoveryResult> {
    const parsedTaskId = z.string().min(1).parse(taskId);
    const parsedCoordinate = taskContentAccessRecoveryCoordinateSchema.parse(coordinate);
    if (parsedCoordinate.taskId !== parsedTaskId) {
      throw new Error("Task recovery coordinate does not match path Task");
    }
    return this.request({
      method: "POST",
      path: `/api/tasks/${encodeURIComponent(parsedTaskId)}/content-access-recovery`,
      body: parsedCoordinate,
      schema: taskContentAccessRecoveryResultSchema,
      defaultErrorPrefix: "POST Task content access recovery",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async listWorkspaceArtifacts(
    opts?: ListWorkspaceArtifactsOptions,
  ): Promise<ListArtifactsResponse> {
    const result = await this.listWorkspaceArtifactsConditional(opts);
    if (result.status === 304) {
      throw new ApiError(
        304,
        "GET /api/workspace/artifacts returned 304 without If-None-Match",
      );
    }
    return result.body;
  }

  /** one bounded, opt-in plaintext Artifact inventory page. */
  async listWorkspaceArtifactPage(
    opts: ListWorkspaceArtifactPageOptions = {},
  ): Promise<ListArtifactPageResponse> {
    const params = new URLSearchParams({ pagination: "keyset_v1" });
    if (opts.pathPrefix !== undefined) params.set("pathPrefix", opts.pathPrefix);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.roomId !== undefined && opts.roomId.length > 0) {
      params.set("roomId", opts.roomId);
    }
    if (opts.cursor !== undefined) params.set("cursor", opts.cursor);
    return this.request({
      path: `/api/workspace/artifacts?${params.toString()}`,
      schema: listArtifactPageResponseSchema,
      defaultErrorPrefix: "GET /api/workspace/artifacts (complete inventory)",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /**
   * traverse every bounded plaintext page. A stale/cyclic/malformed
   * continuation is an error; callers must never present a partial inventory
   * as complete.
   */
  async listAllWorkspaceArtifacts(
    opts: ListWorkspaceArtifactsCompleteOptions = {},
  ): Promise<ListArtifactsResponse> {
    const artifacts: ArtifactDto[] = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const page = await this.listWorkspaceArtifactPage({
        ...(opts.pathPrefix !== undefined ? { pathPrefix: opts.pathPrefix } : {}),
        ...(opts.pageSize !== undefined ? { limit: opts.pageSize } : {}),
        ...(opts.roomId !== undefined ? { roomId: opts.roomId } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      for (const artifact of page.artifacts) {
        if (seenIds.has(artifact.id)) {
          throw new ApiError(
            502,
            "Workspace Artifact inventory repeated an object across pages",
          );
        }
        seenIds.add(artifact.id);
        artifacts.push(artifact);
      }
      if (page.nextCursor === null) return { artifacts };
      if (seenCursors.has(page.nextCursor)) {
        throw new ApiError(502, "Workspace Artifact inventory repeated a continuation cursor");
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  /** authenticated, scope-bound durable media-generation status. */
  async getMediaGenerationStatus(
    receiptId: string,
    opts: { roomId: string; signal?: AbortSignal },
  ): Promise<MediaGenerationStatusDtoV1> {
    if (!/^mg_[A-Za-z0-9_-]{16,128}$/u.test(receiptId)) {
      throw new TypeError("Media generation receipt must be a server-local opaque id.");
    }
    if (opts.roomId.trim().length === 0) throw new TypeError("Media generation status requires a Room.");
    const params = new URLSearchParams({ roomId: opts.roomId });
    return this.request({
      path: `/api/media-generations/${encodeURIComponent(receiptId)}?${params.toString()}`,
      schema: mediaGenerationStatusDtoV1Schema,
      defaultErrorPrefix: "GET /api/media-generations/:receiptId",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  /** Parent-host-only Video take status; it never receives a generation receipt. */
  async getVideoGenerationTakeStatus(
    takeId: string,
    opts: { roomId: string; projectArtifactId: string; attestationToken: string; signal?: AbortSignal },
  ): Promise<VideoGenerationTakeStatusDtoV1> {
    if (!/^take_[A-Za-z0-9_-]{16,128}$/u.test(takeId)) throw new TypeError("Video take id must be opaque.");
    if (!opts.roomId.trim() || !opts.projectArtifactId.trim() || !opts.attestationToken.trim()) throw new TypeError("Video take status requires attested project context.");
    const params = new URLSearchParams({ roomId: opts.roomId, projectArtifactId: opts.projectArtifactId });
    return this.request({
      path: `/api/video-generations/${encodeURIComponent(takeId)}/status?${params.toString()}`,
      schema: videoGenerationTakeStatusDtoV1Schema,
      headers: { "X-Nautilo-Video-Host-Attestation": opts.attestationToken },
      defaultErrorPrefix: "GET /api/video-generations/:takeId/status",
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  async issueVideoHostAttestation(input: { roomId: string; projectArtifactId: string; sourceHash: string }): Promise<VideoHostAttestationDtoV1> {
    if (!input.roomId.trim() || !input.projectArtifactId.trim() || !/^[a-f0-9]{64}$/u.test(input.sourceHash)) {
      throw new TypeError("Video host attestation requires the loaded runtime's source hash and project context.");
    }
    return this.request({ method: "POST", path: "/api/apps/nautilo-video/video-host-attestation", body: input,
      schema: videoHostAttestationDtoV1Schema, defaultErrorPrefix: "POST /api/apps/nautilo-video/video-host-attestation" });
  }

  async revokeVideoHostAttestation(attestationToken: string): Promise<void> {
    await this.request({ method: "POST", path: "/api/apps/nautilo-video/video-host-attestation/revoke", body: { attestationToken },
      emptyResponse: true, defaultErrorPrefix: "POST /api/apps/nautilo-video/video-host-attestation/revoke" });
  }

  /** Parent-host-only take preparation; the quote remains the normalization authority. */
  async prepareVideoGeneration(
    input: VideoGenerationPrepareRequestV1,
    attestationToken: string,
  ): Promise<VideoGenerationReviewDtoV1> {
    const parsed = videoGenerationPrepareRequestV1Schema.parse(input);
    if (!attestationToken.trim()) throw new TypeError("Video generation prepare requires a host attestation.");
    return this.request({
      method: "POST",
      path: "/api/video-generations/prepare",
      body: parsed,
      schema: videoGenerationReviewDtoV1Schema,
      headers: { "X-Nautilo-Video-Host-Attestation": attestationToken },
      statusErrors: { 422: (body) =>
        (body["code"] === "request_invalid" || body["code"] === "quote_unavailable") && typeof body["recovery"] === "string" && body["recovery"].trim()
          ? new VideoGenerationPreparationError(body["code"], body["recovery"])
          : new ApiError(422, "Video generation could not be prepared.") },
      defaultErrorPrefix: "POST /api/video-generations/prepare",
    });
  }

  /** Submits precisely the reviewed take; the private generation receipt never crosses this boundary. */
  async submitVideoGenerationTake(
    takeId: string,
    input: { roomId: string; projectArtifactId: string; reviewHandle: string; attestationToken: string },
  ): Promise<VideoGenerationSubmitDtoV1> {
    if (!/^take_[A-Za-z0-9_-]{16,128}$/u.test(takeId)) throw new TypeError("Video take id must be opaque.");
    if (!input.roomId.trim() || !input.projectArtifactId.trim() || !input.reviewHandle.trim() || !input.attestationToken.trim()) {
      throw new TypeError("Video generation submit requires its exact reviewed project context.");
    }
    return this.request({
      method: "POST",
      path: `/api/video-generations/${encodeURIComponent(takeId)}/submit`,
      body: { roomId: input.roomId, projectArtifactId: input.projectArtifactId, reviewHandle: input.reviewHandle },
      schema: videoGenerationSubmitDtoV1Schema,
      headers: { "X-Nautilo-Video-Host-Attestation": input.attestationToken },
      defaultErrorPrefix: "POST /api/video-generations/:takeId/submit",
    });
  }

  async listVideoGenerationTakes(opts: { roomId: string; projectArtifactId: string; attestationToken: string }): Promise<VideoGenerationTakeListDtoV1> {
    const params = new URLSearchParams({ roomId: opts.roomId, projectArtifactId: opts.projectArtifactId });
    return this.request({ path: `/api/video-generations?${params.toString()}`, schema: videoGenerationTakeListDtoV1Schema,
      headers: { "X-Nautilo-Video-Host-Attestation": opts.attestationToken }, defaultErrorPrefix: "GET /api/video-generations" });
  }

  async listWorkspaceArtifactsConditional(
    opts: ListWorkspaceArtifactsOptions & ConditionalReadOptions = {},
  ): Promise<ConditionalReadResult<ListArtifactsResponse>> {
    const params = new URLSearchParams();
    if (opts?.pathPrefix !== undefined) params.set("pathPrefix", opts.pathPrefix);
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.roomId !== undefined && opts.roomId.length > 0) params.set("roomId", opts.roomId);
    const qs = params.toString();
    const requestOptions: RequestOpts<ListArtifactsResponse> = {
      path: `/api/workspace/artifacts${qs ? `?${qs}` : ""}`,
      defaultErrorPrefix: "GET /api/workspace/artifacts",
      ...(opts.ifNoneMatch
        ? { headers: { "If-None-Match": opts.ifNoneMatch } }
        : {}),
    };
    return this.conditionalGet(requestOptions, (response) =>
      this.parseConditionalJsonResponse(response, requestOptions),
    );
  }

  async getWorkspaceArtifactByPublicId(artifactId: string, opts: { roomId?: string; signal?: AbortSignal } = {}): Promise<ArtifactDto | null> {
    const query = opts.roomId ? `?roomId=${encodeURIComponent(opts.roomId)}` : "";
    try {
      return await this.request<ArtifactDto>({ path: `/api/workspace/artifacts/by-public-id/${encodeURIComponent(artifactId)}${query}`, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getWorkspaceArtifact(id: string, opts?: { roomId?: string }): Promise<ArtifactDto | null> {
    const enc = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const res = await this._fetch(`${this.baseUrl}/api/workspace/artifacts/${enc}${q}`, {
      headers: this.authHeaders(),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/workspace/artifacts/${id} failed: ${res.status}`,
      );
    }
    return (await res.json()) as ArtifactDto;
  }

  /**
   * Reads the latest host-authorized authored change for one exact Workspace
   * document version. The response is deliberately left unknown here: the
   * sandbox host validates the closed projection before exposing it to an app.
   */
  async getWorkspaceArtifactAuthoredChange(
    id: string,
    opts: {
      roomId: string;
      expectedSha256: string;
      expectedRevision: number;
    },
  ): Promise<unknown> {
    const params = new URLSearchParams({
      roomId: opts.roomId,
      expectedSha256: opts.expectedSha256,
      expectedRevision: String(opts.expectedRevision),
    });
    return this.request<unknown>({
      path: `/api/workspace/artifacts/${encodeURIComponent(id)}/authored-change?${params.toString()}`,
      defaultErrorPrefix: "GET /api/workspace/artifacts/:id/authored-change",
    });
  }

  /**
   * Compatibility API for general Blob consumers. This intentionally retains
   * its original unbounded response behavior; preview callers use the separate
   * bounded ArrayBuffer API below.
   */
  async getWorkspaceArtifactBytes(id: string, opts?: { roomId?: string }): Promise<Blob> {
    const res = await this._fetch(this.getWorkspaceArtifactBytesUrl(id, opts), {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/workspace/artifacts/${id}/bytes failed: ${res.status}`,
      );
    }
    return await res.blob();
  }

  /**
   * Fetch an authorized Artifact as one bounded ArrayBuffer.
   *
   * The route is deliberately fetched with redirects disabled. The response is
   * read incrementally, never handed to Blob, and only returned after its
   * declared and observed sizes agree. No partial bytes escape on any failure.
   */
  async getWorkspaceArtifactBytesArrayBuffer(
    id: string,
    opts?: WorkspaceArtifactBytesOptions,
  ): Promise<ArrayBuffer> {
    const maxBytes = validByteCount(opts?.maxBytes, "maxBytes") ?? MAX_WORKSPACE_ARTIFACT_STREAM_BYTES;
    const expectedBytes = validByteCount(opts?.expectedBytes, "expectedBytes");
    if (expectedBytes !== undefined && expectedBytes > maxBytes) {
      throw new WorkspaceArtifactStreamError("size", "Artifact is too large to preview.");
    }
    if (opts?.signal?.aborted) throw createAbortError();

    let response: Response;
    try {
      response = await this._fetch(this.getWorkspaceArtifactBytesUrl(id, opts), {
        headers: this.authHeaders(),
        redirect: "error",
        ...(opts?.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      if (opts?.signal?.aborted) throw createAbortError();
      throw error;
    }
    if (response.redirected || response.type === "opaqueredirect") {
      throw new WorkspaceArtifactStreamError("redirect", "Artifact response redirect was rejected.");
    }
    if (!response.ok) {
      const errJson = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        response.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/workspace/artifacts/${id}/bytes failed: ${response.status}`,
      );
    }

    const declaredBytes = contentLength(response);
    if (declaredBytes !== undefined && declaredBytes > maxBytes) {
      throw new WorkspaceArtifactStreamError("size", "Artifact is too large to preview.");
    }
    if (
      expectedBytes !== undefined &&
      declaredBytes !== undefined &&
      expectedBytes !== declaredBytes
    ) {
      throw new WorkspaceArtifactStreamError(
        "content_length",
        "Artifact response size does not match its authorized metadata.",
      );
    }
    if (response.body === null) {
      if ((declaredBytes ?? expectedBytes ?? 0) === 0) return new ArrayBuffer(0);
      throw new WorkspaceArtifactStreamError("response", "Artifact response body was unavailable.");
    }

    const reader = response.body.getReader();
    const cancelReaderOnAbort = (): void => {
      void reader.cancel(opts?.signal?.reason).catch(() => undefined);
    };
    opts?.signal?.addEventListener("abort", cancelReaderOnAbort, { once: true });
    let completed = false;
    let received = 0;
    const knownLengthOutput = declaredBytes === undefined ? undefined : new Uint8Array(declaredBytes);
    const collector = knownLengthOutput === undefined ? new BoundedByteCollector(maxBytes) : undefined;
    try {
      while (true) {
        if (opts?.signal?.aborted) throw createAbortError();
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value as Uint8Array;
        if (chunk.byteLength > maxBytes - received) {
          throw new WorkspaceArtifactStreamError("size", "Artifact is too large to preview.");
        }
        if (knownLengthOutput !== undefined) {
          if (chunk.byteLength > knownLengthOutput.byteLength - received) {
            throw new WorkspaceArtifactStreamError("truncated", "Artifact response exceeded its content length.");
          }
          knownLengthOutput.set(chunk, received);
        } else {
          collector!.append(chunk);
        }
        received += chunk.byteLength;
      }
      if (opts?.signal?.aborted) throw createAbortError();
      if (declaredBytes !== undefined && received !== declaredBytes) {
        throw new WorkspaceArtifactStreamError("truncated", "Artifact response ended before its content length.");
      }
      if (expectedBytes !== undefined && received !== expectedBytes) {
        throw new WorkspaceArtifactStreamError(
          "truncated",
          "Artifact response size does not match its authorized metadata.",
        );
      }
      if (received > maxBytes) {
        throw new WorkspaceArtifactStreamError("size", "Artifact is too large to preview.");
      }
      completed = true;
      return knownLengthOutput?.buffer ?? collector!.toArrayBuffer();
    } catch (error) {
      if (opts?.signal?.aborted) throw createAbortError();
      if (error instanceof WorkspaceArtifactStreamError || (error instanceof DOMException && error.name === "AbortError")) {
        throw error;
      }
      throw new WorkspaceArtifactStreamError("response", "Artifact response stream failed.");
    } finally {
      opts?.signal?.removeEventListener("abort", cancelReaderOnAbort);
      if (!completed) {
        await reader.cancel().catch(() => undefined);
      }
      reader.releaseLock();
    }
  }

  /**
   * build the authed byte-route URL for a workspace artifact
   * (internal artifact id + optional `roomId`). Analogous to
   * {@link getMessageAttachmentUrl}: returns the URL only — does not fetch — so
   * the caller can hand it directly to a native streamed downloader
   * (`expo-file-system` `File.downloadFileAsync`) that attaches the session
   * bearer via its `headers` option. Single source of truth for the bytes route
   * so UI/transport code never rebuilds the URL. The route is namespace-gated
   * server-side (401/403/404/501).
   */
  getWorkspaceArtifactBytesUrl(id: string, opts?: { roomId?: string }): string {
    const enc = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return `${this.baseUrl}/api/workspace/artifacts/${enc}/bytes${q}`;
  }

  /**
   * `GET /api/workspace/artifacts/:id/discussion-rooms`.
   * Lists the discussion rooms attached to a workspace artifact. The route is
   * authorized server-side against the viewer's memory envelope (401 / 403 /
   * 404 / 501), so this wrapper only forwards the request and surfaces non-2xx
   * as `ApiError`. Uses `session-fresh` so a stale renderer bearer can't 401 the
   * read, and URL-encodes the artifact id (it is an internal row uuid but the
   * server still validates shape).
   */
  async listArtifactDiscussionRooms(
    id: string,
  ): Promise<ListArtifactDiscussionRoomsResponse> {
    return this.request<ListArtifactDiscussionRoomsResponse>({
      path: `/api/workspace/artifacts/${encodeURIComponent(id)}/discussion-rooms`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/workspace/artifacts/:id/discussion-rooms",
    });
  }

  /**
   * `POST /api/workspace/artifacts/:id/discussion-rooms`.
   * "Start a new conversation" from an artifact: the server atomically
   * mints an authorized conversational Room (caller + caller's personal
   * agent) and attaches the artifact to that Room's Namespace in a single
   * transaction, then returns the safe `{ id, label, kind }` projection of
   * the new room. No namespace id is exposed; the personal agent is
   * resolved server-side from the caller's session.
   *
   * The route is authorized server-side against the viewer's memory
   * envelope (401 / 403 / 404 / 501), so this wrapper only forwards the
   * request and surfaces non-2xx as `ApiError`. Uses `session-fresh` so a
   * stale renderer bearer can't 401 the create, and URL-encodes the
   * artifact id. `opts.label` is optional (1–80 chars); when omitted the
   * server defaults the label to the artifact's path basename.
   */
  async createArtifactDiscussionRoom(
    id: string,
    opts?: { label?: string },
  ): Promise<ArtifactDiscussionRoom> {
    const trimmed = opts?.label?.trim();
    return this.request<ArtifactDiscussionRoom>({
      method: "POST",
      path: `/api/workspace/artifacts/${encodeURIComponent(id)}/discussion-rooms`,
      auth: "session-fresh",
      ...(trimmed && trimmed.length > 0 ? { body: { label: trimmed } } : {}),
      defaultErrorPrefix: "POST /api/workspace/artifacts/:id/discussion-rooms",
    });
  }

  /**
   * build the authed byte-route URL for a retained message attachment
   * (image or audio). The caller MUST attach the session bearer header when
   * loading the bytes (e.g. `expo-image`'s `headers` prop, or a fetch +
   * object URL for desktop). The route is namespace-gated server-side, so a
   * non-member receives 404. Returns the URL only — does not fetch — so the
   * caller can hand it directly to an image/audio element.
   */
  getMessageAttachmentUrl(id: string, opts?: { roomId?: string }): string {
    const room = opts?.roomId;
    const query = room && room.length > 0 ? `?roomId=${encodeURIComponent(room)}` : "";
    return `${this.baseUrl}/api/message-attachments/${encodeURIComponent(id)}${query}`;
  }

  /**
   * mint a WOPI access token for an office artifact and get the fully
   * assembled Collabora editor URL (server-side assembly avoids CORS on the
   * coolwsd discovery fetch and keeps the WOPI origin/token off the client).
   * v1 permission is "readonly" (viewer); future contracts may add "edit".
   */
  async getOfficeEditorUrl(
    artifactId: string,
    opts?: { permission?: "readonly" | "edit"; roomId?: string },
  ): Promise<{ editorUrl: string | null }> {
    // roomId is a QUERY param (not body) so the server preHandler scopes the
    // memory envelope to that room — same convention as the artifacts routes.
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const res = await this._fetch(`${this.baseUrl}/api/office/wopi-token${q}`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({
        artifactId,
        permission: opts?.permission ?? "readonly",
      }),
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/office/wopi-token failed: ${res.status}`,
      );
    }
    return (await res.json()) as { editorUrl: string | null };
  }

  async saveWorkspaceArtifactContent(
    id: string,
    content: string,
    opts: {
      baseRevision: number | null;
      baseSha256: string | null;
      checkpoint: boolean;
      mimeType?: string;
      roomId?: string;
      clientMutationId?: string;
    },
  ): Promise<{ id: string; revision: number; size: number; sha256: string }> {
    const enc = encodeURIComponent(id);
    const q =
      opts.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const headers: Record<string, string> = {
      ...this.authHeaders(),
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (opts.mimeType !== undefined && opts.mimeType.length > 0) {
      headers["X-Artifact-Mime-Type"] = opts.mimeType;
    }
    if (opts.baseRevision !== null) {
      headers["If-Match"] = String(opts.baseRevision);
    }
    if (opts.baseSha256 !== null) {
      headers["X-Base-Sha256"] = opts.baseSha256;
    }
    if (opts.checkpoint) {
      headers["X-Checkpoint"] = "1";
    }
    if (opts.clientMutationId !== undefined && opts.clientMutationId.length > 0) {
      headers["X-Client-Mutation-Id"] = opts.clientMutationId;
    }
    const res = await this._fetch(`${this.baseUrl}/api/workspace/artifacts/${enc}/content${q}`, {
      method: "PUT",
      headers,
      body: content,
    });
    if (res.status === 409) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        currentSha256?: unknown;
      };
      const currentSha256 =
        typeof errJson.currentSha256 === "string" ? errJson.currentSha256 : null;
      throw new ConflictError(currentSha256);
    }
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `PUT /api/workspace/artifacts/${id}/content failed: ${res.status}`,
      );
    }
    return (await res.json()) as { id: string; revision: number; size: number; sha256: string };
  }

  async applyWorkspaceArtifactPatch(
    id: string,
    body: DocumentPatchRequest,
    opts?: { roomId?: string },
  ): Promise<DocumentPatchApplied> {
    const enc = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const res = await this._fetch(`${this.baseUrl}/api/workspace/artifacts/${enc}/patch${q}`, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      const rejection = (await res.json().catch(() => ({
        kind: "stale_base_unrebaseable",
        latestRevision: null,
        latestSha256: "",
      }))) as DocumentPatchRejected;
      throw new DocumentPatchConflictError(rejection);
    }
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
        reason?: unknown;
      };
      const msg =
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : typeof errJson.reason === "string" && errJson.reason.length > 0
            ? errJson.reason
            : `POST /api/workspace/artifacts/${id}/patch failed: ${res.status}`;
      throw new ApiError(res.status, msg);
    }
    return (await res.json()) as DocumentPatchApplied;
  }

  /**
   * advisory human-edit lease registration. The request has only an
   * untrusted target candidate and editor state; the authenticated transport
   * resolves identity, version, and human ownership before it touches the
   * registry.
   */
  async registerHumanEditLease(
    input: RegisterHumanEditLeaseRequest,
    opts?: { roomId?: string },
  ): Promise<HumanEditLeaseStoreResult> {
    const body = registerHumanEditLeaseRequestSchema.parse(input);
    const roomId =
      body.target.kind === "workspace_artifact" &&
      opts?.roomId !== undefined &&
      opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.requestHumanEditLeaseStoreResult({
      method: "POST",
      path: `/api/document-mutations/human-edit-leases${roomId}`,
      body,
      defaultErrorPrefix: "POST /api/document-mutations/human-edit-leases",
    });
  }

  /** compare-and-swap editor-state update for an existing lease. */
  async updateHumanEditLease(
    leaseId: string,
    input: UpdateHumanEditLeaseRequest,
    opts?: { roomId?: string },
  ): Promise<HumanEditLeaseStoreResult> {
    const body = updateHumanEditLeaseRequestSchema.parse(input);
    const roomId =
      body.target.kind === "workspace_artifact" &&
      opts?.roomId !== undefined &&
      opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.requestHumanEditLeaseStoreResult({
      method: "PATCH",
      path: `/api/document-mutations/human-edit-leases/${encodeURIComponent(leaseId)}${roomId}`,
      body,
      defaultErrorPrefix: "PATCH /api/document-mutations/human-edit-leases/:leaseId",
    });
  }

  /** renew a held lease without changing its editor state. */
  async renewHumanEditLease(
    leaseId: string,
    input: RenewHumanEditLeaseRequest,
    opts?: { roomId?: string },
  ): Promise<HumanEditLeaseStoreResult> {
    const body = renewHumanEditLeaseRequestSchema.parse(input);
    const roomId =
      body.target.kind === "workspace_artifact" &&
      opts?.roomId !== undefined &&
      opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.requestHumanEditLeaseStoreResult({
      method: "POST",
      path: `/api/document-mutations/human-edit-leases/${encodeURIComponent(leaseId)}/renew${roomId}`,
      body,
      defaultErrorPrefix: "POST /api/document-mutations/human-edit-leases/:leaseId/renew",
    });
  }

  /** release a held lease. Registry TTL remains the crash fallback. */
  async releaseHumanEditLease(
    leaseId: string,
    input: ReleaseHumanEditLeaseRequest,
  ): Promise<HumanEditLeaseStoreResult> {
    const body = releaseHumanEditLeaseRequestSchema.parse(input);
    return this.requestHumanEditLeaseStoreResult({
      method: "POST",
      path: `/api/document-mutations/human-edit-leases/${encodeURIComponent(leaseId)}/release`,
      body,
      defaultErrorPrefix: "POST /api/document-mutations/human-edit-leases/:leaseId/release",
    });
  }

  /**
   * HTTP failures already emerge as ApiError from `request`. A malformed 2xx
   * registry response is a server integration failure too, not a Zod error a
   * Workbench editor must understand.
   */
  private async requestHumanEditLeaseStoreResult(input: {
    method: "POST" | "PATCH";
    path: string;
    body:
      | RegisterHumanEditLeaseRequest
      | UpdateHumanEditLeaseRequest
      | RenewHumanEditLeaseRequest
      | ReleaseHumanEditLeaseRequest;
    defaultErrorPrefix: string;
  }): Promise<HumanEditLeaseStoreResult> {
    // Lease registry state is intentionally communicated through both normal
    // and conflict/not-found HTTP responses. Do not use the generic request
    // helper here: it correctly throws on every non-2xx for ordinary routes,
    // but a 404 `not_found` and 409 `stale_generation` are controller inputs.
    const headers = {
      ...(await this.authHeadersFresh()),
      "Content-Type": "application/json",
    };
    const response = await this._fetch(`${this.baseUrl}${input.path}`, {
      method: input.method,
      headers,
      body: JSON.stringify(input.body),
    });

    if (response.status !== 200 && response.status !== 404 && response.status !== 409) {
      const errorBody = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      throw new ApiError(
        response.status,
        typeof errorBody["error"] === "string" && errorBody["error"].length > 0
          ? errorBody["error"]
          : `${input.defaultErrorPrefix} failed: ${response.status}`,
      );
    }

    const responseBody: unknown = await response.json().catch(() => undefined);
    const parsed = humanEditLeaseStoreResultSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ApiError(502, `${input.defaultErrorPrefix}: malformed server response`);
    }
    const statusMatchesResult =
      (response.status === 200 && parsed.data.status === "ok") ||
      (response.status === 404 && parsed.data.status === "not_found") ||
      (response.status === 409 &&
        (parsed.data.status === "stale_generation" || parsed.data.status === "invalid"));
    if (!statusMatchesResult) {
      throw new ApiError(502, `${input.defaultErrorPrefix}: mismatched server response status`);
    }
    return parsed.data;
  }

  /**
   * read interactive-artifact state by key. Returns the
   * value + metadata when set; rejects with `ApiError` of status 404
   * when the key is unset (distinct from `value: null`, which is a
   * legitimate stored state). Wrapped on the iframe side by
   * `state-bridge-client.ts` which translates 404 to `undefined`.
   */
  async getArtifactState(
    id: string,
    key: string,
    opts?: { roomId?: string },
  ): Promise<{
    artifactId: string;
    key: string;
    value: unknown;
    namespaceId: string;
    updatedAt: string;
  }> {
    const encId = encodeURIComponent(id);
    const encKey = encodeURIComponent(key);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    // 404 stays an `ApiError` with `.status === 404`, which the iframe-side
    // wrapper in `state-bridge-client.ts` already destructures to translate
    // to `undefined` ("key is unset"). Going through `request<T>()` keeps
    // that contract intact.
    return this.request<{
      artifactId: string;
      key: string;
      value: unknown;
      namespaceId: string;
      updatedAt: string;
    }>({
      path: `/api/workspace/artifacts/${encId}/state/${encKey}${q}`,
      defaultErrorPrefix: `GET /api/workspace/artifacts/${id}/state/${key}`,
    });
  }

  /**
   * write interactive-artifact state. Upserts on the
   * (namespace, agent, artifactId, key) composite key. The server
   * picks the target namespace from the overlap of the artifact's
   * attachments and the caller's writable set — see the route doc
   * for the policy. `value` is any JSON-serializable payload
   * including `null`.
   */
  async setArtifactState(
    id: string,
    key: string,
    value: unknown,
    opts?: { roomId?: string },
  ): Promise<{
    artifactId: string;
    key: string;
    value: unknown;
    namespaceId: string;
    updatedAt: string;
  }> {
    const encId = encodeURIComponent(id);
    const encKey = encodeURIComponent(key);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.request<{
      artifactId: string;
      key: string;
      value: unknown;
      namespaceId: string;
      updatedAt: string;
    }>({
      method: "PUT",
      path: `/api/workspace/artifacts/${encId}/state/${encKey}${q}`,
      body: { value },
      defaultErrorPrefix: `PUT /api/workspace/artifacts/${id}/state/${key}`,
    });
  }

  /**
   * enqueue an agent-notification event from an interactive
   * artifact. Appends to `pending_artifact_events` (drained by
   * `read_artifact_events` on the agent's next turn). `topic` is a
   * bounded string; `payload` is any JSON-serializable value including
   * `null`. Wrapped on the iframe side by `state-bridge-client.ts`
   * (`nwState.emit`) and the workbench host bridge (`nw.event.emit`).
   */
  async emitArtifactEvent(
    id: string,
    topic: string,
    payload: unknown,
    opts?: { roomId?: string },
  ): Promise<{
    artifactId: string;
    topic: string;
    id: string;
    createdAt: string;
    droppedCount?: number;
  }> {
    const encId = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.request<{
      artifactId: string;
      topic: string;
      id: string;
      createdAt: string;
      droppedCount?: number;
    }>({
      method: "POST",
      path: `/api/workspace/artifacts/${encId}/events${q}`,
      body: { topic, payload },
      defaultErrorPrefix: `POST /api/workspace/artifacts/${id}/events`,
    });
  }

  /**
   * enqueue an agent-notification event from an interactive
   * artifact and wake an idle agent now. Appends to
   * `pending_artifact_events` (same enqueue path as `emitArtifactEvent`)
   * plus a coalesced `preset='ping'` task when no open ping task exists.
   * Wrapped on the iframe side by `state-bridge-client.ts` (`nwState.ping`)
   * and the workbench host bridge (`nw.event.ping`).
   */
  async pingArtifactEvent(
    id: string,
    topic: string,
    payload: unknown,
    opts?: { roomId?: string },
  ): Promise<{
    artifactId: string;
    topic: string;
    id: string;
    createdAt: string;
    droppedCount?: number;
    woke?: boolean;
  }> {
    const encId = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.request<{
      artifactId: string;
      topic: string;
      id: string;
      createdAt: string;
      droppedCount?: number;
      woke?: boolean;
    }>({
      method: "POST",
      path: `/api/workspace/artifacts/${encId}/events/ping${q}`,
      body: { topic, payload },
      defaultErrorPrefix: `POST /api/workspace/artifacts/${id}/events/ping`,
    });
  }

  async getWorkspaceArtifactObjectUrl(id: string, opts?: { roomId?: string }): Promise<string> {
    const hit = this.workspaceArtifactObjectUrlCache.get(id);
    if (hit !== undefined) return hit;
    if (typeof URL.createObjectURL !== "function") {
      throw new ApiError(501, "URL.createObjectURL not available");
    }
    const blob = await this.getWorkspaceArtifactBytes(id, opts);
    const url = URL.createObjectURL(blob);
    this.workspaceArtifactObjectUrlCache.set(id, url);
    return url;
  }

  revokeWorkspaceArtifactObjectUrl(id: string): void {
    const cached = this.workspaceArtifactObjectUrlCache.get(id);
    if (cached === undefined) return;
    if (typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(cached);
    this.workspaceArtifactObjectUrlCache.delete(id);
  }

  /**
   * Clear every cached workspace artifact object URL. Test-only helper —
   * the hook used to do this implicitly on unmount, which evicted shared
   * entries from sibling consumers. The api-client owns
   * the cache; revocation is now driven by the Workspace tab's SSE
   * `deleted` handler.
   */
  clearWorkspaceArtifactObjectUrlCache(): void {
    if (typeof URL.revokeObjectURL === "function") {
      for (const url of this.workspaceArtifactObjectUrlCache.values()) {
        URL.revokeObjectURL(url);
      }
    }
    this.workspaceArtifactObjectUrlCache.clear();
  }

  /**
   * upload a composer attachment's bytes. Returns an `attachmentId`
   * the composer references at send time. The server stores it as a pending
   * upload bound to the caller + the turn's namespace until the message sends.
   */
  async uploadMessageAttachment(
    file: Blob,
    filename: string,
    opts?: { roomId?: string },
  ): Promise<{ attachmentId: string; filename: string; mimeType: string; sizeBytes: number; status: string }> {
    const form = new FormData();
    form.append("file", file, filename.length > 0 ? filename : "attachment");
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const res = await this._fetch(`${this.baseUrl}/api/message-attachments${q}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/message-attachments failed: ${res.status}`,
      );
    }
    return (await res.json()) as {
      attachmentId: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      status: string;
    };
  }

  /**
   * Cancel a pending composer upload or delete a retained attachment the
   * current viewer may remove. The server applies the distinct uploader and
   * namespace capability checks; callers receive the ordinary typed API
   * errors rather than inferring which attachment state existed.
   */
  async deleteMessageAttachment(id: string): Promise<{ ok: true }> {
    return this.request<{ ok: true }>({
      method: "DELETE",
      path: `/api/message-attachments/${encodeURIComponent(id)}`,
      auth: "session-fresh",
      defaultErrorPrefix: `DELETE /api/message-attachments/${id}`,
    });
  }

  /**
   * transcribe an audio recording via `POST /api/stt` (speech-to-text).
   * `file` is a Blob-shaped audio recording; returns the transcript. On mobile,
   * pass an Expo FS `File` (Blob-shaped with `.bytes()`) so Winter fetch streams
   * the real bytes — see `apps/mobile/src/lib/attachments.ts` for the rationale.
   * The server reads the first multipart file part (desktop convention: field
   * name `"audio"`); 400 non-audio, 502 provider error, 503 no provider.
   */
  async transcribeAudio(
    file: Blob,
    filename: string,
  ): Promise<{ text: string; provider: string; model: string }> {
    const form = new FormData();
    form.append("audio", file, filename.length > 0 ? filename : "recording.m4a");
    const res = await this._fetch(`${this.baseUrl}/api/stt`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/stt failed: ${res.status}`,
      );
    }
    return (await res.json()) as { text: string; provider: string; model: string };
  }

  async createWorkspaceArtifact(
    file: Blob,
    opts: { path: string; mimeType?: string; roomId?: string },
  ): Promise<ArtifactDto> {
    const form = new FormData();
    const slash = opts.path.lastIndexOf("/");
    const base = slash >= 0 ? opts.path.slice(slash + 1) : opts.path;
    const filename = base.length > 0 ? base : "upload.bin";
    form.append("file", file, filename);
    form.append("path", opts.path);
    if (opts.mimeType !== undefined && opts.mimeType.length > 0) {
      form.append("mimeType", opts.mimeType);
    }
    const q =
      opts.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const res = await this._fetch(`${this.baseUrl}/api/workspace/artifacts${q}`, {
      method: "POST",
      headers: this.authHeaders(),
      body: form,
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as Record<string, unknown> & {
        error?: unknown;
      };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/workspace/artifacts failed: ${res.status}`,
      );
    }
    return (await res.json()) as ArtifactDto;
  }

  /**
   * create a blank LibreOffice document (Writer/Calc/Impress) from a
   * server-side template and return the new artifact. Unlike
   * `createWorkspaceArtifact`, there is no user file to upload; the server
   * copies the committed blank template for `kind`.
   */
  async createBlankOfficeDoc(
    kind: "writer" | "calc" | "impress",
    opts?: { name?: string; roomId?: string },
  ): Promise<ArtifactDto> {
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.request<ArtifactDto>({
      method: "POST",
      path: `/api/office/new${q}`,
      body: {
        kind,
        ...(opts?.name !== undefined && opts.name.length > 0 ? { name: opts.name } : {}),
      },
      defaultErrorPrefix: "POST /api/office/new",
    });
  }

  async shareWorkspaceArtifact(id: string, recipientUserId: string, opts?: { roomId?: string }): Promise<{ status: "shared" | "already_shared" }> {
    const query = opts?.roomId ? `?roomId=${encodeURIComponent(opts.roomId)}` : "";
    return this.request({ method: "POST", path: `/api/workspace/artifacts/${encodeURIComponent(id)}/share${query}`,
      body: { recipientUserId }, defaultErrorPrefix: "Could not add file to workspace" });
  }

  async listWorkspaceShares(): Promise<{ artifacts: SharedWorkspaceArtifactDto[] }> {
    return this.request({ path: "/api/workspace/shared-with-me", defaultErrorPrefix: "Could not load shared files" });
  }

  async renameWorkspaceArtifact(
    id: string,
    newPath: string,
    opts?: { roomId?: string },
  ): Promise<ArtifactDto> {
    const enc = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    return this.request<ArtifactDto>({
      method: "PATCH",
      path: `/api/workspace/artifacts/${enc}${q}`,
      body: { newPath },
      defaultErrorPrefix: `PATCH /api/workspace/artifacts/${id}`,
    });
  }

  async deleteWorkspaceArtifact(id: string, opts?: { roomId?: string }): Promise<void> {
    const enc = encodeURIComponent(id);
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    await this.request<unknown>({
      method: "DELETE",
      path: `/api/workspace/artifacts/${enc}${q}`,
      defaultErrorPrefix: `DELETE /api/workspace/artifacts/${id}`,
    });
  }

  subscribeWorkspaceArtifactEvents(
    handler: (e: WorkspaceArtifactEvent) => unknown,
    opts?: {
      roomId?: string;
      onOpen?: (reconnected: boolean) => void;
      /**
       * The native EventSource implementation exposes an HTTP status for
       * rejected handshakes. Transport/offline errors intentionally have no
       * status, so callers must not treat them as authentication failure.
       */
      onError?: (error: { status?: number }) => void;
    },
  ): () => void {
    if (typeof EventSource !== "function") {
      throw new ApiError(501, "EventSource not available");
    }
    const token = this.getToken();
    if (!token || token.length === 0) {
      throw new ApiError(401, "Bearer token required");
    }
    let url = `${this.baseUrl}/api/workspace/artifacts/events?token=${encodeURIComponent(token)}`;
    if (opts?.roomId !== undefined && opts.roomId.length > 0) {
      url += `&roomId=${encodeURIComponent(opts.roomId)}`;
    }
    const EventSourceCtor = EventSource as unknown as new (src: string) => EventSource;
    const es = new EventSourceCtor(url);
    let opened = false;
    const onOpen = () => {
      opts?.onOpen?.(opened);
      opened = true;
    };
    const onError = (event: unknown) => {
      const candidate = event as { xhrStatus?: unknown } | null;
      const xhrStatus = candidate?.xhrStatus;
      opts?.onError?.(
        typeof xhrStatus === "number" && Number.isInteger(xhrStatus) && xhrStatus > 0
          ? { status: xhrStatus }
          : {},
      );
    };
    const onChanged = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data)) as {
        id: string;
        artifactId: string;
        path: string;
        clientMutationId?: unknown;
        reloadRequired?: unknown;
      };
      void handler({
        type: "changed",
        id: data.id,
        artifactId: data.artifactId,
        path: data.path,
        ...(typeof data.clientMutationId === "string" && data.clientMutationId.length > 0
          ? { clientMutationId: data.clientMutationId }
          : {}),
        ...(data.reloadRequired === true ? { reloadRequired: true } : {}),
      });
    };
    const onRenamed = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data)) as { id: string; oldPath: string; newPath: string };
      void handler({ type: "renamed", id: data.id, oldPath: data.oldPath, newPath: data.newPath });
    };
    const onDeleted = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data)) as { id: string; artifactId: string };
      void handler({ type: "deleted", id: data.id, artifactId: data.artifactId });
    };
    const onPatchApplied = (ev: MessageEvent) => {
      const data = JSON.parse(String(ev.data)) as Omit<
        Extract<WorkspaceArtifactEvent, { type: "document.patch.applied" }>,
        "type"
      >;
      void handler({
        type: "document.patch.applied",
        target: data.target,
        patchId: data.patchId,
        ...(data.requestId ? { requestId: data.requestId } : {}),
        revision: data.revision,
        sha256: data.sha256,
        previousRevision: data.previousRevision,
        previousSha256: data.previousSha256,
        patch: data.patch,
        author: data.author,
        ...(data.clientMutationId ? { clientMutationId: data.clientMutationId } : {}),
        ...(data.rebased !== undefined ? { rebased: data.rebased } : {}),
      });
    };
    const onDocumentMutationCommitted = (ev: MessageEvent) => {
      // The committed event is the durable coordinator receipt, not an
      // optimistic editor projection. Drop malformed SSE frames rather than
      // letting an untrusted payload take down the EventSource callback.
      try {
        void handler(parseDocumentMutationCommittedEvent(JSON.parse(String(ev.data))));
      } catch {
        // Ignore malformed/unknown frames; a later valid event or the normal
        // artifact reconciliation path restores state.
      }
    };
    // Cast via `addEventListener`'s own parameter type so consumers
    // without DOM lib (e.g. `apps/desktop` typecheck) don't need
    // `EventListener` as a global.
    type SseListener = Parameters<typeof es.addEventListener>[1];
    es.addEventListener("open", onOpen as unknown as SseListener);
    es.addEventListener("error", onError as unknown as SseListener);
    es.addEventListener("changed", onChanged as unknown as SseListener);
    es.addEventListener("renamed", onRenamed as unknown as SseListener);
    es.addEventListener("deleted", onDeleted as unknown as SseListener);
    es.addEventListener("document.patch.applied", onPatchApplied as unknown as SseListener);
    es.addEventListener(
      "document.mutation.committed",
      onDocumentMutationCommitted as unknown as SseListener,
    );
    return () => {
      es.removeEventListener("open", onOpen as unknown as SseListener);
      es.removeEventListener("error", onError as unknown as SseListener);
      es.removeEventListener("changed", onChanged as unknown as SseListener);
      es.removeEventListener("renamed", onRenamed as unknown as SseListener);
      es.removeEventListener("deleted", onDeleted as unknown as SseListener);
      es.removeEventListener("document.patch.applied", onPatchApplied as unknown as SseListener);
      es.removeEventListener(
        "document.mutation.committed",
        onDocumentMutationCommitted as unknown as SseListener,
      );
      es.close();
    };
  }

  /**
   * fetch workspace artifact bytes and persist locally (native
   * save when `nautiloDesktop.dialog.showSaveDialog` +
   * `nautiloDesktop.fs.writeFileBytes` are both bridged; otherwise
   * invisible-anchor download in the browser).
   */
  async downloadArtifact(
    artifactInternalId: string,
    suggestedFilename: string,
    opts?: { roomId?: string },
  ): Promise<void> {
    const blob = await this.getWorkspaceArtifactBytes(artifactInternalId, opts);
    await saveArtifactToDisk(blob, suggestedFilename);
  }

  /**
   * bulk export: zip the given artifacts (by internal id) server-side
   * and save the single archive to disk. One request + one save dialog,
   * instead of N per-file downloads. `ids` are internal artifact row uuids.
   */
  async downloadArtifactsZip(
    ids: string[],
    opts?: { roomId?: string; filename?: string },
  ): Promise<void> {
    const q =
      opts?.roomId !== undefined && opts.roomId.length > 0
        ? `?roomId=${encodeURIComponent(opts.roomId)}`
        : "";
    const res = await this._fetch(`${this.baseUrl}/api/workspace/artifacts/export${q}`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/workspace/artifacts/export failed: ${res.status}`,
      );
    }
    const blob = await res.blob();
    await saveArtifactToDisk(blob, opts?.filename ?? "artifacts.zip");
  }

  // ── Portable Genie profile bundle HTTP client ────────────
  //
  // Self-service surface: the caller can only ever touch their OWN personal
  // agent's profile/avatar. The client never holds a passphrase and never
  // asks the server to decrypt bundle bytes — it forwards the ID-free
  // semantic export, fetches raw avatar media as a Blob, and drives the
  // dry-run → stage → commit gate. The destructive `"source"` commit applies
  // the portable profile + identity and echoes the applied fields in the
  // response (see `ProfileBundleCommitSourceResponse`).

  /**
   * Fetch the caller's own ID-free semantic profile/avatar export. The
   * returned `avatarMedia` (if present) names a `mediaEntry` whose raw bytes
   * are fetched separately via {@link downloadProfileBundleMedia}.
   */
  async exportProfileBundle(): Promise<ProfileBundleExportResponse> {
    return this.request<ProfileBundleExportResponse>({
      method: "GET",
      path: "/api/profile/bundle/export",
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/profile/bundle/export",
    });
  }

  /**
   * Stream the raw avatar media bytes for a `mediaEntry` from the export. The
   * server streams binary (not base64 JSON); this returns a `Blob` so the
   * CLI can hash/pipe it without re-encoding.
   */
  async downloadProfileBundleMedia(mediaEntry: string): Promise<Blob> {
    const res = await this._fetch(
      `${this.baseUrl}/api/profile/bundle/export/media/${encodeURIComponent(mediaEntry)}`,
      { headers: await this.authHeadersFresh() },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/profile/bundle/export/media/${mediaEntry} failed: ${res.status}`,
      );
    }
    return await res.blob();
  }

  /**
   * Submit a dry-run import plan. Binds the bundle's semantic root + the
   * target's current state digest + destination instance + scopes + the
   * explicit whole-profile source|target choice. Returns the plan token
   * (with a TTL) plus detected conflicts; performs NO mutation.
   */
  async planProfileBundleImport(
    input: ProfileBundlePlanRequest,
  ): Promise<ProfileBundlePlanResponse> {
    return this.request<ProfileBundlePlanResponse>({
      method: "POST",
      path: "/api/profile/bundle/import/plan",
      auth: "session-fresh",
      body: input,
      defaultErrorPrefix: "POST /api/profile/bundle/import/plan",
    });
  }

  /**
   * Stage raw avatar bytes for a plan (multipart, streamed server-side). The
   * server verifies the SHA-256 against the plan's `avatarMedia.sha256`
   * before accepting. Pass the exact bytes that produced the export's
   * `avatarMedia.sha256`.
   */
  async stageProfileBundleAvatar(
    input: ProfileBundleStageRequest,
  ): Promise<ProfileBundleStageResponse> {
    const form = new FormData();
    const filename =
      input.bytes instanceof File && input.bytes.name.length > 0
        ? input.bytes.name
        : "avatar.bin";
    form.append("file", input.bytes, filename);
    const res = await this._fetch(
      `${this.baseUrl}/api/profile/bundle/import/stage/${encodeURIComponent(input.mediaEntry)}?planToken=${encodeURIComponent(input.planToken)}`,
      { method: "POST", headers: this.authHeaders(), body: form },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/profile/bundle/import/stage/${input.mediaEntry} failed: ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    return json as ProfileBundleStageResponse;
  }

  /**
   * Final commit gate. Verifies plan freshness (the target's state digest
   * has not moved since dry-run) and commits the plan. The `"target"` choice
   * is a verified no-op; the `"source"` choice applies the portable profile
   * fields + identity and returns the applied name/handle/avatar in the
   * response so the CLI can surface exactly what landed.
   *
   * Supply a stable `idempotencyKey` so a replayed commit returns the same
   * result instead of re-mutating.
   */
  async commitProfileBundleImport(
    input: ProfileBundleCommitRequest,
  ): Promise<ProfileBundleCommitResponse> {
    return this.request<ProfileBundleCommitResponse>({
      method: "POST",
      path: "/api/profile/bundle/import/commit",
      auth: "session-fresh",
      body: input,
      defaultErrorPrefix: "POST /api/profile/bundle/import/commit",
    });
  }

  // ── Private-artifact selection preview and source stream ──
  // target stage. The client drives the server's OPAQUE selection semantics
  // only: it never invents artifact IDs, never uses a path as identity, and
  // never echoes source DB IDs / storage URIs. The preview mints a
  // server-bound `selectionPlanToken` + per-item opaque `selectionToken`s;
  // the source stream is opened by (selectionPlanToken, selectionToken); the
  // target stage is keyed by the bundle's `bytesEntry` opaque id. See
  // `packages/server/src/routes/profile-bundle.ts` for the authoritative
  // contract.

  /**
   * Fetch one COMPLETE page of the caller's eligible private-artifact
   * inventory as opaque selection tokens + logical path/mimeType/size. The
   * server binds the full snapshot (every item, regardless of size — large
   * items are never silently omitted) to the returned `selectionPlanToken`;
   * `limit`/`offset` slice the RESPONSE only. The CLI paginates until
   * `hasMore` is false to surface the complete inventory.
   */
  async previewProfileBundleArtifacts(
    opts?: {
      readonly limit?: number;
      readonly offset?: number;
      /** Re-open an existing caller-bound selection snapshot for pagination or selection. */
      readonly selectionPlanToken?: string;
    },
  ): Promise<ProfileBundleArtifactPreviewResponse> {
    const qs: string[] = [];
    if (opts?.limit !== undefined) qs.push(`limit=${encodeURIComponent(String(opts.limit))}`);
    if (opts?.offset !== undefined) qs.push(`offset=${encodeURIComponent(String(opts.offset))}`);
    if (opts?.selectionPlanToken !== undefined) {
      qs.push(`selectionPlanToken=${encodeURIComponent(opts.selectionPlanToken)}`);
    }
    const query = qs.length > 0 ? `?${qs.join("&")}` : "";
    return this.request<ProfileBundleArtifactPreviewResponse>({
      method: "GET",
      path: `/api/profile/bundle/artifacts/preview${query}`,
      auth: "session-fresh",
      defaultErrorPrefix: "GET /api/profile/bundle/artifacts/preview",
    });
  }

  /**
   * Open a raw byte stream for one selected source artifact, addressed
   * exclusively by its opaque `(selectionPlanToken, selectionToken)` pair —
   * never by path. Returns the streaming `Response` so the CLI can hash/pipe
   * the bytes without re-buffering. The server revalidates private
   * eligibility + observed metadata at open time and fails closed on drift.
   */
  async streamProfileBundleArtifactSource(input: {
    readonly selectionPlanToken: string;
    readonly selectionToken: string;
  }): Promise<Response> {
    const res = await this._fetch(
      `${this.baseUrl}/api/profile/bundle/artifacts/source/${encodeURIComponent(input.selectionToken)}?selectionPlanToken=${encodeURIComponent(input.selectionPlanToken)}`,
      { headers: await this.authHeadersFresh() },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `GET /api/profile/bundle/artifacts/source/${input.selectionToken} failed: ${res.status}`,
      );
    }
    return res;
  }

  /**
   * Stage one artifact's decrypted bytes on the target, addressed by the
   * bundle's opaque `bytesEntry` (`media/artifacts/<opaque-id>.bin`); the
   * `<opaque-id>` segment is the URL `:opaqueId`. The server verifies
   * checksum + size against the plan-bound manifest and writes to a
   * target-local FRESH file identity (never the source identity). Streamed
   * multipart; pass the exact bytes that produced the bundle's sha256.
   */
  async stageProfileBundleArtifact(
    input: ProfileBundleArtifactStageRequest,
  ): Promise<ProfileBundleArtifactStageResponse> {
    const opaqueId = extractArtifactOpaqueId(input.bytesEntry);
    const form = new FormData();
    const filename =
      input.bytes instanceof File && input.bytes.name.length > 0
        ? input.bytes.name
        : `${opaqueId}.bin`;
    form.append("file", input.bytes, filename);
    const res = await this._fetch(
      `${this.baseUrl}/api/profile/bundle/import/stage-artifact/${encodeURIComponent(opaqueId)}?planToken=${encodeURIComponent(input.planToken)}`,
      { method: "POST", headers: this.authHeaders(), body: form },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/profile/bundle/import/stage-artifact/${opaqueId} failed: ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    return json as ProfileBundleArtifactStageResponse;
  }

  /**
   * Stage one artifact's decrypted bytes
   * on the target as a RAW `application/octet-stream` request body, fed
   * from a `ReadableStream<Uint8Array>` or async iterable. The server
   * streams the body straight to the target spool with backpressure while
   * hashing/counting; the client NEVER aggregates a whole artifact into a
   * Blob/Buffer. Pass the exact decrypted bytes that produced the bundle's
   * `sha256` (the deserializer sink feeds them chunk-by-chunk, bounded by
   * the crypto chunk size). Unix socket transport is preserved via
   * {@link NautiloApiClient._fetch}.
   */
  async stageProfileBundleArtifactStream(
    input: ProfileBundleArtifactStageStreamRequest,
  ): Promise<ProfileBundleArtifactStageResponse> {
    const opaqueId = extractArtifactOpaqueId(input.bytesEntry);
    const body = toReadableStream(input.body);
    const res = await this._fetch(
      `${this.baseUrl}/api/profile/bundle/import/stage-artifact/${encodeURIComponent(opaqueId)}?planToken=${encodeURIComponent(input.planToken)}`,
      {
        method: "POST",
        headers: { ...this.authHeaders(), "Content-Type": "application/octet-stream" },
        body,
      },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `POST /api/profile/bundle/import/stage-artifact/${opaqueId} failed: ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    return json as ProfileBundleArtifactStageResponse;
  }

  /**
   * Explicitly clear ALL staged artifact
   * spool bytes + store entries for a plan. Called by the CLI on a
   * terminal manifest / decrypt / chunk error so a half-staged plan does
   * not leave orphan spool bytes. Best-effort: returns even if the server
   * has nothing staged. Unix socket transport is preserved.
   */
  async abortProfileBundleArtifactStaging(input: {
    readonly planToken: string;
  }): Promise<ProfileBundleArtifactStageAbortResponse> {
    const res = await this._fetch(
      `${this.baseUrl}/api/profile/bundle/import/stage-artifact?planToken=${encodeURIComponent(input.planToken)}`,
      { method: "DELETE", headers: this.authHeaders() },
    );
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as { error?: unknown };
      throw new ApiError(
        res.status,
        typeof errJson.error === "string" && errJson.error.length > 0
          ? errJson.error
          : `DELETE /api/profile/bundle/import/stage-artifact failed: ${res.status}`,
      );
    }
    const json: unknown = await res.json();
    return json as ProfileBundleArtifactStageAbortResponse;
  }
}

// ── Portable Genie profile bundle client types ────────────
// Mirror of the server's `/api/profile/bundle/*` contract. ID-free semantic
// records only; never source IDs/auth/credentials. See
// `packages/server/src/routes/profile-bundle.ts` for the authoritative shapes.

export type ProfileBundleWholeProfileChoice = "source" | "target";

export interface ProfileBundleAvatarMedia {
  readonly mediaEntry: string;
  readonly sha256: string;
  readonly mimeType: string;
  readonly size?: number;
}

export interface ProfileBundleExportResponse {
  readonly semanticVersion: { readonly major: number; readonly minor: number };
  readonly bundleId: string;
  readonly scopes: readonly semantic.PortableScope[];
  readonly records: readonly semantic.SemanticRecord[];
  readonly avatarMedia: ProfileBundleAvatarMedia | null;
}

export interface ProfileBundleConflict {
  readonly group: semantic.ProfileConflictGroup;
  readonly choice: ProfileBundleWholeProfileChoice;
}

export interface ProfileBundlePlan {
  readonly planToken: string;
  readonly semanticRoot: string;
  readonly targetStateDigest: string;
  readonly targetAgentId: string;
  readonly destinationInstanceId: string;
  readonly scopes: readonly semantic.PortableScope[];
  readonly wholeProfileChoice: ProfileBundleWholeProfileChoice;
  readonly conflicts: readonly ProfileBundleConflict[];
  readonly avatarMedia: {
    readonly mediaEntry: string;
    readonly sha256: string;
    readonly mimeType: string;
  } | null;
  /**
   * count of `privateMemories` records the bundle carries and
   * the plan will replay on commit. A COUNT ONLY: no memory content, no
   * embeddings, no IDs, no diagnostics ever surface here. Zero when the
   * bundle omits `privateMemories` or the caller did not
   * request the scope. Mirrors the server's `ProfileBundlePlan` exactly.
   */
  readonly privateMemoryCount: number;
  /** Plan-time exact-record replay estimate; commit returns authoritative values. */
  readonly privateMemoryAddedCount: number;
  /** Plan-time exact matches already present in the target namespace. */
  readonly privateMemoryAlreadyPresentCount: number;
  /**
   * count of `privateArtifacts` records the bundle carries and
   * the plan will replay on commit. A COUNT ONLY: no artifact content, no
   * storage URIs, no source DB IDs, no paths ever surface here. Zero when the
   * bundle omits `privateArtifacts` or the caller did
   * not request the scope. Mirrors the server's `ProfileBundlePlan` exactly.
   */
  readonly privateArtifactCount: number;
  /**
   * total logical byte size of the plan's `privateArtifacts`
   * (sum of `size` across entries). A TOTAL ONLY, so the CLI can warn about
   * large transfers without the server omitting any item. Zero when the
   * bundle omits `privateArtifacts` or the scope was not requested.
   */
  readonly privateArtifactBytes: number;
  readonly refused: readonly string[];
  readonly unknown: readonly string[];
  readonly expiresAt: string;
}

export interface ProfileBundlePlanResponse {
  readonly planToken: string;
  readonly plan: ProfileBundlePlan;
}

/** Body for `planProfileBundleImport` — the exported bundle + target choice. */
export interface ProfileBundlePlanRequest {
  readonly bundle: semantic.GenieLiveV1;
  readonly destinationInstanceId: string;
  readonly scopes: readonly semantic.PortableScope[];
  readonly wholeProfileChoice: ProfileBundleWholeProfileChoice;
}

export interface ProfileBundleStageResponse {
  readonly planToken: string;
  readonly mediaEntry: string;
  readonly sha256: string;
  readonly size: number;
  readonly staged: true;
}

/** Body for `stageProfileBundleAvatar` — raw avatar bytes for one media entry. */
export interface ProfileBundleStageRequest {
  readonly planToken: string;
  readonly mediaEntry: string;
  readonly bytes: Blob | File;
}

export interface ProfileBundleCommitTargetResponse {
  readonly planToken: string;
  readonly idempotencyKey: string;
  readonly semanticRoot: string;
  readonly targetStateDigest: string;
  readonly fresh: true;
  readonly committed: true;
  readonly choice: "target";
  readonly privateMemoryAddedCount: 0;
  readonly privateMemoryAlreadyPresentCount: 0;
}

/** `wholeProfileChoice: "source"` commit — destructive apply succeeded. */
export interface ProfileBundleCommitSourceResponse {
  readonly planToken: string;
  readonly idempotencyKey: string;
  readonly semanticRoot: string;
  readonly targetStateDigest: string;
  readonly fresh: true;
  readonly committed: true;
  readonly choice: "source";
  /** Authoritative transaction result: records inserted into target namespace. */
  readonly privateMemoryAddedCount: number;
  /** Authoritative transaction result: exact records skipped as already present. */
  readonly privateMemoryAlreadyPresentCount: number;
  readonly applied: {
    readonly name: string;
    readonly handle: string;
    readonly handleCustomized: boolean;
    readonly avatar: AvatarRef | null;
  };
}

export type ProfileBundleCommitResponse =
  | ProfileBundleCommitTargetResponse
  | ProfileBundleCommitSourceResponse;

/** Body for `commitProfileBundleImport`. */
export interface ProfileBundleCommitRequest {
  readonly planToken: string;
  readonly idempotencyKey: string;
}

// ── Private-artifact preview, source and stage client types ──
// Mirror of the server's `/api/profile/bundle/artifacts/*` +
// `/import/stage-artifact/:opaqueId` contract. Opaque selection semantics
// only: the client never invents artifact IDs and never uses a path as
// identity. See `packages/server/src/routes/profile-bundle.ts`.

/** One eligible private artifact in a preview page, addressed by opaque token. */
export interface ProfileBundleArtifactPreviewItem {
  /** Opaque plan-local selection token; the bundle `bytesEntry` opaque id. */
  readonly selectionToken: string;
  /** Logical artifact path (display only; NEVER used as identity). */
  readonly path: string;
  readonly mimeType: string;
  readonly size: number;
}

/** Paginated response from `GET /api/profile/bundle/artifacts/preview`. */
export interface ProfileBundleArtifactPreviewResponse {
  /** Server-bound snapshot token; pairs with each item's `selectionToken`. */
  readonly selectionPlanToken: string;
  readonly items: readonly ProfileBundleArtifactPreviewItem[];
  /** Total eligible artifact count (full snapshot; never page-sliced). */
  readonly totalCount: number;
  /** Total eligible artifact bytes (full snapshot; large items never omitted). */
  readonly totalBytes: number;
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}

/** Body for `stageProfileBundleArtifact` — decrypted bytes for one artifact. */
export interface ProfileBundleArtifactStageRequest {
  readonly planToken: string;
  /** Bundle `bytesEntry` (`media/artifacts/<opaque-id>.bin`). */
  readonly bytesEntry: string;
  readonly bytes: Blob | File;
}

/**
 * Request body for
 * {@link NautiloApiClient.stageProfileBundleArtifactStream}. Decrypted
 * bytes for one artifact as a streaming body (`ReadableStream` or async
 * iterable of bounded `Uint8Array` chunks); NEVER a Blob / aggregate
 * buffer. The client forwards the stream straight to the server's raw
 * octet-stream stage endpoint.
 */
export interface ProfileBundleArtifactStageStreamRequest {
  readonly planToken: string;
  /** Bundle `bytesEntry` (`media/artifacts/<opaque-id>.bin`). */
  readonly bytesEntry: string;
  readonly body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>;
}

/** Response from `DELETE /api/profile/bundle/import/stage-artifact` (plan cleanup). */
export interface ProfileBundleArtifactStageAbortResponse {
  readonly planToken: string;
  /** Number of staged spool files removed. */
  readonly cleared: number;
  readonly clearedAll: true;
}

/** Response from `POST /api/profile/bundle/import/stage-artifact/:opaqueId`. */
export interface ProfileBundleArtifactStageResponse {
  readonly planToken: string;
  readonly bytesEntry: string;
  /** Fresh target-local external artifact id (never the source identity). */
  readonly artifactId: string;
  readonly sha256: string;
  readonly size: number;
  readonly staged: true;
}

/**
 * Extract the `<opaque-id>` segment from a `media/artifacts/<opaque-id>.bin`
 * bytesEntry. The stage endpoint addresses artifacts by this opaque id (the
 * bundle's selection token), never by source path or DB id. Throws on a
 * malformed bytesEntry so a smuggled non-artifact entry cannot reach the
 * stage route.
 */
export function extractArtifactOpaqueId(bytesEntry: string): string {
  const prefix = "media/artifacts/";
  const suffix = ".bin";
  if (!bytesEntry.startsWith(prefix) || !bytesEntry.endsWith(suffix)) {
    throw new ApiError(0, `invalid artifact bytesEntry: ${bytesEntry}`);
  }
  const opaqueId = bytesEntry.slice(prefix.length, bytesEntry.length - suffix.length);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(opaqueId)) {
    throw new ApiError(0, `invalid artifact opaque id: ${opaqueId}`);
  }
  return opaqueId;
}

/**
 * Normalize a streaming stage body into a
 * pull-based `ReadableStream<Uint8Array>` so the consumer (fetch) drives
 * backpressure: one chunk is pulled from the source at a time, so a whole
 * artifact is NEVER aggregated in memory. A `ReadableStream` is passed
 * through unchanged; an async iterable is wrapped in a `pull`-based stream
 * that yields one bounded chunk per pull.
 */
function toReadableStream(
  body: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  if (body instanceof ReadableStream) {
    return body;
  }
  const iter = body[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      let result: IteratorResult<Uint8Array>;
      try {
        result = await iter.next();
      } catch (e) {
        await iter.return?.(undefined as unknown as undefined).catch(() => {});
        controller.error(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (result.done === true) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(result.value));
    },
    cancel(reason): void {
      void iter.return?.(reason as unknown as undefined);
    },
  });
}

/**
 * shape of a paired relay device as returned by
 * `GET /api/relay/devices`. Mirrors the server's row projection
 * (no `userId` / `actorId` / `tokenHash` — those are server-side
 * details the workbench never needs).
 */
export interface RelayDevice {
  id: string;
  label: string;
  capabilities: Record<string, unknown>;
  /** ISO-8601 UTC timestamp. */
  createdAt: string;
  /** ISO-8601 UTC, or null if the relay never connected with this token. */
  lastSeenAt: string | null;
}

/** Version 2: one caller-owned physical device, never a relay-token row. */
export interface RelayGroupedDevice {
  /** Opaque, user-bound management target; never a raw group/installation/token ID. */
  deviceManagementId: string;
  label: string;
  pairingCount: number;
  firstPairedAt: string;
  lastSeenAt: string | null;
  /** Bounded display-only values. */
  profiles: string[];
  /** Bounded boolean capability names, never arbitrary capability values. */
  capabilities: string[];
}

export interface RelayHistoricalPairingsSummary {
  pairingCount: number;
  oldestPairedAt: string | null;
  latestSeenAt: string | null;
}

export interface RelayDeviceListResponse {
  contractVersion: 2;
  devices: RelayGroupedDevice[];
  historical: RelayHistoricalPairingsSummary;
}

export interface RelayDeviceDetailResponse {
  contractVersion: 2;
  device: RelayGroupedDevice;
}

export interface RelayDeviceMutationResult {
  affectedPairingCount: number;
  auditRecorded: boolean;
}

import {createProductionProtectedReflectionSemantics} from "./reflection/protected-semantic-composition";
import {createProductionProtectedReflectionSearchComposition} from "./reflection/protected-search-composition";
import type {DurableSleepSemanticPort} from "@nautilo/reflection/durable";
import {createProductionReflectionAuthorityMaintenance} from "./reflection/protected-authority-composition";
import { bindEncryptionDataOperationOwner } from "@nautilo/lattice-bridge";
import { bindReflectionSemanticDataOperationPort, resolveReflectionSemanticStageAdmission, createPostgresStenographerAuthorizationWaitPort, createStenographerDataOperationPort, createStenographerCandidateDataOperationPort, readPostgresReflectionAuthorityStatus, readPostgresStenographerProtectionStatus, verifyCryptoPostgresHandle, type StenographerIntentAdapter } from "@nautilo/lattice-bridge/server";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {decodeBackgroundProcessorWorkDescriptorV2} from "@nautilo/lattice-crypto/background";
import { createHmacProtectedStenographerRecordCommitmentPort, createHmacRecordSemanticCommitmentPort, verifyRecordProductPostgresHandle } from "@nautilo/reflection-bridge/server";
import { createProductionProtectedStenographerComposition } from "./background/stenographer-composition";
import { createEventFeed } from "@nautilo/event-feed";
import type { ServerEvent } from "@nautilo/types";
import { createEventFeedStorage, createEventFeedPreferenceStore, listArtifactFeedRecipientUserIds } from "@nautilo/db";
import { eventFeedRoutes } from "./routes/event-feed";
import { eventFeedPreferenceRoutes } from "./routes/event-feed-preferences";
import { publishEventFeedChanged } from "./realtime/ws-publisher";
import { createHumanMembershipEventProducer } from "./event-feed/membership-producer";
import { createArtifactEventProducer } from "./event-feed/artifact-producer";
import { createArtifactFeedInvalidator } from "./event-feed/artifact-invalidation";
import { resolveArtifactFeedAuthor, resolveArtifactFeedPeople, resolveArtifactCreationRoom,
  resolveArtifactFeedActorNames } from "./event-feed/artifact-identities";
import { setWorkspaceArtifactCreatedSink } from "@nautilo/agent";
import { createServerMemoryReviewRuntime } from "./lib/memory-review-runtime";
import { memoryStatusRoutes } from "./routes/memory-status";
import {
  createForegroundMemoryEffectRecovery,
  createPostgresForegroundMemoryEffectRecoveryStore,
  installForegroundMemoryEffectRecoveryLifecycle,
} from "./routes/foreground-memory-effect-recovery";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { error as logError, log, warn, runWithTurn } from "@nautilo/logger";
import { ConfigGuardError, isCloudManagedDeployment } from "@nautilo/config-guard";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticFiles from "@fastify/static";
import websocket from "@fastify/websocket";
import { type StreamEntry, multistream, destination } from "pino";
import { liveDocumentVersionEquals } from "@nautilo/types";
import type {
  PolicyResolver,
  RuntimePolicyContext,
  MemoryAccessEnvelope,
  CanonicalPrincipal,
  RbacProjection,
} from "@nautilo/trust";
// `getBootstrapOwnerId` is consumed exactly once below
// at `createApp` boot to seed operator-only routes (ownerRoutes,
// invitesRoutes mint flow, jobManager background-job attribution,
// healthRoutes operator hints, profile-route owner detection). It is
// NOT read on the request hot path; the lint rule's carve-out
// allows this single createApp-level use. New per-request callers
// must derive `ownerId` from `request.sessionUserId` or
// `request.memoryEnvelope?.ownerId`, never from this getter.
import { findRoomForUserMember } from "@nautilo/trust";
// eslint-disable-next-line no-restricted-imports
import { getBootstrapOwnerId, getBootstrapOwnerActorId, isUuidString } from "@nautilo/trust";
import {
  PinChallengeProvider,
  buildGuestToolPolicy,
  getUserCapabilities,
  listHumanUserIdsInRoom,
} from "@nautilo/trust";
import { bearerResolutionDepthForRoute } from "./auth/bearer-resolution-depth";
import { buildResolveBearer, isResolveBearerPolicyOk } from "./auth/resolve-bearer";

const serverSrcDir = dirname(fileURLToPath(import.meta.url));
import { replyForConfigGuardError } from "./lib/config-guard-http";
import { decodeCanonicalBase64url } from "./lib/canonical-base64url";
import { forwardWorkspaceArtifactBusEvent } from "./lib/workspace-artifact-bus-event";
import { renderWorkbenchNotServedPage } from "./friendly-errors/workbench-not-served";
import {
  renderMobileWebNotServedPage,
  type MobileWebNotServedReason,
} from "./friendly-errors/mobile-web-not-served";
import { healthRoutes, markReady } from "./routes/health";
import { publicJoinRoutes } from "./routes/public-join";
import { wsRoutes } from "./routes/ws";
import { chatRoutes, defaultChatRoutesDeps, type ChatRoutesDeps } from "./routes/chat";
import {
  installAgentRedirectCompletionHandler,
  uninstallAgentRedirectCompletionHandler,
} from "./messaging/agent-redirect-handler";
import { roomsRoutes } from "./routes/rooms";
import { humanBlockRoutes } from "./routes/human-blocks";
import { contentReportRoutes } from "./routes/content-reports";
import { mobileUserAgreementRoutes } from "./routes/mobile-user-agreement";
import { liveShadowMessageRoutes } from "./routes/live-shadow-message";
import { foregroundPendingAttentionRoutes } from "./routes/foreground-pending-attention";
import { registerProductionDomainKeyAuthority } from "./routes/domain-key-authority";
import {
  createProductionLiveShadowMessageComposition,
  installProductionLiveShadowMessageComposition,
  uninstallProductionLiveShadowMessageComposition,
} from "./routes/live-shadow-message-composition";
import { messagesReadStateRoutes } from "./routes/messages-readstate";
import { modelControlSelectionRoutes } from "./routes/model-control-selections";
import { notificationPreferenceRoutes } from "./routes/notification-preferences";
import { pushNotificationRoutes } from "./routes/push-notifications";
import { usersPresenceRoutes } from "./routes/users-presence";
import { usersAvatarRoutes } from "./routes/users-avatar";
import { scheduleLastSeenBump } from "./preHandlers/schedule-last-seen";
import { agentMembersRoutes } from "./routes/agent-members";
import { groupMembersRoutes } from "./routes/group-members";
import { adminRoomsRoutes } from "./routes/admin-rooms";
import { adminUsersRoutes } from "./routes/admin-users";
import { accessControlReadRoutes } from "./routes/access-control-read";
import { accessControlMutationRoutes } from "./routes/access-control-mutations";
import { costsRoutes } from "./routes/costs";
import { stenographerStatusRoutes } from "./routes/stenographer-status";
import { reflectionStatusRoutes } from "./routes/reflection-status";
import { invokeDirectRoutes } from "./routes/invoke-direct";
import { jobRoutes } from "./routes/jobs";
import { operatorMaintenanceRoutes, withMaintenanceStatusPublishing } from "./routes/operator-release";
import { tasksRoutes } from "./routes/tasks";
import { profileRoutes } from "./routes/profile";
import { profileAvatarRoutes } from "./routes/profile-avatar";
import { agentPhotoLibraryRoutes } from "./routes/agent-photo-library";
import { backfillLegacyCurrentPhotoReferences } from "./photo-library/legacy-current-reference-backfill";
import { backfillLegacyManageAvatarHistory } from "./photo-library/legacy-manage-avatar-history-backfill";
import { profileBundleRoutes } from "./routes/profile-bundle";
import { memoryRoutes } from "./routes/memory";
import type { ProtectedMemoryRouteComposition } from "./routes/protected-memory-composition";
import { createProductionHumanMemoryRouteFactory } from "./routes/human-memory-live-composition";
import { registerHumanMemoryReadObservationRoutes } from "./routes/human-memory-read-observations";
import { skillsRoutes } from "./routes/skills";
import { commandsRoutes } from "./routes/commands";
import { workspaceArtifactsRoutes } from "./routes/workspace-artifacts";
import { contentAccessRoutes } from "./routes/content-access";
import { ordinaryContentAccessRecoveryRoutes } from "./routes/ordinary-content-access-recovery";
import { taskContentAccessRecoveryRoutes } from "./routes/task-content-access-recovery";
import { createServerContentAccessRuntime } from "./content-access/runtime";
import { createAgentContentAccessForState } from "./content-access/agent";
import { slideTemplateRoutes } from "./routes/slide-templates";
import { mediaGenerationsRoutes } from "./routes/media-generations";
import { videoGenerationRoutes } from "./video-generation/routes";
import {
  requestWorkspaceDocumentMutationOutboxPump,
  startWorkspaceDocumentMutationOutboxRuntime,
} from "./document-mutations/workspace-document-mutation-runtime";
import {
  startPushDeliveryRuntime,
  stopPushDeliveryRuntime,
} from "./push/push-delivery-runtime";
import {
  createWorkspaceFileContentCommitExecution,
  createWorkspaceFileContentRecoveryExecution,
} from "./document-mutations/workspace-file-content-coordinator-adapter";
import { createWorkspaceFileStructuralMutationExecution } from "./document-mutations/workspace-file-structural-coordinator-adapter";
import { createWorkspaceCanonicalHistoryRestoreExecution } from "./document-mutations/workspace-canonical-history-restore-adapter";
import { createWorkspaceCanonicalUndoTurnExecution } from "./document-mutations/workspace-canonical-undo-turn-adapter";
import { createWorkspaceOfficeCliCommitExecution } from "./document-mutations/workspace-officecli-coordinator-adapter";
import { workspaceDocumentMutationLockManager } from "./document-mutations/workspace-document-mutation-lock-manager";
import { wopiRoutes } from "./routes/wopi";
import { officeProxyRoutes } from "./routes/office-proxy";
import { messageAttachmentRoutes } from "./routes/message-attachments";
import { configRoutes } from "./routes/config";
import { connectionRoutes } from "./routes/connections";
import { connectedWebAccountRoutes } from "./routes/connected-web-accounts";
import { connectedWebOperationRoutes } from "./routes/connected-web-operations";
import { codexConnectionRoutes } from "./routes/codex";
import { claudeConnectionsRoutes } from "./routes/claude-connections";
import { codexRequestsRoutes } from "./routes/codex-requests";
import { acpReadinessRoutes } from "./acp/routes";
import { createHermesAcpHarnessTask } from "./acp/harness-task";
import { createHermesAcpTaskExecutionRouteRegistration } from "./acp/task-execution-composition";
import { createOpenCodeAcpTaskExecutionRouteRegistration } from "./acp/opencode-task-execution-composition";
import { CodexAdminControlPlane } from "./codex/admin-control-plane";
import { CodexExecutionAdmissionFactory } from "./codex/admission-factory";
import { CodexAuthorityService } from "./codex/authority";
import {
  CodexCanonicalFactsService,
  createCodexCanonicalFactsReader,
} from "./codex/canonical-facts";
import { CodexBindingSessionService, createCodexTaskBindingLookup } from "./codex/binding-session";
import { CodexHarnessExecution } from "./codex/harness-execution";
import {
  createCodexHarnessControlPlane,
  createCodexTaskHarnessExecutionRouteRegistration,
} from "./codex/harness-composition";
import {
  CodexHarnessPreferenceStore,
  createCodexTaskExecutionRouteReader,
  createCodexTaskExecutionRouteSelector,
} from "./codex/harness-admission";
import {
  createTaskHarnessExecutionRouteSelector,
} from "./harness/task-execution-route";
import { createTaskHarnessExecutionRouteStore } from "./harness/task-execution-route-store";
import {
  createCodexHarnessTask,
  listCodexHarnessModels,
} from "./codex/harness-task";
import { steerCodexHarnessTask } from "./codex/harness-task-control";
import { CodexPersistenceAdapter } from "./codex/persistence";
import { CodexRoomOutputProjector } from "./codex/room-output";
import {
  CodexTaskRunLifecycleAdapter,
  CodexUnavailableRequestTerminalizer,
  createCodexTaskRunReportBack,
  createCodexTaskRunLifecycleReader,
  createCodexTaskRunLifecycleWriter,
} from "./codex/task-run-lifecycle";
import { CodexTurnEventBroker } from "./codex/turn-event-broker";
import { CodexRequestBroker } from "./codex/request-broker";
import { CodexExecutionPreflight } from "./codex/execution-preflight";
import { CodexProfileRemovalTurnCoordinator } from "./codex/profile-removal-turn-coordinator";
import { ClaudeConnectionController } from "./claude/connection-controller";
import { ClaudeHarnessExecution } from "./claude/harness-execution";
import { createClaudeHarnessTask } from "./claude/harness-task";
import { steerClaudeHarnessTask } from "./claude/harness-task-control";
import {
  createClaudeTaskExecutionRouteSelector,
  createClaudeTaskHarnessExecutionRouteRegistration,
  parseClaudeTaskExecutionMetadata,
} from "./claude/task-execution-route";
import { CODEX_REVIEWED_RUNTIME_ARTIFACT_REF } from "@nautilo/relay";
import {
  archiveCodexProfileBindingsForRemovalWith,
  beginCodexProfileRemovalWith,
  claimCodexUserInputRequestDispatchWith,
  createCodexUserInputRequestWith,
  finalizeCodexProfileRemovalWith,
  getServerContextConfig,
  getCodexUserInputRequestWith,
  getTaskById,
  getTaskRuns,
  recordTaskWriterReviewAcceptedReceipt,
  reserveTaskWriterReviewWorkspaceOperation,
  releaseTaskWriterReviewWorkspaceOperation,
  getJobById,
  getCodexProfileWith,
  getCodexUserPreferenceWith,
  insertCodexProfileWith,
  listCodexProfileRemovalTaskBindingWorkWith,
  listCodexProfilesWith,
  listCodexUserInputRequestsForRoomWith,
  markCodexUserInputRequestSubmittedWith,
  markCodexUserInputRequestUnavailableWith,
  renameCodexProfileWith,
  registerCodexProfileFromOfficialAccountWith,
  settleCodexUserInputRequestWith,
  updateCodexProfileUsageSnapshotWith,
  updateCodexProfileStatusWith,
  upsertCodexUserPreferenceWith,
  getOrCreateClaudeConnectionWith,
  saveClaudeConnectionObservationWith,
  selectClaudeConnectionModelWith,
  setClaudeConnectionEnabledWith,
} from "@nautilo/db";
import { connectionProxyRoutes, dispatchConnectionProxy } from "./routes/connection-proxy";
import { explainerMediaRoutes } from "./routes/explainer-media";
import { setupRoutes } from "./routes/setup";
import { setupStatusRoutes } from "./routes/setup-status";
import { serverIconRoutes } from "./routes/server-icon";
import { serverModelsRoutes } from "./routes/server-models";
import { serverContextRoutes } from "./routes/server-context";
import { encryptionTransitionRoutes } from "./routes/encryption-transition";
import { personalEncryptionCoverageRoutes } from "./routes/personal-encryption-coverage";
import { messageBackfillRoutes } from "./routes/message-backfill";
import { deviceAdmissionRoutes } from "./routes/device-admission";
import { backgroundAuthorizationRoutes } from "./routes/background-authorization";
import { createProductionBackgroundAuthorizationComposition } from "./routes/background-authorization-composition";
import { createProductionDeviceAdmissionComposition } from
  "./routes/device-admission-composition";
import {
  cryptoDeviceAdmissionRequiredError,
  preAdmissionRouteKind,
  resolveCurrentDeviceAdmission,
  type CurrentDeviceAdmission,
} from "./auth/device-admission-gate";
import {
  createProductionInitialDeviceReadinessComposition,
  protectedInitialDeviceReadinessRoutes,
} from "./routes/protected-initial-device-readiness";
import { humanDeviceMembershipRoutes } from
  "./routes/human-device-membership";
import { createProductionHumanDeviceMembershipComposition } from
  "./routes/human-device-membership-composition";
import { ReflectionSleepController } from "./reflection/reflection-sleep-controller";
import { mcpServersRoutes } from "./routes/mcp-servers";
import { createLocalMcpToolRuntime } from "./mcp/local-mcp-service";
import { setLocalMcpInstallRelaySocketSafetyCloser } from "./mcp/local-mcp-install-service";
import { integrationsGoogleRoutes } from "./routes/integrations-google";
import { connectedAppsRoutes } from "./routes/connected-apps";
import {
  BUNDLED_CONNECTION_PROVIDER_CATALOG,
  loadConnectionProviderCatalog,
  type ResolvedConnectionProviderCatalog,
} from "./connected-apps/catalog";
import { OomolHostedConnectedAppDriver } from "./connected-apps/hosted-driver";
import { OpenConnectorLocalConnectedAppDriver } from "./connected-apps/local-driver";
import { openWorkspaceArtifactInput } from "./connected-apps/artifact-input";
import { ConnectedAppService, type ConnectedAppStore } from "./connected-apps/service";
import { connectedAppProviderDefinitions } from "./connected-apps/providers";
import {
  ConnectedAppResultPresenter,
  deriveConnectedAppPreviewKey,
} from "./connected-apps/result-presentation";
import { appRoutes, type LiveReviewLifecyclePort } from "./apps/app-routes";
import { LiveLocalDocumentAuthority } from "./apps/live-local-document-authority";
import { createLiveArtifactProposalAcceptance } from
  "./apps/live-artifact-proposal-acceptance";
import {
  DEFAULT_HUMAN_EDIT_LEASE_TTL_MS,
  HumanEditLeaseRegistry,
} from "@nautilo/document-mutations";
import { humanEditLeaseRoutes } from "./routes/human-edit-leases";
import {
  resolveWorkspaceHumanEditLeaseTarget,
} from "./document-mutations/human-edit-lease-targets";
import { liveMiniAppSessionRegistry } from "./apps/live-mini-app-session-registry";
import {
  getLiveAppSessionExtension,
  getLiveTaskDelegationToolIds,
} from "./apps/live-review-extension-registry";
import { generateMiniAppAgentToolName } from "./apps/app-manifest";
import { seedFirstPartyApps } from "./apps/seed-first-party-apps";
import {
  createLiveAppToolRegistrationOptions,
  registerInstalledAppTools,
} from "./apps/app-tool-registration";
import { createMiniAppToolRuntime } from "./apps/mini-app-tool-runtime";
import { getToolCatalog } from "@nautilo/catalog";
import { startMcpHost } from "./mcp/mcp-host";
import { setMcpClientManager } from "./mcp/mcp-manager-singleton";
import { serverProfileRoutes } from "./routes/server-profile";
import { voiceRoutes, type VoiceRouteDeps } from "./routes/voices";
import { sttRoutes } from "./routes/stt";
import { sessionRoutes } from "./routes/sessions";
import { authRoutes } from "./routes/auth";
import { accountRoutes } from "./routes/account";
import { logtoInternalRoutes } from "./routes/logto-internal";
import {
  securityRoutes,
  UncontainedHostCommandsController,
} from "./routes/security";
import { createPostureMutator } from "./lib/posture-mutator";
import { readPostureSidecar } from "./lib/posture-sidecar";
import {
  acceptsRequestedRoomIdFromUrl,
  extractChatRequestedRoomId,
  extractRequestedRoomIdFromUrl,
} from "./lib/chat-requested-room-id";
import {
  writeSecurityAuditEvent,
  type ConnectionVaultToolAuditEvent,
} from "./lib/security-audit-log";
import { ownerRoutes } from "./routes/owner";
import { pairRoutes } from "./routes/pair";
import { testModeRoutes, resolveTestToken } from "./routes/test-mode";
import { installTestModeRelayFixture } from "./lib/test-mode-relay-fixture";
import { TEST_MODE_RELAY_USER_ID } from "./lib/test-mode-relay-credential";
import { webfingerRoutes, logFederationReadinessWarning } from "./routes/webfinger";
import { startEventBridge } from "./realtime/event-bridge";
import { getTtsService } from "./realtime/tts-service";
import { invitesRoutes } from "./routes/invites";
import {
  createRelayPairingGenerationInvalidator,
  createRelayGenerationInvalidator,
  relayRoutes,
} from "./realtime/relay-endpoint";
import { closeLiveMiniAppSessionsForRelay } from "./realtime/live-mini-app-session-close";
import { relayHttpRoutes } from "./routes/relay";
import { remoteControlRoutes } from "./routes/remote-control";
import { RemoteHostPresenceStream } from "./remote-control/host-presence-stream";
import { projectRemoteHosts } from "./remote-control/host-projection";
import { getRemotePairingStore } from "./remote-control/pairing-store";
import { requirePairingPepper } from "./remote-control/pairing-secrets";
import { createOrdinaryHostResolver } from "./remote-control/ordinary-host-resolver";
import {
  createComputerUsePostModelAdmissionResolvers,
} from "./remote-control/computer-use-admission";
import { createComputerUseAgentOwnershipAuthorizer } from "./remote-control/computer-use-agent-ownership";
import {
  createRelayRegistryBindingProvider,
  createRelayRegistryProfileActivationProvider,
  resolveActiveWorkstationDispatchBinding,
  createWorkstationApprovalOverrideResolver,
  workstationAccessRoutes,
} from "./routes/workstation-access";
import {
  broadcast,
  buildMaintenanceStatusEvent,
  publishRemoteHostPresenceFrame,
  publishDomainKeyCatchUpRequested,
  publishMaintenanceStatus,
  publishEncryptionPolicyChanged,
  convergeHumanRoomCatalogs,
  flushPendingWebSocketBroadcasts,
} from "./realtime/ws-publisher";
import { getServerDirectDb } from "./lib/server-direct-db";
import {
  currentStrictShadowPolicy,
  enforceRegisteredStrictShadowBoundary,
  installStrictShadowPlaintextRouteGate,
} from
  "./lib/strict-shadow-policy";
import { createConnectedWebAccountStore } from "./connected-web-accounts/store";
import { ConnectedWebAccountController } from "./connected-web-accounts/controller";
import { browserUseCdpNavigator } from "./connected-web-accounts/cdp-navigator";
import { BrowserUseCloudAdapter } from "./browser-use/browser-use-cloud";
import { ConnectedWebOperationSecrets } from "./connected-web-accounts/operation-secrets";
import { createConnectedWebOperationLiveRuntime } from "./connected-web-accounts/operation-live-runtime";
import { createConnectedWebOperationDirectProductionRuntime } from "./connected-web-accounts/operation-direct-production";
import { ConnectedWebOperationOwnerController } from "./connected-web-accounts/operation-owner-controller";
import { createConnectedWebAccountActionProductionRuntime, createConnectedWebAccountReadProductionRuntime } from "./connected-web-accounts/read-tool-runtime-composition";
import { startAgentPhotoLibraryReservationRecovery } from "./lib/agent-photo-library-production";
import { startAccountDeletionPhotoCleanupRecovery } from "./lib/user-account-deletion";
import { createOfficeSessionBroker } from "./lib/office-session-broker";
import {
  buildWorkbenchAssetsStaticOptions,
  buildWorkbenchSpaFallbackSendFileOptions,
  buildWorkbenchSpaRootStaticOptions,
  isWorkbenchAssetRequest,
} from "./lib/workbench-static-cache";
import {
  buildMobileWebAssetsStaticOptions,
  buildMobileWebFallbackSendFileOptions,
  inspectMobileWebExport,
  isMobileWebAssetRequest,
  isMobileWebTraversalAttempt,
  MOBILE_WEB_NAVIGATION_CACHE_CONTROL,
  pathnameWithoutQuery,
} from "./lib/mobile-web-static-cache";
import { buildMobileWebSecurityHeaders } from "./lib/mobile-web-security-headers";
import { routeSkipsTrustPreHandler } from "./trust-bypass-routes";
import {
  finalizeHandlerPhase,
  getActiveRequestTelemetry,
  markHandlerPhaseStart,
  runWithNewRequestTelemetry,
  shouldSkipRequestTelemetry,
} from "./telemetry/request-telemetry";
import {
  formatServerTimingHeader,
  isValidServerTimingHeader,
} from "./telemetry/server-timing";
import { bindRuntimeStatementObserverToRequestTelemetry } from "./telemetry/runtime-db-observer";
import {
  eventBus,
  installDurableToolResultLifecycleObserver,
  installForegroundTurnLifecycleObserver,
  InMemoryRelayRegistry,
  InMemoryWorkstationSessionRegistry,
  InMemoryWorkstationDispatchPlanRegistry,
  jobManager,
  TaskObserver,
  getTaskObserver,
  setTaskObserver,
  setTaskRunJobManager,
  createTask as runtimeCreateTask,
  createAgentTurnTaskCreationProvenance,
  getPlaintextTaskCreationAdmission,
  clearTaskReturnBindings,
  advanceTaskLiveMiniAppBindingDocumentVersion,
  claimTaskWriterReviewAcceptance,
  failTaskWriterReviewAcceptedContinuation,
  failTaskWriterReviewsForSession,
  finalizeTaskWriterReviewResolution,
  isPendingTaskWriterReviewProposal,
  pendingTaskWriterReviewFinalizations,
  taskWriterReviewProposalState,
  LIVE_MINI_APP_TASK_DELEGATION_METADATA_KEY,
  releaseTaskWriterReviewAcceptanceClaim,
  registerTaskReturnBinding,
  taskReturnBindingRegistrationFailure,
  registerTaskLiveMiniAppBinding,
  resolveTaskLiveMiniAppBinding,
  resolveTaskWriterReviewProposal,
  removeTaskReturnBinding,
  removeTaskReturnBindingsForRelay,
  computeNextFireAt as runtimeComputeNextFireAt,
  pauseTask as runtimePauseTask,
  unpauseTask as runtimeUnpauseTask,
  canResumeSecurityResearchContextFailure,
  stopTask as runtimeStopTask,
  setMaintenanceGate,
  ProductionMaintenanceGate,
  MaintenanceController,
  StenographerWorker,
  candidateRoomIds, historicalCandidateRoomIds, compactionCandidateRooms, initializeHistoricalBackfills,
  createOrdinaryStenographerIntentAdapter,
  createLiveShadowDataOperationPolicyBinding,
  createNativeStenographerExtractionPublisher,
  createProductionReflectionMemoryRuntime,
  disabledReflectionSemanticSchedulerStatus,
  REFLECTION_SEMANTIC_RUNTIME_POLICY_V1,
  installForegroundRecordContextPortFactory,
  installForegroundRecordRecallPortFactory,
  uninstallForegroundRecordContextPortFactory,
  uninstallForegroundRecordRecallPortFactory,
  resolveReflectionModelId,
  resolveStenographerModelId,
  type WorkstationAccessAuditEvent,
  type WorkstationAdmissionAuditEvent,
  type OrdinaryStenographerIntentAdapterOptions,
  type TaskWriterReviewBinding,
  hasTaskWriterReviewBindingForTaskRun,
} from "@nautilo/runtime";
import {
  resolveCurrentRecordRepositorySelection,
  resolveCurrentReflectionCommitmentKey,
} from "./reflection/record-repository-selection";
import {
  ClientActionBindingRegistry,
  installClientActionBindingRegistry,
} from "./realtime/client-action-binding-registry";
import { publishDurableGuideUserClientAction } from "./realtime/client-action-publisher";
import {
  setRelayRegistry,
  setOrdinaryHostResolver,
  setWorkstationDispatchPlanRegistry,
  setAgentEventSink,
  setWorkspaceArtifactEventSink,
  setArtifactStorage,
  setOfficeSessionBroker,
  setBackupStorage,
  setConnectionVaultBackend,
  setConnectionVaultAuditSink,
  setConnectionProxyDispatcher,
  setRevisionEventSink,
  startBackupGcScheduler,
  stopBackupGcScheduler,
  setTaskToolRuntime,
  getTaskCreationReturnContext,
  getTaskCreationLiveMiniAppContext,
  getTaskCreationBackgroundTaskProvenance,
  getTaskCreationInvocationProvenance,
  setMiniAppToolRuntime,
  setLocalMcpToolRuntime,
  setConnectedAppActionRuntime,
  syncConnectedAppOperationTools,
  createWorkspaceBinaryArtifactFromStream,
  setLiveReviewWriteGuard,
  LiveReviewTargetResolutionError,
  defaultPostModelDeps,
  setWorkspaceFileContentCommitExecution,
  setWorkspaceFileContentRecoveryExecution,
  setWorkspaceCanonicalHistoryRestoreExecution,
  setWorkspaceCanonicalUndoTurnExecution,
  setWorkspaceFileStructuralMutationExecution,
  setWorkspaceOfficeCliCommitExecution,
  setConnectedWebAccountReadToolRuntime,
  setConnectedWebAccountActionToolRuntime,
  installAuthoredMemorySemanticChangeSink,
  resolveModelExecutionLimits,
} from "@nautilo/agent";
import {
  BuiltinVaultBackend,
  BunOrPinVaultMasterPersistence,
  clearRegisteredSecretsForRedaction,
  resolveVaultEncryptedFilePath,
} from "@nautilo/vault";
import {
  hasAdminUser,
  hasUnredeemedClaimInvite,
  materializeDefaultServerProfileOnce,
  refreshServerModelConfigCache,
  getCachedServerModelConfigRow,
  kickServerModelConfigRefresh,
  countAcceptedWorkWith,
  countActiveTaskWorkWith,
  listStoppableTasksForOwnerRoom,
  queryStenographerAdminStatus,
  queryReflectionAdminStatus,
  getAccountSecurityRowByUserId,
  getEncryptionTransitionPolicy,
  createPostgresJsBridgeConnection, getSharedDirectCryptoDb, rooms, roomMembers, and, actors, inArray, isNull,
  getConnectedAppProfile,
  upsertConnectedAppProfile,
  markConnectedAppUserProfilesState,
  deleteConnectedAppProfile,
  getConnectedAppProviderConfig,
  upsertConnectedAppProviderConfig,
  findActiveConnectedAppOauthAttempt,
  expireStaleConnectedAppOauthAttempts,
  insertConnectedAppOauthAttempt,
  getConnectedAppOauthAttempt,
  finishConnectedAppOauthAttempt,
  eq,
  nautiloInstanceIdentity,
} from "@nautilo/db";
import {
  passwordChangeRequiredError,
  restrictedPasswordChangeRouteAllowed,
} from "./auth/password-change-gate";
import {
  createStorageZones,
  ensureDirectoryTree,
  fromRuntimeConfig,
  getAppsRoot,
  getServerHostname,
  parseNautiloInstanceId,
  resolveNautiloRuntimePaths,
  type StorageZones,
} from "@nautilo/config";

//  server-owned spend policy and provider poll cadence. Browser Use V4
// runs are long-lived jobs: they end at a provider terminal state, the spend
// cap, or an explicit Human Stop rather than an invented wall-clock cutoff.
const CONNECTED_WEB_ACCOUNT_READ_MAX_COST_USD = 2;
const CONNECTED_WEB_ACCOUNT_READ_POLL_INTERVAL_MS = 2_000;
const CONNECTED_WEB_ACCOUNT_ACTION_MAX_COST_USD = 2;
const CONNECTED_WEB_ACCOUNT_ACTION_POLL_INTERVAL_MS = 2_000;

// Fastify type augmentation for trust context
declare module "fastify" {
  interface FastifyRequest {
    policyContext: RuntimePolicyContext | null;
    memoryEnvelope: MemoryAccessEnvelope | null;
    sessionActorId: string | null;
    sessionUserId: string | null;
    accessTokenIssuedAt: number | null;
    accessTokenExpiresAt: number | null;
    cryptoDeviceAdmission: CurrentDeviceAdmission | null;
    /** canonical identity from bearer resolution when authenticated. */
    resolvedPrincipal: CanonicalPrincipal | null;
    /** server-wide RBAC projection when depth is `rbac` or `policy`. */
    rbacProjection: RbacProjection | null;
  }
  interface FastifyInstance {
    /**
     * Full four-zone storage bundle. Decorated at boot so any
     * route can grab a provider without re-reading runtime paths.
     * Relay-facing wiring should narrow via `toRelayStorageZones`.
     */
    storageZones: StorageZones;
    /**  process-local human editor presence; never document authority. */
    humanEditLeaseRegistry: HumanEditLeaseRegistry;
  }
}

export interface CreateAppOptions {
  /** Suppress Fastify request logging for quiet or embedded callers. */
  silent?: boolean | undefined;
  /** Override the durable security-audit sink for isolated integration tests. */
  securityAuditLogPath?: string | undefined;
  /**
   * Persist the write-once default server profile during app construction.
   * Defaults to false so reusable `createApp()` fixtures are side-effect free;
   * the real server binary opts in for ordinary boots.
   */
  materializeServerProfileAtBoot?: boolean | undefined;
  /** Enables the opt-in Claude Code ordinary-Task composition. */
  enableClaudeCodeTasks?: boolean | undefined;
  /** Recover only database-proven legacy photo ownership before serving. */
  backfillOwnedPhotoLibraryAtBoot?: boolean | undefined;
  /** Development-only DB-less smoke harness; ordinary app composition remains the default. */
  testModeOnly?: boolean | undefined;
  /** Trust layer PolicyResolver. When provided, every request resolves
   *  actor context and memory envelope. */
  policyResolver?: PolicyResolver | undefined;
  /**
   * Owner actor ID (from trust seed). Required for auth / PIN subject.
   * If omitted, `createApp` falls back to the bootstrap-state-cache
   * value populated by
   * `bin/nautilo-server` after `seedTrustPersonal`. Tests inject
   * this option explicitly.
   */
  ownerActorId?: string | undefined;
  /** Owner user ID — fallback comes from the bootstrap-state-cache
   *  populated by `bin/nautilo-server` after `findClaimedOwnerId`. */
  ownerId?: string | undefined;
  /** TLS key + cert for HTTPS. When provided, Fastify starts with HTTPS. */
  https?: { key: Buffer; cert: Buffer } | undefined;
  /** Path to certs directory (for pairing routes to serve CA cert). */
  certsDir?: string | undefined;
  /** Friendly hostname (for pairing page URLs). */
  hostname?: string | undefined;
  /** Server port (for pairing page URLs). */
  port?: number | undefined;
  /** Custom PinChallengeProvider (for testing with short lockouts). */
  pinProvider?: PinChallengeProvider | undefined;
  /** override chat route deps (e.g. stub `createForegroundJob` in integration tests). */
  chatRoutesDeps?: Partial<ChatRoutesDeps> | undefined;
  /**  dormant direct-source test composition; production always omits it. */
  protectedMemoryComposition?: ProtectedMemoryRouteComposition | undefined;
  /**
   * Canonical server migration composition for Stenographer Records. Current
   * production supplies ordinary; future encryption activation supplies the
   * protected implementation without changing Stenographer or model output.
   */
  stenographerRecordPublisher?: OrdinaryStenographerIntentAdapterOptions["publishExtraction"] | undefined;
  stenographerRecordConverter?: OrdinaryStenographerIntentAdapterOptions["convertNextLegacy"] | undefined;
  /** override voice catalog persistent cache deps in unit tests. */
  voiceRoutesDeps?: VoiceRouteDeps | undefined;
  /**
   * Integration harness: pin the default agent id passed
   * into `policyResolver.resolveContext` during Logto bearer resolution.
   * Parallel test files mutate `getBootstrapDefaultAgentId()`; wiring this
   * keeps each `createApp` instance stable. Production omits it.
   */
  trustBearerDefaultAgentId?: string | (() => string) | undefined;
  /**  test/later-coordinator injection; production creates one registry per app. */
  humanEditLeaseRegistry?: HumanEditLeaseRegistry | undefined;
}

/**
 * context for requests with NO authenticated user
 * (no bearer, or bearer failed in a way that doesn't yield a real
 * identity). Empty ownerId + empty agentId means downstream routes
 * that derive a subject from `request.sessionUserId ?? request.memoryEnvelope?.ownerId`
 * naturally fail with 401 instead of silently adopting the first
 * claimer's identity. `actorRole` is `"anonymous"` so policy-aware
 * code can grep for the case explicitly.
 *
 * `buildGuestContext` below is kept for the few callers that pass a
 * real per-user id (NOT a bootstrap global) for a known-user-but-
 * guest-role visit. Production app.ts call sites today all qualify
 * as anonymous and use `buildAnonymousContext`.
 */
export function buildAnonymousContext(): RuntimePolicyContext {
  const envelope: MemoryAccessEnvelope = {
    ownerId: "",
    actorId: "",
    agentId: "",
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: buildGuestToolPolicy(),
  };
  return {
    laneKey: "anonymous",
    actorId: "",
    agentId: "",
    roomId: "",
    roomType: "",
    graphThreadId: "",
    actorLabel: "Anonymous",
    actorFederatedId: "",
    agentFederatedId: "",
    speakerTrust: "unverified",
    laneScope: "private",
    actorRole: "anonymous",
    memoryAccess: envelope,
  };
}

// the legacy `buildGuestContext(ownerId, agentId)` helper
// is gone. All production call sites used it with bootstrap-state-cache
// globals, which silently dressed every unauthenticated / auth-failed
// request in the operator's identity. `buildAnonymousContext()` is the
// canonical replacement. If a future caller genuinely needs a
// per-user "known user, guest role" projection, derive ids from the
// caller's bearer or `findAgentsOwnedByUser` — never the bootstrap cache.

const DEFAULT_DEV_LOG_RETENTION_DAYS = 14;
const MAX_DEV_LOG_RETENTION_DAYS = 90;

/**
 * Delete dev log files older than retention window. Best-effort — any
 * error sweeping one file just gets logged and moves on. Called at sink
 * setup so stale logs don't accumulate indefinitely.
 */
function sweepOldLogs(dir: string, prefix: string, retentionDays: number): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir doesn't exist yet — nothing to sweep
  }
  let deleted = 0;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.mtimeMs < cutoff) {
        unlinkSync(full);
        deleted++;
      }
    } catch (err) {
      process.stderr.write(
        `[server] log-sweep: skip ${name}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  if (deleted > 0) {
    process.stderr.write(`[server] log-sweep: deleted ${deleted} file(s) older than ${retentionDays}d\n`);
  }
}

function resolveRetentionDays(): number {
  const raw = process.env["NAUTILO_DEV_LOG_RETENTION_DAYS"];
  if (!raw) return DEFAULT_DEV_LOG_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DEV_LOG_RETENTION_DAYS;
  return Math.min(n, MAX_DEV_LOG_RETENTION_DAYS);
}

function resolvePublicBaseUrl(options?: CreateAppOptions): string {
  const configured = process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim();
  if (configured) return configured.replace(/\/$/u, "");
  const scheme = options?.https ? "https" : "http";
  const host = options?.hostname ?? "localhost";
  const port = options?.port ?? 3001;
  return `${scheme}://${host}:${port}`;
}

export async function materializeServerProfileForAppBoot(
  enabled = false,
  materialize: () => Promise<unknown> = () =>
    materializeDefaultServerProfileOnce(getServerDirectDb()),
): Promise<void> {
  if (!enabled) return;
  await materialize();
}

export async function backfillOwnedPhotoLibraryForAppBoot(
  enabled = false,
  backfill: () => Promise<unknown> = async () => {
    const db = getServerDirectDb();
    const [identity] = await db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
      .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
    if (!identity) throw new Error(" boot backfill requires the singleton server identity");
    await backfillLegacyCurrentPhotoReferences(
      { db },
      {
        dryRun: false,
        expectedServerInstanceId: identity.serverInstanceId,
        exclusiveMaintenance: true,
      },
    );
    await backfillLegacyManageAvatarHistory({ db });
  },
): Promise<void> {
  if (!enabled) return;
  await backfill();
}

/**
 * In dev, optionally tees Fastify/Pino logs to a JSONL file sink at
 * ~/.nautilo/logs/server-<date>.jsonl when NAUTILO_DEV_LOGS=1 is set. The
 * file sink is debug-only: never enabled in production regardless of env.
 * Returns the pino multistream to pass as Fastify's logger.stream, or null
 * if no extra sink is desired (Fastify will use its default stdout).
 *
 * Old log files (older than NAUTILO_DEV_LOG_RETENTION_DAYS, default
 * ${DEFAULT_DEV_LOG_RETENTION_DAYS}) are swept on setup.
 */
function buildDevLogStream(): ReturnType<typeof multistream> | null {
  const devLogsEnabled =
    process.env["NAUTILO_DEV_LOGS"] === "1" &&
    process.env["NODE_ENV"] !== "production";
  if (!devLogsEnabled) return null;

  try {
    const level = process.env["NODE_ENV"] === "production" ? "info" : "debug";
    const dir = join(homedir(), ".nautilo", "logs");
    mkdirSync(dir, { recursive: true });
    sweepOldLogs(dir, "server-", resolveRetentionDays());
    const date = new Date().toISOString().slice(0, 10);
    const logPath = join(dir, `server-${date}.jsonl`);
    const streams: StreamEntry[] = [
      { level, stream: process.stdout },
      {
        level,
        stream: destination({ dest: logPath, sync: false, mkdir: true, append: true }),
      },
    ];
    process.stderr.write(`[server] dev log sink → ${logPath}\n`);
    return multistream(streams);
  } catch (err) {
    process.stderr.write(
      `[server] failed to open dev log sink: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return null;
  }
}

/** Construct only the authenticated smoke surface, without production DB owners. */
async function createTestModeOnlyApp(options: CreateAppOptions) {
  if (process.env["NODE_ENV"] === "production"
    || process.env["NAUTILO_TEST_MODE_ONLY"] !== "1"
    || process.env["NAUTILO_TEST_MODE"] !== "1") {
    throw new Error("DB-less app composition requires the development test-mode-only harness");
  }
  const token = await resolveTestToken();
  if (token === null) throw new Error("DB-less app composition requires a test token");
  const app = Fastify({
    logger: options.silent === true ? false : true,
    ...(options.https ? { https: options.https } : {}),
  });
  await app.register(websocket);
  const paths = resolveNautiloRuntimePaths();
  await ensureDirectoryTree(paths);
  const storageZones = createStorageZones(paths);
  app.decorate("storageZones", storageZones);
  setArtifactStorage(storageZones);
  const relayRegistry = new InMemoryRelayRegistry();
  const restoreRelayTokenStore = installTestModeRelayFixture(token);
  relayRegistry.start();
  setRelayRegistry(relayRegistry);
  app.addHook("onClose", (_instance, done) => {
    relayRegistry.stop();
    setRelayRegistry(null);
    restoreRelayTokenStore();
    done();
  });
  healthRoutes(app);
  // Keep the production websocket validator: an unpaired relay is still denied.
  relayRoutes(app, relayRegistry);
  testModeRoutes(app, { enabled: true, token, relayRegistry, defaultRelayUserId: TEST_MODE_RELAY_USER_ID });
  return app;
}

export async function createApp(options?: CreateAppOptions) {
  if (options?.testModeOnly === true) return createTestModeOnlyApp(options);
  const silent = options?.silent ?? false;
  const enableClaudeCodeTasks = options?.enableClaudeCodeTasks === true;
  const policyResolver = options?.policyResolver ?? null;
  //  A1.P1 (was M042D): prefer explicit option (test injection
  // path); fall back to the bootstrap-state-cache populated by
  // bin/nautilo-server right after seedTrustPersonal. Production always
  // has the cache populated; tests pass it explicitly so they can mint
  // their own owner actor.
  const ownerActorId =
    options?.ownerActorId ?? (getBootstrapOwnerActorId() || null);
  const ownerId = options?.ownerId ?? getBootstrapOwnerId();

  const httpsOpts = options?.https;
  const devLogStream = silent ? null : buildDevLogStream();
  const app = Fastify({
    logger: silent
      ? false
      : devLogStream
        ? {
            level: process.env["NODE_ENV"] === "production" ? "info" : "debug",
            stream: devLogStream,
          }
        : { level: process.env["NODE_ENV"] === "production" ? "info" : "debug" },
    ...(httpsOpts ? { https: { key: httpsOpts.key, cert: httpsOpts.cert } } : {}),
  });
  installStrictShadowPlaintextRouteGate(app);

  // one app-owned, memory-only eligibility registry. The
  // lifecycle observer is replace-safe for repeated app fixtures and is
  // removed with this app; it is not a runtime import side effect.
  const foregroundMemoryEffectRecovery = createForegroundMemoryEffectRecovery({
    store: createPostgresForegroundMemoryEffectRecoveryStore(),
    onPassFailure: () => {
      warn("[memory] foreground effect recovery pass failed; durable receipts remain pending");
    },
  });
  const liveShadowMessageComposition =
    createProductionLiveShadowMessageComposition({
      wakeForegroundMemoryEffectRecovery: () =>
        foregroundMemoryEffectRecovery.wake(),
    });
  installProductionLiveShadowMessageComposition(
    app,
    liveShadowMessageComposition,
  );
  const clientActionBindingRegistry = new ClientActionBindingRegistry(
    Date.now,
    (clientActionSessionId) => {
      liveShadowMessageComposition.pendingAttention?.cancelForClientSession(clientActionSessionId);
      liveShadowMessageComposition.recipients.deleteClientSession(
        clientActionSessionId,
      );
    },
  );
  const uninstallClientActionBindingRegistry = installClientActionBindingRegistry(
    clientActionBindingRegistry,
  );
  const uninstallForegroundTurnLifecycleObserver = installForegroundTurnLifecycleObserver((event) => {
    clientActionBindingRegistry.onHumanPersistence(
      event.turnId,
      event.kind === "human_persisted",
    );
  });
  const uninstallDurableToolResultLifecycleObserver = installDurableToolResultLifecycleObserver((event) => {
    publishDurableGuideUserClientAction(clientActionBindingRegistry, event);
  });
  let liveShadowLifecycleReconciliation: Promise<void> | null = null;
  const reconcileLiveShadowLifecycle = (): void => {
    if (
      liveShadowLifecycleReconciliation !== null
      || liveShadowMessageComposition.reconcileLifecycle === undefined
    ) return;
    liveShadowLifecycleReconciliation = liveShadowMessageComposition
      .reconcileLifecycle()
      .then(() => undefined)
      .catch((error: unknown) => {
        app.log.warn(
          {
            errorName: error instanceof Error ? error.name : typeof error,
          },
          "live Shadow lifecycle reconciliation failed",
        );
      })
      .finally(() => {
        liveShadowLifecycleReconciliation = null;
      });
  };
  const liveShadowLifecycleTimer = setInterval(
    reconcileLiveShadowLifecycle,
    5_000,
  );
  liveShadowLifecycleTimer.unref?.();
  // Close work stranded by the previous process without waiting for a new
  // Room send or even the first interval tick.
  reconcileLiveShadowLifecycle();
  app.addHook("onClose", async () => {
    clearInterval(liveShadowLifecycleTimer);
    await liveShadowLifecycleReconciliation;
    uninstallDurableToolResultLifecycleObserver();
    uninstallForegroundTurnLifecycleObserver();
    uninstallClientActionBindingRegistry();
    uninstallProductionLiveShadowMessageComposition(app);
    await liveShadowMessageComposition.shutdown();
  });

  // one process-local DB statement observer delegates to the
  // active request telemetry context (AsyncLocalStorage); no per-request
  // observer registration races.
  const unbindRuntimeDbObserver = bindRuntimeStatementObserverToRequestTelemetry();
  app.addHook("onClose", () => {
    unbindRuntimeDbObserver();
  });

  // create the four-zone directory tree (idempotent, <50ms),
  // then build the storage bundle once at boot and share it with every
  // route + the agent's artifact tools.
  //
  // ensureDirectoryTree is called HERE (not only in bin/nautilo-server)
  // so test harnesses and any future consumer that spins up the
  // Fastify app via createApp() directly get the directory tree
  // without having to replicate boot code. Idempotent — safe to
  // run every createApp() call; the migration marker means the
  // move-from-old-layout step runs at most once per install.
  const paths = resolveNautiloRuntimePaths();
  await ensureDirectoryTree(paths);
  const storageZones = createStorageZones(paths);
  app.decorate("storageZones", storageZones);
  setArtifactStorage(storageZones);
  //  Milestone B — install the inPlace office-session broker so the
  // agent's `office` tool can edit a workspace doc through a live coolwsd
  // session (WOPI token mint + WS URL assembly). Symmetric with
  // setArtifactStorage above.
  setOfficeSessionBroker(createOfficeSessionBroker());

  // prime the server model config cache so the first model resolution
  // (default / conductor / fallback) sees admin-configured values without a
  // request first. Best-effort: consumers fall back safely if this fails.
  await refreshServerModelConfigCache(true).catch(() => undefined);

  // choose and persist this server's non-legacy visual
  // identity once at boot. The DB conditional write makes concurrent app
  // starts idempotent and preserves any explicit Admin/upload choice.
  //
  // reusable `createApp()` defaults this persistence side effect
  // off. The real server binary opts in for ordinary boots and opts out only
  // for its DB-less test-mode-only harness. Rejections are intentionally not
  // swallowed: an enabled real boot must fail on an unexpected DB/write error.
  await materializeServerProfileForAppBoot(
    options?.materializeServerProfileAtBoot,
  );
  // migrations create the ownership tables, then ordinary boots adopt
  // only current DB pointers and exact manage_avatar success transcripts.
  // This runs before Fastify listens, so interactive photo mutations cannot
  // race the offline backfill admission.
  await backfillOwnedPhotoLibraryForAppBoot(
    options?.backfillOwnedPhotoLibraryAtBoot,
  );

  const securityAuditLogPath = options?.securityAuditLogPath
    ?? join(homedir(), ".nautilo", "logs", "security-audit.log");
  const writeConnectionVaultAudit = (evt: {
    readonly actorId: string | null;
    readonly ip: string;
    readonly userAgent?: string | undefined;
    readonly action: ConnectionVaultToolAuditEvent["action"];
    readonly tool: string;
    readonly outcome: ConnectionVaultToolAuditEvent["outcome"];
    readonly service?: string | undefined;
    readonly field?: string | undefined;
    readonly connectionId?: string | undefined;
    readonly errorKind?: string | undefined;
  }): void => {
    const row = {
      ts: new Date().toISOString(),
      kind: "connection_vault_tool" as const,
      actorId: evt.actorId,
      ip: evt.ip.length > 0 ? evt.ip : "unknown",
      userAgent: evt.userAgent,
      action: evt.action,
      tool: evt.tool,
      outcome: evt.outcome,
      ...(evt.service !== undefined ? { service: evt.service } : {}),
      ...(evt.field !== undefined ? { field: evt.field } : {}),
      ...(evt.connectionId !== undefined ? { connectionId: evt.connectionId } : {}),
      ...(evt.errorKind !== undefined ? { errorKind: evt.errorKind } : {}),
    } satisfies ConnectionVaultToolAuditEvent;
    try {
      writeSecurityAuditEvent(securityAuditLogPath, row);
    } catch (err) {
      warn(
        `[connection-vault-audit] write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const connectionVault = new BuiltinVaultBackend({
    installId: paths.rootDir,
    masterPersistence: new BunOrPinVaultMasterPersistence(paths.vaultDir),
    vaultPath: resolveVaultEncryptedFilePath(paths),
  });
  await connectionVault.loadFromDisk();
  try {
    await connectionVault.unlock();
  } catch (e) {
    warn(
      `[vault] boot-time unlock skipped: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  // vault is locked at boot; unlocked on next successful PIN proof
  // (prove-and-resume / identity-verify-resume / recover); re-locked on shutdown.
  connectionVault.lock();
  clearRegisteredSecretsForRedaction();
  setConnectionVaultAuditSink(writeConnectionVaultAudit);
  setConnectionProxyDispatcher(async (input) => {
    const envelope = input.context?.memoryAccessEnvelope;
    const writable = envelope?.writableNamespaces ?? [];
    const scope = {
      agentId: envelope?.agentId ?? "",
      // attachment target (`writableNamespaces[0]`), not `mutableNamespaces`.
      defaultNamespaceId: writable[0] ?? null,
      readableNamespaceIds: envelope?.readableNamespaces ?? [],
    };
    return dispatchConnectionProxy(
      {
        vault: connectionVault,
        auditConnection: writeConnectionVaultAudit,
      },
      {
        service: input.service,
        request: {
          ...input.request,
          method: input.request.method ?? "GET",
          category: "user",
        },
        scope,
        actorId: input.context?.actorId ?? null,
        ip: input.context?.ip ?? "internal",
        userAgent: input.context?.userAgent,
      },
    );
  });
  setConnectionVaultBackend(connectionVault);
  app.addHook("onClose", () => {
    connectionVault.lock();
    clearRegisteredSecretsForRedaction();
    setConnectionVaultBackend(null);
    setConnectionVaultAuditSink(null);
    setConnectionProxyDispatcher(null);
  });
  // A — the backup subsystem uses the `data` zone for
  // content-addressed pre-bytes blobs (agent-invisible, server-
  // internal). Setting the full `StorageZones` bundle keeps the
  // registry API symmetric with `setArtifactStorage` above and
  // leaves room for future multi-zone routing (e.g. encrypted
  // blobs under `vault` once M2 key-isolation lands).
  setBackupStorage(storageZones);
  // wire the backup subsystem's event sink
  // to the WS broadcaster. After this, any recordRevision success
  // or GC eviction fires a `revisions.state_changed` event the
  // workbench's useRevisionState hook consumes to toggle undo/
  // redo affordances. No-op before this line (the sink module
  // falls back to silent when unregistered); production code path
  // always runs setBackupStorage before this, so ordering is safe.
  setRevisionEventSink(broadcast);
  // hourly sweep for size-cap LRU
  // eviction and orphaned-blob cleanup. Caps + interval come from
  // the runtime config (env: NAUTILO_BACKUP_PER_FILE_CAP /
  // NAUTILO_BACKUP_TOTAL_SIZE_CAP_MB / NAUTILO_BACKUP_GC_INTERVAL_MS;
  // defaults: 50 / 500 MB / 1 h). The per-file count-cap sweep runs
  // inline post-insert inside `recordRevision()`; only the
  // deployment-wide size sweep needs the background scheduler.
  // `unref()`'d internally so shutdown isn't blocked.
  const backupConfig = fromRuntimeConfig();
  startBackupGcScheduler({
    intervalMs: backupConfig.nautilo_backup_gc_interval_ms,
    config: {
      perFileCap: backupConfig.nautilo_backup_per_file_cap,
      totalSizeCapBytes:
        backupConfig.nautilo_backup_total_size_cap_mb * 1024 * 1024,
    },
  });
  app.addHook("onClose", () => stopBackupGcScheduler());
  // terminalize expired pre-provider reservations and remove only the
  // DB-proven deterministic artifacts. This is independent of future creates.
  const stopAgentPhotoLibraryReservationRecovery = startAgentPhotoLibraryReservationRecovery({
    db: getServerDirectDb(),
  });
  app.addHook("onClose", () => stopAgentPhotoLibraryReservationRecovery());
  const stopAccountDeletionPhotoCleanupRecovery = startAccountDeletionPhotoCleanupRecovery({
    db: getServerDirectDb(),
  });
  app.addHook("onClose", () => stopAccountDeletionPhotoCleanupRecovery());

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ConfigGuardError) {
      return replyForConfigGuardError(reply, error);
    }
    logError(
      "[server]",
      request.method,
      request.url,
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    const codeRaw = (error as { statusCode?: unknown }).statusCode;
    const statusCode = typeof codeRaw === "number" ? codeRaw : 500;
    const msgRaw = (error as { message?: unknown }).message;
    const clientMessage =
      statusCode >= 500
        ? "Something went wrong. Check the server logs for details."
        : typeof msgRaw === "string"
          ? msgRaw
          : "Request failed";
    // Preserve machine-readable `code` and an explicit `publicError` label
    // when a thrown error carries them (e.g. the trust preHandler's
    // `user_disabled` / `agent_resolution_failed` rejections). This keeps
    // the `{ code }` body contract intact now that those paths throw
    // instead of calling reply.send() directly.
    const machineCode = (error as { code?: unknown }).code;
    const publicError = (error as { publicError?: unknown }).publicError;
    const errorLabel =
      typeof publicError === "string" && publicError.length > 0
        ? publicError
        : statusCode >= 500
          ? "Internal Server Error"
          : "Request Error";
    const body: {
      statusCode: number;
      error: string;
      message: string;
      code?: string;
    } = {
      statusCode,
      error: errorLabel,
      message: clientMessage,
    };
    if (typeof machineCode === "string" && machineCode.length > 0) {
      body.code = machineCode;
    }
    return reply.code(statusCode).send(body);
  });

  await app.register(cors, {
    origin: process.env["NODE_ENV"] === "production" ? false : true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  });

  await app.register(websocket);
  await app.register(multipart);

  // onboarding static assets.
  //
  // Greenfield migration of the legacy /setup/ Fastify static page.
  // The Fastify-served `/setup/index.html` wizard is gone — its
  // replacement runs as a dedicated Electron BrowserWindow bundle
  // under apps/desktop/onboarding/. The server only ships the
  // narrator MP3 + avatar preset files at a stable `/api/onboarding/`
  // route so the renderer can fetch them at runtime. Three.js is
  // bundled in the Electron renderer; the legacy `/vendor/three.*`
  // routes are deleted (no fallback, no replacement — Three.js was
  // wizard-only).
  await app.register(staticFiles, {
    root: join(serverSrcDir, "onboarding"),
    prefix: "/api/onboarding/",
  });

  // ---------------------------------------------------------------------------
  // PIN provider
  // ---------------------------------------------------------------------------

  const pinProvider = options?.pinProvider ?? new PinChallengeProvider();

  // ---------------------------------------------------------------------------
  // Auth + Trust middleware — resolves actor context on every request.
  // Authenticated requests get owner context; unauthenticated get guest context.
  // ---------------------------------------------------------------------------

  app.decorateRequest("policyContext", null);
  app.decorateRequest("memoryEnvelope", null);
  app.decorateRequest("sessionActorId", null);
  app.decorateRequest("sessionUserId", null);
  app.decorateRequest("accessTokenIssuedAt", null);
  app.decorateRequest("accessTokenExpiresAt", null);
  app.decorateRequest("cryptoDeviceAdmission", null);
  app.decorateRequest("resolvedPrincipal", null);
  app.decorateRequest("rbacProjection", null);

  // start every non-bypass request in a newly allocated ALS
  // context. Calling Fastify's continuation inside `run` preserves the
  // context for later lifecycle hooks and prevents stale ambient stores from
  // being reused by a subsequent request.
  app.addHook("onRequest", (request, _reply, done) => {
    if (shouldSkipRequestTelemetry(
      request.url,
      request.routeOptions?.url ?? request.url,
    )) {
      done();
      return;
    }
    runWithNewRequestTelemetry(done);
  });

  //  PR A — access log for /api/auth/* POSTs. Logs status +
  // latency regardless of whether the business handler succeeded or
  // threw. Distinguishes "did the client even reach us?" from
  // "reached us but we errored" in observability-gap debugging
  // (esp. the approval-reply flow). Routes OUTSIDE /api/auth are not
  // included on purpose — /api/chat and friends have their own
  // route-level logs already.
  app.addHook("onRequest", (request, _reply, done) => {
    if (request.method === "POST" && request.url.startsWith("/api/auth/")) {
      (request as unknown as { __authStartedAt?: number }).__authStartedAt =
        Date.now();
    }
    done();
  });

  // SSE-only convenience: EventSource cannot set Authorization headers.
  // Promote `?token=` to a Bearer header for the small set of SSE routes
  // that browser EventSource must open without custom headers. The query
  // token is the same opaque session bearer the rest of the stack uses;
  // surface area is kept minimal by exact URL-prefix gates.
  app.addHook("onRequest", (request, _reply, done) => {
    if (
      request.method === "GET" &&
      (request.url.startsWith("/api/workspace/artifacts/events") ||
        request.url.startsWith("/api/apps/events")) &&
      !request.headers["authorization"]
    ) {
      const url = new URL(request.url, "http://localhost");
      const token = url.searchParams.get("token");
      if (token) {
        request.headers["authorization"] = `Bearer ${token}`;
      }
    }
    done();
  });
  app.addHook("onResponse", (request, reply, done) => {
    if (request.method !== "POST" || !request.url.startsWith("/api/auth/")) {
      done();
      return;
    }
    const startedAt = (request as unknown as { __authStartedAt?: number })
      .__authStartedAt;
    const dt = startedAt ? `${Date.now() - startedAt}ms` : "unknown";
    const userHint =
      request.policyContext?.actorRole === "owner"
        ? "owner"
        : request.policyContext?.actorRole ?? "unknown";
    //  PR B — if the resume-handler stashed a turnId on the
    // request (verify-and-resume, prove-and-resume, approval-reply),
    // bind it for this single log emission so the access line
    // grep-correlates with the rest of the turn. Routes without a
    // stashed turnId (enroll, recovery-codes, lockout-check, etc.)
    // fall through and emit the line unprefixed, same as pre-PR-B.
    const emit = () =>
      log(
        `[auth/access] POST ${request.url} ${reply.statusCode} user=${userHint} dt=${dt}`,
      );
    if (request.__turnId) {
      runWithTurn(request.__turnId, emit);
    } else {
      emit();
    }
    done();
  });

  // single source of truth for "bearer → policyContext".
  // Used by the HTTP preHandler below AND the WS first-message auth
  // gate at routes/ws.ts. Captured here so `policyResolver` (createApp
  // closure, not a module-level singleton) stays in scope for both
  // consumers.
  //  Read on every request via
  // callback so a claim redeem's bootstrap-state-cache refresh
  // (in-process, sync) takes effect on the very next bearer
  // resolution without requiring a server restart. The pre-
  // "stable at boot" guarantee was a test-harness-only convenience
  // — for production the value still only shifts on the first claim,
  // never mid-session.
  //  The `defaultAgentId` dep on `buildResolveBearer`
  // is deprecated and no longer consulted inside the resolver (Phase 1.3
  // zero-agent branch sets preferredAgentId="" instead of falling back).
  // We stop touching `getBootstrapDefaultAgentId()` here entirely so this
  // production request path is grep-clean per MR1.
  const resolveBearer = buildResolveBearer({
    policyResolver,
  });
  const deviceAdmissionComposition =
    createProductionDeviceAdmissionComposition();

  app.addHook("preHandler", async (request, _reply) => {
    const routePath = request.routeOptions?.url ?? request.url;

    // WOPI endpoints (coolwsd) have no user cookie. They present
    // a per-artifact `access_token` query param validated inside the
    // `/wopi/*` route handlers. Short-circuit session-based trust
    // resolution for the `/wopi/` prefix only; `POST /api/office/wopi-token`
    // (which mints the token) does NOT match this prefix and stays
    // user-authed via the normal bearer path below.
    if (request.url.startsWith("/wopi/")) return;

    // the coolwsd reverse-proxy prefix. Engine
    // assets + WS upgrades aren't user-session-authed (no browser cookie
    // is sent for `<iframe>`-initiated asset fetches); document access
    // stays gated by the WOPI `access_token` validated inside `/wopi/*`.
    if (request.url.startsWith("/office-engine/")) return;

    if (routeSkipsTrustPreHandler(routePath)) return;

    // Initialize decorations to guest defaults so the per-branch code
    // below only has to overwrite on the happy path.
    request.sessionActorId = null;
    request.sessionUserId = null;
    request.accessTokenIssuedAt = null;
    request.accessTokenExpiresAt = null;
    request.cryptoDeviceAdmission = null;
    request.resolvedPrincipal = null;
    request.rbacProjection = null;

    const authHeader = request.headers.authorization;
    const bearer = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7)
      : null;

    if (!bearer) {
      request.policyContext = buildAnonymousContext();
      request.memoryEnvelope = request.policyContext.memoryAccess;
      return;
    }

    const stringifyErr = (e: unknown): string => {
      if (e instanceof Error) return e.message;
      if (typeof e === "string") return e;
      try {
        return JSON.stringify(e);
      } catch {
        return "[unstringifiable error]";
      }
    };

    /**
     * Single fallback path: every failure (revoked user,
     * bad JWT, missing federated id, exception) lands here with a
     * structured `reason` so log-grepping can distinguish the cases.
     * Never throws back to Fastify — auth errors fall through to
     * anonymous context, exactly as the local-mode path always has.
     */
    const fallbackToAnonymous = (reason: string, err?: unknown): void => {
      const route = request.routeOptions?.url ?? request.url;
      if (err) {
        warn(
          `[auth] preHandler.fallback_to_anonymous reason=${reason} on ${route}: ${stringifyErr(err)}`,
        );
      } else {
        warn(
          `[auth] preHandler.fallback_to_anonymous reason=${reason} on ${route}`,
        );
      }
      request.sessionActorId = null;
      request.sessionUserId = null;
      request.accessTokenIssuedAt = null;
      request.accessTokenExpiresAt = null;
      request.cryptoDeviceAdmission = null;
      request.resolvedPrincipal = null;
      request.rbacProjection = null;
      request.policyContext = buildAnonymousContext();
      request.memoryEnvelope = request.policyContext.memoryAccess;
    };

    const acceptsRequestedRoom =
      request.method === "POST" &&
      (routePath === "/api/chat" ||
        routePath === "/api/file/invoke-direct" ||
        routePath === "/api/apps/:appId/video-host-attestation" ||
        routePath === "/api/video-generations/prepare" ||
        routePath === "/api/video-generations/:takeId/submit" ||
        routePath === "/api/rooms/:roomId/messages");
    // Artifact, media, office, conversion, and connected-app preview routes
    // narrow the bearer envelope by the same `?roomId=` contract. This keeps
    // every derived or fetched resource in the exact Room namespace.
    const acceptsRoomQuery = acceptsRequestedRoomIdFromUrl(
      request.method,
      routePath,
      request.url,
    );
    const requestedRoomIdFromMessagesRoute =
      routePath === "/api/rooms/:roomId/messages" && request.method === "POST"
        ? (() => {
            const p = request.params as { roomId?: string };
            const rid = typeof p?.roomId === "string" ? p.roomId.trim() : "";
            return rid && isUuidString(rid) ? rid : undefined;
          })()
        : undefined;
    const requestedRoomId =
      requestedRoomIdFromMessagesRoute ??
      (acceptsRequestedRoom && routePath !== "/api/rooms/:roomId/messages"
        ? extractChatRequestedRoomId(request.body)
        : undefined) ??
      (acceptsRoomQuery
        ? extractRequestedRoomIdFromUrl(request.url)
        : undefined);
    const resolutionDepth = bearerResolutionDepthForRoute(
      request.method,
      routePath,
    );
    const result = await resolveBearer(bearer, {
      ...(requestedRoomId ? { requestedRoomId } : {}),
      ...(requestedRoomId &&
      (acceptsRoomQuery ||
        routePath === "/api/apps/:appId/video-host-attestation" ||
        routePath === "/api/rooms/:roomId/messages")
        ? { requestedRoomAdmission: "human" as const }
        : {}),
      depth: resolutionDepth,
    });
    if (!result.ok) {
      if (result.reason === "agent_resolution_failed") {
        const errStr =
          "err" in result && result.err ? stringifyErr(result.err) : "";
        warn(
          `[auth] agent_resolution_failed on ${routePath}${errStr ? ": " + errStr : ""}`,
        );
        // THROW (not reply.send) to halt deterministically. Under bun +
        // Fastify v5, a `reply.send()` + return from this async preHandler
        // does NOT reliably skip the route handler, so the handler ran and
        // double-sent (`ERR_HTTP_HEADERS_SENT`). Throwing always halts the
        // lifecycle; `setErrorHandler` renders the tagged statusCode/code.
        throw Object.assign(new Error("agent identity resolution failed; retry shortly"), {
          statusCode: 503,
          code: "agent_resolution_failed",
          publicError: "Service Unavailable",
        });
      }
      if (result.reason === "user_disabled") {
        // fail-closed on a soft-deleted account. Hard 401 (NOT a
        // guest fallthrough) so a disabled user reaches no authenticated
        // route. Audit the blocked session for the forensic trail.
        warn(`[auth] user_disabled_session_blocked on ${routePath}`);
        try {
          writeSecurityAuditEvent(securityAuditLogPath, {
            kind: "user_disabled_session_blocked",
            ts: new Date().toISOString(),
            actorId: null,
            ip: request.ip,
            userAgent:
              typeof request.headers["user-agent"] === "string"
                ? request.headers["user-agent"]
                : undefined,
            sessionUserId: "",
            route: routePath,
          });
        } catch (err) {
          warn(`[auth] user_disabled audit write failed: ${stringifyErr(err)}`);
        }
        // THROW to halt deterministically (see agent_resolution_failed
        // above) — a `reply.send()` + return here let the route handler run
        // under bun + Fastify v5 and double-send.
        throw Object.assign(new Error("This account has been disabled."), {
          statusCode: 401,
          code: "user_disabled",
          publicError: "Unauthorized",
        });
      }
      const reason =
        result.reason === "exception"
          ? "preHandler.exception"
          : result.reason;
      fallbackToAnonymous(
        reason,
        "err" in result ? result.err : undefined,
      );
      return;
    }
    request.sessionActorId = result.sessionActorId;
    request.sessionUserId = result.sessionUserId;
    request.accessTokenIssuedAt = result.accessTokenIssuedAt;
    request.accessTokenExpiresAt = result.accessTokenExpiresAt;
    request.resolvedPrincipal = result.principal;
    if (result.depth === "rbac" || result.depth === "policy") {
      request.rbacProjection = result.rbacProjection;
    }
    if (isResolveBearerPolicyOk(result)) {
      request.policyContext = result.policyContext;
      request.memoryEnvelope = result.memoryEnvelope;
    }
    scheduleLastSeenBump(result.sessionUserId);
  });

  //  Wave 3 — a temporary-password identity is authenticated but
  // restricted. Only identity inspection and the exact password-change path
  // remain reachable until the server observes successful rotation and clears
  // the durable account-security gate. This is server enforcement: CLI/TUI/UI
  // clients cannot bypass it by constructing a different request.
  app.addHook("preHandler", async (request) => {
    const userId = request.sessionUserId;
    if (!userId) return;
    const routePath = request.routeOptions?.url ?? request.url;
    if (restrictedPasswordChangeRouteAllowed(request.method, routePath)) return;
    const security = await getAccountSecurityRowByUserId(getServerDirectDb(), userId);
    if (security?.requiresPasswordChange === true) {
      throw passwordChangeRequiredError();
    }
  });

  // authentication identifies the Human. On a non-plaintext server,
  // this second boundary proves that the same bearer controls one exact,
  // active/current crypto-device signing key before product code runs.
  app.addHook("preHandler", async (request) => {
    if (!request.sessionUserId) return;
    const routePath = request.routeOptions?.url ?? request.url;
    const preAdmissionKind = preAdmissionRouteKind(request.method, routePath);
    if (preAdmissionKind !== null) {
      if (preAdmissionKind === "encryption_rollback") {
        request.log.info({
          event: "crypto_device_admission_rollback_route_allowed",
        });
      }
      return;
    }
    try {
      const policy = await getEncryptionTransitionPolicy(getServerDirectDb());
      if (policy.mode === "plaintext_only") return;
      request.cryptoDeviceAdmission = await resolveCurrentDeviceAdmission({
        request,
        composition: deviceAdmissionComposition,
        now: Date.now(),
      });
    } catch (error) {
      if (
        typeof error === "object"
        && error !== null
        && "code" in error
        && typeof error.code === "string"
        && error.code.startsWith("device_")
      ) throw error;
      request.log.warn({
        event: "crypto_device_admission_unavailable",
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw cryptoDeviceAdmissionRequiredError(
        "device_admission_unavailable",
      );
    }
  });

  // Must return a Promise — a sync preHandler after the async trust preHandler
  // above stalls Fastify's hook chain (zero-byte hang on every route).
  app.addHook("preHandler", (request): Promise<void> => {
    if (shouldSkipRequestTelemetry(
      request.url,
      request.routeOptions?.url ?? request.url,
    )) {
      return Promise.resolve();
    }
    if (getActiveRequestTelemetry()) {
      markHandlerPhaseStart();
    }
    return Promise.resolve();
  });

  // stage durations + opaque correlation id on the response.
  // Server-Timing carries stage names/durations only (no user-identifying data).
  app.addHook("onSend", async (request, reply, payload) => {
    if (shouldSkipRequestTelemetry(
      request.url,
      request.routeOptions?.url ?? request.url,
    )) {
      return payload;
    }

    finalizeHandlerPhase();
    const ctx = getActiveRequestTelemetry();
    if (!ctx) return payload;

    const timing = formatServerTimingHeader(ctx);
    if (timing !== null && isValidServerTimingHeader(timing)) {
      reply.header("Server-Timing", timing);
    }
    reply.header("X-Correlation-Id", ctx.correlationId);
    return payload;
  });

  // security/cache policy applies to the complete Mobile namespace,
  // including static assets, diagnostics, redirects, and hard 404s. Static
  // plugin misses can terminate inside their encapsulated scope before a
  // parent onSend hook, so establish the safe default at request entry and
  // retain the onSend guard for every ordinary Mobile response. Fingerprinted
  // static handlers replace this default with their explicit immutable policy.
  // It stays route-local so Workbench and API response contracts are unchanged.
  const mobileWebSecurityHeaders = buildMobileWebSecurityHeaders(process.env["LOGTO_ENDPOINT"]);
  const isMobileWebRequest = (request: FastifyRequest) => {
    // Fastify may normalize an encoded traversal before route selection. Keep
    // the raw request target for header ownership so a `/mobile/...` attempt
    // cannot lose the Mobile no-store/security policy as it fails closed.
    const pathname = pathnameWithoutQuery(request.raw.url ?? request.url);
    return pathname === "/mobile" || pathname.startsWith("/mobile/");
  };
  const applyMobileWebSecurityHeaders = (reply: FastifyReply) => {
    for (const [name, value] of Object.entries(mobileWebSecurityHeaders)) {
      if (name === "content-security-policy") continue;
      reply.header(name, value);
    }
  };
  app.addHook("onRequest", (request, reply, done) => {
    if (isMobileWebRequest(request)) {
      applyMobileWebSecurityHeaders(reply);
      reply.header("cache-control", MOBILE_WEB_NAVIGATION_CACHE_CONTROL);
    }
    done();
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (!isMobileWebRequest(request)) return payload;
    applyMobileWebSecurityHeaders(reply);
    const contentType = reply.getHeader("content-type");
    if (typeof contentType === "string" && contentType.toLowerCase().startsWith("text/html")) {
      reply.header(
        "content-security-policy",
        mobileWebSecurityHeaders["content-security-policy"],
      );
    }
    // Fingerprinted static mounts set their explicit immutable policy. Every
    // other Mobile response is intentionally revalidated, including favicon,
    // redirects, and missing metadata/assets.
    if (reply.getHeader("cache-control") === undefined) {
      reply.header("cache-control", MOBILE_WEB_NAVIGATION_CACHE_CONTROL);
    }
    return payload;
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  //  (Wave 2 task 2.2.1) — install the production maintenance gate BEFORE
  // any route or the Task observer can accept work. Every executable ingress
  // (chat dispatch, `POST /api/jobs`, task claim/scheduled dispatch, coalescer
  // enqueue) consults this gate and rejects NEW work with a typed retryable
  // error while the durable maintenance state is active; already-accepted
  // continuation (conductor wakes, task report-back, in-turn background spawns)
  // carries acceptance authority and is admitted. Installed here (not at module
  // load) so the lazy DB pool is only created in a real server process.
  const maintenanceController = new MaintenanceController({
    db: getServerDirectDb(),
  });
  //  (Wave 3 task 3.2.1) — wrap the controller so every durable
  // maintenance state change (operator enter/applying/complete/cancel/renew
  // AND expiry recovery observed on read) publishes a payload-free
  // `maintenance.status` broadcast to every authenticated socket. Same-state
  // reads are suppressed, so the gate's per-ingress `getState()` and the
  // operator `status` GET never become a polling firehose. The same wrapper
  // is shared by the gate and the operator API so there is one broadcast
  // chokepoint and no duplicate emits.
  const publishingMaintenanceController = withMaintenanceStatusPublishing(
    maintenanceController,
    publishMaintenanceStatus,
  );
  const maintenanceGate = new ProductionMaintenanceGate(publishingMaintenanceController);
  const strictBackgroundMaintenanceGate = (boundaryId: string) => {
    const permitsProtectedWork = async (): Promise<boolean> => {
      const enforcement = await enforceRegisteredStrictShadowBoundary({
        boundaryId,
        state: "unsupported",
        reason: "unsupported_operation",
        retryable: false,
      });
      return enforcement.result.disposition === "ordinary"
        || enforcement.result.disposition === "protected";
    };
    return {
      isAcceptingWork: async (): Promise<boolean> =>
        await maintenanceGate.isAcceptingWork()
        && await permitsProtectedWork(),
      assertAcceptingNewWork: async (): Promise<void> => {
        await maintenanceGate.assertAcceptingNewWork();
        if (!(await permitsProtectedWork())) {
          throw new Error("Strict Shadow background protection is unavailable");
        }
      },
    };
  };
  setMaintenanceGate(maintenanceGate);
  let reflectionCommitmentKey: Uint8Array | undefined;
  const getReflectionCommitmentKey = () =>
    reflectionCommitmentKey ??= resolveCurrentReflectionCommitmentKey();
  const recordRepositorySelection = resolveCurrentRecordRepositorySelection();
  const resolveStenographerModel = () => {
    kickServerModelConfigRefresh();
    const cachedModelConfig = getCachedServerModelConfigRow();
    return resolveStenographerModelId({
      serverConfiguredModelId: cachedModelConfig?.stenographerModel,
      serverConfiguredConductorModelId: cachedModelConfig?.conductorModel,
      runtimeConfiguredConductorModelId:
        fromRuntimeConfig().nautilo_conductor_model,
    });
  };
  const resolveReflectionModel = () => {
    kickServerModelConfigRefresh();
    const cachedModelConfig = getCachedServerModelConfigRow();
    return resolveReflectionModelId({
      serverConfiguredModelId: cachedModelConfig?.reflectionModel,
      resolvedStenographerModelId: resolveStenographerModel(),
    });
  };
  let ordinaryPublisherPromise: ReturnType<
    typeof createNativeStenographerExtractionPublisher
  > | null = null;
  const publishStenographerRecord: OrdinaryStenographerIntentAdapterOptions["publishExtraction"] =
    options?.stenographerRecordPublisher ?? (async (input) => {
      ordinaryPublisherPromise ??= createNativeStenographerExtractionPublisher({
        db: getServerDirectDb(),
        selection: recordRepositorySelection,
        commitmentKey: getReflectionCommitmentKey(),
        semanticCommitmentKey: getReflectionCommitmentKey(),
      });
      return (await ordinaryPublisherPromise).publishExtraction(input);
    });
  const convertStenographerRecords: OrdinaryStenographerIntentAdapterOptions["convertNextLegacy"] =
    options?.stenographerRecordPublisher !== undefined
      ? options.stenographerRecordConverter
      : async (input) => {
          ordinaryPublisherPromise ??= createNativeStenographerExtractionPublisher({
            db: getServerDirectDb(),
            selection: recordRepositorySelection,
            commitmentKey: getReflectionCommitmentKey(),
            semanticCommitmentKey: getReflectionCommitmentKey(),
          });
          return (await ordinaryPublisherPromise).convertNextLegacyPage(input);
        };
  const memoryReviewRuntime = createServerMemoryReviewRuntime(maintenanceGate);
  const stenographerDataOwner = bindEncryptionDataOperationOwner({
    policy: createLiveShadowDataOperationPolicyBinding(
      () => getEncryptionTransitionPolicy(getServerDirectDb()),
    ),
  });
  // Task protection remains dark until its complete create/read/execution
  // composition is activated. Preserve the established ordinary Task route
  // in every server-wide encryption mode through a Task-specific owner.
  const dormantTaskContentOwner = bindEncryptionDataOperationOwner({
    policy: {
      resolve: () => Promise.resolve({
        policy: { mode: "plaintext_only" as const, shadowBehavior: "fallback" as const },
        revalidationToken: 0,
      }),
      revalidate: () => Promise.resolve(),
    },
  });
  let protectedStenographerPromise: ReturnType<typeof createProductionProtectedStenographerComposition> | null = null;
  let stenographerProtectionCryptoHandlePromise: ReturnType<
    typeof verifyCryptoPostgresHandle
  > | null = null;
  const stenographerProtectionCryptoHandle = () => {
    stenographerProtectionCryptoHandlePromise ??= verifyCryptoPostgresHandle(
      createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
    );
    return stenographerProtectionCryptoHandlePromise;
  };
  const protectedStenographer = () => {
    if (protectedStenographerPromise === null) {
      const pending = createProductionProtectedStenographerComposition({
        db: getServerDirectDb(),
        restricted: createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
        crypto: new LatticeCrypto(),
        serverScope: process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001",
        recordCommitment: createHmacProtectedStenographerRecordCommitmentPort(getReflectionCommitmentKey()),
        semanticCommitments: createHmacRecordSemanticCommitmentPort(getReflectionCommitmentKey()),
        resolveModelId: resolveStenographerModel,
        authorizationRequested: async (record) => {
          if (record.snapshot.formatVersion !== 2
            || record.snapshot.credentialSubject.kind !== "processor"
            || record.descriptorBytes === null) {
            throw new Error("Background wake requires a processor v2 durable descriptor");
          }
          const descriptor = decodeBackgroundProcessorWorkDescriptorV2(record.descriptorBytes);
          try {
            const [room] = await getServerDirectDb().select({id: rooms.id}).from(rooms)
              .where(and(eq(rooms.id, descriptor.authority.roomId), eq(rooms.namespaceId, descriptor.authority.namespaceId))).limit(1);
            if (room !== undefined) broadcast({type: "crypto.background_authorization_requested"}, {kind: "room", roomId: room.id});
          } finally {
            descriptor.authority.namespaceHeadDigest.fill(0); descriptor.authority.domainHeadDigest.fill(0);
            descriptor.authority.bundleDigest.fill(0); descriptor.source.fingerprint.fill(0); descriptor.recipientPublicKey.fill(0);
          }
        },
      });
      protectedStenographerPromise = pending;
      void pending.catch(() => {if (protectedStenographerPromise === pending) protectedStenographerPromise = null;});
    }
    return protectedStenographerPromise;
  };
  const lazyStenographerAdapter = (select: (composition: Awaited<ReturnType<typeof protectedStenographer>>) => StenographerIntentAdapter): StenographerIntentAdapter => ({
    prepareNextOutputRepair: async (input) =>
      select(await protectedStenographer()).prepareNextOutputRepair?.(input)
      ?? Promise.resolve({
        publish: () => Promise.resolve({
          status: "unavailable" as const,
          processed: false as const,
        }),
      }),
    prepareExtraction: async (input) => select(await protectedStenographer()).prepareExtraction(input),
    prepareCompaction: async (input) => select(await protectedStenographer()).prepareCompaction(input),
    prepareNextRebuild: async (input) => select(await protectedStenographer()).prepareNextRebuild(input),
    prepareLegacyConversion: async (input) => select(await protectedStenographer()).prepareLegacyConversion(input),
  });
  const stenographerWorker = new StenographerWorker({
    maintenanceGate,
    operations: createStenographerDataOperationPort({
      owner: stenographerDataOwner,
      authorizationWait: createPostgresStenographerAuthorizationWaitPort(getServerDirectDb()),
      protected: lazyStenographerAdapter((composition) => composition.adapter),
      dual: lazyStenographerAdapter((composition) => composition.dualAdapter),
      ordinary: createOrdinaryStenographerIntentAdapter({
        publishExtraction: publishStenographerRecord,
        ...(convertStenographerRecords === undefined
          ? {}
          : {convertNextLegacy: convertStenographerRecords}),
      }),
    }),
    candidates: createStenographerCandidateDataOperationPort({
      owner: stenographerDataOwner,
      ordinary: {
        extraction: ({lane, now}) => lane === "live" ? candidateRoomIds(getServerDirectDb(), now) : historicalCandidateRoomIds(getServerDirectDb(), now),
        compaction: async ({now}) => (await compactionCandidateRooms(getServerDirectDb(), now)).map((row) => row.roomId),
        initializeHistorical: ({now}) => initializeHistoricalBackfills({db: getServerDirectDb(), now}),
      },
      protected: async () => (await protectedStenographer()).candidates,
    }),
    resolveModelId: resolveStenographerModel,
  });
  const reflectionPolicy = createLiveShadowDataOperationPolicyBinding(
    () => getEncryptionTransitionPolicy(getServerDirectDb()),
  );
  let reflectionAuthorityPromise: ReturnType<typeof createProductionReflectionAuthorityMaintenance> | null = null;
  const reflectionAuthority = () => {
    if (reflectionAuthorityPromise !== null) return reflectionAuthorityPromise;
    const pending = createProductionReflectionAuthorityMaintenance({
      db: getServerDirectDb(), restricted: createPostgresJsBridgeConnection(getSharedDirectCryptoDb()),
      crypto: new LatticeCrypto(), serverScope: process.env["NAUTILO_PUBLIC_BASE_URL"]?.trim() || "http://localhost:3001",
      commitmentKey: getReflectionCommitmentKey(),
      namespaceReadinessRequested: async coordinate => {
        const humans = await getServerDirectDb().select({userId: actors.ownerId}).from(rooms)
          .innerJoin(roomMembers, eq(roomMembers.roomId, rooms.id))
          .innerJoin(actors, and(eq(actors.id, roomMembers.actorId), eq(actors.kind, "user")))
          .where(and(eq(rooms.id, coordinate.roomId), eq(rooms.namespaceId, coordinate.namespaceId),
            isNull(rooms.parentRoomId), isNull(rooms.archivedAt)));
        publishDomainKeyCatchUpRequested({...coordinate, keyClass: "ai",
          recipientUserIds: humans.flatMap(human => human.userId === null ? [] : [human.userId])});
      },
      authorizationRequested: async record => {
        const rootRooms = await getServerDirectDb().select({humans: rooms.humanActorIds}).from(rooms)
          .where(and(eq(rooms.namespaceId, record.snapshot.namespaceId), isNull(rooms.parentRoomId))).limit(2);
        if (rootRooms.length !== 1) return;
        const room = rootRooms[0]!;
        const humans = await getServerDirectDb().select({userId: actors.ownerId}).from(actors)
          .where(and(inArray(actors.id, room.humans), eq(actors.kind, "user")));
        for (const human of humans) if (human.userId !== null) {
          broadcast({type: "crypto.background_authorization_requested"}, {kind: "user", userId: human.userId});
        }
      },
    });
    reflectionAuthorityPromise = pending;
    void pending.catch(() => {
      if (reflectionAuthorityPromise === pending) reflectionAuthorityPromise = null;
    });
    return pending;
  };
  let reflectionRuntimePromise: ReturnType<
    typeof createProductionReflectionMemoryRuntime
  > | null = null;
  const reflectionRuntime = () => {
    if (reflectionRuntimePromise === null) {
      const pending = createProductionReflectionMemoryRuntime({
        db: getServerDirectDb(),
        selection: recordRepositorySelection,
        commitmentKey: getReflectionCommitmentKey(),
        maintenanceGate,
        resolveStageAdmission: signal => resolveReflectionSemanticStageAdmission(reflectionPolicy, signal, true),
        bindSemanticDataOperations: ({work, ordinary, embedding, sourceInvalidation, invokePreparedOrganizerBatch}) => {
          let protectedPromise: Promise<DurableSleepSemanticPort> | undefined;
          const resolveProtected = () => {
            if (protectedPromise !== undefined) return protectedPromise;
            const pending = (async () => {
              const authority = await reflectionAuthority();
              const db = getServerDirectDb();
              const commitmentKey = getReflectionCommitmentKey();
              const search = await createProductionProtectedReflectionSearchComposition({db, commitmentKey, embedding, runSemantic: authority.runSemantic});
              return createProductionProtectedReflectionSemantics({db,
                productHandle: await verifyRecordProductPostgresHandle(createPostgresJsBridgeConnection(db)),
                selection: {...recordRepositorySelection, selectedRepresentation: "protected"}, commitmentKey,
                operation: authority, readiness: {ensureAuthority: authority.ensureAuthority, ensureSearchProjection: search.ensureSearchProjection},
                model: {readiness: signal => ordinary.modelLaneReadiness?.(signal) ?? Promise.resolve({status: "ready"}),
                  invoke: (claim, prompt, signal) => invokePreparedOrganizerBatch([claim], prompt, signal), invokeBatch: invokePreparedOrganizerBatch},
                resolveParentConflict: operation => ordinary.resolveParentConflict(operation), sourceInvalidation,
                nextRetryAt: () => Date.now() + REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds,
              });
            })();
            protectedPromise = pending;
            void pending.catch(() => {if (protectedPromise === pending) protectedPromise = undefined;});
            return pending;
          };
          const semantic: DurableSleepSemanticPort = {
            ensureAuthority: async (claim, signal) => (await reflectionAuthority()).ensureAuthority(claim, signal),
            ensureSearchProjection: async (claim, signal) => (await resolveProtected()).ensureSearchProjection(claim, signal),
            openOrganizationAttempt: async (claim, signal) => (await resolveProtected()).openOrganizationAttempt!(claim, signal),
            loadOrganizerView: async (claim, signal) => (await resolveProtected()).loadOrganizerView(claim, signal),
            resolveParentConflict: async operation => (await resolveProtected()).resolveParentConflict(operation),
            resolveDependencyLoss: async operation => (await resolveProtected()).resolveDependencyLoss(operation),
            invokeOrganizer: async (claim, prompt, signal) => (await resolveProtected()).invokeOrganizer(claim, prompt, signal),
            invokeOrganizerBatch: async (claims, prompt, signal) => (await resolveProtected()).invokeOrganizerBatch!(claims, prompt, signal),
            applyProposal: async operation => (await resolveProtected()).applyProposal(operation),
            modelLaneReadiness: signal => ordinary.modelLaneReadiness?.(signal) ?? Promise.resolve({status: "ready"}),
          };
          return bindReflectionSemanticDataOperationPort({policy: reflectionPolicy, work, ordinary, invokePreparedOrganizerBatch,
            protected: {ensureAuthority: (claim, signal) => semantic.ensureAuthority(claim, signal), semantic,
              releaseWaitingSemantic: async (claim, stage, failure) => (await reflectionAuthority()).releaseWaitingSemantic(claim, stage, failure), maintain: async operation => (await reflectionAuthority()).maintain(operation)}});
        },
        resolveModelId: resolveReflectionModel,
      });
      reflectionRuntimePromise = pending;
      void pending.catch(() => {
        if (reflectionRuntimePromise === pending) reflectionRuntimePromise = null;
      });
    }
    return reflectionRuntimePromise;
  };
  const reflectionSleepController = new ReflectionSleepController({
    resolveWorker: async () => (await reflectionRuntime()).worker,
  });
  installForegroundRecordRecallPortFactory((state) => {
    let bound: ReturnType<
      Awaited<ReturnType<typeof reflectionRuntime>>["recallRecordsPortForState"]
    > | undefined;
    const resolve = async () => {
      const runtime = await reflectionRuntime();
      bound ??= runtime.recallRecordsPortForState(state);
      return bound;
    };
    return {
      async searchStructural(request) {
        const port = await resolve();
        return port?.searchStructural === undefined
          ? { status: "unavailable" as const, reason: "not_ready" as const }
          : port.searchStructural(request);
      },
      async search(request) {
        const port = await resolve();
        return port === undefined
          ? { status: "unavailable", reason: "not_ready" }
          : port.search(request);
      },
      async expand(request) {
        const port = await resolve();
        return port === undefined
          ? { status: "unavailable", reason: "not_ready" }
          : port.expand(request);
      },
    };
  });
  installForegroundRecordContextPortFactory((roomId) => {
    let bound: ReturnType<
      Awaited<ReturnType<typeof reflectionRuntime>>["foregroundRecordContextPortForRoom"]
    > | undefined;
    return {
      get representation() {
        return recordRepositorySelection.selectedRepresentation;
      },
      async select(request) {
        const runtime = await reflectionRuntime();
        bound ??= runtime.foregroundRecordContextPortForRoom(roomId);
        return bound.select(request);
      },
      async selectStructural(request) {
        const runtime = await reflectionRuntime();
        bound ??= runtime.foregroundRecordContextPortForRoom(roomId);
        if (bound.selectStructural === undefined) return {
          status: "unavailable" as const,
          representation: "protected" as const,
          queryEmbeddingStatus: "unavailable" as const,
          reason: "incompatible_projection" as const,
        };
        return bound.selectStructural(request);
      },
    };
  });
  const uninstallAuthoredMemorySemanticChangeSink =
    installAuthoredMemorySemanticChangeSink(async (change) => {
      const runtime = await reflectionRuntime();
      await runtime.authoredMemoryChanges.admit(change);
    });
  installForegroundMemoryEffectRecoveryLifecycle(
    app,
    foregroundMemoryEffectRecovery,
  );
  app.addHook("onClose", async () => {
    uninstallAuthoredMemorySemanticChangeSink();
    uninstallForegroundRecordContextPortFactory();
    uninstallForegroundRecordRecallPortFactory();
    await reflectionSleepController.stop();
  });
  // one process-local, in-memory executor→dispatch
  // completion seam. Fastify teardown releases the hook and clears any
  // server-owned pending wake contexts so tests/restarts cannot retain state.
  installAgentRedirectCompletionHandler();
  app.addHook("onClose", () => {
    uninstallAgentRedirectCompletionHandler();
  });

  healthRoutes(app, {
    pinProvider,
    ownerId: ownerId ?? undefined,
    canonicalEnrolled: async () =>
      (await hasAdminUser(getServerDirectDb())) &&
      !(await hasUnredeemedClaimInvite(getServerDirectDb())),
    getMaintenanceState: async () => (await publishingMaintenanceController.getState()).state,
  });
  // Route registration is deferred until the remote-host stream is composed
  // below. The provider itself is independent of that ordering.
  const getMaintenanceStatusEventForWs = async () => {
    try {
      const snapshot = await publishingMaintenanceController.getState();
      return buildMaintenanceStatusEvent(snapshot);
    } catch (err) {
      warn(
        `[ws] maintenance.status snapshot read failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  };

  // Local Desktop session state remains separate from Full
  // Workstation. The controller is created before the relay registry so its
  // routes can close over the authoritative registry once it is assigned.
  // It is never persisted and is null on unprovisioned first boot.
  let uncontainedHostCommands: UncontainedHostCommandsController | null = null;

  if (ownerActorId) {
    //  server posture API. Same guard as
    // authRoutes: needs an owner actor to exist (a fresh install
    // before first-boot provisioning has no owner, so the endpoint
    // returns 401 for everyone rather than surfacing an empty
    // posture).
    //
    // Audit log path matches the `logrotate(8)` / `newsyslog(5)`
    // configs shipped under `scripts/logrotate/nautilo` and
    // `scripts/newsyslog/nautilo.conf` which target
    // `~/.nautilo/logs/*.log` — keeping these in sync prevents the
    // audit log growing unbounded.
    //
    // The mutator writes the `posture_changed` row, atomically
    // writes the posture sidecar (survives restart),
    // updates the in-memory config, and broadcasts
    // `policy.changed`. The auditor writes
    // `capability_check_failed` + `pin_check_failed` rows for the
    // 403 / 401 branches.
    const sidecarPath = join(homedir(), ".nautilo", "posture.json");
    const auditEvent = (event: Parameters<typeof writeSecurityAuditEvent>[1]) => {
      try {
        writeSecurityAuditEvent(securityAuditLogPath, event);
      } catch (err) {
        warn(
          `[security-posture] audit write failed for ` +
            `${event.kind}: ${String(err)}`,
        );
      }
      return Promise.resolve();
    };

    authRoutes(app, {
      pinProvider,
      ownerActorId,
      ownerId,
      auditEvent,
      policyResolver,
      // `defaultAgentId` dep is dropped; routes read
      // `request.memoryEnvelope?.agentId` per-call.
      unlockVaultWithPin: async (pinUtf8: string) => {
        await connectionVault.unlock({ pinUtf8 });
      },
    });
    accountRoutes(app, { pinProvider, auditEvent });
    logtoInternalRoutes(app, { auditEvent });
    const uncontainedHostServerBindingId = getServerHostname();
    uncontainedHostCommands = new UncontainedHostCommandsController({
      pinProvider,
      getAllowUncontainedHostCommands: () =>
        readPostureSidecar(sidecarPath)?.allowUncontainedHostCommands ?? false,
      getLiveRelayBinding: ({ userId, relayId, desktopSessionId }) => {
        const matches = relayRegistry.snapshotForUser(userId).filter((snapshot) =>
          snapshot.relayId === relayId &&
          snapshot.desktopSessionId === desktopSessionId &&
          snapshot.capabilities.profile === "desktop-agent",
        );
        if (matches.length !== 1) return null;
        const snapshot = matches[0]!;
        return {
          userId: snapshot.userId,
          serverBindingId: uncontainedHostServerBindingId,
          relayId: snapshot.relayId,
          desktopSessionId,
          pairingGeneration: snapshot.pairingGeneration,
          capabilityRevision: snapshot.capabilityRevision,
        };
      },
      auditEvent,
    });
    securityRoutes(app, {
      pinProvider,
      auditLogPath: securityAuditLogPath,
      mutatePosture: createPostureMutator({ auditLogPath: securityAuditLogPath, sidecarPath }),
      auditEvent,
      //  real Capability-store lookup. The
      // owner-actor heuristic is gone; household/teammate/guest
      // actors get 403s based on their actual Role bundle. Post-
      //  caps are keyed on user_id (not actor_id); routes use
      // `request.sessionUserId` from the trust preHandler.
      getCapabilities: (userId) => getUserCapabilities(userId),
      getAllowUncontainedHostCommands: () =>
        readPostureSidecar(sidecarPath)?.allowUncontainedHostCommands ?? false,
      uncontainedHostCommands,
    });
  }

  chatRoutes(app, {
    ...defaultChatRoutesDeps,
    ...(policyResolver
      ? {
          buildEnvelopeForRoom: (
            actorId: string,
            laneKey: string,
            agentId: string,
            roomId: string,
          ) => policyResolver.buildEnvelope(actorId, laneKey, agentId, roomId),
        }
      : {}),
    ...options?.chatRoutesDeps,
  });
  const eventFeed = createEventFeed({
    storage: createEventFeedStorage(getServerDirectDb()),
    warn: ({ operation, code }) => warn(`[event-feed] ${operation}: ${code}`),
    onChanged: ({ userIds }) => {
      for (const userId of userIds) publishEventFeedChanged(userId);
    },
  });
  const humanMembershipEventProducer = createHumanMembershipEventProducer({
    feed: eventFeed,
    listHumanUserIdsInRoom,
    warn: (message) => warn(`[event-feed] ${message}`),
  });
  const artifactEventProducer = createArtifactEventProducer({
    feed: eventFeed, resolveAuthor: resolveArtifactFeedAuthor,
    resolvePeople: resolveArtifactFeedPeople, resolveCreationRoom: resolveArtifactCreationRoom,
    listHumanUserIdsInRoom, warn: (message) => warn(`[event-feed] ${message}`),
  });
  roomsRoutes(
    app,
    undefined,
    liveShadowMessageComposition.protectedEdit,
    humanMembershipEventProducer,
  );
  humanBlockRoutes(app);
  contentReportRoutes(app);
  mobileUserAgreementRoutes(app);
  registerProductionDomainKeyAuthority(app);
  liveShadowMessageRoutes(app, {
    composition: liveShadowMessageComposition,
    clientSessions: {
      inspect: (input) => clientActionBindingRegistry.inspectLiveSession(input),
    },
  });
  if (liveShadowMessageComposition.pendingAttention !== undefined) {
    foregroundPendingAttentionRoutes(app, {
      service: liveShadowMessageComposition.pendingAttention,
      clientSessions: {
        inspect: (input) => clientActionBindingRegistry.inspectLiveSession(input),
      },
    });
  }
  messagesReadStateRoutes(app);
  modelControlSelectionRoutes(app);
  notificationPreferenceRoutes(app);
  eventFeedRoutes(app, {
    feed: eventFeed,
    resolveActorNames: resolveArtifactFeedActorNames,
  });
  eventFeedPreferenceRoutes(app, {
    preferences: createEventFeedPreferenceStore(getServerDirectDb()),
    changed: publishEventFeedChanged,
  });
  pushNotificationRoutes(app);
  usersPresenceRoutes(app);
  usersAvatarRoutes(app);
  agentMembersRoutes(app);
  const prepareUncontainedHostCommandsMembershipRemoval = async (input: {
    readonly userId: string;
    readonly groupId: string;
    readonly actorId: string;
  }): Promise<(() => Promise<boolean>) | null> => {
    return await uncontainedHostCommands?.prepareMembershipRemoval(input) ?? null;
  };
  groupMembersRoutes(app, {
    prepareMembershipRemoval: prepareUncontainedHostCommandsMembershipRemoval,
  });
  adminUsersRoutes(app);
  // read-only access-control endpoints (self + admin
  // target/catalogue). Registered after the admin-users surface; relies on
  // the default `policy` bearer resolution depth (no depth-config edit).
  accessControlReadRoutes(app);
  // preview/apply mutation engine (custom Role/Group
  // CRUD + capability/Role assignment + membership, all through one shared
  // command engine with anti-escalation, protected-definition, protected-
  // cap, and stale-preview enforcement).
  accessControlMutationRoutes(app, {
    prepareMembershipRemoval: prepareUncontainedHostCommandsMembershipRemoval,
  });
  costsRoutes(app);
  memoryStatusRoutes(app, memoryReviewRuntime);
  stenographerStatusRoutes(app, {
    queryStatus: (input) =>
      queryStenographerAdminStatus(input, getServerDirectDb()),
    queryProtectionStatus: async (input) =>
      readPostgresStenographerProtectionStatus({
        product: getServerDirectDb(),
        crypto: await stenographerProtectionCryptoHandle(),
        ...input,
      }),
  });
  reflectionStatusRoutes(app, {
    queryStatus: (input) =>
      queryReflectionAdminStatus({
        ...input,
        scheduler: reflectionSleepController.getHealth()
          ?? disabledReflectionSemanticSchedulerStatus(
            REFLECTION_SEMANTIC_RUNTIME_POLICY_V1.scanIntervalMilliseconds,
          ),
      }, getServerDirectDb()),
    queryAuthorityStatus: async (input) =>
      readPostgresReflectionAuthorityStatus({
        product: getServerDirectDb(),
        crypto: await stenographerProtectionCryptoHandle(),
        ...input,
      }),
  });
  adminRoomsRoutes(app);
  invokeDirectRoutes(app);
  jobRoutes(app, {
    stopTasksForRoom: async (ownerId, roomId) => {
      const stoppableTasks = await listStoppableTasksForOwnerRoom(
        getServerDirectDb(),
        ownerId,
        roomId,
      );
      let stopped = 0;
      for (const task of stoppableTasks) {
        const result = await runtimeStopTask(taskLifecycleDeps(), task.id);
        if (result.ok && result.status === "cancelled") stopped += 1;
      }
      return stopped;
    },
  });
  //  (Wave 2 task 2.2.2) — operator maintenance API (enter/status/renew/
  // applying/cancel/complete). Shares the privileged setup trust boundary
  // with the release-readiness route (loopback OR constant-time bootstrap
  // bearer); NOT exposed to ordinary room-user sessions. The controller
  // owns operation ownership + hard expiry; the route only renders payload-
  // free state + aggregate counts. Registered alongside the jobs routes so
  // the maintenance gate (installed above) is already in effect.
  operatorMaintenanceRoutes(app, {
    controller: publishingMaintenanceController,
    jobManager,
    countAcceptedWork: () => countAcceptedWorkWith(getServerDirectDb()),
    countActiveTaskWork: () => countActiveTaskWorkWith(getServerDirectDb()),
  });
  profileAvatarRoutes(app, { ownerId });
  agentPhotoLibraryRoutes(app);
  profileRoutes(app, { ownerId });
  //  Wave 1A — self-service portable Genie profile bundle HTTP surface
  // (export / media / dry-run plan / staged avatar upload / commit gate).
  // Session-authenticated, scoped to the caller's own personal Agent.
  // Wave 3 also reconciles durable artifact finalization journals after a
  // crash; it runs asynchronously and never blocks app readiness.
  profileBundleRoutes(app, { ownerId, reconcileOnRouteInit: true });
  const ordinaryContentAccess = createServerContentAccessRuntime({
    observeCommittedArtifactShares: artifactEventProducer.shared,
  });
  defaultPostModelDeps.ordinaryContentAccessForState = createAgentContentAccessForState(ordinaryContentAccess);
  ordinaryContentAccessRecoveryRoutes(app, { ordinaryContentAccessForState: defaultPostModelDeps.ordinaryContentAccessForState });
  taskContentAccessRecoveryRoutes(app, { ordinaryContentAccessForState: defaultPostModelDeps.ordinaryContentAccessForState });
  memoryRoutes(app, options?.protectedMemoryComposition
    ?? createProductionHumanMemoryRouteFactory({
      wakeRecovery: () => foregroundMemoryEffectRecovery.wake(),
    }), enforceRegisteredStrictShadowBoundary, {
    ordinaryAccess: ordinaryContentAccess,
    loadEncryptionPolicy: currentStrictShadowPolicy,
  });
  registerHumanMemoryReadObservationRoutes(app);
  contentAccessRoutes(app, { coordinator: ordinaryContentAccess });
  skillsRoutes(app);
  commandsRoutes(app);
  workspaceArtifactsRoutes(app, {
    onArtifactCreated: artifactEventProducer.created,
    contentAccessCoordinator: ordinaryContentAccess,
    buildCurrentEnvelope: async (actorId, agentId, roomId) => {
      if (!policyResolver) throw new Error("Policy resolver is unavailable for Workspace SSE reauthorization");
      const room = await findRoomForUserMember(roomId, actorId);
      if (!room) {
        throw new Error("Workspace SSE Room membership was revoked");
      }
      return policyResolver.buildEnvelope(actorId, "workbench", agentId, roomId);
    },
  });
  slideTemplateRoutes(app);
  mediaGenerationsRoutes(app);
  videoGenerationRoutes(app);
  // Office (Collabora/WOPI) routes are only mounted when the office feature
  // flag is on. With it off, /wopi/* and /office-engine/* do not exist.
  if (fromRuntimeConfig().nautilo_office_enabled) {
    // quarantined WOPI read module (coolwsd → /wopi/files/:id).
    // The `/wopi/*` routes bypass user-session auth in the preHandler
    // below and are gated by a per-artifact access_token minted by
    // `POST /api/office/wopi-token` (which IS user-authed).
    wopiRoutes(app, {
      validateAdmissionProvenance: async (provenance) => {
        const policy = await getEncryptionTransitionPolicy(getServerDirectDb());
        if (policy.mode === "plaintext_only") return true;
        if (provenance.kind === "server_agent") return true;
        if (provenance.kind !== "human_device") return false;
        const current = await deviceAdmissionComposition
          .currentAuthorityForDelegation({
            userId: provenance.userId,
            humanActorId: provenance.humanActorId,
            deviceId: provenance.deviceId,
          });
        if (current === null) return false;
        return current.deviceGeneration === provenance.deviceGeneration
          && current.serverInstanceId === provenance.serverInstanceId
          && current.lineageGeneration === provenance.lineageGeneration
          && current.epoch === provenance.epoch
          && current.securityRevision === provenance.securityRevision
          && current.headDigest.length === provenance.headDigest.length
          && current.headDigest.every(
            (value, index) => value === provenance.headDigest[index],
          );
      },
    });
    // same-origin coolwsd reverse proxy. Mounts the
    // engine under `/office-engine/*` so the editor iframe becomes
    // same-origin with the Nautilo server. The prefix bypasses user-
    // session auth in the preHandler above (engine assets + WS); doc
    // access stays gated by the WOPI access_token.
    officeProxyRoutes(app);
  }
  messageAttachmentRoutes(app);
  await seedFirstPartyApps();
  let liveLocalDocumentAuthority: LiveLocalDocumentAuthority | null = null;
  await registerInstalledAppTools(getAppsRoot(), {
    ...createLiveAppToolRegistrationOptions(() => liveLocalDocumentAuthority),
  });
  setMiniAppToolRuntime(createMiniAppToolRuntime(getAppsRoot));

  // inject the local (relay-tier) MCP tool runtime so the
  // `manage_local_mcp` agent tool can register / enable / disable / remove /
  // list / status a user's own local MCPs. Hard-scoped to the caller's own relay
  // (server-tier mutations refused in the service). Mutations audit via the
  // same `security-audit.log` writer the mutation route uses.
  setLocalMcpToolRuntime(
    createLocalMcpToolRuntime({
      db: getServerDirectDb(),
      audit: (event) => {
        try {
          writeSecurityAuditEvent(securityAuditLogPath, event);
        } catch (err) {
          warn(
            `[manage_local_mcp] audit write failed for ${event.kind}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    }),
  );

  // server-side MCP host. Only runs when a ToolCatalog is
  // installed (real boot via bin/nautilo-server); the test app-fixture
  // installs no catalog, so this is a no-op there. Never blocks boot:
  // a failed MCP server is logged and skipped inside startMcpHost.
  const mcpCatalog = getToolCatalog();
  if (mcpCatalog) {
    try {
      const mcpManager = await startMcpHost({ catalog: mcpCatalog });
      // install the live manager into the process
      // singleton so the `/api/mcp-servers` mutation route can trigger
      // a hot-reload `reconcile` after a config write. Cleared in the
      // onClose hook alongside `stopAll()` so a post-shutdown caller
      // best-effort skips the reconcile instead of touching a torn-
      // down manager.
      setMcpClientManager(mcpManager);
      app.addHook("onClose", async () => {
        await mcpManager.stopAll();
        setMcpClientManager(null);
      });
    } catch (e) {
      warn(
        `[mcp] host startup failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const liveReviewLifecycle: LiveReviewLifecyclePort = {
    isPendingReview: isPendingTaskWriterReviewProposal,
    reviewProposalState: taskWriterReviewProposalState,
    admitAcceptedProposal: claimTaskWriterReviewAcceptance,
    releaseAcceptanceClaim: (input) => {
      releaseTaskWriterReviewAcceptanceClaim(input);
    },
    reserveAcceptedWorkspaceOperation: async (input, admissionBinding) => {
      const binding = admissionBinding as TaskWriterReviewBinding;
      if (
        binding.ownerId !== input.ownerId ||
        binding.sessionId !== input.sessionId ||
        binding.proposalId !== input.proposalId ||
        !liveDocumentVersionEquals(binding.documentVersion, input.documentVersion)
      ) return { status: "conflict" };
      return reserveTaskWriterReviewWorkspaceOperation(getServerDirectDb(), {
        taskId: binding.taskId,
        taskRunId: binding.taskRunId,
        proposalId: binding.proposalId,
        operationId: input.operationId,
        clientMutationId: input.clientMutationId,
        artifactInternalId: input.artifactInternalId,
      });
    },
    releaseAcceptedWorkspaceOperation: async (input, admissionBinding) => {
      const binding = admissionBinding as TaskWriterReviewBinding;
      if (
        binding.ownerId !== input.ownerId ||
        binding.sessionId !== input.sessionId ||
        binding.proposalId !== input.proposalId ||
        !liveDocumentVersionEquals(binding.documentVersion, input.documentVersion)
      ) return;
      await releaseTaskWriterReviewWorkspaceOperation(getServerDirectDb(), {
        taskId: binding.taskId,
        taskRunId: binding.taskRunId,
        proposalId: binding.proposalId,
        operationId: input.operationId,
        clientMutationId: input.clientMutationId,
        artifactInternalId: input.artifactInternalId,
      });
    },
    recordAcceptedReceipt: async (input, admissionBinding) => {
      const binding = admissionBinding as TaskWriterReviewBinding;
      if (
        binding.ownerId !== input.ownerId ||
        binding.sessionId !== input.sessionId ||
        binding.proposalId !== input.proposalId ||
        !liveDocumentVersionEquals(binding.documentVersion, input.documentVersion)
      ) return { status: "conflict" };
      // Receipt only: the route advances the session registry and the
      // process-local live fence before resolving/requeueing this Task.
      const receipt = await recordTaskWriterReviewAcceptedReceipt(getServerDirectDb(), {
        taskId: binding.taskId,
        taskRunId: binding.taskRunId,
        proposalId: binding.proposalId,
        resultRevision: input.resultDocumentVersion,
      });
      if (receipt.status === "conflict") return { status: "conflict" };
      if (receipt.status === "not_found" || receipt.status === "stale") {
        return { status: "not_found" };
      }
      return { status: "recorded" };
    },
    advanceAcceptedReviewContinuation: (opaqueBinding, resultDocumentVersion) => {
      const binding = opaqueBinding as TaskWriterReviewBinding;
      if (
        binding.resolution !== null &&
        (binding.resolution.outcome !== "accepted" ||
          !liveDocumentVersionEquals(binding.resolution.documentVersion, resultDocumentVersion))
      ) return false;
      const advanced = advanceTaskLiveMiniAppBindingDocumentVersion({
        taskId: binding.taskId,
        ownerId: binding.ownerId,
        sessionId: binding.sessionId,
        previousDocumentVersion: binding.documentVersion,
        resultDocumentVersion,
      });
      return advanced;
    },
    failAcceptedReviewContinuation: (opaqueBinding, code) =>
      failTaskWriterReviewAcceptedContinuation(
        opaqueBinding as TaskWriterReviewBinding,
        code,
      ),
    resolveReview: resolveTaskWriterReviewProposal,
    failReview: (input, code) => resolveTaskWriterReviewProposal({
      ...input,
      resolution: { outcome: "failed", code },
    }),
    finalizeReview: async (binding) => {
      await finalizeTaskWriterReviewResolution(
        getServerDirectDb(),
        binding as TaskWriterReviewBinding,
      );
    },
    failReviewsForSession: failTaskWriterReviewsForSession,
  };
  /**
   * A capability close is not merely a renderer event: it must resolve the
   * exact Task-owned review before the process-local registry drops proposal
   * lineage. The synchronous resolution removes the visible owner; async
   * durable finalization is deliberately idempotent for model-completion
   * races.
   */
  const closeLiveTaskWriterReviews = (sessionId: string, code: string): void => {
    const bindings = liveReviewLifecycle.failReviewsForSession(sessionId, code);
    for (const binding of bindings) {
      void liveReviewLifecycle.finalizeReview(binding).catch((error) => {
        warn(`[live-writer-review] close finalization failed for session=${sessionId}: ${String(error)}`);
      });
    }
  };
  const closeLiveWriterSessionsForRelay = (input: {
    userId: string;
    relayId: string;
  }): void => {
    closeLiveMiniAppSessionsForRelay(input, {
      registry: liveMiniAppSessionRegistry,
      onSessionClosing: (sessionId) => {
        closeLiveTaskWriterReviews(sessionId, "LIVE_WRITER_REVIEW_RELAY_DISCONNECTED");
      },
      publish: (event, userId) =>
        broadcast(event as never, { kind: "user", userId }),
    });
  };
  liveMiniAppSessionRegistry.setExpiryObserver((sessionId) => {
    closeLiveTaskWriterReviews(sessionId, "LIVE_WRITER_REVIEW_SESSION_EXPIRED");
  });
  appRoutes(app, {
    getLiveLocalDocumentAuthority: () => liveLocalDocumentAuthority,
    liveReviewLifecycle,
    acceptLiveArtifactProposal: createLiveArtifactProposalAcceptance(),
  });
  let connectedAppCatalog: ResolvedConnectionProviderCatalog = {
    catalog: BUNDLED_CONNECTION_PROVIDER_CATALOG,
    source: "bundled",
    reason: null,
  };
  let hostedConnectedAppDriver: OomolHostedConnectedAppDriver | null = null;
  const hostedProjectKey = process.env["NAUTILO_OOMOL_PROJECT_API_KEY"]?.trim();
  if (hostedProjectKey) {
    try {
      hostedConnectedAppDriver = new OomolHostedConnectedAppDriver(hostedProjectKey);
    } catch {
      warn("[connected-apps] hosted driver configuration rejected");
    }
  }
  const cloudManagedConnections = isCloudManagedDeployment();
  const localConnectedAppDriver = cloudManagedConnections
    ? null
    : new OpenConnectorLocalConnectedAppDriver(
        fromRuntimeConfig().nautilo_openconnector_base_url,
        {
          store: async (input) => {
            const vaultScope = {
              readableNamespaceIds: [input.namespaceId],
              defaultNamespaceId: input.namespaceId,
              agentId: input.agentId,
            };
            await connectionVault.set(
              { service: "nautilo-connected-apps", field: input.field },
              Buffer.from(input.value, "utf8"),
              vaultScope,
              {
                namespaceId: input.namespaceId,
                agentId: input.agentId,
                authoredByUserId: input.authoredByUserId,
              },
            );
            const record = (await connectionVault.list(vaultScope)).find((candidate) =>
              candidate.ref.service === "nautilo-connected-apps" && candidate.ref.field === input.field);
            if (!record) throw new Error("CONNECTED_APP_VAULT_STORE_FAILED");
            return {
              id: record.id,
              namespaceId: input.namespaceId,
              agentId: input.agentId,
              field: input.field,
            };
          },
          read: async (ref) => {
            const value = await connectionVault.get(
              { id: ref.id, service: "nautilo-connected-apps", field: ref.field },
              {
                readableNamespaceIds: [ref.namespaceId],
                defaultNamespaceId: ref.namespaceId,
                agentId: ref.agentId,
              },
            );
            return value ? Buffer.from(value).toString("utf8") : null;
          },
          delete: async (ref) => {
            await connectionVault.delete(
              { id: ref.id, service: "nautilo-connected-apps", field: ref.field },
              {
                readableNamespaceIds: [ref.namespaceId],
                defaultNamespaceId: ref.namespaceId,
                agentId: ref.agentId,
              },
            );
          },
        },
      );
  const connectedAppStore: ConnectedAppStore = {
      getProfile: (scope, providerId, driverKind) =>
        getConnectedAppProfile(getServerDirectDb(), scope, providerId, driverKind),
      upsertProfile: (input) => upsertConnectedAppProfile(getServerDirectDb(), input),
      markUserProfilesState: (userId, providerId, driverKind, status, lastErrorCode) =>
        markConnectedAppUserProfilesState(
          getServerDirectDb(),
          userId,
          providerId,
          driverKind,
          status,
          lastErrorCode,
        ),
      deleteProfile: (scope, providerId, driverKind) =>
        deleteConnectedAppProfile(getServerDirectDb(), scope, providerId, driverKind),
      getProviderConfig: (providerId, driverKind) =>
        getConnectedAppProviderConfig(getServerDirectDb(), providerId, driverKind),
      upsertProviderConfig: (input) =>
        upsertConnectedAppProviderConfig(getServerDirectDb(), input),
      findActiveAttempt: (scope, providerId, driverKind) =>
        findActiveConnectedAppOauthAttempt(getServerDirectDb(), scope, providerId, driverKind),
      expireAttempts: (scope, providerId, driverKind) =>
        expireStaleConnectedAppOauthAttempts(getServerDirectDb(), scope, providerId, driverKind),
      insertAttempt: (input) => insertConnectedAppOauthAttempt(getServerDirectDb(), input),
      getAttempt: (scope, attemptId) =>
        getConnectedAppOauthAttempt(getServerDirectDb(), scope, attemptId),
      finishAttempt: (scope, attemptId, status, errorCode) =>
        finishConnectedAppOauthAttempt(getServerDirectDb(), scope, attemptId, status, errorCode),
    };
  let connectedAppPreviewKey: Buffer | undefined;
  try {
    connectedAppPreviewKey = deriveConnectedAppPreviewKey(requirePairingPepper());
  } catch {
    if (!options?.silent) {
      warn("[connected-apps] durable preview references unavailable; using a process-local key");
    }
  }
  const connectedAppResultPresenter = new ConnectedAppResultPresenter(
    globalThis.fetch,
    connectedAppPreviewKey,
  );
  const createConnectedAppServices = (resolved: ResolvedConnectionProviderCatalog) =>
    connectedAppProviderDefinitions(resolved.catalog).map((provider) =>
      new ConnectedAppService(
        connectedAppStore,
        resolved,
        resolvePublicBaseUrl(options),
        hostedConnectedAppDriver,
        cloudManagedConnections ? "oomol_hosted" : "openconnector_local",
        localConnectedAppDriver,
        provider,
        connectedAppResultPresenter,
      ));
  let connectedAppServices = createConnectedAppServices(connectedAppCatalog);
  if (mcpCatalog) {
    syncConnectedAppOperationTools(mcpCatalog, connectedAppCatalog.catalog.providers);
  }
  connectedAppsRoutes(app, () => connectedAppServices, {
    resultPresenter: connectedAppResultPresenter,
  });
  setConnectedAppActionRuntime({
    eligibleProviderIds: async (scope) => {
      const providerIds = await Promise.all(connectedAppServices.map(async (service) =>
        (await service.isConnected(scope)) ? service.providerId : null));
      return providerIds.filter((providerId): providerId is NonNullable<typeof providerId> => providerId !== null);
    },
    execute: async (input) => {
      const service = connectedAppServices.find((candidate) => candidate.providerId === input.providerId);
      if (!service) throw new Error("CONNECTED_APP_PROVIDER_NOT_FOUND");
      return service.execute({
        scope: { userId: input.userId, namespaceId: input.namespaceId },
        causalHumanUserId: input.causalHumanUserId,
        operationId: input.operationId,
        effect: input.effect,
        args: input.input,
        artifactImporter: async (output) => {
          const saved = await createWorkspaceBinaryArtifactFromStream({
            envelope: input.memoryAccessEnvelope,
            actor: { kind: "agent", agentId: input.memoryAccessEnvelope.agentId },
            namespaceId: input.namespaceId,
            logicalPath: output.logicalPath,
            mimeType: output.mimeType,
            chunks: output.chunks,
            overwrite: true,
          });
          return saved.ok
            ? {
                artifactId: saved.artifactId,
                path: saved.displayPath,
                mime: output.mimeType,
                bytes: saved.size,
              }
            : null;
        },
        artifactInputResolver: ({ artifactPath, signal }) => openWorkspaceArtifactInput({
          envelope: input.memoryAccessEnvelope,
          artifactPath,
          ...(signal ? { signal } : {}),
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    },
  });
  app.addHook("onListen", () => {
    void loadConnectionProviderCatalog().then((resolved) => {
      const nextServices = createConnectedAppServices(resolved);
      if (mcpCatalog) syncConnectedAppOperationTools(mcpCatalog, resolved.catalog.providers);
      connectedAppCatalog = resolved;
      connectedAppServices = nextServices;
    }).catch((error) => {
      warn(`[connected-apps] catalogue activation rejected: ${
        error instanceof Error ? error.message : String(error)}`);
    });
  });
  configRoutes(app);
  explainerMediaRoutes(app);
  connectionRoutes(app, {
    vault: connectionVault,
    auditConnection: writeConnectionVaultAudit,
  });
  //  first-house operator policy. These are Nautilo execution choices,
  // deliberately separate from the provider's browser/session parameters.
  const connectedWebAccountStore = createConnectedWebAccountStore(getServerDirectDb());
  const connectedWebAccountBrowser = new BrowserUseCloudAdapter({ serverKeys: process.env });
  let connectedWebOperationRuntime: ReturnType<typeof createConnectedWebOperationLiveRuntime> | undefined;
  let connectedWebOperationDirectRuntime: ReturnType<typeof createConnectedWebOperationDirectProductionRuntime> | null = null;
  // Listener-owned only: the read runtime closes over this nullable cell so
  // createApp/inject never reaches DB-backed stable secret material.
  let connectedWebOperationSecrets: ConnectedWebOperationSecrets | null = null;
  const connectedWebAccountController = new ConnectedWebAccountController({
    stopDirectOperations: async (input) => {
      for (const operation of await connectedWebAccountStore.listDirectOperationsForRecovery(input)) {
        const stopped = await connectedWebOperationDirectRuntime?.stopForOwner({
          ownerUserId: input.ownerUserId, operationId: operation.id,
        });
        if (!stopped || (stopped.driver === "direct" && stopped.lifecycle !== "terminal")) return false;
      }
      return true;
    },
    store: connectedWebAccountStore,
    browser: connectedWebAccountBrowser,
    navigator: browserUseCdpNavigator,
  });
  const connectedWebOperationOwnerController = new ConnectedWebOperationOwnerController({
    store: connectedWebAccountStore,
    provider: connectedWebAccountBrowser,
    // Same listener-owned codec as admission/supervision. This remains null
    // for createApp/inject, so route registration never reads stable secrets.
    secrets: () => connectedWebOperationSecrets,
    direct: () => connectedWebOperationDirectRuntime,
  });
  setConnectedWebAccountReadToolRuntime(createConnectedWebAccountReadProductionRuntime({
    db: getServerDirectDb(),
    store: connectedWebAccountStore,
    provider: connectedWebAccountBrowser,
    policy: {
      maxCostUsd: CONNECTED_WEB_ACCOUNT_READ_MAX_COST_USD,
      pollIntervalMs: CONNECTED_WEB_ACCOUNT_READ_POLL_INTERVAL_MS,
    },
    secrets: () => connectedWebOperationSecrets,
  }));
  setConnectedWebAccountActionToolRuntime(createConnectedWebAccountActionProductionRuntime({
    db: getServerDirectDb(),
    store: connectedWebAccountStore,
    provider: connectedWebAccountBrowser,
    policy: {
      maxCostUsd: CONNECTED_WEB_ACCOUNT_ACTION_MAX_COST_USD,
      pollIntervalMs: CONNECTED_WEB_ACCOUNT_ACTION_POLL_INTERVAL_MS,
    },
  }));
  connectedWebAccountRoutes(app, { controller: connectedWebAccountController });
  connectedWebOperationRoutes(app, { controller: connectedWebOperationOwnerController });
  // Reconcile every provider resource whose identifier reached durable state.
  // Browser Use V4 currently documents neither create idempotency nor resource
  // enumeration, so the smaller post-create/pre-activation crash window is a
  // named release gate rather than something this hook pretends to recover.
  app.addHook("onListen", async () => {
    void connectedWebAccountController.reconcileStaleExecutions().catch(() => {
      warn("[connected-web-accounts] stale execution reconciliation deferred");
    });
    void connectedWebAccountController.reconcileRevokedProfileCleanup().catch(() => {
      warn("[connected-web-accounts] revoked profile cleanup reconciliation deferred");
    });
    try {
      connectedWebOperationSecrets ??= new ConnectedWebOperationSecrets({ stableServerSecret: requirePairingPepper() });
      if (!connectedWebOperationRuntime) {
        try {
          connectedWebOperationDirectRuntime = createConnectedWebOperationDirectProductionRuntime({
            db: getServerDirectDb(), store: connectedWebAccountStore, provider: connectedWebAccountBrowser,
            secrets: connectedWebOperationSecrets, instanceIdentity: paths.rootDir,
          });
        } catch {
          // Direct control is an optional secondary driver. Its local harness
          // must never disable hosted supervision or management controls.
          warn("[connected-web-operation] direct browser control unavailable at server start");
        }
        connectedWebOperationRuntime = createConnectedWebOperationLiveRuntime({
          db: getServerDirectDb(), store: connectedWebAccountStore, provider: connectedWebAccountBrowser,
          // The listener owns this stable key material. The live runtime derives
          // one domain-separated codec and shares it between management and the
          // durable supervisor without exposing it to routes or Agent context.
          secrets: connectedWebOperationSecrets,
          ...(connectedWebOperationDirectRuntime === null ? {} : { directRuntime: connectedWebOperationDirectRuntime }),
        });
      }
      await connectedWebOperationRuntime.start();
    } catch {
      // Operation claims remain durable. Keep the HTTP server live rather
      // than logging provider coordinates when its secret is unavailable.
      warn("[connected-web-operation] durable supervisor unavailable at server start");
    }
  });
  app.addHook("onClose", async () => { await connectedWebOperationRuntime?.stop(); });
  connectionProxyRoutes(app, {
    vault: connectionVault,
    auditConnection: writeConnectionVaultAudit,
  });
  setupRoutes(app);
  setupStatusRoutes(app);
  serverIconRoutes(app);
  serverModelsRoutes(app, { onConfigUpdated: () => memoryReviewRuntime.wake() });
  serverContextRoutes(app, {
    onConfigUpdated: async (config) => {
      memoryReviewRuntime.wake();
      await reflectionSleepController.setEnabled(config.reflectionSleepEnabled);
    },
  });
  encryptionTransitionRoutes(app, {
    publishPolicyChanged: publishEncryptionPolicyChanged,
    maintenanceController: publishingMaintenanceController,
    getExecutableActivity: async () => {
      const jobs = jobManager.getExecutableJobWorkSummary();
      const [acceptedWork, tasks] = await Promise.all([
        countAcceptedWorkWith(getServerDirectDb()),
        countActiveTaskWorkWith(getServerDirectDb()),
      ]);
      return {
        ...jobs,
        acceptedWork,
        runningTaskRuns: tasks.runningTaskRuns,
        claimedTasks: tasks.claimedTasks,
      };
    },
    flushPendingBroadcasts: flushPendingWebSocketBroadcasts,
  });
  personalEncryptionCoverageRoutes(app);
  messageBackfillRoutes(app);
  backgroundAuthorizationRoutes(app, createProductionBackgroundAuthorizationComposition({
    wakeProtectedTask: () => getTaskObserver()?.kick(),
  }));
  deviceAdmissionRoutes(app, {
    composition: deviceAdmissionComposition,
    requiresCryptoDevice: async () =>
      (await getEncryptionTransitionPolicy(getServerDirectDb())).mode
        !== "plaintext_only",
  });
  protectedInitialDeviceReadinessRoutes(app, {
    composition: createProductionInitialDeviceReadinessComposition(),
  });
  humanDeviceMembershipRoutes(
    app,
    createProductionHumanDeviceMembershipComposition(pinProvider),
  );
  // server-tier MCP config mutation
  // API. `manage_server_security`-gated; no PIN. Audit writer is a
  // closure over the same `securityAuditLogPath` the posture route
  // uses; `getCapabilities` wires the real `getUserCapabilities` so
  // the gate reflects the caller's actual Role bundle.
  mcpServersRoutes(app, {
    getCapabilities: (userId) => getUserCapabilities(userId),
    auditEvent: (event) => {
      try {
        writeSecurityAuditEvent(securityAuditLogPath, event);
      } catch (err) {
        warn(
          `[mcp-servers] audit write failed for ${event.kind}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return Promise.resolve();
    },
  });
  integrationsGoogleRoutes(app, {
    auditEvent: (event) => {
      writeSecurityAuditEvent(securityAuditLogPath, event);
    },
  });
  serverProfileRoutes(app);
  ownerRoutes(app, { ownerId, pinProvider });
  // M042C — WebFinger + public handle-indexed profile. Registered
  // after `profileRoutes` so Fastify's route-registration ordering
  // doesn't collide with `/api/profile` (parameterized vs fixed).
  webfingerRoutes(app);
  logFederationReadinessWarning();
  if (options?.certsDir) {
    pairRoutes(app, {
      certsDir: options.certsDir,
      hostname: options.hostname ?? "nautilo.local",
      port: options.port ?? 3001,
    });
  }
  voiceRoutes(app, options?.voiceRoutesDeps);
  sttRoutes(app);
  sessionRoutes(app);

  // committed Workspace document events are delivered only by the
  // durable outbox runtime. Start it before the bus bridge so post-recovery
  // events can use the same scoped SSE lane as normal saves.
  startWorkspaceDocumentMutationOutboxRuntime();
  // durable push candidates and explicit generic test intents are
  // independently claimed from storage. This is deliberately not an event-bus
  // subscriber: a restart must never lose a committed notification candidate.
  startPushDeliveryRuntime();
  app.addHook("onClose", () => stopPushDeliveryRuntime());
  startEventBridge();
  markReady("eventBridge");

  // server-side TTS streaming. Subscribes to voice.sentence events on
  // the event bus and broadcasts voice.audio chunks via WS. No-op when
  // ELEVENLABS_API_KEY is unset.
  getTtsService().start();

  // Full Workstation access wiring.
  //
  //   `serverBindingId` is the stable server-side server identity
  //   sourced from the resolved Nautilo instance's federated hostname
  //   (see `createRelayRegistryBindingProvider` for the lifecycle
  //   contract). It is captured once at boot.
  const workstationServerBindingId = getServerHostname();
  const writeWorkstationAudit = (event: WorkstationAccessAuditEvent): void => {
    try {
      writeSecurityAuditEvent(securityAuditLogPath, {
        kind: event.kind,
        ts: event.ts,
        actorId: event.actorId,
        ip: event.ip,
        userAgent: event.userAgent,
        userId: event.userId,
        relayId: event.relayId,
        desktopSessionId: event.desktopSessionId,
        serverBindingId: event.serverBindingId,
        capabilityRevision: event.capabilityRevision,
        ...(event.denialCode !== undefined ? { denialCode: event.denialCode } : {}),
        ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
        ...(event.route !== undefined ? { route: event.route } : {}),
      });
    } catch (err) {
      warn(
        `[workstation-access] audit write failed for ${event.kind}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  const workstationSessionRegistry = new InMemoryWorkstationSessionRegistry({
    audit: writeWorkstationAudit,
  });

  //  task 3.1.2 — transient `WorkstationDispatchPlan` store. The
  // post-model override resolver admits one plan per tool-call id (binding
  // the exact active-session-bound relay); the tools node consumes it to pin
  // the relay dispatch. Plans are admission metadata only — never authority,
  // never widening `allowedRoots`. Invalidation collapses to the relay /
  // session lifecycle hooks wired below so a plan never outlives its relay
  // binding; the tools node re-validates independently at dispatch time.
  const workstationDispatchPlanRegistry = new InMemoryWorkstationDispatchPlanRegistry({
    // same-authority re-admission reads the canonical active
    // session and the live relay snapshots together. Missing or incoherent
    // snapshot state returns null: readmit must never omit grant/policy
    // revisions or reconstruct a binding from advisory relay state alone.
    getActiveBinding: ({ userId, currentFolder }) =>
      resolveActiveWorkstationDispatchBinding({
        userId,
        currentFolder,
        sessionRegistry: workstationSessionRegistry,
        relayRegistry,
      }),
  });

  // Transient relay disconnects must not clear Full Workstation Mode: a
  // reconnect with the same desktopSessionId resumes the exact session.
  // Explicit disable, logout, server switch, relay identity replacement, and
  // the future re-pair lifecycle handler clear it instead.
  //
  //  app-restart seam: when the same `(relayId, userId)` re-registers
  // with a DIFFERENT non-empty `desktopSessionId` (a new Electron
  // main-process launch), the prior Full Workstation session is bound to a
  // dead desktop session — invalidate it now, before the entry is replaced.
  // `serverBindingId` is the stable server identity captured above; the
  // `relayId` + `previousDesktopSessionId` filters pin the exact session so a
  // foreign relay's session is never touched. Transient disconnects and
  // same-session reconnects never reach this hook, so this path cannot clear
  // a session that is still live on a reconnecting relay.
  //
  //  task 3.1.2 — the same seams also invalidate `WorkstationDispatchPlan`
  // entries bound to the affected relay: `onUnregister` covers explicit
  // disconnect / socket close / heartbeat-timeout loss, and
  // `onDesktopSessionReplaced` covers the app-restart identity change. A
  // transient disconnect that re-registers with the SAME `desktopSessionId`
  // does NOT reach `onDesktopSessionReplaced`; the tools node's dispatch-time
  // re-validation still catches a plan whose relay is momentarily gone, so
  // this is fail-closed defense-in-depth, not the only gate.
  // Assigned immediately after registry construction and before the registry
  // is started or published to any route/singleton. Registry callbacks can
  // therefore never observe an uninitialized stream.
  const authorizeComputerUseAgentOwnership = createComputerUseAgentOwnershipAuthorizer(
    getServerDirectDb(),
  );
  //  authority is live only while both independently-current facts hold:
  // the authenticated Human still has desktop control and the exact Genie is
  // still that Human's canonical Agent actor. This is intentionally read on
  // every root admission, semantic call, and relay dispatch; there is no
  // cache, lease, retry, or fallback selection.
  const hasCurrentDesktopAutomationAuthority = async (
    userId: string,
    agentId: string,
  ): Promise<boolean> => {
    try {
      return (await getUserCapabilities(userId)).includes("control_desktop")
        && await authorizeComputerUseAgentOwnership({ userId, agentId });
    } catch {
      return false;
    }
  };
  const relayRegistry = new InMemoryRelayRegistry({
    authorizeDesktopAutomationDispatch: async ({ userId, agentId }) =>
      hasCurrentDesktopAutomationAuthority(userId, agentId),
    onRemotePresenceChanged: (input) => {
      const affectedUserIds = new Set<string>();
      if (input.previous !== null) affectedUserIds.add(input.previous.userId);
      if (input.current !== null) affectedUserIds.add(input.current.userId);
      for (const userId of affectedUserIds) {
        void remoteHostPresenceStream.reconcileUser(userId).catch((err) => {
          warn(
            `[remote-host-presence] registry reconciliation failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
      if (
        input.previous !== null &&
        input.current !== null &&
        input.previous.userId === input.current.userId &&
        input.previous.desktopSessionId !== null &&
        input.previous.capabilityRevision !== input.current.capabilityRevision
      ) {
        void uncontainedHostCommands?.invalidateForRelayBinding({
          userId: input.previous.userId,
          relayId: input.previous.relayId,
          desktopSessionId: input.previous.desktopSessionId,
          pairingGeneration: input.previous.pairingGeneration,
          capabilityRevision: input.previous.capabilityRevision,
          reason: "capability_revision_changed",
        }).catch((err) => {
          warn(`[uncontained-host-commands] capability invalidation failed: ${String(err)}`);
        });
      }
    },
    onDesktopSessionReplaced: (input) => {
      closeLiveWriterSessionsForRelay({
        userId: input.userId,
        relayId: input.relayId,
      });
      removeTaskReturnBindingsForRelay(input.relayId);
      void uncontainedHostCommands?.invalidateForRelayBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.previousDesktopSessionId,
        reason: "desktop_session_replaced",
      }).catch((err) => {
        warn(`[uncontained-host-commands] session invalidation failed: ${String(err)}`);
      });
      workstationSessionRegistry.invalidateForRelayBinding({
        userId: input.userId,
        serverBindingId: workstationServerBindingId,
        relayId: input.relayId,
        desktopSessionId: input.previousDesktopSessionId,
      });
      workstationDispatchPlanRegistry.invalidateForBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.previousDesktopSessionId,
      });
    },
    onPairingGenerationChanged: (input) => {
      closeLiveWriterSessionsForRelay({
        userId: input.userId,
        relayId: input.relayId,
      });
      removeTaskReturnBindingsForRelay(input.relayId);
      void uncontainedHostCommands?.invalidateForRelayBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
        pairingGeneration: input.previousPairingGeneration,
        reason: "pairing_generation_changed",
      }).catch((err) => {
        warn(`[uncontained-host-commands] pairing invalidation failed: ${String(err)}`);
      });
      //  Commit 2 — explicit re-pair: the same relay/user re-registered
      // with the SAME desktopSessionId but a DIFFERENT server-derived
      // pairingGeneration (a new validated relay-token row id). Invalidate
      // the Full Workstation session + dispatch plans bound to that relay
      // even though desktopSessionId is reused. The session is pinned by
      // the prior pairing generation via the optional filter so a session
      // already re-activated under the new generation is not touched.
      workstationSessionRegistry.invalidateForRelayBinding({
        userId: input.userId,
        serverBindingId: workstationServerBindingId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
        pairingGeneration: input.previousPairingGeneration,
      });
      workstationDispatchPlanRegistry.invalidateForBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
      });
    },
    onUnregister: (input) => {
      void uncontainedHostCommands?.invalidateForRelayBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
        reason: "relay_unregistered",
      }).catch(() => {
        warn("[uncontained-host-commands] disconnect invalidation failed");
      });
      closeLiveWriterSessionsForRelay(input);
      removeTaskReturnBindingsForRelay(input.relayId);
      // Headless relays (null desktopSessionId) never carry workstation
      // plans; guard the invalidate call for those.
      if (input.desktopSessionId === null) return;
      workstationDispatchPlanRegistry.invalidateForBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
      });
    },
    //  reconnect/session split-brain fix — fail-closed snapshot-loss
    // seam. When a desktop relay's advisory Workstation Profile binding
    // snapshot transitions present→absent (reconnect with frozen
    // pre-activation caps, profile deactivation, a transient controller
    // unavailability during a capability refresh, or a headless re-register
    // of a previously-desktop relay), invalidate any Full Workstation
    // session + dispatch plans bound to that relay's existing binding
    // identity BEFORE the registry entry reflects the cleared snapshot. A
    // session must never survive the loss of its relay's profile binding
    // snapshot, or the no-plan `run_shell` gate would skip and dispatch an
    // unbound generic shell under the active session. The hook is pinned by
    // the prior pairing generation so a session already re-activated under
    // a new generation is not touched.
    onWorkstationProfileSnapshotCleared: (input) => {
      workstationSessionRegistry.invalidateForRelayBinding({
        userId: input.userId,
        serverBindingId: workstationServerBindingId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
        ...(input.pairingGeneration !== undefined
          ? { pairingGeneration: input.pairingGeneration }
          : {}),
      });
      workstationDispatchPlanRegistry.invalidateForBinding({
        userId: input.userId,
        relayId: input.relayId,
        desktopSessionId: input.desktopSessionId,
      });
    },
    //  reconnect/session split-brain fix — expose the LIVE active Full
    // Workstation session to the agent tools node so the no-plan `run_shell`
    // gate fails closed for an active session bound to the selected relay
    // even when the relay's profile snapshot is absent (defense in depth
    // behind the snapshot-cleared invalidation seam). The relay registry
    // never owns session state; it delegates the lookup to the session
    // registry built above.
    getActiveWorkstationSession: (userId) => {
      const session = workstationSessionRegistry.get(userId);
      if (session === null) return null;
      return {
        userId: session.userId,
        relayId: session.relayId,
        desktopSessionId: session.desktopSessionId,
        capabilityRevision: session.capabilityRevision,
      };
    },
  });
  const remotePairingStore = getRemotePairingStore();
  const remoteHostPresenceStream = new RemoteHostPresenceStream({
    projector: {
      projectForUser: async (userId) => {
        const identities = await getServerDirectDb()
          .select({
            serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
            serverBindingGeneration:
              nautiloInstanceIdentity.serverBindingGeneration,
          })
          .from(nautiloInstanceIdentity)
          .where(eq(nautiloInstanceIdentity.id, "self"))
          .limit(1);
        const serverIdentity = identities[0];
        if (!serverIdentity) return [];
        const rows = await remotePairingStore.listPairedHostRowsForUser({
          userId,
          serverInstanceId: serverIdentity.serverInstanceId,
          serverBindingGeneration: serverIdentity.serverBindingGeneration,
        });
        return projectRemoteHosts({
          userId,
          rows,
          presence: relayRegistry.snapshotForUser(userId),
          nowMs: Date.now(),
        });
      },
    },
    publishToUser: publishRemoteHostPresenceFrame,
  });
  liveLocalDocumentAuthority = new LiveLocalDocumentAuthority({
    relayRegistry,
    localFileDispatch: relayRegistry,
  });
  const humanEditLeaseRegistry = options?.humanEditLeaseRegistry ?? new HumanEditLeaseRegistry({
    ttlMs: DEFAULT_HUMAN_EDIT_LEASE_TTL_MS,
    now: Date.now,
    newLeaseId: randomUUID,
  });
  // Deliberately process-local and injectable: Workspace coordinator admission
  // consumes this exact instance, never a route-owned shadow registry.
  app.decorate("humanEditLeaseRegistry", humanEditLeaseRegistry);

  // OfficeCLI produces bytes in its existing private temporary file. Its
  // Workspace final commit shares the same coordinator lock/lease/outbox lane
  // as apply_patch and editor saves; relay/non-Workspace routes remain local.
  setWorkspaceOfficeCliCommitExecution(createWorkspaceOfficeCliCommitExecution({
    humanEditLeases: humanEditLeaseRegistry,
    lockManager: workspaceDocumentMutationLockManager,
    onCommitted: requestWorkspaceDocumentMutationOutboxPump,
  }));
  setWorkspaceFileContentCommitExecution(createWorkspaceFileContentCommitExecution({
    humanEditLeases: humanEditLeaseRegistry,
    lockManager: workspaceDocumentMutationLockManager,
    onCommitted: requestWorkspaceDocumentMutationOutboxPump,
  }));
  setWorkspaceFileContentRecoveryExecution(createWorkspaceFileContentRecoveryExecution({
    humanEditLeases: humanEditLeaseRegistry,
    lockManager: workspaceDocumentMutationLockManager,
  }));
  setWorkspaceCanonicalHistoryRestoreExecution(
    createWorkspaceCanonicalHistoryRestoreExecution({
      humanEditLeases: humanEditLeaseRegistry,
      lockManager: workspaceDocumentMutationLockManager,
      onCommitted: requestWorkspaceDocumentMutationOutboxPump,
    }),
  );
  setWorkspaceFileStructuralMutationExecution(
    createWorkspaceFileStructuralMutationExecution({
      humanEditLeases: humanEditLeaseRegistry,
      lockManager: workspaceDocumentMutationLockManager,
      onCommitted: requestWorkspaceDocumentMutationOutboxPump,
    }),
  );
  setWorkspaceCanonicalUndoTurnExecution(
    createWorkspaceCanonicalUndoTurnExecution({
      humanEditLeases: humanEditLeaseRegistry,
      lockManager: workspaceDocumentMutationLockManager,
      onCommitted: requestWorkspaceDocumentMutationOutboxPump,
    }),
  );

  humanEditLeaseRoutes(app, {
    registry: humanEditLeaseRegistry,
    workspaceLockManager: workspaceDocumentMutationLockManager,
    resolveTarget: async ({ request, candidate }) => {
      if (!request.sessionUserId) return { ok: false, code: "forbidden" };
      if (!request.memoryEnvelope) return { ok: false, code: "forbidden" };
      return resolveWorkspaceHumanEditLeaseTarget({
        envelope: request.memoryEnvelope,
        candidate,
      });
    },
  });
  setLiveReviewWriteGuard(async (target) => {
    if (target.surface === "workspace") {
      return liveMiniAppSessionRegistry.hasOpenSessionForArtifact({
        appId: "nautilo-writer",
        userId: target.ownerId,
        artifactId: target.artifactId,
      });
    }
    const authority = liveLocalDocumentAuthority;
    if (!authority) {
      throw new Error("Live local document authority is unavailable.");
    }
    for (const canonicalTargetIdentity of target.canonicalTargetIdentities ?? []) {
      if (
        !authority.authorizeCanonicalTargetIdentity({
          ownerId: target.ownerId,
          relayId: target.relayId,
          canonicalTargetIdentity,
        })
      ) {
        throw new LiveReviewTargetResolutionError("local_target_forbidden");
      }
      if (
        liveMiniAppSessionRegistry.hasOpenSessionForCurrentFileIdentity({
          appId: "nautilo-writer",
          userId: target.ownerId,
          relayId: target.relayId,
          canonicalTargetIdentity,
        })
      ) {
        return true;
      }
    }
    for (const candidatePath of target.candidatePaths ?? []) {
      const identity = await authority.resolveCanonicalTargetIdentity({
        ownerId: target.ownerId,
        relayId: target.relayId,
        candidatePath,
      });
      if (!identity.ok) {
        if (identity.code === "not_found") continue;
        throw new LiveReviewTargetResolutionError(identity.code);
      }
      if (
        liveMiniAppSessionRegistry.hasOpenSessionForCurrentFileIdentity({
          appId: "nautilo-writer",
          userId: target.ownerId,
          relayId: target.relayId,
          canonicalTargetIdentity: identity.canonicalTargetIdentity,
        })
      ) {
        return true;
      }
    }
    for (const candidatePath of target.directoryCandidatePaths ?? []) {
      const identity = await authority.resolveCanonicalTargetIdentity({
        ownerId: target.ownerId,
        relayId: target.relayId,
        candidatePath,
      });
      if (!identity.ok) {
        if (identity.code === "not_found") continue;
        throw new LiveReviewTargetResolutionError(identity.code);
      }
      if (
        liveMiniAppSessionRegistry.hasOpenSessionAtOrBelowCurrentFileIdentity({
          appId: "nautilo-writer",
          userId: target.ownerId,
          relayId: target.relayId,
          canonicalDirectoryIdentity: identity.canonicalTargetIdentity,
        })
      ) {
        return true;
      }
    }
    return false;
  });
  relayRegistry.start();
  setRelayRegistry(relayRegistry);
  setOrdinaryHostResolver(createOrdinaryHostResolver({
    pairingStore: remotePairingStore,
    registry: relayRegistry,
  }));
  //  Wave 7 — REST and WS share the exact stream instance whose projector
  // reads the authoritative durable bindings plus this live registry.
  remoteControlRoutes(app, {
    registry: relayRegistry,
    getRemoteHostAuthoritativeSnapshot: async (userId) => {
      const snapshot =
        await remoteHostPresenceStream.authoritativeSnapshotForUser(userId);
      return { hosts: [...snapshot.hosts], cursor: snapshot.cursor };
    },
    onRemoteHostMutation: async (userId) => {
      await remoteHostPresenceStream.reconcileUser(userId);
    },
    onRemoteHostRevoked: async ({ userId, remoteHostId }) => {
      await remoteHostPresenceStream.revokeRemoteHost({
        userId,
        remoteHostId,
      });
    },
  });
  wsRoutes(app, {
    resolveBearer,
    checkDeviceAdmission: async ({
      credentialDigestBase64url,
      userId,
      humanActorId,
    }) => {
      const policy = await getEncryptionTransitionPolicy(getServerDirectDb());
      if (policy.mode === "plaintext_only") return { status: "admitted" };
      const credentialDigest = decodeCanonicalBase64url(
        credentialDigestBase64url,
        32,
      );
      if (credentialDigest === null) {
        return {
          status: "required",
          reason: "device_admission_unavailable",
        };
      }
      const status = await deviceAdmissionComposition.status({
        authority: { credentialDigest, userId, humanActorId },
        now: Date.now(),
      });
      return status.status === "admitted"
        ? { status: "admitted" }
        : { status: "required", reason: status.reason };
    },
    getMaintenanceStatusEvent: getMaintenanceStatusEventForWs,
    remoteHostPresenceStream,
  });
  //  task 3.1.2 — install the plan store on the agent tools node so it
  // can pin relay dispatches to the plan's bound relay.
  setWorkstationDispatchPlanRegistry(workstationDispatchPlanRegistry);

  //  task 3.1.2 / 3.2.5 — wire the Full Workstation approval override
  // resolver into the LIVE post-model approval path. The resolver is
  // server-owned (it reads the live `workstationSessionRegistry` +
  // `relayRegistry` and admits plans into `workstationDispatchPlanRegistry`)
  // and is installed on the shared `defaultPostModelDeps` object so every
  // graph constructed downstream — the foreground `langgraphExecutor`, the
  // fork executor, subagent runs, and the resume paths — consults it in
  // post-model Pass 2 before batching `ask` / `prove_it` / `auto`-anomaly
  // candidates.
  //
  // Fail-closed: in this slice the resolver DECISION is `none` for every
  // dispatch (the per-dispatch side-evidence pipeline + authenticated
  // dispatch-binding threading are a follow-up outside this slice's owned
  // files), so normal approval semantics are byte-for-byte unchanged. The
  // plan ADMISSION is live: the tools node pins the relay to the session's
  // bound relay through the normal-approval path today, and completing the
  // evidence pipeline flips eligible Full Mode dispatches to `auto` without
  // further post-model edits. See `createWorkstationApprovalOverrideResolver`
  // for the contract.
  defaultPostModelDeps.resolveWorkstationApprovalOverride =
    createWorkstationApprovalOverrideResolver({
      registry: workstationSessionRegistry,
      relayRegistry,
      planRegistry: workstationDispatchPlanRegistry,
      //  Commit 4 — redacted `workstation_admission` audit sink. The
      // resolver emits one row per consultation (auto or none) carrying
      // execution class + outcome/reason + tool/tool-call id + OPAQUE
      // session/plan binding identifiers; the writer appends it to the
      // security audit log. Never command text / output / roots / paths /
      // env / token / PIN / grant contents.
      audit: (event: WorkstationAdmissionAuditEvent): void => {
        try {
          writeSecurityAuditEvent(securityAuditLogPath, event);
        } catch {
          warn(
            `[workstation-access] admission audit write failed for ${event.toolName}`,
          );
        }
      },
    });
  // semantic computer calls are admitted independently of generic
  // approval. The shared adapter supplies only the current relay/session/
  // pairing tuple plus the local Desktop's advisory receipt. Electron still
  // reloads and enforces the receipt at dispatch time; no Auto-Approve input
  // exists.
  const computerUsePostModelResolvers = createComputerUsePostModelAdmissionResolvers({
    hasCurrentDesktopAutomationAuthority,
    registry: {
      snapshotForUser: (userId) => relayRegistry.snapshotForComputerUse(userId),
    },
  });
  defaultPostModelDeps.resolveComputerUseAdmission =
    computerUsePostModelResolvers.resolveComputerUseAdmission;
  defaultPostModelDeps.resolveComputerUseRootGrant =
    computerUsePostModelResolvers.resolveComputerUseRootGrant;

  // the tools node calls this resolver immediately before dispatch.
  // The controller re-reads every live authority fact and returns the sole
  // real-workstation decision; post-model approval processing has no
  // preview, authority, or persistence role.
  defaultPostModelDeps.resolveUncontainedHostCommandsDispatch = async (input) => {
    const controller = uncontainedHostCommands;
    const origin = input.foregroundLocalElectron;
    if (
      controller === null ||
      origin.userId !== input.userId ||
      origin.relayId !== input.relayId ||
      origin.desktopSessionId.length === 0 ||
      origin.pairingGeneration.length === 0
    ) {
      return { admitted: false, reason: "foreground_local_electron_required" };
    }
    return await controller.resolveDispatch({
      userId: input.userId,
      actorId: input.actorId,
      relayId: input.relayId,
      desktopSessionId: origin.desktopSessionId,
      pairingGeneration: origin.pairingGeneration,
      toolCallId: input.toolCallId,
      ...(input.clientMeta?.ip !== undefined ? { ip: input.clientMeta.ip } : {}),
      ...(input.clientMeta?.userAgent !== undefined ? { userAgent: input.clientMeta.userAgent } : {}),
    });
  };

  // compose the one production Codex path entirely from canonical
  // persisted facts, the authenticated relay snapshot, and the existing
  // Task/TaskRun lifecycle. No browser-shaped identity or manifest can cross
  // this boundary. The live ToolCatalog is a server boot invariant: a missing
  // catalog is not replaced with a permissive or empty stand-in. Ordinary
  // Tasks retain their native execution route.
  const codexDb = getServerDirectDb();
  const codexPreferences = new CodexHarnessPreferenceStore(codexDb);
  const codexBindings = createCodexTaskBindingLookup(codexDb);
  const codexPersistence = new CodexPersistenceAdapter(codexDb);
  const codexAdmin = new CodexAdminControlPlane({
    relay: relayRegistry,
    // A first inspection validates the locally installed Codex runtime and
    // generates both stable and experimental app-server schemas. Official npm
    // launchers are deliberately re-probed, so this one read-only command can
    // exceed the relay's normal timeout. Mutating/admin operations retain the
    // relay default rather than inheriting this cold-start allowance.
    runtimeInspectTimeoutMs: 60_000,
    profileIds: { mint: () => ({ profileHandle: randomUUID(), profileGeneration: 0 }) },
    artifacts: { selectInstallArtifact: () => Promise.resolve({ artifactRef: CODEX_REVIEWED_RUNTIME_ARTIFACT_REF }) },
  });
  const codexExecutionPreflight = new CodexExecutionPreflight({
    control: codexAdmin,
    readHostStatus: (userId, relayId) =>
      relayRegistry.getCodexSession(relayId, userId)?.status ?? null,
  });
  // `InMemoryRelayRegistry#getCodexSession` already proves v8 + the Electron
  // host capability before returning. The authority service additionally
  // requires the exact socket/runtime correlation that its older internal
  // port models, so derive it only from that authenticated registry snapshot.
  // A missing host status or child generation is represented by an invalid
  // generation and rejected by the authority service; it never becomes an
  // alternate identity or a synthesized ready state.
  const codexAuthoritySessions = {
    getCodexSession(relayId: string, userId: string) {
      const snapshot = relayRegistry.getCodexSession(relayId, userId);
      if (!snapshot) return null;
      const status = snapshot.status;
      return {
        relayId: snapshot.relayId,
        userId: snapshot.userId,
        relaySessionId: snapshot.relaySessionId,
        pairingGenerationRef: snapshot.pairingGenerationRef,
        desktopSessionId: snapshot.desktopSessionId,
        selectedProtocolVersion: snapshot.selectedProtocolVersion,
        capability: { version: 1 as const, hostKind: "electron" },
        capabilityRevision: snapshot.capabilityRevision,
        currentCapabilityRevision: snapshot.capabilityRevision,
        currentRuntimeGeneration: status?.runtimeGeneration ?? -1,
        statusCorrelation: {
          relayId: snapshot.relayId,
          relaySessionId: snapshot.relaySessionId,
          desktopSessionId: snapshot.desktopSessionId,
          pairingGenerationRef: snapshot.pairingGenerationRef,
          selectedProtocolVersion: snapshot.selectedProtocolVersion,
          capabilityRevision: snapshot.capabilityRevision,
        },
        status: status === null
          ? null
          : {
              state: status.state,
              workspace: status.workspace,
              ...(status.compatibility === undefined
                ? {}
                : { compatibility: status.compatibility }),
              ...(status.features === undefined ? {} : { features: status.features }),
              ...(status.runtimeGeneration === undefined
                ? {}
                : { runtimeGeneration: status.runtimeGeneration }),
              ...(status.profiles === undefined
                ? {}
                : {
                    profiles: status.profiles.map((profile) => ({
                      profileHandle: profile.profileHandle,
                      profileGeneration: profile.profileGeneration,
                      accountGeneration: profile.accountGeneration,
                      childGeneration: profile.childGeneration ?? -1,
                      state: profile.state,
                    })),
                  }),
            },
      };
    },
  };
  const codexCanonicalFactsReader = createCodexCanonicalFactsReader(codexDb);
  const codexAuthority = new CodexAuthorityService(
    new CodexCanonicalFactsService(codexCanonicalFactsReader),
    codexAuthoritySessions,
    codexPersistence,
  );
  const codexBindingSessions = new CodexBindingSessionService({
    relay: relayRegistry,
    bindings: codexBindings,
    mutations: codexPersistence,
    mintId: randomUUID,
  });
  const codexAdmissionFactory = new CodexExecutionAdmissionFactory({
    bindings: codexBindings,
    mintId: randomUUID,
  });
  const codexTurnBroker = new CodexTurnEventBroker({ source: relayRegistry });
  const codexRequestBroker = new CodexRequestBroker({ source: relayRegistry });
  const codexHarnessExecution = new CodexHarnessExecution({
    sessions: codexBindingSessions,
    events: codexTurnBroker,
    requests: codexRequestBroker,
  });
  const codexControlPlane = createCodexHarnessControlPlane({
    execution: codexHarnessExecution,
  });
  const codexTaskRunWriter = createCodexTaskRunLifecycleWriter(codexDb);
  const codexTaskRunReportBack = createCodexTaskRunReportBack(codexDb);
  const codexTaskRuns = new CodexTaskRunLifecycleAdapter({
    reader: createCodexTaskRunLifecycleReader(codexDb),
    writer: codexTaskRunWriter,
    reportBack: codexTaskRunReportBack,
  });
  const codexUnavailableRequests = new CodexUnavailableRequestTerminalizer(
    codexTaskRunWriter,
    codexTaskRunReportBack,
  );
  const codexTaskExecutionReader = createCodexTaskExecutionRouteReader(codexDb);
  const taskHarnessExecutionRouteReader = createTaskHarnessExecutionRouteStore(codexDb);
  const claudeConnections = new ClaudeConnectionController({
    getConnection: (userId) => getOrCreateClaudeConnectionWith(getServerDirectDb(), { userId }),
    setEnabled: async (userId, enabled) => {
      const row = await setClaudeConnectionEnabledWith(getServerDirectDb(), { userId }, enabled);
      if (!row) throw new Error("Claude connection enablement persistence returned no row");
      return row;
    },
    saveObservation: (input) => saveClaudeConnectionObservationWith(getServerDirectDb(), { userId: input.userId }, input),
    selectModel: (input) => selectClaudeConnectionModelWith(getServerDirectDb(), { userId: input.userId }, input),
    listContexts: async (userId) => (await relayRegistry.listConnected()).flatMap((relayId) => {
      const context = relayRegistry.getClaudeConnectionContext(relayId, userId);
      return context === null ? [] : [context];
    }),
    ...(enableClaudeCodeTasks
      ? { getExecutionSession: (relayId: string, userId: string) => relayRegistry.getClaudeExecutionSession(relayId, userId) }
      : {}),
    requestDiscovery: (input) => relayRegistry.requestClaudeConnectionDiscovery(input),
    onContext: (listener) => relayRegistry.onClaudeConnectionContext(listener),
  });
  app.addHook("onClose", () => claudeConnections.close());
  const claudeHarnessExecution = enableClaudeCodeTasks
    ? new ClaudeHarnessExecution({ relay: relayRegistry })
    : null;
  const claudeEphemeralOutputProjector = enableClaudeCodeTasks
    ? new CodexRoomOutputProjector({ requestMode: "ephemeral" })
    : null;
  const codexRoomOutputProjector = new CodexRoomOutputProjector({
    persistUserInputRequest: async (input) => {
      const result = await createCodexUserInputRequestWith(
        codexDb,
        { userId: input.userId, agentId: input.sourceAgentId },
        {
          requestRef: input.requestRef,
          bindingId: input.bindingId,
          bindingGeneration: input.bindingGeneration,
          roomId: input.roomId,
          taskId: input.taskId,
          taskRunId: input.taskRunId,
          jobId: input.jobId,
          codexThreadId: input.codexThreadId,
          codexTurnId: input.codexTurnId,
          codexItemId: input.codexItemId,
          questions: input.questions,
          autoResolutionMs: input.autoResolutionMs,
          expiresAt: input.expiresAt,
        },
      );
      if (result.status === "created" || result.status === "existing") {
        return { status: result.status, state: result.request.state };
      }
      return { status: result.status };
    },
  });
  const taskHarnessExecutionRouteSelector = createTaskHarnessExecutionRouteSelector({
    tasks: taskHarnessExecutionRouteReader,
    registrations: [
      createCodexTaskHarnessExecutionRouteRegistration(
        () => createCodexTaskExecutionRouteSelector({
          preferences: codexPreferences,
          tasks: codexTaskExecutionReader,
          taskRuns: codexTaskRuns,
          preflight: codexExecutionPreflight,
          models: { list: (profile) => codexAdmin.listModels(profile) },
          limits: { resolve: resolveModelExecutionLimits },
          authority: codexAuthority,
          admissionFactory: codexAdmissionFactory,
          controlPlane: codexControlPlane,
          outputProjection: codexRoomOutputProjector,
        }),
      ),
      ...(claudeHarnessExecution !== null && claudeEphemeralOutputProjector !== null
        ? [createClaudeTaskHarnessExecutionRouteRegistration(
          () => createClaudeTaskExecutionRouteSelector({
            tasks: {
              getTask: async (taskId) => {
                const task = await codexTaskExecutionReader.getTask(taskId);
                if (task === null || task.callingRoomId === undefined) return null;
                return { ...task, callingRoomId: task.callingRoomId };
              },
            },
            controller: claudeConnections,
            execution: claudeHarnessExecution,
            taskRuns: codexTaskRuns,
            outputProjection: claudeEphemeralOutputProjector,
          }),
        )]
        : []),
      createHermesAcpTaskExecutionRouteRegistration(codexDb, relayRegistry),
      createOpenCodeAcpTaskExecutionRouteRegistration(codexDb, relayRegistry),
    ],
  });

  // Task primitive async engine. The observer claims due `tasks` rows
  // and dispatches each as its own job (its own thread, a task-only lane) so a
  // task run never holds a human room's lane. The generic selector reloads the
  // sealed server-authored harness descriptor; Native Tasks return undefined
  // and preserve their existing executor. Stopped on app close.
  const taskObserver = new TaskObserver({
    db: getServerDirectDb(),
    jobManager,
    maintenanceGate: strictBackgroundMaintenanceGate(
      "background.task.observer",
    ),
    executionRouteSelector: taskHarnessExecutionRouteSelector,
    convergeCreatedRoomCatalog: convergeHumanRoomCatalogs,
    onMaintenance: async () => {
      liveMiniAppSessionRegistry.expire();
      // A canonical save can outlive a transient DB finalizer failure. Retry
      // only already-resolved, model-finished bindings on the existing
      // observer tick; unresolved Human reviews stay parked untouched.
      for (const binding of pendingTaskWriterReviewFinalizations()) {
        try {
          await liveReviewLifecycle.finalizeReview(binding);
        } catch {
          warn(`[live-writer-review] finalization retry failed task=${binding.taskId}`);
        }
      }
    },
  });
  setTaskObserver(taskObserver);
  function taskLifecycleDeps() {
    return {
      db: getServerDirectDb(),
      jobManager,
      observer: taskObserver,
      onStoppedWriterReview: (binding: TaskWriterReviewBinding) => {
        // Stop won durably; release precisely the visible review before the
        // runtime removes its non-durable Writer binding.
        liveMiniAppSessionRegistry.completeProposalReview({
          sessionId: binding.sessionId,
          proposalId: binding.proposalId,
          outcome: "rejected",
        });
      },
    };
  }
  const createTaskForAgentTool = async (
    task: Parameters<typeof runtimeCreateTask>[1],
  ) => {
    const liveMiniAppContext = getTaskCreationLiveMiniAppContext();
    const taskProvenance = getTaskCreationBackgroundTaskProvenance();
    const invocationProvenance = getTaskCreationInvocationProvenance();
    const parentLiveMiniAppBinding = taskProvenance
      ? resolveTaskLiveMiniAppBinding(
          taskProvenance.taskId,
          taskProvenance.ownerId,
        )
      : null;
    if (parentLiveMiniAppBinding?.status === "available") {
      throw new Error(
        "Cannot create a child task: this already-running Task owns the active live-app session. Perform the document work with this Task's admitted live tools; child Tasks cannot inherit the session.",
      );
    }
    if (
      taskProvenance
      && hasTaskWriterReviewBindingForTaskRun(taskProvenance)
    ) {
      throw new Error(
        "Cannot create a child task: this TaskRun already owns a Writer review proposal. End this run so the same Task can wait for Human acceptance and requeue verification.",
      );
    }
    const scheduleKind = task.scheduleKind ?? "now";
    const activeAppId = liveMiniAppContext?.liveMiniAppSession.appId ?? null;
    const activeExtension = activeAppId
      ? getLiveAppSessionExtension(activeAppId)
      : null;
    const delegableToolIds = activeAppId
      ? getLiveTaskDelegationToolIds(activeAppId)
      : null;
    const generatedLiveToolByInput = new Map<string, string>();
    const generatedDelegableLiveToolNames: string[] = [];
    if (activeAppId && delegableToolIds) {
      for (const toolId of delegableToolIds) {
        const generatedName = generateMiniAppAgentToolName(activeAppId, toolId);
        generatedLiveToolByInput.set(toolId, generatedName);
        generatedLiveToolByInput.set(generatedName, generatedName);
        generatedDelegableLiveToolNames.push(generatedName);
      }
    }
    if (
      task.toolsMode === "whitelist" &&
      activeAppId &&
      activeExtension?.taskDelegation.mode === "direct_only"
    ) {
      const requestedDirectOnlyTool = task.toolsWhitelist?.some((requested) =>
        activeExtension.liveToolIds.some((toolId) =>
          requested === toolId ||
          requested === generateMiniAppAgentToolName(activeAppId, toolId),
        ),
      );
      if (requestedDirectOnlyTool) {
        throw new Error(
          `${activeExtension.appId} live tools are direct-only. Invoke them in the active app turn instead of a background Task.`,
        );
      }
    }
    let delegatesLiveMiniApp = false;
    let normalizedToolsWhitelist = task.toolsWhitelist
      ? [...task.toolsWhitelist]
      : undefined;
    if (liveMiniAppContext && delegableToolIds && delegableToolIds.length > 0) {
      if (scheduleKind === "now" && (task.toolsMode ?? "auto") === "auto") {
        delegatesLiveMiniApp = true;
      } else if (task.toolsMode === "whitelist" && normalizedToolsWhitelist) {
        normalizedToolsWhitelist = normalizedToolsWhitelist.map((requested) => {
          const generated = generatedLiveToolByInput.get(requested);
          if (generated) delegatesLiveMiniApp = true;
          return generated ?? requested;
        });
        if (delegatesLiveMiniApp && scheduleKind !== "now") {
          throw new Error(
            "Live app operations can only be delegated to an immediate background Task while that exact session remains open.",
          );
        }
      }
    }
    const taskForCreate = {
      ...task,
      ...(task.toolsMode === "whitelist"
        ? { toolsWhitelist: normalizedToolsWhitelist ?? [] }
        : {}),
      ...(delegatesLiveMiniApp && activeAppId
        ? {
            metadata: {
              ...(task.metadata ?? {}),
              [LIVE_MINI_APP_TASK_DELEGATION_METADATA_KEY]: {
                version: 1,
                appId: activeAppId,
              },
            },
          }
        : {}),
    };
    const directDb = getServerDirectDb();
    let bindingTaskId: string | null = null;
    let created: Awaited<ReturnType<typeof runtimeCreateTask>>;
    try {
      created = await directDb.transaction(async (tx) => {
        // The observer must not see the committed row before its process-local
        // authority is registered. The transaction supplies that ordering;
        // the real kick happens only after commit below.
        const result = await runtimeCreateTask(
          {
            db: tx as unknown as Parameters<typeof runtimeCreateTask>[0]["db"],
            observer: { kick() {} },
            provenance: createAgentTurnTaskCreationProvenance({
              ownerId: task.ownerId,
              invocation: invocationProvenance,
            }),
            admission: getPlaintextTaskCreationAdmission(),
          },
          taskForCreate,
        );
        bindingTaskId = result.taskId;
        if (scheduleKind === "now" && task.callingRoomId) {
          const returnContext = getTaskCreationReturnContext();
          const registered = registerTaskReturnBinding(
            result.taskId,
            returnContext,
            relayRegistry,
          );
          if (!registered) {
            const reason = taskReturnBindingRegistrationFailure(
              result.taskId,
              returnContext,
              relayRegistry,
            );
            warn(
              `[task-return-binding] capture unavailable task=${result.taskId} reason=${reason ?? "unknown"}`,
            );
          }
        }
        if (delegatesLiveMiniApp) {
          const registered = registerTaskLiveMiniAppBinding(
            result.taskId,
            liveMiniAppContext,
            liveMiniAppContext
              ? () => {
                  const session = liveMiniAppContext.liveMiniAppSession;
                  const validation = liveMiniAppSessionRegistry.validateOpenForSubject(
                    session.sessionToken,
                    {
                      appId: session.appId,
                      userId: liveMiniAppContext.ownerId,
                    },
                  );
                  if (
                    !validation.ok ||
                    validation.sessionId !== session.sessionId ||
                    validation.binding.appId !== session.appId ||
                    validation.binding.userId !== liveMiniAppContext.ownerId
                  ) return null;
                  return {
                    ...session,
                    documentVersion: validation.binding.documentVersion,
                  };
                }
              : null,
            // Auto remains the normal progressive catalogue, but its first
            // model step must know the exact live operations admission
            // selected. This seed is process-local with the raw binding.
            (task.toolsMode ?? "auto") === "auto"
              ? { initialActivatedToolNames: generatedDelegableLiveToolNames }
              : {},
          );
          if (!registered) {
            throw new Error(
              "The live app session could not be delegated to this background Task. Keep the document open and try again.",
            );
          }
        }
        return result;
      });
    } catch (error) {
      if (bindingTaskId) removeTaskReturnBinding(bindingTaskId);
      throw error;
    }
    if (scheduleKind === "now") taskObserver.kick();
    return created;
  };
  const codexHarnessTaskDeps = {
    preferences: codexPreferences,
    facts: codexCanonicalFactsReader,
    preflight: codexExecutionPreflight,
    models: { list: (profile: Parameters<typeof codexAdmin.listModels>[0]) => codexAdmin.listModels(profile) },
    limits: { resolve: resolveModelExecutionLimits },
    readiness: {
      check: (profile: Parameters<typeof codexAuthority.checkProfileReadiness>[0], collaborationMode: "work" | "plan") =>
        Promise.resolve(codexAuthority.checkProfileReadiness(profile, collaborationMode)),
    },
    createTask: createTaskForAgentTool,
  };
  const hermesAcpHarnessTaskDeps = {
    facts: codexCanonicalFactsReader,
    relay: relayRegistry,
    createTask: createTaskForAgentTool,
  };
  const claudeHarnessTaskDeps = {
    facts: codexCanonicalFactsReader,
    admission: claudeConnections,
    createTask: createTaskForAgentTool,
  };
  // publish a live JobManager so the report-back finalizer (running
  // inside the task-run executor generator) can enqueue the wake turn, and a
  // bound runtime `createTask` so the `task` tool's `create` command can start
  // tasks without `@nautilo/agent` importing `@nautilo/runtime` (cycle).
  setTaskRunJobManager(jobManager);
  const prepareHarnessStop = async (taskId: string): Promise<boolean> => {
    if (claudeHarnessExecution !== null && await claudeHarnessExecution.stopActiveTask(taskId)) return true;
    return codexHarnessExecution.stopActiveTask(taskId);
  };
  const stopTaskForAgentTool = async (taskId: string) => {
    await prepareHarnessStop(taskId);
    return runtimeStopTask(taskLifecycleDeps(), taskId);
  };
  setTaskToolRuntime({
    db: getServerDirectDb(),
    canUseLegacyTaskContent: () => dormantTaskContentOwner.runMutation({
      ordinary: () => Promise.resolve(true),
      dual: () => Promise.resolve(false),
      protected: () => Promise.resolve(false),
    }),
    ...(enableClaudeCodeTasks ? { claudeCodeTasksEnabled: true as const } : {}),
    createTask: createTaskForAgentTool,
    createHarnessTask: (input) => {
      if (input.harness === "codex") {
        return createCodexHarnessTask(codexHarnessTaskDeps, input);
      }
      if (input.harness === "claude-code") {
        return (async () => {
          if (!enableClaudeCodeTasks || input.callingRoomId === null) {
            throw new Error("Claude Code task execution is unavailable.");
          }
          const selectedModels = (await claudeConnections.listExecutionModels(input.ownerId))
            .filter((model) => model.selected);
          const model = input.harnessModelId === undefined
            ? selectedModels.length === 1 ? selectedModels[0] ?? null : null
            : selectedModels.find((candidate) => candidate.catalogModelId === input.harnessModelId) ?? null;
          if (model === null) throw new Error("Claude Code task execution is unavailable.");
          return createClaudeHarnessTask(claudeHarnessTaskDeps, {
            ownerId: input.ownerId,
            requestorId: input.requestorId,
            agentId: input.agentId,
            prompt: input.prompt,
            callingRoomId: input.callingRoomId,
            harness: "claude-code",
            profileRef: model.profileRef,
            catalogModelId: model.catalogModelId,
            selectedModel: model.selectedModel,
          });
        })();
      }
      if (input.harness === "hermes-acp") {
        return createHermesAcpHarnessTask(hermesAcpHarnessTaskDeps, input);
      }
      if (input.harness === "opencode-acp") {
        throw Object.assign(new Error("ACP_HARNESS_UNAVAILABLE"), {
          code: "ACP_HARNESS_UNAVAILABLE" as const,
        });
      }
      throw new Error("Unsupported harness selection.");
    },
    listHarnessModels: (input) => {
      if (input.harness === "claude-code") {
        if (!enableClaudeCodeTasks) return Promise.resolve([]);
        return claudeConnections.listExecutionModels(input.ownerId).then((models) => models
          .filter((model) => model.selected)
          .map((model) => ({
            id: model.catalogModelId,
            displayName: model.displayName,
            description: model.description,
            isDefault: false,
            isPreferred: true,
          })));
      }
      if (input.harness !== "codex") return Promise.resolve([]);
      return listCodexHarnessModels({
        preferences: codexPreferences,
        preflight: codexExecutionPreflight,
        models: { list: (profile) => codexAdmin.listModels(profile) },
        limits: { resolve: resolveModelExecutionLimits },
      }, input.ownerId);
    },
    steerHarnessTask: async (input) => {
      // Provider selection is only a pre-read. Each provider control seam
      // re-reads and re-derives exact Task authority before it acts.
      const task = await codexTaskExecutionReader.getTask(input.taskId);
      if (task !== null && parseClaudeTaskExecutionMetadata(task.metadata) !== null) {
        return steerClaudeHarnessTask({
          tasks: codexTaskExecutionReader,
          execution: claudeHarnessExecution ?? { steerActiveTask: () => Promise.resolve(false) },
        }, input);
      }
      return steerCodexHarnessTask(
        {
          tasks: codexTaskExecutionReader,
          controlPlane: codexControlPlane,
          execution: codexHarnessExecution,
        },
        input,
      );
    },
    inspectHarnessTask: async (input) => {
      // Re-read the Task at the server composition boundary. The agent-side
      // owner check is useful ergonomics, but it is not the authorization
      // boundary for process-local harness activity.
      const task = await codexTaskExecutionReader.getTask(input.taskId);
      if (
        !task ||
        task.ownerId !== input.ownerId ||
        task.agentId !== input.agentId ||
        task.callingRoomId !== input.roomId ||
        task.targetRoomId !== input.roomId
      ) return null;
      const snapshot = codexRoomOutputProjector.inspectLiveActivity(input);
      const runs = await getTaskRuns(getServerDirectDb(), task.id);
      const run = snapshot
        ? runs.find((candidate) => candidate.id === snapshot.taskRunId)
        : [...runs].reverse().find((candidate) => candidate.jobId !== null);
      if (!run?.jobId) return null;
      const job = await getJobById(run.jobId, input.ownerId);
      return {
        taskRunId: run.id,
        jobId: run.jobId,
        jobStatus: job?.status ?? null,
        jobCreatedAt: job?.createdAt.toISOString() ?? null,
        jobStartedAt: job?.startedAt?.toISOString() ?? null,
        jobCompletedAt: job?.completedAt?.toISOString() ?? null,
        lastActivityAt: snapshot?.lastActivityAt ?? null,
        activity: snapshot?.activity ?? [],
      };
    },
    computeNextFireAt: runtimeComputeNextFireAt,
    canResumeResearch: (task) => canResumeSecurityResearchContextFailure(getServerDirectDb(), task),
    // lifecycle commands funnel through the runtime fns (shared abort
    // seam); `unpauseTask` kicks this observer to re-claim for checkpoint resume.
    pauseTask: (taskId) =>
      runtimePauseTask(
        { db: getServerDirectDb(), jobManager, observer: taskObserver },
        taskId,
      ),
    unpauseTask: (taskId) =>
      runtimeUnpauseTask(
        { db: getServerDirectDb(), jobManager, observer: taskObserver },
        taskId,
      ),
    stopTask: stopTaskForAgentTool,
  });
  // the task HTTP API funnels `create` through the SAME runtime
  // `createTask` (kicking this observer for now-tasks). Registered here, after
  // the observer exists; Fastify permits route registration until `ready()`.
  tasksRoutes(app, {
    observer: taskObserver,
    prepareStopTask: prepareHarnessStop,
    contentOwner: dormantTaskContentOwner,
  });
  await taskObserver.start();
  codexRequestsRoutes(app, {
    controlPlane: codexControlPlane,
    emit: (event) => eventBus.emit(event),
    liveRequests: codexRequestBroker,
    ...(claudeHarnessExecution === null ? {} : { ephemeralRequests: claudeHarnessExecution }),
    unavailableRequests: codexUnavailableRequests,
    userInputRequests: {
      get: (ownerId, requestRef) =>
        getCodexUserInputRequestWith(codexDb, { userId: ownerId }, requestRef),
      listRoom: (ownerId, roomId) =>
        listCodexUserInputRequestsForRoomWith(codexDb, { userId: ownerId }, { roomId, limit: 16 }),
      claim: (input) =>
        claimCodexUserInputRequestDispatchWith(
          codexDb,
          { userId: input.ownerId, agentId: input.agentId },
          { requestRef: input.requestRef, expectedRevision: input.expectedRevision, now: input.now },
        ),
      settle: (input) =>
        settleCodexUserInputRequestWith(
          codexDb,
          { userId: input.ownerId, agentId: input.agentId },
          {
            requestRef: input.requestRef,
            expectedRevision: input.expectedRevision,
            state: input.state,
            now: input.now,
          },
        ),
      markUnavailable: (input) =>
        markCodexUserInputRequestUnavailableWith(
          codexDb,
          { userId: input.ownerId, agentId: input.agentId },
          { requestRef: input.requestRef, expectedRevision: input.expectedRevision, now: input.now },
        ),
      markSubmitted: (input) =>
        markCodexUserInputRequestSubmittedWith(
          codexDb,
          { userId: input.ownerId, agentId: input.agentId },
          { requestRef: input.requestRef, expectedRevision: input.expectedRevision, now: input.now },
        ),
    },
  });
  setAgentEventSink({
    emit: (event) => eventBus.emit(event),
  });
  setWorkspaceArtifactEventSink((event) => {
    forwardWorkspaceArtifactBusEvent(event, (forwarded) => {
      eventBus.emit(forwarded);
    });
  });
  setWorkspaceArtifactCreatedSink(artifactEventProducer.created);
  const invalidateArtifactFeed = createArtifactFeedInvalidator({
    recipients: id => listArtifactFeedRecipientUserIds(getServerDirectDb(), id),
    changed: publishEventFeedChanged,
  });
  const artifactFeedListener = (event: ServerEvent) => { void invalidateArtifactFeed(event); };
  eventBus.on(artifactFeedListener);
  const relaySocketLifecycle = relayRoutes(app, relayRegistry);
  acpReadinessRoutes(app, {
    relay: relayRegistry,
    resolveHost: async (userId, requestedRelayId) => {
      const candidates = (await relayRegistry.listConnected())
        .filter((relayId) => relayRegistry.getAcpSession(relayId, userId) !== null);
      if (requestedRelayId !== undefined) {
        return candidates.includes(requestedRelayId) ? { relayId: requestedRelayId } : null;
      }
      return candidates.length === 1 ? { relayId: candidates[0]! } : null;
    },
  });
  setLocalMcpInstallRelaySocketSafetyCloser(relaySocketLifecycle);
  // HTTP lifecycle mutations receive exact revoked relay-token row
  // ids only after their DB transaction commits. Reconcile those authoritative
  // pairing generations synchronously against the sole live registry, clear
  // Full Workstation sessions/plans, then close through the websocket
  // endpoint so ordinary unregister owns MCP/mini-app/pending cleanup.
  const relayPairingGenerationInvalidator = createRelayPairingGenerationInvalidator({
    relayRegistry,
    workstationSessionRegistry,
    workstationDispatchPlanRegistry,
    serverBindingId: workstationServerBindingId,
    socketLifecycle: relaySocketLifecycle,
  });
  const codexProfileRemovalTurns = new CodexProfileRemovalTurnCoordinator({
    listBindingWork: ({ userId, profileId }) =>
      listCodexProfileRemovalTaskBindingWorkWith(
        getServerDirectDb(),
        { userId },
        profileId,
      ),
    readTask: async (taskId) => {
      const task = await getTaskById(getServerDirectDb(), taskId);
      return task ? { ownerId: task.ownerId, status: task.status } : null;
    },
    stopTask: (taskId) => runtimeStopTask(taskLifecycleDeps(), taskId),
    getJob: (jobId) => jobManager.getJob(jobId),
  });
  codexConnectionRoutes(app, {
    control: codexAdmin,
    resolveHost: async (userId, requestedRelayId) => {
      const candidates = (await relayRegistry.listConnected())
        .filter((relayId) => relayRegistry.getCodexSession(relayId, userId) !== null);
      if (requestedRelayId !== undefined) {
        return candidates.includes(requestedRelayId) ? { relayId: requestedRelayId } : null;
      }
      return candidates.length === 1 ? { relayId: candidates[0]! } : null;
    },
    readHostStatus: (userId, relayId) => relayRegistry.getCodexSession(relayId, userId)?.status ?? null,
    readHostInspectionScope: (userId, relayId) => {
      const session = relayRegistry.getCodexSession(relayId, userId);
      return session
        ? {
          relaySessionId: session.relaySessionId,
          desktopSessionId: session.desktopSessionId,
          capabilityRevision: session.capabilityRevision,
        }
        : null;
    },
    listProfiles: (userId) => listCodexProfilesWith(getServerDirectDb(), { userId }),
    getProfile: (userId, profileId) => getCodexProfileWith(getServerDirectDb(), { userId }, profileId),
    createProfile: async (input) => {
      const row = await insertCodexProfileWith(getServerDirectDb(), { userId: input.userId }, {
        id: input.id, relayId: input.relayId, homeHandle: input.homeHandle, label: input.label,
        profileGeneration: input.profileGeneration,
        accountGeneration: input.accountGeneration,
        authState: input.authState,
        registrationState: input.registrationState,
      });
      if (!row) throw new Error("Codex profile persistence returned no row");
      return row;
    },
    renameProfile: (input) => renameCodexProfileWith(getServerDirectDb(), { userId: input.userId }, input.profileId, input.label, input.expectedRevision),
    updateProfileStatus: (input) => updateCodexProfileStatusWith(getServerDirectDb(), { userId: input.userId }, {
      id: input.profileId,
      authState: input.authState,
      profileGeneration: input.profileGeneration,
      accountGeneration: input.accountGeneration,
      ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
      ...(input.planType !== undefined ? { planType: input.planType } : {}),
      ...(input.expectedRegistrationState !== undefined
        ? { expectedRegistrationState: input.expectedRegistrationState }
        : {}),
      expectedRevision: input.expectedRevision,
    }),
    registerProfileFromOfficialAccount: (input) =>
      registerCodexProfileFromOfficialAccountWith(
        getServerDirectDb(),
        { userId: input.userId },
        {
          id: input.profileId,
          profileGeneration: input.profileGeneration,
          accountGeneration: input.accountGeneration,
          ...(input.accountEmail !== undefined ? { accountEmail: input.accountEmail } : {}),
          ...(input.planType !== undefined ? { planType: input.planType } : {}),
          expectedRevision: input.expectedRevision,
        },
      ),
    updateProfileUsageSnapshot: (input) => updateCodexProfileUsageSnapshotWith(
      getServerDirectDb(),
      { userId: input.userId },
      {
        id: input.profileId,
        profileGeneration: input.profileGeneration,
        accountGeneration: input.accountGeneration,
        expectedRevision: input.expectedRevision,
        patch: input.patch,
        observedAt: input.observedAt,
      },
    ),
    beginProfileRemoval: (input) => beginCodexProfileRemovalWith(
      getServerDirectDb(),
      { userId: input.userId },
      { id: input.profileId, expectedRevision: input.expectedRevision },
    ),
    drainProfileTurns: ({ userId, profile }) =>
      codexProfileRemovalTurns.drain({ userId, profileId: profile.id }),
    archiveProfileBindingsForRemoval: ({ userId, profile }) =>
      archiveCodexProfileBindingsForRemovalWith(
        getServerDirectDb(),
        { userId },
        {
          id: profile.id,
          relayId: profile.relayId,
          homeHandle: profile.homeHandle,
          profileGeneration: profile.profileGeneration,
          accountGeneration: profile.accountGeneration,
          expectedRevision: profile.revision,
        },
      ),
    finalizeProfileRemoval: ({ userId, profile }) =>
      finalizeCodexProfileRemovalWith(
        getServerDirectDb(),
        { userId },
        {
          id: profile.id,
          relayId: profile.relayId,
          homeHandle: profile.homeHandle,
          profileGeneration: profile.profileGeneration,
          accountGeneration: profile.accountGeneration,
          expectedRevision: profile.revision,
        },
      ),
    getUserPreference: (userId) =>
      getCodexUserPreferenceWith(getServerDirectDb(), { userId }),
    upsertUserPreference: (input) =>
      upsertCodexUserPreferenceWith(
        getServerDirectDb(),
        { userId: input.userId },
        {
          profileId: input.profileId,
          posture: input.posture,
          enabled: input.enabled,
          expectedRevision: input.expectedRevision,
        },
      ),
  });
  claudeConnectionsRoutes(app, { controller: claudeConnections });
  // pairing + device-management HTTP surface. Goes through
  // the trust preHandler (NOT in PUBLIC_ROUTES) so callers must
  // present a real authenticated context.
  relayHttpRoutes(app, {
    relayRegistry,
    reconcileRevokedPairingGenerations: ({ userId, pairingGenerationIds }) => {
      relayPairingGenerationInvalidator.reconcileRevokedPairingGenerations({
        userId,
        pairingGenerations: pairingGenerationIds,
      });
    },
    recordPairingLifecycleAudit: (event) => {
      writeSecurityAuditEvent(securityAuditLogPath, event);
    },
    generationInvalidation: createRelayGenerationInvalidator({
      registry: relayRegistry,
      invalidateAuthorityAndPresence: (input) =>
        remoteHostPresenceStream.invalidatePairingGenerations(input),
    }),
  });
  // Full Workstation activation/disable route. Mounted after the
  //   relay surface so it shares the same authenticated relay registry
  //   + the workstation session registry constructed above. The route
  //   stays fail-closed: until a desktop advertises a compiled profile
  //   snapshot the binding provider resolves `null` and the route
  //   returns a truthful 404 `relay_binding_unavailable` rather than
  //   fabricating a binding. No Workbench UI, approval resolver,
  //   sandbox/MCP execution, or discovery probes are wired here.
  workstationAccessRoutes(app, {
    relayRegistry,
    pinProvider,
    getCapabilities: (userId) => getUserCapabilities(userId),
    relayBindingProvider: createRelayRegistryBindingProvider({
      relayRegistry,
      serverBindingId: workstationServerBindingId,
    }),
    // profile-selector activation seam. Derives the authoritative
    // binding from the relay registry's grant snapshot + the desktop main's
    // profile selectors, so the FIRST activation of an approved stored
    // profile can be gated by the user's OWN fresh PIN at the server
    // boundary before the desktop compiles any authority. Same capability
    // gate + PIN proof + registry as `/activate`.
    profileActivationProvider: createRelayRegistryProfileActivationProvider({
      relayRegistry,
      serverBindingId: workstationServerBindingId,
    }),
    registry: workstationSessionRegistry,
    auditEvent: writeWorkstationAudit,
    // reuse the existing stable remote-pairing HMAC material, but
    // resolve it only when a receipt is minted/verified. This keeps server
    // boot semantics unchanged when remote pairing is not configured.
    startupReceiptSecret: () => requirePairingPepper(),
  });
  publicJoinRoutes(app, {
    inviteToken: process.env["NAUTILO_PUBLIC_JOIN_INVITE_TOKEN"],
  });
  invitesRoutes(app, {
    onHumanRoomJoined: humanMembershipEventProducer,
    ownerId: ownerId ?? "",
    securityAuditLogPath,
    publicInviteBaseUrl: resolvePublicBaseUrl(options),
  });
  app.addHook("onClose", async () => {
    await getTtsService().dispose();
    setLiveReviewWriteGuard(null);
    await memoryReviewRuntime.stop();
    await stenographerWorker.stop();
    if (protectedStenographerPromise !== null) await (await protectedStenographerPromise).dispose();
    if (reflectionAuthorityPromise !== null) await (await reflectionAuthorityPromise).dispose();
    setWorkspaceFileContentCommitExecution(undefined);
    setWorkspaceFileContentRecoveryExecution(undefined);
    setWorkspaceCanonicalHistoryRestoreExecution(undefined);
    setWorkspaceFileStructuralMutationExecution(undefined);
    setWorkspaceCanonicalUndoTurnExecution(undefined);
    setWorkspaceOfficeCliCommitExecution(undefined);
    codexTurnBroker.dispose();
    codexRequestBroker.dispose();
    relayRegistry.stop();
    clearTaskReturnBindings();
    //  task 3.2.5 — release the Full Workstation override resolver so a
    // post-shutdown graph construction (e.g. a stray background job) does
    // not consult a torn-down session registry. Restoring the absent state
    // (the field is optional) makes post-model skip the override
    // consultation (fail-closed). `delete` is used because the server's
    // `exactOptionalPropertyTypes` config forbids assigning `undefined` to
    // an optional property.
    delete defaultPostModelDeps.resolveWorkstationApprovalOverride;
    delete defaultPostModelDeps.ordinaryContentAccessForState;
    delete defaultPostModelDeps.resolveComputerUseAdmission;
    delete defaultPostModelDeps.resolveComputerUseRootGrant;
    delete defaultPostModelDeps.resolveUncontainedHostCommandsDispatch;
    //  task 3.1.2 — release the plan store + clear its entries so a
    // post-shutdown graph construction does not pin dispatches to a
    // torn-down plan registry. Restoring the absent singleton makes the
    // tools node skip plan pinning (fail-closed, normal first-eligible path).
    workstationDispatchPlanRegistry.clear();
    setWorkstationDispatchPlanRegistry(null);
    setOrdinaryHostResolver(null);
    await taskObserver.stop();
    setTaskObserver(null);
    setTaskRunJobManager(null);
    setTaskToolRuntime(null);
    setMiniAppToolRuntime(null);
    setLocalMcpToolRuntime(null);
    setConnectedAppActionRuntime(null);
    setConnectedWebAccountReadToolRuntime(null);
    setConnectedWebAccountActionToolRuntime(null);
    setAgentEventSink(null);
    setWorkspaceArtifactEventSink(null);
    setWorkspaceArtifactCreatedSink(null);
    eventBus.off(artifactFeedListener);
  });
  // A real listener owns the worker. App construction and `app.inject()` stay
  // DB-free, while shutdown is already guaranteed to stop future claims.
  app.addHook("onListen", () => {
    stenographerWorker.start();
    memoryReviewRuntime.start();
    void getServerContextConfig(getServerDirectDb())
      .then((config) => reflectionSleepController.setEnabled(
        config.reflectionSleepEnabled,
      ))
      .catch(() => {
        warn("[reflection] semantic worker remains disabled", {
          failureCode: "sleep_policy_unavailable",
        });
      });
  });

  // Test-mode routes (NAUTILO_TEST_MODE=1 only). Registered last so the
  // test token resolver can write ~/.nautilo/smoke-token on first boot
  // without racing the auth pipeline.
  const testToken = await resolveTestToken();
  testModeRoutes(app, {
    enabled: testToken !== null,
    token: testToken ?? "",
    //  thread the relay registry so
    // /api/test/tool-invoke can dispatch run_shell through a
    // connected in-VM relay with a real sandboxProfile envelope.
    relayRegistry,
  });

  // Mobile Web is an optional, strictly namespaced Expo export. It is
  // mounted before the Workbench root SPA so `/mobile/*` never falls into the
  // desktop shell. The route-local fallback is intentional: Fastify permits
  // only one global not-found handler and the Workbench owns that one.
  const mobileWebDist = process.env["NAUTILO_MOBILE_WEB_DIST"];
  let mobileWebNotServedReason: MobileWebNotServedReason | null = null;
  let mobileWebInventory: ReturnType<typeof inspectMobileWebExport> | null = null;
  let mobileExpoStatic: string | null = null;
  let mobileAssets: string | null = null;
  if (!mobileWebDist) {
    mobileWebNotServedReason = "not-configured";
    log("[server] mobile web not mounted: NAUTILO_MOBILE_WEB_DIST is unset (optional)");
  } else if (!existsSync(join(mobileWebDist, "index.html"))) {
    mobileWebNotServedReason = "index-missing";
    warn("[server] mobile web not mounted: configured export is missing index.html");
  } else {
    try {
      const candidateInventory = inspectMobileWebExport(mobileWebDist);
      if (candidateInventory.invalidFingerprintFiles.length > 0) {
        mobileWebNotServedReason = "invalid-export";
        warn("[server] mobile web not mounted: generated asset fingerprint validation failed");
      } else {
        const candidateExpoStatic = join(mobileWebDist, "_expo", "static");
        const candidateAssets = join(mobileWebDist, "assets");
        const presentAssetRoots = [candidateExpoStatic, candidateAssets]
          .filter((assetRoot) => existsSync(assetRoot));
        if (presentAssetRoots.some((assetRoot) => !statSync(assetRoot).isDirectory())) {
          mobileWebNotServedReason = "invalid-export";
          warn("[server] mobile web not mounted: generated asset root is not a directory");
        } else {
          // Every fallible export inspection completes before the first
          // registration. A Fastify plugin registration failure is not
          // recoverable because it can leave a partial plugin state behind.
          mobileWebInventory = candidateInventory;
          mobileExpoStatic = existsSync(candidateExpoStatic) ? candidateExpoStatic : null;
          mobileAssets = existsSync(candidateAssets) ? candidateAssets : null;
        }
      }
    } catch {
      mobileWebNotServedReason = "inspection-failed";
      warn("[server] mobile web not mounted: configured export inspection failed");
    }
  }
  if (mobileWebInventory !== null && mobileWebDist) {
    if (mobileExpoStatic !== null) {
      await app.register(
        staticFiles,
        buildMobileWebAssetsStaticOptions(mobileExpoStatic, "/mobile/_expo/static/"),
      );
    }
    if (mobileAssets !== null) {
      await app.register(
        staticFiles,
        buildMobileWebAssetsStaticOptions(mobileAssets, "/mobile/assets/"),
      );
    }
    app.get("/mobile", async (_req, reply) => reply.redirect("/mobile/", 308));
    // Expo's current static export references this root-level file. Other
    // file-like paths stay under the hard-404 rule in the navigation handler.
    if (existsSync(join(mobileWebDist, "favicon.ico"))) {
      app.get("/mobile/favicon.ico", async (_req, reply) =>
        reply.sendFile("favicon.ico", mobileWebDist, buildMobileWebFallbackSendFileOptions()),
      );
    }
    app.get("/mobile/*", async (req, reply) => {
      if (isMobileWebTraversalAttempt(req.url) || isMobileWebAssetRequest(req.url)) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: `Route ${req.method}:${req.url} not found`,
        });
      }
      const htmlFile = mobileWebInventory.resolveHtmlRoute(req.url);
      if (htmlFile === null) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: `Route ${req.method}:${req.url} not found`,
        });
      }
      reply.header("cache-control", MOBILE_WEB_NAVIGATION_CACHE_CONTROL).code(200);
      return reply.sendFile(
        htmlFile,
        mobileWebDist,
        buildMobileWebFallbackSendFileOptions(),
      );
    });
    log(`[server] mobile web mounted at /mobile/ from ${mobileWebDist}`);
  }
  if (mobileWebNotServedReason !== null) {
    const replyMobileWebUnavailable = async (_req: FastifyRequest, reply: FastifyReply) =>
      reply
        .code(503)
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .send(renderMobileWebNotServedPage(mobileWebNotServedReason));
    app.get("/mobile", replyMobileWebUnavailable);
    app.get("/mobile/", replyMobileWebUnavailable);
  }

  // Mount the Workbench SPA at `/` so `nautilo-server` can serve the
  // single-origin (workbench + API + WS on the same host) topology that
  // the packaged Electron client and hosted deployments rely on. Env-gated so dev mode is
  // unaffected when NAUTILO_WORKBENCH_DIST is unset.
  //
  // Registered AFTER every /api/* + /ws + /relay route above so explicit
  // routes always win — the @fastify/static plugin only fills in the
  // unmatched-GET tail. `decorateReply: false` is required: the earlier
  // /api/onboarding/ mount already decorated `reply.sendFile`, and a
  // second decoration throws FST_ERR_DEC_ALREADY_PRESENT at boot.
  //
  // The setNotFoundHandler fallback supports SPA deep-link refresh
  // (e.g. reloading https://demo.nautilo.dev/genie/abc returns the
  // SPA's index.html instead of 404). The `req.method !== "GET"` guard
  // is non-negotiable: without it, an unknown POST/PUT/DELETE silently
  // 200s with the SPA HTML, masking real API bugs.
  const workbenchDist = process.env["NAUTILO_WORKBENCH_DIST"];
  if (workbenchDist && existsSync(join(workbenchDist, "index.html"))) {
    // Serve hashed Vite chunks explicitly. With wildcard:false on the SPA root
    // mount, nested `/assets/...` requests can otherwise fall through to the
    // SPA not-found handler and return index.html as `text/html`, which blanks
    // Electron because module scripts never execute.
    const workbenchAssets = join(workbenchDist, "assets");
    if (existsSync(workbenchAssets)) {
      await app.register(
        staticFiles,
        buildWorkbenchAssetsStaticOptions(workbenchAssets),
      );
    }
    await app.register(staticFiles, buildWorkbenchSpaRootStaticOptions(workbenchDist));
    // buildWorkbenchSpaRootStaticOptions sets wildcard:false so @fastify/static
    // skips its own `/*` catch-all 404; unmatched GETs (SPA deep-link refresh
    // like /genie/abc) fall through to setNotFoundHandler below.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method !== "GET") return reply.code(404).send();
      const requestPathname = pathnameWithoutQuery(req.url);
      // Don't shadow API, WS, relay, Mobile Web, or missing static-asset 404s
      // with SPA HTML. Mobile is optional; when its export is absent,
      // `/mobile/*` remains an honest 404 rather than becoming the desktop UI.
      // In particular, a missing parser WASM must never receive index.html.
      if (
        requestPathname === "/api" ||
        requestPathname.startsWith("/api/") ||
        requestPathname === "/ws" ||
        requestPathname.startsWith("/ws/") ||
        requestPathname === "/relay" ||
        requestPathname.startsWith("/relay/") ||
        requestPathname === "/mobile" ||
        requestPathname.startsWith("/mobile/") ||
        isWorkbenchAssetRequest(req.url)
      ) {
        return reply.code(404).send({
          statusCode: 404,
          error: "Not Found",
          message: `Route ${req.method}:${req.url} not found`,
        });
      }
      // sendFile inherits the not-found 200 default from the framework
      // for the body, but the response code stays at the inbound 404
      // unless we override it. SPA deep-link refresh has to be a true
      // 200 so browsers don't poison their cache or trigger error UI.
      reply.code(200);
      return reply.sendFile(
        "index.html",
        workbenchDist,
        buildWorkbenchSpaFallbackSendFileOptions(),
      );
    });
    log(`[server] workbench SPA mounted at / from ${workbenchDist}`);
  } else {
    let serverPkgVersion = "unknown";
    try {
      const raw = readFileSync(join(serverSrcDir, "..", "package.json"), "utf8");
      const v = (JSON.parse(raw) as { version?: string }).version;
      serverPkgVersion = typeof v === "string" && v.trim() !== "" ? v : "unknown";
    } catch {
      /* keep unknown */
    }
    const rawInstanceId = parseNautiloInstanceId(process.env);
    const instanceLabel = rawInstanceId.trim() === "" ? "(default)" : rawInstanceId.trim();

    //  friendly fallback is intentionally scoped to GET `/` only.
    //
    // Originally this fallback caught every unknown GET that wasn't /api,
    // /ws, or /relay, on the theory that anything else might be a Workbench
    // SPA deep link. That over-reached: retired server routes (e.g. the
    // legacy `/setup` page) silently became 200 + branded
    // HTML, masking real 404s and breaking `health-keys.test.ts`'s
    // "GET /setup returns 404" pin. The fallback's actual job is narrow:
    // when an operator hits the bare server URL in a browser and the
    // Workbench SPA isn't mounted, show them a branded diagnostic page
    // instead of the raw `{"message":"Route GET:/ not found"...}` JSON.
    // Other unknown paths fall through to the default JSON 404 so deleted
    // routes stay honestly 404.
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === "GET" && req.url === "/") {
        const dist = process.env["NAUTILO_WORKBENCH_DIST"];
        const indexOk = Boolean(dist) && existsSync(join(dist!, "index.html"));
        const html = renderWorkbenchNotServedPage({
          workbenchDistEnv: process.env["NAUTILO_WORKBENCH_DIST"],
          indexHtmlExists: indexOk,
          serverVersion: serverPkgVersion,
          instanceId: instanceLabel,
        });
        return reply.code(200).type("text/html; charset=utf-8").send(html);
      }
      if (req.method !== "GET") {
        return reply.code(404).send();
      }
      return reply.code(404).send({
        statusCode: 404,
        error: "Not Found",
        message: `Route ${req.method}:${req.url} not found`,
      });
    });
    log(`[server] workbench SPA not mounted — friendly GET / fallback active`);
  }

  return app;
}

// Model capability catalog (OpenRouter import + overrides). Hydrate at server boot.
export {
  hydrateModelCapabilitiesCache,
  modelSupportsInput,
  modelSupportsFeature,
  resolveModelCapabilities,
  resolveModelFeatures,
} from "@nautilo/model-capabilities";

// Chat / multimodal ingress
export { buildForegroundUserHumanMessage } from "./chat/foreground-user-message";
export {
  deriveComputerUseInvocationId,
  isSupportedComputerUseToolName,
} from "./runtime/computer-use-admission";
// Re-export BaseMessage so server-side message-persist code paths
// (D128 P1.2 suppressed-turn path; future analogous spots) can type
// against the canonical LangGraph message shape without forcing every
// downstream consumer to declare @langchain/core as a direct dep.
export type { BaseMessage } from "@langchain/core/messages";
export {
  createProcessLocalProtectedAgentMemoryProjectionPort,
  createResumableProtectedAgentMemoryProjectionPort,
  type ResumableProtectedAgentMemoryProjectionPortInput,
  type ProtectedAgentMemoryAccessAction,
  type ProtectedAgentMemoryAccessPort,
  type ProtectedAgentMemoryProjectionApprovalPreview,
  type ProtectedAgentMemoryProjectionPort,
  type ProtectedAgentMemoryProjectionPreparation,
  type ProtectedAgentMemoryProjectionReference,
  type ProtectedAgentMemoryScopeLifecyclePort,
  type ProtectedMemoryToolPorts,
} from "./tools/memory/protected-memory-ports";
export {
  isSensitiveToolArgumentKey,
  omitSensitiveToolArgs,
  sanitizeToolArgsForEvent,
} from "./utils/tool-argument-redaction";
export {
  maybeSummarizeImagesWithVisionFallback,
  type TextOnlyImagePolicy,
} from "./chat/vision-fallback";
export {
  hasRunnableChatProviderCredentials,
  modelHasRunnableCredentials,
} from "./chat/model-runtime-credentials";
export { parseVisionCandidateIds } from "./chat/vision-candidates";

// Graph
export {
  createNautiloGraph,
  type NautiloGraphDeps,
} from "./agent/graph";
export {
  createEncryptedCheckpointSaver,
  ENCRYPTED_CHECKPOINT_LIST_DEFAULT_LIMIT,
  ENCRYPTED_CHECKPOINT_LIST_MAX_LIMIT,
  EncryptedCheckpointSaver,
  EncryptedCheckpointMaintenanceError,
  InlineCheckpointCellSerializer,
  OperationBoundCheckpointPool,
  type CheckpointAuthorizedOperationContext,
  type CheckpointAuthorizationOperation,
  type CheckpointCellCoordinate,
  type CheckpointCellCrypto,
  type CheckpointInvocationScope,
  type CheckpointOperationStore,
  type CheckpointOperationStoreFactory,
  type CheckpointWriteCoordinate,
  type CheckpointWriteCoordinateReader,
  type CreateEncryptedCheckpointSaverOptions,
  type EncryptedCheckpointSaverOptions,
  type EncryptedCheckpointMaintenanceAttempt,
  type EncryptedCheckpointMaintenanceCoordinate,
  type EncryptedCheckpointMaintenanceOutcome,
  type EncryptedCheckpointSaverCloseOutcome,
} from "./checkpoints/encrypted-checkpoint-saver";
export {
  createDedicatedEncryptedCheckpointPool,
} from "./checkpoints/checkpoint-saver";
export { resumeGraphWithIdentity } from "./graph/resume-identity";
export { resumeGraphWithApproval, type StreamEventProcessor } from "./graph/resume-approval";
export { resumeGraphWithAskReply } from "./graph/resume-approval-ask";
export {
  readOrdinaryContentAccessRecovery,
  resumeOrdinaryContentAccessRecovery,
  OrdinaryContentAccessRecoveryUnavailableError,
  type OrdinaryContentAccessRecoveryScope,
  type OrdinaryContentAccessRecoveryCoordinate,
  type OrdinaryContentAccessRecoveryDeps,
} from "./graph/resume-ordinary-content-access";
export { resumeGraphWithHostChoice } from "./graph/resume-host-choice";
export {
  resumeGraphWithHumanReply,
  type ResumeHumanReplyResult,
} from "./graph/resume-human-reply";
export {
  interruptValueToServerEvent,
  collectPendingInterruptEvents,
} from "./graph/interrupt-mapping";
export { readPendingInterruptEventsForThread } from "./graph/pending-interrupts";
export { resumeGraphWithConnectedWebAction } from "./graph/resume-connected-web-action";
export {
  inspectTaskResumeOutcome,
  type TaskResumeOutcome,
} from "./graph/inspect-resume-outcome";
export { parentGraphThreadIdFromForkCheckpoint, roomGraphThreadFromLaneThread } from "./graph/fork-thread-id";
export {
  readAgentIdForThread,
  readConnectedWebActionResumeBindingForThread,
  readCausalHumanUserIdForThread,
  readTurnIdForThread,
} from "./graph/turn-id";
export {
  readProjectionResumeBindingForThread,
  projectionResumeBindingFromCheckpoint,
  type ProjectionResumeBinding,
  type ProjectionCheckpointReadable,
} from "./graph/projection-resume-binding";
export {
  resolveGraphExecutionPolicy,
  isGraphRecursionError,
  toGraphBudgetOutcome,
  GraphExecutionMetrics,
  DEFAULT_GRAPH_RECURSION_LIMIT,
  DEFAULT_REPEATED_FAILURE_LIMIT,
  type GraphExecutionPolicy,
  type GraphExecutionPolicyOverrides,
  type GraphBudgetOutcome,
  type GraphExecutionMetricsSnapshot,
} from "./graph/execution-policy";
export {
  applyToolResultsToStreaks,
  buildNoProgressKey,
  serializeNoProgressKey,
  operationDiscriminator,
  normalizeToolError,
  resetStreakForKey,
  toNoProgressOutcome,
  toNoProgressOutcomeFromError,
  isNoProgressError,
  formatNoProgressLogToken,
  NO_PROGRESS_CORRECTIVE_INSTRUCTION,
  NoProgressError,
  type NoProgressKey,
  type NoProgressStreakEntry,
  type NoProgressStreaks,
  type NoProgressToolResult,
  type NoProgressTransition,
  type NoProgressAction,
  type NoProgressOutcome,
} from "./graph/no-progress";
export { NautiloStateAnnotation, MAX_SUBAGENT_DEPTH, type NautiloState } from "./agent/state";
export {
  decodeTransientAgentRuntimeConfiguration,
  runNautiloTransientProtectedModelDispatch,
  runTransientProtectedModelDispatch,
  type TransientAgentRuntimeCommand,
  type TransientAgentRuntimeConfiguration,
  type TransientAgentRuntimeOnboardingAnswer,
} from "./runtime/protected-runtime-dispatch";
export {
  getCurrentInitiatingClientSurface,
  runWithInitiatingClientSurface,
} from "./runtime/initiating-client-surface-context";
export {
  runScopeSubagentUntilPause,
  extractTaskProgressFromStreamEvent,
  retainTaskWorkProgress,
  type ObservedTaskProgress,
  type RunScopeSubagentOpts,
  type RunScopeSubagentResult,
} from "./subagents/scope-subagent/run";
// D363 — repo-docs (OpenWiki) primitives consumed by the runtime task wrapper
// (`repo-docs-task.ts`). Prompt + git-context + safety constants only; no runtime.
export { createSystemPrompt, createUserPrompt } from "./subagents/repo-docs/prompt";
export {
  buildGitContext,
  readLastUpdate,
  writeLastUpdateMetadata,
  getGitHead,
  formatLastUpdate,
  type UpdateMetadata,
  type RepoGitSurface,
} from "./subagents/repo-docs/git-context";
export {
  DEFAULT_WIKI_DIR,
  METADATA_FILENAME,
  docBranchName,
  ALLOWED_GIT_SUBCOMMANDS,
  type RepoDocsCommand,
} from "./subagents/repo-docs/constants";
// M144 — exposed so the runtime task-dispatch seam validates a task's
// tool whitelist at dispatch time (single source of truth for every surface).
export {
  validateSubagentToolWhitelist,
  type ValidateSubagentToolsResult,
} from "./tools/subagents/validate-subagent-whitelist";

// D087 Phase 3 §3.7 — server routes dispatch file-tool commands
// directly (bypassing the LLM) for user-initiated history commands.
// `dispatchFileCommand` is the same primitive used by the
// DynamicStructuredTool's `func` at chat time; reusing it keeps
// the direct path and the chat path in perfect behavioral lock-
// step.
export { dispatchFileCommand } from "./tools/file/dispatch";
export type { DispatchContext } from "./tools/file/dispatch";
export {
  envelopeFactsForArtifacts,
  emitWorkspaceArtifactCreatedFact,
  setWorkspaceArtifactEventSink,
  setWorkspaceArtifactCreatedSink,
  validateLogicalPath,
  resolveWorkspaceArtifact,
  physicalPathFromStorageUri,
  emitWorkspaceArtifactDocumentPatchApplied,
  emitWorkspaceArtifactDocumentPatchFromAnchoredEdit,
  type EnvelopeFacts,
  type ArtifactResolution,
  type WorkspaceArtifactBusEvent,
  type WorkspaceArtifactRowApplyResult,
  type WorkspaceArtifactCreationActor,
  type WorkspaceArtifactCreatedFact,
  type WorkspaceArtifactCreatedSink,
} from "./tools/file/artifact-store";
export { sha256Hex } from "./tools/file/staged-patches";
export { selectFileBackend, type FileBackend } from "./tools/file/backend";
export {
  executeLocalOfficeOperation,
  localOfficeDispatchErrorText,
} from "./tools/office/local-office-dispatch";
export {
  parseOfficeRunReadArgv,
  type OfficeRunReadSpec,
} from "./tools/office/local-office-read-spec";
export { resolveLocalOfficeRelay } from "./tools/office/local-office-routing";
export {
  setWorkspaceOfficeCliCommitExecution,
  getWorkspaceOfficeCliCommitExecution,
  type WorkspaceOfficeCliCommitExecution,
  type WorkspaceOfficeCliCommitRequest,
  type WorkspaceOfficeCliCommitResult,
  type WorkspaceOfficeCliSnapshot,
} from "./tools/office/workspace-runtime-adapter";
export {
  readLocalZoneBytes,
  readLocalZoneText,
  queryLocalZoneStat,
  writeLocalZoneBytes,
  writeLocalZoneText,
  requireLocalMutationTurnId,
  formatLocalMutationTurnIdError,
  parseLocalWriteRevisionId,
  type LocalZoneIoContext,
  type LocalZoneStatDetails,
  type LocalMutationTurnIdResult,
} from "./tools/file/local-zone-io";
export { LOCAL_HISTORY_INPUT_REQUIRED } from "./tools/file/local-history-routing";
export {
  FOCUSED_RELAY_MISMATCH_MESSAGE,
  resolveFocusedRelayHintForPath,
  resolveLocalFileRelay,
} from "./tools/file/local-file-routing";
export { pickMutationNamespaceId } from "./tools/file/workspace-commands";
export { withAgentTrustContext } from "./store/trust-agent-db";
export {
  userSaveWorkspaceArtifact,
  shouldRecordCheckpoint,
  conflictReason,
  USER_SAVE_TEXT_LIMIT_BYTES,
  type UserSaveResult,
} from "./tools/file/user-save";
export {
  createWorkspaceBinaryArtifact,
  createWorkspaceBinaryArtifactFromStream,
  type CreateWorkspaceBinaryArtifactResult,
} from "./tools/file/workspace-binary-artifact";
export {
  applyWorkspaceArtifactTextPatch,
  type WorkspaceArtifactPatchApplyResult,
} from "./tools/file/user-patch";
export { resolveZone, assertRealpathContained } from "./tools/file/zones";
export type { ZoneContext } from "./tools/file/zones";
export {
  USE_EDIT_OPEN_WRITER,
  USE_EDIT_OPEN_WRITER_MESSAGE,
  LiveReviewTargetResolutionError,
  getLiveReviewWriteGuard,
  liveReviewWriteGateFailure,
  liveReviewWriteGateFailureJson,
  rejectIfOpenInWriter,
  setLiveReviewWriteGuard,
  type LiveReviewWriteGateFailure,
  type LiveReviewWriteGuard,
  type LiveReviewWriteGuardTarget,
} from "./tools/file/live-review-write-guard";

// Nodes
export { preModelNode } from "./nodes/pre-model";
export { agentNode } from "./nodes/agent";
export {
  loadForegroundModelControlSnapshot,
  foregroundModelControlPlanFromSnapshot,
} from "./config/foreground-model-controls";
export {
  createPostModelNode,
  postModelNode,
  type PostModelDeps,
} from "./nodes/post-model";
export { defaultPostModelDeps } from "./agent/post-model-deps";
export {
  toolsNode,
  createToolsNode,
  setRelayRegistry,
  getRelayRegistry,
  setWorkstationDispatchPlanRegistry,
  getWorkstationDispatchPlanRegistry,
  validateBeforeExecution,
  RelayUnavailableError,
  LiveShadowToolProtectionRequiredError,
  LiveShadowToolProtectionTerminalError,
} from "./nodes/tools";
export type {
  LiveShadowToolBoundary,
  LiveShadowToolBoundaryForState,
  ToolRelayRegistry,
  WorkstationDispatchPlanView,
  WorkstationDispatchPlanRegistry,
  WorkstationRelayFingerprintView,
  WorkstationPlanRevalidationResultView,
  WorkstationPlanRevalidationReasonView,
} from "./nodes/tools";
export {
  createNautiloToolInvocationSession,
} from "./tools/invocation-service";
export type {
  InvocationAuthorityResolution,
  InvocationAuthorityResolver,
  NautiloToolInvocationCall,
  NautiloToolInvocationResult,
  NautiloToolInvocationServerContext,
  NautiloToolInvocationSession,
  NautiloToolInvocationSnapshot,
} from "./tools/invocation-service";
export { buildRuntimeCapabilityTokens } from "./runtime/relay-capabilities";
export {
  getOrdinaryHostResolver,
  setOrdinaryHostResolver,
  type OrdinaryHostResolver,
  type OrdinaryHostResolution,
  type ResolvedOrdinaryHost,
} from "./runtime/ordinary-host-resolver";
export {
  classifyHostScope,
  isReviewedConnectionRelayTool,
  type HostScopeRequirement,
} from "./runtime/host-scoped-tools";
export {
  createApplyPatchExecutionRouter,
  buildApplyPatchToolContext,
} from "./tools/apply-patch/execution-router";
export type {
  WorkspaceApplyPatchOperationReconciliation,
  WorkspaceCommitAdmission,
  WorkspaceCommitResult,
} from "./tools/apply-patch/workspace-executor";
export type {
  WorkspaceApplyPatchProductionPorts,
} from "./tools/apply-patch/workspace-production-adapter";
export type {
  WorkspaceArtifactSnapshot,
} from "./tools/apply-patch/workspace-staging";
export {
  setAgentEventSink,
  type AgentToolCallTracker,
} from "./runtime-hooks";
export { projectSemanticComputerResult } from "./tools/computer/model-result-projector";
export type { DeepResearchReturnContext } from "./runtime/deep-research-return-context";
export {
  type AgentTurnContext,
  getOrCreateAgentTurnContext,
  getAgentTurnContext,
  clearAgentTurnContext,
  withAgentTurnContextFields,
  recordStreamActivityFromEvent,
  bindModelAttemptProgressSinkByKey,
  clearModelAttemptProgressSinkByKey,
  reportModelAttemptProgressByKey,
  _resetAgentTurnContextsForTests,
  type AgentRedirectRequest,
  type AgentRedirectRejectionReason,
  type AgentRedirectRecordResult,
  tryRecordAgentRedirect,
  tryRecordAgentRedirectByKey,
  peekAgentRedirectRequest,
  peekAgentRedirectRequestByKey,
  consumeAgentRedirectRequest,
  consumeAgentRedirectRequestByKey,
  seedAgentRedirectDepth,
  seedAgentRedirectDepthByKey,
  turnContextKey,
  getOrCreateAgentTurnContextByKey,
  getAgentTurnContextByKey,
  clearAgentTurnContextByKey,
} from "./runtime/turn-context";
export {
  resolveModelAttemptPolicy,
  createModelAttemptId,
  ModelAttemptSupervisor,
  classifyModelStreamProgress,
  modelIdFromStreamEvent,
  modelAttemptIdFromStreamEvent,
  TEMPORARY_LEGACY_FIRST_PROGRESS_MS,
  TEMPORARY_LEGACY_REASONING_FIRST_PROGRESS_MS,
  type ResolvedModelAttemptPolicy,
  type ModelAttemptPolicyProvenance,
  type ModelStreamProgress,
  type ModelAttemptTimeoutKind,
  type ModelAttemptTerminalOutcome,
  type ModelAttemptProgressSink,
} from "./utils/model-attempt-policy";
export {
  shouldSuppressFallbackEmission,
  shouldEmitFallbackAssistantText,
  postTurnFallbackContextForTurn,
  postTurnFallbackContextForTurnByKey,
  type PostTurnFallbackContext,
} from "./runtime/post-turn-hook";
export { createSkipTool, SKIP_TOOL_DESCRIPTION, skipToolSchema } from "./tools/skip";
export {
  normalizeRedirectTargetHandle,
  resolveSourceHandle,
  recordRedirectRequest,
  MAX_REDIRECT_TARGET_HANDLE_LENGTH,
} from "./tools/skip";

// Checkpoints
export {
  closeCheckpointSaver,
  createCheckpointSaver,
  setupCheckpointSaver,
  deleteEphemeralCheckpointThread,
  isEphemeralCheckpointThread,
  type PostgresSaver,
} from "./checkpoints/checkpoint-saver";

// Providers
export {
  resolveProviderKey,
  type ProviderName,
  type TenantContext,
} from "./resolve-provider-key";
export { createUniversalModel, __setStubModelForTests } from "./providers/universal";
export {
  smokeTestVenice,
  resolveVeniceSmokeModelId,
  DEFAULT_VENICE_SMOKE_MODEL_ID,
  type SmokeTestVeniceResult,
  type SmokeTestVeniceOptions,
  type VeniceSmokeFetch,
} from "./providers/venice-smoke";
export {
  getModelTokenLimit,
  getModelMaxOutputTokens,
  resolveModelExecutionLimits,
  resolveModelClass,
  type ModelClass,
  type ResolvedModelExecutionLimits,
} from "./providers/models";
export type { ChatModel, CreateModelOptions } from "./providers/types";
export {
  modelRouteProvider,
  resolveUnderlyingModelFamily,
  usesOpenAICompatibleChatTransport,
  type ModelFamily,
} from "./providers/model-route";

// Model catalog
export {
  ASSISTANT_MODELS,
  getDefaultModel,
  getModelById,
  getEnabledModels,
  getSelectableModels,
  getNextFallbackModel,
  getProviderFromModelId,
  getCostCoefficient,
  type AssistantModelConfig,
} from "./config/assistant-models";
// D141 P2 / LD-1 — per-user / per-agent fallback policy resolution
export {
  resolveFallbackPolicy,
  type ResolvedFallbackPolicy,
} from "./utils/resolve-fallback-policy";
export {
  getEligibleModels,
  resolveRetainedModels,
  assertModelRunnable,
  ModelUnavailableError,
  MAX_RETAINED_MODEL_IDS,
} from "./config/eligible-models";
export {
  resolveModelRole,
  NoRunnableModelForRoleError,
  type ResolveModelRoleOptions,
} from "./config/model-role-resolution";
// D429 Phase 1 — resolved catalog projection (local/cache-backed, non-secret).
export {
  resolveCatalogModel,
  listResolvedCatalogModels,
  getActiveModelCatalogProvenance,
} from "./config/resolved-catalog";
// D429 Phase 7 — runtime remote model-catalog loader seam.
export {
  OFFICIAL_MODEL_CATALOG_POINTER_URL,
  configureRuntimeModelCatalog,
  resetRuntimeModelCatalog,
  hydrateRuntimeModelCatalog,
  kickRuntimeModelCatalogRefresh,
  getActiveModelCatalogSync,
  getRuntimeModelCatalog,
  mapModelCatalogProvenance,
  startRuntimeModelCatalogRefreshLoop,
  stopRuntimeModelCatalogRefreshLoop,
  type ModelCatalogProvenance,
  type RuntimeModelCatalogOptions,
} from "./config/model-catalog/runtime-catalog";
export {
  OFFICIAL_COMPUTER_USE_CONTRACT_CATALOGUE_POINTER_URL,
  configureRuntimeComputerUseContractCatalogue,
  hydrateRuntimeComputerUseContractCatalogue,
  refreshRuntimeComputerUseContractCatalogue,
  startRuntimeComputerUseContractCatalogueRefreshLoop,
  stopRuntimeComputerUseContractCatalogueRefreshLoop,
  getActiveComputerUseContractCatalogueSync,
  getActiveComputerUseContractCatalogueResultSync,
  type ComputerUseContractCatalogueRefreshEvent,
} from "./config/computer-use-catalogue/runtime-catalogue";
export {
  createRemoteModelCatalogLoader,
  type RemoteModelCatalogConfig,
  type RemoteModelCatalogLoader,
  type RemoteModelCatalogResult,
  type RemoteModelCatalogSource,
} from "./config/model-catalog/remote-catalog";
export {
  setTrustedModelCatalogKeysForTests,
  resetTrustedModelCatalogKeysForTests,
  getTrustedModelCatalogPublicKey,
} from "./config/model-catalog/trusted-keys";
export {
  SUPPORTED_MODEL_CATALOG_PROVIDER_PREFIXES,
  isSupportedModelCatalogProvider,
} from "./config/model-catalog/supported-providers";
// D429 Phase 7.4 — runtime signed explainer-catalog seam + trusted keys.
export {
  OFFICIAL_EXPLAINER_CATALOG_URL,
  OFFICIAL_EXPLAINER_MEDIA_ORIGIN,
  EXPLAINER_MEDIA_ORIGIN_ENV,
  configureRuntimeExplainerCatalog,
  resetRuntimeExplainerCatalog,
  getRuntimeExplainerCatalog,
  mapExplainerCatalogProvenance,
  mapExplainerCatalogSource,
  resolveExplainerMediaOrigin,
  findExplainerCatalogEntry,
  type ExplainerCatalogProvenance,
  type RuntimeExplainerCatalogOptions,
} from "./media/explainer-catalog/runtime-catalog";
export {
  createRemoteExplainerCatalogLoader,
  type RemoteExplainerCatalogConfig,
  type RemoteExplainerCatalogLoader,
  type RemoteExplainerCatalogResult,
  type RemoteExplainerCatalogSource,
} from "./media/explainer-catalog/remote-catalog";
export {
  setTrustedExplainerCatalogKeysForTests,
  resetTrustedExplainerCatalogKeysForTests,
  getTrustedExplainerCatalogPublicKey,
} from "./media/explainer-catalog/trusted-keys";
// D405 — LLM costs dashboard: pricing + usage metering
export {
  MODEL_PRICES,
  IMAGE_PRICES_USD,
  DEFAULT_IMAGE_PRICE_USD,
  PRICING_VERSION,
  getModelPrice,
  resolveModelPrice,
  resolveImagePrice,
  estimateCostUsd,
  estimateImageCostUsd,
  hasExplicitPrice,
  FALLBACK_USAGE_PRICING_SOURCES,
  type ModelPrice,
  type UsageTokens,
  type PricingSource,
  type ImagePricingSource,
  type UsagePricingSource,
  type ResolvedModelPrice,
  type ResolvedImagePrice,
  type FallbackUsagePricingSource,
} from "./config/model-pricing";
export {
  runWithUsageContext,
  getUsageContext,
  type UsageContext,
  type UsageCallType,
} from "./usage/usage-context";
export { recordLlmUsage, type RecordUsageInput } from "./usage/record-usage";
export { extractUsageFromLLMResult, createUsageCallbackHandler, countNautiloUsageCallbacks } from "./usage/usage-callback";
// M152 — multi-axis task model selection
export {
  resolveTaskModel,
  validateTaskModelSelection,
  ModelSelectionError,
  type ModelSelectionFailure,
  type ResolveTaskModelInput,
  type ResolveTaskModelResult,
} from "./config/resolve-task-model";
export {
  MODEL_INTELLIGENCE_TIER,
  INTELLIGENCE_RANK,
  DEFAULT_INTELLIGENCE_TIER,
  COMBO_SPECS,
  PRIVACY_FLOOR_GRADE,
  SMART_BAND_TOLERANCE,
  CHEAP_BAND_FACTOR,
  intelligenceRankOf,
  modelAxesOf,
  selectionTable,
  type IntelligenceTier,
  type ModelAxes,
} from "./config/model-selection";
export {
  SUPPORTED_MODEL_PREFIXES,
  assertProfileDefaultModelAllowed,
  isSupportedRoutedModelId,
  normalizeProfileDefaultModel,
} from "./config/model-id-validation";
export {
  getDefaultImageModel,
  getImageModel,
  type ImageModelConfig,
  type ImageProvider,
} from "./config/image-models";
export { listMediaGenerationModels, getDefaultMediaGenerationModel } from "./config/media-generation-models";
export type { MediaGenerationFamily, MediaGenerationModel } from "./config/media-generation-models";
export {
  generateImages,
  generateImagesOpenAi,
  generateImagesOpenAiStream,
  generateImagesGoogle,
  generateImagesOpenRouter,
  generateImagesVenice,
  type GenerateImagesArgs,
  type GenerateImagesResult,
  type GenerateImagesStreamEvent,
  type ProviderCreds,
} from "./image-gen";
export { composeAvatarPrompt } from "./image-gen/avatar-prompt";

// Tools
export { reconcileComputerUseHostTools, registerAllTools } from "./tools/register-all";
export {
  compileConnectedAppOperationAdmissions,
  type ConnectedAppOperationAdmission,
} from "./tools/connected-apps/admissions";
export { syncConnectedAppOperationTools } from "./tools/connected-apps/projector";
export {
  connectedAppEligibleProviderIdsForContext,
  connectedAppScopeFromContext,
  getConnectedAppActionRuntime,
  setConnectedAppActionRuntime,
  type ConnectedAppActionRuntime,
} from "./tools/connected-apps/runtime";
export {
  RECALL_RECORDS_POLICY_V1,
  createRecallRecordsTool,
  formatRecallRecordsExpandResult,
  formatRecallRecordsSearchResult,
  isRecallRecordsToolAvailable,
  recallRecordsSchema,
  recallRecordsToolContextForState,
  toolPolicyWithRecallRecordsAvailability,
  type RecallRecordEvidenceView,
  type RecallRecordFreshness,
  type RecallRecordView,
  type RecallRecordsExpandResult,
  type RecallRecordsPort,
  type RecallRecordsPortForState,
  type RecallRecordsSearchResult,
  type RecallRecordsToolContext,
  type RecallRecordsUnavailableReason,
} from "./tools/memory/recall-records";
export {
  getMediaGenerationApprovalRuntime,
  hasMediaGenerationApprovalRuntime,
  mediaGenerationApprovalFromPrepared,
  prepareMediaGenerationApproval,
  resetMediaGenerationApprovalRuntimeForTests,
  setMediaGenerationApprovalRuntime,
  submitMediaGenerationApproval,
  type MediaGenerationApprovalActorContext,
  type MediaGenerationApprovalRuntime,
  type MediaGenerationPreparationInput,
  type MediaGenerationSafeResult,
} from "./tools/media/media-generation-approval-runtime";
export {
  createMediaGenerationServerCore,
  type ExactMediaGenerationQuotePort,
  type MediaGenerationCoreReceipt,
  type MediaGenerationCoreRepository,
  type MediaGenerationServerCoreDependencies,
  type VeniceMediaAdmissionPort,
} from "./media-generation/server-core";
export { VeniceQuoteLifecycleError } from "./media-generation/quote";
export {
  classifyVeniceMediaFailure,
  sanitizeVeniceProviderCode,
  type MediaGenerationFailure,
} from "./media-generation/errors";
export {
  VeniceMediaLifecycleAdapter,
  type VeniceAcceptedMediaWork,
  type VeniceMediaFetch,
} from "./media-generation/venice-lifecycle";
export {
  LOCKED_VENICE_MEDIA_MODEL_FACTS,
  MediaGenerationValidationError,
  VENICE_MEDIA_MODELS,
  normalizeMediaGenerationRequest,
  type NormalizedMediaGenerationIntent,
  type NormalizedMediaGenerationRequest,
  type VeniceMediaModel,
} from "./media-generation/contracts";
export {
  MediaArtifactIndexCommitError,
  type CommittedMediaArtifactIdentity,
  type MediaArtifactIndexCommit,
} from "./media-generation/artifact-writer";
export {
  MediaGenerationReconciler,
  type MediaGenerationArtifactCustody,
  type MediaGenerationReconcilerRepository,
} from "./media-generation/reconciler";
export { VENICE_API_V1_BASE } from "./providers/venice-api";
export {
  setManageAvatarPhotoLibraryPort,
  type ManageAvatarPhotoLibraryPort,
} from "./tools/config/manage-avatar";
export { ToolCatalog, initToolCatalog } from "@nautilo/catalog";
export {
  setConnectionVaultBackend,
  setConnectionVaultAuditSink,
  type ConnectionVaultAuditSinkInput,
} from "./tools/connections/runtime";
export {
  buildConnectionProxyRequest,
  connectionProxyContextFromToolContext,
  dispatchConnectionProxyRequest,
  getConnectionProxyDispatcher,
  setConnectionProxyDispatcher,
  type BuildConnectionProxyRequestInput,
  type BuiltConnectionProxyRequest,
  type ConnectionProxyDispatchContext,
  type ConnectionProxyDispatcher,
  type ConnectionProxyDispatchInput,
} from "./tools/connections/proxy-request";
export { createFileTool } from "./tools/file/file-tool";
export {
  createFileMutationRequestId,
  getWorkspaceFileContentCommitExecution,
  getWorkspaceFileContentRecoveryExecution,
  getWorkspaceCanonicalHistoryRestoreExecution,
  getWorkspaceFileStructuralMutationExecution,
  getWorkspaceCanonicalUndoTurnExecution,
  setWorkspaceFileContentCommitExecution,
  setWorkspaceFileContentRecoveryExecution,
  setWorkspaceCanonicalHistoryRestoreExecution,
  setWorkspaceFileStructuralMutationExecution,
  setWorkspaceCanonicalUndoTurnExecution,
  type WorkspaceFileContentCommitExecution,
  type WorkspaceFileContentCommitRequest,
  type WorkspaceFileContentCommitResult,
  type WorkspaceFileContentRecoveryExecution,
  type WorkspaceFileContentRecoveryRequest,
  type WorkspaceCanonicalHistoryRestoreExecution,
  type WorkspaceCanonicalHistoryRestoreRequest,
  type WorkspaceCanonicalHistoryRestoreResult,
  type WorkspaceFileStructuralMutationExecution,
  type WorkspaceFileStructuralMutationRequest,
  type WorkspaceFileStructuralMutationResult,
  type WorkspaceCanonicalUndoTurnExecution,
  type WorkspaceCanonicalUndoTurnOutcome,
  type WorkspaceCanonicalUndoTurnRequest,
  type WorkspaceCanonicalUndoTurnResult,
  type WorkspaceFileContentSnapshot,
} from "./tools/file/workspace-runtime-adapter";
export { createTaskTool } from "./tools/tasks/task-tool";
export {
  getTaskCreationReturnContext,
  runWithTaskCreationReturnContext,
  taskCreationReturnContextForState,
  type TaskCreationReturnContext,
} from "./runtime/task-creation-return-context";
export {
  getTaskCreationBackgroundTaskProvenance,
  getTaskCreationLiveMiniAppContext,
  runWithTaskCreationAmbientContext,
  runWithTaskCreationLiveMiniAppContext,
  taskCreationBackgroundTaskProvenanceForState,
  taskCreationLiveMiniAppContextForState,
  type TaskCreationBackgroundTaskProvenance,
  type TaskCreationLiveMiniAppContext,
} from "./runtime/task-creation-live-mini-app-context";
export {
  effectiveLiveMiniAppSessionForState,
  getLiveMiniAppExecutionContext,
  runWithLiveMiniAppExecutionContext,
  type LiveMiniAppExecutionContext,
} from "./runtime/live-mini-app-execution-context";
export {
  hasAvailableTaskReportBackContinuation,
  parseTaskReportBackContinuation,
  TASK_CONTINUATION_LOCAL_STATUSES,
  type TaskContinuationLocalStatus,
  type TaskReportBackContinuation,
} from "./runtime/task-report-back-continuation";
export { createScheduleTool } from "./tools/tasks/shortcuts/schedule";
export {
  setTaskToolRuntime,
  getTaskToolRuntime,
  type TaskToolRuntime,
  type TaskToolCreateInput,
} from "./tools/tasks/task-tool-runtime";
export {
  setMiniAppToolRuntime,
  getMiniAppToolRuntime,
  resetMiniAppToolRuntimeForTests,
  type MiniAppToolRuntime,
  type MiniAppSourceFile,
  type MiniAppSourceWrite,
} from "./tools/apps/mini-app-runtime";
export { createMiniAppTool, dispatchMiniAppCommand, miniAppToolSchema } from "./tools/apps/mini-app";
export {
  createConnectedWebAccountReadTool,
  dispatchConnectedWebAccountRead,
  connectedWebAccountReadToolSchema,
  listConnectedWebAccountCapabilities,
  resolveConnectedWebAccountReadActor,
  projectConnectedWebAccountReadResult,
  type ConnectedWebAccountReadToolArgs,
  type ConnectedWebAccountReadToolContext,
} from "./tools/connected-web-accounts/read-connected-web-account";
export {
  createConnectedWebAccountActionTool,
  connectedWebAccountActionToolSchema,
  type ConnectedWebAccountActionToolArgs,
} from "./tools/connected-web-accounts/act-connected-web-account";
export {
  createManageConnectedWebOperationTool,
  dispatchManageConnectedWebOperation,
  manageConnectedWebOperationToolSchema,
  resolveManageConnectedWebOperationActor,
  type ManageConnectedWebOperationToolArgs,
  type ManageConnectedWebOperationToolContext,
} from "./tools/connected-web-accounts/manage-connected-web-operation";
export {
  createControlConnectedWebOperationTool,
  dispatchControlConnectedWebOperation,
  controlConnectedWebOperationToolSchema,
  type ControlConnectedWebOperationToolArgs,
} from "./tools/connected-web-accounts/control-connected-web-operation";
export {
  getConnectedWebAccountReadToolRuntime,
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebAccountReadToolRuntime,
  type ConnectedWebAccountCapability,
  type ConnectedWebAccountReadFact,
  type ConnectedWebAccountReadOutput,
  type ConnectedWebAccountReadFailure,
  type ConnectedWebAccountReadFailureCode,
  type ConnectedWebAccountAuthenticationIntervention,
  type ConnectedWebAccountAuthenticationReason,
  type ConnectedWebAccountReadRecovery,
  type ConnectedWebAccountReadResult,
  type PublicBrowserReadInput,
  type PublicBrowserReadResult,
  type ConnectedWebAccountReadSuccess,
  type ConnectedWebAccountReadToolActorContext,
  type ConnectedWebAccountReadToolInput,
  type ConnectedWebAccountReadToolRuntime,
  getConnectedWebAccountActionToolRuntime,
  setConnectedWebAccountActionToolRuntime,
  type ConnectedWebAccountActionToolInput,
  type ConnectedWebAccountActionToolRuntime,
  type ConnectedWebAccountActionResult,
  getConnectedWebOperationToolRuntime,
  setConnectedWebOperationToolRuntime,
  getConnectedWebOperationDirectToolRuntime,
  setConnectedWebOperationDirectToolRuntime,
  type ConnectedWebOperationControl,
  type ConnectedWebOperationSafeProjection,
  type ConnectedWebOperationToolActorContext,
  type ConnectedWebOperationToolInput,
  type ConnectedWebOperationToolResult,
  type ConnectedWebOperationToolRuntime,
  type ConnectedWebOperationDirectCommand,
  type ConnectedWebOperationDirectToolInput,
  type ConnectedWebOperationDirectToolResult,
  type ConnectedWebOperationDirectToolRuntime,
} from "./tools/connected-web-accounts/runtime";
// D384 §5.4 — local (relay-tier) MCP tool runtime DI seam. Server wiring
// injects the impl at boot via `setLocalMcpToolRuntime`.
export {
  setLocalMcpToolRuntime,
  getLocalMcpToolRuntime,
  resetLocalMcpToolRuntimeForTests,
  type LocalMcpToolRuntime,
  type LocalMcpToolActorContext,
  type LocalMcpRegisterInput,
  type LocalMcpServerSummary,
  type LocalMcpActionResult,
} from "./tools/mcp/local-mcp-runtime";
export {
  createManageLocalMcpTool,
  dispatchManageLocalMcpCommand,
  manageLocalMcpToolSchema,
} from "./tools/mcp/manage-local-mcp";
export { listTaskToolCommandNames } from "./tools/tasks/schema";
export { rejectNotYetWiredTaskParams } from "./tools/tasks/validate";
export {
  validateTaskSelectionForCreate,
  validateTaskModelSelectionForCreate,
} from "./tools/tasks/selection-validation";
// D429 Phase 3 — exact task model selection (strict pin; curated IDs only).
export {
  validateExactTaskModelSelection,
  assertExactTaskModelSelection,
  type ExactModelSelectionFailureCode,
  type ExactModelSelectionFailure,
  type ValidateExactTaskModelInput,
} from "./config/validate-exact-task-model";
export { createSearchMemoryTool } from "./tools/memory/search-memory";
export { createManageMemoryTool } from "./tools/memory/manage-memory";
export {
  setArtifactStorage,
  resetArtifactStorage,
  getArtifactZone,
} from "./tools/artifacts/storage-registry";
// D362 Milestone B — inPlace office-session broker registry. Server boot
// wires the real broker (setOfficeSessionBroker) symmetric with
// setArtifactStorage above.
export {
  setOfficeSessionBroker,
  getOfficeSessionBroker,
  resetOfficeSessionBroker,
  type OfficeSessionBroker,
  type OfficeSessionMint,
  type OfficeSessionMintOptions,
} from "./tools/office/session-broker";
// D087 Phase 2A — backup subsystem public API (storage wiring +
// revision recording). Called from the server boot sequence (setBackupStorage)
// and the `file.apply_patch` success path (recordRevision).
// D090 — session-notifications helpers for silent direct-dispatch
// Accept/Reject. Consumed by the server WS handler (append on
// reject) and the pre-model node (drain + inject into system
// prompt at turn start).
export {
  appendSessionNotification,
  drainSessionNotifications,
  buildSessionNotificationsBlock,
  NOTIFICATIONS_BLOCK_MAX_LINES,
  sanitizeForSystemPrompt,
  UNKNOWN_PATH_SENTINEL,
  type AppendNotificationInput,
} from "./notifications/session-notifications";

export {
  recordRevision,
  setBackupStorage,
  resetBackupStorage,
  blobRelPathFor,
  setRevisionEventSink,
  resetRevisionEventSink,
  type RevisionEventSink,
  findLatestRevisionForPath,
  sweepPerFileCap,
  sweepHourly,
  startBackupGcScheduler,
  stopBackupGcScheduler,
  isBackupGcSchedulerRunning,
  BACKUP_ROUTING,
  DEFAULT_GC_CONFIG,
  DEFAULT_GC_INTERVAL_MS,
  type RecordRevisionInput,
  type RecordRevisionResult,
  type GcConfig,
  type StartBackupGcOptions,
  type PerFileSweepResult,
  type HourlySweepResult,
} from "./tools/file/backups";
export { createExecuteArtifactTool } from "./tools/execute-artifact/execute-artifact";
export { createTranscribeAudioTool } from "./tools/audio/transcribe-audio";
export { detectRuntime, listSupportedExtensions, RUNTIME_ALLOWLIST } from "./tools/execute-artifact/runtimes";
export { buildRelaySandboxProfile } from "./relay/sandbox-profile-builder";

// Prompts
export {
  buildSystemPrompt,
  TIME_CONTEXT_HEADER,
  buildTimeContextBlock,
  type TimeContextInput,
  VOICE_MODE_PROMPT,
  MEMORY_BRIEF_HEADER,
  MEMORY_DELTA_HEADER,
  SOUL_FILE_HEADER,
  SKIP_TOOL_MULTI_HUMAN_PROMPT,
  ROOM_CONTEXT_MESSAGE_HEADER,
} from "./prompts/templates";
export { interpolate } from "./prompts/interpolate";

// Memory stores
export {
  commitForegroundMemoryOrdinaryFallback,
  saveMemory,
  searchMemory,
  replaceMemory,
  demoteMemory,
  archiveMemory,
  promoteMemory,
  getPromptBrief,
  getPromptBriefReadOnly,
  selectPromptBriefMemories,
  stagePromptBriefMemories,
  stagePromptBriefMemoryStructuralPage,
  loadPromptBriefMemoryOrdinarySelections,
  packOpenedPromptBriefMemories,
  commitPromptBriefMemoryOverflow,
  type PromptBriefMemoryStructuralCursor,
  type PromptBriefMemoryStructuralPage,
  listMemories,
  countMemories,
  getMemoryById,
  updateMemory,
  hardDeleteMemory,
  encodeMemoryListCursor,
  decodeMemoryListCursor,
  lockAtomicProjectionDestinationAuthority,
  setMemoryAuditSink,
  assertNamespaceWriteAccess,
  attachMemoryToNamespace,
  detachMemoryFromNamespace,
  getMemoryNamespaces,
  type SaveMemoryOptions,
  type SearchMemoryOptions,
  type MemoryResult,
  type StagedPromptBriefMemories,
  type PromptBriefMemory,
  type MemoryListItem,
  type MemoryDetail,
  type HardDeleteMemoryResult,
  type ListMemoriesOptions,
} from "./store/memory-store";
export {
  installAuthoredMemorySemanticChangeSink,
  emitAuthoredMemorySemanticChange,
  _resetAuthoredMemorySemanticChangeSinkForTests,
  type AuthoredMemorySemanticChange,
  type AuthoredMemorySemanticChangeKind,
  type AuthoredMemorySemanticChangeSink,
} from "./store/authored-memory-semantic-change";
export {
  deliverForegroundMemoryMutationEffect,
  type CommittedForegroundMemoryEffectReceipt,
  type ForegroundMemoryEffectAcknowledgement,
} from "./store/foreground-memory-effect-delivery";
export {
  listScopeMemories,
  getScopeMemoryById,
  searchScopeMemory,
  updateScopeMemory,
  demoteScopeMemory,
  archiveScopeMemory,
  hardDeleteScopeMemory,
} from "./store/scope-memory-store";
// M173 — shared share/grant helper (used by the share_memory tool + grant route)
export {
  shareMemoryToUser,
  type ShareMemoryOutcome,
} from "./tools/memory/share-memory";
export {
  EmbeddingProviderError,
  embedText,
  embedTexts,
  embedTextWithProvenance,
  getEmbeddingDims,
  type EmbeddingErrorCode,
  type EmbeddingProvider,
  type EmbeddingWithProvenanceV1,
  getProtectedMemoryEmbeddingConfiguration,
} from "./store/embeddings";
export {
  computeMessageFingerprint,
  type ComputeFingerprintOptions,
} from "./store/fingerprint";
export {
  ensureSession,
  reserveMemoryReviewSources,
  appendTranscriptMessages,
  searchSessions,
  getLatestSession,
  getLatestSubagentSession,
  getLatestSessionForRoom,
  getLatestSessionForRoomAcrossMembers,
  getSessionMessages,
  getLatestSessionMessages,
  getRoomMessagesBeforeCursor,
  getRoomMessagesAcrossMemberSessions,
  getRoomMessagesAcrossMemberSessionsWithSelection,
  findLatestUserMessageAt,
  getRunAgentTranscript,
  SUBAGENT_GRAPH_THREAD_PREFIX,
  isSubagentGraphThreadId,
  type EnsureSessionOptions,
  type SessionSearchResult,
  type SessionInfo,
  type SessionMessage,
  type RoomHistorySelectedMessageCoordinate,
  type RunAgentTranscriptMessage,
  type RunAgentTranscriptToolCall,
  type GetRunAgentTranscriptOptions,
} from "./store/session-store";
export {
  listReactionsForMessageIds,
  listReactionsForMessage,
  addReaction,
  removeReaction,
  type ReactionAggregate,
} from "./store/message-reactions-store";
export {
  normalizeRoomMessageSearchQuery,
  roomMessageSearchTsquery,
  queryRoomMessageContentIndex,
  searchRoomMessages,
  searchChats,
  getRoomMessagesAround,
  ROOM_MESSAGE_SEARCH_LIMIT_MAX,
  ROOM_MESSAGE_SEARCH_MAX_QUERY_CHARS,
  ROOM_MESSAGE_SEARCH_MAX_TERMS,
  type NormalizedRoomMessageSearchQuery,
  type NormalizeRoomMessageSearchQueryResult,
  type RoomMessageSearchDb,
  type RoomMessageSearchMode,
  type RoomMessageSearchReadArgs,
  type RoomMessageSearchReadResult,
  type RoomMessageSearchValidationError,
  type RoomMessageCursor,
  type RoomMessageSearchHit,
  type RoomMessageSearchPage,
  type ChatSearchConversationHit,
  type ChatSearchMessageHit,
  type ChatSearchPage,
  type RoomMessagesAroundPage,
} from "./store/room-message-search";
export {
  getProfile,
  getProfileByAgentId,
  getAgentExecutionConfigById,
  getAgentDisplayNameById,
  getAgentHandleById,
  upsertProfile,
  updateFallbackPolicy,
  getVoices,
  upsertVoiceAssignment,
  removeVoiceAssignment,
  assertValidVoiceLangKey,
  type NautiloProfile,
  type UpsertProfileInput,
} from "./store/profile-store";

// Memory learning loop
export {
  prepareMemoryReview,
  type MemoryReviewOptions,
  type MemoryReviewPreparation,
  type MemoryReviewModelInvocation,
} from "./memory/background-reviewer";
export {
  countUserTurns,
  shouldRunExitFlush,
  runExitFlush,
} from "./memory/exit-flush";
export {
  runProtectedBackgroundMemoryReview,
} from "./memory/protected-background-memory-review";
export {
  createProtectedBackgroundMemoryStaging,
  type ProtectedBackgroundMemoryCandidateMetadata,
  type ProtectedBackgroundMemoryOutputSlot,
  type ProtectedBackgroundMemoryStaging,
} from "./memory/protected-background-memory-staging";

// History
export {
  processHistory,
  estimateTokenCount,
  type HistoryConfig,
  type ProcessedHistory,
} from "./utils/history-manager";

// Error classification
export {
  classifyError,
  classifyErrorSimple,
  getRetryStrategy,
  isRetryableError,
  isTokenLimitError,
  isRateLimitError,
  isNetworkError,
  isTimeoutError,
  isOverloadedError,
  formatErrorBrief,
  waitForRetryDelay,
  messageImpliesCapabilityMismatch,
  type ClassifiedError,
  type RetryStrategy,
  type ErrorCategory,
} from "./utils/errors";

// D141 Phase 1 — friendly error translator. Wired into the runtime
// job-loop's catch site so user-facing errors never leak raw upstream
// blobs. Server logs continue to capture the full provider detail via
// `formatProviderError` (unchanged).
export {
  toFriendlyError,
  toFriendlyGraphBudgetError,
  toFriendlyNoProgressError,
  friendlyMessageFor,
  friendlyMessageWithCode,
  codeFor,
  mapCategory,
  type FriendlyError,
  type FriendlyErrorCategory,
  type MdlCode,
} from "./utils/friendly-errors";
export { invokeWithRetry, type RetryOptions } from "./utils/invoke";

// Chat model invocation (main agent path — budget, timeout, fallback)
export {
  resolveCompletionBudget,
  invokeChatModelWithFallback,
  PreparedContextExceededError,
  isPreparedContextExceededError,
  shouldFallbackToNextModel,
} from "./utils/chat-model-invocation";
export { messagesContainImageInputs, hasImageContent, isImageContentBlock } from "./utils/message-modalities";

// Model health
export {
  checkModelHealth,
  isModelHealthy,
  getHealthyModels,
  clearHealthCache,
  markModelInvokeFailure,
  modelInvokeCooldownRemainingMs,
} from "./utils/model-health";

// Time utilities
export { sleep, withTimeout } from "./utils/time";

// Soul
export {
  generateSoulFile,
  generateSoulFileFallback,
  generateSoulFileStream,
  SOUL_GENERATION_FAILED_MESSAGE,
  type SoulGenerationStreamEvent,
} from "./soul/generate-soul-file";
export { getSoulFileMirrorPath, mirrorSoulFileToDisk, loadSoulFileFromDisk } from "./soul/soul-file-mirror";
export { SoulFileInputSchema, normalizeSoulFileInput, type SoulFileInput } from "./soul/types";

// Error hierarchy
export {
  NautiloError,
  ConfigurationError,
  InfraUnavailableError,
  TransientError,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
  ConcurrencyError,
  QuotaError,
  ToolExecutionError,
  NotFoundError,
} from "./errors/index";

// D296 P2 — official + DB skills resolution seam (ingress, discover_skills, view_skill)
export {
  resolveEnabledBodies,
  resolveByName,
  mergeOfficialWithDbRows,
} from "./skills/resolve-skills";
export {
  requiresToolsMet,
  selectSkillsForTurn,
  type SkillBody,
  type SkillCatalogEntry,
  type SelectSkillsForTurnInput,
  type SelectSkillsForTurnResult,
} from "./skills/select-skills-for-turn";
export { buildSkillBodyBlock } from "./prompts/templates";

// D296 P3 — code-shipped official skills registry (consumed by the server skills routes)
export { OFFICIAL_SKILLS, getBundledSkill } from "./skills/bundled";
export type { BundledSkill } from "./skills/bundled";

// D379 — code-shipped official commands registry + resolution seam
// (consumed by the server slash-command expander)
export { OFFICIAL_COMMANDS, getBundledCommand } from "./commands/bundled";
export type { BundledCommand } from "./commands/bundled";
export {
  resolveByName as resolveCommandByName,
  mergeOfficialWithDbRows as mergeOfficialCommandsWithDbRows,
} from "./commands/resolve-commands";

// Deep Research
export {
  createDeepResearchAgent,
  createDeepResearchGraph,
  fromDeepResearchConfig,
  DeepResearchUnavailableError,
  deepResearchModelPlanFromConfiguration,
  resolveDeepResearchModelPlan,
  validateDeepResearchModelPlan,
  type DeepResearchAgentConfig,
  type DeepResearchConfiguration,
  type DeepResearchRuntimeConfigOptions,
  type DeepResearchModelLane,
  type DeepResearchModelPlan,
  type DeepResearchAgentState,
} from "./subagents/deep-research/index";
export {
  deepResearchTaskMetadata,
  readDeepResearchTaskMetadata,
  type DeepResearchTaskMetadata,
} from "./subagents/deep-research/shared/task-metadata";

export {
  publishPreparedMemoryReview,
  revalidateMemoryReviewAuthority, deliverMemoryReviewEffect,
  type PreparedMemoryReview, type MemoryReviewTransaction,
  type MemoryReviewPublication, type MemoryReviewEffect,
} from "./memory/memory-review-publication";
export { withSerializableAgentTrustContext } from "./store/trust-agent-db";
export {
  MemoryMutationAuthorityError,
  revalidateMemoryMutationAuthority,
  revalidateHumanMemoryMutationAuthority,
} from "./store/memory-mutation-authority";
export { protectedMemoryAuthorityFromEnvelope } from "./tools/memory/protected-memory-authority";

export { MemoryReviewError } from "./memory/memory-review-staging";
export { exportFinalizedSecurityResearch, assertSecurityResearchResumeBinding, assertSecurityResearchContextFailureRecovery, type SecurityResearchExportInput } from "./tools/security/research-export";

export { ProviderTimeoutError, isSafelyRetryableProviderTimeout } from "./providers/errors";

export type {
  OrdinaryContentAccessPort,
  OrdinaryContentAccessForState,
  OrdinaryContentAccessSelection,
  OrdinaryContentAccessPrepared,
  OrdinaryContentAccessPreparedOperation,
  OrdinaryContentAccessPreparationFailure,
  OrdinaryShareExecutionIdentity,
} from "./runtime/ordinary-content-access";
export { collapseWhitespaceShareApprovalSnippet } from "./post-model/share-approval-preview";
export { OrdinaryContentAccessRetryRequiredError } from "./runtime/ordinary-content-access";

export * from "./schema/index";
export * from "./queries/owned-photo-library";
export * from "./queries/push-notifications";
export { createEventFeedPreferenceStore } from "./queries/event-feed-preferences";
export * from "./queries/media-generations";
export * from "./queries/connected-apps";
export * from "./queries/legacy-photo-history";
export * from "./queries/reflection-sources";
export * from "./queries/personal-encryption-coverage";
export * from "./queries/video-generation-links";
export {
  createDatabase,
  db,
  getSharedDirectDb,
  resolveAppDatabaseConnectionString,
  __resetSharedDirectDbForTests,
  type Database,
} from "./config/database";

// D427 (Wave 4) — shared recovery/acceptance helpers used by both the
// Compose restore/upgrade path and the `nautilo-dev` restore/upgrade/verify
// path. Pure + dependency-free so operator tooling can import them without
// pulling the full @nautilo/db runtime.
export {
  sqlLiteral,
  parseDotenv,
  buildAppRolePasswordReconcileSql,
  LOGTO_TENANT_PASSWORD_RESYNC_SQL,
  planCredentialReconciliation,
  runRuntimeAcceptance,
  type CredentialReconcileKind,
  type CredentialReconcilePipeline,
  type CredentialReconcilePlan,
  type RuntimeAcceptanceCheckId,
  type RuntimeAcceptanceResponse,
  type RuntimeAcceptanceExecResult,
  type RuntimeAcceptanceTransport,
  type RuntimeAcceptanceAppRoleProbe,
  type RuntimeAcceptanceDirectPostgresProbe,
  type RuntimeAcceptanceTargets,
  type RuntimeAcceptanceCheck,
  type RuntimeAcceptanceReport,
  type RuntimeAcceptanceOptions,
} from "./restore-acceptance";
import {
  createDirectDb,
  createOfflineDirectDb,
  compileOfflineDirectQuery,
  type DirectDatabase,
  type OfflineDirectDatabase,
  type OfflineDirectQuery,
  type OfflineDirectQueryRow,
  resolveDirectDatabaseConnectionString,
} from "./config/direct-database";

export {
  createDirectDb,
  createOfflineDirectDb,
  compileOfflineDirectQuery,
  type DirectDatabase,
  type OfflineDirectDatabase,
  type OfflineDirectQuery,
  type OfflineDirectQueryRow,
  resolveDirectDatabaseConnectionString,
};
// D129 P3 — agent-vs-auth Postgres role split (Stack 11.5).
// The agent runtime should use `agentDb` (or `createAgentDatabase()`)
// instead of the full-privilege `db` singleton. See packages/db/README.md
// for role-specific connection setup.
export {
  agentDb,
  createAgentDatabase,
  createDirectAgentDb,
  getSharedDirectAgentDb,
  resolveAgentDatabaseConnectionString,
  resolveDirectAgentDatabaseConnectionString,
  __resetSharedDirectAgentDbForTests,
  type AgentDatabase,
  type DirectAgentDatabase,
} from "./config/agent-database";

export {
  createCryptoDatabase,
  getSharedDirectCryptoDb,
  resolveCryptoDatabaseConnectionString,
  __resetSharedDirectCryptoDbForTests,
  CryptoDatabaseConnectionUnavailableError,
  type CryptoDatabase,
} from "./config/crypto-database";

export {
  setRuntimeStatementObserver,
  type RuntimeStatementRole,
  type RuntimeStatementObserver,
} from "./config/runtime-statement-observer";

export {
  asPostgresJsExecutor,
  createPostgresJsBridgeConnection,
  createPostgresJsCanonicalBridgeConnection,
  type PostgresJsBridgeConnection,
  type PostgresJsCanonicalBridgeConnection,
  type PostgresJsCanonicalTransaction,
  type PostgresJsBridgeExecutor,
  type PostgresJsBridgeIsolationLevel,
  type PostgresJsBridgeRow,
  type PostgresJsBridgeScalar,
} from "./config/postgres-js-executor";

export {
  registerPoolForShutdown,
  closeRegisteredPools,
  __resetPoolShutdownRegistryForTests,
  __getRegisteredPoolNamesForTests,
  type RegisteredPool,
} from "./config/pool-shutdown-registry";

// D168 P2 — Path C RLS trust-context wrapper.
export {
  withTrustContext,
  setTrustContextOnTx,
  type TrustContext,
  type TransactableDatabase,
} from "./connection/with-trust-context";

export { eq, ne, and, or, sql, desc, asc, ilike, notLike, inArray, notInArray, arrayContains, lt, lte, gt, gte, isNull, isNotNull, exists, notExists, count, max, type SQL } from "drizzle-orm";
export { alias } from "drizzle-orm/pg-core";
export {
  createNamespaceBoundaryProjection,
  namespaceSubsetPredicate,
  privateNamespaceBoundarySql,
  publicNamespaceBoundarySql,
} from "./queries/namespace-access";
export { ensureDatabase } from "./utils/ensure-database";
export {
  buildAgentRoleGrantsSql,
  buildLangchainCheckpointRoleGrantsSql,
  buildMemoryCryptoLifecycleRoleGrantsSql,
  buildNotificationIntelligenceRoleGrantsSql,
  getAgentRoleConstants,
  AGENT_APPEND_NOTIFICATION_TABLES,
  AGENT_DENIED_NOTIFICATION_TABLES,
  AGENT_SELECT_ONLY_TABLES,
  SENSITIVE_TABLES,
  USERS_PUBLIC_VIEW_COLUMNS,
  LANGCHAIN_CHECKPOINT_TABLES,
} from "./utils/agent-role-grants";
export {
  buildCryptoRoleReconcilePsqlScript,
  buildFullCryptoTablePrivilegeReconcileSql,
  buildCryptoTablePrivilegeReconcileSql,
  CRYPTO_DB_PASSWORD_ENV_KEY,
  CRYPTO_DB_ROLE,
  CRYPTO_DB_ROLE_ATTRIBUTES,
  CRYPTO_IDENTITY_READ_COLUMNS,
  CRYPTO_TABLE_PRIVILEGES,
  type CryptoTablePrivilege,
} from "./utils/crypto-role-contract";
export {
  buildAppRoleOwnershipRepairSql,
  buildFullLegacyRoleRepairSql,
  buildVectorExtensionRepairSql,
  NAUTILO_APP_ROLE,
  NAUTILO_ESSENTIAL_SELECT_TABLE,
  PROBE_NAUTILO_ESSENTIAL_SELECT_SQL,
  PROBE_PUBLIC_OBJECTS_NOT_OWNED_SQL,
} from "./utils/legacy-role-repair";
export {
  createHostedDatabaseSecret,
  withHostedDatabaseSecret,
  reconcileHostedCluster,
  getHostedClusterContractSql,
  getHostedClusterRoleAttributes,
  type HostedDatabaseSecret,
  type HostedClusterKind,
  type HostedClusterDatabase,
  type HostedClusterStage,
  type HostedRoleName,
  type HostedRoleAttributes,
  type HostedRoleCreation,
  type HostedDatabaseCreation,
  type HostedSqlOperation,
  type HostedCredentialValidation,
  type HostedRequiredExtension,
  type HostedClusterAdminAdapter,
  type HostedAppClusterCredentials,
  type HostedLogtoClusterCredentials,
  type HostedClusterReconciliationRequest,
  type HostedLogtoClusterReconciliationRequest,
  type HostedClusterRequest,
  type HostedClusterCheckpoint,
  type HostedClusterFailureKind,
  type HostedClusterFailure,
  type HostedClusterReconciliationResult,
} from "./utils/hosted-cluster-reconcile";
export { seedDefaultOwner } from "./utils/seed-default-owner";
export {
  findClaimedOwnerId,
  findClaimedOwnerIdWithDb,
} from "./utils/find-claimed-owner";
export {
  findDefaultAgentForOwner,
  findDefaultAgentForOwnerWithDb,
} from "./utils/find-default-agent";
export {
  assertCanCreateBootstrapOwner,
  assertConnectedDbMarkerMatches,
  assertDirectConnectionMatchesInstance,
  clearDbConnectionOverrides,
  decideInstanceIdentityAction,
  DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES,
  ensureConnectedDbIdentity,
  hasDefaultPriorLifeEvidence,
  listDbConnectionOverrides,
  resolveExpectedDbInstanceId,
  type DbIdentityCheckResult,
  type InstanceIdentityAction,
} from "./utils/db-identity-guard";
export {
  seedTrustPersonal,
  M128_CAPABILITY_SLUGS,
  M128_ROLE_SLUGS,
  M128_GROUP_TYPES,
  M128_ROLE_CAPABILITIES,
} from "./utils/seed-trust-personal";
export { seedDefaultAgent } from "./utils/seed-default-agent";
export { seedDefaultRoom } from "./utils/seed-default-room";
export {
  claimBootstrapSeedAgentInTx,
  claimBootstrapSeedUserInTx,
  seedPersonalAgentForInviteeInTx,
  seedPersonalPrivateRoomInTx,
  // M128 D2: seedInviterAgentPrivateRoomInTx removed — every invitee gets their own Personal Room.
  type InviteSeedTx,
  type SeedPersonalAgentResult,
  type ClaimBootstrapSeedUserResult,
} from "./utils/seed-invitee";
export { updateOwnerName } from "./utils/update-owner-name";
export {
  updateOwnerHandle,
  type UpdateOwnerHandleResult,
} from "./utils/update-owner-handle";
export {
  renameAgentProfileIdentity,
  setAgentHandle,
} from "./utils/rename-agent-profile-identity";
// D425 Wave 1A — transaction-aware profile/identity/handle primitives for
// the portable Genie profile importer. The existing rename/setAgentHandle
// helpers each open their own transaction; these twins take a caller-supplied
// tx so the importer owns the commit boundary. Also exports the frozen Wave
// 1A profile allowlist and the target-state digest used for stale-plan
// detection. See packages/db/src/utils/profile-migration-primitives.ts.
export {
  applyWave1AProfileAllowlist,
  applyWave1AProfileFieldsInTx,
  isWave1AProfileFieldAllowed,
  extractHandleIntent,
  applyProfileIdentityInTx,
  renameAgentProfileIdentityInTx,
  setAgentHandleInTx,
  readTargetStateForDigestInTx,
  computeTargetStateDigestInTx,
  computeTargetStateDigestFromState,
  canonicalTargetState,
  HandleCollisionError,
  WAVE_1A_PROFILE_ALLOWED_FIELDS,
  WAVE_1A_PROFILE_EXCLUDED_LIFECYCLE_FIELDS,
  WAVE_1A_PROFILE_EXCLUDED_IDENTITY_FIELDS,
  type ProfileMigrationTx,
  type Wave1AProfileField,
  type Wave1AProfilePayload,
  type ApplyAllowlistResult,
  type HandleIntent,
  type TargetStateDigestInput,
} from "./utils/profile-migration-primitives";
// D425 Wave 1B — narrow, transaction-aware private-memory migration
// primitives for the portable Genie profile importer: a source-eligibility
// helper (pure evaluator + transaction-aware fetcher) that walks every
// memory_namespaces / memory_scopes edge and accepts a memory only when it
// is purely private to the exporting owner, a record encoder projecting a
// source memory onto the MemoryRecord contract (no IDs / no embedding),
// and an import-only insert helper that writes a caller-supplied target
// embedding + the memory namespace junction inside the caller's
// transaction (no embedding gen / no dedup / no update). See
// packages/db/src/utils/profile-migration-memory-primitives.ts.
export {
  encodePrivateMemoryRecord,
  evaluatePrivateMemoryEligibility,
  fingerprintPrivateMemoryRecord,
  insertPrivateMemoryInTx,
  isMemoryEligibleForPrivateExportInTx,
  listPrivateMemoryFingerprintsInNamespaceInTx,
  replayPrivateMemoriesInTx,
  type InsertPrivateMemoryInTxArgs,
  type InsertPrivateMemoryInTxResult,
  type PrivateMemoryReplayResult,
  type PrivateMemoryEligibilityInput,
  type PrivateMemoryEligibilityReason,
  type PrivateMemoryEligibilityResult,
  type PrivateMemoryNamespaceEdge,
  type PrivateMemoryRecord,
  type PrivateMemoryRecordInput,
  type PrivateMemoryScopeEdge,
  type ReplayPrivateMemoryRecordInTxArgs,
} from "./utils/profile-migration-memory-primitives";
// D425 Wave 3 — narrow, transaction-aware private-artifact migration
// primitives for the portable Genie profile importer: a source-eligibility
// helper (pure evaluator + transaction-aware fetcher) that walks every
// artifact_namespaces edge and accepts an artifact only when every edge's
// Room has exactly the exporting owner's human actor (shared / foreign /
// no-room / no-edge reject the whole artifact; artifact_scopes ignored —
// runtime behavior unimplemented), a pure `PortableArtifact` projection
// that validates a safe logical path + the exact
// `media/artifacts/<opaque-id>.bin` bytesEntry grammar (no source IDs /
// storage URI / revision), and an import-only DB insert helper that writes
// the target artifact row + its artifact_namespaces junction inside the
// caller's transaction (no FS writes / no dedup / no update). See
// packages/db/src/utils/profile-migration-artifact-primitives.ts.
export {
  encodePortableArtifact,
  evaluatePrivateArtifactEligibility,
  insertPrivateArtifactInTx,
  isArtifactEligibleForPrivateExportInTx,
  isValidArtifactBytesEntry,
  isValidArtifactSha256,
  isValidPortableArtifactPath,
  validatePortableArtifactInput,
  type EncodePortableArtifactResult,
  type InsertPrivateArtifactInTxArgs,
  type InsertPrivateArtifactInTxResult,
  type PortableArtifact,
  type PortableArtifactFieldError,
  type PortableArtifactInput,
  type PrivateArtifactEligibilityInput,
  type PrivateArtifactEligibilityReason,
  type PrivateArtifactEligibilityResult,
  type PrivateArtifactNamespaceEdge,
  type ValidatePortableArtifactResult,
} from "./utils/profile-migration-artifact-primitives";
export {
  persistJob,
  updateJobStatus,
  getJobById,
  type PersistJobPayload,
  type PersistedJobRecord,
  type JobPublicationPolicy,
} from "./queries/jobs";
export {
  hasClaimedOwner,
  hasAdminUser,
  hasUnredeemedClaimInvite,
  invitesTableExists,
} from "./utils/setup-state-queries";
export {
  resolveServerProfile,
  getServerProfile,
  upsertServerProfile,
  materializeDefaultServerProfileOnce,
  deriveDefaultServerName,
  type ResolvedServerProfile,
  type ResolveServerProfileOpts,
  type MaterializeDefaultServerProfileOpts,
  type ServerProfilePatch,
  type ServerProfileDb,
} from "./utils/server-profile-queries";
export {
  resolveServerModelConfig,
  getServerModelConfig,
  upsertServerModelConfig,
  type ResolvedServerModelConfig,
  type ServerModelConfigDefaults,
  type ServerModelConfigPatch,
  type ServerModelConfigDb,
  type ServerReasoningPolicy,
} from "./utils/server-model-config-queries";
export {
  RECENT_CONVERSATION_LIMIT_DEFAULT,
  RECENT_CONVERSATION_LIMIT_MIN,
  RECENT_CONVERSATION_LIMIT_MAX,
  MINIMUM_FULL_TURNS_DEFAULT,
  MINIMUM_FULL_TURNS_MIN,
  MINIMUM_FULL_TURNS_MAX,
  MAX_ROOM_CONTEXT_PERCENT_DEFAULT,
  MAX_ROOM_CONTEXT_PERCENT_MIN,
  MAX_ROOM_CONTEXT_PERCENT_MAX,
  STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_DEFAULT,
  STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MIN,
  STENOGRAPHER_PRIOR_CONVERSATION_LIMIT_MAX,
  PASSIVE_RECALL_ENABLED_DEFAULT,
  REFLECTION_SLEEP_ENABLED_DEFAULT,
  isRecentConversationLimit,
  isMinimumFullTurns,
  isMaxRoomContextPercent,
  isStenographerPriorConversationLimit,
  resolveServerContextConfig,
  getServerContextConfig,
  upsertServerContextConfig,
  type ResolvedServerContextConfig,
  type ServerContextConfigPatch,
  type ServerContextConfigDb,
} from "./utils/server-context-config-queries";
export {
  LIVE_SHADOW_ENCRYPTION_TRANSITION_MODES,
  UnsupportedEncryptionTransitionStateError,
  EncryptionTransitionPolicyConflictError,
  EncryptionPublicationPolicyError,
  acquireEncryptionPublicationFence,
  acquireOrdinaryEncryptionPublicationFence,
  acquireEncryptionConsumptionFence,
  assertLiveShadowEncryptionTransitionMode,
  assertLiveShadowEncryptionTransitionBehavior,
  projectLiveShadowEncryptionTransitionPolicy,
  getEncryptionTransitionPolicy,
  compareAndSwapEncryptionTransitionPolicy,
  observationBoundsFromPolicyRow,
  type LiveShadowEncryptionTransitionMode,
  type LiveShadowEncryptionTransitionBehavior,
  type LiveShadowEncryptionTransitionPolicy,
  type EncryptionTransitionPolicyDb,
  type DurableEncryptionTransitionObservationBounds,
} from "./utils/encryption-transition-queries";
export {
  recordStrictShadowBoundaryHealth,
  readStrictShadowBoundaryHealth,
  type StrictShadowBoundaryHealthDb,
  type StrictShadowBoundaryHealthRecord,
  type RecordStrictShadowBoundaryHealthInput,
} from "./utils/strict-shadow-boundary-health";
export {
  validateEncryptionTransitionObservationBounds,
  planEncryptionTransitionObservation,
  recordEncryptionTransitionObservation,
  issueEncryptionTransitionObservationAdmission,
  reconcileExpiredEncryptionTransitionObservationAdmissions,
  consumeEncryptionTransitionObservationAdmission,
  consumeTrustedEncryptionTransitionObservationAdmission,
  issueEncryptionTransitionHistoryReadAdmission,
  consumeSignedEncryptionTransitionHistoryReadAcknowledgement,
  consumeUnavailableEncryptionTransitionHistoryReadAdmission,
  consumeIneligibleEncryptionTransitionHistoryReadAdmission,
  consumeServerUnavailableEncryptionTransitionHistoryReadAdmission,
  reconcileExpiredEncryptionTransitionHistoryReadAdmissions,
  readEncryptionTransitionHistoryReadActivity,
  ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_TOKEN_BYTES,
  ENCRYPTION_TRANSITION_OBSERVATION_ADMISSION_MAX_TTL_MS,
  type EncryptionTransitionObservationBounds,
  type PlannedEncryptionTransitionObservation,
  type EncryptionTransitionObservationDb,
  type EncryptionTransitionObservationAdmission,
  type EncryptionTransitionObservationAdmissionConsumption,
  type EncryptionTransitionHistoryReadAdmission,
  type EncryptionTransitionHistoryReadAdmissionConsumption,
  type EncryptionTransitionHistoryReadResultCounts,
  type EncryptionTransitionHistoryReadActivity,
  type EncryptionTransitionHistoryReadServerUnavailableReason,
} from "./utils/encryption-transition-observations";
export {
  assembleEncryptionTransitionDashboard,
  readEncryptionTransitionDashboard,
  readEncryptionTransitionObservationPressure,
  readLiveShadowTurnDashboard,
  readHumanPeerLiveShadowDashboard,
  readSharedAgentLiveShadowDashboard,
  readDomainKeyCatchUpDashboard,
  LIVE_SHADOW_TURN_STAGES,
  type EncryptionTransitionAttemptRow,
  type EncryptionTransitionCoverageRow,
  type EncryptionTransitionFamilyDashboard,
  type EncryptionTransitionObservationPressure,
  type EncryptionTransitionDashboardDb,
  type LiveShadowTurnStage,
  type LiveShadowTurnStageDashboard,
  type LiveShadowTurnFallbackDashboard,
  type LiveShadowTurnDashboard,
  type HumanPeerLiveShadowDashboard,
  type SharedAgentLiveShadowDashboard,
  type DomainKeyCatchUpDashboard,
} from "./utils/encryption-transition-dashboard";
export {
  getProfileDefaultModelControlSelection,
  setProfileDefaultModelControlSelection,
  getRoomAgentModelControlSelection,
  upsertRoomAgentModelControlSelection,
  resetRoomAgentModelControlSelection,
  parseModelControlSelection,
  InvalidModelControlSelectionError,
} from "./utils/model-control-selection";
export {
  getCachedServerModelConfigRow,
  primeServerModelConfigCache,
  refreshServerModelConfigCache,
  kickServerModelConfigRefresh,
  __resetServerModelConfigCache,
} from "./utils/server-model-config-cache";
export {
  PASSWORD_CHANGE_REASON,
  markMigrationTempPasswordRequired,
  markPasswordChangeRequired,
  markPasswordChangeCompleted,
  getAccountSecurityRowByUserId,
  listLocalLinkedUsersRequiringPasswordChange,
  type PasswordChangeReason,
  type AccountSecurityDb,
  type UserRequiringPasswordChangeRow,
} from "./queries/logto-account-security";
export {
  insertArtifact,
  attachArtifactToNamespace,
  getArtifactNamespaces,
  getArtifactPathByInternalId,
  getNamespacesForArtifactIds,
  detachArtifactFromNamespace,
  findArtifactByIdForNamespaces,
  findArtifactInternalIdByPublicId,
  findArtifactReconciliationIdentity,
  findArtifactByInternalIdForNamespaces,
  lockMutableArtifactForWorkspaceMutation,
  resolveWorkspaceRoomMutationAuthority,
  lockWorkspaceRoomMutationAuthority,
  lockWorkspaceArtifactForCurrentRoomAuthority,
  lockWorkspaceArtifactIncludingDeletedForCurrentRoomAuthority,
  workspaceRoomAuthorityProofAllows,
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findArtifactByPathForNamespaces,
  listArtifactPageForNamespaces,
  listArtifactsForNamespaces,
  type ArtifactListKeyset,
  buildExactNamespaceArtifactPageQuery,
  listArtifactsForExactNamespacePage,
  markArtifactDeletedForExactNamespace,
  updateArtifactPath,
  bumpArtifactRevision,
  markArtifactDeleted,
  restoreArtifactRevision,
  listDiscussionRoomsForArtifact,
  type ArtifactDiscussionRoomCandidate,
  type ListDiscussionRoomsForArtifactInput,
  type InsertArtifactInput,
  type ExactNamespaceArtifactPageCursor,
  type ArtifactReconciliationIdentity,
  type LockedWorkspaceRoomMutationAuthority,
} from "./queries/artifacts";
export {
  createDiscussionRoomForArtifact,
  type CreateDiscussionRoomForArtifactInput,
  type CreatedDiscussionRoom,
} from "./queries/rooms";
export {
  getArtifactStateForNamespaces,
  setArtifactState,
  listArtifactStateKeysForNamespaces,
  _deleteArtifactStateForArtifact,
} from "./queries/artifact-state";
export {
  insertPendingMessageAttachment,
  findPendingMessageAttachmentForSender,
  resolvePendingMessageAttachment,
  cancelPendingMessageAttachment,
  findRetainedMessageAttachmentForNamespaces,
  findExpiredPendingMessageAttachments,
  sumPendingMessageAttachmentBytesForActor,
  stampTurnIdOnAttachments,
  getAttachmentsForTurns,
  markRetainedAttachmentDeletedForNamespaces,
  markRetainedAttachmentsDeletedByTurn,
  getSessionMessageFingerprintById,
  type InsertPendingMessageAttachmentInput,
} from "./queries/message-attachments";
export {
  getRoomNamespaceId,
  findArtifactInternalIdsForCanonicalNamespace,
  recordMessageArtifacts,
  hydrateMessageArtifacts,
  basenameFromPath,
} from "./queries/session-message-artifacts";
export {
  createTask,
  getTaskById,
  getTaskByIdWithMutationVersion,
  listTasksForOwner,
  listStoppableTasksForOwnerRoom,
  updateTask,
  updateTaskIfCurrent,
  insertTaskRun,
  getTaskRuns,
  getLatestRunModelByTask,
  getAgentDisplayNamesByAgentId,
  getOwnerAgentDisplayNamesByAgentId,
  getActiveTaskRun,
  transitionTaskLifecyclePaused,
  transitionTaskLifecycleTerminal,
  countActiveTaskWorkWith,
  getLatestResumableTaskRun,
  repairTaskContentAccessRecovery,
  findAwaitingTaskForRoom,
  markTaskAwaitingWriterReview,
  reserveTaskWriterReviewWorkspaceOperation,
  releaseTaskWriterReviewWorkspaceOperation,
  recordTaskWriterReviewAcceptedReceipt,
  completeTaskRunAndRequeueWriterReviewAccepted,
  startTaskRunForWriterReviewVerification,
  clearTaskWriterReviewAwaitingMarker,
  terminalizeTaskWriterReviewVerificationLost,
  WRITER_REVIEW_ACCEPTED_RECEIPT_METADATA_KEY,
  listAwaitingWriterReviewTasks,
  listPendingWriterReviewVerificationTasks,
  listRunningWriterReviewVerificationTasks,
  findAwaitingTaskRunForApproval,
  transitionTaskApprovalExecution,
  recordTaskPreparation,
  listAwaitingTaskRunsForOwner,
  findOpenPingTask,
  findTimedOutRunningTasks,
  claimDueTasks,
  claimDueProtectedTasks,
  listProtectedAwaitingTaskRunsForAuthorization,
  prepareClaimedProtectedTaskOccurrence,
  clearStaleFireLocks,
  pauseClaimedTaskForAuthorizationDenial,
  pauseAwaitingTaskRunForAuthorizationDenial,
  rescheduleCron,
  markTaskRunning,
  markTaskAwaiting,
  markTaskPaused,
  markTaskCompleted,
  markTaskCancelled,
  markTaskErrored,
  markTaskRunStatus,
  type ActiveTaskWorkCounts,
  type AuthorizationPauseTransition,
  type PrepareClaimedProtectedTaskOccurrenceInput,
  type PrepareClaimedProtectedTaskOccurrenceResult,
  type ProtectedAwaitingTaskRunCursor,
  type ListTasksForOwnerOpts,
  type TerminalTaskLifecycleTransition,
  type WriterReviewAwaitingMarker,
  type RecordWriterReviewAcceptedReceiptResult,
  type ReserveTaskWriterReviewWorkspaceOperationResult,
  type TerminalizeWriterReviewVerificationLostResult,
  type ListAwaitingWriterReviewTasksOptions,
  type TransitionTaskLifecycleTerminalInput,
} from "./queries/tasks";
export {
  appendPendingArtifactEvent,
  drainPendingArtifactEventsForNamespaces,
  PENDING_ARTIFACT_EVENTS_CAP,
  _deletePendingArtifactEventsForArtifact,
  type AppendPendingArtifactEventResult,
} from "./queries/pending-artifact-events";
// D448 Phase 8.2 — transaction-bound coordinator persistence substrate.
// These do not choose authority, open a transaction, or perform a writer cutover.
export {
  acquireWorkspaceDocumentMutationOperationLock,
  findWorkspaceDocumentMutationForIdempotency,
  findWorkspaceDocumentMutationForRecovery,
  findTrustedWorkspaceDocumentMutationReplay,
  findWorkspaceEditorSaveForWriterReviewRecovery,
  acquireWorkspaceArtifactMutationLock,
  casWorkspaceArtifactContentPointer,
  casRestoreDeletedWorkspaceArtifactForMutation,
  createWorkspaceArtifactForMutation,
  casDeleteWorkspaceArtifactForMutation,
  insertWorkspaceDocumentMutationReceipt,
  claimNextWorkspaceDocumentMutationOutboxBatch,
  markWorkspaceDocumentMutationOutboxDispatched,
  markWorkspaceDocumentMutationOutboxFailed,
  releaseStaleWorkspaceDocumentMutationOutboxClaims,
  listStaleWorkspaceDocumentMutationOutboxBatchKeys,
  type WorkspaceDocumentMutationTx,
  type WorkspaceDocumentMutationOperationLock,
  type WorkspaceMutationActorKind,
  type WorkspaceMutationOutboxEventType,
  type WorkspaceMutationOutboxEvent,
  type WorkspaceMutationReceiptEntryInput,
  type WorkspaceMutationEventBatchInput,
  type InsertWorkspaceDocumentMutationInput,
  type WorkspaceCommittedEntryReplay,
  type WorkspaceDocumentMutationCommitReplay,
} from "./queries/workspace-document-mutations";
export {
  findOwnedWorkspaceHistoryByRevisionId,
  findOwnedWorkspaceHistoryByEntryId,
  findLatestEligibleWorkspaceHistory,
  listWorkspaceHistoryForTurn,
  findLatestWorkspaceRedoEligibleHistory,
  listWorkspaceDocumentHistory,
  listWorkspaceRoomDocumentHistory,
  reduceWorkspaceDocumentHistoryLineage,
  resolveWorkspaceDocumentHistoryLineage,
  resolveWorkspaceDocumentHistoryLineageForArtifact,
  setOwnedWorkspaceHistoryGroupPinned,
  touchOwnedWorkspaceHistoryGroup,
  findRecentWorkspaceHumanCheckpoint,
  findLatestDeletedWorkspaceArtifactHistory,
  type WorkspaceHistoryScope,
  type WorkspaceDocumentHistoryRecord,
  type WorkspaceDocumentHistoryLineage,
  type ListWorkspaceDocumentHistoryInput,
} from "./queries/workspace-document-history";
export {
  listCatalog,
  getEnabledBodies,
  getByName,
  upsertSkill,
  setSkillEnabled,
  softDeleteSkill,
  type SkillCatalogEntry,
  type SkillBody,
  type UpsertSkillInput,
} from "./queries/skills";
export {
  listCatalog as listCommandCatalog,
  getByName as getCommandByName,
  upsertCommand,
  setCommandEnabled,
  softDeleteCommand,
  type CommandCatalogEntry,
  type CommandBody,
  type UpsertCommandInput,
} from "./queries/commands";
export {
  findRecentRevision,
  findLatestWorkspaceRevisionForLogicalPath,
  withWorkspaceFileRevisionMetadata,
  type FindRecentRevisionInput,
  type FindRecentRevisionResult,
  type WorkspaceFileRevisionMetadata,
} from "./queries/file-revisions";
export {
  insertLlmUsageEvent,
  getCostsSummary,
  __setLlmUsageDbForTests,
  type InsertLlmUsageInput,
  type CostsRange,
  type CostsTotals,
  type CostsByModelRow,
  type CostsByCallTypeRow,
  type CostsByProviderRow,
  type CostsByUserRow,
  type CostsTimeSeriesPoint,
  type CostsSummary,
} from "./queries/llm-usage";
export {
  insertProviderCostEvent,
  insertProviderCostEventWith,
  buildProviderCostsSummaryQueries,
  providerCostIdempotencyKey,
  estimateProviderToolCostUsd,
  PROVIDER_TOOL_PRICING_VERSION,
  type InsertProviderCostEventInput,
  type ProviderCostEvidenceState,
  type ProviderToolPriceKey,
} from "./queries/provider-costs";
export {
  enterDraining,
  enterDrainingWith,
  transitionApplying,
  transitionApplyingWith,
  renewLease,
  renewLeaseWith,
  clearMaintenance,
  clearMaintenanceWith,
  recoverExpiredMaintenance,
  recoverExpiredMaintenanceWith,
  getMaintenanceState,
  getMaintenanceStateWith,
  countAcceptedWorkWith,
  MAINTENANCE_SINGLETON_KEY,
  MAINTENANCE_REASONS,
  MaintenanceTransitionError,
  type MaintenanceLeaseDurations,
  type MaintenanceSnapshot,
} from "./queries/maintenance";
export {
  insertAcceptance,
  insertAcceptanceWith,
  insertAcceptances,
  insertAcceptancesWith,
  linkAcceptancesToJob,
  linkAcceptancesToJobWith,
  terminalizeAcceptances,
  terminalizeAcceptancesWith,
  terminalizeAllAccepted,
  terminalizeAllAcceptedWith,
  userCancelAcceptances,
  userCancelAcceptancesWith,
  getAcceptance,
  getAcceptanceWith,
  listAcceptancesByStatus,
  listAcceptancesByStatusWith,
  countAcceptancesByStatus,
  countAcceptancesByStatusWith,
  listAcceptancesForJob,
  listAcceptancesForJobWith,
  WORK_ACCEPTANCE_REASONS,
  type WorkAcceptanceReason,
} from "./queries/work-acceptances";
export {
  acquireRoomWriteLock,
  type RoomLockTransaction,
} from "./queries/room-lock";
export {
  discoverRoomAuthorityInTx,
  lockDiscoveredRoomAuthorityInTx,
  RoomAuthorityChangedError,
  type RoomAuthoritySnapshot,
} from "./queries/room-authority-locks";
export {
  findMemoryIdByCreationKeyWith,
  findProjectionRoomByIdWith,
} from "./queries/memory-projections";
export {
  markMessageRecipientDeliveredWith,
  markMessageRecipientReadWith,
} from "./queries/session-message-read-state";
export {
  ROOM_JOURNAL_EXTRACTOR_VERSION,
  createRoomJournalStateInTx,
  reconcileRoomJournalMembershipInTx,
  type RoomJournalMutationTransaction,
} from "./queries/room-journal-state";
export { queryStenographerAdminStatus } from "./queries/stenographer-status";
export {
  classifyReflectionHealth,
  queryReflectionAdminStatus,
} from "./queries/reflection-status";
export * from "./queries/codex";
export * from "./queries/claude-connections";
export * from "./queries/memory-review";

export * from "./queries/memory-review-status";

export { shareWorkspaceArtifact, listWorkspaceSharesForHuman } from "./queries/workspace-sharing";

export { createEventFeedStorage, listArtifactFeedRecipientUserIds } from "./queries/event-feed";

export { memoryEmbeddingValues, memoryEmbeddingCompatibilityCondition } from "./utils/memory-embedding";
export { PHYSICAL_FILE_URI_COLUMNS, physicalFileUriBase, rebindPhysicalFileUri } from "./utils/physical-storage-uris";

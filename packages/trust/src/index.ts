export type {
  PolicyResolver,
  ResolveContextFromPrincipalInput,
  RequestedRoomAdmission,
  RuntimePolicyContext,
  MemoryAccessEnvelope,
  NamespaceMemoryEnvelope,
  ScopeMemoryEnvelope,
  RelationshipLimits,
  ToolAccess,
  ToolAccessDecision,
  ApprovalRoute,
  ApprovalRequest,
} from "./types";

export {
  memoryModeOf,
  isScopeMemoryEnvelope,
  isNamespaceMemoryEnvelope,
  envelopeReadableNamespaces,
  envelopeMutableNamespaces,
  envelopeWritableNamespaces,
} from "./types";
export {
  blockHuman,
  unblockHuman,
  listBlockedHumanUserIds,
  getHumanBlockStatus,
  humanPairIsBlocked,
  directHumanPeerUserId,
  type HumanBlockStatus,
} from "./human-blocks";
export {
  PostgresProtectedScopeCloseSaga,
  type ProtectedScopeCloseBeginResult,
  type ProtectedScopeCloseClaim,
  type ProtectedScopeCloseItem,
  type ProtectedScopeCloseObservation,
  type ProtectedScopeMutationAdmission,
  type ScopeClosePostgresConnection,
  type ScopeClosePostgresExecutor,
  type ScopeCloseRow,
  type ScopeCloseScalar,
} from "./scope-close-saga";
export {
  ScopeMemoryOriginError,
  createScopeMemoryEnvelopeWithOrigin,
  type ScopeMemoryEnvelopeWithOrigin,
} from "./scope-memory-origin";

/** D086 Phase 4 — shared eligible-model list types (implementation in `@nautilo/agent`). */
export type {
  EligibleModel,
  EligibleModelCapabilities,
  EligibleModelControls,
  EligibleModelReasoningControl,
  EligibleModelReasoningEffort,
  EligibleModelReasoningLevel,
  EligibleModelServingIntent,
  EligibleModelServingProfile,
  EligibleModelServingRateCard,
  GetEligibleModelsOptions,
  InferenceTier,
  ModelAvailability,
  ModelPurpose,
  RoutingClass,
} from "./eligible-models-types";

/** D429 Phase 1 — resolved catalog projection types (implementation in `@nautilo/agent`). */
export type {
  IntelligenceTier,
  ResolvedCatalogAvailability,
  ResolvedCatalogProvenance,
  ResolvedCatalogInputModality,
  ResolvedCatalogOutputModality,
  ResolvedCatalogFeatures,
  ResolvedCatalogModel,
  ResolveCatalogModelOptions,
} from "./eligible-models-types";

export { PersonalPolicyResolver, buildGuestToolPolicy } from "./personal-policy-resolver";

/**
 * M037 — command-approval engine (arity classifier + DB matcher) for
 * durable `room`/`always` standing approvals. See ISSUE-M037.
 */
export {
  TOOL_ARITY,
  slotKindFor,
  type SlotKind,
  type ToolArity,
} from "./command-arity";
export {
  classifyCall,
  canonicalSignatureKey,
  formatSignature,
  tokenizeCommand,
  matchCommandApproval,
  createCommandApproval,
  matchCapabilityApproval,
  createCapabilityApproval,
  revokeCommandApproval,
  listCommandApprovals,
  APPROVAL_KIND_TOOL,
  APPROVAL_KIND_CAPABILITY,
  type ClassifiedCall,
  type ApprovalKind,
  type CommandApprovalScope,
  type CommandApprovalRow,
} from "./command-approvals";

/**
 * D120 A1 — sync in-memory cache for bootstrap-time identity facts
 * (ownerId / ownerActorId / defaultAgentId). Populated at server boot
 * + refreshed post-claim. Replaces NAUTILO_OWNER_ID / OWNER_ACTOR_ID /
 * DEFAULT_AGENT_ID env-var reads scattered through the server.
 */
export {
  setBootstrapOwnerId,
  getBootstrapOwnerId,
  setBootstrapOwnerBound,
  isBootstrapOwnerBound,
  setBootstrapOwnerActorId,
  getBootstrapOwnerActorId,
  setBootstrapDefaultAgentId,
  getBootstrapDefaultAgentId,
  _resetBootstrapStateCacheForTests,
} from "./bootstrap-state-cache";

export {
  CAP_MANAGE_SERVER_SECURITY,
  CAP_INVOKE_AGENTS,
  CAP_WRITE_ARTIFACTS,
  CAP_APPROVE_SPENDING,
  CAP_MANAGE_BILLING,
  CAP_CONTROL_DESKTOP,
  CAP_CONTROL_BROWSER,
  CAP_USE_PROJECT_CONTENT,
  CAP_USE_PROJECT_EXECUTION,
  CAP_USE_WORKSTATION,
  CAP_USE_REMOTE_HOSTS,
  CAP_USE_CONNECTIONS,
  CAP_USE_MEDIA_GENERATION,
  CAP_USE_GOOGLE_WORKSPACE,
  CAP_CONTROL_HOME,
  CAP_MANAGE_WORKSTATION_PROFILES,
  CAP_MANAGE_UNCONTAINED_HOST_COMMANDS,
  CAP_MANAGE_MEMBERS,
  CAP_CREATE_INVITES,
  CAP_MANAGE_STANDING_APPROVALS,
  CAP_MODERATE_CONTENT_REPORTS,
  CAPABILITY_SLUGS,
  isCapabilitySlug,
  type CapabilitySlug,
} from "./capabilities";

// DEPRECATED: TOOL_POLICIES is being replaced by @nautilo/catalog.
// These exports are kept for backward compatibility in tests.
// Production code should use getToolCatalog() from @nautilo/catalog.
export {
  getToolPolicy,
  getRegisteredToolNames,
  validateToolRegistry,
  type ToolPolicyEntry,
  type ToolImpact,
  type ToolExecutor,
} from "./tool-policies";

/**
 * D079 Phase 4 / G2 — per-command trust policies for the unified
 * `file` tool. Consumed by the file-tool handler (registered in G3)
 * and the approval dock (G4 commit 11). See
 * `pr-reviews/DECISION-2026-04-21-file-tool-shape.md` + H-025.
 */
export {
  resolveFileCommandPolicy,
  isDestructiveFileCommand,
  listFileCommandNames,
  formatFileToolVerb,
  type FileCommandName,
  type FileCommandSeverity,
} from "./file-tool-policies";

export {
  DEFAULT_NOTIFICATION_LEVEL,
  NotificationPreferenceError,
  getNotificationPreferences,
  isNotificationLevel,
  resolveEffectiveNotificationLevel,
  setDefaultNotificationLevel,
  setRoomNotificationPreference,
  type NotificationPreferenceErrorReason,
} from "./notification-preferences";

export {
  MAX_NOTIFICATION_STATE_DETAILS,
  NotificationStateTooLargeError,
  getChangedNotificationState,
  getImportantMessageArrivals,
  getLegacyOwnRoomUnreadCounts,
  getNotificationState,
  getNotificationUnreadCount,
  sanitizeNotificationLabel,
  type ChangedNotificationState,
} from "./notification-state";

export {
  MAX_STRUCTURED_HUMAN_MENTIONS,
  NotificationClassificationError,
  persistNotificationClassification,
  type AppendNotificationContext,
  type NotificationClassificationTx,
} from "./notification-classification";

export { initPolicyResolver, getPolicyResolver } from "./resolver-singleton";

/** D476 Phase 2 — trusted, name-driven destination resolution for projection sharing. */
export {
  MAX_ROOM_NAME_CANDIDATES,
  ROOM_NAME_QUERY_CANDIDATE_LIMIT,
  ROOM_NAME_FUZZY_THRESHOLD,
  normalizeRoomName,
  resolveAuthorizedRoomName,
  type RoomNameCandidate,
  type ResolvedRoomDestination,
  type RoomNameResolution,
  type RoomChoiceTokenCodec,
  type AuthorizedRoomNameResolverDependencies,
  type ResolveAuthorizedRoomNameInput,
} from "./room-name-resolver";

/**
 * D418 Commit 3 — Workstation execution-admission engine.
 *
 * Strict pure module: takes a slim execution-admission contract
 * (`executionClass + activeSession + exactPlan + tool/operation identity`)
 * and returns one decision — `auto` only for a `run_shell`
 * `profile_bound_sandbox` attempt under an exact active Full Workstation
 * session pinned by a live admitted+revalidated plan, otherwise a structured
 * `none` that leaves normal approval logic intact. Removes the paused 3.2.5c
 * nine-field caller-authored evidence model (profile / path / network / OS /
 * boundedness / MCP / escape booleans); Electron-local execution remains the
 * authority and critical / elevation scanning stays an independent server-side
 * refusal defense. The admission decision never claims local sandbox
 * construction or kernel containment. Does NOT reuse the global
 * `security.level:"yolo"` row.
 *
 * Wiring status: consumed by the server-side decision seam in
 * `packages/server/src/routes/workstation-access.ts`, which reads the LIVE
 * `InMemoryWorkstationSessionRegistry` session, admits + revalidates the
 * transient `WorkstationDispatchPlan`, and calls
 * {@link resolveWorkstationAdmission}. Commit 4 admits only an active-session,
 * exact-plan `profile_bound_sandbox` `run_shell` attempt; Electron-local
 * shell binding and sandbox construction remain fail-closed execution
 * authority and are never represented as a server-confirmed boolean. The
 * live post-model CALL SITE
 * (`packages/agent/src/nodes/post-model.ts` Pass 2) that invokes the server
 * seam is wired by the orchestrator in a separate slice.
 */
export {
  resolveWorkstationAdmission,
  type FullWorkstationSessionEvidence,
  type WorkstationExecutionClass,
  type WorkstationToolIdentity,
  type WorkstationAdmissionEvidence,
  type WorkstationAdmissionReason,
  type WorkstationAdmissionAuto,
  type WorkstationAdmissionNone,
  type WorkstationAdmissionDecision,
} from "./workstation-admission";

export {
  findActorByOwnerId,
  findActorByLogtoSub,
  // M045: rename of the pre-M045 `findAgentActorByOwnerId` (.limit(1) on
  // owner-scoped lookup became non-deterministic under multi-agent).
  findAgentActorForAgent,
  findAgentById,
  findDefaultRoomForActor,
  pickDefaultRoomFromPrivateMemberCandidates,
  type PrivateRoomMemberCandidate,
  findRoomIdByGraphThreadIdForOwner,
  findRoomIdByGraphThreadIdForUser,
  findRoomForUserAndAgentMembers,
  listRoomsForActor,
  type ListRoomsForActorOptions,
  // M122 — room unread counts
  resolveViewerUserIdForActor,
  getRoomUnreadCountsForRecipients,
  listHumanUserIdsInRoom,
  getRoomDetailForMember,
  getSubthreadDetailForMember,
  getSubthreadDetailForMemberWithDb,
  type SubthreadDetailPayload,
  createRoomForOwner,
  createRoomFromMembers,
  type CreateRoomFromMembersParams,
  // M124 — public rooms (kind='open')
  listDiscoverableRoomsForUser,
  listHumanOnlyDiscoverableRoomsForUser,
  joinOpenRoom,
  createOpenRoom,
  type CreateOpenRoomParams,
  findOtherAdminMembers,
  findRoomOwnerUserId,
  createSharedRoomForPair,
  type CreateSharedRoomParams,
  findShareTargetRoom,
  type ShareTargetRoomRow,
  renamePrivateRoomForOwner,
  type RenamePrivateRoomForOwnerParams,
  listManageableRoomsForUser,
  getRoomDetailForManager,
  getRoomGraphThreadForOwnerSession,
  getRoomGraphThreadForViewer,
  findLocalUserByHandle,
  findAgentsOwnedByUser,
  findPersonalAgentsForUser,
  findAllAgents,
  findRoomsContainingAgent,
  type InvitableRoomRow,
  // M068 / M128 — agent / room membership management
  listAgentUsers,
  findUserAgentRoleSlug,
  findUserHighestRoleSlug,
  findAgentUserByNormalizedHandle,
  normalizeHandleForAgentRosterMatch,
  // M213 — canonical principal + RBAC read models
  resolveCanonicalPrincipalByLogtoSub,
  projectUserRbac,
  M213_WORKBENCH_CHANNEL,
  bindingForCanonicalFederatedId,
  dedupeCapabilitySlugs,
  deepFreeze,
  foldGroupChipsFromMembershipRows,
  foldRbacProjection,
  freezeCanonicalPrincipal,
  pickHighestRoleSlug,
  type CanonicalPrincipal,
  type PersonalAgentSnapshot,
  type RbacGroupChip,
  type RbacMembershipFoldRow,
  type RbacProjection,
  type RoleRankMap,
  type WorkbenchChannelBindingCandidate,
  type WorkbenchChannelBinding,
  type AgentMemberRoleSlug,
  type AgentUserRow,
  type ServerRoleSlug,
  SERVER_ROLE_RANK,
  SERVER_ROLE_TO_GROUP_TYPE,
  addUserToAgentRole,
  removeUserFromAgentRole,
  MembershipOpError,
  // M128 server-wide group helpers
  listGroupMembers,
  addUserToGroup,
  removeUserFromGroup,
  findCanonicalGroupByType,
  addRoomMember,
  removeRoomMember,
  updateRoomMemberAgentResponseMode,
  updateRoomConductorMode,
  updateRoomMemberRole,
  updateRoomVisibility,
  listAddableUsersForRoom,
  listAddableAgentsForRoom,
  listDirectoryHumans,
  searchDirectory,
  type DirectorySearchResult,
  type CreateRoomMemberInput,
  assertCanCreateRoomMembers,
  CreateRoomReachabilityError,
  isUuidString,
  type RoomSummaryRow,
  type RoomDetailPayload,
  type CreateRoomForOwnerParams,
  loadRoomRoster,
  isMessageInRoom,
  resolveRoomMessageByAuthorAndTime,
  getRoleCapabilities,
  type RoomParticipant,
  formatRoomMembershipSystemLine,
  // M042C
  findUserById,
  // M087
  loadUserTimezone,
  persistUserTimezoneIfChanged,
  findUserDisplayInfo,
  userHasCapability,
  findActorById,
  findActorByHandle,
  findHandleOwner,
  getFederatedIdForActor,
  // M043 — Subject queries keyed on users.id
  findUserByChannelIdentity,
  getUserMemberships,
  getUserCapabilities,
  type MembershipRow,
  // M128 — server-wide capability resolution
  findUsersWithCapability,
  findCanonicalActiveServerOwner,
  findOrCreateHumanOnlyDirectRoom,
  resolveInviteLandingRoomInTx,
  // M044 — Room-derived Namespace access (REL-NSP-RMS, REL-HUM-NSP)
  getRoomWithAccess,
  findAuthorizedRoomNameCandidates,
  type AuthorizedRoomNameCandidateRow,
  type FindAuthorizedRoomNameCandidatesInput,
  type NamespaceSubsetSourcePolicy,
  findReadableNamespacesForSubset,
  findCurrentReadableNamespacesForHumanActor,
  findRoomByExactHumanActorSet,
  findRecordAccessRoomByExactHumanActorSet,
  findRoomForUserMember,
  updateRoomHumanActors,
  updateRoomHumanActorsInTx,
  findAgentOwnerPrivateRoom,
  // M173 — memory access API helpers
  findRoomByNamespaceId,
  findRoomsByNamespaceIds,
  resolveActorsDisplay,
  resolveActorsDisplayMap,
  createAccessRoomForHumanSet,
  findOrCreateAccessNamespace,
  findOrCreateRecordAccessNamespace,
  assertRoomAllowsDirectMembershipMutation,
  bumpLastSeen,
  getUserLastSeenAt,
  // M080 — agent scopes + speaker resolution
  resolveSpeakerUserId,
  createScope,
  findScopes,
  getScopeForSpeaker,
  closeScope,
  type ScopeRow,
  // Stack 195 / W3.0.2 — Group capability bundle query for the anti-escalation resolver.
  getGroupCapabilityBundle,
} from "./queries";

// Stack 195 / W3.0.2 — shared trust-layer anti-escalation resolver.
export {
  NONDELEGABLE_OWNER_ONLY_CAPABILITIES,
  resolveMembershipMutationAuthority,
  authorizeMembershipMutation,
  assertNoNondelegableCapabilities,
  checkAuthorityOverBundle,
  type NondelegableOwnerOnlyCapability,
  type AuthorityDenial,
  type AuthorityOk,
  type AuthorityDecision,
  type AuthorityDenialReason,
  type AuthorityDeps,
  type MembershipMutationInput,
} from "./rbac-anti-escalation";

// M246/M254 — shared action-Capability admission and accepted-work authority.
export {
  assertCanInvokeAgent,
  assertCanWriteArtifacts,
  createAcceptedInvocationAuthority,
  assertAcceptedInvocationAuthoritySubject,
  getAcceptedInvocationAuthoritySubject,
  toActionCapabilityHttpDenial,
  toActionCapabilityDenialDiagnostic,
  ActionCapabilityDeniedError,
  AgentInvocationDeniedError,
  ArtifactWriteDeniedError,
  type AcceptedInvocationAuthority,
  type AgentInvocationOrigin,
  type AgentInvocationAdmissionInput,
  type ArtifactWriteAdmissionInput,
  type ActionCapabilityAdmissionDeps,
  type ActionCapabilityDenialCode,
  type ActionCapabilityHttpDenial,
  type ActionCapabilityDenialDiagnostic,
} from "./action-capability-admission";

// Stack 195 / W3.2 — shared RBAC mutation command engine (preview/apply).
export {
  CANONICAL_ROLE_SLUGS,
  CANONICAL_GROUP_TYPES,
  CUSTOM_GROUP_TYPE_PREFIX,
  managementCapabilityFor,
  managementCapabilitiesFor,
  computeFingerprint,
  evaluateOperation,
  previewOperation,
  applyOperation,
  applyDirectOperation,
  createProductionMutationEngineDeps,
  effectiveCapabilitiesForUser,
  effectiveUserDelta,
  computeAffectedUserDeltas,
  type AccessControlOperation,
  type AccessControlOperationKind,
  type EngineRoleRow,
  type EngineGroupRow,
  type EngineState,
  type MutationTx,
  type ApplyFacts,
  type WriteOutcome,
  type MutationEngineDeps,
  type ProductionMutationEngineDepsOptions,
  type Check,
  type CheckCode,
  type AuthorityDelta,
  type AffectedUserDelta,
  type DeletionConsequence,
  type RbacAuditEventInput,
  type PreviewResponse,
  type PreviewInput,
  type ApplyInput,
  type ApplyResult,
  type EvaluationInput,
  type EvaluationResult,
} from "./rbac-mutation-engine";

// Stack 195 / W3.1 — read-only effective-access + provenance read models.
export {
  buildEffectiveAccess,
  computeHighestCanonicalRole,
  fetchEffectiveAccessPathRows,
  fetchCatalogueCapabilities,
  getEffectiveAccessForUser,
  getAccessControlCatalogue,
  type AccessControlCapabilityRow,
  type AccessControlCatalogue,
  type AccessControlGroupRoleFact,
  type AccessControlGroupSummary,
  type AccessControlProvenancePath,
  type AccessControlRoleSummary,
  type AccessControlUserIdentity,
  type CatalogueCapability,
  type CatalogueCapabilityRow,
  type CatalogueGroupSummary,
  type CatalogueRoleSummary,
  type EffectiveAccessPathRow,
  type EffectiveAccessResponse,
} from "./access-control-read-models";

export {
  buildWideEnvelopeForSpeaker,
  type WideEnvelopeResult,
} from "./wide-envelope";

export {
  buildEnvelopeForTargetUsers,
  type TargetUserRef,
  type TargetUsersEnvelopeResult,
} from "./target-users-envelope";

export {
  markDelivered,
  markRead,
  markRoomRead,
  getMessageReadState,
  getHumanSenderUserIdForMessageBroadcast,
  type AggregatedReadState,
} from "./read-state";

export {
  shouldFireLLMTurn,
  parseAgentMentions,
  contentOutsideCodeFences,
  findReplyTargetAgentActorId,
  findRoomAgentResponseModes,
  resolveSubthreadAgentEligibility,
  listSubthreadRoomIdsForParent,
  type AgentResponseMode,
  type ShouldFireResult,
  type TrustDb,
  type SubthreadResponderEligibilityStatus,
  type SubthreadResponderEligibility,
} from "./agent-response";

export {
  MessageAccessError,
  MessageDeleteError,
  assertUserCanAccessMessage,
  assertUserCanDeleteMessage,
  decideMessageDelete,
} from "./membership";
export type { DeleteDenyReason, MessageDeleteAuthority } from "./membership";
export { deleteMessageHard } from "./message-delete";
export {
  appendCanonicalTranscriptRowsInTx,
  appendCanonicalTranscriptRowsToExistingSessionInTx,
  deleteMessageHardInTx,
  editCanonicalTranscriptMessageInTx,
  isCountedReplyRow,
  reserveCanonicalTranscriptMessageIdInTx,
  type CanonicalHardDeleteEffects,
  type CanonicalHardDeleteHookContext,
  type CanonicalHardDeleteHooks,
  type CanonicalHardDeleteResult,
  type CanonicalProtectedMessageStructuralProjection,
  type CanonicalExistingSessionAppendInput,
  type CanonicalRootSummary,
  type CanonicalTranscriptAllocatedRowContext,
  type CanonicalTranscriptAppendHooks,
  type CanonicalTranscriptAppendInput,
  type CanonicalTranscriptAppendResult,
  type CanonicalTranscriptAppendRow,
  type CanonicalTranscriptInsertedRow,
  type CanonicalTranscriptEditHookContext,
  type CanonicalTranscriptEditHooks,
  type CanonicalTranscriptEditResult,
  type CanonicalTranscriptEditRow,
  type CanonicalTranscriptSessionInput,
  type CanonicalTranscriptTx,
} from "./canonical-transcript-mutations";
export {
  decideHumanMessageEdit,
  editHumanRoomMessage,
  MessageEditError,
  type MessageEditDenyReason,
} from "./message-edit";

/**
 * M134 — conversational-focus substrate. `./focus/writer` is single-writer
 * restricted (Conductor + focus routes only); read/derive helpers are open.
 */
export {
  deriveActiveFoci,
  type ActiveFocus,
  openOrExtendFocus,
  clearFocus,
  materializeExpiry,
  type FocusDb,
  deriveRecentFocusBotActorIds,
  loadActiveFoci,
  loadRecentFocusBotActorIds,
} from "./focus";

/**
 * D426 Phase 2 — durable, requester-private Thread Responder substrate
 * (per-(Subthread, human) Genie selection; no expiry). See
 * `./focus/responder`.
 */
export {
  readSubthreadResponder,
  replaceSubthreadResponder,
  clearSubthreadResponder,
  invalidateSubthreadResponders,
  invalidateRespondersForBotInParentChildren,
  ResponderOpError,
  type ResponderDb,
  type SubthreadResponderRow,
  type SubthreadResponderRead,
  type SubthreadResponderStatus,
  type SubthreadResponderSource,
  type SubthreadResponderUnavailableReason,
} from "./focus";

export {
  activeSilence,
  loadActiveSilenceForRoom,
  resolveActiveSilence,
  cancelAllSilenceWindowExpiryForRoom,
  cancelSilenceWindowExpiry,
  scheduleSilenceWindowExpiry,
  type ActiveRoomSilenceDto,
  type RoomSilenceDb,
  type SilenceKind,
} from "./room-silence";

export {
  cascadeMemoriesOnNamespaceDelete,
  type CascadeMemoriesOnNamespaceDeleteOptions,
} from "./memory-cascade";

export type { ChallengeProvider } from "./challenge";
export {
  PinChallengeProvider,
  PinAlreadyEnrolledError,
  InvalidPinError,
  LockoutError,
} from "./challenge";

export { hashPin, verifyPin } from "./pin-hash";

export {
  generateRecoveryCodes,
  generateRecoveryCodesInTx,
  useRecoveryCode,
  getRecoveryCodeStatus,
  regenerateRecoveryCodes,
  regenerateLogtoAccountRecoveryCodes,
  getLogtoAccountRecoveryCodeStatus,
  claimLogtoAccountRecoveryCode,
  releaseLogtoAccountRecoveryCode,
  findMatchingUnusedLogtoAccountRecoveryCode,
  markLogtoAccountRecoveryCodeUsed,
  type UseRecoveryCodeResult,
} from "./recovery-codes";

export type { RecoveryCodePurpose } from "@nautilo/db";
export { RECOVERY_CODE_PURPOSE } from "@nautilo/db";

/**
 * M042C — federated identity helpers.
 *
 * Canonical home is `@nautilo/config` (so `@nautilo/db` seeds can call
 * these without a circular dep through trust). Re-exported here for
 * callers already importing from `@nautilo/trust`.
 */
export {
  composeFederatedId,
  parseFederatedId,
  normalizeHandle,
  validateHandle,
  slugifyToHandle,
  getServerHostname,
  type HandleValidation,
} from "@nautilo/config";

/**
 * M052 (Logto cluster) — backend Logto support. The server preHandler
 * imports these via this barrel; integration callers (M053 data
 * migration, M056 invite UI) will too. See
 * `research/logto-integration-v1.md` §4.
 *
 * Boundary: `LogtoAdminClient` is auth-pure — it does NOT expose any
 * organization-role / organization-membership method. Authorization
 * stays in the Nautilo trust layer (PersonalPolicyResolver, the seeded
 * `roles` / `groups` tables). See `logto-admin.ts` for the rule.
 */
export {
  verifyLogtoAccessToken,
  type LogtoTokenPayload,
} from "./logto-verifier";
export {
  LogtoAdminClient,
  LogtoOneTimeTokenError,
  getLogtoAdminClient,
  ensureLogtoPrimaryEmail,
  type CreateUserArgs,
  type CreateOneTimeTokenArgs,
  type OneTimeToken,
  type LogtoUserDetails,
  type EnsurePrimaryEmailArgs,
} from "./logto-admin";
export { checkLogtoRevocation } from "./logto-revocation-cache";
export {
  verifyLogtoActiveUserForAuthority,
  type StrictLogtoActiveUserStatus,
  type StrictLogtoActiveUserClient,
  type VerifyLogtoActiveUserForAuthorityOptions,
} from "./logto-active-user";

// Ordinary content-access transaction owner. Persistence primitives and raw
// authority snapshots intentionally stay internal to this package.
export {
  createContentAccessCoordinator,
  type ContentAccessAdmission,
  type ContentAccessCommand,
  type ContentAccessPreparation,
  type ContentAccessFailure,
  type LegacyHumanContentAccessResult,
  type CommittedArtifactShareEffect,
  type ObserveCommittedArtifactShareEffects,
  type ContentAccessCoordinatorOptions,
} from "./content-access-coordinator";
export { inspectContentAccess, type ContentAccessSummary } from "./content-access-summary";
export { createContentAccessPreviewCodec } from "./content-access-preview";
export type { ContentAccessReceipt } from "./content-access-publication";

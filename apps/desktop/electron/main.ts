import "./instance-argv-bootstrap.ts";

import {
  app,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  session,
  webContents,
  nativeImage,
  nativeTheme,
  screen,
  crashReporter,
  Notification,
  powerSaveBlocker,
  powerMonitor,
  safeStorage,
  protocol,
} from "electron";

// Registered before readiness so the sandboxed iframe may use the bounded
// preview URL as a media source without receiving filesystem/network power.
protocol.registerSchemesAsPrivileged([{
  scheme: "nautilo-media",
  privileges: { standard: true, secure: true, stream: true, supportFetchAPI: false },
}]);
import { mediaProxyResponse } from "./media-proxy-response";
import log from "electron-log/main";
import { autoUpdater } from "electron-updater";
import type {
  AvatarGenerationEvent,
  AvatarRef,
  IpcResult,
  OnboardingStartAt,
  ProfileSnapshot as WizardProfileSnapshot,
  SoulGenerationEvent,
} from "@nautilo/genie-customization-ui/types";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isIP } from "node:net";
import {
  createHash,
  randomBytes,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import {
  clearToolRuntimePath,
  getToolRuntimeStatus,
  refreshToolRuntimeStatus,
  setToolRuntimePath,
  stopRelay,
  getRelayStatus,
  getPersistedDesktopRelayId,
  refreshDesktopRelayCapabilities,
  setActiveRelay,
  DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
  deriveComputerUseServerBindingId,
  getActiveComputerUseRuntime,
  cancelComputerUseOwnedWork,
  getActiveStructuredSshRuntime,
  isGogAuthHealthy,
  resolveGogBin,
  type StartRelayOptions,
} from "./relay";
import {
  getDesktopSessionId,
  mintDesktopSessionId,
} from "./workstation-access/desktop-session";
import type { ToolRuntimeName } from "./tool-runtime-config";
import {
  clearDesktopConfig,
  configForCommittedActiveConnection,
  configForLegacyConnectionGuard,
  configForVerifiedLegacyConnection,
  loadConfig,
  readyToWorkProtectedReceiptFilePath,
  readyToWorkStateFilePath,
  saveCodexConnectionIntent,
  saveHermesConnectionIntent,
  saveConfig,
  type DesktopConfig,
} from "./config";
import { isServerFingerprint, projectActiveAuthority } from "./config-schema";
import {
  createReadyToWorkDesiredState,
  hasReadyToWorkSameBinding,
  parseReadyToWorkSelection,
  readyToWorkAggregateStatus,
  withReadyToWorkCodingHarnesses,
  type ReadyToWorkComponentId,
  type ReadyToWorkCodingHarnessStatus,
  type ReadyToWorkDesiredState,
  type ReadyToWorkBinding,
} from "./ready-to-work-contract";
import { ReadyToWorkStore } from "./ready-to-work-store";
import {
  isReadyToWorkStorageProtected,
  ReadyToWorkProtectedReceiptStore,
} from "./ready-to-work-protected-receipt";
import {
  parseMiniAppRecoveryOpenInput,
  parseMiniAppRecoveryWriteInput,
  type MiniAppRecoveryBinding,
  type MiniAppRecoveryTargetCandidate,
  type MiniAppRecoveryTargetIdentity,
} from "./mini-app-draft-recovery-contract";
import {
  MiniAppDraftRecoveryRuntime,
  MiniAppDraftRecoveryStore,
  MiniAppRecoveryError,
  resolveMiniAppRecoveryFilePath,
  type MiniAppRecoveryHandleContext,
} from "./mini-app-draft-recovery";
import {
  ReadyToWorkCoordinator,
  ReadyToWorkOperationQueue,
  commitReadyComputerUseEnable,
  readyToWorkBoundedValue,
  readyToWorkComputerUseFailureReason,
  readyToWorkWorkstationFailureReason,
} from "./ready-to-work-coordinator";
import { reprobeLogtoAuthDiagnostic } from "./logto-auth-diagnostic";
import {
  createPendingConnectionStore,
  projectPendingConnectionRecovery,
  type ActiveAuthority,
} from "./pending-connection";
import {
  prepareCommittedColdBootTerminal,
  type CommittedColdBootTerminal,
} from "./committed-cold-boot-terminal";
import { createColdBootTerminalRuntime, type AcceptedIdentityConfigCas } from "./cold-boot-terminal-runtime";
import {
  prepareActivePrecommitColdBootTerminal,
  type ActivePrecommitColdBootTerminal,
} from "./active-precommit-cold-boot-terminal";
import { prepareAcceptedIdentityColdBootTerminal, type AcceptedIdentityColdBootTerminal } from "./accepted-identity-cold-boot-terminal";
import {
  DesktopConnectionFlow,
  rendererSafeConnectionValue,
  selectPreviousHttpsOrigin,
  type DesktopConnectionResult,
  type DesktopConnectionTheme,
  type VerifiedConnectionCohort,
  type VerifiedHealth,
} from "./desktop-connection-flow";
import { canonicalizeServerUrl } from "./url-canonical";
import { publishConnectionPresentation, publishConnectionPresentationListener, type ConnectionPresentation } from "./connection-presentation";
import { connectionSupportAttemptRef, ConnectionSupportReceiptProjector } from "./connection-support-receipt";
import {
  askForMicrophoneAccess,
  getMicrophoneStatus,
  openSystemMicSettings,
  type MicStatus,
} from "./media";
import {
  getSystemPermissionsSnapshot,
  isSystemPermissionId,
  resolveSystemPermission,
  type SystemPermissionsSnapshot,
} from "./system-permissions";
import {
  loadSystemPermissionsOnboardingPreference,
  saveSystemPermissionsOnboardingPreference,
  systemPermissionsOnboardingPreferencePath,
  type SystemPermissionsOnboardingPreference,
} from "./system-permissions-onboarding-preference";
import { createApplicationMenu, type MenuAuthOptions } from "./menu";
import {
  UpdateController,
  type ElectronUpdaterFacade,
  type SanitizedUpdate,
  type SanitizedUpdaterError,
  type SanitizedUpdateStatus,
  type UpdaterEvent,
} from "./updater";
import { resolveProductionUpdaterEligibility } from "./updater-eligibility";
import { NativeMiniAppLifecycleCoordinator } from "./native-mini-app-lifecycle";
import {
  attachNavigationGuards,
  type NavigationGuardController,
} from "./navigation-guards";
import { attachEditableContextMenu } from "./editable-context-menu";
import { registerTerminalHost, disposeAllTerminals } from "./terminal-host";
import { createWorkstationShellHost } from "./workstation-shell-host";
import {
  WorkstationShellConsentStore,
  type WorkstationShellSubject,
} from "./workstation-shell-consent-store";
import { createGitHubCliConnection } from "./github-cli-connection";
import {
  createGoogleWorkspaceAuth,
} from "./google-workspace-auth";
import { GOOGLE_OAUTH_CLIENT_FILENAME } from "./google-workspace-oauth";
import { runSignIn } from "./auth/sign-in";
import { runStepUp } from "./auth/step-up";
import { startLoopbackServer } from "./auth/loopback-server";
import { generatePkcePair, generateState } from "./auth/pkce";
import { openAuthWindow } from "./auth/auth-window";
import {
  buildAccountPageUrl,
  type AccountPagePath,
} from "./auth/account-page-url";
import { validatePasteResetUrl } from "./auth/reset-paste-url";
import {
  isAccessTokenExpiring,
  refreshTokens as refreshTokensCore,
} from "./auth/refresh";
import {
  clearTokens,
  clearTokensFor,
  createIdentityBoundTokenStore,
  consumeAuthNotice,
  getLastAuthIssue,
  loadTokens,
  loadTokensFor,
  registerDesktopAuthIdentityDescriptor,
  saveTokens,
  type TokenBundle,
} from "./auth/token-store-electron";
import { serverUrlScope } from "./auth/token-store";
import { createElectronEncryptionRecoveryReadinessClient } from
  "./encryption-recovery-readiness.ts";
import {
  activateFreshDesktopCryptoInstallationId,
  readOrCreateDesktopCryptoInstallationId,
} from "./crypto-installation-identity.ts";
import {
  createElectronForegroundShadowController,
  type ElectronForegroundShadowController,
  type ElectronForegroundShadowApi,
} from "./foreground-shadow-controller.ts";
import { createDesktopForegroundShadowOriginSender } from
  "./foreground-shadow-origin-sender.ts";
import {
  assertForegroundShadowHistoryShape,
  boundedForegroundShadowValue,
  FOREGROUND_SHADOW_HISTORY_IPC_MAX_BYTES,
  foregroundShadowString,
  parseForegroundShadowEdit,
  parseForegroundShadowPendingAttention,
} from "./foreground-shadow-ipc-validation.ts";
import {
  clearRelayToken,
  retireRelayToken,
  getOrCreateInstallationId,
  loadRelayToken,
  pairRelay,
  relayTokenRequiresPairingCutover,
} from "./auth/relay-pair-electron";

import {
  broadcastAuthState as broadcastAuthStateImpl,
  type BroadcastAuthStateDeps,
} from "./auth/broadcast-auth-state";
import { getValidAccessToken } from "./auth/access-token";
import { reportStaleToken } from "./auth/report-stale-token";
import {
  parseDeepLinksFromArgv,
  registerDeepLinkHandler,
  type DeepLink,
} from "./auth/deep-link";
import { getFirstRunConnectTargets } from "./first-run-connect-options";
import {
  buildVersionedServerIconUrl,
  parseServerSetupStatusSummary,
  ServerSessionRegistry,
  type ServerSession,
  type ServerSessionConnection,
  type ServerSessionLogtoConfig,
  type ServerFallbackActivationResult,
  type ServerSetupStatusProbeResult,
} from "./server-sessions/registry";
import {
  createCompatibilityFileExclusively as createCompatibilityFileExclusivelyWithinRoot,
  registerFsStructuralIpcHandlers,
} from "./fs-structural-ipc";
import { DesktopDocumentMutationRuntime } from "./document-mutations/desktop-document-mutation-runtime.ts";
import { LocalDurableMutationJournal } from "./local-file-history/durable-mutations.ts";
import {
  resolveMissingTargetFromExistingAncestor,
  type GuardedFileAdapter,
} from "./local-file-history/file-adapter.ts";
// M239 — macOS important-message delivery and Dock attention policies.
import {
  isMacosAppEffectivelyActive,
  NotificationMessageDeduper,
  showImportantMessage,
  redactNativeError,
  type ChatNotificationDeps,
  type ImportantMessageInput,
  type NotificationNavigationTarget,
  type ShowImportantMessageResult,
} from "./chat-notifications";
import {
  applyDockAttention,
  type DockAttentionDeps,
} from "./notification-dock";
import type { NotificationSummaryInput } from "./notification-summary";
// D403 (ISSUE-D403) P0 — embedded-browser password layer. HUMAN-ONLY: these
// channels serve the guest <webview> preload + host renderer save/autofill UX
// and must never be exposed on any agent/tool/CDP surface (see passwords/ipc.ts).
import { registerPasswordsIpc } from "./passwords/ipc";
import { KdbxBackend } from "./passwords/kdbx-backend";
import {
  asBinaryReadSessionResult,
  BINARY_READ_SESSION_TTL_MS,
  BinaryReadSessionManager,
} from "./binary-read-sessions";
import { executeMediaProcess } from "./media-process.ts";
import { exportCurrentFolderSequence } from "./sequence-export-host.ts";
import { exportWorkspaceSequence, type WorkspaceSequenceExportInput, type WorkspaceSequenceSourceBinding } from "./workspace-sequence-export.ts";
import { publishSequenceToWorkspace, sequenceWorkspaceOutputPath } from "./sequence-workspace-publication.ts";
import { promoteVideoProject, projectVideoPromotionResult } from "./video-project-promotion.ts";
import { probeDesktopFfmpeg } from "./ffmpeg-runtime.ts";
import { copyMediaSnapshot, inspectMediaSource } from "./media-source-inspection.ts";
import { inspectMediaWaveform } from "./media-waveform";
import { importPickedWorkspaceMedia, importPickedWorkspaceMediaBatch, stageWorkspaceMedia, isWorkspaceMediaArtifact, isWorkspaceMediaRoom } from "./workspace-media-streaming";
import { MEDIA_PROCESS_PROTOCOL_VERSION, type MediaProcessProgress } from "@nautilo/relay";
import {
  isCanonicalPathWithinRoot,
  isMediaProxyRequestAuthorized,
  isOpaqueMediaProxyId,
  isValidBoundMediaRef,
  parseMediaProxyPreviewToken,
} from "./media-proxy-policy.ts";
import {
  KeepAwakeLeasePolicy,
  type KeepAwakeConditions,
  type KeepAwakePolicy,
} from "./remote-control/keep-awake-policy";

/** D357 Phase 3 — desktop jailed fs.mkdir result (main IPC). */
export type FsMkdirResult =
  | { ok: true }
  | {
      ok: false;
      code: "exists" | "forbidden" | "error";
      message?: string;
    };

/** D418 — renderer-safe results for the narrow Desktop Filesystem Grant bridge. */
export type DesktopFilesystemGrantsIpcFailureCode =
  | DesktopFilesystemGrantStoreErrorCode
  | DesktopFilesystemGrantRootIdentityErrorCode
  | "invalid_request"
  | "identity_unavailable"
  | "subject_mismatch"
  | "platform_authorization_unsupported";

export type DesktopFilesystemGrantsIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: DesktopFilesystemGrantsIpcFailureCode; message: string };
import {
  ColdBootObservationAuthority,
  type ColdBootAcceptanceProof,
  type ColdBootDiagnostic,
  type ColdBootObserveOptions,
  type ColdBootObserveResult,
  type VerifiedColdBootCohort,
} from "./cold-boot-observation";
import {
  runColdBootLaunchGate,
  type ColdBootLifecycleState,
} from "./cold-boot-lifecycle";
import { shouldTrustExplicitDevLoopbackServer } from "./dev-loopback-trust";
import {
  mapSetupStatusToServerClaimState,
  probeServerClaimStateForUrl,
  shouldForceGenieOnboardingFromSetup,
  shouldSkipGenieOnboardingWizard,
  type ServerClaimState,
} from "./boot-setup-status";
import {
  NautiloApiClient,
  deviceAdmissionChallengeSchema,
  messageBackfillNextRequestSchema,
  type SetupStatusResponse,
} from "@nautilo/api-client";
import {
  canonicalRemoteOrdinaryRequestBody,
  normalizeHumanMessageText,
  normalizeVideoExportSettings,
  normalizeRemoteOrdinaryRequestBody,
  parseLiveShadowMessageRealtimeEventV1,
  parseFullEncryptionMessageRealtimeContentEventV2,
} from "@nautilo/types";
import {
  deviceAdmissionChallengeFromDto,
  deviceAdmissionProofToDto,
  encodeMessagePayloadV2,
  type MessagePayloadV2,
} from "@nautilo/lattice-bridge";
import { writePersistedTuiServerTarget } from "@nautilo/instance-discovery/node";
import {
  validateWorkspacePath,
  type ValidatorDeps,
} from "./workspace-validation";
import { checkCurrentFolderSanity } from "./workspace-sanity";
import { createCurrentFolderAdoptionAuthority } from "./current-folder-adoption";
import { createPairedFilesystemDirectoryAuthority } from "./paired-filesystem-directory";
import { buildProtectedPathPolicy } from "@nautilo/security";
import {
  listRecent as listRecentCurrentFolders,
  pushRecent as pushRecentCurrentFolder,
  pruneMissing as pruneMissingRecentCurrentFolders,
  migrateLegacyFile as migrateLegacyRecentCurrentFolders,
} from "./recent-current-folders";
import {
  getRecentServerFingerprint,
  findRecentServerAliases,
  listRecentServers,
  migratePairedServerIdentityToFingerprint,
  pushRecentServer,
  removeRecentServer,
  replaceRecentServerFingerprint,
  setCommittedRecentServerFingerprint,
} from "./recent-servers";
import { ensureDefaultGenieWorkspace } from "./default-genie-workspace";
import {
  persistWorkingFolderPathAtomically,
  resolveWorkingFolderBootstrap,
  validateUsableWorkingFolder,
  type WorkingFolderBootstrapOptions,
} from "./working-folder-bootstrap";
import {
  currentFolderFilePath,
  legacyWorkspaceFilePath,
  localFileHistoryDirPath,
  miniAppDraftRecoveryDirPath,
  pendingConnectionFilePath,
  windowStateFilePath,
  browserControlStateFilePath,
  desktopFilesystemGrantsFilePath,
  legacyDesktopFilesystemGrantsFilePath,
  workstationShellConsentFilePath,
  workstationProfilesFilePath,
  computerUseStateFilePath,
  codexHostDirPath,
  codexRuntimeDirPath,
  codexProfileHomesDirPath,
  codexHostStateDirPath,
  DEFAULT_GENIE_WORKSPACE_ROOT,
  desktopRelayIdentityFilePath,
  legacySharedRelayIdentityFilePath,
} from "./paths";
import {
  APP_NAME,
  APP_CRASH_REPORTER_URL,
  DEFAULT_WINDOW_SIZE,
  resolveDevServerUrl,
  LOG_MAX_SIZE_BYTES,
  RENDERER_ALLOWED_LOG_LEVELS,
  WINDOW_STATE_SAVE_DEBOUNCE_MS,
} from "./constants";
import { parseProfileFromArgv } from "./auth/profile-from-argv";
import { computeUserDataDirName } from "./user-data-dir-name";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import * as os from "node:os";
import type { RelayFsChangeEvent, RelayStatus } from "@nautilo/relay";
import { ipcPayloadFromRelayFsChange } from "./local-file-dispatch/change-event.ts";
import { BrowserControlManager } from "./browser-control-manager";
import { browserControlStateSessionSource } from "./browser-control-state";
import { BrowserResearchTargetManager } from "./browser-research-target-manager";
import { resolveDownloadTarget } from "./download-target";
import { augmentProcessPath } from "./augment-path";
import {
  parseDesktopFilesystemGrant,
  DESKTOP_FILESYSTEM_ACCESS_OPERATIONS,
  DESKTOP_FILESYSTEM_GRANT_LIFETIMES,
  type DesktopFilesystemAccessOperation,
  type DesktopFilesystemGrant,
  type DesktopFilesystemGrantFilesystemIdentity,
  type DesktopFilesystemGrantLifetime,
} from "@nautilo/desktop-filesystem-grants";
import {
  captureDesktopFilesystemGrantRootIdentity,
  revalidateDesktopFilesystemGrantRootIdentity,
  type DesktopFilesystemGrantRootIdentityErrorCode,
  type DesktopFilesystemGrantRootIdentityResult,
} from "./desktop-filesystem-grants/identity";
import {
  DesktopFilesystemGrantStore,
  type DesktopFilesystemGrantStoreErrorCode,
} from "./desktop-filesystem-grants/store";
import { DesktopFilesystemGrantAuthority } from "./desktop-filesystem-grants/authority";
import { ActiveWorkstationProfileController } from "./workstation-profiles/active-controller";
import { developerWorkstationSeedProfile } from "./workstation-profiles/developer-workstation-seed";
import { ElectronCodexConnection } from "./codex-connection";
import { createElectronCodexProductionHostFactory } from "./codex-production-host";
import { ElectronClaudeConnectionHost } from "./claude-connection";
import { ElectronClaudeExecutionHost } from "./claude-execution";
import {
  createElectronHermesAcpNativeProbe,
  ElectronHermesAcpReadinessHost,
} from "./acp-readiness-host";
import { ElectronHermesAcpExecutionHost } from "./acp-execution-host";
import { ElectronOpenCodeAcpExecutionHost } from "./opencode-acp-execution-host";
import { ElectronAcpExecutionRouter } from "./acp-execution-router";
import {
  createElectronOpenCodeAcpNativeProbe,
  ElectronOpenCodeAcpReadinessHost,
} from "./opencode-acp-readiness-host";
import {
  discoverWorkstationFacts,
  type WorkstationDiscoveryReview,
} from "./workstation-profiles/discovery";
import { createStructuredSshSetupController } from "./structured-ssh/setup-controller";
import { ComputerUseLocalStore } from "./computer-use/local-store";
import { createComputerUseSetupController } from "./computer-use/setup-controller";
import { ComputerUseHostRouteAttestation } from "./computer-use/host-dispatch.ts";
import { ComputerUseServerBindingLifecycle } from "./computer-use/server-binding-lifecycle.ts";
import {
  createManagedComputerUseHostRuntime,
  ComputerUseHostBroker,
  createStdioComputerUseHostLauncher,
  resolveBundledCuaDriverPath,
  type ComputerUseHostState,
} from "./computer-use-host-runtime/index.ts";
import {
  isComputerUseOpaqueId,
  type DesktopAutomationReceipt,
} from "./computer-use/contracts";
import {
  buildForStableComputerUseRuntime,
  sameComputerUseRuntimeIdentity,
} from "./computer-use/semantic-contracts.ts";
import {
  parseComputerUseOwnedAgents,
  selectComputerUseOwnedAgent,
  type ComputerUseOwnedAgent,
} from "./computer-use/owned-agent-selection.ts";

const {
  googleWorkspaceAuthStatus,
  googleWorkspaceConnect,
  googleWorkspaceDisconnect,
} = createGoogleWorkspaceAuth({ resolveGogBin, isGogAuthHealthy });

const githubCliConnection = createGitHubCliConnection({
  openExternal: (url) => shell.openExternal(url).then(() => undefined),
});

function nautiloAppVersion(): string {
  return app.getVersion();
}

// D057 2a.6 — normalize app identity before ANY app.getPath() call below
// (current-folder.json, logs, crashDumps, etc. all flow from this). Without
// this, dev runs resolve to "@nautilo/desktop" (package.json "name")
// while packaged runs resolve to "Nautilo" (electron-builder productName),
// splitting userData / logs / crashDumps across two directories.
//
// One-time dev-environment migration note: existing unpackaged runs
// stored current-folder.json (nee workspace.json) + any other userData at
//   ~/Library/Application Support/@nautilo/desktop/
// after this commit, dev runs use
//   ~/Library/Application Support/Nautilo/
// matching packaged builds. Users will need to re-pick their current
// folder once. Not a data loss — the folders themselves are unaffected,
// only the saved-path pointer moves.
app.setName(APP_NAME);

// D384 Phase 5 — repair PATH before anything spawns children. A GUI-launched
// Electron app inherits a minimal PATH that omits ~/.maestro/bin,
// /opt/homebrew/bin, etc., so relay-hosted stdio MCP servers (and CLI tools)
// fail with `spawn <cmd> ENOENT`. Best-effort + idempotent.
{
  const added = augmentProcessPath();
  if (added > 0)
    log.info(`[desktop] PATH augmented (+${added} dir(s)) for child spawns`);
}

// M097 + Stack 19 Phase 4 (D156 Architecture amendment 2026-05-16) — segregate
// Electron `userData` by the (instance, profile) tuple so different
// server-targets AND different operator identities get isolated
// renderer state.
//
// Why:
//   1. Electron's `requestSingleInstanceLock()` (keyed on app name +
//      userData) DOES NOT refuse the second window when the tuple
//      differs. Without this, the second `bun run desktop -- --profile galina`
//      OR the second `NAUTILO_INSTANCE_ID=smoke-stack19 bun run desktop`
//      silently `app.quit()`s because the first owns the lock.
//   2. Per-tuple Cookies / Local Storage / IndexedDB / Cache / Preferences
//      don't cross-talk. Two operators on the same instance signed in as
//      different Logto users want isolated browsing state (the profile
//      axis); two server-targets in the same operator's hands want
//      isolated renderer state so smoke-test cruft doesn't bleed into
//      daily-driver state (the instance axis).
//   3. Per-tuple crashDumps + electron-log files land in the right tree.
//
// Naming formula (see `./user-data-dir-name.ts` for the pure helper +
// unit tests pinning the 4-way matrix):
//
//   ${APP_NAME}${instanceSuffix}${profileSuffix}
//
//   ${instanceSuffix} = "" for default instance, else "-${instanceId}"
//   ${profileSuffix}  = "" for default profile,  else "-${profile}"
//
// Default+default tuple collapses to bare `APP_NAME` → existing operator
// state (pre-Stack-19 `~/Library/Application Support/Nautilo/`) is
// preserved verbatim. Named-instance and/or named-profile sessions get
// new dirs on first launch (sign-in screen). No backwards-compat shim
// per the no-hacks design rule.
//
// Auth is already per-instance per-profile via
// `~/.nautilo${suffix}/desktop-auth[-<profile>].json` (M097 Phase 3 +
// resolveNautiloRootDir from @nautilo/config); this completes the
// isolation for everything Electron itself owns.
const desktopProfile = parseProfileFromArgv(process.argv);
const desktopInstance = resolveInstance();
const isDefaultInstance = desktopInstance.instanceId.trim() === "";
const targetDirName = computeUserDataDirName({
  appName: APP_NAME,
  instanceId: desktopInstance.instanceId,
  isDefaultInstance,
  profile: desktopProfile,
});
if (targetDirName !== APP_NAME) {
  const baseUserData = app.getPath("userData");
  const tupleUserData = path.join(path.dirname(baseUserData), targetDirName);
  app.setPath("userData", tupleUserData);
  // Match `userData` for sibling Electron paths so nothing leaks back
  // to the default tree. `crashDumps` defaults to `${userData}/Crashpad`
  // and `logs` to `${userData}/logs` on the platforms we care about,
  // but Electron does NOT auto-recompute them when `userData` is
  // re-pointed — so we re-derive explicitly.
  app.setPath("logs", path.join(tupleUserData, "logs"));
  app.setPath("crashDumps", path.join(tupleUserData, "Crashpad"));
}

// D516 2.1.2 — this owns an optional packaged child only. Its lifecycle is
// intentionally separate from provider admission, relay capability discovery,
// and every Computer use dispatch path.
// The Host owns the Cua process, socket, session, and driver generation.
// Electron attests only immutable packaged resources and forwards generic v3
// descriptors. There is no PATH, URL, or Electron-owned socket fallback.
const managedComputerUseHostRuntime = createManagedComputerUseHostRuntime({
  resourceDirectory: path.join(process.resourcesPath, "tools-computer-use-host"),
  runtimeRoot: path.join(app.getPath("userData"), "computer-use-host"),
  desktopExecutable: process.execPath,
});
const computerUseHostBroker = new ComputerUseHostBroker(
  managedComputerUseHostRuntime,
  createStdioComputerUseHostLauncher(),
  () => {
    const driverPath = resolveBundledCuaDriverPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    });
    return driverPath === null
      ? null
      : {
          driverPath,
          runtimeRoot: path.join(app.getPath("userData"), "computer-use-host"),
          hostBundleId: "com.nautilo.desktop",
        };
  },
);

const workstationShellConsentStore = new WorkstationShellConsentStore({
  instanceId: desktopInstance.instanceId,
  filePath: workstationShellConsentFilePath(),
});

async function currentWorkstationShellSubject(): Promise<WorkstationShellSubject | null> {
  const serverUrl = resolvedServerUrl();
  if (serverUrl === null) return null;
  const userId = await currentDesktopFilesystemGrantUserId();
  const relayId = getPersistedDesktopRelayId();
  const relayToken = loadRelayToken(serverUrl);
  if (userId === null || relayId === null || relayToken === null) return null;
  return {
    instanceId: desktopInstance.instanceId,
    userId,
    relayId,
    serverOrigin: new URL(serverUrl).toString().replace(/\/+$/, ""),
    pairingFingerprint: createHash("sha256")
      .update(`nautilo-host-command-consent:${relayToken}`)
      .digest("base64url"),
  };
}

const workstationShellHost = createWorkstationShellHost({
  consentStore: workstationShellConsentStore,
  resolveSubject: currentWorkstationShellSubject,
  requestConsent: async (workspacePath) => {
    const response = await dialog.showMessageBox({
      type: "warning",
      title: "Allow host commands?",
      message: "Allow Genie to use developer tools on this Mac?",
      detail:
        `Current Folder:\n${workspacePath}\n\n` +
        "Commands run as your signed-in macOS user. They can use installed developer tools " +
        "and existing CLI credentials (including GitHub), and are not contained by Nautilo's " +
        "shell sandbox. Command output is returned to Genie and may expose account data.\n\n" +
        "Routine developer commands will not ask again while this access is active. Critical " +
        "destruction or elevation still follows Nautilo's normal approval policy.",
      buttons: [
        "Always Allow for This Folder",
        "Allow for This App Session",
        "Deny",
      ],
      defaultId: 2,
      cancelId: 2,
      noLink: true,
    });
    if (response.response === 0) return "durable";
    if (response.response === 1) return "session";
    return null;
  },
});

/** Bound fs/path helpers for `validateWorkspacePath` (avoids unbound-method when passed as values). */
const WORKSPACE_VALIDATOR_DEPS: ValidatorDeps = {
  isAbsolute: (p) => path.isAbsolute(p),
  resolve: (p) => path.resolve(p),
  statSync: (p) => fs.statSync(p),
};

const FS_WATCH_DEBOUNCE_MS = 300;

// crashReporter.start MUST be called before app.ready to catch early
// main-process crashes. Keep uploadToServer=false until Phase 2b.6
// wires a real endpoint; dumps land in app.getPath("crashDumps").
crashReporter.start({
  productName: APP_NAME,
  submitURL: APP_CRASH_REPORTER_URL,
  uploadToServer: false,
  compress: true,
});

const serverSessions = new ServerSessionRegistry();
let miniAppRecoveryRuntime: MiniAppDraftRecoveryRuntime | null = null;
let miniAppRecoveryAuthGeneration = 0;
const miniAppRecoveryObservedSenders = new Set<number>();
let mainWindow: BaseWindow | null = null;
let mainNavigationGuard: NavigationGuardController | null = null;
let verifiedWorkbenchOrigin: string | null = null;
let verifiedBootstrapRelease: Readonly<{ epoch: number; origin: string }> | null = null;
let verifiedBootstrapReleaseEpoch = 0;
let browserControlManager: BrowserControlManager | null = null;
let advertisedBrowserControlSessionSource: string | null = null;
let browserResearchTargetManager: BrowserResearchTargetManager | null = null;

/**
 * M161 Phase 3 — renderer subscribers to `servers:changed` pushes. Keyed
 * by `webContents.id` so a destroyed renderer is pruned on the next
 * emission (unsubscribe-safe). The registry's `onChange` listener
 * (wired once in boot) broadcasts to every live subscriber.
 */
const serverChangeSubscribers = new Map<number, Electron.WebContents>();
const connectionSupportReceiptProjector = new ConnectionSupportReceiptProjector(
  () => performance.now(), () => connectionSupportAttemptRef(randomBytes(10)),
);
let pickerPresentationListener: ((snapshot: ConnectionPresentation) => void) | null = null;
let serverChangeBridgeWired = false;
let onboardingOpenHandlerRegistered = false;
let initialDeepLinksQueued = false;
let releasedDesktopBootFinalizer: Promise<void> | null = null;
let releasedDesktopBootUpdaterStarted = false;
let releasedDesktopBootActivateHandlerRegistered = false;

// D514 — native menus are process-global, while Logto discovery is scoped to
// the active M161 server session. The key includes every field that changes
// the Account projection so a same-server Logto/signed-in transition cannot
// leave a stale native menu behind. A switch/close/forget cascade coalesces
// into one rebuild against its final projection.
let renderedMenuAuthProjectionKey: string | null = null;
let menuAuthRebuildQueued = false;

function activeMenuAuthProjectionKey(): string {
  const active = serverSessions.active;
  if (!active) return "no-active-server";
  return [
    active.scope,
    active.logtoConfig ? "logto-ready" : "logto-unresolved",
    active.signedIn ? "signed-in" : "signed-out",
  ].join("|");
}

function refreshMenuForActiveServerTransition(): void {
  const nextProjectionKey = activeMenuAuthProjectionKey();
  if (!menuAuthRebuildQueued && nextProjectionKey === renderedMenuAuthProjectionKey) {
    return;
  }
  if (menuAuthRebuildQueued) return;
  menuAuthRebuildQueued = true;
  queueMicrotask(() => {
    menuAuthRebuildQueued = false;
    if (activeMenuAuthProjectionKey() === renderedMenuAuthProjectionKey) return;
    rebuildApplicationMenu();
  });
}

/** Phase 1 compatibility seam: all renderer traffic targets the active view. */
function activeRenderer(): Electron.WebContents | null {
  const contents = serverSessions.active?.view?.webContents ?? null;
  return contents && !contents.isDestroyed() ? contents : null;
}

function sendToActiveRenderer(channel: string, ...args: unknown[]): void {
  activeRenderer()?.send(channel, ...args);
}

function isWorkbenchHostWindowFocused(): boolean {
  return Boolean(
    mainWindow &&
      !mainWindow.isDestroyed() &&
      mainWindow.isVisible() &&
      mainWindow.isFocused(),
  );
}

function publishWorkbenchHostWindowFocus(): void {
  sendToActiveRenderer(
    "workbench:window-focus-changed",
    isWorkbenchHostWindowFocused(),
  );
}

function coldBootLocalShellPaths(): string[] {
  return [
    path.join(__dirname, "bootstrap.html"),
    path.join(__dirname, "cold-boot-picker.html"),
  ];
}

function releaseVerifiedWorkbenchNavigation(serverUrl: string): boolean {
  try {
    const origin = new URL(serverUrl).origin;
    if (origin === "null") throw new Error("opaque origin");
    if (!mainNavigationGuard) throw new Error("main navigation guard unavailable");
    mainNavigationGuard.replaceAllowedOrigins([origin]);
    verifiedWorkbenchOrigin = origin;
    verifiedBootstrapRelease = { epoch: ++verifiedBootstrapReleaseEpoch, origin };
    coldBootBootstrapReady = true;
    logColdBootDiagnostic({
      generation: initializeColdBootObservationAuthority().snapshot().generation,
      phase: "navigation",
      category: "navigation-released",
      durationMs: 0,
      acceptedGeneration: true,
      stateChanged: true,
    });
    return true;
  } catch {
    logColdBootDiagnostic({
      generation: initializeColdBootObservationAuthority().snapshot().generation,
      phase: "navigation",
      category: "navigation-blocked",
      durationMs: 0,
      acceptedGeneration: true,
      stateChanged: false,
    });
    return false;
  }
}

function holdColdBootNavigation(): void {
  coldBootBootstrapReady = false;
  verifiedWorkbenchOrigin = null;
  verifiedBootstrapRelease = null;
  mainNavigationGuard?.holdLocalNavigation();
}

/** Content-free wake only; the renderer must fetch sender-gated local state. */
function notifyComputerUseStatusChanged(): void {
  sendToActiveRenderer("computerUse:statusChanged");
}

// D103 — eligibility is derived solely from Electron's packaging state and
// the version stamped by the protected signed-release workflow. The actual
// generic provider URL is compiled into app-update.yml by electron-builder;
// it is not accepted from an environment variable, CLI argument, server,
// profile, renderer, or IPC request.
const productionUpdaterEligibility = resolveProductionUpdaterEligibility({
  isPackaged: app.isPackaged,
  version: app.getVersion(),
  // This can only disable checks in a test harness; it never supplies feed
  // authority or lets an untrusted caller enable the updater.
  isTest: process.env["NODE_ENV"] === "test",
});
const productionUpdaterFeedEnabled = productionUpdaterEligibility.enabled;

/** Adapt electron-updater without exposing its provider/configuration surface. */
const electronUpdaterFacade: ElectronUpdaterFacade = {
  get autoDownload(): boolean {
    return autoUpdater.autoDownload;
  },
  set autoDownload(value: boolean) {
    autoUpdater.autoDownload = value;
  },
  get autoInstallOnAppQuit(): boolean {
    return autoUpdater.autoInstallOnAppQuit;
  },
  set autoInstallOnAppQuit(value: boolean) {
    autoUpdater.autoInstallOnAppQuit = value;
  },
  checkForUpdates: () => autoUpdater.checkForUpdates(),
  downloadUpdate: () => autoUpdater.downloadUpdate(),
  quitAndInstall: () => autoUpdater.quitAndInstall(),
  on: (event: UpdaterEvent, listener: (...args: unknown[]) => void) => {
    autoUpdater.on(event, listener);
  },
  removeListener: (
    event: UpdaterEvent,
    listener: (...args: unknown[]) => void,
  ) => {
    autoUpdater.removeListener(event, listener);
  },
};

function showUpdaterMessage(
  options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options);
  }
  return dialog.showMessageBox(options);
}

async function showAvailableUpdateDialog(
  update: SanitizedUpdate,
): Promise<"later" | "download"> {
  const result = await showUpdaterMessage({
    type: "info",
    title: "Update available",
    message: `Nautilo ${update.version} is available.`,
    detail: "Download it now? You can keep working while it downloads.",
    buttons: ["Later", "Download"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response === 1 ? "download" : "later";
}

async function showReadyUpdateDialog(
  update: SanitizedUpdate,
): Promise<"later" | "restart"> {
  const result = await showUpdaterMessage({
    type: "info",
    title: "Update ready",
    message: `Nautilo ${update.version} is ready to install.`,
    detail:
      "Running terminal commands, browser automation, connectors, and local actions will stop. Save your work or wait for it to finish before continuing.",
    buttons: ["Cancel", "Restart & Update"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) return "later";
  if (!(await prepareRegisteredRenderersForQuit())) return "later";
  quitPersistencePrepared = true;
  return "restart";
}

function showNoUpdateDialog(): void {
  void showUpdaterMessage({
    type: "info",
    title: "Nautilo is up to date",
    message: "You already have the latest version of Nautilo.",
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  }).catch(() => undefined);
}

function showUpdaterErrorDialog(error: SanitizedUpdaterError): void {
  void showUpdaterMessage({
    type: "error",
    title: "Update unavailable",
    message: error.message,
    buttons: ["OK"],
    defaultId: 0,
    noLink: true,
  }).catch(() => undefined);
}

// Background server sessions can retain their Workbench renderer while another
// server is active. Retain renderers that successfully subscribed while active
// so a future session switch never reveals stale update UI. This is naturally
// bounded by live Workbench renderer lifecycle; destroyed renderers are pruned.
// Membership is still minted only by the active-session IPC gate.
const updateStatusSubscribers = new Map<number, Electron.WebContents>();

function addUpdateStatusSubscriber(contents: Electron.WebContents): void {
  for (const [id, subscriber] of updateStatusSubscribers) {
    if (subscriber.isDestroyed()) updateStatusSubscribers.delete(id);
  }
  if (!updateStatusSubscribers.has(contents.id)) {
    contents.once("destroyed", () =>
      updateStatusSubscribers.delete(contents.id),
    );
  }
  updateStatusSubscribers.set(contents.id, contents);
}

function broadcastUpdaterStatus(status: SanitizedUpdateStatus): void {
  // The renderer receives only the small status projection; feed URLs,
  // release notes, paths, provider errors, and install control stay in main.
  // Never use `activeRenderer()` here: preserved server sessions which were
  // verified subscribers must also remain current before they become active.
  for (const [id, contents] of updateStatusSubscribers) {
    if (contents.isDestroyed()) {
      updateStatusSubscribers.delete(id);
      continue;
    }
    try {
      contents.send("updates:status", status);
    } catch {
      updateStatusSubscribers.delete(id);
    }
  }
}

const updateController = new UpdateController({
  updater: electronUpdaterFacade,
  productionFeedEnabled: productionUpdaterFeedEnabled,
  disabledReason:
    productionUpdaterEligibility.disabledReason ?? "feed-not-configured",
  timers: {
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) =>
      clearInterval(handle as ReturnType<typeof setInterval>),
  },
  ui: {
    showAvailable: showAvailableUpdateDialog,
    showReady: showReadyUpdateDialog,
    showNoUpdate: showNoUpdateDialog,
    showError: showUpdaterErrorDialog,
  },
  beforeInstall: () => {
    // Keep final admission synchronous: a renderer may have registered since
    // confirmation. Cleanup belongs to the awaited before-quit handler, so a
    // rejected update leaves the current app and its editors usable.
    if (!quitPersistencePrepared) return false;
    const renderer = activeRenderer();
    if (renderer && !renderer.isDestroyed()) {
      void renderer.executeJavaScript(UPDATE_INSTALL_COVER_SCRIPT).catch(() => {});
    }
    return true;
  },
  onStateChange: (state) => {
    if (state.kind === "error") releaseCompletedQuitPreparation();
    broadcastUpdaterStatus(updateController.getSanitizedStatus());
  },
});

const documentMutationReadyRenderers = new Set<number>();
const documentMutationRendererCleanup = new Map<number, () => void>();
const documentMutationRendererEpochs = new Map<number, number>();
const pendingDocumentMutationAcks = new Map<
  string,
  {
    rendererId: number;
    resolve: (value: "published" | "unknown") => void;
    timer: NodeJS.Timeout;
  }
>();

function invalidatePendingDocumentMutationAcks(rendererId?: number): void {
  for (const [key, pending] of pendingDocumentMutationAcks) {
    if (rendererId !== undefined && pending.rendererId !== rendererId) continue;
    clearTimeout(pending.timer);
    pendingDocumentMutationAcks.delete(key);
    pending.resolve("unknown");
  }
}

function forgetDocumentMutationRenderer(rendererId: number): void {
  documentMutationReadyRenderers.delete(rendererId);
  documentMutationRendererCleanup.get(rendererId)?.();
  documentMutationRendererCleanup.delete(rendererId);
  invalidatePendingDocumentMutationAcks(rendererId);
}

function documentMutationRendererEpoch(rendererId: number): number {
  return documentMutationRendererEpochs.get(rendererId) ?? 0;
}

function publishDocumentMutationBatch(
  batch: import("@nautilo/document-mutations").AtomicDocumentMutationEventBatch,
): Promise<"published" | "not_published" | "unknown"> {
  const renderer = activeRenderer();
  if (
    !renderer ||
    renderer.isDestroyed() ||
    !documentMutationReadyRenderers.has(renderer.id)
  ) {
    return Promise.resolve("not_published");
  }
  const existing = pendingDocumentMutationAcks.get(batch.idempotencyKey);
  if (existing) return Promise.resolve("unknown");
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingDocumentMutationAcks.delete(batch.idempotencyKey);
      resolve("unknown");
    }, 5_000);
    timer.unref?.();
    pendingDocumentMutationAcks.set(batch.idempotencyKey, {
      rendererId: renderer.id,
      resolve,
      timer,
    });
    try {
      renderer.send("document:mutationCommitted", batch);
    } catch {
      clearTimeout(timer);
      pendingDocumentMutationAcks.delete(batch.idempotencyKey);
      resolve("unknown");
    }
  });
}

function loadActiveRenderer(url: string): Promise<void> {
  const renderer = activeRenderer();
  if (!renderer)
    return Promise.reject(new Error("active server view not ready"));
  return loadRendererUrl(renderer, url);
}

/**
 * The release epoch is captured before each local bootstrap request. It makes
 * an expected Chromium cancellation independent of when `getURL()` happens
 * to reflect the subsequent Workbench redirect.
 */
type BootstrapLoadIntent = Readonly<{
  requestedUrl: string;
  releaseEpochAtRequest: number;
}>;

function captureBootstrapLoadIntent(requestedUrl: string): BootstrapLoadIntent {
  return {
    requestedUrl,
    releaseEpochAtRequest: verifiedBootstrapRelease?.epoch ?? 0,
  };
}

function isExpectedBootstrapSupersession(
  error: unknown,
  intent: BootstrapLoadIntent,
): boolean {
  const errorCode = (error as { code?: unknown } | null)?.code;
  const aborted = errorCode === -3 || errorCode === "ERR_ABORTED" ||
    (error instanceof Error && error.message.includes("(-3) loading"));
  const release = verifiedBootstrapRelease;
  if (!aborted || intent.requestedUrl !== connectBootstrapEntryHref ||
      !release || !coldBootBootstrapReady ||
      verifiedWorkbenchOrigin !== release.origin ||
      release.epoch < intent.releaseEpochAtRequest) return false;
  return true;
}

/** Both the initial local shell and later bootstrap projections use this exact boundary. */
function loadRendererUrl(contents: Electron.WebContents, url: string): Promise<void> {
  const intent = captureBootstrapLoadIntent(url);
  return contents.loadURL(url).catch((error) => {
    if (isExpectedBootstrapSupersession(error, intent)) return;
    throw error;
  });
}

function workbenchBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0a0d16" : "#fafbff";
}

const RELOAD_COVER_SCRIPT = `(() => {
  document.getElementById("nautilo-reload-cover")?.remove();
  const cover = document.createElement("div");
  cover.id = "nautilo-reload-cover";
  cover.setAttribute("role", "status");
  cover.setAttribute("aria-live", "polite");
  Object.assign(cover.style, {
    position: "fixed", inset: "0", zIndex: "2147483647",
    display: "grid", placeItems: "center", background: "#0a0d16",
    color: "#f5f7ff", fontFamily: "system-ui, sans-serif",
  });
  const message = document.createElement("div");
  message.textContent = "Updating Nautilo…";
  message.style.fontSize = "16px";
  message.style.fontWeight = "600";
  cover.append(message);
  document.body.append(cover);
})()`;

const UPDATE_INSTALL_COVER_SCRIPT = `(() => {
  document.getElementById("nautilo-update-install-cover")?.remove();
  const cover = document.createElement("div");
  cover.id = "nautilo-update-install-cover";
  cover.setAttribute("role", "status");
  cover.setAttribute("aria-live", "assertive");
  Object.assign(cover.style, {
    position: "fixed", inset: "0", zIndex: "2147483647",
    display: "grid", placeItems: "center", background: "#0a0d16",
    color: "#f5f7ff", fontFamily: "system-ui, sans-serif",
  });
  const content = document.createElement("div");
  Object.assign(content.style, { display: "grid", justifyItems: "center", gap: "14px" });
  const spinner = document.createElement("div");
  Object.assign(spinner.style, {
    width: "34px", height: "34px", borderRadius: "9999px",
    border: "3px solid rgba(56, 189, 248, 0.22)",
    borderTopColor: "#38bdf8", animation: "nautiloUpdateSpin 0.8s linear infinite",
  });
  const style = document.createElement("style");
  style.textContent = "@keyframes nautiloUpdateSpin { to { transform: rotate(360deg); } }";
  const message = document.createElement("div");
  message.textContent = "Installing update… Nautilo will restart automatically.";
  Object.assign(message.style, { fontSize: "16px", fontWeight: "650" });
  content.append(spinner, message);
  cover.append(style, content);
  document.body.append(cover);
})()`;

const pendingDeepLinks: DeepLink[] = [];

function isVerifiedWorkbenchRenderer(renderer: Electron.WebContents): boolean {
  if (!verifiedWorkbenchOrigin) return false;
  try {
    return new URL(renderer.getURL()).origin === verifiedWorkbenchOrigin;
  } catch {
    return false;
  }
}

function forwardDeepLinkToRenderer(link: DeepLink): void {
  const renderer = activeRenderer();
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    renderer &&
    !renderer.isLoading() &&
    isVerifiedWorkbenchRenderer(renderer)
  ) {
    renderer.send("deep-link:received", link);
    return;
  }
  pendingDeepLinks.push(link);
}

function drainPendingDeepLinks(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  while (pendingDeepLinks.length > 0) {
    const link = pendingDeepLinks.shift()!;
    sendToActiveRenderer("deep-link:received", link);
  }
}
let tray: Tray | null = null;
let isQuitting = false;
let quitTeardownStarted = false;
let quitTeardownComplete = false;
let quitPreparationStarted = false;
let quitPersistencePrepared = false;
const quitGuardCoordinator = new NativeMiniAppLifecycleCoordinator<Electron.WebContents>();
const quitGuardRendererCleanup = new Map<number, () => void>();
let completedQuitPreparation: {
  requestId: string;
  targets: Array<[number, Electron.WebContents]>;
} | null = null;

function forgetQuitGuardRenderer(rendererId: number): void {
  quitGuardRendererCleanup.get(rendererId)?.();
  quitGuardRendererCleanup.delete(rendererId);
  quitGuardCoordinator.unregister(rendererId);
  if (completedQuitPreparation?.targets.some(([id]) => id === rendererId)) {
    releaseCompletedQuitPreparation();
  }
}

ipcMain.on("desktop:lifecycle:register-quit-guard", (event) => {
  const renderer = event.sender;
  if (!serverSessions.getBySender(renderer.id) || !isVerifiedWorkbenchRenderer(renderer)) return;
  if (!quitGuardCoordinator.register(renderer.id, renderer)) return;
  if (completedQuitPreparation || quitPersistencePrepared) {
    releaseCompletedQuitPreparation();
  }
  const rendererId = renderer.id;
  const onDestroyed = () => forgetQuitGuardRenderer(rendererId);
  const onDidStartNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || isInPlace) return;
    forgetQuitGuardRenderer(rendererId);
  };
  renderer.once("destroyed", onDestroyed);
  renderer.on("did-start-navigation", onDidStartNavigation);
  quitGuardRendererCleanup.set(rendererId, () => {
    renderer.removeListener("destroyed", onDestroyed);
    renderer.removeListener("did-start-navigation", onDidStartNavigation);
  });
});

ipcMain.on("desktop:lifecycle:unregister-quit-guard", (event) => {
  if (!serverSessions.getBySender(event.sender.id)) return;
  forgetQuitGuardRenderer(event.sender.id);
});

ipcMain.on("desktop:lifecycle:prepare-quit-result", (event, raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const result = raw as { requestId?: unknown; ready?: unknown };
  quitGuardCoordinator.accept(event.sender.id, result.requestId, result.ready);
});

function cancelRendererQuitPreparation(
  requestId: string,
  targets: Array<[number, Electron.WebContents]>,
): void {
  quitGuardCoordinator.cancel(requestId);
  if (completedQuitPreparation?.requestId === requestId) completedQuitPreparation = null;
  for (const [, renderer] of targets) {
    if (renderer.isDestroyed()) continue;
    try {
      renderer.send("desktop:lifecycle:prepare-quit-cancelled", { requestId });
    } catch {
      // Destruction between the check and send already prevents further edits.
    }
  }
}

function releaseCompletedQuitPreparation(): void {
  const completed = completedQuitPreparation;
  if (completed) cancelRendererQuitPreparation(completed.requestId, completed.targets);
  quitPersistencePrepared = false;
}

let rendererQuitPreparationPromise: Promise<boolean> | null = null;

function resolveQuitProgressDialogParent(
  targets: Array<[number, Electron.WebContents]>,
): BrowserWindow | null {
  const candidates = [
    mainWindow,
    ...targets.map(([, renderer]) => BrowserWindow.fromWebContents(renderer)),
  ];
  const parent = candidates.find((candidate): candidate is BrowserWindow =>
    candidate !== null && !candidate.isDestroyed());
  if (!parent) return null;
  // A parentless message box is synchronous on macOS, so main cannot process
  // the renderer's ready response or abort the progress dialog. A visible
  // parent keeps this an asynchronous sheet, including quits initiated while
  // the main window is hidden in the tray.
  if (parent.isMinimized()) parent.restore();
  if (!parent.isVisible()) parent.show();
  return parent;
}

function prepareRegisteredRenderersForQuit(): Promise<boolean> {
  if (rendererQuitPreparationPromise) return rendererQuitPreparationPromise;
  const run = runRegisteredRendererQuitPreparation().finally(() => {
    if (rendererQuitPreparationPromise === run) rendererQuitPreparationPromise = null;
  });
  rendererQuitPreparationPromise = run;
  return run;
}

async function runRegisteredRendererQuitPreparation(): Promise<boolean> {
  while (true) {
    const targets = quitGuardCoordinator.entries().filter(([id, renderer]) => {
      if (!renderer.isDestroyed() && serverSessions.getBySender(id) && isVerifiedWorkbenchRenderer(renderer)) return true;
      forgetQuitGuardRenderer(id);
      return false;
    });
    if (targets.length === 0) return true;
    const progressDialogParent = resolveQuitProgressDialogParent(targets);
    if (!progressDialogParent) {
      log.warn("[desktop][lifecycle] quit preparation has no live dialog parent");
      return false;
    }
    const requestId = randomUUID();
    const targetIds = targets.map(([id]) => id);
    const responses = quitGuardCoordinator.begin(requestId, targetIds);
    let invalidatedDuringPreparation = false;
    const invalidated = quitGuardCoordinator.watchInvalidation(requestId, targetIds).then(() => {
      invalidatedDuringPreparation = true;
    });
    for (const [id, renderer] of targets) {
      try {
        renderer.send("desktop:lifecycle:prepare-quit", { requestId });
      } catch {
        quitGuardCoordinator.accept(id, requestId, false);
      }
    }
    const dialogAbort = new AbortController();
    const responsePromise = Promise.race([
      Promise.all(responses).then((values) => ({ kind: "responses" as const, ready: values.every(Boolean) })),
      invalidated.then(() => ({ kind: "responses" as const, ready: false })),
    ]);
    const cancelPromise = dialog.showMessageBox(progressDialogParent, {
      type: "info",
      title: "Saving before quitting",
      message: "Nautilo is saving open work before it quits.",
      detail: "You can cancel quitting while saving continues.",
      buttons: ["Cancel Quit"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal: dialogAbort.signal,
    }).then(
      () => ({ kind: "cancel" as const }),
      () => ({ kind: "cancel" as const }),
    );
    const outcome = await Promise.race([responsePromise, cancelPromise]);
    if (outcome.kind === "cancel") {
      cancelRendererQuitPreparation(requestId, targets);
      return false;
    }
    dialogAbort.abort();
    await cancelPromise;
    quitGuardCoordinator.complete(requestId);
    if (outcome.ready && !invalidatedDuringPreparation) {
      completedQuitPreparation = { requestId, targets };
      return true;
    }
    const retry = await dialog.showMessageBox(progressDialogParent, {
      type: "warning",
      title: "Nautilo could not quit safely",
      message: "Some open work could not be saved or preserved exactly.",
      detail: "Keep Nautilo open and retry after resolving the save error.",
      buttons: ["Cancel Quit", "Retry"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }).catch(() => ({ response: 0 }));
    cancelRendererQuitPreparation(requestId, targets);
    if (retry.response !== 1) return false;
  }
}
let currentRelayStatus: RelayStatus = "disconnected";
let relayRootRefreshPromise: Promise<void> | null = null;
let relayRootRefreshQueued = false;
let relayRootRefreshIdleTimer: ReturnType<typeof setTimeout> | null = null;
let deferredRelayRootRefreshReason: string | null = null;
const RELAY_ROOT_REFRESH_IDLE_DELAY_MS = 1_000;

function deferRelayRootRefreshUntilCodexIdle(reason: string): void {
  // Keep only the latest local refresh reason and one timer. This has no
  // connection to model activity; it merely rechecks the local supervisor.
  deferredRelayRootRefreshReason = reason;
  if (relayRootRefreshIdleTimer !== null) return;
  relayRootRefreshIdleTimer = setTimeout(() => {
    relayRootRefreshIdleTimer = null;
    const deferredReason = deferredRelayRootRefreshReason;
    deferredRelayRootRefreshReason = null;
    if (deferredReason) void refreshRelayForCurrentFolder(deferredReason);
  }, RELAY_ROOT_REFRESH_IDLE_DELAY_MS);
}
// D418 reconnect/session split-brain fix — tracks whether the relay has
// completed at least one connected cycle, so `onRelayStatusChange` can
// distinguish a RECONNECT (disconnected/error → connected again) from the
// initial connect and re-push the current capability state. The relay
// client already re-advertises current capabilities at register via the
// dynamic `getCapabilities` getter; this refresh is the defensive
// authoritative re-push AFTER a successful reconnect, so a concurrent
// profile change between disconnect and re-register is reconciled without
// a stop/start cycle. Fire-and-forget: a failure is logged inside
// `refreshDesktopRelayCapabilities` and never blocks the status update.
let relayHasConnectedOnce = false;
// D458 Wave 7 — one main-owned, scoped native wake blocker. It is deliberately
// not a general “keep my Mac awake” preference and the renderer never sees its
// Electron id. It is released on every authority-ending lifecycle below.
let remoteControlKeepAwakePolicy: KeepAwakePolicy = "off";
const remoteControlKeepAwake = new KeepAwakeLeasePolicy({
  start: () => powerSaveBlocker.start("prevent-display-sleep"),
  stop: (id) => powerSaveBlocker.stop(id),
});

function reconcileRemoteControlKeepAwake(
  overrides: Partial<KeepAwakeConditions> = {},
) {
  return remoteControlKeepAwake.reconcile({
    policy: remoteControlKeepAwakePolicy,
    remoteEnabled: getRelayStatus() === "connected",
    // Electron's powerMonitor is authoritative for AC/battery. The policy
    // releases immediately on battery, rather than pretending caffeinate can
    // make lid-closed battery hosting reliable.
    onExternalPower: !powerMonitor.isOnBatteryPower(),
    signedIn: isSignedIn(),
    hostRevoked: false,
    appShuttingDown: false,
    ...overrides,
  });
}

let remoteControlPowerMonitorRegistered = false;
const reconcileRemoteControlPowerState = () => {
  reconcileRemoteControlKeepAwake();
};

/**
 * Electron documents powerMonitor as available only after app readiness. Keep
 * the subscription in this explicit lifecycle seam, and unregister it on quit
 * so test/relaunch-style lifecycles cannot accumulate duplicate listeners.
 */
function registerRemoteControlPowerMonitor(): void {
  if (remoteControlPowerMonitorRegistered) return;
  powerMonitor.on("on-battery", reconcileRemoteControlPowerState);
  powerMonitor.on("on-ac", reconcileRemoteControlPowerState);
  remoteControlPowerMonitorRegistered = true;
}

function unregisterRemoteControlPowerMonitor(): void {
  if (!remoteControlPowerMonitorRegistered) return;
  powerMonitor.removeListener("on-battery", reconcileRemoteControlPowerState);
  powerMonitor.removeListener("on-ac", reconcileRemoteControlPowerState);
  remoteControlPowerMonitorRegistered = false;
}
/**
 * M161 Phase 1 compatibility reads. Boot creates the initial registry
 * session before any auth or renderer setup, so these helpers replace the
 * former module-level server/auth globals without changing existing callers'
 * observable single-server behavior.
 */
function resolvedServerUrl(): string | null {
  return serverSessions.active?.serverUrl ?? null;
}

function logtoConfig(): ServerSessionLogtoConfig | null {
  return serverSessions.active?.logtoConfig ?? null;
}

function isSignedIn(): boolean {
  return serverSessions.active?.signedIn ?? false;
}

function setSignedIn(value: boolean): void {
  const active = serverSessions.active;
  if (!active)
    throw new Error("cannot set signed-in state before server session");
  serverSessions.updateSession(active.serverUrl, { signedIn: value });
}

/** D154 — surfaced to the workbench preload (`shellStateOnBoot`); updated by bootstrap + cold-boot picker. */
type ShellStateOnBoot = "live" | "disconnected" | "wrong-server" | "no-pairing";

let shellStateOnBoot: ShellStateOnBoot = "live";

function coldBootExpectedFingerprint(serverUrl: string): string | null {
  return getRecentServerFingerprint(serverUrl) ?? readPairedServerIdentity();
}

let coldBootObservationAuthority: ColdBootObservationAuthority | null = null;
let committedColdBootTerminal: CommittedColdBootTerminal | null = null;
let activePrecommitColdBootTerminal: ActivePrecommitColdBootTerminal | null = null;
let acceptedIdentityColdBootTerminal: AcceptedIdentityColdBootTerminal | null = null;
let acceptedIdentityColdBootProof: ColdBootAcceptanceProof | null = null;
let coldBootBootstrapReady = false;
let blockedLegacyHandoff = false;
let coldBootRecoveryContinue: (() => void) | null = null;
let coldBootLifecycle: ColdBootLifecycleState = "observing";

function logColdBootDiagnostic(diagnostic: ColdBootDiagnostic): void {
  // Never interpolate URL, identity, response-body, provider, token, or
  // certificate content. The pure authority cannot emit any of them either.
  log.info(
    `[desktop][d514] cold-boot generation=${diagnostic.generation} phase=${diagnostic.phase} category=${diagnostic.category} durationMs=${diagnostic.durationMs} acceptedGeneration=${diagnostic.acceptedGeneration} stateChanged=${diagnostic.stateChanged}`,
  );
}

function initializeColdBootObservationAuthority(): ColdBootObservationAuthority {
  if (coldBootObservationAuthority) return coldBootObservationAuthority;
  coldBootObservationAuthority = new ColdBootObservationAuthority({
    fetch: (input, init) => fetch(input, init),
    expectedFingerprint: coldBootExpectedFingerprint,
    fingerprintFromHealthBody,
    priorActiveScope: resolvedServerUrl,
    onDiagnostic: logColdBootDiagnostic,
  });
  return coldBootObservationAuthority;
}

async function observeColdBootConnection(
  serverUrl: string,
  options: ColdBootObserveOptions = {},
): Promise<ColdBootObserveResult> {
  const observation = await initializeColdBootObservationAuthority().observe(serverUrl, options);
  // A provisional human-acceptance proof deliberately leaves the shared
  // mismatch/shell untouched until synchronous fingerprint persistence commits.
  if (observation.kind === "acceptance-proof") return observation;
  shellStateOnBoot =
    observation.kind === "live"
      ? "live"
      : observation.kind === "wrong-server"
        ? "wrong-server"
        : observation.kind === "no-pairing"
          ? "no-pairing"
          : "disconnected";
  return observation;
}

/**
 * The connection flow has already completed its verified candidate and
 * durable promotion before it exposes this private cohort. Project those
 * exact facts for bootstrap IPC instead of making the local shell wait for a
 * second `/health` observation owned by a different authority.
 */
function projectVerifiedConnectionCohort(
  cohort: InitialConnectionCohort,
) {
  const projected = initializeColdBootObservationAuthority().projectVerifiedCohort({
    serverUrl: cohort.url,
    healthBody: cohort.verified.health.body,
    fingerprint: cohort.verified.health.fingerprint,
  } satisfies VerifiedColdBootCohort);
  if (projected.kind !== "live" || projected.serverUrl !== cohort.url) {
    throw new Error("verified connection cohort could not be projected to cold boot");
  }
  shellStateOnBoot = "live";
  return projected;
}

/** D154 — `loadURL` target for the connect-mode bootstrap shell (file URL); null when dev-from-source. */
let connectBootstrapEntryHref: string | null = null;

/** D154 — last main-window `loadURL` + navigation-guard origin for `activate` reopen. */
let lastMainWindowLoadUrl = "about:blank";

/** D112 — guest `GET /api/setup/status` snapshot taken once per boot after URL resolution. */
let bootSetupStatus: SetupStatusResponse | null = null;

async function loadBootSetupStatus(serverUrl: string): Promise<void> {
  bootSetupStatus = null;
  try {
    const client = new NautiloApiClient(serverUrl.replace(/\/$/, ""));
    bootSetupStatus = await client.getSetupStatus();
    console.log(`[desktop] boot setupState=${bootSetupStatus.setupState}`);
  } catch (err) {
    console.warn("[desktop] boot GET /api/setup/status failed:", err);
  }
}
/**
 * D079 — "current folder" is the task-scoped folder the user has
 * pointed Nautilo at (a codebase, a legal-doc dump, a design folder).
 * Distinct from the Genie's Workspace (her persistent drawer) which
 * lands in Phase 3. NULL is a legitimate state: fresh install with no
 * folder picked, or user explicitly closed the folder.
 */
let currentFolderPath: string | null = null;
/** Process-monotonic revision; process restart also rotates the receipt HMAC. */
let currentFolderRevision = 0;
// Optional and explicitly env-gated: declaration lives beside Current Folder
// authority so construction below cannot capture a pre-initialized selection.
let claudeExecutionHost: ElectronClaudeExecutionHost | null = null;

// D431 — main owns the file handles and version checks for preview-sized
// binary reads. This is additive until Task 1.5 migrates legacy consumers.
const binaryReadSessions = new BinaryReadSessionManager({
  assertPathInAllowedRoot,
});
const binaryReadSessionExpiryTimer = setInterval(() => {
  void binaryReadSessions.cleanupExpired();
}, BINARY_READ_SESSION_TTL_MS);
binaryReadSessionExpiryTimer.unref();

// D385/D378 — a renderer owns only an opaque, revocable preview capability.
// The source path is derived here from its already-bound document, FFmpeg sees
// private paths only, and the sandbox receives a custom-scheme URL whose
// random capability is invalidated on close, navigation, or renderer death.
// This is deliberately Desktop/local only; it is not a Relay/LAN transport.
type MediaProxyOutput = {
  readonly lifetime: AbortController;
  readonly isAuthorityCurrent?: () => boolean;
  readonly ownerId: number;
  /** Separate, renderer-visible capability; never the executor output ref. */
  readonly previewToken: string;
  readonly outputPath: string;
  readonly parentDir: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};
const mediaProxyOutputs = new Map<string, MediaProxyOutput>();
const mediaProxyInflight = new Map<string, { readonly ownerId: number; readonly controller: AbortController; readonly scope: "current-folder" | "workspace" }>();

function mediaProxyKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`;
}

function findMediaProxyByPreviewToken(previewToken: string): [string, MediaProxyOutput] | undefined {
  return [...mediaProxyOutputs.entries()].find(([, output]) => output.previewToken === previewToken);
}

async function discardMediaProxyOutput(outputRef: string): Promise<void> {
  const output = mediaProxyOutputs.get(outputRef);
  if (!output) return;
  output.lifetime.abort();
  mediaProxyOutputs.delete(outputRef);
  await fsp.rm(output.parentDir, { recursive: true, force: true }).catch(() => {});
}

async function discardMediaProxyOutputsForSender(senderId: number): Promise<void> {
  const refs = [...mediaProxyOutputs.entries()]
    .filter(([, output]) => output.ownerId === senderId)
    .map(([ref]) => ref);
  for (const ref of refs) await discardMediaProxyOutput(ref);
  for (const [key, pending] of mediaProxyInflight) {
    if (pending.ownerId === senderId) {
      pending.controller.abort();
      mediaProxyInflight.delete(key);
    }
  }
}

const mediaProxySenderBindings = new Map<number, { sender: Electron.WebContents; onDestroyed: () => void; onDidStartNavigation: (event: Electron.Event, url: string, isInPlace: boolean, isMainFrame: boolean) => void }>();

function bindMediaProxySender(sender: Electron.WebContents): void {
  registerMediaProxySession(sender.session);
  if (mediaProxySenderBindings.has(sender.id)) return;
  const senderId = sender.id;
  const release = () => {
    const binding = mediaProxySenderBindings.get(senderId);
    if (!binding) return;
    binding.sender.removeListener("destroyed", binding.onDestroyed);
    binding.sender.removeListener("did-start-navigation", binding.onDidStartNavigation);
    mediaProxySenderBindings.delete(senderId);
    void discardMediaProxyOutputsForSender(senderId);
  };
  const onDestroyed = release;
  const onDidStartNavigation = (_event: Electron.Event, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame) release();
  };
  mediaProxySenderBindings.set(senderId, { sender, onDestroyed, onDidStartNavigation });
  sender.once("destroyed", onDestroyed);
  sender.on("did-start-navigation", onDidStartNavigation);
}

async function disposeMediaProxySenders(): Promise<void> {
  for (const pending of mediaProxyInflight.values()) pending.controller.abort();
  mediaProxyInflight.clear();
  for (const binding of mediaProxySenderBindings.values()) {
    binding.sender.removeListener("destroyed", binding.onDestroyed);
    binding.sender.removeListener("did-start-navigation", binding.onDidStartNavigation);
  }
  mediaProxySenderBindings.clear();
  for (const output of mediaProxyOutputs.values()) output.lifetime.abort();
  await Promise.all([...new Set([...mediaProxyOutputs.values()].map((output) => output.parentDir))]
    .map((parentDir) => fsp.rm(parentDir, { recursive: true, force: true }).catch(() => {})));
  mediaProxyOutputs.clear();
}

function registerMediaProxyProtocol(targetSession: Electron.Session): void {
  targetSession.protocol.handle("nautilo-media", async (request) => {
    let outputRef: string | null = null;
    try {
      outputRef = parseMediaProxyPreviewToken(request.url);
      if (!outputRef) return new Response("Not found", { status: 404 });
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const entry = outputRef ? findMediaProxyByPreviewToken(outputRef) : undefined;
    const output = entry?.[1];
    if (!output || output.isAuthorityCurrent?.() === false) {
      if (entry) void discardMediaProxyOutput(entry[0]);
      return new Response("Not found", { status: 404 });
    }
    return mediaProxyResponse({ ...output, signal: output.lifetime.signal }, request);
  });
}

function registerMediaProxyRequestGuard(targetSession: Electron.Session): void {
  targetSession.webRequest.onBeforeRequest(
    { urls: ["nautilo-media://*/*"] },
    (details, callback) => {
      try {
        const previewToken = parseMediaProxyPreviewToken(details.url);
        const output = previewToken ? findMediaProxyByPreviewToken(previewToken)?.[1] : undefined;
        // `webContentsId` is supplied by Electron's request details. Missing
        // ownership metadata fails closed rather than treating the URL token
        // as a process-global file grant.
        callback({ cancel: output?.isAuthorityCurrent?.() === false || !isMediaProxyRequestAuthorized({
          previewToken,
          ownerId: output?.ownerId,
          requesterId: details.webContentsId,
        }) });
      } catch {
        callback({ cancel: true });
      }
    },
  );
}

// Workbench uses a per-server Electron partition. Scheme privilege registration
// is process-wide, but the handler and owner guard must share the sender's session.
const mediaProxyProtocolSessions = new WeakSet<Electron.Session>();
function registerMediaProxySession(targetSession: Electron.Session): void {
  if (mediaProxyProtocolSessions.has(targetSession)) return;
  registerMediaProxyProtocol(targetSession);
  registerMediaProxyRequestGuard(targetSession);
  mediaProxyProtocolSessions.add(targetSession);
}

async function probePickedVideoFromCurrentFolder(documentPath: unknown): Promise<
  | { ok: true; data: { mediaRef: string; label: string; mediaKind: "video" | "audio" | "image"; durationSec?: number; frameRate?: { numerator: number; denominator: number } } }
  | { ok: false; error: { code: string } }
> {
  if (!mainWindow || !currentFolderPath || typeof documentPath !== "string") return { ok: false, error: { code: "unsupported_environment" } };
  const boundRoot = currentFolderPath;
  const boundRevision = currentFolderRevision;
  const stillBound = () => currentFolderPath === boundRoot && currentFolderRevision === boundRevision;
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: "Import media",
    properties: ["openFile"],
    filters: [{ name: "Video, audio and images", extensions: ["mp4", "m4v", "m4a", "mp3", "wav", "png", "jpg", "jpeg", "webp"] }],
  });
  if (selection.canceled || !selection.filePaths[0]) return { ok: false, error: { code: "cancelled" } };
  let importedDirectory: string | undefined;
  let retained = false;
  try {
    if (!stillBound()) return { ok: false, error: { code: "stale_project" } };
    const root = await fsp.realpath(boundRoot);
    const canonicalDocument = await fsp.realpath(documentPath);
    if (!isCanonicalPathWithinRoot(canonicalDocument, root)) return { ok: false, error: { code: "unsupported_environment" } };
    const source = await fsp.realpath(selection.filePaths[0]);
    const stat = await fsp.stat(source);
    if (!stat.isFile()) return { ok: false, error: { code: "unsupported_type" } };
    const ffmpeg = await probeDesktopFfmpeg({ isPackaged: app.isPackaged });
    if (!ffmpeg.ok) return { ok: false, error: { code: "processing_unavailable" } };
    // The native pick authorizes this one source, not a reusable external path.
    // Copy disk-to-disk below the bound document, then measure that exact copy.
    importedDirectory = await fsp.mkdtemp(path.join(path.dirname(canonicalDocument), "video-media-"));
    const importedSource = path.join(importedDirectory, "source");
    if (!await copyMediaSnapshot(source, importedSource)) return { ok: false, error: { code: "source_changed" } };
    const metadata = await inspectMediaSource(ffmpeg.binaryPath, importedSource);
    if (!metadata) {
      return { ok: false, error: { code: "unsupported_type" } };
    }
    const namedSource = path.join(importedDirectory, `source.${metadata.extension}`);
    await fsp.rename(importedSource, namedSource);
    const mediaRef = path.relative(path.dirname(canonicalDocument), namedSource).split(path.sep).join("/");
    // The first V1 project ref may not traverse: requiring source media below
    // the document folder keeps the document-relative resolver closed.
    if (!isValidBoundMediaRef(mediaRef)) return { ok: false, error: { code: "unsupported_environment" } };
    if (!stillBound()) return { ok: false, error: { code: "stale_project" } };
    retained = true;
    return { ok: true, data: { mediaRef, label: path.basename(source), mediaKind: metadata.mediaKind,
      ...(metadata.mediaKind !== "image" ? { durationSec: metadata.durationSec } : {}),
      ...(metadata.mediaKind === "video" ? { frameRate: metadata.frameRate } : {}) } };
  } catch {
    return { ok: false, error: { code: "processing_unavailable" } };
  } finally { if (importedDirectory && !retained) await fsp.rm(importedDirectory, { recursive: true, force: true }).catch(() => {}); }
}


type BinaryReadSenderBinding = {
  sender: Electron.WebContents;
  onDestroyed: () => void;
  onDidStartNavigation: (
    event: Electron.Event,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void;
};

// One binding per live renderer. It is retired as soon as that renderer has no
// sessions, navigates its main frame, is destroyed, or the app shuts down.
const binaryReadSenderBindings = new Map<number, BinaryReadSenderBinding>();

function retireBinaryReadSenderBinding(
  senderId: number,
  closeSessions: boolean,
): void {
  const binding = binaryReadSenderBindings.get(senderId);
  if (binding) {
    binding.sender.removeListener("destroyed", binding.onDestroyed);
    binding.sender.removeListener(
      "did-start-navigation",
      binding.onDidStartNavigation,
    );
    binaryReadSenderBindings.delete(senderId);
  }
  if (closeSessions) void binaryReadSessions.closeForSender(senderId);
}

function retireBinaryReadSenderBindingIfIdle(senderId: number): void {
  if (!binaryReadSessions.hasSessionsForSender(senderId)) {
    retireBinaryReadSenderBinding(senderId, false);
  }
}

function bindBinaryReadSender(sender: Electron.WebContents): void {
  if (binaryReadSenderBindings.has(sender.id)) return;
  const senderId = sender.id;
  const onDestroyed = () => retireBinaryReadSenderBinding(senderId, true);
  const onDidStartNavigation = (
    _event: Electron.Event,
    _url: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame) retireBinaryReadSenderBinding(senderId, true);
  };
  binaryReadSenderBindings.set(senderId, {
    sender,
    onDestroyed,
    onDidStartNavigation,
  });
  sender.once("destroyed", onDestroyed);
  sender.on("did-start-navigation", onDidStartNavigation);
}

function disposeBinaryReadSenderBindings(): void {
  for (const senderId of [...binaryReadSenderBindings.keys()]) {
    retireBinaryReadSenderBinding(senderId, false);
  }
}

/**
 * D079 Phase 3 — Genie's Workspace root (Surface A). Populated at
 * boot by `ensureDefaultGenieWorkspace()`. Unlike `currentFolderPath`,
 * this is NEVER null after boot — the default root always exists (or
 * we at least returned the default path string for the renderer's
 * empty-state handling). `setRoot` + `pickAndSetRoot` are Phase 3
 * follow-ups; this commit ships the always-set default + read-only
 * IPC family.
 */
let genieWorkspaceRoot: string | null = null;

// D057 2a.2 — Electron-managed state files live under userData.
// Paths wrap `app.getPath("userData")` so callers evaluate them
// AFTER app init; top-level consts lived in this file but they
// only worked because `app` was imported at the top (which
// initializes the electron internals) — moving to getter calls
// removes the latent boot-order coupling.
const CURRENT_FOLDER_FILE = currentFolderFilePath();
const LEGACY_WORKSPACE_FILE = legacyWorkspaceFilePath();

/**
 * One-shot D079 Phase 1 migration: rename the on-disk persistence file
 * from `workspace.json` → `current-folder.json`. Safe to call every
 * boot — no-op if the new file exists OR the legacy file doesn't.
 */
function migrateLegacyCurrentFolderFile(): void {
  let newExists = false;
  try {
    newExists = fs.statSync(CURRENT_FOLDER_FILE).isFile();
  } catch {
    newExists = false;
  }
  if (newExists) return;

  let oldExists = false;
  try {
    oldExists = fs.statSync(LEGACY_WORKSPACE_FILE).isFile();
  } catch {
    oldExists = false;
  }
  if (!oldExists) return;

  try {
    fs.renameSync(LEGACY_WORKSPACE_FILE, CURRENT_FOLDER_FILE);
    log.info(
      `[desktop] migrated workspace.json → current-folder.json (D079 Phase 1)`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`[desktop] current-folder.json migration failed: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Path validation — prevents traversal attacks on filesystem IPC
// ---------------------------------------------------------------------------

/**
 * D079 Phase 3 — the `fs:readDir` / `fs:readFile` / `fs:stat` IPCs
 * must accept paths under the CURRENT FOLDER (Surface B) AND the
 * GENIE WORKSPACE (Surface A). Before this, only currentFolderPath
 * was allowed, which meant the Workspace tab's readDir call rejected
 * with "Access denied" because `~/Documents/Nautilo/` isn't under
 * the user's currently-opened folder.
 *
 * The guard is strict — exactly these two roots (plus their
 * subtrees). Anything else rejects.
 *
 * D079 PR-011 security port — the check uses `fs.realpathSync` on
 * both the target and each allowed root. `path.resolve` only
 * normalizes textually (collapses `..`) and does NOT follow
 * symlinks — so a symlink inside `~/Documents/Nautilo/` pointing at
 * `/etc/hosts` would pass a pure-textual prefix check and the
 * subsequent `fsp.readFile` would follow the link and read the
 * target. The realpath post-check rejects symlink-based escape.
 * Matches the equivalent zone-resolver contract in
 * `packages/agent/src/tools/file/zones.ts::assertRealpathContained`.
 *
 * For paths that don't exist yet (writing a new file in an IPC),
 * `realpathSync` falls back to `path.resolve` on the target — the
 * parent-directory check would be symmetric but the current IPC
 * surface reads/stats existing paths only, so the new-file case
 * isn't reachable through these handlers today.
 */
function isPathWithinAllowedRoot(targetPath: string): boolean {
  const allowedRoots: string[] = [];
  if (currentFolderPath) allowedRoots.push(resolveReal(currentFolderPath));
  if (genieWorkspaceRoot) allowedRoots.push(resolveReal(genieWorkspaceRoot));
  // When no roots are set at all (fresh install, pre-boot), reject
  // rather than allow — previously this returned true for the
  // "no currentFolderPath" case, which was a latent permissive
  // default. D079 Phase 3 ensures `genieWorkspaceRoot` is always
  // set post-boot, so the no-root case only happens during
  // boot-order edge cases (where we'd rather fail closed).
  if (allowedRoots.length === 0) return false;
  const resolved = resolveReal(targetPath);
  return allowedRoots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
}

/**
 * Resolve a path textually (path.resolve) and then through realpath
 * when the target exists. When it doesn't exist (ENOENT), fall back
 * to the textual resolve — the fs op itself will fail later with a
 * useful ENOENT, and the textual path is still containment-checked
 * against the equally-resolved roots so symlinks on the parent
 * chain that DO exist still get caught.
 */
function resolveReal(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function assertPathInAllowedRoot(targetPath: string): void {
  if (!isPathWithinAllowedRoot(targetPath)) {
    const rootDesc = `currentFolder=${currentFolderPath ?? "(none)"} workspace=${genieWorkspaceRoot ?? "(none)"}`;
    throw new Error(
      `Access denied: ${targetPath} is outside the allowed roots (${rootDesc})`,
    );
  }
}

async function createCompatibilityFileExclusively(
  targetPath: string,
  bytes: Buffer,
): Promise<void> {
  await createCompatibilityFileExclusivelyWithinRoot(
    targetPath,
    bytes,
    assertPathInAllowedRoot,
  );
}

/**
 * D448 document-mutation adapter. Unlike a startup-captured `allowedRoots`
 * array it asks the existing main-process policy on every action, so changing
 * Current Folder cannot leave an old root authorized by a long-lived runtime.
 */
const dynamicDocumentMutationFileAdapter: GuardedFileAdapter = {
  async resolveTarget(filePath, options) {
    const resolved = path.resolve(filePath);
    try {
      const stat = await fsp.lstat(resolved);
      if (options.rejectFinalSymlink && stat.isSymbolicLink()) {
        throw new Error("Desktop document symbolic-link target is forbidden");
      }
      const canonical = await fsp.realpath(resolved);
      assertPathInAllowedRoot(canonical);
      return canonical;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        !options.allowMissing
      ) {
        throw error;
      }
      return await resolveMissingTargetFromExistingAncestor(
        resolved,
        assertPathInAllowedRoot,
      );
    }
  },
  canonicalize(filePath) {
    assertPathInAllowedRoot(filePath);
    const canonical = resolveReal(filePath);
    assertPathInAllowedRoot(canonical);
    return Promise.resolve(canonical);
  },
  async stat(filePath) {
    const canonical =
      await dynamicDocumentMutationFileAdapter.canonicalize(filePath);
    try {
      const stat = await fsp.lstat(canonical);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async readFile(filePath) {
    return await fsp.readFile(
      await dynamicDocumentMutationFileAdapter.canonicalize(filePath),
    );
  },
  async writeFile(filePath, bytes) {
    await fsp.writeFile(
      await dynamicDocumentMutationFileAdapter.canonicalize(filePath),
      bytes,
    );
  },
  async writeFileAtomic(filePath, bytes) {
    const canonical =
      await dynamicDocumentMutationFileAdapter.canonicalize(filePath);
    const temporary = path.join(
      path.dirname(canonical),
      `.${path.basename(canonical)}.nautilo-editor-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await fsp.writeFile(temporary, bytes);
      // Reauthorize immediately before authoritative replacement. The backend
      // also reauthorizes, so this protects both the adapter primitive and the
      // coordinator boundary against Current Folder/path drift.
      const reauthorized =
        await dynamicDocumentMutationFileAdapter.canonicalize(canonical);
      if (reauthorized !== canonical)
        throw new Error(
          "Desktop document path drifted before atomic replacement",
        );
      await fsp.rename(temporary, canonical);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  },
  async writeFileAtomicConditional(filePath, expected, bytes) {
    const canonical = await dynamicDocumentMutationFileAdapter.resolveTarget(
      filePath,
      {
        allowMissing: expected.kind === "missing",
        rejectFinalSymlink: true,
      },
    );
    if (expected.kind === "missing") {
      try {
        await createCompatibilityFileExclusivelyWithinRoot(
          canonical,
          Buffer.from(bytes),
          assertPathInAllowedRoot,
        );
        return { kind: "applied" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          return { kind: "conflict" };
        }
        throw error;
      }
    }
    const current = await fsp.readFile(canonical);
    if (!current.equals(Buffer.from(expected.bytes)))
      return { kind: "conflict" };
    const temporary = path.join(
      path.dirname(canonical),
      `.${path.basename(canonical)}.nautilo-document-${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      await fsp.writeFile(temporary, bytes, { flag: "wx" });
      const publishTarget =
        await dynamicDocumentMutationFileAdapter.resolveTarget(canonical, {
          allowMissing: false,
          rejectFinalSymlink: true,
        });
      if (publishTarget !== canonical) return { kind: "conflict" };
      const publishCurrent = await fsp.readFile(publishTarget);
      if (!publishCurrent.equals(Buffer.from(expected.bytes))) {
        return { kind: "conflict" };
      }
      await fsp.rename(temporary, publishTarget);
      return { kind: "applied" };
    } finally {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  },
  async remove(filePath) {
    await fsp.rm(
      await dynamicDocumentMutationFileAdapter.canonicalize(filePath),
      { force: true },
    );
  },
  async removeConditional(filePath, expected) {
    if (expected.kind === "missing") return { kind: "conflict" };
    const canonical = await dynamicDocumentMutationFileAdapter.resolveTarget(
      filePath,
      {
        allowMissing: false,
        rejectFinalSymlink: true,
      },
    );
    const current = await fsp.readFile(canonical);
    if (!current.equals(Buffer.from(expected.bytes)))
      return { kind: "conflict" };
    const publishTarget =
      await dynamicDocumentMutationFileAdapter.resolveTarget(canonical, {
        allowMissing: false,
        rejectFinalSymlink: true,
      });
    if (publishTarget !== canonical) return { kind: "conflict" };
    const publishCurrent = await fsp.readFile(publishTarget);
    if (!publishCurrent.equals(Buffer.from(expected.bytes))) {
      return { kind: "conflict" };
    }
    await fsp.unlink(publishTarget);
    return { kind: "applied" };
  },
  async removeRecursive(filePath) {
    await fsp.rm(
      await dynamicDocumentMutationFileAdapter.canonicalize(filePath),
      { recursive: true, force: false },
    );
  },
  async rename(from, to) {
    await fsp.rename(
      await dynamicDocumentMutationFileAdapter.canonicalize(from),
      await dynamicDocumentMutationFileAdapter.canonicalize(to),
    );
  },
};

let desktopDocumentMutationRuntime: DesktopDocumentMutationRuntime | undefined;
let desktopDocumentMutationRuntimeRelayId: string | undefined;
let desktopDocumentMutationHistoryRelayId: string | undefined;
let desktopDocumentMutationRelayBindingMismatch:
  | {
      expectedRelayId: string;
      actualRelayId: string;
    }
  | undefined;
let desktopDocumentMutationRuntimeGeneration = 0;

function getDesktopDocumentMutationRuntime():
  DesktopDocumentMutationRuntime | undefined {
  const relayId = getPersistedDesktopRelayId();
  if (!relayId) {
    if (desktopDocumentMutationRuntime) {
      desktopDocumentMutationRuntimeGeneration += 1;
      desktopDocumentMutationRuntime.stopOutboxPump();
      desktopDocumentMutationRuntime = undefined;
      desktopDocumentMutationRuntimeRelayId = undefined;
      invalidatePendingDocumentMutationAcks();
    }
    return undefined;
  }
  if (
    desktopDocumentMutationHistoryRelayId !== undefined &&
    desktopDocumentMutationHistoryRelayId !== relayId
  ) {
    if (
      desktopDocumentMutationRelayBindingMismatch?.actualRelayId !== relayId ||
      desktopDocumentMutationRuntime !== undefined
    ) {
      desktopDocumentMutationRuntimeGeneration += 1;
      desktopDocumentMutationRuntime?.stopOutboxPump();
      desktopDocumentMutationRuntime = undefined;
      desktopDocumentMutationRuntimeRelayId = undefined;
      invalidatePendingDocumentMutationAcks();
    }
    desktopDocumentMutationRelayBindingMismatch = {
      expectedRelayId: desktopDocumentMutationHistoryRelayId,
      actualRelayId: relayId,
    };
    return undefined;
  }
  desktopDocumentMutationRelayBindingMismatch = undefined;
  if (
    desktopDocumentMutationRuntime &&
    desktopDocumentMutationRuntimeRelayId === relayId
  ) {
    return desktopDocumentMutationRuntime;
  }
  // Relay identity scopes the journal manifest. A replacement runtime gets a
  // new journal; permanently stop the old unref'd pump so it cannot publish
  // or contend with batches under a stale relay identity.
  const generation = ++desktopDocumentMutationRuntimeGeneration;
  desktopDocumentMutationRuntime?.stopOutboxPump();
  invalidatePendingDocumentMutationAcks();
  const journal = new LocalDurableMutationJournal({
    rootDir: localFileHistoryDirPath(),
    relayId,
    fileAdapter: dynamicDocumentMutationFileAdapter,
  });
  desktopDocumentMutationRuntime = new DesktopDocumentMutationRuntime({
    getTrustedRelayId: () => getPersistedDesktopRelayId(),
    getTrustedHumanId: () => currentDesktopFilesystemGrantUserId(),
    fileAdapter: dynamicDocumentMutationFileAdapter,
    journal,
    isCurrent: () =>
      generation === desktopDocumentMutationRuntimeGeneration &&
      getPersistedDesktopRelayId() === relayId,
    publishToRenderer: (batch) =>
      generation === desktopDocumentMutationRuntimeGeneration
        ? publishDocumentMutationBatch(batch)
        : Promise.resolve("not_published" as const),
  });
  desktopDocumentMutationRuntimeRelayId = relayId;
  desktopDocumentMutationHistoryRelayId ??= relayId;
  // A no-window/retry failure leaves truth in the journal. Never block app
  // startup or discard it; the first successful renderer publication acks it.
  void desktopDocumentMutationRuntime.recoverAtStartup().catch((error) => {
    console.warn("[desktop] D448 editor mutation recovery deferred:", error);
  });
  return desktopDocumentMutationRuntime;
}

/** D357 Phase 3 — narrow an unknown catch value to a Node errno exception. */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

type FsWatchState = {
  watcher: fs.FSWatcher;
  pending: Set<string>;
  timer: NodeJS.Timeout | null;
};

const fsWatchers = new Map<string, FsWatchState>();

function emitFsDirectoryChanged(
  rootPath: string,
  changedDir: string,
  changedPath?: string,
  extra?: Omit<RelayFsChangeEvent, "rootPath" | "path" | "changedPath">,
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  sendToActiveRenderer("fs:directoryChanged", {
    rootPath,
    path: changedDir,
    ...(changedPath ? { changedPath } : {}),
    ...(extra ?? {}),
  });
}

function emitRelayFsChange(event: RelayFsChangeEvent): void {
  const payload = ipcPayloadFromRelayFsChange(event);
  emitFsDirectoryChanged(payload.rootPath, payload.path, payload.changedPath, {
    source: payload.source,
    op: payload.op,
    ...(payload.reloadRequired !== undefined
      ? { reloadRequired: payload.reloadRequired }
      : {}),
    ...(payload.sha256 ? { sha256: payload.sha256 } : {}),
    ...(payload.clientMutationId
      ? { clientMutationId: payload.clientMutationId }
      : {}),
    ...(payload.patchEvent ? { patchEvent: payload.patchEvent } : {}),
  });
}

function cleanupFsWatchRoot(rootPath: string): void {
  const existing = fsWatchers.get(rootPath);
  if (!existing) return;
  if (existing.timer) clearTimeout(existing.timer);
  existing.watcher.close();
  fsWatchers.delete(rootPath);
}

function cleanupFsWatchers(): void {
  for (const rootPath of Array.from(fsWatchers.keys())) {
    cleanupFsWatchRoot(rootPath);
  }
}

function queueFsWatchEvent(rootPath: string, changedPath: string): void {
  const state = fsWatchers.get(rootPath);
  if (!state) return;
  state.pending.add(changedPath);
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    const paths = Array.from(state.pending);
    state.pending.clear();
    for (const p of paths) {
      emitFsDirectoryChanged(rootPath, path.dirname(p), p);
    }
  }, FS_WATCH_DEBOUNCE_MS);
}

function ensureFsWatchRoot(rootPath: string): void {
  assertPathInAllowedRoot(rootPath);
  const resolvedRoot = fs.realpathSync(rootPath);
  if (fsWatchers.has(resolvedRoot)) return;
  const watcher = fs.watch(
    resolvedRoot,
    {
      recursive: process.platform === "darwin" || process.platform === "win32",
    },
    (_eventType, filename) => {
      const changedPath = filename
        ? path.resolve(resolvedRoot, filename.toString())
        : resolvedRoot;
      queueFsWatchEvent(resolvedRoot, changedPath);
    },
  );
  watcher.on("error", (err) => {
    log.warn(
      `[fs-watch] ${resolvedRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    cleanupFsWatchRoot(resolvedRoot);
  });
  fsWatchers.set(resolvedRoot, { watcher, pending: new Set(), timer: null });
}

// ---------------------------------------------------------------------------
// Current-folder persistence
// ---------------------------------------------------------------------------

function workingFolderBootstrapOptions(): WorkingFolderBootstrapOptions {
  return {
    stateFilePath: CURRENT_FOLDER_FILE,
    defaultFolderPath: DEFAULT_GENIE_WORKSPACE_ROOT,
    homeDirectory: os.homedir(),
    checkSanity: checkCurrentFolderSanity,
    fileSystem: {
      readFile: (filePath) => fs.readFileSync(filePath, "utf-8"),
      mkdir: (directory) => {
        fs.mkdirSync(directory, { recursive: true });
      },
      stat: (directory) => fs.statSync(directory),
      access: (directory) => {
        fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
      },
      realpath: (directory) => fs.realpathSync(directory),
      writeFileExclusive: (filePath, contents) => {
        fs.writeFileSync(filePath, contents, {
          encoding: "utf-8",
          flag: "wx",
          mode: 0o600,
        });
      },
      rename: (from, to) => fs.renameSync(from, to),
      unlink: (filePath) => fs.unlinkSync(filePath),
    },
    dirname: (filePath) => path.dirname(filePath),
    uniqueTempSuffix: randomUUID,
  };
}

function persistCurrentFolderPath(p: string): void {
  persistWorkingFolderPathAtomically(p, workingFolderBootstrapOptions());
}

function assertUsableWorkingFolderPath(p: string): void {
  if (!validateUsableWorkingFolder(p, workingFolderBootstrapOptions()).ok) {
    throw new Error("That folder is no longer usable.");
  }
}

/**
 * Show the native folder picker WITHOUT persisting the selection.
 * Caller (CurrentFolderHeader dropdown's "Open folder…") validates
 * before committing via currentFolder:setPath. pickAndCommit IPC below
 * wraps pick + validate + commit into one call for the common case.
 */
async function pickFolder(): Promise<string | null> {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title: "Open Folder",
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
}

/** D271 — native multi-file open for composer attachments; returns bytes
 * (base64) for the renderer to upload to POST /api/message-attachments. */
async function pickFilesForComposer(): Promise<
  Array<{
    name: string;
    sizeBytes: number;
    base64: string;
  }>
> {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    title: "Attach files",
  });
  if (result.canceled) return [];
  // D271 — return the bytes (base64) so the renderer can upload to
  // POST /api/message-attachments. Trust is the native picker: the user
  // explicitly chose these files in the OS dialog this session. No HMAC/shared-secret model (retired in D271).
  const picked: Array<{
    name: string;
    sizeBytes: number;
    base64: string;
  }> = [];
  for (const filePath of result.filePaths) {
    try {
      const linkStat = await fsp.lstat(filePath);
      if (!linkStat.isFile()) {
        log.warn(
          `[desktop] skipping picked attachment that is not a regular file: ${filePath}`,
        );
        continue;
      }
      const stat = await fsp.stat(filePath);
      if (!stat.isFile()) continue;
      const sizeBytes =
        typeof stat.size === "bigint" ? Number(stat.size) : stat.size;
      const buf = await fsp.readFile(filePath);
      picked.push({
        name: path.basename(filePath),
        sizeBytes,
        base64: buf.toString("base64"),
      });
    } catch (err) {
      log.warn(
        `[desktop] could not read picked attachment ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return picked;
}

/**
 * Persist a chosen current-folder path. Called by every commit path —
 * the renderer dropdown, the tray menu, the native File menu's Recent
 * Folders submenu, and the Open Folder action.
 *
 * Side effects in order:
 *   1. Atomically write current-folder.json.
 *   2. Update main-process currentFolderPath state.
 *   3. Push to the recent-current-folders registry (dedupe + cap 5).
 *   4. Rebuild the native File menu so Recent Folders reflects the
 *      new list.
 *   5. Update the tray menu.
 *   6. Notify the renderer via `currentFolder:pathChanged` so the
 *      BrowserColumnContext updates without a reload. Dropdown-
 *      initiated commits round-trip through this too — that's
 *      acceptable; it keeps a single source of truth for "current
 *      folder changed."
 *   7. Refresh the desktop relay root so relay `allowedRoots`,
 *      `zone:"current"` file access, and shell cwd follow the newly
 *      committed folder instead of the root captured at relay boot.
 */
function commitCurrentFolderPath(
  p: string,
  options: { refreshRelay?: boolean } = {},
): void {
  // Never publish a new filesystem authority that cannot survive restart.
  // In particular, relay, stale-revision, menu, and renderer projections must
  // continue to describe the prior folder if the durable write fails.
  assertUsableWorkingFolderPath(p);
  persistCurrentFolderPath(p);
  const currentFolderChanged = currentFolderPath !== p;
  if (currentFolderPath !== null && currentFolderChanged) {
    workstationShellHost.deactivate(currentFolderPath);
  }
  if (currentFolderChanged) {
    // Codex resolves Current Folder only when opening a new thread. Existing
    // threads retain their own cwd and are not Nautilo folder-bound.
    currentFolderRevision += 1;
    // Local media capabilities are rooted in the prior Current Folder.
    // Revoke previews and abort exports before publishing the new authority.
    for (const pending of mediaProxyInflight.values()) if (pending.scope === "current-folder") pending.controller.abort();
    for (const outputRef of mediaProxyOutputs.keys()) void discardMediaProxyOutput(outputRef);
  }
  currentFolderPath = p;
  if (currentFolderChanged) claudeExecutionHost?.onCurrentFolderChanged();
  pushRecentCurrentFolder(p);
  rebuildApplicationMenu();
  updateTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    sendToActiveRenderer("currentFolder:pathChanged", p);
    // Deprecation alias — D079 Phase 1 window. Emit both so any
    // renderer code still listening to the legacy event continues to
    // work while the migration rolls out.
    sendToActiveRenderer("workspace:pathChanged", p);
  }
  if (options.refreshRelay !== false) {
    void refreshRelayForCurrentFolder("current-folder commit");
  }
}

function showWorkingFolderCommitError(): void {
  log.warn("[desktop] could not use or save the selected Working Folder");
  if (!mainWindow || mainWindow.isDestroyed()) return;
  void dialog.showMessageBox(mainWindow, {
    type: "warning",
    message: "Can't use that folder",
    detail: "Nautilo could not use or save that Working Folder.",
    buttons: ["OK"],
  });
}

async function selectCurrentFolderFromMobile(input: {
  readonly sourceRootKind: "workspace" | "current_folder";
  readonly relativePath: string;
}): Promise<
  | { readonly ok: true; readonly label: string }
  | { readonly ok: false; readonly error: string }
> {
  if (
    input.relativePath.length > 1024 ||
    input.relativePath.includes("\0") ||
    path.isAbsolute(input.relativePath) ||
    input.relativePath
      .split(/[\\/]/)
      .some((part) => part === "." || part === "..")
  ) {
    return { ok: false, error: "That folder selection is invalid." };
  }
  const sourceRoot =
    input.sourceRootKind === "workspace"
      ? genieWorkspaceRoot
      : currentFolderPath;
  if (!sourceRoot) {
    return { ok: false, error: "That folder source is no longer available." };
  }
  try {
    const canonicalRoot = await fsp.realpath(sourceRoot);
    const candidate = path.resolve(canonicalRoot, input.relativePath || ".");
    const canonicalCandidate = await fsp.realpath(candidate);
    if (
      canonicalCandidate !== canonicalRoot &&
      !canonicalCandidate.startsWith(canonicalRoot + path.sep)
    ) {
      return {
        ok: false,
        error: "That folder is outside the authorized source.",
      };
    }
    const stat = await fsp.stat(canonicalCandidate);
    if (!stat.isDirectory())
      return { ok: false, error: "That selection is not a folder." };
    const sanity = checkCurrentFolderSanity(canonicalCandidate, os.homedir());
    if (!sanity.ok) return { ok: false, error: sanity.reason };
    // Do not restart the relay while it is still carrying this request: that
    // would commit successfully and then disconnect before the acknowledgement
    // reaches the server. Return first, then refresh on the next event-loop turn.
    try {
      commitCurrentFolderPath(canonicalCandidate, { refreshRelay: false });
    } catch {
      return { ok: false, error: "Could not save that folder selection." };
    }
    setTimeout(() => {
      void refreshRelayForCurrentFolder("mobile Current Folder selection");
    }, 250);
    return { ok: true, label: path.basename(canonicalCandidate) };
  } catch {
    return { ok: false, error: "That folder is no longer available." };
  }
}

function commitMobileCurrentFolderSelection(input: {
  readonly ok: true;
  readonly label: string;
  readonly canonicalPath: string;
} | {
  readonly ok: false;
  readonly error: string;
}): { readonly ok: true; readonly label: string } | { readonly ok: false; readonly error: string } {
  if (!input.ok) return input;
  // Preserve the acknowledgement-before-refresh ordering: a successful phone
  // selection must not tear down its relay connection before the receipt.
  try {
    commitCurrentFolderPath(input.canonicalPath, { refreshRelay: false });
  } catch {
    return { ok: false, error: "Could not save that folder selection." };
  }
  setTimeout(() => {
    void refreshRelayForCurrentFolder("mobile Current Folder selection");
  }, 250);
  return { ok: true, label: input.label };
}

/** D154 — persisted beside config.json for wrong-server detection at cold boot. */
const PAIRED_SERVER_IDENTITY_FILE = "paired-server-identity.json";

function pairedServerIdentityPath(): string {
  return path.join(app.getPath("userData"), PAIRED_SERVER_IDENTITY_FILE);
}

function readPairedServerIdentity(): string | null {
  try {
    const raw = fs.readFileSync(pairedServerIdentityPath(), "utf8");
    const data = JSON.parse(raw) as { serverIdentity?: unknown };
    return typeof data.serverIdentity === "string" &&
      data.serverIdentity.length > 0
      ? data.serverIdentity
      : null;
  } catch {
    return null;
  }
}

function fingerprintFromHealthBody(
  body: Record<string, unknown>,
): string | null {
  const sid = body["serverIdentity"];
  let id: string | null =
    typeof sid === "string" && sid.length > 0 ? sid : null;
  if (!id) {
    const a = body["logtoDesktopAppId"];
    const b = body["logtoResource"];
    if (
      typeof a === "string" &&
      a.length > 0 &&
      typeof b === "string" &&
      b.length > 0
    ) {
      id = `${a}|${b}`;
    }
  }
  return isServerFingerprint(id) ? id : null;
}

// D480 — process-local observation only. The durable per-tuple result stays
// in the encrypted relay-token payload; this merely prevents a pre-contract
// cached token from being rotated against a server whose /health has not
// advertised the v2 pairing contract.
const relayPairingContractV2Fingerprints = new Set<string>();

function observeRelayPairingContract(
  body: Record<string, unknown>,
  fingerprint: string | null,
): void {
  if (fingerprint && body["relayPairingContractVersion"] === 2) {
    relayPairingContractV2Fingerprints.add(fingerprint);
  }
}

/** M055 — apply Logto config from an already-verified health response. */
function applyVerifiedLogtoHealthBody(
  serverUrl: string,
  body: Record<string, unknown>,
  opts: { trustObservedFingerprint?: boolean; targetSession?: ServerSession } = {},
): boolean {
  try {
    const targetSession = opts.targetSession ?? serverSessions.active;
    if (!targetSession || targetSession.serverUrl !== serverUrl) return false;
    const observedFingerprint = fingerprintFromHealthBody(body);
    observeRelayPairingContract(body, observedFingerprint);
    if (opts.trustObservedFingerprint && observedFingerprint) {
      // `dev-stack --electron` supplies an explicit loopback URL to an
      // unpackaged build, bypassing the picker that normally establishes this
      // trust record. Persist only that narrowly-authorized local fingerprint
      // so a fresh NAUTILO_PROFILE can pair its relay after sign-in.
      pushRecentServer({ url: serverUrl });
      replaceRecentServerFingerprint(serverUrl, observedFingerprint);
      promoteSourceDevelopmentAuthorityFingerprint(serverUrl, observedFingerprint);
      log.info(
        "[desktop][dev-stack] trusted explicit loopback server fingerprint",
      );
    }
    if (app.isPackaged && observedFingerprint && !sourceDevelopmentAuthority) {
      const currentConfig = loadConfig();
      const activeAuthority = currentConfig ? projectActiveAuthority(currentConfig) : null;
      let observedOrigin: string | null = null;
      try { observedOrigin = new URL(serverUrl).origin; } catch { /* invalid server cannot be promoted */ }
      if (currentConfig && activeAuthority?.serverFingerprint === null &&
        activeAuthority.connectionAttemptId.startsWith("legacy-") &&
        activeAuthority.scope === observedOrigin) {
        saveConfig(configForVerifiedLegacyConnection(currentConfig, {
          serverUrl,
          serverFingerprint: observedFingerprint,
        }));
        log.info("[desktop][d514] completed verified legacy active authority");
      }
    }
    const endpoint = body["logtoEndpoint"];
    const appId = body["logtoDesktopAppId"];
    const resource = body["logtoResource"];
    if (
      typeof endpoint === "string" &&
      endpoint.length > 0 &&
      typeof appId === "string" &&
      appId.length > 0 &&
      typeof resource === "string" &&
      resource.length > 0
    ) {
      const nextLogtoConfig = { endpoint, appId, resource };
      targetSession.logtoConfig = nextLogtoConfig;
      log.info(
        `[desktop][m055] Logto auth resolved (endpoint=${nextLogtoConfig.endpoint})`,
      );
      // M097/M161 — resolve the complete identity envelope from ONE active
      // session. Do not capture this probe's `serverUrl` while reading Logto
      // config from the mutable active session: after A → B → A that mixed
      // A's URL with B's endpoint/app id and made both scoped bundles look
      // corrupt, signing the user out on every switch.
      registerDesktopAuthIdentityDescriptor(() => {
        const active = serverSessions.active;
        if (!active?.logtoConfig) {
          throw new Error(
            "active server session or Logto config unresolved when token-store identity was requested",
          );
        }
        return {
          serverUrl: active.serverUrl,
          logtoEndpoint: active.logtoConfig.endpoint,
          clientAppId: active.logtoConfig.appId,
        };
      });
      return true;
    }
    const detail =
      "The server's /health response is missing Logto desktop settings (logtoEndpoint, logtoDesktopAppId, logtoResource). Ensure Logto is running and the server was bootstrapped.";
    log.warn(`[desktop][m055] ${detail}`);
    return false;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(`[desktop][m055] verified health projection failed: ${detail}`);
    return false;
  }
}

const AUTH_DIAGNOSTIC_PROBE_TIMEOUT_MS = 5_000;

/** Explicit user-requested diagnostic refresh; never part of boot or switching. */
async function reprobeLogtoConfigDiagnostic(serverUrl: string): Promise<boolean> {
  const session = serverSessions.active;
  if (!session || session.serverUrl !== serverUrl) return false;
  return reprobeLogtoAuthDiagnostic({
    timeoutMs: AUTH_DIAGNOSTIC_PROBE_TIMEOUT_MS,
    fetch: globalThis.fetch,
    current: () => {
      const active = serverSessions.active;
      return active === session ? {
        session: active,
        routingServerUrl: active.serverUrl,
        authority: authoritativeConnectionSnapshot(),
      } : null;
    },
    apply: (captured, body) => serverSessions.active === captured &&
      applyVerifiedLogtoHealthBody(captured.serverUrl, body, { targetSession: captured }),
  });
}

/**
 * M055 — Refresh token wrapper that uses the Electron token-store
 * facade. Defined once so `auth:getAccessToken` IPC and the boot-time
 * silent refresh share one implementation.
 */
async function refreshTokens(): Promise<TokenBundle | null> {
  const config = logtoConfig();
  if (!config) return null;
  return refreshTokensCore(
    {
      endpoint: config.endpoint,
      appId: config.appId,
      resource: config.resource,
    },
    {
      fetchImpl: globalThis.fetch,
      loadTokens,
      saveTokens,
      clearTokens,
    },
  );
}

/**
 * M101 Phase 4 — best-effort refresh after closing a Logto account page.
 * Uses a no-op `clearTokens` on failure so a transient network error does
 * not sign the user out of the desktop shell.
 */
async function refreshTokensSafe(): Promise<void> {
  const config = logtoConfig();
  if (!config) return;
  await refreshTokensCore(
    {
      endpoint: config.endpoint,
      appId: config.appId,
      resource: config.resource,
    },
    {
      fetchImpl: globalThis.fetch,
      loadTokens,
      saveTokens,
      clearTokens: () => {},
    },
  );
}

/**
 * M101 Phase 4 — open a Logto-hosted account page (`/account` or
 * `/account/password`) in the embedded auth window.
 *
 * We deliberately do NOT prepend an OIDC step-up here. Logto's hosted
 * `/account/password` page enforces its own session-freshness gate: it
 * prompts for the current password when the session's `auth_time` is
 * older than its threshold, and skips the prompt when the user has
 * recently authenticated. Adding our own `prompt=login&max_age=60`
 * pre-flight on every click forces a full re-login even when the
 * session is moments old, which feels broken to the user. Trust Logto's
 * gating and let `account/password` decide. (If we ever need a stricter
 * cap, the right move is to lower Logto's account-API freshness window
 * server-side, not to bolt on a client-side double-check.)
 */
function openLogtoAccountPage(path: AccountPagePath): void {
  const config = logtoConfig();
  if (!config) return;
  const url = buildAccountPageUrl(config.endpoint, path);
  openAuthWindow({
    parent: mainWindow,
    url,
    kind: "account-page",
    onClose: () => {
      void refreshTokensSafe();
    },
  });
}

/**
 * M056 — resolve a usable relay token. In the connect-to-server model
 * we either load a previously-paired token or pair a fresh one against
 * `/api/relay/pair` using the current Logto access token. Returns null
 * when:
 *
 *   - no Logto access token is available
 *     (user not signed in yet — caller defers `startRelay`),
 *   - pairing failed (caller defers `startRelay`).
 *
 * Idempotent: a persisted token short-circuits the network call.
 */
async function ensureRelayToken(serverUrl: string): Promise<string | null> {
  const cached = loadRelayToken(serverUrl);
  // D480's deviceGroupId is derived only from the canonical D133/M161
  // fingerprint. Never substitute a raw URL, hostname, or mutable label.
  const trustedServerFingerprint = getRecentServerFingerprint(serverUrl);
  if (!trustedServerFingerprint) {
    if (cached) return cached;
    log.warn(
      "[desktop][d480] No trusted server fingerprint; deferring first relay pair",
    );
    return null;
  }
  if (
    cached &&
    (!relayPairingContractV2Fingerprints.has(trustedServerFingerprint) ||
      !relayTokenRequiresPairingCutover({
        serverUrl,
        trustedServerFingerprint,
        requirePairingContractV2: true,
      }))
  ) {
    return cached;
  }

  const accessToken = await getValidAccessToken({
    refresh: () => refreshTokens(),
  });
  if (!accessToken) {
    log.warn(
      "[desktop][m056] No Logto access token; deferring relay pair until sign-in",
    );
    return null;
  }
  try {
    const minted = await pairRelay({
      serverUrl,
      accessToken,
      trustedServerFingerprint,
    });
    log.info("[desktop][m056] Paired new relay token");
    return minted;
  } catch (err) {
    log.error(
      `[desktop][m056] Relay pairing failed; deferring relay startup: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

function isRelayTokenRejection(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Invalid or missing relay token/i.test(message);
}

/**
 * M161 Phase 2 — resolve the `ServerSession` the relay should bind to
 * during boot. The boot session is the active session; look it up by
 * URL (canonicalized inside the registry) and fall back to
 * `registry.active` so the relay always binds to a real session whose
 * `relayActive` flag `setActiveRelay` will manage.
 */
function bootSessionForRelay(serverUrl: string): ServerSession {
  const byUrl = serverSessions.getByServerUrl(serverUrl);
  if (byUrl) return byUrl;
  const active = serverSessions.active;
  if (active) return active;
  throw new Error("no active server session for relay boot");
}

/**
 * M056 — boot or re-boot the relay. Resolves the relay's userId from
 * the server, gates startup behind the Logto fail-closed checks, and
 * starts the relay with a token when one is available.
 *
 * Called once from boot()'s tail and again from `handleSignIn` so
 * relay startup retries automatically the moment the user signs in.
 */
async function bootRelayIfPossible(serverUrl: string): Promise<void> {
  // A bootstrap relay may have been admitted before interactive sign-in from
  // the local setup projection. Once Logto completes, resolve the canonical
  // session actor before honoring the connected/connecting fast path. A
  // different actor is a new Computer use authority boundary, so restart the
  // relay through its existing stop-before-start handoff rather than leaving
  // a stale runtime for owned-Genie admission to reject.
  const expectedHumanUserId = await resolveRelayUserId(serverUrl);
  if (!expectedHumanUserId) return;
  const activeRuntime = getActiveComputerUseRuntime();
  if ((getRelayStatus() === "connected" || getRelayStatus() === "connecting")
    && activeRuntime?.humanUserId === expectedHumanUserId) {
    if (getRelayStatus() === "connected") {
      void reconcileReadyForServerSession(bootSessionForRelay(serverUrl));
    }
    return;
  }
  await startRelayForSession(bootSessionForRelay(serverUrl));
  // A mounted Connections panel may have truthfully shown the stale runtime's
  // owned-Genie rejection. Wake it only after the rebind settled so it
  // refetches sender-gated status and ownership without a reload or Check.
  notifyComputerUseStatusChanged();
}

/**
 * M161 Phase 3 — relay start for a specific session, shared by the boot
 * path (`bootRelayIfPossible`) and the in-process switch handoff
 * (`handoffRelay` hook). Resolves the relay userId + token for the
 * session's own server URL, builds `StartRelayOptions`, and routes
 * through `setActiveRelay` (stop-before-start). On a relay-token
 * rejection, clears the scoped token and re-pairs once. Does NOT skip
 * when already connected — the caller decides that (boot guards on
 * status; switch always hands off so the previous server's relay is
 * torn down before the target's is started).
 */
async function startRelayForSession(session: ServerSession): Promise<void> {
  const serverUrl = session.serverUrl;
  // Establish or transition the server-scoped local authority before any
  // target-server auth/token early return. A switch to an unavailable or
  // signed-out server must still revoke the server we are leaving.
  await configureComputerUseForServer(serverUrl);
  // Resolve the relay's userId so it matches the server-side
  // state.userId that tool dispatches use. Without this, the relay
  // registers under a hardcoded default and findByCapabilityForUser
  // never matches — every relay tool call fails silently. See D064.
  const userId = await resolveRelayUserId(serverUrl);
  if (!userId) {
    log.warn(
      "[desktop][m056] Could not resolve relay userId; deferring startRelay until sign-in",
    );
    return;
  }

  const relayToken = await ensureRelayToken(serverUrl);
  if (!relayToken) {
    log.warn("[desktop][m056] No relay token available; deferring startRelay");
    return;
  }

  const googleOAuthStatusToken = logtoConfig()
    ? await getValidAccessToken({
        refresh: () => refreshTokens(),
        onObservedRejection: onLogtoRefreshFailed,
      })
    : readPersistedSessionToken();

  if (genieWorkspaceRoot === null) {
    throw new Error(
      "Desktop Genie Workspace is unavailable; repair the visible Workspace before starting the relay.",
    );
  }

  const currentFolderAdoptionNautiloRoot = resolveNautiloRootDir();
  const currentFolderAdoptionProtectedPathPolicy = buildProtectedPathPolicy({
    homeDir: os.homedir(),
    platform: process.platform,
    nautiloRoots: {
      privateRoot: path.join(currentFolderAdoptionNautiloRoot, "private"),
      dataRoot: path.join(currentFolderAdoptionNautiloRoot, "data"),
      auditRoot: path.join(currentFolderAdoptionNautiloRoot, "audit"),
    },
  });
  // D497 — the helper is process-local and never receives a server-provided
  // approval bit. The relay adapter below supplies approval only after its
  // explicit desktop dispatch guard has admitted the opaque preparation id.
  const currentFolderAdoption = createCurrentFolderAdoptionAuthority({
    getWorkspaceRoot: () =>
      genieWorkspaceRoot === null
        ? null
        : { path: genieWorkspaceRoot, revision: 0 },
    getCurrentFolderRoot: () =>
      currentFolderPath === null
        ? null
        : { path: currentFolderPath, revision: currentFolderRevision },
    getCurrentFolderSelection: () => ({
      path: currentFolderPath,
      revision: currentFolderRevision,
    }),
    checkCurrentFolderSanity: (candidate) =>
      checkCurrentFolderSanity(candidate, os.homedir()),
    protectedPathPolicy: currentFolderAdoptionProtectedPathPolicy,
    commitCurrentFolderPath,
  });
  if (process.env["NAUTILO_CLAUDE_CODE_TASKS"] === "1" && claudeExecutionHost === null) {
    claudeExecutionHost = new ElectronClaudeExecutionHost({
      currentFolder: () => currentFolderPath === null
        ? null
        : Object.freeze({ path: currentFolderPath, revision: currentFolderRevision }),
    });
  }
  // Phone directory browsing has a deliberately separate local authority from
  // generic Computer Files.  It owns opaque location ids and never exposes a
  // Mac path to the server/phone; selection is still committed only here.
  const pairedFilesystemDirectory = createPairedFilesystemDirectoryAuthority({
    getHomeDirectory: () => os.homedir(),
    protectedPathPolicy: currentFolderAdoptionProtectedPathPolicy,
    checkCurrentFolderSanity: (candidate) => checkCurrentFolderSanity(candidate, os.homedir()),
  });

  // D458 — relay Workspace and Current Folder are intentionally separate.
  // Genie Workspace is the guaranteed Finder-visible baseline that makes a
  // newly paired desktop useful immediately. Current Folder remains the
  // optional Human project selection; passing it through a provider never
  // creates, replaces, or persists it during relay boot/pairing.
  const relayOpts: StartRelayOptions = {
    serverUrl,
    userId,
    relayIdentityFilePath: desktopRelayIdentityFilePath(),
    localFileHistoryRootDir: localFileHistoryDirPath(),
    legacyLocalHistoryRelayIdentityFilePath: legacySharedRelayIdentityFilePath(),
    ...(targetDirName === APP_NAME
      ? { legacyRelayIdentityFilePath: legacySharedRelayIdentityFilePath() }
      : {}),
    workspacePath: genieWorkspaceRoot,
    // Resolve at each dispatch: Current Folder can change while the relay
    // stays connected, but explicitly Current-Folder-bound paths must fail
    // when absent rather than silently falling back to Genie Workspace.
    currentFolderPathProvider: () => currentFolderPath ?? undefined,
    // D500: app-owned trust/grant storage only. Structured SSH deliberately
    // receives no Current Folder and never falls back to run_shell.
    structuredSshAppDataDirectory: app.getPath("userData"),
    // D560 security research is durable app-owned state, never a project
    // directory and never inferred by the relay from a server request.
    securityResearchDataDirectory: app.getPath("userData"),
    computerUseSnapshotProvider: async () => {
      const stored = computerUseLocalStore;
      const routeAttestation = computerUseProviderRouteAttestation;
      if (stored === null || routeAttestation === null) return undefined;
      // Initial registration has no server-acknowledged topology yet.  Do not
      // attach a durable receipt until the relay callback establishes the
      // exact current pairing/session and reconciliation has run.
      const runtime = getActiveComputerUseRuntime();
      if (runtime === null) return undefined;
      const built = await buildForStableComputerUseRuntime({
        initialRuntime: runtime,
        currentRuntime: getActiveComputerUseRuntime,
        build: async () => {
          const current = await stored.get();
          if (!current.ok) {
            routeAttestation.clear();
            return undefined;
          }
          // Host ownership begins at its immutable bundled bootstrap. This
          // snapshot must not create or borrow Electron's former Cua socket.
          const route = routeAttestation.resolveWithAvailability(await currentCuaProviderAvailability());
          if (current.data.receipt === null) return undefined;
          if (!receiptMatchesCurrentComputerUseRuntime(current.data.receipt, runtime)) {
            routeAttestation.clear();
            return undefined;
          }
          // A durable receipt is not readiness. Do not advertise Computer use
          // unless this exact Electron process has an executable selected route.
          return route === null
            ? undefined
            : {
                enabled: true as const,
                agentId: current.data.receipt.agentId,
                installationEpoch: current.data.receipt.installationEpoch,
                grantGeneration: current.data.receipt.grantGeneration,
                provider: route.provider,
                providerGeneration: route.providerGeneration,
              };
        },
      });
      if (!built.stable) {
        routeAttestation.clear();
        clearCuaRouteState();
        return undefined;
      }
      return built.value;
    },
    onComputerUseTopologyChange: (refreshRelayCapabilities) =>
      reconcileComputerUseTopology(refreshRelayCapabilities),
    computerUseDispatch: async (invocation) => {
      if (invocation.computerUseRequest !== undefined) {
        const stored = computerUseLocalStore;
        const runtime = getActiveComputerUseRuntime();
        const current = stored === null ? null : await stored.get().catch(() => null);
        const receipt = current?.ok === true ? current.data.receipt : null;
        if (runtime === null || receipt === null
          || !receiptMatchesHostInvocation(receipt, invocation.binding, runtime)) {
          return { ok: false as const, hostFailure: "authority_mismatch" as const };
        }
        const dispatched = await computerUseHostBroker.dispatch({
          authority: {
            authorityLeaseId: invocation.binding.computerUseContextId,
            authorityGeneration: invocation.binding.grantGeneration,
          },
          cancellationGeneration: invocation.binding.grantGeneration,
          requestId: invocation.binding.computerUseInvocationId,
          contract: invocation.computerUseRequest.contract,
          arguments: invocation.computerUseRequest.arguments,
          ...(invocation.signal === undefined ? {} : { signal: invocation.signal }),
        });
        if (!dispatched.ok) return { ok: false as const, hostFailure: dispatched.code };
        return {
          ok: true as const,
          contract: invocation.computerUseRequest.contract,
          hostResult: dispatched.result,
          ...(dispatched.attachment === undefined
            ? {}
            : { visionImage: { mime: "image/png" as const, base64: Buffer.from(dispatched.attachment.bytes).toString("base64") } }),
        };
      }
      // Relay admission requires the generic request for computer_use. Never
      // reinterpret a malformed/old request through the retired controller.
      return { ok: false as const, hostFailure: "host_protocol_rejected" as const };
    },
    // D497 — this is a process-local Electron authority. Its successful
    // commit receipt confirms only the local Current Folder transition;
    // commitCurrentFolderPath refreshes the relay asynchronously.
    currentFolderAdoption: {
      prepare: (request) => currentFolderAdoption.prepare(request),
      commit: ({ preparationId }) =>
        currentFolderAdoption.commit({ preparationId, approved: true }),
    },
    selectCurrentFolder: selectCurrentFolderFromMobile,
    pairedFilesystemDirectory: {
      list: (request) => pairedFilesystemDirectory.list(request),
      select: async (request) => commitMobileCurrentFolderSelection(
        await pairedFilesystemDirectory.select(request.relativePath),
      ),
    },
    ensureBrowserSurface: async ({ url, timeoutMs }) => {
      const renderer = activeRenderer();
      const manager = browserControlManager;
      if (!renderer || !manager) {
        return {
          ok: false as const,
          error:
            "browser_open could not ask the active Nautilo window to open its Browser surface",
        };
      }

      // Register with the authoritative manager before sending so a fast
      // renderer adoption cannot beat the handshake subscription.
      const ready = manager.waitForActiveView("browser", timeoutMs);
      renderer.send("browserControl:openRequested", { url });
      const snapshot = await ready;
      if (!snapshot) {
        return {
          ok: false as const,
          error:
            "browser_open timed out waiting for Nautilo's Browser surface to become controllable",
        };
      }
      return { ok: true as const };
    },
    controlBrowserNavigation: async ({ action }) => {
      const result = browserControlManager?.navigateActive(action) ?? {
        ok: false as const,
        error: "The embedded Browser control manager is unavailable",
      };
      if (!result.ok) return result;
      await new Promise((resolve) =>
        setTimeout(resolve, action === "reload" ? 750 : 500),
      );
      return { ok: true as const };
    },
    // D504: the relay receives only this Electron-main-owned target port.
    // The hidden research target never enters interactive Browser state.
    ...(browserResearchTargetManager !== null
      ? {
          browserResearchTargetPort: browserResearchTargetManager,
          onBrowserResearchIntervention: (
            intervention: import("./browser-research-target-manager").BrowserResearchInterventionSnapshot,
          ) => {
            sendToActiveRenderer("browserResearch:intervention", intervention);
          },
        }
      : {}),
    onStatusChange: onRelayStatusChange,
    onFsChange: emitRelayFsChange,
    token: relayToken,
    googleOAuthClientPath: path.join(
      app.getPath("userData"),
      GOOGLE_OAUTH_CLIENT_FILENAME,
    ),
    // D418 prerequisite — share the single main-process authority with the
    // relay so the resolver and snapshot builder see overlay grants.
    desktopFilesystemGrantAuthority: desktopFilesystemGrantStore,
    // D418 — share the single main-process active-profile controller so the
    // relay advertises the controller's redacted profile snapshot from the
    // SAME store the main process owns (no duplicate profile stores).
    workstationProfileController: activeWorkstationProfileController,
    // D448: native apply_patch is private-staging only. The process-scoped
    // Desktop mutation runtime is the sole live-file writer and shares the
    // editor's coordinator, V2 journal, locks, recovery and durable outbox.
    commitDesktopApplyPatch: async (input) => {
      const runtime = getDesktopDocumentMutationRuntime();
      if (!runtime) {
        return {
          rejected: true,
          operations: [],
          error: {
            code: "runtime_unavailable",
            message: "Desktop document mutation runtime is unavailable.",
            retryable: true,
          },
        };
      }
      return runtime.commitApplyPatch({
        root: input.root,
        agentId: input.identity.agentId,
        turnId: input.identity.turnId,
        operations: input.operations,
        reauthorize: input.reauthorize,
      });
    },
    // D448: OfficeCLI still owns private generation/OOXML validation, but its
    // final Current Folder binary write uses this same coordinator, V2 journal,
    // lock domain and durable event outbox as editor saves and apply_patch.
    commitDesktopOfficeCli: async (input) => {
      const runtime = getDesktopDocumentMutationRuntime();
      if (!runtime) {
        return {
          ok: false as const,
          code: "error" as const,
          message: "Desktop document mutation runtime is unavailable.",
        };
      }
      return runtime.commitOfficeCli(input);
    },
    // D448 Phase 11: ordinary file content commands keep their relay grant
    // authorization and response envelope, but the process-scoped runtime is
    // their sole live-file/V2 journal/outbox commit owner.
    commitDesktopAgentContent: async (input) => {
      const runtime = getDesktopDocumentMutationRuntime();
      if (!runtime) {
        return {
          ok: false as const,
          code: "error" as const,
          message: "Desktop document mutation runtime is unavailable.",
        };
      }
      return runtime.commitAgentContent(input);
    },
    // D448 Phase 11.1: structural file commands use the same canonical
    // coordinator, CAS, V2 journal and outbox as all other local mutations.
    commitDesktopAgentStructural: async (input) => {
      const runtime = getDesktopDocumentMutationRuntime();
      if (!runtime) {
        return {
          ok: false as const,
          code: "error" as const,
          message: "Desktop document mutation runtime is unavailable.",
        };
      }
      return runtime.commitAgentStructural(input);
    },
    // D448 Phase 11.2: undo/redo are canonical V2 coordinator mutations,
    // sharing the same locks, leases, CAS, journal and outbox as file writes.
    commitDesktopHistoryRestore: async (input) => {
      const runtime = getDesktopDocumentMutationRuntime();
      if (!runtime) {
        return {
          ok: false as const,
          code: "error" as const,
          message: "Desktop document mutation runtime is unavailable.",
        };
      }
      return runtime.commitHistoryRestore(input);
    },
    resolveApplyPatchTrustedIdentity: (_request, preparation) => ({
      // Relay registration authenticates this Desktop user. Filesystem grants
      // are deliberately not part of Current Folder apply_patch authority.
      ownerId: userId,
      agentId: preparation.request.operation.routing.agentId,
      turnId: preparation.request.operation.routing.turnId,
    }),
    runWorkstationShell: (request) => workstationShellHost.execute(request),
    verifyUncontainedHostCommands: verifyUncontainedHostCommandsForRelay,
    // D453 — stable disabled-by-default port survives relay replacement and
    // re-pair; readiness remains false until an explicit local enable.
    codexHostPort: codexConnection,
    // D452 v17 — account/catalog discovery is a parked local SDK exchange;
    // the relay receives only its closed, scope-fenced result.
    claudeConnectionHostPort: claudeConnection,
    ...(claudeExecutionHost === null ? {} : { claudeExecutionHostPort: claudeExecutionHost }),
    // D452 v14 — Electron retains launch/session authority; relay receives
    // only opaque workspace receipts and bounded semantic frames.
    acpHostPort: acpExecutionRouter,
    ...(googleOAuthStatusToken ? { googleOAuthStatusToken } : {}),
  };

  try {
    // Rehydrate the optional Codex host before the relay's first register so
    // the initial capability snapshot is truthful. Starting it afterwards
    // relies on a second capability-update handshake and can leave the local
    // Connections UI green while a freshly restarted server has never seen a
    // Codex-capable host. A disconnected relay makes enablement reconciliation
    // explicitly deferred; startRelay immediately advertises the resulting
    // ready host in its canonical register frame.
    await restoreCodexConnectionBeforeRelayStart(userId);
    // D418 reconnect/session split-brain fix — a fresh startRelay begins a
    // new relay lifecycle; reset the reconnect flag so the FIRST connect of
    // this cycle is treated as initial (the register frame already
    // advertises current caps) and only a subsequent reconnect triggers
    // the defensive post-reconnect capability refresh.
    relayHasConnectedOnce = false;
    // M161 Phase 2 — route the start through `setActiveRelay` so the
    // relay binds to the named session and `relayActive` is managed on
    // the session object (background sessions stay `relayActive=false`).
    // `setActiveRelay` awaits `stopRelay()` before `startRelay()`.
    await setActiveRelay(serverSessions, session, relayOpts);
    console.log("[desktop] Relay connected");
    void reconcileReadyForServerSession(session);
  } catch (err) {
    if (isRelayTokenRejection(err)) {
      log.warn(
        "[desktop][m056] Cached relay token was rejected; clearing scoped token and re-pairing",
      );
      clearRelayToken(serverUrl);
      await stopRelay().catch(() => undefined);

      const freshRelayToken = await ensureRelayToken(serverUrl);
      if (freshRelayToken) {
        try {
          // D418 reconnect fix — fresh lifecycle after a re-pair; reset the
          // reconnect flag (see the primary startRelay call above).
          relayHasConnectedOnce = false;
          // M161 Phase 2 — re-pair also routes through `setActiveRelay` so
          // the relay stays bound to the session and the stop/start
          // ordering is preserved (the explicit `stopRelay` above already
          // tore down the rejected client; `setActiveRelay`'s internal
          // stop is a no-op on a null client).
          await setActiveRelay(serverSessions, session, {
            ...relayOpts,
            token: freshRelayToken,
          });
          console.log("[desktop] Relay connected after re-pair");
          void reconcileReadyForServerSession(session);
          return;
        } catch (retryErr) {
          console.error(
            "[desktop] Relay connection failed after re-pair (will auto-retry):",
            retryErr,
          );
          return;
        }
      }
    }
    console.error("[desktop] Relay connection failed (will auto-retry):", err);
  }
}

/**
 * D340/D458 — Current Folder augments the relay's Workspace baseline. If the
 * user changes it after the relay connects, refresh the relay so its optional
 * Current Folder root and server-private binding metadata stay exact. The
 * always-present Genie Workspace remains unchanged throughout this lifecycle.
 */
async function refreshRelayForCurrentFolder(reason: string): Promise<void> {
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) {
    log.info(
      `[desktop][d340] Skipping relay root refresh after ${reason}; server URL is not resolved yet`,
    );
    return;
  }
  if (await codexConnection.hasActiveWork()) {
    // Current Folder affects only future auto-resolved Codex cwd. Replacing
    // the relay here would disconnect and terminate the active supervisor.
    deferRelayRootRefreshUntilCodexIdle(reason);
    return;
  }
  if (relayRootRefreshIdleTimer !== null) {
    clearTimeout(relayRootRefreshIdleTimer);
    relayRootRefreshIdleTimer = null;
    deferredRelayRootRefreshReason = null;
  }
  if (relayRootRefreshPromise) {
    relayRootRefreshQueued = true;
    return relayRootRefreshPromise;
  }

  relayRootRefreshPromise = (async () => {
    const status = getRelayStatus();
    const nextRoot =
      currentFolderPath ??
      "(no Current Folder; Genie Workspace remains baseline)";
    if (status === "connected" || status === "connecting") {
      // Recheck inside the serialized refresh. Work could have begun after
      // the outer check while this refresh was waiting for a prior caller.
      if (await codexConnection.hasActiveWork()) {
        deferRelayRootRefreshUntilCodexIdle(reason);
        return;
      }
      log.info(
        `[desktop][d340] Refreshing relay root after ${reason}: ${nextRoot}`,
      );
      try {
        await stopRelay();
      } catch (err) {
        log.warn(
          `[desktop][d340] Failed to stop relay for root refresh: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return;
      }
    } else {
      log.info(
        `[desktop][d340] Relay is ${status}; booting with current folder after ${reason}: ${nextRoot}`,
      );
    }

    await bootRelayIfPossible(serverUrl);
  })().finally(() => {
    relayRootRefreshPromise = null;
    if (relayRootRefreshQueued) {
      relayRootRefreshQueued = false;
      void refreshRelayForCurrentFolder("queued current-folder commit");
    }
  });

  return relayRootRefreshPromise;
}

/**
 * M055 — flip the cached signed-in flag and rebuild the native menu
 * so the Account submenu's enabled/disabled state stays current.
 * Cheap on equal-value calls (rebuildApplicationMenu is the same
 * call commitCurrentFolderPath already runs after every commit).
 */
function refreshAuthMenuState(next: boolean): void {
  if (isSignedIn() === next) {
    // Sign-out while already signed-out still needs a menu rebuild on some
    // boot paths (silent refresh failure before `isSignedIn` was ever true).
    if (next === false) rebuildApplicationMenu();
    return;
  }
  setSignedIn(next);
  rebuildApplicationMenu();
}

const broadcastAuthStateDeps: BroadcastAuthStateDeps = {
  getAllWindows: () => {
    const renderer = activeRenderer();
    const activeViewTarget = renderer
      ? [
          {
            id: renderer.id,
            isDestroyed: () => renderer.isDestroyed(),
            webContents: renderer,
          },
        ]
      : [];
    return [...BrowserWindow.getAllWindows(), ...activeViewTarget];
  },
};

let mediaAuthGeneration = 0;
function broadcastAuthState(state: "signed-in" | "signed-out"): void {
  mediaAuthGeneration++;
  void disposeMediaProxySenders();
  broadcastAuthStateImpl(broadcastAuthStateDeps, state);
}

function invalidateMiniAppRecoveryAuthentication(): void {
  miniAppRecoveryAuthGeneration += 1;
  miniAppRecoveryRuntime?.invalidateAll();
}

function onLogtoRefreshFailed(): void {
  invalidateMiniAppRecoveryAuthentication();
  void disposeMediaProxySenders();
  refreshAuthMenuState(false);
  broadcastAuthState("signed-out");
  if (
    Notification.isSupported() &&
    process.env["CI"] !== "true" &&
    process.env["NODE_ENV"] !== "test"
  ) {
    try {
      new Notification({
        title: "Nautilo sign-in expired",
        body: "Click the workbench window to re-authenticate.",
      }).show();
    } catch (err) {
      log.warn(
        `[auth] auth expiry notification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * M055 — derive `MenuOptions.auth` for `createApplicationMenu`.
 */
function buildMenuAuthOptions(): MenuAuthOptions {
  if (!logtoConfig()) {
    return { status: "unresolved" };
  }
  return {
    status: "ready",
    signedIn: isSignedIn(),
    onSignIn: () => {
      // Fire-and-forget — the IPC handler updates the menu state +
      // broadcasts to the renderer on completion.
      void handleSignIn();
    },
    onSignOut: () => {
      void handleSignOut();
    },
    onChangePassword: () => {
      openLogtoAccountPage("/account/password");
    },
    onChangePinMenu: () => {
      sendToActiveRenderer("menu:action", "open-change-pin");
    },
    onRestorePinMenu: () => {
      sendToActiveRenderer("menu:action", "open-restore-pin");
    },
    onManageDevices: () => {
      sendToActiveRenderer("menu:action", "open-account-devices");
    },
  };
}

/**
 * M055 — drive the loopback PKCE flow. Shared between the
 * `auth:signIn` IPC and the native menu's Sign In click; returns the
 * same `{ok, error?}` envelope the IPC promises so callers don't
 * special-case.
 */
async function handleSignIn(
  opts?: {
    extraParams?: Record<string, string>;
    theme?: "light" | "dark" | null;
  },
): Promise<{ ok: boolean; error?: string }> {
  mediaAuthGeneration++;
  await disposeMediaProxySenders();
  let loopbackRef: { shutdown: () => void } | null = null;
  const startLoopbackCapturing = async () => {
    const loopback = await startLoopbackServer();
    loopbackRef = loopback;
    return loopback;
  };
  try {
    // Boot applies verified health before sign-in; explicit reprobe overwrites
    // on success only.
    const cfg = logtoConfig();
    if (!cfg) throw new Error("Logto config unresolved");
    await runSignIn(
      {
        endpoint: cfg.endpoint,
        appId: cfg.appId,
        resource: cfg.resource,
        ...(opts?.extraParams ? { extraParams: opts.extraParams } : {}),
      },
      {
        // M055 follow-up — embedded sign-in instead of
        // `shell.openExternal`. Keeps the user inside the app; the
        // loopback server still catches the redirect. Trade-offs
        // documented in `auth-window.ts`.
        openAuthUrl: (url) =>
          Promise.resolve(
            openAuthWindow({
              parent: mainWindow,
              url,
              kind: "sign-in",
              theme: opts?.theme ?? null,
              onClose: ({ closedByUser }) => {
                if (closedByUser && loopbackRef) loopbackRef.shutdown();
              },
            }),
          ),
        fetchImpl: globalThis.fetch,
        saveTokens,
        startLoopback: startLoopbackCapturing,
      },
    );
    invalidateMiniAppRecoveryAuthentication();
    refreshAuthMenuState(true);
    const serverUrl = resolvedServerUrl();
    if (serverUrl) {
      await loadBootSetupStatus(serverUrl);
    }
    broadcastAuthState("signed-in");
    // M056 — fresh sign-in unblocks relay startup if the boot tail
    // deferred it (no Logto access token yet, or relay userId could
    // not be resolved). Fire-and-forget; status updates flow back
    // through onRelayStatusChange.
    if (serverUrl) {
      void bootRelayIfPossible(serverUrl);
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.message === "Loopback server shut down") {
      return { ok: false, error: "cancelled" };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * M101 — OIDC step-up for a fresh JWT (`prompt=login` + `max_age`) without
 * disturbing the rest of the shell; persists rotated tokens when Logto
 * returns them.
 */
async function handleAuthStepUp(opts: {
  maxAgeSeconds?: number;
}): Promise<
  { accessToken: string; issuedAt: number } | { error: "cancelled" }
> {
  const config = logtoConfig();
  if (!config) {
    return { error: "cancelled" };
  }
  // Capture the loopback handle so the auth-window's `onClose` can
  // proactively `shutdown()` it when the user dismisses the surface
  // before the OIDC redirect — otherwise the IPC promise hangs until
  // the loopback server's 5-minute default timeout fires.
  let loopbackRef: { shutdown: () => void } | null = null;
  const startLoopbackCapturing = async () => {
    const lb = await startLoopbackServer();
    loopbackRef = lb;
    return lb;
  };
  try {
    return await runStepUp(
      {
        openAuthUrl: (url) =>
          Promise.resolve(
            openAuthWindow({
              parent: mainWindow,
              url,
              kind: "step-up",
              onClose: ({ closedByUser }) => {
                if (closedByUser && loopbackRef) loopbackRef.shutdown();
              },
            }),
          ),
        startLoopback: startLoopbackCapturing,
        fetchImpl: globalThis.fetch,
        saveTokens: (bundle) => {
          saveTokens(bundle);
          return Promise.resolve();
        },
        config: {
          endpoint: config.endpoint,
          clientId: config.appId,
          resource: config.resource,
        },
        generatePkce: () => {
          const p = generatePkcePair();
          return Promise.resolve({
            verifier: p.codeVerifier,
            challenge: p.codeChallenge,
          });
        },
        generateState,
        getExistingTokenBundle: () => Promise.resolve(loadTokens()),
      },
      opts,
    );
  } catch (err) {
    if (
      err instanceof Error &&
      err.message === "step_up_cancelled" &&
      (err as { code?: unknown }).code === "cancelled"
    ) {
      return { error: "cancelled" };
    }
    throw err;
  }
}

/**
 * M055/M061 — Electron sign-out is local to the app shell. Do not open
 * Logto in the user's system browser: Electron sign-in uses an embedded
 * BrowserWindow, and interactive sign-in now sends `prompt=login consent`,
 * so clearing Nautilo tokens plus the Electron Logto cookies is the right
 * app-local logout behavior.
 */
async function handleSignOut(): Promise<void> {
  invalidateMiniAppRecoveryAuthentication();
  await disposeMediaProxySenders();
  await disposeAllForegroundShadowControllers();
  remoteControlKeepAwakePolicy = "off";
  reconcileRemoteControlKeepAwake({ signedIn: false });
  const config = logtoConfig();
  // Stop delivery first, then disable the optional Codex connection before
  // clearing actor/profile authority. Disable is reusable: a later sign-in
  // may explicitly enable a fresh host without reviving this generation.
  try {
    await stopRelay();
  } catch (err) {
    log.warn(
      `[desktop][d453] failed to stop relay on sign-out: ${String(err)}`,
    );
  }
  try {
    await configureComputerUseForServer(null);
  } catch (err) {
    // Transport is already stopped and the lifecycle removed live local
    // references. Keep signing out; a future relay adoption must retry and
    // prove durable revocation before it can start.
    log.error(`[desktop][d516] failed to revoke Computer use on sign-out: ${String(err)}`);
  }
  if (!config) return;
  try {
    await codexConnection.disable();
  } catch (err) {
    log.warn(
      `[desktop][d453] failed to disable Codex on sign-out: ${String(err)}`,
    );
  }
  clearTokens();
  // P4.7 — clear the relay token alongside Logto access/refresh tokens.
  // The relay token is server-scoped and was minted on behalf of the
  // signed-in user; leaving it on disk after sign-out would let any
  // other OS user on the box (or any process that can read the
  // userData dir) impersonate the previous user against the relay.
  // 4401 re-pair already clears + re-pairs on rejection (see
  // bootRelayIfPossible); this closes the explicit-sign-out gap.
  const serverUrl = resolvedServerUrl();
  if (serverUrl) {
    try {
      clearRelayToken(serverUrl);
      log.info("[desktop][p4.7] Cleared relay token on sign-out");
    } catch (err) {
      log.warn(
        `[desktop][p4.7] failed to clear relay token on sign-out: ${String(err)}`,
      );
    }
  }
  // D418 — drop the active Workstation Profile binding and revoke its
  // ephemeral policy-pack/session overlay grants on explicit sign-out. This
  // is NOT a transient relay reconnect (which resumes the session), so
  // clearing here is correct: the user is leaving, and the compiled authority
  // must not linger in the main process for a signed-out user. Best-effort —
  // a failure to revoke never blocks the rest of the sign-out flow.
  try {
    await activeWorkstationProfileController.deactivate();
  } catch (err) {
    log.warn(
      `[desktop][d418] failed to deactivate active profile on sign-out: ${String(err)}`,
    );
  }
  refreshAuthMenuState(false);
  try {
    await session.defaultSession.clearStorageData({
      origin: new URL(config.endpoint).origin,
      storages: ["cookies"],
    });
  } catch (err) {
    log.warn(
      `[desktop][m061] failed to clear Logto Electron cookies: ${String(err)}`,
    );
  }
  broadcastAuthState("signed-out");
}

/**
 * Rebuild the application menu so the File → Recent Folders submenu
 * reflects the current list. Called from commitCurrentFolderPath after
 * the list changes and once during boot after the window is ready.
 */
function rebuildApplicationMenu(): void {
  Menu.setApplicationMenu(
    createApplicationMenu(mainWindow, activeRenderer(), {
      recentCurrentFolders: listRecentCurrentFolders(),
      onCommitCurrentFolder: (p) => {
        try {
          commitCurrentFolderPath(p);
        } catch {
          showWorkingFolderCommitError();
        }
      },
      auth: buildMenuAuthOptions(),
      onSwitchServer: () => openServerPicker(),
      // This stays a direct main-process callback: the renderer may request
      // the already-owned flow, but it never gets update/feed authority.
      onOpenUpdateFlow: () => {
        void updateController.openUpdateFlow();
      },
      onOpenFolder: async () => {
        // Same pick + validate + commit flow as the tray menu.
        if (mainWindow && !mainWindow.isVisible()) {
          mainWindow.show();
          mainWindow.focus();
        }
        const picked = await pickFolder();
        if (!picked) return;
        const validated = validateWorkspacePath(
          { path: picked },
          WORKSPACE_VALIDATOR_DEPS,
        );
        if (!validated.ok) {
          if (mainWindow) {
            void dialog.showMessageBox(mainWindow, {
              type: "warning",
              message: "Can't use that folder",
              detail: validated.error,
              buttons: ["OK"],
            });
          }
          return;
        }
        const sanity = checkCurrentFolderSanity(
          validated.resolved,
          os.homedir(),
        );
        if (!sanity.ok) {
          if (mainWindow) {
            void dialog.showMessageBox(mainWindow, {
              type: "warning",
              message: "Can't use that folder",
              detail: sanity.reason,
              buttons: ["OK"],
            });
          }
          return;
        }
        try {
          commitCurrentFolderPath(validated.resolved);
        } catch {
          showWorkingFolderCommitError();
        }
      },
    }),
  );
  // This function is the sole writer: direct rebuilds (auth reprobe,
  // sign-in/out, boot) and the session-change coalescer therefore share one
  // authoritative rendered projection marker without recursive scheduling.
  renderedMenuAuthProjectionKey = activeMenuAuthProjectionKey();
}

// ---------------------------------------------------------------------------
// Window state persistence
// ---------------------------------------------------------------------------

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const STATE_FILE = windowStateFilePath();

function loadWindowState(): WindowState {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const state = JSON.parse(raw) as WindowState;
    if (state.x !== undefined && state.y !== undefined) {
      const displays = screen.getAllDisplays();
      const visible = displays.some((d) => {
        const { x, y, width, height } = d.bounds;
        return (
          state.x! >= x &&
          state.x! < x + width &&
          state.y! >= y &&
          state.y! < y + height
        );
      });
      if (!visible) {
        return { width: state.width, height: state.height };
      }
    }
    return state;
  } catch {
    return { ...DEFAULT_WINDOW_SIZE };
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function saveWindowState(win: BaseWindow): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    try {
      fs.writeFileSync(
        STATE_FILE,
        JSON.stringify({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }),
      );
    } catch {
      /* best-effort */
    }
  }, WINDOW_STATE_SAVE_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// Single-instance lock
// ---------------------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    for (const link of parseDeepLinksFromArgv(commandLine)) {
      forwardDeepLinkToRenderer(link);
    }
  });

  registerDeepLinkHandler({
    appName: "Nautilo",
    // The legacy helper's focus hook is BrowserWindow-typed. BaseWindow
    // focusing is performed in the callback so behavior remains intact
    // without a cast or widening an unrelated module.
    getMainWindow: () => null,
    onDeepLink: (link) => {
      forwardDeepLinkToRenderer(link);
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      }
    },
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

/**
 * M161 Phase 2 — sender-resolved session lookup for privileged IPC.
 *
 * Replaces the Phase 1 `assertMainWindowSender` boolean gate with a
 * resolver that returns the `ServerSession` mapped to `event.sender.id`.
 * Unknown senders (no `webContentsId` → scope binding) and non-active
 * privileged senders fail closed — both throw before any privileged work
 * runs. This is the security boundary from issue §"Common pitfalls" #1:
 * the renderer never supplies an auth scope URL; main derives the server
 * identity from the registered sender.
 *
 * Returns the resolved active session so auth handlers can scope token
 * ops (`…For(session.serverUrl)`) and read `session.logtoConfig` without
 * trusting a renderer argument. Callers MUST throw (not silently return)
 * so the renderer's promise rejects loudly and the violation appears in
 * logs — `resolveSessionFromSender` does that for them.
 */
function resolveSessionFromSender(
  e: Electron.IpcMainInvokeEvent,
): ServerSession {
  try {
    return serverSessions.resolveActiveFromSenderOrThrow(e.sender.id);
  } catch (err) {
    log.warn("[ipc-guard] privileged sender rejected", {
      senderId: e.sender.id,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * D103 P4.2 — sender-id gate for module-level handlers.
 *
 * Module-level handlers are registered at app startup (before any
 * BrowserWindow exists) and are intended for the **mainWindow / Workbench
 * renderer only**. The first-run picker, onboarding wizard, and auth
 * window each have their own per-session preloads that do NOT expose
 * these channels — but a future XSS or compromised dependency in any
 * of those windows would gain access to `ipcRenderer` and could attempt
 * to invoke these privileged channels directly. This gate makes that
 * impossible: if the call isn't mapped to the registry's active session,
 * we throw before doing any privileged work (file IO, token access, dialog,
 * system shell).
 *
 * Defence-in-depth, NOT primary security — primary defences are
 * (a) preload narrowness + sandbox + contextIsolation, and (b)
 * `assertPathInAllowedRoot` on every fs:* path arg. Sender-id closes
 * the failure mode where a non-main-window's preload accidentally
 * (or maliciously) re-exposes `ipcRenderer.invoke`.
 *
 * M161 Phase 2 — delegates to `resolveSessionFromSender` so every
 * privileged handler (auth and non-auth) shares one fail-closed
 * sender boundary. Auth handlers use the resolver directly to obtain
 * the session; non-auth handlers keep the void `assert*` call shape.
 */
function assertMainWindowSender(e: Electron.IpcMainInvokeEvent): void {
  resolveSessionFromSender(e);
}

/**
 * D557 — derive the sole durable Ready-to-work binding in main. The renderer
 * supplies neither a Human nor server authority marker, and an active server
 * without its complete D514 marker is intentionally ineligible.
 */
async function resolveReadyToWorkBindingForSession(
  activeSession: Pick<ServerSession, "serverUrl" | "signedIn">,
): Promise<ReadyToWorkBinding> {
  if (!activeSession.signedIn) {
    throw new Error("Ready to work requires a signed-in Nautilo Human");
  }
  const authority = authoritativeConnectionSnapshot();
  if (!authority || !authority.serverFingerprint) {
    throw new Error("Ready to work requires the active Desktop server authority");
  }
  let sessionOrigin: string;
  try {
    sessionOrigin = new URL(activeSession.serverUrl).origin;
  } catch {
    throw new Error("Ready to work requires a valid active server");
  }
  if (authority.scope !== sessionOrigin) {
    throw new Error("Ready to work active server authority does not match this renderer");
  }
  const accessToken = await awaitReadyToWorkValueBounded(
    getValidAccessToken({
      refresh: refreshTokens,
      onObservedRejection: onLogtoRefreshFailed,
    }).catch(() => null),
    5_000,
    null,
  );
  if (!accessToken) {
    throw new Error("Ready to work requires an authenticated Nautilo Human");
  }
  let humanId: string | null = null;
  try {
    const response = await fetch(`${activeSession.serverUrl.replace(/\/$/, "")}/api/auth/whoami`, {
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const body = await response.json() as { sessionUserId?: unknown };
      humanId = typeof body.sessionUserId === "string" ? body.sessionUserId : null;
    }
  } catch {
    humanId = null;
  }
  if (!humanId) {
    throw new Error("Ready to work could not verify the signed-in Nautilo Human");
  }
  return {
    humanId,
    authority: {
      scope: authority.scope,
      revision: authority.revision,
      connectionAttemptId: authority.connectionAttemptId,
      serverFingerprint: authority.serverFingerprint,
    },
  };
}

async function resolveReadyToWorkBinding(
  e: Electron.IpcMainInvokeEvent,
): Promise<ReadyToWorkBinding> {
  return await resolveReadyToWorkBindingForSession(resolveSessionFromSender(e));
}

function desktopMiniAppRecoveryRuntime(): MiniAppDraftRecoveryRuntime {
  miniAppRecoveryRuntime ??= new MiniAppDraftRecoveryRuntime({
    store: new MiniAppDraftRecoveryStore({
      rootDir: miniAppDraftRecoveryDirPath(),
      safeStorage,
    }),
    authorizeBinding: authorizeMiniAppRecoveryBinding,
  });
  return miniAppRecoveryRuntime;
}

function miniAppRecoveryHandleContext(
  e: Electron.IpcMainInvokeEvent,
): MiniAppRecoveryHandleContext {
  const session = resolveSessionFromSender(e);
  const authority = authoritativeConnectionSnapshot();
  let sessionOrigin: string | null = null;
  try {
    sessionOrigin = new URL(session.serverUrl).origin;
  } catch {
    sessionOrigin = null;
  }
  if (
    !session.signedIn ||
    !authority.scope ||
    !authority.serverFingerprint ||
    authority.scope !== sessionOrigin
  ) {
    throw new MiniAppRecoveryError(
      "authority_changed",
      "Draft recovery is no longer authorized.",
    );
  }
  return {
    senderId: e.sender.id,
    authGeneration: miniAppRecoveryAuthGeneration,
    canonicalOrigin: authority.scope,
    serverFingerprint: authority.serverFingerprint,
    signedIn: true,
  };
}

async function resolveMiniAppRecoveryTarget(
  target: MiniAppRecoveryTargetCandidate,
): Promise<MiniAppRecoveryTargetIdentity> {
  if (target.kind === "workspace_artifact") {
    return target;
  }
  const relayId = getPersistedDesktopRelayId();
  if (!relayId || relayId !== target.relayId) {
    throw new MiniAppRecoveryError(
      "authority_changed",
      "Draft recovery is unavailable for this document.",
    );
  }
  const canonicalPath = await resolveMiniAppRecoveryFilePath(
    dynamicDocumentMutationFileAdapter, target.candidatePath,
  );
  return { kind: "local_file", relayId, canonicalPath };
}

async function authorizeMiniAppRecoveryBinding(
  binding: MiniAppRecoveryBinding,
): Promise<boolean> {
  const authority = authoritativeConnectionSnapshot();
  const active = serverSessions.active;
  if (
    !active?.signedIn ||
    authority.scope !== binding.owner.canonicalOrigin ||
    authority.serverFingerprint !== binding.owner.serverFingerprint
  ) return false;
  if (binding.target.kind === "workspace_artifact") return true;
  if (getPersistedDesktopRelayId() !== binding.target.relayId) return false;
  try {
    const stillCanonical = await resolveMiniAppRecoveryFilePath(
      dynamicDocumentMutationFileAdapter, binding.target.canonicalPath,
    );
    return stillCanonical === binding.target.canonicalPath;
  } catch {
    return false;
  }
}

function observeMiniAppRecoverySender(sender: Electron.WebContents): void {
  if (miniAppRecoveryObservedSenders.has(sender.id)) return;
  miniAppRecoveryObservedSenders.add(sender.id);
  sender.once("destroyed", () => {
    miniAppRecoveryObservedSenders.delete(sender.id);
    miniAppRecoveryRuntime?.invalidateSender(sender.id);
  });
}

function throwMiniAppRecoveryIpcError(error: unknown): never {
  if (error instanceof MiniAppRecoveryError) throw new Error(error.message);
  throw new Error("Draft recovery could not be completed.");
}

function readyToWorkStore(): ReadyToWorkStore {
  return new ReadyToWorkStore({ filePath: readyToWorkStateFilePath() });
}

function readyToWorkProtectedReceiptStore(): ReadyToWorkProtectedReceiptStore {
  return new ReadyToWorkProtectedReceiptStore({
    filePath: readyToWorkProtectedReceiptFilePath(),
    safeStorage,
  });
}

let readyToWorkCoordinatorBinding: ReadyToWorkBinding | null = null;
let readyToWorkGeneration = 0;
let readyToWorkCleanupPromise: Promise<void> = Promise.resolve();
const readyToWorkOperationQueue = new ReadyToWorkOperationQueue();

function awaitReadyToWorkBounded(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
}

function awaitReadyToWorkValueBounded<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
): Promise<T> {
  return readyToWorkBoundedValue(promise, timeoutMs, fallback);
}

async function readyToWorkStatusForSender(
  e: Electron.IpcMainInvokeEvent,
  generation: number,
) {
  // The sender gate remains observable. Missing identity/marker safely reads
  // as Standard rather than leaking another Human's desired posture.
  resolveSessionFromSender(e);
  try {
    const binding = await resolveReadyToWorkBinding(e);
    const desired = readyToWorkStore().loadFor(binding);
    if (desired) return await refreshReadyToWorkStatus(desired, generation);
    return attachReadyCodingHarnessPreview(readyToWorkAggregateStatus(desired));
  } catch {
    return readyToWorkAggregateStatus(null);
  }
}

// D516 — permission status is useful only while its Human-facing setup UI is
// mounted. Keep a sender set rather than a global background poller, and send
// only a newly observed semantic state (never a stream of identical snapshots).
const systemPermissionStatusSubscribers = new Map<number, Electron.WebContents>();
let systemPermissionStatusWatch: ReturnType<typeof setInterval> | null = null;
let lastSystemPermissionStatusSignature: string | null = null;
let lastComputerUsePermissionSignature: string | null = null;
// This is tied to lifecycle work, not to whether the Connections card happens
// to be mounted. A Cua child can cache its host TCC state while the card is
// closed, so its last checked host signature must remain independently known.
let lastCuaHostPermissionCheck: { readonly signature: string; readonly generation: string | null } | null = null;
let requestedCuaHostPermissionSignature: string | null = null;
let cuaHostPermissionReconciliation: Promise<void> | null = null;
let bundledComputerUseHostReady = false;
let activeComputerUseHostState: ComputerUseHostState | null = null;
let lastComputerUseHostStateSignature: string | null = null;

/** Content-safe release provenance: no native path, task data, or provider payload. */
function recordComputerUseHostState(state: ComputerUseHostState): ComputerUseHostState {
  activeComputerUseHostState = state;
  bundledComputerUseHostReady = state.state === "ready";
  const signature = state.state === "ready"
    ? [state.source, state.release.releaseId, state.release.version, state.release.archive.sha256, state.generation, state.remoteUpdateFailure ?? "fresh"].join(":")
    : `unavailable:${state.code}`;
  if (signature === lastComputerUseHostStateSignature) return state;
  lastComputerUseHostStateSignature = signature;
  if (state.state === "ready") {
    const entrypoint = state.release.members.find((member) => member.path === state.release.entrypoint);
    log.info(
      `[desktop][computer-use-host] source=${state.source} release=${state.release.releaseId} version=${state.release.version} archiveSha256=${state.release.archive.sha256} entrypointSha256=${entrypoint?.sha256 ?? "missing"} generation=${state.generation} remoteUpdate=${state.remoteUpdateFailure === undefined ? "accepted" : `retained:${state.remoteUpdateFailure}`}`,
    );
  } else {
    log.warn(`[desktop][computer-use-host] unavailable code=${state.code}`);
  }
  return state;
}

function systemPermissionStatusSignature(
  snapshot: SystemPermissionsSnapshot,
): string {
  return snapshot.permissions
    .map((permission) =>
      [
        permission.id,
        permission.state,
        permission.action ?? "",
        permission.restart,
      ].join(":"),
    )
    .join("|");
}

/** Only the two responsible-host grants that bound the embedded Cua child. */
function computerUsePermissionSignature(snapshot: SystemPermissionsSnapshot): string {
  const stateFor = (id: "accessibility" | "screen-recording") =>
    snapshot.permissions.find((permission) => permission.id === id)?.state ?? "unknown";
  return `accessibility:${stateFor("accessibility")}|screen-recording:${stateFor("screen-recording")}`;
}

function currentComputerUsePermissionSignature(): string {
  return computerUsePermissionSignature(getSystemPermissionsSnapshot());
}

function recordCuaHostPermissionCheck(signature: string): void {
  lastCuaHostPermissionCheck = {
    signature,
    generation: activeComputerUseHostState?.state === "ready"
      ? `${activeComputerUseHostState.source}:${activeComputerUseHostState.release.version}:${activeComputerUseHostState.generation}`
      : null,
  };
}

/**
 * Serializes the latest observed host state. A second OS change during a
 * child restart is not allowed to publish the first state over the newer one:
 * it immediately becomes the next exact child retirement/check cycle.
 */
function reconcileCuaHostPermissionSignature(signature: string): Promise<void> {
  requestedCuaHostPermissionSignature = signature;
  if (cuaHostPermissionReconciliation !== null) return cuaHostPermissionReconciliation;
  const pending = (async () => {
    for (;;) {
      const target: string = requestedCuaHostPermissionSignature ?? currentComputerUsePermissionSignature();
      // Cua is Host-owned: a TCC transition retires its Host session and
      // forces the next dispatch to create a fresh Host/Cua generation.
      await computerUseHostBroker.close();
      recordComputerUseHostState(await managedComputerUseHostRuntime.bootstrap());
      const observed = currentComputerUsePermissionSignature();
      if (requestedCuaHostPermissionSignature !== target || observed !== target) {
        requestedCuaHostPermissionSignature = observed;
        continue;
      }
      recordCuaHostPermissionCheck(observed);
      return;
    }
  })().finally(() => {
    if (cuaHostPermissionReconciliation === pending) cuaHostPermissionReconciliation = null;
  });
  cuaHostPermissionReconciliation = pending;
  return pending;
}

/**
 * Cua itself documents that a responsible-host permission change requires
 * destroying clients, restarting the daemon, reconnecting, and checking
 * again. This is intentionally separate from TCC recovery: the OS owns the
 * grant and this code only retires the stale child that cached its old state.
 */
function reconcileCuaForHostPermissionTransition(): void {
  const expectedSignature = currentComputerUsePermissionSignature();
  void (async () => {
    try {
      await reconcileCuaHostPermissionSignature(expectedSignature);
      if (currentComputerUsePermissionSignature() !== expectedSignature
        || lastCuaHostPermissionCheck?.signature !== expectedSignature) return;
      // Re-observe the exact local Cua route only after the fresh Cua check
      // settles. This can mint a new route, but never changes the durable
      // Human receipt merely because an OS grant was lost or restored.
      const local = await computerUseSetup?.localStatus();
      if (local !== undefined) await refreshComputerUseProviderProjection();
      if (currentComputerUsePermissionSignature() !== expectedSignature
        || lastCuaHostPermissionCheck?.signature !== expectedSignature) return;
    } catch {
      // Lifecycle states and route invalidation are fail-closed. The regular
      // recovery UI receives the resulting status wake below.
    } finally {
      if (currentComputerUsePermissionSignature() === expectedSignature
        && lastCuaHostPermissionCheck?.signature === expectedSignature) {
        await refreshComputerUseRelay("Cua host permission transition reconciled");
        notifyComputerUseStatusChanged();
      }
    }
  })();
}

/** Runs on focus even without a mounted permission card; it never polls. */
function reconcileCuaForObservedHostPermissionChange(): void {
  const expected = lastCuaHostPermissionCheck?.signature
    ?? requestedCuaHostPermissionSignature;
  if (expected === null || expected === currentComputerUsePermissionSignature()) return;
  reconcileCuaForHostPermissionTransition();
}

/**
 * Every startup/manual Cua readiness check binds its result to the exact host
 * signature it observed. If Settings changes during the check—or since the
 * last checked child—we take the documented child-restart path instead.
 */
async function checkCuaAgainstCurrentHostPermissions(options: { readonly startup?: boolean } = {}): Promise<void> {
  const before = currentComputerUsePermissionSignature();
  if (lastCuaHostPermissionCheck !== null && lastCuaHostPermissionCheck.signature !== before) {
    await reconcileCuaHostPermissionSignature(before);
    return;
  }
  void options;
  recordComputerUseHostState(await managedComputerUseHostRuntime.bootstrap());
  const after = currentComputerUsePermissionSignature();
  if (after !== before) {
    await reconcileCuaHostPermissionSignature(after);
    return;
  }
  recordCuaHostPermissionCheck(after);
}

function stopSystemPermissionStatusWatchIfUnused(): void {
  if (systemPermissionStatusSubscribers.size > 0 || !systemPermissionStatusWatch)
    return;
  clearInterval(systemPermissionStatusWatch);
  systemPermissionStatusWatch = null;
  lastSystemPermissionStatusSignature = null;
  lastComputerUsePermissionSignature = null;
}

function emitSystemPermissionStatusIfChanged(): void {
  if (systemPermissionStatusSubscribers.size === 0) return;
  const snapshot = getSystemPermissionsSnapshot();
  const signature = systemPermissionStatusSignature(snapshot);
  if (signature === lastSystemPermissionStatusSignature) return;
  const computerUseSignature = computerUsePermissionSignature(snapshot);
  const requiredComputerUsePermissionChanged = lastComputerUsePermissionSignature !== null
    && computerUseSignature !== lastComputerUsePermissionSignature;
  lastSystemPermissionStatusSignature = signature;
  lastComputerUsePermissionSignature = computerUseSignature;
  for (const [id, contents] of systemPermissionStatusSubscribers) {
    if (contents.isDestroyed()) {
      systemPermissionStatusSubscribers.delete(id);
      continue;
    }
    contents.send("systemPermissions:statusChanged", snapshot);
  }
  // Send the row-level truth before beginning asynchronous Cua retirement so
  // the user sees the OS change immediately. Subscription establishes the
  // baseline and must never itself restart an otherwise healthy daemon.
  if (requiredComputerUsePermissionChanged) reconcileCuaForHostPermissionTransition();
  stopSystemPermissionStatusWatchIfUnused();
}

function startSystemPermissionStatusWatch(baseline: SystemPermissionsSnapshot): void {
  if (systemPermissionStatusSubscribers.size === 0 || systemPermissionStatusWatch)
    return;
  // The subscription receives this exact baseline before the watcher begins.
  // That closes the status-invoke → subscribe gap without treating mounting as
  // a permission transition or a reason to restart an otherwise healthy Cua.
  lastSystemPermissionStatusSignature = systemPermissionStatusSignature(baseline);
  lastComputerUsePermissionSignature = computerUsePermissionSignature(baseline);
  systemPermissionStatusWatch = setInterval(
    emitSystemPermissionStatusIfChanged,
    750,
  );
}

function acceptSystemPermissionStatusSubscriber(
  e: Electron.IpcMainEvent,
): boolean {
  try {
    assertMainWindowSender(e as Electron.IpcMainInvokeEvent);
    return !e.sender.isDestroyed();
  } catch {
    log.warn("[ipc-guard] systemPermissions subscription rejected", {
      senderId: e.sender.id,
    });
    return false;
  }
}

app.on("browser-window-focus", () => {
  emitSystemPermissionStatusIfChanged();
  reconcileCuaForObservedHostPermissionChange();
});

function ipcRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function resolveActivePersonalAgent(
  accessToken: string,
  expectedUserId: string,
): Promise<string | null> {
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) return null;
  try {
    const who = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/whoami`, {
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!who.ok) {
      log.warn(`[desktop][structured-ssh] personal Genie resolution failed at whoami (${who.status})`);
      return null;
    }
    const identity = ipcRecord(await who.json());
    if (identity?.["sessionUserId"] !== expectedUserId) {
      log.warn(`[desktop][structured-ssh] personal Genie resolution rejected relay/session identity mismatch (session=${typeof identity?.["sessionUserId"] === "string" ? "present" : "absent"})`);
      return null;
    }
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/profile`, {
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      log.warn(`[desktop][structured-ssh] personal Genie resolution failed at profile (${response.status})`);
      return null;
    }
    const body = ipcRecord(await response.json());
    const owned = Array.isArray(body?.["ownedAgents"]) ? body["ownedAgents"] : [];
    const first = ipcRecord(owned[0]);
    const agentId = first?.["agentId"];
    if (typeof agentId !== "string") {
      log.warn(`[desktop][structured-ssh] signed-in Human has no personal Genie in profile projection (owned=${owned.length})`);
    }
    return typeof agentId === "string" && agentId.length > 0 && agentId.length <= 256 ? agentId : null;
  } catch {
    return null;
  }
}

async function fetchCurrentComputerUseOwnedAgents(
  accessToken: string,
  expectedUserId: string,
): Promise<readonly ComputerUseOwnedAgent[] | null> {
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) return null;
  try {
    const who = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/whoami`, {
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!who.ok) {
      log.warn(`[desktop][computer-use] owned Genie resolution failed at whoami (${who.status})`);
      return null;
    }
    const identity = ipcRecord(await who.json());
    if (identity?.["sessionUserId"] !== expectedUserId) {
      log.warn(`[desktop][computer-use] owned Genie resolution rejected relay/session identity mismatch (session=${typeof identity?.["sessionUserId"] === "string" ? "present" : "absent"})`);
      return null;
    }
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/profile`, {
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      log.warn(`[desktop][computer-use] owned Genie resolution failed at profile (${response.status})`);
      return null;
    }
    const agents = parseComputerUseOwnedAgents(await response.json());
    if (agents === null) {
      log.warn("[desktop][computer-use] signed-in Human returned an invalid owned Genie projection");
      return null;
    }
    return agents;
  } catch {
    return null;
  }
}

async function resolveSelectedComputerUseOwnedAgent(
  accessToken: string,
  expectedUserId: string,
  requestedAgentId: string,
): Promise<string | null> {
  const agents = await fetchCurrentComputerUseOwnedAgents(accessToken, expectedUserId);
  return agents === null
    ? null
    : selectComputerUseOwnedAgent(agents, requestedAgentId)?.agentId ?? null;
}

// D500 management is Human-only. Targets, identities, OpenSSH configuration,
// and host trust are resolved per exact Genie request, never constructed here.
const structuredSshSetup = createStructuredSshSetupController({
  getRuntime: getActiveStructuredSshRuntime,
  verifyPin: async (pin) => {
    const serverUrl = resolvedServerUrl();
    if (!serverUrl) throw new Error("Connect this signed-in Nautilo Desktop before enabling SSH.");
    const accessToken = await getValidAccessToken({
      refresh: refreshTokens,
      onObservedRejection: onLogtoRefreshFailed,
    });
    if (!accessToken) throw new Error("Sign in again before enabling SSH access.");
    const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/verify-pin`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ pin }),
    });
    if (response.ok) return accessToken;
    let body: { error?: unknown; retryAfterMs?: unknown } | null = null;
    try { body = await response.json() as { error?: unknown; retryAfterMs?: unknown }; } catch { /* noop */ }
    if (response.status === 401) throw new Error("That PIN is incorrect.");
    if (response.status === 429) throw new Error(typeof body?.error === "string" ? body.error : "Too many PIN attempts. Try again later.");
    throw new Error("Nautilo could not verify your PIN. SSH access was not changed.");
  },
  resolveOwnedAgent: resolveActivePersonalAgent,
  refreshRelay: async () => { await refreshDesktopRelayCapabilities("structured SSH setup changed"); },
});

// D516 — this deliberately remains a small local authority, not a generic
// capability registry.  Future computer execution registers cancellers here;
// revocation advances the exact epoch/generation fence before the UI reports
// Off, so late output cannot become authority after a local revoke.
const computerUseOwnedWork = new Map<string, {
  readonly installationEpoch: string;
  readonly grantGeneration: number;
  readonly provider?: "cua";
  readonly abort: () => void;
}>();
let computerUseLocalStore: ComputerUseLocalStore | null = null;
let computerUseSetup: ReturnType<typeof createComputerUseSetupController> | null = null;
/** One Electron-main owner for snapshot and dispatch route truth. */
let computerUseProviderRouteAttestation: ComputerUseHostRouteAttestation | null = null;

function sameComputerUseRuntime(
  left: ReturnType<typeof getActiveComputerUseRuntime>,
  right: {
    readonly instanceId: string;
    readonly humanUserId: string;
    readonly serverBindingId: string;
    readonly relayId: string;
    readonly pairingGeneration: string;
    readonly desktopSessionId: string;
  },
): boolean {
  return sameComputerUseRuntimeIdentity(left, right);
}

function receiptMatchesCurrentComputerUseRuntime(
  receipt: DesktopAutomationReceipt,
  runtime: NonNullable<ReturnType<typeof getActiveComputerUseRuntime>>,
): boolean {
  return receipt.instanceId === runtime.instanceId
    && receipt.humanUserId === runtime.humanUserId
    && receipt.serverBindingId === runtime.serverBindingId
    && receipt.relayId === runtime.relayId
    && receipt.pairingGeneration === runtime.pairingGeneration;
}

/** Final local authority check for the generic Host lane; no action/name gate. */
function receiptMatchesHostInvocation(
  receipt: DesktopAutomationReceipt,
  binding: import("@nautilo/relay").DesktopAutomationInvocationBinding,
  runtime: NonNullable<ReturnType<typeof getActiveComputerUseRuntime>>,
): boolean {
  return receiptMatchesCurrentComputerUseRuntime(receipt, runtime)
    && receipt.humanUserId === binding.originHumanId
    && receipt.agentId === binding.originAgentId
    && receipt.relayId === binding.relayId
    && receipt.pairingGeneration === binding.pairingGeneration
    && receipt.installationEpoch === binding.installationEpoch
    && receipt.grantGeneration === binding.grantGeneration
    && runtime.desktopSessionId === binding.desktopSessionId;
}

async function refreshComputerUseRelay(reason: string): Promise<void> {
  // The relay owns coalescing and its one trailing update for route drift.
  // A second main-process latch would swallow that required follow-up.
  await refreshDesktopRelayCapabilities(reason).catch(() => false);
}

function clearCuaRouteState(options: { readonly clearRouteAttestation?: boolean } = {}): void {
  // An authority transition invalidates all opaque Host references. Ordinary
  // request cancellation never calls this and retains the Host session.
  void computerUseHostBroker.close();
  if (options.clearRouteAttestation === true) computerUseProviderRouteAttestation?.clear();
}

/** One checked Cua descriptor feeds snapshot publication and final dispatch. */
async function currentCuaProviderAvailability() {
  const available = recordComputerUseHostState(
    await managedComputerUseHostRuntime.bootstrap(),
  ).state === "ready";
  return {
    cua: available,
  };
}

function adoptComputerUseStore(
  _serverBindingId: string | null,
  store: ComputerUseLocalStore | null,
): void {
  if (store === null) {
    clearCuaRouteState({ clearRouteAttestation: true });
    computerUseProviderRouteAttestation?.clear();
    computerUseProviderRouteAttestation = null;
    computerUseLocalStore = null;
    computerUseSetup = null;
    return;
  }
  computerUseLocalStore = store;
  computerUseProviderRouteAttestation = new ComputerUseHostRouteAttestation(
    // Checked-port lookup only: route availability cannot start or refresh Cua.
    () => currentCuaProviderAvailability(),
    () => {
      // Route drift is fail-closed immediately at dispatch. Re-advertise it as
      // well so later server admission cannot continue issuing stale bindings.
      void refreshComputerUseRelay("computer use provider readiness changed");
    },
  );
  computerUseSetup = createComputerUseSetupController({
    store,
    getRuntime: getActiveComputerUseRuntime,
    verifyOwnPin: async (pin, expectedHumanUserId) => {
      const serverUrl = resolvedServerUrl();
      if (!serverUrl) throw new Error("Connect this signed-in Nautilo Desktop before enabling Computer use.");
      const accessToken = await awaitReadyToWorkValueBounded(
        getValidAccessToken({
          refresh: refreshTokens,
          onObservedRejection: onLogtoRefreshFailed,
        }).catch(() => null),
        5_000,
        null,
      );
      if (!accessToken) throw new Error("Sign in again before enabling Computer use.");
      const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/verify-pin`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ pin }),
      });
      if (!response.ok) {
        if (response.status === 401) throw new Error("That PIN is incorrect.");
        if (response.status === 429) throw new Error("Too many PIN attempts. Try again later.");
        throw new Error("Nautilo could not verify your PIN. Computer use was not changed.");
      }
      try {
        const who = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/whoami`, {
          signal: AbortSignal.timeout(5_000),
          headers: { authorization: `Bearer ${accessToken}` },
        });
        const identity = who.ok ? ipcRecord(await who.json()) : null;
        if (identity?.["sessionUserId"] !== expectedHumanUserId) return null;
      } catch {
        return null;
      }
      return { accessToken, humanUserId: expectedHumanUserId };
    },
    resolveOwnedAgent: resolveSelectedComputerUseOwnedAgent,
    attestActivation: async (expectedRuntime) => {
      const observed = getActiveComputerUseRuntime();
      if (!sameComputerUseRuntime(observed, expectedRuntime)) return null;
      const serverUrl = resolvedServerUrl();
      if (!serverUrl) return null;
      const accessToken = await awaitReadyToWorkValueBounded(
        getValidAccessToken({
          refresh: refreshTokens,
          onObservedRejection: onLogtoRefreshFailed,
        }).catch(() => null),
        5_000,
        null,
      );
      if (!accessToken) return null;
      try {
        const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/whoami`, {
          signal: AbortSignal.timeout(5_000),
          headers: { authorization: `Bearer ${accessToken}` },
        });
        const identity = response.ok ? ipcRecord(await response.json()) : null;
        const capabilities = Array.isArray(identity?.["capabilities"])
          ? identity["capabilities"]
          : [];
        const controlDesktop = identity?.["sessionUserId"] === expectedRuntime.humanUserId
          && capabilities.includes("control_desktop");
        const current = getActiveComputerUseRuntime();
        if (!sameComputerUseRuntime(current, expectedRuntime)) return null;
        if (current === null) return null;
        return {
          ...expectedRuntime,
          controlDesktop,
        };
      } catch {
        return null;
      }
    },
    cancelAndFenceOwnedWork: (fence) => {
      clearCuaRouteState({ clearRouteAttestation: true });
      computerUseProviderRouteAttestation?.clear();
      cancelComputerUseOwnedWork(computerUseOwnedWork, fence);
    },
  });
}

const computerUseServerBindingLifecycle = new ComputerUseServerBindingLifecycle<ComputerUseLocalStore>({
  abortOwnedWork: () => {
    clearCuaRouteState({ clearRouteAttestation: true });
    computerUseProviderRouteAttestation?.clear();
    cancelComputerUseOwnedWork(computerUseOwnedWork, {
      kind: "installation_epoch_reset",
      installationEpoch: "server-binding-reconfiguration",
      grantGeneration: 0,
    });
  },
  createStore: (serverBindingId) => new ComputerUseLocalStore({
    instanceId: desktopInstance.instanceId,
    serverBindingId,
    filePath: computerUseStateFilePath(serverBindingId),
  }),
  adopt: adoptComputerUseStore,
  failClosed: async () => {
    // The prior durable receipt may still exist. Keep every dispatch/snapshot
    // reference removed and tear down transport so it cannot be advertised.
    try { await stopRelay(); } catch { /* the lifecycle still refuses adoption */ }
  },
});

async function configureComputerUseForServer(serverUrl: string | null): Promise<void> {
  const serverBindingId = serverUrl === null ? null : deriveComputerUseServerBindingId(serverUrl);
  if (serverUrl !== null && serverBindingId === null) {
    throw new Error("Computer use cannot bind to this server URL; relay startup was refused.");
  }
  await computerUseServerBindingLifecycle.configure(serverBindingId);
}

type ComputerUseProviderReadiness = Readonly<{
  readonly cua:
    | Readonly<{ readonly ready: true; readonly reason: null; readonly lifecycle: "healthy" }>
    | Readonly<{
      readonly ready: false;
      readonly reason: "not_installed" | "not_checked" | "checking" | "unhealthy";
      readonly lifecycle: "not_installed" | "installed" | "starting" | "unhealthy";
    }>;
}>;

/** Content-free status projection from a checked port, never a health probe. */
function cuaProviderReadiness(): ComputerUseProviderReadiness["cua"] {
  if (bundledComputerUseHostReady) {
    return { ready: true, reason: null, lifecycle: "healthy" };
  }
  return { ready: false, reason: "not_checked", lifecycle: "installed" };
}

type ComputerUseProviderProjection = Readonly<{
  readonly providers: ComputerUseProviderReadiness;
  /** Cua route is present only when the checked local driver is executable. */
  readonly effectiveProvider: Readonly<{ readonly provider: "cua" }> | null;
}>;

/** Builds renderer state from the last observed Cua readiness; this does not probe. */
function computerUseProviderProjection(): ComputerUseProviderProjection {
  const observation = computerUseProviderRouteAttestation?.lastObservation() ?? null;
  const selection = observation?.selection ?? null;
  return {
    providers: {
      cua: cuaProviderReadiness(),
    },
    effectiveProvider: selection === null ? null : { provider: selection.provider },
  };
}

async function computerUseStatusFromLocal<T extends {
  readonly state: "unavailable" | "not-enabled" | "enabled";
  readonly reason: string | null;
  readonly agentId: string | null;
  readonly grantGeneration: number | null;
}>(status: T) {
  return { ...(await computerUseStatusWithRevocability(status)), ...computerUseProviderProjection() };
}

/** Explicitly refreshes local driver readiness, never waiting for relay ACK. */
async function refreshComputerUseProviderProjection(): Promise<ComputerUseProviderProjection> {
  await computerUseProviderRouteAttestation?.resolve();
  return computerUseProviderProjection();
}

/** One startup readiness attempt; manual Check remains the explicit recovery. */
async function startComputerUseReadiness(): Promise<void> {
  try {
    await checkCuaAgainstCurrentHostPermissions({ startup: true });
    const setup = computerUseSetup;
    if (setup !== null) {
      await setup.localStatus();
      await refreshComputerUseProviderProjection();
    }
  } catch {
    // Lifecycle/status projections remain fail-closed; startup is never an
    // unhandled rejection and manual Check remains available for recovery.
  } finally {
    void refreshComputerUseRelay("automatic Cua startup readiness completed");
    notifyComputerUseStatusChanged();
  }
}

async function computerUseStatus(reason: string) {
  const setup = computerUseSetup;
  if (setup === null) {
    const status = {
      state: "unavailable" as const,
      reason: "Connect this signed-in Nautilo Desktop to manage Computer use on this Mac.",
      agentId: null,
      grantGeneration: null,
      canDisable: false,
    };
    return { ...status, ...computerUseProviderProjection() };
  }
  // Recovery must render from local authority even when a relay update is
  // wedged. Re-advertisement is best effort and never gates PIN-free Off.
  const status = await setup.localStatus();
  void refreshComputerUseRelay(reason);
  return await computerUseStatusFromLocal(status);
}

async function computerUseStatusWithRevocability<T extends {
  readonly state: "unavailable" | "not-enabled" | "enabled";
  readonly reason: string | null;
  readonly agentId: string | null;
  readonly grantGeneration: number | null;
}>(status: T): Promise<T & { readonly canDisable: boolean }> {
  const stored = computerUseLocalStore;
  if (stored === null) return { ...status, canDisable: false };
  const current = await stored.get();
  // Corrupt/unreadable/foreign bytes may conceal authority.  Revocation is
  // therefore reachable and lets the store's explicit recovery path reset
  // the installation epoch.  Only a valid, empty store proves there is
  // nothing local to disable.
  return {
    ...status,
    canDisable: !current.ok || current.data.receipt !== null,
  };
}

async function reconcileComputerUseTopology(
  refreshRelayCapabilities: (reason?: string) => Promise<boolean>,
): Promise<void> {
  // The controller reloads/revokes a stale receipt against the newly
  // acknowledged pairing before this refresh can advertise it.  A failure is
  // fail-closed: snapshot provider below will omit the receipt. Its failure
  // must not skip the unconditional relay refresh for this new topology.
  try {
    await computerUseSetup?.status();
  } catch {
    // The local snapshot remains fail-closed; the relay still needs the
    // current topology refresh below.
  }
  await refreshRelayCapabilities("computer use topology reconciliation");
  // A reconnect can be the first successful topology after the initial
  // start attempt was swallowed. Wake the mounted card only after this
  // exact topology has reconciled, so it refetches sender-gated status and
  // owned Genies without a remount or manual Check.
  notifyComputerUseStatusChanged();
}

// D418 — local-only human grant administration. This store is deliberately
// distinct from current-folder state and from fs:* browsing authority.
// D418 prerequisite — one main-process authority wraps the durable store with
// an in-memory overlay for `once` / `session` / `policy_pack` grants. The IPC
// handlers, the desktop relay authority resolver, and the advisory snapshot
// builder all read this same instance (passed into `startRelay`), so overlay
// grants are visible to enforcement and discovery. The variable name is kept
// so the grant IPC handlers continue to call `.create` / `.list` / `.revoke`
// on a store-shaped surface while the overlay is merged transparently.
const desktopFilesystemGrantDurableStore = new DesktopFilesystemGrantStore({
  instanceId: desktopInstance.instanceId,
  filePath: desktopFilesystemGrantsFilePath(),
  legacyFilePath: legacyDesktopFilesystemGrantsFilePath(),
});
const desktopFilesystemGrantStore = new DesktopFilesystemGrantAuthority({
  instanceId: desktopInstance.instanceId,
  store: desktopFilesystemGrantDurableStore,
});

// D418 — the single main-process active-profile state machine. Owns the
// instance-scoped WorkstationProfileStore and shares the authority above, so
// compiled policy-pack session grants land in the SAME overlay the relay
// resolver, advisory snapshot builder, and grant IPC handlers read. The relay
// receives this same controller via `startRelay` so it advertises the
// controller's redacted profile snapshot without constructing a duplicate
// profile store. Activation/deactivation is internal only today; future
// settings/discovery wiring invokes the controller. A successful activate or
// deactivate re-advertises relay capabilities atomically via
// `refreshDesktopRelayCapabilities` (no stop/start reconnect).
const activeWorkstationProfileController =
  new ActiveWorkstationProfileController({
    instanceId: desktopInstance.instanceId,
    authority: desktopFilesystemGrantStore,
    filePath: workstationProfilesFilePath(),
    onActiveProfileChanged: (reason) => {
      // D418 — skip the fire-and-forget re-advertise for the activate reason:
      // the `selectActiveProfile` handler (sole activate() caller) performs the
      // authoritative awaited completion refresh, and a second refresh here
      // would race the publisher and issue a redundant capability revision.
      // Deactivation still re-advertises.
      if (reason === "workstation profile activate") return;
      reAdvertiseDesktopFilesystemGrantSnapshot(reason);
    },
  });

ipcMain.handle("githubCli:status", async (e) => {
  assertMainWindowSender(e);
  return await githubCliConnection.status();
});

ipcMain.handle("githubCli:connect", async (e) => {
  assertMainWindowSender(e);
  return await githubCliConnection.connect();
});

ipcMain.handle("githubCli:openDevicePage", async (e) => {
  assertMainWindowSender(e);
  await githubCliConnection.openDevicePage();
});

ipcMain.handle("githubCli:cancel", (e) => {
  assertMainWindowSender(e);
  githubCliConnection.cancel();
});

ipcMain.handle("structuredSsh:status", async (e) => {
  resolveSessionFromSender(e);
  return await structuredSshSetup.status();
});

ipcMain.handle("structuredSsh:check", async (e) => {
  resolveSessionFromSender(e);
  return await structuredSshSetup.check();
});

ipcMain.handle("structuredSsh:enable", async (e, raw: unknown) => {
  resolveSessionFromSender(e);
  const request = ipcRecord(raw);
  if (!request || Object.keys(request).length !== 1
    || typeof request["pin"] !== "string"
    || !/^\d{6,8}$/.test(request["pin"])) {
    throw new Error("Enabling SSH requires your 6–8 digit PIN.");
  }
  return await structuredSshSetup.enable(request["pin"]);
});

ipcMain.handle("structuredSsh:disable", async (e) => {
  resolveSessionFromSender(e);
  return await structuredSshSetup.disable();
});

// D516 — renderer supplies only the transient own-Human PIN.  Main owns the
// local store, server binding, authenticated relay topology, receipt, and
// provider route. These routes are intentionally unrelated to generic tool
// approvals or Auto-Approve.
ipcMain.handle("computerUse:status", async (e) => {
  resolveSessionFromSender(e);
  return await computerUseStatus("computer use status reconciliation");
});

ipcMain.handle("computerUse:check", async (e) => {
  resolveSessionFromSender(e);
  // New explicit Check authority never inherits a prior Cua route. Clear the
  // private anchor before asynchronous health work begins.
  clearCuaRouteState({ clearRouteAttestation: true });
  // Manual recovery shares the automatic startup checked-generation path.
  // Local authority re-attestation may run concurrently, but this fresh check must settle before
  // any provider selection, no-route disable, or capability re-advertisement.
  const cuaCheck = checkCuaAgainstCurrentHostPermissions();
  const setup = computerUseSetup;
  if (setup === null) {
    await cuaCheck;
    return await computerUseStatus("computer use check while unavailable");
  }
  const before = await setup.localStatus();
  let checked = await setup.check();
  await cuaCheck;
  // Selection happens only after the explicit Check settles, so a successful
  // Cua Check can advertise focus/click and a failed one revokes Cua immediately.
  const projection = await refreshComputerUseProviderProjection();
  // Defense in depth for a topology change after the local observation: an
  // enabled receipt may never survive a completed Check without a route.
  if (checked.state === "enabled" && projection.effectiveProvider === null) {
    checked = await setup.disable();
  }
  // A full check can revoke before or during the live attestation. Always
  // re-advertise best effort; the local fence has already won if it revoked.
  void refreshComputerUseRelay(before.state === "enabled" && checked.state !== "enabled"
    ? "computer use check revoked authority"
    : "computer use check completed");
  await cuaCheck;
  return await computerUseStatusFromLocal(checked);
});

ipcMain.handle("computerUse:enable", async (e, raw: unknown) => {
  resolveSessionFromSender(e);
  const request = ipcRecord(raw);
  if (!request || Object.keys(request).length !== 2
    || typeof request["pin"] !== "string"
    || !/^\d{6,8}$/.test(request["pin"])
    || !isComputerUseOpaqueId(request["agentId"])) {
    throw new Error("Choose one of your current Genies and enter your 6–8 digit PIN to enable Computer use.");
  }
  const setup = computerUseSetup;
  if (setup === null) {
    throw new Error("Connect this signed-in Nautilo Desktop before enabling Computer use.");
  }
  // Never begin the PIN ceremony when there is no executable local Cua
  // route. This probes only the local driver; no relay acknowledgement gates
  // the Human's setup or later local revocation.
  const local = computerUseLocalStore === null ? null : await computerUseLocalStore.get();
  if (local === null || !local.ok) {
    throw new Error("Nautilo could not read local Computer use state. Computer use was not enabled.");
  }
  if ((await refreshComputerUseProviderProjection()).effectiveProvider === null) {
    throw new Error("Cua is not ready. Restore its local permission or health before turning Computer use on.");
  }
  const enabled = await setup.enable(request["pin"], request["agentId"]);
  // The route may disappear while PIN/ownership/minting runs. Re-read a fresh
  // local observation; never return the pre-PIN route or wait for server ACK.
  if ((await refreshComputerUseProviderProjection()).effectiveProvider === null) {
    // This is local revocation, not a second PIN ceremony. It fences any
    // freshly minted work before the revoked snapshot is re-advertised.
    const revoked = await setup.disable();
    void refreshComputerUseRelay("computer use enabled route lost");
    return await computerUseStatusFromLocal(revoked);
  }
  void refreshComputerUseRelay("computer use enabled");
  return await computerUseStatusFromLocal(enabled);
});

ipcMain.handle("computerUse:ownedAgents", async (e) => {
  resolveSessionFromSender(e);
  const runtime = getActiveComputerUseRuntime();
  if (runtime === null) {
    throw new Error("Connect this signed-in Nautilo Desktop to choose a Genie for Computer use.");
  }
  const expectedRuntime = { ...runtime };
  const accessToken = await getValidAccessToken({
    refresh: refreshTokens,
    onObservedRejection: onLogtoRefreshFailed,
  });
  if (!accessToken) throw new Error("Sign in again to choose a Genie for Computer use.");
  const agents = await fetchCurrentComputerUseOwnedAgents(accessToken, expectedRuntime.humanUserId);
  if (agents === null || !sameComputerUseRuntime(getActiveComputerUseRuntime(), expectedRuntime)) {
    throw new Error("Nautilo could not verify the Genies you currently own on this Desktop.");
  }
  return agents;
});

ipcMain.handle("computerUse:disable", async (e) => {
  resolveSessionFromSender(e);
  const setup = computerUseSetup;
  if (setup === null) {
    return await computerUseStatus("computer use disabled while unavailable");
  }
  const revoked = await setup.disable();
  // Off remains successful if the relay is disconnected. Advertisement is
  // best effort only; the local revoke/fence has already completed.
  void refreshComputerUseRelay("computer use disabled");
  return await computerUseStatusFromLocal(revoked);
});

ipcMain.handle("workstationShell:status", async (e) => {
  assertMainWindowSender(e);
  const workspacePath = currentFolderPath;
  const consent =
    workspacePath === null
      ? "none"
      : await workstationShellHost.consentStatus(workspacePath);
  return {
    workspacePath,
    consented: consent !== "none",
    consent,
  };
});

ipcMain.handle("workstationShell:revoke", async (e) => {
  assertMainWindowSender(e);
  if (currentFolderPath !== null) {
    await workstationShellHost.revoke(
      currentFolderPath,
      await currentWorkstationShellSubject(),
    );
  }
});

// D453 task 2.3 — stable, initially-disabled relay port. No Codex runtime,
// host, profile, or process exists until a future human-facing connection
// action supplies a reviewed factory to `enable`.
const codexConnection = new ElectronCodexConnection({
  refreshRelay: async (reason) => {
    const wasConnected = getRelayStatus() === "connected";
    const acknowledged = await refreshDesktopRelayCapabilities(reason);
    if (acknowledged) return "acked";
    return wasConnected && getRelayStatus() === "connected"
      ? "failed"
      : "deferred";
  },
});

// This is deliberately an ambient-only local integration. The resolver uses
// Electron's boot-augmented PATH and never selects an SDK optional CLI asset.
const claudeConnection = new ElectronClaudeConnectionHost({
  workingDirectory: () => {
    if (genieWorkspaceRoot === null) throw new Error("Claude discovery requires the Genie Workspace.");
    return genieWorkspaceRoot;
  },
});

const hermesAcpReadinessHost = new ElectronHermesAcpReadinessHost(
  createElectronHermesAcpNativeProbe(),
);
const opencodeAcpReadinessHost = new ElectronOpenCodeAcpReadinessHost(
  createElectronOpenCodeAcpNativeProbe(),
);
const hermesAcpExecutionHost = new ElectronHermesAcpExecutionHost({
  currentFolder: () => currentFolderPath === null
    ? null
    : Object.freeze({ path: currentFolderPath, revision: currentFolderRevision }),
}, {
  readiness: hermesAcpReadinessHost,
  onAvailabilityChanged: () => { void refreshDesktopRelayCapabilities("ACP cleanup settled"); },
});
const opencodeAcpExecutionHost = new ElectronOpenCodeAcpExecutionHost({
  currentFolder: () => currentFolderPath === null
    ? null
    : Object.freeze({ path: currentFolderPath, revision: currentFolderRevision }),
}, {
  readiness: opencodeAcpReadinessHost,
  onAvailabilityChanged: () => { void refreshDesktopRelayCapabilities("ACP cleanup settled"); },
});
const acpExecutionRouter = new ElectronAcpExecutionRouter({
  "hermes-acp": hermesAcpExecutionHost,
  "opencode-acp": opencodeAcpExecutionHost,
}, {
  isEnabled: (registrationId) => registrationId === "opencode-acp" ||
    loadConfig()?.hermesConnectionEnabled === true,
});

function codexProductionHostFactory(actorId: string) {
  return createElectronCodexProductionHostFactory({
    actorId,
    currentFolder: () =>
      currentFolderPath === null
        ? null
        : Object.freeze({
            path: currentFolderPath,
            revision: currentFolderRevision,
          }),
    defaultWorkingDirectory: genieWorkspaceRoot ?? app.getPath("home"),
    paths: {
      codexHostDirPath: codexHostDirPath(),
      codexRuntimeDirPath: codexRuntimeDirPath(),
      codexProfileHomesDirPath: codexProfileHomesDirPath(),
      codexHostStateDirPath: codexHostStateDirPath(),
    },
    openExternal: (url) => shell.openExternal(url).then(() => undefined),
  });
}

/**
 * Rehydrate after the signed-in actor and relay token have been resolved but
 * before relay registration. A failed local runtime start leaves the durable
 * intent intact so a later desktop restart can retry, while readiness remains
 * a normal server preflight concern.
 */
async function restoreCodexConnectionBeforeRelayStart(
  actorId: string,
): Promise<void> {
  if (loadConfig()?.codexConnectionEnabled !== true) return;
  try {
    await codexConnection.enable(codexProductionHostFactory(actorId));
  } catch (err) {
    log.warn(
      `[desktop][d453] failed to restore enabled Codex connection: ${String(err)}`,
    );
  }
}

ipcMain.handle("codexConnection:status", (e) => {
  resolveSessionFromSender(e);
  return codexConnection.status();
});

ipcMain.handle("codexConnection:enable", async (e) => {
  const session = resolveSessionFromSender(e);
  if (!session.signedIn) {
    throw new Error(
      "Codex connection requires a signed-in, non-Guest Nautilo session",
    );
  }
  const userId = await resolveRelayUserId(session.serverUrl);
  if (!userId)
    throw new Error(
      "Codex connection requires an authenticated Nautilo session",
    );
  await codexConnection.enable(codexProductionHostFactory(userId));
  try {
    saveCodexConnectionIntent(session.serverUrl, true);
  } catch (err) {
    // Do not leave a live connection whose successful enablement cannot be
    // made durable: roll it back to the same disabled state a restart sees.
    await codexConnection.disable().catch(() => undefined);
    throw err;
  }
  void publishReadyToWorkOwnerObservation().catch(() => undefined);
});

ipcMain.handle("codexConnection:disable", async (e) => {
  const session = resolveSessionFromSender(e);
  // Fence command admission first, then durably clear restart intent. A host
  // teardown fault must never revive Codex on relaunch.
  const disabling = codexConnection.disable();
  try {
    saveCodexConnectionIntent(session.serverUrl, false);
  } catch (err) {
    await disabling.catch(() => undefined);
    throw err;
  }
  await disabling;
  void publishReadyToWorkOwnerObservation().catch(() => undefined);
});

type HermesConnectionStatus = Readonly<{
  enabled: boolean;
  relay: "connected" | "starting";
}>;

function hermesConnectionStatus(): HermesConnectionStatus {
  return {
    enabled: loadConfig()?.hermesConnectionEnabled === true,
    relay: getRelayStatus() === "connected" ? "connected" : "starting",
  };
}

async function publishReadyToWorkOwnerObservation(): Promise<void> {
  const desired = readyToWorkStore().load();
  if (!desired) return;
  const generation = readyToWorkGeneration;
  const status = await readyToWorkOperationQueue.run(async () =>
    await refreshReadyToWorkStatus(desired, generation));
  if (generation === readyToWorkGeneration) publishReadyToWorkStatus(status);
}

ipcMain.handle("hermesConnection:status", (e) => {
  resolveSessionFromSender(e);
  return hermesConnectionStatus();
});

ipcMain.handle("hermesConnection:enable", async (e) => {
  const session = resolveSessionFromSender(e);
  if (!session.signedIn) throw new Error("Hermes requires a signed-in Nautilo session");
  saveHermesConnectionIntent(session.serverUrl, true);
  await acpExecutionRouter.reconcileRegistration("hermes-acp");
  await refreshDesktopRelayCapabilities("Hermes connection enabled");
  void publishReadyToWorkOwnerObservation().catch(() => undefined);
  return hermesConnectionStatus();
});

ipcMain.handle("hermesConnection:disable", async (e) => {
  const session = resolveSessionFromSender(e);
  // Persist Off before process containment and remote advertisement cleanup.
  saveHermesConnectionIntent(session.serverUrl, false);
  await acpExecutionRouter.reconcileRegistration("hermes-acp");
  await refreshDesktopRelayCapabilities("Hermes connection disabled");
  void publishReadyToWorkOwnerObservation().catch(() => undefined);
  return hermesConnectionStatus();
});

type ReadyOwnerResult = {
  readonly state: "ready" | "needs_attention";
  readonly reason: import("./ready-to-work-contract").ReadyToWorkReason | null;
  readonly repairTarget: import("./ready-to-work-contract").ReadyToWorkRepairTarget;
};

const readyOwnerResult = (
  repairTarget: ReadyOwnerResult["repairTarget"],
  ready: boolean,
  reason: ReadyOwnerResult["reason"] = "owner_unavailable",
): ReadyOwnerResult => ready
  ? { state: "ready", reason: null, repairTarget }
  : { state: "needs_attention", reason, repairTarget };

let pendingReadyRendererRestore: Readonly<{
  attemptId: string;
  resolve: (result: Readonly<{ voice: ReadyOwnerResult; autoApprove: ReadyOwnerResult }>) => void;
  timeout: ReturnType<typeof setTimeout>;
}> | null = null;

function requestReadyRendererOwners(input: Readonly<{ voice: boolean | null; autoApprove: boolean | null }>) {
  const renderer = activeRenderer();
  const unavailable = {
    voice: readyOwnerResult("voice_settings", false),
    autoApprove: readyOwnerResult("auto_approve_settings", false),
  } as const;
  if (!renderer) return Promise.resolve(unavailable);
  if (input.voice === null && input.autoApprove === null) return Promise.resolve(unavailable);
  if (pendingReadyRendererRestore) {
    clearTimeout(pendingReadyRendererRestore.timeout);
    pendingReadyRendererRestore.resolve(unavailable);
    pendingReadyRendererRestore = null;
  }
  const attemptId = randomUUID();
  return new Promise<Readonly<{ voice: ReadyOwnerResult; autoApprove: ReadyOwnerResult }>>((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingReadyRendererRestore?.attemptId !== attemptId) return;
      pendingReadyRendererRestore = null;
      resolve(unavailable);
    }, 1_500);
    pendingReadyRendererRestore = { attemptId, resolve, timeout };
    renderer.send("readyToWork:restoreRendererOwners", {
      attemptId,
      voice: input.voice,
      autoApprove: input.autoApprove,
    });
  });
}

async function disableReadyWorkstationOwner(): Promise<void> {
  // Revoke local compiler authority and begin advertising its removal before
  // any token or server work. Remote cleanup is bounded best effort only.
  await activeWorkstationProfileController.deactivate().catch(() => undefined);
  const relayRefresh = refreshDesktopRelayCapabilities(
    "Ready-to-work Workstation disabled",
  ).catch(() => false);
  const serverUrl = resolvedServerUrl();
  const bearerToken = await Promise.race([
    getValidAccessToken({
      refresh: refreshTokens,
      onObservedRejection: onLogtoRefreshFailed,
    }).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1_500)),
  ]);
  if (serverUrl && bearerToken) {
    await awaitReadyToWorkBounded(
      disableWorkstationProfileViaServer({ serverUrl, bearerToken }),
      1_500,
    );
  }
  await awaitReadyToWorkBounded(relayRefresh, 1_500);
}

async function restoreReadyWorkstation(desired: ReadyToWorkDesiredState): Promise<ReadyOwnerResult> {
  const binding: ReadyToWorkBinding = { humanId: desired.humanId, authority: desired.authority };
  const protectedReceipt = readyToWorkProtectedReceiptStore().readFor(binding);
  if (!protectedReceipt.ok) {
    const reason = protectedReceipt.code === "unavailable"
      ? "os_protection_unavailable"
      : protectedReceipt.code === "missing"
        ? "startup_receipt_missing"
        : "startup_receipt_invalid";
    return readyOwnerResult("workstation_settings", false, reason);
  }
  const local = activeWorkstationProfileController.getActiveSession();
  const server = await getWorkstationServerSessionStatus();
  if (local?.profileId === protectedReceipt.profileId &&
    local.profileRevision === protectedReceipt.profileRevision && server.confirmed &&
    server.session?.profileId === local.profileId && server.session.profileRevision === local.profileRevision) {
    return readyOwnerResult("workstation_settings", true);
  }
  const activated = await activateStoredWorkstationProfile({
    profileId: protectedReceipt.profileId,
    profileRevision: protectedReceipt.profileRevision,
    proof: { startupReceipt: protectedReceipt.receipt },
    networkTimeoutMs: 5_000,
  });
  if (!activated.ok) {
    const reason = readyToWorkWorkstationFailureReason(activated.code);
    return readyOwnerResult("workstation_settings", false, reason);
  }
  const nextReceipt = activated.data.startupReceipt;
  if (nextReceipt && !readyToWorkProtectedReceiptStore().save({
    binding,
    profileId: activated.data.summary.profileId,
    profileRevision: activated.data.summary.profileRevision,
    receipt: nextReceipt,
  })) {
    await disableReadyWorkstationOwner();
    return readyOwnerResult("workstation_settings", false, "os_protection_unavailable");
  }
  return readyOwnerResult("workstation_settings", true);
}

async function observeReadyWorkstation(desired: ReadyToWorkDesiredState): Promise<ReadyOwnerResult> {
  const binding: ReadyToWorkBinding = { humanId: desired.humanId, authority: desired.authority };
  const protectedReceipt = readyToWorkProtectedReceiptStore().readFor(binding);
  if (!protectedReceipt.ok) {
    const reason = protectedReceipt.code === "unavailable"
      ? "os_protection_unavailable"
      : protectedReceipt.code === "missing"
        ? "startup_receipt_missing"
        : "startup_receipt_invalid";
    return readyOwnerResult("workstation_settings", false, reason);
  }
  const local = activeWorkstationProfileController.getActiveSession();
  if (local && (local.profileId !== protectedReceipt.profileId ||
    local.profileRevision !== protectedReceipt.profileRevision)) {
    return readyOwnerResult("workstation_settings", false, "workstation_profile_update_needed");
  }
  const server = await getWorkstationServerSessionStatus();
  if (!server.confirmed || server.session === null) {
    return readyOwnerResult("workstation_settings", false, "workstation_relay_unavailable");
  }
  return readyOwnerResult(
    "workstation_settings",
    local !== null && server.session.profileId === protectedReceipt.profileId &&
      server.session.profileRevision === protectedReceipt.profileRevision,
    "workstation_relay_unavailable",
  );
}

function readyComputerUsePermissionState(): Readonly<{
  accessibilityGranted: boolean;
  screenRecordingGranted: boolean;
}> {
  const permissions = getSystemPermissionsSnapshot().permissions;
  return {
    accessibilityGranted:
      permissions.find((permission) => permission.id === "accessibility")?.state === "granted",
    screenRecordingGranted:
      permissions.find((permission) => permission.id === "screen-recording")?.state === "granted",
  };
}

async function observeReadyComputerUse(): Promise<ReadyOwnerResult> {
  const setup = computerUseSetup;
  // status() performs the existing live server/capability/binding
  // re-attestation and revokes stale authority before projecting Ready.
  const local = setup
    ? await awaitReadyToWorkValueBounded(setup.status(), 5_000, null)
    : null;
  const status = local ? await computerUseStatusFromLocal(local) : null;
  const reason = readyToWorkComputerUseFailureReason({
    ...readyComputerUsePermissionState(),
    state: local?.state ?? "unavailable",
    providerReady: status?.effectiveProvider !== null && status?.effectiveProvider !== undefined,
  });
  return readyOwnerResult("computer_use_settings", reason === null, reason);
}

/**
 * Ready enrollment reuses D516's one canonical PIN/ownership/attestation/mint
 * ceremony. It chooses the same first current personal Genie that the
 * Computer Use setup UI initially selects; the controller then revalidates
 * that exact ownership before writing its existing receipt.
 */
async function enableReadyComputerUseDuringEnrollment(
  pin: string,
  expectedHumanUserId: string,
): Promise<boolean> {
  const setup = computerUseSetup;
  if (!setup) return false;
  const current = await awaitReadyToWorkValueBounded(setup.status(), 5_000, null);
  if (!current || current.state !== "not-enabled") return false;

  // OS grants and provider readiness are repairs, not a reason to discard the
  // rest of a valid Ready selection. Reconciliation reports their exact
  // bounded reason after enrollment.
  const permissionReason = readyToWorkComputerUseFailureReason({
    ...readyComputerUsePermissionState(),
    state: "enabled",
    providerReady: true,
  });
  if (permissionReason) return false;
  const projection = await awaitReadyToWorkValueBounded(
    refreshComputerUseProviderProjection(),
    5_000,
    null,
  );
  if (!projection?.effectiveProvider) return false;

  const accessToken = await awaitReadyToWorkValueBounded(
    getValidAccessToken({
      refresh: refreshTokens,
      onObservedRejection: onLogtoRefreshFailed,
    }).catch(() => null),
    5_000,
    null,
  );
  if (!accessToken) {
    throw new Error("Ready to work requires an authenticated Nautilo Human");
  }
  const ownedAgents = await awaitReadyToWorkValueBounded(
    fetchCurrentComputerUseOwnedAgents(accessToken, expectedHumanUserId),
    5_000,
    null,
  );
  const agentId = ownedAgents?.[0]?.agentId ?? null;
  if (!agentId) return false;

  const enabled = await setup.enable(pin, agentId);
  if (enabled.state !== "enabled") {
    throw new Error("Nautilo could not enable Computer use for Ready to work");
  }
  const retained = await commitReadyComputerUseEnable({
    providerReady: async () => {
      const enabledProjection = await awaitReadyToWorkValueBounded(
        refreshComputerUseProviderProjection(),
        5_000,
        null,
      );
      return enabledProjection?.effectiveProvider !== null &&
        enabledProjection?.effectiveProvider !== undefined;
    },
    disable: async () => { await setup.disable(); },
  });
  if (!retained) return false;
  await awaitReadyToWorkBounded(
    refreshComputerUseRelay("Ready-to-work enrollment enabled Computer use"),
    5_000,
  );
  return true;
}

async function disableReadyComputerUseOwner(): Promise<void> {
  if (computerUseSetup) await computerUseSetup.disable();
  await refreshComputerUseRelay("Ready-to-work disabled");
}

async function stopReadyCodexRuntime(): Promise<void> {
  await awaitReadyToWorkBounded(codexConnection.disable(), 5_000);
}

const readyToWorkCoordinator = new ReadyToWorkCoordinator({
  restoreRendererOwners: requestReadyRendererOwners,
  restoreWorkstation: restoreReadyWorkstation,
  observeComputerUse: async () => {
    const permissionReason = readyToWorkComputerUseFailureReason({
      ...readyComputerUsePermissionState(),
      state: "enabled",
      providerReady: true,
    });
    if (permissionReason) return readyOwnerResult("computer_use_settings", false, permissionReason);
    const setup = computerUseSetup;
    if (!setup) return readyOwnerResult("computer_use_settings", false, "computer_use_setup_required");
    const local = await awaitReadyToWorkValueBounded(setup.status(), 5_000, null);
    if (!local) {
      return readyOwnerResult(
        "computer_use_settings",
        false,
        "computer_use_provider_unavailable",
      );
    }
    await awaitReadyToWorkBounded(refreshComputerUseProviderProjection(), 5_000);
    await awaitReadyToWorkBounded(
      refreshComputerUseRelay("Ready-to-work startup reconciliation"),
      5_000,
    );
    const status = await computerUseStatusFromLocal(local);
    const reason = readyToWorkComputerUseFailureReason({
      ...readyComputerUsePermissionState(),
      state: status.state,
      providerReady: status.effectiveProvider !== null,
    });
    return readyOwnerResult(
      "computer_use_settings",
      reason === null,
      reason,
    );
  },
  restoreCodingConnection: async (desired, isCurrent) => {
    // Ready derives harness membership from each Connection's canonical owner
    // toggle. It retries an enabled Codex owner but never turns an off owner on.
    if (loadConfig()?.codexConnectionEnabled !== true) {
      return readyOwnerResult("coding_connection_settings", true);
    }
    const status = codexConnection.status();
    if (status.ready) return readyOwnerResult("coding_connection_settings", true);
    try {
      const enabled = await awaitReadyToWorkValueBounded(
        codexConnection.enable(codexProductionHostFactory(desired.humanId))
          .then(() => true)
          .catch(() => false),
        5_000,
        false,
      );
      if (!enabled) {
        return readyOwnerResult(
          "coding_connection_settings",
          false,
          "coding_connection_unavailable",
        );
      }
      if (!await isCurrent()) {
        await stopReadyCodexRuntime().catch(() => undefined);
        return readyOwnerResult(
          "coding_connection_settings",
          false,
          "authority_changed",
        );
      }
      return readyOwnerResult("coding_connection_settings", codexConnection.status().ready,
        "coding_connection_unavailable");
    } catch {
      return readyOwnerResult("coding_connection_settings", false, "coding_connection_unavailable");
    }
  },
  disableRendererOwners: async (selection) => {
    await requestReadyRendererOwners({
      voice: selection.voice ? false : null,
      autoApprove: selection.auto_approve ? false : null,
    });
  },
  disableWorkstation: disableReadyWorkstationOwner,
  disableComputerUse: disableReadyComputerUseOwner,
  // Harness toggles are canonical owner intent. Switching Ready to Individual
  // controls must not silently rewrite those independent choices.
  disableCodingConnection: () => Promise.resolve(),
});

async function readyToWorkActiveBindingMatches(binding: ReadyToWorkBinding): Promise<boolean> {
  const activeSession = serverSessions.active;
  if (!activeSession) return false;
  try {
    const authenticated = await resolveReadyToWorkBindingForSession(activeSession);
    if (serverSessions.active !== activeSession) return false;
    const refreshedAuthority = authoritativeConnectionSnapshot();
    if (!refreshedAuthority?.serverFingerprint) return false;
    const current: ReadyToWorkBinding = {
      humanId: authenticated.humanId,
      authority: {
        scope: refreshedAuthority.scope,
        revision: refreshedAuthority.revision,
        connectionAttemptId: refreshedAuthority.connectionAttemptId,
        serverFingerprint: refreshedAuthority.serverFingerprint,
      },
    };
    return hasReadyToWorkSameBinding(binding, current);
  } catch {
    return false;
  }
}

async function reconcileReadyToWorkNow(
  binding: ReadyToWorkBinding,
  trigger: "startup" | "relay_reconnect" | "explicit_restore",
  generation: number,
) {
  if (generation !== readyToWorkGeneration) return attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
  const desired = readyToWorkStore().loadFor(binding);
  if (!desired) return attachReadyCodingHarnessPreview(readyToWorkAggregateStatus(null));
  readyToWorkCoordinatorBinding = binding;
  const status = await readyToWorkCoordinator.reconcile({
    desired,
    trigger,
    isCurrent: async () => {
      if (generation !== readyToWorkGeneration) return false;
      const persisted = readyToWorkStore().loadFor(binding);
      if (!persisted ||
        persisted.components.voice !== desired.components.voice ||
        persisted.components.auto_approve !== desired.components.auto_approve ||
        persisted.components.workstation !== desired.components.workstation ||
        persisted.components.computer_use !== desired.components.computer_use ||
        persisted.components.coding_connection !== desired.components.coding_connection) {
        return false;
      }
      return await readyToWorkActiveBindingMatches(binding);
    },
  });
  if (generation !== readyToWorkGeneration) return attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
  return await attachReadyCodingHarnessStatuses(status);
}

function enabledReadyCodingHarnessStatuses(): ReadyToWorkCodingHarnessStatus[] {
  const harnesses: ReadyToWorkCodingHarnessStatus[] = [];
  if (loadConfig()?.codexConnectionEnabled === true) {
    const ready = codexConnection.status().ready;
    harnesses.push({
      id: "codex",
      state: ready ? "ready" : "needs_attention",
      reason: ready ? null : "coding_harness_unavailable",
      repairTarget: "coding_connection_settings",
    });
  }
  if (loadConfig()?.hermesConnectionEnabled === true) {
    harnesses.push({
      id: "hermes-acp",
      state: "needs_attention",
      reason: getRelayStatus() === "connected"
        ? "coding_harness_unavailable"
        : "coding_harness_starting",
      repairTarget: "coding_connection_settings",
    });
  }
  return harnesses;
}

function attachReadyCodingHarnessPreview(
  status: import("./ready-to-work-contract").ReadyToWorkAggregateStatus,
): import("./ready-to-work-contract").ReadyToWorkAggregateStatus {
  return withReadyToWorkCodingHarnesses(status, enabledReadyCodingHarnessStatuses());
}

async function attachReadyCodingHarnessStatuses(
  status: import("./ready-to-work-contract").ReadyToWorkAggregateStatus,
): Promise<import("./ready-to-work-contract").ReadyToWorkAggregateStatus> {
  if (status.mode !== "ready") return attachReadyCodingHarnessPreview(status);
  const coding = status.components.find((component) => component.id === "coding_connection");
  if (!coding || coding.state === "off_by_choice") return status;
  const harnesses = enabledReadyCodingHarnessStatuses();
  if (loadConfig()?.hermesConnectionEnabled === true) {
    let state: Awaited<ReturnType<typeof hermesAcpReadinessHost.readiness>> | "starting" = "starting";
    if (getRelayStatus() === "connected") {
      state = await awaitReadyToWorkValueBounded(
        hermesAcpReadinessHost.readiness(),
        5_000,
        "unavailable",
      );
    }
    const reason = state === "ready" ? null
      : state === "starting" ? "coding_harness_starting" as const
        : state === "missing" ? "coding_harness_not_installed" as const
          : state === "authentication_required" ? "coding_harness_sign_in_required" as const
            : "coding_harness_unavailable" as const;
    const hermesIndex = harnesses.findIndex((harness) => harness.id === "hermes-acp");
    const hermesStatus: ReadyToWorkCodingHarnessStatus = {
      id: "hermes-acp" as const,
      state: state === "ready" ? "ready" : "needs_attention",
      reason,
      repairTarget: "coding_connection_settings",
    };
    if (hermesIndex === -1) harnesses.push(hermesStatus);
    else harnesses[hermesIndex] = hermesStatus;
  }
  return withReadyToWorkCodingHarnesses(status, harnesses);
}

async function refreshReadyToWorkStatus(
  desired: ReadyToWorkDesiredState,
  generation: number,
): Promise<import("./ready-to-work-contract").ReadyToWorkAggregateStatus> {
  if (generation !== readyToWorkGeneration) return attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
  const observed: Partial<Record<ReadyToWorkComponentId, ReadyOwnerResult>> = {};
  if (desired.components.workstation) {
    observed.workstation = await observeReadyWorkstation(desired).catch(() =>
      readyOwnerResult("workstation_settings", false));
  }
  if (desired.components.computer_use) {
    observed.computer_use = await observeReadyComputerUse().catch(() =>
      readyOwnerResult("computer_use_settings", false));
  }
  if (desired.components.coding_connection) {
    observed.coding_connection = readyOwnerResult(
      "coding_connection_settings",
      codexConnection.status().ready,
      "coding_connection_unavailable",
    );
  }
  const binding: ReadyToWorkBinding = { humanId: desired.humanId, authority: desired.authority };
  const persisted = readyToWorkStore().loadFor(binding);
  if (!persisted ||
    persisted.components.voice !== desired.components.voice ||
    persisted.components.auto_approve !== desired.components.auto_approve ||
    persisted.components.workstation !== desired.components.workstation ||
    persisted.components.computer_use !== desired.components.computer_use ||
    persisted.components.coding_connection !== desired.components.coding_connection ||
    !await readyToWorkActiveBindingMatches(binding) || generation !== readyToWorkGeneration) {
    readyToWorkCoordinatorBinding = null;
    return attachReadyCodingHarnessPreview(readyToWorkAggregateStatus(null));
  }
  if (!readyToWorkCoordinatorBinding ||
    !hasReadyToWorkSameBinding(readyToWorkCoordinatorBinding, binding)) {
    readyToWorkCoordinatorBinding = binding;
  }
  return await attachReadyCodingHarnessStatuses(readyToWorkCoordinator.observe(desired, observed));
}

function publishReadyToWorkStatus(
  status: import("./ready-to-work-contract").ReadyToWorkAggregateStatus,
): void {
  sendToActiveRenderer("readyToWork:statusChanged", status);
}

async function reconcileReadyForServerSession(
  session: ServerSession,
  trigger: "startup" | "relay_reconnect" = "startup",
): Promise<void> {
  const generation = readyToWorkGeneration;
  try {
    await readyToWorkOperationQueue.run(async () => {
      await readyToWorkCleanupPromise;
      if (generation !== readyToWorkGeneration) return;
      const binding = await resolveReadyToWorkBindingForSession(session);
      const status = await reconcileReadyToWorkNow(binding, trigger, generation);
      if (generation === readyToWorkGeneration) publishReadyToWorkStatus(status);
    });
  } catch {
    // Standard, signed-out, foreign, and unavailable startup contexts are
    // deliberately silent and fail closed. Explicit Restore remains the
    // Human-visible retry path.
  }
}

async function verifyReadyEnrollmentPin(serverUrl: string, pin: string): Promise<void> {
  const token = await awaitReadyToWorkValueBounded(
    getValidAccessToken({ refresh: refreshTokens, onObservedRejection: onLogtoRefreshFailed })
      .catch(() => null),
    5_000,
    null,
  );
  if (!token) throw new Error("Ready to work requires an authenticated Nautilo Human");
  const response = await fetch(`${serverUrl.replace(/\/$/, "")}/api/auth/verify-pin`, {
    method: "POST",
    signal: AbortSignal.timeout(5_000),
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ pin }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "That PIN is incorrect." : "Nautilo could not verify your PIN.");
}

// D557 — the renderer may submit one transient own-Human PIN during
// enrollment, but no receipt, binding, identity, or owner authority crosses.
ipcMain.handle("readyToWork:get", async (e) => {
  const generation = readyToWorkGeneration;
  return await readyToWorkOperationQueue.run(async () =>
    await readyToWorkStatusForSender(e, generation));
});

ipcMain.handle("readyToWork:enroll", async (e, raw: unknown) => {
  const request = ipcRecord(raw);
  const selection = request && Object.keys(request).sort().join(",") === "pin,selection"
    ? parseReadyToWorkSelection(request["selection"])
    : null;
  const pin = request?.["pin"];
  if (!selection) throw new Error("Ready-to-work selection is invalid");
  if (typeof pin !== "string" || !/^\d{6,8}$/.test(pin)) {
    throw new Error("Ready to work requires your 6–8 digit PIN");
  }
  const generation = readyToWorkGeneration;
  return await readyToWorkOperationQueue.run(async () => {
    await readyToWorkCleanupPromise;
    if (generation !== readyToWorkGeneration) {
      throw new Error("Ready to work enrollment was cancelled");
    }
    const binding = await resolveReadyToWorkBinding(e);
    const session = resolveSessionFromSender(e);
    const previous = readyToWorkStore().loadFor(binding);
    let activatedWorkstation = false;
    let activatedComputerUse = false;
    let receiptToPersist: Readonly<{
      profileId: string;
      profileRevision: number;
      receipt: string;
    }> | null = null;

    if (selection.workstation) {
      if (!isReadyToWorkStorageProtected(safeStorage)) {
        throw new Error("Ready to work cannot protect its Workstation startup receipt on this Mac");
      }
      const selectors = await readyToWorkProfileSelectors();
      if (!selectors.ok) throw new Error(selectors.message);
      const existingReceipt = readyToWorkProtectedReceiptStore().readFor(binding);
      let canPreserveReceipt = existingReceipt.ok &&
        existingReceipt.profileId === selectors.profileId &&
        existingReceipt.profileRevision === selectors.profileRevision;
      let pinVerified = false;
      if (canPreserveReceipt) {
        // Repeat enrollment proves the Human again. An exact live local/server
        // session may preserve its receipt; otherwise try the receipt once so
        // stale pairing-generation claims fall back to a fresh PIN ceremony.
        await verifyReadyEnrollmentPin(session.serverUrl, pin);
        pinVerified = true;
        const local = activeWorkstationProfileController.getActiveSession();
        const server = await getWorkstationServerSessionStatus();
        const exactLive = local?.profileId === selectors.profileId &&
          local.profileRevision === selectors.profileRevision && server.confirmed &&
          server.session?.profileId === selectors.profileId &&
          server.session.profileRevision === selectors.profileRevision;
        if (!exactLive && existingReceipt.ok) {
          const restored = await activateStoredWorkstationProfile({
            profileId: selectors.profileId,
            profileRevision: selectors.profileRevision,
            proof: { startupReceipt: existingReceipt.receipt },
            networkTimeoutMs: 5_000,
          });
          if (restored.ok) {
            activatedWorkstation = true;
            if (restored.data.startupReceipt) {
              receiptToPersist = {
                profileId: restored.data.summary.profileId,
                profileRevision: restored.data.summary.profileRevision,
                receipt: restored.data.startupReceipt,
              };
            }
          } else {
            canPreserveReceipt = false;
            // A failed receipt attempt may have rolled local compilation back
            // while an old server session remains. Reduce both before PIN mint.
            await disableReadyWorkstationOwner();
          }
        }
      }
      if (!canPreserveReceipt) {
        const active = activeWorkstationProfileController.getActiveSession();
        if (active !== null) {
          // Initial Ready adoption of an already-live manual Workstation needs
          // a receipt. Prove the PIN before reducing that existing authority,
          // then run the ordinary activation ceremony to mint one.
          if (!pinVerified) await verifyReadyEnrollmentPin(session.serverUrl, pin);
          await disableReadyWorkstationOwner();
        }
        const activated = await activateStoredWorkstationProfile({
          profileId: selectors.profileId,
          profileRevision: selectors.profileRevision,
          proof: { pin },
          networkTimeoutMs: 5_000,
        });
        if (!activated.ok) throw new Error(activated.message);
        activatedWorkstation = true;
        if (!activated.data.startupReceipt) {
          await disableReadyWorkstationOwner();
          throw new Error("Nautilo could not mint the Workstation startup receipt");
        }
        receiptToPersist = {
          profileId: activated.data.summary.profileId,
          profileRevision: activated.data.summary.profileRevision,
          receipt: activated.data.startupReceipt,
        };
      }
    } else {
      await verifyReadyEnrollmentPin(session.serverUrl, pin);
    }

    try {
      if (selection.computer_use) {
        activatedComputerUse = await enableReadyComputerUseDuringEnrollment(
          pin,
          binding.humanId,
        );
      }
    } catch (error) {
      if (activatedComputerUse) await disableReadyComputerUseOwner().catch(() => undefined);
      if (activatedWorkstation) await disableReadyWorkstationOwner();
      throw error;
    }

    // The PIN/activation ceremony is asynchronous. Never persist its result
    // after the Human, active session, or complete authority marker changed.
    if (generation !== readyToWorkGeneration ||
      !await readyToWorkActiveBindingMatches(binding)) {
      if (activatedComputerUse) await disableReadyComputerUseOwner().catch(() => undefined);
      if (activatedWorkstation) await disableReadyWorkstationOwner();
      throw new Error("Ready to work active Desktop authority changed during enrollment");
    }

    const desired = createReadyToWorkDesiredState(binding, selection);
    let persistedNewReceipt = false;
    try {
      if (receiptToPersist !== null) {
        persistedNewReceipt = readyToWorkProtectedReceiptStore().save({
          binding,
          ...receiptToPersist,
        });
        if (!persistedNewReceipt) {
          throw new Error("Nautilo could not protect the Workstation startup receipt");
        }
      }
      // A narrowed same-binding selection is durable before any removed owner
      // is turned off, so a crash can only restart the narrower posture.
      readyToWorkStore().save(desired);
    } catch (error) {
      if (persistedNewReceipt) {
        try { readyToWorkProtectedReceiptStore().clear(); } catch { /* rollback continues */ }
      }
      if (activatedComputerUse) await disableReadyComputerUseOwner().catch(() => undefined);
      if (activatedWorkstation) await disableReadyWorkstationOwner();
      throw error;
    }

    if (previous) {
      const removed = {
        voice: previous.components.voice && !selection.voice,
        auto_approve: previous.components.auto_approve && !selection.auto_approve,
        workstation: previous.components.workstation && !selection.workstation,
        computer_use: previous.components.computer_use && !selection.computer_use,
        coding_connection: previous.components.coding_connection && !selection.coding_connection,
      };
      if (Object.values(removed).some(Boolean)) {
        if (removed.workstation) {
          try { readyToWorkProtectedReceiptStore().clear(); } catch { /* intent is already narrowed */ }
        }
        await readyToWorkCoordinator.disable(createReadyToWorkDesiredState(binding, removed));
      }
    }
    const status = await reconcileReadyToWorkNow(binding, "explicit_restore", generation);
    if (generation === readyToWorkGeneration) publishReadyToWorkStatus(status);
    return status;
  });
});

ipcMain.handle("readyToWork:restore", async (e) => {
  const generation = readyToWorkGeneration;
  return await readyToWorkOperationQueue.run(async () => {
    await readyToWorkCleanupPromise;
    if (generation !== readyToWorkGeneration) return attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
    const binding = await resolveReadyToWorkBinding(e);
    const status = await reconcileReadyToWorkNow(binding, "explicit_restore", generation);
    if (generation === readyToWorkGeneration) publishReadyToWorkStatus(status);
    return status;
  });
});

ipcMain.handle("readyToWork:disable", (e) => {
  // Authority-reducing Off needs no Human/network lookup: sender-gate, capture
  // the sole local selection, then synchronously disarm restart before any
  // queued or remote work can delay it.
  resolveSessionFromSender(e);
  const desired = readyToWorkStore().load();
  readyToWorkStore().clear();
  try {
    readyToWorkProtectedReceiptStore().clear();
  } catch {
    // Durable intent is already disarmed. A stale opaque ciphertext is not
    // authority and must not prevent Standard or owner shutdown.
  }
  readyToWorkCoordinatorBinding = null;
  readyToWorkGeneration += 1;
  const status = attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
  publishReadyToWorkStatus(status);
  const ownerCleanup = desired
    ? readyToWorkCoordinator.disable(desired).catch(() => undefined)
    : Promise.resolve();
  readyToWorkCleanupPromise = awaitReadyToWorkBounded(
    Promise.all([readyToWorkCleanupPromise, ownerCleanup]),
    5_000,
  );
  const cleanup = readyToWorkCleanupPromise;
  // Cleanup starts now, while this queued barrier keeps a later Restore or
  // enrollment from racing authority that Off is still reducing.
  void readyToWorkOperationQueue.run(async () => await cleanup).catch(() => undefined);
  return status;
});

ipcMain.handle("readyToWork:ackRendererOwners", (e, raw: unknown) => {
  assertMainWindowSender(e);
  const request = ipcRecord(raw);
  if (!request || Object.keys(request).sort().join(",") !== "attemptId,autoApprove,voice" ||
    typeof request["attemptId"] !== "string" || typeof request["voice"] !== "boolean" ||
    typeof request["autoApprove"] !== "boolean") return;
  const pending = pendingReadyRendererRestore;
  if (!pending || pending.attemptId !== request["attemptId"]) return;
  clearTimeout(pending.timeout);
  pendingReadyRendererRestore = null;
  pending.resolve({
    voice: readyOwnerResult("voice_settings", request["voice"]),
    autoApprove: readyOwnerResult("auto_approve_settings", request["autoApprove"]),
  });
});

// Current renderer-owned truth is observational only: it updates the redacted
// aggregate and never invokes an enable/restore path.
ipcMain.handle("readyToWork:reportRendererOwners", async (e, raw: unknown) => {
  assertMainWindowSender(e);
  const request = ipcRecord(raw);
  if (!request || Object.keys(request).sort().join(",") !== "autoApprove,voice" ||
    typeof request["voice"] !== "boolean" || typeof request["autoApprove"] !== "boolean") {
    throw new Error("Ready-to-work renderer owner status is invalid");
  }
  const voice = request["voice"];
  const autoApprove = request["autoApprove"];
  const generation = readyToWorkGeneration;
  return await readyToWorkOperationQueue.run(async () => {
    if (generation !== readyToWorkGeneration) return attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
    const binding = await resolveReadyToWorkBinding(e);
    if (generation !== readyToWorkGeneration) return attachReadyCodingHarnessPreview(readyToWorkCoordinator.reset());
    const desired = readyToWorkStore().loadFor(binding);
    if (!desired) return attachReadyCodingHarnessPreview(readyToWorkAggregateStatus(null));
    const observed: Partial<Record<ReadyToWorkComponentId, ReadyOwnerResult>> = {};
    if (desired.components.voice) {
      observed.voice = readyOwnerResult("voice_settings", voice, "owner_rejected");
    }
    if (desired.components.auto_approve) {
      observed.auto_approve = readyOwnerResult(
        "auto_approve_settings",
        autoApprove,
        "owner_rejected",
      );
    }
    const status = await attachReadyCodingHarnessStatuses(readyToWorkCoordinator.observe(desired, observed));
    if (generation === readyToWorkGeneration) publishReadyToWorkStatus(status);
    return status;
  });
});

function grantIpcFailure<T>(
  code: DesktopFilesystemGrantsIpcFailureCode,
  message: string,
): DesktopFilesystemGrantsIpcResult<T> {
  return { ok: false, code, message };
}

/**
 * D418 protocol v7 — re-advertise the desktop relay's advisory active-grant
 * snapshot after a local grant mutation via the atomic
 * `relay:update-capabilities` transport (no stop/start reconnect). The shared
 * "current capability builder" in `startRelay` rebuilds the snapshot from the
 * LOCAL `DesktopFilesystemGrantAuthority` (durable + overlay), so overlay grants are
 * visible to discovery. The server snapshot is NEVER updated from renderer
 * data: the renderer only triggers a refresh, and the relay rebuilds the
 * advisory hint from its own local store. The snapshot stays advisory; the
 * relay-local resolver decides final authority, and stale/revoked grants fail
 * locally. When the relay is not connected this is a no-op — the snapshot is
 * rebuilt from local state at the next register.
 */
function reAdvertiseDesktopFilesystemGrantSnapshot(reason: string): void {
  void refreshDesktopRelayCapabilities(reason);
}

function rootIdentityResult(
  result: DesktopFilesystemGrantRootIdentityResult,
): DesktopFilesystemGrantsIpcResult<{
  canonicalRoot: string;
  filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
}> {
  return result.ok
    ? { ok: true, data: result }
    : grantIpcFailure(result.error.code, result.error.message);
}

async function currentDesktopFilesystemGrantUserId(): Promise<string | null> {
  const serverUrl = resolvedServerUrl();
  return serverUrl ? resolveRelayUserId(serverUrl) : null;
}

function grantStoreFailure<T>(
  code: DesktopFilesystemGrantStoreErrorCode,
): DesktopFilesystemGrantsIpcResult<T> {
  // Store messages can contain OS-specific details. Keep the bridge safe for
  // renderer display while preserving the typed cause for UI handling.
  return grantIpcFailure(
    code,
    "Desktop Filesystem Grants could not be updated.",
  );
}

type DesktopFilesystemGrantCreateRequest = {
  canonicalRoot: string;
  filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
  access: readonly DesktopFilesystemAccessOperation[];
  lifetime: DesktopFilesystemGrantLifetime;
};

/**
 * The renderer may request only the filesystem facts it received from
 * validation plus its explicit operation/lifetime choice. Reject all other
 * fields so it can never nominate a subject, identifier, origin, or policy.
 */
function parseDesktopFilesystemGrantCreateRequest(
  value: unknown,
): DesktopFilesystemGrantCreateRequest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  const request = value as {
    canonicalRoot?: unknown;
    filesystemIdentity?: unknown;
    access?: unknown;
    lifetime?: unknown;
    [key: string]: unknown;
  };
  const allowedKeys = new Set([
    "canonicalRoot",
    "filesystemIdentity",
    "access",
    "lifetime",
  ]);
  if (Object.keys(request).some((key) => !allowedKeys.has(key))) return null;
  if (
    typeof request.canonicalRoot !== "string" ||
    request.canonicalRoot.length === 0
  )
    return null;
  if (!Array.isArray(request.access) || request.access.length === 0)
    return null;
  if (
    !request.access.every(
      (operation) =>
        typeof operation === "string" &&
        (DESKTOP_FILESYSTEM_ACCESS_OPERATIONS as readonly string[]).includes(
          operation,
        ),
    ) ||
    new Set(request.access).size !== request.access.length
  ) {
    return null;
  }
  if (
    typeof request.lifetime !== "string" ||
    !(DESKTOP_FILESYSTEM_GRANT_LIFETIMES as readonly string[]).includes(
      request.lifetime,
    )
  ) {
    return null;
  }
  if (
    typeof request.filesystemIdentity !== "object" ||
    request.filesystemIdentity === null ||
    Array.isArray(request.filesystemIdentity)
  ) {
    return null;
  }
  const identity = request.filesystemIdentity as {
    realRoot?: unknown;
    device?: unknown;
    inode?: unknown;
    [key: string]: unknown;
  };
  const identityKeys = new Set(["realRoot", "device", "inode"]);
  if (
    Object.keys(identity).some((key) => !identityKeys.has(key)) ||
    typeof identity.realRoot !== "string" ||
    identity.realRoot.length === 0
  ) {
    return null;
  }
  const hasDevice = identity.device !== undefined;
  if (
    hasDevice !== (identity.inode !== undefined) ||
    (hasDevice &&
      (typeof identity.device !== "number" ||
        !Number.isSafeInteger(identity.device) ||
        identity.device < 0 ||
        typeof identity.inode !== "number" ||
        !Number.isSafeInteger(identity.inode) ||
        identity.inode < 0))
  ) {
    return null;
  }
  return {
    canonicalRoot: request.canonicalRoot,
    filesystemIdentity: {
      realRoot: identity.realRoot,
      ...(hasDevice
        ? { device: identity.device as number, inode: identity.inode as number }
        : {}),
    },
    access: request.access as DesktopFilesystemAccessOperation[],
    lifetime: request.lifetime as DesktopFilesystemGrantLifetime,
  };
}

ipcMain.handle("desktopFilesystemGrants:pick", async (e) => {
  assertMainWindowSender(e);
  // A picker result is only a candidate. It is neither validated nor persisted.
  return pickFolder();
});

ipcMain.handle(
  "desktopFilesystemGrants:validate",
  async (e, args: { path?: unknown }) => {
    assertMainWindowSender(e);
    if (typeof args?.path !== "string") {
      return grantIpcFailure(
        "invalid_request",
        "Choose a directory before validating it.",
      );
    }
    return rootIdentityResult(
      await captureDesktopFilesystemGrantRootIdentity(args.path),
    );
  },
);

ipcMain.handle(
  "desktopFilesystemGrants:create",
  async (e, args: { request?: unknown }) => {
    assertMainWindowSender(e);
    const request = parseDesktopFilesystemGrantCreateRequest(args?.request);
    if (!request) {
      return grantIpcFailure(
        "invalid_request",
        "The Desktop Filesystem Grant request is invalid.",
      );
    }
    const userId = await currentDesktopFilesystemGrantUserId();
    const relayId = getPersistedDesktopRelayId();
    if (!userId || !relayId) {
      return grantIpcFailure(
        "identity_unavailable",
        "Sign in and start the desktop relay before creating a Desktop Filesystem Grant.",
      );
    }
    const revalidated = await revalidateDesktopFilesystemGrantRootIdentity(
      request.filesystemIdentity,
    );
    if (!revalidated.ok) {
      return grantIpcFailure(revalidated.error.code, revalidated.error.message);
    }
    if (
      revalidated.canonicalRoot !== request.canonicalRoot ||
      revalidated.filesystemIdentity.realRoot !==
        request.filesystemIdentity.realRoot ||
      revalidated.filesystemIdentity.device !==
        request.filesystemIdentity.device ||
      revalidated.filesystemIdentity.inode !== request.filesystemIdentity.inode
    ) {
      return grantIpcFailure(
        "root_identity_changed",
        "The selected directory no longer matches its validated identity.",
      );
    }
    const parsed = parseDesktopFilesystemGrant({
      schemaVersion: 1,
      id: randomUUID(),
      canonicalRoot: request.canonicalRoot,
      access: request.access,
      origin: "user_picker",
      lifetime: request.lifetime,
      subject: {
        userId,
        instanceId: desktopInstance.instanceId,
        relayId,
        agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
      },
      createdBy: userId,
      createdAt: new Date().toISOString(),
      policyVersion: 1,
      filesystemIdentity: request.filesystemIdentity,
    } satisfies DesktopFilesystemGrant);
    if (!parsed.ok) {
      return grantIpcFailure(
        "invalid_request",
        "The Desktop Filesystem Grant request is invalid.",
      );
    }

    const created = await desktopFilesystemGrantStore.create({
      userId,
      grant: parsed.grant,
    });
    if (!created.ok) return grantStoreFailure(created.code);
    // D418 — re-advertise the advisory snapshot from local state (never renderer data).
    reAdvertiseDesktopFilesystemGrantSnapshot(
      "Desktop Filesystem Grant create",
    );
    return { ok: true, data: created.data } as const;
  },
);

ipcMain.handle(
  "desktopFilesystemGrants:list",
  async (e, args?: { includeHistory?: unknown }) => {
    assertMainWindowSender(e);
    const userId = await currentDesktopFilesystemGrantUserId();
    if (!userId) {
      return grantIpcFailure(
        "identity_unavailable",
        "Sign in to view Desktop Filesystem Grants.",
      );
    }
    const listed = await desktopFilesystemGrantStore.list({
      userId,
      includeHistory: args?.includeHistory === true,
    });
    return listed.ok
      ? ({ ok: true, data: listed.data } as const)
      : grantStoreFailure(listed.code);
  },
);

ipcMain.handle(
  "desktopFilesystemGrants:revoke",
  async (e, args: { grantId?: unknown }) => {
    assertMainWindowSender(e);
    if (typeof args?.grantId !== "string" || args.grantId.length === 0) {
      return grantIpcFailure(
        "invalid_request",
        "Choose a Desktop Filesystem Grant to revoke.",
      );
    }
    const userId = await currentDesktopFilesystemGrantUserId();
    if (!userId) {
      return grantIpcFailure(
        "identity_unavailable",
        "Sign in to revoke Desktop Filesystem Grants.",
      );
    }
    const revoked = await desktopFilesystemGrantStore.revoke({
      userId,
      grantId: args.grantId,
    });
    if (!revoked.ok) return grantStoreFailure(revoked.code);
    // D418 — re-advertise the advisory snapshot from local state (never renderer data).
    reAdvertiseDesktopFilesystemGrantSnapshot(
      "Desktop Filesystem Grant revoke",
    );
    return { ok: true, data: revoked.data } as const;
  },
);

// ── D418 — Workstation Profile review / activation-preparation bridge ──────
//
// Read-only-ish review operations + a narrow activation-preparation IPC for
// the shipped Developer Workstation seed. The renderer supplies NO roots,
// env, executables, or discovered facts: Electron main materializes the seed
// profile itself and runs the advisory discovery adapters itself, returning
// only review facts + seed identity. This bridge NEVER activates a profile,
// NEVER creates/updates a stored profile, NEVER grants roots, and NEVER calls
// the server activation route. It is sender-gated to the mainWindow
// Workbench renderer and absent on non-desktop (preload-gated).
//
// The redacted return shapes carry only identity + capability ids/backends +
// the human-readable discovery review. Roots/env values/executable paths from
// the profile TEMPLATE are never returned; only discovered facts the host
// itself probed surface in the review rows, which is the advisory display
// model. The active-profile summary omits subject + grantIds.

type WorkstationProfileIpcFailureCode =
  | "invalid_request"
  | "seed_invalid"
  | "discovery_failed"
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  // D418 — profile-selector activation seam failures. Surfaced when the
  // server proof flow rejects activation OR the desktop cannot compile the
  // stored profile after the server proof succeeded.
  | "no_relay"
  | "no_user"
  | "no_server"
  | "profile_not_found"
  | "stale_revision"
  | "invalid_pin"
  | "capability_missing"
  | "relay_binding_unavailable"
  | "duplicate_active"
  | "lockout"
  | "server_activation_failed"
  | "compile_failed";

type WorkstationProfileIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WorkstationProfileIpcFailureCode; message: string };

function profileIpcFailure<T>(
  code: WorkstationProfileIpcFailureCode,
  message: string,
): WorkstationProfileIpcResult<T> {
  return { ok: false, code, message };
}

function workstationProfileActivationErrorMessage(error: string): string {
  if (error === "stale_revision") {
    return "The workstation profile changed. Review the latest profile and try again.";
  }
  if (error === "broader_revision") {
    return "Developer Workstation changed during activation. Disable it, then enable it again.";
  }
  if (error === "duplicate_active") {
    return "Developer Workstation is already active for this account.";
  }
  return error;
}

function profileIpcFailureFromStoreCode(
  code: import("./workstation-profiles/store").WorkstationProfileStoreErrorCode,
): WorkstationProfileIpcFailureCode {
  if (code === "store_unavailable") return "store_unavailable";
  if (code === "store_instance_mismatch") return "store_instance_mismatch";
  return "store_corrupt";
}

interface WorkstationProfileCapabilityEntry {
  readonly id: string;
  readonly backend: import("@nautilo/workstation-profiles").ProfileCapabilityBackend;
}

interface WorkstationProfileSeedDescriptor {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly protectedPolicyVersion: number;
  readonly networkMode: import("@nautilo/workstation-profiles").ProfileNetworkMode;
  readonly discoveryProviders: readonly import("@nautilo/workstation-profiles").ProfileDiscoveryProvider[];
  readonly environmentKeys: readonly string[];
  readonly capabilities: readonly WorkstationProfileCapabilityEntry[];
}

interface WorkstationProfileSummary {
  readonly id: string;
  readonly revision: number;
  readonly name: string;
  readonly protectedPolicyVersion: number;
  readonly networkMode: import("@nautilo/workstation-profiles").ProfileNetworkMode;
  readonly capabilities: readonly WorkstationProfileCapabilityEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ActiveWorkstationProfileSummary {
  readonly profileId: string;
  readonly profileRevision: number;
  readonly protectedPolicyVersion: number;
  readonly networkMode: import("@nautilo/workstation-profiles").ProfileNetworkMode;
  readonly capabilities: readonly WorkstationProfileCapabilityEntry[];
  readonly compiledAt: string;
}

interface WorkstationProfileSeedIdentity {
  readonly id: string;
  readonly revision: number;
  readonly protectedPolicyVersion: number;
}

function redactProfileCapabilities(
  profile: import("@nautilo/workstation-profiles").WorkstationProfile,
): readonly WorkstationProfileCapabilityEntry[] {
  return profile.toolchainCapabilities.map((capability) => ({
    id: capability.id,
    backend: capability.backend,
  }));
}

function buildSeedDescriptor(
  profile: import("@nautilo/workstation-profiles").WorkstationProfile,
): WorkstationProfileSeedDescriptor {
  return {
    id: profile.id,
    revision: profile.revision,
    name: profile.name,
    protectedPolicyVersion: profile.protectedPolicyVersion,
    networkMode: profile.network.mode,
    discoveryProviders: [...profile.discoveryProviders],
    environmentKeys: [...profile.environmentKeys],
    capabilities: redactProfileCapabilities(profile),
  };
}

function buildProfileSummary(
  profile: import("@nautilo/workstation-profiles").WorkstationProfile,
): WorkstationProfileSummary {
  return {
    id: profile.id,
    revision: profile.revision,
    name: profile.name,
    protectedPolicyVersion: profile.protectedPolicyVersion,
    networkMode: profile.network.mode,
    capabilities: redactProfileCapabilities(profile),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

function buildActiveProfileSummary(
  session: import("./workstation-profiles/active-controller").ActiveWorkstationProfileSession,
): ActiveWorkstationProfileSummary {
  return {
    profileId: session.profileId,
    profileRevision: session.profileRevision,
    protectedPolicyVersion: session.protectedPolicyVersion,
    networkMode: session.networkMode,
    capabilities: [...session.capabilities],
    compiledAt: session.compiledAt,
  };
}

/**
 * Materializes the shipped Developer Workstation seed profile for this host
 * (main resolves home + platform itself). Throws on a seed-validation failure
 * (a programming error — the shipped seed must parse). Returns the typed
 * profile + a typed failure for the discovery caller to fold into an IPC code.
 */
function materializeSeedProfileForReview():
  | {
      ok: true;
      profile: import("@nautilo/workstation-profiles").WorkstationProfile;
    }
  | { ok: false; code: "seed_invalid"; message: string } {
  try {
    const profile = developerWorkstationSeedProfile();
    return { ok: true, profile };
  } catch (error) {
    return {
      ok: false,
      code: "seed_invalid",
      message: `Developer Workstation seed rejected: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Runs advisory discovery against the materialized seed profile. Discovery is
 * advisory only and never creates authority; main supplies the real host
 * fs/exec/env seams. A probe failure resolves to a missing/optional review row
 * and never rejects, so a non-throwing failure here is treated as
 * `discovery_failed` only when the adapter itself throws unexpectedly.
 */
async function runSeedDiscoveryReview(
  profile: import("@nautilo/workstation-profiles").WorkstationProfile,
): Promise<
  | { ok: true; review: WorkstationDiscoveryReview }
  | { ok: false; code: "discovery_failed"; message: string }
> {
  try {
    const result = await discoverWorkstationFacts({ profile });
    return { ok: true, review: result.review };
  } catch (error) {
    return {
      ok: false,
      code: "discovery_failed",
      message: `workstation discovery failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

ipcMain.handle("workstationProfiles:getSeedDescriptor", (e) => {
  assertMainWindowSender(e);
  // No renderer-supplied facts: main materializes the seed itself.
  const seed = materializeSeedProfileForReview();
  if (!seed.ok) return profileIpcFailure(seed.code, seed.message);
  return { ok: true, data: buildSeedDescriptor(seed.profile) } as const;
});

ipcMain.handle("workstationProfiles:runDiscoveryReview", async (e) => {
  assertMainWindowSender(e);
  // No renderer-supplied roots/env/executables/facts: main runs discovery.
  const seed = materializeSeedProfileForReview();
  if (!seed.ok) return profileIpcFailure(seed.code, seed.message);
  const review = await runSeedDiscoveryReview(seed.profile);
  if (!review.ok) return profileIpcFailure(review.code, review.message);
  const seedIdentity: WorkstationProfileSeedIdentity = {
    id: seed.profile.id,
    revision: seed.profile.revision,
    protectedPolicyVersion: seed.profile.protectedPolicyVersion,
  };
  return { ok: true, data: { review: review.review, seedIdentity } } as const;
});

ipcMain.handle("workstationProfiles:listProfiles", async (e) => {
  assertMainWindowSender(e);
  // Instance-scoped, not user-scoped. The store is the controller's owned store.
  const listed = await activeWorkstationProfileController
    .getProfileStore()
    .list();
  if (!listed.ok) {
    return profileIpcFailure(
      profileIpcFailureFromStoreCode(listed.code),
      "Workstation profiles could not be read.",
    );
  }
  return {
    ok: true,
    data: {
      profiles: listed.data.profiles.map(buildProfileSummary),
      revision: listed.data.revision,
    },
  } as const;
});

ipcMain.handle("workstationProfiles:getActiveProfileSummary", (e) => {
  assertMainWindowSender(e);
  const session = activeWorkstationProfileController.getActiveSession();
  if (session === null) return { ok: true, data: null } as const;
  return { ok: true, data: buildActiveProfileSummary(session) } as const;
});

/**
 * D418 C4 — read the authoritative server session through Electron main.
 * Failure is intentionally represented as an unconfirmed result, not a local
 * fallback: renderer presentation must never claim an active session without
 * this confirmation.
 */
async function getWorkstationServerSessionStatus() {
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) return { confirmed: false, session: null } as const;
  try {
    const bearerToken = await awaitReadyToWorkValueBounded(
      getValidAccessToken({
        refresh: refreshTokens,
        onObservedRejection: onLogtoRefreshFailed,
      }).catch(() => null),
      5_000,
      null,
    );
    if (!bearerToken) return { confirmed: false, session: null } as const;
    const response = await fetch(
      `${serverUrl.replace(/\/$/, "")}/api/workstation-access/session`,
      {
        signal: AbortSignal.timeout(5_000),
        headers: { authorization: `Bearer ${bearerToken}` },
      },
    );
    if (!response.ok) return { confirmed: false, session: null } as const;
    const body = (await response.json()) as {
      ok?: unknown;
      session?: { profileId?: unknown; profileRevision?: unknown } | null;
    };
    const session = body.session;
    if (
      body.ok !== true ||
      session === null ||
      typeof session?.profileId !== "string" ||
      !Number.isSafeInteger(session.profileRevision)
    ) {
      return { confirmed: true, session: null } as const;
    }
    return {
      confirmed: true,
      session: {
        profileId: session.profileId,
        profileRevision: session.profileRevision,
      },
    } as const;
  } catch {
    return { confirmed: false, session: null } as const;
  }
}

ipcMain.handle("workstationProfiles:getServerSessionStatus", async (e) => {
  assertMainWindowSender(e);
  return await getWorkstationServerSessionStatus();
});

/**
 * D538 — Electron owns the relay/session tuple for uncontained-host-command
 * activation. The renderer may never nominate a relay, desktop session, or
 * bearer token; it can only request status, provide its own PIN, or reduce
 * authority by disabling this exact session.
 */
function uncontainedHostCommandsBinding(): {
  readonly serverUrl: string;
  readonly relayId: string;
  readonly desktopSessionId: string;
} | null {
  const serverUrl = resolvedServerUrl();
  const relayId = getPersistedDesktopRelayId();
  const desktopSessionId = getDesktopSessionId();
  if (!serverUrl || !relayId || !desktopSessionId) return null;
  return { serverUrl, relayId, desktopSessionId };
}

async function uncontainedHostCommandsBearer(): Promise<string | null> {
  return await getValidAccessToken({
    refresh: refreshTokens,
    onObservedRejection: onLogtoRefreshFailed,
  });
}

/**
 * D538's Electron-local pre-spawn fence. The relay client supplies its own
 * run_shell owner tuple; Electron main compares that tuple to this live
 * session, then asks the server for the exact current D538 status. Neither
 * a legacy D486 folder-consent receipt nor a server-provided execution class
 * can pass this check by itself.
 */
async function verifyUncontainedHostCommandsForRelay(binding: {
  readonly instanceId: string;
  readonly userId: string;
  readonly relayId: string;
  readonly desktopSessionId: string | null;
}): Promise<boolean> {
  const current = uncontainedHostCommandsBinding();
  if (
    current === null ||
    binding.instanceId !== desktopInstance.instanceId ||
    binding.relayId !== current.relayId ||
    binding.desktopSessionId === null ||
    binding.desktopSessionId !== current.desktopSessionId
  ) return false;
  const userId = await currentDesktopFilesystemGrantUserId();
  if (userId === null || binding.userId !== userId) return false;
  const bearerToken = await uncontainedHostCommandsBearer();
  if (bearerToken === null) return false;
  try {
    const query = new URLSearchParams({
      relayId: current.relayId,
      desktopSessionId: current.desktopSessionId,
    });
    const response = await fetch(
      `${current.serverUrl.replace(/\/$/, "")}/api/security/uncontained-host-commands/session?${query.toString()}`,
      { headers: { authorization: `Bearer ${bearerToken}` } },
    );
    if (!response.ok) return false;
    const body = await response.json() as { active?: unknown };
    return body.active === true;
  } catch {
    return false;
  }
}

ipcMain.handle("uncontainedHostCommands:getStatus", async (e) => {
  assertMainWindowSender(e);
  const binding = uncontainedHostCommandsBinding();
  if (!binding) {
    return { confirmed: false, active: false, eligible: false, reason: "desktop_binding_unavailable", activatedAt: null } as const;
  }
  const bearerToken = await uncontainedHostCommandsBearer();
  if (!bearerToken) {
    return { confirmed: false, active: false, eligible: false, reason: "authentication_unavailable", activatedAt: null } as const;
  }
  try {
    const query = new URLSearchParams({
      relayId: binding.relayId,
      desktopSessionId: binding.desktopSessionId,
    });
    const response = await fetch(
      `${binding.serverUrl.replace(/\/$/, "")}/api/security/uncontained-host-commands/session?${query.toString()}`,
      { headers: { authorization: `Bearer ${bearerToken}` } },
    );
    if (!response.ok) {
      return { confirmed: false, active: false, eligible: false, reason: "server_status_unavailable", activatedAt: null } as const;
    }
    const body = await response.json() as Record<string, unknown>;
    if (
      typeof body["active"] !== "boolean" ||
      typeof body["eligible"] !== "boolean" ||
      !(typeof body["reason"] === "string" || body["reason"] === null) ||
      !(typeof body["activatedAt"] === "string" || body["activatedAt"] === null)
    ) {
      return { confirmed: false, active: false, eligible: false, reason: "server_status_invalid", activatedAt: null } as const;
    }
    return {
      confirmed: true,
      active: body["active"],
      eligible: body["eligible"],
      reason: body["reason"],
      activatedAt: body["activatedAt"],
    } as const;
  } catch {
    return { confirmed: false, active: false, eligible: false, reason: "server_status_unavailable", activatedAt: null } as const;
  }
});

ipcMain.handle("uncontainedHostCommands:activate", async (e, args: { pin?: unknown }) => {
  assertMainWindowSender(e);
  if (typeof args?.pin !== "string" || args.pin.length === 0) {
    return { ok: false, message: "Enter your own PIN." } as const;
  }
  const binding = uncontainedHostCommandsBinding();
  const bearerToken = await uncontainedHostCommandsBearer();
  if (!binding || !bearerToken) {
    return { ok: false, message: "This Desktop is not connected to an authenticated server session." } as const;
  }
  try {
    const response = await fetch(
      `${binding.serverUrl.replace(/\/$/, "")}/api/security/uncontained-host-commands/activate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({
          pin: args.pin,
          relayId: binding.relayId,
          desktopSessionId: binding.desktopSessionId,
        }),
      },
    );
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || body?.["ok"] !== true) {
      return {
        ok: false,
        message: typeof body?.["error"] === "string" ? body["error"] : "Uncontained host commands could not be activated.",
        ...(typeof body?.["retryAfterMs"] === "number" ? { retryAfterMs: body["retryAfterMs"] } : {}),
      } as const;
    }
    return { ok: true } as const;
  } catch {
    return { ok: false, message: "Uncontained host commands could not be activated." } as const;
  }
});

ipcMain.handle("uncontainedHostCommands:disable", async (e) => {
  assertMainWindowSender(e);
  const binding = uncontainedHostCommandsBinding();
  const bearerToken = await uncontainedHostCommandsBearer();
  if (!binding || !bearerToken) {
    return { ok: false, message: "This Desktop is not connected to an authenticated server session." } as const;
  }
  try {
    const response = await fetch(
      `${binding.serverUrl.replace(/\/$/, "")}/api/security/uncontained-host-commands/disable`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ relayId: binding.relayId, desktopSessionId: binding.desktopSessionId }),
      },
    );
    if (!response.ok) {
      return { ok: false, message: "Uncontained host commands could not be disabled." } as const;
    }
    return { ok: true } as const;
  } catch {
    return { ok: false, message: "Uncontained host commands could not be disabled." } as const;
  }
});

/**
 * D418 — narrow activation-preparation IPC. The renderer supplies NO roots,
 * env, executables, or discovered facts. Electron main materializes the seed
 * profile and runs the advisory discovery adapters itself, returning only the
 * review facts + seed identity for the operator to review before a future
 * Enable-with-PIN step. This does NOT activate the profile, does NOT create or
 * update a stored profile, does NOT grant roots, and does NOT call the server
 * activation route — those are explicit separate flows.
 */
ipcMain.handle("workstationProfiles:prepareActivation", async (e) => {
  assertMainWindowSender(e);
  const seed = materializeSeedProfileForReview();
  if (!seed.ok) return profileIpcFailure(seed.code, seed.message);
  const review = await runSeedDiscoveryReview(seed.profile);
  if (!review.ok) return profileIpcFailure(review.code, review.message);
  return {
    ok: true,
    data: {
      seed: buildSeedDescriptor(seed.profile),
      review: review.review,
    },
  } as const;
});

// ── D418 — Workstation Profile management bridge (narrow, sender-gated) ────
//
// The review/activation-preparation handlers above are read-only / advisory.
// This subsection adds the narrow, safe management operations Settings needs:
//
//   - materializeSeedProfile: idempotently persist the shipped Developer
//     Workstation seed into this instance's profile store if it is absent.
//     A profile is admin CONFIGURATION, never authority by itself, so this
//     creates no grants and compiles nothing. Main materializes the seed
//     itself (renderer never supplies a profile payload). If the seed id is
//     already present the stored profile is returned unchanged.
//   - deactivateActiveProfile: revoke the active session's policy-pack grants
//     and drop the binding. This is the authority-REDUCING direction — it
//     mirrors the existing sign-out / quit / server-switch deactivation paths
//     and adds no authority.
//
// DEFERRED (D418):
//   - selectActiveProfile (activate): NOW IMPLEMENTED below as the
//     PIN/capability proof seam. The activating user's OWN fresh PIN is
//     verified at the authoritative server-side Full Workstation activation
//     boundary (`POST /api/workstation-access/activate-profile`), which also
//     enforces the `use_workstation` capability gate (B3 — D418
//     Commit 1: `control_desktop` is no longer required for activation) +
//     the authoritative relay binding. The desktop compiles the
//     stored profile into live policy-pack / session authority ONLY after a
//     200 server proof success, then re-advertises the relay's redacted
//     profile snapshot via the controller's `onActiveProfileChanged`
//     callback. No offline admin PIN is required or accepted.
//   - updateProfile (profile mutations): mutating admin config that shapes
//     future authority must be guarded by a DISTINCT capability/PIN policy
//     (the activation seam is scoped to selecting an EXISTING stored profile
//     only — it does NOT broaden management authority to profile edits).
//     Profile mutation remains NOT exposed here; see the done-report
//     deferral for the operator decision.
//
// As with the review bridge: the renderer supplies NO roots, env,
// executables, discovered facts, subject, or profile payload. Every handler
// is sender-gated to the mainWindow Workbench renderer.

ipcMain.handle("workstationProfiles:materializeSeedProfile", async (e) => {
  assertMainWindowSender(e);
  // No renderer-supplied profile: main materializes the shipped seed itself.
  const seed = materializeSeedProfileForReview();
  if (!seed.ok) return profileIpcFailure(seed.code, seed.message);
  const store = activeWorkstationProfileController.getProfileStore();
  // Idempotent: if the seed id is already stored, return the stored summary.
  const existing = await store.get({ profileId: seed.profile.id });
  if (existing.ok) {
    // Refresh the store revision so Settings can optimistic-concurrency gate
    // a future (deferred) mutation. The stored profile is returned as-is.
    const listed = await store.list();
    if (!listed.ok) {
      return profileIpcFailure(
        profileIpcFailureFromStoreCode(listed.code),
        "Workstation profiles could not be read.",
      );
    }
    return {
      ok: true,
      data: {
        profile: buildProfileSummary(existing.data.profile),
        created: false,
        revision: listed.data.revision,
      },
    } as const;
  }
  // A real store error (not "absent") — surface it, never persist blindly.
  if (existing.code !== "profile_not_found") {
    return profileIpcFailure(
      profileIpcFailureFromStoreCode(existing.code),
      "Workstation profiles could not be read.",
    );
  }
  const created = await store.create({ profile: seed.profile });
  if (!created.ok) {
    // A duplicate-id race after the get check is benign — re-read and return
    // the existing stored profile rather than failing the idempotent call.
    if (created.code === "invalid_profile") {
      const reread = await store.get({ profileId: seed.profile.id });
      if (reread.ok) {
        const listed = await store.list();
        if (listed.ok) {
          return {
            ok: true,
            data: {
              profile: buildProfileSummary(reread.data.profile),
              created: false,
              revision: listed.data.revision,
            },
          } as const;
        }
      }
    }
    return profileIpcFailure(
      profileIpcFailureFromStoreCode(created.code),
      "Developer Workstation seed could not be persisted.",
    );
  }
  return {
    ok: true,
    data: {
      profile: buildProfileSummary(created.data.profile),
      created: true,
      revision: created.data.revision,
    },
  } as const;
});

ipcMain.handle("workstationProfiles:deactivateActiveProfile", async (e) => {
  assertMainWindowSender(e);
  // No renderer-supplied subject / grantIds: the controller revokes the
  // session it owns. This is authority-reducing only; it adds no authority.

  // B3 (D418 Commit 1) — best-effort server-side Full Workstation session
  // teardown. POST to the authoritative `/api/workstation-access/disable`
  // route with the user's Logto bearer token. The server route is
  // authenticated + user-bound + idempotent + capability-independent (B3),
  // so a user whose capability was revoked mid-session can still tear down
  // their own server-side session (the one the approval override reads).
  // This is BEST-EFFORT ONLY: a network / server failure or a missing token
  // / server URL NEVER blocks local deactivation — the local
  // `ActiveWorkstationProfileController` remains the fail-closed authority
  // for the desktop's policy-pack grants. A stale server session left by a
  // failed teardown is reconciled by the next local activate / server
  // switch / sign-out. No PIN, command output, or secret is sent.
  const serverUrl = resolvedServerUrl();
  if (serverUrl) {
    try {
      const bearerToken = await getValidAccessToken({
        refresh: refreshTokens,
        onObservedRejection: onLogtoRefreshFailed,
      });
      if (bearerToken) {
        await disableWorkstationProfileViaServer({
          serverUrl,
          bearerToken,
        });
      }
    } catch {
      // Swallow — local deactivation must proceed regardless.
    }
  }

  const deactivated = await activeWorkstationProfileController.deactivate();
  if (deactivated.ok) {
    return {
      ok: true,
      data: {
        cleared: deactivated.data.cleared,
        skipped: [...deactivated.data.skipped],
      },
    } as const;
  }
  // The only controller-side failure is `no_active_profile`, a benign no-op.
  if (deactivated.code === "no_active_profile") {
    return {
      ok: true,
      data: { cleared: 0, skipped: [] as readonly string[] },
    } as const;
  }
  return profileIpcFailure(
    "invalid_request",
    "The active workstation profile could not be deactivated.",
  );
});

// ── D418 — Workstation Profile activation seam (selectActiveProfile) ────────
//
// The narrow IPC that unblocks activation of an approved stored Workstation
// Profile. The renderer supplies ONLY the selected stored profile's id +
// exact revision + the activating user's OWN fresh PIN. Electron main:
//
//   1. Looks up the stored profile + verifies the requested revision EXACTLY
//      matches the stored profile's revision (the "wrong revision" rejection
//      happens here, desktop-side, before any server call).
//   2. Builds the relay binding evidence (relayId, desktopSessionId,
//      instanceId) from authoritative main-side state — NEVER from the
//      renderer.
//   3. POSTs { pin, profileId, profileRevision, relayId, desktopSessionId,
//      instanceId } to the server `/api/workstation-access/activate-profile`
//      route with the user's Logto bearer token. The server verifies the
//      `use_workstation` capability gate (B3 — D418 Commit 1:
//      `control_desktop` is no longer required for activation), the
//      user's OWN fresh PIN proof, and the authoritative relay binding
//      (userId / relayId / desktopSessionId / instanceId / serverBindingId /
//      capabilityRevision / grantIds) derived from the relay registry. A
//      client flag alone cannot activate; a renderer-supplied capability
//      claim is never trusted.
//   4. ONLY on a 200 server proof success: compiles the stored profile into
//      live policy-pack / session authority via the active-profile
//      controller. The controller's `onActiveProfileChanged` callback
//      re-advertises the relay's redacted profile snapshot atomically. A
//      failed compile adds no authority (the compiler is fail-closed) and
//      is surfaced as a typed failure.
//   5. Returns a redacted active-profile summary (no subject, no grantIds,
//      no roots, no env, no executable paths) or a typed failure code.
//
// The renderer NEVER submits roots, env, executable rules, grants, subject
// identity, or an arbitrary profile payload. Every authority-bearing field
// is server-derived; the desktop main supplies only profile selectors +
// relay binding evidence + PIN. No offline admin PIN is required or
// accepted — the proof is the activating user's OWN PIN verified at the
// authoritative server boundary.

/** Shape of the server `/activate-profile` response body the seam parses. */
type WorkstationProfileServerActivationResponse = {
  ok?: boolean;
  authorization?: string;
  expiresAt?: string;
  outcome?: string;
  session?: {
    serverBindingId?: string;
    profileId?: string;
    profileRevision?: number;
  } | null;
  error?: string;
  retryAfterMs?: number;
  capability?: string;
  startupReceipt?: string;
};

/** Result of the server-activation seam (parsed + normalized, no PIN leak). */
type WorkstationProfileServerActivationResult =
  | {
      ok: true;
      authorization: string;
      startupReceipt?: string;
    }
  | {
      ok: false;
      status: number;
      error: string;
      retryAfterMs?: number;
      capability?: string;
    };

/**
 * D418 — the main→server activation seam. POSTs the profile selectors +
 * relay binding evidence + the activating user's OWN PIN to the
 * authoritative server `/api/workstation-access/activate-profile` route
 * with the user's Logto bearer token, then parses + normalizes the
 * response. Never throws on HTTP/network failure — returns a typed
 * `ok:false` so the handler can map it to an IPC failure code. No PIN,
 * command output, or secret is logged or returned beyond the typed
 * outcome/session shape.
 */
async function activateWorkstationProfileViaServer(input: {
  readonly serverUrl: string;
  readonly bearerToken: string;
  readonly proof:
    | Readonly<{ pin: string }>
    | Readonly<{ startupReceipt: string }>;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly relayId: string;
  readonly desktopSessionId: string;
  readonly instanceId: string;
  readonly timeoutMs?: number;
}): Promise<WorkstationProfileServerActivationResult> {
  let resp: Response;
  try {
    resp = await fetch(
      `${input.serverUrl.replace(/\/$/, "")}/api/workstation-access/activate-profile`,
      {
        method: "POST",
        ...(input.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(input.timeoutMs) }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.bearerToken}`,
        },
        body: JSON.stringify({
          ...input.proof,
          profileId: input.profileId,
          profileRevision: input.profileRevision,
          relayId: input.relayId,
          desktopSessionId: input.desktopSessionId,
          instanceId: input.instanceId,
        }),
      },
    );
  } catch (err) {
    return {
      ok: false,
      status: -1,
      error: `workstation profile activation network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  let body: WorkstationProfileServerActivationResponse | null = null;
  try {
    body = (await resp.json()) as WorkstationProfileServerActivationResponse;
  } catch {
    body = null;
  }
  if (!resp.ok || body === null || body.ok !== true) {
    return {
      ok: false,
      status: resp.status,
      error:
        body?.error ?? `workstation profile activation failed: ${resp.status}`,
      ...(body?.retryAfterMs !== undefined
        ? { retryAfterMs: body.retryAfterMs }
        : {}),
      ...(body?.capability !== undefined
        ? { capability: body.capability }
        : {}),
    };
  }
  if (
    typeof body.authorization !== "string" ||
    body.authorization.length === 0
  ) {
    return {
      ok: false,
      status: resp.status,
      error: "workstation profile activation returned no authorization",
    };
  }
  return {
    ok: true,
    authorization: body.authorization,
  };
}

/** Complete a pending authorization with the ticket only: no PIN/binding. */
async function completeWorkstationProfileActivation(input: {
  readonly serverUrl: string;
  readonly bearerToken: string;
  readonly authorization: string;
  readonly timeoutMs?: number;
}): Promise<WorkstationProfileServerActivationResult> {
  try {
    const resp = await fetch(
      `${input.serverUrl.replace(/\/$/, "")}/api/workstation-access/activate-profile/complete`,
      {
        method: "POST",
        ...(input.timeoutMs === undefined
          ? {}
          : { signal: AbortSignal.timeout(input.timeoutMs) }),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.bearerToken}`,
        },
        body: JSON.stringify({ authorization: input.authorization }),
      },
    );
    const body =
      (await resp.json()) as WorkstationProfileServerActivationResponse;
    if (!resp.ok || body.ok !== true) {
      return {
        ok: false,
        status: resp.status,
        error: body.error ?? `activation completion failed: ${resp.status}`,
      };
    }
    return {
      ok: true,
      authorization: input.authorization,
      ...(typeof body.startupReceipt === "string" && body.startupReceipt.length > 0
        ? { startupReceipt: body.startupReceipt }
        : {}),
    };
  } catch (err) {
    return {
      ok: false,
      status: -1,
      error: `activation completion network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * B3 (D418 Commit 1) — best-effort server-side Full Workstation session
 * disable. POSTs to the authoritative `/api/workstation-access/disable`
 * route with the user's Logto bearer token. The server route is
 * authenticated + user-bound + idempotent + capability-independent (B3): it
 * tears down the server-side session that the approval override reads, and a
 * user whose capability was revoked mid-session can still disable their own
 * session. The body is empty — the server derives the userId from the
 * session token.
 *
 * This call is BEST-EFFORT ONLY. It never throws and its failure NEVER
 * blocks local deactivation: the local `ActiveWorkstationProfileController`
 * remains the fail-closed authority for the desktop's policy-pack grants.
 * The caller wraps the await in its own try/catch too, so a thrown error
 * here is doubly contained. No PIN, command output, or secret is sent or
 * returned. A stale server session left by a failed teardown is reconciled
 * by the next local activate / server switch / sign-out.
 */
async function disableWorkstationProfileViaServer(input: {
  readonly serverUrl: string;
  readonly bearerToken: string;
}): Promise<void> {
  try {
    await fetch(
      `${input.serverUrl.replace(/\/$/, "")}/api/workstation-access/disable`,
      {
        method: "POST",
        signal: AbortSignal.timeout(1_500),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${input.bearerToken}`,
        },
        body: JSON.stringify({}),
      },
    );
  } catch {
    // Swallow — local deactivation proceeds regardless of server availability.
  }
}

/** Ensure the one shipped Developer Workstation profile exists locally. */
async function readyToWorkProfileSelectors(): Promise<
  | Readonly<{ ok: true; profileId: string; profileRevision: number }>
  | Readonly<{ ok: false; code: WorkstationProfileIpcFailureCode; message: string }>
> {
  const seed = materializeSeedProfileForReview();
  if (!seed.ok) return seed;
  const store = activeWorkstationProfileController.getProfileStore();
  let stored = await store.get({ profileId: seed.profile.id });
  if (!stored.ok && stored.code === "profile_not_found") {
    const created = await store.create({ profile: seed.profile });
    if (!created.ok) {
      stored = await store.get({ profileId: seed.profile.id });
    } else {
      return {
        ok: true,
        profileId: created.data.profile.id,
        profileRevision: created.data.profile.revision,
      };
    }
  }
  if (!stored.ok) {
    return {
      ok: false,
      code: stored.code === "profile_not_found"
        ? "profile_not_found"
        : profileIpcFailureFromStoreCode(stored.code),
      message: "Developer Workstation profile could not be read.",
    };
  }
  return {
    ok: true,
    profileId: stored.data.profile.id,
    profileRevision: stored.data.profile.revision,
  };
}

async function activateStoredWorkstationProfile(
  args: Readonly<{
    profileId?: unknown;
    profileRevision?: unknown;
    proof?: unknown;
    networkTimeoutMs?: number;
  }>,
): Promise<WorkstationProfileIpcResult<Readonly<{
  summary: ActiveWorkstationProfileSummary;
  outcome: string;
  startupReceipt?: string;
}>>> {
    // The caller supplies only profile selectors plus one opaque proof.
    if (
      typeof args?.profileId !== "string" ||
      args.profileId.trim().length === 0 ||
      typeof args?.profileRevision !== "number" ||
      !Number.isSafeInteger(args.profileRevision) ||
      args.profileRevision < 1 ||
      typeof args?.proof !== "object" || args.proof === null || Array.isArray(args.proof) ||
      !((Object.keys(args.proof).length === 1 && typeof (args.proof as { pin?: unknown }).pin === "string" &&
          ((args.proof as { pin: string }).pin.length > 0)) ||
        (Object.keys(args.proof).length === 1 && typeof (args.proof as { startupReceipt?: unknown }).startupReceipt === "string" &&
          ((args.proof as { startupReceipt: string }).startupReceipt.length > 0)))
    ) {
      return profileIpcFailure(
        "invalid_request",
        "workstation activation requires profile selectors and exactly one proof",
      );
    }
    const profileId = args.profileId;
    const profileRevision = args.profileRevision;
    const proof = args.proof as { pin: string } | { startupReceipt: string };

    // 1. Look up the stored profile + verify the requested revision EXACTLY
    //    matches the stored profile's revision. The renderer never supplies
    //    profile content — only the id + revision of an EXISTING stored
    //    profile. A mismatch is the "wrong revision" rejection.
    const store = activeWorkstationProfileController.getProfileStore();
    const stored = await store.get({ profileId });
    if (!stored.ok) {
      if (stored.code === "profile_not_found") {
        return profileIpcFailure(
          "profile_not_found",
          "profile not found in this instance store",
        );
      }
      return profileIpcFailure(
        profileIpcFailureFromStoreCode(stored.code),
        "workstation profile store could not be read",
      );
    }
    if (stored.data.profile.revision !== profileRevision) {
      return profileIpcFailure(
        "stale_revision",
        "requested profileRevision does not match the stored profile revision",
      );
    }
    const profile = stored.data.profile;

    // 2. Build the relay binding evidence from authoritative main-side
    //    state. The renderer never supplies these.
    const relayId = getPersistedDesktopRelayId();
    if (relayId === null) {
      return profileIpcFailure(
        "no_relay",
        "no persisted desktop relay id is available",
      );
    }
    const desktopSessionId = mintDesktopSessionId();
    const instanceId = desktopInstance.instanceId;

    // 3. Server proof flow — the authoritative gate. Requires a resolved
    //    server URL + the user's Logto access token.
    const serverUrl = resolvedServerUrl();
    if (!serverUrl) {
      return profileIpcFailure(
        "no_server",
        "no server connection is available",
      );
    }
    const tokenPromise = getValidAccessToken({
        refresh: refreshTokens,
        onObservedRejection: onLogtoRefreshFailed,
      }).catch(() => null);
    const bearerToken = args.networkTimeoutMs === undefined
      ? await tokenPromise
      : await awaitReadyToWorkValueBounded(tokenPromise, args.networkTimeoutMs, null);
    if (bearerToken === null) {
      return profileIpcFailure(
        "server_activation_failed",
        "could not obtain an authenticated server token",
      );
    }

    const serverResult = await activateWorkstationProfileViaServer({
      serverUrl,
      bearerToken,
      proof,
      profileId,
      profileRevision,
      relayId,
      desktopSessionId,
      instanceId,
      ...(args.networkTimeoutMs === undefined ? {} : { timeoutMs: args.networkTimeoutMs }),
    });

    if (!serverResult.ok) {
      // Map the server denial to a typed IPC failure. NO compile / activate
      // happens on any server failure — the desktop adds no authority until
      // the server proof succeeds.
      const status = serverResult.status;
      if (status === 401) {
        return profileIpcFailure("invalid_pin", serverResult.error);
      }
      if (status === 403) {
        return profileIpcFailure("capability_missing", serverResult.error);
      }
      if (status === 404) {
        return profileIpcFailure(
          "relay_binding_unavailable",
          serverResult.error,
        );
      }
      if (status === 409) {
        if (serverResult.error === "stale_revision") {
          return profileIpcFailure(
            "stale_revision",
            workstationProfileActivationErrorMessage(serverResult.error),
          );
        }
        return profileIpcFailure(
          "duplicate_active",
          workstationProfileActivationErrorMessage(serverResult.error),
        );
      }
      if (status === 429) {
        return profileIpcFailure("lockout", serverResult.error);
      }
      return profileIpcFailure("server_activation_failed", serverResult.error);
    }

    // 4. Server proof succeeded — compile the EXACT stored profile into live
    //    policy-pack / session authority. The subject is derived from
    //    authoritative main-side identity (userId from the relay pairing),
    //    never from the renderer.
    const userId = await currentDesktopFilesystemGrantUserId();
    if (userId === null) {
      // Server proof succeeded but the desktop cannot resolve its own relay
      // user identity — do NOT compile. Surface as a typed failure.
      return profileIpcFailure(
        "no_user",
        "could not resolve the desktop relay user identity",
      );
    }
    const subject: import("@nautilo/desktop-filesystem-grants").DesktopFilesystemGrantSubject =
      {
        userId,
        instanceId,
        relayId,
        agentScope: DESKTOP_FILESYSTEM_GRANT_AGENT_SCOPE,
      };

    let factsResult: Awaited<ReturnType<typeof discoverWorkstationFacts>>;
    try {
      factsResult = await discoverWorkstationFacts({ profile });
    } catch (err) {
      return profileIpcFailure(
        "discovery_failed",
        `workstation discovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const activated = await activeWorkstationProfileController.activate({
      profileId,
      facts: factsResult.facts,
      subject,
    });
    if (!activated.ok) {
      // Phase one issued only a pending ticket, never a server session.
      // The compiler is fail-closed, so this leaves neither authority nor
      // an active Full Workstation session.
      return profileIpcFailure(
        "compile_failed",
        `profile compile rejected: ${activated.code}`,
      );
    }

    // 5. Explicitly await the relay update ACK. The controller callback is
    // fire-and-forget for existing callers, so it is not sufficient here.
    // If acknowledgement fails, revoke local compiled authority and await a
    // removal advertisement before surfacing the failed attempt.
    const advertisement = refreshDesktopRelayCapabilities("workstation profile activation complete");
    const advertised = args.networkTimeoutMs === undefined
      ? await advertisement
      : await awaitReadyToWorkValueBounded(advertisement, args.networkTimeoutMs, false);
    if (!advertised) {
      await activeWorkstationProfileController.deactivate();
      const rollback = refreshDesktopRelayCapabilities("workstation profile activation rollback");
      if (args.networkTimeoutMs === undefined) await rollback;
      else await awaitReadyToWorkBounded(rollback, args.networkTimeoutMs);
      return profileIpcFailure(
        "server_activation_failed",
        "relay capability advertisement was not acknowledged",
      );
    }
    const completed = await completeWorkstationProfileActivation({
      serverUrl,
      bearerToken,
      authorization: serverResult.authorization,
      ...(args.networkTimeoutMs === undefined ? {} : { timeoutMs: args.networkTimeoutMs }),
    });
    if (!completed.ok) {
      await activeWorkstationProfileController.deactivate();
      const rollback = refreshDesktopRelayCapabilities("workstation profile completion rollback");
      if (args.networkTimeoutMs === undefined) await rollback;
      else await awaitReadyToWorkBounded(rollback, args.networkTimeoutMs);
      return profileIpcFailure(
        "server_activation_failed",
        workstationProfileActivationErrorMessage(completed.error),
      );
    }

    // 6. Completion atomically consumes the ticket and commits the server
    // session; return only a redacted local summary.
    return {
      ok: true,
      data: {
        summary: buildActiveProfileSummary(activated.data.session),
        outcome: "activated",
        ...(completed.startupReceipt === undefined
          ? {}
          : { startupReceipt: completed.startupReceipt }),
      },
    } as const;
}

ipcMain.handle(
  "workstationProfiles:selectActiveProfile",
  async (e, args: { profileId?: unknown; profileRevision?: unknown; pin?: unknown }) => {
    assertMainWindowSender(e);
    const activated = await activateStoredWorkstationProfile({
      profileId: args?.profileId,
      profileRevision: args?.profileRevision,
      proof: { pin: args?.pin },
    });
    if (!activated.ok) return activated;
    // The opaque startup receipt is main-only and never crosses this existing
    // renderer surface.
    return {
      ok: true,
      data: {
        summary: activated.data.summary,
        outcome: activated.data.outcome,
      },
    } as const;
  },
);

ipcMain.handle("app:getVersion", () => nautiloAppVersion());
// D103 — updater IPC is intentionally argument-free. These handlers expose a
// renderer-safe status projection and a request to open the native flow; feed
// selection, downloading, dialogs, and installation remain exclusively main.
ipcMain.handle("updates:get-status", (e) => {
  assertMainWindowSender(e);
  return updateController.getSanitizedStatus();
});
ipcMain.handle("updates:open", (e) => {
  assertMainWindowSender(e);
  void updateController.openUpdateFlow();
});
ipcMain.handle("updates:subscribe", (e) => {
  assertMainWindowSender(e);
  addUpdateStatusSubscriber(e.sender);
  const status = updateController.getSanitizedStatus();
  // The preload registers its listener before this request. Sending directly
  // returns an initial snapshot to this verified Workbench sender, while
  // subsequent state changes broadcast only through `broadcastUpdaterStatus`.
  e.sender.send("updates:status", status);
});
ipcMain.handle("workbench:reload", async (e) => {
  assertMainWindowSender(e);
  // Reload only the Workbench renderer. Main-process Logto token storage and
  // the Electron session survive, unlike an app relaunch.
  // Paint the cover in the still-live renderer first; after unload, the
  // BrowserWindow background prevents Chromium's default white flash.
  await e.sender.executeJavaScript(RELOAD_COVER_SCRIPT).catch(() => {});
  e.sender.reload();
});
ipcMain.handle("relay:getStatus", () => getRelayStatus());

/**
 * D423 4.1.3 — expose the persisted Electron relay identity to the Workbench
 * renderer. Reads the SAME tuple-scoped relay-id file `startRelay` persists (via
 * `resolvePersistedRelayId` in `./relay.ts`); NEVER generates a replacement —
 * the renderer must obtain the persisted id, not invent one. Returns
 * `{ relayId: null }` when the relay has not yet been started (file missing /
 * unreadable); the renderer's local-file focus ref then fails closed at send
 * time because the server-side resolver validates the ref's `relayId` against
 * the connected-relay registry. The persisted id is private run metadata; it
 * never reaches model prompt prose (the resolver keeps it in `locator` only).
 */
ipcMain.handle("relay:getIdentity", (e) => {
  assertMainWindowSender(e);
  return { relayId: getPersistedDesktopRelayId() };
});

ipcMain.handle(
  "ordinaryChat:sendRoomMessage",
  async (
    e,
    args: {
      roomId?: unknown;
      body?: unknown;
    },
  ) => {
    const senderSession = resolveSessionFromSender(e);
    if (
      typeof args?.roomId !== "string" ||
      args.roomId.length < 1 ||
      args.roomId.length > 200 ||
      typeof args.body !== "object" ||
      args.body === null ||
      Array.isArray(args.body)
    )
      throw new Error("Invalid ordinary Room message request.");

    const relayId = getPersistedDesktopRelayId();
    const desktopSessionId = getDesktopSessionId();
    const relayToken = loadRelayToken(senderSession.serverUrl);
    const accessToken = await getValidAccessToken({
      refresh: refreshTokens,
      onObservedRejection: onLogtoRefreshFailed,
    });
    if (!relayId || !desktopSessionId || !relayToken || !accessToken) {
      throw new Error("Desktop origin is unavailable.");
    }

    const roomId = args.roomId;
    const rendererBody = structuredClone(args.body);
    // JSON omission/null semantics belong at this renderer-to-main boundary.
    // The resulting value is the exact value both credentialed and sent, so a
    // Writer selection's optional tableCellRange cannot split the digest from
    // the request body. Rejections remain the helper's value-free path/class
    // diagnostic; do not log or rewrite potentially private message content.
    const normalizedBody = normalizeRemoteOrdinaryRequestBody(
      rendererBody,
    ) as unknown as Parameters<NautiloApiClient["sendRoomMessage"]>[1];
    const path = `/api/rooms/${encodeURIComponent(roomId)}/messages`;
    const bodySha256 = createHash("sha256")
      .update(canonicalRemoteOrdinaryRequestBody(normalizedBody), "utf8")
      .digest("hex");
    const client = new NautiloApiClient(
      senderSession.serverUrl.replace(/\/$/, ""),
    );
    client.setToken(accessToken);
    const issued = await client.mintElectronOriginCredential(
      {
        requestId: randomUUID(),
        relayId,
        desktopSessionId,
        method: "POST",
        path,
        bodySha256,
      },
      relayToken,
    );
    return client.sendRoomMessage(roomId, normalizedBody, {
      electronOriginCredential: issued.credential,
    });
  },
);

type BoundForegroundShadowController = Readonly<{
  senderId: number;
  serverScope: string;
  userId: string;
  humanActorId: string;
  sender: Electron.WebContents;
  onSenderDestroyed: () => void;
  controller: ElectronForegroundShadowController;
}>;

const foregroundShadowControllers = new Map<
  number,
  Promise<BoundForegroundShadowController>
>();

function validatedForegroundShadowSibling(value: unknown): MessagePayloadV2 {
  const encoded = encodeMessagePayloadV2(value as MessagePayloadV2);
  encoded.fill(0);
  return value as MessagePayloadV2;
}

async function disposeForegroundShadowController(senderId: number): Promise<void> {
  const pending = foregroundShadowControllers.get(senderId);
  if (pending === undefined) return;
  foregroundShadowControllers.delete(senderId);
  try {
    const bound = await pending;
    bound.sender.removeListener("destroyed", bound.onSenderDestroyed);
    await bound.controller.dispose();
  } catch (error) {
    log.warn("[desktop][foreground-shadow] controller disposal failed", {
      senderId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function disposeAllForegroundShadowControllers(): Promise<void> {
  await Promise.all(
    [...foregroundShadowControllers.keys()].map(
      async (senderId) => await disposeForegroundShadowController(senderId),
    ),
  );
}

async function foregroundShadowControllerForSender(
  e: Electron.IpcMainInvokeEvent,
): Promise<BoundForegroundShadowController> {
  const session = resolveSessionFromSender(e);
  const senderId = e.sender.id;
  const current = foregroundShadowControllers.get(senderId);
  if (current !== undefined) {
    const bound = await current;
    if (bound.serverScope === session.scope) return bound;
    await disposeForegroundShadowController(senderId);
  }

  const creating = (async (): Promise<BoundForegroundShadowController> => {
    const api = await remoteControlClientForSender(e);
    const viewer = await api.whoami();
    if (viewer.sessionUserId === null || viewer.sessionActorId === null) {
      throw new Error("Desktop foreground encryption requires a Human session.");
    }
    const serverScope = session.serverUrl.replace(/\/$/u, "");
    const userId = viewer.sessionUserId;
    const humanActorId = viewer.sessionActorId;
    const cryptoDirectory = path.join(
      app.getPath("userData"),
      "crypto-client",
    );
    const controller = createElectronForegroundShadowController({
      api: api as ElectronForegroundShadowApi,
      isBindingCurrent: () => {
        if (e.sender.isDestroyed()) return false;
        const active = serverSessions.active;
        const currentSession = serverSessions.getBySender(senderId);
        return active?.scope === session.scope
          && active.view?.webContents.id === senderId
          && currentSession?.scope === session.scope
          && currentSession.signedIn;
      },
      isAccountCurrent: async () => {
        if (e.sender.isDestroyed()) return false;
        const active = serverSessions.active;
        const currentSession = serverSessions.getBySender(senderId);
        if (!(active?.scope === session.scope
          && active.view?.webContents.id === senderId
          && currentSession?.scope === session.scope
          && currentSession.signedIn)) return false;
        const currentViewer = await api.whoami();
        return currentViewer.sessionUserId === userId
          && currentViewer.sessionActorId === humanActorId;
      },
      refreshBearer: () => getValidAccessToken({
        refresh: refreshTokens,
        onObservedRejection: onLogtoRefreshFailed,
      }),
      sendRoomMessage: createDesktopForegroundShadowOriginSender({
        api,
        resolveOriginAuthority: () => {
          const relayId = getPersistedDesktopRelayId();
          const desktopSessionId = getDesktopSessionId();
          const relayToken = loadRelayToken(session.serverUrl);
          return relayId && desktopSessionId && relayToken
            ? { relayId, desktopSessionId, relayToken }
            : null;
        },
      }),
      serverScope,
      userId,
      humanActorId,
      installationId: readOrCreateDesktopCryptoInstallationId({
        directory: cryptoDirectory,
        account: { serverScope, userId, humanActorId },
        fallbackInstallationId: getOrCreateInstallationId(),
      }),
      directory: cryptoDirectory,
      safeStorage,
      normalizeContent: normalizeHumanMessageText,
      onProtectedRoomAccessState: (state) => {
        if (!e.sender.isDestroyed()) {
          e.sender.send("foregroundShadow:protectedRoomAccess", state);
        }
      },
    });
    api.setDeviceAdmissionRequiredHandler(() => {
      void disposeForegroundShadowController(senderId);
    });
    const onSenderDestroyed = () => {
      void disposeForegroundShadowController(senderId);
    };
    const bound = Object.freeze({
      senderId,
      serverScope: session.scope,
      userId,
      humanActorId,
      sender: e.sender,
      onSenderDestroyed,
      controller,
    });
    e.sender.once("destroyed", onSenderDestroyed);
    return bound;
  })();
  foregroundShadowControllers.set(senderId, creating);
  try {
    return await creating;
  } catch (error) {
    if (foregroundShadowControllers.get(senderId) === creating) {
      foregroundShadowControllers.delete(senderId);
    }
    throw error;
  }
}

ipcMain.handle("foregroundShadow:inspect", async (e) => {
  const { controller } = await foregroundShadowControllerForSender(e);
  return Object.freeze({ status: "ready" as const, deviceId: controller.deviceId });
});

ipcMain.handle("foregroundShadow:memory:list", async (e, raw: unknown) => {
  const options = boundedForegroundShadowValue(raw, "Protected Memory list") as
    Parameters<ElectronForegroundShadowController["memoryList"]>[0];
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryList(options);
});

ipcMain.handle("foregroundShadow:memory:search", async (e, raw: unknown) => {
  const options = boundedForegroundShadowValue(raw, "Protected Memory search") as
    Parameters<ElectronForegroundShadowController["memorySearch"]>[0];
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memorySearch(options);
});

ipcMain.handle("foregroundShadow:memory:detail", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory detail") as
    { memoryId?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryDetail(memoryId);
});

ipcMain.handle("foregroundShadow:memory:update", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory update") as {
    memoryId?: unknown; type?: unknown; content?: unknown; importance?: unknown;
  };
  const input = Object.freeze({
    memoryId: foregroundShadowString(value.memoryId, "Memory id", 200),
    type: foregroundShadowString(value.type, "Memory type", 4_096),
    content: foregroundShadowString(value.content, "Memory content", 65_536),
    importance: value.importance,
  });
  if (typeof input.importance !== "number" || !Number.isFinite(input.importance)
    || input.importance < 0 || input.importance > 1) {
    throw new TypeError("Memory importance is invalid");
  }
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryUpdate({ ...input, importance: input.importance });
});

ipcMain.handle("foregroundShadow:memory:retryPending", async (e) => {
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryRetryPending();
});

ipcMain.handle("foregroundShadow:memory:archive", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory archive") as
    { memoryId?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryArchive(memoryId);
});

ipcMain.handle("foregroundShadow:memory:restore", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory restore") as
    { memoryId?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryRestore(memoryId);
});

ipcMain.handle("foregroundShadow:memory:tier", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory tier") as
    { memoryId?: unknown; action?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  if (value.action !== "promote" && value.action !== "demote") {
    throw new TypeError("Memory tier action is invalid");
  }
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryTransitionTier(memoryId, value.action);
});

ipcMain.handle("foregroundShadow:memory:deleteAuthorizedView", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory delete view") as
    { memoryId?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryDeleteAuthorizedView(memoryId);
});

ipcMain.handle("foregroundShadow:memory:grantUser", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory user grant") as
    { memoryId?: unknown; userHandle?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const userHandle = foregroundShadowString(value.userHandle, "User handle", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryGrantUser(memoryId, userHandle);
});

ipcMain.handle("foregroundShadow:memory:revokeUser", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory user revoke") as
    { memoryId?: unknown; userHandle?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const userHandle = foregroundShadowString(value.userHandle, "User handle", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryRevokeUser(memoryId, userHandle);
});

ipcMain.handle("foregroundShadow:memory:makePrivate", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Protected Memory make private") as
    { memoryId?: unknown };
  const memoryId = foregroundShadowString(value.memoryId, "Memory id", 200);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.memoryMakePrivate(memoryId);
});

ipcMain.handle("foregroundShadow:send", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Foreground Shadow send") as {
    roomId?: unknown;
    body?: unknown;
  };
  const roomId = foregroundShadowString(value?.roomId, "Room id", 200);
  if (typeof value?.body !== "object" || value.body === null
    || Array.isArray(value.body)) {
    throw new Error("Foreground Shadow message body is invalid.");
  }
  // Reject non-JSON/cyclic/over-deep renderer bodies before a controller can
  // unlock custody. The protected sender later normalizes its augmented final
  // body once more immediately before hashing and posting it.
  const body = normalizeRemoteOrdinaryRequestBody(value.body) as unknown as
    Parameters<ElectronForegroundShadowController["send"]>[1];
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.send(roomId, body);
});

ipcMain.handle("foregroundShadow:recoverPending", async (e) => {
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.recoverPending();
});

ipcMain.handle("foregroundShadow:recoverRoomPendingAttention", async (e, raw: unknown) => {
  const input = parseForegroundShadowPendingAttention(raw);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.recoverRoomPendingAttention(input);
});

ipcMain.handle("foregroundShadow:edit", async (e, raw: unknown) => {
  const { roomId, messageId, body } = parseForegroundShadowEdit(raw);
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.edit(roomId, messageId, body);
});

ipcMain.handle("foregroundShadow:authorize", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(
    raw,
    "Foreground Shadow authorization",
  ) as { event?: unknown };
  const event = parseLiveShadowMessageRealtimeEventV1(
    value?.event,
  );
  if (
    event.type !== "message.shared_agent_authorization_required"
    && event.type !== "message.runtime_invocation_authorization_required"
  ) throw new Error("Foreground Shadow authorization kind is unsupported.");
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.authorizeSharedAgentExecution(event);
});

function logForegroundShadowReceiveResult(
  kind: "standard" | "human_peer" | "shared_agent" | "shared_agent_output",
  eventType: string,
  result: unknown,
): void {
  const record = typeof result === "object" && result !== null
    ? result as { status?: unknown; reason?: unknown; checkpoint?: unknown }
    : null;
  log.info("[desktop][foreground-shadow] receive", {
    kind,
    eventType,
    status: typeof record?.status === "string" ? record.status : "null",
    ...(typeof record?.reason === "string" ? { reason: record.reason } : {}),
    ...(typeof record?.checkpoint === "string"
      ? { checkpoint: record.checkpoint }
      : {}),
  });
}

ipcMain.handle("foregroundShadow:receive", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(raw, "Foreground Shadow receive") as {
    kind?: unknown;
    event?: unknown;
    ordinarySibling?: unknown;
  };
  const event = typeof value.event === "object" && value.event !== null
      && "wireVersion" in value.event && value.event.wireVersion === 2
    ? parseFullEncryptionMessageRealtimeContentEventV2(value.event)
    : parseLiveShadowMessageRealtimeEventV1(value.event);
  switch (value?.kind) {
    case "standard": {
      if (event.type !== "message.shadow_stream_start"
        && event.type !== "message.shadow_stream_frame"
        && event.type !== "message.shadow_durable") {
        throw new Error("Foreground Shadow receive kind disagrees with event.");
      }
      const { controller } = await foregroundShadowControllerForSender(e);
      const result = await controller.receiveLive(event);
      logForegroundShadowReceiveResult("standard", event.type, result);
      return Object.freeze({
        kind: "standard" as const,
        result,
      });
    }
    case "human_peer": {
      if (event.type !== "message.human_peer_shadow"
        || (event.wireVersion === 1 && (typeof value.ordinarySibling !== "object"
        || value.ordinarySibling === null))) {
        throw new Error("Foreground Shadow Human-peer input is invalid.");
      }
      const ordinarySibling = event.wireVersion === 1
        ? validatedForegroundShadowSibling(value.ordinarySibling) : undefined;
      const { controller } = await foregroundShadowControllerForSender(e);
      const result = await controller.receiveHumanPeer(
        event,
        ordinarySibling,
      );
      logForegroundShadowReceiveResult("human_peer", event.type, result);
      return Object.freeze({
        kind: "human_peer" as const,
        result,
      });
    }
    case "shared_agent": {
      if (event.type !== "message.shared_agent_shadow"
        || (event.wireVersion === 1 && (typeof value.ordinarySibling !== "object"
        || value.ordinarySibling === null))) {
        throw new Error("Foreground Shadow shared-Agent input is invalid.");
      }
      const ordinarySibling = event.wireVersion === 1
        ? validatedForegroundShadowSibling(value.ordinarySibling) : undefined;
      const { controller } = await foregroundShadowControllerForSender(e);
      const result = await controller.receiveSharedAgent(
        event,
        ordinarySibling,
      );
      logForegroundShadowReceiveResult("shared_agent", event.type, result);
      return Object.freeze({
        kind: "shared_agent" as const,
        result,
      });
    }
    case "shared_agent_output": {
      if (event.type !== "message.shared_agent_stream_start"
        && event.type !== "message.shared_agent_stream_frame"
        && event.type !== "message.shared_agent_output_shadow") {
        throw new Error("Foreground Shadow shared-Agent output is invalid.");
      }
      const { controller } = await foregroundShadowControllerForSender(e);
      const result = await controller.receiveSharedAgentOutput(event);
      logForegroundShadowReceiveResult("shared_agent_output", event.type, result);
      return Object.freeze({
        kind: "shared_agent_output" as const,
        result,
      });
    }
    default:
      throw new Error("Foreground Shadow receive kind is unsupported.");
  }
});

ipcMain.handle(
  "foregroundShadow:synchronizeRecipients",
  async (e, raw: unknown) => {
    const value = boundedForegroundShadowValue(
      raw,
      "Foreground Shadow recipient synchronization",
    ) as { roomId?: unknown; namespaceId?: unknown; keyClass?: unknown };
    const roomId = foregroundShadowString(value?.roomId, "Room id", 200);
    const namespaceId = foregroundShadowString(
      value?.namespaceId,
      "Namespace id",
      512,
    );
    const { controller } = await foregroundShadowControllerForSender(e);
    if (value.keyClass !== undefined) {
      if (value.keyClass !== "human" && value.keyClass !== "ai") {
        throw new Error("Domain key class is invalid.");
      }
      return controller.serviceDomainKeyRequests(
        roomId,
        namespaceId,
        value.keyClass,
      );
    }
    return controller.synchronizeHumanPeerRecipients(roomId, namespaceId);
  },
);

ipcMain.handle("foregroundShadow:serviceDomainKeyBacklog", async (e) => {
  const { controller } = await foregroundShadowControllerForSender(e);
  return controller.serviceDomainKeyBacklog();
});

ipcMain.handle("foregroundShadow:backgroundAuthorization:service", async (e) => {
  const { controller } = await foregroundShadowControllerForSender(e);
  await controller.serviceBackgroundAuthorization();
});

ipcMain.handle(
  "foregroundShadow:messageBackfill:service",
  async (e, raw: unknown) => {
    const request = messageBackfillNextRequestSchema.parse(raw ?? {});
    const { controller } = await foregroundShadowControllerForSender(e);
    return controller.serviceMessageBackfill(request.urgent);
  },
);

ipcMain.handle("foregroundShadow:messageBackfill:cancel", async (e) => {
  const session = resolveSessionFromSender(e);
  const pending = foregroundShadowControllers.get(e.sender.id);
  if (pending === undefined) return;
  const bound = await pending;
  if (bound.sender !== e.sender || bound.serverScope !== session.scope) return;
  bound.controller.cancelMessageBackfill();
});

ipcMain.handle("foregroundShadow:history:reconcile", async (e, raw: unknown) => {
  const value = boundedForegroundShadowValue(
    raw,
    "Foreground Shadow history",
    FOREGROUND_SHADOW_HISTORY_IPC_MAX_BYTES,
  );
  assertForegroundShadowHistoryShape(value);
  const { controller } = await foregroundShadowControllerForSender(e);
  const result = await controller.reconcileHistory(
    value.readerInput as Parameters<
      ElectronForegroundShadowController["reconcileHistory"]
    >[0],
  );
  try {
    await controller.acknowledgeHistory({
      ...(value.acknowledgement as Omit<Parameters<
        ElectronForegroundShadowController["acknowledgeHistory"]
      >[0], "result">),
      result,
    });
  } catch (error) {
    log.warn("[desktop][foreground-shadow] history acknowledgement failed", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  return result;
});

/**
 * D458 Wave 7 — controller pairing stays main-owned so the renderer receives
 * only server-authored ceremony data and safe controller projections. In
 * particular, it never receives an access bearer, relay token, or native
 * power-save blocker id.
 */
async function remoteControlClientForSender(
  e: Electron.IpcMainInvokeEvent,
): Promise<NautiloApiClient> {
  resolveSessionFromSender(e);
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) throw new Error("No active Nautilo server connection.");
  const token = await getValidAccessToken({
    refresh: refreshTokens,
    onObservedRejection: onLogtoRefreshFailed,
  });
  if (!token) throw new Error("Sign in again to manage mobile control.");
  const client = new NautiloApiClient(serverUrl.replace(/\/$/, ""));
  client.setToken(token);
  return client;
}


type PendingRecoveryPresentation = Readonly<{
  presentationId: string;
  removeDestroyedListener: () => void;
  resolve: (result:
    | Readonly<{ status: "confirmed" }>
    | Readonly<{ status: "cancelled" }>) => void;
}>;

const pendingRecoveryPresentations = new Map<
  number,
  PendingRecoveryPresentation
>();

async function encryptionRecoveryClientForSender(
  e: Electron.IpcMainInvokeEvent,
) {
  const session = resolveSessionFromSender(e);
  const api = await remoteControlClientForSender(e);
  const directory = path.join(app.getPath("userData"), "crypto-client");
  return createElectronEncryptionRecoveryReadinessClient({
    api,
    serverScope: session.serverUrl.replace(/\/$/u, ""),
    directory,
    safeStorage,
    installationIdForAccount: (account) =>
      readOrCreateDesktopCryptoInstallationId({
        directory,
        account,
        fallbackInstallationId: getOrCreateInstallationId(),
      }),
    createRecoveryInstallationId: randomUUID,
    activateRecoveryInstallationId: (installationId, account) =>
      activateFreshDesktopCryptoInstallationId({
        directory,
        account,
        installationId,
      }),
    onRecoveryIdentityActivated: () =>
      disposeForegroundShadowController(e.sender.id),
  });
}

const unavailableEncryptionRecovery = () => Object.freeze({
  status: "unavailable" as const,
  reason: "identity_invalid" as const,
});

function logEncryptionRecoveryFailure(
  operation: "inspect" | "setup",
  error: unknown,
): void {
  const cause = error instanceof Error ? error.cause : undefined;
  log.error("[desktop] encryption recovery request failed", {
    operation,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : "non-error rejection",
    causeName: cause instanceof Error ? cause.name : typeof cause,
    causeMessage: cause instanceof Error ? cause.message : undefined,
    causeCode: cause !== null && typeof cause === "object" && "code" in cause
      && typeof cause.code === "string"
      ? cause.code
      : undefined,
  });
}

ipcMain.handle("encryptionRecovery:inspect", async (e) => {
  try {
    const client = await encryptionRecoveryClientForSender(e);
    return client === null ? unavailableEncryptionRecovery() : client.inspect();
  } catch (error) {
    logEncryptionRecoveryFailure("inspect", error);
    throw error;
  }
});

ipcMain.handle("encryptionRecovery:deviceAdmissionDeviceId", async (e) => {
  const client = await encryptionRecoveryClientForSender(e);
  return await client?.deviceAdmissionDeviceId?.() ?? null;
});

ipcMain.handle(
  "encryptionRecovery:signDeviceAdmissionChallenge",
  async (e, raw: unknown) => {
    const challenge = deviceAdmissionChallengeSchema.parse(raw);
    const client = await encryptionRecoveryClientForSender(e);
    if (client?.signDeviceAdmissionChallenge === undefined) {
      throw new Error("Device admission signing is unavailable");
    }
    const proof = await client.signDeviceAdmissionChallenge(
      deviceAdmissionChallengeFromDto(challenge),
    );
    return deviceAdmissionProofToDto(proof);
  },
);

ipcMain.handle("encryptionRecovery:continueAdditionalDevice", async (e) => {
  const client = await encryptionRecoveryClientForSender(e);
  return client?.continueAdditionalDevice === undefined
    ? unavailableEncryptionRecovery()
    : client.continueAdditionalDevice();
});

ipcMain.handle(
  "encryptionRecovery:approveAdditionalDevice",
  async (e, raw: unknown) => {
    const operationId = (raw as { operationId?: unknown })?.operationId;
    const verificationCode = (raw as { verificationCode?: unknown })
      ?.verificationCode;
    if (typeof operationId !== "string" || operationId.length < 1
      || operationId.length > 128
      || typeof verificationCode !== "string"
      || !/^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$/u.test(verificationCode)) {
      throw new Error("Additional-device operation is invalid.");
    }
    const client = await encryptionRecoveryClientForSender(e);
    return client?.approveAdditionalDevice === undefined
      ? unavailableEncryptionRecovery()
      : client.approveAdditionalDevice(operationId, verificationCode);
  },
);

ipcMain.handle(
  "encryptionRecovery:advanceAdditionalDevice",
  async (e, raw: unknown) => {
    const operationId = (raw as { operationId?: unknown })?.operationId;
    if (typeof operationId !== "string" || operationId.length < 1
      || operationId.length > 128) {
      throw new Error("Additional-device operation is invalid.");
    }
    const client = await encryptionRecoveryClientForSender(e);
    return client?.advanceAdditionalDevice === undefined
      ? unavailableEncryptionRecovery()
      : client.advanceAdditionalDevice(operationId);
  },
);

ipcMain.handle("encryptionRecovery:listDevices", async (e) => {
  const client = await encryptionRecoveryClientForSender(e);
  if (client?.listEncryptionDevices === undefined) {
    throw new Error("Encryption device roster is unavailable.");
  }
  return client.listEncryptionDevices();
});

ipcMain.handle(
  "encryptionRecovery:removeDevice",
  async (e, raw: unknown) => {
    const deviceId = (raw as { deviceId?: unknown })?.deviceId;
    const pin = (raw as { pin?: unknown })?.pin;
    if (typeof deviceId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(deviceId)
      || typeof pin !== "string" || !/^\d{6,8}$/u.test(pin)) {
      throw new Error("Encryption device removal request is invalid.");
    }
    const client = await encryptionRecoveryClientForSender(e);
    if (client?.removeEncryptionDevice === undefined) {
      throw new Error("Encryption device removal is unavailable.");
    }
    return client.removeEncryptionDevice(deviceId, pin);
  },
);

ipcMain.handle(
  "encryptionRecovery:recoverDevice",
  async (e, raw: unknown) => {
    const mnemonic = (raw as { mnemonic?: unknown })?.mnemonic;
    if (typeof mnemonic !== "string"
      || mnemonic.length > 512
      || mnemonic.trim().split(/\s+/u).length !== 24) {
      throw new Error("Encryption recovery phrase is invalid.");
    }
    const client = await encryptionRecoveryClientForSender(e);
    if (client?.recoverEncryptionDevice === undefined) {
      throw new Error("Encryption device recovery is unavailable.");
    }
    return client.recoverEncryptionDevice(mnemonic);
  },
);

ipcMain.handle("encryptionRecovery:reconnectDevice", async (e) => {
  const client = await encryptionRecoveryClientForSender(e);
  if (client?.reconnectEncryptionDevice === undefined) {
    throw new Error("Encryption device reconnection is unavailable.");
  }
  return client.reconnectEncryptionDevice();
});

ipcMain.handle("encryptionRecovery:resetLocalSetup", async (e) => {
  const client = await encryptionRecoveryClientForSender(e);
  return client === null
    ? unavailableEncryptionRecovery()
    : client.resetLocalSetup();
});

ipcMain.handle("encryptionRecovery:setup", async (e) => {
  if (pendingRecoveryPresentations.has(e.sender.id)) {
    throw new Error("Encrypted recovery confirmation is already open.");
  }
  const client = await encryptionRecoveryClientForSender(e);
  if (client === null) return unavailableEncryptionRecovery();
  try {
    return await client.setup((presentation) => new Promise((resolve) => {
      const presentationId = randomUUID();
      const onDestroyed = () => {
        const current = pendingRecoveryPresentations.get(e.sender.id);
        if (current?.presentationId !== presentationId) return;
        pendingRecoveryPresentations.delete(e.sender.id);
        resolve({ status: "cancelled" });
      };
      e.sender.once("destroyed", onDestroyed);
      const pending = Object.freeze({
        presentationId,
        removeDestroyedListener: () =>
          e.sender.removeListener("destroyed", onDestroyed),
        resolve,
      });
      pendingRecoveryPresentations.set(e.sender.id, pending);
      e.sender.send("encryptionRecovery:presentation", Object.freeze({
        presentationId,
        documentHeader: presentation.documentHeader,
        mnemonic: presentation.revealMnemonic(),
      }));
    }));
  } catch (error) {
    logEncryptionRecoveryFailure("setup", error);
    throw error;
  } finally {
    const pending = pendingRecoveryPresentations.get(e.sender.id);
    if (pending !== undefined) {
      pendingRecoveryPresentations.delete(e.sender.id);
      pending.removeDestroyedListener();
      pending.resolve({ status: "cancelled" });
    }
  }
});

ipcMain.handle(
  "encryptionRecovery:resolvePresentation",
  (e, input: unknown) => {
    resolveSessionFromSender(e);
    const value = input as Record<string, unknown>;
    const pending = pendingRecoveryPresentations.get(e.sender.id);
    if (pending === undefined
      || value?.["presentationId"] !== pending.presentationId
      || (value["status"] !== "confirmed" && value["status"] !== "cancelled")) {
      throw new Error("Encrypted recovery confirmation is stale.");
    }
    const result = value["status"] === "confirmed"
      ? Object.freeze({ status: "confirmed" as const })
      : Object.freeze({ status: "cancelled" as const });
    pendingRecoveryPresentations.delete(e.sender.id);
    pending.removeDestroyedListener();
    pending.resolve(result);
  },
);


ipcMain.handle("remoteControl:getReadiness", (e) => {
  assertMainWindowSender(e);
  const lease = reconcileRemoteControlKeepAwake();
  return {
    relayReady: getRelayStatus() === "connected",
    relayStatus: getRelayStatus(),
    keepAwakeEnabled: lease.active,
    keepAwakePolicy: remoteControlKeepAwakePolicy,
    keepAwakeSupported: true,
    macosLidClosedGuidance:
      process.platform === "darwin"
        ? "For lid-closed mobile control, connect external power and an external display. macOS requires both for supported clamshell operation."
        : null,
  };
});

ipcMain.handle(
  "remoteControl:setKeepAwakePolicy",
  (e, args: { policy?: unknown }) => {
    assertMainWindowSender(e);
    if (
      args?.policy !== "off" &&
      args?.policy !== "while_remote_enabled_and_on_external_power"
    )
      throw new Error("invalid remote-control wake policy");
    const policy: KeepAwakePolicy = args.policy;
    if (policy === "while_remote_enabled_and_on_external_power") {
      if (getRelayStatus() !== "connected")
        return { ok: false, enabled: false } as const;
      remoteControlKeepAwakePolicy = policy;
      const lease = reconcileRemoteControlKeepAwake();
      return { ok: lease.active, enabled: lease.active, policy } as const;
    }
    remoteControlKeepAwakePolicy = "off";
    const lease = reconcileRemoteControlKeepAwake({ policy: "off" });
    return { ok: true, enabled: lease.active, policy } as const;
  },
);

ipcMain.handle("remoteControl:createChallenge", async (e) => {
  const client = await remoteControlClientForSender(e);
  if (getRelayStatus() !== "connected")
    throw new Error("Desktop relay is not connected yet.");
  const relayId = getPersistedDesktopRelayId();
  if (!relayId) throw new Error("Desktop relay identity is not ready yet.");
  // The only pairing payload returned to the renderer is the exact API
  // response. No relay token is ever materialized here.
  return client.createRemotePairingChallenge({ relayId });
});

ipcMain.handle("remoteControl:listControllers", async (e) => {
  const client = await remoteControlClientForSender(e);
  return client.listRemoteControllers();
});

ipcMain.handle(
  "remoteControl:renameController",
  async (e, args: { bindingId?: unknown; label?: unknown }) => {
    const client = await remoteControlClientForSender(e);
    if (typeof args?.bindingId !== "string" || typeof args.label !== "string")
      throw new Error("invalid controller rename");
    return client.renameRemoteController(args.bindingId, { label: args.label });
  },
);

ipcMain.handle(
  "remoteControl:revokeController",
  async (e, args: { bindingId?: unknown }) => {
    const client = await remoteControlClientForSender(e);
    if (typeof args?.bindingId !== "string")
      throw new Error("invalid controller revoke");
    const result = await client.revokeRemoteController(args.bindingId);
    // Controller revocation is independent of the desktop's own relay authority;
    // do not tear down a global native lease merely because one phone was removed.
    reconcileRemoteControlKeepAwake();
    return result;
  },
);

function parseToolRuntimeName(raw: unknown): ToolRuntimeName | null {
  return raw === "agent-browser" || raw === "gog" ? raw : null;
}

ipcMain.handle("toolRuntimes:getStatus", async (e) => {
  assertMainWindowSender(e);
  return getToolRuntimeStatus();
});

ipcMain.handle("toolRuntimes:refresh", async (e) => {
  assertMainWindowSender(e);
  const status = await refreshToolRuntimeStatus();
  await refreshRelayForCurrentFolder("tool runtime refresh");
  return status;
});

ipcMain.handle(
  "toolRuntimes:setPath",
  async (e, args: { tool?: unknown; path?: unknown }) => {
    assertMainWindowSender(e);
    const tool = parseToolRuntimeName(args?.tool);
    if (!tool || typeof args?.path !== "string" || args.path.length === 0) {
      return { ok: false, reason: "invalid_tool_runtime_path" } as const;
    }
    const status = await setToolRuntimePath(tool, args.path);
    await refreshRelayForCurrentFolder(`tool runtime path set: ${tool}`);
    return { ok: true as const, status };
  },
);

ipcMain.handle(
  "toolRuntimes:clearPath",
  async (e, args: { tool?: unknown }) => {
    assertMainWindowSender(e);
    const tool = parseToolRuntimeName(args?.tool);
    if (!tool) return { ok: false, reason: "invalid_tool_runtime" } as const;
    const status = await clearToolRuntimePath(tool);
    await refreshRelayForCurrentFolder(`tool runtime path cleared: ${tool}`);
    return { ok: true as const, status };
  },
);

ipcMain.handle("googleWorkspace:authStatus", async (e) => {
  assertMainWindowSender(e);
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) {
    return {
      clientConfigOnServer: false,
      clientConfigLocal: false,
      connectedAccounts: [],
      healthy: false,
      reason: "no_server",
    };
  }
  const token = logtoConfig()
    ? await getValidAccessToken({
        refresh: refreshTokens,
        onObservedRejection: onLogtoRefreshFailed,
      })
    : null;
  return googleWorkspaceAuthStatus({
    serverUrl,
    ...(token ? { token } : {}),
  });
});

ipcMain.handle(
  "googleWorkspace:connect",
  async (e, args: { email?: unknown }) => {
    assertMainWindowSender(e);
    const serverUrl = resolvedServerUrl();
    if (!serverUrl) {
      return { ok: false as const, reason: "no_server" };
    }
    if (typeof args?.email !== "string") {
      return { ok: false as const, reason: "invalid_email" };
    }
    const token = logtoConfig()
      ? await getValidAccessToken({
          refresh: refreshTokens,
          onObservedRejection: onLogtoRefreshFailed,
        })
      : null;
    if (!token) {
      return { ok: false as const, reason: "not_signed_in" };
    }
    const result = await googleWorkspaceConnect({
      serverUrl,
      token,
      email: args.email,
      refreshRelay: () =>
        refreshRelayForCurrentFolder("google workspace connect"),
    });
    if (result.ok && mainWindow && !mainWindow.isDestroyed()) {
      app.focus({ steal: true });
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
    return result;
  },
);

ipcMain.handle(
  "googleWorkspace:disconnect",
  async (e, args: { email?: unknown }) => {
    assertMainWindowSender(e);
    if (typeof args?.email !== "string") {
      return { ok: false as const, reason: "invalid_email" };
    }
    return googleWorkspaceDisconnect({
      email: args.email,
      refreshRelay: () =>
        refreshRelayForCurrentFolder("google workspace disconnect"),
    });
  },
);

// D336 — adopt a Workbench-owned <webview>'s webContents (resolved from the
// renderer-provided id) so we can run the scoped CDP shim against the SaaS app
// surface. The webview element itself handles layout/visibility in the DOM.
// D336 — canvas-rendered apps (Google Docs, etc.) only expose their text in the
// DOM/accessibility tree when Chromium is in SCREEN-READER mode. Forcing the
// `screenReader` accessibility feature makes Docs emit its "annotated canvas"
// text layer (the same path assistive tech / Grammarly rely on), so
// browser_snapshot/read/get can read the document without screenshots, the gws
// API, or the user toggling Docs' own accessibility setting.
//
// Enabled ONCE when the first SaaS webview is adopted, and deliberately NOT
// auto-disabled: `setAccessibilitySupportFeatures([])` would clobber a real
// screen-reader user's session. App-wide a11y-tree perf cost is accepted while
// browser control is in use. macOS/Windows only.
let browserAccessibilityEnabled = false;
function enableBrowserAccessibilityForCanvasText(): void {
  if (browserAccessibilityEnabled) return;
  try {
    app.setAccessibilitySupportFeatures([
      "nativeAPIs",
      "webContents",
      "html",
      "screenReader",
    ]);
    browserAccessibilityEnabled = true;
    log.info(
      "[browser-control] enabled screen-reader accessibility so canvas apps (Google Docs) expose text",
    );
  } catch (err) {
    log.warn("[browser-control] setAccessibilitySupportFeatures failed", err);
  }
}

const externalProtocolHandlers = new WeakSet<Electron.WebContents>();

function shouldOpenOutsideEmbeddedBrowser(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return !["http:", "https:", "about:", "data:", "blob:"].includes(
      url.protocol,
    );
  } catch {
    return false;
  }
}

function routeEmbeddedBrowserExternalLink(
  rawUrl: string,
  source: string,
): void {
  log.info("[browser-control] opening external link from embedded browser", {
    source,
    url: rawUrl,
  });
  void shell.openExternal(rawUrl).catch((err: unknown) => {
    log.warn(
      "[browser-control] shell.openExternal failed for embedded browser link",
      {
        source,
        url: rawUrl,
        error: err instanceof Error ? err.message : String(err),
      },
    );
  });
}

function attachEmbeddedBrowserNavigationHandlers(
  guest: Electron.WebContents,
): void {
  // Browser-mode pages often hand off to native apps via custom protocols
  // (`spotify:`, `mailto:`, etc.). A normal browser forwards those to the OS;
  // an Electron <webview> needs the host to do it explicitly.
  guest.setWindowOpenHandler(({ url }) => {
    if (shouldOpenOutsideEmbeddedBrowser(url)) {
      routeEmbeddedBrowserExternalLink(url, "window-open");
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  if (externalProtocolHandlers.has(guest)) return;
  externalProtocolHandlers.add(guest);
  guest.on("will-navigate", (event, rawUrl) => {
    if (!shouldOpenOutsideEmbeddedBrowser(rawUrl)) return;
    event.preventDefault();
    routeEmbeddedBrowserExternalLink(rawUrl, "will-navigate");
  });

  registerEmbeddedBrowserDownloadHandler(guest);
}

// D368 Wave 2 — auto-save downloads from the embedded browser into the OS
// Downloads dir + toast, instead of Electron's default save dialog. Registered
// on the guest's SESSION (partitions are per-app; multiple guests can share
// one session), deduped per session so a re-adopt/guest-swap doesn't stack
// duplicate handlers.
const downloadHandledSessions = new WeakSet<Electron.Session>();

function registerEmbeddedBrowserDownloadHandler(
  guest: Electron.WebContents,
): void {
  let ses: Electron.Session;
  try {
    ses = guest.session;
  } catch {
    return;
  }
  if (downloadHandledSessions.has(ses)) return;
  downloadHandledSessions.add(ses);
  ses.on("will-download", (_event, item) => {
    let savePath: string;
    try {
      savePath = resolveDownloadTarget(
        app.getPath("downloads"),
        item.getFilename(),
        (candidate) => fs.existsSync(candidate),
      );
    } catch (err) {
      log.warn("[browser-control] could not resolve download target", {
        error: err instanceof Error ? err.message : String(err),
      });
      return; // fall back to Electron's default (save dialog) rather than break
    }
    item.setSavePath(savePath);
    item.once("done", (_doneEvent, state) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      sendToActiveRenderer("browserControl:download", {
        state,
        filename: path.basename(savePath),
        savePath,
      });
    });
  });
}

ipcMain.handle(
  "browserControl:attachWebview",
  async (
    e,
    args: {
      appId: string;
      mode?: "app" | "browser";
      partition: string;
      url: string;
      webContentsId: number;
    },
  ) => {
    assertMainWindowSender(e);
    if (!browserControlManager) return null;
    const guest = webContents.fromId(args.webContentsId);
    if (!guest) {
      log.warn("[browser-control] attachWebview: no webContents for id", {
        webContentsId: args.webContentsId,
        appId: args.appId,
      });
      return null;
    }
    attachEmbeddedBrowserNavigationHandlers(guest);
    const snapshot = await browserControlManager.adopt(
      {
        appId: args.appId,
        mode: args.mode ?? "app",
        partition: args.partition,
        url: args.url,
      },
      guest,
    );
    enableBrowserAccessibilityForCanvasText();
    return snapshot;
  },
);

ipcMain.handle("browserControl:detachWebview", (e, args: { appId: string }) => {
  assertMainWindowSender(e);
  return browserControlManager?.release(args.appId) ?? false;
});

ipcMain.handle("browserControl:setActive", (e, args: { appId: string }) => {
  assertMainWindowSender(e);
  return browserControlManager?.setActive(args.appId) ?? null;
});

ipcMain.handle("browserControl:getViews", (e) => {
  assertMainWindowSender(e);
  return browserControlManager?.list() ?? [];
});

function browserResearchId(raw: unknown): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const id = (raw as { id?: unknown }).id;
  return typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

ipcMain.handle("browserResearch:present", (e, raw: unknown) => {
  assertMainWindowSender(e);
  const id = browserResearchId(raw);
  if (!browserResearchTargetManager)
    return { ok: false as const, reason: "unavailable" as const };
  const intervention = id ? browserResearchTargetManager.present(id) : null;
  if (!intervention) return { ok: false as const, reason: "stale" as const };
  sendToActiveRenderer("browserResearch:presentRequested", intervention);
  return { ok: true as const };
});

function browserResearchBounds(raw: unknown): Electron.Rectangle | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return null;
  const value = raw as {
    x?: unknown;
    y?: unknown;
    width?: unknown;
    height?: unknown;
  };
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite))
    return null;
  const bounds = {
    x: Math.max(0, Math.round(value.x as number)),
    y: Math.max(0, Math.round(value.y as number)),
    width: Math.max(1, Math.round(value.width as number)),
    height: Math.max(1, Math.round(value.height as number)),
  };
  if (!mainWindow || mainWindow.isDestroyed()) return null;
  const content = mainWindow.getContentBounds();
  if (
    bounds.x + bounds.width > content.width ||
    bounds.y + bounds.height > content.height
  )
    return null;
  return bounds;
}

ipcMain.handle("browserResearch:attachSurface", (e, raw: unknown) => {
  assertMainWindowSender(e);
  const id = browserResearchId(raw);
  const bounds = browserResearchBounds(
    (raw as { bounds?: unknown } | null)?.bounds,
  );
  if (!id || !bounds || !browserResearchTargetManager) return false;
  return browserResearchTargetManager.attachSurface(id, bounds);
});

ipcMain.handle("browserResearch:detachSurface", (e, raw: unknown) => {
  assertMainWindowSender(e);
  const id = browserResearchId(raw);
  return Boolean(id && browserResearchTargetManager?.detachSurface(id));
});

ipcMain.handle("browserResearch:cancel", (e, raw: unknown) => {
  assertMainWindowSender(e);
  const id = browserResearchId(raw);
  if (!browserResearchTargetManager)
    return { ok: false as const, reason: "unavailable" as const };
  return id && browserResearchTargetManager.resolveIntervention(id, "cancel")
    ? { ok: true as const }
    : { ok: false as const, reason: "stale" as const };
});

ipcMain.handle("browserResearch:alternate", (e, raw: unknown) => {
  assertMainWindowSender(e);
  const id = browserResearchId(raw);
  if (!browserResearchTargetManager)
    return { ok: false as const, reason: "unavailable" as const };
  return id && browserResearchTargetManager.resolveIntervention(id, "alternate")
    ? { ok: true as const }
    : { ok: false as const, reason: "stale" as const };
});

ipcMain.handle("browserResearch:getActiveIntervention", (e) => {
  assertMainWindowSender(e);
  return browserResearchTargetManager?.getActiveIntervention() ?? null;
});

// D368 Wave 2 — user-initiated "open in external browser" for the current
// embedded page. Reuses the same external-link router as protocol/window-open
// handoff so logging + error handling stay consistent. Only http(s)/about/…
// pass the guard; anything else is a no-op.
ipcMain.handle("browserControl:openExternal", (e, args: { url: string }) => {
  assertMainWindowSender(e);
  const url = typeof args?.url === "string" ? args.url : "";
  if (!url) return;
  try {
    const scheme = new URL(url).protocol;
    if (!["http:", "https:", "about:", "data:", "blob:"].includes(scheme))
      return;
  } catch {
    return;
  }
  routeEmbeddedBrowserExternalLink(url, "user-open-external");
});

// ---------------------------------------------------------------------------
// D403 (ISSUE-D403) Phase 0 — embedded-browser password save & restore IPC.
//
// SECURITY (R6, non-negotiable): web credentials are HUMAN-ONLY. The
// passwords:* channels exist only for the human operating the embedded browser
// — the guest <webview> preload and the host (mainWindow) renderer's
// save/autofill UX. They must NEVER be exposed on any agent/tool/CDP surface,
// and web credentials must NEVER enter agent/LLM context. Do not add these
// channels to any agent-facing API, MCP tool, relay, or the agent-browser/CDP
// bridge. P0 uses a NoopBackend stub; P2 swaps in the KDBX-backed store.
// ---------------------------------------------------------------------------

/**
 * D403 P0 — human-only sender gate for the `passwords:*` channels. Allowed
 * senders: the mainWindow renderer (host save/autofill UX) and embedded-browser
 * `<webview>` guests (guest preload). Everything else is rejected — other
 * windows (first-run/onboarding/auth) and any agent/tool/CDP surface (which has
 * no `ipcRenderer` in the guest page's main world anyway, thanks to
 * contextIsolation). Defence-in-depth on top of that structural guarantee.
 */
function assertPasswordsCredentialSender(e: {
  sender: Electron.WebContents;
}): void {
  const sender = e.sender;
  if (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    serverSessions.getBySender(sender.id) === serverSessions.active
  ) {
    return;
  }
  let senderType: string | null = null;
  try {
    senderType = sender.getType();
  } catch {
    senderType = null;
  }
  if (senderType === "webview") return;
  log.warn("[passwords] rejected non-human sender for passwords:* channel", {
    senderId: sender.id,
    senderType,
  });
  throw new Error("ipc-denied: passwords:* is human-only");
}

registerPasswordsIpc({
  backend: new KdbxBackend(app.getPath("userData")),
  assertCredentialSender: assertPasswordsCredentialSender,
  // Host (mainWindow) renderer for pushing pendingSave / formDetected notices.
  // A getter because mainWindow is created/recreated over the app lifetime.
  getHostWebContents: () =>
    mainWindow && !mainWindow.isDestroyed() ? activeRenderer() : null,
  // Resolve a live GUEST webContents by id for one-shot fill delivery. We
  // re-check that the target is actually an embedded-browser <webview> guest
  // (defence-in-depth) so main never ships a secret to a non-guest surface.
  getGuestWebContents: (id: number) => {
    const wc = webContents.fromId(id);
    if (!wc || wc.isDestroyed()) return null;
    let type: string | null = null;
    try {
      type = wc.getType();
    } catch {
      type = null;
    }
    return type === "webview" ? wc : null;
  },
});

// D403 P0 — surface the built guest-preload path (a file:// URL) to the
// mainWindow renderer so the SaaS surface can set it as the <webview preload>
// attribute. Sync (mirrors `coldBoot:peekShellState`) because the renderer
// needs it at <webview> render time. Not a secret (just a local path), but
// gated to mainWindow for tidiness; returns null to any other sender.
ipcMain.on("passwords:getGuestPreloadPath", (e) => {
  const isMain =
    !!mainWindow &&
    !mainWindow.isDestroyed() &&
    serverSessions.getBySender(e.sender.id) === serverSessions.active;
  e.returnValue = isMain
    ? pathToFileURL(path.join(__dirname, "guest-preload.js")).href
    : null;
});

// D057 2a.7 — legacy: pick + persist in one shot. Retained for callers
// that don't need the pick/confirm separation (none today, but kept for
// backward compat with preload consumers).
ipcMain.handle("dialog:openFolder", async (e) => {
  assertMainWindowSender(e);
  const picked = await pickFolder();
  if (picked) commitCurrentFolderPath(picked);
  return picked;
});

ipcMain.handle("dialog:pickFiles", (e) => {
  assertMainWindowSender(e);
  return pickFilesForComposer();
});

/**
 * D079 Phase 1 — IPC handler implementations under the new
 * `currentFolder:*` namespace. Deprecation aliases at
 * `workspace:*` live below and delegate to these so any renderer /
 * MCP / skill that hasn't migrated yet keeps working for one release.
 */

// D057 2a.7 — pick without persisting.
ipcMain.handle("currentFolder:pickFolder", (e) => {
  assertMainWindowSender(e);
  return pickFolder();
});

// D057 2a.7 — persist a chosen path.
//
// Shape-only validation (see `workspace-validation.ts` for the full
// rationale): rejects empty/relative/NUL-containing/non-existent/
// non-directory inputs and normalizes `..` / `.` segments via
// `path.resolve` before commit. This is defence-in-depth against
// shape bugs, NOT a privilege boundary — the actual filesystem-scope
// confinement lives in `packages/relay/src/workspace-guard.ts` and in
// `assertPathInAllowedRoot` below. A compromised renderer that
// bypasses the native pickFolder dialog could still persist any real
// directory (including e.g. `$HOME/.ssh`); that is the preload-
// bridge + native-dialog's job to prevent, not this validator's.
ipcMain.handle("currentFolder:setPath", (e, args: { path: string }) => {
  assertMainWindowSender(e);
  const result = validateWorkspacePath(args, WORKSPACE_VALIDATOR_DEPS);
  if (!result.ok) throw new Error(result.error);

  // D075 — sanity-gate against system roots + home + known-bad paths.
  // Runs AFTER validateWorkspacePath so the path is already
  // canonicalized by path.resolve (no `..` / `.` segments confuse the
  // comparison).
  const sanity = checkCurrentFolderSanity(result.resolved, os.homedir());
  if (!sanity.ok) {
    throw new Error(sanity.reason);
  }

  commitCurrentFolderPath(result.resolved);
});

ipcMain.handle("currentFolder:getPath", (e) => {
  assertMainWindowSender(e);
  return currentFolderPath;
});

// D448 Phase 5 — this privileged producer binds the selected folder to the
// persisted Electron relay identity. The server re-authenticates the pairing
// before it can affect execution routing.
ipcMain.handle("currentFolder:getContext", (e) => {
  assertMainWindowSender(e);
  return {
    currentFolder: currentFolderPath,
    relayId: getPersistedDesktopRelayId(),
  };
});

// D075 — pre-commit validator. Used by edge paths (hand-typed paths,
// future tooling) before commit. The CurrentFolderHeader dropdown's
// Recent entries call setPath directly since they were validated at
// original commit.
ipcMain.handle(
  "currentFolder:validate",
  (
    e,
    args: { path: string },
  ): { ok: true; resolved: string } | { ok: false; reason: string } => {
    assertMainWindowSender(e);
    const result = validateWorkspacePath(args, WORKSPACE_VALIDATOR_DEPS);
    if (!result.ok) return { ok: false, reason: result.error };
    const sanity = checkCurrentFolderSanity(result.resolved, os.homedir());
    if (!sanity.ok) return { ok: false, reason: sanity.reason };
    return { ok: true, resolved: result.resolved };
  },
);

// D075 chunk 2 — pick + validate + commit in one round-trip. Used by
// the CurrentFolderHeader dropdown's "Open folder…", the tray menu's
// Open Folder, and any future single-click commit path. Returns the
// committed path, null if the user cancelled, or throws if the user
// picked a bad path (system root / home / non-directory).
ipcMain.handle("currentFolder:pickAndCommit", async (e) => {
  assertMainWindowSender(e);
  const picked = await pickFolder();
  if (!picked) return null;

  const validated = validateWorkspacePath(
    { path: picked },
    WORKSPACE_VALIDATOR_DEPS,
  );
  if (!validated.ok) throw new Error(validated.error);

  const sanity = checkCurrentFolderSanity(validated.resolved, os.homedir());
  if (!sanity.ok) throw new Error(sanity.reason);

  commitCurrentFolderPath(validated.resolved);
  return validated.resolved;
});

// D075 chunk 2 — recent current folders surfaced to the renderer for
// the CurrentFolderHeader dropdown's RECENT section. Same list drives
// the native File → Recent Folders ▸ submenu.
ipcMain.handle("currentFolder:listRecent", (e) => {
  assertMainWindowSender(e);
  return listRecentCurrentFolders();
});

/**
 * D079 Phase 3 — `genieWorkspace:*` IPC family for Surface A (Genie's
 * persistent drawer at `~/Documents/Nautilo/` by default). This commit
 * ships the read-only members (`getRoot`, `rootChanged` push) plus
 * the always-set default. `setRoot`, `pickAndSetRoot`, `revealInFinder`,
 * `listRecent` land in follow-up work (see Phase 3 §3.2 + §3.9 — not
 * required for G1 commit 3's MVP slice).
 *
 * Why a new `genieWorkspace:*` namespace instead of reusing
 * `workspace:*`: the old `workspace:*` family got renamed to
 * `currentFolder:*` by D079 Phase 1 and is retained as a deprecation
 * alias (see below). Keeping Surface A's IPC in its own namespace
 * means the two surfaces are NEVER confusable at the wire level —
 * channel name is the discriminator.
 */
ipcMain.handle("genieWorkspace:getRoot", (e) => {
  assertMainWindowSender(e);
  return genieWorkspaceRoot;
});

/**
 * D079 Phase 1 — deprecation aliases for the old `workspace:*` IPC
 * channels. Each logs a one-shot warning the first time it's called in
 * a session, then delegates to the renamed handler. Removed in the
 * release after Phase 4 ships.
 *
 * NOTE: `workspace:useDefault` is intentionally NOT aliased. It used
 * to create `~/Documents/Nautilo` as the current folder's default; in
 * the D079 model, current folder has no default. The equivalent for
 * Genie's Workspace (Surface A) gets its own IPC in Phase 3.
 */
const deprecatedIpcWarned = new Set<string>();
function warnDeprecatedIpc(channel: string): void {
  if (deprecatedIpcWarned.has(channel)) return;
  deprecatedIpcWarned.add(channel);
  log.warn(
    `[desktop][deprecated-ipc] ${channel} is renamed per D079 Phase 1; update callers to use the currentFolder:* equivalent.`,
  );
}

ipcMain.handle("workspace:pickFolder", (e) => {
  assertMainWindowSender(e);
  warnDeprecatedIpc("workspace:pickFolder");
  return pickFolder();
});
ipcMain.handle("workspace:setPath", (e, args: { path: string }) => {
  assertMainWindowSender(e);
  warnDeprecatedIpc("workspace:setPath");
  const result = validateWorkspacePath(args, WORKSPACE_VALIDATOR_DEPS);
  if (!result.ok) throw new Error(result.error);
  const sanity = checkCurrentFolderSanity(result.resolved, os.homedir());
  if (!sanity.ok) throw new Error(sanity.reason);
  commitCurrentFolderPath(result.resolved);
});
ipcMain.handle("workspace:getPath", (e) => {
  assertMainWindowSender(e);
  warnDeprecatedIpc("workspace:getPath");
  return currentFolderPath;
});
ipcMain.handle("workspace:validate", (e, args: { path: string }) => {
  assertMainWindowSender(e);
  warnDeprecatedIpc("workspace:validate");
  const result = validateWorkspacePath(args, WORKSPACE_VALIDATOR_DEPS);
  if (!result.ok) return { ok: false, reason: result.error };
  const sanity = checkCurrentFolderSanity(result.resolved, os.homedir());
  if (!sanity.ok) return { ok: false, reason: sanity.reason };
  return { ok: true, resolved: result.resolved };
});
ipcMain.handle("workspace:pickAndCommit", async (e) => {
  assertMainWindowSender(e);
  warnDeprecatedIpc("workspace:pickAndCommit");
  const picked = await pickFolder();
  if (!picked) return null;
  const validated = validateWorkspacePath(
    { path: picked },
    WORKSPACE_VALIDATOR_DEPS,
  );
  if (!validated.ok) throw new Error(validated.error);
  const sanity = checkCurrentFolderSanity(validated.resolved, os.homedir());
  if (!sanity.ok) throw new Error(sanity.reason);
  commitCurrentFolderPath(validated.resolved);
  return validated.resolved;
});
ipcMain.handle("workspace:listRecent", (e) => {
  assertMainWindowSender(e);
  warnDeprecatedIpc("workspace:listRecent");
  return listRecentCurrentFolders();
});

// D373 / Stack 137 — PTY session host (terminal work surface). Reuses the
// main-window sender guard; pushes output on the main window's webContents.
registerTerminalHost({
  ipcMain,
  assertSender: assertMainWindowSender,
  getWebContents: () => activeRenderer(),
  // The Human's Let Genie drive action must reach the server's next-turn
  // capability projection before the IPC promise resolves. The exact PTY id
  // remains local; the advertised bit only makes `terminal` immediately
  // callable and lets the prompt state that a handoff is waiting.
  onAgentHandoffChanged: async () => {
    await refreshDesktopRelayCapabilities("terminal handoff changed");
  },
});

ipcMain.handle("fs:readDir", async (e, args: { path: string }) => {
  assertMainWindowSender(e);
  assertPathInAllowedRoot(args.path);
  const entries = await fsp.readdir(args.path, { withFileTypes: true });
  // Stat each entry in parallel so the file tree can sort by date/size.
  // size/mtime are not present in directory entries on macOS/APFS, so a stat
  // per entry is unavoidable; Promise.all keeps it to one parallel batch.
  // Stat failures (broken symlinks, races) degrade to 0 rather than throwing
  // — a single bad entry must not fail the whole directory read.
  return Promise.all(
    entries.map(async (entry) => {
      const childPath = path.join(args.path, entry.name);
      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const st = await fsp.stat(childPath);
        sizeBytes = typeof st.size === "bigint" ? Number(st.size) : st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        /* unreadable entry — keep zeros so it still lists */
      }
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
        sizeBytes,
        mtimeMs,
      };
    }),
  );
});

ipcMain.handle("fs:watchRoot", (e, args: { path: string }) => {
  assertMainWindowSender(e);
  ensureFsWatchRoot(args.path);
});

ipcMain.handle("fs:unwatchRoot", (e, args: { path: string }) => {
  assertMainWindowSender(e);
  try {
    cleanupFsWatchRoot(fs.realpathSync(args.path));
  } catch {
    cleanupFsWatchRoot(path.resolve(args.path));
  }
});

ipcMain.handle("fs:readFile", async (e, args: { path: string }) => {
  assertMainWindowSender(e);
  assertPathInAllowedRoot(args.path);
  return fsp.readFile(args.path, "utf-8");
});

ipcMain.handle("documentMutations:readAuthoredChange", async (e, args: unknown) => {
  assertMainWindowSender(e);
  if (!args || typeof args !== "object" || Array.isArray(args)) return { kind: "unavailable", code: "invalid_request" };
  const value = args as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "path" && key !== "expectedSha256") ||
      typeof value["path"] !== "string" || typeof value["expectedSha256"] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value["expectedSha256"])) return { kind: "unavailable", code: "invalid_request" };
  const root = currentFolderPath;
  const revision = currentFolderRevision;
  const human = await currentDesktopFilesystemGrantUserId();
  const relay = getPersistedDesktopRelayId();
  if (!root || !human || !relay) return { kind: "unavailable", code: "unsupported_environment" };
  try {
    assertPathInAllowedRoot(value["path"]);
    const canonical = await fsp.realpath(value["path"]);
    const canonicalRoot = await fsp.realpath(root);
    const relative = path.relative(canonicalRoot, canonical);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return { kind: "unavailable", code: "outside_current_folder" };
    }
    const runtime = getDesktopDocumentMutationRuntime();
    if (!runtime) return { kind: "unavailable", code: "history_unavailable" };
    const result = await runtime.readAuthoredChange({ path: canonical, expectedSha256: value["expectedSha256"] });
    assertMainWindowSender(e);
    if (e.sender.isDestroyed() || currentFolderPath !== root || currentFolderRevision !== revision ||
        await currentDesktopFilesystemGrantUserId() !== human || getPersistedDesktopRelayId() !== relay) {
      return { kind: "unavailable", code: "authority_changed" };
    }
    return result;
  } catch { return { kind: "unavailable", code: "history_unavailable" }; }
});

ipcMain.handle(
  "binaryRead:open",
  async (e, args: { path?: unknown } | null | undefined) => {
    assertMainWindowSender(e);
    bindBinaryReadSender(e.sender);
    const result = await asBinaryReadSessionResult(async () => {
      // Preserve the existing authority order, then repeat the check against the
      // canonical path inside BinaryReadSessionManager before opening the handle.
      if (!args || typeof args.path !== "string") {
        return await binaryReadSessions.open(e.sender.id, undefined);
      }
      assertPathInAllowedRoot(args.path);
      const opened = await binaryReadSessions.open(e.sender.id, args.path);
      // A navigation/destruction can happen while the async open was pending.
      if (
        e.sender.isDestroyed() ||
        !binaryReadSenderBindings.has(e.sender.id)
      ) {
        await binaryReadSessions.close(e.sender.id, opened.id);
        throw new Error("Binary read sender is no longer active");
      }
      return opened;
    });
    retireBinaryReadSenderBindingIfIdle(e.sender.id);
    return result;
  },
);

ipcMain.handle(
  "binaryRead:read",
  async (e, args: { id?: unknown; position?: unknown } | null | undefined) => {
    assertMainWindowSender(e);
    const result = await asBinaryReadSessionResult(() =>
      binaryReadSessions.read(e.sender.id, args?.id, args?.position),
    );
    retireBinaryReadSenderBindingIfIdle(e.sender.id);
    return result;
  },
);

ipcMain.handle(
  "binaryRead:close",
  async (e, args: { id?: unknown } | null | undefined) => {
    assertMainWindowSender(e);
    const result = await asBinaryReadSessionResult(async () => {
      await binaryReadSessions.close(e.sender.id, args?.id);
      return null;
    });
    retireBinaryReadSenderBindingIfIdle(e.sender.id);
    return result;
  },
);

// D385/D378 — the renderer never submits a source path. It supplies the path
// of the document it already has open plus a project-relative ref; main
// canonicalizes both under the active Current Folder before the executor sees
// an opaque source token. The resulting URL is a revocable capability, not a
// `file:` URL and not an output path.
ipcMain.handle(
  "mediaProxy:open",
  async (e, args: unknown) => {
    assertMainWindowSender(e);
    const input = ipcRecord(args);
    const requestId = input?.["requestId"];
    const documentPath = input?.["documentPath"];
    const ref = input?.["ref"];
    if (!isOpaqueMediaProxyId(requestId) || typeof documentPath !== "string" || !isValidBoundMediaRef(ref)) {
      return { ok: false as const, error: { code: "invalid_request" } };
    }
    if (!currentFolderPath) return { ok: false as const, error: { code: "unsupported_environment" } };
    const key = mediaProxyKey(e.sender.id, requestId);
    if (mediaProxyInflight.has(key)) return { ok: false as const, error: { code: "invalid_request" } };
    const boundRoot = currentFolderPath;
    const boundRevision = currentFolderRevision;
    const controller = new AbortController();
    bindMediaProxySender(e.sender);
    mediaProxyInflight.set(key, { ownerId: e.sender.id, controller, scope: "current-folder" });
    let sourceDirectory: string | undefined;
    let retainSource = false;
    try {
      const root = await fsp.realpath(boundRoot);
      const canonicalDocument = await fsp.realpath(documentPath);
      if (!isCanonicalPathWithinRoot(canonicalDocument, root)) return { ok: false as const, error: { code: "source_unavailable" } };
      const candidate = path.resolve(path.dirname(canonicalDocument), ref);
      const canonicalSource = await fsp.realpath(candidate);
      if (!isCanonicalPathWithinRoot(canonicalSource, root)) return { ok: false as const, error: { code: "source_unavailable" } };
      const stat = await fsp.stat(canonicalSource);
      if (!stat.isFile()) return { ok: false as const, error: { code: "source_unavailable" } };
      sourceDirectory = await fsp.mkdtemp(path.join(tmpdir(), "nautilo-media-source-"));
      const sourcePath = path.join(sourceDirectory, "source");
      if (!await copyMediaSnapshot(canonicalSource, sourcePath, { signal: controller.signal })) return { ok: false as const, error: { code: controller.signal.aborted ? "cancelled" : "source_unavailable" } };
      const ffmpeg = await probeDesktopFfmpeg({ isPackaged: app.isPackaged });
      if (!ffmpeg.ok) return { ok: false as const, error: { code: "processing_unavailable" } };
      const metadata = await inspectMediaSource(ffmpeg.binaryPath, sourcePath, { signal: controller.signal });
      if (controller.signal.aborted || e.sender.isDestroyed() || boundRevision !== currentFolderRevision || boundRoot !== currentFolderPath) return { ok: false as const, error: { code: "cancelled" } };
      if (!metadata) return { ok: false as const, error: { code: "unsupported_type" } };
      const waveform = metadata.mediaKind === "image" ? null : await inspectMediaWaveform(ffmpeg.binaryPath, sourcePath, controller.signal);
      if (metadata.mediaKind !== "video") {
        const outputRef = `proxy_${randomUUID().replace(/-/g, "")}`;
        const previewToken = `preview_${randomUUID().replace(/-/g, "")}`;
        const sizeBytes = (await fsp.stat(sourcePath)).size;
        if (controller.signal.aborted || e.sender.isDestroyed()) return { ok: false as const, error: { code: "cancelled" } };
        mediaProxyOutputs.set(outputRef, { lifetime: new AbortController(), ownerId: e.sender.id, previewToken, outputPath: sourcePath, parentDir: sourceDirectory, mimeType: metadata.mimeType, sizeBytes });
        retainSource = true;
        return { ok: true as const, data: { url: `nautilo-media://proxy/${previewToken}`, mimeType: metadata.mimeType, sizeBytes, revokeToken: previewToken, ...(waveform ? { waveform } : {}) } };
      }
      const sourceRef = `source_${randomUUID().replace(/-/g, "")}`;
      const result = await executeMediaProcess({
        type: "relay:media-process-request",
        version: MEDIA_PROCESS_PROTOCOL_VERSION,
        requestId,
        operation: "transcode_proxy",
        sourceRef,
      }, {
        resolveSource: (candidateRef) => Promise.resolve(candidateRef === sourceRef
          ? { ok: true as const, canonicalPath: sourcePath }
          : { ok: false as const }),
        resolveFfmpeg: async () => {
          const resolved = await probeDesktopFfmpeg({ isPackaged: app.isPackaged });
          return resolved.ok ? { ok: true, binaryPath: resolved.binaryPath } : { ok: false };
        },
        registerOutput: async (output) => {
          if (output.signal?.aborted) return { ok: false };
          const parentDir = await fsp.mkdtemp(path.join(tmpdir(), "nautilo-media-proxy-"));
          const outputRef = `proxy_${randomUUID().replace(/-/g, "")}`;
          const previewToken = `preview_${randomUUID().replace(/-/g, "")}`;
          const outputPath = path.join(parentDir, "preview.mp4");
          try {
            await fsp.rename(output.outputPath, outputPath);
            mediaProxyOutputs.set(outputRef, {
              lifetime: new AbortController(),
              ownerId: e.sender.id,
              previewToken,
              outputPath,
              parentDir,
              mimeType: "video/mp4",
              sizeBytes: output.sizeBytes,
            });
            return { ok: true as const, outputRef };
          } catch {
            await fsp.rm(parentDir, { recursive: true, force: true }).catch(() => {});
            return { ok: false as const };
          }
        },
        discardOutput: discardMediaProxyOutput,
        signal: controller.signal,
        onProgress: (progress: MediaProcessProgress) => {
          if (!e.sender.isDestroyed()) e.sender.send("mediaProxy:progress", { requestId, progress });
        },
      });
      if (result.status !== "succeeded") {
        return { ok: false as const, error: { code: result.status === "failed" ? result.code : "cancelled" } };
      }
      const output = mediaProxyOutputs.get(result.outputRef);
      if (!output || output.ownerId !== e.sender.id) return { ok: false as const, error: { code: "output_registration_failed" } };
      return {
        ok: true as const,
        data: {
          url: `nautilo-media://proxy/${output.previewToken}`,
          mimeType: output.mimeType,
          sizeBytes: output.sizeBytes,
          revokeToken: output.previewToken,
          ...(waveform ? { waveform } : {}),
        },
      };
    } catch { return { ok: false as const, error: { code: controller.signal.aborted ? "cancelled" : "source_unavailable" } }; }
    finally {
      mediaProxyInflight.delete(key);
      if (sourceDirectory && !retainSource) await fsp.rm(sourceDirectory, { recursive: true, force: true }).catch(() => {});
    }
  },
);

ipcMain.handle("mediaProxy:cancel", (e, args: unknown) => {
  assertMainWindowSender(e);
  const requestId = ipcRecord(args)?.["requestId"];
  if (!isOpaqueMediaProxyId(requestId)) return { ok: false as const, error: { code: "invalid_request" } };
  const pending = mediaProxyInflight.get(mediaProxyKey(e.sender.id, requestId));
  if (!pending) return { ok: true as const, data: null };
  pending.controller.abort();
  return { ok: true as const, data: null };
});

// D378 — dedicated Current Folder sequence export. The renderer supplies only
// its already-bound document path and last saved SHA; this host rereads and
// lowers that exact file before resolving any project-relative media source.
ipcMain.handle("mediaExport:start", async (e, args: unknown) => {
  assertMainWindowSender(e);
  const input = ipcRecord(args);
  const requestId = input?.["requestId"];
  const documentPath = input?.["documentPath"];
  const expectedSha256 = input?.["expectedSha256"];
  const exportSettings = normalizeVideoExportSettings(input?.["exportSettings"]);
  if (!exportSettings) return { ok: false as const, error: { code: "invalid_settings" } };
  if (!isOpaqueMediaProxyId(requestId) || typeof documentPath !== "string" || typeof expectedSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSha256)) {
    return { ok: false as const, error: { code: "invalid_request" } };
  }
  if (!currentFolderPath) return { ok: false as const, error: { code: "unsupported_environment" } };
  const boundFolderPath = currentFolderPath;
  const boundFolderRevision = currentFolderRevision;
  const key = mediaProxyKey(e.sender.id, requestId);
  if (mediaProxyInflight.has(key)) return { ok: false as const, error: { code: "invalid_request" } };
  const controller = new AbortController();
  bindMediaProxySender(e.sender);
  mediaProxyInflight.set(key, { ownerId: e.sender.id, controller, scope: "current-folder" });
  try {
    const ffmpeg = await probeDesktopFfmpeg({ isPackaged: app.isPackaged });
    if (controller.signal.aborted || e.sender.isDestroyed() || currentFolderRevision !== boundFolderRevision || currentFolderPath !== boundFolderPath) return { ok: true as const, data: { status: "cancelled" as const } };
    if (!ffmpeg.ok) return { ok: false as const, error: { code: "ffmpeg_unavailable" } };
    const result = await exportCurrentFolderSequence({
      activeRoot: boundFolderPath,
      exportSettings,
      documentPath,
      expectedSha256,
      ffmpegPath: ffmpeg.binaryPath,
      chooseOutput: async (suggestedName) => {
        if (!mainWindow || e.sender.isDestroyed() || currentFolderRevision !== boundFolderRevision) return null;
        const selected = await dialog.showSaveDialog(mainWindow, { title: "Export video", defaultPath: path.join(path.dirname(documentPath), suggestedName), filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
        return selected.canceled ? null : selected.filePath ?? null;
      },
      signal: controller.signal,
      onProgress: (progress) => { if (!e.sender.isDestroyed()) e.sender.send("mediaExport:progress", { requestId, progress }); },
    });
    return result.status === "failed" ? { ok: false as const, error: { code: result.code } } : { ok: true as const, data: result };
  } finally { mediaProxyInflight.delete(key); }
});

ipcMain.handle("mediaExport:startWorkspace", async (e, args: unknown) => {
  assertMainWindowSender(e);
  const input = ipcRecord(args);
  const exportSettings = normalizeVideoExportSettings(input?.["exportSettings"]);
  if (!exportSettings) return { ok: false as const, error: { code: "invalid_settings" } };
  const requestId = input?.["requestId"];
  if (!isOpaqueMediaProxyId(requestId) || typeof input?.["documentContent"] !== "string" ||
      typeof input["expectedSha256"] !== "string" || typeof input["roomId"] !== "string" || !Array.isArray(input["sources"]) ||
      (input["publishToWorkspace"] !== undefined && typeof input["publishToWorkspace"] !== "boolean")) {
    return { ok: false as const, error: { code: "invalid_request" } };
  }
  const key = mediaProxyKey(e.sender.id, requestId);
  if (mediaProxyInflight.has(key)) return { ok: false as const, error: { code: "invalid_request" } };
  const activeSession = serverSessions.active;
  if (!activeSession || serverSessions.getBySender(e.sender.id) !== activeSession) return { ok: false as const, error: { code: "unsupported_environment" } };
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) return { ok: false as const, error: { code: "unsupported_environment" } };
  let authority: ActiveAuthority;
  try { authority = authoritativeConnectionSnapshot(); }
  catch { return { ok: true as const, data: { status: "cancelled" as const } }; }
  const authorityCurrent = () => {
    try {
      const current = authoritativeConnectionSnapshot();
      return !e.sender.isDestroyed() && serverSessions.active === activeSession &&
        serverSessions.getBySender(e.sender.id) === activeSession && resolvedServerUrl() === serverUrl &&
        current.scope === authority.scope && current.revision === authority.revision &&
        current.connectionAttemptId === authority.connectionAttemptId && current.serverFingerprint === authority.serverFingerprint;
    } catch { return false; }
  };
  const controller = new AbortController();
  bindMediaProxySender(e.sender);
  mediaProxyInflight.set(key, { ownerId: e.sender.id, controller, scope: "workspace" });
  const unsubscribeAuthority = serverSessions.onChange(() => {
    if (!authorityCurrent()) controller.abort();
  });
  try {
    let bearer: string | null;
    try { bearer = await getValidAccessToken({ refresh: refreshTokens, onObservedRejection: onLogtoRefreshFailed }); }
    catch { bearer = null; }
    if (controller.signal.aborted || !authorityCurrent()) return { ok: true as const, data: { status: "cancelled" as const } };
    if (!bearer) return { ok: false as const, error: { code: "not_signed_in" } };
    const ffmpeg = await probeDesktopFfmpeg({ isPackaged: app.isPackaged });
    if (controller.signal.aborted || !authorityCurrent()) return { ok: true as const, data: { status: "cancelled" as const } };
    if (!ffmpeg.ok) return { ok: false as const, error: { code: "ffmpeg_unavailable" } };
    const workspaceInput: WorkspaceSequenceExportInput = {
      exportSettings,
      documentContent: input["documentContent"], expectedSha256: input["expectedSha256"], roomId: input["roomId"],
      sources: input["sources"] as WorkspaceSequenceSourceBinding[],
    };
    let authenticationRejected = false;
    const workspacePath = sequenceWorkspaceOutputPath("video");
    const result = await exportWorkspaceSequence(workspaceInput, {
      ffmpegPath: ffmpeg.binaryPath,
      fetchSource: async (source, signal) => {
        if (!authorityCurrent()) throw new Error("server_authority_changed");
        const endpoint = `${serverUrl.replace(/\/$/u, "")}/api/workspace/artifacts/${encodeURIComponent(source.artifactRowId)}/bytes?roomId=${encodeURIComponent(workspaceInput.roomId)}`;
        const response = await fetch(endpoint, { headers: { authorization: `Bearer ${bearer}` }, redirect: "error", ...(signal ? { signal } : {}) });
        if (response.status === 401) authenticationRejected = true;
        return response;
      },
      chooseOutput: async (suggestedName) => {
        if (!mainWindow || !authorityCurrent()) return null;
        const selected = await dialog.showSaveDialog(mainWindow, { title: "Export video", defaultPath: suggestedName, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
        return selected.canceled ? null : selected.filePath ?? null;
      },
      signal: controller.signal,
      isAuthorityCurrent: authorityCurrent,
      ...(input["publishToWorkspace"] === true ? { workspacePublication: {
        path: workspacePath,
        publish: async (stagedPath: string, sizeBytes: number) => await publishSequenceToWorkspace({
          stagedPath, sizeBytes, workspacePath, roomId: workspaceInput.roomId,
          serverUrl, bearer, signal: controller.signal, isAuthorityCurrent: authorityCurrent,
        }),
      } } : {}),
      onProgress: (progress) => { if (authorityCurrent()) e.sender.send("mediaExport:progress", { requestId, progress }); },
    });
    // Preserve a publication that already crossed its exclusive-link commit
    // point, but normalize every earlier authority/cancellation exit.
    if (result.status !== "succeeded" && (controller.signal.aborted || !authorityCurrent())) {
      return { ok: true as const, data: { status: "cancelled" as const } };
    }
    if (authenticationRejected) return { ok: false as const, error: { code: "not_signed_in" } };
    return result.status === "failed" ? { ok: false as const, error: { code: result.code } } : { ok: true as const, data: result };
  } catch {
    return controller.signal.aborted || !authorityCurrent()
      ? { ok: true as const, data: { status: "cancelled" as const } }
      : { ok: false as const, error: { code: "processing_failed" } };
  }
  finally { unsubscribeAuthority(); mediaProxyInflight.delete(key); }
});

ipcMain.handle("mediaExport:promoteVideoProject", async (e, args: unknown) => {
  assertMainWindowSender(e);
  const input = ipcRecord(args); const requestId = input?.["requestId"];
  const documentPath = input?.["documentPath"]; const expectedSha256 = input?.["expectedSha256"]; const roomId = input?.["roomId"];
  if (!input || Object.keys(input).some((key) => !["requestId", "documentPath", "expectedSha256", "roomId"].includes(key)) ||
      !isOpaqueMediaProxyId(requestId) || typeof documentPath !== "string" || typeof expectedSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expectedSha256) || typeof roomId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(roomId)) {
    return { ok: false as const, error: { code: "invalid_request" } };
  }
  const root = currentFolderPath; const folderRevision = currentFolderRevision;
  const human = await currentDesktopFilesystemGrantUserId(); const relay = getPersistedDesktopRelayId();
  const activeSession = serverSessions.active; const serverUrl = resolvedServerUrl();
  if (!root || !human || !relay || !activeSession || !serverUrl || serverSessions.getBySender(e.sender.id) !== activeSession) {
    return { ok: false as const, error: { code: "unsupported_environment" } };
  }
  let connection: ActiveAuthority;
  try { connection = authoritativeConnectionSnapshot(); } catch { return { ok: true as const, data: { status: "cancelled", code: "authority_changed", retainedPaths: [] } }; }
  let authRefreshToken: string | null = null;
  const authorityCurrent = () => {
    try { assertMainWindowSender(e); const now = authoritativeConnectionSnapshot(); return authRefreshToken !== null && loadTokensFor(serverUrl)?.refresh_token === authRefreshToken && !e.sender.isDestroyed() && currentFolderPath === root && currentFolderRevision === folderRevision &&
      getPersistedDesktopRelayId() === relay && serverSessions.active === activeSession &&
      serverSessions.getBySender(e.sender.id) === activeSession && resolvedServerUrl() === serverUrl && now.scope === connection.scope &&
      now.revision === connection.revision && now.connectionAttemptId === connection.connectionAttemptId && now.serverFingerprint === connection.serverFingerprint; }
    catch { return false; }
  };
  const key = mediaProxyKey(e.sender.id, requestId);
  if (mediaProxyInflight.has(key)) return { ok: false as const, error: { code: "invalid_request" } };
  const controller = new AbortController(); bindMediaProxySender(e.sender);
  mediaProxyInflight.set(key, { ownerId: e.sender.id, controller, scope: "current-folder" });
  const unsubscribeAuthority = serverSessions.onChange(() => { if (!authorityCurrent()) controller.abort(); });
  try {
    let bearer: string | null;
    try { bearer = await getValidAccessToken({ refresh: refreshTokens, onObservedRejection: onLogtoRefreshFailed }); } catch { bearer = null; }
    if (!bearer) return { ok: false as const, error: { code: "not_signed_in" } };
    const admittedTokens = loadTokensFor(serverUrl);
    const currentHuman = await currentDesktopFilesystemGrantUserId();
    const currentTokens = loadTokensFor(serverUrl);
    if (currentHuman !== human || !admittedTokens || !currentTokens || admittedTokens.access_token !== bearer ||
        currentTokens.access_token !== bearer || currentTokens.refresh_token !== admittedTokens.refresh_token) {
      return { ok: true as const, data: { status: "cancelled", code: "authority_changed", retainedPaths: [] } };
    }
    authRefreshToken = currentTokens.refresh_token;
    if (!authorityCurrent()) return { ok: true as const, data: { status: "cancelled", code: "authority_changed", retainedPaths: [] } };
    const result = await promoteVideoProject({ documentPath, expectedSha256 }, { rootPath: root, roomId, serverUrl, bearer,
      isAuthorityCurrent: authorityCurrent, signal: controller.signal,
      onProgress: (progress) => { if (authorityCurrent()) e.sender.send("mediaExport:progress", { requestId, progress }); } });
    return { ok: true as const, data: projectVideoPromotionResult(result, authorityCurrent()) };
  } catch { return { ok: false as const, error: { code: "processing_failed" } }; }
  finally { unsubscribeAuthority(); mediaProxyInflight.delete(key); }
});

ipcMain.handle("mediaExport:cancel", (e, args: unknown) => {
  assertMainWindowSender(e);
  const requestId = ipcRecord(args)?.["requestId"];
  if (!isOpaqueMediaProxyId(requestId)) return { ok: false as const, error: { code: "invalid_request" } };
  mediaProxyInflight.get(mediaProxyKey(e.sender.id, requestId))?.controller.abort();
  return { ok: true as const, data: null };
});

ipcMain.handle("mediaProxy:importVideo", async (e, args: unknown) => {
  assertMainWindowSender(e);
  return await probePickedVideoFromCurrentFolder(ipcRecord(args)?.["documentPath"]);
});

/** Reuses native upload, private staging and preview lifecycle; no renderer byte transport. */
async function workspaceMediaTransfer(e: Electron.IpcMainInvokeEvent, args: unknown, operation: "import" | "importBatch" | "preview") {
  assertMainWindowSender(e);
  const input = ipcRecord(args);
  const requestId = input?.["requestId"]; const roomId = input?.["roomId"];
  const mediaKind = input?.["mediaKind"]; const artifact = input?.["artifact"];
  const fail = (code: string) => ({ ok: false as const, error: { code } });
  if (!input || !isOpaqueMediaProxyId(requestId) || !isWorkspaceMediaRoom(roomId) ||
      Object.keys(input).some((key) => !["requestId", "roomId", operation === "preview" ? "artifact" : "mediaKind"].includes(key)) ||
      (operation === "preview" && !isWorkspaceMediaArtifact(artifact)) ||
      (operation === "importBatch" && mediaKind !== "image") ||
      (operation === "import" && mediaKind !== undefined && mediaKind !== "image" && mediaKind !== "video" && mediaKind !== "audio")) return fail("invalid_request");
  const admittedMediaKind = mediaKind === "image" || mediaKind === "video" || mediaKind === "audio" ? mediaKind : undefined;
  const activeSession = serverSessions.active; const serverUrl = resolvedServerUrl();
  if (!mainWindow || !activeSession || !serverUrl || serverSessions.getBySender(e.sender.id) !== activeSession) return fail("unsupported_environment");
  const key = mediaProxyKey(e.sender.id, requestId);
  if (mediaProxyInflight.has(key)) return fail("invalid_request");
  let authority: ActiveAuthority;
  try { authority = authoritativeConnectionSnapshot(); } catch { return fail("unsupported_environment"); }
  const authGeneration = mediaAuthGeneration;
  const authorityCurrent = () => {
    try {
      const now = authoritativeConnectionSnapshot();
      return !e.sender.isDestroyed() && serverSessions.active === activeSession && serverSessions.getBySender(e.sender.id) === activeSession &&
        resolvedServerUrl() === serverUrl && now.scope === authority.scope && now.revision === authority.revision &&
        now.connectionAttemptId === authority.connectionAttemptId && now.serverFingerprint === authority.serverFingerprint &&
        mediaAuthGeneration === authGeneration && loadTokensFor(serverUrl) !== null;
    } catch { return false; }
  };
  const controller = new AbortController();
  bindMediaProxySender(e.sender);
  mediaProxyInflight.set(key, { ownerId: e.sender.id, controller, scope: "workspace" });
  const unsubscribe = serverSessions.onChange(() => { if (!authorityCurrent()) controller.abort(); });
  try {
    const bearer = await getValidAccessToken({ refresh: refreshTokens, onObservedRejection: onLogtoRefreshFailed });
    if (!bearer || !loadTokensFor(serverUrl)) return fail("not_signed_in");
    if (!authorityCurrent() || controller.signal.aborted) return fail("cancelled");
    const ffmpeg = await probeDesktopFfmpeg({ isPackaged: app.isPackaged });
    if (!ffmpeg.ok) return fail("ffmpeg_unavailable");
    const deps = { serverUrl, bearer, roomId, ffmpegPath: ffmpeg.binaryPath, signal: controller.signal, isAuthorityCurrent: authorityCurrent };
    if (operation === "import" || operation === "importBatch") {
      const selection = await dialog.showOpenDialog(mainWindow, {
        title: operation === "importBatch" ? "Add image references to Workspace" : admittedMediaKind ? `Add ${admittedMediaKind} reference to Workspace` : "Import media into Workspace",
        properties: operation === "importBatch" ? ["openFile", "multiSelections"] : ["openFile"],
        filters: [{ name: "Media", extensions: admittedMediaKind === "image" ? ["png", "jpg", "jpeg", "webp"] : admittedMediaKind === "audio" ? ["mp3", "wav", "m4a"] : admittedMediaKind === "video" ? ["mp4"] : ["mp4", "m4v", "m4a", "mp3", "wav", "png", "jpg", "jpeg", "webp"] }],
      });
      if (selection.canceled || !selection.filePaths[0] || !authorityCurrent() || controller.signal.aborted) return fail("cancelled");
      if (operation === "importBatch") {
        return { ok: true as const, data: await importPickedWorkspaceMediaBatch(selection.filePaths, deps) };
      }
      return await importPickedWorkspaceMedia(selection.filePaths[0], admittedMediaKind, deps);
    }
    if (!isWorkspaceMediaArtifact(artifact)) return fail("invalid_request");
    const staged = await stageWorkspaceMedia(artifact, deps);
    if (!staged.ok) return controller.signal.aborted || !authorityCurrent()
      ? fail("cancelled")
      : { ok: false as const, error: { code: staged.code, ...(staged.httpStatus !== undefined ? { httpStatus: staged.httpStatus } : {}) } };
    const stagedData = staged.data;
    if (!authorityCurrent() || controller.signal.aborted) {
      await fsp.rm(stagedData.parentDir, { recursive: true, force: true });
      return fail("cancelled");
    }
    const previewToken = randomUUID();
    mediaProxyOutputs.set(previewToken, { lifetime: new AbortController(), ownerId: e.sender.id, previewToken, outputPath: stagedData.outputPath, parentDir: stagedData.parentDir,
      mimeType: artifact.mimeType, sizeBytes: artifact.size, isAuthorityCurrent: authorityCurrent });
    return { ok: true as const, data: { url: `nautilo-media://proxy/${previewToken}`, revokeToken: previewToken, mimeType: artifact.mimeType,
      sizeBytes: artifact.size, sha256: stagedData.sha256, mediaKind: stagedData.metadata.mediaKind,
      ...(stagedData.waveform ? { waveform: stagedData.waveform } : {}),
      ...(stagedData.metadata.mediaKind !== "image" ? { durationSec: stagedData.metadata.durationSec } : {}),
      ...(stagedData.metadata.mediaKind === "video" ? { frameRate: stagedData.metadata.frameRate } : {}) } };
  } catch { return fail(controller.signal.aborted || !authorityCurrent() ? "cancelled" : "processing_unavailable"); }
  finally { unsubscribe(); mediaProxyInflight.delete(key); }
}
ipcMain.handle("mediaProxy:importWorkspace", (e, args: unknown) => workspaceMediaTransfer(e, args, "import"));
ipcMain.handle("mediaProxy:importWorkspaceBatch", (e, args: unknown) => workspaceMediaTransfer(e, args, "importBatch"));
ipcMain.handle("mediaProxy:openWorkspace", (e, args: unknown) => workspaceMediaTransfer(e, args, "preview"));

ipcMain.handle("mediaProxy:close", async (e, args: unknown) => {
  assertMainWindowSender(e);
  const revokeToken = ipcRecord(args)?.["revokeToken"];
  if (!isOpaqueMediaProxyId(revokeToken)) return { ok: false as const, error: { code: "invalid_request" } };
  const entry = findMediaProxyByPreviewToken(revokeToken);
  if (entry && entry[1].ownerId === e.sender.id) await discardMediaProxyOutput(entry[0]);
  // Closing an absent/already-revoked token is intentionally idempotent.
  return { ok: true as const, data: null };
});

ipcMain.handle("fs:stat", async (e, args: { path: string }) => {
  assertMainWindowSender(e);
  assertPathInAllowedRoot(args.path);
  try {
    const stat = await fsp.stat(args.path);
    const relayId = getPersistedDesktopRelayId();
    const canonicalPath = await dynamicDocumentMutationFileAdapter.canonicalize(
      args.path,
    );
    return {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modified: stat.mtime.toISOString(),
      documentIdentity: relayId
        ? { kind: "local_file" as const, relayId, canonicalPath }
        : null,
    };
  } catch {
    return {
      exists: false,
      isFile: false,
      isDirectory: false,
      size: 0,
      modified: null,
      documentIdentity: null,
    };
  }
});

registerFsStructuralIpcHandlers({
  ipcMain: {
    handle: (channel, listener) =>
      ipcMain.handle(
        channel,
        listener as (
          event: Electron.IpcMainInvokeEvent,
          ...args: unknown[]
        ) => unknown,
      ),
  },
  assertSender: assertMainWindowSender,
  assertPathInAllowedRoot,
  fs: {
    readFile: (filePath) => fsp.readFile(filePath),
    writeFile: (filePath, data) => fsp.writeFile(filePath, data),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (filePath) => fsp.unlink(filePath),
  },
  shell,
  createFileExclusive: createCompatibilityFileExclusively,
  editorSave: {
    saveExistingFile: async (input) => {
      const runtime = getDesktopDocumentMutationRuntime();
      if (!runtime) {
        const mismatch = desktopDocumentMutationRelayBindingMismatch;
        return {
          ok: false,
          code: "error" as const,
          message: mismatch
            ? `Desktop local mutation history is bound to relay ${mismatch.expectedRelayId}; relay ${mismatch.actualRelayId} requires an explicit whole-history rebind`
            : "Desktop relay identity is unavailable; editor save was not committed",
        };
      }
      return await runtime.saveExistingFile(input);
    },
  },
});

/**
 * D448 Phase 10 — local-file human-edit presence stays in the Desktop process.
 * The renderer provides only candidate transport data; the runtime derives the
 * active human/relay, canonical identity, and exact bytes under the existing
 * allowed-root guard before touching its local lease registry.
 */
function unavailableLocalLeaseResult() {
  const mismatch = desktopDocumentMutationRelayBindingMismatch;
  return {
    status: "invalid" as const,
    reason: mismatch
      ? `Desktop local mutation history is bound to relay ${mismatch.expectedRelayId}; relay ${mismatch.actualRelayId} requires an explicit whole-history rebind`
      : "Desktop local lease runtime is unavailable",
  };
}

ipcMain.handle(
  "documentMutations:humanEditLeases:register",
  async (event, input: unknown) => {
    assertMainWindowSender(event);
    const runtime = getDesktopDocumentMutationRuntime();
    return runtime === undefined
      ? unavailableLocalLeaseResult()
      : await runtime.registerHumanEditLease(input);
  },
);
ipcMain.handle(
  "documentMutations:humanEditLeases:update",
  async (event, payload: unknown) => {
    assertMainWindowSender(event);
    const data = payload as { leaseId?: unknown; input?: unknown } | null;
    const runtime = getDesktopDocumentMutationRuntime();
    return runtime === undefined
      ? unavailableLocalLeaseResult()
      : await runtime.updateHumanEditLease(
          typeof data?.leaseId === "string" ? data.leaseId : "",
          data?.input,
        );
  },
);
ipcMain.handle(
  "documentMutations:humanEditLeases:renew",
  async (event, payload: unknown) => {
    assertMainWindowSender(event);
    const data = payload as { leaseId?: unknown; input?: unknown } | null;
    const runtime = getDesktopDocumentMutationRuntime();
    return runtime === undefined
      ? unavailableLocalLeaseResult()
      : await runtime.renewHumanEditLease(
          typeof data?.leaseId === "string" ? data.leaseId : "",
          data?.input,
        );
  },
);
ipcMain.handle(
  "documentMutations:humanEditLeases:release",
  async (event, payload: unknown) => {
    assertMainWindowSender(event);
    const data = payload as { leaseId?: unknown; input?: unknown } | null;
    const runtime = getDesktopDocumentMutationRuntime();
    return runtime === undefined
      ? unavailableLocalLeaseResult()
      : await runtime.releaseHumanEditLease(
          typeof data?.leaseId === "string" ? data.leaseId : "",
          data?.input,
        );
  },
);

ipcMain.handle("miniAppRecovery:open", async (event, raw: unknown) => {
  try {
    const input = parseMiniAppRecoveryOpenInput(raw);
    if (!input) {
      throw new MiniAppRecoveryError("invalid", "Draft recovery request is invalid.");
    }
    const initialAuthGeneration = miniAppRecoveryAuthGeneration;
    const session = resolveSessionFromSender(event);
    const authenticated = await resolveReadyToWorkBindingForSession(session);
    if (authenticated.humanId !== input.expectedViewerId) {
      throw new MiniAppRecoveryError(
        "authority_changed",
        "Draft recovery is unavailable for this account.",
      );
    }
    const target = await resolveMiniAppRecoveryTarget(input.target);
    const context = miniAppRecoveryHandleContext(event);
    if (
      context.authGeneration !== initialAuthGeneration ||
      context.canonicalOrigin !== authenticated.authority.scope ||
      context.serverFingerprint !== authenticated.authority.serverFingerprint
    ) {
      throw new MiniAppRecoveryError(
        "authority_changed",
        "Draft recovery authorization changed while opening.",
      );
    }
    const binding: MiniAppRecoveryBinding = {
      owner: {
        humanId: authenticated.humanId,
        canonicalOrigin: context.canonicalOrigin,
        serverFingerprint: context.serverFingerprint,
      },
      appId: input.appId,
      target,
    };
    const handle = desktopMiniAppRecoveryRuntime().open(
      event.sender.id,
      context.authGeneration,
      binding,
    );
    observeMiniAppRecoverySender(event.sender);
    return { handle };
  } catch (error) {
    throwMiniAppRecoveryIpcError(error);
  }
});

ipcMain.handle("miniAppRecovery:read", async (event, handle: unknown) => {
  try {
    if (typeof handle !== "string" || handle.length === 0) {
      throw new MiniAppRecoveryError("invalid", "Draft recovery request is invalid.");
    }
    return await desktopMiniAppRecoveryRuntime().read(
      miniAppRecoveryHandleContext(event),
      handle,
    );
  } catch (error) {
    throwMiniAppRecoveryIpcError(error);
  }
});

ipcMain.handle("miniAppRecovery:write", async (event, raw: unknown) => {
  try {
    const payload = raw as { handle?: unknown; input?: unknown } | null;
    const input = parseMiniAppRecoveryWriteInput(payload?.input);
    if (typeof payload?.handle !== "string" || payload.handle.length === 0 || !input) {
      throw new MiniAppRecoveryError("invalid", "Draft recovery request is invalid.");
    }
    return await desktopMiniAppRecoveryRuntime().write(
      miniAppRecoveryHandleContext(event),
      payload.handle,
      input.expectedRevision,
      input.draft,
    );
  } catch (error) {
    throwMiniAppRecoveryIpcError(error);
  }
});

ipcMain.handle("miniAppRecovery:close", async (event, handle: unknown) => {
  try {
    if (typeof handle !== "string" || handle.length === 0) {
      throw new MiniAppRecoveryError("invalid", "Draft recovery request is invalid.");
    }
    const context = miniAppRecoveryHandleContext(event);
    await desktopMiniAppRecoveryRuntime().close(context.senderId, handle);
  } catch (error) {
    throwMiniAppRecoveryIpcError(error);
  }
});

ipcMain.on("document:mutationReady", (event, raw: unknown) => {
  try {
    assertMainWindowSender(event);
    const rendererId = event.sender.id;
    const epoch =
      raw && typeof raw === "object"
        ? (raw as { epoch?: unknown }).epoch
        : undefined;
    if (epoch !== documentMutationRendererEpoch(rendererId)) return;
    documentMutationReadyRenderers.add(rendererId);
    if (!documentMutationRendererCleanup.has(rendererId)) {
      const sender = event.sender;
      const onDestroyed = () => forgetDocumentMutationRenderer(rendererId);
      const onDidStartNavigation = (
        _event: Electron.Event,
        _url: string,
        isInPlace: boolean,
        isMainFrame: boolean,
      ) => {
        // Workbench route changes keep the same document and preload alive.
        // Clearing readiness for those leaves no new preload to register it
        // again, so every later local-file mutation remains in the outbox.
        if (!isMainFrame || isInPlace) return;
        forgetDocumentMutationRenderer(rendererId);
      };
      sender.once("destroyed", onDestroyed);
      sender.on("did-start-navigation", onDidStartNavigation);
      documentMutationRendererCleanup.set(rendererId, () => {
        sender.removeListener("destroyed", onDestroyed);
        sender.removeListener("did-start-navigation", onDidStartNavigation);
      });
    }
  } catch {
    // Readiness never grants authority.
  }
});
ipcMain.on("document:mutationAck", (event, raw: unknown) => {
  try {
    assertMainWindowSender(event);
    const key =
      raw && typeof raw === "object"
        ? (raw as { idempotencyKey?: unknown }).idempotencyKey
        : undefined;
    if (typeof key !== "string") return;
    const pending = pendingDocumentMutationAcks.get(key);
    if (!pending || pending.rendererId !== event.sender.id) return;
    clearTimeout(pending.timer);
    pendingDocumentMutationAcks.delete(key);
    pending.resolve("published");
  } catch {
    // A foreign renderer cannot acknowledge another renderer's batch.
  }
});

// D357 Phase 3 — jailed fs.mkdir. Mirrors fs:writeFile's guard order:
// sender check first, then path jail. recursive:false matches writeFile's
// no-implicit-parent-mkdir stance — callers must create parents explicitly.
ipcMain.handle(
  "fs:mkdir",
  async (e, args: { path: string }): Promise<FsMkdirResult> => {
    assertMainWindowSender(e);

    try {
      assertPathInAllowedRoot(args.path);
    } catch {
      return { ok: false, code: "forbidden" };
    }

    try {
      await fsp.mkdir(args.path, { recursive: false });
      return { ok: true };
    } catch (err) {
      if (isErrnoException(err) && err.code === "EEXIST") {
        return { ok: false, code: "exists" };
      }
      return {
        ok: false,
        code: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
);

// M055 — Logto auth IPC. The renderer's `useAuth()` Electron branch
// is the only consumer today; the native menu calls handleSignIn /
// handleSignOut directly (so the menu doesn't go through IPC just
// to reach the same main-process state).
ipcMain.handle("auth:status", (e) => {
  const session = resolveSessionFromSender(e);
  return Boolean(loadTokensFor(session.serverUrl));
});

ipcMain.handle("auth:issue", (e) => {
  resolveSessionFromSender(e);
  return getLastAuthIssue();
});

ipcMain.handle("auth:notice", (e) => {
  resolveSessionFromSender(e);
  return consumeAuthNotice();
});

ipcMain.handle("auth:getAccessToken", async (e) => {
  const senderSession = serverSessions.getBySender(e.sender.id);
  if (!senderSession) {
    throw new Error("ipc-denied: sender is not registered");
  }
  // Never disclose a bearer to a background renderer. Older preserved
  // Workbench bundles may continue polling until upgraded; return a quiet
  // null and let them retry normally when their session becomes active.
  if (senderSession !== serverSessions.active) return null;
  if (!senderSession.logtoConfig) return null;
  // M056 — single source of truth for "give me a fresh access token"
  // shared with the relay-pair flow's `ensureRelayToken`. Refresh
  // failure runs `onLogtoRefreshFailed` (menu + all-window broadcast +
  // optional native notification). Token load/save is scoped to the
  // sender's own session via the active-session wrappers.
  return getValidAccessToken({
    refresh: refreshTokens,
    onObservedRejection: onLogtoRefreshFailed,
  });
});

ipcMain.handle(
  "auth:signIn",
  async (e, opts: {
    extraParams?: Record<string, string>;
    theme?: "light" | "dark" | null;
  } | undefined) => {
    resolveSessionFromSender(e);
    const theme = opts?.theme === "light" || opts?.theme === "dark"
      ? opts.theme
      : null;
    return handleSignIn({
      ...(opts?.extraParams ? { extraParams: opts.extraParams } : {}),
      theme,
    });
  },
);

ipcMain.handle(
  "auth:step-up",
  async (e, opts: { maxAgeSeconds?: number } | undefined) => {
    resolveSessionFromSender(e);
    return handleAuthStepUp(opts ?? {});
  },
);

ipcMain.handle("auth:signOut", async (e) => {
  resolveSessionFromSender(e);
  await handleSignOut();
});

ipcMain.handle("auth:report-stale", (e) => {
  resolveSessionFromSender(e);
  invalidateMiniAppRecoveryAuthentication();
  reportStaleToken(broadcastAuthState);
  refreshAuthMenuState(false);
  return { ok: true } as const;
});

ipcMain.handle(
  "auth:open-account-page",
  (
    e,
    args: unknown,
  ): { ok: true } | { ok: false; reason: string } => {
    const session = resolveSessionFromSender(e);
    const rec = args as { path?: unknown };
    const p = rec.path;
    if (p !== "/account" && p !== "/account/password") {
      return { ok: false, reason: "invalid-args" };
    }
    if (!session.logtoConfig) {
      return { ok: false, reason: "no-logto" };
    }
    openLogtoAccountPage(p);
    return { ok: true };
  },
);

ipcMain.handle("auth:openResetUrl", (e, raw: unknown) => {
  resolveSessionFromSender(e);
  if (typeof raw !== "string")
    return { ok: false, reason: "invalid_url" } as const;
  const url = raw.trim();
  if (!validatePasteResetUrl(url))
    return { ok: false, reason: "invalid_url" } as const;
  try {
    openAuthWindow({
      parent: mainWindow,
      url,
      kind: "forgot-password",
    });
    return { ok: true } as const;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "open_failed",
    } as const;
  }
});

/**
 * D103 P4d.9 — Re-probe `/health` on demand so `logtoConfig` recovers
 * from a boot-time probe failure without a full app restart.
 *
 * The renderer's connection-state machine fires this after a
 * `disconnected → connected` transition (e.g. server was down at boot,
 * later came back online; or HTTPS/HTTP mismatch resolved server-side).
 *
 * Idempotent: re-probes the active session URL, which
 * overwrites that session's `logtoConfig` on success and leaves it
 * untouched on failure (so a transient probe blip can never wipe a
 * working config). Returns `{ ok, hasLogto }` so the renderer can show
 * a one-shot "reconnected" toast when `hasLogto` flips from false to
 * true.
 */
ipcMain.handle("auth:reprobe-server", async (e) => {
  const session = resolveSessionFromSender(e);
  await reprobeLogtoConfigDiagnostic(session.serverUrl);
  rebuildApplicationMenu();
  return { ok: true, hasLogto: session.logtoConfig !== null } as const;
});

// D154 — cold-boot bootstrap + picker IPC (connect-mode shell only).
function activeLocalColdBootShell(e?: Electron.IpcMainInvokeEvent): Electron.WebContents | null {
  const renderer = activeRenderer();
  if (!renderer || (e && renderer.id !== e.sender.id)) return null;
  try {
    const url = new URL(renderer.getURL());
    // Recovery state is carried in the query; admission still requires the
    // exact local shell file and the current renderer sender.
    url.search = "";
    url.hash = "";
    return coldBootLocalShellPaths().some((filePath) => pathToFileURL(filePath).href === url.href)
      ? renderer
      : null;
  } catch {
    return null;
  }
}

function assertColdBootActionSender(e: Electron.IpcMainInvokeEvent): void {
  if (!committedColdBootTerminal && !acceptedIdentityColdBootTerminal) return assertMainWindowSender(e);
  if (!activeLocalColdBootShell(e)) throw new Error("ipc-denied: committed recovery sender rejected");
}

ipcMain.on("coldBoot:peekShellState", (event) => {
  event.returnValue = shellStateOnBoot;
});

ipcMain.handle("coldBoot:getBootstrapState", (e) => {
  assertColdBootActionSender(e);
  if (blockedLegacyHandoff) return { kind: "unavailable" as const, serverUrl: resolvedServerUrl() ?? "" };
  const committedState = committedColdBootTerminal?.snapshot();
  if (committedState) {
    return committedState.phase === "recoverable"
      ? { kind: "unavailable" as const, serverUrl: committedColdBootTerminal!.routingServerUrl }
      : { kind: "connecting" as const };
  }
  const precommitState = activePrecommitColdBootTerminal?.snapshot();
  if (precommitState) {
    return precommitState.phase === "recoverable"
      ? { kind: "unavailable" as const, serverUrl: activePrecommitColdBootTerminal!.recoveryTarget }
      : { kind: "connecting" as const };
  }
  const acceptedState = acceptedIdentityColdBootTerminal?.snapshot();
  if (acceptedState) return acceptedState.phase === "recoverable"
    ? { kind: "unavailable" as const, serverUrl: acceptedIdentityColdBootTerminal!.routingServerUrl }
    : { kind: "connecting" as const };
  // The shell itself paints before boot's network-dependent gates settle.
  // Do not let an unusually fast /health result navigate the Workbench ahead
  // of the existing onboarding/setup ordering; boot reloads this local shell
  // once those gates complete.
  if (!coldBootBootstrapReady) return { kind: "connecting" as const };
  if (!resolvedServerUrl()) return { kind: "no-pairing" as const };
  const coldBootObservation = initializeColdBootObservationAuthority().snapshot();
  // Return the typed projection only. `healthBody` remains main-private so a
  // compromised local shell cannot gain provider response content.
  switch (coldBootObservation.kind) {
    case "live":
      return {
        kind: "live" as const,
        serverUrl: coldBootObservation.serverUrl,
      };
    case "unavailable":
      return {
        kind: "unavailable" as const,
        serverUrl: coldBootObservation.serverUrl,
      };
    case "malformed":
      return {
        kind: "malformed" as const,
        serverUrl: coldBootObservation.serverUrl,
      };
    case "wrong-server":
      return {
        kind: "wrong-server" as const,
        serverUrl: coldBootObservation.serverUrl,
      };
    case "no-pairing":
      return { kind: "no-pairing" as const };
    case "connecting":
      return { kind: "connecting" as const };
  }
});

ipcMain.handle("coldBoot:retry", async (e) => {
  assertColdBootActionSender(e);
  if (blockedLegacyHandoff) {
    if (connectBootstrapEntryHref) await loadActiveRenderer(connectBootstrapEntryHref);
    return;
  }
  if (committedColdBootTerminal) {
    await committedColdBootTerminal.retry();
    return;
  }
  if (activePrecommitColdBootTerminal) {
    await activePrecommitColdBootTerminal.retry();
    return;
  }
  if (acceptedIdentityColdBootTerminal) {
    const result = await acceptedIdentityColdBootTerminal.retry();
    if (result === "precommit-failed" && acceptedIdentityColdBootProof)
      initializeColdBootObservationAuthority().rollbackAcceptedWrongServer(acceptedIdentityColdBootProof);
    if (result !== "recoverable-forward") {
      acceptedIdentityColdBootProof = null;
      acceptedIdentityColdBootTerminal = null;
    }
    return;
  }
  if (!connectBootstrapEntryHref || !mainWindow || mainWindow.isDestroyed()) {
    log.warn("[desktop][d154] coldBoot:retry — no bootstrap entry or window");
    return;
  }
  const bootstrapEntryHref = connectBootstrapEntryHref;
  if (coldBootLifecycle === "resuming" || coldBootLifecycle === "observing") {
    // The boot continuation already owns setup/auth/onboarding. Do not let a
    // second click escape into the old direct-release fallback while those
    // gates are still in flight; return the local spinner instead.
    coldBootBootstrapReady = false;
    await loadActiveRenderer(bootstrapEntryHref);
    return;
  }
  const pausedBootContinuation = coldBootRecoveryContinue;
  const serverUrl = resolvedServerUrl();
  if (!serverUrl) {
    shellStateOnBoot = "no-pairing";
    await loadActiveRenderer(bootstrapEntryHref);
    return;
  }
  holdColdBootNavigation();
  logColdBootDiagnostic({
    generation: initializeColdBootObservationAuthority().snapshot().generation,
    phase: "recovery",
    category: "retry-requested",
    durationMs: 0,
    acceptedGeneration: true,
    stateChanged: false,
  });
  const observation = await observeColdBootConnection(serverUrl);
  if (observation.kind === "live") {
    if (pausedBootContinuation) {
      if (coldBootRecoveryContinue === pausedBootContinuation) {
        const continueBoot = coldBootRecoveryContinue;
        coldBootRecoveryContinue = null;
        coldBootLifecycle = "resuming";
        continueBoot();
      }
      // A coalesced retry belongs to the boot-paused cohort. Once another
      // member resumes it, this caller must never take the post-boot fallback.
      return;
    }
    if (coldBootLifecycle === "paused" && coldBootRecoveryContinue) {
      const continueBoot = coldBootRecoveryContinue;
      coldBootRecoveryContinue = null;
      coldBootLifecycle = "resuming";
      continueBoot();
      return;
    }
    applyVerifiedLogtoHealthBody(serverUrl, observation.healthBody);
    releaseVerifiedWorkbenchNavigation(serverUrl);
  }
  if (observation.kind !== "live") coldBootBootstrapReady = true;
  await loadActiveRenderer(bootstrapEntryHref);
});

ipcMain.handle("coldBoot:pairToDifferentServer", async (e) => {
  assertColdBootActionSender(e);
  if (blockedLegacyHandoff) return { ok: false as const, reason: "committed-handoff-pending" as const };
  if (committedColdBootTerminal || acceptedIdentityColdBootTerminal) {
    return { ok: false as const, reason: "committed-handoff-pending" as const };
  }
  if (activePrecommitColdBootTerminal) {
    return activePrecommitColdBootTerminal.pairToDifferentServer();
  }
  const current = serverSessions.active?.serverUrl ?? resolvedServerUrl();
  // A remains the durable/visible authority while the picker prepares B.
  // Cancel, edit, mismatch, and offline outcomes leave A untouched; only the
  // shared promotion boundary changes config, metadata, relay, or visibility.
  const result = await showGuardedServerPicker({ mode: "switch-server", currentServerUrl: current });
  if (!result?.ok || !("verified" in result)) {
    return result?.ok
      ? { ok: false as const, reason: "promotion-failed" as const }
      : result === null
        ? { ok: false as const, reason: "cancelled" as const }
        : { ok: false as const, reason: result.reason };
  }
  recoveryReplacementCohort = { url: result.url, verified: result.verified };
  projectVerifiedConnectionCohort(recoveryReplacementCohort);
  const continueBoot = coldBootRecoveryContinue;
  coldBootRecoveryContinue = null;
  continueBoot?.();
  return { ok: true as const, url: result.url };
});

ipcMain.handle("coldBoot:useThisServerAnyway", async (e) => {
  assertColdBootActionSender(e);
  if (blockedLegacyHandoff) return;
  if (committedColdBootTerminal || activePrecommitColdBootTerminal || acceptedIdentityColdBootTerminal) return;
  const serverUrl = resolvedServerUrl();
  if (!serverUrl || !mainWindow || mainWindow.isDestroyed()) return;
  const bootstrapEntryHref = connectBootstrapEntryHref;
  if (!bootstrapEntryHref) return;
  if (coldBootLifecycle === "resuming" || coldBootLifecycle === "observing") {
    coldBootBootstrapReady = false;
    await loadActiveRenderer(bootstrapEntryHref);
    return;
  }
  const authority = initializeColdBootObservationAuthority();
  try {
    const displayed = authority.snapshot();
    if (displayed.kind !== "wrong-server" || displayed.serverUrl !== serverUrl) return;
    // Record the Human's choice against the mismatch they saw, then make one
    // fresh main-owned attempt prove that exact observed identity. The body
    // that rendered the warning can never itself become live.
    const proof = await observeColdBootConnection(serverUrl, {
      forceFresh: true,
      acceptDisplayedWrongServer: displayed,
    });
    const attempt = authority.attemptSnapshot();
    if (
      proof.kind !== "acceptance-proof" ||
      attempt?.phase !== "setup" ||
      fingerprintFromHealthBody(proof.healthBody) !== displayed.observedFingerprint
    ) {
      coldBootBootstrapReady = true;
      await loadActiveRenderer(bootstrapEntryHref);
      return;
    }
    acceptedIdentityColdBootTerminal = prepareProductionAcceptedIdentityColdBootTerminal({
      displayed: { serverUrl: displayed.serverUrl, generation: displayed.generation,
        observedFingerprint: displayed.observedFingerprint },
      proof,
      priorRoutingServerUrl: serverUrl,
    });
    if (!acceptedIdentityColdBootTerminal) {
      authority.rollbackAcceptedWrongServer(proof);
      return;
    }
    acceptedIdentityColdBootProof = proof;
    const result = await acceptedIdentityColdBootTerminal.launch();
    if (result === "precommit-failed") {
      authority.rollbackAcceptedWrongServer(proof);
      acceptedIdentityColdBootProof = null;
      acceptedIdentityColdBootTerminal = null;
    } else if (result === "released") {
      acceptedIdentityColdBootProof = null;
      acceptedIdentityColdBootTerminal = null;
    }
  } catch (err) {
    log.warn("[desktop][d154] coldBoot:useThisServerAnyway failed:", err);
  }
});

ipcMain.handle("coldBoot:quit", (e) => {
  assertColdBootActionSender(e);
  app.quit();
});

ipcMain.handle("servers:list-recent", (e) => {
  assertMainWindowSender(e);
  return listRecentServers().map(rendererSafeConnectionValue);
});

let activeServerPicker: Promise<PickerConnectionResult | null> | null = null;
let activeServerPickerWindow: BrowserWindow | null = null;

function showGuardedServerPicker(
  opts: {
    mode: Extract<FirstRunPickerMode, "switch-server" | "add-server">;
    currentServerUrl: string | null;
    suggestedUrl?: string | null;
    theme?: DesktopConnectionTheme;
  },
): Promise<PickerConnectionResult | null> {
  if (activeServerPicker) return activeServerPicker;
  const opened = showFirstRunPicker(opts);
  const guarded = opened.finally(() => {
    if (activeServerPicker === guarded) activeServerPicker = null;
  });
  activeServerPicker = guarded;
  return activeServerPicker;
}

async function openServerPicker(): Promise<void> {
  const current = loadConfig();
  await showGuardedServerPicker({
    mode: "switch-server",
    currentServerUrl:
      current?.mode === "connect"
        ? (current.serverUrl ?? null)
        : resolvedServerUrl(),
  });
}

ipcMain.handle("servers:open-picker", async (e) => {
  assertMainWindowSender(e);
  await openServerPicker();
});

/**
 * M161 Phase 3 — subscribe the caller's renderer to `servers:changed`
 * pushes. The renderer registers one listener per `onChanged` call; we
 * dedupe by `webContents.id` so multiple subscribers in the same
 * renderer share one sender. The registry's `onChange` listener (wired
 * once in boot) broadcasts to every live subscriber and prunes destroyed
 * senders, so a closed renderer never throws into the emission loop.
 */
ipcMain.on("servers:subscribe-changed", (e) => {
  const wc = e.sender;
  try {
    serverSessions.resolveActiveFromSenderOrThrow(wc.id);
  } catch {
    log.warn("[ipc-guard] servers:subscribe-changed rejected", {
      senderId: wc.id,
    });
    return;
  }
  serverChangeSubscribers.set(wc.id, wc);
  wc.once("destroyed", () => {
    serverChangeSubscribers.delete(wc.id);
  });
});

/**
 * Active-session lifecycle is intentionally non-privileged: a renderer may
 * ask main whether its already-bound session is active, but it cannot use
 * this channel to acquire authority. Privileged handlers keep the unchanged
 * fail-closed `assertMainWindowSender` boundary.
 */
ipcMain.on("desktop:subscribe-active-session-state", (e) => {
  const session = serverSessions.getBySender(e.sender.id);
  if (!session || e.sender.isDestroyed()) {
    log.warn("[ipc-guard] active-session-state subscriber rejected", {
      senderId: e.sender.id,
    });
    return;
  }
  e.sender.send("desktop:active-session-state", {
    active: session === serverSessions.active,
    documentMutationEpoch: documentMutationRendererEpoch(e.sender.id),
  });
});

// ---------------------------------------------------------------------------
// M239 — macOS important-message notifications and Dock attention
// ---------------------------------------------------------------------------

let macosAppActive = true;
if (process.platform === "darwin") {
  app.on("did-resign-active", () => {
    macosAppActive = false;
  });
  app.on("did-become-active", () => {
    macosAppActive = true;
  });
}

type NotificationDeliveryStatus = {
  state: "unsupported" | "supported" | "delivery-failed";
};

const NOTIFICATION_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.notifications";
const notificationMessageDeduper = new NotificationMessageDeduper();
let notificationDeliveryFailure = false;

function currentNotificationDeliveryStatus(): NotificationDeliveryStatus {
  if (process.platform !== "darwin" || !Notification.isSupported()) {
    return { state: "unsupported" };
  }
  return {
    state: notificationDeliveryFailure ? "delivery-failed" : "supported",
  };
}

function sendNotificationDeliveryStatus(): void {
  const wc = serverSessions.active?.view?.webContents ?? null;
  if (!wc || wc.isDestroyed()) return;
  wc.send(
    "notifications:delivery-status-changed",
    currentNotificationDeliveryStatus(),
  );
}

function markNotificationDeliveryFailed(error: string): void {
  notificationDeliveryFailure = true;
  log.warn("[chat-notifications] native delivery failed", {
    error: redactNativeError(error),
  });
  sendNotificationDeliveryStatus();
}

const chatNotificationDeps: ChatNotificationDeps = {
  platform: () => process.platform,
  isNotificationSupported: () => Notification.isSupported(),
  isTestEnvironment: () =>
    process.env["CI"] === "true" || process.env["NODE_ENV"] === "test",
  isMainWindowAlive: () => !!mainWindow && !mainWindow.isDestroyed(),
  isAppActive: () =>
    isMacosAppEffectivelyActive({
      eventStateActive: macosAppActive,
      hasFocusedAppWindow: BaseWindow.getFocusedWindow() !== null,
    }),
  resolveActiveSessionKey: (senderId) => {
    const session = serverSessions.getBySender(senderId);
    return session !== null && session === serverSessions.active
      ? session.scope
      : null;
  },
  claimMessage: (sessionKey, messageId) =>
    notificationMessageDeduper.claim(sessionKey, messageId),
  createNotification: ({ title, body }) => {
    const n = new Notification({ title, body });
    return {
      show: () => n.show(),
      onClick: (handler) => {
        n.on("click", handler);
      },
      onClose: (handler) => {
        n.on("close", handler);
      },
      onFailed: (handler) => {
        n.on("failed", (_event, error) => handler(error));
      },
    };
  },
  showMainWindow: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  },
  focusMainWindow: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.focus();
  },
  sendNavigate: (
    senderId: number,
    expectedSessionKey: string,
    target: NotificationNavigationTarget,
  ) => {
    const session = serverSessions.getBySender(senderId);
    if (
      !session ||
      session !== serverSessions.active ||
      session.scope !== expectedSessionKey
    ) {
      return;
    }
    const wc = session.view?.webContents ?? null;
    if (!wc || wc.isDestroyed()) return;
    wc.send("notifications:navigate", target);
  },
  logNativeFailure: markNotificationDeliveryFailed,
};

const dockAttentionDeps: DockAttentionDeps = {
  platform: () => process.platform,
  setNumericBadge: (count) => app.setBadgeCount(count),
  setTextBadge: (text) => {
    if (!app.dock) throw new Error("dock-unavailable");
    app.dock.setBadge(text);
  },
};

ipcMain.handle(
  "notifications:show-important-message",
  (e, input: ImportantMessageInput): ShowImportantMessageResult => {
    const result = showImportantMessage(
      e.sender.id,
      input,
      chatNotificationDeps,
    );
    if (result.ok) {
      notificationDeliveryFailure = false;
      sendNotificationDeliveryStatus();
    } else if (
      result.reason === "unsupported-platform" ||
      result.reason === "unsupported-api"
    ) {
      sendNotificationDeliveryStatus();
    } else if (result.reason === "show-failed") {
      markNotificationDeliveryFailed("show failed");
    } else if (
      result.reason === "inactive-sender" ||
      result.reason === "invalid-payload"
    ) {
      log.warn("[chat-notifications] request rejected", {
        reason: result.reason,
        senderId: e.sender.id,
      });
    }
    return result;
  },
);

ipcMain.handle(
  "notifications:publish-summary",
  (e, input: NotificationSummaryInput) => {
    const result = serverSessions.publishNotificationSummary(
      e.sender.id,
      input,
    );
    if (!result.ok) {
      log.warn("[notification-summary] publication rejected", {
        reason: result.reason,
        senderId: e.sender.id,
      });
    }
    return result;
  },
);

ipcMain.handle("notifications:get-delivery-status", (e) => {
  assertMainWindowSender(e);
  return currentNotificationDeliveryStatus();
});

ipcMain.handle("notifications:open-system-settings", async (e) => {
  assertMainWindowSender(e);
  if (process.platform !== "darwin") return { ok: false };
  try {
    await shell.openExternal(NOTIFICATION_SETTINGS_URL);
    return { ok: true };
  } catch {
    log.warn("[chat-notifications] settings recovery failed", {
      reason: "settings-open-failed",
    });
    return { ok: false };
  }
});

serverSessions.onChange(() => {
  refreshMenuForActiveServerTransition();
  const activeForegroundSenderId = serverSessions.active?.view?.webContents.id;
  for (const senderId of foregroundShadowControllers.keys()) {
    const currentSession = serverSessions.getBySender(senderId);
    if (senderId !== activeForegroundSenderId || currentSession?.signedIn !== true) {
      void disposeForegroundShadowController(senderId);
    }
  }
  const liveSessionKeys = new Set<string>();
  for (const entry of serverSessions.list()) {
    const session = serverSessions.getByServerUrl(entry.url);
    if (session) liveSessionKeys.add(session.scope);
  }
  notificationMessageDeduper.retainSessions(liveSessionKeys);

  const aggregate = serverSessions.getNotificationAggregate();
  const result = applyDockAttention(
    {
      kind: "counts",
      unreadCount: aggregate.unreadCount,
      importantUnreadCount: aggregate.importantUnreadCount,
    },
    dockAttentionDeps,
  );
  if (!result.ok && result.reason === "native-failed") {
    markNotificationDeliveryFailed("dock badge failed");
    log.warn("[notification-dock] aggregate update rejected", {
      reason: result.reason,
    });
  }
});

/**
 * M161 Phase 3 — `servers:list`. Merges recent + live sessions, enriches
 * each from public `/api/setup/status` + icon URL, and marks
 * active/signedIn/connection. Per-entry probes are wrapped so one offline
 * server never kills the list (or the current session). This read-only,
 * renderer-safe projection is available to every registered session
 * renderer so preserved background sessions can publish and reconcile their
 * own summary; unknown senders still fail closed.
 */
ipcMain.handle("servers:list", async (e) => {
  if (!serverSessions.getBySender(e.sender.id)) {
    throw new Error("ipc-denied: sender is not registered");
  }
  const result = await serverSessions.listEnrichedResult();
  return {
    ...result,
    servers: result.servers.map(rendererSafeConnectionValue),
  };
});

/**
 * Source launches select A from the dev-stack environment rather than from
 * config. Keep its authority process-local, but project the trusted identity
 * for that exact recent-server slot so a displayed mismatch can be explicitly
 * accepted. A stale per-profile config can never masquerade as this A.
 */
let sourceDevelopmentAuthority: ActiveAuthority | null = null;

/**
 * An explicit loopback source launch begins with a markerless process-local
 * authority so stale persisted config can never select its server identity.
 * Once that launch's verified health observation is explicitly trusted, fold
 * only its exact fingerprint into the same live authority. This does not
 * persist or trust a different origin.
 */
function promoteSourceDevelopmentAuthorityFingerprint(
  serverUrl: string,
  serverFingerprint: string,
): void {
  if (!sourceDevelopmentAuthority) return;
  let scope: string;
  try {
    scope = new URL(serverUrl).origin;
  } catch {
    return;
  }
  if (sourceDevelopmentAuthority.scope !== scope) return;
  sourceDevelopmentAuthority = {
    ...sourceDevelopmentAuthority,
    serverFingerprint,
  };
}

function installSourceDevelopmentAuthority(serverUrl: string): void {
  const scope = new URL(serverUrl).origin;
  sourceDevelopmentAuthority = {
    scope,
    revision: `dev-${randomUUID()}`,
    connectionAttemptId: `legacy-dev-${randomUUID()}`,
    serverFingerprint: getRecentServerFingerprint(scope),
  };
}

function authoritativeConnectionSnapshot(): ActiveAuthority {
  if (sourceDevelopmentAuthority) return sourceDevelopmentAuthority;
  const config = loadConfig();
  const projected = config ? projectActiveAuthority(config) : null;
  if (projected) {
    return {
      scope: projected.scope,
      revision: projected.revision,
      connectionAttemptId: projected.connectionAttemptId,
      serverFingerprint: projected.serverFingerprint,
    };
  }
  const active = serverSessions.active;
  if (!active || !config || config.mode !== "connect") {
    return { scope: null, revision: null, connectionAttemptId: null, serverFingerprint: null };
  }
  throw new Error("legacy active authority migration must complete before connection flow");
}

/** Commit the guarded connection through the same authority in source and packaged Desktop. */
function commitDesktopConnectionAuthority(
  { routingServerUrl, attemptId, serverFingerprint, priorAuthorityGuard }: Parameters<AcceptedIdentityConfigCas>[0],
): boolean {
  const current = authoritativeConnectionSnapshot();
  if (current.scope !== priorAuthorityGuard.scope ||
    current.revision !== priorAuthorityGuard.revision ||
    current.connectionAttemptId !== priorAuthorityGuard.connectionAttemptId ||
    current.serverFingerprint !== priorAuthorityGuard.serverFingerprint) {
    return false;
  }
  const committedConfig = configForCommittedActiveConnection(loadConfig(), {
    serverUrl: routingServerUrl,
    connectionAttemptId: attemptId,
    serverFingerprint,
  });
  saveConfig(committedConfig);
  if (sourceDevelopmentAuthority) {
    const committedAuthority = projectActiveAuthority(committedConfig);
    if (!committedAuthority) throw new Error("committed source authority is invalid");
    sourceDevelopmentAuthority = committedAuthority;
  }
  return true;
}

const desktopConnectionTupleBinding = createHash("sha256")
  .update(`${desktopInstance.instanceId}\0${desktopProfile}`)
  .digest("hex");
let pendingConnectionStore: ReturnType<typeof createPendingConnectionStore> | null = null;
function connectionPendingStore(): ReturnType<typeof createPendingConnectionStore> {
  pendingConnectionStore ??= createPendingConnectionStore({
    filePath: pendingConnectionFilePath(),
    tupleBinding: desktopConnectionTupleBinding,
    currentActiveAuthority: authoritativeConnectionSnapshot,
  });
  return pendingConnectionStore;
}

function previousHttpsOriginForConnectionTarget(enteredTarget: string): string | null {
  return selectPreviousHttpsOrigin(
    enteredTarget,
    authoritativeConnectionSnapshot().scope,
    listRecentServers(),
  );
}

async function fetchConnectionHealth(origin: string, signal: AbortSignal): Promise<VerifiedHealth> {
  const response = await fetch(`${origin}/health`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`health-http-${response.status}`);
  const answeringOrigin = new URL(response.url || `${origin}/health`).origin;
  const body = (await response.json()) as Record<string, unknown>;
  const fingerprint = fingerprintFromHealthBody(body);
  const endpoint = body["logtoEndpoint"];
  const appId = body["logtoDesktopAppId"];
  const resource = body["logtoResource"];
  const status = body["status"];
  const authRequired = body["authRequired"];
  const enrolled = body["enrolled"];
  if (
    !fingerprint || typeof endpoint !== "string" || !endpoint ||
    typeof appId !== "string" || !appId ||
    typeof resource !== "string" || !resource || status !== "ok" ||
    typeof authRequired !== "boolean" || typeof enrolled !== "boolean"
  ) {
    throw new Error("health-incompatible");
  }
  return {
    answeringOrigin,
    body,
    fingerprint,
    logtoConfig: { endpoint, appId, resource },
    observedAtMs: Date.now(),
  };
}

async function observeConnectionReadiness(origin: string, signal: AbortSignal): Promise<number> {
  const response = await fetch(`${origin}/health/ready`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!response.ok || new URL(response.url || `${origin}/health/ready`).origin !== origin) {
    throw new Error("server not ready");
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (body["status"] !== "ready") throw new Error("invalid readiness response");
  return Date.now();
}

async function observeConnectionSetup(origin: string, signal: AbortSignal) {
  if (signal.aborted) throw new Error("setup observation superseded");
  const observed = await probeServerClaimStateForUrl(origin, signal);
  if (signal.aborted) throw new Error("setup observation superseded");
  if (!observed.raw) throw new Error("setup status unavailable");
  return { observedAtMs: Date.now(), state: observed.state, raw: observed.raw };
}

async function authenticateConnectionCandidate(input: Readonly<{
  routingServerUrl: string;
  health: VerifiedHealth;
  attemptId: string;
  generation: number;
  allowStoredCredentials: boolean;
  theme: DesktopConnectionTheme;
  signal: AbortSignal;
}>): Promise<
  | Readonly<{ kind: "signed-in"; persist: () => void }>
  | Readonly<{ kind: "cancelled" | "failed" }>
> {
  const { health, signal } = input;
  const declaredServerUrl = typeof health.body["serverUrl"] === "string"
    ? health.body["serverUrl"]
    : null;
  const canonicalRoutingServerUrl = canonicalizeServerUrl(
    input.routingServerUrl,
    declaredServerUrl,
  );
  const exactStore = createIdentityBoundTokenStore({
    routingServerUrl: input.routingServerUrl,
    logtoEndpoint: health.logtoConfig.endpoint,
    clientAppId: health.logtoConfig.appId,
  });
  const stores = canonicalRoutingServerUrl === input.routingServerUrl
    ? [exactStore]
    : [
        exactStore,
        createIdentityBoundTokenStore({
          routingServerUrl: canonicalRoutingServerUrl,
          logtoEndpoint: health.logtoConfig.endpoint,
          clientAppId: health.logtoConfig.appId,
        }),
      ];
  if (input.allowStoredCredentials) {
    for (const store of stores) {
      try {
        let bundle = store.load();
        if (bundle && isAccessTokenExpiring(bundle)) {
          bundle = await refreshTokensCore(health.logtoConfig, {
            fetchImpl: globalThis.fetch,
            loadTokens: () => store.load(),
            saveTokens: (next) => store.save(next),
            clearTokens: () => store.clear(),
          });
        }
        if (bundle) {
          // Heal localhost/127.0.0.1 drift only after the guarded connection
          // transaction succeeds. Remote hosts never gain an alias here.
          return { kind: "signed-in", persist: () => exactStore.save(bundle) };
        }
      } catch {
        if (signal.aborted) return { kind: "cancelled" };
        // Continue through the verified loopback alias before falling back to
        // immediate interactive sign-in.
      }
    }
  }

  let authSurface: { closeAuthSurface: () => void } | null = null;
  let loopback: Awaited<ReturnType<typeof startLoopbackServer>> | null = null;
  let shutdownRequested = false;
  let shutdownPerformed = false;
  const shutdownLoopback = () => {
    shutdownRequested = true;
    if (!loopback || shutdownPerformed) return;
    shutdownPerformed = true;
    loopback.shutdown();
  };
  const stop = () => {
    authSurface?.closeAuthSurface();
    shutdownLoopback();
  };
  signal.addEventListener("abort", stop, { once: true });
  let freshBundle: TokenBundle | null = null;
  try {
    if (signal.aborted) return { kind: "cancelled" };
    await runSignIn(health.logtoConfig, {
      fetchImpl: globalThis.fetch,
      saveTokens: (next) => { freshBundle = next; },
      startLoopback: async () => {
        loopback = await startLoopbackServer();
        if (shutdownRequested || signal.aborted) shutdownLoopback();
        return { ...loopback, shutdown: shutdownLoopback };
      },
      openAuthUrl: (url) => {
        if (signal.aborted) throw new Error("candidate sign-in cancelled");
        const pickerWindow = activeServerPickerWindow;
        authSurface = openAuthWindow({
          // Candidate authentication is one step inside the guarded blue
          // connection surface. The old Workbench remains alive only as
          // rollback authority; it must never own or appear behind Logto.
          parent: pickerWindow && !pickerWindow.isDestroyed() ? pickerWindow : mainWindow,
          url,
          kind: "sign-in",
          theme: input.theme,
          partition: `server-auth-candidate-${input.attemptId}-${input.generation}`,
          onClose: ({ closedByUser }) => { if (closedByUser) shutdownLoopback(); },
        });
        return Promise.resolve(authSurface);
      },
    });
    if (signal.aborted || !freshBundle) return { kind: "cancelled" };
    return {
      kind: "signed-in",
      persist: () => {
        exactStore.save(freshBundle!);
        invalidateMiniAppRecoveryAuthentication();
      },
    };
  } catch (error) {
    return signal.aborted || (error instanceof Error && error.message === "Loopback server shut down")
      ? { kind: "cancelled" }
      : { kind: "failed" };
  } finally {
    signal.removeEventListener("abort", stop);
  }
}

const desktopConnectionFlow = new DesktopConnectionFlow(
  desktopConnectionTupleBinding,
  {
    onPresentation: (rawSnapshot) => {
      let snapshot = rawSnapshot;
      try { snapshot = connectionSupportReceiptProjector.project(rawSnapshot); } catch { /* diagnostics never own delivery */ }
      if (!publishConnectionPresentationListener(snapshot, pickerPresentationListener)) pickerPresentationListener = null;
      publishConnectionPresentation(snapshot, serverChangeSubscribers,
        (id, sender) => !sender.isDestroyed() && Boolean(serverSessions.resolveActiveFromSenderOrThrow(id)),
        (sender, next) => sender.send("servers:connection-presentation", next));
    },
    active: () => {
      const authority = authoritativeConnectionSnapshot();
      const active = serverSessions.active;
      return {
        authority,
        registryScope: active?.scope ?? null,
      };
    },
    expectedFingerprint: (candidateOrigin) => getRecentServerFingerprint(candidateOrigin),
    previousHttpsOrigin: previousHttpsOriginForConnectionTarget,
    activeRoutingServerUrl: () => sourceDevelopmentAuthority
      ? (serverSessions.active?.serverUrl ?? sourceDevelopmentAuthority.scope)
      : (() => {
      const config = loadConfig();
      return config?.mode === "connect" ? (config.serverUrl ?? null) : serverSessions.active?.serverUrl ?? null;
    })(),
    activateAlreadyActive: () => {
      const view = serverSessions.active?.view;
      if (view) navigateServerSessionHome(view);
    },
    savePending: (pending) => connectionPendingStore().save(pending),
    clearPending: () => connectionPendingStore().clear(),
    fetchHealth: fetchConnectionHealth,
    observeReadiness: observeConnectionReadiness,
    observeSetup: observeConnectionSetup,
    authenticateCandidate: authenticateConnectionCandidate,
    prepare: (input) => serverSessions.prepareSwitch({
      attemptId: input.attemptId,
      generation: input.generation,
      canonicalOrigin: input.canonicalOrigin,
      routingServerUrl: input.routingServerUrl,
      identityTransition: input.identityTransition,
      priorRegistryScope: input.priorRegistryScope,
      priorAuthorityGuard: input.priorAuthorityGuard,
      candidateServerFingerprint: input.candidateServerFingerprint,
      ...(input.forceDetachedReplacement ? { forceDetachedReplacement: true } : {}),
      ...(input.acceptedIdentityReplacementReceipt
        ? { acceptedIdentityReplacementReceipt: input.acceptedIdentityReplacementReceipt }
        : {}),
      awaitNavigationReceipt: (navigation) =>
        awaitCandidateNavigation(navigation, input.signal),
    }),
    cancelPrepared: (attemptId, generation) =>
      serverSessions.cancelPreparedSwitch(attemptId, generation),
    applyCandidateFacts: (candidate, health, { allowStoredCredentials, authenticatedThisAttempt }) => {
      candidate.logtoConfig = { ...health.logtoConfig };
      candidate.signedIn = authenticatedThisAttempt ||
        (allowStoredCredentials && loadTokensFor(candidate.serverUrl) !== null);
      observeRelayPairingContract({ ...health.body }, health.fingerprint);
    },
    retireStoredCandidateIdentity: async (serverUrl, health) => {
      invalidateMiniAppRecoveryAuthentication();
      createIdentityBoundTokenStore({ routingServerUrl: serverUrl,
        logtoEndpoint: health.logtoConfig.endpoint, clientAppId: health.logtoConfig.appId }).retireExact();
      retireRelayToken(serverUrl);
      await session.fromPartition(`persist:server-${serverUrlScope(serverUrl)}`).clearStorageData();
    },
    commitActiveAuthority: commitDesktopConnectionAuthority,
    persistMetadata: (candidate, health) => {
      writePersistedTuiServerTarget(candidate.serverUrl);
      pushRecentServer({ url: candidate.serverUrl });
      if (!setCommittedRecentServerFingerprint(candidate.serverUrl, health.fingerprint,
        authoritativeConnectionSnapshot())) {
        return Promise.reject(new Error("fingerprint metadata persistence failed"));
      }
      return Promise.resolve();
    },
    stopOldCodex: async () => { await codexConnection.disable(); },
    stopOldRelay: async () => {
      await stopRelay();
      // The durable target is already committed at this checkpoint. Revoke
      // the prior server-bound Computer use authority even when the target is
      // signed out and therefore has no relay startup to adopt its own store.
      await configureComputerUseForServer(null);
    },
    deactivateOldProfile: async () => { await activeWorkstationProfileController.deactivate(); },
    retireOldIdentity: async ({ priorRoutingServerUrl, targetRegistryScope }, health) => {
      createIdentityBoundTokenStore({ routingServerUrl: priorRoutingServerUrl,
        logtoEndpoint: health.logtoConfig.endpoint, clientAppId: health.logtoConfig.appId }).retireExact();
      retireRelayToken(priorRoutingServerUrl);
      await session.fromPartition(`persist:server-${targetRegistryScope}`).clearStorageData();
    },
    startTargetRelay: startRelayForSession,
    shouldStartTargetRelay: (candidate) => candidate.signedIn,
    onActivated: (candidate) => {
      refreshAuthMenuState(candidate.signedIn);
      broadcastAuthState(candidate.signedIn ? "signed-in" : "signed-out");
    },
    promote: (handle, hooks) => serverSessions.promotePrepared(handle, hooks),
    resolveUnknownCommitOutcome: (handle, authority) =>
      serverSessions.resolveUnknownCommitOutcome(handle, authority),
  },
);

function coldBootTerminalRuntime() {
  return createColdBootTerminalRuntime({
    configureRegistry: configureServerSessions,
    loadPending: () => connectionPendingStore().load(),
    projectCommitted: (loaded) => {
      const projected = projectPendingConnectionRecovery(loaded);
      if (projected.disposition !== "committed-handoff") throw new Error("invalid committed projection");
      return projected;
    },
    currentAuthority: authoritativeConnectionSnapshot,
    currentRegistryScope: () => serverSessions.active?.scope ?? null,
    registry: serverSessions,
    fetch: (input, init) => fetch(input, init),
    fingerprintFromHealthBody,
    navigateCandidate: ({ navigationUrl, expectedOrigin, attemptId, generation, view, newlyCreatedView }, signal) =>
      awaitCandidateNavigation({
        attemptId: attemptId as import("./connection-attempt").ConnectionAttemptId,
        generation,
        view,
        newlyCreatedView,
        expectedOrigin,
        ...(navigationUrl === undefined ? {} : { navigationUrl }),
      }, signal),
    savePending: (pending) => connectionPendingStore().save(pending),
    clearPending: () => connectionPendingStore().clear(),
    retireOldIdentity: async ({ priorRoutingServerUrl, targetRegistryScope }) => {
      retireRelayToken(priorRoutingServerUrl);
      await session.fromPartition(`persist:server-${targetRegistryScope}`).clearStorageData();
    },
    persistMetadata: (candidate, health) => {
      writePersistedTuiServerTarget(candidate.serverUrl);
      pushRecentServer({ url: candidate.serverUrl });
      if (!setCommittedRecentServerFingerprint(candidate.serverUrl, health.fingerprint,
        authoritativeConnectionSnapshot())) {
        throw new Error("fingerprint metadata persistence failed");
      }
      return Promise.resolve();
    },
    stopOldCodex: async () => { await codexConnection.disable(); },
    stopOldRelay: async () => {
      await stopRelay();
      // Recovery resumes from the same post-commit authority boundary as the
      // live switch path; never retain the prior server's local grant while a
      // signed-out target intentionally skips relay startup.
      await configureComputerUseForServer(null);
    },
    deactivateOldProfile: async () => { await activeWorkstationProfileController.deactivate(); },
    startTargetRelay: startRelayForSession,
    createTokenStore: createIdentityBoundTokenStore,
    observeRelayContract: (health) => observeRelayPairingContract({ ...health.body }, health.fingerprint),
    candidateUi: {
      startLoopback: startLoopbackServer,
      openAuthSurface: ({ url, partition, onClosedByUser }) => Promise.resolve(openAuthWindow({
        parent: mainWindow,
        url,
        kind: "sign-in",
        partition,
        onClose: ({ closedByUser }) => { if (closedByUser) onClosedByUser(); },
      })),
      showOnboarding: ({ routingServerUrl, partition, getBearer, signal }) =>
        showOnboardingWizard(routingServerUrl, { partition, getBearer, signal }),
    },
    forceOnboarding: process.env["NAUTILO_FORCE_ONBOARDING"] === "1",
    installActiveAuthDescriptor: () => registerDesktopAuthIdentityDescriptor(() => {
      const active = serverSessions.active;
      if (!active?.logtoConfig) throw new Error("candidate auth identity unavailable");
      return { serverUrl: active.serverUrl, logtoEndpoint: active.logtoConfig.endpoint,
        clientAppId: active.logtoConfig.appId };
    }),
  });
}

function prepareProductionCommittedColdBootTerminal(
  targetRegistryScope: string,
  initiateLocalShell: () => void,
): CommittedColdBootTerminal | null {
  const runtime = coldBootTerminalRuntime();
  return prepareCommittedColdBootTerminal(runtime.committedPorts({
    targetRegistryScope,
    initiateLocalShell,
    releaseCandidate: ({ recovery, facts }) => {
      bootSetupStatus = facts.setupStatus;
      shellStateOnBoot = "live";
      verifiedWorkbenchOrigin = recovery.candidateOrigin;
      coldBootBootstrapReady = true;
      coldBootLifecycle = "complete";
      registerOnboardingOpenHandler();
      queueInitialDeepLinksOnce();
      drainPendingDeepLinks();
    },
    finishReleased: async ({ recovery }) => {
      await finishReleasedDesktopBoot(recovery.routingServerUrl);
      committedColdBootTerminal = null;
    },
    onState: (state) => {
      const localRecoveryShell = activeLocalColdBootShell();
      coldBootBootstrapReady = state.phase === "recoverable" && localRecoveryShell !== null;
      if (state.phase === "recoverable" && localRecoveryShell) {
        shellStateOnBoot = "disconnected";
        if (connectBootstrapEntryHref) void loadActiveRenderer(connectBootstrapEntryHref);
      }
    },
  }));
}

function prepareProductionAcceptedIdentityColdBootTerminal(input: Readonly<{ displayed: Readonly<{ serverUrl: string; generation: number; observedFingerprint: string }>; proof: ColdBootAcceptanceProof; priorRoutingServerUrl: string }>): AcceptedIdentityColdBootTerminal | null {
  configureServerSessions();
  const runtime = coldBootTerminalRuntime();
  let rendererReleased = false;
  return prepareAcceptedIdentityColdBootTerminal({
    ...runtime.acceptedPorts({
      commitAcceptedConfig: commitDesktopConnectionAuthority,
    }),
    releaseCandidate: ({ routingServerUrl, facts }) => {
      rendererReleased = true;
      shellStateOnBoot = "live";
      bootSetupStatus = facts.setupStatus;
      verifiedWorkbenchOrigin = new URL(routingServerUrl).origin;
      coldBootBootstrapReady = true;
      coldBootLifecycle = "complete";
      coldBootRecoveryContinue = null;
      registerOnboardingOpenHandler();
      queueInitialDeepLinksOnce();
      drainPendingDeepLinks();
    },
    finishReleased: async ({ routingServerUrl }) => {
      await finishReleasedDesktopBoot(routingServerUrl);
    },
    onState: (state) => {
      // A finalizer retry happens after B is already the visible authority;
      // never reload the bootstrap over that renderer.
      const localRecoveryShell = activeLocalColdBootShell();
      coldBootBootstrapReady = state.phase === "recoverable" && !rendererReleased && localRecoveryShell !== null;
      if (state.phase === "recoverable" && !rendererReleased && localRecoveryShell && connectBootstrapEntryHref) {
        shellStateOnBoot = "disconnected";
        void loadActiveRenderer(connectBootstrapEntryHref);
      }
    },
  }, { ...input, tupleBinding: desktopConnectionTupleBinding });
}

function prepareProductionActivePrecommitColdBootTerminal(): ActivePrecommitColdBootTerminal | null {
  return prepareActivePrecommitColdBootTerminal({
    loadPending: () => connectionPendingStore().load(),
    projectPrecommit: (loaded) => {
      const projected = projectPendingConnectionRecovery(loaded);
      if (projected.disposition !== "precommit") throw new Error("invalid precommit projection");
      return projected;
    },
    currentAuthority: authoritativeConnectionSnapshot,
    // A retained active authority makes this a replacement. The flow's own
    // postcommit closure is therefore also the only valid cold Retry path.
    connect: (enteredTarget) => desktopConnectionFlow.connect(enteredTarget, "switch"),
    takeVerifiedCohort: (url) => desktopConnectionFlow.takeVerifiedCohort(url),
    cancel: () => desktopConnectionFlow.cancel(),
    pairToDifferentServer: async () => {
      const current = serverSessions.active?.serverUrl ?? resolvedServerUrl();
      const result = await showGuardedServerPicker({ mode: "switch-server", currentServerUrl: current });
      if (result === null) return { kind: "cancelled" as const };
      if (!result.ok || !("verified" in result)) return { kind: "failed" as const };
      return { kind: "candidate" as const, cohort: result.verified };
    },
    onState: (state) => {
      const localRecoveryShell = activeLocalColdBootShell();
      coldBootBootstrapReady = state.phase === "recoverable" && localRecoveryShell !== null;
      if (state.phase === "recoverable" && localRecoveryShell && connectBootstrapEntryHref) {
        shellStateOnBoot = "disconnected";
        void loadActiveRenderer(connectBootstrapEntryHref);
      }
    },
  });
}

/**
 * M161 Phase 3 — `servers:switchTo(url)`. Real in-process switch: lazily
 * create/load the target view, preserve the old view alive+hidden,
 * navigate the target to `/`, resolve Logto, restore/silently refresh
 * tokens (re-auth only when absent/unrefreshable), then stop-before-start
 * relay handoff. No relaunch. Failures return a typed result so the
 * Servers panel can render `wrong-server`/offline recovery in place.
 */
ipcMain.handle("servers:switchTo", async (e, rawUrl: unknown, rawTheme: unknown) => {
  assertMainWindowSender(e);
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("servers:switchTo requires a non-empty url string");
  }
  const theme: DesktopConnectionTheme = rawTheme === "light" || rawTheme === "dark"
    ? rawTheme
    : null;
  await browserResearchTargetManager?.disposeAll();
  const result = await desktopConnectionFlow.connect(rawUrl.trim(), "switch", theme);
  if (!result.ok && result.reason === "downgrade-confirmation-required") {
    const current = loadConfig();
    await showGuardedServerPicker({
      mode: "switch-server",
      currentServerUrl: current?.mode === "connect" ? (current.serverUrl ?? null) : resolvedServerUrl(),
      suggestedUrl: rawUrl.trim(),
      theme,
    });
    return { ok: true as const };
  }
  if (result.ok) {
    desktopConnectionFlow.takeVerifiedCohort(result.url);
    return { ok: true as const };
  }
  return result.reason === "wrong-server"
    ? { ok: false as const, reason: result.reason, decisionId: result.decisionId }
    : result.reason === "promotion-failed"
      ? { ok: false as const, reason: result.reason, authoritativePairingChanged: result.authoritativePairingChanged }
    : { ok: false as const, reason: result.reason };
});

ipcMain.handle("servers:accept-identity", async (e, decisionId: unknown) => {
  assertMainWindowSender(e);
  if (typeof decisionId !== "string") return { ok: false as const, reason: "stale" as const };
  const result = await desktopConnectionFlow.acceptIdentity(decisionId);
  if (result.ok) {
    desktopConnectionFlow.takeVerifiedCohort(result.url);
    return { ok: true as const };
  }
  return { ok: false as const, reason: result.reason };
});

/**
 * M161 Phase 3 — `servers:add()`, surfaced by Phase 4 as the persistent
 * footer action “Connect to server…”. Opens the existing picker in
 * `add-server` mode (no relaunch). The current server stays active on
 * cancel/failure. On a successful commit, the picked URL is ensured as
 * a new session and switched to (which lazily creates its view + hands
 * off the relay) — no relaunch.
 */
ipcMain.handle("servers:add", async (e, rawTheme: unknown) => {
  assertMainWindowSender(e);
  const theme: DesktopConnectionTheme = rawTheme === "light" || rawTheme === "dark"
    ? rawTheme
    : null;
  const current = loadConfig();
  const result = await showGuardedServerPicker({
    mode: "add-server",
    currentServerUrl:
      current?.mode === "connect"
        ? (current.serverUrl ?? null)
        : resolvedServerUrl(),
    theme,
  });
  if (!result) {
    // Cancel or invalid commit — current server stays active.
    return { ok: false as const, reason: "cancelled" };
  }
  if (result.ok) return { ok: true as const, url: result.url };
  return result.reason === "promotion-failed"
    ? { ok: false as const, reason: result.reason, authoritativePairingChanged: result.authoritativePairingChanged }
    : { ok: false as const, reason: result.reason };
});

/**
 * M161 Phase 3 — `servers:close(url)`. Destroys the target session's view
 * and drops the session (falls back to a remaining session as active).
 * Does NOT remove the recent-servers entry or token files (D133, not M161).
 */
ipcMain.handle("servers:close", async (e, rawUrl: unknown) => {
  assertMainWindowSender(e);
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    throw new Error("servers:close requires a non-empty url string");
  }
  const result = await serverSessions.close(rawUrl);
  return rendererSafeConnectionValue(result);
});

/**
 * M161 Phase 6.5 — irreversibly remove one trusted server and every stored
 * alias of that server. This is deliberately separate from D133 Disconnect /
 * Sign-out: Forget wipes server-scoped auth, relay credentials, browser
 * partition data, and recents, but never the installation identity.
 */
ipcMain.handle("servers:forget", async (e, rawUrl: unknown) => {
  assertMainWindowSender(e);
  if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) {
    return { ok: false as const, reason: "invalid-url" as const };
  }
  const serverUrl = rawUrl.trim();
  const fingerprint = getRecentServerFingerprint(serverUrl) ?? undefined;
  const forgetOptions = fingerprint ? { fingerprint } : {};
  const aliases = findRecentServerAliases(serverUrl, forgetOptions);
  const knownLive = serverSessions.getByServerUrl(serverUrl) !== null;
  if (aliases.length === 0 && !knownLive) {
    return { ok: false as const, reason: "unknown-server" as const };
  }
  const allAliases = aliases.length > 0 ? aliases : [serverUrl];
  const aliasSet = new Set(allAliases);
  // listRecentServers is ordered most-recent first, so this is the required
  // fallback preference. It is intentionally chosen before recents mutate.
  const fallback = listRecentServers().find((entry) => {
    try {
      return !aliasSet.has(new URL(entry.url).toString().replace(/\/$/, ""));
    } catch {
      return false;
    }
  })?.url;

  const result = await serverSessions.forget(serverUrl, allAliases, fallback);
  if (!result.ok) return result;
  try {
    for (const alias of allAliases) {
      clearTokensFor(alias);
      clearRelayToken(alias);
    }
    await serverSessions.clearPersistentPartitionsFor(allAliases);
  } catch (err) {
    log.warn("[desktop][m161] failed to clear forgotten server state:", err);
    return { ok: false as const, reason: "partition-clear-failed" as const };
  }
  removeRecentServer(serverUrl, forgetOptions);
  try {
    if (result.landedEmpty) {
      clearDesktopConfig();
    }
  } catch (err) {
    log.warn("[desktop][m161] failed to update forgotten server config:", err);
    return { ok: false as const, reason: "config-clear-failed" as const };
  }
  return {
    ok: true as const,
    fallbackFailed: result.fallbackFailed,
    landedEmpty: result.landedEmpty,
  };
});

ipcMain.handle("fs:openPath", async (e, args: { path: string }) => {
  assertMainWindowSender(e);
  assertPathInAllowedRoot(args.path);
  const err = await shell.openPath(args.path);
  if (err) throw new Error(err);
});

// D057 2a.5 — media permission IPC.
ipcMain.handle("media:getMicStatus", (e): MicStatus => {
  assertMainWindowSender(e);
  return getMicrophoneStatus();
});
ipcMain.handle("media:askMic", async (e): Promise<MicStatus> => {
  assertMainWindowSender(e);
  return askForMicrophoneAccess();
});
ipcMain.handle("shell:openSystemMicSettings", async (e): Promise<void> => {
  assertMainWindowSender(e);
  await openSystemMicSettings();
});

// D516 — Desktop-wide permission registry. The renderer receives status data
// and a fixed identifier only; main selects every native recovery action.
ipcMain.handle("systemPermissions:status", (e): SystemPermissionsSnapshot => {
  assertMainWindowSender(e);
  return getSystemPermissionsSnapshot();
});
ipcMain.handle("systemPermissions:resolve", async (
  e,
  raw: unknown,
): Promise<SystemPermissionsSnapshot> => {
  assertMainWindowSender(e);
  if (!isSystemPermissionId(raw)) {
    throw new Error("Unknown system permission.");
  }
  return await resolveSystemPermission(raw);
});
ipcMain.handle("systemPermissions:restart", (e): void => {
  assertMainWindowSender(e);
  if (
    !getSystemPermissionsSnapshot().permissions.some(
      (permission) => permission.restart === "required",
    )
  ) {
    throw new Error("Nautilo does not need to restart for a system permission.");
  }
  // Schedule after this synchronous IPC handler returns so the renderer gets
  // a clean acknowledgement before Electron exits its current process.
  setImmediate(() => {
    app.relaunch();
    // Enter the existing awaited before-quit teardown. An immediate exit would
    // bypass it and could strand the app-owned Cua child during a permission
    // restart.
    app.quit();
  });
});
ipcMain.handle(
  "systemPermissions:onboardingPreference",
  (e): SystemPermissionsOnboardingPreference => {
    assertMainWindowSender(e);
    return loadSystemPermissionsOnboardingPreference(
      systemPermissionsOnboardingPreferencePath(
        app.getPath("appData"),
        APP_NAME,
        app.isPackaged ? "packaged" : "development",
      ),
    );
  },
);
ipcMain.handle(
  "systemPermissions:setOnboardingPreference",
  (e, raw: unknown): SystemPermissionsOnboardingPreference => {
    assertMainWindowSender(e);
    if (typeof raw !== "boolean") {
      throw new Error("System-permissions onboarding preference must be boolean.");
    }
    const preference: SystemPermissionsOnboardingPreference = {
      version: 1,
      showAutomatically: raw,
    };
    saveSystemPermissionsOnboardingPreference(
      systemPermissionsOnboardingPreferencePath(
        app.getPath("appData"),
        APP_NAME,
        app.isPackaged ? "packaged" : "development",
      ),
      preference,
    );
    return preference;
  },
);
ipcMain.on("systemPermissions:subscribe", (e) => {
  if (!acceptSystemPermissionStatusSubscriber(e)) return;
  const contents = e.sender;
  if (!systemPermissionStatusSubscribers.has(contents.id)) {
    systemPermissionStatusSubscribers.set(contents.id, contents);
    contents.once("destroyed", () => {
      systemPermissionStatusSubscribers.delete(contents.id);
      stopSystemPermissionStatusWatchIfUnused();
    });
  }
  const baseline = getSystemPermissionsSnapshot();
  // A renderer may have a slower earlier status() promise in flight. Its
  // versioned subscriber applies this newer event first and suppresses that
  // stale promise on arrival.
  contents.send("systemPermissions:statusChanged", baseline);
  startSystemPermissionStatusWatch(baseline);
});
ipcMain.on("systemPermissions:unsubscribe", (e) => {
  if (!acceptSystemPermissionStatusSubscriber(e)) return;
  systemPermissionStatusSubscribers.delete(e.sender.id);
  stopSystemPermissionStatusWatchIfUnused();
});

// ---------------------------------------------------------------------------
// System tray
// ---------------------------------------------------------------------------

function createTray(): void {
  const iconPath = path.join(__dirname, "../assets/iconTemplate.png");
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(iconPath);
  } catch {
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip("Nautilo");
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;

  const statusLabel =
    currentRelayStatus === "connected"
      ? "Relay: \u25CF Connected"
      : currentRelayStatus === "connecting"
        ? "Relay: \u25CB Connecting..."
        : "Relay: \u25CB Disconnected";

  const folderLabel = currentFolderPath
    ? `Folder: ${path.basename(currentFolderPath)}`
    : "Folder: (none open)";

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Nautilo Desktop", enabled: false },
      { type: "separator" },
      { label: statusLabel, enabled: false },
      { label: folderLabel, enabled: false },
      { type: "separator" },
      {
        label: "Open Folder...",
        // D075 chunk 2 — direct pick + validate + commit. The modal
        // preview/confirm step from 2a.7 is gone; the native folder
        // picker IS the preview, and the validation throws (with a
        // descriptive reason) if the user picked a system root /
        // home / etc. commitCurrentFolderPath fires the push event so
        // the workbench updates live.
        click: () => {
          if (
            mainWindow &&
            !mainWindow.isDestroyed() &&
            !mainWindow.isVisible()
          ) {
            mainWindow.show();
            mainWindow.focus();
          }
          void (async () => {
            const picked = await pickFolder();
            if (!picked) return;
            const validated = validateWorkspacePath(
              { path: picked },
              WORKSPACE_VALIDATOR_DEPS,
            );
            if (!validated.ok) {
              if (mainWindow)
                void dialog.showMessageBox(mainWindow, {
                  type: "warning",
                  message: "Can't use that folder",
                  detail: validated.error,
                  buttons: ["OK"],
                });
              return;
            }
            const sanity = checkCurrentFolderSanity(
              validated.resolved,
              os.homedir(),
            );
            if (!sanity.ok) {
              if (mainWindow)
                void dialog.showMessageBox(mainWindow, {
                  type: "warning",
                  message: "Can't use that folder",
                  detail: sanity.reason,
                  buttons: ["OK"],
                });
              return;
            }
            try {
              commitCurrentFolderPath(validated.resolved);
            } catch {
              showWorkingFolderCommitError();
            }
          })();
        },
      },
      {
        label: "Show / Hide",
        click: () => {
          if (mainWindow?.isVisible()) {
            mainWindow.hide();
          } else {
            mainWindow?.show();
            mainWindow?.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: "Quit Nautilo",
        click: () => {
          app.quit();
        },
      },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createWindow(
  url: string,
): void {
  const state = loadWindowState();
  const activeSession = serverSessions.active;
  if (!activeSession) {
    throw new Error(
      "cannot create main window before ensuring a server session",
    );
  }

  mainWindow = new BaseWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined
      ? { x: state.x, y: state.y }
      : {}),
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "default",
    backgroundColor: workbenchBackgroundColor(),
    // Operator-run CDP smokes must not flash three short-lived Nautilo
    // windows across the Human's desktop. The view still loads and remains
    // fully inspectable through its isolated debugging port.
    show: process.env["NAUTILO_SMOKE_HIDDEN"] !== "1",
  });
  if (
    process.env["NAUTILO_SMOKE_HIDDEN"] === "1" &&
    process.platform === "darwin"
  ) {
    app.dock?.hide();
  }

  // Install before creating the renderer: existing sandbox frames retain their
  // protocol loader factories and cannot discover a handler added by later IPC.
  registerMediaProxySession(session.fromPartition(activeSession.partition));

  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // D519 — make the Composer's platform-owned spellchecking contract
      // explicit rather than depending on Electron's runtime default.
      spellcheck: true,
      preload: path.join(__dirname, "preload.js"),
      partition: activeSession.partition,
      // D336 — SaaS app surfaces embed cross-origin web content as a real DOM
      // element via <webview>, which (unlike WebContentsView) is laid out and
      // clipped by the compositor so it can never float outside its panel.
      // Electron defaults this to false; we opt in and keep webviews contained
      // behind BrowserControlManager.
      webviewTag: true,
    },
  });
  activeSession.view = view;
  attachEditableContextMenu(view.webContents, {
    getWindow: () => mainWindow,
    platform: process.platform,
  });
  const senderId = view.webContents.id;
  if (!serverSessions.attachSender(senderId, activeSession.scope)) {
    view.webContents.close();
    mainWindow.destroy();
    mainWindow = null;
    activeSession.view = null;
    throw new Error("failed to bind active renderer sender to server session");
  }
  view.webContents.once("destroyed", () => {
    serverSessions.detachSender(senderId);
  });
  // The preload subscription replays this after load; this direct lifecycle
  // delivery also covers an already-ready renderer during a host reattach.
  serverSessions.syncRendererActiveStates();
  mainWindow.contentView.addChildView(view);
  const resizeActiveView = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const activeView = serverSessions.active?.view;
    if (!activeView) return;
    const bounds = mainWindow.getContentBounds();
    activeView.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  };
  resizeActiveView();
  browserControlManager = new BrowserControlManager({
    writeProviderState: (state) => {
      try {
        fs.writeFileSync(browserControlStateFilePath(), JSON.stringify(state));
        const nextSessionSource = browserControlStateSessionSource(state);
        if (nextSessionSource !== advertisedBrowserControlSessionSource) {
          advertisedBrowserControlSessionSource = nextSessionSource;
          void refreshDesktopRelayCapabilities("embedded Browser session changed");
        }
      } catch (err) {
        log.warn("[browser-control] failed to write provider state", err);
      }
    },
  });
  browserResearchTargetManager ??= new BrowserResearchTargetManager({
    createView: (options) => new WebContentsView(options),
    attachBackgroundView: (researchView) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      try {
        // Background consent recovery needs a compositor-backed viewport for
        // screenshots and coordinate input. Keep that exact anonymous target
        // behind the full-size Workbench child; Human presentation later
        // re-adds the same view at the default top position.
        mainWindow.contentView.addChildView(
          researchView as WebContentsView,
          0,
        );
        return true;
      } catch (error) {
        log.warn(
          "[browser-research] failed to attach in-app research view",
          error,
        );
        return false;
      }
    },
    attachView: (researchView) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      try {
        mainWindow.contentView.addChildView(researchView as WebContentsView);
        return true;
      } catch (error) {
        log.warn(
          "[browser-research] failed to attach in-app research view",
          error,
        );
        return false;
      }
    },
    detachView: (researchView) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      try {
        mainWindow.contentView.removeChildView(researchView as WebContentsView);
      } catch {
        // Already detached or host closing.
      }
    },
    onSurfaceClosed: (id) =>
      sendToActiveRenderer("browserResearch:surfaceClosed", { id }),
    onVerificationCleared: (id) =>
      sendToActiveRenderer("browserResearch:verificationCleared", { id }),
    onWarning: (message, error) =>
      log.warn(`[browser-research] ${message}`, error),
  });

  // D514 — the local bootstrap starts default-deny. A verified origin is
  // installed atomically only after the main-owned health/identity gates.
  mainNavigationGuard = attachNavigationGuards(view.webContents, {
    allowedOrigins: [],
    allowedFrameOrigins: ["https://live.browser-use.com"],
    allowedLocalFilePaths: coldBootLocalShellPaths(),
    windowName: "main",
  });
  if (verifiedWorkbenchOrigin) {
    mainNavigationGuard.replaceAllowedOrigins([verifiedWorkbenchOrigin]);
  }

  void loadRendererUrl(view.webContents, url).catch((error) => {
    log.warn("[desktop] initial renderer load failed", error);
  });

  // Deep links are privileged Workbench intent, never bootstrap input. Drain
  // only after the exact verified origin has actually loaded.
  view.webContents.on("did-finish-load", () => {
    view.webContents.send(
      "workbench:window-focus-changed",
      activeSession.view === view && isWorkbenchHostWindowFocused(),
    );
    if (!verifiedWorkbenchOrigin) return;
    try {
      if (new URL(view.webContents.getURL()).origin !== verifiedWorkbenchOrigin) return;
    } catch {
      return;
    }
    drainPendingDeepLinks();
  });
  view.webContents.once("destroyed", () => {
    mainNavigationGuard = null;
  });

  if (process.env["NAUTILO_DEVTOOLS"] === "1") {
    view.webContents.openDevTools({ mode: "detach" });
  }

  mainWindow.on("resize", () => {
    resizeActiveView();
    if (mainWindow) saveWindowState(mainWindow);
  });
  mainWindow.on("move", () => {
    if (mainWindow) saveWindowState(mainWindow);
  });
  mainWindow.on("focus", publishWorkbenchHostWindowFocus);
  mainWindow.on("blur", publishWorkbenchHostWindowFocus);
  mainWindow.on("show", publishWorkbenchHostWindowFocus);
  mainWindow.on("hide", publishWorkbenchHostWindowFocus);

  mainWindow.on("close", (e) => {
    // Electron's native updater closes windows before emitting before-quit.
    // Admit that close only after the update's save preparation succeeded;
    // hiding it here would leave the installer waiting for a manual quit.
    const installingPreparedUpdate =
      quitPersistencePrepared && updateController.getState().kind === "installing";
    if (!isQuitting && !installingPreparedUpdate && process.platform === "darwin") {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (activeSession.view === view) activeSession.view = null;
  });
}

// ---------------------------------------------------------------------------
// M161 Phase 3 — in-process server switch view + relay orchestration
// ---------------------------------------------------------------------------

/**
 * M161 Phase 3 — create a `WebContentsView` for a server session on the
 * shared `BaseWindow` host. Mirrors `createWindow`'s view construction:
 * canonical hashed `partition`, same `preload.js` + nav guards + security
 * settings, sender binding via `registry.attachSender`. Does NOT load a
 * URL — the registry drives the initial `${serverUrl}/` navigation
 * through the `navigateView` hook so the switch is observable. Throws on
 * sender-bind failure (fail closed — issue §"Common pitfalls" #1).
 */
function constructServerSessionView(
  serverSession: ServerSession,
  attachToWindow: boolean,
  bindSender: boolean,
): WebContentsView {
  registerMediaProxySession(session.fromPartition(serverSession.partition));
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // D519 — switched server views must retain the same explicit
      // spellchecker behavior as the initial Workbench view.
      spellcheck: true,
      preload: path.join(__dirname, "preload.js"),
      partition: serverSession.partition,
      // D336 — SaaS app surfaces embed cross-origin web content via
      // <webview>; keep webviews contained behind BrowserControlManager.
      webviewTag: true,
    },
  });
  attachEditableContextMenu(view.webContents, {
    getWindow: () => mainWindow,
    platform: process.platform,
  });
  const senderId = view.webContents.id;
  if (bindSender) {
    if (!serverSessions.attachSender(senderId, serverSession.scope)) {
      view.webContents.close();
      throw new Error("failed to bind server session renderer sender");
    }
    view.webContents.once("destroyed", () => {
      serverSessions.detachSender(senderId);
    });
  }
  if (attachToWindow && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.addChildView(view);
    const bounds = mainWindow.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  }
  // P4.5 — navigation containment. The server view may only navigate
  // within its own resolved origin; anything else routes to the system
  // browser via shell.openExternal.
  let allowedOrigins: readonly string[] = [];
  try {
    allowedOrigins = [new URL(serverSession.serverUrl).origin];
  } catch {
    log.warn("[main] could not parse server URL for nav-guard allow-list", {
      url: serverSession.serverUrl,
    });
  }
  attachNavigationGuards(view.webContents, {
    allowedOrigins,
    allowedFrameOrigins: ["https://live.browser-use.com"],
    windowName: "main",
  });
  if (process.env["NAUTILO_DEVTOOLS"] === "1") {
    view.webContents.openDevTools({ mode: "detach" });
  }
  return view;
}

function createServerSessionView(session: ServerSession): WebContentsView {
  return constructServerSessionView(session, true, true);
}

/** D514 candidates remain detached and invisible until the visibility checkpoint. */
function createCandidateServerSessionView(session: ServerSession): WebContentsView {
  return constructServerSessionView(session, false, false);
}

const boundCandidateSessionViews = new WeakSet<WebContentsView>();
function bindCandidateServerSessionSender(
  _previous: ServerSession | null,
  candidate: ServerSession,
  view: WebContentsView,
): void {
  const senderId = view.webContents.id;
  if (!serverSessions.attachSender(senderId, candidate.scope)) {
    throw new Error("failed to bind promoted candidate renderer sender");
  }
  if (boundCandidateSessionViews.has(view)) return;
  boundCandidateSessionViews.add(view);
  view.webContents.once("destroyed", () => {
    serverSessions.detachSender(senderId);
  });
}

function attachCandidateServerSessionView(
  _session: ServerSession,
  view: WebContentsView,
): void {
  showServerSessionView(view);
}

function awaitCandidateNavigation(
  input: {
    attemptId: import("./connection-attempt").ConnectionAttemptId;
    generation: number;
    view: WebContentsView;
    newlyCreatedView: boolean;
    expectedOrigin: string;
    navigationUrl?: string;
  },
  signal: AbortSignal,
): Promise<import("./connection-attempt").ObservationReceipt> {
  const currentUrl = input.view.webContents.getURL();
  if (!input.newlyCreatedView && currentUrl) {
    return Promise.resolve({
      attemptId: input.attemptId,
      generation: input.generation,
      origin: new URL(currentUrl).origin,
      observedAtMs: Date.now(),
    });
  }
  return new Promise((resolve, reject) => {
    const contents = input.view.webContents;
    const cleanup = () => {
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
      signal.removeEventListener("abort", onAbort);
    };
    const onFinish = () => {
      cleanup();
      try {
        resolve({
          attemptId: input.attemptId,
          generation: input.generation,
          origin: new URL(contents.getURL()).origin,
          observedAtMs: Date.now(),
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("invalid candidate URL"));
      }
    };
    const onFail = () => { cleanup(); reject(new Error("candidate navigation failed")); };
    const onAbort = () => { cleanup(); reject(new Error("candidate navigation superseded")); };
    contents.once("did-finish-load", onFinish);
    contents.once("did-fail-load", onFail);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) return onAbort();
    void contents.loadURL(input.navigationUrl ?? `${input.expectedOrigin}/`).catch(onFail);
  });
}

/** Show a hidden (background) session view by re-attaching it to the host. */
function showServerSessionView(view: WebContentsView): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.contentView.addChildView(view);
    const bounds = mainWindow.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height });
  } catch {
    /* already attached or window gone — best-effort */
  }
}

/** Hide a session view without destroying it (preserves the background session). */
function hideServerSessionView(view: WebContentsView): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.contentView.removeChildView(view);
  } catch {
    /* not a child — best-effort */
  }
}

/** Navigate a session view's renderer to a URL (initial `/` load on creation). */
function navigateServerSessionView(view: WebContentsView, url: string): void {
  if (view.webContents.isDestroyed()) return;
  void view.webContents.loadURL(url);
}

/**
 * Route an already-live target renderer to Workbench Home without
 * reloading its WebContents or losing its preserved session state.
 * Phase 4 owns the narrow router listener exposed by preload.
 */
function navigateServerSessionHome(view: WebContentsView): void {
  if (view.webContents.isDestroyed()) return;
  view.webContents.send("servers:navigate-home");
}

/** Main-owned lifecycle signal for every session renderer. */
function setServerSessionRendererActive(
  view: WebContentsView,
  active: boolean,
): void {
  if (view.webContents.isDestroyed()) return;
  const rendererId = view.webContents.id;
  if (!active) {
    forgetDocumentMutationRenderer(rendererId);
  } else {
    documentMutationRendererEpochs.set(
      rendererId,
      documentMutationRendererEpoch(rendererId) + 1,
    );
  }
  view.webContents.send("desktop:active-session-state", {
    active,
    documentMutationEpoch: documentMutationRendererEpoch(rendererId),
  });
  view.webContents.send(
    "workbench:window-focus-changed",
    active && isWorkbenchHostWindowFocused(),
  );
}

/** Destroy + detach a session view (on close). */
function destroyServerSessionView(view: WebContentsView): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.contentView.removeChildView(view);
    } catch {
      /* not a child — best-effort */
    }
  }
  if (!view.webContents.isDestroyed()) {
    view.webContents.close();
  }
}

/**
 * M161 Phase 3 — fetch a server's public `/api/setup/status` summary for
 * `listEnriched`. Network/non-OK is `offline`; reachable JSON missing
 * the alpha/current required profile name or canonical icon is
 * `incompatible`; a valid projection is `live`.
 */
async function fetchListSetupStatus(
  serverUrl: string,
): Promise<ServerSetupStatusProbeResult> {
  const base = serverUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/api/setup/status`, {
      signal: AbortSignal.timeout(5_000),
      headers: { Accept: "application/json" },
    });
  } catch {
    return { kind: "offline" };
  }
  if (!res.ok) return { kind: "offline" };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "incompatible" };
  }
  const profile = parseServerSetupStatusSummary(body);
  return profile ? { kind: "live", profile } : { kind: "incompatible" };
}

async function activateFallbackWithConnectionFlow(serverUrl: string): Promise<ServerFallbackActivationResult> {
  const result = await desktopConnectionFlow.connect(serverUrl, "switch");
  if (result.ok) return { kind: "activated" };
  if (result.reason === "stale" || result.reason === "promotion-failed") return { kind: "indeterminate" };
  try {
    if (!desktopConnectionFlow.cancel()) return { kind: "indeterminate" };
  } catch {
    return { kind: "indeterminate" };
  }
  if (result.reason === "wrong-server") {
    return { kind: "not-activated", result: { ok: false, reason: "incompatible" } };
  }
  if (result.reason === "offline" || result.reason === "incompatible") {
    return { kind: "not-activated", result: { ok: false, reason: result.reason } };
  }
  if (result.reason === "invalid-target" || result.reason === "downgrade-confirmation-required") {
    return { kind: "not-activated", result: { ok: false, reason: "incompatible" } };
  }
  return { kind: "indeterminate" };
}

/**
 * M161 Phase 3 — wire the registry's switch/add/close/list hooks to the
 * real Electron + relay + token-store + network surfaces. Called once
 * from boot() after the host `BaseWindow` exists (so `createView` can
 * attach child views). Idempotent — safe to call again on a re-boot.
 */
function configureServerSessions(): void {
  serverSessions.configure({
    createView: createServerSessionView,
    createCandidateView: createCandidateServerSessionView,
    attachCandidateView: attachCandidateServerSessionView,
    bindCandidateSender: bindCandidateServerSessionSender,
    destroyCandidateView: destroyServerSessionView,
    showView: showServerSessionView,
    hideView: hideServerSessionView,
    setRendererActive: setServerSessionRendererActive,
    navigateView: navigateServerSessionView,
    navigateHome: navigateServerSessionHome,
    destroyView: destroyServerSessionView,
    activateFallback: activateFallbackWithConnectionFlow,
    listRecents: () => listRecentServers(),
    fetchListSetupStatus,
    iconUrlFor: buildVersionedServerIconUrl,
    // Keep the raw Electron storage call behind the registry seam so forget
    // tests can assert every alias partition without booting Electron.
    clearPersistentPartition: async (partition) => {
      await session.fromPartition(partition).clearStorageData();
    },
    // Authority-reducing order mirrors explicit sign-out. A failed fallback
    // never leaves the forgotten active relay/profile alive.
    teardownForgottenActive: async () => {
      await stopRelay();
      await configureComputerUseForServer(null);
      await activeWorkstationProfileController.deactivate();
    },
  });
}

// ---------------------------------------------------------------------------
// Relay status → renderer + tray
// ---------------------------------------------------------------------------

function onRelayStatusChange(status: RelayStatus): void {
  const previousStatus = currentRelayStatus;
  currentRelayStatus = status;
  if (status === "disconnected" || status === "error") {
    void browserResearchTargetManager?.disposeAll();
  }
  // A disconnected relay is no longer remote-enabled. Reconcile immediately
  // instead of waiting for a settings refresh or a power-state transition.
  reconcileRemoteControlKeepAwake();
  sendToActiveRenderer("relay:status", status);
  void publishReadyToWorkOwnerObservation().catch(() => undefined);
  updateTrayMenu();
  // M161 Phase 3 — reflect the active session's relay connection state
  // onto its `connection` field and fire `onChanged` so `servers:list`
  // subscribers (the Phase 4 panel) re-fetch. The relay is active-only,
  // so this maps the active session's relay status to its connection.
  const active = serverSessions.active;
  if (active) {
    const connection: ServerSessionConnection =
      status === "connected"
        ? "live"
        : status === "connecting"
          ? "connecting"
          : "offline";
    serverSessions.updateSession(active.serverUrl, { connection });
  }
  // D418 reconnect/session split-brain fix — on a RECONNECT (a transition
  // to "connected" AFTER the relay has already completed a prior connected
  // cycle), authoritatively re-push the current capability state so the
  // server relay registry's profile binding snapshot is reconciled even if
  // a profile changed between the socket drop and the re-register. The
  // relay client's dynamic `getCapabilities` getter already re-advertises
  // current caps in the register frame; this refresh is the defensive
  // post-reconnect update-capabilities push (idempotent full replacement,
  // revision bumped by the client). It is NOT fired on the initial connect
  // (the register frame already advertised current caps) nor on
  // non-connected transitions, avoiding a race or duplicate with the
  // register path. Fire-and-forget; `refreshDesktopRelayCapabilities`
  // logs + swallows its own errors and is a no-op when not connected.
  if (
    status === "connected" &&
    relayHasConnectedOnce &&
    previousStatus !== "connected"
  ) {
    void refreshDesktopRelayCapabilities("relay reconnect");
    // A transient socket drop preserves the server's in-memory Workstation
    // session, but a server restart does not. Re-run the persisted Ready
    // ceremony after the relay's register acknowledgement so the protected
    // startup receipt can restore that exact contained profile binding. This
    // is still Human/server/relay scoped and cannot enable Direct Mac.
    if (active) void reconcileReadyForServerSession(active, "relay_reconnect");
  }
  if (status === "connected") {
    relayHasConnectedOnce = true;
  }
}

// ---------------------------------------------------------------------------
// Local CA trust (OSS HTTPS mode)
//
// D103 P4.6 — production posture: when a local CA cert exists at
// ~/.nautilo${suffix}/certs/ca.crt, trust it for localhost / 127.0.0.1 / *.local
// URLs ONLY when the presented certificate chain anchors back to that
// pinned CA's public key. This is the chain-check we previously omitted.
//
// Mode matrix:
// - app.isPackaged + connect mode (cfg.mode === "connect"): strict.
//   No CA file → reject all cert errors (production-strict — never trust
//   broken cert errors silently in a packaged build talking to a remote).
// - app.isPackaged + non-connect mode (local / cloud): chain-verified.
//   Trust local hostnames only when the chain anchors to the pinned CA.
//   Reject otherwise.
// - dev mode (!app.isPackaged): chain-verified for local hostnames; no
//   CA file → no cert-error handler installed, default Electron behavior
//   (rejection prompt) takes over. We previously had the broad
//   accept-any-cert-with-CA-file-present behavior; that is now gone in
//   every mode because verify-against-pinned-CA is cheap and strictly
//   safer.
//
// Limitation: we trust ANY cert for local URLs when the CA file exists,
// rather than verifying the presented cert against our CA. Electron's
// certificate-error callback doesn't expose the CA chain for validation.
// This is acceptable for Phase 1 since the only local HTTPS server is ours.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Relay userId resolution
//
// LangGraph tool dispatch matches relays with `state.userId`, which is
// the install owner's `users.id` UUID (see `langgraph-executor.ts`).
// D102 removed `userId` from GET /api/profile — never leak it through the
// agent envelope. Bootstrap order:
//   1. NAUTILO_USER_ID env (escape hatch)
//   2. GET /api/profile/status → `relayUserId` when the request hits the
//      server from loopback (local desktop ↔ local server)
//   3. Current Logto access token + GET /api/auth/whoami →
//      `sessionUserId`
//   4. Legacy ~/.nautilo/session.json bearer + whoami (default instance only)
//   5. null → defer relay until sign-in provides a JWT
// ---------------------------------------------------------------------------

function readPersistedSessionToken(): string | null {
  // Intentional non-suffixed legacy migration path: only the default instance
  // may read ~/.nautilo/session.json so named instances never inherit its bearer.
  if ((process.env["NAUTILO_INSTANCE_ID"] ?? "").trim() !== "") {
    return null;
  }
  try {
    const p = path.join(homedir(), ".nautilo", "session.json");
    if (!fs.existsSync(p)) return null;
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { token?: unknown };
    return typeof raw.token === "string" && raw.token.length > 0
      ? raw.token
      : null;
  } catch {
    return null;
  }
}

function avatarRefToWizardAvatarUrl(
  ref: unknown,
  canonicalAvatarUrl: string,
): string | null {
  if (!ref || typeof ref !== "object") return canonicalAvatarUrl;
  const r = ref as { kind?: unknown; id?: unknown };
  if (r.kind === "preset" && typeof r.id === "string") {
    if (r.id === "shell") return canonicalAvatarUrl;
    return `/api/onboarding/images/avatars/${r.id}.webp`;
  }
  return canonicalAvatarUrl;
}

function parseAvatarRef(value: unknown): AvatarRef | null {
  if (!value || typeof value !== "object") return null;
  const ref = value as Record<string, unknown>;
  if (ref["kind"] === "preset" && typeof ref["id"] === "string") {
    return { kind: "preset", id: ref["id"] };
  }
  if (
    (ref["kind"] === "uploaded" || ref["kind"] === "generated") &&
    typeof ref["blobId"] === "string"
  ) {
    return { kind: ref["kind"], blobId: ref["blobId"] };
  }
  return null;
}

function agentEnvelopeToProfileSnapshot(
  json: unknown,
): WizardProfileSnapshot | null {
  if (!json || typeof json !== "object") return null;
  const root = json as Record<string, unknown>;
  if (root["viewerRole"] !== "owner") return null;
  const agent = root["agent"];
  if (!agent || typeof agent !== "object") return null;
  const a = agent as Record<string, unknown>;
  if (a["onboardingCompleted"] !== true) return null;

  const voicesRaw =
    a["voices"] && typeof a["voices"] === "object"
      ? (a["voices"] as Record<string, unknown>)
      : {};
  const defaultVoiceRaw = voicesRaw["default"];
  const defaultVoice =
    defaultVoiceRaw && typeof defaultVoiceRaw === "object"
      ? (() => {
          const dv = defaultVoiceRaw as Record<string, unknown>;
          const voiceId =
            typeof dv["voiceId"] === "string" ? dv["voiceId"] : null;
          const voiceName =
            typeof dv["voiceName"] === "string" ? dv["voiceName"] : null;
          return voiceId && voiceName ? { voiceId, voiceName } : null;
        })()
      : null;
  const personality =
    a["personality"] && typeof a["personality"] === "object"
      ? (a["personality"] as Record<string, unknown>)
      : {};
  const canonicalAvatarUrl =
    typeof a["avatarUrl"] === "string" && a["avatarUrl"].length > 0
      ? a["avatarUrl"]
      : "/api/profile/avatar";

  const lang = typeof a["language"] === "string" ? a["language"] : "en";
  const language: WizardProfileSnapshot["language"] =
    lang === "es" ? "es" : "en";

  const wlm = a["workLifeMode"];
  const workLifeMode: WizardProfileSnapshot["workLifeMode"] =
    wlm === "work" || wlm === "life" || wlm === "both" ? wlm : null;

  return {
    name: typeof a["name"] === "string" ? a["name"] : "",
    language,
    workLifeMode,
    privacySpectrum:
      typeof a["privacySpectrum"] === "number" ? a["privacySpectrum"] : 50,
    personalityPrompt:
      typeof personality["prompt"] === "string" ? personality["prompt"] : null,
    motherAnswer:
      typeof personality["motherAnswer"] === "string"
        ? personality["motherAnswer"]
        : null,
    defaultVoice,
    avatar: parseAvatarRef(a["avatar"]),
    avatarUrl: avatarRefToWizardAvatarUrl(a["avatar"], canonicalAvatarUrl),
    soulFile: typeof a["soulFile"] === "string" ? a["soulFile"] : null,
  };
}

async function loadProfileAvatarDataUrl(
  serverUrl: string,
  bearer: string,
): Promise<string | null> {
  try {
    const resp = await fetch(`${serverUrl}/api/profile/avatar`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    if (!resp.ok) return null;
    const contentType = resp.headers.get("content-type") ?? "image/png";
    const bytes = await resp.arrayBuffer();
    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  } catch {
    return null;
  }
}

async function hydrateProfileAvatarPreview(
  snapshot: WizardProfileSnapshot,
  serverUrl: string,
  bearer: string,
): Promise<WizardProfileSnapshot> {
  if (snapshot.avatarUrl !== "/api/profile/avatar") return snapshot;
  const avatarUrl = await loadProfileAvatarDataUrl(serverUrl, bearer);
  return avatarUrl ? { ...snapshot, avatarUrl } : snapshot;
}

/**
 * Resolve the relay's `userId` for `startRelay`. Returns null when
 * the user is not signed in and no bootstrap path can discover an id.
 */
async function resolveRelayUserId(serverUrl: string): Promise<string | null> {
  const explicit = process.env["NAUTILO_USER_ID"];
  if (explicit) return explicit;

  // A restored signed-in session is canonical. The localhost profile-status
  // bootstrap projects the instance's fallback Human and can belong to a
  // different user; consulting it first misbinds the relay after login.
  const accessToken = await getValidAccessToken({
    refresh: () => refreshTokens(),
  });
  if (accessToken) {
    try {
      const who = await fetch(`${serverUrl}/api/auth/whoami`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (who.ok) {
        const body = (await who.json()) as { sessionUserId?: unknown };
        if (
          typeof body.sessionUserId === "string" &&
          body.sessionUserId.length > 0
        ) {
          console.log(
            "[desktop] Resolved relay userId from /api/auth/whoami (Logto JWT)",
          );
          return body.sessionUserId;
        }
      }
    } catch (err) {
      console.warn("[desktop] whoami (Logto JWT) relay bootstrap failed:", err);
    }
  }

  const token = readPersistedSessionToken();
  if (token) {
    try {
      const who = await fetch(`${serverUrl}/api/auth/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (who.ok) {
        const body = (await who.json()) as { sessionUserId?: unknown };
        if (
          typeof body.sessionUserId === "string" &&
          body.sessionUserId.length > 0
        ) {
          console.log(
            "[desktop] Resolved relay userId from /api/auth/whoami (legacy session file)",
          );
          return body.sessionUserId;
        }
      }
    } catch (err) {
      console.warn("[desktop] whoami relay bootstrap failed:", err);
    }
  }

  // Fresh/unclaimed local setup has no authenticated bearer yet. Only then
  // may the localhost bootstrap identity seed the relay.
  try {
    const statusResp = await fetch(`${serverUrl}/api/profile/status`);
    if (statusResp.ok) {
      const status = (await statusResp.json()) as { relayUserId?: unknown };
      if (typeof status.relayUserId === "string" && status.relayUserId.length > 0) {
        console.log("[desktop] Resolved relay userId from /api/profile/status (localhost bootstrap)");
        return status.relayUserId;
      }
    } else {
      console.warn(`[desktop] /api/profile/status → ${statusResp.status} during relay bootstrap`);
    }
  } catch (err) {
    console.warn("[desktop] /api/profile/status relay bootstrap failed:", err);
  }

  console.warn("[desktop] Could not resolve relay userId — deferring relay until sign-in");
  return null;
}

/**
 * D103 P4.6 — chain-verify a presented Electron Certificate against the
 * pinned local CA. Walks the `issuerCert` chain (Electron supplies the
 * server-presented chain) and returns true iff some node in the chain
 * is signed by the pinned CA's public key.
 *
 * Returning false is the safe default: any parse failure, missing
 * issuer chain, or signature mismatch causes the cert-error to bubble
 * up to Electron's default rejection.
 */
function chainAnchorsTo(
  presented: Electron.Certificate,
  caCertificatePem: string,
): boolean {
  // Extract the CA's public key from its certificate PEM.
  // `createPublicKey()` rejects `BEGIN CERTIFICATE` PEM bodies (it expects
  // SPKI / PKCS1 public-key PEM); the canonical extraction is via
  // `new X509Certificate(certPem).publicKey`. An earlier revision used
  // `createPublicKey()` directly and silently failed every chain check —
  // see commit log for D103 P4.6 follow-up.
  let caKey: import("node:crypto").KeyObject;
  try {
    caKey = new X509Certificate(caCertificatePem).publicKey;
  } catch {
    return false;
  }

  let cur: Electron.Certificate | undefined = presented;
  let depth = 0;
  while (cur && depth < 8 /* sane chain-depth cap */) {
    try {
      const x = new X509Certificate(Buffer.from(cur.data));
      if (x.verify(caKey)) return true;
    } catch {
      // Parse failed — bail out; default rejection.
      return false;
    }
    // Electron's Certificate type chains via `issuerCert`. Self-signed
    // leaves leave issuerCert undefined (or pointing at themselves).
    const next: Electron.Certificate | undefined = cur.issuerCert;
    if (!next || next === cur) break;
    cur = next;
    depth++;
  }
  return false;
}

function isExpectedLocalAuthorityError(error: string): boolean {
  return [
    "net::ERR_CERT_AUTHORITY_INVALID",
    "net::ERR_CERT_UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    "net::ERR_CERT_SELF_SIGNED_CERT_IN_CHAIN",
  ].includes(error);
}

function leafCertificateMatchesHostAndTime(
  presented: Electron.Certificate,
  hostname: string,
  now = new Date(),
): boolean {
  try {
    const x = new X509Certificate(Buffer.from(presented.data));
    const validFrom = Date.parse(x.validFrom);
    const validTo = Date.parse(x.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return false;
    const nowMs = now.getTime();
    if (nowMs < validFrom || nowMs > validTo) return false;

    if (isIP(hostname)) {
      return x.checkIP(hostname) !== undefined;
    }
    return x.checkHost(hostname) !== undefined;
  } catch {
    return false;
  }
}

// P4.6 — boot-time mode is set after first-run / config load. The
// cert-error handler is installed BEFORE that resolution (early in
// boot()), so it reads the live mode through this getter. Default
// "unknown" is treated as strict (no override) until set.
let currentBootMode: "local" | "connect" | "cloud" | "unknown" = "unknown";
function setCurrentBootMode(mode: "local" | "connect" | "cloud"): void {
  currentBootMode = mode;
}

function setupLocalCATrust(): void {
  const caCertPath = path.join(
    resolveNautiloRootDir({ env: process.env }),
    "certs",
    "ca.crt",
  );

  let caPem: string | null = null;
  try {
    caPem = fs.readFileSync(caCertPath, "utf8");
  } catch {
    caPem = null;
  }

  if (!caPem) {
    log.info(
      `[desktop] no local CA file at ${caCertPath} — strict TLS (Electron default)`,
    );
    return;
  }

  app.on(
    "certificate-error",
    (event, _webContents, url, error, cert, callback) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        callback(false);
        return;
      }
      const isLocal =
        parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname.endsWith(".local");

      // P4.6 production-strict: packaged build in connect mode never
      // overrides cert errors for non-local hostnames. Local hostnames
      // still go through chain-verify below. The remote in connect mode
      // is expected to present a public-CA-rooted cert; if it doesn't,
      // that's a real problem we don't paper over.
      if (app.isPackaged && currentBootMode === "connect" && !isLocal) {
        callback(false);
        return;
      }
      if (!isLocal) {
        callback(false);
        return;
      }
      if (!isExpectedLocalAuthorityError(error)) {
        log.warn(
          "[desktop] cert-error: refusing override for non-authority TLS error",
          {
            url: parsed.origin,
            mode: currentBootMode,
            error,
          },
        );
        callback(false);
        return;
      }
      if (!leafCertificateMatchesHostAndTime(cert, parsed.hostname)) {
        log.warn(
          "[desktop] cert-error: refusing override for hostname/validity mismatch",
          {
            url: parsed.origin,
            mode: currentBootMode,
            error,
          },
        );
        callback(false);
        return;
      }
      // P4.6 — chain-verify the presented cert against the pinned CA.
      // Failed verification → default rejection.
      if (chainAnchorsTo(cert, caPem)) {
        event.preventDefault();
        callback(true);
        return;
      }
      log.warn(
        "[desktop] cert-error: presented chain did not anchor to pinned CA — rejecting",
        {
          url: parsed.origin,
          mode: currentBootMode,
        },
      );
      callback(false);
    },
  );

  log.info(`[desktop] Local CA trust (chain-verified) enabled (${caCertPath})`);
}

// ---------------------------------------------------------------------------
// First-run picker (D057 2a.2)
//
// Shows a dedicated BrowserWindow loading first-run/index.html so the
// the user can connect to one server before the main workbench comes up.
// Runs once per install; subsequent launches read the committed active
// authority and skip the picker. The window closes only after promotion.
//
// Env var escape hatches (dev only):
//   NAUTILO_CONNECT_SERVER_URL → skip picker, connect to this URL
//   NAUTILO_FORCE_FIRST_RUN    → re-run picker even if config exists
// ---------------------------------------------------------------------------

type FirstRunPickerMode = "first-run" | "switch-server" | "add-server";

type InitialConnectionCohort = Readonly<{ url: string; verified: VerifiedConnectionCohort }>;
type PickerConnectionResult = DesktopConnectionResult | (Extract<DesktopConnectionResult, { ok: true }> & {
  verified: VerifiedConnectionCohort;
});

let initialConnectionCohort: InitialConnectionCohort | null = null;
let recoveryReplacementCohort: InitialConnectionCohort | null = null;
let initialConnectionHost: BaseWindow | null = null;

/**
 * First-run has no active server by definition. Give the registry an invisible
 * local host for its detached candidate without inventing an active session.
 * The host and proved candidate are discarded after commit; normal boot then
 * builds the real local bootstrap shell from the same verified facts cohort.
 */
function ensureInitialConnectionHost(): void {
  if (initialConnectionHost && !initialConnectionHost.isDestroyed()) return;
  initialConnectionHost = new BaseWindow({
    width: 800,
    height: 600,
    show: false,
    backgroundColor: workbenchBackgroundColor(),
  });
  mainWindow = initialConnectionHost;
  configureServerSessions();
}

function disposeInitialConnectionHost(): void {
  const active = serverSessions.active;
  const view = active?.view ?? null;
  if (view) {
    try { initialConnectionHost?.contentView.removeChildView(view); } catch { /* detached */ }
    try { view.webContents.close(); } catch { /* already closed */ }
    if (active?.view === view) active.view = null;
  }
  try { initialConnectionHost?.destroy(); } catch { /* already closed */ }
  if (mainWindow === initialConnectionHost) mainWindow = null;
  initialConnectionHost = null;
}

function showFirstRunPicker(
  opts: {
    mode?: FirstRunPickerMode;
    currentServerUrl?: string | null;
    suggestedUrl?: string | null;
    theme?: DesktopConnectionTheme;
  } = {},
): Promise<PickerConnectionResult | null> {
  const pickerMode: FirstRunPickerMode = opts.mode ?? "first-run";
  const currentServerUrl = opts.currentServerUrl?.trim() || null;
  const suggestedUrl = opts.suggestedUrl?.trim() || null;
  return new Promise<PickerConnectionResult | null>((resolve, reject) => {
    // Pick the BrowserWindow backgroundColor to match the OS theme so
    // light-mode users don't see a dark flash before first-run/index.html
    // paints. The page's own CSS picks up @media (prefers-color-scheme)
    // at load; this just eliminates the 1-frame gap between window
    // appearing and first content paint.
    const pickerBg = nativeTheme.shouldUseDarkColors ? "#0f1420" : "#f7f9fc";
    const win = new BrowserWindow({
      width: 760,
      height: 820,
      minWidth: 640,
      minHeight: 680,
      title: "Nautilo — Setup",
      backgroundColor: pickerBg,
      titleBarStyle: "hiddenInset",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-first-run.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    activeServerPickerWindow = win;

    // D376 — smoke-hidden mode: the boot smoke (smoke-packaged.ts) sets
    // NAUTILO_SMOKE_HIDDEN=1 so local harness runs don't pop a visible
    // Setup window on the operator's desktop. Content still loads and
    // CDP can still enumerate the preload surface on a hidden window;
    // only the show() is skipped. Normal launches are unaffected.
    const smokeHidden = process.env["NAUTILO_SMOKE_HIDDEN"] === "1";
    win.once("ready-to-show", () => {
      if (!smokeHidden) {
        win.show();
        win.focus();
      }
    });
    if (smokeHidden && process.platform === "darwin") app.dock?.hide();

    // P4.5 — navigation containment. The first-run picker is a
    // file:// SPA that talks to main exclusively via IPC; it has no
    // legitimate reason to navigate top-level. Any external links
    // (docs, support) routed via shell.openExternal.
    attachNavigationGuards(win, {
      allowedOrigins: [],
      windowName: "first-run",
    });

    void win.loadFile(path.join(__dirname, "first-run", "index.html"));

    const sendPresentation = (snapshot: ConnectionPresentation) => {
      if (!win.webContents.isDestroyed()) win.webContents.send("first-run:connection-presentation", snapshot);
    };
    pickerPresentationListener = sendPresentation;

    let settled = false;
    const finishConnection = (result: DesktopConnectionResult) => {
      if (!result.ok) {
        if (pickerMode === "first-run" && result.reason !== "downgrade-confirmation-required" &&
            result.reason !== "wrong-server") {
          if (desktopConnectionFlow.cancel()) disposeInitialConnectionHost();
        }
        if (result.reason === "wrong-server") {
          return { ok: false as const, reason: result.reason, decisionId: result.decisionId };
        }
        if (result.reason === "downgrade-confirmation-required") {
          return { ok: false as const, reason: result.reason, decisionId: result.decisionId };
        }
        if (result.reason === "promotion-failed") {
          return { ok: false as const, reason: result.reason,
            authoritativePairingChanged: result.authoritativePairingChanged };
        }
        return { ok: false as const, reason: result.reason };
      }
      if (pickerMode === "first-run") {
        const verified = desktopConnectionFlow.takeVerifiedCohort(result.url);
        if (!verified) {
          disposeInitialConnectionHost();
          return { ok: false as const, reason: "promotion-failed" as const,
            authoritativePairingChanged: false as const };
        }
        initialConnectionCohort = { url: result.url, verified };
        disposeInitialConnectionHost();
        settled = true;
        cleanup();
        win.close();
        resolve({ ...result, verified });
        return { ok: true as const, url: result.url };
      }
      const verified = desktopConnectionFlow.takeVerifiedCohort(result.url);
      settled = true;
      cleanup();
      win.close();
      resolve(verified ? { ...result, verified } : result);
      return { ok: true as const, url: result.url };
    };
    // IPC handlers — scoped to this picker window via WebContents id so
    // they can't be called from other renderers after the picker closes.
    const handlers = {
      getConnectTargets: async (_e: Electron.IpcMainInvokeEvent) => {
        if (_e.sender.id !== win.webContents.id) {
          return {
            candidates: [] as const,
            recentServers: [] as const,
            suggestedUrl: null as string | null,
            localDiscovery: { kind: "unavailable" as const },
            mode: pickerMode,
            currentServerUrl,
          };
        }
        try {
          const targets = await getFirstRunConnectTargets();
          return {
            ...targets,
            recentServers: targets.recentServers.map(rendererSafeConnectionValue),
            suggestedUrl: suggestedUrl ?? targets.suggestedUrl,
            mode: pickerMode,
            currentServerUrl,
          };
        } catch (err) {
          log.warn("[desktop] first-run getConnectTargets failed:", err);
          return {
            candidates: [],
            recentServers: [],
            suggestedUrl: null,
            localDiscovery: { kind: "unavailable" as const },
            mode: pickerMode,
            currentServerUrl,
          };
        }
      },
      commit: async (_e: Electron.IpcMainInvokeEvent, cfg: DesktopConfig) => {
        if (_e.sender.id !== win.webContents.id || settled) {
          return { ok: false as const, reason: "stale" as const };
        }
        if (cfg.mode !== "connect" || !cfg.serverUrl?.trim()) {
          return { ok: false as const, reason: "invalid-target" as const };
        }
        if (pickerMode === "first-run") ensureInitialConnectionHost();
        const context = pickerMode === "first-run"
          ? "initial" as const
          : pickerMode === "add-server"
            ? "add" as const
            : "switch" as const;
        const result = await desktopConnectionFlow.connect(
          cfg.serverUrl.trim(),
          context,
          opts.theme ?? null,
        );
        return finishConnection(result);
      },
      confirmDowngrade: async (_e: Electron.IpcMainInvokeEvent, decisionId: unknown) => {
        if (_e.sender.id !== win.webContents.id || settled || typeof decisionId !== "string") {
          return { ok: false as const, reason: "stale" as const };
        }
        return finishConnection(await desktopConnectionFlow.confirmDowngrade(decisionId));
      },
      acceptIdentity: async (_e: Electron.IpcMainInvokeEvent, decisionId: unknown) => {
        if (_e.sender.id !== win.webContents.id || settled || typeof decisionId !== "string") {
          return { ok: false as const, reason: "stale" as const };
        }
        return finishConnection(await desktopConnectionFlow.acceptIdentity(decisionId));
      },
      cancel: (_e: Electron.IpcMainInvokeEvent) => {
        if (_e.sender.id !== win.webContents.id) return;
        if (settled) return;
        if (!desktopConnectionFlow.cancel()) return;
        if (pickerMode === "first-run") disposeInitialConnectionHost();
        settled = true;
        cleanup();
        win.close();
        if (pickerMode === "switch-server" || pickerMode === "add-server") {
          // M161 Phase 3 — switch/add cancel keeps the current server
          // active; resolve null so the IPC handler can no-op.
          resolve(null);
        } else {
          reject(new Error("First-run picker cancelled"));
        }
      },
      abortAttempt: (_e: Electron.IpcMainInvokeEvent) => {
        if (_e.sender.id !== win.webContents.id || settled) return false;
        const cancelled = desktopConnectionFlow.cancel();
        if (cancelled && pickerMode === "first-run") disposeInitialConnectionHost();
        return cancelled;
      },
    };

    const cleanup = () => {
      ipcMain.removeHandler("first-run:get-connect-targets");
      ipcMain.removeHandler("first-run:commit");
      ipcMain.removeHandler("first-run:confirm-downgrade");
      ipcMain.removeHandler("first-run:accept-identity");
      ipcMain.removeHandler("first-run:cancel");
      ipcMain.removeHandler("first-run:abort-attempt");
      if (pickerPresentationListener === sendPresentation) pickerPresentationListener = null;
      if (activeServerPickerWindow === win) activeServerPickerWindow = null;
    };

    ipcMain.handle("first-run:get-connect-targets", handlers.getConnectTargets);
    ipcMain.handle("first-run:commit", handlers.commit);
    ipcMain.handle("first-run:confirm-downgrade", handlers.confirmDowngrade);
    ipcMain.handle("first-run:accept-identity", handlers.acceptIdentity);
    ipcMain.handle("first-run:cancel", handlers.cancel);
    ipcMain.handle("first-run:abort-attempt", handlers.abortAttempt);

    // User closed the window without committing (click X / Cmd+Q).
    // Treat as cancel and surface a clear error — main will quit.
    win.on("closed", () => {
      if (!settled) {
        if (!desktopConnectionFlow.cancel()) return;
        if (pickerMode === "first-run") disposeInitialConnectionHost();
        settled = true;
        cleanup();
        if (pickerMode === "switch-server" || pickerMode === "add-server") {
          resolve(null);
        } else {
          reject(new Error("First-run picker closed without confirming"));
        }
      }
    });
  });
}

/**
 * An initial precommit journal is editable intent, not evidence to resume.
 * Only the empty-authority journal shape may prefill the ordinary first-run
 * picker; every fresh Connect still mints its own attempt and observations.
 */
function initialPrecommitPickerSuggestion(): string | null {
  const loaded = connectionPendingStore().load();
  if (loaded.disposition !== "precommit") return null;
  const recovery = projectPendingConnectionRecovery(loaded);
  return recovery.disposition === "precommit" &&
      recovery.context === "initial" &&
      recovery.priorActiveScope === null &&
      recovery.priorRecoveryGuard.scope === null &&
      recovery.priorRecoveryGuard.revision === null
    ? recovery.enteredTarget
    : null;
}

// ---------------------------------------------------------------------------
// Onboarding wizard (D091)
//
// "The Genie Moment" — fullscreen BrowserWindow that walks a new
// owner through language / keys / privacy / work-life / owner details
// / personality / soul-compile / avatar / name / voice / reveal. Runs
// ONCE per profile on the happy path; re-trigger from workbench
// Settings lands in Phase 3.
//
// Phase 1 (this commit): scaffold + OrbCanvas port + boot wiring +
// placeholder screen + D092 routing-hook stub. Phase 2 fills in the
// 13 real screens + full API-proxy IPC surface. Phase 3 deletes the
// legacy Fastify-served `/setup/` static page.
//
// Env var dev escape hatch:
//   NAUTILO_FORCE_ONBOARDING → re-run wizard even if profile says
//                              onboardingCompleted=true
// ---------------------------------------------------------------------------

/**
 * D092 routing hook — D112 maps from cached `GET /api/setup/status`
 * (see `loadBootSetupStatus` in `boot()`). `ServerClaimState` is
 * imported from `./boot-setup-status` (single source of truth — a
 * previous local re-declaration here drifted as a shadow type and
 * defeated the mapper's `_exhaustive: never` guard for this consumer).
 */
function probeServerState(_serverUrl: string): ServerClaimState {
  return mapSetupStatusToServerClaimState(bootSetupStatus);
}

/**
 * Check whether the wizard should run for the current profile. Boot
 * calls this AFTER the server is reachable + BEFORE createWindow.
 *
 * D112 — `bootSetupStatus` (`GET /api/setup/status`, usually guest) can
 * skip the wizard for `fresh-unclaimed` / `server-needs-keys`, or force it
 * when `viewer.genieCustomized === false`. Otherwise falls back to
 * `/api/profile/status`.
 *
 * Truth table (legacy profile probe):
 *   profile fetch errors       → return false
 *   profile is null / 404      → return true
 *   profile.onboardingCompleted is true  → return false
 *   profile.onboardingCompleted is false → return true
 */
async function shouldShowOnboarding(serverUrl: string): Promise<boolean> {
  if (process.env["NAUTILO_FORCE_ONBOARDING"] === "1") {
    console.log(
      "[desktop] NAUTILO_FORCE_ONBOARDING=1 — forcing onboarding wizard",
    );
    return true;
  }
  if (shouldSkipGenieOnboardingWizard(bootSetupStatus)) {
    console.log(
      "[desktop] Skipping Genie onboarding wizard (setupState / viewer gate)",
    );
    return false;
  }
  if (shouldForceGenieOnboardingFromSetup(bootSetupStatus)) {
    console.log(
      "[desktop] Opening onboarding wizard (setup ready, genie not customized)",
    );
    return true;
  }
  try {
    const resp = await fetch(`${serverUrl}/api/profile/status`);
    if (!resp.ok) {
      console.warn(
        `[desktop] /api/profile/status returned ${resp.status}; skipping wizard`,
      );
      return false;
    }
    const status = (await resp.json()) as {
      exists?: unknown;
      onboardingCompleted?: unknown;
    };
    if (status.exists !== true) return true;
    return status.onboardingCompleted !== true;
  } catch (err) {
    console.warn(
      "[desktop] Failed to probe /api/profile/status for onboarding gate:",
      err,
    );
    return false;
  }
}

/**
 * IPC channel name list — single source of truth so registration
 * + cleanup stay in sync. Adding a channel = update this array
 * AND register a handler below; cleanup auto-removes via the array.
 */
const ONBOARDING_IPC_CHANNELS = [
  "onboarding:get-server-url",
  "onboarding:complete",
  "onboarding:cancel",
  "onboarding:load-existing-profile",
  "onboarding:get-config-flags",
  "onboarding:get-start-at",
  "onboarding:get-voices",
  "onboarding:list-voice-catalog",
  "onboarding:preview-voice",
  "onboarding:generate-soul",
  "onboarding:generate-avatar",
  "onboarding:put-profile",
  "onboarding:upsert-voice",
] as const;

type Uint8StreamReadResult =
  | { readonly done: true; readonly value?: undefined }
  | { readonly done: false; readonly value: Uint8Array };

function ipcOk<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function ipcErr(error: unknown): IpcResult<never> {
  const msg = error instanceof Error ? error.message : String(error);
  return { ok: false, error: msg };
}

const PROFILE_SAVED_AVATAR_UNVERIFIED_ERROR =
  "Your profile was saved, but Nautilo could not confirm the Agent photo update. Refresh Nautilo to verify the photo, or choose it again in Settings.";

function splitSseFrames(raw: string): { frames: string[]; remainder: string } {
  const frames: string[] = [];
  let start = 0;
  const frameBoundary = /\r?\n\r?\n/g;
  for (;;) {
    const match = frameBoundary.exec(raw);
    if (!match) break;
    frames.push(raw.slice(start, match.index));
    start = match.index + match[0].length;
  }
  return { frames, remainder: raw.slice(start) };
}

function parseSseEvents(
  frames: readonly string[],
): Array<{ event: string | null; data: string }> {
  const events: Array<{ event: string | null; data: string }> = [];
  for (const block of frames) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of trimmed.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice("event:".length).trim();
      if (line.startsWith("data:"))
        dataLines.push(line.slice("data:".length).trim());
    }
    if (dataLines.length > 0)
      events.push({ event, data: dataLines.join("\n") });
  }
  return events;
}

/** Build query string for `GET /api/voices/catalog` (D215). */
function buildCatalogQueryString(query: unknown): string {
  if (query === undefined || query === null) return "";
  if (typeof query !== "object") return "";
  const q = query as Record<string, unknown>;
  const params = new URLSearchParams();
  for (const key of [
    "language",
    "category",
    "gender",
    "age",
    "accent",
    "use_cases",
    "search",
  ] as const) {
    const value = q[key];
    if (typeof value === "string" && value.trim()) {
      params.set(key, value.trim());
    }
  }
  const page = q["page"];
  if (typeof page === "number" && Number.isFinite(page)) {
    params.set("page", String(Math.max(0, Math.floor(page))));
  } else if (typeof page === "string" && page.trim()) {
    params.set("page", page.trim());
  }
  const pageSize = q["page_size"];
  if (typeof pageSize === "number" && Number.isFinite(pageSize)) {
    params.set(
      "page_size",
      String(Math.min(100, Math.max(1, Math.floor(pageSize)))),
    );
  } else if (typeof pageSize === "string" && pageSize.trim()) {
    params.set("page_size", pageSize.trim());
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Wrap a fetch call to the Nautilo server, normalize HTTP
 * + network errors into IpcResult, and (when bearerToken is set)
 * set the Authorization: Bearer header.
 *
 * D091 wires this for every API-proxy handler in
 * showOnboardingWizard. The bearer is always the user's Logto
 * access token (see `getWizardBearer` at call sites).
 */
async function proxyFetch<T>(
  serverUrl: string,
  endpoint: string,
  init: RequestInit,
  bearerToken: string | null,
): Promise<IpcResult<T>> {
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (bearerToken) headers["authorization"] = `Bearer ${bearerToken}`;
    // D091 live-verify diagnostic — keep observable so re-trigger
    // auth regressions surface in electron.log. Token is logged
    // as prefix only.
    console.log(
      `[onboarding:proxy] ${init.method ?? "GET"} ${endpoint} auth=${bearerToken ? `Bearer ${bearerToken.slice(0, 8)}…` : "none"}`,
    );
    const resp = await fetch(`${serverUrl}${endpoint}`, {
      ...init,
      headers,
    });
    if (!resp.ok) {
      // 404 on /api/profile is a legitimate "no profile yet" signal
      // for some endpoints; callers handle that case explicitly
      // before calling proxyFetch. Everything else is a real error.
      return ipcErr(
        `${init.method ?? "GET"} ${endpoint} → ${resp.status} ${resp.statusText}`,
      );
    }
    const json = (await resp.json()) as T;
    return ipcOk(json);
  } catch (err) {
    return ipcErr(err);
  }
}

/**
 * Open the onboarding wizard BrowserWindow and resolve when the user
 * completes (Continue on the final screen). Rejects when the user
 * cancels (⌘W / window X / explicit Skip). Mirrors the
 * showFirstRunPicker pattern.
 *
 * Authenticated server calls use the Logto access token from the
 * main-process token store (`getWizardBearer` at call sites).
 */
function parseOnboardingStartAt(raw: unknown): OnboardingStartAt | null {
  return raw === "personality" || raw === "avatar" ? raw : null;
}

function showOnboardingWizard(
  serverUrl: string,
  opts: {
    startAt?: OnboardingStartAt | null;
    partition?: string;
    getBearer?: () => Promise<string | null>;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error("Onboarding wizard cancelled"));
      return;
    }
    const getWizardBearer = async (): Promise<string | null> =>
      opts.getBearer
        ? opts.getBearer()
        : getValidAccessToken({
            refresh: () => refreshTokens(),
            onObservedRejection: onLogtoRefreshFailed,
          });

    const bg = nativeTheme.shouldUseDarkColors ? "#0a0d16" : "#fafbff";

    const win = new BrowserWindow({
      width: 960,
      height: 840,
      minWidth: 900,
      minHeight: 780,
      resizable: true,
      maximizable: true,
      minimizable: false,
      fullscreenable: false,
      title: "Nautilo — Meet your Genie",
      backgroundColor: bg,
      titleBarStyle: "hiddenInset",
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "preload-onboarding.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(opts.partition ? { partition: opts.partition } : {}),
      },
    });

    // CSP widening — runtime response-header override that lets the
    // wizard fetch audio + API responses from the resolved server URL.
    // The static index.html ships with `connect-src 'none'` baked in;
    // this override takes precedence at the renderer.
    //
    // Scoped to this window's session via the per-window webContents
    // so the workbench's session isn't affected. Cleanup detaches
    // automatically when the window closes.
    const sessionInst = win.webContents.session;
    sessionInst.webRequest.onHeadersReceived(
      { urls: [`file://*`] },
      (details, callback) => {
        const headers = { ...details.responseHeaders };
        // Find any existing CSP header (case-insensitive) and replace it.
        const cspKey = Object.keys(headers).find(
          (k) => k.toLowerCase() === "content-security-policy",
        );
        if (cspKey) delete headers[cspKey];
        headers["content-security-policy"] = [
          `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${serverUrl}; connect-src 'self' ${serverUrl}; media-src 'self' ${serverUrl};`,
        ];
        callback({ responseHeaders: headers });
      },
    );

    win.once("ready-to-show", () => {
      if (process.env["NAUTILO_SMOKE_HIDDEN"] !== "1") win.show();
    });
    // P4.5 — navigation containment. The onboarding wizard is a
    // file:// SPA. It makes API fetches to serverUrl (allowed via
    // CSP override above), but those are XHR/fetch — not
    // will-navigate events. Top-level navigation has no legitimate
    // use; deny all and route http(s) clicks via shell.openExternal.
    attachNavigationGuards(win, {
      allowedOrigins: [],
      windowName: "onboarding",
    });

    void win.loadFile(path.join(__dirname, "onboarding", "index.html"));

    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      win.close();
      reject(new Error("Onboarding wizard cancelled"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const senderOk = (e: Electron.IpcMainInvokeEvent): boolean => {
      if (win.isDestroyed()) return false;
      return e.sender.id === win.webContents.id;
    };

    // ── Lifecycle handlers ─────────────────────────────────────────
    ipcMain.handle("onboarding:get-server-url", (e) => {
      if (!senderOk(e)) return "";
      return serverUrl;
    });
    ipcMain.handle("onboarding:complete", (e) => {
      if (!senderOk(e)) return;
      if (settled) return;
      settled = true;
      cleanup();
      win.close();
      resolve();
    });
    ipcMain.handle("onboarding:cancel", (e) => {
      if (!senderOk(e)) return;
      if (settled) return;
      settled = true;
      cleanup();
      win.close();
      reject(new Error("Onboarding wizard cancelled"));
    });

    // ── Hydration handlers ─────────────────────────────────────────
    ipcMain.handle("onboarding:load-existing-profile", async (e) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      try {
        const bearer = await getWizardBearer();
        if (!bearer) {
          const statusResp = await fetch(`${serverUrl}/api/profile/status`);
          if (!statusResp.ok) {
            return ipcErr(`GET /api/profile/status → ${statusResp.status}`);
          }
          const status = (await statusResp.json()) as {
            exists?: unknown;
            onboardingCompleted?: unknown;
          };
          if (status.exists !== true || status.onboardingCompleted !== true) {
            return ipcOk(null);
          }
          return ipcErr(
            "Existing profile requires sign-in. Open the wizard from Settings → Personalize your Genie after signing in.",
          );
        }

        const resp = await fetch(`${serverUrl}/api/profile`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        if (resp.status === 404) return ipcOk(null);
        if (!resp.ok) {
          return ipcErr(`GET /api/profile → ${resp.status}`);
        }
        const snapshot = agentEnvelopeToProfileSnapshot(await resp.json());
        if (!snapshot) return ipcOk(null);
        return ipcOk(
          await hydrateProfileAvatarPreview(snapshot, serverUrl, bearer),
        );
      } catch (err) {
        return ipcErr(err);
      }
    });
    ipcMain.handle("onboarding:get-config-flags", async (e) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      // The legacy wizard surfaced these via inline window globals baked into
      // index.html. Phase 2 promotes them to the canonical setup-flags endpoint.
      try {
        const setupResp = await fetch(`${serverUrl}/api/config/setup-flags`);
        const setupData = setupResp.ok
          ? ((await setupResp.json()) as Record<string, unknown>)
          : {};
        return ipcOk({
          avatarGenAvail: Boolean(setupData["avatarGenAvail"]),
          motherEasterEgg: Boolean(setupData["motherEasterEgg"]),
        });
      } catch {
        /* fall through */
      }
      return ipcOk({ avatarGenAvail: false, motherEasterEgg: false });
    });

    ipcMain.handle("onboarding:get-start-at", (e) => {
      if (!senderOk(e)) return null;
      return opts.startAt ?? null;
    });

    // ── API-proxy handlers ─────────────────────────────────────────
    ipcMain.handle("onboarding:get-voices", async (e) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      const bearer = await getWizardBearer();
      return proxyFetch(serverUrl, "/api/voices", { method: "GET" }, bearer);
    });
    ipcMain.handle(
      "onboarding:list-voice-catalog",
      async (e, query: unknown) => {
        if (!senderOk(e)) return ipcErr("sender mismatch");
        if (
          query !== undefined &&
          (typeof query !== "object" || query === null)
        ) {
          return ipcErr("list-voice-catalog query must be an object");
        }
        const bearer = await getWizardBearer();
        const qs = buildCatalogQueryString(query);
        return proxyFetch(
          serverUrl,
          `/api/voices/catalog${qs}`,
          { method: "GET" },
          bearer,
        );
      },
    );
    ipcMain.handle("onboarding:preview-voice", async (e, input: unknown) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      if (!input || typeof input !== "object")
        return ipcErr("preview-voice requires object");
      const { voiceId, displayName, text } = input as {
        voiceId?: unknown;
        displayName?: unknown;
        text?: unknown;
      };
      if (typeof voiceId !== "string")
        return ipcErr("voiceId must be a string");
      try {
        const bearer = await getWizardBearer();
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (bearer) headers["authorization"] = `Bearer ${bearer}`;
        const resp = await fetch(
          `${serverUrl}/api/voices/${encodeURIComponent(voiceId)}/preview`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({
              displayName,
              ...(typeof text === "string" && text.trim().length > 0
                ? { text: text.trim() }
                : {}),
            }),
          },
        );
        if (!resp.ok) {
          return ipcErr(
            `POST /api/voices/${voiceId}/preview → ${resp.status} ${resp.statusText}`,
          );
        }
        const bytes = Buffer.from(await resp.arrayBuffer());
        const previewDir = path.join(app.getPath("userData"), "voice-previews");
        await fsp.mkdir(previewDir, { recursive: true });
        const previewPath = path.join(
          previewDir,
          `${voiceId}-${Date.now()}-${randomBytes(4).toString("hex")}.mp3`,
        );
        await fsp.writeFile(previewPath, bytes);
        return ipcOk({
          audioUrl: pathToFileURL(previewPath).toString(),
        });
      } catch (err) {
        return ipcErr(err);
      }
    });
    ipcMain.handle("onboarding:generate-soul", async (e, input: unknown) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      const generationStartedAt = Date.now();
      console.log("[onboarding:soul] generation started");
      const sendSoulEvent = (event: SoulGenerationEvent): void => {
        if (win.isDestroyed()) return;
        win.webContents.send("onboarding:soul-generation-event", event);
      };
      try {
        const bearer = await getWizardBearer();
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (bearer) headers["authorization"] = `Bearer ${bearer}`;
        const resp = await fetch(
          `${serverUrl}/api/profile/generate-soul/stream`,
          {
            method: "POST",
            headers,
            body: JSON.stringify(input ?? {}),
          },
        );
        if (!resp.body) {
          return ipcErr(
            "POST /api/profile/generate-soul/stream returned no stream",
          );
        }
        if (!resp.ok) {
          const data = (await resp.json().catch(() => null)) as {
            error?: string;
          } | null;
          return ipcErr(data?.error ?? `${resp.status} ${resp.statusText}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finalSoulFile: string | null = null;
        const handleEvent = (
          eventName: string | null,
          dataText: string,
        ): IpcResult<never> | null => {
          const data = JSON.parse(dataText) as {
            text?: unknown;
            soulFile?: unknown;
            error?: unknown;
            fallback?: unknown;
          };
          if (eventName === "soul.started") {
            sendSoulEvent({ type: "started" });
            return null;
          }
          if (eventName === "soul.delta" && typeof data.text === "string") {
            sendSoulEvent({ type: "delta", text: data.text });
            return null;
          }
          if (
            eventName === "soul.completed" &&
            typeof data.soulFile === "string"
          ) {
            finalSoulFile = data.soulFile;
            sendSoulEvent({ type: "completed", soulFile: data.soulFile });
            return null;
          }
          if (eventName === "soul.error") {
            const error =
              typeof data.error === "string"
                ? data.error
                : "Soul generation failed.";
            const fallback =
              typeof data.fallback === "string" ? data.fallback : undefined;
            sendSoulEvent({
              type: "error",
              error,
              ...(fallback ? { fallback } : {}),
            });
            if (fallback) {
              finalSoulFile = fallback;
              return null;
            }
            return ipcErr(error);
          }
          return null;
        };

        for (;;) {
          const readResult = (await reader.read()) as Uint8StreamReadResult;
          if (readResult.done) break;
          buffer += decoder.decode(readResult.value, { stream: true });
          const { frames, remainder } = splitSseFrames(buffer);
          buffer = remainder;
          for (const parsed of parseSseEvents(frames)) {
            const maybeError = handleEvent(parsed.event, parsed.data);
            if (maybeError) return maybeError;
          }
        }
        if (buffer.trim()) {
          for (const parsed of parseSseEvents([buffer])) {
            const maybeError = handleEvent(parsed.event, parsed.data);
            if (maybeError) return maybeError;
          }
        }

        if (!finalSoulFile) {
          return ipcErr(
            "POST /api/profile/generate-soul/stream returned no final soul file",
          );
        }
        // First-run onboarding must never hold its final save screen open for
        // model latency. The renderer is allowed to close as soon as the
        // ordinary profile write finishes, so Desktop durably commits the soul
        // from this detached main-process request when generation completes.
        // A final profile write that omits `soulFile` preserves this result no
        // matter which request wins the insert/update race.
        const persistResp = await fetch(`${serverUrl}/api/profile`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ soulFile: finalSoulFile }),
        });
        if (!persistResp.ok) {
          console.warn(
            `[onboarding:soul] generated in ${Date.now() - generationStartedAt}ms but background persistence failed: ${persistResp.status}`,
          );
        } else {
          console.log(
            `[onboarding:soul] generated and persisted in ${Date.now() - generationStartedAt}ms`,
          );
        }
        return ipcOk({ soulFile: finalSoulFile });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.warn(
          `[onboarding:soul] generation failed after ${Date.now() - generationStartedAt}ms`,
        );
        sendSoulEvent({ type: "error", error });
        return ipcErr(err);
      }
    });
    ipcMain.handle("onboarding:generate-avatar", async (e, input: unknown) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      const sendAvatarEvent = (event: AvatarGenerationEvent): void => {
        if (win.isDestroyed()) return;
        win.webContents.send("onboarding:avatar-generation-event", event);
      };
      try {
        const bearer = await getWizardBearer();
        if (!bearer) return ipcErr("Sign in before generating an Agent photo");
        const body =
          input && typeof input === "object"
            ? (input as Record<string, unknown>)
            : {};
        const prompt =
          typeof body["prompt"] === "string" ? body["prompt"].trim() : "";
        if (!prompt) return ipcErr("Describe the Agent photo to generate");
        const client = new NautiloApiClient(serverUrl.replace(/\/$/, ""));
        client.setToken(bearer);
        const created = await client.generateAgentPhotoLibraryEntries(
          { prompt, count: 1 },
          {
            idempotencyKey: randomUUID(),
            origin: "desktop_wizard",
          },
        );
        const entry = created.entries[0];
        if (!entry) return ipcErr("Nautilo returned no generated Agent photo");
        // D487 media is authenticated. Never hand the renderer a protected
        // URL that an <img> request would fetch without the bearer.
        const media = await client.getAgentPhotoLibraryMedia(entry.id, "full");
        const mediaBytes = Buffer.from(await media.blob.arrayBuffer());
        const finalPayload = {
          target: { kind: "entry" as const, entryId: entry.id },
          avatarUrl: `data:${media.contentType};base64,${mediaBytes.toString("base64")}`,
        };
        sendAvatarEvent({ type: "completed", ...finalPayload });
        return ipcOk(finalPayload);
      } catch (err) {
        sendAvatarEvent({
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
        return ipcErr(err);
      }
    });
    ipcMain.handle("onboarding:put-profile", async (e, input: unknown) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      if (!input || typeof input !== "object")
        return ipcErr("put-profile requires object");
      const src = input as Record<string, unknown>;
      const body: Record<string, unknown> = { ...src };
      delete body["avatarUrl"];
      delete body["avatarTarget"];
      delete body["avatar"];
      const legacyVoiceId =
        typeof src["voiceId"] === "string" ? src["voiceId"] : null;
      const legacyVoiceName =
        typeof src["voiceName"] === "string" ? src["voiceName"] : null;
      delete body["voiceId"];
      delete body["voiceName"];
      const bearer = await getWizardBearer();
      const profileResult = await proxyFetch(
        serverUrl,
        "/api/profile",
        { method: "PUT", body: JSON.stringify(body) },
        bearer,
      );
      if (!profileResult.ok) return profileResult;
      const targetRaw = src["avatarTarget"];
      if (targetRaw && typeof targetRaw === "object") {
        if (!bearer) return ipcErr("Sign in before changing the Agent photo");
        const target = targetRaw as Record<string, unknown>;
        const selectionTarget =
          target["kind"] === "entry" && typeof target["entryId"] === "string"
            ? { kind: "entry" as const, entryId: target["entryId"] }
            : target["kind"] === "preset" &&
                typeof target["presetId"] === "string"
              ? { kind: "preset" as const, presetId: target["presetId"] }
              : null;
        if (!selectionTarget) return ipcErr("Invalid Agent photo selection");
        try {
          const client = new NautiloApiClient(serverUrl.replace(/\/$/, ""));
          client.setToken(bearer);
          const current = await client.getAgentPhotoLibraryCurrent();
          await client.selectAgentPhotoLibraryEntry(
            {
              target: selectionTarget,
              expectedSelectionRevision: current.scope.selectionRevision,
            },
            { idempotencyKey: randomUUID(), origin: "desktop_wizard" },
          );
        } catch {
          // The profile request above has already succeeded. A rejected or
          // interrupted photo-selection request may be a known failure or an
          // ambiguous write, so report the partial outcome without claiming
          // the selected photo is current.
          return ipcErr(PROFILE_SAVED_AVATAR_UNVERIFIED_ERROR);
        }
      }
      if (legacyVoiceId && legacyVoiceName) {
        const voiceResult = await proxyFetch(
          serverUrl,
          "/api/profile/voices/default",
          {
            method: "PUT",
            body: JSON.stringify({
              voiceId: legacyVoiceId,
              voiceName: legacyVoiceName,
            }),
          },
          bearer,
        );
        if (!voiceResult.ok) return voiceResult;
      }
      return profileResult;
    });

    ipcMain.handle("onboarding:upsert-voice", async (e, input: unknown) => {
      if (!senderOk(e)) return ipcErr("sender mismatch");
      if (!input || typeof input !== "object")
        return ipcErr("upsert-voice requires object");
      const src = input as Record<string, unknown>;
      const language =
        typeof src["language"] === "string" ? src["language"] : "";
      const ref = src["ref"];
      if (!language) return ipcErr("language is required");
      if (!ref || typeof ref !== "object") return ipcErr("ref is required");
      const r = ref as Record<string, unknown>;
      if (
        typeof r["voiceId"] !== "string" ||
        typeof r["voiceName"] !== "string"
      ) {
        return ipcErr("ref.voiceId and ref.voiceName must be strings");
      }
      const bearer = await getWizardBearer();
      return proxyFetch(
        serverUrl,
        `/api/profile/voices/${encodeURIComponent(language)}`,
        {
          method: "PUT",
          body: JSON.stringify({
            voiceId: r["voiceId"],
            voiceName: r["voiceName"],
          }),
        },
        bearer,
      );
    });

    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
      for (const ch of ONBOARDING_IPC_CHANNELS) {
        ipcMain.removeHandler(ch);
      }
    };

    win.on("closed", () => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error("Onboarding wizard closed without completing"));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Logging + crash reporting (D057 2a.6)
//
// Writes main-process logs to the platform-standard Electron location via
// electron-log:
//   macOS    ~/Library/Logs/Nautilo/main.log
//   Linux    ~/.config/Nautilo/logs/main.log
//   Windows  %USERPROFILE%\AppData\Roaming\Nautilo\logs\main.log
//
// Rotation at 5 MB → main.old.log, managed by electron-log. Uncaught JS
// exceptions + unhandled rejections are captured via log.errorHandler.
// Native (Chromium) crashes produce .dmp files in app.getPath("crashDumps")
// via Electron's crashReporter; the upload endpoint is a no-op placeholder
// until Phase 2b wires a real endpoint.
// ---------------------------------------------------------------------------

function setupLogging(): void {
  // D514 acceptance runs use a private tuple-scoped userData/log tree. Bind
  // electron-log before initialization so source/package smoke evidence never
  // reads from or appends to the installed app's shared macOS log.
  if (process.env["NAUTILO_SMOKE_HIDDEN"] === "1") {
    log.transports.file.resolvePathFn = () =>
      path.join(app.getPath("logs"), "main.log");
  }
  // log.initialize() registers ipcMain listeners so renderer-side
  // `electron-log/renderer` (if adopted later) can forward through the
  // same pipeline. Safe to call regardless of whether renderers opt in.
  log.initialize();

  log.transports.file.level = app.isPackaged ? "info" : "debug";
  log.transports.file.maxSize = LOG_MAX_SIZE_BYTES;
  // Keep stdout output in dev for developer convenience; silent in
  // packaged builds where there's no attached terminal to read anyway.
  log.transports.console.level = app.isPackaged ? false : "debug";

  // Re-route every existing console.log/warn/error/info/debug in
  // main.ts / server.ts / relay.ts through electron-log without having
  // to touch call sites. electron-log's `log.functions` provides
  // identical method names so this is a drop-in swap at runtime.
  Object.assign(console, log.functions);

  // Catch unhandled exceptions + promise rejections in main + renderer.
  // showDialog=false keeps the app running — Electron's default modal
  // would obscure the root cause rather than surface it in the log.
  log.errorHandler.startCatching({
    showDialog: false,
    onError: ({ error, errorName, processType }) => {
      log.error(`[${processType}] ${errorName}:`, error);
    },
  });

  log.info(
    `[desktop] logging ready — file: ${log.transports.file.getFile().path}, crashes: ${app.getPath("crashDumps")}`,
  );
}

// Forward renderer-side log calls through main (2a.6.3). The preload
// bridge exposes nautiloDesktop.logger.{info,warn,error} which maps to
// this IPC channel. Allowed levels come from `constants.ts` where
// the set is documented alongside the rest of the log configuration.
ipcMain.on("log", (_e, level: unknown, msg: unknown) => {
  if (typeof level !== "string" || !RENDERER_ALLOWED_LOG_LEVELS.has(level))
    return;
  if (typeof msg !== "string") return;
  // Cap at 4 KB so a runaway renderer can't fill the log.
  const safe = msg.length > 4096 ? `${msg.slice(0, 4096)}… [truncated]` : msg;
  const fn = log.functions[level as "info" | "warn" | "error"];
  if (typeof fn === "function") fn(`[renderer] ${safe}`);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function registerOnboardingOpenHandler(): void {
  if (onboardingOpenHandlerRegistered) return;

  ipcMain.handle(
    "onboarding:open",
    async (e, _rawToken: unknown, rawTheme: unknown, rawOptions: unknown) => {
      if (!mainWindow) return;
      if (serverSessions.getBySender(e.sender.id) !== serverSessions.active)
        return;
      const activeServerUrl = resolvedServerUrl();
      if (!activeServerUrl) {
        console.warn("[desktop] onboarding:open before serverUrl ready");
        return;
      }
      const themeSource: "light" | "dark" | null =
        rawTheme === "light" || rawTheme === "dark" ? rawTheme : null;
      const startAt: OnboardingStartAt | null =
        rawOptions != null && typeof rawOptions === "object"
          ? parseOnboardingStartAt(
              (rawOptions as { startAt?: unknown }).startAt,
            )
          : null;

      console.log(
        `[onboarding:open] themeSource=${themeSource ?? "system"} startAt=${startAt ?? "default"}`,
      );

      const previousThemeSource = nativeTheme.themeSource;
      if (themeSource !== null) nativeTheme.themeSource = themeSource;

      mainWindow.hide();
      try {
        await showOnboardingWizard(activeServerUrl, { startAt });
        console.log("[desktop] Re-triggered onboarding wizard complete");
      } catch (err) {
        console.warn("[desktop] Re-triggered wizard cancelled:", err);
      } finally {
        if (themeSource !== null) {
          nativeTheme.themeSource = previousThemeSource;
        }
        mainWindow?.show();
        sendToActiveRenderer("onboarding:completed");
      }
    },
  );
  onboardingOpenHandlerRegistered = true;
}

function queueInitialDeepLinksOnce(): void {
  if (initialDeepLinksQueued) return;
  for (const link of parseDeepLinksFromArgv(process.argv)) {
    pendingDeepLinks.push(link);
  }
  initialDeepLinksQueued = true;
}

function finishReleasedDesktopBoot(serverUrl: string): Promise<void> {
  if (releasedDesktopBootFinalizer) return releasedDesktopBootFinalizer;
  const finalizer = (async () => {
    // M161 Phase 3 — wire the registry's switch/add/close/list hooks to the
    // real Electron + relay + token-store + network surfaces, and bridge registry
    // `onChange` to every subscribed renderer. Done AFTER createWindow so
    // `createView` can attach child views to the host `BaseWindow`. The bridge is
    // idempotent (one registry listener).
    configureServerSessions();
    serverSessions.syncRendererActiveStates();
    if (!serverChangeBridgeWired) {
      serverChangeBridgeWired = true;
      serverSessions.onChange(() => {
        const activeSenderId = serverSessions.active?.view?.webContents.id;
        for (const [id, wc] of serverChangeSubscribers) {
          if (wc.isDestroyed()) {
            serverChangeSubscribers.delete(id);
            continue;
          }
          // Only the active server-selector UI needs this wake. Preserved
          // background renderers may read `servers:list`, but do not display it;
          // the switch lifecycle signal and this event can arrive in one turn.
          if (id !== activeSenderId) continue;
          try {
            wc.send("servers:changed");
          } catch {
            /* sender gone mid-emit — prune on the next pass */
            serverChangeSubscribers.delete(id);
          }
        }
      });
    }

    if (!tray) createTray();

    // Replace Electron's default menu with our native app menu.
    // Built AFTER createWindow so About/Services/close-window items can
    // address the real mainWindow. See electron/menu.ts.
    // rebuildApplicationMenu reads the current recent-current-folders
    // list so File → Recent Folders ▸ reflects persisted state from
    // the start.
    rebuildApplicationMenu();

    // Keep the gate at the lifecycle boundary: only an eligible packaged stable
    // build schedules a network check, and it starts the controller once.
    if (productionUpdaterFeedEnabled && !releasedDesktopBootUpdaterStarted) {
      releasedDesktopBootUpdaterStarted = true;
      updateController.startScheduling();
    }

    await bootRelayIfPossible(serverUrl);
    // Relay startup establishes the persisted trusted relay identity. Recover
    // committed editor-save batches now, even if no renderer save is made in
    // this process; unavailable identity simply leaves recovery fail-closed.
    void getDesktopDocumentMutationRuntime()
      ?.recoverAtStartup()
      .catch((error) => {
        console.warn(
          "[desktop] D448 startup editor mutation recovery deferred:",
          error,
        );
      });

    if (!releasedDesktopBootActivateHandlerRegistered) {
      app.on("activate", () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow(lastMainWindowLoadUrl);
        } else if (process.env["NAUTILO_SMOKE_HIDDEN"] !== "1") {
          mainWindow?.show();
          mainWindow?.focus();
        }
      });
      releasedDesktopBootActivateHandlerRegistered = true;
    }
  })();
  releasedDesktopBootFinalizer = finalizer;
  void finalizer.catch(() => {
    if (releasedDesktopBootFinalizer === finalizer) {
      releasedDesktopBootFinalizer = null;
    }
  });
  return finalizer;
}

async function boot(): Promise<void> {
  setupLogging();
  setupLocalCATrust();
  // Driver startup is automatic and non-polling. Permission prompts remain
  // owned by macOS/the Human; this readiness check never mutates the grant.
  void startComputerUseReadiness();

  // D079 Phase 1 — migrate on-disk persistence if legacy files exist.
  // Runs before any loadCurrentFolderPath / recent-folder read so the
  // migration completes transparently.
  migrateLegacyCurrentFolderFile();
  migrateLegacyRecentCurrentFolders();

  // Resolve the local work root before a renderer, relay, mutation runtime,
  // shell, ACP host, or Codex host can consume it. A valid prior selection
  // wins; every other ordinary state is repaired to Nautilo's safe default.
  const workingFolder = resolveWorkingFolderBootstrap(
    workingFolderBootstrapOptions(),
  );
  if (!workingFolder.ok) {
    log.error(
      `[desktop] unable to establish Working Folder during boot: ${workingFolder.reason}`,
    );
    dialog.showErrorBox(
      "Nautilo needs a Working Folder",
      "Nautilo could not create or use its local Working Folder. Check that your disk is available and writable, then reopen Nautilo.",
    );
    app.quit();
    return;
  }
  currentFolderPath = workingFolder.path;
  if (workingFolder.source !== "restored") {
    pushRecentCurrentFolder(workingFolder.path);
    log.info(`[desktop] Working Folder ${workingFolder.source}`);
  }

  // The durable document mutation runtime is allowed to initialize only after
  // the Working Folder invariant is established.
  void getDesktopDocumentMutationRuntime();

  // D079 Phase 3 — Genie's Workspace (Surface A) is always set once
  // this runs. First boot creates `~/Documents/Nautilo/` with starter
  // subdirs; subsequent boots honor any user-changed root. Must run
  // BEFORE the renderer mounts so `workspace:getRoot` returns a
  // meaningful value on first query.
  genieWorkspaceRoot = ensureDefaultGenieWorkspace();

  // D075 chunk 2 — prune recent-current-folders entries whose folders
  // no longer exist. Cheap (sync stats on ≤5 entries) and keeps the
  // dropdown / native menu honest on every boot.
  pruneMissingRecentCurrentFolders();

  const explicitServerUrl = process.env["NAUTILO_CONNECT_SERVER_URL"];
  const forceFirstRun = process.env["NAUTILO_FORCE_FIRST_RUN"] === "1";
  const preferPersistedConnection =
    process.env["NAUTILO_PREFER_PERSISTED_CONNECTION"] === "1";
  let serverUrl: string;
  let workbenchUrl: string;

  if (!app.isPackaged && !forceFirstRun && !preferPersistedConnection) {
    // M167 — dev-from-source: connect to the LOCAL server (single-origin),
    // or to an explicit override passed by dev-stack. No Vite dev server.
    sourceDevelopmentAuthority = null;
    serverUrl = explicitServerUrl ?? resolveDevServerUrl();
    workbenchUrl = serverUrl;
    setCurrentBootMode("local"); // dev keeps lenient (self-signed) cert policy
    console.log(`[desktop] Dev mode (single-origin) — server: ${serverUrl}`);
  } else if (explicitServerUrl && !forceFirstRun) {
    // Explicit URL override: useful for debugging against a staging or
    // remote server without going through the picker.
    serverUrl = explicitServerUrl;
    workbenchUrl = explicitServerUrl;
    setCurrentBootMode("connect"); // P4.6 — explicit remote URL → connect-strict
    console.log(`[desktop] SaaS mode — ${workbenchUrl}`);
  } else {
    // Packaged build, or NAUTILO_FORCE_FIRST_RUN=1: use persisted config
    // or run the picker. This is the "normal user" path.
    //
    // D134 — desktop is a connect-to-server client. The only valid
    // packaged-mode runtime is `connect`. Stale configs that still
    // record `mode: "local"` (from the deprecated bundled-server
    // path) are treated as "no config" so the user is re-prompted.
    let cfg: DesktopConfig | null = forceFirstRun ? null : loadConfig();
    if (cfg && cfg.mode !== "connect") {
      console.warn(
        `[desktop] Discarding stale config (mode="${String((cfg as { mode: string }).mode)}"); D134 retired non-connect packaged modes — re-running picker`,
      );
      cfg = null;
    }
    if (!cfg) {
      console.log("[desktop] First-run picker");
      try {
        // An interrupted initial attempt restores only its editable target.
        // Force-first-run is an explicit fresh journey and never inherits it.
        const connected = await showFirstRunPicker({
          suggestedUrl: forceFirstRun ? null : initialPrecommitPickerSuggestion(),
        });
        if (!connected?.ok) {
          console.error("[desktop] First-run picker cancelled");
          app.quit();
          return;
        }
        // The connection flow atomically committed URL + authority marker.
        // Re-read that durable authority; never promote a bare picker value.
        cfg = loadConfig();
        if (!cfg) throw new Error("committed first-run authority is unavailable");
      } catch (err) {
        console.error("[desktop] First-run picker cancelled or errored:", err);
        app.quit();
        return;
      }
    }

    setCurrentBootMode(cfg.mode); // P4.6 — gate cert-error policy on resolved mode

    if (cfg.mode === "connect") {
      if (!cfg.serverUrl) {
        console.error("[desktop] Connect mode config has no serverUrl");
        app.quit();
        return;
      }
      // A markerless legacy pairing may still route below an origin. Stamp
      // only a revision/attempt guard before *any* journal or network work;
      // its fingerprint intentionally remains null until a fresh proof.
      if (!projectActiveAuthority(cfg)) {
        cfg = configForLegacyConnectionGuard(cfg);
        saveConfig(cfg);
      }
      const configuredServerUrl = cfg.serverUrl;
      if (!configuredServerUrl) throw new Error("active connect config lost serverUrl");
      serverUrl = configuredServerUrl;
      workbenchUrl = configuredServerUrl;
      console.log(`[desktop] Connect mode — ${workbenchUrl}`);
    } else {
      // D134 — `local` is retired (bundled-server detour); `cloud` is
      // a future hosted-trust mode not yet wired. Both should have
      // been filtered out above; reach this only on a logic bug.
      console.error(
        `[desktop] Unsupported mode "${String((cfg as { mode: string }).mode)}" — D134 desktop client supports only mode="connect"`,
      );
      app.quit();
      return;
    }
  }

  // M161 Phase 1 — route the existing single-server boot through one
  // registry session before auth state or renderer construction.
  const bootSession = serverSessions.ensure(serverUrl);
  serverUrl = bootSession.serverUrl;
  if (!app.isPackaged && !forceFirstRun) {
    installSourceDevelopmentAuthority(bootSession.serverUrl);
  }
  // The server switcher is durable membership, not a capped suggestion list.
  // Persist the configured boot target so it remains available until Forget.
  pushRecentServer({ url: serverUrl });

  // M161 Phase 3.2 — one-time boot migration: fold the legacy
  // `paired-server-identity.json` fingerprint onto the recent-server
  // entry matching the active server URL (only if that entry has no
  // fingerprint yet), then unlink the legacy file. Idempotent +
  // non-destructive: a re-run never overwrites an existing fingerprint
  // and never touches non-matching entries. If no matching recent entry
  // exists, the legacy file is retained for old-boot compatibility.
  // Verified Logto projection never recreates it: after a successful fold,
  // schema-v2 recent fingerprints are the sole authority.
  migratePairedServerIdentityToFingerprint(serverUrl, {
    readIdentity: readPairedServerIdentity,
    unlink: () => {
      try {
        fs.unlinkSync(pairedServerIdentityPath());
      } catch {
        /* legacy file already gone — migration is still done */
      }
    },
  });

  // D514 — paint the local, default-deny bootstrap before any setup, health,
  // profile, onboarding, or relay network work. The renderer remains local
  // until the continuation releases an exact verified Workbench origin.
  coldBootBootstrapReady = false;
  verifiedWorkbenchOrigin = null;
  verifiedBootstrapRelease = null;
  connectBootstrapEntryHref = pathToFileURL(
    path.join(__dirname, "bootstrap.html"),
  ).href;
  const bootstrapEntryHref = connectBootstrapEntryHref;
  lastMainWindowLoadUrl = bootstrapEntryHref;
  const initiateLocalShell = () => {
    if (mainWindow && !mainWindow.isDestroyed()) return;
    createWindow(lastMainWindowLoadUrl);
    rebuildApplicationMenu();
  };
  if (connectionPendingStore().load().disposition === "blocked-legacy-handoff") {
    blockedLegacyHandoff = true;
    initiateLocalShell();
    shellStateOnBoot = "disconnected";
    coldBootBootstrapReady = true;
    await loadActiveRenderer(bootstrapEntryHref);
    return;
  }
  committedColdBootTerminal = prepareProductionCommittedColdBootTerminal(
    bootSession.scope,
    initiateLocalShell,
  );
  if (committedColdBootTerminal) {
    await committedColdBootTerminal.launch();
    return;
  }
  activePrecommitColdBootTerminal = prepareProductionActivePrecommitColdBootTerminal();
  if (activePrecommitColdBootTerminal) {
    const outcome = await activePrecommitColdBootTerminal.launch();
    activePrecommitColdBootTerminal = null;
    if (outcome.kind === "candidate") {
      // The retained flow already proved B's readiness, health, identity,
      // setup, auth discovery, and candidate navigation. Continue the
      // ordinary boot tail with exactly that private cohort, never a probe.
      serverUrl = outcome.cohort.url;
      workbenchUrl = outcome.cohort.url;
      initialConnectionCohort = { url: outcome.cohort.url, verified: outcome.cohort };
      bootSetupStatus = outcome.cohort.setup.raw as SetupStatusResponse;
    }
  }
  let launchConnectionCohort = initialConnectionCohort?.url === new URL(serverUrl).origin
    ? initialConnectionCohort
    : null;
  const initialColdBootObservation = launchConnectionCohort
    ? (() => {
        // Connect already proved readiness, health, identity, setup, auth, and
        // candidate navigation. Paint the ordinary local shell, then reuse the
        // exact facts; a second launch probe is the bounce bug D514 removes.
        initiateLocalShell();
        coldBootLifecycle = "resuming";
        bootSetupStatus = launchConnectionCohort.verified.setup.raw as SetupStatusResponse;
        return projectVerifiedConnectionCohort(launchConnectionCohort);
      })()
    : await runColdBootLaunchGate({
        createLocalShell: () => {
          initiateLocalShell();
        },
        observe: () => observeColdBootConnection(serverUrl),
        isLive: (observation) => observation.kind === "live",
        projectRecovery: async () => {
          coldBootBootstrapReady = true;
          await loadActiveRenderer(bootstrapEntryHref);
        },
        waitForRecoveryContinuation: () => new Promise<void>((resolve) => {
          coldBootRecoveryContinue = resolve;
        }),
        currentObservation: () => initializeColdBootObservationAuthority().snapshot(),
        setLifecycle: (state) => {
          coldBootLifecycle = state;
        },
      });

  if (recoveryReplacementCohort) {
    launchConnectionCohort = recoveryReplacementCohort;
    recoveryReplacementCohort = null;
    serverUrl = launchConnectionCohort.url;
    workbenchUrl = launchConnectionCohort.url;
    bootSetupStatus = launchConnectionCohort.verified.setup.raw as SetupStatusResponse;
  }

  // <D154-connect-bootstrap-preflight>
  if (!launchConnectionCohort) await loadBootSetupStatus(serverUrl);
  if (initialColdBootObservation.kind === "live") {
    const hadLogtoBeforeResolution = logtoConfig() !== null;
    const logtoResolved = applyVerifiedLogtoHealthBody(
      serverUrl,
      initialColdBootObservation.healthBody,
      {
        trustObservedFingerprint: shouldTrustExplicitDevLoopbackServer({
          isPackaged: app.isPackaged,
          explicitServerUrl,
          resolvedServerUrl: serverUrl,
        }),
      },
    );
    logColdBootDiagnostic({
      generation: initialColdBootObservation.generation,
      phase: "auth",
      category: logtoResolved ? "auth-resolved" : "auth-unresolved",
      durationMs: 0,
      acceptedGeneration: true,
      stateChanged: hadLogtoBeforeResolution !== (logtoConfig() !== null),
    });
  }
  // </D154-connect-bootstrap-preflight>

  // M055 — silent refresh on boot if tokens are persisted but the
  // access token is close to expiry. Avoids an unnecessary AuthGate
  // auto-redirect on relaunch when the user comes back after >55min.
  if (logtoConfig()) {
    const bundle = loadTokens();
    if (bundle) {
      if (isAccessTokenExpiring(bundle)) {
        const refreshed = await refreshTokens();
        setSignedIn(refreshed !== null);
        if (!refreshed) {
          onLogtoRefreshFailed();
        }
      } else {
        setSignedIn(true);
      }
    }
  }

  // D091 — server-state probe + onboarding gate.
  //
  // D112 — `probeServerState` reads cached `GET /api/setup/status`.
  // shouldShowOnboarding uses the same cache plus /api/profile/status.
  //
  // Cancel paths:
  //   - User closes the wizard window → reject in showOnboardingWizard →
  //     we catch, log, app.quit(). Matches first-run cancel semantics.
  //   - Profile endpoint unreachable → shouldShowOnboarding returns
  //     false → we skip the wizard. The workbench surfaces the
  //     connectivity issue via its own error path.
  const serverState = probeServerState(serverUrl);
  // D103 P4c — exhaustive switch on all 4 ServerClaimState values.
  // Adding a new state to the union fails compilation at `_exhaustive`
  // until this branch is updated.
  switch (serverState) {
    case "ready":
    case "authenticated":
      break;
    case "unclaimed":
    case "invite-pending":
      console.log(`[desktop] D092 state "${serverState}" — no-op stub`);
      break;
    default: {
      const _exhaustive: never = serverState;
      console.log(
        `[desktop] Unhandled ServerClaimState: ${String(_exhaustive)}`,
      );
      break;
    }
  }

  if (logtoConfig() && await shouldShowOnboarding(serverUrl)) {
    if (!loadTokens()) {
      console.log(
        "[desktop] M072 — Logto sign-in required before onboarding wizard",
      );
      const signInRes = await handleSignIn();
      if (!signInRes.ok) {
        await dialog.showMessageBox({
          type: "error",
          title: "Sign in required",
          message: "Finish signing in before setting up your Genie.",
          detail: signInRes.error ?? "Unknown error",
          buttons: ["OK"],
        });
        app.quit();
        return;
      }
    }
    console.log("[desktop] Opening onboarding wizard");
    try {
      await showOnboardingWizard(serverUrl);
      console.log("[desktop] Onboarding wizard complete");
    } catch (err) {
      console.error("[desktop] Onboarding wizard cancelled or errored:", err);
      app.quit();
      return;
    }
  }

  registerOnboardingOpenHandler();

  // The verified main-owned observation is the only authority allowed to
  // release remote navigation. Bootstrap reload then projects live/recovery.
  queueInitialDeepLinksOnce();
  if (!releaseVerifiedWorkbenchNavigation(serverUrl)) return;
  coldBootLifecycle = "complete";
  // Establish the authenticated relay/runtime before asking the local shell
  // to hand navigation to Workbench.  The bootstrap page can replace its own
  // navigation as soon as the origin is released; on Chromium that can leave
  // the initiating loadURL promise pending even though the remote page is
  // already visible.  Relay boot must not sit behind that renderer lifecycle
  // race or an authenticated cold boot renders a usable-looking shell with no
  // Desktop origin and no owned-Genie projection.
  await finishReleasedDesktopBoot(serverUrl);
  await loadActiveRenderer(bootstrapEntryHref);
}

// D103 P3.7 — About-this-app dialog metadata. macOS reads
// `setAboutPanelOptions` for the system About menu item; Linux uses
// the same call. Windows ignores it (Windows uses Info.plist-equivalent
// resource fields via electron-builder.yml). Wired before `boot()` so
// the menu item is populated even if boot() fails.
app.setAboutPanelOptions({
  applicationName: "Nautilo",
  applicationVersion: nautiloAppVersion(),
  copyright: "Copyright © 2026 Nautilo",
  iconPath: path.join(__dirname, "../assets/icon.png"),
});

void app.whenReady().then(() => {
  registerMediaProxySession(session.defaultSession);
  registerRemoteControlPowerMonitor();
  void boot();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// Development orchestrators and service managers terminate Electron with an
// OS signal. Route the first ordinary termination request through Electron's
// awaited `before-quit` teardown instead of letting Node exit immediately;
// otherwise ACP process groups can outlive the desktop generation that owns
// them. A second signal retains the platform's normal hard-stop escape hatch
// because these are one-shot handlers.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => app.quit());
}

function resumeQuitAfterPersistence(): void {
  app.quit();
}

app.on("before-quit", (event) => {
  if (quitTeardownComplete) return;
  event.preventDefault();
  if (!quitPersistencePrepared) {
    if (quitPreparationStarted) return;
    quitPreparationStarted = true;
    void prepareRegisteredRenderersForQuit().then((ready) => {
      quitPreparationStarted = false;
      if (!ready) return;
      quitPersistencePrepared = true;
      resumeQuitAfterPersistence();
    }).catch((err: unknown) => {
      quitPreparationStarted = false;
      log.warn(`[desktop][lifecycle] quit preparation failed: ${String(err)}`);
    });
    return;
  }
  isQuitting = true;
  if (quitTeardownStarted) return;
  quitTeardownStarted = true;
  desktopDocumentMutationRuntime?.stopOutboxPump();
  invalidatePendingDocumentMutationAcks();
  clearInterval(binaryReadSessionExpiryTimer);
  disposeBinaryReadSenderBindings();
  const mediaProxyTeardown = disposeMediaProxySenders();
  updateController.dispose();
  unregisterRemoteControlPowerMonitor();
  remoteControlKeepAwakePolicy = "off";
  reconcileRemoteControlKeepAwake({ appShuttingDown: true });
  cleanupFsWatchers();
  disposeAllTerminals();
  githubCliConnection.cancel();
  workstationShellHost.dispose();
  void (async () => {
    try {
      await binaryReadSessions.closeAll();
    } catch (err) {
      log.warn(`[desktop][lifecycle] failed to close binary reads during quit: ${String(err)}`);
    }
    // Let the relay deliver its final disconnect before permanently closing
    // the retained optional host. The one-time gate keeps Electron alive
    // until both awaited stages finish, then the second quit is admitted.
    try {
      await mediaProxyTeardown;
    } catch (err) {
      log.warn(`[desktop][d385] failed to dispose media proxies during quit: ${String(err)}`);
    }
    try {
      await stopRelay();
    } catch (err) {
      log.warn(
        `[desktop][d453] failed to stop relay during quit: ${String(err)}`,
      );
    }
    try {
      await browserResearchTargetManager?.disposeAll();
    } catch (err) {
      log.warn(
        `[browser-research] failed to dispose research target during quit: ${String(err)}`,
      );
    }
    await disposeAllForegroundShadowControllers();
    try {
      await codexConnection.shutdown();
    } catch (err) {
      log.warn(
        `[desktop][d453] failed to shut down Codex during quit: ${String(err)}`,
      );
    }
    try {
      await computerUseHostBroker.close();
    } catch (err) {
      log.warn(
        `[desktop][d516] failed to close Computer Use Host during quit: ${String(err)}`,
      );
    }
    // D418 — best-effort deactivation of the active Workstation Profile on
    // quit so ephemeral grants are explicitly revoked before process exit.
    try {
      await activeWorkstationProfileController.deactivate();
    } catch (err) {
      log.warn(
        `[desktop][d418] failed to deactivate active profile during quit: ${String(err)}`,
      );
    } finally {
      quitTeardownComplete = true;
      app.quit();
    }
  })();
});

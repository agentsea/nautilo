/**
 * Desktop detection utility. Available as window.nautiloDesktop when running
 * inside the Electron shell. Undefined in the browser.
 *
 * Usage:
 *   import { isDesktop, desktopAPI } from "../lib/desktop";
 *   if (isDesktop) { const status = await desktopAPI!.relayStatus.get(); }
 */

import type { FsDirectoryChangedEvent } from "./fs-directory-changed";
import type { ConnectionPresentation as DesktopConnectionPresentation } from "../../../desktop/electron/connection-presentation";
import type {
  DesktopFilesystemAccessOperation,
  DesktopFilesystemGrant,
  DesktopFilesystemGrantFilesystemIdentity,
  DesktopFilesystemGrantLifetime,
} from "@nautilo/desktop-filesystem-grants";
import type {
  ProfileCapabilityBackend,
  ProfileDiscoveryProvider,
  ProfileNetworkMode,
} from "@nautilo/workstation-profiles";
import type {
  AnchoredTextPatch,
  DocumentVersion,
  HumanEditLeaseStoreResult,
  RegisterHumanEditLeaseRequest,
  ReleaseHumanEditLeaseRequest,
  RenewHumanEditLeaseRequest,
  UpdateHumanEditLeaseRequest,
  InitiatingClientSurfaceV1,
  LiveShadowMessageRealtimeEventV1,
  FullEncryptionMessageRealtimeContentEventV2,
} from "@nautilo/types";
import type { AtomicDocumentMutationEventBatch } from "@nautilo/document-mutations";
import type {
  DeviceAdmissionChallengeDto,
  DeviceAdmissionProofRequest,
  MessageBackfillUrgentSelection,
  NautiloApiClient,
} from "@nautilo/api-client/browser";
import type { MessagePayloadV2 } from "@nautilo/lattice-bridge";
import type {
  AuthorizedHumanMemoryClient,
  BrowserRoomHistoryShadowAcknowledgementInput,
  HumanPeerLiveShadowReceiveResult,
  ProtectedRoomAccessStateV2,
  SharedAgentLiveShadowReceiveResult,
  VaultLiveShadowReceiveResult,
  VaultRoomHistoryShadowReadInputV1,
  VaultRoomHistoryShadowReadResultV1,
} from "@nautilo/lattice-bridge/client/browser";
import type {
  WorkbenchProtectedMemory,
  WorkbenchProtectedMemorySearchResult,
} from "./protected-human-memory-controller";
import type {
  ReadyToWorkAggregateStatus,
  ReadyToWorkSelection,
} from "../../../desktop/electron/ready-to-work-contract";
import type {
  MiniAppRecoveryOpenInput,
  MiniAppRecoveryReadResult,
  MiniAppRecoveryWriteInput,
} from "../../../desktop/electron/mini-app-draft-recovery-contract";

/** D057 2a.5 — mirror of the main-process MicStatus union. */
export type MicStatus =
  "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** D516 — renderer-safe, reusable macOS system-permission contract. */
export type DesktopSystemPermissionId =
  | "accessibility"
  | "screen-recording"
  | "microphone";
export type DesktopSystemPermissionState =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown"
  | "unsupported";
export type DesktopSystemPermissionAction = "request" | "open-settings" | null;
export type DesktopSystemPermissionRestart = "not-required" | "required";
export type DesktopSystemPermissionFeature = "computer-use" | "voice";

export interface DesktopSystemPermission {
  id: DesktopSystemPermissionId;
  label: string;
  reason: string;
  requiredFor: readonly DesktopSystemPermissionFeature[];
  state: DesktopSystemPermissionState;
  action: DesktopSystemPermissionAction;
  restart: DesktopSystemPermissionRestart;
}

export interface DesktopSystemPermissionsSnapshot {
  version: 1;
  platform: "macos" | "other";
  permissions: readonly DesktopSystemPermission[];
}

export interface DesktopSystemPermissionsOnboardingPreference {
  version: 1;
  showAutomatically: boolean;
}

/** Optional on older Desktop builds; feature-detect before use. */
export interface DesktopSystemPermissionsAPI {
  status: () => Promise<DesktopSystemPermissionsSnapshot>;
  resolve: (id: DesktopSystemPermissionId) => Promise<DesktopSystemPermissionsSnapshot>;
  /** Restarts the packaged Desktop after a typed restart-required transition. */
  restart: () => Promise<void>;
  onStatusChanged: (callback: (snapshot: DesktopSystemPermissionsSnapshot) => void) => () => void;
  onboardingPreference?: () => Promise<DesktopSystemPermissionsOnboardingPreference>;
  setOnboardingPreference?: (showAutomatically: boolean) => Promise<DesktopSystemPermissionsOnboardingPreference>;
  onOnboardingPreferenceChanged?: (callback: (preference: DesktopSystemPermissionsOnboardingPreference) => void) => () => void;
  requestGuidedSetup?: () => Promise<void>;
  onGuidedSetupRequested?: (callback: () => void) => () => void;
}

/** D458 Wave 7 — safe desktop pairing data; contains no relay credential. */
export interface DesktopRemoteControlReadiness {
  relayReady: boolean;
  relayStatus: string;
  keepAwakeEnabled: boolean;
  keepAwakePolicy: "off" | "while_remote_enabled_and_on_external_power";
  keepAwakeSupported: boolean;
  macosLidClosedGuidance: string | null;
}

export interface DesktopRemotePairingChallenge {
  deepLink: string;
  challengeId: string;
  ceremonyContext: string;
  qrSecret: string;
  manualCode: string;
  expiresAt: string;
}

export interface DesktopRemoteController {
  bindingId: string;
  remoteHostId: string;
  installationId: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string | null;
}

export type DesktopEncryptionRecoveryReadiness =
  | {
    status: "active";
    encryptionSetup?:
      | "device_active"
      | "human_domain_active"
      | "v2_personal_authority_ready";
    continuationReason?:
      | "device_unavailable"
      | "existing_domain_requires_delivery"
      | "multiple_active_devices_require_fanout"
      | "stale_identity";
    pendingAdditionalDevices?: readonly Readonly<{
      operationId: string;
      deviceId: string;
      clientKind: "browser" | "electron";
      verificationCode?: string;
      progress: "approval_required" | "transfer_ready" | "awaiting_target";
    }>[];
  }
  | { status: "setup_required" | "setup_pending" }
  | {
    status: "additional_device_required";
    enrollmentStatus?: "required" | "waiting_for_approval" | "syncing";
    syncReason?: "delivery_pending" | "current_domain_sync_required"
      | "personal_authority_required";
    operationId?: string;
    verificationCode?: string;
  }
  | { status: "reset_required"; reason: "server_identity_missing" }
  | {
    status: "recovery_required";
    reason: "stale_device" | "removed_device";
  }
  | {
    status: "unavailable";
    reason: "identity_invalid" | "custody_unavailable" | "custody_conflict";
  };

export interface DesktopEncryptionDeviceRoster {
  formatVersion: 1;
  currentDeviceId: string;
  currentMemberCount: number;
  devices: readonly Readonly<{
    deviceId: string;
    clientKind: "browser" | "electron" | "tui";
    deviceGeneration: number;
    deviceRevision: number;
    membershipState: "pending" | "welcome_pending" | "catching_up"
      | "current" | "stale" | "removed";
    isCurrentDevice: boolean;
    canRemove: boolean;
    publicFingerprintBase64url: string;
    membershipEvidence: {
      lineageGeneration: number;
      epoch: number;
      securityRevision: number;
      acknowledgedSequence: number;
      headDigestBase64url: string;
    } | null;
    admissionEvidence: {
      lastProvedAt: number;
      expiresAt: number;
    } | null;
    domainKeyCoverage: {
      acknowledged: number;
      required: number;
    };
    deliveryEvidence: {
      acknowledgedSequence: number;
      highWatermark: number;
      blocked: {
        sequence: number;
        operationId: string;
        at: number;
        reason: string;
      } | null;
    };
    createdAt: number;
    lastSeenAt: number | null;
    revokedAt: number | null;
  }>[];
}

export interface DesktopRecoveryKitPresentation {
  presentationId: string;
  documentHeader: string;
  mnemonic: string;
}

export interface DesktopEncryptionRecoveryAPI {
  inspect(): Promise<DesktopEncryptionRecoveryReadiness>;
  deviceAdmissionDeviceId(): Promise<string | null>;
  signDeviceAdmissionChallenge(
    challenge: DeviceAdmissionChallengeDto,
  ): Promise<DeviceAdmissionProofRequest["proof"]>;
  resetLocalSetup(): Promise<DesktopEncryptionRecoveryReadiness>;
  continueAdditionalDevice(): Promise<DesktopEncryptionRecoveryReadiness>;
  approveAdditionalDevice(operationId: string, verificationCode: string):
    Promise<DesktopEncryptionRecoveryReadiness>;
  advanceAdditionalDevice(operationId: string):
    Promise<DesktopEncryptionRecoveryReadiness>;
  listEncryptionDevices(): Promise<DesktopEncryptionDeviceRoster>;
  removeEncryptionDevice(deviceId: string, pin: string):
    Promise<DesktopEncryptionRecoveryReadiness>;
  recoverEncryptionDevice(mnemonic: string):
    Promise<DesktopEncryptionRecoveryReadiness>;
  reconnectEncryptionDevice(): Promise<DesktopEncryptionRecoveryReadiness>;
  setup(): Promise<DesktopEncryptionRecoveryReadiness>;
  resolvePresentation(input: Readonly<{
    presentationId: string;
    status: "confirmed" | "cancelled";
  }>): Promise<void>;
  onPresentation(listener: (value: DesktopRecoveryKitPresentation) => void):
    () => void;
}

/** M300 PR 1 — content-free readiness for main-owned foreground crypto. */
export type DesktopForegroundShadowInspection =
  | Readonly<{ status: "ready"; deviceId: string }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "session_unavailable"
        | "identity_unavailable"
        | "not_enrolled"
        | "secure_storage_unavailable"
        | "custody_locked"
        | "custody_corrupt"
        | "storage_lost"
        | "unsupported";
    }>;

export type DesktopForegroundShadowReceiveInput =
  | Readonly<{
      kind: "standard";
      event: LiveShadowMessageRealtimeEventV1 | FullEncryptionMessageRealtimeContentEventV2;
    }>
  | Readonly<{
      kind: "human_peer";
      event: LiveShadowMessageRealtimeEventV1 | FullEncryptionMessageRealtimeContentEventV2;
      ordinarySibling?: MessagePayloadV2;
    }>
  | Readonly<{
      kind: "shared_agent";
      event: LiveShadowMessageRealtimeEventV1 | FullEncryptionMessageRealtimeContentEventV2;
      ordinarySibling?: MessagePayloadV2;
    }>
  | Readonly<{
      kind: "shared_agent_output";
      event: LiveShadowMessageRealtimeEventV1 | FullEncryptionMessageRealtimeContentEventV2;
    }>;

export type DesktopForegroundShadowReceiveResult =
  | Readonly<{
      kind: "standard" | "shared_agent_output";
      result: VaultLiveShadowReceiveResult | null;
    }>
  | Readonly<{
      kind: "human_peer";
      result: HumanPeerLiveShadowReceiveResult | null;
    }>
  | Readonly<{
      kind: "shared_agent";
      result: SharedAgentLiveShadowReceiveResult | null;
    }>;

export interface DesktopForegroundShadowAPI {
  inspect(): Promise<DesktopForegroundShadowInspection>;
  send(
    roomId: string,
    body: Parameters<NautiloApiClient["sendRoomMessage"]>[1],
  ): ReturnType<NautiloApiClient["sendRoomMessage"]>;
  /** Older shells fail closed in Full rather than sending an ordinary edit. */
  edit?(
    roomId: string,
    messageId: string,
    body: Readonly<{ content: string; expectedRevision: number }>,
  ): Promise<Readonly<{ content: string; editRevision: number }>>;
  recoverPending(): Promise<number>;
  /** Added after initial foreground Shadow support; feature-detect older shells. */
  recoverRoomPendingAttention?(input: Readonly<{
    roomId: string;
    clientActionSessionId: string;
  }>): Promise<import("@nautilo/api-client/browser").RoomPendingAttentionRecoveryResponse>;
  memory: {
    list(options?: Readonly<{
      cursor?: string; limit?: number; includeArchive?: boolean;
      room?: string; person?: string; audience?: "private";
    }>): Promise<Readonly<{
      items: readonly WorkbenchProtectedMemory[];
      nextCursor: string | null;
      memoryMode: "namespace" | "scope";
      total?: number;
    }>>;
    search(options: Readonly<{
      q: string; mode: "text" | "semantic"; limit?: number;
      includeArchive?: boolean;
    }>): Promise<Readonly<{
      items: readonly WorkbenchProtectedMemorySearchResult[];
      memoryMode: "namespace" | "scope";
      queryDisclosure: "embedding_provider";
    }>>;
    detail(memoryId: string): Promise<Readonly<{
      memory: WorkbenchProtectedMemory;
      memoryMode: "namespace" | "scope";
      actionAuthority: Readonly<{
        canEdit: boolean; canArchive: boolean; canManageAccess: boolean;
      }>;
    }>>;
    update(input: Readonly<{
      memoryId: string; type: string; content: string; importance: number;
    }>): Promise<Readonly<{
      status: "published" | "replayed";
      memoryId: string;
      memory: WorkbenchProtectedMemory;
      followUpPending?: true;
    }> | Extract<Awaited<ReturnType<AuthorizedHumanMemoryClient["update"]>>,
      { status: "ordinary_fallback" }>>;
    retryPendingMutations(): Promise<number>;
    archive(memoryId: string): Promise<Readonly<{
      status: "archived" | "replayed"; memoryId: string; tier: 3;
    }>>;
    restore(memoryId: string): Promise<Readonly<{
      status: "restored" | "replayed"; memoryId: string;
      previousTier: 3; nextTier: 1 | 2;
    }>>;
    transitionTier(memoryId: string, action: "promote" | "demote"): Promise<Readonly<{
      status: "promoted" | "demoted" | "replayed"; memoryId: string;
      previousTier: 1 | 2; nextTier: 1 | 2 | 3;
    }>>;
    deleteAuthorizedView: AuthorizedHumanMemoryClient["deleteAuthorizedView"];
    grantUser: AuthorizedHumanMemoryClient["grantUser"];
    revokeUser: AuthorizedHumanMemoryClient["revokeUser"];
    makePrivate: AuthorizedHumanMemoryClient["makePrivate"];
  };
  authorize(event: LiveShadowMessageRealtimeEventV1): Promise<boolean>;
  receive(
    input: DesktopForegroundShadowReceiveInput,
  ): Promise<DesktopForegroundShadowReceiveResult>;
  synchronizeRecipients(
    roomId: string,
    namespaceId: string,
    keyClass?: "human" | "ai",
  ): Promise<boolean>;
  /** Added after initial foreground Shadow support; feature-detect older shells. */
  serviceDomainKeyBacklog?(): Promise<boolean>;
  /** Services durable device-mediated work inside main-owned custody. */
  serviceBackgroundAuthorization?(): Promise<void>;
  /** One main-owned, content-free repair batch; added after initial support. */
  serviceMessageBackfill(
    urgent?: MessageBackfillUrgentSelection,
  ): Promise<Readonly<{
    state: "more" | "waiting" | "caught_up";
    resumeAt: number | null;
    reconciled?: true;
    reconciledSelection?: MessageBackfillUrgentSelection;
    resolvedSelection?: MessageBackfillUrgentSelection;
  }>>;
  /** Cancels only this renderer sender's current repair batch. */
  cancelMessageBackfill(): Promise<void>;
  /** Added after the foreground Shadow namespace; feature-detect on older shells. */
  onProtectedRoomAccessState?(
    listener: (state: ProtectedRoomAccessStateV2) => void,
  ): () => void;
  history: {
    reconcile(input: Readonly<{
      readerInput: VaultRoomHistoryShadowReadInputV1;
      acknowledgement: Omit<
        BrowserRoomHistoryShadowAcknowledgementInput,
        "result"
      >;
    }>): Promise<VaultRoomHistoryShadowReadResultV1>;
  };
}

/** Main-owned pairing and wake-lock lifecycle; optional for older desktops. */
export interface DesktopRemoteControlAPI {
  getReadiness: () => Promise<DesktopRemoteControlReadiness>;
  setKeepAwakePolicy: (
    policy: DesktopRemoteControlReadiness["keepAwakePolicy"],
  ) => Promise<{ ok: boolean; enabled: boolean; policy: string }>;
  createChallenge: () => Promise<DesktopRemotePairingChallenge>;
  listControllers: () => Promise<{ controllers: DesktopRemoteController[] }>;
  renameController: (bindingId: string, label: string) => Promise<{ ok: true }>;
  revokeController: (bindingId: string) => Promise<{ ok: true }>;
}

/** D418 — renderer-safe result returned by the desktop grant bridge. */
export type DesktopFilesystemGrantsIpcFailureCode =
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  | "invalid_grant"
  | "grant_not_found"
  | "invalid_root"
  | "root_missing"
  | "root_symlink"
  | "root_not_directory"
  | "root_identity_changed"
  | "invalid_request"
  | "identity_unavailable"
  | "subject_mismatch"
  | "platform_authorization_unsupported";

export type DesktopFilesystemGrantsIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: DesktopFilesystemGrantsIpcFailureCode; message: string };

export interface DesktopListedDesktopFilesystemGrant {
  grant: DesktopFilesystemGrant;
  status: "active" | "revoked" | "expired";
}

/** Renderer-provided facts from the immediately preceding validation step. */
export interface DesktopFilesystemGrantCreateRequest {
  canonicalRoot: string;
  filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
  access: readonly DesktopFilesystemAccessOperation[];
  lifetime: DesktopFilesystemGrantLifetime;
}

/**
 * D418 — narrow human grant-management surface. This deliberately exposes no
 * general local filesystem read/browse operation.
 */
export interface DesktopFilesystemGrantsAPI {
  pick: () => Promise<string | null>;
  validate: (path: string) => Promise<
    DesktopFilesystemGrantsIpcResult<{
      canonicalRoot: string;
      filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
    }>
  >;
  create: (
    request: DesktopFilesystemGrantCreateRequest,
  ) => Promise<
    DesktopFilesystemGrantsIpcResult<{
      grant: DesktopFilesystemGrant;
      revision: number;
    }>
  >;
  list: (opts?: {
    includeHistory?: boolean;
  }) => Promise<
    DesktopFilesystemGrantsIpcResult<{
      grants: DesktopListedDesktopFilesystemGrant[];
      revision: number;
    }>
  >;
  revoke: (
    grantId: string,
  ) => Promise<
    DesktopFilesystemGrantsIpcResult<{
      grant: DesktopFilesystemGrant;
      revision: number;
    }>
  >;
}

/**
 * D418 — Workstation Profile review / activation-preparation bridge result
 * codes. Mirrors the preload/main contract. None of these surfaces accept
 * renderer-supplied roots, env, executables, or discovered facts.
 */
export type WorkstationProfileIpcFailureCode =
  | "invalid_request"
  | "seed_invalid"
  | "discovery_failed"
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  // D418 — profile-selector activation seam failures.
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

export type WorkstationProfileIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: WorkstationProfileIpcFailureCode; message: string };

/** Redacted capability entry shared across profile summary / seed shapes. */
export interface DesktopWorkstationProfileCapabilityEntry {
  id: string;
  backend: ProfileCapabilityBackend;
}

/**
 * D418 — redacted Developer Workstation seed descriptor. Carries identity +
 * bounded env-key NAMES (never values) + capability ids/backends + discovery
 * providers. Root paths, executable paths, and env values never cross here.
 */
export interface DesktopWorkstationProfileSeedDescriptor {
  id: string;
  revision: number;
  name: string;
  protectedPolicyVersion: number;
  networkMode: ProfileNetworkMode;
  discoveryProviders: readonly ProfileDiscoveryProvider[];
  environmentKeys: readonly string[];
  capabilities: readonly DesktopWorkstationProfileCapabilityEntry[];
}

/** D418 — redacted stored-profile summary (no roots, no executables, no env values). */
export interface DesktopWorkstationProfileSummary {
  id: string;
  revision: number;
  name: string;
  protectedPolicyVersion: number;
  networkMode: ProfileNetworkMode;
  capabilities: readonly DesktopWorkstationProfileCapabilityEntry[];
  createdAt: string;
  updatedAt: string;
}

/** D418 — redacted active-profile summary. Omits subject + grantIds. */
export interface DesktopActiveWorkstationProfileSummary {
  profileId: string;
  profileRevision: number;
  protectedPolicyVersion: number;
  networkMode: ProfileNetworkMode;
  capabilities: readonly DesktopWorkstationProfileCapabilityEntry[];
  compiledAt: string;
}

/** D418 C4 — redacted server-authoritative Workstation session selectors. */
export interface DesktopWorkstationServerSessionSummary {
  profileId: string;
  profileRevision: number;
}

/**
 * A failed status read is explicitly not a confirmation. Consumers must show
 * Ready, never On, unless `confirmed` is true and the selectors match local
 * active state.
 */
export interface DesktopWorkstationServerSessionStatus {
  confirmed: boolean;
  session: DesktopWorkstationServerSessionSummary | null;
}

/** D418 — seed identity carried alongside an advisory discovery review. */
export interface DesktopWorkstationProfileSeedIdentity {
  id: string;
  revision: number;
  protectedPolicyVersion: number;
}

export type DesktopWorkstationDiscoveryRowStatus =
  "found" | "missing" | "optional";

/** D418 — a single advisory discovery review row (mirrors main-side review). */
export interface DesktopWorkstationDiscoveryRow {
  tool: string;
  capabilityId?: string;
  provider?: ProfileDiscoveryProvider;
  status: DesktopWorkstationDiscoveryRowStatus;
  origin?: "fixed_argv" | "well_known_path" | "existing_config";
  executable?: string;
  version?: string;
  roots?: readonly string[];
  environmentKeys?: readonly string[];
  backend?: ProfileCapabilityBackend;
  note?: string;
}

/** D418 — human-readable advisory discovery review model. */
export interface DesktopWorkstationDiscoveryReview {
  generatedAt: string;
  platform: string;
  home: string;
  networkMode: ProfileNetworkMode;
  rows: readonly DesktopWorkstationDiscoveryRow[];
  hostNetworkImplication: string;
  hardBoundaries: readonly string[];
  summary: { found: number; optional: number; missing: number };
}

/**
 * D418 — narrow Workstation Profile review / activation-preparation surface.
 * Every method is read-only or advisory-only and takes NO renderer-supplied
 * roots, env, executables, or discovered facts. Electron main materializes
 * the seed and runs discovery itself. This surface never activates a profile,
 * never creates/updates a stored profile, never grants roots, and never calls
 * the server activation route.
 */
export interface DesktopWorkstationProfilesAPI {
  getSeedDescriptor: () => Promise<
    WorkstationProfileIpcResult<DesktopWorkstationProfileSeedDescriptor>
  >;
  runDiscoveryReview: () => Promise<
    WorkstationProfileIpcResult<{
      review: DesktopWorkstationDiscoveryReview;
      seedIdentity: DesktopWorkstationProfileSeedIdentity;
    }>
  >;
  listProfiles: () => Promise<
    WorkstationProfileIpcResult<{
      profiles: DesktopWorkstationProfileSummary[];
      revision: number;
    }>
  >;
  getActiveProfileSummary: () => Promise<
    WorkstationProfileIpcResult<DesktopActiveWorkstationProfileSummary | null>
  >;
  /**
   * Narrow activation-preparation IPC: main materializes the seed + runs
   * discovery and returns review facts + seed identity only. Does NOT activate.
   */
  prepareActivation: () => Promise<
    WorkstationProfileIpcResult<{
      seed: DesktopWorkstationProfileSeedDescriptor;
      review: DesktopWorkstationDiscoveryReview;
    }>
  >;
  /**
   * D418 — idempotently persist the shipped Developer Workstation seed into
   * this instance's profile store if it is absent. A profile is admin
   * configuration, never authority by itself: this creates no grants and
   * compiles nothing. Main materializes the seed itself; the renderer supplies
   * no profile payload. Returns the redacted stored summary, whether the seed
   * was newly created, and the store envelope revision.
   */
  materializeSeedProfile: () => Promise<
    WorkstationProfileIpcResult<{
      profile: DesktopWorkstationProfileSummary;
      created: boolean;
      revision: number;
    }>
  >;
  /**
   * D418 — revoke the active profile session's policy-pack grants and drop the
   * binding. Authority-reducing only; adds no authority. `cleared` is 0 and
   * `skipped` is empty when no profile was active (benign no-op).
   */
  deactivateActiveProfile: () => Promise<
    WorkstationProfileIpcResult<{ cleared: number; skipped: readonly string[] }>
  >;
  /**
   * D418 — select + activate an EXISTING stored Workstation Profile. The
   * renderer supplies ONLY the selected profile's id + exact revision + the
   * activating user's OWN fresh PIN; Electron main verifies the stored
   * revision, posts the selectors + relay binding evidence + PIN to the
   * authoritative server `/api/workstation-access/activate-profile` route
   * (which enforces the `use_workstation` capability gate (B3 —
   * D418 Commit 1: `control_desktop` is no longer required for activation)
   * + the user's OWN PIN proof + the authoritative relay binding), and ONLY on a 200 server proof success compiles the stored
   * profile into live policy-pack / session authority and re-advertises the
   * relay's redacted profile snapshot. The renderer never supplies roots,
   * env, executable rules, grants, subject identity, or a profile payload.
   * No offline admin PIN is required or accepted.
   */
  selectActiveProfile: (input: {
    profileId: string;
    profileRevision: number;
    pin: string;
  }) => Promise<
    WorkstationProfileIpcResult<{
      summary: DesktopActiveWorkstationProfileSummary;
      outcome: string;
    }>
  >;
  /** Read-only server session confirmation; never decides runtime authority. */
  getServerSessionStatus: () => Promise<DesktopWorkstationServerSessionStatus>;
}

/**
 * D538 — server-confirmed, process-local permission for one exact Desktop
 * session. `confirmed:false` is deliberately presentation-unavailable, never
 * evidence that uncontained commands are active.
 */
export interface DesktopUncontainedHostCommandsAPI {
  getStatus: () => Promise<{
    confirmed: boolean;
    active: boolean;
    eligible: boolean;
    reason: string | null;
    activatedAt: string | null;
  }>;
  activate: (input: { pin: string }) => Promise<
    { ok: true } | { ok: false; message: string; retryAfterMs?: number }
  >;
  disable: () => Promise<{ ok: true } | { ok: false; message: string }>;
}

/**
 * D057 2a.4 — native menu actions the renderer can react to. Kept in
 * lock-step with apps/desktop/electron/menu.ts MenuAction.
 */
export type MenuAction =
  | "new-chat"
  | "new-window"
  | "open-settings"
  | "speak"
  | "report-issue"
  // D077 — panel toggles wired through the native View menu so
  // keyboard shortcuts (⌘⇧B / ⌘⇧I) work identically to the existing
  // "speak" / "open-settings" flow.
  | "toggle-browser-column"
  | "toggle-context-panel"
  // D076 Chunk 4 — navigation rail toggle (⌘⇧0).
  | "toggle-nav-rail"
  // M055 — Account → Manage devices… (no-op until M056).
  | "open-account-devices"
  | "open-change-pin"
  | "open-restore-pin";
// Note: "change-workspace" was a MenuAction under 2a.7 but D075 chunk 2
// moved the File menu's folder actions to main-process-direct handlers
// (createApplicationMenu options), so no renderer dispatch is involved.
// D079 Phase 1 renamed the push event to `currentFolder:pathChanged`.

/**
 * D079 Phase 1 — shape of the current-folder namespace exposed by the
 * preload bridge. The old `workspace` namespace is retained as a
 * deprecated alias (preload-side) but new renderer code should use
 * `currentFolder`.
 */
interface CurrentFolderAPI {
  getPath: () => Promise<string | null>;
  /** Electron-owned Current Folder plus the persisted relay identity. */
  getContext?: () => Promise<{
    currentFolder: string | null;
    relayId: string | null;
  }>;
  /** D075 chunk 2 — commit a Recent entry (already-validated path). */
  setPath: (p: string) => Promise<void>;
  /** D075 chunk 2 — pick + validate + commit in one round-trip.
   *  Returns committed path, null if cancelled, throws on bad path. */
  pickAndCommit: () => Promise<string | null>;
  /** D075 chunk 2 — recent-current-folders list, most-recent first. */
  listRecent: () => Promise<string[]>;
  /** D075 — pre-commit validator for edge paths. */
  validate: (
    p: string,
  ) => Promise<{ ok: true; resolved: string } | { ok: false; reason: string }>;
  /** D075 chunk 2 — push notification on any current-folder commit. */
  onPathChanged: (handler: (path: string) => void) => () => void;
}

/**
 * D079 Phase 3 — Genie's Workspace (Surface A) namespace. This commit
 * ships only the read-only `getRoot`. Follow-ups add `setRoot`,
 * `pickAndSetRoot`, `revealInFinder`, `listRecent`, `onRootChanged`.
 * Kept deliberately narrow so consumers don't come to depend on APIs
 * that aren't there yet.
 */
interface GenieWorkspaceAPI {
  getRoot: () => Promise<string | null>;
}

export interface DesktopAuthIdentityEnvelope {
  instanceId: string;
  serverUrl: string;
  logtoEndpoint: string;
  workbenchAppId: string;
}

export type DesktopAuthIssue = {
  kind: "scope-mismatch";
  expected: DesktopAuthIdentityEnvelope;
  disk: DesktopAuthIdentityEnvelope | null;
} | null;

export type DesktopAuthNotice = {
  kind: "env-pinned-auth-cleared";
  expected: DesktopAuthIdentityEnvelope;
  disk: DesktopAuthIdentityEnvelope | null;
} | null;

/**
 * M055 — Logto auth namespace exposed by the Electron preload
 * bridge. The renderer's `useAuth()` Electron branch (the swap
 * for M054's `ELECTRON_STUB`) reads through this surface.
 */
interface DesktopAuthAPI {
  isAuthenticated: () => Promise<boolean>;
  getIssue: () => Promise<DesktopAuthIssue>;
  consumeNotice?: () => Promise<DesktopAuthNotice>;
  getAccessToken: () => Promise<string | null>;
  signIn: (
    opts?: {
      extraParams?: Record<string, string>;
      theme?: "light" | "dark" | null;
    },
  ) => Promise<{ ok: boolean; error?: string }>;
  signOut: () => Promise<void>;
  stepUp: (opts?: {
    maxAgeSeconds?: number;
  }) => Promise<
    { accessToken: string; issuedAt: number } | { error: "cancelled" }
  >;
  reprobeServer: () => Promise<
    | { ok: true; hasLogto: boolean }
    | { ok: false; hasLogto: false; reason: string }
  >;
  /** M101 Phase 4 — Logto Account Center in the embedded auth window. */
  openAccountPage: (
    path: "/account" | "/account/password",
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** M106 — open an operator-pasted Logto password-reset URL in the embedded auth window. */
  openResetUrl: (
    url: string,
  ) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Returns an unsubscribe fn for React useEffect cleanup. */
  onStateChange: (
    cb: (event: { state: "signed-in" | "signed-out" }) => void,
  ) => () => void;
}

/** M101 Phase 3 — payload from `nautilo://` custom-protocol links. */
export type DesktopDeepLink = {
  kind: "invite" | "reset-password" | "account";
  payload: Record<string, string>;
};

export interface DesktopDeepLinkAPI {
  onReceived: (cb: (link: DesktopDeepLink) => void) => () => void;
}

/**
 * D154 — cold-boot shell classification from Electron bootstrap (preload).
 * Mirrors `ShellStateOnBoot` in `apps/desktop/electron/preload.ts`.
 */
export type ShellStateOnBoot =
  "live" | "disconnected" | "wrong-server" | "no-pairing";

/**
 * D154 — async cold-boot / picker IPC surface (preload). Optional on
 * `NautiloDesktopAPI` for browser dev and older packaged desktops.
 */
export type { DesktopConnectionPresentation };

/** M123 — entry in `~/.nautilo/recent-servers.json`. */
export interface RecentServerEntry {
  url: string;
  displayName?: string;
  lastUsedAt: string;
}

/**
 * M161 Phase 3 — enriched entry returned by `servers:list`. Merges recent
 * + live sessions with public `/api/setup/status` profile metadata +
 * connection state. `active` / `signedIn` come from the live session.
 */
export interface DesktopServerListEntry {
  url: string;
  name?: string;
  description?: string;
  iconUrl: string;
  connection: "connecting" | "live" | "offline" | "incompatible";
  active: boolean;
  signedIn: boolean;
  notificationSummary:
    | {
        state: "fresh" | "stale";
        unreadCount: number;
        importantUnreadCount: number;
      }
    | { state: "unknown" };
}

export interface DesktopServerListResult {
  servers: DesktopServerListEntry[];
  aggregate: {
    unreadCount: number;
    importantUnreadCount: number;
    unavailableServerCount: number;
  };
}

/** Typed fail-closed result from an in-process server switch. */
export type DesktopServerSwitchResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "unknown-server"
        | "offline"
        | "incompatible"
        | "stale"
        | "identity-changed-again"
        | "invalid-target"
        | "fingerprint-storage-failed";
    }
  | { ok: false; reason: "promotion-failed"; authoritativePairingChanged: false | true | "unknown" }
  | { ok: false; reason: "wrong-server"; decisionId: string };

/** Result of “Connect to server…” — success, cancel, or switch failure. */
export type DesktopServerAddResult =
  | { ok: true; url: string }
  | {
      ok: false;
      reason:
        | "cancelled"
        | "unknown-server"
        | "offline"
        | "incompatible"
        | "stale"
        | "identity-changed-again"
        | "invalid-target"
        | "fingerprint-storage-failed";
    }
  | { ok: false; reason: "promotion-failed"; authoritativePairingChanged: false | true | "unknown" }
  | { ok: false; reason: "wrong-server" };

/** Result of the destructive per-server Forget action. */
export type DesktopServerForgetResult =
  | { ok: true; fallbackFailed: boolean; landedEmpty: boolean }
  | {
      ok: false;
      reason:
        | "invalid-url"
        | "unknown-server"
        | "partition-clear-failed"
        | "config-clear-failed";
    };

/**
 * M123 / Stack 39 Phase 3E + M161 Phase 3 — desktop server switcher IPC
 * surface. `openPicker` (legacy/recovery) relaunches on commit; the
 * Phase 3 `list` / `switchTo` / `add` / `close` / `onChanged` surface
 * switches in-process without relaunch. Optional on older packaged
 * builds until preload ships the namespace.
 */
export interface DesktopServersAPI {
  openPicker: () => Promise<void>;
  listRecent?: () => Promise<RecentServerEntry[]>;
  /**
   * M161 Phase 3 — enriched list and explicit profile refresh seam.
   * Phase 4 consumption: call on panel open, every 15 seconds while the
   * panel remains open, and after `onChanged`. Main re-fetches public
   * setup status on every call and emits `onChanged` only when fetched
   * live-session state actually differs. There is no spontaneous server
   * profile push in Phase 3.
   */
  list?: () => Promise<DesktopServerListResult>;
  onConnectionPresentation?: (cb: (snapshot: DesktopConnectionPresentation) => void) => () => void;
  /** M161 Phase 3 — in-process switch to an existing session. */
  switchTo?: (
    url: string,
    theme?: "light" | "dark" | null,
  ) => Promise<DesktopServerSwitchResult>;
  acceptIdentity?: (decisionId: string) => Promise<
    | { ok: true }
    | { ok: false; reason: "stale" | "offline" | "incompatible" | "identity-changed-again" | "promotion-failed" }
  >;
  /** M161 Phase 3 — “Connect to server…” picker (no relaunch). */
  add?: (theme?: "light" | "dark" | null) => Promise<DesktopServerAddResult>;
  /** M161 Phase 3 — destroy a session's view (keeps recents + tokens). */
  close?: (url: string) => Promise<DesktopServerSwitchResult>;
  /** M161 Phase 6.5 — erase a server and all trusted aliases/scoped state. */
  forget?: (url: string) => Promise<DesktopServerForgetResult>;
  /** M161 Phase 3 — subscribe to switch/add/close/profile/connection changes. */
  onChanged?: (cb: () => void) => () => void;
  /**
   * Phase 4 router contract. Subscribe while the Workbench shell is
   * mounted; on emission, route to Home (`/`) without reloading.
   */
  onNavigateHome?: (cb: () => void) => () => void;
}

/**
 * Renderer-safe main-owned lifecycle state. `active: false` means this
 * preserved background session must not invoke active-only desktop IPC.
 */
export interface DesktopActiveSessionAPI {
  onStateChange: (cb: (state: { active: boolean }) => void) => () => void;
}

export interface BrowserControlSnapshot {
  appId: string;
  mode: "app" | "browser";
  partition: string;
  url: string;
  cdpUrl: string | null;
}

export interface DesktopBrowserControlAPI {
  /** Mount and show the embedded Browser when a relay browser_open arrives cold. */
  onOpenRequested: (cb: (evt: { url: string }) => void) => () => void;
  attachWebview: (args: {
    appId: string;
    mode?: "app" | "browser";
    partition: string;
    url: string;
    webContentsId: number;
  }) => Promise<BrowserControlSnapshot | null>;
  detachWebview: (args: { appId: string }) => Promise<boolean>;
  setActive: (args: {
    appId: string;
  }) => Promise<BrowserControlSnapshot | null>;
  getViews: () => Promise<BrowserControlSnapshot[]>;
  /** D368 Wave 2 — open the current embedded page in the OS default browser. */
  openExternal: (args: { url: string }) => Promise<void>;
  /**
   * D368 Wave 2 — embedded-browser download completion pushes (auto-saved to
   * the OS Downloads dir by main). Returns an unsubscribe fn.
   */
  onDownload: (cb: (evt: BrowserDownloadEvent) => void) => () => void;
}

export type DesktopBrowserResearchActionResult =
  { ok: true } | { ok: false; reason: "unavailable" | "stale" };

export interface DesktopBrowserResearchAPI {
  present: (id: string) => Promise<DesktopBrowserResearchActionResult>;
  attachSurface: (
    id: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) => Promise<boolean>;
  detachSurface: (id: string) => Promise<boolean>;
  alternate: (id: string) => Promise<DesktopBrowserResearchActionResult>;
  cancel: (id: string) => Promise<DesktopBrowserResearchActionResult>;
  getActiveIntervention: () => Promise<DesktopBrowserResearchIntervention | null>;
  onIntervention: (
    handler: (intervention: DesktopBrowserResearchIntervention) => void,
  ) => () => void;
  onPresentRequested: (
    handler: (intervention: DesktopBrowserResearchIntervention) => void,
  ) => () => void;
  onSurfaceClosed: (handler: (payload: { id: string }) => void) => () => void;
  onVerificationCleared: (
    handler: (payload: { id: string }) => void,
  ) => () => void;
}

export interface DesktopBrowserResearchIntervention {
  id: string;
  toolCallId: string;
  laneKey: string;
  turnId?: string;
  authorAgentId?: string;
  state: "awaiting_choice";
  host: string;
  reason: "human-verification";
  expiresAt: string;
}

/** D368 Wave 2 — a completed/failed embedded-browser download. */
export interface BrowserDownloadEvent {
  /** Electron DownloadItem final state: "completed" | "cancelled" | "interrupted". */
  state: string;
  filename: string;
  savePath: string;
}

/**
 * D403 (ISSUE-D403) P3 — embedded-browser password save/autofill bridge types.
 *
 * SECURITY (R6): mirrors the main-process contract in
 * `apps/desktop/electron/passwords/types.ts`. Kept structurally identical but
 * declared here because the renderer can't import electron-side types. NO shape
 * on this surface carries a raw password — the plaintext lives only in main and
 * flows guest ⇄ main, never through this (host renderer) bridge.
 */

/** A single lookup hit — id + username ONLY, never the password. */
export interface PasswordLookupMatch {
  id: string;
  username: string;
}

export interface PasswordLookupResult {
  matches: PasswordLookupMatch[];
}

/**
 * main → host: a credential is staged and awaits the human (no password).
 * Keyed by ORIGIN so the offer survives the post-submit navigation.
 */
export interface PasswordPendingSaveNotice {
  origin: string;
  username: string;
  /** "new" = no stored match; "update" = same user, different password. */
  kind: "new" | "update";
}

/** Field-shape-only description of a detected login form (no values). */
export interface DetectedLoginFormShape {
  formId: string;
  passwordFieldId: string;
  usernameFieldId?: string;
  frameOrigin: string;
}

/** main → host: a login form was detected in a guest webContents. */
export interface PasswordFormDetectedNotice {
  webContentsId: number;
  form: DetectedLoginFormShape;
}

/** Result of a side-effecting host→main command that returns no secret. */
export interface PasswordActionResult {
  ok: boolean;
}

/**
 * D403 P3 — human-only save/autofill bridge (host renderer only). Optional on
 * `NautiloDesktopAPI`: absent in the browser and on pre-D403 desktop builds.
 */
export interface DesktopPasswordsAPI {
  /** Look up saved matches for an origin (id + username only). */
  lookup: (origin: string) => Promise<PasswordLookupResult>;
  /** Persist the credential staged for an origin. */
  commitSave: (origin: string) => Promise<PasswordActionResult>;
  /** Discard the credential staged for an origin. */
  dismissSave: (origin: string) => Promise<PasswordActionResult>;
  /** Ask main to deliver a matched secret straight to the guest (no secret returned). */
  applyFill: (args: {
    webContentsId: number;
    id: string;
  }) => Promise<PasswordActionResult>;
  /** Subscribe to detected-form notices. Returns an unsubscribe fn. */
  onFormDetected: (
    cb: (notice: PasswordFormDetectedNotice) => void,
  ) => () => void;
  /**
   * Pull the last detected login form for a guest (race-proof autofill on
   * attach — the one-shot `onFormDetected` push can fire before this panel
   * subscribes on a cold start). Null if none/guest gone.
   */
  getDetectedForm: (
    webContentsId: number,
  ) => Promise<DetectedLoginFormShape | null>;
  /** Subscribe to pending-save notices. Returns an unsubscribe fn. */
  onPendingSave: (
    cb: (notice: PasswordPendingSaveNotice) => void,
  ) => () => void;
}

export type ToolRuntimeName = "agent-browser" | "gog";

export interface ToolRuntimeStatus {
  tool: ToolRuntimeName;
  configuredPath: string | null;
  resolvedPath: string | null;
  source:
    "configured" | "bundled" | "app-managed" | "common" | "path" | "env" | null;
  version: string | null;
  health:
    | "unknown"
    | "healthy"
    | "missing"
    | "not-runnable"
    | "auth-missing"
    | "auth-healthy";
  authHealthy?: boolean;
  checkedAt: string;
}

export interface DesktopToolRuntimesAPI {
  getStatus: () => Promise<Record<ToolRuntimeName, ToolRuntimeStatus>>;
  refresh: () => Promise<Record<ToolRuntimeName, ToolRuntimeStatus>>;
  setPath: (
    tool: ToolRuntimeName,
    runtimePath: string,
  ) => Promise<
    { ok: true; status: ToolRuntimeStatus } | { ok: false; reason: string }
  >;
  clearPath: (
    tool: ToolRuntimeName,
  ) => Promise<
    { ok: true; status: ToolRuntimeStatus } | { ok: false; reason: string }
  >;
}

export interface GoogleWorkspaceAuthStatus {
  clientConfigOnServer: boolean;
  clientConfigLocal: boolean;
  connectedAccounts: string[];
  healthy: boolean;
  reason?: string;
}

/** M196 — Google Workspace OAuth connect flow (preload + main IPC). */
export interface DesktopGoogleWorkspaceAPI {
  authStatus: () => Promise<GoogleWorkspaceAuthStatus>;
  connect: (args: {
    email: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
  disconnect: (args: {
    email: string;
  }) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

/** M180 — desktop jailed fs write result (preload + main IPC). */
export type FsWriteFileResult =
  | { ok: true; sha256: string; size: number }
  | {
      ok: false;
      code: "forbidden" | "conflict" | "too_large" | "error";
      currentSha256?: string;
      message?: string;
    };

/** D448 correlation values only; main derives all Desktop authority itself. */
export type DesktopEditorSaveWriteOptions = {
  baseSha256?: string | null;
  checkpoint?: boolean;
  requestId?: string;
  clientMutationId?: string;
  anchoredPatch?: AnchoredTextPatch;
  baseVersion?: DocumentVersion;
};

/** D357 Phase 3 — desktop jailed fs.mkdir result (preload + main IPC). */
export type FsMkdirResult =
  | { ok: true }
  | {
      ok: false;
      code: "exists" | "forbidden" | "error";
      message?: string;
    };

/** D357 Phase 3 — desktop jailed fs.rename result (preload + main IPC). */
export type FsRenameResult =
  | { ok: true }
  | {
      ok: false;
      code: "exists" | "forbidden" | "error";
      message?: string;
    };

/** D357 — desktop jailed move-to-OS-trash result (recoverable delete). */
export type FsTrashResult =
  | { ok: true }
  | {
      ok: false;
      code: "forbidden" | "error";
      message?: string;
    };

/** P2.2b — single-writer input-lock owner. */
export type TerminalController = "user" | "agent";

/** Result of a terminal write, gated by the P2.2b single-writer lock. */
export type TerminalWriteResult =
  { ok: true } | { ok: false; reason: "no-session" | "locked" };

/** D373 / Stack 137 — PTY session info returned by the terminal bridge. */
export interface TerminalSessionInfo {
  id: string;
  title: string;
  cwd: string;
  /** True for sandbox-wrapped (agent-grantable) sessions; false for the user's real shell. */
  sandboxed: boolean;
  /** Current input-lock owner (P2.2b). */
  controller: TerminalController;
  /** P2.2b — the agent tried to write while the user holds the lock (pending request). */
  requested: boolean;
  /** D438 — main-owned per-PTY consent: true once the user has explicitly
   *  handed this one PTY to Genie. Survives retake for the PTY's lifetime;
   *  not durable (cleared when the PTY exits or Electron main quits). */
  agentControlConsented: boolean;
}

/**
 * D373 — terminal (PTY) work surface bridge. Optional on
 * `NautiloDesktopAPI`: absent in the browser and on older desktop builds,
 * so the terminal surface/launcher must feature-detect before use.
 */
export interface DesktopTerminalAPI {
  create: (opts?: {
    cwd?: string;
    cols?: number;
    rows?: number;
    shell?: string;
  }) => Promise<TerminalSessionInfo>;
  /** Reattach to a live session; returns its buffered scrollback, or ok:false if gone. */
  attach: (
    sessionId: string,
  ) => Promise<
    { ok: true; info: TerminalSessionInfo; scrollback: string } | { ok: false }
  >;
  write: (sessionId: string, data: string) => Promise<TerminalWriteResult>;
  /** P2.2b — transfer the input lock ("Take control" → user, "Let agent drive" → agent).
   *  May consume existing per-PTY consent but cannot mint it; refuses
   *  `controller="agent"` for an unsandboxed, unconsented session. */
  setController: (
    sessionId: string,
    controller: TerminalController,
  ) => Promise<boolean>;
  /** D438 — explicit, active-sender-validated grant: records per-PTY consent
   *  and transfers control to Genie atomically. The only consent-minting
   *  operation; the one to call from the first-handoff confirmation. Returns
   *  `false` if the session is gone. */
  grantAgentControl: (sessionId: string) => Promise<boolean>;
  /** P2.2b — dismiss a pending agent control request without handing over. */
  clearRequest: (sessionId: string) => Promise<boolean>;
  resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
  kill: (sessionId: string) => Promise<void>;
  list: () => Promise<TerminalSessionInfo[]>;
  /** Streamed PTY output. Returns an unsubscribe fn. */
  onData: (
    handler: (evt: { sessionId: string; chunk: string }) => void,
  ) => () => void;
  /** PTY exit lifecycle. Returns an unsubscribe fn. */
  onExit: (
    handler: (evt: { sessionId: string; exitCode: number }) => void,
  ) => () => void;
  /** D373 P2.2b — input-lock owner changed. Returns an unsubscribe fn. */
  onController: (
    handler: (evt: {
      sessionId: string;
      controller: TerminalController;
    }) => void,
  ) => () => void;
  /** D373 P2.2b — agent control request raised/cleared. Returns an unsubscribe fn. */
  onRequest: (
    handler: (evt: { sessionId: string; requested: boolean }) => void,
  ) => () => void;
}

export interface DesktopColdBootAPI {
  getBootstrapContext: () => Promise<{
    serverUrl: string | null;
    expectedServerFingerprint?: string | null;
    pairedServerIdentity: string | null;
  }>;
  setShellStateOnBoot: (state: ShellStateOnBoot) => Promise<void>;
  retry: () => Promise<void>;
  pairToDifferentServer: () => Promise<void>;
  useThisServerAnyway: () => Promise<void>;
  quit: () => Promise<void>;
}

/** Reloads the Workbench renderer without clearing desktop authentication. */
export interface DesktopWorkbenchAPI {
  reload: () => Promise<void>;
  /** Await every registered editor's durable save/recovery boundary before native quit. */
  onPrepareQuit?: (
    handler: (cancellation: {
      isCancelled: () => boolean;
      onCancelled: (handler: () => void) => () => void;
    }) => { ready: boolean; errorMessage?: string | null } |
      Promise<{ ready: boolean; errorMessage?: string | null }>,
  ) => () => void;
  /** Main-owned host-window focus; renderer focus is unreliable across macOS Spaces. */
  isWindowFocused?: () => boolean;
  onWindowFocusChanged?: (handler: (focused: boolean) => void) => () => void;
}

/**
 * D423 4.1.3 — persisted Electron relay identity exposed to the Workbench
 * renderer. The renderer reads the relay id that the desktop relay registered
 * at startup; it NEVER generates or accepts a renderer-supplied replacement.
 * `null` when the relay has not been started (the local-file focus ref then
 * fails closed at send time). The id is private run metadata — it never
 * reaches model prompt prose (the server-side resolver keeps it in `locator`).
 */
export interface DesktopRelayIdentityAPI {
  /** Read the persisted relay id, or `null` if the relay has not started. */
  getRelayId: () => Promise<{ relayId: string | null }>;
}

export interface DesktopGitHubCliStatus {
  installed: boolean;
  authenticated: boolean;
  login: string | null;
  version: string | null;
  loginPending: boolean;
}

export interface DesktopGitHubCliAPI {
  status: () => Promise<DesktopGitHubCliStatus>;
  connect: () => Promise<{ url: string; code: string }>;
  openDevicePage: () => Promise<void>;
  cancel: () => Promise<void>;
}

/** D500 — compact, secret-free management state for SSH on this Mac. */
export interface DesktopStructuredSshStatus {
  state: "unavailable" | "not-enabled" | "enabled";
  reason: string | null;
  enabledTools: readonly string[];
}

export interface DesktopStructuredSshAPI {
  status: () => Promise<DesktopStructuredSshStatus>;
  check: () => Promise<DesktopStructuredSshStatus>;
  enable: (pin: string) => Promise<DesktopStructuredSshStatus>;
  disable: () => Promise<DesktopStructuredSshStatus>;
}

/** D516 — renderer-safe local Computer use management projection. */
export interface DesktopComputerUseStatus {
  state: "unavailable" | "not-enabled" | "enabled";
  reason: string | null;
  /** Exact selected Genie in a durable active grant; null until enabled. */
  agentId: string | null;
  grantGeneration: number | null;
  /** True when valid or unreadable local bytes still require PIN-free revocation/recovery. */
  canDisable: boolean;
  /** Last observed local readiness. A selected preference does not imply a runnable driver. */
  providers: {
    cua:
      | { ready: true; reason: null; lifecycle: "healthy" }
      | {
        ready: false;
        /** Content-free reason that an exact readiness-checked Cua port is absent. */
        reason: "not_installed" | "not_checked" | "checking" | "unhealthy";
        lifecycle: "not_installed" | "installed" | "starting" | "unhealthy";
      };
  };
  /** Electron's executable Cua route, never renderer inference. */
  effectiveProvider: { provider: "cua" } | null;
}
export interface DesktopComputerUseAPI {
  status: () => Promise<DesktopComputerUseStatus>;
  /** Content-free lifecycle wake; fetch status for current sender-scoped truth. */
  onStatusChanged?: (callback: () => void) => () => void;
  check: () => Promise<DesktopComputerUseStatus>;
  ownedAgents: () => Promise<readonly { agentId: string; displayName: string; handle: string }[]>;
  enable: (pin: string, agentId: string) => Promise<DesktopComputerUseStatus>;
  disable: () => Promise<DesktopComputerUseStatus>;
}

export interface DesktopWorkstationShellAPI {
  status: () => Promise<{
    workspacePath: string | null;
    consented: boolean;
    consent: "none" | "session" | "durable";
  }>;
  revoke: () => Promise<void>;
}

/** D453 — renderer-safe state of the optional local Codex connection. */
export type DesktopCodexConnectionState =
  "disabled" | "enabling" | "enabled" | "disabling" | "faulted";

/** Deliberately redacted: no local paths, account/profile ids, or error text. */
export interface DesktopCodexConnectionStatus {
  state: DesktopCodexConnectionState;
  ready: boolean;
  relayReconciliation: "acked" | "deferred" | "failed" | null;
}

/**
 * D453 — human Connection controls. Each method takes no arguments; Electron
 * main resolves the active session, runtime, auth, and workspace itself.
 */
export interface DesktopCodexConnectionAPI {
  status: () => Promise<DesktopCodexConnectionStatus>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export interface DesktopHermesConnectionStatus {
  enabled: boolean;
  relay: "connected" | "starting";
}

/** Hermes owner choice only; processes remain one-per-accepted-Task. */
export interface DesktopHermesConnectionAPI {
  status: () => Promise<DesktopHermesConnectionStatus>;
  enable: () => Promise<DesktopHermesConnectionStatus>;
  disable: () => Promise<DesktopHermesConnectionStatus>;
}

/** D557 — renderer-safe desired startup posture, never a feature authority. */
export interface DesktopReadyToWorkAPI {
  get: () => Promise<ReadyToWorkAggregateStatus>;
  enroll: (input: {
    selection: ReadyToWorkSelection;
    /** Transient own-Human proof; Desktop never returns or persists it. */
    pin: string;
  }) => Promise<ReadyToWorkAggregateStatus>;
  restore: () => Promise<ReadyToWorkAggregateStatus>;
  disable: () => Promise<ReadyToWorkAggregateStatus>;
  onRestoreRendererOwners: (handler: (request: {
    attemptId: string;
    /** null means this owner was not selected and must remain unchanged. */
    voice: boolean | null;
    autoApprove: boolean | null;
  }) => void) => () => void;
  acknowledgeRendererOwners: (result: {
    attemptId: string;
    voice: boolean;
    autoApprove: boolean;
  }) => Promise<void>;
  /** Reports current owner truth only; this never restores either owner. */
  reportRendererOwners: (result: {
    voice: boolean;
    autoApprove: boolean;
  }) => Promise<ReadyToWorkAggregateStatus>;
  onStatusChanged: (handler: (status: ReadyToWorkAggregateStatus) => void) => () => void;
}

/** M239 — the complete content-free important-arrival IPC payload. */
export interface DesktopImportantMessageNotificationInput {
  messageId: string;
  senderDisplayName: string;
  roomId: string;
  topLevelRoomId: string;
  roomLabel: string;
  parentRoomLabel?: string;
}

export interface DesktopNotificationNavigationTarget {
  topLevelRoomId: string;
  subthreadRoomId?: string;
}

export interface DesktopNotificationSummaryInput {
  epoch: string;
  generation: number;
  generatedAt: string;
  unreadCount: number;
  importantUnreadCount: number;
}

export interface DesktopNotificationDeliveryStatus {
  state: "unsupported" | "supported" | "delivery-failed";
}

/** M239/M240 — narrow macOS delivery, summary, click, and recovery surface. */
export interface DesktopNotificationsAPI {
  showImportantMessage: (
    input: DesktopImportantMessageNotificationInput,
  ) => Promise<void>;
  publishSummary: (input: DesktopNotificationSummaryInput) => Promise<void>;
  getDeliveryStatus: () => Promise<DesktopNotificationDeliveryStatus>;
  openSystemSettings: () => Promise<{ ok: boolean }>;
  onNavigate: (
    handler: (event: DesktopNotificationNavigationTarget) => void,
  ) => () => void;
  onDeliveryStatusChange: (
    handler: (status: DesktopNotificationDeliveryStatus) => void,
  ) => () => void;
}

/**
 * D103 — intentionally small renderer projection of the main-process update
 * state. It contains presentation data only: no feed URL, release notes,
 * artifact path, provider details, or installation control crosses preload.
 */
export type DesktopUpdateStatus =
  | Readonly<{ kind: "hidden" }>
  | Readonly<{ kind: "available"; version: string }>
  | Readonly<{ kind: "downloading"; version: string; percent: number }>
  | Readonly<{ kind: "ready"; version: string }>
  | Readonly<{ kind: "installing"; version: string }>;

/**
 * D103 — optional, renderer-safe update affordance bridge. The main process
 * owns all updater decisions and native dialogs; the renderer can only read a
 * sanitized status and request that main open its native update UI.
 */
export interface DesktopUpdatesAPI {
  getStatus: () => Promise<DesktopUpdateStatus>;
  onStatus: (handler: (status: DesktopUpdateStatus) => void) => () => void;
  open: () => Promise<void>;
}

interface NautiloDesktopAPI {
  miniAppRecovery?: {
    open: (input: MiniAppRecoveryOpenInput) => Promise<{ handle: string }>;
    read: (handle: string) => Promise<MiniAppRecoveryReadResult>;
    write: (
      handle: string,
      input: MiniAppRecoveryWriteInput,
    ) => Promise<{ revision: string }>;
    close: (handle: string) => Promise<void>;
  };
  documentMutations: {
    readAuthoredChange?: (input: { path: string; expectedSha256: string }) => Promise<unknown>;
    onCommitted: (
      listener: (
        batch: AtomicDocumentMutationEventBatch,
      ) => void | Promise<void>,
    ) => () => void;
    onReconnect: (listener: () => void | Promise<void>) => () => void;
    /** D448 P10: trusted main-process lifecycle for local-file leases. */
    humanEditLeases: {
      register: (
        input: RegisterHumanEditLeaseRequest,
      ) => Promise<HumanEditLeaseStoreResult>;
      update: (
        leaseId: string,
        input: UpdateHumanEditLeaseRequest,
      ) => Promise<HumanEditLeaseStoreResult>;
      renew: (
        leaseId: string,
        input: RenewHumanEditLeaseRequest,
      ) => Promise<HumanEditLeaseStoreResult>;
      release: (
        leaseId: string,
        input: ReleaseHumanEditLeaseRequest,
      ) => Promise<HumanEditLeaseStoreResult>;
    };
  };
  readonly isDesktop: true;
  readonly platform: string;
  readonly electronVersion: string;
  /**
   * D403 (ISSUE-D403) P0 — built guest `<webview>` preload path (a file:// URL)
   * for the embedded-browser password autofill layer. Set as the
   * `<webview preload>` attribute on the SaaS surface. Optional/nullable:
   * absent in the browser and on desktop builds that predate D403.
   */
  readonly embeddedBrowserGuestPreloadPath?: string | null;
  /**
   * D154 — sync read of bootstrap-set shell state before workbench load.
   * Absent in browser and on M097/older Electron builds.
   */
  shellStateOnBoot?: () => ShellStateOnBoot;
  /** D154 — cold-boot picker / recovery IPC. Optional; see `shellStateOnBoot`. */
  coldBoot?: DesktopColdBootAPI;
  getVersion: () => Promise<string>;
  workbench?: DesktopWorkbenchAPI;
  openFolder: () => Promise<string | null>;
  /** D271 — multi-select native file open; returns bytes (base64) to upload. */
  pickFiles: () => Promise<
    Array<{ name: string; sizeBytes: number; base64: string }>
  >;
  /** M055 — Logto auth bridge. */
  auth: DesktopAuthAPI;
  /** M123 — in-app server switcher (Electron only). */
  servers?: DesktopServersAPI;
  /** M161 Stack 198 — active-session lifecycle (desktop only). */
  activeSession?: DesktopActiveSessionAPI;
  /** M239 — macOS native message delivery and Dock attention. */
  notifications?: DesktopNotificationsAPI;
  /** D103 — optional on older desktop builds and always absent in the web app. */
  updates?: DesktopUpdatesAPI;
  /** D336 — SaaS <webview> CDP-adoption bridge. */
  browserControl?: DesktopBrowserControlAPI;
  /** D504 — Human controls for one exact challenged anonymous research lease. */
  browserResearch?: DesktopBrowserResearchAPI;
  /**
   * D403 — human-only embedded-browser save/autofill bridge (desktop only;
   * feature-detect). No raw password ever crosses this surface.
   */
  passwords?: DesktopPasswordsAPI;
  /** D345 — configured local runtimes for optional tool integrations. */
  toolRuntimes?: DesktopToolRuntimesAPI;
  /** M196 — Google Workspace OAuth connect (desktop only). */
  googleWorkspace?: DesktopGoogleWorkspaceAPI;
  /** D373 — terminal (PTY) work surface bridge (desktop only; feature-detect). */
  terminal?: DesktopTerminalAPI;
  /** D418 — local Desktop Filesystem Grant administration (desktop only; feature-detect). */
  desktopFilesystemGrants?: DesktopFilesystemGrantsAPI;
  /**
   * D418 — Workstation Profile review / activation-preparation bridge
   * (desktop only; feature-detect). Read-only review + seed discovery; never
   * activates. Absent on non-desktop and on builds that predate this bridge.
   */
  workstationProfiles?: DesktopWorkstationProfilesAPI;
  /** D538 — own-PIN uncontained-host-command session control. */
  uncontainedHostCommands?: DesktopUncontainedHostCommandsAPI;
  /** D458 Wave 7 — mobile-control pairing surface (new desktop builds only). */
  remoteControl?: DesktopRemoteControlAPI;
  /** Main-owned ordinary send path; credentials never enter renderer state. */
  ordinaryChat?: {
    sendRoomMessage: (
      roomId: string,
      body: Parameters<NautiloApiClient["sendRoomMessage"]>[1],
    ) => ReturnType<NautiloApiClient["sendRoomMessage"]>;
  };
  /** Main-owned foreground Shadow custody; absent on older Desktop builds. */
  foregroundShadow?: DesktopForegroundShadowAPI;
  /** Main-owned recovery phrase generation and sealed device custody. */
  encryptionRecovery?: DesktopEncryptionRecoveryAPI;
  /** M101 Phase 3 — `nautilo://` deep links (invite, reset-password, account). */
  deepLink: DesktopDeepLinkAPI;
  /**
   * D079 — canonical current-folder surface (the user's task-scoped
   * folder — codebase, design dump, legal archive, etc.). Use this in
   * new code.
   */
  currentFolder: CurrentFolderAPI;
  /**
   * D079 Phase 3 — Genie's Workspace (Surface A, her persistent
   * drawer at `~/Documents/Nautilo/` by default). Distinct namespace
   * from `currentFolder` so the two surfaces are never confusable.
   */
  genieWorkspace: GenieWorkspaceAPI;
  /**
   * D079 — deprecated alias for the current-folder surface. Retained
   * for one release while consumer code migrates. `useDefault` is NOT
   * included — the current folder has no default in the D079 model.
   */
  workspace: Omit<CurrentFolderAPI, never>;
  relayStatus: {
    onChange: (cb: (status: string) => void) => () => void;
    get: () => Promise<string>;
  };

  /**
   * D423 4.1.3 — persisted Electron relay identity (desktop only; optional on
   * older builds). Feature-detect via `getDesktopRelayId()` before use.
   */
  relayIdentity?: DesktopRelayIdentityAPI;
  /** D431 — opaque, sender-owned local binary-read sessions. */
  binaryRead: {
    open: (
      path: string,
    ) => Promise<
      | { ok: true; data: { id: string; size: number; chunkSize: number } }
      | { ok: false; error: { code: string } }
    >;
    read: (
      id: string,
      position: number,
    ) => Promise<
      | {
          ok: true;
          data: { bytes: Uint8Array; position: number; done: boolean };
        }
      | { ok: false; error: { code: string } }
    >;
    close: (
      id: string,
    ) => Promise<
      { ok: true; data: null } | { ok: false; error: { code: string } }
    >;
  };
  /** D385/D378 — opaque Desktop-local media import/preview capability. */
  mediaProxy?: {
    importVideo: (documentPath: string) => Promise<
      | { ok: true; data: { mediaRef: string; label: string; mediaKind?: "video" | "audio" | "image"; durationSec?: number; frameRate?: { numerator: number; denominator: number } } }
      | { ok: false; error: { code: string } }
    >;
    /** Main streams a native-picked immutable snapshot through authenticated Workspace admission. */
    importWorkspace?: (input: import("@nautilo/types").WorkspaceMediaImportInput) => Promise<
      { ok: true; data: import("@nautilo/types").WorkspaceMediaImportData } | { ok: false; error: { code: string } }
    >;
    /** Main imports one native multi-selection in picker order; failures expose basename labels only. */
    importWorkspaceBatch?: (input: import("@nautilo/types").WorkspaceMediaImportInput) => Promise<
      { ok: true; data: import("@nautilo/types").WorkspaceMediaBatchImportData } | { ok: false; error: { code: string } }
    >;
    /** Main stages authenticated media on disk; only a revocable range-serving handle crosses IPC. */
    openWorkspace?: (input: import("@nautilo/types").WorkspaceMediaPreviewInput) => Promise<
      { ok: true; data: import("@nautilo/types").WorkspaceMediaPreviewData } | { ok: false; error: { code: string } }
    >;
    open: (input: { requestId: string; documentPath: string; ref: string }) => Promise<
      | { ok: true; data: { url: string; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } }
      | { ok: false; error: { code: string } }
    >;
    cancel: (requestId: string) => Promise<
      { ok: true; data: null } | { ok: false; error: { code: string } }
    >;
    close: (revokeToken: string) => Promise<
      { ok: true; data: null } | { ok: false; error: { code: string } }
    >;
    onProgress: (callback: (event: { requestId: string; progress: unknown }) => void) => () => void;
  };
  /** D378 — sender-bound native sequence export for Current Folder and Workspace sources. */
  mediaExport?: {
    supportsWorkspacePublication?: true;
    supportsExportSettings?: true;
    start: (input: { requestId: string; documentPath: string; expectedSha256: string; exportSettings?: import("@nautilo/types").VideoExportSettings }) => Promise<
      | { ok: true; data: { status: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[] } | { status: "cancelled" } }
      | { ok: false; error: { code: string } }
    >;
    startWorkspace?: (input: { requestId: string; documentContent: string; expectedSha256: string; roomId: string; sources: Array<{ mediaId: string; artifactRowId: string; artifactId: string; path: string; mimeType: string; sizeBytes: number }>; publishToWorkspace?: boolean; exportSettings?: import("@nautilo/types").VideoExportSettings }) => Promise<
      | { ok: true; data: { status: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[]; workspace?: { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string } } | { status: "cancelled" } }
      | { ok: false; error: { code: string } }
    >;
    promoteVideoProject?: (input: { requestId: string; documentPath: string; expectedSha256: string; roomId: string }) => Promise<unknown>;
    cancel: (requestId: string) => Promise<{ ok: true; data: null } | { ok: false; error: { code: string } }>;
    onProgress: (callback: (event: { requestId: string; progress: unknown }) => void) => () => void;
  };
  /** D486 — host GitHub CLI health and device-flow controls. */
  githubCli?: DesktopGitHubCliAPI;
  /** D500 — Human-only structured SSH setup/revocation (desktop only). */
  structuredSsh?: DesktopStructuredSshAPI;
  /** D516 — Human-only local Computer use setup/revocation. */
  computerUse?: DesktopComputerUseAPI;
  /** D516 — Human-owned macOS permission setup (new Desktop builds only). */
  systemPermissions?: DesktopSystemPermissionsAPI;
  /** D486 — human status/revocation for Current Folder workstation consent. */
  workstationShell?: DesktopWorkstationShellAPI;
  /** D453 — optional on older desktop builds; feature-detect before use. */
  codexConnection?: DesktopCodexConnectionAPI;
  /** D557 — optional on older desktop builds; durable Hermes owner choice. */
  hermesConnection?: DesktopHermesConnectionAPI;
  /** D557 — optional on older Desktop builds; no receipt or authority data. */
  readyToWork?: DesktopReadyToWorkAPI;
  fs: {
    readDir: (
      path: string,
    ) => Promise<
      Array<{ name: string; type: string; sizeBytes: number; mtimeMs: number }>
    >;
    readFile: (path: string) => Promise<string>;
    /** Open a file with the OS default application. */
    openPath: (path: string) => Promise<void>;
    watchRoot: (path: string) => Promise<void>;
    unwatchRoot: (path: string) => Promise<void>;
    onDirectoryChanged: (
      handler: (event: FsDirectoryChangedEvent) => void,
    ) => () => void;
    stat: (path: string) => Promise<{
      exists: boolean;
      isFile: boolean;
      isDirectory: boolean;
      size: number;
      modified: string | null;
      documentIdentity?: {
        kind: "local_file";
        relayId: string;
        canonicalPath: string;
      } | null;
    }>;
    writeFile: (
      path: string,
      content: string,
      opts?: DesktopEditorSaveWriteOptions,
    ) => Promise<FsWriteFileResult>;
    /** D357 Phase 3 — create a directory inside the allowed root (no implicit parents). */
    mkdir: (path: string) => Promise<FsMkdirResult>;
    /** D357 Phase 3 — move/rename a file or directory within the allowed root. */
    rename: (from: string, to: string) => Promise<FsRenameResult>;
    /** D357 — move a file or directory to the OS trash (recoverable delete). */
    trash: (path: string) => Promise<FsTrashResult>;
  };
  media: {
    /** Current TCC mic status. Does not trigger a prompt. */
    getMicStatus: () => Promise<MicStatus>;
    /**
     * Ask macOS for mic access. Idempotent — if the user has already
     * decided, no prompt shows and the existing status is returned.
     * On non-macOS platforms resolves to "granted" without side effects.
     */
    askForMicrophoneAccess: () => Promise<MicStatus>;
    /**
     * Open System Settings scoped to microphone permissions so a denied
     * user can flip the toggle. macOS only; no-op elsewhere.
     */
    openSystemMicSettings: () => Promise<void>;
  };

  menu: {
    /**
     * Subscribe to native menu clicks. Returns an unsubscribe fn to call
     * on unmount so we don't leak listeners on hot-reload / re-mount.
     */
    onAction: (handler: (action: MenuAction) => void) => () => void;
  };

  /**
   * D057 2a.6.3 — forward renderer-side log calls into the main-process
   * electron-log pipeline so they land in the platform-standard main.log.
   * Fire-and-forget. Safe to call from hot paths.
   */
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };

  /**
   * D091 Phase 3 — re-trigger the onboarding wizard from workbench
   * Settings. Main hides the workbench window, opens the wizard
   * against the existing profile, restores the workbench afterward,
   * and pushes `onboarding:completed` regardless of whether the
   * wizard completed or was cancelled — workbench can refetch
   * profile state uniformly.
   */
  onboarding: {
    /** @param sessionToken Logto access token from the workbench session
     *   (`useAuth().session.getAccessToken()`), forwarded to the wizard's
     *   main-side IPC cache so re-trigger authenticated calls succeed
     *   without re-prompting. Pass `null` if no token is available.
     * @param theme Workbench's active theme (from
     *   `localStorage["nautilo-theme"]`). Main sets
     *   `nativeTheme.themeSource` for the wizard's lifetime so
     *   the wizard's `prefers-color-scheme` CSS resolves to the
     *   user's chosen theme. Pass `null` to fall back to the OS
     *   preference. */
    open: (
      sessionToken: string | null,
      theme: "light" | "dark" | null,
      options?: { startAt?: "personality" | "avatar" },
    ) => Promise<void>;
    /** Subscribe to wizard-completed pushes. Returns an unsubscribe
     *  fn to call on unmount. */
    onCompleted: (handler: () => void) => () => void;
  };
}

export const isDesktop: boolean =
  typeof window !== "undefined" && "nautiloDesktop" in window;

export const desktopAPI: NautiloDesktopAPI | null = isDesktop
  ? (window as unknown as { nautiloDesktop: NautiloDesktopAPI }).nautiloDesktop
  : null;

/** Subscribe when the running preload supports protected-Room access updates. */
export function subscribeToDesktopProtectedRoomAccessState(
  api: Pick<DesktopForegroundShadowAPI, "onProtectedRoomAccessState"> | undefined,
  listener: (state: ProtectedRoomAccessStateV2) => void,
): () => void {
  const subscribe = api?.onProtectedRoomAccessState;
  if (typeof subscribe !== "function") return () => undefined;
  try {
    const unsubscribe = subscribe.call(api, listener);
    if (typeof unsubscribe !== "function") return () => undefined;
    return () => {
      try {
        unsubscribe();
      } catch {
        // A stale preload must not turn React effect cleanup into a renderer error.
      }
    };
  } catch {
    // The Workbench can be newer than the installed Desktop preload.
    return () => undefined;
  }
}

export function resolveWorkbenchSurfaceFocused(args: {
  nativeFocus?: (() => boolean) | undefined;
  documentFocused: boolean;
}): boolean {
  if (typeof args.nativeFocus !== "function") return args.documentFocused;
  try {
    return args.nativeFocus();
  } catch {
    return false;
  }
}

/**
 * Whether the Human can currently see and interact with this Workbench.
 * Electron's WebContentsView can keep `document.hasFocus()` true when its
 * BaseWindow is parked on another macOS Space, so Desktop must defer to the
 * main-process window signal. Browser clients retain the DOM fallback.
 */
export function isWorkbenchSurfaceFocused(): boolean {
  const nativeFocus = desktopAPI?.workbench?.isWindowFocused;
  return resolveWorkbenchSurfaceFocused({
    nativeFocus,
    documentFocused: typeof document === "undefined" || document.hasFocus(),
  });
}

/** Subscribe to the main-owned Desktop focus signal when the bridge supports it. */
export function onDesktopWindowFocusChanged(
  handler: (focused: boolean) => void,
): () => void {
  const subscribe = desktopAPI?.workbench?.onWindowFocusChanged;
  if (typeof subscribe !== "function") return () => {};
  try {
    return subscribe(handler);
  } catch {
    return () => {};
  }
}

/** The preload bridge, not user agent heuristics, owns the Workbench declaration. */
export function initiatingClientSurfaceForWorkbench(args: {
  isDesktop: boolean;
  desktopAPI: NautiloDesktopAPI | null;
}): InitiatingClientSurfaceV1 {
  return args.isDesktop && args.desktopAPI ? "workbench.desktop" : "workbench.browser";
}

/**
 * M123 — true when the desktop preload exposes the server-switch picker.
 * Env-pinned launches hide mismatch recovery in main; this gate is
 * bridge-availability only until main exposes an explicit env-pin flag.
 */
export function canSwitchDesktopServer(): boolean {
  return typeof desktopAPI?.servers?.openPicker === "function";
}

/**
 * M161 Phase 3 — true when the desktop preload exposes the in-process
 * switch surface (`switchTo` / `add` / `close` / `list` / `onChanged`).
 * Used to feature-gate the new servers panel against older builds that
 * only ship the legacy relaunch `openPicker`.
 */
export function canSwitchDesktopServerInProcess(): boolean {
  const s = desktopAPI?.servers;
  return (
    typeof s?.switchTo === "function" &&
    typeof s?.add === "function" &&
    typeof s?.close === "function" &&
    typeof s?.list === "function" &&
    typeof s?.onChanged === "function" &&
    typeof s?.onNavigateHome === "function"
  );
}

/**
 * D154 — read cold-boot shell classification from the preload bridge.
 * Returns `null` in browser dev, when `nautiloDesktop` is missing, or when
 * the running desktop build does not expose `shellStateOnBoot`.
 *
 * Reads `window.nautiloDesktop` on each call (not the module-level
 * `desktopAPI` snapshot) so late-installed preload bridges and unit tests
 * that polyfill `nautiloDesktop` after module load still see the value.
 */
export function getShellStateOnBoot(): ShellStateOnBoot | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { nautiloDesktop?: NautiloDesktopAPI })
    .nautiloDesktop;
  if (!api) return null;
  const fn = api.shellStateOnBoot;
  if (typeof fn !== "function") return null;
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * D423 4.1.3 — read the persisted Electron relay identity from the preload
 * bridge. Returns the relay id, or `null` when not running inside the Electron
 * shell, the preload bridge is missing, the `relayIdentity` namespace is
 * absent (older build), or the relay has not yet been started. The renderer
 * MUST use this to populate a local-file focus ref's `relayId`; it never
 * invents one. Errors degrade to `null` (fail closed) rather than throwing.
 *
 * Reads `window.nautiloDesktop` on each call so late-installed preload bridges
 * and unit tests that polyfill `nautiloDesktop` after module load still see
 * the value.
 */
export async function getDesktopRelayId(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { nautiloDesktop?: NautiloDesktopAPI })
    .nautiloDesktop;
  if (!api) return null;
  const fn = api.relayIdentity?.getRelayId;
  if (typeof fn !== "function") return null;
  try {
    const result = await fn();
    return result?.relayId ?? null;
  } catch {
    return null;
  }
}

/**
 * D448 P10 — resolve the optional local human-edit lease bridge at call time,
 * matching `getDesktopRelayId`'s late-preload/test-safe behavior.
 */
export function getDesktopLocalHumanEditLeaseAPI():
  NautiloDesktopAPI["documentMutations"]["humanEditLeases"] | null {
  if (typeof window === "undefined") return null;
  const api = (window as unknown as { nautiloDesktop?: NautiloDesktopAPI })
    .nautiloDesktop;
  return api?.documentMutations.humanEditLeases ?? null;
}
/**
 * D154 Phase 2.3 — pure seed for `lastOpenAt` (see `NautiloRuntimeProvider`).
 * Mirrors the persisted has-ever-open bit (`getInitialLastOpenAt`) with a
 * cold-boot tiebreaker when Electron reports non-`live` `shellStateOnBoot`.
 */
export function computeInitialLastOpenAtSeed(input: {
  hasEverBeenOpen: boolean;
  shellStateOnBoot: ShellStateOnBoot | null;
  now: number;
}): number | null {
  const base = input.hasEverBeenOpen ? input.now : null;
  const boot = input.shellStateOnBoot;
  if (boot != null && boot !== "live" && base === null) {
    return input.now;
  }
  return base;
}

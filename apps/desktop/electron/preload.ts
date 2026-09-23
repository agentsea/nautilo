import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { CompanionOwnerAPI, CompanionAction } from "./companion-contract";
import type { ConnectionPresentation } from "./connection-presentation";
import type {
  ReadyToWorkAggregateStatus,
  ReadyToWorkSelection,
} from "./ready-to-work-contract";
import type {
  MiniAppRecoveryOpenInput,
  MiniAppRecoveryReadResult,
  MiniAppRecoveryWriteInput,
} from "./mini-app-draft-recovery-contract";
import type {
  SystemPermissionId,
  SystemPermissionsSnapshot,
} from "./system-permissions";
import type {
  MessageBackfillUrgentSelection,
  NautiloApiClient,
  RoomPendingAttentionRecoveryResponse,
} from "@nautilo/api-client";
import type { AtomicDocumentMutationEventBatch } from "@nautilo/document-mutations";
import type { MessagePayloadV2 } from "@nautilo/lattice-bridge";
import type {
  BrowserRoomHistoryShadowAcknowledgementInput,
  HumanPeerLiveShadowReceiveResult,
  ProtectedRoomAccessStateV2,
  SharedAgentLiveShadowReceiveResult,
  VaultLiveShadowReceiveResult,
  VaultRoomHistoryShadowReadInputV1,
  VaultRoomHistoryShadowReadResultV1,
} from "@nautilo/lattice-bridge/client/browser";
import type {
  HumanEditLeaseStoreResult,
  LiveShadowMessageRealtimeEventV1,
  FullEncryptionMessageRealtimeContentEventV2,
  RegisterHumanEditLeaseRequest,
  ReleaseHumanEditLeaseRequest,
  RenewHumanEditLeaseRequest,
  UpdateHumanEditLeaseRequest,
} from "@nautilo/types";
import { validateAtomicDocumentMutationEventBatchEnvelope } from "@nautilo/document-mutations";

type DocumentMutationBatchListener = (
  batch: AtomicDocumentMutationEventBatch,
) => void | Promise<void>;
type DocumentMutationReconnectListener = () => void | Promise<void>;
type BinaryReadSessionErrorCode =
  | "invalid_request"
  | "not_file"
  | "not_found"
  | "size_limit"
  | "session_limit"
  | "session_not_found"
  | "sender_mismatch"
  | "out_of_order"
  | "read_in_progress"
  | "expired"
  | "mutated"
  | "unavailable";
type BinaryReadSessionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: BinaryReadSessionErrorCode } };

type ForegroundShadowInspection =
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

type ForegroundShadowReceiveInput =
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

type ForegroundShadowReceiveResult =
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

type ForegroundShadowHistoryReconcileInput = Readonly<{
  readerInput: VaultRoomHistoryShadowReadInputV1;
  acknowledgement: Omit<
    BrowserRoomHistoryShadowAcknowledgementInput,
    "result"
  >;
}>;
type MessageBackfillBatchResult = Readonly<{
  state: "more" | "waiting" | "caught_up";
  resumeAt: number | null;
  reconciled?: true;
  reconciledSelection?: MessageBackfillUrgentSelection;
  resolvedSelection?: MessageBackfillUrgentSelection;
}>;
const documentMutationListeners = new Set<DocumentMutationBatchListener>();
const documentMutationReconnectListeners =
  new Set<DocumentMutationReconnectListener>();
let documentMutationEpoch = 0;
let preparedDocumentMutationEpoch = -1;
let preparingDocumentMutationEpoch: Promise<void> | null = null;
let workbenchWindowFocused = false;
const workbenchWindowFocusListeners = new Set<(focused: boolean) => void>();
type PrepareDesktopQuitResult = { ready: boolean; errorMessage?: string | null };
type PrepareDesktopQuitCancellation = {
  isCancelled: () => boolean;
  onCancelled: (handler: () => void) => () => void;
};
type PrepareDesktopQuitHandler = (
  cancellation: PrepareDesktopQuitCancellation,
) => PrepareDesktopQuitResult | Promise<PrepareDesktopQuitResult>;
const prepareDesktopQuitListeners = new Set<PrepareDesktopQuitHandler>();
const prepareDesktopQuitControllers = new Map<string, AbortController>();
type SystemPermissionStatusListener = (
  snapshot: SystemPermissionsSnapshot,
) => void;
const systemPermissionStatusListeners = new Set<SystemPermissionStatusListener>();
let systemPermissionStatusSubscribed = false;
type SystemPermissionsOnboardingPreference = Readonly<{
  version: 1;
  showAutomatically: boolean;
}>;
const systemPermissionOnboardingPreferenceListeners = new Set<
  (preference: SystemPermissionsOnboardingPreference) => void
>();
const systemPermissionGuidedSetupListeners = new Set<() => void>();

ipcRenderer.on("workbench:window-focus-changed", (_event, focused: unknown) => {
  if (typeof focused !== "boolean") return;
  workbenchWindowFocused = focused;
  for (const listener of workbenchWindowFocusListeners) listener(focused);
});

ipcRenderer.on("desktop:lifecycle:prepare-quit", (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object" ||
    typeof (raw as { requestId?: unknown }).requestId !== "string") return;
  const requestId = (raw as { requestId: string }).requestId;
  for (const controller of prepareDesktopQuitControllers.values()) controller.abort();
  prepareDesktopQuitControllers.clear();
  const controller = new AbortController();
  prepareDesktopQuitControllers.set(requestId, controller);
  const cancellation: PrepareDesktopQuitCancellation = {
    isCancelled: () => controller.signal.aborted,
    onCancelled: (handler) => {
      if (controller.signal.aborted) {
        handler();
        return () => {};
      }
      const onAbort = () => handler();
      controller.signal.addEventListener("abort", onAbort, { once: true });
      return () => controller.signal.removeEventListener("abort", onAbort);
    },
  };
  void Promise.all([...prepareDesktopQuitListeners].map((listener) =>
    Promise.resolve().then(() => listener(cancellation))))
    .then((results) => {
      const failure = results.find((result) => result.ready !== true);
      ipcRenderer.send("desktop:lifecycle:prepare-quit-result", {
        requestId,
        ready: failure === undefined,
        ...(failure?.errorMessage ? { errorMessage: failure.errorMessage } : {}),
      });
    })
    .catch((error: unknown) => {
      ipcRenderer.send("desktop:lifecycle:prepare-quit-result", {
        requestId,
        ready: false,
        errorMessage: error instanceof Error ? error.message : "Saving before quit failed.",
      });
    });
});

ipcRenderer.on("desktop:lifecycle:prepare-quit-cancelled", (_event, raw: unknown) => {
  if (!raw || typeof raw !== "object" ||
    typeof (raw as { requestId?: unknown }).requestId !== "string") return;
  const requestId = (raw as { requestId: string }).requestId;
  const controller = prepareDesktopQuitControllers.get(requestId);
  if (!controller) return;
  prepareDesktopQuitControllers.delete(requestId);
  controller.abort();
});

ipcRenderer.on("systemPermissions:statusChanged", (_event, raw: unknown) => {
  // Main owns the payload. Keep the renderer bridge narrow and simply fan its
  // current status snapshot to mounted consumers.
  for (const listener of systemPermissionStatusListeners) {
    listener(raw as SystemPermissionsSnapshot);
  }
});

const systemPermissionsAPI = {
  status: () =>
    ipcRenderer.invoke(
      "systemPermissions:status",
    ) as Promise<SystemPermissionsSnapshot>,
  resolve: (id: SystemPermissionId) =>
    ipcRenderer.invoke(
      "systemPermissions:resolve",
      id,
    ) as Promise<SystemPermissionsSnapshot>,
  restart: () =>
    ipcRenderer.invoke("systemPermissions:restart") as Promise<void>,
  onStatusChanged: (listener: SystemPermissionStatusListener): (() => void) => {
    systemPermissionStatusListeners.add(listener);
    if (!systemPermissionStatusSubscribed) {
      systemPermissionStatusSubscribed = true;
      ipcRenderer.send("systemPermissions:subscribe");
    }
    return () => {
      systemPermissionStatusListeners.delete(listener);
      if (
        systemPermissionStatusSubscribed &&
        systemPermissionStatusListeners.size === 0
      ) {
        systemPermissionStatusSubscribed = false;
        ipcRenderer.send("systemPermissions:unsubscribe");
      }
    };
  },
  onboardingPreference: () =>
    ipcRenderer.invoke(
      "systemPermissions:onboardingPreference",
    ) as Promise<SystemPermissionsOnboardingPreference>,
  setOnboardingPreference: async (
    showAutomatically: boolean,
  ): Promise<SystemPermissionsOnboardingPreference> => {
    const preference = await ipcRenderer.invoke(
      "systemPermissions:setOnboardingPreference",
      showAutomatically,
    ) as SystemPermissionsOnboardingPreference;
    for (const listener of systemPermissionOnboardingPreferenceListeners) {
      listener(preference);
    }
    return preference;
  },
  onOnboardingPreferenceChanged: (
    listener: (preference: SystemPermissionsOnboardingPreference) => void,
  ): (() => void) => {
    systemPermissionOnboardingPreferenceListeners.add(listener);
    return () => systemPermissionOnboardingPreferenceListeners.delete(listener);
  },
  requestGuidedSetup: (): Promise<void> => {
    for (const listener of systemPermissionGuidedSetupListeners) listener();
    return Promise.resolve();
  },
  onGuidedSetupRequested: (listener: () => void): (() => void) => {
    systemPermissionGuidedSetupListeners.add(listener);
    return () => systemPermissionGuidedSetupListeners.delete(listener);
  },
};

function prepareDocumentMutationEpoch(): Promise<void> {
  if (
    documentMutationListeners.size === 0 ||
    preparedDocumentMutationEpoch === documentMutationEpoch
  )
    return Promise.resolve();
  if (preparingDocumentMutationEpoch) return preparingDocumentMutationEpoch;
  const epoch = documentMutationEpoch;
  preparingDocumentMutationEpoch = (async () => {
    await Promise.all(
      [...documentMutationReconnectListeners].map(
        async (listener) => await listener(),
      ),
    );
    if (epoch !== documentMutationEpoch || documentMutationListeners.size === 0)
      return;
    preparedDocumentMutationEpoch = epoch;
    ipcRenderer.send("document:mutationReady", { epoch });
  })().finally(() => {
    preparingDocumentMutationEpoch = null;
    if (
      preparedDocumentMutationEpoch !== documentMutationEpoch &&
      documentMutationListeners.size > 0
    ) {
      void prepareDocumentMutationEpoch();
    }
  });
  return preparingDocumentMutationEpoch;
}
ipcRenderer.on("document:mutationCommitted", (_event, raw: unknown) => {
  void (async () => {
    try {
      if (
        documentMutationListeners.size === 0 ||
        !validateAtomicDocumentMutationEventBatchEnvelope(raw)
      )
        return;
      const batch: AtomicDocumentMutationEventBatch = raw;
      // All registered consumers must synchronously/asynchronously accept the
      // exact batch. Any failure/unload leaves durable outbox truth pending.
      await Promise.all(
        [...documentMutationListeners].map(
          async (listener) => await listener(batch),
        ),
      );
      ipcRenderer.send("document:mutationAck", {
        idempotencyKey: batch.idempotencyKey,
      });
    } catch {
      // Deliberately no ack.
    }
  })();
});
ipcRenderer.on("desktop:active-session-state", (_event, state: unknown) => {
  if (
    state !== null &&
    typeof state === "object" &&
    (state as { active?: unknown }).active === true
  ) {
    const epoch = (state as { documentMutationEpoch?: unknown })
      .documentMutationEpoch;
    if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0)
      return;
    if (epoch !== documentMutationEpoch) {
      documentMutationEpoch = epoch;
      preparedDocumentMutationEpoch = -1;
    } else if (preparedDocumentMutationEpoch === epoch) {
      return;
    }
    void prepareDocumentMutationEpoch();
  }
});
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
import type { ListedDesktopFilesystemGrant } from "./desktop-filesystem-grants/store";
import type {
  ApplyFillRequest,
  CommitSaveRequest,
  DismissSaveRequest,
  FormDetectedNotice,
  PasswordActionResult,
  PasswordLookupRequest,
  PasswordLookupResult,
  PendingSaveNotice,
} from "./passwords/types";

/**
 * menu action dispatch from main. Renderer subscribes via
 * `nautiloDesktop.menu.onAction(handler)`; main fires actions when menu
 * items are clicked. String union kept in lock-step with
 * apps/desktop/electron/menu.ts MenuAction.
 */
type MenuAction =
  | "new-chat"
  | "new-window"
  | "open-settings"
  | "speak"
  | "report-issue"
  | "toggle-browser-column"
  | "toggle-context-panel"
  | "toggle-nav-rail"
  // Account → Manage devices…
  | "open-account-devices"
  | "open-change-pin"
  | "open-restore-pin";

/**
 * microphone permission status values surfaced to the
 * renderer. Mirrors the MicStatus union in main-process media.ts.
 */
type MicStatus =
  "not-determined" | "granted" | "denied" | "restricted" | "unknown";

type DesktopFilesystemGrantsIpcFailureCode =
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

type DesktopFilesystemGrantsIpcResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: DesktopFilesystemGrantsIpcFailureCode; message: string };

type DesktopFilesystemGrantValidation = DesktopFilesystemGrantsIpcResult<{
  canonicalRoot: string;
  filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
}>;

type DesktopFilesystemGrantCreateRequest = {
  canonicalRoot: string;
  filesystemIdentity: DesktopFilesystemGrantFilesystemIdentity;
  access: readonly DesktopFilesystemAccessOperation[];
  lifetime: DesktopFilesystemGrantLifetime;
};

/** deliberately narrow mobile-control renderer bridge. */
type RemoteControlReadiness = {
  relayReady: boolean;
  relayStatus: string;
  keepAwakeEnabled: boolean;
  keepAwakePolicy: "off" | "while_remote_enabled_and_on_external_power";
  keepAwakeSupported: boolean;
  macosLidClosedGuidance: string | null;
};

type RemotePairingChallenge = {
  deepLink: string;
  challengeId: string;
  ceremonyContext: string;
  qrSecret: string;
  manualCode: string;
  expiresAt: string;
};

type RemoteController = {
  bindingId: string;
  remoteHostId: string;
  installationId: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string | null;
};

type EncryptionRecoveryReadiness =
  | {
    status: "active";
    encryptionSetup?: "device_active" | "human_domain_active";
    continuationReason?:
      | "device_unavailable"
      | "existing_domain_requires_delivery"
      | "multiple_active_devices_require_fanout"
      | "stale_identity";
    pendingAdditionalDevices?: readonly Readonly<{
      operationId: string;
      deviceId: string;
      clientKind: "browser" | "electron";
      verificationCode: string;
      progress: "approval_required" | "transfer_ready" | "awaiting_target";
    }>[];
  }
  | { status: "setup_required" | "setup_pending" }
  | {
    status: "additional_device_required";
    enrollmentStatus?: "required" | "waiting_for_approval" | "syncing";
    operationId?: string;
    verificationCode?: string;
  }
  | { status: "reset_required"; reason: "server_identity_missing" }
  | {
    status: "recovery_required";
    reason: "stale_device" | "removed_device";
  }
  | { status: "unavailable"; reason: string };

type EncryptionDeviceRoster = {
  formatVersion: 1;
  currentDeviceId: string;
  currentMemberCount: number;
  devices: readonly {
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
  }[];
};

type DeviceAdmissionChallenge = {
  formatVersion: 1;
  challengeId: string;
  credentialDigestBase64url: string;
  userId: string;
  humanActorId: string;
  deviceId: string;
  deviceGeneration: number;
  serverInstanceId: string;
  lineageGeneration: number;
  epoch: number;
  securityRevision: number;
  headDigestBase64url: string;
  nonceBase64url: string;
  issuedAt: number;
  expiresAt: number;
};

type DeviceAdmissionProof = DeviceAdmissionChallenge & {
  signatureBase64url: string;
};

type RecoveryKitPresentation = {
  presentationId: string;
  documentHeader: string;
  mnemonic: string;
};

const remoteControlAPI = {
  getReadiness: () =>
    ipcRenderer.invoke(
      "remoteControl:getReadiness",
    ) as Promise<RemoteControlReadiness>,
  setKeepAwakePolicy: (
    policy: "off" | "while_remote_enabled_and_on_external_power",
  ) =>
    ipcRenderer.invoke("remoteControl:setKeepAwakePolicy", {
      policy,
    }) as Promise<{ ok: boolean; enabled: boolean; policy: string }>,
  createChallenge: () =>
    ipcRenderer.invoke(
      "remoteControl:createChallenge",
    ) as Promise<RemotePairingChallenge>,
  listControllers: () =>
    ipcRenderer.invoke("remoteControl:listControllers") as Promise<{
      controllers: RemoteController[];
    }>,
  renameController: (bindingId: string, label: string) =>
    ipcRenderer.invoke("remoteControl:renameController", {
      bindingId,
      label,
    }) as Promise<{ ok: true }>,
  revokeController: (bindingId: string) =>
    ipcRenderer.invoke("remoteControl:revokeController", {
      bindingId,
    }) as Promise<{ ok: true }>,
};

const encryptionRecoveryAPI = {
  inspect: () => ipcRenderer.invoke("encryptionRecovery:inspect") as
    Promise<EncryptionRecoveryReadiness>,
  deviceAdmissionDeviceId: () =>
    ipcRenderer.invoke("encryptionRecovery:deviceAdmissionDeviceId") as
      Promise<string | null>,
  signDeviceAdmissionChallenge: (challenge: DeviceAdmissionChallenge) =>
    ipcRenderer.invoke(
      "encryptionRecovery:signDeviceAdmissionChallenge",
      challenge,
    ) as Promise<DeviceAdmissionProof>,
  resetLocalSetup: () => ipcRenderer.invoke("encryptionRecovery:resetLocalSetup") as
    Promise<EncryptionRecoveryReadiness>,
  setup: () => ipcRenderer.invoke("encryptionRecovery:setup") as
    Promise<EncryptionRecoveryReadiness>,
  continueAdditionalDevice: () =>
    ipcRenderer.invoke("encryptionRecovery:continueAdditionalDevice") as
      Promise<EncryptionRecoveryReadiness>,
  approveAdditionalDevice: (operationId: string, verificationCode: string) =>
    ipcRenderer.invoke("encryptionRecovery:approveAdditionalDevice", {
      operationId,
      verificationCode,
    }) as Promise<EncryptionRecoveryReadiness>,
  advanceAdditionalDevice: (operationId: string) =>
    ipcRenderer.invoke("encryptionRecovery:advanceAdditionalDevice", {
      operationId,
    }) as Promise<EncryptionRecoveryReadiness>,
  listEncryptionDevices: () =>
    ipcRenderer.invoke("encryptionRecovery:listDevices") as
      Promise<EncryptionDeviceRoster>,
  removeEncryptionDevice: (deviceId: string, pin: string) =>
    ipcRenderer.invoke("encryptionRecovery:removeDevice", {
      deviceId,
      pin,
    }) as Promise<EncryptionRecoveryReadiness>,
  recoverEncryptionDevice: (mnemonic: string) =>
    ipcRenderer.invoke("encryptionRecovery:recoverDevice", {
      mnemonic,
    }) as Promise<EncryptionRecoveryReadiness>,
  reconnectEncryptionDevice: () =>
    ipcRenderer.invoke("encryptionRecovery:reconnectDevice") as
      Promise<EncryptionRecoveryReadiness>,
  resolvePresentation: (input: Readonly<{
    presentationId: string;
    status: "confirmed" | "cancelled";
  }>) => ipcRenderer.invoke("encryptionRecovery:resolvePresentation", input) as
    Promise<void>,
  onPresentation(listener: (value: RecoveryKitPresentation) => void) {
    const handler = (_event: Electron.IpcRendererEvent, value: RecoveryKitPresentation) =>
      listener(value);
    ipcRenderer.on("encryptionRecovery:presentation", handler);
    return () => ipcRenderer.removeListener(
      "encryptionRecovery:presentation",
      handler,
    );
  },
};

const ordinaryChatAPI = {
  sendRoomMessage: (
    roomId: string,
    body: Parameters<NautiloApiClient["sendRoomMessage"]>[1],
  ) =>
    ipcRenderer.invoke("ordinaryChat:sendRoomMessage", {
      roomId,
      body,
    }) as ReturnType<NautiloApiClient["sendRoomMessage"]>,
};

/**
 * narrow human-only grant-management bridge. It intentionally has no
 * directory browsing/read APIs and a picked path is never persisted here.
 */
const desktopFilesystemGrantsAPI = {
  pick: () =>
    ipcRenderer.invoke("desktopFilesystemGrants:pick") as Promise<
      string | null
    >,
  validate: (path: string) =>
    ipcRenderer.invoke("desktopFilesystemGrants:validate", {
      path,
    }) as Promise<DesktopFilesystemGrantValidation>,
  create: (request: DesktopFilesystemGrantCreateRequest) =>
    ipcRenderer.invoke("desktopFilesystemGrants:create", {
      request,
    }) as Promise<
      DesktopFilesystemGrantsIpcResult<{
        grant: DesktopFilesystemGrant;
        revision: number;
      }>
    >,
  list: (opts?: { includeHistory?: boolean }) =>
    ipcRenderer.invoke("desktopFilesystemGrants:list", opts ?? {}) as Promise<
      DesktopFilesystemGrantsIpcResult<{
        grants: ListedDesktopFilesystemGrant[];
        revision: number;
      }>
    >,
  revoke: (grantId: string) =>
    ipcRenderer.invoke("desktopFilesystemGrants:revoke", {
      grantId,
    }) as Promise<
      DesktopFilesystemGrantsIpcResult<{
        grant: DesktopFilesystemGrant;
        revision: number;
      }>
    >,
};

// ── Workstation Profile review / activation-preparation bridge ─────────
//
// Read-only-ish review operations + a narrow activation-preparation IPC for
// the shipped Developer Workstation seed. The renderer supplies NO roots, env,
// executables, or discovered facts — Electron main materializes the seed and
// runs discovery itself. This bridge never activates, never creates/updates a
// profile, never grants roots, and never calls the server activation route.

type WorkstationProfileIpcFailureCode =
  | "invalid_request"
  | "seed_invalid"
  | "discovery_failed"
  | "store_unavailable"
  | "store_corrupt"
  | "store_instance_mismatch"
  // Profile-selector activation seam failures.
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

type WorkstationProfileCapabilityEntry = {
  id: string;
  backend: ProfileCapabilityBackend;
};

type WorkstationProfileSeedDescriptor = {
  id: string;
  revision: number;
  name: string;
  protectedPolicyVersion: number;
  networkMode: ProfileNetworkMode;
  discoveryProviders: readonly ProfileDiscoveryProvider[];
  environmentKeys: readonly string[];
  capabilities: readonly WorkstationProfileCapabilityEntry[];
};

type WorkstationProfileSummary = {
  id: string;
  revision: number;
  name: string;
  protectedPolicyVersion: number;
  networkMode: ProfileNetworkMode;
  capabilities: readonly WorkstationProfileCapabilityEntry[];
  createdAt: string;
  updatedAt: string;
};

type ActiveWorkstationProfileSummary = {
  profileId: string;
  profileRevision: number;
  protectedPolicyVersion: number;
  networkMode: ProfileNetworkMode;
  capabilities: readonly WorkstationProfileCapabilityEntry[];
  compiledAt: string;
};

type WorkstationServerSessionStatus = {
  confirmed: boolean;
  session: { profileId: string; profileRevision: number } | null;
};

type WorkstationProfileSeedIdentity = {
  id: string;
  revision: number;
  protectedPolicyVersion: number;
};

type WorkstationDiscoveryRowStatus = "found" | "missing" | "optional";

type WorkstationDiscoveryRow = {
  tool: string;
  capabilityId?: string;
  provider?: ProfileDiscoveryProvider;
  status: WorkstationDiscoveryRowStatus;
  origin?: "fixed_argv" | "well_known_path" | "existing_config";
  executable?: string;
  version?: string;
  roots?: readonly string[];
  environmentKeys?: readonly string[];
  backend?: ProfileCapabilityBackend;
  note?: string;
};

type WorkstationDiscoveryReview = {
  generatedAt: string;
  platform: string;
  home: string;
  networkMode: ProfileNetworkMode;
  rows: readonly WorkstationDiscoveryRow[];
  hostNetworkImplication: string;
  hardBoundaries: readonly string[];
  summary: { found: number; optional: number; missing: number };
};

const workstationProfilesAPI = {
  getSeedDescriptor: () =>
    ipcRenderer.invoke("workstationProfiles:getSeedDescriptor") as Promise<
      WorkstationProfileIpcResult<WorkstationProfileSeedDescriptor>
    >,
  runDiscoveryReview: () =>
    ipcRenderer.invoke("workstationProfiles:runDiscoveryReview") as Promise<
      WorkstationProfileIpcResult<{
        review: WorkstationDiscoveryReview;
        seedIdentity: WorkstationProfileSeedIdentity;
      }>
    >,
  listProfiles: () =>
    ipcRenderer.invoke("workstationProfiles:listProfiles") as Promise<
      WorkstationProfileIpcResult<{
        profiles: WorkstationProfileSummary[];
        revision: number;
      }>
    >,
  getActiveProfileSummary: () =>
    ipcRenderer.invoke(
      "workstationProfiles:getActiveProfileSummary",
    ) as Promise<
      WorkstationProfileIpcResult<ActiveWorkstationProfileSummary | null>
    >,
  getServerSessionStatus: () =>
    ipcRenderer.invoke(
      "workstationProfiles:getServerSessionStatus",
    ) as Promise<WorkstationServerSessionStatus>,
  prepareActivation: () =>
    ipcRenderer.invoke("workstationProfiles:prepareActivation") as Promise<
      WorkstationProfileIpcResult<{
        seed: WorkstationProfileSeedDescriptor;
        review: WorkstationDiscoveryReview;
      }>
    >,
  materializeSeedProfile: () =>
    ipcRenderer.invoke("workstationProfiles:materializeSeedProfile") as Promise<
      WorkstationProfileIpcResult<{
        profile: WorkstationProfileSummary;
        created: boolean;
        revision: number;
      }>
    >,
  deactivateActiveProfile: () =>
    ipcRenderer.invoke(
      "workstationProfiles:deactivateActiveProfile",
    ) as Promise<
      WorkstationProfileIpcResult<{
        cleared: number;
        skipped: readonly string[];
      }>
    >,
  /**
   * select + activate an EXISTING stored Workstation Profile. The
   * renderer supplies ONLY the selected profile's id + exact revision +
   * the activating user's OWN fresh PIN. Electron main verifies the stored
   * revision, posts the profile selectors + relay binding evidence + PIN
   * to the authoritative server `/api/workstation-access/activate-profile`
   * route (which enforces the `use_workstation` capability gate
   * (`control_desktop` is no longer required for
   * activation) + the user's OWN PIN proof + the authoritative relay
   * binding), and ONLY on a 200 server proof success compiles the stored
   * profile into live policy-pack / session authority and re-advertises the
   * relay's redacted profile snapshot. The renderer never supplies roots,
   * env, executable rules, grants, subject identity, or a profile payload.
   * No offline admin PIN is required or accepted.
   */
  selectActiveProfile: (input: {
    profileId: string;
    profileRevision: number;
    pin: string;
  }) =>
    ipcRenderer.invoke(
      "workstationProfiles:selectActiveProfile",
      input,
    ) as Promise<
      WorkstationProfileIpcResult<{
        summary: ActiveWorkstationProfileSummary;
        outcome: string;
      }>
    >,
};

/**
 * renderer-safe session-permission bridge. The renderer may provide
 * only its own PIN; relay and Desktop-session identity stay in Electron main.
 */
const uncontainedHostCommandsAPI = {
  getStatus: () =>
    ipcRenderer.invoke("uncontainedHostCommands:getStatus") as Promise<{
      confirmed: boolean;
      active: boolean;
      eligible: boolean;
      reason: string | null;
      activatedAt: string | null;
    }>,
  activate: (input: { pin: string }) =>
    ipcRenderer.invoke("uncontainedHostCommands:activate", input) as Promise<
      { ok: true } | { ok: false; message: string; retryAfterMs?: number }
    >,
  disable: () =>
    ipcRenderer.invoke("uncontainedHostCommands:disable") as Promise<
      { ok: true } | { ok: false; message: string }
    >,
};

/**
 * the `currentFolder` namespace is the canonical
 * filesystem surface for the user's task-scoped folder. Phase 3 will
 * add a sibling `workspace` namespace for Genie's Workspace (Surface
 * A). Don't re-use the old `workspace` name in new code — it stays
 * aliased below only for the deprecation window.
 */
const currentFolderAPI = {
  getPath: () =>
    ipcRenderer.invoke("currentFolder:getPath") as Promise<string | null>,
  getContext: () =>
    ipcRenderer.invoke("currentFolder:getContext") as Promise<{
      currentFolder: string | null;
      relayId: string | null;
    }>,
  /** chunk 2 — commit a Recent entry (already-validated path). */
  setPath: (p: string) =>
    ipcRenderer.invoke("currentFolder:setPath", { path: p }) as Promise<void>,
  /** chunk 2 — pick + validate + commit in one round-trip. */
  pickAndCommit: () =>
    ipcRenderer.invoke("currentFolder:pickAndCommit") as Promise<string | null>,
  /** chunk 2 — recent current folders (most-recent first). */
  listRecent: () =>
    ipcRenderer.invoke("currentFolder:listRecent") as Promise<string[]>,
  /** pre-commit validator for edge paths. */
  validate: (p: string) =>
    ipcRenderer.invoke("currentFolder:validate", { path: p }) as Promise<
      { ok: true; resolved: string } | { ok: false; reason: string }
    >,
  /**
   * chunk 2 — push notification from main when any commit path
   * (dropdown / tray / native menu) changes the current folder.
   * Renderer's BrowserColumnContext subscribes so the header + file
   * tree update live without a reload. Returns an unsubscribe
   * function for unmount cleanup.
   */
  onPathChanged: (handler: (path: string) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, path: string) => handler(path);
    ipcRenderer.on("currentFolder:pathChanged", listener);
    return () => ipcRenderer.off("currentFolder:pathChanged", listener);
  },
};

/**
 * deprecation alias for `nautiloDesktop.workspace.*`.
 * One-shot warning the first time any legacy method is called; each
 * method delegates to the new IPC channel (main.ts also accepts the
 * old IPC channel names as aliases, but we prefer to route through
 * the new name at the preload layer so the main's warn-once counter
 * sees only direct legacy-IPC callers).
 *
 * `useDefault` is intentionally missing from the alias — current
 * folder has no default in . Existing callers will see a
 * TypeError if they try; that's a clear breakage surfacing a real
 * semantic shift.
 */
const deprecationWarned = new Set<string>();
function warnDeprecated(method: string): void {
  if (deprecationWarned.has(method)) return;
  deprecationWarned.add(method);

  console.warn(
    `[nautilo-desktop][deprecated] nautiloDesktop.workspace.${method} is renamed to nautiloDesktop.currentFolder.${method}.`,
  );
}

/**
 * Genie's Workspace API (Surface A). Read-only for
 * now — `getRoot` returns the always-set workspace root (default
 * `~/Documents/Nautilo/`, user-overridable via Settings in follow-up
 * work). `setRoot`, `pickAndSetRoot`, `revealInFinder`, `listRecent`,
 * `onRootChanged` land in a later commit when setRoot wires up.
 */
const genieWorkspaceAPI = {
  getRoot: () =>
    ipcRenderer.invoke("genieWorkspace:getRoot") as Promise<string | null>,
};

const workspaceAliasAPI = {
  getPath: () => {
    warnDeprecated("getPath");
    return currentFolderAPI.getPath();
  },
  setPath: (p: string) => {
    warnDeprecated("setPath");
    return currentFolderAPI.setPath(p);
  },
  pickAndCommit: () => {
    warnDeprecated("pickAndCommit");
    return currentFolderAPI.pickAndCommit();
  },
  listRecent: () => {
    warnDeprecated("listRecent");
    return currentFolderAPI.listRecent();
  },
  validate: (p: string) => {
    warnDeprecated("validate");
    return currentFolderAPI.validate(p);
  },
  onPathChanged: (handler: (path: string) => void) => {
    warnDeprecated("onPathChanged");
    return currentFolderAPI.onPathChanged(handler);
  },
};

/**
 * Logto auth bridge. The renderer's `useAuth` Electron
 * branch (Phase 9) consumes this through `desktopAPI!.auth.*`.
 *
 * `onStateChange` returns an unsubscribe fn — same shape as
 * `menu.onAction` and `currentFolder.onPathChanged` so React
 * `useEffect` cleanup works on unmount / hot-reload.
 */
const authAPI = {
  isAuthenticated: (): Promise<boolean> =>
    ipcRenderer.invoke("auth:status") as Promise<boolean>,
  getIssue: (): Promise<{
    kind: "scope-mismatch";
    expected: {
      instanceId: string;
      serverUrl: string;
      logtoEndpoint: string;
      workbenchAppId: string;
    };
    disk: {
      instanceId: string;
      serverUrl: string;
      logtoEndpoint: string;
      workbenchAppId: string;
    } | null;
  } | null> =>
    ipcRenderer.invoke("auth:issue") as Promise<{
      kind: "scope-mismatch";
      expected: {
        instanceId: string;
        serverUrl: string;
        logtoEndpoint: string;
        workbenchAppId: string;
      };
      disk: {
        instanceId: string;
        serverUrl: string;
        logtoEndpoint: string;
        workbenchAppId: string;
      } | null;
    } | null>,
  consumeNotice: (): Promise<{
    kind: "env-pinned-auth-cleared";
    expected: {
      instanceId: string;
      serverUrl: string;
      logtoEndpoint: string;
      workbenchAppId: string;
    };
    disk: {
      instanceId: string;
      serverUrl: string;
      logtoEndpoint: string;
      workbenchAppId: string;
    } | null;
  } | null> =>
    ipcRenderer.invoke("auth:notice") as Promise<{
      kind: "env-pinned-auth-cleared";
      expected: {
        instanceId: string;
        serverUrl: string;
        logtoEndpoint: string;
        workbenchAppId: string;
      };
      disk: {
        instanceId: string;
        serverUrl: string;
        logtoEndpoint: string;
        workbenchAppId: string;
      } | null;
    } | null>,
  getAccessToken: (): Promise<string | null> =>
    ipcRenderer.invoke("auth:getAccessToken") as Promise<string | null>,
  /**
   * Start the desktop Logto loopback PKCE flow (embedded BrowserWindow).
   * Resolves to `{ ok: true }` when tokens are persisted, or
   * `{ ok: false, error }` on user cancel / IdP failure.
   */
  signIn: (
    opts?: {
      extraParams?: Record<string, string>;
      theme?: "light" | "dark" | null;
    },
  ): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("auth:signIn", opts ?? {}) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  signOut: (): Promise<void> =>
    ipcRenderer.invoke("auth:signOut") as Promise<void>,
  /**
   * embedded OIDC step-up (`prompt=login` + `max_age`) for a
   * fresh access token; persists any rotated refresh token in the shell.
   */
  stepUp: (opts?: { maxAgeSeconds?: number }) =>
    ipcRenderer.invoke("auth:step-up", opts ?? {}) as Promise<
      { accessToken: string; issuedAt: number } | { error: "cancelled" }
    >,
  /**
   * P4d.9 — Ask the main process to re-probe the server's
   * `/health` endpoint and refresh the cached Logto config. Call this
   * after a `disconnected → connected` transition so a boot-time probe
   * failure (server was down, HTTPS/HTTP mismatch, etc.) recovers
   * without a full app restart. Returns `{ ok, hasLogto }`; renderers
   * may show a "reconnected" toast when `hasLogto` flips false→true.
   */
  reprobeServer: (): Promise<
    | { ok: true; hasLogto: boolean }
    | { ok: false; hasLogto: false; reason: string }
  > =>
    ipcRenderer.invoke("auth:reprobe-server") as Promise<
      | { ok: true; hasLogto: boolean }
      | { ok: false; hasLogto: false; reason: string }
    >,
  openAccountPage: (path: "/account" | "/account/password") =>
    ipcRenderer.invoke("auth:open-account-page", { path }) as Promise<
      { ok: true } | { ok: false; reason: string }
    >,
  openResetUrl: (
    url: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke("auth:openResetUrl", url) as Promise<
      { ok: true } | { ok: false; reason: string }
    >,
  onStateChange: (
    cb: (event: { state: "signed-in" | "signed-out" }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      event: { state: "signed-in" | "signed-out" },
    ) => cb(event);
    ipcRenderer.on("auth:state-change", listener);
    return () => ipcRenderer.off("auth:state-change", listener);
  },
};

/**
 * cold-boot bootstrap + static picker surface (main window only).
 */
type ShellStateOnBoot = "live" | "disconnected" | "wrong-server" | "no-pairing";

/**
 * In-app server switcher IPC.
 *
 * `openPicker` (legacy/recovery) still relaunches on commit; the Phase 3
 * `list` / `switchTo` / `add` / `close` / `onChanged` surface performs
 * real in-process switching without relaunch. `listRecent` is kept for
 * the recovery picker.
 */
const serversAPI = {
  openPicker: () => ipcRenderer.invoke("servers:open-picker") as Promise<void>,
  listRecent: () =>
    ipcRenderer.invoke("servers:list-recent") as Promise<
      Array<{ url: string; displayName?: string; lastUsedAt: string }>
    >,
  list: () =>
    ipcRenderer.invoke("servers:list") as Promise<{
      servers: Array<{
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
      }>;
      aggregate: {
        unreadCount: number;
        importantUnreadCount: number;
        unavailableServerCount: number;
      };
    }>,
  onConnectionPresentation: (cb: (snapshot: ConnectionPresentation) => void): (() => void) => {
    ipcRenderer.send("servers:subscribe-changed");
    const listener = (_event: IpcRendererEvent, snapshot: ConnectionPresentation): void => cb(snapshot);
    ipcRenderer.on("servers:connection-presentation", listener);
    return () => ipcRenderer.off("servers:connection-presentation", listener);
  },
  switchTo: (url: string, theme?: "light" | "dark" | null) =>
    ipcRenderer.invoke("servers:switchTo", url, theme ?? null) as Promise<
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
      | { ok: false; reason: "wrong-server"; decisionId: string }
    >,
  acceptIdentity: (decisionId: string) =>
    ipcRenderer.invoke("servers:accept-identity", decisionId) as Promise<
      | { ok: true }
      | { ok: false; reason: "stale" | "offline" | "incompatible" | "identity-changed-again" | "promotion-failed" }
    >,
  /** Phase 4 label: persistent footer action “Connect to server…”. */
  add: (theme?: "light" | "dark" | null) =>
    ipcRenderer.invoke("servers:add", theme ?? null) as Promise<
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
      | { ok: false; reason: "wrong-server" }
    >,
  close: (url: string) =>
    ipcRenderer.invoke("servers:close", url) as Promise<
      | { ok: true }
      | {
          ok: false;
          reason:
            | "unknown-server"
            | "offline"
            | "incompatible"
            | "fingerprint-storage-failed";
        }
      | { ok: false; reason: "wrong-server" }
    >,
  forget: (url: string) =>
    ipcRenderer.invoke("servers:forget", url) as Promise<
      | { ok: true; fallbackFailed: boolean; landedEmpty: boolean }
      | {
          ok: false;
          reason:
            | "invalid-url"
            | "unknown-server"
            | "partition-clear-failed"
            | "config-clear-failed";
        }
    >,
  onChanged: (cb: () => void): (() => void) => {
    // Subscribe once per renderer; main dedupes by webContents.id.
    ipcRenderer.send("servers:subscribe-changed");
    const listener = (): void => cb();
    ipcRenderer.on("servers:changed", listener);
    return () => {
      ipcRenderer.off("servers:changed", listener);
    };
  },
  /**
   * Phase 4 router contract: explicit switching to an already-live
   * session requests Home navigation without reloading the renderer.
   */
  onNavigateHome: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on("servers:navigate-home", listener);
    return () => {
      ipcRenderer.off("servers:navigate-home", listener);
    };
  },
};

/**
 * Main-owned active-session lifecycle. A background renderer may observe that
 * it is inactive, but never decides or requests activation itself.
 */
const activeSessionAPI = {
  onStateChange: (cb: (state: { active: boolean }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, state: { active: boolean }) =>
      cb(state);
    ipcRenderer.on("desktop:active-session-state", listener);
    // Register before asking for the replay so a synchronous main response
    // cannot race past this listener.
    ipcRenderer.send("desktop:subscribe-active-session-state");
    return () => ipcRenderer.off("desktop:active-session-state", listener);
  },
};

type ImportantMessageNotificationInput = {
  messageId: string;
  senderDisplayName: string;
  roomId: string;
  topLevelRoomId: string;
  roomLabel: string;
  parentRoomLabel?: string;
};

type NotificationNavigationTarget = {
  topLevelRoomId: string;
  subthreadRoomId?: string;
};

type NotificationSummaryInput = {
  epoch: string;
  generation: number;
  generatedAt: string;
  unreadCount: number;
  importantUnreadCount: number;
};

type NotificationDeliveryStatus = {
  state: "unsupported" | "supported" | "delivery-failed";
};

/** narrow native delivery and content-free summary bridge. */
const notificationsAPI = {
  showImportantMessage: (
    input: ImportantMessageNotificationInput,
  ): Promise<void> =>
    ipcRenderer.invoke(
      "notifications:show-important-message",
      input,
    ) as Promise<void>,
  publishSummary: (input: NotificationSummaryInput): Promise<void> =>
    ipcRenderer.invoke("notifications:publish-summary", input) as Promise<void>,
  getDeliveryStatus: (): Promise<NotificationDeliveryStatus> =>
    ipcRenderer.invoke(
      "notifications:get-delivery-status",
    ) as Promise<NotificationDeliveryStatus>,
  openSystemSettings: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("notifications:open-system-settings") as Promise<{
      ok: boolean;
    }>,
  onNavigate: (
    handler: (event: NotificationNavigationTarget) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      event: NotificationNavigationTarget,
    ) => handler(event);
    ipcRenderer.on("notifications:navigate", listener);
    return () => ipcRenderer.off("notifications:navigate", listener);
  },
  onDeliveryStatusChange: (
    handler: (status: NotificationDeliveryStatus) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      status: NotificationDeliveryStatus,
    ) => handler(status);
    ipcRenderer.on("notifications:delivery-status-changed", listener);
    return () =>
      ipcRenderer.off("notifications:delivery-status-changed", listener);
  },
};

type BrowserControlSnapshot = {
  appId: string;
  mode: "app" | "browser";
  partition: string;
  url: string;
  cdpUrl: string | null;
};

type ToolRuntimeName = "agent-browser" | "gog";
type ToolRuntimeStatus = {
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
};

const browserControlAPI = {
  onOpenRequested: (cb: (evt: { url: string }) => void) => {
    const listener = (_e: unknown, payload: { url: string }): void =>
      cb(payload);
    ipcRenderer.on("browserControl:openRequested", listener);
    return () =>
      ipcRenderer.removeListener("browserControl:openRequested", listener);
  },
  attachWebview: (args: {
    appId: string;
    mode?: "app" | "browser";
    partition: string;
    url: string;
    webContentsId: number;
  }) =>
    ipcRenderer.invoke(
      "browserControl:attachWebview",
      args,
    ) as Promise<BrowserControlSnapshot | null>,
  detachWebview: (args: { appId: string }) =>
    ipcRenderer.invoke(
      "browserControl:detachWebview",
      args,
    ) as Promise<boolean>,
  setActive: (args: { appId: string }) =>
    ipcRenderer.invoke(
      "browserControl:setActive",
      args,
    ) as Promise<BrowserControlSnapshot | null>,
  getViews: () =>
    ipcRenderer.invoke("browserControl:getViews") as Promise<
      BrowserControlSnapshot[]
    >,
  openExternal: (args: { url: string }) =>
    ipcRenderer.invoke("browserControl:openExternal", args) as Promise<void>,
  onDownload: (
    cb: (evt: { state: string; filename: string; savePath: string }) => void,
  ) => {
    const listener = (
      _e: unknown,
      payload: { state: string; filename: string; savePath: string },
    ): void => cb(payload);
    ipcRenderer.on("browserControl:download", listener);
    return () =>
      ipcRenderer.removeListener("browserControl:download", listener);
  },
};

type BrowserResearchInterventionActionResult =
  { ok: true } | { ok: false; reason: "unavailable" | "stale" };

type BrowserResearchIntervention = {
  id: string;
  toolCallId: string;
  laneKey: string;
  turnId?: string;
  authorAgentId?: string;
  state: "awaiting_choice";
  host: string;
  reason: "human-verification";
  expiresAt: string;
};

const browserResearchAPI = {
  present: (id: string) =>
    ipcRenderer.invoke("browserResearch:present", {
      id,
    }) as Promise<BrowserResearchInterventionActionResult>,
  attachSurface: (
    id: string,
    bounds: { x: number; y: number; width: number; height: number },
  ) =>
    ipcRenderer.invoke("browserResearch:attachSurface", {
      id,
      bounds,
    }) as Promise<boolean>,
  detachSurface: (id: string) =>
    ipcRenderer.invoke("browserResearch:detachSurface", {
      id,
    }) as Promise<boolean>,
  alternate: (id: string) =>
    ipcRenderer.invoke("browserResearch:alternate", {
      id,
    }) as Promise<BrowserResearchInterventionActionResult>,
  cancel: (id: string) =>
    ipcRenderer.invoke("browserResearch:cancel", {
      id,
    }) as Promise<BrowserResearchInterventionActionResult>,
  getActiveIntervention: () =>
    ipcRenderer.invoke(
      "browserResearch:getActiveIntervention",
    ) as Promise<BrowserResearchIntervention | null>,
  onIntervention: (
    handler: (intervention: BrowserResearchIntervention) => void,
  ) => {
    const listener = (
      _event: IpcRendererEvent,
      intervention: BrowserResearchIntervention,
    ): void => handler(intervention);
    ipcRenderer.on("browserResearch:intervention", listener);
    return () => ipcRenderer.off("browserResearch:intervention", listener);
  },
  onPresentRequested: (
    handler: (intervention: BrowserResearchIntervention) => void,
  ) => {
    const listener = (
      _event: IpcRendererEvent,
      intervention: BrowserResearchIntervention,
    ): void => handler(intervention);
    ipcRenderer.on("browserResearch:presentRequested", listener);
    return () => ipcRenderer.off("browserResearch:presentRequested", listener);
  },
  onSurfaceClosed: (handler: (payload: { id: string }) => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { id: string },
    ): void => handler(payload);
    ipcRenderer.on("browserResearch:surfaceClosed", listener);
    return () => ipcRenderer.off("browserResearch:surfaceClosed", listener);
  },
  onVerificationCleared: (handler: (payload: { id: string }) => void) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { id: string },
    ): void => handler(payload);
    ipcRenderer.on("browserResearch:verificationCleared", listener);
    return () =>
      ipcRenderer.off("browserResearch:verificationCleared", listener);
  },
};

/**
 * P3 — human-only save/autofill bridge for the embedded
 * browser. Exposed to the HOST (mainWindow) renderer's save/autofill UX only.
 *
 * SECURITY (R6, non-negotiable): NO method here returns or accepts a raw
 * password. `lookup` yields id+username metadata only; `commitSave`/`dismissSave`
 * address a staged credential by guest webContents id (main holds the plaintext);
 * `applyFill` tells main which match to deliver, and main sends the secret
 * straight to the guest — it is never returned across this bridge. The password
 * therefore never enters the host renderer / React tree, and — like the rest of
 * `passwords:*` — must never be exposed to any agent/tool/CDP surface.
 */
const passwordsAPI = {
  lookup: (origin: string) => {
    const req: PasswordLookupRequest = { origin };
    return ipcRenderer.invoke(
      "passwords:lookup",
      req,
    ) as Promise<PasswordLookupResult>;
  },
  commitSave: (origin: string) => {
    const req: CommitSaveRequest = { origin };
    return ipcRenderer.invoke(
      "passwords:commitSave",
      req,
    ) as Promise<PasswordActionResult>;
  },
  dismissSave: (origin: string) => {
    const req: DismissSaveRequest = { origin };
    return ipcRenderer.invoke(
      "passwords:dismissSave",
      req,
    ) as Promise<PasswordActionResult>;
  },
  applyFill: (args: { webContentsId: number; id: string }) => {
    const req: ApplyFillRequest = {
      webContentsId: args.webContentsId,
      id: args.id,
    };
    return ipcRenderer.invoke(
      "passwords:applyFill",
      req,
    ) as Promise<PasswordActionResult>;
  },
  onFormDetected: (cb: (notice: FormDetectedNotice) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, notice: FormDetectedNotice) =>
      cb(notice);
    ipcRenderer.on("passwords:formDetected", listener);
    return () => ipcRenderer.off("passwords:formDetected", listener);
  },
  getDetectedForm: (webContentsId: number) =>
    ipcRenderer.invoke("passwords:getDetectedForm", {
      webContentsId,
    }) as Promise<FormDetectedNotice["form"] | null>,
  onPendingSave: (cb: (notice: PendingSaveNotice) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, notice: PendingSaveNotice) =>
      cb(notice);
    ipcRenderer.on("passwords:pendingSave", listener);
    return () => ipcRenderer.off("passwords:pendingSave", listener);
  },
};

const toolRuntimesAPI = {
  getStatus: () =>
    ipcRenderer.invoke("toolRuntimes:getStatus") as Promise<
      Record<ToolRuntimeName, ToolRuntimeStatus>
    >,
  refresh: () =>
    ipcRenderer.invoke("toolRuntimes:refresh") as Promise<
      Record<ToolRuntimeName, ToolRuntimeStatus>
    >,
  setPath: (tool: ToolRuntimeName, runtimePath: string) =>
    ipcRenderer.invoke("toolRuntimes:setPath", {
      tool,
      path: runtimePath,
    }) as Promise<
      { ok: true; status: ToolRuntimeStatus } | { ok: false; reason: string }
    >,
  clearPath: (tool: ToolRuntimeName) =>
    ipcRenderer.invoke("toolRuntimes:clearPath", { tool }) as Promise<
      { ok: true; status: ToolRuntimeStatus } | { ok: false; reason: string }
    >,
};

// the renderer gets a deliberately tiny, data-only updater projection.
// It cannot set a channel/feed, choose an artifact, download directly, or
// install. `open()` only asks Electron main to present its native flow.
type SanitizedUpdateStatus =
  | { kind: "hidden" }
  | { kind: "available"; version: string }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "ready"; version: string }
  | { kind: "installing"; version: string };

function isSanitizedUpdateStatus(
  value: unknown,
): value is SanitizedUpdateStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as {
    kind?: unknown;
    version?: unknown;
    percent?: unknown;
  };
  if (status.kind === "hidden") return true;
  if (
    status.kind === "available" ||
    status.kind === "ready" ||
    status.kind === "installing"
  ) {
    return typeof status.version === "string";
  }
  return (
    status.kind === "downloading" &&
    typeof status.version === "string" &&
    typeof status.percent === "number" &&
    Number.isFinite(status.percent) &&
    status.percent >= 0 &&
    status.percent <= 100
  );
}

const updatesAPI = {
  getStatus: () =>
    ipcRenderer.invoke("updates:get-status") as Promise<SanitizedUpdateStatus>,
  onStatus: (
    listener: (status: SanitizedUpdateStatus) => void,
  ): (() => void) => {
    const eventListener = (_e: IpcRendererEvent, status: unknown) => {
      if (isSanitizedUpdateStatus(status)) listener(status);
    };
    ipcRenderer.on("updates:status", eventListener);
    // Register after the listener so the main-process initial snapshot cannot
    // race past this subscription. A failed registration simply means this
    // bridge remains inert; it never manufactures update state locally.
    void ipcRenderer.invoke("updates:subscribe").catch(() => undefined);
    return () => ipcRenderer.off("updates:status", eventListener);
  },
  open: () => ipcRenderer.invoke("updates:open") as Promise<void>,
};

type GoogleWorkspaceAuthStatus = {
  clientConfigOnServer: boolean;
  clientConfigLocal: boolean;
  connectedAccounts: string[];
  healthy: boolean;
  reason?: string;
};

const googleWorkspaceAPI = {
  authStatus: () =>
    ipcRenderer.invoke(
      "googleWorkspace:authStatus",
    ) as Promise<GoogleWorkspaceAuthStatus>,
  connect: (args: { email: string }) =>
    ipcRenderer.invoke("googleWorkspace:connect", args) as Promise<
      { ok: true } | { ok: false; reason: string }
    >,
  disconnect: (args: { email: string }) =>
    ipcRenderer.invoke("googleWorkspace:disconnect", args) as Promise<
      { ok: true } | { ok: false; reason: string }
    >,
};

/**
 * terminal (PTY) bridge. `create` spawns a shell in
 * main and returns its session id; `onData`/`onExit` stream output +
 * lifecycle. Subscriptions return an unsubscribe fn (React useEffect
 * cleanup) matching the menu/currentFolder pattern.
 */
type Controller = "user" | "agent";
type TerminalSessionInfo = {
  id: string;
  title: string;
  cwd: string;
  sandboxed: boolean;
  controller: Controller;
  requested: boolean;
  /** main-owned per-PTY consent; true once the user has handed this
   * one PTY to Genie (survives retake for the PTY's lifetime). */
  agentControlConsented: boolean;
};
type WriteResult =
  { ok: true } | { ok: false; reason: "no-session" | "locked" };
const terminalAPI = {
  create: (opts?: {
    cwd?: string;
    cols?: number;
    rows?: number;
    shell?: string;
  }) =>
    ipcRenderer.invoke(
      "terminal:create",
      opts ?? {},
    ) as Promise<TerminalSessionInfo>,
  attach: (sessionId: string) =>
    ipcRenderer.invoke("terminal:attach", { sessionId }) as Promise<
      | { ok: true; info: TerminalSessionInfo; scrollback: string }
      | { ok: false }
    >,
  write: (sessionId: string, data: string) =>
    ipcRenderer.invoke("terminal:write", {
      sessionId,
      data,
    }) as Promise<WriteResult>,
  setController: (sessionId: string, controller: Controller) =>
    ipcRenderer.invoke("terminal:set-controller", {
      sessionId,
      controller,
    }) as Promise<boolean>,
  /** explicit, active-sender-validated grant: records per-PTY consent
   * and transfers control to Genie atomically. The only consent-minting op. */
  grantAgentControl: (sessionId: string) =>
    ipcRenderer.invoke("terminal:grant-agent-control", {
      sessionId,
    }) as Promise<boolean>,
  clearRequest: (sessionId: string) =>
    ipcRenderer.invoke("terminal:clear-request", {
      sessionId,
    }) as Promise<boolean>,
  resize: (sessionId: string, cols: number, rows: number) =>
    ipcRenderer.invoke("terminal:resize", {
      sessionId,
      cols,
      rows,
    }) as Promise<void>,
  kill: (sessionId: string) =>
    ipcRenderer.invoke("terminal:kill", { sessionId }) as Promise<void>,
  list: () =>
    ipcRenderer.invoke("terminal:list") as Promise<TerminalSessionInfo[]>,
  onData: (
    handler: (evt: { sessionId: string; chunk: string }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      evt: { sessionId: string; chunk: string },
    ) => handler(evt);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.off("terminal:data", listener);
  },
  onExit: (
    handler: (evt: { sessionId: string; exitCode: number }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      evt: { sessionId: string; exitCode: number },
    ) => handler(evt);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.off("terminal:exit", listener);
  },
  onController: (
    handler: (evt: { sessionId: string; controller: Controller }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      evt: { sessionId: string; controller: Controller },
    ) => handler(evt);
    ipcRenderer.on("terminal:controller", listener);
    return () => ipcRenderer.off("terminal:controller", listener);
  },
  onRequest: (
    handler: (evt: { sessionId: string; requested: boolean }) => void,
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      evt: { sessionId: string; requested: boolean },
    ) => handler(evt);
    ipcRenderer.on("terminal:request", listener);
    return () => ipcRenderer.off("terminal:request", listener);
  },
};

const coldBootAPI = {
  getBootstrapState: () =>
    ipcRenderer.invoke("coldBoot:getBootstrapState") as Promise<
      | { kind: "connecting" }
      | { kind: "live"; serverUrl: string }
      | { kind: "unavailable"; serverUrl: string }
      | { kind: "malformed"; serverUrl: string }
      | {
          kind: "wrong-server";
          serverUrl: string;
        }
      | { kind: "no-pairing" }
    >,
  retry: () => ipcRenderer.invoke("coldBoot:retry") as Promise<void>,
  pairToDifferentServer: () =>
    ipcRenderer.invoke("coldBoot:pairToDifferentServer") as Promise<void>,
  useThisServerAnyway: () =>
    ipcRenderer.invoke("coldBoot:useThisServerAnyway") as Promise<void>,
  quit: () => ipcRenderer.invoke("coldBoot:quit") as Promise<void>,
};

/** GitHub CLI connection status and device-flow controls, owned by Electron. */
const githubCliAPI = {
  status: () =>
    ipcRenderer.invoke("githubCli:status") as Promise<{
      installed: boolean;
      authenticated: boolean;
      login: string | null;
      version: string | null;
      loginPending: boolean;
    }>,
  connect: () =>
    ipcRenderer.invoke("githubCli:connect") as Promise<{
      url: string;
      code: string;
    }>,
  openDevicePage: () =>
    ipcRenderer.invoke("githubCli:openDevicePage") as Promise<void>,
  cancel: () => ipcRenderer.invoke("githubCli:cancel") as Promise<void>,
};

/** only the transient Human PIN crosses; no Agent selector, SSH credential, or operation authority does. */
const structuredSshAPI = {
  status: () => ipcRenderer.invoke("structuredSsh:status") as Promise<unknown>,
  check: () => ipcRenderer.invoke("structuredSsh:check") as Promise<unknown>,
  enable: (pin: string) => ipcRenderer.invoke("structuredSsh:enable", { pin }) as Promise<unknown>,
  disable: () => ipcRenderer.invoke("structuredSsh:disable") as Promise<unknown>,
};

type ComputerUseIpcStatus = {
  state: "unavailable" | "not-enabled" | "enabled";
  reason: string | null;
  agentId: string | null;
  grantGeneration: number | null;
  canDisable: boolean;
  /** Last observed content-free, Electron-owned driver readiness. */
  providers: {
    cua:
      | { ready: true; reason: null; lifecycle: "healthy" }
      | {
        ready: false;
        /** Content-free reason for why no exact readiness-checked port exists. */
        reason: "not_installed" | "not_checked" | "checking" | "unhealthy";
        lifecycle: "not_installed" | "installed" | "starting" | "unhealthy";
      };
  };
  /** Executable Cua route, if one exists. */
  effectiveProvider: { provider: "cua" } | null;
};

type ComputerUseOwnedAgentIpc = { agentId: string; displayName: string; handle: string };

/** only a transient own-Human PIN crosses the renderer boundary. */
const computerUseAPI = {
  status: () => ipcRenderer.invoke("computerUse:status") as Promise<ComputerUseIpcStatus>,
  onStatusChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("computerUse:statusChanged", listener);
    return () => ipcRenderer.removeListener("computerUse:statusChanged", listener);
  },
  check: () => ipcRenderer.invoke("computerUse:check") as Promise<ComputerUseIpcStatus>,
  ownedAgents: () => ipcRenderer.invoke("computerUse:ownedAgents") as Promise<readonly ComputerUseOwnedAgentIpc[]>,
  enable: (pin: string, agentId: string) =>
    ipcRenderer.invoke("computerUse:enable", { pin, agentId }) as Promise<ComputerUseIpcStatus>,
  disable: () => ipcRenderer.invoke("computerUse:disable") as Promise<ComputerUseIpcStatus>,
};

const workstationShellAPI = {
  status: () =>
    ipcRenderer.invoke("workstationShell:status") as Promise<{
      workspacePath: string | null;
      consented: boolean;
      consent: "none" | "session" | "durable";
    }>,
  revoke: () => ipcRenderer.invoke("workstationShell:revoke") as Promise<void>,
};

/**
 * intentionally tiny human-only Codex Connection bridge. Main owns
 * all identity, account, runtime, workspace, and auth decisions; this sends
 * no renderer-controlled arguments across the privilege boundary.
 */
const codexConnectionAPI = {
  status: () =>
    ipcRenderer.invoke("codexConnection:status") as Promise<{
      state: "disabled" | "enabling" | "enabled" | "disabling" | "faulted";
      ready: boolean;
      relayReconciliation: "acked" | "deferred" | "failed" | null;
    }>,
  enable: () => ipcRenderer.invoke("codexConnection:enable") as Promise<void>,
  disable: () => ipcRenderer.invoke("codexConnection:disable") as Promise<void>,
};

/** Hermes keeps no resident process; this is only its durable owner choice. */
const hermesConnectionAPI = {
  status: () => ipcRenderer.invoke("hermesConnection:status") as Promise<{
    enabled: boolean;
    relay: "connected" | "starting";
  }>,
  enable: () => ipcRenderer.invoke("hermesConnection:enable") as Promise<{
    enabled: boolean;
    relay: "connected" | "starting";
  }>,
  disable: () => ipcRenderer.invoke("hermesConnection:disable") as Promise<{
    enabled: boolean;
    relay: "connected" | "starting";
  }>,
};

/**
 * deliberately narrow desired-state bridge. The selection is the only
 * renderer input; Electron derives the Human and active server binding. PINs,
 * startup receipts, credentials, roots, and owner authority stay in main.
 */
const readyToWorkAPI = {
  get: () => ipcRenderer.invoke("readyToWork:get") as Promise<ReadyToWorkAggregateStatus>,
  enroll: (input: { selection: ReadyToWorkSelection; pin: string }) =>
    ipcRenderer.invoke("readyToWork:enroll", input) as Promise<ReadyToWorkAggregateStatus>,
  restore: () => ipcRenderer.invoke("readyToWork:restore") as Promise<ReadyToWorkAggregateStatus>,
  disable: () => ipcRenderer.invoke("readyToWork:disable") as Promise<ReadyToWorkAggregateStatus>,
  onRestoreRendererOwners: (handler: (request: {
    attemptId: string;
    voice: boolean | null;
    autoApprove: boolean | null;
  }) => void) => {
    const listener = (_event: IpcRendererEvent, request: {
      attemptId: string;
      voice: boolean | null;
      autoApprove: boolean | null;
    }) => handler(request);
    ipcRenderer.on("readyToWork:restoreRendererOwners", listener);
    return () => ipcRenderer.removeListener("readyToWork:restoreRendererOwners", listener);
  },
  acknowledgeRendererOwners: (result: {
    attemptId: string;
    voice: boolean;
    autoApprove: boolean;
  }) => ipcRenderer.invoke("readyToWork:ackRendererOwners", result) as Promise<void>,
  reportRendererOwners: (result: { voice: boolean; autoApprove: boolean }) =>
    ipcRenderer.invoke("readyToWork:reportRendererOwners", result) as Promise<ReadyToWorkAggregateStatus>,
  onStatusChanged: (handler: (status: ReadyToWorkAggregateStatus) => void) => {
    const listener = (_event: IpcRendererEvent, status: ReadyToWorkAggregateStatus) => handler(status);
    ipcRenderer.on("readyToWork:statusChanged", listener);
    return () => ipcRenderer.removeListener("readyToWork:statusChanged", listener);
  },
};

/**
 * PR 1 — data-only foreground Shadow bridge. Electron main retains all
 * profile, Namespace, Grant, signing, and wrapping-key bytes; the renderer can
 * submit only ordinary product DTOs and authenticated realtime ciphertext
 * events, and receives only display projections or content-free status.
 */
const foregroundShadowAPI = {
  inspect: () =>
    ipcRenderer.invoke(
      "foregroundShadow:inspect",
    ) as Promise<ForegroundShadowInspection>,
  send: (
    roomId: string,
    body: Parameters<NautiloApiClient["sendRoomMessage"]>[1],
  ) => ipcRenderer.invoke(
    "foregroundShadow:send",
    { roomId, body },
  ) as ReturnType<NautiloApiClient["sendRoomMessage"]>,
  edit: (
    roomId: string,
    messageId: string,
    body: Readonly<{ content: string; expectedRevision: number }>,
  ) => ipcRenderer.invoke("foregroundShadow:edit", { roomId, messageId, body }) as
    Promise<Readonly<{ content: string; editRevision: number }>>,
  recoverPending: () =>
    ipcRenderer.invoke("foregroundShadow:recoverPending") as Promise<number>,
  recoverRoomPendingAttention: (input: Readonly<{
    roomId: string;
    clientActionSessionId: string;
  }>) => ipcRenderer.invoke(
    "foregroundShadow:recoverRoomPendingAttention",
    input,
  ) as Promise<RoomPendingAttentionRecoveryResponse>,
  memory: {
    list: (options?: Readonly<{
      cursor?: string; limit?: number; includeArchive?: boolean;
      room?: string; person?: string; audience?: "private";
    }>) => ipcRenderer.invoke(
      "foregroundShadow:memory:list", options,
    ),
    search: (options: Readonly<{
      q: string; mode: "text" | "semantic"; limit?: number;
      includeArchive?: boolean;
    }>) => ipcRenderer.invoke("foregroundShadow:memory:search", options),
    detail: (memoryId: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:detail", { memoryId },
    ),
    update: (input: Readonly<{
      memoryId: string; type: string; content: string; importance: number;
    }>) => ipcRenderer.invoke("foregroundShadow:memory:update", input),
    retryPendingMutations: () => ipcRenderer.invoke(
      "foregroundShadow:memory:retryPending",
    ) as Promise<number>,
    archive: (memoryId: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:archive", { memoryId },
    ),
    restore: (memoryId: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:restore", { memoryId },
    ),
    transitionTier: (memoryId: string, action: "promote" | "demote") =>
      ipcRenderer.invoke("foregroundShadow:memory:tier", { memoryId, action }),
    deleteAuthorizedView: (memoryId: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:deleteAuthorizedView", { memoryId },
    ),
    grantUser: (memoryId: string, userHandle: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:grantUser", { memoryId, userHandle },
    ),
    revokeUser: (memoryId: string, userHandle: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:revokeUser", { memoryId, userHandle },
    ),
    makePrivate: (memoryId: string) => ipcRenderer.invoke(
      "foregroundShadow:memory:makePrivate", { memoryId },
    ),
  },
  authorize: (event: LiveShadowMessageRealtimeEventV1) =>
    ipcRenderer.invoke(
      "foregroundShadow:authorize",
      { event },
    ) as Promise<boolean>,
  receive: (input: ForegroundShadowReceiveInput) =>
    ipcRenderer.invoke(
      "foregroundShadow:receive",
      input,
    ) as Promise<ForegroundShadowReceiveResult>,
  synchronizeRecipients: (
    roomId: string,
    namespaceId: string,
    keyClass?: "human" | "ai",
  ) =>
    ipcRenderer.invoke(
      "foregroundShadow:synchronizeRecipients",
      { roomId, namespaceId, keyClass },
    ) as Promise<boolean>,
  serviceDomainKeyBacklog: () =>
    ipcRenderer.invoke(
      "foregroundShadow:serviceDomainKeyBacklog",
    ) as Promise<boolean>,
  serviceBackgroundAuthorization: () =>
    ipcRenderer.invoke(
      "foregroundShadow:backgroundAuthorization:service",
    ) as Promise<void>,
  serviceMessageBackfill: (urgent?: MessageBackfillUrgentSelection) =>
    ipcRenderer.invoke(
      "foregroundShadow:messageBackfill:service",
      urgent === undefined ? {} : { urgent },
    ) as Promise<MessageBackfillBatchResult>,
  cancelMessageBackfill: () =>
    ipcRenderer.invoke(
      "foregroundShadow:messageBackfill:cancel",
    ) as Promise<void>,
  onProtectedRoomAccessState: (
    listener: (state: ProtectedRoomAccessStateV2) => void,
  ) => {
    const handler = (
      _event: IpcRendererEvent,
      state: ProtectedRoomAccessStateV2,
    ) => listener(state);
    ipcRenderer.on("foregroundShadow:protectedRoomAccess", handler);
    return () => {
      ipcRenderer.removeListener("foregroundShadow:protectedRoomAccess", handler);
    };
  },
  history: {
    reconcile: (input: ForegroundShadowHistoryReconcileInput) =>
      ipcRenderer.invoke(
        "foregroundShadow:history:reconcile",
        input,
      ) as Promise<VaultRoomHistoryShadowReadResultV1>,
  },
};

/**
 * P0 — the built guest `<webview>` preload path (a file:// URL)
 * for the embedded-browser password layer. Resolved ONCE here (sync, at preload
 * load) from main so the SaaS surface can set it as the `<webview preload>`
 * attribute at render time. `null` when main doesn't provide it (older builds).
 * This is only a local file path — NOT a credential surface. The password IPC
 * (`passwords:*`) is human-only and deliberately not exposed on this bridge in
 * P0; P3 adds the host save/autofill UX.
 */
const embeddedBrowserGuestPreloadPath: string | null = (() => {
  try {
    const value = ipcRenderer.sendSync(
      "passwords:getGuestPreloadPath",
    ) as unknown;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
})();

contextBridge.exposeInMainWorld("nautiloDesktop", {
  companion: {
    enable: binding => ipcRenderer.invoke("companion:enable", binding),
    pickFiles: generation => ipcRenderer.invoke("companion:pick-files", generation),
    disable: generation => ipcRenderer.invoke("companion:disable", generation),
    publish: (generation, snapshot) => ipcRenderer.invoke("companion:publish", generation, snapshot),
    onAction: callback => {
      const listener = (_event: IpcRendererEvent, generation: string, action: CompanionAction) => callback(generation, action);
      ipcRenderer.on("companion:action", listener);
      return () => ipcRenderer.removeListener("companion:action", listener);
    },
    onClosed: callback => {
      const listener = (_event: IpcRendererEvent, generation: string) => callback(generation);
      ipcRenderer.on("companion:closed", listener);
      return () => ipcRenderer.removeListener("companion:closed", listener);
    },
  } satisfies CompanionOwnerAPI,
  miniAppRecovery: {
    open: (input: MiniAppRecoveryOpenInput) =>
      ipcRenderer.invoke("miniAppRecovery:open", input) as Promise<{ handle: string }>,
    read: (handle: string) =>
      ipcRenderer.invoke("miniAppRecovery:read", handle) as Promise<MiniAppRecoveryReadResult>,
    write: (handle: string, input: MiniAppRecoveryWriteInput) =>
      ipcRenderer.invoke("miniAppRecovery:write", { handle, input }) as Promise<{ revision: string }>,
    close: (handle: string) =>
      ipcRenderer.invoke("miniAppRecovery:close", handle) as Promise<void>,
  },
  documentMutations: {
    readAuthoredChange: (input: { path: string; expectedSha256: string }) =>
      ipcRenderer.invoke("documentMutations:readAuthoredChange", input),
    onCommitted: (listener: DocumentMutationBatchListener) => {
      documentMutationListeners.add(listener);
      void prepareDocumentMutationEpoch();
      return () => documentMutationListeners.delete(listener);
    },
    onReconnect: (listener: DocumentMutationReconnectListener) => {
      documentMutationReconnectListeners.add(listener);
      return () => documentMutationReconnectListeners.delete(listener);
    },
    /** Local-file leases are resolved and held by the Desktop mutation runtime. */
    humanEditLeases: {
      register: (input: RegisterHumanEditLeaseRequest) =>
        ipcRenderer.invoke(
          "documentMutations:humanEditLeases:register",
          input,
        ) as Promise<HumanEditLeaseStoreResult>,
      update: (leaseId: string, input: UpdateHumanEditLeaseRequest) =>
        ipcRenderer.invoke("documentMutations:humanEditLeases:update", {
          leaseId,
          input,
        }) as Promise<HumanEditLeaseStoreResult>,
      renew: (leaseId: string, input: RenewHumanEditLeaseRequest) =>
        ipcRenderer.invoke("documentMutations:humanEditLeases:renew", {
          leaseId,
          input,
        }) as Promise<HumanEditLeaseStoreResult>,
      release: (leaseId: string, input: ReleaseHumanEditLeaseRequest) =>
        ipcRenderer.invoke("documentMutations:humanEditLeases:release", {
          leaseId,
          input,
        }) as Promise<HumanEditLeaseStoreResult>,
    },
  },
  isDesktop: true as const,
  /**
   * P0 — built guest <webview> preload path (file:// URL) for the
   * embedded-browser password layer, or null on builds that don't provide it.
   */
  embeddedBrowserGuestPreloadPath,
  /** Logto auth namespace (loopback PKCE). */
  auth: authAPI,
  /**
   * cold-boot shell classification (bootstrap + picker set this
   * before the workbench loads).
   */
  shellStateOnBoot: (): ShellStateOnBoot =>
    ipcRenderer.sendSync("coldBoot:peekShellState") as ShellStateOnBoot,
  coldBoot: coldBootAPI,
  platform: process.platform,
  /** Electron runtime version (not the Nautilo product semver). */
  electronVersion: process.versions.electron ?? "unknown",
  getVersion: () => ipcRenderer.invoke("app:getVersion") as Promise<string>,
  workbench: {
    reload: () => ipcRenderer.invoke("workbench:reload") as Promise<void>,
    isWindowFocused: () => workbenchWindowFocused,
    onWindowFocusChanged: (handler: (focused: boolean) => void) => {
      workbenchWindowFocusListeners.add(handler);
      handler(workbenchWindowFocused);
      return () => workbenchWindowFocusListeners.delete(handler);
    },
    onPrepareQuit: (handler: PrepareDesktopQuitHandler) => {
      prepareDesktopQuitListeners.add(handler);
      if (prepareDesktopQuitListeners.size === 1) {
        ipcRenderer.send("desktop:lifecycle:register-quit-guard");
      }
      return () => {
        prepareDesktopQuitListeners.delete(handler);
        if (prepareDesktopQuitListeners.size === 0) {
          for (const controller of prepareDesktopQuitControllers.values()) controller.abort();
          prepareDesktopQuitControllers.clear();
          ipcRenderer.send("desktop:lifecycle:unregister-quit-guard");
        }
      };
    },
  },
  /** optional updater affordance; all authority remains in Electron main. */
  updates: updatesAPI,

  openFolder: () =>
    ipcRenderer.invoke("dialog:openFolder") as Promise<string | null>,

  /** multi-select native file open; returns bytes (base64) to upload. */
  pickFiles: () =>
    ipcRenderer.invoke("dialog:pickFiles") as Promise<
      Array<{ name: string; sizeBytes: number; base64: string }>
    >,

  /** canonical current-folder surface. Use this in new code. */
  currentFolder: currentFolderAPI,

  /**
   * Genie's Workspace (Surface A). Distinct from
   * `currentFolder` (Surface B) and from `workspace` (deprecation
   * alias). The rename cost is worth it: three distinct namespaces
   * at the preload boundary make surface confusion impossible.
   */
  genieWorkspace: genieWorkspaceAPI,

  /** deprecated alias; remove after Phase 4 ships. */
  workspace: workspaceAliasAPI,

  /** account-menu "Switch server…" + mismatch recovery picker. */
  servers: serversAPI,
  /** active-only privileged IPC lifecycle. */
  activeSession: activeSessionAPI,

  /** macOS important-message delivery and Dock attention. */
  notifications: notificationsAPI,

  /** SaaS <webview> CDP-adoption bridge. */
  browserControl: browserControlAPI,
  /** exact opaque challenged-research lease controls. */
  browserResearch: browserResearchAPI,

  /**
   * P3 — human-only embedded-browser save/autofill bridge. No raw password
   * ever crosses this surface (see `passwordsAPI`). Must never be exposed to any
   * agent/tool/CDP path.
   */
  passwords: passwordsAPI,

  /** configured local tool runtimes (`agent-browser`, `gog`). */
  toolRuntimes: toolRuntimesAPI,

  /** Google Workspace OAuth connect / status (explicit UI only for keychain). */
  googleWorkspace: googleWorkspaceAPI,

  /** terminal (PTY) work surface bridge. */
  terminal: terminalAPI,

  /** local Desktop Filesystem Grant administration (human renderer only). */
  desktopFilesystemGrants: desktopFilesystemGrantsAPI,

  /**
   * Workstation Profile review / activation-preparation bridge
   * (human renderer only). Read-only review + seed discovery; never activates.
   */
  workstationProfiles: workstationProfilesAPI,

  /** human-only own-PIN control; no relay binding crosses renderer. */
  uncontainedHostCommands: uncontainedHostCommandsAPI,

  githubCli: githubCliAPI,
  structuredSsh: structuredSshAPI,
  computerUse: computerUseAPI,
  workstationShell: workstationShellAPI,
  /** human Connection controls; feature-detect on older builds. */
  codexConnection: codexConnectionAPI,
  /** durable Hermes owner choice; each accepted Task remains ephemeral. */
  hermesConnection: hermesConnectionAPI,
  /** current Desktop builds only; desired state is not live authority. */
  readyToWork: readyToWorkAPI,

  /** human settings surface only; no raw relay token or blocker id. */
  remoteControl: remoteControlAPI,

  /** ordinary Electron messages submitted wholly by main. */
  ordinaryChat: ordinaryChatAPI,
  /** PR 1 — main-owned foreground Shadow encryption and projection. */
  foregroundShadow: foregroundShadowAPI,
  encryptionRecovery: encryptionRecoveryAPI,

  relayStatus: {
    onChange: (cb: (status: string) => void) => {
      const listener = (_e: IpcRendererEvent, status: string) => cb(status);
      ipcRenderer.on("relay:status", listener);
      return () => ipcRenderer.removeListener("relay:status", listener);
    },
    get: () => ipcRenderer.invoke("relay:getStatus") as Promise<string>,
  },

  /**
   * persisted Electron relay identity. The renderer reads the
   * relay id that `startRelay` registered; it NEVER generates or accepts a
   * renderer-supplied replacement (a local-file focus ref's `relayId` must be
   * the exact originating relay). `null` when the relay has not been started.
   */
  relayIdentity: {
    getRelayId: () =>
      ipcRenderer.invoke("relay:getIdentity") as Promise<{
        relayId: string | null;
      }>,
  },

  // opaque, sender-owned sessions. The preload never exposes a file
  // descriptor, canonical path, or base64 conversion surface.
  binaryRead: {
    open: (filePath: string) =>
      ipcRenderer.invoke("binaryRead:open", { path: filePath }) as Promise<
        BinaryReadSessionResult<{
          id: string;
          size: number;
          chunkSize: number;
        }>
      >,
    read: (id: string, position: number) =>
      ipcRenderer.invoke("binaryRead:read", { id, position }) as Promise<
        BinaryReadSessionResult<{
          bytes: Uint8Array;
          position: number;
          done: boolean;
        }>
      >,
    close: (id: string) =>
      ipcRenderer.invoke("binaryRead:close", { id }) as Promise<
        BinaryReadSessionResult<null>
      >,
  },

  // host-only request shape. The Workbench binds documentPath;
  // sandboxed mini-apps receive only the returned opaque URL/token.
  mediaProxy: {
    importVideo: (documentPath: string) =>
      ipcRenderer.invoke("mediaProxy:importVideo", { documentPath }) as Promise<
        | { ok: true; data: { mediaRef: string; label: string; mediaKind?: "video" | "audio" | "image"; durationSec?: number; frameRate?: { numerator: number; denominator: number } } }
        | { ok: false; error: { code: string } }
      >,
    importWorkspace: (input: import("@nautilo/types").WorkspaceMediaImportInput) =>
      ipcRenderer.invoke("mediaProxy:importWorkspace", input) as Promise<
        { ok: true; data: import("@nautilo/types").WorkspaceMediaImportData } | { ok: false; error: { code: string } }
      >,
    importWorkspaceBatch: (input: import("@nautilo/types").WorkspaceMediaImportInput) =>
      ipcRenderer.invoke("mediaProxy:importWorkspaceBatch", input) as Promise<
        { ok: true; data: import("@nautilo/types").WorkspaceMediaBatchImportData } | { ok: false; error: { code: string } }
      >,
    openWorkspace: (input: import("@nautilo/types").WorkspaceMediaPreviewInput) =>
      ipcRenderer.invoke("mediaProxy:openWorkspace", input) as Promise<
        { ok: true; data: import("@nautilo/types").WorkspaceMediaPreviewData } | { ok: false; error: { code: string } }
      >,
    open: (input: { requestId: string; documentPath: string; ref: string }) =>
      ipcRenderer.invoke("mediaProxy:open", input) as Promise<
        | { ok: true; data: { url: string; mimeType: string; sizeBytes: number; revokeToken: string; waveform?: { peaks: number[]; samplesPerSecond: number } } }
        | { ok: false; error: { code: string } }
      >,
    cancel: (requestId: string) =>
      ipcRenderer.invoke("mediaProxy:cancel", { requestId }) as Promise<
        | { ok: true; data: null }
        | { ok: false; error: { code: string } }
      >,
    close: (revokeToken: string) =>
      ipcRenderer.invoke("mediaProxy:close", { revokeToken }) as Promise<
        | { ok: true; data: null }
        | { ok: false; error: { code: string } }
      >,
    onProgress: (callback: (event: { requestId: string; progress: unknown }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record["requestId"] !== "string") return;
        callback({ requestId: record["requestId"], progress: record["progress"] });
      };
      ipcRenderer.on("mediaProxy:progress", listener);
      return () => ipcRenderer.removeListener("mediaProxy:progress", listener);
    },
  },
  mediaExport: {
    supportsWorkspacePublication: true,
    supportsExportSettings: true,
    start: (input: { requestId: string; documentPath: string; expectedSha256: string; exportSettings?: import("@nautilo/types").VideoExportSettings }) => ipcRenderer.invoke("mediaExport:start", input) as Promise<
      | { ok: true; data: { status: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[] } | { status: "cancelled" } }
      | { ok: false; error: { code: string } }
    >,
    startWorkspace: (input: { requestId: string; documentContent: string; expectedSha256: string; roomId: string; sources: Array<{ mediaId: string; artifactRowId: string; artifactId: string; path: string; mimeType: string; sizeBytes: number }>; publishToWorkspace?: boolean; exportSettings?: import("@nautilo/types").VideoExportSettings }) => ipcRenderer.invoke("mediaExport:startWorkspace", input) as Promise<
      | { ok: true; data: { status: "succeeded"; label: string; sizeBytes: number; warnings: readonly unknown[]; workspace?: { status: "published" | "not_published" | "unknown"; path: string; artifactId?: string } } | { status: "cancelled" } }
      | { ok: false; error: { code: string } }
    >,
    promoteVideoProject: (input: { requestId: string; documentPath: string; expectedSha256: string; roomId: string }) =>
      ipcRenderer.invoke("mediaExport:promoteVideoProject", input) as Promise<unknown>,
    cancel: (requestId: string) => ipcRenderer.invoke("mediaExport:cancel", { requestId }) as Promise<{ ok: true; data: null } | { ok: false; error: { code: string } }>,
    onProgress: (callback: (event: { requestId: string; progress: unknown }) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record["requestId"] === "string") callback({ requestId: record["requestId"], progress: record["progress"] });
      };
      ipcRenderer.on("mediaExport:progress", listener);
      return () => ipcRenderer.removeListener("mediaExport:progress", listener);
    },
  },

  fs: {
    readDir: (dirPath: string) =>
      ipcRenderer.invoke("fs:readDir", { path: dirPath }) as Promise<
        Array<{
          name: string;
          type: string;
          sizeBytes: number;
          mtimeMs: number;
        }>
      >,
    readFile: (filePath: string) =>
      ipcRenderer.invoke("fs:readFile", { path: filePath }) as Promise<string>,
    openPath: (filePath: string) =>
      ipcRenderer.invoke("fs:openPath", { path: filePath }) as Promise<void>,
    watchRoot: (dirPath: string) =>
      ipcRenderer.invoke("fs:watchRoot", { path: dirPath }) as Promise<void>,
    unwatchRoot: (dirPath: string) =>
      ipcRenderer.invoke("fs:unwatchRoot", { path: dirPath }) as Promise<void>,
    onDirectoryChanged: (
      handler: (event: {
        rootPath: string;
        path: string;
        changedPath?: string;
        source?: "relay";
        op?: string;
        reloadRequired?: boolean;
        sha256?: string;
        clientMutationId?: string;
        patchEvent?: unknown;
      }) => void,
    ): (() => void) => {
      const listener = (
        _e: IpcRendererEvent,
        event: {
          rootPath: string;
          path: string;
          changedPath?: string;
          source?: "relay";
          op?: string;
          reloadRequired?: boolean;
          sha256?: string;
          patchEvent?: unknown;
        },
      ) => handler(event);
      ipcRenderer.on("fs:directoryChanged", listener);
      return () => ipcRenderer.off("fs:directoryChanged", listener);
    },
    stat: (filePath: string) =>
      ipcRenderer.invoke("fs:stat", { path: filePath }) as Promise<{
        exists: boolean;
        isFile: boolean;
        isDirectory: boolean;
        size: number;
        modified: string | null;
        documentIdentity: {
          kind: "local_file";
          relayId: string;
          canonicalPath: string;
        } | null;
      }>,
    writeFile: (
      filePath: string,
      content: string,
      opts?: {
        baseSha256?: string | null;
        checkpoint?: boolean;
        requestId?: string;
        clientMutationId?: string;
        anchoredPatch?: unknown;
        baseVersion?: unknown;
      },
    ) =>
      ipcRenderer.invoke("fs:writeFile", {
        path: filePath,
        content,
        baseSha256: opts?.baseSha256 ?? null,
        checkpoint: opts?.checkpoint,
        requestId: opts?.requestId,
        clientMutationId: opts?.clientMutationId,
        anchoredPatch: opts?.anchoredPatch,
        baseVersion: opts?.baseVersion,
      }) as Promise<
        | { ok: true; sha256: string; size: number }
        | {
            ok: false;
            code: "forbidden" | "conflict" | "too_large" | "error";
            currentSha256?: string;
            message?: string;
          }
      >,
    // jailed fs.mkdir / fs.rename. Mirrors writeFile's
    // result shape: { ok: true } or { ok: false, code, message? }.
    mkdir: (filePath: string) =>
      ipcRenderer.invoke("fs:mkdir", { path: filePath }) as Promise<
        | { ok: true }
        | {
            ok: false;
            code: "exists" | "forbidden" | "error";
            message?: string;
          }
      >,
    rename: (fromPath: string, toPath: string) =>
      ipcRenderer.invoke("fs:rename", {
        from: fromPath,
        to: toPath,
      }) as Promise<
        | { ok: true }
        | {
            ok: false;
            code: "exists" | "forbidden" | "error";
            message?: string;
          }
      >,
    // move a file/dir to the OS trash (recoverable delete).
    trash: (filePath: string) =>
      ipcRenderer.invoke("fs:trash", { path: filePath }) as Promise<
        | { ok: true }
        | {
            ok: false;
            code: "forbidden" | "error";
            message?: string;
          }
      >,
  },

  media: {
    getMicStatus: () =>
      ipcRenderer.invoke("media:getMicStatus") as Promise<MicStatus>,
    askForMicrophoneAccess: () =>
      ipcRenderer.invoke("media:askMic") as Promise<MicStatus>,
    openSystemMicSettings: () =>
      ipcRenderer.invoke("shell:openSystemMicSettings") as Promise<void>,
  },

  systemPermissions: systemPermissionsAPI,

  menu: {
    /**
     * Subscribe to main-process menu clicks. Returns an unsubscribe
     * function the renderer can call on unmount so we don't leak
     * listeners on hot-reload / component re-mount.
     */
    onAction: (handler: (action: MenuAction) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, action: MenuAction) =>
        handler(action);
      ipcRenderer.on("menu:action", listener);
      return () => ipcRenderer.off("menu:action", listener);
    },
  },

  // fire-and-forget log forwarding into the main-process
  // electron-log pipeline so renderer-side problems land in main.log
  // alongside desktop-main events. ipcRenderer.send (not invoke) so
  // logging never blocks the renderer on main-process backpressure.
  logger: {
    info: (msg: string) => ipcRenderer.send("log", "info", msg),
    warn: (msg: string) => ipcRenderer.send("log", "warn", msg),
    error: (msg: string) => ipcRenderer.send("log", "error", msg),
  },

  // Settings → Personalize your Genie re-trigger.
  //
  // open() asks main to hide this workbench window and open the
  // onboarding wizard against the existing profile. Main resolves
  // when the wizard completes (Continue on Reveal) OR rejects when
  // the user closes the wizard window without completing — either
  // way main.then-finally always pushes "onboarding:completed"
  // back so the workbench can refetch profile state and update
  // the UI even on cancel paths.
  //
  // onCompleted() returns a tear-down function so React useEffect
  // cleanup can detach the listener cleanly on unmount /
  // re-render, matching the menu.onAction pattern above.
  onboarding: {
    /**
     * @param _accessTokenArg Ignored . The wizard uses the
     * main-process Logto token store; workbench may still pass
     * `getAccessToken` for API shape compatibility.
     * @param theme Workbench's active theme (from
     * `localStorage["nautilo-theme"]`). Main sets
     * `nativeTheme.themeSource` for the wizard's lifetime so
     * the wizard's `prefers-color-scheme` CSS resolves to the
     * user's chosen theme. `null` falls back to OS preference.
     */
    open: (
      _accessTokenArg: string | null,
      theme: "light" | "dark" | null,
      options?: { startAt?: "personality" | "avatar" },
    ): Promise<void> =>
      ipcRenderer.invoke(
        "onboarding:open",
        _accessTokenArg,
        theme,
        options ?? null,
      ) as Promise<void>,
    onCompleted: (handler: () => void): (() => void) => {
      const listener = () => handler();
      ipcRenderer.on("onboarding:completed", listener);
      return () => ipcRenderer.off("onboarding:completed", listener);
    },
  },

  /** `nautilo://` deep links forwarded from main. */
  deepLink: {
    onReceived: (
      cb: (link: { kind: string; payload: Record<string, string> }) => void,
    ): (() => void) => {
      const handler = (_e: IpcRendererEvent, link: unknown) =>
        cb(link as { kind: string; payload: Record<string, string> });
      ipcRenderer.on("deep-link:received", handler);
      return () => {
        ipcRenderer.removeListener("deep-link:received", handler);
      };
    },
  },
});

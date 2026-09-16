import type {
  DeviceAdmissionChallengeDto,
  DeviceAdmissionProofRequest,
} from "@nautilo/api-client/browser";

export interface WorkbenchRecoveryKitPresentation {
  readonly documentHeader: string;
  revealMnemonic(): string;
}

export type WorkbenchRecoveryKitPresentationResult =
  | Readonly<{ status: "confirmed" }>
  | Readonly<{ status: "cancelled" }>;

export interface WorkbenchEncryptionDeviceRoster {
  readonly formatVersion: 1;
  readonly currentDeviceId: string;
  readonly currentMemberCount: number;
  readonly devices: readonly Readonly<{
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

export type WorkbenchEncryptionRecoveryReadiness =
  | Readonly<{
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
  }>
  | Readonly<{ status: "setup_required" | "setup_pending" }>
  | Readonly<{
    status: "additional_device_required";
    enrollmentStatus?: "required" | "waiting_for_approval" | "syncing";
    syncReason?: "delivery_pending" | "current_domain_sync_required"
      | "personal_authority_required";
    operationId?: string;
    verificationCode?: string;
  }>
  | Readonly<{
    status: "reset_required";
    reason: "server_identity_missing";
  }>
  | Readonly<{
    status: "recovery_required";
    reason: "stale_device" | "removed_device";
  }>
  | Readonly<{
    status: "unavailable";
    reason: "identity_invalid" | "custody_unavailable" | "custody_conflict";
  }>;

export interface WorkbenchEncryptionRecoveryReadinessPort {
  inspect(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  deviceAdmissionDeviceId?(): Promise<string | null>;
  signDeviceAdmissionChallenge?(
    challenge: DeviceAdmissionChallengeDto,
  ): Promise<DeviceAdmissionProofRequest["proof"]>;
  resetLocalSetup?(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  continueAdditionalDevice?(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  approveAdditionalDevice?(
    operationId: string,
    verificationCode: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  advanceAdditionalDevice?(
    operationId: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  listEncryptionDevices?(): Promise<WorkbenchEncryptionDeviceRoster>;
  removeEncryptionDevice?(
    deviceId: string,
    pin: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  recoverEncryptionDevice?(
    mnemonic: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  reconnectEncryptionDevice?(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  setup(
    present: (
      presentation: WorkbenchRecoveryKitPresentation,
    ) => WorkbenchRecoveryKitPresentationResult
      | Promise<WorkbenchRecoveryKitPresentationResult>,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
}

let registered: WorkbenchEncryptionRecoveryReadinessPort | undefined;

export function registerWorkbenchEncryptionRecoveryReadiness(
  port: WorkbenchEncryptionRecoveryReadinessPort,
): () => void {
  registered = port;
  return () => {
    if (registered === port) registered = undefined;
  };
}

export function currentWorkbenchEncryptionRecoveryReadiness():
WorkbenchEncryptionRecoveryReadinessPort | undefined {
  return registered;
}

export function createDesktopEncryptionRecoveryReadinessPort(main: Readonly<{
  inspect(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  deviceAdmissionDeviceId(): Promise<string | null>;
  signDeviceAdmissionChallenge(
    challenge: DeviceAdmissionChallengeDto,
  ): Promise<DeviceAdmissionProofRequest["proof"]>;
  resetLocalSetup(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  continueAdditionalDevice(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  approveAdditionalDevice(
    operationId: string,
    verificationCode: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  advanceAdditionalDevice(
    operationId: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  listEncryptionDevices(): Promise<WorkbenchEncryptionDeviceRoster>;
  removeEncryptionDevice(
    deviceId: string,
    pin: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  recoverEncryptionDevice?(
    mnemonic: string,
  ): Promise<WorkbenchEncryptionRecoveryReadiness>;
  reconnectEncryptionDevice?(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  setup(): Promise<WorkbenchEncryptionRecoveryReadiness>;
  resolvePresentation(input: Readonly<{
    presentationId: string;
    status: "confirmed" | "cancelled";
  }>): Promise<void>;
  onPresentation(listener: (value: Readonly<{
    presentationId: string;
    documentHeader: string;
    mnemonic: string;
  }>) => void): () => void;
}>): WorkbenchEncryptionRecoveryReadinessPort {
  return Object.freeze({
    inspect: () => main.inspect(),
    deviceAdmissionDeviceId: () => main.deviceAdmissionDeviceId(),
    signDeviceAdmissionChallenge: (challenge: DeviceAdmissionChallengeDto) =>
      main.signDeviceAdmissionChallenge(challenge),
    resetLocalSetup: () => main.resetLocalSetup(),
    continueAdditionalDevice: () => main.continueAdditionalDevice(),
    approveAdditionalDevice: (operationId: string, verificationCode: string) =>
      main.approveAdditionalDevice(operationId, verificationCode),
    advanceAdditionalDevice: (operationId: string) =>
      main.advanceAdditionalDevice(operationId),
    listEncryptionDevices: () => main.listEncryptionDevices(),
    removeEncryptionDevice: (deviceId: string, pin: string) =>
      main.removeEncryptionDevice(deviceId, pin),
    ...(main.recoverEncryptionDevice === undefined ? {} : {
      recoverEncryptionDevice: (mnemonic: string) =>
        main.recoverEncryptionDevice!(mnemonic),
    }),
    ...(main.reconnectEncryptionDevice === undefined ? {} : {
      reconnectEncryptionDevice: () => main.reconnectEncryptionDevice!(),
    }),
    async setup(
      present: Parameters<WorkbenchEncryptionRecoveryReadinessPort["setup"]>[0],
    ) {
      let presentationFailure: unknown;
      const unsubscribe = main.onPresentation((value) => {
        let mnemonic: string | undefined = value.mnemonic;
        void Promise.resolve().then(() => present({
          documentHeader: value.documentHeader,
          revealMnemonic() {
            if (mnemonic === undefined) {
              throw new Error("Recovery kit presentation is no longer available");
            }
            return mnemonic;
          },
        })).then(async (result: WorkbenchRecoveryKitPresentationResult) => {
          mnemonic = undefined;
          await main.resolvePresentation({
            presentationId: value.presentationId,
            ...result,
          });
        }).catch(async (error: unknown) => {
          mnemonic = undefined;
          presentationFailure = error;
          await main.resolvePresentation({
            presentationId: value.presentationId,
            status: "cancelled",
          }).catch(() => undefined);
        });
      });
      try {
        const result = await main.setup();
        if (presentationFailure !== undefined) {
          throw presentationFailure instanceof Error
            ? presentationFailure
            : new Error("Recovery kit presentation failed", {
              cause: presentationFailure,
            });
        }
        return result;
      } finally {
        unsubscribe();
      }
    },
  });
}

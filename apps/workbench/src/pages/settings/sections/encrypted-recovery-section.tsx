import { useEffect, useRef, useState } from "react";

import { useAuth } from "../../../hooks/use-auth";
import {
  currentWorkbenchEncryptionRecoveryReadiness,
  type WorkbenchEncryptionRecoveryReadiness,
  type WorkbenchEncryptionRecoveryReadinessPort,
  type WorkbenchEncryptionDeviceRoster,
  type WorkbenchRecoveryKitPresentation,
  type WorkbenchRecoveryKitPresentationResult,
} from "../../../lib/encryption-recovery-readiness";
import { copyTextToClipboard } from "../../../lib/copy-to-clipboard";
import { isCryptoAdmissionAllowed, requestCryptoAdmissionRefresh } from "../../../lib/crypto-admission-access";
import { Button, SectionCard, TextInput } from "../ui";
import { PersonalEncryptionCoverageCard } from "./personal-encryption-coverage-card";

interface ActivePresentation {
  readonly header: string;
  readonly mnemonic: string;
  readonly resolve: (result: WorkbenchRecoveryKitPresentationResult) => void;
}

type RecoveryPhraseCopyState = "idle" | "copying" | "copied" | "failed";

type EncryptionDevice = WorkbenchEncryptionDeviceRoster["devices"][number];

function deviceMembershipCopy(device: EncryptionDevice): string {
  switch (device.membershipState) {
    case "current":
      return "Roster membership: Current";
    case "catching_up":
      return "Roster membership: Catching up";
    case "welcome_pending":
      return "Roster membership: Awaiting completion";
    case "removed":
      return "Roster membership: Removed";
    case "stale":
      return "Roster membership: Stale";
    case "pending":
      return "Roster membership: Pending";
  }
}

function DeviceHealthDetails({
  device,
  localCustodyReady,
  personalAuthorityReady,
}: Readonly<{
  device: EncryptionDevice;
  localCustodyReady: boolean;
  personalAuthorityReady: boolean;
}>) {
  const coverage = device.domainKeyCoverage;
  const delivery = device.deliveryEvidence;
  return (
    <div className="mt-2 space-y-1 text-xs text-foreground-muted">
      <p>{deviceMembershipCopy(device)}</p>
      <p>
        Fingerprint: <span className="font-mono">
          {device.publicFingerprintBase64url.slice(0, 12)}…
        </span>
      </p>
      {device.isCurrentDevice ? (
        <>
          <p>Local key custody: {localCustodyReady ? "Available" : "Waiting"}</p>
          <p>
            Personal encryption authority: {personalAuthorityReady
              ? "Available" : "Waiting"}
          </p>
        </>
      ) : (
        <p>Local key custody: Verifiable only on that device</p>
      )}
      {device.membershipEvidence === null ? (
        <p>MLS evidence: Unavailable</p>
      ) : (
        <>
          <p>
            MLS evidence: Lineage {device.membershipEvidence.lineageGeneration}, epoch {device.membershipEvidence.epoch}, security revision {device.membershipEvidence.securityRevision}, acknowledged sequence {device.membershipEvidence.acknowledgedSequence}
          </p>
          <p>
            MLS head: <span className="font-mono">
              {device.membershipEvidence.headDigestBase64url.slice(0, 12)}…
            </span>
          </p>
        </>
      )}
      <p>
        Current Domain keys acknowledged: {coverage.acknowledged} of {coverage.required}
      </p>
      <p>
        Key delivery: {delivery.acknowledgedSequence} of {delivery.highWatermark} acknowledged
      </p>
      {delivery.blocked === null ? null : (
        <p className="text-[var(--warning)]" role="status">
          Delivery {delivery.blocked.sequence} is blocked: {delivery.blocked.reason}
        </p>
      )}
      <p>
        Active session proof: {device.admissionEvidence === null
          ? "None"
          : `${new Date(device.admissionEvidence.lastProvedAt).toLocaleString()} · valid until ${new Date(device.admissionEvidence.expiresAt).toLocaleString()}`}
      </p>
    </div>
  );
}

const ADDITIONAL_DEVICE_STEPS = Object.freeze([
  "Request connection",
  "Approve on a connected device",
  "Receive and verify device identity",
  "Finish device connection",
] as const);

function additionalDeviceStep(
  readiness: Extract<WorkbenchEncryptionRecoveryReadiness, {
    status: "additional_device_required";
  }>,
): number {
  if (readiness.enrollmentStatus === "waiting_for_approval") return 2;
  if (readiness.enrollmentStatus === "syncing") {
    return readiness.syncReason === "delivery_pending" ? 3 : 4;
  }
  return 1;
}

function additionalDeviceCopy(
  readiness: Extract<WorkbenchEncryptionRecoveryReadiness, {
    status: "additional_device_required";
  }>,
): string {
  if (readiness.enrollmentStatus === "waiting_for_approval") {
    return "Compare this code on an already connected device, then approve this device there. This page will continue automatically.";
  }
  if (readiness.enrollmentStatus === "syncing") {
    if (readiness.syncReason === "current_domain_sync_required") {
      return "Room encryption membership changed while this device was connecting. It remains safely blocked until an existing device finishes that membership update.";
    }
    if (readiness.syncReason === "delivery_pending") {
      return "The approval matched. This device is receiving and verifying its signed device identity.";
    }
    if (readiness.syncReason === "personal_authority_required") {
      return "The device identity is connected. Waiting for another connected device to share the small personal encryption authority needed to create new work. This page retries automatically.";
    }
    return "The device identity arrived. An existing device is finishing the connection.";
  }
  return "Connect this device through an already enrolled Browser or Desktop.";
}

function reasonCopy(
  reason: Extract<WorkbenchEncryptionRecoveryReadiness, {
    status: "unavailable";
  }>["reason"],
): string {
  switch (reason) {
    case "identity_invalid":
      return "Your signed-in Human identity could not be verified for encrypted recovery.";
    case "custody_conflict":
      return "This device has a different encrypted setup in progress. Reload before trying again.";
    case "custody_unavailable":
      return "Secure local storage is unavailable. No recovery phrase or device key was saved.";
  }
}

export function EncryptedRecoverySection({
  readinessPort,
  showPersonalCoverage = true,
}: Readonly<{
  readinessPort?: WorkbenchEncryptionRecoveryReadinessPort;
  showPersonalCoverage?: boolean;
}> = {}) {
  const auth = useAuth();
  const port = readinessPort
    ?? currentWorkbenchEncryptionRecoveryReadiness();
  const [readiness, setReadiness] = useState<
    WorkbenchEncryptionRecoveryReadiness | null
  >(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presentation, setPresentation] = useState<ActivePresentation | null>(
    null,
  );
  const [recoveryPhraseAcknowledged, setRecoveryPhraseAcknowledged] =
    useState(false);
  const [recoveryPhraseCopyState, setRecoveryPhraseCopyState] =
    useState<RecoveryPhraseCopyState>("idle");
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [deviceRoster, setDeviceRoster] = useState<
    WorkbenchEncryptionDeviceRoster | null
  >(null);
  const [removingDeviceId, setRemovingDeviceId] = useState<string | null>(null);
  const [removalPin, setRemovalPin] = useState("");
  const [recoveryMnemonic, setRecoveryMnemonic] = useState("");
  const activePresentation = useRef<ActivePresentation | null>(null);
  const automaticRefreshInFlight = useRef(false);

  useEffect(() => {
    // Enrollment/recovery completion replaces the old gate polling trigger.
    // Local readiness only asks for server reproof; it never grants admission.
    if (readiness?.status === "active" && !isCryptoAdmissionAllowed()) {
      requestCryptoAdmissionRefresh("device_ready");
    }
  }, [readiness?.status]);

  useEffect(() => {
    activePresentation.current = presentation;
  }, [presentation]);

  useEffect(() => () => {
    activePresentation.current?.resolve({ status: "cancelled" });
    activePresentation.current = null;
  }, []);

  useEffect(() => {
    if (!auth.viewer.isVerified || auth.viewer.staleWhoami || port === undefined) {
      setReadiness(null);
      return;
    }
    let current = true;
    setLoading(true);
    void port.inspect().then((result) => {
      if (current) setReadiness(result);
    }).catch((cause: unknown) => {
      if (current) {
        setError(cause instanceof Error
          ? cause.message
          : "Encrypted recovery status could not be loaded.");
      }
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [auth.viewer.isVerified, auth.viewer.staleWhoami, port]);

  const readinessSyncReason = readiness?.status === "additional_device_required"
    ? readiness.syncReason
    : undefined;

  useEffect(() => {
    const canListDevices = readiness?.status === "active"
      || (readiness?.status === "additional_device_required"
        && readinessSyncReason === "personal_authority_required");
    if (!canListDevices
      || port?.listEncryptionDevices === undefined) {
      setDeviceRoster(null);
      return;
    }
    let current = true;
    void port.listEncryptionDevices().then((result) => {
      if (current) setDeviceRoster(result);
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error
        ? cause.message
        : "Connected encryption devices could not be loaded.");
    });
    return () => {
      current = false;
    };
  }, [port, readiness?.status, readinessSyncReason]);

  const targetEnrollmentPending = readiness?.status === "additional_device_required"
    && readiness.enrollmentStatus !== "required"
    && readiness.syncReason !== "personal_authority_required";
  const approvalDiscoveryEnabled = readiness?.status === "active"
    || (readiness?.status === "additional_device_required"
      && readiness.syncReason === "personal_authority_required");

  useEffect(() => {
    if (port === undefined
      || (!targetEnrollmentPending && !approvalDiscoveryEnabled)) return;
    let current = true;
    const refresh = async () => {
      if (automaticRefreshInFlight.current || loading) return;
      automaticRefreshInFlight.current = true;
      try {
        const result = targetEnrollmentPending
          && port.continueAdditionalDevice !== undefined
          ? await port.continueAdditionalDevice()
          : await port.inspect();
        if (current) {
          setReadiness(result);
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(cause instanceof Error
            ? cause.message
            : "Device connection status could not be refreshed.");
        }
      } finally {
        automaticRefreshInFlight.current = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    const interval = window.setInterval(() => void refresh(), 3_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      current = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [approvalDiscoveryEnabled, loading, port, targetEnrollmentPending]);

  function presentRecoveryKit(
    value: WorkbenchRecoveryKitPresentation,
  ): Promise<WorkbenchRecoveryKitPresentationResult> {
    return new Promise((resolve) => {
      const next = {
        header: value.documentHeader,
        mnemonic: value.revealMnemonic(),
        resolve,
      };
      activePresentation.current = next;
      setRecoveryPhraseAcknowledged(false);
      setRecoveryPhraseCopyState("idle");
      setPresentation(next);
    });
  }

  async function start(): Promise<void> {
    if (port === undefined || loading || presentation !== null) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.setup(presentRecoveryKit));
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "Encrypted recovery setup did not complete.");
    } finally {
      activePresentation.current = null;
      setPresentation(null);
      setRecoveryPhraseAcknowledged(false);
      setRecoveryPhraseCopyState("idle");
      setLoading(false);
    }
  }

  async function resetLocalSetup(): Promise<void> {
    if (port?.resetLocalSetup === undefined || loading) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.resetLocalSetup());
      setConfirmingReset(false);
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "The stale local encryption setup could not be removed.");
    } finally {
      setLoading(false);
    }
  }

  async function continueAdditionalDevice(): Promise<void> {
    if (port?.continueAdditionalDevice === undefined || loading) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.continueAdditionalDevice());
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "This device could not continue encrypted setup.");
    } finally {
      setLoading(false);
    }
  }

  async function reconnectEncryptionDevice(): Promise<void> {
    if (port?.reconnectEncryptionDevice === undefined || loading) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.reconnectEncryptionDevice());
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "This device could not request a fresh encrypted connection.");
    } finally {
      setLoading(false);
    }
  }

  async function approveAdditionalDevice(
    operationId: string,
    verificationCode: string,
  ): Promise<void> {
    if (port?.approveAdditionalDevice === undefined || loading) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.approveAdditionalDevice(
        operationId,
        verificationCode,
      ));
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "The additional device could not be approved.");
    } finally {
      setLoading(false);
    }
  }

  async function advanceAdditionalDevice(operationId: string): Promise<void> {
    if (port?.advanceAdditionalDevice === undefined || loading) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.advanceAdditionalDevice(operationId));
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "Encrypted key synchronization could not continue.");
    } finally {
      setLoading(false);
    }
  }

  async function removeEncryptionDevice(): Promise<void> {
    if (port?.removeEncryptionDevice === undefined || removingDeviceId === null
      || loading || !/^\d{6,8}$/u.test(removalPin)) return;
    const target = removingDeviceId;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.removeEncryptionDevice(target, removalPin));
      setDeviceRoster(port.listEncryptionDevices === undefined
        ? null
        : await port.listEncryptionDevices());
      setRemovingDeviceId(null);
      setRemovalPin("");
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "The encryption device could not be removed.");
    } finally {
      setLoading(false);
    }
  }

  async function recoverEncryptionDevice(): Promise<void> {
    if (port?.recoverEncryptionDevice === undefined || loading
      || recoveryMnemonic.trim().length === 0) return;
    setLoading(true);
    setError(null);
    try {
      setReadiness(await port.recoverEncryptionDevice(
        recoveryMnemonic.trim(),
      ));
      setRecoveryMnemonic("");
    } catch (cause) {
      setError(cause instanceof Error
        ? cause.message
        : "This device could not be recovered from the phrase.");
    } finally {
      setLoading(false);
    }
  }

  function confirm(): void {
    if (presentation === null || !recoveryPhraseAcknowledged) {
      return;
    }
    presentation.resolve({ status: "confirmed" });
    activePresentation.current = null;
    setPresentation(null);
    setRecoveryPhraseAcknowledged(false);
    setRecoveryPhraseCopyState("idle");
  }

  function cancel(): void {
    presentation?.resolve({ status: "cancelled" });
    activePresentation.current = null;
    setPresentation(null);
    setRecoveryPhraseAcknowledged(false);
    setRecoveryPhraseCopyState("idle");
  }

  async function copyRecoveryPhrase(): Promise<void> {
    if (presentation === null || recoveryPhraseCopyState === "copying") return;
    const currentPresentation = presentation;
    setRecoveryPhraseCopyState("copying");
    let copied = false;
    try {
      copied = await copyTextToClipboard(currentPresentation.mnemonic);
    } catch {
      copied = false;
    }
    if (activePresentation.current !== currentPresentation) return;
    setRecoveryPhraseCopyState(copied ? "copied" : "failed");
  }

  return (
    <SectionCard
      id="encrypted-recovery"
      title="Encryption"
      description="Protect this device with a one-time offline recovery phrase and manage its encrypted connection."
    >
      {!auth.viewer.isVerified ? (
        <p className="text-sm text-foreground-muted">
          Sign in to set up encrypted recovery for this device.
        </p>
      ) : auth.viewer.staleWhoami ? (
        <p className="text-sm text-foreground-muted">
          Reconnect to verify your identity before changing encrypted recovery.
        </p>
      ) : port === undefined ? (
        <p className="text-sm text-foreground-muted">
          Encrypted recovery setup is unavailable in this client build.
        </p>
      ) : presentation !== null ? (
        <div className="space-y-4">
          <div className="rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
            <p className="text-sm font-medium text-foreground">
              Save this phrase offline
            </p>
            <p className="mt-1 text-xs text-foreground-muted">
              Anyone with this phrase can recover your encrypted data. If you lose every usable device and this phrase, your encrypted data may be unrecoverable. It is shown only during this acknowledgement step.
            </p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-foreground-muted">
                {presentation.header}
              </p>
              <Button
                variant="ghost"
                onClick={() => void copyRecoveryPhrase()}
                disabled={recoveryPhraseCopyState === "copying"}
              >
                {recoveryPhraseCopyState === "copying" ? "Copying…"
                  : recoveryPhraseCopyState === "copied" ? "Copied"
                  : "Copy phrase"}
              </Button>
            </div>
            <pre
              data-testid="encrypted-recovery-mnemonic"
              className="mt-2 whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-sm text-foreground"
            >
              {presentation.mnemonic}
            </pre>
            {recoveryPhraseCopyState === "copied" ? (
              <p className="mt-2 text-xs text-foreground-muted" role="status">
                Copied to clipboard.
              </p>
            ) : recoveryPhraseCopyState === "failed" ? (
              <p className="mt-2 text-xs text-[var(--error)]" role="alert">
                Copy failed. Select the phrase and copy it manually.
              </p>
            ) : null}
          </div>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={recoveryPhraseAcknowledged}
              onChange={(event) =>
                setRecoveryPhraseAcknowledged(event.target.checked)}
            />
            <span>I saved this recovery phrase somewhere safe</span>
          </label>
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={confirm}
              disabled={!recoveryPhraseAcknowledged}
            >
              Continue
            </Button>
            <Button variant="ghost" onClick={cancel}>Cancel</Button>
          </div>
        </div>
      ) : readiness?.status === "active" ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground" role="status">
            This device has usable local encryption keys.
          </p>
          <p className="text-sm text-foreground-muted">
            {readiness.encryptionSetup === "v2_personal_authority_ready"
              ? "Its offline recovery phrase, device identity, and personal encryption authority are ready. Encryption keys for other existing Rooms are loaded only when this device needs them; a Room may briefly use plaintext Shadow fallback while it waits for any authorized participant device."
              : readiness.encryptionSetup === "human_domain_active"
              ? "Its offline recovery phrase was acknowledged and its Human encryption identity is available. Private Rooms can be prepared separately when encrypted writing needs them; shared Rooms may still require encrypted key delivery from their other participants."
              : "Its offline recovery phrase was acknowledged and encrypted setup can continue automatically when needed."}
          </p>
          {(readiness.pendingAdditionalDevices?.length ?? 0) > 0 ? (
            <div className="space-y-3">
              {readiness.pendingAdditionalDevices?.map((candidate) => (
                <div
                  key={candidate.operationId}
                  className="rounded-md border border-border bg-background p-3"
                >
                  <p className="text-sm font-medium text-foreground">
                    Connect {candidate.clientKind === "electron"
                      ? "Desktop" : "Browser"}
                  </p>
                  {candidate.verificationCode ? (
                    <p className="mt-2 font-mono text-sm text-foreground">
                      {candidate.verificationCode}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-foreground-muted">
                    {candidate.progress === "approval_required"
                      ? "Compare this code with the new device, then approve it."
                      : candidate.progress === "awaiting_target"
                      ? "The new device must continue setup to receive its signed device identity."
                      : "Continue the signed device connection."}
                  </p>
                  {candidate.progress === "approval_required"
                    && candidate.verificationCode ? (
                    <div className="mt-3">
                      <Button
                        onClick={() => void approveAdditionalDevice(
                          candidate.operationId,
                          candidate.verificationCode!,
                        )}
                        loading={loading}
                      >
                        Approve matching code
                      </Button>
                    </div>
                  ) : candidate.progress === "transfer_ready" ? (
                    <div className="mt-3">
                      <Button
                        onClick={() => void advanceAdditionalDevice(
                          candidate.operationId,
                        )}
                        loading={loading}
                      >
                        Finish device connection
                      </Button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {deviceRoster !== null ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Encryption device health
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  Roster membership, local custody, personal authority, session admission, and Domain-key delivery are separate checks. A device can be removed only from another roster member; your final device is protected.
                </p>
              </div>
              {deviceRoster.devices.map((device) => (
                <div
                  key={`${device.deviceId}:${device.deviceGeneration}`}
                  className="rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {device.clientKind === "electron" ? "Desktop"
                          : device.clientKind === "browser" ? "Browser" : "Device"}
                        {device.isCurrentDevice ? " · This device" : ""}
                      </p>
                      <DeviceHealthDetails
                        device={device}
                        localCustodyReady
                        personalAuthorityReady={readiness.encryptionSetup
                          === "v2_personal_authority_ready"}
                      />
                    </div>
                    {device.canRemove && removingDeviceId !== device.deviceId ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRemovingDeviceId(device.deviceId);
                          setRemovalPin("");
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                  {removingDeviceId === device.deviceId ? (
                    <div className="mt-3 space-y-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
                      <p className="text-sm text-foreground">
                        This device will stop receiving future encrypted keys. Existing information it already opened cannot be taken back. Enter your PIN to confirm.
                      </p>
                      <TextInput
                        value={removalPin}
                        onChange={setRemovalPin}
                        ariaLabel="PIN to remove encryption device"
                        type="password"
                        inputMode="numeric"
                        autoComplete="current-password"
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          onClick={() => void removeEncryptionDevice()}
                          loading={loading}
                          disabled={!/^\d{6,8}$/u.test(removalPin)}
                        >
                          Remove device
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setRemovingDeviceId(null);
                            setRemovalPin("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {error ? <p className="text-sm text-[var(--error)]" role="alert">{error}</p> : null}
        </div>
      ) : readiness?.status === "reset_required" ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--warning)]" role="alert">
            This client has encryption keys from a server instance that no longer recognizes this device. They will not encrypt new data here.
          </p>
          {confirmingReset ? (
            <div className="space-y-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
              <p className="text-sm text-foreground">
                Remove only this client&apos;s stale local keys? This cannot recover encrypted data from the deleted server. You will create a new recovery phrase next.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => void resetLocalSetup()}
                  loading={loading}
                  disabled={port.resetLocalSetup === undefined}
                >
                  Remove stale keys
                </Button>
                <Button variant="ghost" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => setConfirmingReset(true)}
              disabled={port.resetLocalSetup === undefined}
            >
              Reset this device&apos;s encryption setup
            </Button>
          )}
          {error ? <p className="text-sm text-[var(--error)]" role="alert">{error}</p> : null}
        </div>
      ) : readiness?.status === "recovery_required" ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--warning)]" role="status">
            {readiness.reason === "removed_device"
              ? "This device was removed from your encrypted device group."
              : "This device no longer has usable encrypted membership state."}
          </p>
          {port.reconnectEncryptionDevice === undefined ? null : (
            <div className="space-y-2">
              <p className="text-sm text-foreground-muted">
                If another connected device remains, reconnect this client with a fresh device identity. The connected device stays active and approves this one by comparison code.
              </p>
              <Button
                variant="primary"
                onClick={() => void reconnectEncryptionDevice()}
                loading={loading}
              >
                Reconnect through another device
              </Button>
            </div>
          )}
          <div className="space-y-2 border-t border-border pt-3">
            <p className="text-sm text-foreground-muted">
              If no connected device remains, enter the current 24-word recovery phrase. This replaces the old device group with a fresh one and restores other Room keys only when they are needed.
            </p>
          <TextInput
            value={recoveryMnemonic}
            onChange={setRecoveryMnemonic}
            ariaLabel="Current 24-word recovery phrase"
            autoComplete="off"
          />
          <Button
            variant="primary"
            onClick={() => void recoverEncryptionDevice()}
            loading={loading}
            disabled={port.recoverEncryptionDevice === undefined
              || recoveryMnemonic.trim().length === 0}
          >
            Recover this device
          </Button>
          </div>
          {error ? <p className="text-sm text-[var(--error)]" role="alert">{error}</p> : null}
        </div>
      ) : readiness?.status === "additional_device_required" ? (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-background p-3" role="status">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">
                Connecting this device
              </p>
              <p className="text-xs text-foreground-muted">
                Step {additionalDeviceStep(readiness)} of {ADDITIONAL_DEVICE_STEPS.length}
              </p>
            </div>
            <div
              className="mt-3 flex gap-1"
              role="progressbar"
              aria-label="Device connection progress"
              aria-valuemin={1}
              aria-valuemax={ADDITIONAL_DEVICE_STEPS.length}
              aria-valuenow={additionalDeviceStep(readiness)}
            >
              {ADDITIONAL_DEVICE_STEPS.map((step, index) => (
                <span
                  key={step}
                  className={`h-1.5 flex-1 rounded-full ${
                    index < additionalDeviceStep(readiness)
                      ? "bg-primary" : "bg-background-element"
                  }`}
                />
              ))}
            </div>
            <p className="mt-3 text-sm text-foreground">
              {ADDITIONAL_DEVICE_STEPS[additionalDeviceStep(readiness) - 1]}
            </p>
            <p className="mt-1 text-xs text-foreground-muted">
              {additionalDeviceCopy(readiness)}
            </p>
          </div>
          {readiness.verificationCode ? (
            <div>
              <p className="text-xs text-foreground-muted">Verification code</p>
              <p className="mt-1 font-mono text-sm text-foreground">
                {readiness.verificationCode}
              </p>
            </div>
          ) : null}
          <Button
            variant={readiness.enrollmentStatus === "required" ? "primary" : "ghost"}
            onClick={() => void continueAdditionalDevice()}
            loading={loading}
            disabled={port.continueAdditionalDevice === undefined}
          >
            {readiness.enrollmentStatus === "required"
              ? "Request device connection" : "Check connection now"}
          </Button>
          {port.recoverEncryptionDevice !== undefined ? (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-sm text-foreground-muted">
                No connected device remains? Recover with the current 24-word phrase instead.
              </p>
              <TextInput
                value={recoveryMnemonic}
                onChange={setRecoveryMnemonic}
                ariaLabel="Current 24-word recovery phrase"
                autoComplete="off"
              />
              <Button
                variant="ghost"
                onClick={() => void recoverEncryptionDevice()}
                loading={loading}
                disabled={recoveryMnemonic.trim().length === 0}
              >
                Recover without another device
              </Button>
            </div>
          ) : null}
          {deviceRoster !== null ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Encryption device health
                </p>
                <p className="mt-1 text-xs text-foreground-muted">
                  A device can be removed only from another connected device. Your final device is protected.
                </p>
              </div>
              {deviceRoster.devices.map((device) => (
                <div
                  key={`${device.deviceId}:${device.deviceGeneration}`}
                  className="rounded-md border border-border bg-background p-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {device.clientKind === "electron" ? "Desktop"
                          : device.clientKind === "browser" ? "Browser" : "Device"}
                        {device.isCurrentDevice ? " · This device" : ""}
                      </p>
                      <DeviceHealthDetails
                        device={device}
                        localCustodyReady={device.isCurrentDevice
                          && readiness.enrollmentStatus === "syncing"
                          && readiness.syncReason
                            === "personal_authority_required"}
                        personalAuthorityReady={false}
                      />
                    </div>
                    {device.canRemove && removingDeviceId !== device.deviceId ? (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setRemovingDeviceId(device.deviceId);
                          setRemovalPin("");
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                  {removingDeviceId === device.deviceId ? (
                    <div className="mt-3 space-y-2 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3">
                      <p className="text-sm text-foreground">
                        This device will stop receiving future encrypted keys. Existing information it already opened cannot be taken back. Enter your PIN to confirm.
                      </p>
                      <TextInput
                        value={removalPin}
                        onChange={setRemovalPin}
                        ariaLabel="PIN to remove encryption device"
                        type="password"
                        inputMode="numeric"
                        autoComplete="current-password"
                      />
                      <div className="flex gap-2">
                        <Button
                          variant="primary"
                          onClick={() => void removeEncryptionDevice()}
                          loading={loading}
                          disabled={!/^\d{6,8}$/u.test(removalPin)}
                        >
                          Remove device
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setRemovingDeviceId(null);
                            setRemovalPin("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
          {error ? <p className="text-sm text-[var(--error)]" role="alert">{error}</p> : null}
        </div>
      ) : readiness?.status === "unavailable" ? (
        <div className="space-y-3">
          <p className="text-sm text-[var(--error)]" role="alert">
            {reasonCopy(readiness.reason)}
          </p>
          <Button onClick={() => void start()} disabled={loading}>Try again</Button>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-foreground-muted">
            {readiness?.status === "setup_pending"
              ? "Your encryption setup is safely stored on this device. Continue without creating a new recovery phrase."
              : "Set up the recovery kit before this device begins storing encrypted conversations, memories, or artifacts."}
          </p>
          <Button variant="primary" onClick={() => void start()} loading={loading}>
            {readiness?.status === "setup_pending" ? "Continue setup" : "Set up recovery kit"}
          </Button>
          {port.recoverEncryptionDevice !== undefined ? (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-sm text-foreground-muted">
                Already have a recovery phrase for this account? Use it instead of creating a new one.
              </p>
              <TextInput
                value={recoveryMnemonic}
                onChange={setRecoveryMnemonic}
                ariaLabel="Current 24-word recovery phrase"
                autoComplete="off"
              />
              <Button
                variant="ghost"
                onClick={() => void recoverEncryptionDevice()}
                loading={loading}
                disabled={recoveryMnemonic.trim().length === 0}
              >
                Recover existing encrypted data
              </Button>
            </div>
          ) : null}
          {error ? <p className="text-sm text-[var(--error)]" role="alert">{error}</p> : null}
        </div>
      )}
      {showPersonalCoverage ? <PersonalEncryptionCoverageCard /> : null}
    </SectionCard>
  );
}

import { LatticeCrypto } from "@nautilo/lattice-crypto";
import type { HumanDeviceMembershipRosterV1 } from "@nautilo/api-client";

import type {
  ClientProfileCoordinates,
  ClientProfileVault,
  PublicClientProfile,
} from "../client-vault/types.ts";
import {
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  stageAndActivateClientDeviceProfileV4,
} from "../client-vault/profile-v4.ts";
import {
  nautiloActorId,
  nautiloUserId,
} from "../identity/product-ids.ts";
import type { InitialDeviceBootstrapClientPort } from
  "./initial-bootstrap-client-ceremony.ts";
import type { PresentInitialDeviceRecoveryKit } from
  "./initial-bootstrap-ceremony.ts";
import { InitialDeviceRecoveryCeremonyError } from
  "./initial-bootstrap-ceremony.ts";
import {
  destroyPendingInitialDeviceBootstrap,
  prepareRestartSafeInitialDeviceClientCeremony,
  resumeRestartSafeInitialDeviceClientCeremony,
  type PendingInitialDeviceBootstrapVault,
} from "./restart-safe-initial-device-client-ceremony.ts";
import type {
  InitialHumanDomainApiClientPort,
  InitialHumanDomainPlan,
} from "./initial-readiness-api-client.ts";
import { InitialDeviceEnrollmentRequiredError } from
  "./initial-readiness-api-client.ts";
import { deriveAdditionalDeviceClientIdentity } from
  "./additional-device-client.ts";
import {
  createDeviceAdmissionProof,
  type DeviceAdmissionChallenge,
  type DeviceAdmissionProof,
} from "./device-admission.ts";

type InitialHumanDomainUnavailableReason = Extract<
  InitialHumanDomainPlan,
  { status: "unavailable" }
>["reason"];

type ClientProfileV1Migration = Readonly<{
  trustedDeviceRevision: number;
  trustedHostAuthorizationRevision: number;
  deliveryHighWatermark: number;
}>;

export type LocalInitialDeviceReadiness =
  | Readonly<{
    status: "active";
    coordinates: ClientProfileCoordinates;
    encryptionSetup:
      | "device_active"
      | "human_domain_active"
      | "v2_personal_authority_ready";
    continuationReason?: InitialHumanDomainUnavailableReason;
    pendingAdditionalDevices?: readonly Readonly<{
      operationId: string;
      deviceId: string;
      clientKind: "browser" | "electron";
      verificationCode?: string;
      progress: "approval_required" | "transfer_ready" | "awaiting_target";
    }>[];
  }>
  | Readonly<{
    status: "setup_required" | "setup_pending";
    coordinates: ClientProfileCoordinates;
  }>
  | Readonly<{
    status: "additional_device_required";
    coordinates: ClientProfileCoordinates;
    enrollmentStatus?: "required" | "waiting_for_approval" | "syncing";
    syncReason?: "delivery_pending" | "current_domain_sync_required"
      | "personal_authority_required";
    operationId?: string;
    verificationCode?: string;
  }>
  | Readonly<{
    status: "reset_required";
    reason: "server_identity_missing";
    coordinates: ClientProfileCoordinates;
  }>
  | Readonly<{
    status: "recovery_required";
    reason: "stale_device" | "removed_device";
    coordinates: ClientProfileCoordinates;
  }>
  | Readonly<{
    status: "unavailable";
    reason: "identity_invalid" | "custody_unavailable" | "custody_conflict";
  }>;

export interface LocalInitialDeviceReadinessClient {
  inspect(): Promise<LocalInitialDeviceReadiness>;
  /** Local custody only; the server challenge verifies current membership. */
  deviceAdmissionDeviceId?(): Promise<string | null>;
  signDeviceAdmissionChallenge?(
    challenge: DeviceAdmissionChallenge,
  ): Promise<DeviceAdmissionProof>;
  resetLocalSetup(): Promise<LocalInitialDeviceReadiness>;
  continueAdditionalDevice?(): Promise<LocalInitialDeviceReadiness>;
  approveAdditionalDevice?(
    operationId: string,
    verificationCode: string,
  ): Promise<LocalInitialDeviceReadiness>;
  advanceAdditionalDevice?(operationId: string): Promise<LocalInitialDeviceReadiness>;
  listEncryptionDevices?(): Promise<HumanDeviceMembershipRosterV1>;
  removeEncryptionDevice?(
    deviceId: string,
    pin: string,
  ): Promise<LocalInitialDeviceReadiness>;
  recoverEncryptionDevice?(
    mnemonic: string,
  ): Promise<LocalInitialDeviceReadiness>;
  reconnectEncryptionDevice?(): Promise<LocalInitialDeviceReadiness>;
  setup(
    presentRecoveryKit: PresentInitialDeviceRecoveryKit,
  ): Promise<LocalInitialDeviceReadiness>;
}

export interface LocalInitialDeviceReadinessClientInput {
  readonly profileVault: ClientProfileVault;
  readonly pendingVault: PendingInitialDeviceBootstrapVault;
  readonly bootstrap: InitialDeviceBootstrapClientPort;
  readonly initialHumanDomain: InitialHumanDomainApiClientPort;
  readonly serverScope: string;
  readonly userId: string;
  readonly humanActorId: string;
  readonly installationId: string;
  readonly clientKind: "browser" | "electron";
  readonly crypto?: LatticeCrypto;
  readonly humanDeviceMembership?: Readonly<{
    requiresAdditionalDevice?(): Promise<boolean>;
    ensure(): Promise<Readonly<{
      status: "ready" | "additional_required" | "waiting_for_approval"
        | "syncing" | "stale" | "removed";
      operationId?: string;
      verificationCode?: string;
      syncReason?: "personal_authority_required";
    }>>;
    roster?(): Promise<HumanDeviceMembershipRosterV1>;
    removeDevice?(
      targetDeviceId: string,
      pin: string,
    ): Promise<unknown>;
    recoverWithMnemonic?(mnemonic: string): Promise<unknown>;
  }>;
  readonly additionalDeviceTarget?: Readonly<{
    hasPending(): Promise<boolean>;
    inspectPending?(): Promise<Readonly<{
      status: "required" | "waiting_for_approval" | "syncing";
      operationId?: string;
      verificationCode?: string;
      syncReason?: "delivery_pending" | "current_domain_sync_required"
        | "personal_authority_required";
    }> | null>;
    continue(): Promise<Readonly<{
      status: "waiting_for_approval" | "syncing" | "active";
      operationId: string;
      verificationCode?: string;
      syncReason?: "delivery_pending" | "current_domain_sync_required"
        | "personal_authority_required";
    }>>;
  }>;
  readonly additionalDeviceApprover?: Readonly<{
    inspect(): Promise<readonly Readonly<{
      enrollment: Readonly<{
        operationId: string;
        deviceId: string;
        clientKind: "browser" | "electron";
      }>;
      verificationCode?: string;
      progress?: "approval_required" | "transfer_ready" | "awaiting_target"
        | undefined;
    }>[] >;
    approve(operationId: string, verificationCode: string): Promise<unknown>;
    advance(operationId: string): Promise<unknown>;
  }>;
}

function portableInstallationId(value: string): string {
  if (value.length < 1 || value.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new TypeError("Crypto installation identity is invalid");
  }
  return value;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function exactCoordinates(
  left: ClientProfileCoordinates,
  right: ClientProfileCoordinates,
): boolean {
  return left.serverScope === right.serverScope
    && left.userId === right.userId
    && left.humanActorId === right.humanActorId
    && left.profileId === right.profileId
    && left.deviceId === right.deviceId
    && left.installationLineageDigest === right.installationLineageDigest;
}

export function createLocalInitialDeviceReadinessClient(
  input: LocalInitialDeviceReadinessClientInput,
): LocalInitialDeviceReadinessClient {
  const crypto = input.crypto ?? new LatticeCrypto();
  const installationId = portableInstallationId(input.installationId);
  const user = nautiloUserId(input.userId);
  const actor = nautiloActorId(input.humanActorId);
  if (!user.ok || !actor.ok) {
    return Object.freeze({
      inspect: () => Promise.resolve(Object.freeze({
        status: "unavailable" as const,
        reason: "identity_invalid" as const,
      })),
      resetLocalSetup: () => Promise.resolve(Object.freeze({
        status: "unavailable" as const,
        reason: "identity_invalid" as const,
      })),
      setup: () => Promise.resolve(Object.freeze({
        status: "unavailable" as const,
        reason: "identity_invalid" as const,
      })),
    });
  }
  const identity = deriveAdditionalDeviceClientIdentity({
    crypto,
    serverScope: input.serverScope,
    userId: user.value,
    humanActorId: actor.value,
    installationId,
    clientKind: input.clientKind,
  });
  const coordinates: ClientProfileCoordinates = identity.coordinates;
  const installationLineageDigest = identity.installationLineageDigest;
  const idempotencyKey = identity.idempotencyKey.replace(
    "additional-device:",
    "initial-device:",
  );

  function active(
    encryptionSetup:
      | "device_active"
      | "human_domain_active"
      | "v2_personal_authority_ready",
    continuationReason?: InitialHumanDomainUnavailableReason,
  ): LocalInitialDeviceReadiness {
    return Object.freeze({
      status: "active" as const,
      coordinates,
      encryptionSetup,
      ...(continuationReason === undefined ? {} : { continuationReason }),
    });
  }

  let domainContinuation: Promise<LocalInitialDeviceReadiness> | undefined;

  async function activeProfileIsV4(): Promise<boolean> {
    try {
      await input.profileVault.withOpenProfile(coordinates, async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto,
          profileBytes,
          expectedDeviceId: coordinates.deviceId,
        });
        destroyOpenedClientDeviceProfileV4(profile);
      });
      return true;
    } catch (error) {
      if (error instanceof TypeError
        && error.message === "Client profile v4 is unavailable") return false;
      throw error;
    }
  }

  async function ensureActiveProfileV4(
    activeProfile: PublicClientProfile,
    plan: InitialHumanDomainPlan,
    bootstrapMigration?: ClientProfileV1Migration,
  ): Promise<void> {
    if (await activeProfileIsV4()) return;
    const migrationStageId = `profile-v4-migration:${coordinates.deviceId}`;
    const staged = (await input.profileVault.listPublicProfiles()).find(
      (profile) => exactCoordinates(profile.coordinates, coordinates)
        && profile.lifecycle === "staged",
    );
    if (staged !== undefined) {
      if (staged.stageId !== migrationStageId
        || staged.generation !== activeProfile.generation + 1
        || input.profileVault.withOpenStagedProfile === undefined) {
        throw new Error("Client profile v4 migration conflicts with pending custody");
      }
      await input.profileVault.withOpenStagedProfile(
        coordinates,
        migrationStageId,
        async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes,
            expectedDeviceId: coordinates.deviceId,
          });
          destroyOpenedClientDeviceProfileV4(profile);
        },
      );
      await input.profileVault.activateProfile(coordinates, migrationStageId);
      return;
    }

    let candidate: Awaited<ReturnType<typeof createClientDeviceProfileV4Candidate>>
      | undefined;
    try {
      await input.profileVault.withOpenProfile(coordinates, async (profileBytes) => {
        candidate = await createClientDeviceProfileV4Candidate({
          crypto,
          currentProfileBytes: profileBytes,
          expectedDeviceId: coordinates.deviceId,
          ...(
            plan.status === "planned" || plan.status === "active"
              ? {
                v1Migration: {
                  trustedDeviceRevision: plan.trustedDeviceRevision,
                  trustedHostAuthorizationRevision:
                    plan.trustedHostAuthorizationRevision,
                  deliveryHighWatermark: plan.deliveryHighWatermark,
                },
              }
              : plan.migration !== undefined
              ? { v1Migration: plan.migration }
              : bootstrapMigration === undefined
              ? {}
              : { v1Migration: bootstrapMigration }
          ),
        });
      });
      await stageAndActivateClientDeviceProfileV4({
        crypto,
        vault: input.profileVault,
        coordinates,
        stageId: migrationStageId,
        generation: activeProfile.generation + 1,
        publicState: activeProfile.publicState,
        candidate: candidate!,
      });
    } catch (error) {
      // A second readiness inspector may have completed the deterministic
      // migration between our read and stage. Accept only the exact resulting
      // active v4 profile; every other collision remains a custody conflict.
      if (!await activeProfileIsV4()) throw error;
    } finally {
      if (candidate) destroyOpenedClientDeviceProfileV4(candidate);
    }
  }

  async function continueHumanDomainNow(
    bootstrapMigration?: ClientProfileV1Migration,
  ): Promise<LocalInitialDeviceReadiness> {
    // A first device can establish the one-Human V2 Domain on first use. An
    // additional device remains in its durable enrollment state until the
    // existing one-Human Domain keys have been delivered and cached.
    const plan = await input.initialHumanDomain.plan(coordinates.deviceId);
    try {
      if (plan.status === "unavailable" && plan.reason === "stale_identity") {
        return Object.freeze({
          status: "reset_required" as const,
          reason: "server_identity_missing" as const,
          coordinates,
        });
      }
      const activeProfile = (await input.profileVault.listPublicProfiles()).find(
        (profile) => exactCoordinates(profile.coordinates, coordinates)
          && profile.lifecycle === "active",
      );
      if (activeProfile === undefined) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_conflict" as const,
        });
      }
      const requiresAdditionalDevice = bootstrapMigration === undefined
        && await input.humanDeviceMembership?.requiresAdditionalDevice?.()
          === true;
      await ensureActiveProfileV4(
        activeProfile,
        plan,
        bootstrapMigration ?? (requiresAdditionalDevice
          ? {
            trustedDeviceRevision: 0,
            trustedHostAuthorizationRevision: 0,
            deliveryHighWatermark: 0,
          }
          : undefined),
      );
      const membership = await input.humanDeviceMembership?.ensure();
      if (membership !== undefined && membership.status !== "ready") {
        if (membership.status === "stale" || membership.status === "removed") {
          return Object.freeze({
            status: "recovery_required" as const,
            reason: membership.status === "removed"
              ? "removed_device" as const
              : "stale_device" as const,
            coordinates,
          });
        }
        return Object.freeze({
          status: "additional_device_required" as const,
          coordinates,
          enrollmentStatus: membership.status === "additional_required"
            ? "required" as const
            : membership.status,
          ...(membership.operationId === undefined
            ? {}
            : { operationId: membership.operationId }),
          ...(membership.verificationCode === undefined
            ? {}
            : { verificationCode: membership.verificationCode }),
          ...(membership.syncReason === undefined
            ? {}
            : { syncReason: membership.syncReason }),
        });
      }
      return active("v2_personal_authority_ready");
    } finally {
      if (plan.status === "active") plan.stateHash.fill(0);
    }
  }

  function continueHumanDomain(
    bootstrapMigration?: ClientProfileV1Migration,
  ): Promise<LocalInitialDeviceReadiness> {
    domainContinuation ??= continueHumanDomainNow(bootstrapMigration).finally(() => {
      domainContinuation = undefined;
    });
    return domainContinuation;
  }

  async function inspect(): Promise<LocalInitialDeviceReadiness> {
    const availability = await input.profileVault.unlock();
    if (availability.status !== "available") {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "custody_unavailable" as const,
      });
    }
    const profiles = (await input.profileVault.listPublicProfiles()).filter(
      (profile) => exactCoordinates(profile.coordinates, coordinates),
    );
    // A transferred profile is locally active before the approving device has
    // finished recipient synchronization. Keep foreground encryption gated by
    // the durable target state until that final synchronization is complete.
    if (input.additionalDeviceTarget !== undefined
      && await input.additionalDeviceTarget.hasPending()) {
      const pending = await input.additionalDeviceTarget.inspectPending?.();
      return Object.freeze({
        status: "additional_device_required" as const,
        coordinates,
        enrollmentStatus: pending?.status ?? "waiting_for_approval" as const,
        ...(pending?.operationId === undefined
          ? {}
          : { operationId: pending.operationId }),
        ...(pending?.verificationCode === undefined
          ? {}
          : { verificationCode: pending.verificationCode }),
        ...(pending?.syncReason === undefined
          ? {}
          : { syncReason: pending.syncReason }),
      });
    }
    if (profiles.some((profile) => profile.lifecycle === "active")) {
      const current = await continueHumanDomain();
      if (input.additionalDeviceApprover === undefined) return current;
      const canApproveWhileCurrentAuthorityCatchesUp =
        current.status === "additional_device_required"
        && current.enrollmentStatus === "syncing"
        && current.syncReason === "personal_authority_required";
      if (current.status !== "active"
        && !canApproveWhileCurrentAuthorityCatchesUp
        && !(current.status === "unavailable"
          && current.reason === "custody_conflict")) return current;
      const pending = await input.additionalDeviceApprover.inspect();
      const canResumeCommittedTransfer = current.status === "unavailable"
        && current.reason === "custody_conflict"
        && pending.some((candidate) =>
          candidate.progress === "awaiting_target"
          || candidate.progress === "transfer_ready"
        );
      if (current.status !== "active"
        && !canApproveWhileCurrentAuthorityCatchesUp
        && !canResumeCommittedTransfer) return current;
      if (pending.length === 0) return current;
      return Object.freeze({
        ...(current.status === "active"
          ? current
          : active("device_active")),
        pendingAdditionalDevices: Object.freeze(pending.map((candidate) =>
          Object.freeze({
            operationId: candidate.enrollment.operationId,
            deviceId: candidate.enrollment.deviceId,
            clientKind: candidate.enrollment.clientKind,
            ...(candidate.verificationCode === undefined
              ? {}
              : { verificationCode: candidate.verificationCode }),
            progress: candidate.progress ?? "approval_required",
          })
        )),
      });
    }
    if (await input.humanDeviceMembership?.requiresAdditionalDevice?.()) {
      return Object.freeze({
        status: "additional_device_required" as const,
        coordinates,
        enrollmentStatus: "required" as const,
      });
    }
    if (input.additionalDeviceTarget !== undefined) {
      const domain = await input.initialHumanDomain.plan(coordinates.deviceId);
      if (domain.status === "active") domain.stateHash.fill(0);
      if (domain.status === "unavailable"
        && (domain.reason === "existing_domain_requires_delivery"
          || domain.reason === "multiple_active_devices_require_fanout")) {
        return Object.freeze({
          status: "additional_device_required" as const,
          coordinates,
          enrollmentStatus: "required" as const,
        });
      }
    }
    try {
      const pending = await input.pendingVault.load(idempotencyKey);
      if (pending !== null) {
        return Object.freeze({
          status: "setup_pending" as const,
          coordinates,
        });
      }
    } catch {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "custody_unavailable" as const,
      });
    }
    return Object.freeze({ status: "setup_required" as const, coordinates });
  }

  return Object.freeze({
    async deviceAdmissionDeviceId(): Promise<string | null> {
      const availability = await input.profileVault.unlock();
      if (availability.status !== "available") return null;
      const profiles = await input.profileVault.listPublicProfiles();
      return profiles.some((profile) =>
        exactCoordinates(profile.coordinates, coordinates)
        && profile.lifecycle === "active"
      ) ? coordinates.deviceId : null;
    },
    async signDeviceAdmissionChallenge(
      challenge: DeviceAdmissionChallenge,
    ): Promise<DeviceAdmissionProof> {
      if (
        challenge.userId !== input.userId
        || challenge.humanActorId !== input.humanActorId
        || challenge.deviceId !== coordinates.deviceId
        || challenge.serverInstanceId.length === 0
      ) throw new Error("Device admission challenge does not match local custody");
      const availability = await input.profileVault.unlock();
      if (availability.status !== "available") {
        throw new Error("Device admission custody is unavailable");
      }
      let proof: DeviceAdmissionProof | undefined;
      await input.profileVault.withOpenProfile(coordinates, async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto,
          profileBytes,
          expectedDeviceId: coordinates.deviceId,
        });
        try {
          proof = createDeviceAdmissionProof({
            crypto,
            challenge,
            signingPrivateKey:
              profile.baseProfile.baseProfile.signingPrivateKey,
          });
        } finally {
          destroyOpenedClientDeviceProfileV4(profile);
        }
      });
      if (proof === undefined) {
        throw new Error("Device admission proof was not produced");
      }
      return proof;
    },
    inspect,
    async listEncryptionDevices(): Promise<HumanDeviceMembershipRosterV1> {
      if (input.humanDeviceMembership?.roster === undefined) {
        throw new Error("Human-device roster is unavailable");
      }
      return input.humanDeviceMembership.roster();
    },
    async removeEncryptionDevice(
      deviceId: string,
      pin: string,
    ): Promise<LocalInitialDeviceReadiness> {
      if (input.humanDeviceMembership?.removeDevice === undefined) {
        throw new Error("Human-device removal is unavailable");
      }
      await input.humanDeviceMembership.removeDevice(deviceId, pin);
      return inspect();
    },
    async recoverEncryptionDevice(
      mnemonic: string,
    ): Promise<LocalInitialDeviceReadiness> {
      if (input.humanDeviceMembership?.recoverWithMnemonic === undefined) {
        throw new Error("Human-device recovery is unavailable");
      }
      await input.humanDeviceMembership.recoverWithMnemonic(mnemonic);
      return inspect();
    },
    async continueAdditionalDevice(): Promise<LocalInitialDeviceReadiness> {
      if (input.additionalDeviceTarget === undefined) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_unavailable" as const,
        });
      }
      const availability = await input.profileVault.unlock();
      if (availability.status !== "available") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_unavailable" as const,
        });
      }
      const progress = await input.additionalDeviceTarget.continue();
      if (progress.status === "active") return inspect();
      return Object.freeze({
        status: "additional_device_required" as const,
        coordinates,
        enrollmentStatus: progress.status,
        operationId: progress.operationId,
        ...(progress.verificationCode === undefined ? {} : {
          verificationCode: progress.verificationCode,
        }),
        ...(progress.syncReason === undefined ? {} : {
          syncReason: progress.syncReason,
        }),
      });
    },
    async approveAdditionalDevice(
      operationId: string,
      verificationCode: string,
    ): Promise<LocalInitialDeviceReadiness> {
      if (input.additionalDeviceApprover === undefined) return inspect();
      const availability = await input.profileVault.unlock();
      if (availability.status !== "available") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_unavailable" as const,
        });
      }
      const progress = await input.additionalDeviceApprover.approve(
        operationId,
        verificationCode,
      ) as
        Readonly<{ status?: string }>;
      if (progress.status === "transition_ready") {
        await input.additionalDeviceApprover.advance(operationId);
      }
      return inspect();
    },
    async advanceAdditionalDevice(
      operationId: string,
    ): Promise<LocalInitialDeviceReadiness> {
      if (input.additionalDeviceApprover === undefined) return inspect();
      const availability = await input.profileVault.unlock();
      if (availability.status !== "available") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_unavailable" as const,
        });
      }
      await input.additionalDeviceApprover.advance(operationId);
      return inspect();
    },
    async resetLocalSetup(): Promise<LocalInitialDeviceReadiness> {
      const availability = await input.profileVault.unlock();
      if (availability.status !== "available") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_unavailable" as const,
        });
      }
      const plan = await input.initialHumanDomain.plan(coordinates.deviceId);
      if (plan.status === "active") plan.stateHash.fill(0);
      if (plan.status !== "unavailable" || plan.reason !== "stale_identity") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "custody_conflict" as const,
        });
      }
      const pending = await input.pendingVault.load(idempotencyKey);
      try {
        if (pending !== null && !await input.pendingVault.removeExact(pending)) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "custody_conflict" as const,
          });
        }
      } finally {
        destroyPendingInitialDeviceBootstrap(pending);
      }
      await input.profileVault.forgetProfile(coordinates);
      return Object.freeze({ status: "setup_required" as const, coordinates });
    },
    async setup(
      presentRecoveryKit: PresentInitialDeviceRecoveryKit,
    ): Promise<LocalInitialDeviceReadiness> {
      const current = await inspect();
      if (current.status === "active" || current.status === "unavailable"
        || current.status === "reset_required") {
        return current;
      }
      try {
        await prepareRestartSafeInitialDeviceClientCeremony({
          crypto,
          vault: input.profileVault,
          pending: input.pendingVault,
          serverScope: input.serverScope,
          profileId: coordinates.profileId,
          userId: user.value,
          humanActorId: actor.value,
          deviceId: coordinates.deviceId,
          clientKind: input.clientKind,
          installationLineageDigest,
          idempotencyKey,
          recoverySources: [],
          presentRecoveryKit,
        });
        const receipt = await resumeRestartSafeInitialDeviceClientCeremony({
          crypto,
          vault: input.profileVault,
          pending: input.pendingVault,
          bootstrap: input.bootstrap,
          idempotencyKey,
        });
        return continueHumanDomain({
          trustedDeviceRevision: receipt.deviceRevision,
          trustedHostAuthorizationRevision: receipt.deviceRevision,
          deliveryHighWatermark: 0,
        });
      } catch (error) {
        if (error instanceof InitialDeviceEnrollmentRequiredError) {
          const pending = await input.pendingVault.load(idempotencyKey);
          try {
            if (pending !== null && input.humanDeviceMembership !== undefined) {
              const stageId = `human-device-profile:${coordinates.deviceId}`;
              const profiles = await input.profileVault.listPublicProfiles();
              const activeProfile = profiles.find((profile) =>
                exactCoordinates(profile.coordinates, coordinates)
                && profile.lifecycle === "active"
              );
              if (activeProfile === undefined) {
                const staged = profiles.find((profile) =>
                  exactCoordinates(profile.coordinates, coordinates)
                  && profile.lifecycle === "staged"
                );
                if (staged === undefined) {
                  await input.profileVault.stageProfile({
                    coordinates,
                    stageId,
                    generation: 1,
                    profileBytes: pending.profileBytes,
                    publicState: {
                      clientKind: pending.request.clientKind,
                      publicFingerprint: hex(pending.publicFingerprint),
                    },
                  });
                } else if (staged.stageId !== stageId) {
                  throw new Error(
                    "Additional-device profile conflicts with pending custody",
                  );
                }
                await input.profileVault.activateProfile(coordinates, stageId);
              }
            }
            if (pending !== null
              && !await input.pendingVault.removeExact(pending)) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "custody_conflict" as const,
              });
            }
          } finally {
            destroyPendingInitialDeviceBootstrap(pending);
          }
          if (input.humanDeviceMembership === undefined) {
            await input.profileVault.forgetProfile(coordinates);
          } else {
            await continueHumanDomain({
              trustedDeviceRevision: 0,
              trustedHostAuthorizationRevision: 0,
              deliveryHighWatermark: 0,
            });
          }
          if (input.additionalDeviceTarget !== undefined) {
            const progress = await input.additionalDeviceTarget.continue();
            if (progress.status === "active") return inspect();
            return Object.freeze({
              status: "additional_device_required" as const,
              coordinates,
              enrollmentStatus: progress.status,
              operationId: progress.operationId,
              ...(progress.verificationCode === undefined ? {} : {
                verificationCode: progress.verificationCode,
              }),
            });
          }
          return Object.freeze({
            status: "additional_device_required" as const,
            coordinates,
            enrollmentStatus: "required" as const,
          });
        }
        if (error instanceof InitialDeviceRecoveryCeremonyError
          && error.code === "cancelled") {
          return inspect();
        }
        if (error instanceof Error
          && (error.message.includes("collid")
            || error.message.includes("changed concurrently"))) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "custody_conflict" as const,
          });
        }
        throw error;
      }
    },
  });
}

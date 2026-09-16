import type {
  HumanDeviceMembershipAcknowledgementRequestV1,
  HumanDeviceMembershipAddRequestV1,
  HumanDeviceMembershipBeginRequestV1,
  HumanDeviceMembershipBeginV1,
  HumanDeviceMembershipInitialRequestV1,
  HumanDeviceMembershipJoinRequestV1,
  HumanDeviceMembershipMutationV1,
  HumanDeviceMembershipPendingRequestV1,
  HumanDeviceMembershipPendingV1,
  HumanDeviceMembershipRemoveRequestV1,
  HumanDeviceMembershipRecoveryBeginRequestV1,
  HumanDeviceMembershipRecoveryBeginV1,
  HumanDeviceMembershipRecoveryCompleteRequestV1,
  HumanDeviceMembershipRosterRequestV1,
  HumanDeviceMembershipRosterV1,
  HumanDeviceMembershipStatusRequestV1,
  HumanDeviceMembershipStatusV1,
} from "@nautilo/api-client";
import {
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  LatticeCrypto,
  answerRecoveryDevicePossessionChallenge,
  cryptoDeviceId,
  cryptoDomainId,
  decodeHumanDeviceGroupHead,
  decodeHumanDeviceGroupJoinRequest,
  decodeHumanDeviceGroupTransition,
  decodeHumanDeviceRoster,
  domainEpoch,
  encodeHumanDeviceGroupHead,
  encodeHumanDeviceGroupJoinRequest,
  encodeHumanDeviceGroupTransition,
  humanDeviceGroupHeadDigest,
  humanId,
  restoreSealedProviderState,
  unixTimestamp,
  type HumanDeviceCredential,
  type HumanDeviceGroupHead,
} from "@nautilo/lattice-crypto";
import {
  decodeRecoveryDeviceActivationChallengeV2,
  pendingDeviceRevisionV2,
  type SealedProviderStateV2 as SealedProviderState,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
} from "../client-vault/profile-v4.ts";
import { encodeClientDeviceProfileV1 } from "../client-vault/profile-v2.ts";
import { deriveRecoveryCredentialFromMnemonic } from
  "../recovery/recovery-kit.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
  PublicClientProfile,
} from "../client-vault/types.ts";
import {
  advanceAndActivateClientTrustedDeviceAuthorityRevision,
} from "./trusted-device-authority-revision.ts";
export interface HumanDeviceMembershipApiPort {
  loadHumanDeviceMembership(
    input: HumanDeviceMembershipStatusRequestV1,
  ): Promise<HumanDeviceMembershipStatusV1>;
  establishHumanDeviceMembership(
    input: HumanDeviceMembershipInitialRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1>;
  beginHumanDeviceMembership(
    input: HumanDeviceMembershipBeginRequestV1,
  ): Promise<HumanDeviceMembershipBeginV1>;
  publishHumanDeviceMembershipJoin(
    operationId: string,
    input: HumanDeviceMembershipJoinRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1>;
  listHumanDeviceMembershipPending(
    input: HumanDeviceMembershipPendingRequestV1,
  ): Promise<HumanDeviceMembershipPendingV1>;
  listHumanDeviceMembershipRoster(
    input: HumanDeviceMembershipRosterRequestV1,
  ): Promise<HumanDeviceMembershipRosterV1>;
  publishHumanDeviceMembershipAdd(
    operationId: string,
    input: HumanDeviceMembershipAddRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1>;
  publishHumanDeviceMembershipRemove(
    operationId: string,
    input: HumanDeviceMembershipRemoveRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1>;
  beginHumanDeviceMembershipRecovery?(
    input: HumanDeviceMembershipRecoveryBeginRequestV1,
  ): Promise<HumanDeviceMembershipRecoveryBeginV1>;
  completeHumanDeviceMembershipRecovery?(
    operationId: string,
    input: HumanDeviceMembershipRecoveryCompleteRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1>;
  acknowledgeHumanDeviceMembership(
    input: HumanDeviceMembershipAcknowledgementRequestV1,
  ): Promise<HumanDeviceMembershipMutationV1>;
}

export type HumanDeviceMembershipProgress =
  | Readonly<{ status: "ready" }>
  | Readonly<{
      status: "additional_required";
    }>
  | Readonly<{
      status: "waiting_for_approval";
      operationId?: string;
      verificationCode?: string;
    }>
  | Readonly<{
      status: "syncing";
      operationId?: string;
      verificationCode?: string;
      syncReason?: "personal_authority_required";
    }>
  | Readonly<{ status: "stale" }>
  | Readonly<{ status: "removed" }>;

const membershipOperationTails = new Map<string, Promise<void>>();

function membershipOperationKey(
  coordinates: ClientProfileCoordinates,
): string {
  return [
    coordinates.serverScope,
    coordinates.userId,
    coordinates.humanActorId,
    coordinates.profileId,
    coordinates.deviceId,
    coordinates.installationLineageDigest,
  ].join("\0");
}

function serializeMembershipOperation<T>(
  coordinates: ClientProfileCoordinates,
  operation: () => Promise<T>,
): Promise<T> {
  const key = membershipOperationKey(coordinates);
  const previous = membershipOperationTails.get(key) ?? Promise.resolve();
  const running = previous.then(operation, operation);
  const settled = running.then(() => undefined, () => undefined);
  membershipOperationTails.set(key, settled);
  void settled.then(() => {
    if (membershipOperationTails.get(key) === settled) {
      membershipOperationTails.delete(key);
    }
  });
  return running;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function deriveHumanDeviceMembershipVerificationCode(input: Readonly<{
  crypto: Pick<LatticeCrypto, "hash">;
  operationId: string;
  humanId: string;
  targetDeviceId: string;
  targetSigningPublicKey: Uint8Array;
}>): string {
  if (input.targetSigningPublicKey.length !== 32) {
    throw new TypeError("Human-device comparison key is invalid");
  }
  const context = new TextEncoder().encode([
    "nautilo/human-device-membership-verification/v1",
    input.operationId,
    input.humanId,
    input.targetDeviceId,
  ].join("\0"));
  const framed = new Uint8Array(
    context.length + input.targetSigningPublicKey.length,
  );
  framed.set(context);
  framed.set(input.targetSigningPublicKey, context.length);
  const digest = input.crypto.hash(framed);
  try {
    const value = Array.from(digest.subarray(0, 9), (byte) =>
      byte.toString(16).padStart(2, "0").toUpperCase()
    ).join("");
    return value.match(/.{1,6}/gu)!.join("-");
  } finally {
    context.fill(0);
    framed.fill(0);
    digest.fill(0);
  }
}

function activeProfile(
  profiles: readonly PublicClientProfile[],
  coordinates: ClientProfileCoordinates,
): PublicClientProfile {
  const value = profiles.find((entry) =>
    entry.lifecycle === "active"
    && entry.coordinates.deviceId === coordinates.deviceId
    && entry.coordinates.profileId === coordinates.profileId
  );
  if (value === undefined) throw new Error("Human-device profile is unavailable");
  return value;
}

function credential(input: Readonly<{
  serverInstanceId: string;
  humanActorId: string;
  deviceId: string;
  installationLineageDigest: Uint8Array;
  lineageGeneration: number;
}>): HumanDeviceCredential {
  return Object.freeze({
    formatVersion: 1,
    serverInstanceId: input.serverInstanceId,
    humanId: humanId(input.humanActorId),
    lineageGeneration: input.lineageGeneration,
    deviceId: cryptoDeviceId(input.deviceId),
    installationLineageDigest: input.installationLineageDigest.slice(),
    deviceKeyGeneration: 1,
  });
}

function snapshotMatchesHead(
  profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
  head: HumanDeviceGroupHead,
): boolean {
  const snapshot = profile.humanDeviceGroupSnapshot;
  return snapshot !== null
    && snapshot.providerId === "openmls-v2"
    && snapshot.domainId === head.groupId
    && snapshot.epoch === head.epoch
    && sameBytes(snapshot.stateHash, head.stateHash);
}

export function createHumanDeviceMembershipClient(input: Readonly<{
  api: HumanDeviceMembershipApiPort;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  clientKind: "browser" | "electron";
  installationLineageDigest: Uint8Array;
  idempotencyKey: string;
  personalAuthority?: Readonly<{
    ensure(anchor: Readonly<{ roomId: string; namespaceId: string }>): Promise<
      Readonly<{ status: "ready" | "pending" | "unavailable" }>
    >;
    recover?(anchor: Readonly<{ roomId: string; namespaceId: string }>, credential: Readonly<{
      keyId: string;
      generation: number;
      publicKey: Uint8Array;
      privateKey: Uint8Array;
    }>): Promise<Readonly<{ status: "ready" | "unavailable" }>>;
  }>;
  crypto?: LatticeCrypto;
}>) {
  const crypto = input.crypto ?? new LatticeCrypto();

  function exactProfileCoordinates(
    candidate: ClientProfileCoordinates,
  ): boolean {
    return candidate.serverScope === input.coordinates.serverScope
      && candidate.userId === input.coordinates.userId
      && candidate.humanActorId === input.coordinates.humanActorId
      && candidate.profileId === input.coordinates.profileId
      && candidate.deviceId === input.coordinates.deviceId
      && candidate.installationLineageDigest
        === input.coordinates.installationLineageDigest;
  }

  async function ensureAdditionalDeviceProfile(): Promise<void> {
    const availability = await input.vault.unlock();
    if (availability.status !== "available") {
      throw new Error("Human-device profile vault is unavailable");
    }
    const stageId = `human-device-pending:${input.coordinates.deviceId}`;
    const profiles = (await input.vault.listPublicProfiles()).filter((entry) =>
      exactProfileCoordinates(entry.coordinates)
    );
    if (profiles.some((entry) => entry.lifecycle === "active")) return;
    const staged = profiles.filter((entry) => entry.lifecycle === "staged");
    if (staged.length !== 0) {
      if (staged.length !== 1 || staged[0]!.stageId !== stageId
        || input.vault.withOpenStagedProfile === undefined) {
        throw new Error("Human-device pending profile custody is ambiguous");
      }
      await input.vault.withOpenStagedProfile(
        input.coordinates,
        stageId,
        async (profileBytes) => {
          const profile = await authenticateClientDeviceProfileV4({
            crypto,
            profileBytes,
            expectedDeviceId: input.coordinates.deviceId,
          });
          destroyOpenedClientDeviceProfileV4(profile);
        },
      );
      await input.vault.activateProfile(input.coordinates, stageId);
      return;
    }

    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    let v1Bytes: Uint8Array | undefined;
    let candidate: Awaited<ReturnType<
      typeof createClientDeviceProfileV4Candidate
    >> | undefined;
    let profileBytes: Uint8Array | undefined;
    try {
      v1Bytes = encodeClientDeviceProfileV1({
        deviceId: input.coordinates.deviceId,
        signingPublicKey: signing.publicKey,
        signingPrivateKey: signing.privateKey,
        encryptionPublicKey: encryption.publicKey,
        encryptionPrivateKey: encryption.privateKey,
      });
      candidate = await createClientDeviceProfileV4Candidate({
        crypto,
        currentProfileBytes: v1Bytes,
        expectedDeviceId: input.coordinates.deviceId,
        v1Migration: {
          trustedDeviceRevision: 0,
          trustedHostAuthorizationRevision: 0,
          deliveryHighWatermark: 0,
        },
      });
      profileBytes = encodeClientDeviceProfileV4(candidate);
      const fingerprint = crypto.hash(new Uint8Array([
        ...signing.publicKey,
        ...encryption.publicKey,
      ]));
      try {
        await input.vault.stageProfile({
          coordinates: input.coordinates,
          stageId,
          generation: 1,
          profileBytes,
          publicState: {
            clientKind: input.clientKind,
            publicFingerprint: hex(fingerprint),
          },
        });
      } finally {
        fingerprint.fill(0);
      }
      await input.vault.activateProfile(input.coordinates, stageId);
    } finally {
      v1Bytes?.fill(0);
      profileBytes?.fill(0);
      if (candidate !== undefined) destroyOpenedClientDeviceProfileV4(candidate);
      signing.privateKey.fill(0);
      encryption.privateKey.fill(0);
    }
  }

  async function status(afterSequence?: number) {
    return input.api.loadHumanDeviceMembership({
      requestVersion: 1,
      deviceId: input.coordinates.deviceId,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
  }

  async function personalAuthorityReady(
    current: HumanDeviceMembershipStatusV1,
  ): Promise<boolean> {
    if (current.personalAuthority === null) return true;
    if (input.personalAuthority === undefined) return false;
    return (await input.personalAuthority.ensure(current.personalAuthority)).status
      === "ready";
  }

  async function synchronizeDeviceRevision(
    current: HumanDeviceMembershipStatusV1,
  ): Promise<void> {
    if (current.membershipState === "absent") return;
    await advanceAndActivateClientTrustedDeviceAuthorityRevision({
      crypto,
      vault: input.vault,
      coordinates: input.coordinates,
      trustedDeviceRevision: current.deviceRevision,
      createStageId: () =>
        `human-device-authority:${input.coordinates.deviceId}:${String(current.deviceRevision)}`,
    });
  }

  async function withProfile<T>(operation: (context: Readonly<{
    profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>;
    providerVault: DeviceProviderStateVault;
  }>) => Promise<T>): Promise<T> {
    let result!: T;
    await input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto,
        profileBytes,
        expectedDeviceId: input.coordinates.deviceId,
      });
      const providerVault = DeviceProviderStateVault.fromKey(
        crypto,
        cryptoDeviceId(input.coordinates.deviceId),
        profile.baseProfile.providerStateSealingKey,
      );
      try {
        result = await operation({ profile, providerVault });
      } finally {
        providerVault.destroy();
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
    return result;
  }

  function stateFromProfile(
    profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
    head: HumanDeviceGroupHead,
    snapshotKind: "active" | "candidate",
  ): SealedProviderState {
    const record = profile.humanDeviceGroupSnapshot;
    const expectedEpoch = snapshotKind === "candidate"
      ? head.epoch + 1
      : head.epoch;
    if (record === null || record.providerId !== "openmls-v2"
      || record.epoch !== expectedEpoch
      || !sameBytes(record.stateHash, head.stateHash)) {
      throw new Error("Human-device local MLS state is unavailable");
    }
    return restoreSealedProviderState({
      providerId: record.providerId,
      domainId: cryptoDomainId(record.domainId),
      deviceId: cryptoDeviceId(input.coordinates.deviceId),
      revision: domainEpoch(record.epoch),
      snapshotKind,
      ciphertext: record.ciphertext,
    });
  }

  async function stageState(inputState: Readonly<{
    state: SealedProviderState;
    head: HumanDeviceGroupHead;
    stageId: string;
  }>): Promise<void> {
    const publicProfile = activeProfile(
      await input.vault.listPublicProfiles(),
      input.coordinates,
    );
    let candidateBytes: Uint8Array | undefined;
    await input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      const profile = await authenticateClientDeviceProfileV4({
        crypto,
        profileBytes,
        expectedDeviceId: input.coordinates.deviceId,
      });
      const record = Object.freeze({
        providerId: inputState.state.providerId,
        domainId: inputState.state.domainId,
        epoch: inputState.state.revision,
        stateHash: inputState.head.stateHash.slice(),
        ciphertext: inputState.state.ciphertext.slice(),
      });
      try {
        candidateBytes = encodeClientDeviceProfileV4(Object.freeze({
          formatVersion: 4 as const,
          baseProfile: profile.baseProfile,
          humanDeviceGroupSnapshot: record,
          signerEvidence: profile.signerEvidence,
        }));
      } finally {
        record.stateHash.fill(0);
        record.ciphertext.fill(0);
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
    try {
      await input.vault.stageProfile({
        coordinates: input.coordinates,
        stageId: inputState.stageId,
        generation: publicProfile.generation + 1,
        profileBytes: candidateBytes!,
        publicState: publicProfile.publicState,
      });
    } finally {
      candidateBytes?.fill(0);
    }
  }

  async function stagedStateMatches(
    stageId: string,
    head: HumanDeviceGroupHead,
  ): Promise<boolean> {
    if (input.vault.withOpenStagedProfile === undefined) {
      throw new Error("Human-device staged profile recovery is unsupported");
    }
    let matches = false;
    await input.vault.withOpenStagedProfile(
      input.coordinates,
      stageId,
      async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        try {
          matches = snapshotMatchesHead(profile, head);
        } finally {
          destroyOpenedClientDeviceProfileV4(profile);
        }
      },
    );
    return matches;
  }

  async function activeStateMatches(head: HumanDeviceGroupHead): Promise<boolean> {
    return withProfile(({ profile }) =>
      Promise.resolve(snapshotMatchesHead(profile, head))
    );
  }

  async function recoverInterruptedStage(
    current: HumanDeviceMembershipStatusV1,
  ): Promise<boolean> {
    const staged = (await input.vault.listPublicProfiles()).filter((entry) =>
      entry.lifecycle === "staged"
      && entry.coordinates.deviceId === input.coordinates.deviceId
      && entry.coordinates.profileId === input.coordinates.profileId
    );
    if (staged.length === 0) return false;
    if (staged.length !== 1 || staged[0]!.stageId === undefined) {
      throw new Error("Human-device staged profile state is ambiguous");
    }
    const stageId = staged[0]!.stageId;
    const knownStage = stageId.startsWith("human-device-initial:")
      || stageId.startsWith("human-device-join:")
      || stageId.startsWith("human-device-add:")
      || stageId.startsWith("human-device-remove:")
      || stageId.startsWith("human-device-recovery:")
      || stageId.startsWith("human-device-welcome:")
      || stageId.startsWith("human-device-catch-up:");
    if (!knownStage) {
      throw new Error("Another client profile transition is already staged");
    }
    if (current.head === null) {
      await input.vault.abortStagedProfile(input.coordinates, stageId);
      return true;
    }
    const head = decodeHumanDeviceGroupHead(
      decode(current.head.headBytesBase64url),
    );
    const operationMatches = stageId.startsWith("human-device-initial:")
      ? current.membershipState !== "unbound"
      : stageId.startsWith("human-device-join:")
      ? current.targetJoin !== null
        && stageId === `human-device-join:${current.targetJoin.operationId}`
      : stageId.startsWith("human-device-welcome:")
      ? current.welcome !== null
        && stageId === `human-device-welcome:${current.welcome.operationId}`
      : stageId.startsWith("human-device-remove:")
      ? ["catching_up", "current"].includes(current.membershipState)
      : stageId.startsWith("human-device-recovery:")
      ? current.membershipState === "current"
      : current.membershipState === "catching_up";
    if (operationMatches && await stagedStateMatches(stageId, head)) {
      await input.vault.activateProfile(input.coordinates, stageId);
    } else {
      await input.vault.abortStagedProfile(input.coordinates, stageId);
    }
    return true;
  }

  async function acknowledge(
    head: HumanDeviceGroupHead,
    sequence: number,
    leafIndex: number,
  ): Promise<void> {
    const digest = humanDeviceGroupHeadDigest(crypto, head);
    try {
      await input.api.acknowledgeHumanDeviceMembership({
        requestVersion: 1,
        deviceId: input.coordinates.deviceId,
        sequence,
        headDigestBase64url: encode(digest),
        leafIndex,
      });
    } finally {
      digest.fill(0);
    }
  }

  async function acknowledgeLocalHead(
    current: HumanDeviceMembershipStatusV1,
    head: HumanDeviceGroupHead,
  ): Promise<void> {
    if (current.head === null) {
      throw new Error("Human-device acknowledgement head is unavailable");
    }
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: current.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: head.lineageGeneration,
    });
    const member = await withProfile(async ({ profile, providerVault }) => {
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      return group.publicRoster(stateFromProfile(profile, head, "active"))
        .find((entry) => entry.deviceId === input.coordinates.deviceId);
    });
    if (member === undefined) throw new Error("Human-device leaf is unavailable");
    await acknowledge(head, current.head.sequence, member.leafIndex);
  }

  async function establishFirst(current: HumanDeviceMembershipStatusV1) {
    if (current.head !== null || current.membershipState !== "unbound") {
      throw new Error("Human-device first group state is inconsistent");
    }
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: current.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: 1,
    });
    const prepared = await withProfile(async ({ providerVault }) => {
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      return group.createInitialState();
    });
    const stageId = `human-device-initial:${prepared.head.groupId}`;
    await stageState({ state: prepared.active, head: prepared.head, stageId });
    await input.api.establishHumanDeviceMembership({
      requestVersion: 1,
      deviceId: input.coordinates.deviceId,
      headBytesBase64url: encode(encodeHumanDeviceGroupHead(prepared.head)),
      rosterBytesBase64url: encode(prepared.rosterBytes),
    });
    await input.vault.activateProfile(input.coordinates, stageId);
  }

  async function beginAdditional(): Promise<Readonly<{
    status: "waiting_for_approval";
    operationId: string;
    verificationCode: string;
  }>> {
    await ensureAdditionalDeviceProfile();
    let publicKeys!: Readonly<{
      signingPublicKey: Uint8Array;
      encryptionPublicKey: Uint8Array;
    }>;
    await withProfile(({ profile }) => {
      publicKeys = Object.freeze({
        signingPublicKey:
          profile.baseProfile.baseProfile.signingPublicKey.slice(),
        encryptionPublicKey:
          profile.baseProfile.baseProfile.encryptionPublicKey.slice(),
      });
      return Promise.resolve();
    });
    const plan = await input.api.beginHumanDeviceMembership({
      requestVersion: 1,
      deviceId: input.coordinates.deviceId,
      clientKind: input.clientKind,
      installationLineageDigestBase64url:
        encode(input.installationLineageDigest),
      deviceGeneration: 1,
      signingPublicKeyBase64url: encode(publicKeys.signingPublicKey),
      encryptionPublicKeyBase64url: encode(publicKeys.encryptionPublicKey),
      idempotencyKey: input.idempotencyKey,
    });
    const head = decodeHumanDeviceGroupHead(decode(plan.head.headBytesBase64url));
    await prepareAndPublishJoin(plan.enrollment.operationId, head);
    const code = deriveHumanDeviceMembershipVerificationCode({
      crypto,
      operationId: plan.enrollment.operationId,
      humanId: input.coordinates.humanActorId,
      targetDeviceId: input.coordinates.deviceId,
      targetSigningPublicKey: publicKeys.signingPublicKey,
    });
    return Object.freeze({
      status: "waiting_for_approval" as const,
      operationId: plan.enrollment.operationId,
      verificationCode: code,
    });
  }

  async function recoverWithMnemonic(
    mnemonic: string,
  ): Promise<Readonly<{ status: "recovered" }>> {
    if (input.api.beginHumanDeviceMembershipRecovery === undefined
      || input.api.completeHumanDeviceMembershipRecovery === undefined) {
      throw new Error("Human-device recovery is unavailable");
    }
    await ensureAdditionalDeviceProfile();
    let publicKeys!: Readonly<{
      signingPublicKey: Uint8Array;
      encryptionPublicKey: Uint8Array;
    }>;
    await withProfile(({ profile }) => {
      publicKeys = Object.freeze({
        signingPublicKey:
          profile.baseProfile.baseProfile.signingPublicKey.slice(),
        encryptionPublicKey:
          profile.baseProfile.baseProfile.encryptionPublicKey.slice(),
      });
      return Promise.resolve();
    });
    const recovery = await deriveRecoveryCredentialFromMnemonic(
      mnemonic,
      crypto,
    );
    const recoveryPublicKeyDigest = crypto.hash(recovery.publicKey);
    const encryptionPublicKeyDigest = crypto.hash(
      publicKeys.encryptionPublicKey,
    );
    const signingPublicKeyDigest = crypto.hash(publicKeys.signingPublicKey);
    try {
      const plan = await input.api.beginHumanDeviceMembershipRecovery({
        requestVersion: 1,
        deviceId: input.coordinates.deviceId,
        clientKind: input.clientKind,
        installationLineageDigestBase64url:
          encode(input.installationLineageDigest),
        deviceGeneration: 1,
        signingPublicKeyBase64url: encode(publicKeys.signingPublicKey),
        encryptionPublicKeyBase64url: encode(publicKeys.encryptionPublicKey),
        idempotencyKey: `${input.idempotencyKey}/recovery`,
      });
      const challengeBytes = decode(plan.challengeBytesBase64url);
      const challenge = decodeRecoveryDeviceActivationChallengeV2(
        challengeBytes,
      );
      if (challenge.recoveryKeyId !== recovery.keyId
        || !sameBytes(
          challenge.recoveryPublicKeyDigest,
          recoveryPublicKeyDigest,
        )) throw new Error("Recovery phrase is not current for this account");
      const proof = await answerRecoveryDevicePossessionChallenge({
        crypto,
        challengeBytes,
        pendingDevice: {
          humanId: humanId(input.coordinates.humanActorId),
          deviceId: cryptoDeviceId(input.coordinates.deviceId),
          pendingDeviceRevision: pendingDeviceRevisionV2(0),
          encryptionPublicKey: publicKeys.encryptionPublicKey,
          signingPublicKey: publicKeys.signingPublicKey,
        },
        resolveTrustedPendingDevice: (candidateHuman, candidateDevice) =>
          candidateHuman === input.coordinates.humanActorId
              && candidateDevice === input.coordinates.deviceId
            ? {
                humanId: humanId(input.coordinates.humanActorId),
                deviceId: cryptoDeviceId(input.coordinates.deviceId),
                pendingDeviceRevision: pendingDeviceRevisionV2(0),
                encryptionPublicKeyDigest,
                signingPublicKeyDigest,
                status: "pending",
              }
            : null,
        recoveryPublicKey: recovery.publicKey,
        recoveryPrivateKey: recovery.privateKey,
        resolveTrustedCurrentRecoveryKey: (candidateHuman) =>
          candidateHuman === input.coordinates.humanActorId
            ? {
                humanId: humanId(input.coordinates.humanActorId),
                recoveryKeyId: recovery.keyId,
                recoveryGeneration: challenge.recoveryGeneration,
                publicKeyDigest: challenge.recoveryPublicKeyDigest,
              }
            : null,
        currentTime: unixTimestamp(Date.now()),
      });
      const ownCredential = credential({
        ...input.coordinates,
        serverInstanceId: plan.serverInstanceId,
        installationLineageDigest: input.installationLineageDigest,
        lineageGeneration: plan.nextLineageGeneration,
      });
      const prepared = await withProfile(async ({ providerVault }) => {
        const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
          coordinates: ownCredential,
          ownCredential,
        });
        await group.initialize();
        return group.createInitialState();
      });
      const stageId = `human-device-recovery:${plan.operationId}`;
      await stageState({
        state: prepared.active,
        head: prepared.head,
        stageId,
      });
      let activatedAfterLostResponse = false;
      try {
        await input.api.completeHumanDeviceMembershipRecovery(
          plan.operationId,
          {
            requestVersion: 1,
            deviceId: input.coordinates.deviceId,
            challengeHashBase64url: encode(proof.challengeHash),
            responseBase64url: encode(proof.response),
            headBytesBase64url: encode(
              encodeHumanDeviceGroupHead(prepared.head),
            ),
            rosterBytesBase64url: encode(prepared.rosterBytes),
          },
        );
      } catch (error) {
        const current = await status().catch(() => null);
        if (current?.head !== null && current?.membershipState === "current") {
          const currentHead = decodeHumanDeviceGroupHead(
            decode(current.head.headBytesBase64url),
          );
          if (await stagedStateMatches(stageId, currentHead)) {
            await input.vault.activateProfile(input.coordinates, stageId);
            activatedAfterLostResponse = true;
          }
        }
        if (!activatedAfterLostResponse) {
          await input.vault.abortStagedProfile(input.coordinates, stageId)
            .catch(() => undefined);
          throw error;
        }
      } finally {
        proof.response.fill(0);
        proof.challengeHash.fill(0);
      }
      if (!activatedAfterLostResponse) {
        await input.vault.activateProfile(input.coordinates, stageId);
      }
      const current = await status();
      await synchronizeDeviceRevision(current);
      if (
        current.personalAuthority !== null
        && (
          input.personalAuthority === undefined
          || input.personalAuthority.recover === undefined
          || (await input.personalAuthority.recover(
            current.personalAuthority,
            {
              keyId: recovery.keyId,
              generation: challenge.recoveryGeneration,
              publicKey: recovery.publicKey,
              privateKey: recovery.privateKey,
            },
          )).status !== "ready"
        )
      ) {
        throw new Error("Human-device personal authority recovery is incomplete");
      }
      return Object.freeze({ status: "recovered" as const });
    } finally {
      recovery.privateKey.fill(0);
      recovery.publicKey.fill(0);
      recoveryPublicKeyDigest.fill(0);
      encryptionPublicKeyDigest.fill(0);
      signingPublicKeyDigest.fill(0);
      publicKeys.signingPublicKey.fill(0);
      publicKeys.encryptionPublicKey.fill(0);
    }
  }

  async function prepareAndPublishJoin(
    operationId: string,
    head: HumanDeviceGroupHead,
  ): Promise<void> {
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: head.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: head.lineageGeneration,
    });
    const join = await withProfile(async ({ providerVault }) => {
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      return group.createJoinRequest(head);
    });
    const stageId = `human-device-join:${operationId}`;
    await stageState({ state: join.localState, head, stageId });
    await input.api.publishHumanDeviceMembershipJoin(
      operationId,
      {
        requestVersion: 1,
        deviceId: input.coordinates.deviceId,
        requestBytesBase64url: encode(
          encodeHumanDeviceGroupJoinRequest(join.publicResult),
        ),
      },
    );
    await input.vault.activateProfile(input.coordinates, stageId);
  }

  async function applyWelcome(
    current: HumanDeviceMembershipStatusV1,
  ): Promise<void> {
    if (current.head === null || current.welcome === null
      || current.targetJoin === null) {
      throw new Error("Human-device Welcome is incomplete");
    }
    const head = decodeHumanDeviceGroupHead(
      decode(current.head.headBytesBase64url),
    );
    const transition = decodeHumanDeviceGroupTransition(
      crypto,
      decode(current.welcome.transitionBytesBase64url),
    );
    const joinRequest = decodeHumanDeviceGroupJoinRequest(
      decode(current.targetJoin.requestBytesBase64url),
    );
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: current.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: head.lineageGeneration,
    });
    const activated = await withProfile(async ({ profile, providerVault }) => {
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      const joinState = stateFromProfile(
        profile,
        joinRequest.expectedHead,
        "candidate",
      );
      const candidate = await group.prepareWelcome({
        joinState,
        joinRequest,
        transition,
        welcomeBytes: decode(current.welcome!.welcomeBytesBase64url),
      });
      const result = group.activateWelcome({ candidate, joinState });
      if (result.status !== "applied") {
        throw new Error("Human-device Welcome activation aborted");
      }
      return result.active;
    });
    const stageId = `human-device-welcome:${current.welcome.operationId}`;
    await stageState({ state: activated, head, stageId });
    await input.vault.activateProfile(input.coordinates, stageId);
    const roster = await withProfile(async ({ profile, providerVault }) => {
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      return group.publicRoster(stateFromProfile(profile, head, "active"));
    });
    const member = roster.find((entry) =>
      entry.deviceId === input.coordinates.deviceId
    );
    if (member === undefined) throw new Error("Human-device leaf is unavailable");
    await acknowledge(head, current.head.sequence, member.leafIndex);
  }

  async function catchUp(current: HumanDeviceMembershipStatusV1): Promise<void> {
    if (current.head === null || current.commits.length === 0) return;
    const finalHead = decodeHumanDeviceGroupHead(
      decode(current.head.headBytesBase64url),
    );
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: current.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: finalHead.lineageGeneration,
    });
    let active: SealedProviderState | undefined;
    let trustedHead: HumanDeviceGroupHead | undefined;
    let page = current;
    for (;;) {
      await withProfile(async ({ profile, providerVault }) => {
        const first = decodeHumanDeviceGroupTransition(
          crypto,
          decode(page.commits[0]!.transitionBytesBase64url),
        );
        if (active === undefined || trustedHead === undefined) {
          trustedHead = first.expectedHead;
          active = stateFromProfile(profile, trustedHead, "active");
        } else if (!sameBytes(
          encodeHumanDeviceGroupHead(trustedHead),
          encodeHumanDeviceGroupHead(first.expectedHead),
        )) {
          throw new Error("Human-device commit pages are discontinuous");
        }
        const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
          coordinates: ownCredential,
          ownCredential,
        });
        await group.initialize();
        for (const item of page.commits) {
          const transition = decodeHumanDeviceGroupTransition(
            crypto,
            decode(item.transitionBytesBase64url),
          );
          const candidate = await group.prepareIncoming({
            active,
            transition,
          });
          const applied = group.applyCandidate({ active, candidate });
          if (applied.status !== "applied") {
            throw new Error("Human-device catch-up aborted");
          }
          active = applied.active;
          trustedHead = transition.nextHead;
        }
      });
      if (page.nextSequence === null) break;
      page = await status(page.nextSequence);
      if (page.head === null || page.commits.length === 0
        || !sameBytes(
          decode(page.head.headBytesBase64url),
          encodeHumanDeviceGroupHead(finalHead),
        )) {
        throw new Error("Human-device commit pagination changed concurrently");
      }
    }
    if (trustedHead === undefined || active === undefined
      || !sameBytes(encodeHumanDeviceGroupHead(trustedHead),
        encodeHumanDeviceGroupHead(finalHead))) {
      throw new Error("Human-device commit page did not reach its head");
    }
    const stageId = `human-device-catch-up:${current.head.sequence}`;
    await stageState({ state: active, head: finalHead, stageId });
    await input.vault.activateProfile(input.coordinates, stageId);
    const member = await withProfile(async ({ profile, providerVault }) => {
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      return group.publicRoster(stateFromProfile(profile, finalHead, "active"))
        .find((entry) => entry.deviceId === input.coordinates.deviceId);
    });
    if (member === undefined) throw new Error("Human-device leaf is unavailable");
    await acknowledge(finalHead, current.head.sequence, member.leafIndex);
  }

  async function ensure(): Promise<HumanDeviceMembershipProgress> {
    let current = await status();
    if (await recoverInterruptedStage(current)) current = await status();
    if (current.membershipState === "absent") {
      return Object.freeze({ status: "additional_required" as const });
    }
    if (current.head === null && current.membershipState === "unbound") {
      await establishFirst(current);
      current = await status();
      await synchronizeDeviceRevision(current);
      return await personalAuthorityReady(current)
        ? Object.freeze({ status: "ready" as const })
        : Object.freeze({
            status: "syncing" as const,
            syncReason: "personal_authority_required" as const,
          });
    }
    if (current.membershipState === "stale") {
      return Object.freeze({ status: "stale" as const });
    }
    if (current.membershipState === "removed") {
      return Object.freeze({ status: "removed" as const });
    }
    const currentHead = current.head === null ? null : decodeHumanDeviceGroupHead(
      decode(current.head.headBytesBase64url),
    );
    if (
      currentHead !== null
      && (current.membershipState === "welcome_pending"
        || current.membershipState === "catching_up")
      && await activeStateMatches(currentHead)
    ) {
      await acknowledgeLocalHead(current, currentHead);
      current = await status();
      await synchronizeDeviceRevision(current);
      return await personalAuthorityReady(current)
        ? Object.freeze({ status: "ready" as const })
        : Object.freeze({
            status: "syncing" as const,
            syncReason: "personal_authority_required" as const,
          });
    }
    if (current.membershipState === "welcome_pending") {
      await applyWelcome(current);
      const activated = await status();
      await synchronizeDeviceRevision(activated);
      return await personalAuthorityReady(activated)
        ? Object.freeze({ status: "ready" as const })
        : Object.freeze({
            status: "syncing" as const,
            syncReason: "personal_authority_required" as const,
          });
    }
    if (current.membershipState === "catching_up") {
      await catchUp(current);
      const caughtUp = await status();
      await synchronizeDeviceRevision(caughtUp);
      return await personalAuthorityReady(caughtUp)
        ? Object.freeze({ status: "ready" as const })
        : Object.freeze({
            status: "syncing" as const,
            syncReason: "personal_authority_required" as const,
          });
    }
    if (current.membershipState === "pending") {
      const target = current.targetJoin;
      if (target === null) return Object.freeze({ status: "syncing" as const });
      if (current.head === null) {
        throw new Error("Human-device pending head is unavailable");
      }
      const pendingRequest = decodeHumanDeviceGroupJoinRequest(
        decode(target.requestBytesBase64url),
      );
      const currentHead = decodeHumanDeviceGroupHead(
        decode(current.head.headBytesBase64url),
      );
      if (!sameBytes(
        encodeHumanDeviceGroupHead(pendingRequest.expectedHead),
        encodeHumanDeviceGroupHead(currentHead),
      )) {
        await prepareAndPublishJoin(target.operationId, currentHead);
        return ensure();
      }
      let targetSigningPublicKey!: Uint8Array;
      await withProfile(({ profile }) => {
        targetSigningPublicKey =
          profile.baseProfile.baseProfile.signingPublicKey.slice();
        return Promise.resolve();
      });
      return Object.freeze({
        status: "waiting_for_approval" as const,
        operationId: target.operationId,
        verificationCode: deriveHumanDeviceMembershipVerificationCode({
          crypto,
          operationId: target.operationId,
          humanId: input.coordinates.humanActorId,
          targetDeviceId: input.coordinates.deviceId,
          targetSigningPublicKey,
        }),
      });
    }
    if (current.membershipState !== "current") {
      return Object.freeze({ status: "additional_required" as const });
    }
    if (currentHead === null) {
      throw new Error("Human-device current head is unavailable");
    }
    if (!await activeStateMatches(currentHead)) {
      if (current.commits.length === 0) {
        return Object.freeze({ status: "stale" as const });
      }
      await catchUp(current);
      current = await status();
    }
    await synchronizeDeviceRevision(current);
    return await personalAuthorityReady(current)
      ? Object.freeze({ status: "ready" as const })
      : Object.freeze({
          status: "syncing" as const,
          syncReason: "personal_authority_required" as const,
        });
  }

  async function pending() {
    const candidates: HumanDeviceMembershipPendingV1["pending"][number][] = [];
    let afterOperationId: string | undefined;
    for (;;) {
      const result = await input.api.listHumanDeviceMembershipPending({
        requestVersion: 1,
        approverDeviceId: input.coordinates.deviceId,
        ...(afterOperationId === undefined ? {} : { afterOperationId }),
      });
      candidates.push(...result.pending);
      if (result.nextOperationId === null) break;
      if (result.nextOperationId === afterOperationId) {
        throw new Error("Human-device pending pagination did not advance");
      }
      afterOperationId = result.nextOperationId;
    }
    return candidates.map((candidate) => ({
      candidate,
      verificationCode: deriveHumanDeviceMembershipVerificationCode({
        crypto,
        operationId: candidate.operationId,
        humanId: input.coordinates.humanActorId,
        targetDeviceId: candidate.targetDeviceId,
        targetSigningPublicKey: decode(
          candidate.targetSigningPublicKeyBase64url,
        ),
      }),
    }));
  }

  async function approve(
    operationId: string,
    verificationCode: string,
  ): Promise<Readonly<{ status: "transition_ready" }>> {
    const selected = (await pending()).find((entry) =>
      entry.candidate.operationId === operationId
    );
    if (selected === undefined
      || selected.verificationCode !== verificationCode) {
      throw new Error("Human-device comparison code does not match");
    }
    const joinRequest = decodeHumanDeviceGroupJoinRequest(
      decode(selected.candidate.requestBytesBase64url),
    );
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: joinRequest.coordinates.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: joinRequest.expectedHead.lineageGeneration,
    });
    const prepared = await withProfile(async ({ profile, providerVault }) => {
      const active = stateFromProfile(
        profile,
        joinRequest.expectedHead,
        "active",
      );
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      const transition = await group.prepareAdd({
        active,
        currentHead: joinRequest.expectedHead,
        joinRequest,
      });
      const applied = group.applyCandidate({
        active,
        candidate: transition.localCandidate,
      });
      if (applied.status !== "applied") {
        throw new Error("Human-device Add activation aborted");
      }
      return Object.freeze({ transition, active: applied.active });
    });
    const stageId = `human-device-add:${operationId}`;
    await stageState({
      state: prepared.active,
      head: prepared.transition.publicResult.nextHead,
      stageId,
    });
    await input.api.publishHumanDeviceMembershipAdd(operationId, {
      requestVersion: 1,
      committerDeviceId: input.coordinates.deviceId,
      transitionBytesBase64url: encode(
        encodeHumanDeviceGroupTransition(prepared.transition.publicResult),
      ),
      welcomeBytesBase64url: encode(
        prepared.transition.publicResult.welcomeBytes,
      ),
    });
    await input.vault.activateProfile(input.coordinates, stageId);
    const member = prepared.transition.publicResult.committerCredential;
    const roster = prepared.transition.publicResult.rosterBytes;
    const local = decodeHumanDeviceRoster(roster).find((entry) =>
        entry.deviceId === member.deviceId
      );
    if (local === undefined) throw new Error("Human-device committer leaf missing");
    const published = await status();
    if (published.head === null) {
      throw new Error("Human-device published head is unavailable");
    }
    await acknowledge(
      prepared.transition.publicResult.nextHead,
      published.head.sequence,
      local.leafIndex,
    );
    await synchronizeDeviceRevision(await status());
    return Object.freeze({ status: "transition_ready" as const });
  }

  async function removeDevice(
    targetDeviceId: string,
    pin: string,
  ): Promise<Readonly<{ status: "removed"; deviceId: string }>> {
    if (!/^\d{6,8}$/u.test(pin)) {
      throw new Error("PIN must be 6–8 digits");
    }
    const current = await status();
    if (current.membershipState !== "current" || current.head === null) {
      throw new Error("Human-device removal requires a current device");
    }
    if (targetDeviceId === input.coordinates.deviceId) {
      throw new Error("Human-device removal must target another device");
    }
    const head = decodeHumanDeviceGroupHead(
      decode(current.head.headBytesBase64url),
    );
    const ownCredential = credential({
      ...input.coordinates,
      serverInstanceId: current.serverInstanceId,
      installationLineageDigest: input.installationLineageDigest,
      lineageGeneration: head.lineageGeneration,
    });
    const prepared = await withProfile(async ({ profile, providerVault }) => {
      const active = stateFromProfile(profile, head, "active");
      const group = new HumanDeviceOpenMlsGroup(crypto, providerVault, {
        coordinates: ownCredential,
        ownCredential,
      });
      await group.initialize();
      const target = group.publicRoster(active).find((entry) =>
        entry.deviceId === targetDeviceId
      );
      if (target === undefined) {
        throw new Error("Human-device removal target is not current");
      }
      const transition = await group.prepareRemove({
        active,
        currentHead: head,
        removedCredential: Object.freeze({
          formatVersion: target.formatVersion,
          serverInstanceId: target.serverInstanceId,
          humanId: target.humanId,
          lineageGeneration: target.lineageGeneration,
          deviceId: target.deviceId,
          installationLineageDigest:
            target.installationLineageDigest.slice(),
          deviceKeyGeneration: target.deviceKeyGeneration,
        }),
      });
      const applied = group.applyCandidate({
        active,
        candidate: transition.localCandidate,
      });
      if (applied.status !== "applied") {
        throw new Error("Human-device Remove activation aborted");
      }
      return Object.freeze({ transition, active: applied.active });
    });
    const operationRandom = crypto.randomBytes(16);
    const operationId = `human-device-remove-${hex(operationRandom)}`;
    operationRandom.fill(0);
    const stageId = `human-device-remove:${operationId}`;
    await stageState({
      state: prepared.active,
      head: prepared.transition.publicResult.nextHead,
      stageId,
    });
    await input.api.publishHumanDeviceMembershipRemove(operationId, {
      requestVersion: 1,
      committerDeviceId: input.coordinates.deviceId,
      transitionBytesBase64url: encode(
        encodeHumanDeviceGroupTransition(prepared.transition.publicResult),
      ),
      pin,
    });
    await input.vault.activateProfile(input.coordinates, stageId);
    const next = await status();
    if (next.head === null) {
      throw new Error("Human-device removed head is unavailable");
    }
    const local = decodeHumanDeviceRoster(
      prepared.transition.publicResult.rosterBytes,
    ).find((entry) => entry.deviceId === input.coordinates.deviceId);
    if (local === undefined) {
      throw new Error("Human-device removing leaf is unavailable");
    }
    await acknowledge(
      prepared.transition.publicResult.nextHead,
      next.head.sequence,
      local.leafIndex,
    );
    await synchronizeDeviceRevision(await status());
    return Object.freeze({
      status: "removed" as const,
      deviceId: targetDeviceId,
    });
  }

  return Object.freeze({
    async requiresAdditionalDevice(): Promise<boolean> {
      return serializeMembershipOperation(
        input.coordinates,
        async () => {
          const current = await status();
          return current.membershipState === "absent" && current.head !== null;
        },
      );
    },
    ensure: () => serializeMembershipOperation(input.coordinates, ensure),
    beginAdditional: () => serializeMembershipOperation(
      input.coordinates,
      beginAdditional,
    ),
    async hasPending(): Promise<boolean> {
      return serializeMembershipOperation(input.coordinates, async () => {
        const result = await ensure();
        return result.status === "waiting_for_approval"
          || (result.status === "syncing"
            && result.syncReason !== "personal_authority_required");
      });
    },
    async inspectPending() {
      return serializeMembershipOperation(input.coordinates, async () => {
        const result = await ensure();
        return result.status === "waiting_for_approval"
          || (result.status === "syncing"
            && result.syncReason !== "personal_authority_required")
          ? Object.freeze({
              status: result.status === "syncing"
                ? "syncing" as const
                : "waiting_for_approval" as const,
              ...("operationId" in result && result.operationId !== undefined
                ? { operationId: result.operationId }
                : {}),
              ...("verificationCode" in result
                  && result.verificationCode !== undefined
                ? { verificationCode: result.verificationCode }
                : {}),
              ...("syncReason" in result && result.syncReason !== undefined
                ? { syncReason: result.syncReason }
                : {}),
            })
          : null;
      });
    },
    async continue() {
      return serializeMembershipOperation(input.coordinates, async () => {
        const result = await ensure();
        switch (result.status) {
          case "additional_required":
            return beginAdditional();
          case "ready":
            return Object.freeze({
              status: "active" as const,
              operationId: "human-device-current",
            });
          case "stale":
            throw new Error("Human-device local MLS state is stale");
          case "removed":
            throw new Error("Human-device was removed");
          case "waiting_for_approval":
          case "syncing":
            return Object.freeze({
              ...result,
              operationId: result.operationId ?? "human-device-sync",
            });
        }
      });
    },
    async inspect() {
      return serializeMembershipOperation(
        input.coordinates,
        async () => (await pending()).map((entry) => Object.freeze({
          enrollment: Object.freeze({
            operationId: entry.candidate.operationId,
            deviceId: entry.candidate.targetDeviceId,
            clientKind: entry.candidate.targetClientKind,
          }),
          verificationCode: entry.verificationCode,
          progress: "approval_required" as const,
        })),
      );
    },
    approve: (operationId: string, verificationCode: string) =>
      serializeMembershipOperation(
        input.coordinates,
        () => approve(operationId, verificationCode),
      ),
    removeDevice: (targetDeviceId: string, pin: string) =>
      serializeMembershipOperation(
        input.coordinates,
        () => removeDevice(targetDeviceId, pin),
      ),
    recoverWithMnemonic: (mnemonic: string) =>
      serializeMembershipOperation(
        input.coordinates,
        () => recoverWithMnemonic(mnemonic),
      ),
    roster: () => serializeMembershipOperation(
      input.coordinates,
      () => input.api.listHumanDeviceMembershipRoster({
        requestVersion: 1,
        currentDeviceId: input.coordinates.deviceId,
      }),
    ),
    async advance(operationId: string) {
      return serializeMembershipOperation(input.coordinates, async () => {
        const selected = (await pending()).find((entry) =>
          entry.candidate.operationId === operationId
        );
        if (selected === undefined) return Object.freeze({ status: "active" });
        return approve(operationId, selected.verificationCode);
      });
    },
  });
}

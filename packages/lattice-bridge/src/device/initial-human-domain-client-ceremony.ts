import {
  DeviceProviderStateVault,
  OpenMlsGroupProvider,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  participantDigest,
  restoreSealedProviderState,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import type {
  ProviderPublicHeadV2 as ProviderPublicHead,
} from "@nautilo/lattice-crypto/wire";

import {
  addClientDomainProviderSnapshot,
  destroyOpenedClientDeviceProfileV3,
} from "../client-vault/profile-v3.ts";
import {
  authenticateClientDeviceProfileV4,
  createClientDeviceProfileV4Candidate,
  destroyOpenedClientDeviceProfileV4,
  encodeClientDeviceProfileV4,
  type OpenedClientDeviceProfileV4,
} from "../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../client-vault/types.ts";
import {
  createHumanMembershipTargetDomainSubmission,
  humanMembershipTargetDomainSubmissionDigest,
  type HumanMembershipTargetDomainSubmission,
} from "../delivery/human-membership-target-domain.ts";

const FORMAT_VERSION = 1 as const;
const HASH_BYTES = 32;

export type InitialHumanDomainClientDeferralReason =
  | "existing_domain_requires_delivery"
  | "multiple_active_devices_require_fanout";

export interface InitialHumanDomainReceiptExpectation {
  readonly operationId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly domainId: string;
  readonly providerId: string;
  readonly epoch: 0;
  readonly stateHash: Uint8Array;
  readonly rosterHash: Uint8Array;
  readonly submissionDigest: Uint8Array;
  readonly stageId: string;
  readonly profileGeneration: number;
}

export interface InitialHumanDomainServerReceipt {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly status: "active";
  readonly operationId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly domainId: string;
  readonly providerId: string;
  readonly epoch: 0;
  readonly stateHash: Uint8Array;
  readonly rosterHash: Uint8Array;
  readonly submissionDigest: Uint8Array;
  readonly committedAt: number;
}

export type InitialHumanDomainClientPreparation =
  | Readonly<{
    status: "deferred";
    reason: InitialHumanDomainClientDeferralReason;
  }>
  | Readonly<{
    status: "prepared";
    submission: HumanMembershipTargetDomainSubmission;
    receiptExpectation: InitialHumanDomainReceiptExpectation;
  }>;

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactHash(label: string, value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new RangeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
  return value.slice();
}

function assertHash(label: string, value: Uint8Array): void {
  if (!(value instanceof Uint8Array) || value.length !== HASH_BYTES) {
    throw new RangeError(`${label} must be exactly ${HASH_BYTES} bytes`);
  }
}

function sameCoordinates(
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

function destroySubmission(
  submission: HumanMembershipTargetDomainSubmission | undefined,
): void {
  if (submission === undefined) return;
  submission.participantDigest.fill(0);
  submission.initialProviderHead.stateHash.fill(0);
  submission.initialRosterBytes.fill(0);
  submission.chainDigest.fill(0);
  submission.signature.fill(0);
}

function cloneSubmission(
  submission: HumanMembershipTargetDomainSubmission,
): HumanMembershipTargetDomainSubmission {
  return Object.freeze({
    ...submission,
    participants: Object.freeze([...submission.participants]),
    participantDigest: submission.participantDigest.slice(),
    initialProviderHead: Object.freeze({
      ...submission.initialProviderHead,
      stateHash: submission.initialProviderHead.stateHash.slice(),
    }),
    initialRosterBytes: submission.initialRosterBytes.slice(),
    additions: Object.freeze([]),
    chainDigest: submission.chainDigest.slice(),
    signature: submission.signature.slice(),
  });
}

async function recoverStagedInitialHumanDomainPreparation(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  operationId: string;
  domainId?: string;
  humanId: string;
  generation: number;
  trustedDeviceRevision: number;
  trustedHostAuthorizationRevision: number;
}>): Promise<Extract<InitialHumanDomainClientPreparation, { status: "prepared" }>> {
  let profile: OpenedClientDeviceProfileV4 | undefined;
  let submission: HumanMembershipTargetDomainSubmission | undefined;
  let detachedSubmission: HumanMembershipTargetDomainSubmission | undefined;
  let stateHash: Uint8Array | undefined;
  let rosterBytes: Uint8Array | undefined;
  let rosterHash: Uint8Array | undefined;
  let submissionDigest: Uint8Array | undefined;
  try {
    if (input.vault.withOpenStagedProfile === undefined) {
      throw new Error("Initial Human Domain staged profile recovery is unavailable");
    }
    await input.vault.withOpenStagedProfile(
      input.coordinates,
      input.operationId,
      async (profileBytes) => {
        profile = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        if (
          profile.baseProfile.baseProfile.trustedDeviceRevision
            !== input.trustedDeviceRevision
          || profile.baseProfile.baseProfile.trustedHostAuthorizationRevision
            !== input.trustedHostAuthorizationRevision
        ) {
          throw new Error("Initial Human Domain staged profile authority is stale");
        }
        const record = input.domainId === undefined
          ? profile.baseProfile.activeProviderSnapshots[0]
          : profile.baseProfile.activeProviderSnapshots.find(
            (entry) => entry.domainId === input.domainId,
          );
        if (
          record === undefined
          || record.epoch !== 0
          || profile.baseProfile.activeProviderSnapshots.length !== 1
        ) {
          throw new Error("Initial Human Domain staged provider snapshot is not exact");
        }
        const providerVault = DeviceProviderStateVault.fromKey(
          input.crypto,
          cryptoDeviceId(input.coordinates.deviceId),
          profile.baseProfile.providerStateSealingKey,
        );
        const providerState = restoreSealedProviderState({
          providerId: record.providerId,
          domainId: cryptoDomainId(record.domainId),
          deviceId: cryptoDeviceId(input.coordinates.deviceId),
          revision: domainEpoch(0),
          snapshotKind: "active",
          ciphertext: record.ciphertext,
        });
        try {
          const provider = new OpenMlsGroupProvider(input.crypto, providerVault);
          await provider.initialize();
          const head = provider.publicHead(providerState);
          if (
            (input.domainId !== undefined && head.domainId !== input.domainId)
            || head.providerId !== record.providerId
            || head.epoch !== 0
            || !bytesEqual(head.stateHash, record.stateHash)
          ) {
            head.stateHash.fill(0);
            throw new Error("Initial Human Domain staged provider head is not exact");
          }
          stateHash = head.stateHash.slice();
          rosterBytes = provider.publicRoster(providerState);
          rosterHash = input.crypto.hash(rosterBytes);
          const targetHumanId = humanId(input.humanId);
          const targetDomainId = cryptoDomainId(record.domainId);
          const targetDeviceId = cryptoDeviceId(input.coordinates.deviceId);
          const digest = participantDigest([targetHumanId]);
          try {
            submission = createHumanMembershipTargetDomainSubmission({
              crypto: input.crypto,
              operationId: input.operationId,
              targetDomainId,
              participants: [targetHumanId],
              participantDigest: digest,
              committerDeviceId: targetDeviceId,
              committerHumanId: targetHumanId,
              initialProviderHead: head,
              initialRosterBytes: rosterBytes,
              additions: [],
              signingPrivateKey:
                profile.baseProfile.baseProfile.signingPrivateKey,
            });
          } finally {
            digest.fill(0);
            head.stateHash.fill(0);
          }
          submissionDigest = humanMembershipTargetDomainSubmissionDigest({
            crypto: input.crypto,
            submission,
          });
          detachedSubmission = cloneSubmission(submission);
        } finally {
          providerState.ciphertext.fill(0);
          providerVault.destroy();
        }
      },
    );
    return Object.freeze({
      status: "prepared" as const,
      submission: detachedSubmission!,
      receiptExpectation: Object.freeze({
        operationId: input.operationId,
        humanId: input.humanId,
        deviceId: input.coordinates.deviceId,
        domainId: detachedSubmission!.targetDomainId,
        providerId: detachedSubmission!.initialProviderHead.providerId,
        epoch: 0 as const,
        stateHash: stateHash!.slice(),
        rosterHash: rosterHash!.slice(),
        submissionDigest: submissionDigest!.slice(),
        stageId: input.operationId,
        profileGeneration: input.generation,
      }),
    });
  } finally {
    if (profile) destroyOpenedClientDeviceProfileV4(profile);
    destroySubmission(submission);
    stateHash?.fill(0);
    rosterBytes?.fill(0);
    rosterHash?.fill(0);
    submissionDigest?.fill(0);
  }
}

/**
 * Discovers and reopens the sole interrupted singleton-Domain stage after a
 * real client restart. Operation and Domain coordinates come from the sealed
 * staged custody itself; callers do not need to retain either in memory.
 */
export async function resumeStagedInitialHumanDomainClientCeremony(
  input: Readonly<{
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    trustedDeviceRevision?: number;
    trustedHostAuthorizationRevision?: number;
  }>,
): Promise<Extract<InitialHumanDomainClientPreparation, { status: "prepared" }>> {
  const profiles = await input.vault.listPublicProfiles();
  const active = profiles.find((entry) =>
    entry.lifecycle === "active"
    && sameCoordinates(entry.coordinates, input.coordinates)
  );
  const staged = profiles.filter((entry) =>
    entry.lifecycle === "staged"
    && sameCoordinates(entry.coordinates, input.coordinates)
  );
  if (
    active === undefined
    || staged.length !== 1
    || staged[0]!.stageId === undefined
    || staged[0]!.generation !== active.generation + 1
  ) {
    throw new Error("Initial Human Domain interrupted stage is unavailable");
  }
  let stagedAuthority: Readonly<{
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
  }> | undefined;
  if (
    input.trustedDeviceRevision === undefined
    || input.trustedHostAuthorizationRevision === undefined
  ) {
    if (input.vault.withOpenStagedProfile === undefined) {
      throw new Error("Initial Human Domain staged profile recovery is unavailable");
    }
    await input.vault.withOpenStagedProfile(
      input.coordinates,
      staged[0]!.stageId,
      async (profileBytes) => {
        const profile = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
        try {
          stagedAuthority = Object.freeze({
            trustedDeviceRevision:
              profile.baseProfile.baseProfile.trustedDeviceRevision,
            trustedHostAuthorizationRevision:
              profile.baseProfile.baseProfile.trustedHostAuthorizationRevision,
          });
        } finally {
          destroyOpenedClientDeviceProfileV4(profile);
        }
      },
    );
  }
  const trustedDeviceRevision = input.trustedDeviceRevision
    ?? stagedAuthority?.trustedDeviceRevision;
  const trustedHostAuthorizationRevision =
    input.trustedHostAuthorizationRevision
    ?? stagedAuthority?.trustedHostAuthorizationRevision;
  if (
    trustedDeviceRevision === undefined
    || trustedHostAuthorizationRevision === undefined
  ) {
    throw new Error("Initial Human Domain staged authority is unavailable");
  }
  return recoverStagedInitialHumanDomainPreparation({
    crypto: input.crypto,
    vault: input.vault,
    coordinates: input.coordinates,
    operationId: staged[0]!.stageId,
    humanId: humanId(input.coordinates.humanActorId),
    generation: staged[0]!.generation,
    trustedDeviceRevision,
    trustedHostAuthorizationRevision,
  });
}

async function openOrMigrateProfileV4(input: Readonly<{
  crypto: LatticeCrypto;
  profileBytes: Uint8Array;
  expectedDeviceId: string;
  trustedDeviceRevision: number;
  trustedHostAuthorizationRevision: number;
  deliveryHighWatermark: number;
}>): Promise<OpenedClientDeviceProfileV4> {
  try {
    return await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes: input.profileBytes,
      expectedDeviceId: input.expectedDeviceId,
    });
  } catch (error) {
    if (
      !(error instanceof TypeError)
      || error.message !== "Client profile v4 is unavailable"
    ) throw error;
  }
  return createClientDeviceProfileV4Candidate({
    crypto: input.crypto,
    currentProfileBytes: input.profileBytes,
    expectedDeviceId: input.expectedDeviceId,
    v1Migration: {
      trustedDeviceRevision: input.trustedDeviceRevision,
      trustedHostAuthorizationRevision:
        input.trustedHostAuthorizationRevision,
      deliveryHighWatermark: input.deliveryHighWatermark,
    },
  });
}

/**
 * Creates only the singleton fresh-device Domain case. Existing Domains and a
 * multi-device inventory deliberately defer to the existing join/fanout flow.
 * The sealed provider state is staged in profile v4 but remains inactive until
 * an exact durable server receipt is presented.
 */
export async function prepareAndStageInitialHumanDomainClientCeremony(
  input: Readonly<{
    crypto: LatticeCrypto;
    vault: ClientProfileVault;
    coordinates: ClientProfileCoordinates;
    operationId: string;
    domainId: string;
    humanId: string;
    currentDomainHead: ProviderPublicHead | null;
    activeDeviceIds: readonly string[];
    trustedDeviceRevision: number;
    trustedHostAuthorizationRevision: number;
    deliveryHighWatermark: number;
  }>,
): Promise<InitialHumanDomainClientPreparation> {
  const targetHumanId = humanId(input.humanId);
  const targetDeviceId = cryptoDeviceId(input.coordinates.deviceId);
  const targetDomainId = cryptoDomainId(input.domainId);
  if (targetHumanId !== input.coordinates.humanActorId) {
    throw new Error("Initial Human Domain Human authority was substituted");
  }
  if (input.currentDomainHead !== null) {
    return Object.freeze({
      status: "deferred" as const,
      reason: "existing_domain_requires_delivery" as const,
    });
  }
  const devices = [...input.activeDeviceIds].sort();
  if (devices.length > 1) {
    return Object.freeze({
      status: "deferred" as const,
      reason: "multiple_active_devices_require_fanout" as const,
    });
  }
  if (devices.length !== 1 || devices[0] !== targetDeviceId) {
    throw new Error("Initial Human Domain active device authority is stale");
  }
  const publicProfiles = await input.vault.listPublicProfiles();
  const active = publicProfiles.find((entry) =>
    entry.lifecycle === "active"
    && sameCoordinates(entry.coordinates, input.coordinates)
  );
  if (active === undefined) {
    throw new Error("Initial Human Domain active client profile is unavailable");
  }
  const staged = publicProfiles.find((entry) =>
    entry.lifecycle === "staged"
    && sameCoordinates(entry.coordinates, input.coordinates)
  );
  if (staged !== undefined) {
    if (
      staged.stageId !== input.operationId
      || staged.generation !== active.generation + 1
    ) {
      throw new Error("Initial Human Domain client profile already has a conflicting stage");
    }
    return recoverStagedInitialHumanDomainPreparation({
      crypto: input.crypto,
      vault: input.vault,
      coordinates: input.coordinates,
      operationId: input.operationId,
      domainId: targetDomainId,
      humanId: targetHumanId,
      generation: staged.generation,
      trustedDeviceRevision: input.trustedDeviceRevision,
      trustedHostAuthorizationRevision:
        input.trustedHostAuthorizationRevision,
    });
  }

  let profile: OpenedClientDeviceProfileV4 | undefined;
  let providerState: Awaited<ReturnType<OpenMlsGroupProvider["createInitialState"]>>
    | undefined;
  let withProvider: Awaited<ReturnType<typeof addClientDomainProviderSnapshot>>
    | undefined;
  let submission: HumanMembershipTargetDomainSubmission | undefined;
  let candidateBytes: Uint8Array | undefined;
  let stateHash: Uint8Array | undefined;
  let rosterBytes: Uint8Array | undefined;
  let rosterHash: Uint8Array | undefined;
  let submissionDigest: Uint8Array | undefined;
  try {
    await input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      profile = await openOrMigrateProfileV4({
        crypto: input.crypto,
        profileBytes,
        expectedDeviceId: targetDeviceId,
        trustedDeviceRevision: input.trustedDeviceRevision,
        trustedHostAuthorizationRevision: input.trustedHostAuthorizationRevision,
        deliveryHighWatermark: input.deliveryHighWatermark,
      });
      if (
        profile.baseProfile.baseProfile.trustedDeviceRevision
          !== input.trustedDeviceRevision
        || profile.baseProfile.baseProfile.trustedHostAuthorizationRevision
          !== input.trustedHostAuthorizationRevision
      ) {
        throw new Error("Initial Human Domain profile authority is stale");
      }
      if (profile.baseProfile.activeProviderSnapshots.some((entry) =>
        entry.domainId === targetDomainId
      )) {
        throw new Error("Initial Human Domain provider snapshot already exists");
      }
      const providerVault = DeviceProviderStateVault.fromKey(
        input.crypto,
        targetDeviceId,
        profile.baseProfile.providerStateSealingKey,
      );
      try {
        const provider = new OpenMlsGroupProvider(input.crypto, providerVault);
        providerState = await provider.createInitialState({
          domainId: targetDomainId,
          humanId: targetHumanId,
        });
        const head = provider.publicHead(providerState);
        rosterBytes = provider.publicRoster(providerState);
        stateHash = exactHash("Initial Human Domain state hash", head.stateHash);
        rosterHash = input.crypto.hash(rosterBytes);
        const digest = participantDigest([targetHumanId]);
        try {
          submission = createHumanMembershipTargetDomainSubmission({
            crypto: input.crypto,
            operationId: input.operationId,
            targetDomainId,
            participants: [targetHumanId],
            participantDigest: digest,
            committerDeviceId: targetDeviceId,
            committerHumanId: targetHumanId,
            initialProviderHead: head,
            initialRosterBytes: rosterBytes,
            additions: [],
            signingPrivateKey: profile.baseProfile.baseProfile.signingPrivateKey,
          });
        } finally {
          digest.fill(0);
          head.stateHash.fill(0);
        }
        submissionDigest = humanMembershipTargetDomainSubmissionDigest({
          crypto: input.crypto,
          submission,
        });
        withProvider = await addClientDomainProviderSnapshot({
          crypto: input.crypto,
          profile: profile.baseProfile,
          snapshot: providerState,
          expectedHead: submission.initialProviderHead,
        });
        candidateBytes = encodeClientDeviceProfileV4(Object.freeze({
          formatVersion: 4 as const,
          baseProfile: withProvider,
          humanDeviceGroupSnapshot: profile.humanDeviceGroupSnapshot,
          signerEvidence: profile.signerEvidence,
        }));
        const authenticated = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes: candidateBytes,
          expectedDeviceId: targetDeviceId,
        });
        destroyOpenedClientDeviceProfileV4(authenticated);
      } finally {
        providerVault.destroy();
      }
    });
    const stageId = input.operationId;
    await input.vault.stageProfile({
      coordinates: input.coordinates,
      stageId,
      generation: active.generation + 1,
      profileBytes: candidateBytes!,
      publicState: active.publicState,
    });
    const detachedSubmission = cloneSubmission(submission!);
    return Object.freeze({
      status: "prepared" as const,
      submission: detachedSubmission,
      receiptExpectation: Object.freeze({
        operationId: input.operationId,
        humanId: targetHumanId,
        deviceId: targetDeviceId,
        domainId: targetDomainId,
        providerId: detachedSubmission.initialProviderHead.providerId,
        epoch: 0 as const,
        stateHash: stateHash!.slice(),
        rosterHash: rosterHash!.slice(),
        submissionDigest: submissionDigest!.slice(),
        stageId,
        profileGeneration: active.generation + 1,
      }),
    });
  } finally {
    candidateBytes?.fill(0);
    providerState?.ciphertext.fill(0);
    if (withProvider) destroyOpenedClientDeviceProfileV3(withProvider);
    if (profile) destroyOpenedClientDeviceProfileV4(profile);
    destroySubmission(submission);
    stateHash?.fill(0);
    rosterBytes?.fill(0);
    rosterHash?.fill(0);
    submissionDigest?.fill(0);
  }
}

function assertExactReceipt(
  receipt: InitialHumanDomainServerReceipt,
  expected: InitialHumanDomainReceiptExpectation,
): void {
  assertHash("Initial Human Domain expected state hash", expected.stateHash);
  assertHash("Initial Human Domain expected roster hash", expected.rosterHash);
  assertHash(
    "Initial Human Domain expected submission digest",
    expected.submissionDigest,
  );
  assertHash("Initial Human Domain receipt state hash", receipt.stateHash);
  assertHash("Initial Human Domain receipt roster hash", receipt.rosterHash);
  assertHash(
    "Initial Human Domain receipt submission digest",
    receipt.submissionDigest,
  );
  if (
    receipt.formatVersion !== FORMAT_VERSION
    || receipt.status !== "active"
    || receipt.operationId !== expected.operationId
    || receipt.humanId !== expected.humanId
    || receipt.deviceId !== expected.deviceId
    || receipt.domainId !== expected.domainId
    || receipt.providerId !== expected.providerId
    || receipt.epoch !== expected.epoch
    || !bytesEqual(receipt.stateHash, expected.stateHash)
    || !bytesEqual(receipt.rosterHash, expected.rosterHash)
    || !bytesEqual(receipt.submissionDigest, expected.submissionDigest)
    || !Number.isSafeInteger(receipt.committedAt)
    || receipt.committedAt < 0
  ) {
    throw new Error("Initial Human Domain server receipt is invalid");
  }
}

/** Activates an exact staged profile and remains idempotent after restart. */
export async function activateInitialHumanDomainClientCeremony(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  expectation: InitialHumanDomainReceiptExpectation;
  receipt: InitialHumanDomainServerReceipt;
}>): Promise<Readonly<{ status: "active" }>> {
  assertExactReceipt(input.receipt, input.expectation);
  const profiles = await input.vault.listPublicProfiles();
  const staged = profiles.find((entry) =>
    entry.lifecycle === "staged"
    && sameCoordinates(entry.coordinates, input.coordinates)
  );
  if (staged !== undefined) {
    if (
      staged.stageId !== input.expectation.stageId
      || staged.generation !== input.expectation.profileGeneration
    ) throw new Error("Initial Human Domain staged profile is not exact");
    await input.vault.activateProfile(
      input.coordinates,
      input.expectation.stageId,
    );
  }
  let exact = false;
  await input.vault.withOpenProfile(input.coordinates, async (bytes) => {
    const profile = await authenticateClientDeviceProfileV4({
      crypto: input.crypto,
      profileBytes: bytes,
      expectedDeviceId: input.expectation.deviceId,
    });
    try {
      const snapshot = profile.baseProfile.activeProviderSnapshots.find(
        (entry) => entry.domainId === input.expectation.domainId,
      );
      exact = snapshot !== undefined
        && snapshot.providerId === input.expectation.providerId
        && snapshot.epoch === input.expectation.epoch
        && bytesEqual(snapshot.stateHash, input.expectation.stateHash);
    } finally {
      destroyOpenedClientDeviceProfileV4(profile);
    }
  });
  if (!exact) throw new Error("Initial Human Domain active profile is not exact");
  return Object.freeze({ status: "active" as const });
}

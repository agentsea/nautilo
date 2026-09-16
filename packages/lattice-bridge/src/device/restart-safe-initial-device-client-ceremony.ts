import {
  cryptoDeviceId,
  humanId,
  publishHumanRecoveryArchive,
  unixTimestamp,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import { recoveryKeyGenerationV2 } from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfile,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV1,
} from "../client-vault/profile-v2.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../client-vault/types.ts";
import type { NautiloActorId, NautiloUserId } from
  "../identity/product-ids.ts";
import type { InitialDeviceBootstrapClientPort } from
  "./initial-bootstrap-client-ceremony.ts";
import {
  prepareInitialDeviceBootstrapRequest,
  type PresentInitialDeviceRecoveryKit,
} from "./initial-bootstrap-ceremony.ts";
import {
  createInitialDeviceBootstrapProof,
  initialDeviceBootstrapAuditRef,
  type BeginInitialDeviceBootstrap,
  type InitialDeviceBootstrapChallenge,
  type InitialDeviceBootstrapReceipt,
} from "./initial-bootstrap.ts";

type RecoverySources = Parameters<typeof publishHumanRecoveryArchive>[0]["sources"];

export interface PendingInitialDeviceBootstrap {
  readonly formatVersion: 1;
  readonly revision: 1 | 2;
  readonly idempotencyKey: string;
  readonly coordinates: ClientProfileCoordinates;
  readonly request: BeginInitialDeviceBootstrap;
  readonly profileBytes: Uint8Array;
  readonly recoveryArchiveBytes: Uint8Array;
  readonly publicFingerprint: Uint8Array;
  readonly challenge: InitialDeviceBootstrapChallenge | null;
  readonly deviceProof: Uint8Array | null;
}

/**
 * Platform implementations must seal records and CAS the authenticated
 * revision. Every returned record owns detached byte arrays: callers wipe
 * them after use and must never mutate the persisted record by doing so.
 */
export interface PendingInitialDeviceBootstrapVault {
  load(idempotencyKey: string): Promise<PendingInitialDeviceBootstrap | null>;
  create(
    value: PendingInitialDeviceBootstrap,
  ): Promise<"inserted" | "exact_duplicate" | "collision">;
  compareAndSwap(input: Readonly<{
    expected: PendingInitialDeviceBootstrap;
    replacement: PendingInitialDeviceBootstrap;
  }>): Promise<boolean>;
  removeExact(value: PendingInitialDeviceBootstrap): Promise<boolean>;
}

export type RestartSafeInitialDevicePreparation = Readonly<{
  status: "prepared" | "resumed";
  coordinates: ClientProfileCoordinates;
  idempotencyKey: string;
}>;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

export function destroyPendingInitialDeviceBootstrap(
  value: PendingInitialDeviceBootstrap | null,
): void {
  if (value === null) return;
  value.profileBytes.fill(0);
  value.recoveryArchiveBytes.fill(0);
  value.publicFingerprint.fill(0);
  value.deviceProof?.fill(0);
  value.request.installationLineageDigest.fill(0);
  value.request.signingPublicKey.fill(0);
  value.request.encryptionPublicKey.fill(0);
  value.request.recoveryPublicKey.fill(0);
  value.challenge?.installationLineageDigest.fill(0);
  value.challenge?.signingPublicKey.fill(0);
  value.challenge?.encryptionPublicKey.fill(0);
  value.challenge?.recoveryPublicKey.fill(0);
  value.challenge?.authorizationEvidenceDigest.fill(0);
  value.challenge?.authorizationDigest.fill(0);
}

function challengeMatches(
  challenge: InitialDeviceBootstrapChallenge,
  request: BeginInitialDeviceBootstrap,
): boolean {
  return challenge.userId === request.userId
    && challenge.humanActorId === request.humanActorId
    && challenge.deviceId === request.deviceId
    && challenge.clientKind === request.clientKind
    && challenge.recoveryKeyId === request.recoveryKeyId
    && challenge.idempotencyKey === request.idempotencyKey
    && challenge.context.kind === request.context.kind
    && equalBytes(challenge.installationLineageDigest,
      request.installationLineageDigest)
    && equalBytes(challenge.signingPublicKey, request.signingPublicKey)
    && equalBytes(challenge.encryptionPublicKey, request.encryptionPublicKey)
    && equalBytes(challenge.recoveryPublicKey, request.recoveryPublicKey);
}

function receiptMatches(
  receipt: InitialDeviceBootstrapReceipt,
  pending: PendingInitialDeviceBootstrap,
  crypto: Pick<LatticeCrypto, "hash">,
): boolean {
  if (pending.challenge === null) return false;
  return receipt.formatVersion === 1
    && receipt.status === "active"
    && receipt.humanActorId === pending.request.humanActorId
    && receipt.deviceId === pending.request.deviceId
    && receipt.recoveryKeyId === pending.request.recoveryKeyId
    && receipt.recoveryGeneration === 1
    && receipt.deviceRevision === 1
    && receipt.custodyRevision === 1
    && receipt.auditRef === initialDeviceBootstrapAuditRef({
      challenge: pending.challenge,
      recoveryArchiveBytes: pending.recoveryArchiveBytes,
      crypto,
    });
}

export async function prepareRestartSafeInitialDeviceClientCeremony(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly pending: PendingInitialDeviceBootstrapVault;
  readonly serverScope: string;
  readonly profileId: string;
  readonly userId: NautiloUserId;
  readonly humanActorId: NautiloActorId;
  readonly deviceId: string;
  readonly clientKind: "browser" | "electron";
  readonly installationLineageDigest: Uint8Array;
  readonly idempotencyKey: string;
  readonly recoverySources: RecoverySources;
  readonly presentRecoveryKit: PresentInitialDeviceRecoveryKit;
}): Promise<RestartSafeInitialDevicePreparation> {
  const existing = await input.pending.load(input.idempotencyKey);
  if (existing !== null) {
    try {
      return Object.freeze({
        status: "resumed",
        coordinates: Object.freeze({ ...existing.coordinates }),
        idempotencyKey: existing.idempotencyKey,
      });
    } finally {
      destroyPendingInitialDeviceBootstrap(existing);
    }
  }
  if ((await input.vault.unlock()).status !== "available") {
    throw new Error("Initial-device profile vault is unavailable");
  }
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  let profileBytes: Uint8Array | undefined;
  let recoveryArchiveBytes: Uint8Array | undefined;
  try {
    const request = await prepareInitialDeviceBootstrapRequest({
      crypto: input.crypto,
      request: {
        userId: input.userId,
        humanActorId: input.humanActorId,
        deviceId: input.deviceId,
        clientKind: input.clientKind,
        installationLineageDigest: input.installationLineageDigest,
        signingPublicKey: signing.publicKey,
        encryptionPublicKey: encryption.publicKey,
        context: { kind: "preparation", authorityId: input.idempotencyKey },
        idempotencyKey: input.idempotencyKey,
      },
      presentRecoveryKit: input.presentRecoveryKit,
    });
    const recoveryDigest = input.crypto.hash(request.recoveryPublicKey);
    const archive = await publishHumanRecoveryArchive({
      crypto: input.crypto,
      humanId: humanId(input.humanActorId),
      recoveryKeyId: request.recoveryKeyId,
      recoveryGeneration: recoveryKeyGenerationV2(1),
      recoveryPublicKey: request.recoveryPublicKey,
      resolveTrustedCurrentRecoveryKey: () => ({
        humanId: humanId(input.humanActorId),
        recoveryKeyId: request.recoveryKeyId,
        recoveryGeneration: recoveryKeyGenerationV2(1),
        publicKeyDigest: recoveryDigest,
      }),
      issuerDeviceId: cryptoDeviceId(input.deviceId),
      createdAt: unixTimestamp(input.crypto.clock.now()),
      sources: input.recoverySources,
      issuerSigningPrivateKey: signing.privateKey,
      resolveIssuerDevice: () => signing.publicKey,
    });
    recoveryArchiveBytes = archive.archiveBytes.slice();
    profileBytes = encodeClientDeviceProfileV1({
      deviceId: input.deviceId,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
    });
    const coordinates: ClientProfileCoordinates = Object.freeze({
      serverScope: input.serverScope,
      userId: input.userId,
      humanActorId: input.humanActorId,
      profileId: input.profileId,
      deviceId: input.deviceId,
      installationLineageDigest: hex(input.installationLineageDigest),
    });
    const created = await input.pending.create(Object.freeze({
      formatVersion: 1,
      revision: 1,
      idempotencyKey: input.idempotencyKey,
      coordinates,
      request,
      profileBytes,
      recoveryArchiveBytes,
      publicFingerprint: input.crypto.hash(new Uint8Array([
        ...signing.publicKey,
        ...encryption.publicKey,
      ])),
      challenge: null,
      deviceProof: null,
    }));
    if (created === "collision") {
      throw new Error("Initial-device pending custody collided");
    }
    return Object.freeze({
      status: created === "inserted" ? "prepared" : "resumed",
      coordinates,
      idempotencyKey: input.idempotencyKey,
    });
  } finally {
    profileBytes?.fill(0);
    recoveryArchiveBytes?.fill(0);
    signing.privateKey.fill(0);
    encryption.privateKey.fill(0);
  }
}

export async function resumeRestartSafeInitialDeviceClientCeremony(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly pending: PendingInitialDeviceBootstrapVault;
  readonly bootstrap: InitialDeviceBootstrapClientPort;
  readonly idempotencyKey: string;
}): Promise<InitialDeviceBootstrapReceipt> {
  let record = await input.pending.load(input.idempotencyKey);
  if (record === null) throw new Error("Initial-device pending custody is missing");
  try {
    if (record.challenge === null || record.deviceProof === null) {
      const challenge = await input.bootstrap.begin(record.request);
      if (!challengeMatches(challenge, record.request)) {
        throw new TypeError("Initial-device bootstrap challenge was substituted");
      }
      const profile = await authenticateClientDeviceProfile({
        crypto: input.crypto,
        profileBytes: record.profileBytes,
        expectedDeviceId: record.request.deviceId,
      });
      let deviceProof: Uint8Array;
      try {
        deviceProof = createInitialDeviceBootstrapProof({
          crypto: input.crypto,
          challenge,
          recoveryArchiveBytes: record.recoveryArchiveBytes,
          signingPrivateKey: profile.signingPrivateKey,
        }).deviceProof;
      } finally {
        destroyOpenedClientDeviceProfile(profile);
      }
      const replacement: PendingInitialDeviceBootstrap = Object.freeze({
        ...record,
        revision: 2,
        request: Object.freeze({
          ...record.request,
          // The HTTP boundary deliberately omits caller-supplied authority.
          // Retain the server-authored preparation authority that the signed
          // challenge and completion proof actually bind.
          context: Object.freeze({ ...challenge.context }),
        }),
        challenge,
        deviceProof,
      });
      if (!await input.pending.compareAndSwap({ expected: record, replacement })) {
        destroyPendingInitialDeviceBootstrap(replacement);
        record = await input.pending.load(input.idempotencyKey);
        if (record === null || record.challenge === null || record.deviceProof === null) {
          throw new Error("Initial-device pending custody changed concurrently");
        }
      } else {
        record = replacement;
      }
    }
    if (record.challenge === null || record.deviceProof === null) {
      throw new Error("Initial-device pending completion is incomplete");
    }
    const challenge = record.challenge;
    const deviceProof = record.deviceProof;
    await input.vault.stageProfile({
      coordinates: record.coordinates,
      stageId: challenge.challengeId,
      generation: 1,
      profileBytes: record.profileBytes,
      publicState: {
        clientKind: record.request.clientKind,
        publicFingerprint: hex(record.publicFingerprint),
      },
    });
    let receipt: InitialDeviceBootstrapReceipt;
    try {
      receipt = await input.bootstrap.complete({
        formatVersion: 1,
        challenge,
        recoveryArchiveBytes: record.recoveryArchiveBytes,
        deviceProof,
      });
    } catch {
      const resolved = await input.bootstrap.resolveReceipt({
        userId: record.request.userId,
        humanActorId: record.request.humanActorId,
        deviceId: record.request.deviceId,
        challengeId: challenge.challengeId,
        publicFingerprint: record.publicFingerprint,
      });
      if (resolved === null) {
        throw new Error("Initial-device completion outcome is unknown");
      }
      receipt = resolved;
    }
    if (!receiptMatches(receipt, record, input.crypto)) {
      throw new TypeError("Initial-device receipt was substituted");
    }
    await input.vault.activateProfile(record.coordinates, challenge.challengeId);
    if (!await input.pending.removeExact(record)) {
      throw new Error("Initial-device pending custody cleanup failed");
    }
    return receipt;
  } finally {
    destroyPendingInitialDeviceBootstrap(record);
  }
}

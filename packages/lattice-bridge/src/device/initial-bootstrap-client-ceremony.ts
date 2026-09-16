import {
  cryptoDeviceId,
  humanId,
  publishHumanRecoveryArchive,
  unixTimestamp,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  recoveryKeyGenerationV2,
} from "@nautilo/lattice-crypto/wire";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../client-vault/types.ts";
import { encodeClientDeviceProfileV1 } from "../client-vault/profile-v2.ts";
import type {
  NautiloActorId,
  NautiloUserId,
} from "../identity/product-ids.ts";
import {
  prepareInitialDeviceBootstrapRequest,
  type PresentInitialDeviceRecoveryKit,
} from "./initial-bootstrap-ceremony.ts";
import {
  createInitialDeviceBootstrapProof,
  initialDeviceBootstrapAuditRef,
  type BeginInitialDeviceBootstrap,
  type InitialDeviceBootstrapCompletion,
  type InitialDeviceBootstrapContext,
  type InitialDeviceBootstrapReceipt,
  type InitialDeviceBootstrapReceiptQuery,
} from "./initial-bootstrap.ts";

export type InitialDeviceClientCeremonyErrorCode =
  | "vault_unavailable"
  | "profile_stage_failed"
  | "completion_outcome_unknown"
  | "receipt_invalid"
  | "local_activation_pending";

export class InitialDeviceClientCeremonyError extends Error {
  override readonly name = "InitialDeviceClientCeremonyError";

  constructor(readonly code: InitialDeviceClientCeremonyErrorCode) {
    super(`Initial-device client ceremony failed (${code})`);
  }
}

export interface InitialDeviceBootstrapClientPort {
  begin: (
    request: BeginInitialDeviceBootstrap,
  ) => Promise<
    Parameters<typeof createInitialDeviceBootstrapProof>[0]["challenge"]
  >;
  complete: (
    completion: InitialDeviceBootstrapCompletion,
  ) => Promise<InitialDeviceBootstrapReceipt>;
  resolveReceipt: (
    query: InitialDeviceBootstrapReceiptQuery,
  ) => Promise<InitialDeviceBootstrapReceipt | null>;
}

type RecoverySources = Parameters<
  typeof publishHumanRecoveryArchive
>[0]["sources"];

function hex(bytes: Uint8Array): string {
  return Array.from(
    bytes,
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function receiptMatches(
  receipt: InitialDeviceBootstrapReceipt,
  expected: {
    readonly humanActorId: NautiloActorId;
    readonly deviceId: string;
    readonly recoveryKeyId?: string;
    readonly auditRef?: string;
  },
): boolean {
  return receipt.formatVersion === 1
    && receipt.status === "active"
    && receipt.humanActorId === expected.humanActorId
    && receipt.deviceId === expected.deviceId
    && (
      expected.recoveryKeyId === undefined
      || receipt.recoveryKeyId === expected.recoveryKeyId
    )
    && receipt.recoveryGeneration === 1
    && receipt.deviceRevision === 1
    && receipt.custodyRevision === 1
    && /^bootstrap_[0-9a-f]{32}$/u.test(receipt.auditRef)
    && (
      expected.auditRef === undefined
      || receipt.auditRef === expected.auditRef
    )
    && Number.isSafeInteger(receipt.committedAt)
    && receipt.committedAt >= 0;
}

function coordinatesEqual(
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

export async function resumeInitialDeviceClientCeremony(input: {
  readonly vault: ClientProfileVault;
  readonly bootstrap: InitialDeviceBootstrapClientPort;
  readonly coordinates: ClientProfileCoordinates;
}): Promise<InitialDeviceBootstrapReceipt> {
  const availability = await input.vault.unlock();
  if (availability.status !== "available") {
    throw new InitialDeviceClientCeremonyError("vault_unavailable");
  }
  const staged = (await input.vault.listPublicProfiles()).find(
    (profile) =>
      profile.lifecycle === "staged"
      && coordinatesEqual(profile.coordinates, input.coordinates),
  );
  if (staged?.stageId === undefined) {
    throw new InitialDeviceClientCeremonyError("profile_stage_failed");
  }
  let receipt: InitialDeviceBootstrapReceipt | null;
  try {
    receipt = await input.bootstrap.resolveReceipt({
      userId: input.coordinates.userId as NautiloUserId,
      humanActorId: input.coordinates.humanActorId as NautiloActorId,
      deviceId: input.coordinates.deviceId,
      challengeId: staged.stageId,
      publicFingerprint: Uint8Array.from(
        staged.publicState.publicFingerprint.match(/.{2}/gu)?.map(
          (pair) => Number.parseInt(pair, 16),
        ) ?? [],
      ),
    });
  } catch {
    throw new InitialDeviceClientCeremonyError("completion_outcome_unknown");
  }
  if (
    receipt === null
    || !receiptMatches(receipt, {
      humanActorId: input.coordinates.humanActorId as NautiloActorId,
      deviceId: input.coordinates.deviceId,
    })
  ) {
    throw new InitialDeviceClientCeremonyError("receipt_invalid");
  }
  try {
    await input.vault.activateProfile(
      input.coordinates,
      staged.stageId,
    );
  } catch {
    throw new InitialDeviceClientCeremonyError("local_activation_pending");
  }
  return receipt;
}

/**
 * Complete synthetic Wave 7 client composition. Production routing remains
 * absent; callers inject the bootstrap port and authorization-bearing service.
 */
export async function runInitialDeviceClientCeremony(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly bootstrap: InitialDeviceBootstrapClientPort;
  readonly serverScope: string;
  readonly profileId: string;
  readonly userId: NautiloUserId;
  readonly humanActorId: NautiloActorId;
  readonly deviceId: string;
  readonly clientKind: "browser" | "electron" | "tui";
  readonly installationLineageDigest: Uint8Array;
  readonly context: InitialDeviceBootstrapContext;
  readonly idempotencyKey: string;
  readonly recoverySources: RecoverySources;
  readonly presentRecoveryKit: PresentInitialDeviceRecoveryKit;
}): Promise<InitialDeviceBootstrapReceipt> {
  const availability = await input.vault.unlock();
  if (availability.status !== "available") {
    throw new InitialDeviceClientCeremonyError("vault_unavailable");
  }

  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  let profileBytes: Uint8Array | undefined;
  let archiveBytes: Uint8Array | undefined;
  let completion: InitialDeviceBootstrapCompletion | undefined;
  const coordinates: ClientProfileCoordinates = {
    serverScope: input.serverScope,
    userId: input.userId,
    humanActorId: input.humanActorId,
    profileId: input.profileId,
    deviceId: input.deviceId,
    installationLineageDigest: hex(input.installationLineageDigest),
  };
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
        context: input.context,
        idempotencyKey: input.idempotencyKey,
      },
      presentRecoveryKit: input.presentRecoveryKit,
    });
    const challenge = await input.bootstrap.begin(request);
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
    archiveBytes = Uint8Array.from(archive.archiveBytes);
    profileBytes = encodeClientDeviceProfileV1({
      deviceId: input.deviceId,
      signingPublicKey: signing.publicKey,
      signingPrivateKey: signing.privateKey,
      encryptionPublicKey: encryption.publicKey,
      encryptionPrivateKey: encryption.privateKey,
    });
    try {
      await input.vault.stageProfile({
        coordinates,
        stageId: challenge.challengeId,
        generation: 1,
        profileBytes,
        publicState: {
          clientKind: input.clientKind,
          publicFingerprint: hex(input.crypto.hash(new Uint8Array([
            ...signing.publicKey,
            ...encryption.publicKey,
          ]))),
        },
      });
    } catch {
      throw new InitialDeviceClientCeremonyError("profile_stage_failed");
    }
    completion = createInitialDeviceBootstrapProof({
      crypto: input.crypto,
      challenge,
      recoveryArchiveBytes: archiveBytes,
      signingPrivateKey: signing.privateKey,
    });
    const expectedAuditRef = initialDeviceBootstrapAuditRef({
      challenge,
      recoveryArchiveBytes: archiveBytes,
      crypto: input.crypto,
    });
    let receipt: InitialDeviceBootstrapReceipt;
    try {
      receipt = await input.bootstrap.complete(completion);
    } catch {
      try {
        const resolved = await input.bootstrap.resolveReceipt({
          userId: input.userId,
          humanActorId: input.humanActorId,
          deviceId: input.deviceId,
          challengeId: challenge.challengeId,
          publicFingerprint: input.crypto.hash(new Uint8Array([
            ...signing.publicKey,
            ...encryption.publicKey,
          ])),
        });
        if (resolved === null) {
          throw new Error("Bootstrap has no committed receipt");
        }
        receipt = resolved;
      } catch {
        throw new InitialDeviceClientCeremonyError(
          "completion_outcome_unknown",
        );
      }
    }
    if (!receiptMatches(receipt, {
      humanActorId: input.humanActorId,
      deviceId: input.deviceId,
      recoveryKeyId: request.recoveryKeyId,
      auditRef: expectedAuditRef,
    })) {
      throw new InitialDeviceClientCeremonyError("receipt_invalid");
    }
    try {
      await input.vault.activateProfile(coordinates, challenge.challengeId);
    } catch {
      throw new InitialDeviceClientCeremonyError("local_activation_pending");
    }
    return receipt;
  } finally {
    profileBytes?.fill(0);
    archiveBytes?.fill(0);
    completion?.recoveryArchiveBytes.fill(0);
    completion?.deviceProof.fill(0);
    signing.privateKey.fill(0);
    encryption.privateKey.fill(0);
  }
}

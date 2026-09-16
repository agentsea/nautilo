import {
  openDeviceTransfer,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeDeviceTransferApprovalV2,
  type DeviceTransferApprovalV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfile,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV2,
} from "../client-vault/profile-v2.ts";
import type {
  OpenedClientDeviceProfileV2,
  RetainedClientNamespaceKeyringV2,
} from "../client-vault/profile-v2.ts";
import type {
  ClientProfileCoordinates,
  ClientProfilePublicState,
  ClientProfileVault,
} from "../client-vault/types.ts";
import {
  writeClientNamespaceKeyrings,
} from "../device/client-namespace-keyring.ts";
import {
  decodeOpaqueDeliveryArtifactChunk,
  reassembleOpaqueDeliveryArtifact,
  type OpaqueDeliveryArtifactChunk,
} from "./opaque-artifact.ts";

export const CLIENT_KEYRING_DELIVERY_MAX_MESSAGES = 64 as const;
export const CLIENT_KEYRING_DELIVERY_MAX_BYTES = 8_388_608 as const;

export interface ClientKeyringDeliveryMessage {
  readonly messageId: string;
  readonly operationId: string;
  readonly recipientSequence: number;
  readonly kind: "device_transfer";
  readonly formatVersion: 1;
  readonly payloadHash: Uint8Array;
  readonly payloadBytes: Uint8Array;
  readonly createdAt: number;
  readonly expiresAt: number;
}

type OpenTransferInput = Parameters<typeof openDeviceTransfer>[0];

export type ResolveClientDeviceTransferAuthority = (
  operationId: string,
  approval: DeviceTransferApprovalV2,
) => Omit<
  OpenTransferInput,
  "crypto" | "approvalBytes" | "pendingEncryptionPrivateKey"
> | null;

function portable(label: string, value: string): void {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(value)
  ) throw new TypeError(`${label} must be a portable identifier`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((byte, index) => byte === right[index]);
}

function exactMessage(message: ClientKeyringDeliveryMessage): void {
  const fields = [
    "createdAt",
    "expiresAt",
    "formatVersion",
    "kind",
    "messageId",
    "operationId",
    "payloadBytes",
    "payloadHash",
    "recipientSequence",
  ];
  if (
    Object.keys(message).sort().some((field, index) => field !== fields[index])
    || Object.keys(message).length !== fields.length
    || message.kind !== "device_transfer"
    || message.formatVersion !== 1
  ) throw new TypeError("Client delivery message fields are malformed");
  portable("Client delivery message", message.messageId);
  portable("Client delivery operation", message.operationId);
  if (
    !Number.isSafeInteger(message.recipientSequence)
    || message.recipientSequence < 1
    || !Number.isSafeInteger(message.createdAt)
    || message.createdAt < 0
    || !Number.isSafeInteger(message.expiresAt)
    || message.expiresAt <= message.createdAt
    || !(message.payloadHash instanceof Uint8Array)
    || message.payloadHash.length !== 32
    || !(message.payloadBytes instanceof Uint8Array)
    || message.payloadBytes.length < 1
  ) throw new RangeError("Client delivery message bounds are invalid");
}

function wipeChunk(chunk: OpaqueDeliveryArtifactChunk): void {
  chunk.artifactHash.fill(0);
  chunk.payloadBytes.fill(0);
  chunk.chunkHash.fill(0);
}

function wipeApproval(approval: DeviceTransferApprovalV2): void {
  approval.encryptionPublicKeyDigest.fill(0);
  approval.signingPublicKeyDigest.fill(0);
  approval.inventoryDigest.fill(0);
  approval.signature.fill(0);
  approval.packages.forEach((item) => {
    item.encryptionPublicKeyDigest.fill(0);
    item.signingPublicKeyDigest.fill(0);
    item.bindingHash.fill(0);
    item.ciphertext.fill(0);
  });
}

/**
 * Authenticates, opens, and retains canonical signed device-transfer delivery
 * history. The server-delivered rows and HPKE plaintext are consumed without
 * exposing roots or keyrings outside the returned vault-profile candidate.
 */
export async function ingestClientKeyringDeliveryHistory(input: {
  readonly crypto: LatticeCrypto;
  readonly profile: OpenedClientDeviceProfileV2;
  readonly serverHighWatermark: number;
  readonly messages: readonly ClientKeyringDeliveryMessage[];
  readonly resolveAuthority: ResolveClientDeviceTransferAuthority;
}): Promise<OpenedClientDeviceProfileV2> {
  if (
    !Number.isSafeInteger(input.serverHighWatermark)
    || input.serverHighWatermark < input.profile.deliveryHighWatermark
  ) throw new Error("Client delivery rollback was detected");
  if (
    !Array.isArray(input.messages as unknown)
    || input.messages.length < 1
    || input.messages.length > CLIENT_KEYRING_DELIVERY_MAX_MESSAGES
  ) throw new RangeError("Client delivery history count is invalid");
  let aggregateBytes = 0;
  input.messages.forEach((message, index) => {
    exactMessage(message);
    aggregateBytes += message.payloadBytes.length;
    if (
      aggregateBytes > CLIENT_KEYRING_DELIVERY_MAX_BYTES
      || message.recipientSequence
        !== input.profile.deliveryHighWatermark + index + 1
      || message.recipientSequence > input.serverHighWatermark
      || !equalBytes(input.crypto.hash(message.payloadBytes), message.payloadHash)
    ) throw new Error("Client delivery history is noncanonical");
  });

  const retained: RetainedClientNamespaceKeyringV2[] = [];
  const seenOperations = new Set<string>();
  let index = 0;
  try {
    while (index < input.messages.length) {
      const operationId = input.messages[index]!.operationId;
      if (seenOperations.has(operationId)) {
        throw new Error("Client delivery operation order is noncanonical");
      }
      seenOperations.add(operationId);
      const operationMessages: ClientKeyringDeliveryMessage[] = [];
      while (
        index < input.messages.length
        && input.messages[index]!.operationId === operationId
      ) operationMessages.push(input.messages[index++]!);
      const chunks: OpaqueDeliveryArtifactChunk[] = [];
      let approvalBytes: Uint8Array | undefined;
      let approval: DeviceTransferApprovalV2 | undefined;
      let opened: Awaited<ReturnType<typeof openDeviceTransfer>> | undefined;
      try {
        for (const message of operationMessages) {
          const chunk = decodeOpaqueDeliveryArtifactChunk(
            message.payloadBytes,
            input.crypto,
          );
          if (
            chunk.kind !== "device_transfer"
            || chunk.operationId !== operationId
            || chunk.recipientDeviceId !== input.profile.deviceId
          ) {
            wipeChunk(chunk);
            throw new Error("Client delivery chunk coordinates disagree");
          }
          chunks.push(chunk);
        }
        approvalBytes = reassembleOpaqueDeliveryArtifact({
          crypto: input.crypto,
          chunks,
        });
        approval = decodeDeviceTransferApprovalV2(approvalBytes);
        const authority = input.resolveAuthority(operationId, approval);
        if (
          authority === null
          || authority.pendingDevice.deviceId !== input.profile.deviceId
          || !equalBytes(
            authority.pendingDevice.signingPublicKey,
            input.profile.signingPublicKey,
          )
          || !equalBytes(
            authority.pendingDevice.encryptionPublicKey,
            input.profile.encryptionPublicKey,
          )
        ) throw new Error("Client device-transfer authority is unavailable");
        opened = await openDeviceTransfer({
          ...authority,
          crypto: input.crypto,
          approvalBytes,
          pendingEncryptionPrivateKey: input.profile.encryptionPrivateKey,
        });
        if (opened.keyrings.length !== approval.packages.length) {
          throw new Error("Client device-transfer opened inventory disagrees");
        }
        const deliverySequence = operationMessages.at(-1)!.recipientSequence;
        for (let packageIndex = 0; packageIndex < approval.packages.length; packageIndex += 1) {
          const metadata = approval.packages[packageIndex]!;
          const keyring = opened.keyrings[packageIndex]!;
          retained.push(Object.freeze({
            deliverySequence,
            operationId,
            namespaceId: metadata.namespaceId,
            keyClass: metadata.keyClass,
            domainId: metadata.domainId,
            domainEpoch: metadata.domainEpoch,
            accessRevision: metadata.accessRevision,
            bindingHash: metadata.bindingHash.slice(),
            currentGeneration: keyring.currentGeneration,
            generations: Object.freeze(keyring.generations.map((generation) =>
              Object.freeze({
                generation: generation.generation,
                key: generation.key.slice(),
              })
            )),
          }));
        }
      } finally {
        chunks.forEach(wipeChunk);
        approvalBytes?.fill(0);
        if (approval) wipeApproval(approval);
        opened?.keyrings.forEach((keyring) =>
          keyring.generations.forEach((generation) => generation.key.fill(0))
        );
      }
    }
    if (retained.length === 0) {
      if (input.profile.keyringDeliveries.length !== 0) {
        throw new Error("Empty Client delivery cannot replace retained keyrings");
      }
      return Object.freeze({
        formatVersion: 2,
        deviceId: input.profile.deviceId,
        signingPublicKey: input.profile.signingPublicKey.slice(),
        signingPrivateKey: input.profile.signingPrivateKey.slice(),
        encryptionPublicKey: input.profile.encryptionPublicKey.slice(),
        encryptionPrivateKey: input.profile.encryptionPrivateKey.slice(),
        trustedDeviceRevision: input.profile.trustedDeviceRevision,
        trustedHostAuthorizationRevision:
          input.profile.trustedHostAuthorizationRevision,
        deliveryHighWatermark:
          input.messages[input.messages.length - 1]!.recipientSequence,
        keyringDeliveries: Object.freeze([]),
      });
    }
    return writeClientNamespaceKeyrings({
      profile: input.profile,
      deliveryHighWatermark:
        input.messages[input.messages.length - 1]!.recipientSequence,
      keyrings: retained,
    });
  } finally {
    retained.forEach((keyring) => {
      keyring.bindingHash.fill(0);
      keyring.generations.forEach((generation) => generation.key.fill(0));
    });
  }
}

/** Atomically stages and activates one authenticated delivery-history advance. */
export async function ingestAndReplaceClientKeyringDeliveryHistory(input: {
  readonly crypto: LatticeCrypto;
  readonly vault: ClientProfileVault;
  readonly coordinates: ClientProfileCoordinates;
  readonly stageId: string;
  readonly generation: number;
  readonly publicState: ClientProfilePublicState;
  readonly serverHighWatermark: number;
  readonly messages: readonly ClientKeyringDeliveryMessage[];
  readonly resolveAuthority: ResolveClientDeviceTransferAuthority;
}): Promise<void> {
  let candidate: OpenedClientDeviceProfileV2 | undefined;
  let candidateBytes: Uint8Array | undefined;
  await input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
    const profile = await authenticateClientDeviceProfile({
      crypto: input.crypto,
      profileBytes,
      expectedDeviceId: input.coordinates.deviceId,
    });
    try {
      if (profile.formatVersion !== 2) {
        throw new Error("Client keyring delivery requires profile v2");
      }
      candidate = await ingestClientKeyringDeliveryHistory({
        crypto: input.crypto,
        profile,
        serverHighWatermark: input.serverHighWatermark,
        messages: input.messages,
        resolveAuthority: input.resolveAuthority,
      });
      candidateBytes = encodeClientDeviceProfileV2(candidate);
    } finally {
      destroyOpenedClientDeviceProfile(profile);
    }
  });
  try {
    await input.vault.stageProfile({
      coordinates: input.coordinates,
      stageId: input.stageId,
      generation: input.generation,
      profileBytes: candidateBytes!,
      publicState: input.publicState,
    });
    await input.vault.activateProfile(input.coordinates, input.stageId);
  } finally {
    candidateBytes?.fill(0);
    if (candidate) destroyOpenedClientDeviceProfile(candidate);
  }
}

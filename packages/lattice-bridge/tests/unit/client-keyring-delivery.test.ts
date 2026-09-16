import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
  prepareDeviceTransfer,
  sealNamespaceKeyring,
  unixTimestamp,
  verifyNamespaceBindingProof,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfile,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import type {
  OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  ingestAndReplaceClientKeyringDeliveryHistory,
  ingestClientKeyringDeliveryHistory,
} from "../../src/delivery/client-keyring-delivery.ts";
import {
  chunkOpaqueDeliveryArtifact,
  serializeOpaqueDeliveryArtifactChunk,
} from "../../src/delivery/opaque-artifact.ts";
import {
  withClientNamespaceKeyring,
} from "../../src/device/client-namespace-keyring.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";

const COORDINATES = Object.freeze({
  serverScope: "https://crypto.example.test",
  userId: "10000000-0000-4000-8000-000000000248",
  humanActorId: "20000000-0000-4000-8000-000000000248",
  profileId: "profile_delivery",
  deviceId: "device_alice_browser",
  installationLineageDigest: "31".repeat(32),
});

async function fixture(options: { readonly empty?: boolean } = {}) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const targetSigning = crypto.generateSigningKeyPair();
  const targetEncryption = await crypto.generateEncryptionKeyPair();
  const human = humanId("human_alice");
  const issuerDeviceId = cryptoDeviceId("device_alice_current");
  const targetDeviceId = cryptoDeviceId("device_alice_browser");
  const domainId = cryptoDomainId("domain_alice");
  const targetNamespaceId = namespaceId("namespace_room");
  const keyrings = createInitialNamespaceKeyrings(crypto, targetNamespaceId);
  const humanRoot = crypto.randomBytes(32);
  const aiRoot = crypto.randomBytes(32);
  const metadata = {
    domainId,
    domainEpoch: domainEpoch(3),
    previousBindingHash: null,
    committerDeviceId: issuerDeviceId,
  } as const;
  const humanEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: humanRoot,
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const aiEnvelope = sealNamespaceKeyring({
    crypto,
    domainRoot: aiRoot,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope,
    aiEnvelope,
    committerSigningPrivateKey: issuer.privateKey,
    resolveCurrentCommitter: () => issuer.publicKey,
  });
  const trustedHead = verifyNamespaceBindingProof({
    crypto,
    anchor: null,
    proof: [binding],
    resolveHistoricalCommitter: () => issuer.publicKey,
  });
  const pendingDevice = Object.freeze({
    humanId: human,
    deviceId: targetDeviceId,
    pendingDeviceRevision: pendingDeviceRevisionV2(0),
    encryptionPublicKey: targetEncryption.publicKey,
    signingPublicKey: targetSigning.publicKey,
  });
  const trustedPending = Object.freeze({
    humanId: human,
    deviceId: targetDeviceId,
    pendingDeviceRevision: pendingDeviceRevisionV2(0),
    encryptionPublicKeyDigest: crypto.hash(targetEncryption.publicKey),
    signingPublicKeyDigest: crypto.hash(targetSigning.publicKey),
    status: "pending" as const,
  });
  const populatedSources = [{
    authorizedHumanId: human,
    trustedNamespaceHead: trustedHead,
    keyClass: "human" as const,
    currentKeyringEnvelope: humanEnvelope,
    currentDomainRoot: humanRoot,
    resolveHistoricalCommitter: () => issuer.publicKey,
  }, {
    authorizedHumanId: human,
    trustedNamespaceHead: trustedHead,
    keyClass: "ai" as const,
    currentKeyringEnvelope: aiEnvelope,
    currentDomainRoot: aiRoot,
    resolveHistoricalCommitter: () => issuer.publicKey,
  }] as const;
  const sources = options.empty === true ? [] : populatedSources;
  const inventory = sources.map(
    ({ authorizedHumanId, trustedNamespaceHead, keyClass }) => ({
      authorizedHumanId,
      trustedNamespaceHead,
      keyClass,
    }),
  );
  const inventoryRevision = deviceTransferInventoryRevisionV2(8);
  const inventoryDigest = deviceTransferInventoryDigestV2({
    humanId: human,
    inventoryRevision,
    inventory,
  });
  const commitment = Object.freeze({
    humanId: human,
    inventoryRevision,
    inventoryCount: inventory.length,
    inventoryDigest,
  });
  const prepared = await prepareDeviceTransfer({
    crypto,
    pendingDevice,
    resolveTrustedPendingDevice: () => trustedPending,
    issuerDeviceId,
    issuerSigningPrivateKey: issuer.privateKey,
    createdAt: unixTimestamp(10_000),
    inventoryRevision,
    sources,
    resolveTrustedInventoryCommitment: () => commitment,
    resolveCurrentApprover: () => issuer.publicKey,
    resolveCurrentDomainCommitter: () => issuer.publicKey,
  });
  const chunks = chunkOpaqueDeliveryArtifact({
    crypto,
    kind: "device_transfer",
    operationId: "operation_transfer",
    recipientDeviceId: targetDeviceId,
    artifactBytes: prepared.approvalBytes,
  });
  const messages = chunks.map((chunk, index) => {
    const payloadBytes = serializeOpaqueDeliveryArtifactChunk(chunk, crypto);
    return Object.freeze({
      messageId: `message_${index + 1}`,
      operationId: "operation_transfer",
      recipientSequence: index + 1,
      kind: "device_transfer" as const,
      formatVersion: 1 as const,
      payloadHash: crypto.hash(payloadBytes),
      payloadBytes,
      createdAt: 10_000,
      expiresAt: 20_000,
    });
  });
  const profile: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2,
    deviceId: targetDeviceId,
    signingPublicKey: targetSigning.publicKey,
    signingPrivateKey: targetSigning.privateKey,
    encryptionPublicKey: targetEncryption.publicKey,
    encryptionPrivateKey: targetEncryption.privateKey,
    trustedDeviceRevision: 0,
    trustedHostAuthorizationRevision: 1,
    deliveryHighWatermark: 0,
    keyringDeliveries: Object.freeze([]),
  });
  const authority = {
    pendingDevice,
    resolveTrustedPendingDevice: () => trustedPending,
    expectedInventory: inventory,
    resolveTrustedInventoryCommitment: () => commitment,
    resolveCurrentApprover: () => issuer.publicKey,
    resolveCurrentDomainCommitter: () => issuer.publicKey,
  };
  return { crypto, profile, messages, authority, keyrings };
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to fail");
}

describe("signed split-custody client keyring delivery", () => {
  test("opens HPKE delivery and retains Human+AI keyrings independently", async () => {
    const setup = await fixture();
    const updated = await ingestClientKeyringDeliveryHistory({
      crypto: setup.crypto,
      profile: setup.profile,
      serverHighWatermark: setup.messages.length,
      messages: setup.messages,
      resolveAuthority: () => setup.authority,
    });
    expect(updated.deliveryHighWatermark).toBe(setup.messages.length);
    expect(updated.keyringDeliveries.map((entry) => entry.keyClass))
      .toEqual(["ai", "human"]);
    const humanCurrent = await withClientNamespaceKeyring({
      profile: updated,
      namespaceId: "namespace_room",
      keyClass: "human",
      operation: (opened) => opened.currentGeneration,
    });
    expect(humanCurrent).toBe(setup.keyrings.human.currentGeneration);
  });

  test("accepts an authenticated empty inventory only for an empty target profile", async () => {
    const empty = await fixture({ empty: true });
    const updated = await ingestClientKeyringDeliveryHistory({
      crypto: empty.crypto,
      profile: empty.profile,
      serverHighWatermark: empty.messages.length,
      messages: empty.messages,
      resolveAuthority: () => empty.authority,
    });
    expect(updated.deliveryHighWatermark).toBe(empty.messages.length);
    expect(updated.keyringDeliveries).toEqual([]);

    const populated = await fixture();
    const populatedProfile = await ingestClientKeyringDeliveryHistory({
      crypto: populated.crypto,
      profile: populated.profile,
      serverHighWatermark: populated.messages.length,
      messages: populated.messages,
      resolveAuthority: () => populated.authority,
    });
    expect(String(await captureError(() => ingestClientKeyringDeliveryHistory({
      crypto: empty.crypto,
      profile: {
        ...empty.profile,
        keyringDeliveries: populatedProfile.keyringDeliveries,
      },
      serverHighWatermark: empty.messages.length,
      messages: empty.messages,
      resolveAuthority: () => empty.authority,
    })))).toContain("cannot replace retained keyrings");
  });

  test("rejects delivery rollback, gaps, payload mutation, and stale authority", async () => {
    const setup = await fixture();
    const current = { ...setup.profile, deliveryHighWatermark: 2 };
    expect(String(await captureError(() => ingestClientKeyringDeliveryHistory({
      crypto: setup.crypto,
      profile: current,
      serverHighWatermark: 1,
      messages: setup.messages,
      resolveAuthority: () => setup.authority,
    })))).toContain("rollback");
    expect(String(await captureError(() => ingestClientKeyringDeliveryHistory({
      crypto: setup.crypto,
      profile: setup.profile,
      serverHighWatermark: setup.messages.length + 1,
      messages: setup.messages.map((message, index) =>
        index === 0 ? { ...message, recipientSequence: 2 } : message
      ),
      resolveAuthority: () => setup.authority,
    })))).toContain("noncanonical");
    const payload = setup.messages[0]!.payloadBytes.slice();
    payload[0]! ^= 1;
    expect(String(await captureError(() => ingestClientKeyringDeliveryHistory({
      crypto: setup.crypto,
      profile: setup.profile,
      serverHighWatermark: setup.messages.length,
      messages: [{ ...setup.messages[0]!, payloadBytes: payload }],
      resolveAuthority: () => setup.authority,
    })))).toContain("noncanonical");
    expect(String(await captureError(() => ingestClientKeyringDeliveryHistory({
      crypto: setup.crypto,
      profile: setup.profile,
      serverHighWatermark: setup.messages.length,
      messages: setup.messages,
      resolveAuthority: () => null,
    })))).toContain("authority");
  });

  test("atomically stages and activates authenticated delivery custody", async () => {
    const setup = await fixture();
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    const initialBytes = encodeClientDeviceProfileV2(setup.profile);
    try {
      await vault.stageProfile({
        coordinates: COORDINATES,
        stageId: "stage_initial",
        generation: 1,
        profileBytes: initialBytes,
        publicState: {
          clientKind: "browser",
          publicFingerprint: "31".repeat(32),
        },
      });
      await vault.activateProfile(COORDINATES, "stage_initial");
    } finally {
      initialBytes.fill(0);
    }
    await ingestAndReplaceClientKeyringDeliveryHistory({
      crypto: setup.crypto,
      vault,
      coordinates: COORDINATES,
      stageId: "stage_delivery",
      generation: 2,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "32".repeat(32),
      },
      serverHighWatermark: setup.messages.length,
      messages: setup.messages,
      resolveAuthority: () => setup.authority,
    });
    await vault.withOpenProfile(COORDINATES, async (bytes) => {
      const opened = await authenticateClientDeviceProfile({
        crypto: setup.crypto,
        profileBytes: bytes,
        expectedDeviceId: COORDINATES.deviceId,
      });
      try {
        expect(opened).toMatchObject({
          formatVersion: 2,
          deliveryHighWatermark: setup.messages.length,
        });
      } finally {
        destroyOpenedClientDeviceProfile(opened);
      }
    });
  });
});

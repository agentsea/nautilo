import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { namespaceGenerationKeyCommitmentV1 } from
  "../../src/format/namespace-generation-v1.ts";
import {
  decodeNamespaceRecipientAuthorizationV1,
  destroyNamespaceRecipientAuthorizationV1,
  encodeNamespaceRecipientAuthorizationV1,
  namespaceRecipientAuthorizationDigestV1,
  openNamespaceRecipientAuthorizationV1,
  openNamespaceRecipientAuthorizationExactReplayV1,
  prepareNamespaceRecipientAuthorizationV1,
  verifyNamespaceRecipientAuthorizationExactReplayV1,
  verifyNamespaceRecipientAuthorizationV1,
} from "../../src/format/namespace-recipient-authorization-v1.ts";
import {
  accessRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

describe("M290 historical Namespace recipient authorization V1", () => {
  test("rewraps the same committed historical key to an approved new recipient", async () => {
    const crypto = new LatticeCrypto(seededRng(290_101), { now: () => NOW });
    const issuer = crypto.generateSigningKeyPair();
    const target = await crypto.generateEncryptionKeyPair();
    const generationKey = new Uint8Array(32).fill(0x71);
    const namespace = namespaceId("namespace:shared-history");
    const generation = namespaceGeneration(3);
    const prepared = await prepareNamespaceRecipientAuthorizationV1(crypto, {
      operationId: "namespace-recipient:shared-history:device-b",
      currentAccessRevision: accessRevision(9),
      currentAudienceFingerprint: new Uint8Array(32).fill(0x90),
      issuerHumanId: humanId("human:alpha"),
      issuerDeviceId: cryptoDeviceId("device:alpha"),
      issuerSigningKeyGeneration: 1,
      issuerSigningPublicKey: issuer.publicKey,
      issuerSigningPrivateKey: issuer.privateKey,
      target: {
        recipientHumanId: humanId("human:beta"),
        recipientKind: "device",
        recipientKeyId: "device:beta",
        recipientKeyGeneration: 1,
        recipientPublicKeyDigest: crypto.hash(target.publicKey),
        recipientPublicKey: target.publicKey,
      },
      issuedAt: unixTimestamp(NOW),
      expiresAt: unixTimestamp(NOW + 30_000),
      entries: [{
        namespaceId: namespace,
        keyClass: "ai",
        generation,
        sourceAccessRevision: accessRevision(4),
        sourceAudienceFingerprint: new Uint8Array(32).fill(0x40),
        sourceHeadDigest: new Uint8Array(32).fill(0x41),
        sourcePublicationDigest: new Uint8Array(32).fill(0x42),
        sourcePublicationSetDigest: new Uint8Array(32).fill(0x43),
        sourceRecipientEnvelopeDigest: new Uint8Array(32).fill(0x44),
        generationKeyCommitment: namespaceGenerationKeyCommitmentV1({
          namespaceId: namespace,
          keyClass: "ai",
          generation,
          generationKey,
        }),
        generationKey,
      }],
    });

    expect(encodeNamespaceRecipientAuthorizationV1(
      decodeNamespaceRecipientAuthorizationV1(prepared.bytes),
    )).toEqual(prepared.bytes);
    expect(namespaceRecipientAuthorizationDigestV1(prepared.bytes))
      .toEqual(prepared.digest);

    const opened = await openNamespaceRecipientAuthorizationV1(crypto, {
      bytes: prepared.bytes,
      issuerSigningPublicKey: issuer.publicKey,
      now: unixTimestamp(NOW + 1),
      expectedDigest: prepared.digest,
      recipientHumanId: humanId("human:beta"),
      recipientKind: "device",
      recipientKeyId: "device:beta",
      recipientKeyGeneration: 1,
      recipientPrivateKey: target.privateKey,
      namespaceId: namespace,
      keyClass: "ai",
      generation,
    });
    expect(opened?.generationKey).toEqual(generationKey);
    expect(opened?.entry.sourceAccessRevision).toBe(accessRevision(4));
    opened?.authorizationDigest.fill(0);
    opened?.envelopeDigest.fill(0);
    opened?.generationKey.fill(0);
    if (opened) {
      opened.entry.sourceAudienceFingerprint.fill(0);
      opened.entry.sourceHeadDigest.fill(0);
      opened.entry.sourcePublicationDigest.fill(0);
      opened.entry.sourcePublicationSetDigest.fill(0);
      opened.entry.sourceRecipientEnvelopeDigest.fill(0);
      opened.entry.generationKeyCommitment.fill(0);
    }
    const replayed = await openNamespaceRecipientAuthorizationExactReplayV1(
      crypto,
      {
        bytes: prepared.bytes,
        issuerSigningPublicKey: issuer.publicKey,
        expectedDigest: prepared.digest,
        recipientHumanId: humanId("human:beta"),
        recipientKind: "device",
        recipientKeyId: "device:beta",
        recipientKeyGeneration: 1,
        recipientPrivateKey: target.privateKey,
        namespaceId: namespace,
        keyClass: "ai",
        generation,
      },
    );
    expect(replayed?.generationKey).toEqual(generationKey);
    replayed?.authorizationDigest.fill(0);
    replayed?.envelopeDigest.fill(0);
    replayed?.generationKey.fill(0);
    if (replayed) {
      replayed.entry.sourceAudienceFingerprint.fill(0);
      replayed.entry.sourceHeadDigest.fill(0);
      replayed.entry.sourcePublicationDigest.fill(0);
      replayed.entry.sourcePublicationSetDigest.fill(0);
      replayed.entry.sourceRecipientEnvelopeDigest.fill(0);
      replayed.entry.generationKeyCommitment.fill(0);
    }
  });

  test("rejects stale, substituted, wrong-recipient, and wrong-key authorization", async () => {
    const crypto = new LatticeCrypto(seededRng(290_102), { now: () => NOW });
    const issuer = crypto.generateSigningKeyPair();
    const target = await crypto.generateEncryptionKeyPair();
    const wrongTarget = await crypto.generateEncryptionKeyPair();
    const namespace = namespaceId("namespace:history");
    const generation = namespaceGeneration(0);
    const generationKey = new Uint8Array(32).fill(0x55);
    const base = {
      operationId: "namespace-recipient:history",
      currentAccessRevision: accessRevision(2),
      currentAudienceFingerprint: new Uint8Array(32).fill(0x20),
      issuerHumanId: humanId("human:alpha"),
      issuerDeviceId: cryptoDeviceId("device:alpha"),
      issuerSigningKeyGeneration: 1,
      issuerSigningPublicKey: issuer.publicKey,
      issuerSigningPrivateKey: issuer.privateKey,
      target: {
        recipientHumanId: humanId("human:beta"),
        recipientKind: "device" as const,
        recipientKeyId: "device:beta",
        recipientKeyGeneration: 1,
        recipientPublicKeyDigest: crypto.hash(target.publicKey),
        recipientPublicKey: target.publicKey,
      },
      issuedAt: unixTimestamp(NOW),
      expiresAt: unixTimestamp(NOW + 30_000),
      entries: [{
        namespaceId: namespace,
        keyClass: "human" as const,
        generation,
        sourceAccessRevision: accessRevision(1),
        sourceAudienceFingerprint: new Uint8Array(32).fill(0x11),
        sourceHeadDigest: new Uint8Array(32).fill(0x12),
        sourcePublicationDigest: new Uint8Array(32).fill(0x13),
        sourcePublicationSetDigest: new Uint8Array(32).fill(0x14),
        sourceRecipientEnvelopeDigest: new Uint8Array(32).fill(0x15),
        generationKeyCommitment: namespaceGenerationKeyCommitmentV1({
          namespaceId: namespace,
          keyClass: "human",
          generation,
          generationKey,
        }),
        generationKey,
      }],
    };
    const prepared = await prepareNamespaceRecipientAuthorizationV1(crypto, base);

    expect(verifyNamespaceRecipientAuthorizationV1(crypto, {
      bytes: prepared.bytes,
      issuerSigningPublicKey: issuer.publicKey,
      now: unixTimestamp(NOW + 30_000),
    })).toBeNull();
    const replay = verifyNamespaceRecipientAuthorizationExactReplayV1(crypto, {
      bytes: prepared.bytes,
      issuerSigningPublicKey: issuer.publicKey,
      expectedDigest: prepared.digest,
    });
    expect(replay).not.toBeNull();
    if (replay) destroyNamespaceRecipientAuthorizationV1(replay);

    const decoded = decodeNamespaceRecipientAuthorizationV1(prepared.bytes);
    const substitutedBytes = encodeNamespaceRecipientAuthorizationV1({
      ...decoded,
      currentAccessRevision: accessRevision(3),
    });
    expect(verifyNamespaceRecipientAuthorizationV1(crypto, {
      bytes: substitutedBytes,
      issuerSigningPublicKey: issuer.publicKey,
      now: unixTimestamp(NOW + 1),
    })).toBeNull();
    destroyNamespaceRecipientAuthorizationV1(decoded);
    substitutedBytes.fill(0);

    expect(await openNamespaceRecipientAuthorizationV1(crypto, {
      bytes: prepared.bytes,
      issuerSigningPublicKey: issuer.publicKey,
      now: unixTimestamp(NOW + 1),
      recipientHumanId: humanId("human:beta"),
      recipientKind: "device",
      recipientKeyId: "device:beta",
      recipientKeyGeneration: 1,
      recipientPrivateKey: wrongTarget.privateKey,
      namespaceId: namespace,
      keyClass: "human",
      generation,
    })).toBeNull();

    try {
      await prepareNamespaceRecipientAuthorizationV1(crypto, {
        ...base,
        entries: [{
          ...base.entries[0]!,
          generationKey: new Uint8Array(32).fill(0x99),
        }],
      });
      throw new Error("Expected generation-key mismatch to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(TypeError);
      expect((error as Error).message).toContain("generation key disagrees");
    }
  });
});

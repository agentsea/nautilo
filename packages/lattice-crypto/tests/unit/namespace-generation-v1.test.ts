import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1,
  NAMESPACE_GENERATION_MAX_RECIPIENTS_V1,
  decodeNamespaceGenerationHeadV1,
  decodeNamespaceGenerationPublicationV1,
  decodeNamespaceGenerationPublicationSetV1,
  decodeNamespaceGenerationReceiptV1,
  decodeNamespaceGenerationRecipientEnvelopeV1,
  decodeNamespaceGenerationSecretV1,
  encodeNamespaceGenerationHeadV1,
  encodeNamespaceGenerationPublicationV1,
  encodeNamespaceGenerationPublicationSetV1,
  encodeNamespaceGenerationReceiptV1,
  encodeNamespaceGenerationRecipientEnvelopeV1,
  encodeNamespaceGenerationSecretV1,
  namespaceGenerationHeadDigestV1,
  namespaceGenerationKeyCommitmentV1,
  namespaceGenerationAudienceFingerprintV1,
  namespaceGenerationPublicationDigestV1,
  namespaceGenerationPublicationSigningBytesV1,
  namespaceGenerationRecipientSetDigestV1,
  openNamespaceGenerationEnvelopeV1,
  openNamespaceGenerationPublicationSetV1,
  openNamespaceGenerationPublicationSetExactReplayV1,
  prepareNamespaceGenerationPublicationV1,
  prepareNamespaceGenerationPublicationSetV1,
  withVerifiedNamespaceGenerationPublicationSetV1,
  withVerifiedNamespaceGenerationPublicationSetExactReplayV1,
  type NamespaceGenerationHeadV1,
  type NamespaceGenerationPublicationV1,
  type NamespaceGenerationRecipientEnvelopeV1,
  type NamespaceGenerationRecipientV1,
  type NamespaceGenerationSecretV1,
} from "../../src/format/namespace-generation-v1.ts";
import {
  accessRevision,
  cryptoDeviceId,
  humanId,
  namespaceGeneration,
  namespaceId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

function recipients(): readonly NamespaceGenerationRecipientV1[] {
  return Object.freeze([{
    recipientHumanId: humanId("human:alpha"),
    recipientKind: "device" as const,
    recipientKeyId: "device-key:alpha:1",
    recipientKeyGeneration: 1,
    recipientPublicKeyDigest: new Uint8Array(32).fill(0x11),
  }, {
    recipientHumanId: humanId("human:alpha"),
    recipientKind: "recovery" as const,
    recipientKeyId: "recovery-key:alpha:1",
    recipientKeyGeneration: 1,
    recipientPublicKeyDigest: new Uint8Array(32).fill(0x22),
  }]);
}

function manyRecipients(count: number): readonly NamespaceGenerationRecipientV1[] {
  return Object.freeze(Array.from({ length: count }, (_, index) => {
    const digest = new Uint8Array(32);
    new DataView(digest.buffer).setUint32(28, index, false);
    return Object.freeze({
      recipientHumanId: humanId("human:scale"),
      recipientKind: "device" as const,
      recipientKeyId: `device-key:scale:${index.toString().padStart(5, "0")}`,
      recipientKeyGeneration: 1,
      recipientPublicKeyDigest: digest,
    });
  }));
}

function head(): NamespaceGenerationHeadV1 {
  const selected = recipients();
  return {
    formatVersion: 1,
    operationId: "namespace-generation:alpha",
    namespaceId: namespaceId("namespace:alpha"),
    keyClass: "ai",
    accessRevision: accessRevision(0),
    generation: namespaceGeneration(0),
    generationKeyCommitment: namespaceGenerationKeyCommitmentV1({
      namespaceId: namespaceId("namespace:alpha"),
      keyClass: "ai",
      generation: namespaceGeneration(0),
      generationKey: new Uint8Array(32).fill(0x44),
    }),
    audienceFingerprint: new Uint8Array(32).fill(0x33),
    previousHeadDigest: null,
    issuerHumanId: humanId("human:alpha"),
    issuerDeviceId: cryptoDeviceId("device:alpha"),
    issuerSigningKeyGeneration: 1,
    recipientCount: selected.length,
    recipientSetDigest: namespaceGenerationRecipientSetDigestV1(selected),
    issuedAt: unixTimestamp(NOW),
    expiresAt: unixTimestamp(NOW + 30_000),
  };
}

function secret(): NamespaceGenerationSecretV1 {
  const selected = recipients()[0]!;
  const value = head();
  return {
    formatVersion: 1,
    namespaceId: value.namespaceId,
    keyClass: value.keyClass,
    accessRevision: value.accessRevision,
    generation: value.generation,
    generationKey: new Uint8Array(32).fill(0x44),
    audienceFingerprint: value.audienceFingerprint,
    headDigest: namespaceGenerationHeadDigestV1(value),
    ...selected,
  };
}

function envelopes(): readonly NamespaceGenerationRecipientEnvelopeV1[] {
  const selected = recipients();
  const value = head();
  const headDigest = namespaceGenerationHeadDigestV1(value);
  return selected.map((recipient, index) => ({
    formatVersion: 1,
    namespaceId: value.namespaceId,
    keyClass: value.keyClass,
    accessRevision: value.accessRevision,
    generation: value.generation,
    audienceFingerprint: value.audienceFingerprint,
    headDigest,
    ...recipient,
    ciphertext: new Uint8Array(80).fill(0x50 + index),
  }));
}

function publication(): NamespaceGenerationPublicationV1 {
  return {
    formatVersion: 1,
    head: head(),
    envelopes: envelopes(),
    signature: new Uint8Array(64).fill(0x66),
  };
}

describe("M290 Namespace generation V1 canonical bytes", () => {
  test("M295 uses the durable 4,096-recipient and 64 MiB publication envelope", () => {
    expect(NAMESPACE_GENERATION_MAX_RECIPIENTS_V1).toBe(4_096);
    expect(MAX_NAMESPACE_GENERATION_PUBLICATION_WIRE_BYTES_V1 * 2).toBe(
      64 * 1024 * 1024,
    );

    for (const count of [321, 4_096]) {
      const selected = manyRecipients(count);
      const digest = namespaceGenerationRecipientSetDigestV1(selected);
      expect(digest).toHaveLength(32);
      digest.fill(0);
      selected.forEach((recipient) => recipient.recipientPublicKeyDigest.fill(0));
    }

    const oversized = manyRecipients(4_097);
    expect(() => namespaceGenerationRecipientSetDigestV1(oversized)).toThrow(
      "Namespace generation recipients",
    );
    oversized.forEach((recipient) => recipient.recipientPublicKeyDigest.fill(0));
  });

  test("pins the canonical Human audience independently of order", () => {
    const alpha = humanId("human:alpha");
    const beta = humanId("human:beta");
    expect(namespaceGenerationAudienceFingerprintV1([alpha, beta])).toEqual(
      namespaceGenerationAudienceFingerprintV1([beta, alpha]),
    );
    expect(() => namespaceGenerationAudienceFingerprintV1([alpha, alpha]))
      .toThrow("duplicate");
  });
  test("retains pre-M314 canonical audience fingerprint bytes", () => {
    for (const [count, digest] of [
      [2, "89a5417a2ea26e241600968a87a7b5d347b2531bb8295c6cdff1c06dfecd5ba1"],
      [4096, "268a6c16d5725a513352abfe921f68c8ad7981067df3d6e1690d58243ef45103"],
    ] as const) {
      const audience = Array.from({ length: count },
        (_, index) => humanId(`human:${index.toString().padStart(6, "0")}`));
      expect(Buffer.from(namespaceGenerationAudienceFingerprintV1(audience)).toString("hex"))
        .toBe(digest);
    }
  });
  test("audience commitments exceed the V1 recipient publication bound", () => {
    const audience = Array.from({ length: NAMESPACE_GENERATION_MAX_RECIPIENTS_V1 + 1 },
      (_, index) => humanId(`human:${index.toString().padStart(6, "0")}`));
    expect(namespaceGenerationAudienceFingerprintV1(audience)).toHaveLength(32);
    expect(namespaceGenerationAudienceFingerprintV1([...audience].reverse()))
      .toEqual(namespaceGenerationAudienceFingerprintV1(audience));
    expect(() => namespaceGenerationAudienceFingerprintV1([])).toThrow();
  });
  test("pins exact head, secret, envelope, publication, and receipt digests", () => {
    const crypto = new LatticeCrypto(seededRng(290_001));
    const headBytes = encodeNamespaceGenerationHeadV1(head());
    const secretBytes = encodeNamespaceGenerationSecretV1(secret());
    const envelopeBytes = encodeNamespaceGenerationRecipientEnvelopeV1(
      envelopes()[0]!,
    );
    const publicationBytes = encodeNamespaceGenerationPublicationV1(
      publication(),
    );
    const receiptBytes = encodeNamespaceGenerationReceiptV1({
      formatVersion: 1,
      operationId: "namespace-generation:alpha",
      namespaceId: namespaceId("namespace:alpha"),
      keyClass: "ai",
      accessRevision: accessRevision(0),
      generation: namespaceGeneration(0),
      headDigest: namespaceGenerationHeadDigestV1(head()),
      publicationDigest: namespaceGenerationPublicationDigestV1(
        publicationBytes,
      ),
      committedAt: unixTimestamp(NOW + 1),
    });

    expect(Buffer.from(crypto.hash(headBytes)).toString("hex")).toBe(
      "227134b4b788b0536ec4713e8f48248007f1ce9bf0d940e3650fc4587b725676",
    );
    expect(Buffer.from(crypto.hash(secretBytes)).toString("hex")).toBe(
      "a5e8dd54de657f22abfe4debfb3a8aeff2db3abc751f915075900b302c43a9cd",
    );
    expect(Buffer.from(crypto.hash(envelopeBytes)).toString("hex")).toBe(
      "7668d3fb42787933f45effa10bcd4283ba9f959aba69a608f21afb3e167ccc2a",
    );
    expect(Buffer.from(crypto.hash(publicationBytes)).toString("hex")).toBe(
      "018bb3c55a5efcf62f80e0bc46c87aba37c7c549ee8a8fcfcf9123db2ef7d5af",
    );
    expect(Buffer.from(crypto.hash(receiptBytes)).toString("hex")).toBe(
      "24533aba99822e133d2f5b9b2924cf93e3670a157c3019a40914e876d7017e1e",
    );

    expect(encodeNamespaceGenerationHeadV1(
      decodeNamespaceGenerationHeadV1(headBytes),
    )).toEqual(headBytes);
    expect(encodeNamespaceGenerationSecretV1(
      decodeNamespaceGenerationSecretV1(secretBytes),
    )).toEqual(secretBytes);
    expect(encodeNamespaceGenerationRecipientEnvelopeV1(
      decodeNamespaceGenerationRecipientEnvelopeV1(envelopeBytes),
    )).toEqual(envelopeBytes);
    expect(encodeNamespaceGenerationPublicationV1(
      decodeNamespaceGenerationPublicationV1(publicationBytes),
    )).toEqual(publicationBytes);
    expect(encodeNamespaceGenerationReceiptV1(
      decodeNamespaceGenerationReceiptV1(receiptBytes),
    )).toEqual(receiptBytes);
  });

  test("rejects incomplete, duplicate, reordered, substituted, and noncanonical publications", () => {
    const value = publication();
    expect(() => encodeNamespaceGenerationPublicationV1({
      ...value,
      envelopes: value.envelopes.slice(0, 1),
    })).toThrow("recipient count disagrees");
    expect(() => encodeNamespaceGenerationPublicationV1({
      ...value,
      envelopes: [value.envelopes[0]!, value.envelopes[0]!],
    })).toThrow("canonical and unique");
    expect(() => encodeNamespaceGenerationPublicationV1({
      ...value,
      envelopes: [...value.envelopes].reverse(),
    })).toThrow("canonical and unique");
    expect(() => encodeNamespaceGenerationPublicationV1({
      ...value,
      envelopes: [{
        ...value.envelopes[0]!,
        headDigest: new Uint8Array(32).fill(0xff),
      }, value.envelopes[1]!],
    })).toThrow("coordinates disagree");

    const wire = encodeNamespaceGenerationPublicationV1(value);
    expect(() => decodeNamespaceGenerationPublicationV1(
      new Uint8Array([...wire, 0]),
    )).toThrow("trailing bytes");
    expect(() => decodeNamespaceGenerationPublicationV1(wire.subarray(0, -1)))
      .toThrow();
  });

  test("seals one random generation to every exact recipient and opens only its target", async () => {
    const crypto = new LatticeCrypto(seededRng(290_002), {
      now: () => NOW,
    });
    const signing = crypto.generateSigningKeyPair();
    const device = await crypto.generateEncryptionKeyPair();
    const recovery = await crypto.generateEncryptionKeyPair();
    const generationKey = new Uint8Array(32).fill(0xab);
    const prepared = await prepareNamespaceGenerationPublicationV1(crypto, {
      operationId: "namespace-generation:workflow",
      namespaceId: namespaceId("namespace:workflow"),
      keyClass: "ai",
      accessRevision: accessRevision(0),
      generation: namespaceGeneration(0),
      generationKey,
      audienceFingerprint: new Uint8Array(32).fill(0x31),
      previousHeadDigest: null,
      issuerHumanId: humanId("human:alpha"),
      issuerDeviceId: cryptoDeviceId("device:alpha"),
      issuerSigningKeyGeneration: 1,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
      recipients: [{
        recipientHumanId: humanId("human:alpha"),
        recipientKind: "device",
        recipientKeyId: "device-key:alpha:1",
        recipientKeyGeneration: 1,
        recipientPublicKeyDigest: crypto.hash(device.publicKey),
        recipientPublicKey: device.publicKey,
      }, {
        recipientHumanId: humanId("human:alpha"),
        recipientKind: "recovery",
        recipientKeyId: "recovery-key:alpha:1",
        recipientKeyGeneration: 1,
        recipientPublicKeyDigest: crypto.hash(recovery.publicKey),
        recipientPublicKey: recovery.publicKey,
      }],
      issuedAt: unixTimestamp(NOW),
      expiresAt: unixTimestamp(NOW + 30_000),
    });

    expect(prepared.publication.envelopes).toHaveLength(2);
    const opened = await openNamespaceGenerationEnvelopeV1(crypto, {
      publicationBytes: prepared.bytes,
      issuerSigningPublicKey: signing.publicKey,
      recipientHumanId: humanId("human:alpha"),
      recipientKind: "device",
      recipientKeyId: "device-key:alpha:1",
      recipientKeyGeneration: 1,
      recipientPrivateKey: device.privateKey,
      now: unixTimestamp(NOW + 1),
      expectedPublicationDigest: prepared.publicationDigest,
    });
    expect(opened?.generationKey).toEqual(generationKey);

    expect(await openNamespaceGenerationEnvelopeV1(crypto, {
      publicationBytes: prepared.bytes,
      issuerSigningPublicKey: signing.publicKey,
      recipientHumanId: humanId("human:alpha"),
      recipientKind: "device",
      recipientKeyId: "device-key:alpha:1",
      recipientKeyGeneration: 1,
      recipientPrivateKey: recovery.privateKey,
      now: unixTimestamp(NOW + 1),
    })).toBeNull();
    expect(await openNamespaceGenerationEnvelopeV1(crypto, {
      publicationBytes: prepared.bytes,
      issuerSigningPublicKey: signing.publicKey,
      recipientHumanId: humanId("human:alpha"),
      recipientKind: "device",
      recipientKeyId: "device-key:alpha:1",
      recipientKeyGeneration: 1,
      recipientPrivateKey: device.privateKey,
      now: unixTimestamp(NOW + 30_000),
    })).toBeNull();

    const signingBytes = namespaceGenerationPublicationSigningBytesV1(
      prepared.publication,
    );
    expect(crypto.verify(
      signing.publicKey,
      signingBytes,
      prepared.publication.signature,
    )).toBe(true);
  });

  test("atomically binds exactly AI and Human publications and rejects cross-class drift", async () => {
    const crypto = new LatticeCrypto(seededRng(290_003), {
      now: () => NOW,
    });
    const signing = crypto.generateSigningKeyPair();
    const device = await crypto.generateEncryptionKeyPair();
    const recipient = {
      recipientHumanId: humanId("human:alpha"),
      recipientKind: "device" as const,
      recipientKeyId: "device-key:alpha:1",
      recipientKeyGeneration: 1,
      recipientPublicKeyDigest: crypto.hash(device.publicKey),
      recipientPublicKey: device.publicKey,
    };
    const base = {
      operationId: "namespace-generation:set",
      namespaceId: namespaceId("namespace:set"),
      accessRevision: accessRevision(0),
      audienceFingerprint: new Uint8Array(32).fill(0x77),
      issuerHumanId: humanId("human:alpha"),
      issuerDeviceId: cryptoDeviceId("device:alpha"),
      issuerSigningKeyGeneration: 1,
      issuerSigningPublicKey: signing.publicKey,
      issuerSigningPrivateKey: signing.privateKey,
      recipients: [recipient],
      issuedAt: unixTimestamp(NOW),
      expiresAt: unixTimestamp(NOW + 30_000),
    };
    const classes = [{
      keyClass: "ai" as const,
      generation: namespaceGeneration(0),
      generationKey: new Uint8Array(32).fill(0xa1),
      previousHeadDigest: null,
    }, {
      keyClass: "human" as const,
      generation: namespaceGeneration(0),
      generationKey: new Uint8Array(32).fill(0xb1),
      previousHeadDigest: null,
    }];
    const prepared = await prepareNamespaceGenerationPublicationSetV1(
      crypto,
      { ...base, classes },
    );
    expect(prepared.publicationSet.entries.map((entry) => entry.keyClass))
      .toEqual(["ai", "human"]);
    expect(prepared.publicationSet.totalEnvelopeCount).toBe(2);
    expect(encodeNamespaceGenerationPublicationSetV1(
      decodeNamespaceGenerationPublicationSetV1(prepared.bytes),
    )).toEqual(prepared.bytes);
    expect((await openNamespaceGenerationPublicationSetV1(crypto, {
      publicationSetBytes: prepared.bytes,
      keyClass: "ai",
      issuerSigningPublicKey: signing.publicKey,
      recipientHumanId: humanId("human:alpha"),
      recipientKind: "device",
      recipientKeyId: "device-key:alpha:1",
      recipientKeyGeneration: 1,
      recipientPrivateKey: device.privateKey,
      now: unixTimestamp(NOW + 1),
      expectedPublicationSetDigest: prepared.digest,
    }))?.generationKey).toEqual(new Uint8Array(32).fill(0xa1));
    expect(await withVerifiedNamespaceGenerationPublicationSetV1(
      crypto,
      {
        publicationSetBytes: prepared.bytes,
        issuerSigningPublicKey: signing.publicKey,
        now: unixTimestamp(NOW + 1),
        expectedPublicationSetDigest: prepared.digest,
        use: ({ publicationSet }) => publicationSet.totalEnvelopeCount,
      },
    )).toBe(2);
    expect(await withVerifiedNamespaceGenerationPublicationSetV1(
      crypto,
      {
        publicationSetBytes: prepared.bytes,
        issuerSigningPublicKey: signing.publicKey,
        now: unixTimestamp(NOW + 30_001),
        expectedPublicationSetDigest: prepared.digest,
        use: () => true,
      },
    )).toBeNull();
    expect(await withVerifiedNamespaceGenerationPublicationSetExactReplayV1(
      crypto,
      {
        publicationSetBytes: prepared.bytes,
        issuerSigningPublicKey: signing.publicKey,
        expectedPublicationSetDigest: prepared.digest,
        use: ({ publicationSet }) => publicationSet.operationId,
      },
    )).toBe("namespace-generation:set");
    expect((await openNamespaceGenerationPublicationSetExactReplayV1(
      crypto,
      {
        publicationSetBytes: prepared.bytes,
        keyClass: "ai",
        issuerSigningPublicKey: signing.publicKey,
        recipientHumanId: humanId("human:alpha"),
        recipientKind: "device",
        recipientKeyId: "device-key:alpha:1",
        recipientKeyGeneration: 1,
        recipientPrivateKey: device.privateKey,
        expectedPublicationSetDigest: prepared.digest,
      },
    ))?.generationKey).toEqual(new Uint8Array(32).fill(0xa1));
    const wrongDurableDigest = prepared.digest.slice();
    wrongDurableDigest[0] = wrongDurableDigest[0]! ^ 0x01;
    expect(await withVerifiedNamespaceGenerationPublicationSetExactReplayV1(
      crypto,
      {
        publicationSetBytes: prepared.bytes,
        issuerSigningPublicKey: signing.publicKey,
        expectedPublicationSetDigest: wrongDurableDigest,
        use: () => true,
      },
    )).toBeNull();
    const substituted = prepared.bytes.slice();
    substituted[substituted.length - 1] =
      substituted[substituted.length - 1]! ^ 0x01;
    expect(await withVerifiedNamespaceGenerationPublicationSetV1(
      crypto,
      {
        publicationSetBytes: substituted,
        issuerSigningPublicKey: signing.publicKey,
        now: unixTimestamp(NOW + 1),
        use: () => true,
      },
    )).toBeNull();

    const set = prepared.publicationSet;
    expect(() => encodeNamespaceGenerationPublicationSetV1({
      ...set,
      entries: set.entries.slice(0, 1),
    })).toThrow("exactly AI and Human");
    expect(() => encodeNamespaceGenerationPublicationSetV1({
      ...set,
      entries: [...set.entries].reverse(),
    })).toThrow("canonical AI then Human");
    expect(() => encodeNamespaceGenerationPublicationSetV1({
      ...set,
      entries: [set.entries[0]!, set.entries[0]!],
    })).toThrow("canonical AI then Human");
    for (const drift of [{ operationId: "namespace-generation:other" }, {
      issuerDeviceId: cryptoDeviceId("device:other"),
    }, { audienceFingerprint: new Uint8Array(32).fill(0x78) }, {
      accessRevision: accessRevision(1),
    }, { expiresAt: unixTimestamp(NOW + 29_999) }]) {
      expect(() => encodeNamespaceGenerationPublicationSetV1({
        ...set,
        ...drift,
      })).toThrow("inner coordinates disagree");
    }
  });
});

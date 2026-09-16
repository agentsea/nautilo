import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  decodeDomainKeyHeadV2,
  destroyDomainKeyHeadV2,
  destroyDomainKeyRecipientAuthorizationV2,
  destroyDomainKeyRecipientEnvelopeV2,
  openDomainKeyRecipientEnvelopeV2,
  prepareDomainKeyHeadV2,
  prepareDomainKeyRecipientAuthorizationV2,
  prepareDomainKeyRecipientEnvelopeV2,
  verifyDomainKeyHeadV2,
  verifyDomainKeyRecipientAuthorizationExactReplayV2,
  verifyDomainKeyRecipientAuthorizationV2,
} from "../../src/format/domain-key-authority-v2.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

async function fixture(keyClass: "human" | "ai" = "human") {
  const crypto = new LatticeCrypto(seededRng(keyClass === "human" ? 301_201 : 301_202));
  const signer = crypto.generateSigningKeyPair();
  const recipient = await crypto.deriveEncryptionKeyPair(
    new Uint8Array(32).fill(0x31),
  );
  const head = prepareDomainKeyHeadV2(crypto, {
    serverId: "server:alpha",
    cryptoDomainId: cryptoDomainId("domain:alpha-beta"),
    participantDigest: new Uint8Array(32).fill(0x41),
    participantCount: 2,
    keyClass,
    domainKeyGeneration: 1,
    authorizationRevision: authorizationRevision(1),
    previousHeadDigest: null,
    publicationOperationId: `operation:head:${keyClass}:1`,
    issuerHumanId: humanId("human:alpha"),
    issuerDeviceId: cryptoDeviceId("device:alpha"),
    issuerDeviceSigningGeneration: 1,
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    issuerSigningPublicKey: signer.publicKey,
    issuerSigningPrivateKey: signer.privateKey,
  });
  const domainKey = new Uint8Array(32).fill(keyClass === "human" ? 0x51 : 0x52);
  const envelope = await prepareDomainKeyRecipientEnvelopeV2(crypto, {
    head: head.head,
    headDigest: head.digest,
    recipient: {
      recipientHumanId: humanId("human:beta"),
      recipientKind: "device",
      recipientKeyId: "device-key:beta:1",
      recipientKeyGeneration: 1,
      recipientPublicKeyDigest: crypto.hash(recipient.publicKey),
      recipientPublicKey: recipient.publicKey,
    },
    domainKey,
    issuerHumanId: humanId("human:alpha"),
    issuerDeviceId: cryptoDeviceId("device:alpha"),
    issuerDeviceSigningGeneration: 1,
    issuerSigningPublicKey: signer.publicKey,
    issuerSigningPrivateKey: signer.privateKey,
  });
  const requestDigest = new Uint8Array(32).fill(0x61);
  const authorization = prepareDomainKeyRecipientAuthorizationV2(crypto, {
    authorizationOperationId: "operation:catch-up:beta:1",
    reason: "catch_up",
    requestDigest,
    envelopeBytes: envelope.bytes,
    envelopeDigest: envelope.digest,
    issuerHumanId: humanId("human:alpha"),
    issuerDeviceId: cryptoDeviceId("device:alpha"),
    issuerDeviceSigningGeneration: 1,
    issuedAt: NOW,
    deadlineAt: NOW + 30_000,
    issuerSigningPublicKey: signer.publicKey,
    issuerSigningPrivateKey: signer.privateKey,
  });
  return {
    crypto,
    signer,
    recipient,
    head,
    domainKey,
    envelope,
    requestDigest,
    authorization,
  };
}

describe("M301 class-bound Domain key authority V2", () => {
  test("round-trips one Human recipient without an audience inventory", async () => {
    const value = await fixture("human");
    const verifiedHead = verifyDomainKeyHeadV2(value.crypto, {
      headBytes: value.head.bytes,
      issuerSigningPublicKey: value.signer.publicKey,
      expectedHeadDigest: value.head.digest,
      now: NOW + 1,
    });
    expect(verifiedHead?.participantCount).toBe(2);
    expect(verifiedHead?.keyClass).toBe("human");

    const opened = await openDomainKeyRecipientEnvelopeV2(value.crypto, {
      envelopeBytes: value.envelope.bytes,
      expectedEnvelopeDigest: value.envelope.digest,
      issuerSigningPublicKey: value.signer.publicKey,
      recipientHumanId: humanId("human:beta"),
      recipientKind: "device",
      recipientKeyId: "device-key:beta:1",
      recipientKeyGeneration: 1,
      recipientPrivateKey: value.recipient.privateKey,
    });
    expect(opened?.domainKey).toEqual(value.domainKey);
    expect(opened?.envelope.keyClass).toBe("human");

    const fresh = verifyDomainKeyRecipientAuthorizationV2(value.crypto, {
      authorizationBytes: value.authorization.bytes,
      issuerSigningPublicKey: value.signer.publicKey,
      expectedAuthorizationDigest: value.authorization.digest,
      now: NOW + 1,
    });
    expect(fresh?.reason).toBe("catch_up");
    expect(fresh?.requestDigest).toEqual(value.requestDigest);
    expect(verifyDomainKeyRecipientAuthorizationV2(value.crypto, {
      authorizationBytes: value.authorization.bytes,
      issuerSigningPublicKey: value.signer.publicKey,
      now: NOW + 30_000,
    })).toBeNull();
    expect(verifyDomainKeyRecipientAuthorizationExactReplayV2(value.crypto, {
      authorizationBytes: value.authorization.bytes,
      issuerSigningPublicKey: value.signer.publicKey,
      expectedAuthorizationDigest: value.authorization.digest,
    })?.reason).toBe("catch_up");

    if (verifiedHead) destroyDomainKeyHeadV2(verifiedHead);
    if (opened) {
      opened.domainKey.fill(0);
      opened.envelopeDigest.fill(0);
      destroyDomainKeyRecipientEnvelopeV2(opened.envelope);
    }
    if (fresh) destroyDomainKeyRecipientAuthorizationV2(fresh);
  });

  test("binds class, server, Domain, head, recipient, and request bytes", async () => {
    const human = await fixture("human");
    const ai = await fixture("ai");

    expect(await openDomainKeyRecipientEnvelopeV2(human.crypto, {
      envelopeBytes: human.envelope.bytes,
      issuerSigningPublicKey: human.signer.publicKey,
      recipientHumanId: humanId("human:beta"),
      recipientKind: "device",
      recipientKeyId: "device-key:beta:1",
      recipientKeyGeneration: 2,
      recipientPrivateKey: human.recipient.privateKey,
    })).toBeNull();

    expect(verifyDomainKeyRecipientAuthorizationExactReplayV2(
      human.crypto,
      {
        authorizationBytes: human.authorization.bytes,
        issuerSigningPublicKey: human.signer.publicKey,
        expectedAuthorizationDigest: ai.authorization.digest,
      },
    )).toBeNull();

    const changed = human.envelope.bytes.slice();
    changed[changed.length - 1] = changed[changed.length - 1]! ^ 1;
    expect(await openDomainKeyRecipientEnvelopeV2(human.crypto, {
      envelopeBytes: changed,
      issuerSigningPublicKey: human.signer.publicKey,
      recipientHumanId: humanId("human:beta"),
      recipientKind: "device",
      recipientKeyId: "device-key:beta:1",
      recipientKeyGeneration: 1,
      recipientPrivateKey: human.recipient.privateKey,
    })).toBeNull();
    changed.fill(0);
  });

  test("keeps the signed head fixed-size beyond 64 participants", async () => {
    const small = await fixture("human");
    const large = prepareDomainKeyHeadV2(small.crypto, {
      serverId: "server:alpha",
      cryptoDomainId: cryptoDomainId("domain:large"),
      participantDigest: new Uint8Array(32).fill(0x71),
      participantCount: 10_000,
      keyClass: "human",
      domainKeyGeneration: 1,
      authorizationRevision: authorizationRevision(1),
      previousHeadDigest: null,
      publicationOperationId: "operation:head:large:1",
      issuerHumanId: humanId("human:alpha"),
      issuerDeviceId: cryptoDeviceId("device:alpha"),
      issuerDeviceSigningGeneration: 1,
      issuedAt: NOW,
      deadlineAt: NOW + 30_000,
      issuerSigningPublicKey: small.signer.publicKey,
      issuerSigningPrivateKey: small.signer.privateKey,
    });

    expect(large.bytes.length).toBeLessThan(1024);
    expect(Math.abs(large.bytes.length - small.head.bytes.length)).toBeLessThan(32);
    expect(decodeDomainKeyHeadV2(large.bytes).participantCount).toBe(10_000);
  });

  test("adds more than 320 recipients as independent bounded envelopes", async () => {
    const value = await fixture("ai");
    const envelopeDigests = new Set<string>();

    for (let index = 1; index <= 321; index += 1) {
      const recipient = await value.crypto.deriveEncryptionKeyPair(
        new Uint8Array(32).fill((index % 250) + 1),
      );
      const prepared = await prepareDomainKeyRecipientEnvelopeV2(value.crypto, {
        head: value.head.head,
        headDigest: value.head.digest,
        recipient: {
          recipientHumanId: humanId(`human:recipient:${index}`),
          recipientKind: "device",
          recipientKeyId: `device-key:recipient:${index}:1`,
          recipientKeyGeneration: 1,
          recipientPublicKeyDigest: value.crypto.hash(recipient.publicKey),
          recipientPublicKey: recipient.publicKey,
        },
        domainKey: value.domainKey,
        issuerHumanId: humanId("human:alpha"),
        issuerDeviceId: cryptoDeviceId("device:alpha"),
        issuerDeviceSigningGeneration: 1,
        issuerSigningPublicKey: value.signer.publicKey,
        issuerSigningPrivateKey: value.signer.privateKey,
      });
      expect(prepared.bytes.length).toBeLessThan(2048);
      envelopeDigests.add(Buffer.from(prepared.digest).toString("hex"));
      recipient.publicKey.fill(0);
      recipient.privateKey.fill(0);
      destroyDomainKeyRecipientEnvelopeV2(prepared.envelope);
      prepared.bytes.fill(0);
      prepared.digest.fill(0);
    }

    expect(envelopeDigests.size).toBe(321);
    expect(decodeDomainKeyHeadV2(value.head.bytes).keyClass).toBe("ai");
  }, 30_000);
});

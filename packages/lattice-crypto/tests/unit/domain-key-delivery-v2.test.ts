import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2,
  DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2,
  DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
  destroyDomainKeyAccessRequestV2,
  destroyDomainKeyAcknowledgementV2,
  prepareDomainKeyAccessRequestV2,
  prepareDomainKeyAcknowledgementV2,
  verifyDomainKeyAccessRequestV2,
  verifyDomainKeyAcknowledgementV2,
} from "../../src/format/domain-key-delivery-v2.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NOW = 1_800_000_000_000;

function coordinates() {
  return {
    serverId: "server:alpha",
    humanId: humanId("human:beta"),
    deviceId: cryptoDeviceId("device:beta"),
    deviceSigningKeyGeneration: 2,
    cryptoDomainId: cryptoDomainId("domain:alpha-beta"),
    participantDigest: new Uint8Array(32).fill(0x31),
    participantCount: 500,
    keyClass: "human" as const,
    domainKeyGeneration: 3,
    authorizationRevision: authorizationRevision(4),
    headDigest: new Uint8Array(32).fill(0x32),
    recipientKeyId: "device-key:beta:2",
    recipientKeyGeneration: 2,
    recipientPublicKeyDigest: new Uint8Array(32).fill(0x33),
    issuedAt: unixTimestamp(NOW),
    expiresAt: unixTimestamp(NOW + 30_000),
  };
}

describe("M301 Domain key delivery V2", () => {
  test("authenticates a class-bound request and acknowledgement", () => {
    const crypto = new LatticeCrypto(seededRng(301_301));
    const signer = crypto.generateSigningKeyPair();
    const request = prepareDomainKeyAccessRequestV2(crypto, {
      formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2,
      requestId: "request:beta:human:3",
      ...coordinates(),
      signingPrivateKey: signer.privateKey,
    });
    const verifiedRequest = verifyDomainKeyAccessRequestV2(crypto, {
      bytes: request.bytes,
      signingPublicKey: signer.publicKey,
      now: NOW + 1,
    });
    expect(verifiedRequest?.participantCount).toBe(500);
    expect(verifiedRequest?.keyClass).toBe("human");

    const acknowledgement = prepareDomainKeyAcknowledgementV2(crypto, {
      formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_ACKNOWLEDGEMENT_PURPOSE_V2,
      acknowledgementId: "ack:beta:human:3",
      ...coordinates(),
      requestDigest: request.digest,
      envelopeDigest: new Uint8Array(32).fill(0x34),
      processedDeviceRevision: 9,
      signingPrivateKey: signer.privateKey,
    });
    const verifiedAcknowledgement = verifyDomainKeyAcknowledgementV2(crypto, {
      bytes: acknowledgement.bytes,
      signingPublicKey: signer.publicKey,
      now: NOW + 1,
    });
    expect(verifiedAcknowledgement?.requestDigest).toEqual(request.digest);
    expect(verifiedAcknowledgement?.processedDeviceRevision).toBe(9);
    expect(verifyDomainKeyAcknowledgementV2(crypto, {
      bytes: acknowledgement.bytes,
      signingPublicKey: signer.publicKey,
      now: NOW + 30_000,
    })).toBeNull();

    if (verifiedRequest) destroyDomainKeyAccessRequestV2(verifiedRequest);
    if (verifiedAcknowledgement) {
      destroyDomainKeyAcknowledgementV2(verifiedAcknowledgement);
    }
  });

  test("rejects class and signature substitution", () => {
    const crypto = new LatticeCrypto(seededRng(301_302));
    const signer = crypto.generateSigningKeyPair();
    const otherSigner = crypto.generateSigningKeyPair();
    const request = prepareDomainKeyAccessRequestV2(crypto, {
      formatVersion: DOMAIN_KEY_DELIVERY_FORMAT_VERSION_V2,
      purpose: DOMAIN_KEY_ACCESS_REQUEST_PURPOSE_V2,
      requestId: "request:beta:human:3",
      ...coordinates(),
      signingPrivateKey: signer.privateKey,
    });
    expect(verifyDomainKeyAccessRequestV2(crypto, {
      bytes: request.bytes,
      signingPublicKey: otherSigner.publicKey,
      now: NOW + 1,
    })).toBeNull();

    const changed = request.bytes.slice();
    const marker = new TextEncoder().encode("human");
    const index = changed.findIndex((_byte, offset) =>
      marker.every((expected, relative) => changed[offset + relative] === expected)
    );
    expect(index).toBeGreaterThanOrEqual(0);
    if (index < 0) throw new Error("class marker is missing");
    changed[index] = "a".charCodeAt(0);
    expect(verifyDomainKeyAccessRequestV2(crypto, {
      bytes: changed,
      signingPublicKey: signer.publicKey,
      now: NOW + 1,
    })).toBeNull();
    changed.fill(0);
  });
});

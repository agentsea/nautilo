import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  createSharedHumanDomainTrustAcceptanceV1,
  decodeSharedHumanDomainTrustAcceptanceV1,
  encodeSharedHumanDomainTrustAcceptanceV1,
  verifySharedHumanDomainTrustAcceptanceV1,
} from "../../src/delivery/shared-human-domain-trust.ts";

describe("shared Human Domain first-contact trust", () => {
  test("pins the complete canonical device inventory in signed bytes", () => {
    const crypto = new LatticeCrypto(seededRng(2_740));
    const alice = crypto.generateSigningKeyPair();
    const bob = crypto.generateSigningKeyPair();
    const created = createSharedHumanDomainTrustAcceptanceV1({
      crypto,
      domainId: "domain-shared-first-contact",
      domainEpoch: 2,
      participantDigest: new Uint8Array(32).fill(0x11),
      targetSubmissionDigest: new Uint8Array(32).fill(0x22),
      devices: [{
        humanId: "human-alice",
        deviceId: "device-alice",
        deviceGeneration: 1,
        signingPublicKey: alice.publicKey,
      }, {
        humanId: "human-bob",
        deviceId: "device-bob",
        deviceGeneration: 1,
        signingPublicKey: bob.publicKey,
      }],
      acceptedByHumanId: "human-alice",
      acceptedByDeviceId: "device-alice",
      acceptedAt: 10_000,
      acceptingSigningPrivateKey: alice.privateKey,
    });
    const bytes = encodeSharedHumanDomainTrustAcceptanceV1(
      created.acceptance,
    );
    const decoded = decodeSharedHumanDomainTrustAcceptanceV1(bytes);
    const verified = verifySharedHumanDomainTrustAcceptanceV1({
      crypto,
      acceptance: decoded,
      devices: created.devices,
    });
    try {
      expect(verified.devices.map(({ humanId, deviceId }) =>
        `${humanId}/${deviceId}`)).toEqual([
        "human-alice/device-alice",
        "human-bob/device-bob",
      ]);
      expect(encodeSharedHumanDomainTrustAcceptanceV1(decoded)).toEqual(bytes);
    } finally {
      bytes.fill(0);
      decoded.participantDigest.fill(0);
      decoded.targetSubmissionDigest.fill(0);
      decoded.deviceInventoryDigest.fill(0);
      decoded.signature.fill(0);
      created.acceptance.participantDigest.fill(0);
      created.acceptance.targetSubmissionDigest.fill(0);
      created.acceptance.deviceInventoryDigest.fill(0);
      created.acceptance.signature.fill(0);
      created.devices.forEach((entry) => entry.signingPublicKey.fill(0));
      verified.acceptance.participantDigest.fill(0);
      verified.acceptance.targetSubmissionDigest.fill(0);
      verified.acceptance.deviceInventoryDigest.fill(0);
      verified.acceptance.signature.fill(0);
      verified.devices.forEach((entry) => entry.signingPublicKey.fill(0));
      alice.privateKey.fill(0);
      bob.privateKey.fill(0);
    }
  });

  test("rejects a peer-key substitution", () => {
    const crypto = new LatticeCrypto(seededRng(2_741));
    const alice = crypto.generateSigningKeyPair();
    const bob = crypto.generateSigningKeyPair();
    const created = createSharedHumanDomainTrustAcceptanceV1({
      crypto,
      domainId: "domain-shared-key-substitution",
      domainEpoch: 1,
      participantDigest: new Uint8Array(32).fill(0x31),
      targetSubmissionDigest: new Uint8Array(32).fill(0x32),
      devices: [{
        humanId: "human-alice",
        deviceId: "device-alice",
        deviceGeneration: 1,
        signingPublicKey: alice.publicKey,
      }, {
        humanId: "human-bob",
        deviceId: "device-bob",
        deviceGeneration: 1,
        signingPublicKey: bob.publicKey,
      }],
      acceptedByHumanId: "human-alice",
      acceptedByDeviceId: "device-alice",
      acceptedAt: 10_000,
      acceptingSigningPrivateKey: alice.privateKey,
    });
    const substituted = created.devices.map((entry) => ({
      ...entry,
      signingPublicKey: entry.deviceId === "device-bob"
        ? new Uint8Array(32).fill(0x7f)
        : entry.signingPublicKey,
    }));
    try {
      expect(() => verifySharedHumanDomainTrustAcceptanceV1({
        crypto,
        acceptance: created.acceptance,
        devices: substituted,
      })).toThrow("not authentic");
    } finally {
      created.acceptance.participantDigest.fill(0);
      created.acceptance.targetSubmissionDigest.fill(0);
      created.acceptance.deviceInventoryDigest.fill(0);
      created.acceptance.signature.fill(0);
      created.devices.forEach((entry) => entry.signingPublicKey.fill(0));
      alice.privateKey.fill(0);
      bob.privateKey.fill(0);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  DEVICE_ADMISSION_CHALLENGE_TTL_MS,
  createDeviceAdmissionProof,
  deviceAdmissionSigningBytes,
  verifyDeviceAdmissionProof,
  type DeviceAdmissionChallenge,
} from "./device-admission.ts";

const crypto = new LatticeCrypto();
const signing = crypto.generateSigningKeyPair();

function challenge(): DeviceAdmissionChallenge {
  return Object.freeze({
    formatVersion: 1,
    challengeId: "admission-1",
    credentialDigest: crypto.hash(new TextEncoder().encode("credential")),
    userId: "11111111-1111-4111-8111-111111111111",
    humanActorId: "22222222-2222-4222-8222-222222222222",
    deviceId: "browser-device-1",
    deviceGeneration: 1,
    serverInstanceId: "33333333-3333-4333-8333-333333333333",
    lineageGeneration: 1,
    epoch: 3,
    securityRevision: 4,
    headDigest: crypto.hash(new TextEncoder().encode("head")),
    nonce: crypto.randomBytes(32),
    issuedAt: 1_000,
    expiresAt: 1_000 + DEVICE_ADMISSION_CHALLENGE_TTL_MS,
  });
}

describe("device admission", () => {
  test("signs and verifies canonical current-device coordinates", () => {
    const value = challenge();
    const proof = createDeviceAdmissionProof({
      crypto,
      challenge: value,
      signingPrivateKey: signing.privateKey,
    });
    expect(deviceAdmissionSigningBytes(value)).toEqual(
      deviceAdmissionSigningBytes(proof),
    );
    expect(verifyDeviceAdmissionProof({
      crypto,
      proof,
      signingPublicKey: signing.publicKey,
    })).toBe(true);
  });

  test("rejects coordinate substitution", () => {
    const proof = createDeviceAdmissionProof({
      crypto,
      challenge: challenge(),
      signingPrivateKey: signing.privateKey,
    });
    const changed = { ...proof, epoch: proof.epoch + 1 };
    expect(verifyDeviceAdmissionProof({
      crypto,
      proof: changed,
      signingPublicKey: signing.publicKey,
    })).toBe(false);
  });

  test("rejects challenge lifetimes beyond the enrollment precedent", () => {
    const value = challenge();
    expect(() => deviceAdmissionSigningBytes({
      ...value,
      expiresAt: value.expiresAt + 1,
    })).toThrow("lifetime");
  });
});

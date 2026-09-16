import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  assertDeviceDeliveryFetchProof,
  createDeviceDeliveryFetchProof,
  DEVICE_DELIVERY_FETCH_MAX_MESSAGES,
} from "../../src/index.ts";

describe("device delivery fetch proof", () => {
  test("signs one exact device revision, rollback anchor, and bounded page", () => {
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    const proof = createDeviceDeliveryFetchProof({
      crypto,
      requestId: "request_delivery_1",
      humanId: "human_alice",
      deviceId: "device_alice",
      expectedDeviceRevision: 4,
      minimumHighWatermark: 7,
      maximumMessages: 32,
      maximumPayloadBytes: 2_097_152,
      issuedAt: 10_000,
      expiresAt: 20_000,
      signingPrivateKey: signing.privateKey,
    });
    expect(() => assertDeviceDeliveryFetchProof(proof)).not.toThrow();
    expect(proof).toMatchObject({
      requestId: "request_delivery_1",
      expectedDeviceRevision: 4,
      minimumHighWatermark: 7,
      maximumMessages: 32,
    });
  });

  test("rejects unbounded pages and overlong proof lifetimes", () => {
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    const common = {
      crypto,
      requestId: "request_delivery_1",
      humanId: "human_alice",
      deviceId: "device_alice",
      expectedDeviceRevision: 4,
      minimumHighWatermark: 0,
      maximumMessages: 32,
      maximumPayloadBytes: 2_097_152,
      issuedAt: 10_000,
      expiresAt: 20_000,
      signingPrivateKey: signing.privateKey,
    };
    expect(() => createDeviceDeliveryFetchProof({
      ...common,
      maximumMessages: DEVICE_DELIVERY_FETCH_MAX_MESSAGES + 1,
    })).toThrow("bounds");
    expect(() => createDeviceDeliveryFetchProof({
      ...common,
      expiresAt: 400_001,
    })).toThrow("bounds");
  });
});

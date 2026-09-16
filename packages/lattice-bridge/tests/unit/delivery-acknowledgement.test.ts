import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";
import {
  createDeliveryAcknowledgementProof,
  verifyDeliveryAcknowledgementProof,
} from "../../src/index.ts";

describe("delivery acknowledgement proof", () => {
  test("binds one immutable message to its exact recipient and revision", () => {
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    const message = {
      messageId: "delivery_message_1",
      recipientDeviceId: "device_alice_pending",
      recipientSequence: 1,
      payloadHash: new Uint8Array(32).fill(0x31),
    };
    const proof = createDeliveryAcknowledgementProof({
      crypto,
      message,
      processedRevision: 1,
      acknowledgedAt: 20_000,
      signingPrivateKey: signing.privateKey,
    });
    expect(verifyDeliveryAcknowledgementProof({
      crypto,
      proof,
      message,
      resolveDevice: () => ({
        state: "pending",
        revision: 0,
        signingPublicKey: signing.publicKey,
      }),
    })).toMatchObject({
      messageId: "delivery_message_1",
      deviceId: "device_alice_pending",
      processedRevision: 1,
    });
  });

  test("rejects cross-device, payload, revision, and signature substitution", () => {
    const crypto = new LatticeCrypto();
    const signing = crypto.generateSigningKeyPair();
    const message = {
      messageId: "delivery_message_1",
      recipientDeviceId: "device_alice_pending",
      recipientSequence: 1,
      payloadHash: new Uint8Array(32).fill(0x31),
    };
    const proof = createDeliveryAcknowledgementProof({
      crypto,
      message,
      processedRevision: 1,
      acknowledgedAt: 20_000,
      signingPrivateKey: signing.privateKey,
    });
    const common = {
      crypto,
      proof,
      message,
      resolveDevice: () => ({
        state: "pending" as const,
        revision: 0,
        signingPublicKey: signing.publicKey,
      }),
    };
    expect(() => verifyDeliveryAcknowledgementProof({
      ...common,
      message: { ...message, recipientDeviceId: "device_bob" },
    })).toThrow("message");
    expect(() => verifyDeliveryAcknowledgementProof({
      ...common,
      message: {
        ...message,
        recipientSequence: 2,
      },
    })).toThrow("message");
    expect(() => verifyDeliveryAcknowledgementProof({
      ...common,
      message: {
        ...message,
        payloadHash: new Uint8Array(32).fill(0x99),
      },
    })).toThrow("message");
    expect(() => verifyDeliveryAcknowledgementProof({
      ...common,
      resolveDevice: () => ({
        state: "pending",
        revision: 1,
        signingPublicKey: signing.publicKey,
      }),
    })).toThrow("revision");
    expect(() => verifyDeliveryAcknowledgementProof({
      ...common,
      proof: { ...proof, signature: new Uint8Array(64).fill(0x99) },
    })).toThrow("signature");
  });
});

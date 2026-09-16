import { describe, expect, test } from "bun:test";

import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  authenticateClientDeviceProfile,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV2,
  type OpenedClientDeviceProfileV2,
  type RetainedClientNamespaceKeyringV2,
} from "../../src/client-vault/profile-v2.ts";

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to fail");
}

describe("client profile v2 bounded properties", () => {
  test("round-trips bounded Human+AI histories canonically and rejects widening", async () => {
    let marker = 1;
    const crypto = new LatticeCrypto({
      bytes: (length) => new Uint8Array(length).fill(marker++),
    });
    const signing = crypto.generateSigningKeyPair();
    const encryption = await crypto.generateEncryptionKeyPair();
    for (let iteration = 1; iteration <= 12; iteration += 1) {
      const keyrings: RetainedClientNamespaceKeyringV2[] = [];
      const revisions = iteration % 4 + 1;
      for (const keyClass of ["ai", "human"] as const) {
        for (let revision = 1; revision <= revisions; revision += 1) {
          keyrings.push(Object.freeze({
            deliverySequence: revision,
            operationId: `delivery_${keyClass}_${revision}`,
            namespaceId: "namespace_room",
            keyClass,
            domainId: "domain_room",
            domainEpoch: revision,
            accessRevision: revision,
            bindingHash: new Uint8Array(32).fill(iteration + revision),
            currentGeneration: revision,
            generations: Object.freeze([Object.freeze({
              generation: revision,
              key: new Uint8Array(32).fill(iteration + revision + 10),
            })]),
          }));
        }
      }
      const profile: OpenedClientDeviceProfileV2 = Object.freeze({
        formatVersion: 2,
        deviceId: "device_property",
        signingPublicKey: signing.publicKey,
        signingPrivateKey: signing.privateKey,
        encryptionPublicKey: encryption.publicKey,
        encryptionPrivateKey: encryption.privateKey,
        trustedDeviceRevision: iteration,
        trustedHostAuthorizationRevision: iteration + 1,
        deliveryHighWatermark: revisions,
        keyringDeliveries: Object.freeze(keyrings),
      });
      const bytes = encodeClientDeviceProfileV2(profile);
      const opened = await authenticateClientDeviceProfile({
        crypto,
        profileBytes: bytes,
        expectedDeviceId: profile.deviceId,
      });
      try {
        expect(opened.formatVersion).toBe(2);
        if (opened.formatVersion !== 2) throw new Error();
        expect(opened.keyringDeliveries.map((entry) =>
          `${entry.keyClass}:${entry.accessRevision}`
        )).toEqual(keyrings.map((entry) =>
          `${entry.keyClass}:${entry.accessRevision}`
        ));
        const reencoded = encodeClientDeviceProfileV2(opened);
        try {
          expect(reencoded).toEqual(bytes);
        } finally {
          reencoded.fill(0);
        }
      } finally {
        destroyOpenedClientDeviceProfile(opened);
      }
      const widened = new Uint8Array(bytes.length + 1);
      widened.set(bytes);
      expect(String(await captureError(() =>
        authenticateClientDeviceProfile({
          crypto,
          profileBytes: widened,
          expectedDeviceId: profile.deviceId,
        })
      ))).toContain("trailing");
      widened.fill(0);
      bytes.fill(0);
    }
  });
});

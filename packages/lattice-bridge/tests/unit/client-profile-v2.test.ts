import { describe, expect, test } from "bun:test";
import { LatticeCrypto } from "@nautilo/lattice-crypto";

import {
  authenticateClientDeviceProfile,
  createClientDeviceProfileV2Candidate,
  destroyOpenedClientDeviceProfile,
  encodeClientDeviceProfileV1,
  encodeClientDeviceProfileV2,
  replaceClientDeviceProfileWithV2,
} from "../../src/client-vault/profile-v2.ts";
import {
  MemoryClientProfileVault,
} from "../../src/testing/client-profile-vault.ts";

const COORDINATES = {
  serverScope: "https://crypto.example.test",
  userId: "10000000-0000-4000-8000-000000000001",
  humanActorId: "20000000-0000-4000-8000-000000000001",
  profileId: "profile_alice_browser",
  deviceId: "device_alice_browser",
  installationLineageDigest: "31".repeat(32),
} as const;

async function fixture() {
  let marker = 1;
  const crypto = new LatticeCrypto({
    bytes: (length) => new Uint8Array(length).fill(marker++),
  });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const v1 = encodeClientDeviceProfileV1({
    deviceId: COORDINATES.deviceId,
    signingPublicKey: signing.publicKey,
    signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
  });
  return { crypto, signing, encryption, v1 };
}

async function captureError(operation: () => Promise<unknown>): Promise<Error> {
  try {
    await operation();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to fail");
}

describe("versioned client device profile", () => {
  test("parses and authenticates the exact existing v1 device profile", async () => {
    const setup = await fixture();
    const opened = await authenticateClientDeviceProfile({
      crypto: setup.crypto,
      profileBytes: setup.v1,
      expectedDeviceId: COORDINATES.deviceId,
    });
    expect(opened.formatVersion).toBe(1);
    expect(opened.deviceId).toBe(COORDINATES.deviceId);
    expect(opened.signingPublicKey).toEqual(setup.signing.publicKey);
    expect(opened.encryptionPublicKey).toEqual(setup.encryption.publicKey);
    destroyOpenedClientDeviceProfile(opened);
    expect(opened.signingPrivateKey.every((byte) => byte === 0)).toBeTrue();
    expect(opened.encryptionPrivateKey.every((byte) => byte === 0)).toBeTrue();
  });

  test("rejects truncation, trailing bytes, another device, and mismatched keypairs", async () => {
    const setup = await fixture();
    expect(String(await captureError(() => authenticateClientDeviceProfile({
      crypto: setup.crypto,
      profileBytes: setup.v1.slice(0, -1),
      expectedDeviceId: COORDINATES.deviceId,
    })))).toContain("Client profile");
    expect(String(await captureError(() => authenticateClientDeviceProfile({
      crypto: setup.crypto,
      profileBytes: new Uint8Array([...setup.v1, 0]),
      expectedDeviceId: COORDINATES.deviceId,
    })))).toContain("trailing");
    expect(String(await captureError(() => authenticateClientDeviceProfile({
      crypto: setup.crypto,
      profileBytes: setup.v1,
      expectedDeviceId: "device_bob_browser",
    })))).toContain("device");

    const other = await fixture();
    const mismatched = encodeClientDeviceProfileV1({
      deviceId: COORDINATES.deviceId,
      signingPublicKey: setup.signing.publicKey,
      signingPrivateKey: other.signing.privateKey,
      encryptionPublicKey: setup.encryption.publicKey,
      encryptionPrivateKey: other.encryption.privateKey,
    });
    expect(String(await captureError(() => authenticateClientDeviceProfile({
      crypto: setup.crypto,
      profileBytes: mismatched,
      expectedDeviceId: COORDINATES.deviceId,
    })))).toContain("keypair");
  });

  test("constructs a complete empty v2 candidate without recovery material", async () => {
    const setup = await fixture();
    const candidate = await createClientDeviceProfileV2Candidate({
      crypto: setup.crypto,
      v1ProfileBytes: setup.v1,
      expectedDeviceId: COORDINATES.deviceId,
      trustedDeviceRevision: 4,
      trustedHostAuthorizationRevision: 9,
      deliveryHighWatermark: 12,
    });
    const bytes = encodeClientDeviceProfileV2(candidate);
    const reopened = await authenticateClientDeviceProfile({
      crypto: setup.crypto,
      profileBytes: bytes,
      expectedDeviceId: COORDINATES.deviceId,
    });
    expect(reopened).toMatchObject({
      formatVersion: 2,
      trustedDeviceRevision: 4,
      trustedHostAuthorizationRevision: 9,
      deliveryHighWatermark: 12,
      keyringDeliveries: [],
    });
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("mnemonic");
    expect(text).not.toContain("recovery");
    destroyOpenedClientDeviceProfile(candidate);
    destroyOpenedClientDeviceProfile(reopened);
    bytes.fill(0);
  });

  test("atomically replaces v1 through the vault stage/activate lifecycle", async () => {
    const setup = await fixture();
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({
      coordinates: COORDINATES,
      stageId: "initial_v1",
      generation: 1,
      profileBytes: setup.v1,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "aa".repeat(32),
      },
    });
    await vault.activateProfile(COORDINATES, "initial_v1");

    await replaceClientDeviceProfileWithV2({
      crypto: setup.crypto,
      vault,
      coordinates: COORDINATES,
      stageId: "migration_v2",
      generation: 2,
      publicState: {
        clientKind: "browser",
        publicFingerprint: "aa".repeat(32),
      },
      trustedDeviceRevision: 4,
      trustedHostAuthorizationRevision: 9,
      deliveryHighWatermark: 12,
    });

    await vault.withOpenProfile(COORDINATES, async (profileBytes) => {
      const opened = await authenticateClientDeviceProfile({
        crypto: setup.crypto,
        profileBytes,
        expectedDeviceId: COORDINATES.deviceId,
      });
      expect(opened.formatVersion).toBe(2);
      destroyOpenedClientDeviceProfile(opened);
    });
    expect(await vault.listPublicProfiles()).toMatchObject([{
      lifecycle: "active",
      generation: 2,
    }]);
  });

  test("leaves the active v1 readable when activation fails", async () => {
    const setup = await fixture();
    const backing = new MemoryClientProfileVault();
    await backing.unlock();
    await backing.stageProfile({
      coordinates: COORDINATES,
      stageId: "initial_v1",
      generation: 1,
      profileBytes: setup.v1,
      publicState: {
        clientKind: "electron",
        publicFingerprint: "bb".repeat(32),
      },
    });
    await backing.activateProfile(COORDINATES, "initial_v1");
    const vault = {
      availability: () => backing.availability(),
      unlock: () => backing.unlock(),
      lock: () => backing.lock(),
      stageProfile: (input: Parameters<typeof backing.stageProfile>[0]) =>
        backing.stageProfile(input),
      activateProfile: () => Promise.reject(new Error("quota failure")),
      abortStagedProfile: (
        ...input: Parameters<typeof backing.abortStagedProfile>
      ) => backing.abortStagedProfile(...input),
      recoverInterruptedActivation: (
        ...input: Parameters<typeof backing.recoverInterruptedActivation>
      ) => backing.recoverInterruptedActivation(...input),
      withOpenProfile: <T>(
        ...input: Parameters<typeof backing.withOpenProfile<T>>
      ) => backing.withOpenProfile<T>(...input),
      listPublicProfiles: () => backing.listPublicProfiles(),
      rotateWrappingMaterial: () => backing.rotateWrappingMaterial(),
      forgetProfile: (...input: Parameters<typeof backing.forgetProfile>) =>
        backing.forgetProfile(...input),
    };

    expect(String(await captureError(() => replaceClientDeviceProfileWithV2({
      crypto: setup.crypto,
      vault,
      coordinates: COORDINATES,
      stageId: "migration_v2",
      generation: 2,
      publicState: {
        clientKind: "electron",
        publicFingerprint: "bb".repeat(32),
      },
      trustedDeviceRevision: 4,
      trustedHostAuthorizationRevision: 9,
      deliveryHighWatermark: 12,
    })))).toContain("quota failure");
    await backing.withOpenProfile(COORDINATES, async (profileBytes) => {
      const opened = await authenticateClientDeviceProfile({
        crypto: setup.crypto,
        profileBytes,
        expectedDeviceId: COORDINATES.deviceId,
      });
      expect(opened.formatVersion).toBe(1);
      destroyOpenedClientDeviceProfile(opened);
    });
  });
});

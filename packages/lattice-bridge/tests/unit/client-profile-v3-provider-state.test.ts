import { describe, expect, test } from "bun:test";
import {
  DeviceProviderStateVault,
  LatticeCrypto,
  OpenMlsGroupProvider,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  accessRevision,
  objectId,
} from "@nautilo/lattice-crypto";

import {
  addClientDomainProviderSnapshot,
  authenticateClientDeviceProfileV3,
  createClientDeviceProfileV3Candidate,
  createClientProfileObjectAccessAnchorPort,
  destroyOpenedClientDeviceProfileV3,
  encodeClientDeviceProfileV3,
  withClientDomainRoots,
} from "../../src/client-vault/profile-v3.ts";
import {
  encodeClientDeviceProfileV2,
  encodeClientDeviceProfileV1,
  authenticateClientDeviceProfile,
  destroyOpenedClientDeviceProfile,
  type OpenedClientDeviceProfileV2,
} from "../../src/client-vault/profile-v2.ts";
import { MemoryClientProfileVault } from "../../src/testing/client-profile-vault.ts";

const DEVICE = "device_profile_v3_alice";
const DOMAIN = "domain_profile_v3_team";
const COORDINATES = {
  serverScope: "https://profile-v3.test",
  userId: "10000000-0000-4000-8000-000000000001",
  humanActorId: "20000000-0000-4000-8000-000000000001",
  profileId: "profile_v3_alice",
  deviceId: DEVICE, installationLineageDigest: "42".repeat(32),
} as const;

async function v2Fixture() {
  let marker = 1;
  const crypto = new LatticeCrypto({ bytes: (length) => new Uint8Array(length).fill(marker++) });
  const signing = crypto.generateSigningKeyPair();
  const encryption = await crypto.generateEncryptionKeyPair();
  const profile: OpenedClientDeviceProfileV2 = Object.freeze({
    formatVersion: 2, deviceId: DEVICE,
    signingPublicKey: signing.publicKey, signingPrivateKey: signing.privateKey,
    encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey,
    trustedDeviceRevision: 2, trustedHostAuthorizationRevision: 3,
    deliveryHighWatermark: 0, keyringDeliveries: Object.freeze([]),
  });
  return { crypto, bytes: encodeClientDeviceProfileV2(profile) };
}

describe("client profile v3 provider-state custody", () => {
  test("keeps the shipped v2 fixture byte-for-byte stable", async () => {
    const setup = await v2Fixture();
    const fixed = encodeClientDeviceProfileV2(Object.freeze({
      formatVersion: 2 as const, deviceId: DEVICE,
      signingPublicKey: new Uint8Array(32).fill(1),
      signingPrivateKey: new Uint8Array(32).fill(2),
      encryptionPublicKey: new Uint8Array(65).fill(3),
      encryptionPrivateKey: new Uint8Array(32).fill(4),
      trustedDeviceRevision: 2, trustedHostAuthorizationRevision: 3,
      deliveryHighWatermark: 0, keyringDeliveries: Object.freeze([]),
    }));
    expect(Buffer.from(setup.crypto.hash(fixed)).toString("hex"))
      .toBe("c18ae1c915842183557a4e43c781e59f6c687e46fc7e009fe916589a08ac3b27");
    const opened = await authenticateClientDeviceProfile({ crypto: setup.crypto,
      profileBytes: setup.bytes, expectedDeviceId: DEVICE });
    if (opened.formatVersion !== 2) throw new Error("test setup failed");
    const roundtrip = encodeClientDeviceProfileV2(opened);
    expect(roundtrip).toEqual(setup.bytes);
    const trailing = new Uint8Array(setup.bytes.length + 1);
    trailing.set(setup.bytes);
    expect(authenticateClientDeviceProfile({ crypto: setup.crypto,
      profileBytes: trailing, expectedDeviceId: DEVICE }))
      .rejects.toThrow("trailing bytes");
    fixed.fill(0); trailing.fill(0); roundtrip.fill(0);
    destroyOpenedClientDeviceProfile(opened);
    setup.bytes.fill(0);
  });

  test("fails closed when exact-access anchor custody still has a v2 profile", async () => {
    const setup = await v2Fixture();
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    await vault.stageProfile({ coordinates: COORDINATES, stageId: "v2", generation: 1,
      profileBytes: setup.bytes, publicState: {
        clientKind: "browser", publicFingerprint: "aa".repeat(32),
      } });
    await vault.activateProfile(COORDINATES, "v2");
    const anchors = createClientProfileObjectAccessAnchorPort({ crypto: setup.crypto,
      vault, coordinates: COORDINATES, createStageId: () => "must-not-stage" });
    expect(anchors.load("object_profile_v2")).rejects.toThrow(
      "Client profile v3 is unavailable",
    );
    expect((await vault.listPublicProfiles())[0]?.generation).toBe(1);
    setup.bytes.fill(0);
  });

  test("advances v3 anchors atomically while preserving provider snapshots", async () => {
    const setup = await v2Fixture();
    const profile = await createClientDeviceProfileV3Candidate({ crypto: setup.crypto,
      currentProfileBytes: setup.bytes, expectedDeviceId: DEVICE });
    const providerVault = DeviceProviderStateVault.fromKey(setup.crypto,
      cryptoDeviceId(DEVICE), profile.providerStateSealingKey);
    const provider = new OpenMlsGroupProvider(setup.crypto, providerVault);
    const active = await provider.createInitialState({ domainId: cryptoDomainId(DOMAIN),
      humanId: humanId("human_profile_v3_alice") });
    const head = provider.publicHead(active);
    const withSnapshot = await addClientDomainProviderSnapshot({ crypto: setup.crypto,
      profile, snapshot: active, expectedHead: head });
    const vault = new MemoryClientProfileVault();
    await vault.unlock();
    const profileBytes = encodeClientDeviceProfileV3(withSnapshot);
    await vault.stageProfile({ coordinates: COORDINATES, stageId: "initial",
      generation: 1, profileBytes, publicState: {
        clientKind: "browser", publicFingerprint: "aa".repeat(32),
      } });
    await vault.activateProfile(COORDINATES, "initial");
    const anchors = createClientProfileObjectAccessAnchorPort({ crypto: setup.crypto,
      vault, coordinates: COORDINATES, createStageId: () => "anchor_1" });
    const next = { objectId: objectId("object_profile_v3"),
      payloadHash: new Uint8Array(32).fill(1), accessRevision: accessRevision(0),
      manifestHash: new Uint8Array(32).fill(2) };
    expect(await anchors.advance({ expected: null, next })).toBeTrue();
    expect(await anchors.load(next.objectId)).toEqual(next);
    await vault.withOpenProfile(COORDINATES, async (bytes) => {
      const reopened = await authenticateClientDeviceProfileV3({ crypto: setup.crypto,
        profileBytes: bytes, expectedDeviceId: DEVICE });
      expect(reopened.activeProviderSnapshots).toHaveLength(1);
      await withClientDomainRoots({ crypto: setup.crypto, profile: reopened,
        expectedHead: head, operation: () => undefined });
      destroyOpenedClientDeviceProfileV3(reopened);
    });
    profileBytes.fill(0); providerVault.destroy(); active.ciphertext.fill(0);
    head.stateHash.fill(0); destroyOpenedClientDeviceProfileV3(withSnapshot);
    destroyOpenedClientDeviceProfileV3(profile); setup.bytes.fill(0);
  });

  test("migrates v1 through an empty v2 base without inventing provider state", async () => {
    const setup = await v2Fixture();
    const opened = await authenticateClientDeviceProfile({ crypto: setup.crypto,
      profileBytes: setup.bytes, expectedDeviceId: DEVICE });
    if (opened.formatVersion !== 2) throw new Error("test setup failed");
    const v1 = encodeClientDeviceProfileV1(opened);
    const migrated = await createClientDeviceProfileV3Candidate({ crypto: setup.crypto,
      currentProfileBytes: v1, expectedDeviceId: DEVICE, v1Migration: {
        trustedDeviceRevision: 4, trustedHostAuthorizationRevision: 5,
        deliveryHighWatermark: 0,
      } });
    expect(migrated.baseProfile.trustedDeviceRevision).toBe(4);
    expect(migrated.activeProviderSnapshots).toEqual([]);
    const v3Bytes = encodeClientDeviceProfileV3(migrated);
    expect(createClientDeviceProfileV3Candidate({ crypto: setup.crypto,
      currentProfileBytes: v3Bytes, expectedDeviceId: DEVICE }))
      .rejects.toThrow("already v3");
    destroyOpenedClientDeviceProfileV3(migrated);
    destroyOpenedClientDeviceProfile(opened);
    v3Bytes.fill(0); v1.fill(0); setup.bytes.fill(0);
  });

  test("migrates v2 empty, remains unavailable until delivery, then survives restart", async () => {
    const setup = await v2Fixture();
    const empty = await createClientDeviceProfileV3Candidate({
      crypto: setup.crypto, currentProfileBytes: setup.bytes, expectedDeviceId: DEVICE,
    });
    const impossibleHead = { providerId: "openmls-v2", domainId: cryptoDomainId(DOMAIN),
      epoch: domainEpoch(0), stateHash: new Uint8Array(32) };
    expect(withClientDomainRoots({ crypto: setup.crypto, profile: empty,
      expectedHead: impossibleHead, operation: () => undefined })).rejects.toThrow("unavailable");

    const localVault = DeviceProviderStateVault.fromKey(setup.crypto, cryptoDeviceId(DEVICE),
      empty.providerStateSealingKey);
    const provider = new OpenMlsGroupProvider(setup.crypto, localVault);
    const active = await provider.createInitialState({ domainId: cryptoDomainId(DOMAIN),
      humanId: humanId("human_profile_v3_alice") });
    const head = provider.publicHead(active);
    const expectedRoots = await provider.exportDomainRoots(active);
    const delivered = await addClientDomainProviderSnapshot({ crypto: setup.crypto,
      profile: empty, snapshot: active, expectedHead: head });
    const persisted = encodeClientDeviceProfileV3(delivered);
    const restarted = await authenticateClientDeviceProfileV3({ crypto: setup.crypto,
      profileBytes: persisted, expectedDeviceId: DEVICE });
    let escapedHuman: Uint8Array | undefined;
    const observed = await withClientDomainRoots({ crypto: setup.crypto, profile: restarted,
      expectedHead: head, operation: (roots) => {
        escapedHuman = roots.human;
        return { human: roots.human.slice(), ai: roots.ai.slice() };
      } });
    expect(observed.human.every((byte, index) => byte === expectedRoots.human[index])).toBeTrue();
    expect(observed.ai.every((byte, index) => byte === expectedRoots.ai[index])).toBeTrue();
    expect(escapedHuman!.every((byte) => byte === 0)).toBeTrue();

    const changedStateHash = head.stateHash.slice();
    changedStateHash[0] = changedStateHash[0]! ^ 1;
    const wrongHead = { ...head, stateHash: changedStateHash };
    expect(withClientDomainRoots({ crypto: setup.crypto, profile: restarted,
      expectedHead: wrongHead, operation: () => undefined })).rejects.toThrow("exact current head");
    const wrongDevice = { ...active, deviceId: cryptoDeviceId("device_profile_v3_other") };
    expect(addClientDomainProviderSnapshot({ crypto: setup.crypto, profile: empty,
      snapshot: wrongDevice, expectedHead: head })).rejects.toThrow("coordinates");
    expect(addClientDomainProviderSnapshot({ crypto: setup.crypto, profile: empty,
      snapshot: { ...active, domainId: cryptoDomainId("domain_profile_v3_wrong") },
      expectedHead: head })).rejects.toThrow("coordinates");
    expect(addClientDomainProviderSnapshot({ crypto: setup.crypto, profile: empty,
      snapshot: { ...active, revision: domainEpoch(Number(active.revision) + 1) },
      expectedHead: head })).rejects.toThrow("coordinates");

    expectedRoots.human.fill(0); expectedRoots.ai.fill(0); observed.human.fill(0); observed.ai.fill(0);
    active.ciphertext.fill(0); head.stateHash.fill(0); wrongHead.stateHash.fill(0);
    localVault.destroy(); persisted.fill(0); destroyOpenedClientDeviceProfileV3(restarted);
    destroyOpenedClientDeviceProfileV3(delivered);
    const ownedProviderKey = empty.providerStateSealingKey;
    destroyOpenedClientDeviceProfileV3(empty);
    expect(ownedProviderKey.every((byte) => byte === 0)).toBeTrue();
    setup.bytes.fill(0);
  });

  test("rejects same-epoch substitution before cryptographic opening", async () => {
    const setup = await v2Fixture();
    const profile = await createClientDeviceProfileV3Candidate({
      crypto: setup.crypto, currentProfileBytes: setup.bytes, expectedDeviceId: DEVICE,
    });
    const vault = DeviceProviderStateVault.fromKey(setup.crypto, cryptoDeviceId(DEVICE), profile.providerStateSealingKey);
    const provider = new OpenMlsGroupProvider(setup.crypto, vault);
    const active = await provider.createInitialState({ domainId: cryptoDomainId(DOMAIN),
      humanId: humanId("human_profile_v3_alice") });
    const head = provider.publicHead(active);
    const withSnapshot = await addClientDomainProviderSnapshot({ crypto: setup.crypto, profile,
      snapshot: active, expectedHead: head });
    const changedCiphertext = active.ciphertext.slice();
    changedCiphertext[0] = changedCiphertext[0]! ^ 1;
    const substituted = { ...active, ciphertext: changedCiphertext };
    expect(addClientDomainProviderSnapshot({ crypto: setup.crypto, profile: withSnapshot,
      snapshot: substituted, expectedHead: head })).rejects.toThrow("substitution");
    vault.destroy(); active.ciphertext.fill(0); substituted.ciphertext.fill(0); head.stateHash.fill(0);
    destroyOpenedClientDeviceProfileV3(withSnapshot);
    destroyOpenedClientDeviceProfileV3(profile); setup.bytes.fill(0);
  });
});

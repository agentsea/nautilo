import { describe, expect, test } from "bun:test";
import {
  DeviceStateVault,
  InMemoryRecoveryRelay,
  LATTICE_LIMITS,
  LatticeCrypto,
  deviceApprovalSigningBytes,
  epochSecretPackageSigningBytes,
  manualClock,
  parseRecoveryKit,
  recoveryArchiveSigningBytes,
  seededRng,
  serializeRecoveryKit,
  type EpochSecretPackage,
} from "../../src/testing/v1-compat.ts";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";
import { concat, fromHex, fromUtf8, toHex, utf8 } from "../../src/util/bytes.ts";

const OLD_EPOCH_PACKAGE_DOMAIN = fromHex(
  "6b656e746175726f732f6c6174746963652d63727970746f2f65706f63682d7365637265742d7061636b6167652f7631",
);
const OLD_DEVICE_APPROVAL_DOMAIN = fromHex(
  "6b656e746175726f732f6c6174746963652d63727970746f2f6465766963652d617070726f76616c2f7631",
);
const OLD_RECOVERY_ARCHIVE_DOMAIN = fromHex(
  "6b656e746175726f732f6c6174746963652d63727970746f2f7265636f766572792d617263686976652f7631",
);

function replaceLeadingDomain(
  canonical: Uint8Array,
  oldDomain: Uint8Array,
): Uint8Array {
  const canonicalLength = new DataView(
    canonical.buffer,
    canonical.byteOffset,
    canonical.byteLength,
  ).getUint32(0, false);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, oldDomain.length, false);
  return concat(length, oldDomain, canonical.slice(4 + canonicalLength));
}

describe("M3 device-local state and recovery formats", () => {
  test("epoch-secret package v1 has a stable canonical signing fixture", () => {
    const fixture: EpochSecretPackage = {
      formatVersion: 1,
      purpose: "recovery",
      id: "rootpkg_fixture",
      userId: "alice",
      namespaceId: "ns_room",
      epoch: 7,
      issuerDeviceId: "dev_phone",
      recipientId: "recovery_fixture",
      generation: 3,
      createdAt: 1_000,
      encryptedSecret: new Uint8Array([0x00, 0x01, 0xfe, 0xff]),
      signature: new Uint8Array(64).fill(0xaa),
    };
    expect(toHex(epochSecretPackageSigningBytes(fixture))).toBe(
      "0000002e6e617574696c6f2f6c6174746963652d63727970746f2f65706f63682d7365637265742d7061636b6167652f763100000001010000000f726f6f74706b675f6669787475726500000005616c696365000000076e735f726f6f6d0000000000000007000000096465765f70686f6e65000000107265636f766572795f66697874757265000000000000000300000000000003e8000000040001feff",
    );
  });

  test("device approval and recovery archive have stable canonical fixtures", () => {
    const nestedPackage: EpochSecretPackage = {
      formatVersion: 1,
      purpose: "recovery",
      id: "pkg",
      userId: "alice",
      namespaceId: "ns",
      epoch: 1,
      issuerDeviceId: "phone",
      recipientId: "kit",
      generation: 1,
      createdAt: 1_000,
      encryptedSecret: new Uint8Array([1, 2]),
      signature: new Uint8Array(64).fill(3),
    };
    expect(toHex(deviceApprovalSigningBytes({
      formatVersion: 1,
      userId: "alice",
      targetDeviceId: "laptop",
      issuerDeviceId: "phone",
      createdAt: 1_001,
      packages: [nestedPackage],
    }))).toBe(
      "000000296e617574696c6f2f6c6174746963652d63727970746f2f6465766963652d617070726f76616c2f76310000000100000005616c696365000000066c6170746f700000000570686f6e6500000000000003e900000001000000bf0000002e6e617574696c6f2f6c6174746963652d63727970746f2f65706f63682d7365637265742d7061636b6167652f7631000000010100000003706b6700000005616c696365000000026e7300000000000000010000000570686f6e65000000036b6974000000000000000100000000000003e80000000201020000004003030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303",
    );
    expect(toHex(recoveryArchiveSigningBytes({
      formatVersion: 1,
      userId: "alice",
      recoveryKeyId: "kit",
      generation: 1,
      issuerDeviceId: "phone",
      createdAt: 1_001,
      packages: [nestedPackage],
    }))).toBe(
      "0000002a6e617574696c6f2f6c6174746963652d63727970746f2f7265636f766572792d617263686976652f76310000000100000005616c696365000000036b697400000000000000010000000570686f6e6500000000000003e900000001000000bf0000002e6e617574696c6f2f6c6174746963652d63727970746f2f65706f63682d7365637265742d7061636b6167652f7631000000010100000003706b6700000005616c696365000000026e7300000000000000010000000570686f6e65000000036b6974000000000000000100000000000003e80000000201020000004003030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303030303",
    );
  });

  test("a recovery kit is deterministic, checksummed, and rejects corruption", async () => {
    const crypto = new LatticeCrypto(seededRng(91), manualClock(1_000));
    const kit = await crypto.createRecoveryKit();
    const encoded = serializeRecoveryKit(kit);

    expect(encoded).toHaveLength(102);
    expect(toHex(encoded)).toBe(
      "019e14e220c43f3479842698844137f422f86fadb611706be7cedf882f9f8690be04ee20ab8bad42a2fa5a9079477662f6b5b5355d92628ed302bb9ad3b69e25056edff828b81752dc87ec0a972570dd8367e7479b6b9877cbd665782ea2c94dac9c0e7376a3",
    );
    expect(await parseRecoveryKit(encoded, crypto)).toEqual(kit);
    expect(await parseRecoveryKit(
      fromHex(
        "019e14e220c43f3479842698844137f422f86fadb611706be7cedf882f9f8690be04ee20ab8bad42a2fa5a9079477662f6b5b5355d92628ed302bb9ad3b69e25056edff828b81752dc87ec0a972570dd8367e7479b6b9877cbd665782ea2c94dac9cbbfa57df",
      ),
      crypto,
    )).toBeNull();

    const corrupted = encoded.slice();
    corrupted[corrupted.length - 1] =
      (corrupted[corrupted.length - 1] ?? 0) ^ 1;
    expect(await parseRecoveryKit(corrupted, crypto)).toBeNull();
  });

  test("a device vault binds state to device, namespace, and monotonic revision", () => {
    const crypto = new LatticeCrypto(seededRng(92), manualClock(1_000));
    const vault = DeviceStateVault.create(crypto, "alice-phone");
    const snapshot = vault.seal("ns-room", 4, utf8("opaque OpenMLS state"));

    expect(fromUtf8(vault.open(snapshot, 4) ?? new Uint8Array())).toBe(
      "opaque OpenMLS state",
    );
    expect(vault.open(snapshot, 5)).toBeNull();
    expect(
      DeviceStateVault.fromKey(crypto, "alice-laptop", vault.exportLocalKey())
        .open(snapshot, 4),
    ).toBeNull();

    const tampered = {
      ...snapshot,
      namespaceId: "ns-other",
      ciphertext: snapshot.ciphertext.slice(),
    };
    expect(vault.open(tampered, 4)).toBeNull();
  });

  test("the public relay snapshot contains only public keys and opaque packages", async () => {
    const crypto = new LatticeCrypto(seededRng(93), manualClock(1_000));
    const kit = await crypto.createRecoveryKit();
    const relay = new InMemoryRecoveryRelay();

    await relay.publishRecoveryKey("alice", kit.keyId, kit.publicKey, 1);
    const snapshot = relay.snapshot();

    expect(snapshot).toEqual({
      recoveryKeys: [{
        userId: "alice",
        keyId: kit.keyId,
        publicKey: kit.publicKey,
        generation: 1,
      }],
      archives: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain(
      toHex(kit.secret),
    );
  });

  test("a real recovery archive remains opaque to the complete relay snapshot", async () => {
    const config = matrix[0];
    if (!config) throw new Error("expected a reference matrix row");
    const w = new World(config, 94);
    const alice = await w.device("alice");
    const namespaceId = await w.namespace(["alice"]);
    const kit = await w.engine.createRecoveryKit();
    const archive = await w.engine.createRecoveryArchive(
      w.deviceCapability(alice),
      kit,
      1,
    );
    const root = await w.group.exportEpochSecret(namespaceId, 0, alice);
    const relay = new InMemoryRecoveryRelay();
    await relay.publishRecoveryKey("alice", kit.keyId, kit.publicKey, 1);
    await relay.publishArchive(archive);

    const snapshot = relay.snapshot();
    const snapshotBytes = JSON.stringify(snapshot, (_key, value: unknown) =>
      value instanceof Uint8Array ? toHex(value) : value
    );
    expect(snapshotBytes).not.toContain(toHex(root));
    expect(snapshotBytes).not.toContain(toHex(kit.secret));

    const thiefKit = await w.engine.createRecoveryKit();
    const thiefKeys = await new LatticeCrypto(
      seededRng(95),
      manualClock(1_000),
    ).deriveEncryptionKeyPair(thiefKit.secret);
    expect(
      await new LatticeCrypto().openSealed(
        thiefKeys.privateKey,
        snapshot.archives[0]!.packages[0]!.encryptedSecret,
      ),
    ).toBeNull();

    const rotatedKit = await w.engine.createRecoveryKit();
    await relay.publishRecoveryKey(
      "alice",
      rotatedKit.keyId,
      rotatedKit.publicKey,
      2,
    );
    expect(await relay.getArchive("alice")).toBeNull();
    expect(relay.publishArchive(archive)).rejects.toThrow(
      "published recovery key",
    );
  });
});

for (const config of matrix) {
  describe(`M9 authorized history delivery — ${config.name}`, () => {
    test("account login alone leaves a second device pending and outside MLS", async () => {
      const w = new World(config);
      const first = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);

      const pending = await w.engine.registerDevice("alice");

      expect(pending.device.authorized).toBe(false);
      expect(w.group.roster(namespaceId).map((member) => member.deviceId)).toEqual([
        first,
      ]);
      expect(
        w.engine.encryptObject(
          namespaceId,
          utf8("must not encrypt"),
          pending.capability,
        ),
      ).rejects.toThrow("not authorized");
    });

    test("existing-device approval transfers every retained authorized epoch", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.device("bob");
      const namespaceId = await w.namespace(["alice", "bob"]);
      const historical = await w.encrypt(namespaceId, "historical", alice);

      await w.removeMember(namespaceId, "bob");
      const current = await w.encrypt(namespaceId, "current", alice);
      const pending = await w.engine.registerDevice("alice");
      const approval = await w.engine.approveDevice(
        pending.device.id,
        w.deviceCapability(alice),
      );

      await w.engine.acceptDeviceApproval(
        pending.device.id,
        pending.encryptionPrivateKey,
        approval,
      );

      const approved = await w.engine.listDevices("alice");
      expect(
        approved.find((device) => device.id === pending.device.id)?.authorized,
      ).toBe(true);
      expect(w.group.hasEpochSecret(namespaceId, 0, pending.device.id)).toBe(true);
      expect(w.group.hasEpochSecret(namespaceId, 1, pending.device.id)).toBe(true);

      const session = await w.engine.createDelegationSession();
      const grant = await w.engine.mintGrant({
        issuer: pending.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: { [namespaceId]: [0] },
      });
      const results = await w.engine.decryptMany(
        [historical, current],
        grant,
        session,
      );
      expect(results.map((result) =>
        result.ok ? fromUtf8(result.plaintext) : result.reason
      )).toEqual(["historical", "current"]);
    });

    test("an approval cannot be substituted, truncated, or replayed", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.namespace(["alice"]);
      const intended = await w.engine.registerDevice("alice");
      const other = await w.engine.registerDevice("alice");
      const approval = await w.engine.approveDevice(
        intended.device.id,
        w.deviceCapability(alice),
      );
      const issuerCapability = w.deviceCapability(alice);

      const oldDomainApproval = structuredClone(approval);
      oldDomainApproval.signature = new LatticeCrypto().sign(
        issuerCapability.signingPrivateKey,
        replaceLeadingDomain(
          deviceApprovalSigningBytes(oldDomainApproval),
          OLD_DEVICE_APPROVAL_DOMAIN,
        ),
      );
      expect(
        w.engine.acceptDeviceApproval(
          intended.device.id,
          intended.encryptionPrivateKey,
          oldDomainApproval,
        ),
      ).rejects.toThrow("signature");

      const oldDomainPackage = structuredClone(approval);
      const packageToResign = oldDomainPackage.packages[0];
      if (!packageToResign) throw new Error("expected a device package");
      packageToResign.signature = new LatticeCrypto().sign(
        issuerCapability.signingPrivateKey,
        replaceLeadingDomain(
          epochSecretPackageSigningBytes(packageToResign),
          OLD_EPOCH_PACKAGE_DOMAIN,
        ),
      );
      oldDomainPackage.signature = new LatticeCrypto().sign(
        issuerCapability.signingPrivateKey,
        deviceApprovalSigningBytes(oldDomainPackage),
      );
      expect(
        w.engine.acceptDeviceApproval(
          intended.device.id,
          intended.encryptionPrivateKey,
          oldDomainPackage,
        ),
      ).rejects.toThrow("package signature");

      expect(
        w.engine.acceptDeviceApproval(
          other.device.id,
          other.encryptionPrivateKey,
          approval,
        ),
      ).rejects.toThrow("metadata");

      const incomplete = structuredClone(approval);
      incomplete.packages = [];
      incomplete.signature = new LatticeCrypto().sign(
        issuerCapability.signingPrivateKey,
        deviceApprovalSigningBytes(incomplete),
      );
      expect(
        w.engine.acceptDeviceApproval(
          intended.device.id,
          intended.encryptionPrivateKey,
          incomplete,
        ),
      ).rejects.toThrow("complete retained history");

      await w.engine.acceptDeviceApproval(
        intended.device.id,
        intended.encryptionPrivateKey,
        approval,
      );
      expect(
        w.engine.acceptDeviceApproval(
          intended.device.id,
          intended.encryptionPrivateKey,
          approval,
        ),
      ).rejects.toThrow("not pending");
    });

    test("a newly invited user gets a fresh epoch but no pre-join history", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      const bob = await w.device("bob");
      const namespaceId = await w.namespace(["alice"]);
      const beforeJoin = await w.encrypt(namespaceId, "before join", alice);
      const oldGrant = await w.grantToAgent(alice, ["alice"]);

      await w.addMember(namespaceId, "bob");

      expect(await w.engine.currentEpoch(namespaceId)).toBe(1);
      expect(w.group.hasEpochSecret(namespaceId, 0, bob)).toBe(false);
      expect(w.group.hasEpochSecret(namespaceId, 1, bob)).toBe(true);
      expect(await w.agentRead(beforeJoin, oldGrant)).toEqual({
        ok: false,
        reason: "epoch_rotated",
      });

      const session = await w.engine.createDelegationSession();
      expect(
        w.engine.mintGrant({
          issuer: w.deviceCapability(bob),
          scope: ["bob"],
          recipientPublicKey: session.keyPair.publicKey,
          ttlMs: 60_000,
          historicalEpochs: { [namespaceId]: [0] },
        }),
      ).rejects.toThrow(`no retained secret for ${namespaceId}@0`);
    });

    test("a principal add rejects before mutation at the retained-history limit", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);
      const root = await w.group.exportEpochSecret(namespaceId, 0, alice);
      for (
        let epoch = 1;
        epoch < LATTICE_LIMITS.retainedEpochsPerDevice;
        epoch += 1
      ) {
        await w.group.importEpochSecret(namespaceId, epoch, alice, root);
      }

      expect(
        w.group.addDevicesAndRotate(namespaceId, [{
          deviceId: "bob-pending",
          userId: "bob",
        }]),
      ).rejects.toThrow("retained epoch limit");
      expect(w.group.currentEpoch(namespaceId)).toBe(0);
      expect(w.group.roster(namespaceId).map((member) => member.deviceId)).toEqual([
        alice,
      ]);
    });

    test("the recovery credential restores history to a fresh device after total device loss", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);
      const historical = await w.encrypt(namespaceId, "recover me", alice);
      const kit = await w.engine.createRecoveryKit();
      const archive = await w.engine.createRecoveryArchive(
        w.deviceCapability(alice),
        kit,
        1,
      );

      await w.engine.revokeDevice(alice);
      const pending = await w.engine.registerDevice("alice");
      expect(pending.device.authorized).toBe(false);

      await w.engine.recoverDevice(
        pending.device.id,
        pending.encryptionPrivateKey,
        kit,
        archive,
      );

      const currentEpoch = await w.engine.currentEpoch(namespaceId);
      expect(currentEpoch).toBe(1);
      expect(w.group.hasEpochSecret(namespaceId, 0, pending.device.id)).toBe(true);
      expect(w.group.hasEpochSecret(namespaceId, 1, pending.device.id)).toBe(true);

      const session = await w.engine.createDelegationSession();
      const grant = await w.engine.mintGrant({
        issuer: pending.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: { [namespaceId]: [0] },
      });
      const result = await w.engine.decryptObject(historical, grant, session);
      expect(result.ok && fromUtf8(result.plaintext)).toBe("recover me");
    });

    test("recovery combines archived history with a live committer's current root", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.device("bob");
      const namespaceId = await w.namespace(["alice", "bob"]);
      const historical = await w.encrypt(namespaceId, "old room history", alice);
      const kit = await w.engine.createRecoveryKit();
      const archive = await w.engine.createRecoveryArchive(
        w.deviceCapability(alice),
        kit,
        1,
      );

      // Revocation advances to epoch 1. Bob retains the new current root while
      // Alice's offline archive deliberately contains only epoch 0.
      await w.engine.revokeDevice(alice);
      const pending = await w.engine.registerDevice("alice");
      await w.engine.recoverDevice(
        pending.device.id,
        pending.encryptionPrivateKey,
        kit,
        archive,
      );

      expect(w.group.hasEpochSecret(namespaceId, 0, pending.device.id)).toBe(true);
      expect(w.group.hasEpochSecret(namespaceId, 1, pending.device.id)).toBe(true);
      const session = await w.engine.createDelegationSession();
      const grant = await w.engine.mintGrant({
        issuer: pending.capability,
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: { [namespaceId]: [0] },
      });
      const result = await w.engine.decryptObject(historical, grant, session);
      expect(result.ok && fromUtf8(result.plaintext)).toBe("old room history");
    });

    test("tampered or wrong recovery credentials cannot activate a device", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.namespace(["alice"]);
      const kit = await w.engine.createRecoveryKit();
      const wrongKit = await w.engine.createRecoveryKit();
      const archive = await w.engine.createRecoveryArchive(
        w.deviceCapability(alice),
        kit,
        1,
      );
      await w.engine.revokeDevice(alice);
      const pending = await w.engine.registerDevice("alice");
      const oldDomainArchive = structuredClone(archive);
      oldDomainArchive.signature = new LatticeCrypto().sign(
        w.deviceCapability(alice).signingPrivateKey,
        replaceLeadingDomain(
          recoveryArchiveSigningBytes(oldDomainArchive),
          OLD_RECOVERY_ARCHIVE_DOMAIN,
        ),
      );

      expect(
        w.engine.recoverDevice(
          pending.device.id,
          pending.encryptionPrivateKey,
          wrongKit,
          archive,
        ),
      ).rejects.toThrow("recovery key");
      expect(
        w.engine.recoverDevice(
          pending.device.id,
          pending.encryptionPrivateKey,
          kit,
          oldDomainArchive,
        ),
      ).rejects.toThrow("signature");

      const tampered = structuredClone(archive);
      const firstPackage = tampered.packages[0];
      if (!firstPackage) throw new Error("expected a recovery package");
      firstPackage.encryptedSecret[0] =
        (firstPackage.encryptedSecret[0] ?? 0) ^ 1;
      expect(
        w.engine.recoverDevice(
          pending.device.id,
          pending.encryptionPrivateKey,
          kit,
          tampered,
        ),
      ).rejects.toThrow("signature");
      expect(
        (await w.engine.listDevices("alice"))
          .find((device) => device.id === pending.device.id)?.authorized,
      ).toBe(false);
    });
  });
}

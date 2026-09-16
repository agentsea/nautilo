import { describe, expect, test } from "bun:test";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";

for (const config of matrix) {
  describe(`device-level group membership (H7): ${config.name}`, () => {
    test("two devices for one user occupy independent leaves", async () => {
      const w = new World(config);
      const first = await w.device("alice");
      const second = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);

      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: first, userId: "alice", leafIndex: 0 },
        { deviceId: second, userId: "alice", leafIndex: 1 },
      ]);
    });

    test("registering a device after namespace creation joins every applicable group", async () => {
      const w = new World(config);
      const first = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);
      const second = await w.device("alice");

      expect(w.group.roster(namespaceId).map((member) => member.deviceId)).toEqual([
        first,
        second,
      ]);
    });

    test("revoking one device removes only its leaf and rotates the namespace", async () => {
      const w = new World(config);
      const revoked = await w.device("alice");
      const remaining = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);
      const before = await w.engine.currentEpoch(namespaceId);

      await w.engine.revokeDevice(revoked);

      expect(await w.engine.currentEpoch(namespaceId)).toBe(before + 1);
      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: remaining, userId: "alice", leafIndex: 1 },
      ]);
      const revokedOutcome = await w.group
        .exporterSecret(namespaceId, before + 1, "lattice", revoked)
        .then(
          () => "resolved",
          (error: unknown) => String(error),
        );
      expect(revokedOutcome).toContain("not a current member");
      expect(
        await w.group.exporterSecret(
          namespaceId,
          before + 1,
          "lattice",
          remaining,
        ),
      ).toHaveLength(32);
    });

    test("remaining device continues at the rotated epoch and a replacement can join", async () => {
      const w = new World(config);
      const revoked = await w.device("alice");
      const remaining = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);
      const oldObject = await w.encrypt(namespaceId, "old", remaining);
      const oldGrant = await w.grantToAgent(remaining, ["alice"]);

      await w.engine.revokeDevice(revoked);
      expect(await w.agentRead(oldObject, oldGrant)).toEqual({
        ok: false,
        reason: "epoch_rotated",
      });

      const newObject = await w.encrypt(namespaceId, "new", remaining);
      const currentGrant = await w.grantToAgent(remaining, ["alice"]);
      expect(await w.agentRead(newObject, currentGrant)).toEqual({
        ok: true,
        text: "new",
      });

      const replacement = await w.device("alice");
      expect(w.group.roster(namespaceId).map((member) => member.deviceId)).toEqual([
        replacement,
        remaining,
      ]);
    });

    test("revoking the final device closes the group until a fresh device recovers it", async () => {
      const w = new World(config);
      const onlyDevice = await w.device("alice");
      const namespaceId = await w.namespace(["alice"]);
      const kit = await w.engine.createRecoveryKit();
      const archive = await w.engine.createRecoveryArchive(
        w.deviceCapability(onlyDevice),
        kit,
        1,
      );

      await w.engine.revokeDevice(onlyDevice);
      expect(await w.engine.currentEpoch(namespaceId)).toBe(1);
      expect(w.group.roster(namespaceId)).toEqual([]);

      const pending = await w.engine.registerDevice("alice");
      await w.engine.recoverDevice(
        pending.device.id,
        pending.encryptionPrivateKey,
        kit,
        archive,
      );
      const replacement = pending.device.id;
      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: replacement, userId: "alice", leafIndex: 0 },
      ]);
      expect(
        await w.group.exporterSecret(namespaceId, 1, "lattice", replacement),
      ).toHaveLength(32);
    });
  });
}

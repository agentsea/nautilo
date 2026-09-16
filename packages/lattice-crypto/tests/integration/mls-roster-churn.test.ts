import { describe, expect, test } from "bun:test";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";

for (const config of matrix) {
  describe(`authoritative MLS roster churn (H6): ${config.name}`, () => {
    test("remove -> add -> remove reuses and then clears the leftmost blank", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      const bob = await w.device("bob");
      const carol = await w.device("carol");
      const namespaceId = await w.namespace(["alice", "bob", "carol"]);

      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
        { deviceId: bob, userId: "bob", leafIndex: 1 },
        { deviceId: carol, userId: "carol", leafIndex: 2 },
      ]);

      await w.removeMember(namespaceId, "bob");
      const dave = await w.device("dave");
      await w.addMember(namespaceId, "dave");
      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
        { deviceId: dave, userId: "dave", leafIndex: 1 },
        { deviceId: carol, userId: "carol", leafIndex: 2 },
      ]);

      await w.removeMember(namespaceId, "dave");
      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
        { deviceId: carol, userId: "carol", leafIndex: 2 },
      ]);
    });

    test("remove -> add -> add -> remove never targets the wrong occupied leaf", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.device("bob");
      const carol = await w.device("carol");
      const namespaceId = await w.namespace(["alice", "bob", "carol"]);

      await w.removeMember(namespaceId, "bob");
      const dave = await w.device("dave");
      const erin = await w.device("erin");
      await w.addMember(namespaceId, "dave");
      await w.addMember(namespaceId, "erin");

      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
        { deviceId: dave, userId: "dave", leafIndex: 1 },
        { deviceId: carol, userId: "carol", leafIndex: 2 },
        { deviceId: erin, userId: "erin", leafIndex: 3 },
      ]);

      await w.removeMember(namespaceId, "erin");
      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
        { deviceId: dave, userId: "dave", leafIndex: 1 },
        { deviceId: carol, userId: "carol", leafIndex: 2 },
      ]);
    });

    test("repeated blank reuse and multi-remove preserve identity/index parity", async () => {
      const w = new World(config);
      const alice = await w.device("alice");
      await w.device("bob");
      const carol = await w.device("carol");
      const namespaceId = await w.namespace(["alice", "bob", "carol"]);

      await w.removeMember(namespaceId, "bob");
      await w.device("dave");
      await w.addMember(namespaceId, "dave");
      await w.removeMember(namespaceId, "dave");
      const erin = await w.device("erin");
      await w.addMember(namespaceId, "erin");

      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
        { deviceId: erin, userId: "erin", leafIndex: 1 },
        { deviceId: carol, userId: "carol", leafIndex: 2 },
      ]);

      await w.engine.removeParticipants(namespaceId, ["erin", "carol"]);
      expect(w.group.roster(namespaceId)).toEqual([
        { deviceId: alice, userId: "alice", leafIndex: 0 },
      ]);
    });
  });
}

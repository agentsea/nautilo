import { describe, expect, test } from "bun:test";
import { World } from "../../src/testing/world.ts";
import { matrix } from "../../src/testing/matrix.ts";

/**
 * Batch read/write path (`decryptMany` / `encryptMany`). These pin the batch
 * contract: results align 1:1 with the input, grant-level failures fail the
 * whole batch, per-object gates are evaluated element by element, and a
 * single-use grant is one use for the WHOLE batch. Runs across every matrix row.
 */
for (const config of matrix) {
  describe(`batch read/write: ${config.name}`, () => {
    test("decryptMany aligns results 1:1 (in-scope, out-of-scope, not-found)", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsB = await w.namespace(["bob"]);
      const oAB = await w.encrypt(nsAB, "ab");
      const oB = await w.encrypt(nsB, "b-only");
      const g = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentReadMany([oAB, oB, "obj_missing"], g)).toEqual([
        { ok: true, text: "ab" },
        { ok: false, reason: "out_of_scope" },
        { ok: false, reason: "object_not_found" },
      ]);
    });

    test("decryptMany matches a decryptObject loop for a reusable grant (parity)", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");
      const nsA = await w.namespace(["alice"]);
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsBC = await w.namespace(["bob", "carol"]);
      const ids = [
        await w.encrypt(nsA, "a"),
        await w.encrypt(nsAB, "ab"),
        await w.encrypt(nsBC, "bc"),
      ];

      const gLoop = await w.grantToAgent(devA, ["alice"]);
      const looped = [];
      for (const id of ids) looped.push(await w.agentRead(id, gLoop));

      const gBatch = await w.grantToAgent(devA, ["alice"]);
      expect(await w.agentReadMany(ids, gBatch)).toEqual(looped);
    });

    test("encryptMany writes several objects that the agent reads back", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsA = await w.namespace(["alice"]);
      const nsAB = await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      const writes = await w.agentWriteMany(
        [
          { namespaceId: nsA, text: "m1" },
          { namespaceId: nsAB, text: "m2" },
        ],
        g,
      );
      expect(writes.every((r) => r.ok)).toBe(true);
      const ids = writes.map((r) => (r.ok ? r.id : ""));
      expect(await w.agentReadMany(ids, g)).toEqual([
        { ok: true, text: "m1" },
        { ok: true, text: "m2" },
      ]);
    });

    test("encryptMany reports per-item out-of-scope without failing the batch", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsB = await w.namespace(["bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      const writes = await w.agentWriteMany(
        [
          { namespaceId: nsAB, text: "ok" },
          { namespaceId: nsB, text: "nope" },
        ],
        g,
      );
      expect(writes[0]!.ok).toBe(true);
      expect(writes[1]).toEqual({ ok: false, reason: "out_of_scope" });
    });

    test("a grant-level failure (expiry) fails the WHOLE decryptMany batch", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsA = await w.namespace(["alice"]);
      const o1 = await w.encrypt(nsAB, "one");
      const o2 = await w.encrypt(nsA, "two");
      const g = await w.grantToAgent(devA, ["alice"], 1_000);

      w.advanceClock(2_000);
      expect(await w.agentReadMany([o1, o2], g)).toEqual([
        { ok: false, reason: "grant_expired" },
        { ok: false, reason: "grant_expired" },
      ]);
    });

    test("a foreign session fails the whole decryptMany batch with grant_open_failed", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const o = await w.encrypt(ns, "secret");
      const g = await w.grantToAgent(devA, ["alice"]);
      const impostor = await w.engine.createDelegationSession();

      expect(await w.agentReadMany([o], { grant: g.grant, session: impostor })).toEqual([
        { ok: false, reason: "grant_open_failed" },
      ]);
    });

    test("a decrypt-only grant fails the whole encryptMany batch with operation_not_permitted", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(devA, ["alice"], 2 * 60 * 60 * 1000, false, ["decrypt"]);

      expect(await w.agentWriteMany([{ namespaceId: nsAB, text: "x" }], g)).toEqual([
        { ok: false, reason: "operation_not_permitted" },
      ]);
    });

    test("a single-use grant is consumed ONCE for a whole batch; a second batch is denied", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsAC = await w.namespace(["alice", "carol"]);
      const oAB = await w.encrypt(nsAB, "ab");
      const oAC = await w.encrypt(nsAC, "ac");
      const g = await w.grantToAgent(devA, ["alice"], 60_000, true);

      expect(await w.agentReadMany([oAB, oAC], g)).toEqual([
        { ok: true, text: "ab" },
        { ok: true, text: "ac" },
      ]);
      expect(await w.agentReadMany([oAB, oAC], g)).toEqual([
        { ok: false, reason: "grant_consumed" },
        { ok: false, reason: "grant_consumed" },
      ]);
    });

    test("epoch rotation shows per-object epoch_rotated in a mixed batch", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsA = await w.namespace(["alice"]);
      const oAB = await w.encrypt(nsAB, "ab");
      const oA = await w.encrypt(nsA, "a");
      const g = await w.grantToAgent(devA, ["alice"]);

      await w.removeMember(nsAB, "bob"); // rotates nsAB only

      expect(await w.agentReadMany([oAB, oA], g)).toEqual([
        { ok: false, reason: "epoch_rotated" },
        { ok: true, text: "a" },
      ]);
    });
  });
}

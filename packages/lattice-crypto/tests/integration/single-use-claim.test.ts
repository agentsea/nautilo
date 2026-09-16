import { describe, expect, test } from "bun:test";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";

/**
 * Single-use policy: possession + request preflight happen before the atomic
 * claim. Empty or entirely ineligible batches do not claim. Once at least one
 * eligible operation is claimed, later crypto failure still spends the grant.
 */
for (const config of matrix) {
  describe(`single-use claim ordering: ${config.name}`, () => {
    test("a foreign session cannot burn a legitimate recipient's read", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "recipient-only");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);
      const impostor = await w.engine.createDelegationSession();

      expect(
        await w.agentRead(objectId, { grant: g.grant, session: impostor }),
      ).toEqual({ ok: false, reason: "grant_open_failed" });
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: true,
        text: "recipient-only",
      });
    });

    test("a foreign session cannot burn a legitimate recipient's write", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);
      const impostor = await w.engine.createDelegationSession();

      expect(
        await w.agentWrite(ns, "impostor", {
          grant: g.grant,
          session: impostor,
        }),
      ).toEqual({ ok: false, reason: "grant_open_failed" });
      expect((await w.agentWrite(ns, "legitimate", g)).ok).toBe(true);
    });

    test("a foreign session cannot burn a legitimate recipient's read batch", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "batch-recipient");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);
      const impostor = await w.engine.createDelegationSession();

      expect(
        await w.agentReadMany([objectId], {
          grant: g.grant,
          session: impostor,
        }),
      ).toEqual([{ ok: false, reason: "grant_open_failed" }]);
      expect(await w.agentReadMany([objectId], g)).toEqual([
        { ok: true, text: "batch-recipient" },
      ]);
    });

    test("a foreign session cannot burn a legitimate recipient's write batch", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);
      const impostor = await w.engine.createDelegationSession();

      expect(
        await w.agentWriteMany(
          [{ namespaceId: ns, text: "impostor" }],
          { grant: g.grant, session: impostor },
        ),
      ).toEqual([{ ok: false, reason: "grant_open_failed" }]);
      expect(
        (await w.agentWriteMany([{ namespaceId: ns, text: "legitimate" }], g))[0]
          ?.ok,
      ).toBe(true);
    });

    test("empty batches do not consume a single-use grant", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "after-empty");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      expect(await w.agentReadMany([], g)).toEqual([]);
      expect(await w.agentWriteMany([], g)).toEqual([]);
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: true,
        text: "after-empty",
      });
    });

    test("an entirely ineligible read batch does not consume", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "after-miss");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      expect(await w.agentReadMany(["obj_missing"], g)).toEqual([
        { ok: false, reason: "object_not_found" },
      ]);
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: true,
        text: "after-miss",
      });
    });

    test("an ineligible batch still proves possession without consuming", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "after-foreign-miss");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);
      const impostor = await w.engine.createDelegationSession();

      expect(
        await w.agentReadMany(["obj_missing"], {
          grant: g.grant,
          session: impostor,
        }),
      ).toEqual([{ ok: false, reason: "grant_open_failed" }]);
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: true,
        text: "after-foreign-miss",
      });
    });

    test("an entirely ineligible write batch does not consume", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const nsAlice = await w.namespace(["alice"]);
      const nsBob = await w.namespace(["bob"]);
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      expect(
        await w.agentWriteMany([{ namespaceId: nsBob, text: "out-of-scope" }], g),
      ).toEqual([{ ok: false, reason: "out_of_scope" }]);
      expect((await w.agentWrite(nsAlice, "eligible", g)).ok).toBe(true);
    });

    test("a mixed read batch consumes once when at least one item is eligible", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "eligible-read");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      expect(await w.agentReadMany([objectId, "obj_missing"], g)).toEqual([
        { ok: true, text: "eligible-read" },
        { ok: false, reason: "object_not_found" },
      ]);
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: false,
        reason: "grant_consumed",
      });
    });

    test("a mixed write batch consumes once when at least one item is eligible", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const nsAlice = await w.namespace(["alice"]);
      const nsBob = await w.namespace(["bob"]);
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      const results = await w.agentWriteMany(
        [
          { namespaceId: nsAlice, text: "eligible-write" },
          { namespaceId: nsBob, text: "out-of-scope" },
        ],
        g,
      );
      expect(results[0]?.ok).toBe(true);
      expect(results[1]).toEqual({ ok: false, reason: "out_of_scope" });
      expect(await w.agentWrite(nsAlice, "replay", g)).toEqual({
        ok: false,
        reason: "grant_consumed",
      });
    });

    test("crypto failure after an authorized claim still spends the grant", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "tamper-after-preflight");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      const stored = (await w.store.getObject(objectId))!;
      stored.ciphertext[0] = (stored.ciphertext[0] ?? 0) ^ 0xff;
      await w.store.putObject(stored);

      expect(await w.agentRead(objectId, g)).toEqual({
        ok: false,
        reason: "decrypt_failed",
      });
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: false,
        reason: "grant_consumed",
      });
    });

    test("concurrent authorized attempts have exactly one winner", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "one-winner");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      const outcomes = await Promise.all([
        w.agentRead(objectId, g),
        w.agentRead(objectId, g),
      ]);
      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(
        outcomes.filter(
          (outcome) => !outcome.ok && outcome.reason === "grant_consumed",
        ),
      ).toHaveLength(1);
    });
  });
}

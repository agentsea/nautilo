import { describe, expect, test } from "bun:test";
import { World, type WorldConfig } from "../testing/world.ts";

/**
 * Scheme/provider-agnostic conformance suite. Given any `WorldConfig`, it
 * asserts the security properties that must hold for EVERY combination of
 * group provider x lattice scheme. Call it once per matrix row.
 *
 * These properties are the interchangeability contract. Note: human<->human
 * MLS forward-secrecy / per-member key isolation is NOT asserted here — those
 * require real MLS and arrive with the ts-mls provider in M1.
 */
export function defineConformanceTests(config: WorldConfig): void {
  describe(`conformance: ${config.name}`, () => {
    test("subset scope decrypts every superset namespace", async () => {
      const w = new World(config);
      const a = await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device(a);

      const nsAB = await w.namespace(["alice", "bob"]);
      const nsABC = await w.namespace(["alice", "bob", "carol"]);
      const nsB = await w.namespace(["bob"]);

      const oAB = await w.encrypt(nsAB, "ab-secret");
      const oABC = await w.encrypt(nsABC, "abc-secret");
      const oB = await w.encrypt(nsB, "b-only");

      // scope {alice}: subset of {a,b} and {a,b,c}, NOT of {b}.
      const g = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentRead(oAB, g)).toEqual({ ok: true, text: "ab-secret" });
      expect(await w.agentRead(oABC, g)).toEqual({ ok: true, text: "abc-secret" });
      expect(await w.agentRead(oB, g)).toEqual({ ok: false, reason: "out_of_scope" });
    });

    test("multi-user scope only covers exact supersets", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");

      const nsA = await w.namespace(["alice"]);
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsABC = await w.namespace(["alice", "bob", "carol"]);

      const oA = await w.encrypt(nsA, "a");
      const oAB = await w.encrypt(nsAB, "ab");
      const oABC = await w.encrypt(nsABC, "abc");

      // scope {alice,bob}: subset of {a,b} and {a,b,c}, NOT of {a}.
      const g = await w.grantToAgent(devA, ["alice", "bob"]);

      expect(await w.agentRead(oA, g)).toEqual({ ok: false, reason: "out_of_scope" });
      expect(await w.agentRead(oAB, g)).toEqual({ ok: true, text: "ab" });
      expect(await w.agentRead(oABC, g)).toEqual({ ok: true, text: "abc" });
    });

    test("epoch rotation (member removal) invalidates existing grants", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");

      const nsAB = await w.namespace(["alice", "bob"]);
      const o = await w.encrypt(nsAB, "before-removal");
      const g = await w.grantToAgent(devA, ["alice"]);
      expect(await w.agentRead(o, g)).toEqual({ ok: true, text: "before-removal" });

      await w.removeMember(nsAB, "bob"); // epoch bumps

      expect(await w.agentRead(o, g)).toEqual({ ok: false, reason: "epoch_rotated" });
    });

    test("adding a new user rotates the epoch without destroying retained history", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");

      const nsAB = await w.namespace(["alice", "bob"]);
      const o = await w.encrypt(nsAB, "pre-join history");
      const oldGrant = await w.grantToAgent(devA, ["alice"]);

      await w.addMember(nsAB, "carol");

      expect(await w.agentRead(o, oldGrant)).toEqual({
        ok: false,
        reason: "epoch_rotated",
      });
      const session = await w.engine.createDelegationSession();
      const historyGrant = await w.engine.mintGrant({
        issuer: w.deviceCapability(devA),
        scope: ["alice"],
        recipientPublicKey: session.keyPair.publicKey,
        ttlMs: 60_000,
        historicalEpochs: { [nsAB]: [0] },
      });
      expect(await w.engine.decryptObject(o, historyGrant, session)).toMatchObject({
        ok: true,
      });
    });

    test("grant expiry denies decryption", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const o = await w.encrypt(ns, "time-bound");

      const g = await w.grantToAgent(devA, ["alice"], 1_000);
      expect(await w.agentRead(o, g)).toEqual({ ok: true, text: "time-bound" });

      w.advanceClock(2_000);
      expect(await w.agentRead(o, g)).toEqual({ ok: false, reason: "grant_expired" });
    });

    test("grant secret is sealed: a foreign session cannot open it", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const o = await w.encrypt(ns, "sealed");

      const good = await w.grantToAgent(devA, ["alice"]);
      const impostor = await w.engine.createDelegationSession();
      // Same grant, wrong private key.
      const forged = { grant: good.grant, session: impostor };
      expect(await w.agentRead(o, forged)).toEqual({ ok: false, reason: "grant_open_failed" });
    });

    test("revoking the issuing device invalidates its grants", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const o = await w.encrypt(ns, "revoke-me");
      const g = await w.grantToAgent(devA, ["alice"]);
      expect(await w.agentRead(o, g)).toEqual({ ok: true, text: "revoke-me" });

      await w.engine.revokeDevice(devA);
      expect(await w.agentRead(o, g)).toEqual({ ok: false, reason: "grant_device_revoked" });
    });

    test("agent writes into an in-scope namespace under its grant, then reads it back", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      // scope {alice} ⊆ {alice,bob}: the agent may author here.
      const g = await w.grantToAgent(devA, ["alice"]);

      const write = await w.agentWrite(nsAB, "agent-memo", g);
      expect(write.ok).toBe(true);
      if (write.ok) {
        expect(await w.agentRead(write.id, g)).toEqual({ ok: true, text: "agent-memo" });
      }
    });

    test("agent cannot write into an out-of-scope namespace", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsB = await w.namespace(["bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentWrite(nsB, "nope", g)).toEqual({ ok: false, reason: "out_of_scope" });
    });

    test("agent cannot write with a grant whose epoch has rotated", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      await w.removeMember(nsAB, "bob"); // epoch bumps → grant is stale for writes too

      expect(await w.agentWrite(nsAB, "stale", g)).toEqual({ ok: false, reason: "epoch_rotated" });
    });

    test("single-use grant consumes atomically", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      await w.namespace(["alice"]);
      const g = await w.grantToAgent(devA, ["alice"], 60_000, true);

      const first = await w.engine.consumeGrant(g.grant.id);
      const second = await w.engine.consumeGrant(g.grant.id);
      expect(first?.id).toBe(g.grant.id);
      expect(second).toBeNull();
    });

    test("one grant reaches every current superset namespace for both read and write", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");

      const nsA = await w.namespace(["alice"]);
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsABC = await w.namespace(["alice", "bob", "carol"]);
      const nsB = await w.namespace(["bob"]);

      const oA = await w.encrypt(nsA, "a-secret");
      const oAB = await w.encrypt(nsAB, "ab-secret");
      const oABC = await w.encrypt(nsABC, "abc-secret");
      const oB = await w.encrypt(nsB, "b-only");

      const g = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentRead(oA, g)).toEqual({ ok: true, text: "a-secret" });
      expect(await w.agentRead(oAB, g)).toEqual({ ok: true, text: "ab-secret" });
      expect(await w.agentRead(oABC, g)).toEqual({ ok: true, text: "abc-secret" });

      expect((await w.agentWrite(nsA, "write-a", g)).ok).toBe(true);
      expect((await w.agentWrite(nsAB, "write-ab", g)).ok).toBe(true);
      expect((await w.agentWrite(nsABC, "write-abc", g)).ok).toBe(true);

      expect(await w.agentRead(oB, g)).toEqual({ ok: false, reason: "out_of_scope" });
      expect(await w.agentWrite(nsB, "nope", g)).toEqual({ ok: false, reason: "out_of_scope" });
    });

    test("a namespace created after the grant is minted is out of scope (coveredEpochs snapshot)", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");

      // nsAB exists at mint time so the grant covers something; the point of
      // the test is that nsABC (created AFTER) is not covered.
      await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      const nsABC = await w.namespace(["alice", "bob", "carol"]);
      const objLate = await w.encrypt(nsABC, "late");

      expect(await w.agentRead(objLate, g)).toEqual({ ok: false, reason: "out_of_scope" });
      expect(await w.agentWrite(nsABC, "late-write", g)).toEqual({ ok: false, reason: "out_of_scope" });
    });

    test("grant is valid exactly at the expiry boundary and denied one tick later (read and write)", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");

      const ns = await w.namespace(["alice", "bob"]);
      const obj = await w.encrypt(ns, "boundary");
      const g = await w.grantToAgent(devA, ["alice"], 1_000);

      w.advanceClock(1_000);
      expect(await w.agentRead(obj, g)).toEqual({ ok: true, text: "boundary" });

      w.advanceClock(1);
      expect(await w.agentRead(obj, g)).toEqual({ ok: false, reason: "grant_expired" });
      expect(await w.agentWrite(ns, "x", g)).toEqual({ ok: false, reason: "grant_expired" });
    });

    test("the write path denies a revoked issuing device", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");

      const ns = await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      await w.engine.revokeDevice(devA);
      expect(await w.agentWrite(ns, "x", g)).toEqual({ ok: false, reason: "grant_device_revoked" });
    });

    test("the write path denies a foreign delegation session", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");

      const ns = await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(devA, ["alice"]);
      const impostor = await w.engine.createDelegationSession();

      expect(await w.agentWrite(ns, "x", { grant: g.grant, session: impostor })).toEqual({
        ok: false,
        reason: "grant_open_failed",
      });
    });

    test("a decrypt-only grant cannot write but can read", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");

      const ns = await w.namespace(["alice", "bob"]);
      const obj = await w.encrypt(ns, "ro");
      const g = await w.grantToAgent(devA, ["alice"], 2 * 60 * 60 * 1000, false, ["decrypt"]);

      expect(await w.agentWrite(ns, "x", g)).toEqual({ ok: false, reason: "operation_not_permitted" });
      expect(await w.agentRead(obj, g)).toEqual({ ok: true, text: "ro" });
    });

    test("an encrypt-only grant cannot read but can write", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");

      const ns = await w.namespace(["alice", "bob"]);
      const obj = await w.encrypt(ns, "wo");
      const g = await w.grantToAgent(devA, ["alice"], 2 * 60 * 60 * 1000, false, ["encrypt"]);

      expect(await w.agentRead(obj, g)).toEqual({ ok: false, reason: "operation_not_permitted" });
      const write = await w.agentWrite(ns, "x", g);
      expect(write.ok).toBe(true);
    });
  });
}

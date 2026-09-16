import { describe, expect, test } from "bun:test";
import { World } from "../../src/testing/world.ts";
import { matrix } from "../../src/testing/matrix.ts";
import { canonicalizeParticipants, isSubset } from "../../src/util/sets.ts";

/** Deterministic PRNG for property fuzz (mulberry32). */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USERS = ["u1", "u2", "u3", "u4", "u5"] as const;

function randomNonEmptySubset(rng: () => number): string[] {
  for (;;) {
    const picks: string[] = [];
    for (const u of USERS) {
      if (rng() < 0.5) picks.push(u);
    }
    if (picks.length > 0) return canonicalizeParticipants(picks);
  }
}

for (const config of matrix) {
  describe(`read/write battery: ${config.name}`, () => {
    test("sequential removals rotate the epoch and kill an epoch-0 grant", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");
      const family = await w.namespace(["alice", "bob", "carol"]);
      const o0 = await w.encrypt(family, "e0");
      const g0 = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentRead(o0, g0)).toEqual({ ok: true, text: "e0" });
      expect(await w.engine.currentEpoch(family)).toBe(0);

      await w.removeMember(family, "bob");
      expect(await w.engine.currentEpoch(family)).toBe(1);
      expect(await w.agentRead(o0, g0)).toEqual({ ok: false, reason: "epoch_rotated" });

      await w.removeMember(family, "carol");
      expect(await w.engine.currentEpoch(family)).toBe(2);
    });

    test("an object sealed at an old epoch is epoch_mismatch for a grant re-minted at the new epoch", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");
      const family = await w.namespace(["alice", "bob", "carol"]);
      const old = await w.encrypt(family, "old@0");

      await w.removeMember(family, "carol");
      const fresh = await w.encrypt(family, "fresh@1");
      const g1 = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentRead(fresh, g1)).toEqual({ ok: true, text: "fresh@1" });
      expect(await w.agentRead(old, g1)).toEqual({ ok: false, reason: "epoch_mismatch" });
    });

    test("a single-use grant is one use TOTAL across multiple covered namespaces (read then read)", async () => {
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

      expect(await w.agentRead(oAB, g)).toEqual({ ok: true, text: "ab" });
      expect(await w.agentRead(oAC, g)).toEqual({ ok: false, reason: "grant_consumed" });
    });

    test("a single-use grant is one use TOTAL across namespaces (read then write)", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      await w.user("carol");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const nsAC = await w.namespace(["alice", "carol"]);
      const oAB = await w.encrypt(nsAB, "ab");
      await w.encrypt(nsAC, "ac");
      const g = await w.grantToAgent(devA, ["alice"], 60_000, true);

      expect(await w.agentRead(oAB, g)).toEqual({ ok: true, text: "ab" });
      expect(await w.agentWrite(nsAC, "x", g)).toEqual({ ok: false, reason: "grant_consumed" });
    });

    test("an agent-written object is readable by a different session/grant with the same scope", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const gWrite = await w.grantToAgent(devA, ["alice"]);
      const wr = await w.agentWrite(nsAB, "memo", gWrite);
      expect(wr.ok).toBe(true);

      const gRead = await w.grantToAgent(devA, ["alice"]);
      if (wr.ok) {
        expect(await w.agentRead(wr.id, gRead)).toEqual({ ok: true, text: "memo" });
      }
    });

    test("agent-written and member-written objects coexist and are both readable by one grant", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const nsAB = await w.namespace(["alice", "bob"]);
      const oMember = await w.encrypt(nsAB, "member");
      const g = await w.grantToAgent(devA, ["alice"]);
      const wr = await w.agentWrite(nsAB, "agent", g);
      expect(wr.ok).toBe(true);

      expect(await w.agentRead(oMember, g)).toEqual({ ok: true, text: "member" });
      if (wr.ok) {
        expect(await w.agentRead(wr.id, g)).toEqual({ ok: true, text: "agent" });
      }
    });

    test("reading an unknown object returns object_not_found", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      await w.namespace(["alice"]);
      const g = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentRead("obj_does_not_exist", g)).toEqual({
        ok: false,
        reason: "object_not_found",
      });
    });

    test("writing into an unknown namespace returns namespace_not_found", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA = await w.device("alice");
      const g = await w.grantToAgent(devA, ["alice"]);

      expect(await w.agentWrite("ns_does_not_exist", "x", g)).toEqual({
        ok: false,
        reason: "namespace_not_found",
      });
    });

    test("revoking one device rotates the group while another device can continue", async () => {
      const w = new World(config);
      await w.user("alice");
      const devA1 = await w.device("alice");
      const devA2 = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const obj = await w.encrypt(ns, "iso");
      const g1 = await w.grantToAgent(devA1, ["alice"]);
      const g2 = await w.grantToAgent(devA2, ["alice"]);

      expect(await w.agentRead(obj, g1)).toEqual({ ok: true, text: "iso" });
      expect(await w.agentRead(obj, g2)).toEqual({ ok: true, text: "iso" });

      await w.engine.revokeDevice(devA1);
      expect(await w.agentRead(obj, g1)).toEqual({ ok: false, reason: "grant_device_revoked" });
      expect(await w.agentRead(obj, g2)).toEqual({ ok: false, reason: "epoch_rotated" });

      const devA3 = await w.device("alice");
      const g3 = await w.grantToAgent(devA3, ["alice"]);
      const current = await w.encrypt(ns, "current", devA2);
      expect(await w.agentRead(current, g3)).toEqual({ ok: true, text: "current" });
    });

    test("the audit log records the expected lifecycle events", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const devA = await w.device("alice");
      const ns = await w.namespace(["alice", "bob"]);
      await w.encrypt(ns, "x");
      const g = await w.grantToAgent(devA, ["alice"]);
      await w.agentWrite(ns, "y", g);
      await w.removeMember(ns, "bob");
      await w.engine.revokeDevice(devA);

      const events = new Set((await w.store.auditLog()).map((e) => e.event));
      expect(events.has("device.register")).toBe(true);
      expect(events.has("grant.mint")).toBe(true);
      expect(events.has("object.encrypt_with_grant")).toBe(true);
      expect(events.has("epoch.rotate")).toBe(true);
      expect(events.has("device.revoke")).toBe(true);
    });
  });

  describe(`read/write battery property fuzz: ${config.name}`, () => {
    test(`property fuzz: subset-lattice read/write invariant (${config.name})`, async () => {
      const N = config.name.includes("mls") ? 12 : 100;
      const maxNamespaces = config.name.includes("mls") ? 2 : 4;
      const rng = mulberry32(0xc0ffee);

      for (let caseIdx = 0; caseIdx < N; caseIdx++) {
        const w = new World(config);
        for (const u of USERS) await w.user(u);
        const scope = randomNonEmptySubset(rng);
        const issuerUser = scope[0];
        if (!issuerUser) throw new Error("property generated an empty scope");
        const dev = await w.device(issuerUser);

        const namespaceCount = 2 + Math.floor(rng() * (maxNamespaces - 1));
        const namespaceRecords: { nsId: string; objectId: string; participants: string[] }[] = [];
        const seenKeys = new Set<string>();

        while (namespaceRecords.length < namespaceCount) {
          const participants = randomNonEmptySubset(rng);
          const key = participants.join(",");
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const nsId = await w.namespace(participants);
          const objectId = await w.encrypt(nsId, `obj-${caseIdx}-${namespaceRecords.length}`);
          namespaceRecords.push({ nsId, objectId, participants });
        }

        const g = await w.grantToAgent(dev, scope);

        for (const { nsId, objectId, participants } of namespaceRecords) {
          const expected = isSubset(canonicalizeParticipants(scope), participants);

          const readRes = await w.agentRead(objectId, g);
          if (expected) {
            expect(readRes.ok).toBe(true);
          } else {
            expect(readRes).toEqual({ ok: false, reason: "out_of_scope" });
          }

          const writeRes = await w.agentWrite(nsId, "w", g);
          if (expected) {
            expect(writeRes.ok).toBe(true);
          } else {
            expect(writeRes).toEqual({ ok: false, reason: "out_of_scope" });
          }
        }
      }
    });
  });
}

import { describe, expect, test } from "bun:test";
import { World } from "../../src/testing/world.ts";
import { matrix } from "../../src/testing/matrix.ts";
import { utf8 } from "../../src/util/bytes.ts";
import type { Grant } from "../../src/testing/v1-compat.ts";

/**
 * Adversarial + invariant battery — the "how do we know the crypto actually
 * protects anything" suite. For each matrix row (dummy AND real ts-mls) we
 * prove the NEGATIVE cases: tamper, forge, replay, and out-of-scope all FAIL,
 * and that no plaintext / private key is ever stored at rest.
 *
 * These prove functional correctness + non-misuse. They do NOT replace a
 * cryptographic audit (see docs/security-primitives.md).
 */

function flipFirstByte(b: Uint8Array): Uint8Array {
  const copy = b.slice();
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}

/** Does `needle` appear as a contiguous subsequence of `haystack`? */
function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

for (const config of matrix) {
  describe(`adversary: ${config.name}`, () => {
    test("plaintext never appears anywhere in stored bytes", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice", "bob"]);
      const secrets = ["SUPER-SECRET-ONE", "another-private-note", "third-🔒-memo"];
      for (const s of secrets) await w.encrypt(ns, s);
      // also mint a grant + an agent-authored write, so those blobs are covered
      const g = await w.grantToAgent(dev, ["alice"]);
      await w.agentWrite(ns, "agent-written-secret", g);

      const snap = w.store.snapshot();
      const allBlobs: Uint8Array[] = [];
      for (const o of snap.objects) allBlobs.push(o.ciphertext, o.wrappedDek);
      for (const gr of snap.grants) allBlobs.push(gr.encryptedSecret, gr.signature);
      for (const d of snap.devices) allBlobs.push(d.encryptionPublicKey, d.signingPublicKey);

      for (const secret of [...secrets, "agent-written-secret"]) {
        const needle = utf8(secret);
        for (const blob of allBlobs) {
          expect(bytesContain(blob, needle)).toBe(false);
        }
      }
    });

    test("no private key material is persisted", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.device("alice");
      await w.namespace(["alice"]);
      const snap = w.store.snapshot();
      for (const d of snap.devices) {
        expect("privateKey" in d).toBe(false);
        expect("signingPrivateKey" in d).toBe(false);
        expect("encryptionPrivateKey" in d).toBe(false);
      }
    });

    test("tampering the ciphertext fails decryption", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "authentic");
      const g = await w.grantToAgent(dev, ["alice"]);

      const stored = (await w.store.getObject(id))!;
      stored.ciphertext[0] = (stored.ciphertext[0] ?? 0) ^ 0xff; // flip a byte in place
      await w.store.putObject(stored);

      expect(await w.agentRead(id, g)).toEqual({ ok: false, reason: "decrypt_failed" });
    });

    test("tampering the wrapped DEK fails decryption", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "authentic");
      const g = await w.grantToAgent(dev, ["alice"]);

      const stored = (await w.store.getObject(id))!;
      stored.wrappedDek[0] = (stored.wrappedDek[0] ?? 0) ^ 0xff;
      await w.store.putObject(stored);

      expect(await w.agentRead(id, g)).toEqual({ ok: false, reason: "unwrap_failed" });
    });

    test("a forged grant signature is rejected", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "authentic");
      const g = await w.grantToAgent(dev, ["alice"]);

      const forged: Grant = { ...g.grant, signature: flipFirstByte(g.grant.signature) };
      expect(await w.agentRead(id, { grant: forged, session: g.session })).toEqual({
        ok: false,
        reason: "grant_invalid_signature",
      });
    });

    test("a tampered grant scope no longer verifies (signature covers it)", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const dev = await w.device("alice");
      const nsB = await w.namespace(["bob"]);
      const id = await w.encrypt(nsB, "bob-only");
      const g = await w.grantToAgent(dev, ["alice"]);

      // Attacker widens the covered epochs to try to reach {bob}. The signature
      // was computed over the original coveredEpochs, so verify fails.
      const forged: Grant = {
        ...g.grant,
        coveredEpochs: Object.fromEntries(
          [
            ...Object.entries(g.grant.coveredEpochs),
            [nsB, [0]] as [string, number[]],
          ]
            .sort(([left], [right]) => left.localeCompare(right)),
        ),
      };
      const out = await w.agentRead(id, { grant: forged, session: g.session });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.reason).toBe("grant_invalid_signature");
    });

    test("a single-use grant already consumed in storage is rejected (caller's flag is not trusted)", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "authentic");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      // Consume it out-of-band in storage; the caller still holds a grant object
      // with consumed:false. Enforcement must consult storage, not that flag.
      expect(await w.engine.consumeGrant(g.grant.id)).not.toBeNull();
      expect(g.grant.consumed).toBe(false); // caller's cached copy is stale-on-purpose
      expect(await w.agentRead(id, g)).toEqual({ ok: false, reason: "grant_consumed" });
    });

    test("a foreign delegation session cannot open the grant", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "authentic");
      const g = await w.grantToAgent(dev, ["alice"]);
      const impostor = await w.engine.createDelegationSession();

      expect(await w.agentRead(id, { grant: g.grant, session: impostor })).toEqual({
        ok: false,
        reason: "grant_open_failed",
      });
    });

    test("single-use grant cannot be replayed on the read path", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "one-shot");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      expect(await w.agentRead(id, g)).toEqual({ ok: true, text: "one-shot" });
      // Replay with the SAME (unmodified) grant object must fail — enforcement
      // consults storage, not the caller's `consumed` flag.
      expect(await w.agentRead(id, g)).toEqual({ ok: false, reason: "grant_consumed" });
    });

    test("single-use grant cannot be replayed on the write path", async () => {
      const w = new World(config);
      await w.user("alice");
      await w.user("bob");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice", "bob"]);
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      const first = await w.agentWrite(ns, "first-write", g);
      expect(first.ok).toBe(true);
      const second = await w.agentWrite(ns, "second-write", g);
      expect(second).toEqual({ ok: false, reason: "grant_consumed" });
    });

    test("single-use grant is one use TOTAL across read and write", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "shared-budget");
      const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

      expect(await w.agentRead(id, g)).toEqual({ ok: true, text: "shared-budget" });
      // the single use was spent by the read — a subsequent write is denied
      expect(await w.agentWrite(ns, "after-read", g)).toEqual({
        ok: false,
        reason: "grant_consumed",
      });
    });

    test("a reusable (non single-use) grant still allows repeated reads", async () => {
      const w = new World(config);
      await w.user("alice");
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const id = await w.encrypt(ns, "reusable");
      const g = await w.grantToAgent(dev, ["alice"]); // singleUse defaults to false

      expect(await w.agentRead(id, g)).toEqual({ ok: true, text: "reusable" });
      expect(await w.agentRead(id, g)).toEqual({ ok: true, text: "reusable" });
      expect(await w.agentRead(id, g)).toEqual({ ok: true, text: "reusable" });
    });
  });
}

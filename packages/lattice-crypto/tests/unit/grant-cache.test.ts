import { describe, expect, test } from "bun:test";
import { World, type WorldConfig } from "../../src/testing/world.ts";
import { DummyGroupProvider } from "../../src/group/dummy.ts";
import { EnumerationScheme } from "../../src/lattice/enumeration.ts";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { grantSigningBytes } from "../../src/format/grant-v1.ts";
import type {
  DeriveGrantParams,
  LatticeScheme,
  SchemeAccess,
  UnwrapContext,
  WrapContext,
} from "../../src/lattice/scheme.ts";
import type { Grant, NamespaceId } from "../../src/types/index.ts";
import { concat, fromHex, toHex } from "../../src/util/bytes.ts";

/**
 * The session-scoped access cache: opening a grant's sealed key map is
 * O(#accessible namespaces), so re-opening it per object made a full sweep
 * ~O(covered²). The engine now caches the opened map on the DelegationSession.
 * These tests pin the observable contract: the map is opened at most ONCE per
 * (grant, session), the cache never crosses sessions, and it never weakens any
 * access-control gate (single-use, foreign session, epoch rotation).
 */

/** Wraps EnumerationScheme and counts how often the grant secret is opened. */
class CountingScheme implements LatticeScheme {
  readonly id = "enumeration";
  opens = 0;
  private readonly inner = new EnumerationScheme();

  wrapDek(dek: Uint8Array, ctx: WrapContext, crypto: LatticeCrypto): Promise<Uint8Array> {
    return this.inner.wrapDek(dek, ctx, crypto);
  }
  wrapDekWithAccess(
    dek: Uint8Array,
    ctx: UnwrapContext,
    access: SchemeAccess,
    crypto: LatticeCrypto,
  ): Promise<Uint8Array | null> {
    return this.inner.wrapDekWithAccess(dek, ctx, access, crypto);
  }
  unwrapDek(
    wrappedDek: Uint8Array,
    ctx: UnwrapContext,
    access: SchemeAccess,
    crypto: LatticeCrypto,
  ): Promise<Uint8Array | null> {
    return this.inner.unwrapDek(wrappedDek, ctx, access, crypto);
  }
  deriveGrantSecret(params: DeriveGrantParams, crypto: LatticeCrypto): Promise<Uint8Array> {
    return this.inner.deriveGrantSecret(params, crypto);
  }
  openGrantSecret(
    encryptedSecret: Uint8Array,
    recipientPrivateKey: Uint8Array,
    crypto: LatticeCrypto,
  ): Promise<SchemeAccess | null> {
    this.opens++;
    return this.inner.openGrantSecret(encryptedSecret, recipientPrivateKey, crypto);
  }
}

function countingConfig(scheme: CountingScheme): WorldConfig {
  return {
    name: "counting+enumeration",
    makeGroup: (crypto) => new DummyGroupProvider(crypto),
    makeScheme: () => scheme,
  };
}

describe("grant access cache", () => {
  test("an old-domain fingerprint cannot seed the signature cache", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "domain-bound");
    const g = await w.grantToAgent(dev, ["alice"]);
    const device = await w.store.getDevice(dev);
    if (!device) throw new Error("test device missing");

    // Invalidate the signature, then preload the cache with the fingerprint
    // that the former domain would have produced for those forged bytes.
    g.grant.expiresAt += 1;
    const crypto = new LatticeCrypto(seededRng(511));
    const oldFingerprint = toHex(crypto.hash(concat(
      fromHex(
        "6b656e746175726f732f6c6174746963652d63727970746f2f6772616e742d63616368652d66696e6765727072696e742f7631",
      ),
      crypto.hash(grantSigningBytes(g.grant)),
      crypto.hash(g.grant.signature),
      crypto.hash(device.signingPublicKey),
    )));
    g.session.verifiedSignatures.set(g.grant, oldFingerprint);

    expect(await w.agentRead(objectId, g)).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });
  });

  test("the access map is opened once per session across repeated reads", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    await w.user("bob");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice", "bob"]);
    const o1 = await w.encrypt(ns, "one");
    const o2 = await w.encrypt(ns, "two");
    const g = await w.grantToAgent(dev, ["alice"]);

    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "one" });
    expect(await w.agentRead(o2, g)).toEqual({ ok: true, text: "two" });
    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "one" });

    // Three reads, but the sealed map was opened exactly once.
    expect(scheme.opens).toBe(1);
  });

  test("the write path reuses the same cached access (no extra open)", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    await w.user("bob");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice", "bob"]);
    const o1 = await w.encrypt(ns, "read-me");
    const g = await w.grantToAgent(dev, ["alice"]);

    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "read-me" });
    const write = await w.agentWrite(ns, "written", g);
    expect(write.ok).toBe(true);

    // Read (open #1, cached) then write reused it — still one open total.
    expect(scheme.opens).toBe(1);
  });

  test("a separate session does not reuse another session's cache", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const o1 = await w.encrypt(ns, "secret");
    const g = await w.grantToAgent(dev, ["alice"]);

    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "secret" });
    expect(scheme.opens).toBe(1);

    // A foreign session holding the SAME grant must still attempt (and fail) its
    // own open — it never benefits from the legitimate session's cache.
    const impostor = await w.engine.createDelegationSession();
    expect(await w.agentRead(o1, { grant: g.grant, session: impostor })).toEqual({
      ok: false,
      reason: "grant_open_failed",
    });
    expect(scheme.opens).toBe(2);

    // The legitimate session keeps using its cache (no new open).
    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "secret" });
    expect(scheme.opens).toBe(2);
  });

  test("the cache does not resurrect a consumed single-use grant", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const o1 = await w.encrypt(ns, "one-shot");
    const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "one-shot" });
    // Second read is denied by the consumption gate, which runs BEFORE the open,
    // so the cached access is never even consulted.
    expect(await w.agentRead(o1, g)).toEqual({ ok: false, reason: "grant_consumed" });
    expect(scheme.opens).toBe(1);
  });

  test("a forged grant is still rejected even after a valid grant warmed the session", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const o1 = await w.encrypt(ns, "authentic");
    const g = await w.grantToAgent(dev, ["alice"]);

    // Warm the session's signature + access caches with the valid grant.
    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "authentic" });

    // A fresh tampered object has no weak-cache entry, so it gets a full
    // (failing) verification.
    const forgedSig = g.grant.signature.slice();
    forgedSig[0] = (forgedSig[0] ?? 0) ^ 0xff;
    const forged = { ...g.grant, signature: forgedSig };
    expect(await w.agentRead(o1, { grant: forged, session: g.session })).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });

    // Tampering a signed field (same signature bytes, new object) also re-checks
    // and fails.
    const widened = {
      ...g.grant,
      coveredEpochs: { ...g.grant.coveredEpochs, ns_fake: [0] },
    };
    const out = await w.agentRead(o1, { grant: widened, session: g.session });
    expect(out.ok).toBe(false);
  });

  test("same-object expiry extension is rejected after the cache is warm", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "short-lived");
    const g = await w.grantToAgent(dev, ["alice"], 10);

    expect(await w.agentRead(objectId, g)).toEqual({ ok: true, text: "short-lived" });
    w.advanceClock(11);

    // Mutate the SAME object already present in both session caches.
    g.grant.expiresAt = w.clock.now() + 60_000;
    expect(await w.agentRead(objectId, g)).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });
  });

  test("same-object operation escalation is rejected after the cache is warm", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "decrypt-only");
    const g = await w.grantToAgent(dev, ["alice"], 60_000, false, ["decrypt"]);

    expect(await w.agentRead(objectId, g)).toEqual({ ok: true, text: "decrypt-only" });

    // Escalate the SAME signed object from decrypt-only to encrypt-capable.
    g.grant.operations.push("encrypt");
    expect(await w.agentWrite(ns, "must-not-write", g)).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });
  });

  test("same-object single-use downgrade cannot resurrect a consumed grant", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "one-shot");
    const g = await w.grantToAgent(dev, ["alice"], 60_000, true);

    expect(await w.agentRead(objectId, g)).toEqual({ ok: true, text: "one-shot" });

    // The SAME cached object now lies about its signed single-use policy.
    g.grant.singleUse = false;
    expect(await w.agentRead(objectId, g)).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });
  });

  test("same-object sealed-secret mutation cannot reuse stale opened access", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "cached-access");
    const g = await w.grantToAgent(dev, ["alice"]);

    expect(await w.agentRead(objectId, g)).toEqual({ ok: true, text: "cached-access" });
    expect(scheme.opens).toBe(1);

    g.grant.encryptedSecret[0] = (g.grant.encryptedSecret[0] ?? 0) ^ 0xff;
    expect(await w.agentRead(objectId, g)).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });
    // The mutated secret is rejected at signature validation, not reopened or
    // served from the access cached for its previous signed bytes.
    expect(scheme.opens).toBe(1);
  });

  test("same-object issuer substitution cannot bypass device revocation", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const issuer = await w.device("alice");
    const substitute = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "issuer-bound");
    const g = await w.grantToAgent(issuer, ["alice"]);

    expect(await w.agentRead(objectId, g)).toEqual({ ok: true, text: "issuer-bound" });
    await w.engine.revokeDevice(issuer);

    // Point the SAME cached grant at another unrevoked device. Its signature
    // was not made by that device and must be re-verified against its key.
    g.grant.issuingDeviceId = substitute;
    expect(await w.agentRead(objectId, g)).toEqual({
      ok: false,
      reason: "grant_invalid_signature",
    });
  });

  test("every signed field invalidates a warmed same-object cache when mutated", async () => {
    const cases: {
      name: string;
      mutate: (grant: Grant, namespaceId: NamespaceId) => void;
    }[] = [
      { name: "id", mutate: (grant) => void (grant.id += "_tampered") },
      {
        name: "issuingDeviceId",
        mutate: (grant) => void (grant.issuingDeviceId += "_tampered"),
      },
      { name: "scope", mutate: (grant) => void grant.scope.push("mallory") },
      {
        name: "operations",
        mutate: (grant) => void (grant.operations = ["decrypt"]),
      },
      { name: "issuedAt", mutate: (grant) => void (grant.issuedAt += 1) },
      { name: "expiresAt", mutate: (grant) => void (grant.expiresAt += 1) },
      {
        name: "coveredEpochs",
        mutate: (grant, namespaceId) =>
          void (grant.coveredEpochs[namespaceId] = [
            (grant.coveredEpochs[namespaceId]?.[0] ?? 0) + 1,
          ]),
      },
      {
        name: "encryptedSecret",
        mutate: (grant) =>
          void (grant.encryptedSecret[0] = (grant.encryptedSecret[0] ?? 0) ^ 0xff),
      },
      { name: "scheme", mutate: (grant) => void (grant.scheme += "_tampered") },
      { name: "singleUse", mutate: (grant) => void (grant.singleUse = true) },
      {
        name: "signature",
        mutate: (grant) =>
          void (grant.signature[0] = (grant.signature[0] ?? 0) ^ 0xff),
      },
    ];

    for (const testCase of cases) {
      const scheme = new CountingScheme();
      const w = new World(countingConfig(scheme));
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, testCase.name);
      const g = await w.grantToAgent(dev, ["alice"]);

      expect(await w.agentRead(objectId, g)).toEqual({
        ok: true,
        text: testCase.name,
      });
      testCase.mutate(g.grant, ns);
      expect(await w.agentRead(objectId, g)).toEqual({
        ok: false,
        reason: "grant_invalid_signature",
      });
    }
  });

  test("in-flight mutation cannot change signed grant identity after validation", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const objectId = await w.encrypt(ns, "warm-cache");
    const g = await w.grantToAgent(dev, ["alice"]);
    const signedGrantId = g.grant.id;

    expect(await w.agentRead(objectId, g)).toEqual({ ok: true, text: "warm-cache" });

    // The cache hit makes openAccess resolve immediately, but the caller still
    // gets a microtask turn while encryptWithGrant awaits it. Mutating the
    // caller-owned object then must not change the already-validated operation.
    const pendingWrite = w.agentWrite(ns, "snapshot-me", g);
    g.grant.id = "grant_forged_after_validation";
    expect((await pendingWrite).ok).toBe(true);

    const writeEvents = (await w.store
      .auditLog())
      .filter((entry) => entry.event === "object.encrypt_with_grant");
    expect(writeEvents.at(-1)?.detail["grantId"]).toBe(signedGrantId);
  });

  test("caching does not weaken epoch rotation", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    await w.user("bob");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice", "bob"]);
    const o1 = await w.encrypt(ns, "pre-rotation");
    const g = await w.grantToAgent(dev, ["alice"]);

    expect(await w.agentRead(o1, g)).toEqual({ ok: true, text: "pre-rotation" });
    await w.removeMember(ns, "bob"); // epoch rotates

    // Even with a warm cache, the rotated grant is rejected before the open.
    expect(await w.agentRead(o1, g)).toEqual({ ok: false, reason: "epoch_rotated" });
  });

  test("decryptMany opens the sealed map exactly once for the whole batch", async () => {
    const scheme = new CountingScheme();
    const w = new World(countingConfig(scheme));
    await w.user("alice");
    await w.user("bob");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice", "bob"]);
    const ids = [
      await w.encrypt(ns, "one"),
      await w.encrypt(ns, "two"),
      await w.encrypt(ns, "three"),
    ];
    const g = await w.grantToAgent(dev, ["alice"]);

    expect(await w.agentReadMany(ids, g)).toEqual([
      { ok: true, text: "one" },
      { ok: true, text: "two" },
      { ok: true, text: "three" },
    ]);
    // Three objects, but the sealed KEK map was opened exactly once.
    expect(scheme.opens).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  deviceCapabilityChallengeBytes,
  grantCacheFingerprint,
} from "../../src/engine/engine.ts";
import { World } from "../../src/testing/world.ts";
import { concat, fromHex, toHex, utf8 } from "../../src/util/bytes.ts";
import { canonicalizeParticipants, isSubset } from "../../src/util/sets.ts";
import { unitWorldConfig } from "./config.ts";

const config = unitWorldConfig;

describe("participant-set helpers", () => {
  test("canonicalization sorts + dedupes", () => {
    expect(canonicalizeParticipants(["c", "a", "b", "a"])).toEqual(["a", "b", "c"]);
  });

  test("subset predicate matches the lattice rule", () => {
    expect(isSubset(["a"], ["a", "b"])).toBe(true);
    expect(isSubset(["a", "b"], ["a", "b", "c"])).toBe(true);
    expect(isSubset(["a"], ["b"])).toBe(false);
    expect(isSubset(["a", "b"], ["a"])).toBe(false);
  });
});

describe("engine basics", () => {
  test("findOrCreateNamespace is idempotent by participant set", async () => {
    const w = new World(config);
    await w.user("alice");
    await w.user("bob");
    const first = await w.namespace(["alice", "bob"]);
    const second = await w.namespace(["bob", "alice"]); // different order, same set
    expect(second).toBe(first);
  });

  test("canAccess reflects the subset rule", async () => {
    const w = new World(config);
    await w.user("alice");
    await w.user("bob");
    const ns = await w.namespace(["alice", "bob"]);
    expect(await w.engine.canAccess(["alice"], ns)).toBe(true);
    expect(await w.engine.canAccess(["alice", "bob"], ns)).toBe(true);
    expect(await w.engine.canAccess(["carol"], ns)).toBe(false);
  });

  test("round-trip: encrypt then agent-decrypt in scope", async () => {
    const w = new World(config);
    await w.user("alice");
    const dev = await w.device("alice");
    const ns = await w.namespace(["alice"]);
    const obj = await w.encrypt(ns, "round-trip");
    const g = await w.grantToAgent(dev, ["alice"]);
    expect(await w.agentRead(obj, g)).toEqual({ ok: true, text: "round-trip" });
  });
});

describe("internal engine domain separation", () => {
  test("pins the device-capability challenge and rejects an old-domain proof", () => {
    const crypto = new LatticeCrypto(seededRng(41));
    const keyPair = crypto.generateSigningKeyPair();
    const canonical = deviceCapabilityChallengeBytes("dev_phone");
    const oldChallenge = concat(
      fromHex(
        "6b656e746175726f732f6c6174746963652d63727970746f2f6465766963652d6361706162696c6974792f7631",
      ),
      utf8("dev_phone"),
    );
    const oldProof = crypto.sign(keyPair.privateKey, oldChallenge);

    expect(toHex(canonical)).toBe(
      "6e617574696c6f2f6c6174746963652d63727970746f2f6465766963652d6361706162696c6974792f76316465765f70686f6e65",
    );
    expect(crypto.verify(keyPair.publicKey, canonical, oldProof)).toBe(false);
  });

  test("pins the grant-cache fingerprint and excludes its old domain", () => {
    const crypto = new LatticeCrypto(seededRng(42));
    const signingBytes = fromHex("00010203");
    const signature = fromHex("040506");
    const issuerKey = fromHex("070809");
    const canonical = grantCacheFingerprint(
      crypto,
      signingBytes,
      signature,
      issuerKey,
    );
    const oldDomain = fromHex(
      "6b656e746175726f732f6c6174746963652d63727970746f2f6772616e742d63616368652d66696e6765727072696e742f7631",
    );
    const oldFingerprint = toHex(crypto.hash(concat(
      oldDomain,
      crypto.hash(signingBytes),
      crypto.hash(signature),
      crypto.hash(issuerKey),
    )));

    expect(canonical).toBe(
      "e58ebae83dc3f6540192d8a48a01b5a82927fa0026189a828af12325616c516d",
    );
    expect(oldFingerprint).not.toBe(canonical);
  });
});

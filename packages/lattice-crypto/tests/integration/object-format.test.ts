import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ENCRYPTED_OBJECT_FORMAT_VERSION,
  objectPayloadAad,
  wrappedDekAad,
} from "../../src/format/object-v1.ts";
import { EnumerationScheme } from "../../src/lattice/enumeration.ts";
import type {
  SchemeAccess,
  UnwrapContext,
  WrapContext,
} from "../../src/lattice/scheme.ts";
import { matrix } from "../../src/testing/matrix.ts";
import { World } from "../../src/testing/world.ts";
import type { NamespaceId, ObjectId } from "../../src/types/index.ts";
import { fromHex, toHex, utf8 } from "../../src/util/bytes.ts";

type V1WrapContext = WrapContext & {
  formatVersion: number;
  objectId: ObjectId;
};

type V1UnwrapContext = UnwrapContext & {
  formatVersion: number;
  objectId: ObjectId;
};

describe("v1 canonical object AAD", () => {
  test("is deterministic, length-framed, and sensitive to every payload field", () => {
    const base = {
      formatVersion: ENCRYPTED_OBJECT_FORMAT_VERSION,
      objectId: "obj_a",
      namespaceId: "ns_a",
      epoch: 7,
      createdAt: 1_000,
    };
    const aad = objectPayloadAad(base);

    expect(aad).not.toBeNull();
    expect(toHex(aad!)).toBe(
      "0000002e6e617574696c6f2f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563742d6161642f7631000000077061796c6f6164000000276e617574696c6f2f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563740000000131000000056f626a5f61000000046e735f6100000001370000000431303030",
    );
    expect(objectPayloadAad({ ...base })).toEqual(aad);
    expect(objectPayloadAad({ ...base, objectId: "obj_b" })).not.toEqual(aad);
    expect(objectPayloadAad({ ...base, namespaceId: "ns_b" })).not.toEqual(aad);
    expect(objectPayloadAad({ ...base, epoch: 8 })).not.toEqual(aad);
    expect(objectPayloadAad({ ...base, createdAt: 1_001 })).not.toEqual(aad);
    expect(objectPayloadAad({ ...base, formatVersion: 2 })).toBeNull();

    // Without length framing, these two adjacent string pairs would both be
    // the bytes for "abc".
    expect(
      objectPayloadAad({ ...base, objectId: "a", namespaceId: "bc" }),
    ).not.toEqual(
      objectPayloadAad({ ...base, objectId: "ab", namespaceId: "c" }),
    );
  });

  test("rejects non-canonical numeric metadata", () => {
    const base = {
      formatVersion: ENCRYPTED_OBJECT_FORMAT_VERSION,
      objectId: "obj_a",
      namespaceId: "ns_a",
      epoch: 7,
      createdAt: 1_000,
    };

    expect(objectPayloadAad({ ...base, epoch: 1.5 })).toBeNull();
    expect(objectPayloadAad({ ...base, createdAt: Number.NaN })).toBeNull();
    expect(
      objectPayloadAad({ ...base, createdAt: Number.POSITIVE_INFINITY }),
    ).toBeNull();
  });

  test("rejects ciphertext authenticated with the pinned old-domain AAD", () => {
    const context = {
      formatVersion: ENCRYPTED_OBJECT_FORMAT_VERSION,
      objectId: "obj_a",
      namespaceId: "ns_a",
      epoch: 7,
      createdAt: 1_000,
    };
    const oldAad = fromHex(
      "000000306b656e746175726f732f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563742d6161642f7631000000077061796c6f6164000000296b656e746175726f732f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563740000000131000000056f626a5f61000000046e735f6100000001370000000431303030",
    );
    const crypto = new LatticeCrypto(seededRng(701));
    const key = crypto.randomBytes(32);
    const ciphertext = crypto.aeadSeal(key, utf8("old-domain"), oldAad);

    expect(crypto.aeadOpen(key, ciphertext, objectPayloadAad(context)!)).toBeNull();
  });
});

describe("v1 wrapped-DEK AAD", () => {
  test("binds format version, object id, namespace id, and epoch", async () => {
    const crypto = new LatticeCrypto(seededRng(7));
    const scheme = new EnumerationScheme();
    const namespaceA: NamespaceId = "ns_a";
    const namespaceB: NamespaceId = "ns_b";
    const namespaceKey = crypto.randomBytes(32);
    const dek = crypto.randomBytes(32);
    const access = {
      [namespaceA]: { "7": toHex(namespaceKey) },
      [namespaceB]: { "7": toHex(namespaceKey) },
    } as SchemeAccess;
    const wrapContext: V1WrapContext = {
      formatVersion: 1,
      objectId: "obj_a",
      namespaceId: namespaceA,
      epoch: 7,
      namespaceKey,
    };
    const unwrapContext: V1UnwrapContext = {
      formatVersion: 1,
      objectId: "obj_a",
      namespaceId: namespaceA,
      epoch: 7,
    };
    const wrapped = await scheme.wrapDek(dek, wrapContext, crypto);
    expect(toHex(wrappedDekAad(wrapContext)!)).toBe(
      "0000002e6e617574696c6f2f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563742d6161642f76310000000b777261707065642d64656b000000276e617574696c6f2f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563740000000131000000056f626a5f61000000046e735f610000000137",
    );
    const oldDomainWrapped = crypto.aeadSeal(
      namespaceKey,
      dek,
      fromHex(
        "000000306b656e746175726f732f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563742d6161642f76310000000b777261707065642d64656b000000296b656e746175726f732f6c6174746963652d63727970746f2f656e637279707465642d6f626a6563740000000131000000056f626a5f61000000046e735f610000000137",
      ),
    );
    expect(
      await scheme.unwrapDek(oldDomainWrapped, unwrapContext, access, crypto),
    ).toBeNull();

    expect(await scheme.unwrapDek(wrapped, unwrapContext, access, crypto)).toEqual(
      dek,
    );
    expect(
      await scheme.unwrapDek(
        wrapped,
        { ...unwrapContext, formatVersion: 2 },
        access,
        crypto,
      ),
    ).toBeNull();
    expect(
      await scheme.unwrapDek(
        wrapped,
        { ...unwrapContext, objectId: "obj_b" },
        access,
        crypto,
      ),
    ).toBeNull();
    expect(
      await scheme.unwrapDek(
        wrapped,
        { ...unwrapContext, namespaceId: namespaceB },
        access,
        crypto,
      ),
    ).toBeNull();
    expect(
      await scheme.unwrapDek(
        wrapped,
        { ...unwrapContext, epoch: 8 },
        access,
        crypto,
      ),
    ).toBeNull();
  });
});

for (const config of matrix) {
  describe(`v1 encrypted-object AAD: ${config.name}`, () => {
    test("rejects a complete ciphertext/DEK pair swapped within one namespace and epoch", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectA = await w.encrypt(ns, "alpha");
      const objectB = await w.encrypt(ns, "beta");
      const grant = await w.grantToAgent(dev, ["alice"]);
      const storedA = (await w.store.getObject(objectA))!;
      const storedB = (await w.store.getObject(objectB))!;

      storedA.wrappedDek = storedB.wrappedDek.slice();
      storedA.ciphertext = storedB.ciphertext.slice();
      await w.store.putObject(storedA);

      expect(await w.agentRead(objectA, grant)).toEqual({
        ok: false,
        reason: "unwrap_failed",
      });
    });

    test("rejects a complete pair swap between grant-authored objects", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const grant = await w.grantToAgent(dev, ["alice"]);
      const writeA = await w.agentWrite(ns, "agent-alpha", grant);
      const writeB = await w.agentWrite(ns, "agent-beta", grant);
      if (!writeA.ok || !writeB.ok) throw new Error("test setup write failed");
      const storedA = (await w.store.getObject(writeA.id))!;
      const storedB = (await w.store.getObject(writeB.id))!;

      storedA.wrappedDek = storedB.wrappedDek.slice();
      storedA.ciphertext = storedB.ciphertext.slice();
      await w.store.putObject(storedA);

      expect(await w.agentRead(writeA.id, grant)).toEqual({
        ok: false,
        reason: "unwrap_failed",
      });
    });

    test("authenticates the creation timestamp as payload metadata", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "timestamp-bound");
      const grant = await w.grantToAgent(dev, ["alice"]);
      const stored = (await w.store.getObject(objectId))!;

      stored.createdAt += 1;
      await w.store.putObject(stored);

      expect(await w.agentRead(objectId, grant)).toEqual({
        ok: false,
        reason: "decrypt_failed",
      });
    });

    test("authenticates object identity", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "identity-bound");
      const grant = await w.grantToAgent(dev, ["alice"]);
      const stored = (await w.store.getObject(objectId))!;

      stored.id = `${stored.id}_tampered`;
      await w.store.putObject(stored);

      expect(await w.agentRead(stored.id, grant)).toEqual({
        ok: false,
        reason: "unwrap_failed",
      });
    });

    test("rejects an unknown ciphertext format version", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "known-version-only");
      const grant = await w.grantToAgent(dev, ["alice"]);
      const stored = (await w.store.getObject(objectId))!;
      const mutableStored = stored as unknown as {
        formatVersion?: number;
      };

      mutableStored.formatVersion = 999;
      await w.store.putObject(stored);

      expect(await w.agentRead(objectId, grant)).toEqual({
        ok: false,
        reason: "unsupported_object_format",
      });
    });

    test("rejects a missing ciphertext format version without a legacy fallback", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "no-v0-fallback");
      const grant = await w.grantToAgent(dev, ["alice"]);
      const stored = (await w.store.getObject(objectId))!;
      const mutableStored = stored as unknown as {
        formatVersion?: number;
      };

      delete mutableStored.formatVersion;
      await w.store.putObject(stored);

      expect(await w.agentRead(objectId, grant)).toEqual({
        ok: false,
        reason: "unsupported_object_format",
      });
    });

    test("an unsupported format is ineligible and does not consume a single-use grant", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectId = await w.encrypt(ns, "restore-version");
      const grant = await w.grantToAgent(dev, ["alice"], 60_000, true);
      const stored = (await w.store.getObject(objectId))!;
      const mutableVersion = stored as unknown as { formatVersion: number };

      mutableVersion.formatVersion = 999;
      await w.store.putObject(stored);
      expect(await w.agentRead(objectId, grant)).toEqual({
        ok: false,
        reason: "unsupported_object_format",
      });

      mutableVersion.formatVersion = ENCRYPTED_OBJECT_FORMAT_VERSION;
      await w.store.putObject(stored);
      expect(await w.agentRead(objectId, grant)).toEqual({
        ok: true,
        text: "restore-version",
      });
    });

    test("uses an owned object snapshot across async access opening", async () => {
      const w = new World(config);
      const dev = await w.device("alice");
      const ns = await w.namespace(["alice"]);
      const objectA = await w.encrypt(ns, "snapshot-alpha");
      const objectB = await w.encrypt(ns, "snapshot-beta");
      const grant = await w.grantToAgent(dev, ["alice"]);
      const storedA = (await w.store.getObject(objectA))!;
      const storedB = (await w.store.getObject(objectB))!;

      // Warm the access cache so decryptObject yields at an immediately
      // resolving openAccess call after it has captured the stored record.
      expect(await w.agentRead(objectA, grant)).toEqual({
        ok: true,
        text: "snapshot-alpha",
      });
      const pendingRead = w.agentRead(objectA, grant);

      storedA.formatVersion = storedB.formatVersion;
      storedA.namespaceId = storedB.namespaceId;
      storedA.epoch = storedB.epoch;
      storedA.createdAt = storedB.createdAt;
      storedA.wrappedDek = storedB.wrappedDek.slice();
      storedA.ciphertext = storedB.ciphertext.slice();
      await w.store.putObject(storedA);

      expect(await pendingRead).toEqual({
        ok: true,
        text: "snapshot-alpha",
      });
      expect(await w.agentRead(objectA, grant)).toEqual({
        ok: false,
        reason: "unwrap_failed",
      });
    });
  });
}

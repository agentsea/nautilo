import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
  type Rng,
} from "../../src/crypto/index.ts";
import {
  decryptObjectBatchV2,
  encryptObjectBatchV2,
  type NamespaceBatchKeyV2,
} from "../../src/object/batch.ts";
import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function batchKey(
  namespace: string,
  value: number,
): NamespaceBatchKeyV2 {
  return {
    namespaceId: namespaceId(namespace),
    keyClass: "human",
    keyGeneration: namespaceGeneration(3),
    bindingRevision: accessRevision(7),
    key: bytes(value),
  };
}

function countingRng(): Rng & { readonly calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    bytes(length) {
      calls++;
      return bytes(calls, length);
    },
  };
}

describe("v2 bounded object batches", () => {
  test("encrypts with a pre-resolved binding table and decrypts in stable input order", () => {
    const crypto = new LatticeCrypto(seededRng(0xb47c));
    const roomA = batchKey("namespace_a", 0x31);
    const roomB = batchKey("namespace_b", 0x32);
    const encrypted = encryptObjectBatchV2(
      crypto,
      [roomB, roomA],
      [
        {
          context: {
            objectId: objectId("object_first"),
            keyClass: "human",
            objectType: "message",
            createdAt: unixTimestamp(1_000),
          },
          plaintext: new TextEncoder().encode("first"),
          targetNamespaceIds: [
            roomA.namespaceId,
            roomB.namespaceId,
          ],
        },
        {
          context: {
            objectId: objectId("object_second"),
            keyClass: "human",
            objectType: "memory",
            createdAt: unixTimestamp(2_000),
          },
          plaintext: new TextEncoder().encode("second"),
          targetNamespaceIds: [roomB.namespaceId],
        },
      ],
    );

    expect(encrypted).toHaveLength(2);
    expect(
      encrypted.map((item) =>
        item.envelopes.map((envelope) => envelope.context.namespaceId)
      ),
    ).toEqual([
      [roomA.namespaceId, roomB.namespaceId],
      [roomB.namespaceId],
    ]);

    const tampered = {
      ...encrypted[1]!.payload,
      ciphertext: encrypted[1]!.payload.ciphertext.slice(),
    };
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    const results = decryptObjectBatchV2(
      crypto,
      [roomA, roomB],
      [
        {
          payload: encrypted[1]!.payload,
          envelope: encrypted[1]!.envelopes[0]!,
        },
        {
          payload: encrypted[0]!.payload,
          envelope: encrypted[0]!.envelopes[0]!,
        },
        {
          payload: tampered,
          envelope: encrypted[1]!.envelopes[0]!,
        },
      ],
    );

    expect(
      results.map((result) =>
        result.ok
          ? new TextDecoder().decode(result.plaintext)
          : result.reason
      ),
    ).toEqual(["second", "first", "decrypt_failed"]);
  });

  test("reports a missing pre-resolved key per item without shifting later results", () => {
    const crypto = new LatticeCrypto(seededRng(0xb47d));
    const roomA = batchKey("namespace_a", 0x41);
    const roomB = batchKey("namespace_b", 0x42);
    const encrypted = encryptObjectBatchV2(
      crypto,
      [roomA, roomB],
      [{
        context: {
          objectId: objectId("object_shared"),
          keyClass: "human",
          objectType: "artifact",
          createdAt: unixTimestamp(3_000),
        },
        plaintext: bytes(0x51, 8),
        targetNamespaceIds: [roomA.namespaceId, roomB.namespaceId],
      }],
    )[0]!;

    const results = decryptObjectBatchV2(
      crypto,
      [roomB],
      [
        {
          payload: encrypted.payload,
          envelope: encrypted.envelopes[0]!,
        },
        {
          payload: encrypted.payload,
          envelope: encrypted.envelopes[1]!,
        },
      ],
    );

    expect(results[0]).toEqual({
      ok: false,
      reason: "binding_key_unavailable",
    });
    expect(results[1]?.ok).toBe(true);
  });

  test("preflights every batch and binding limit before randomness", () => {
    const rng = countingRng();
    const crypto = new LatticeCrypto(rng);
    const key = batchKey("namespace_limit", 0x61);
    const item = {
      context: {
        objectId: objectId("object_limit"),
        keyClass: "human" as const,
        objectType: "message",
        createdAt: unixTimestamp(4_000),
      },
      plaintext: bytes(0x71),
      targetNamespaceIds: [key.namespaceId],
    };

    expect(() =>
      encryptObjectBatchV2(
        crypto,
        [key],
        Array.from(
          { length: V2_LIMITS.batchItems + 1 },
          () => item,
        ),
      )
    ).toThrow("batch");
    expect(rng.calls).toBe(0);

    expect(() =>
      encryptObjectBatchV2(
        crypto,
        Array.from(
          { length: V2_LIMITS.bindingsPerBatch + 1 },
          (_, index) => batchKey(`namespace_${index}`, index),
        ),
        [item],
      )
    ).toThrow("bindings");
    expect(rng.calls).toBe(0);
  });

  test("rejects duplicate binding coordinates and incomplete targets before crypto", () => {
    const rng = countingRng();
    const crypto = new LatticeCrypto(rng);
    const key = batchKey("namespace_duplicate", 0x81);
    const item = {
      context: {
        objectId: objectId("object_duplicate"),
        keyClass: "human" as const,
        objectType: "message",
        createdAt: unixTimestamp(5_000),
      },
      plaintext: bytes(0x91),
      targetNamespaceIds: [key.namespaceId],
    };

    expect(() =>
      encryptObjectBatchV2(crypto, [key, key], [item])
    ).toThrow("duplicate pre-resolved batch binding coordinate");
    expect(() =>
      encryptObjectBatchV2(crypto, [], [item])
    ).toThrow("pre-resolved");
    expect(rng.calls).toBe(0);
  });

  test("rejects every malformed pre-resolved binding and encryption item before crypto", () => {
    const rng = countingRng();
    const crypto = new LatticeCrypto(rng);
    const key = batchKey("namespace_checked", 0x82);
    const item = {
      context: {
        objectId: objectId("object_checked"),
        keyClass: "human" as const,
        objectType: "message",
        createdAt: unixTimestamp(5_100),
      },
      plaintext: bytes(0x92),
      targetNamespaceIds: [key.namespaceId],
    };
    const encrypt = (
      bindings: readonly NamespaceBatchKeyV2[],
      items: readonly typeof item[],
    ) => encryptObjectBatchV2(crypto, bindings, items);

    expect(() => encrypt(null as never, [item])).toThrow(
      "pre-resolved batch bindings must be an array",
    );
    for (const binding of [null, "binding"]) {
      expect(() => encrypt([binding as never], [item])).toThrow(
        "pre-resolved batch binding must be an object",
      );
    }
    expect(() =>
      encrypt([{ ...key, unknown: true } as never], [item])
    ).toThrow("pre-resolved batch binding contains unknown field unknown");
    expect(() =>
      encrypt([{ ...key, keyClass: "management" as never }], [item])
    ).toThrow("batch key class must be human or ai");
    expect(() =>
      encrypt([{ ...key, key: Array.from(key.key) as never }], [item])
    ).toThrow("pre-resolved Namespace key must be exactly 32 bytes");
    expect(() =>
      encrypt([{ ...key, key: bytes(1, 31) }], [item])
    ).toThrow("pre-resolved Namespace key must be exactly 32 bytes");
    expect(() =>
      encrypt([
        key,
        { ...key, keyGeneration: namespaceGeneration(4) },
      ], [item])
    ).toThrow("duplicate current pre-resolved batch binding coordinate");

    expect(() => encrypt([key], null as never)).toThrow(
      "object encryption batch must be an array",
    );
    for (const candidate of [null, "item"]) {
      expect(() => encrypt([key], [candidate as never])).toThrow(
        "object encryption batch item must be an object",
      );
    }
    expect(() =>
      encrypt([key], [{ ...item, unknown: true } as never])
    ).toThrow("object encryption batch item contains unknown field unknown");
    expect(() =>
      encrypt([key], [{ ...item, plaintext: [1, 2] as never }])
    ).toThrow("object batch plaintext must be Uint8Array");
    expect(() =>
      encrypt([key], [{
        ...item,
        plaintext: new Uint8Array(V2_LIMITS.plaintextBytes + 1),
      }])
    ).toThrow("object batch plaintext bytes exceeds");
    expect(() =>
      encrypt([key], [{ ...item, targetNamespaceIds: null as never }])
    ).toThrow("object batch target Namespaces must be an array");
    expect(() =>
      encrypt([key], [{ ...item, targetNamespaceIds: [] }])
    ).toThrow("object batch requires a pre-resolved target binding");
    expect(() =>
      encrypt([key], [{
        ...item,
        targetNamespaceIds: [key.namespaceId, key.namespaceId],
      }])
    ).toThrow("duplicate object batch target Namespace");
    expect(() =>
      encrypt([key], [{
        ...item,
        targetNamespaceIds: Array.from(
          { length: V2_LIMITS.namespaceEnvelopesPerManifest + 1 },
          () => key.namespaceId,
        ),
      }])
    ).toThrow("object batch target Namespaces exceeds");
    expect(rng.calls).toBe(0);
  });

  test("rejects every malformed decryption item before attempting any decrypt", () => {
    const crypto = new LatticeCrypto(seededRng(0xb480));
    const key = batchKey("namespace_decrypt_checked", 0x83);
    const encrypted = encryptObjectBatchV2(crypto, [key], [{
      context: {
        objectId: objectId("object_decrypt_checked"),
        keyClass: "human",
        objectType: "message",
        createdAt: unixTimestamp(5_200),
      },
      plaintext: bytes(0x93),
      targetNamespaceIds: [key.namespaceId],
    }])[0]!;
    const valid = {
      payload: encrypted.payload,
      envelope: encrypted.envelopes[0]!,
    };
    const decrypt = (items: readonly typeof valid[]) =>
      decryptObjectBatchV2(crypto, [key], items);

    expect(() => decrypt(null as never)).toThrow(
      "object decryption batch must be an array",
    );
    for (const candidate of [null, "item"]) {
      expect(() => decrypt([candidate as never])).toThrow(
        "object decryption batch item must be an object",
      );
    }
    expect(() =>
      decrypt([{ ...valid, unknown: true } as never])
    ).toThrow("object decryption batch item contains unknown field unknown");
    for (const payload of [
      null,
      undefined,
      "payload",
      { ...valid.payload, formatVersion: 1 },
      { ...valid.payload, ciphertext: [1, 2] },
    ]) {
      expect(() => decrypt([{ ...valid, payload: payload as never }])).toThrow(
        "object decryption batch payload is malformed",
      );
    }
    expect(() =>
      decrypt([{
        ...valid,
        payload: {
          ...valid.payload,
          ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
        },
      }])
    ).toThrow("object decryption batch ciphertext bytes exceeds");
    for (const envelope of [
      null,
      undefined,
      "envelope",
      { ...valid.envelope, formatVersion: 1 },
      { ...valid.envelope, wrappedDek: [1, 2] },
    ]) {
      expect(() =>
        decrypt([{ ...valid, envelope: envelope as never }])
      ).toThrow("object decryption batch envelope is malformed");
    }
    expect(() =>
      decrypt([{
        ...valid,
        envelope: {
          ...valid.envelope,
          wrappedDek: new Uint8Array(V2_LIMITS.wrappedDekBytes + 1),
        },
      }])
    ).toThrow("object decryption batch wrapped DEK bytes exceeds");
    expect(() =>
      decrypt(Array.from(
        { length: V2_LIMITS.batchItems + 1 },
        () => valid,
      ))
    ).toThrow("object decryption batch exceeds the 256 limit");
  });

  test("accepts AI bindings only for AI object contexts", () => {
    const crypto = new LatticeCrypto(seededRng(0xb482));
    const aiKey = {
      ...batchKey("namespace_ai", 0x85),
      keyClass: "ai" as const,
    };
    const encrypted = encryptObjectBatchV2(crypto, [aiKey], [{
      context: {
        objectId: objectId("object_ai"),
        keyClass: "ai",
        objectType: "memory",
        createdAt: unixTimestamp(5_250),
      },
      plaintext: bytes(0x95),
      targetNamespaceIds: [aiKey.namespaceId],
    }])[0]!;
    const [result] = decryptObjectBatchV2(crypto, [aiKey], [{
      payload: encrypted.payload,
      envelope: encrypted.envelopes[0]!,
    }]);
    expect(result?.ok).toBe(true);
  });

  test("zeroizes each temporary object DEK after wrapping", () => {
    const crypto = new LatticeCrypto(seededRng(0xb481));
    const key = batchKey("namespace_zeroize", 0x84);
    const originalSeal = crypto.aeadSeal.bind(crypto);
    const observedDeks: Uint8Array[] = [];
    crypto.aeadSeal = (candidateKey, plaintext, aad) => {
      if (candidateKey === key.key) observedDeks.push(plaintext);
      else if (candidateKey.length === 32) observedDeks.push(candidateKey);
      return originalSeal(candidateKey, plaintext, aad);
    };

    encryptObjectBatchV2(crypto, [key], [{
      context: {
        objectId: objectId("object_zeroize"),
        keyClass: "human",
        objectType: "message",
        createdAt: unixTimestamp(5_300),
      },
      plaintext: bytes(0x94),
      targetNamespaceIds: [key.namespaceId],
    }]);

    expect(observedDeks).toHaveLength(2);
    expect(
      observedDeks.every((candidate) =>
        candidate.every((byte) => byte === 0)
      ),
    ).toBe(true);
  });

  test("round-trips the exact 256-item and 256-binding ceilings", () => {
    const crypto = new LatticeCrypto(seededRng(0xb47e));
    const keys = Array.from(
      { length: V2_LIMITS.bindingsPerBatch },
      (_, index) => batchKey(`namespace_${index}`, index),
    );
    const encrypted = encryptObjectBatchV2(
      crypto,
      keys,
      Array.from(
        { length: V2_LIMITS.batchItems },
        (_, index) => ({
          context: {
            objectId: objectId(`object_${index}`),
            keyClass: "human" as const,
            objectType: "message",
            createdAt: unixTimestamp(index),
          },
          plaintext: Uint8Array.of(index & 0xff),
          targetNamespaceIds: [keys[index]!.namespaceId],
        }),
      ),
    );
    const decrypted = decryptObjectBatchV2(
      crypto,
      keys,
      encrypted.map((item) => ({
        payload: item.payload,
        envelope: item.envelopes[0]!,
      })),
    );

    expect(encrypted).toHaveLength(V2_LIMITS.batchItems);
    expect(decrypted).toHaveLength(V2_LIMITS.batchItems);
    expect(
      decrypted.every(
        (result, index) =>
          result.ok && result.plaintext[0] === (index & 0xff),
      ),
    ).toBe(true);
  });
});

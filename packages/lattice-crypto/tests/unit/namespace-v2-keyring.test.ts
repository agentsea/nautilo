import { describe, expect, spyOn, test } from "bun:test";
import {
  LatticeCrypto,
  seededRng,
  type Rng,
} from "../../src/crypto/index.ts";
import {
  NAMESPACE_KEYRING_DOMAIN,
  assertCanonicalNamespaceKeyring,
  assertNamespaceKeyringEnvelope,
  decodeNamespaceKeyring,
  encodeNamespaceKeyring,
  namespaceKeyringEnvelopeAad,
  namespaceKeyringEnvelopeSigningBytes,
  parseNamespaceKeyringEnvelope,
  serializeNamespaceKeyringEnvelope,
} from "../../src/format/namespace-keyring-v2.ts";
import {
  appendNamespaceGeneration,
  createInitialNamespaceKeyrings,
  namespaceKeyringsEqual,
  openNamespaceKeyring,
  prepareNamespaceKeyringRevision,
  resealNamespaceKeyring,
  sealNamespaceKeyring,
  verifyNamespaceKeyringEnvelope,
} from "../../src/namespace/keyrings.ts";
import type {
  NamespaceKeyringEnvelopeV2,
  NamespaceKeyringPlaintextV2,
} from "../../src/namespace/types.ts";
import {
  accessRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceGeneration,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function corruptText(
  input: Uint8Array,
  text: string,
  after = 0,
): Uint8Array {
  const output = input.slice();
  const needle = new TextEncoder().encode(text);
  const offset = output.findIndex((_, index) =>
    index >= after
    && needle.every((byte, inner) => output[index + inner] === byte)
  );
  if (offset < 0) throw new Error(`missing fixture text ${text}`);
  output[offset] = output[offset]! ^ 1;
  return output;
}

function captureZeroizedBytes<T>(
  action: () => T,
): Readonly<{ result: T; zeroized: readonly Uint8Array[] }> {
  const originalFill = Uint8Array.prototype.fill;
  const zeroized: Uint8Array[] = [];
  const fill = spyOn(Uint8Array.prototype, "fill").mockImplementation(
    function (
      this: Uint8Array,
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const result = originalFill.call(this, value, start, end);
      if (value === 0) zeroized.push(new Uint8Array(this));
      return result;
    },
  );
  try {
    return { result: action(), zeroized };
  } finally {
    fill.mockRestore();
  }
}

class SharedSignatureCrypto extends LatticeCrypto {
  issuedSignature: Uint8Array | null = null;

  override sign(
    privateKey: Uint8Array,
    message: Uint8Array,
  ): Uint8Array {
    const signature = super.sign(privateKey, message);
    this.issuedSignature = signature;
    return signature;
  }
}

class CapturingRandomCrypto extends LatticeCrypto {
  readonly issuedRandomBytes: Uint8Array[] = [];

  override randomBytes(length: number): Uint8Array {
    const value = super.randomBytes(length);
    this.issuedRandomBytes.push(value);
    return value;
  }
}

function fixtureKeyring(): NamespaceKeyringPlaintextV2 {
  return {
    formatVersion: 2,
    namespaceId: namespaceId("ns_room"),
    keyClass: "human",
    accessRevision: accessRevision(3),
    currentGeneration: namespaceGeneration(1),
    generations: [
      { generation: namespaceGeneration(0), key: bytes(0x11) },
      { generation: namespaceGeneration(1), key: bytes(0x22) },
    ],
  };
}

function fixtureEnvelope(): NamespaceKeyringEnvelopeV2 {
  return {
    formatVersion: 2,
    namespaceId: namespaceId("ns_room"),
    keyClass: "human",
    domainId: cryptoDomainId("domain_ab"),
    domainEpoch: domainEpoch(2),
    accessRevision: accessRevision(3),
    currentGeneration: namespaceGeneration(4),
    previousBindingHash: bytes(0xaa),
    ciphertext: bytes(0xdd, 40),
    committerDeviceId: cryptoDeviceId("device_alice"),
    signature: bytes(0xee, 64),
  };
}

describe("Namespace keyring v2 canonical format", () => {
  test("locks the exact domain and complete keyring fixture", () => {
    expect(NAMESPACE_KEYRING_DOMAIN).toBe(
      "nautilo/lattice-crypto/namespace-keyring-envelope/v2",
    );
    const encoded = encodeNamespaceKeyring(fixtureKeyring());
    expect(hex(encoded)).toBe(
      "000000346e617574696c6f2f6c6174746963652d63727970746f2f6e616d6573706163652d6b657972696e672d656e76656c6f70652f7632" +
        "0000001b6e616d6573706163652d6b657972696e672d706c61696e74657874" +
        "00000002" +
        "000000076e735f726f6f6d" +
        "0000000568756d616e" +
        "0000000000000003" +
        "0000000000000001" +
        "00000002" +
        "0000000000000000" +
        `00000020${"11".repeat(32)}` +
        "0000000000000001" +
        `00000020${"22".repeat(32)}`,
    );

    const decoded = decodeNamespaceKeyring(encoded);
    expect(String(decoded.namespaceId)).toBe("ns_room");
    expect(decoded.keyClass).toBe("human");
    expect(Number(decoded.accessRevision)).toBe(3);
    expect(Number(decoded.currentGeneration)).toBe(1);
    expect(decoded.generations.map((entry) => Number(entry.generation))).toEqual(
      [0, 1],
    );
    expect(decoded.generations.map((entry) => hex(entry.key))).toEqual([
      "11".repeat(32),
      "22".repeat(32),
    ]);
  });

  test("rejects malformed, noncanonical, incomplete, and oversized keyrings", () => {
    const base = fixtureKeyring();
    expect(() =>
      encodeNamespaceKeyring({ ...base, formatVersion: 3 as never })
    ).toThrow("version");
    expect(() =>
      encodeNamespaceKeyring({
        ...base,
        unexpected: true,
      } as NamespaceKeyringPlaintextV2)
    ).toThrow("unknown field");
    expect(() =>
      encodeNamespaceKeyring({
        ...base,
        rootExtra: true,
      } as never)
    ).toThrow("Namespace keyring contains unknown field rootExtra");
    expect(() =>
      encodeNamespaceKeyring({
        ...base,
        generations: [base.generations[1]!, base.generations[0]!],
      })
    ).toThrow("strictly increasing");
    expect(() =>
      encodeNamespaceKeyring({
        ...base,
        generations: [base.generations[0]!, base.generations[0]!],
      })
    ).toThrow("strictly increasing");
    expect(() =>
      encodeNamespaceKeyring({
        ...base,
        currentGeneration: namespaceGeneration(7),
      })
    ).toThrow("current generation");
    expect(() =>
      encodeNamespaceKeyring({
        ...base,
        generations: [{ generation: namespaceGeneration(0), key: bytes(1, 31) }],
        currentGeneration: namespaceGeneration(0),
      })
    ).toThrow("32 bytes");

    const encoded = encodeNamespaceKeyring(base);
    expect(() =>
      decodeNamespaceKeyring(
        new Uint8Array([...encoded, 0]),
      )
    ).toThrow("trailing bytes");
    expect(() =>
      decodeNamespaceKeyring(
        new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
      )
    ).toThrow("256 KiB");
    expect(() =>
      decodeNamespaceKeyring("not-bytes" as unknown as Uint8Array)
    ).toThrow("Namespace keyring bytes are invalid");
    expect(() =>
      decodeNamespaceKeyring(corruptText(encoded, NAMESPACE_KEYRING_DOMAIN))
    ).toThrow("Namespace keyring domain is unsupported");
    expect(() =>
      decodeNamespaceKeyring(
        corruptText(encoded, "namespace-keyring-plaintext"),
      )
    ).toThrow("Namespace keyring purpose is unsupported");
  });

  test("checks the 4,096 generation ceiling before consuming randomness", () => {
    let rngCalls = 0;
    const crypto = new LatticeCrypto({
      bytes(length) {
        rngCalls++;
        return new Uint8Array(length);
      },
    });
    const generations = Array.from(
      { length: V2_LIMITS.retainedNamespaceGenerations },
      (_, index) => ({
        generation: namespaceGeneration(index),
        key: bytes(index & 0xff),
      }),
    );
    const full: NamespaceKeyringPlaintextV2 = {
      formatVersion: 2,
      namespaceId: namespaceId("ns_room"),
      keyClass: "ai",
      accessRevision: accessRevision(7),
      currentGeneration: namespaceGeneration(
        V2_LIMITS.retainedNamespaceGenerations - 1,
      ),
      generations,
    };

    expect(() => appendNamespaceGeneration(crypto, full)).toThrow("4,096");
    expect(rngCalls).toBe(0);
  });

  test("zeroizes codec-owned key copies on success and trailing-byte failure", () => {
    const encoded = encodeNamespaceKeyring(fixtureKeyring());
    const successful = captureZeroizedBytes(() =>
      decodeNamespaceKeyring(encoded)
    );

    expect(successful.result.generations).toHaveLength(2);
    expect(
      successful.zeroized.filter(
        (value) => value.length === 32,
      ),
    ).toHaveLength(2);

    const malformed = new Uint8Array([
      ...encodeNamespaceKeyring(fixtureKeyring()),
      0,
    ]);
    const failed = captureZeroizedBytes(() =>
      expect(() => decodeNamespaceKeyring(malformed)).toThrow(
        "trailing bytes",
      )
    );
    expect(
      failed.zeroized.filter(
        (value) => value.length === 32,
      ),
    ).toHaveLength(2);
  });

  test("rejects every malformed plaintext shape and key-class boundary", () => {
    const base = fixtureKeyring();
    expect(() =>
      assertCanonicalNamespaceKeyring(null as never)
    ).toThrow("Namespace keyring must be an object");
    expect(() =>
      assertCanonicalNamespaceKeyring("keyring" as never)
    ).toThrow("Namespace keyring must be an object");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        keyClass: "management" as "human",
      })
    ).toThrow("Namespace key class is unsupported");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: null as never,
      })
    ).toThrow("generations must be an array");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: [],
      })
    ).toThrow("Namespace keyring generations");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: [null as never],
      })
    ).toThrow("entry must be an object");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: ["entry" as never],
      })
    ).toThrow("entry must be an object");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: [{
          ...base.generations[0]!,
          extra: true,
        } as never],
      })
    ).toThrow("Namespace keyring entry contains unknown field extra");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: [base.generations[0]!],
        currentGeneration: namespaceGeneration(1),
      })
    ).toThrow("unique latest entry");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: [
          base.generations[0]!,
          { generation: namespaceGeneration(2), key: bytes(3) },
        ],
        currentGeneration: namespaceGeneration(0),
      })
    ).toThrow("unique latest entry");
    expect(() =>
      assertCanonicalNamespaceKeyring({
        ...base,
        generations: [{
          generation: namespaceGeneration(0),
          key: bytes(1, 31),
        }],
        currentGeneration: namespaceGeneration(0),
      })
    ).toThrow("Namespace generation key must contain exactly 32 bytes");
  });

  test("zeroizes each temporary framed-key copy produced by encoding", () => {
    const originalFill = Uint8Array.prototype.fill;
    let zeroFills = 0;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ) {
      if (value === 0 && this.length === 36) zeroFills += 1;
      return originalFill.call(this, value, start, end);
    };
    try {
      encodeNamespaceKeyring(fixtureKeyring());
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
    expect(zeroFills).toBe(2);
  });
});

describe("Namespace keyring lifecycle", () => {
  test("validates every envelope shape, revision/hash relation, and byte boundary", () => {
    const base = fixtureEnvelope();
    expect(() => assertNamespaceKeyringEnvelope(null as never))
      .toThrow("envelope must be an object");
    expect(() => assertNamespaceKeyringEnvelope("envelope" as never))
      .toThrow("envelope must be an object");
    expect(() =>
      assertNamespaceKeyringEnvelope({ ...base, extra: true } as never)
    ).toThrow("Namespace keyring envelope contains unknown field extra");
    expect(() =>
      assertNamespaceKeyringEnvelope({ ...base, formatVersion: 1 as 2 })
    ).toThrow("envelope version is unsupported");
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        keyClass: "management" as "human",
      })
    ).toThrow("Namespace key class is unsupported");
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        previousBindingHash: bytes(1, 31),
      })
    ).toThrow("Previous binding hash must contain exactly 32 bytes");
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        accessRevision: accessRevision(0),
      })
    ).toThrow("empty only at access revision zero");
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        previousBindingHash: null,
      })
    ).toThrow("empty only at access revision zero");
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        accessRevision: accessRevision(0),
        previousBindingHash: null,
      })
    ).not.toThrow();
    for (const ciphertext of [
      "ciphertext" as unknown as Uint8Array,
      bytes(1, 39),
      bytes(1, V2_LIMITS.namespaceKeyringBytes + 1),
    ]) {
      expect(() =>
        assertNamespaceKeyringEnvelope({ ...base, ciphertext })
      ).toThrow("ciphertext has an invalid length");
    }
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        ciphertext: bytes(1, V2_LIMITS.namespaceKeyringBytes),
      })
    ).not.toThrow();
    expect(() =>
      assertNamespaceKeyringEnvelope({
        ...base,
        signature: bytes(1, 63),
      })
    ).toThrow("Namespace keyring signature must contain exactly 64 bytes");
  });

  test("round-trips detached envelope bytes with and without a previous hash", () => {
    for (const original of [
      fixtureEnvelope(),
      {
        ...fixtureEnvelope(),
        accessRevision: accessRevision(0),
        previousBindingHash: null,
      },
    ]) {
      const wire = serializeNamespaceKeyringEnvelope(original);
      const parsed = parseNamespaceKeyringEnvelope(wire);
      expect(parsed).toEqual(original);
      const expected = structuredClone(parsed);
      original.previousBindingHash?.fill(0);
      original.ciphertext.fill(0);
      original.signature.fill(0);
      wire.fill(0);
      expect(parsed).toEqual(expected);
    }
  });

  test("locks envelope domain/purpose parsing and exact wire-size boundary", () => {
    const base = fixtureEnvelope();
    const minimum = serializeNamespaceKeyringEnvelope(base);
    expect(() =>
      parseNamespaceKeyringEnvelope(
        corruptText(minimum, NAMESPACE_KEYRING_DOMAIN),
      )
    ).toThrow("Namespace keyring envelope domain is unsupported");
    expect(() =>
      parseNamespaceKeyringEnvelope(
        corruptText(
          minimum,
          "namespace-keyring",
          4 + new TextEncoder().encode(NAMESPACE_KEYRING_DOMAIN).length,
        ),
      )
    ).toThrow("Namespace keyring envelope purpose is unsupported");

    const exactCiphertextLength =
      base.ciphertext.length
      + V2_LIMITS.namespaceKeyringBytes
      - minimum.length;
    const exact = {
      ...base,
      ciphertext: bytes(1, exactCiphertextLength),
    };
    const exactWire = serializeNamespaceKeyringEnvelope(exact);
    expect(exactWire).toHaveLength(V2_LIMITS.namespaceKeyringBytes);
    expect(parseNamespaceKeyringEnvelope(exactWire)).toEqual(exact);
    expect(() =>
      serializeNamespaceKeyringEnvelope({
        ...exact,
        ciphertext: bytes(1, exactCiphertextLength + 1),
      })
    ).toThrow("Namespace keyring envelope bytes");
    expect(() =>
      parseNamespaceKeyringEnvelope(
        new Uint8Array(V2_LIMITS.namespaceKeyringBytes + 1),
      )
    ).toThrow("Namespace keyring envelope exceeds the 256 KiB limit");
  });

  test("creates independent random generation zero keys", () => {
    let call = 0;
    const rng: Rng = {
      bytes(length) {
        call++;
        return bytes(call, length);
      },
    };
    const pair = createInitialNamespaceKeyrings(
      new LatticeCrypto(rng),
      namespaceId("ns_room"),
    );

    expect(call).toBe(2);
    expect(pair.human.keyClass).toBe("human");
    expect(pair.ai.keyClass).toBe("ai");
    expect(Number(pair.human.currentGeneration)).toBe(0);
    expect(Number(pair.ai.currentGeneration)).toBe(0);
    expect(hex(pair.human.generations[0]!.key)).toBe("01".repeat(32));
    expect(hex(pair.ai.generations[0]!.key)).toBe("02".repeat(32));
  });

  test("wipes each owned random Namespace-key temporary after cloning it", () => {
    const crypto = new CapturingRandomCrypto(seededRng(0x600d));
    const pair = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_random_wipe"),
    );

    expect(crypto.issuedRandomBytes).toHaveLength(2);
    expect(
      crypto.issuedRandomBytes.every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(
      pair.human.generations[0]!.key.some((byte) => byte !== 0),
    ).toBe(true);
    expect(pair.ai.generations[0]!.key.some((byte) => byte !== 0)).toBe(true);

    const appended = appendNamespaceGeneration(crypto, pair.human);
    expect(crypto.issuedRandomBytes).toHaveLength(3);
    expect(
      crypto.issuedRandomBytes[2]!.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      appended.generations[1]!.key.some((byte) => byte !== 0),
    ).toBe(true);
    expect(
      pair.human.generations[0]!.key.some((byte) => byte !== 0),
    ).toBe(true);
  });

  test("wipes the completed first keyring when second-keyring creation fails", () => {
    const crypto = new LatticeCrypto(seededRng(0x600e));
    let calls = 0;
    const issued: Uint8Array[] = [];
    crypto.randomBytes = (length) => {
      calls += 1;
      const value = Buffer.from(
        new Uint8Array(calls === 2 ? length - 1 : length).fill(calls),
      );
      issued.push(value);
      return value;
    };

    const captured = captureZeroizedBytes(() =>
      expect(() =>
        createInitialNamespaceKeyrings(
          crypto,
          namespaceId("ns_partial_initial"),
        )
      ).toThrow("Random Namespace key must contain exactly 32 bytes")
    );
    expect(calls).toBe(2);
    expect(
      issued.every((value) => value.every((byte) => byte === 0)),
    ).toBeTrue();
    expect(
      captured.zeroized.filter((value) => value.length === 32).length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("locks exact envelope AAD and ciphertext-digest signing bytes", () => {
    const envelope: NamespaceKeyringEnvelopeV2 = {
      formatVersion: 2,
      namespaceId: namespaceId("ns_room"),
      keyClass: "human",
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(2),
      accessRevision: accessRevision(3),
      currentGeneration: namespaceGeneration(4),
      previousBindingHash: bytes(0xaa),
      ciphertext: bytes(0xdd, 40),
      committerDeviceId: cryptoDeviceId("device_alice"),
      signature: bytes(0xee, 64),
    };
    const crypto = new LatticeCrypto(seededRng(1));

    expect(hex(namespaceKeyringEnvelopeAad(envelope))).toBe(
      "000000346e617574696c6f2f6c6174746963652d63727970746f2f6e616d6573706163652d6b657972696e672d656e76656c6f70652f7632" +
        "000000116e616d6573706163652d6b657972696e67" +
        "00000002" +
        "000000076e735f726f6f6d" +
        "0000000568756d616e" +
        "00000009646f6d61696e5f6162" +
        "0000000000000002" +
        "0000000000000003" +
        "0000000000000004" +
        `00000020${"aa".repeat(32)}` +
        "0000000c6465766963655f616c696365",
    );
    const signing = namespaceKeyringEnvelopeSigningBytes(envelope);
    expect(hex(signing.slice(0, -36))).toBe(
      hex(namespaceKeyringEnvelopeAad(envelope)),
    );
    expect(hex(signing.slice(-32))).toBe(
      hex(crypto.hash(envelope.ciphertext)),
    );
  });

  test("seals, verifies, and opens with historical roster authority", () => {
    const crypto = new LatticeCrypto(seededRng(0x1234));
    const signing = crypto.generateSigningKeyPair();
    const roots = { old: bytes(0x31), wrong: bytes(0x32) };
    const keyring = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_room"),
    ).human;
    const seenEpochs: number[] = [];
    const envelope = sealNamespaceKeyring({
      crypto,
      domainRoot: roots.old,
      keyring,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(2),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const wire = serializeNamespaceKeyringEnvelope(envelope);
    expect(
      serializeNamespaceKeyringEnvelope(
        parseNamespaceKeyringEnvelope(wire),
      ),
    ).toEqual(wire);
    expect(() =>
      parseNamespaceKeyringEnvelope(new Uint8Array([...wire, 0]))
    ).toThrow("trailing bytes");

    const opened = openNamespaceKeyring({
      crypto,
      domainRoot: roots.old,
      envelope,
      resolveHistoricalCommitter(context) {
        seenEpochs.push(Number(context.domainEpoch));
        return context.domainEpoch === 2 ? signing.publicKey : null;
      },
    });
    expect(seenEpochs).toEqual([2]);
    expect(opened.generations[0]?.key).toEqual(keyring.generations[0]?.key);
    expect(
      verifyNamespaceKeyringEnvelope({
        crypto,
        envelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }),
    ).toBe(true);
    expect(() =>
      verifyNamespaceKeyringEnvelope({
        crypto,
        envelope,
        resolveHistoricalCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      "Historical committer signing public key must contain exactly 32 bytes",
    );
    expect(() =>
      openNamespaceKeyring({
        crypto,
        domainRoot: bytes(1, 31),
        envelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("Domain root must contain exactly 32 bytes");
    expect(() =>
      openNamespaceKeyring({
        crypto,
        domainRoot: Array.from(roots.old) as never,
        envelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("Domain root must contain exactly 32 bytes");

    expect(() =>
      openNamespaceKeyring({
        crypto,
        domainRoot: roots.wrong,
        envelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("decrypt");
    expect(() =>
      openNamespaceKeyring({
        crypto,
        domainRoot: roots.old,
        envelope: { ...envelope, domainEpoch: domainEpoch(3) },
        resolveHistoricalCommitter: () => signing.publicKey,
      })
    ).toThrow("signature");
    expect(() =>
      openNamespaceKeyring({
        crypto,
        domainRoot: roots.old,
        envelope,
        resolveHistoricalCommitter: () => null,
      })
    ).toThrow("historical roster");

    for (const substituted of [
      { ...envelope, namespaceId: namespaceId("ns_other") },
      { ...envelope, keyClass: "ai" as const },
      { ...envelope, domainId: cryptoDomainId("domain_ac") },
      {
        ...envelope,
        accessRevision: accessRevision(1),
        previousBindingHash: bytes(0x88),
      },
      {
        ...envelope,
        currentGeneration: namespaceGeneration(1),
      },
      { ...envelope, committerDeviceId: cryptoDeviceId("device_bob") },
      {
        ...envelope,
        ciphertext: new Uint8Array(envelope.ciphertext).fill(0x99),
      },
      { ...envelope, signature: bytes(0x77, 64) },
    ]) {
      expect(() =>
        openNamespaceKeyring({
          crypto,
          domainRoot: roots.old,
          envelope: substituted,
          resolveHistoricalCommitter: () => signing.publicKey,
        })
      ).toThrow("signature");
    }
  });

  test("zeroizes the temporary decrypted keyring plaintext", () => {
    const crypto = new LatticeCrypto(seededRng(0x1235));
    const signing = crypto.generateSigningKeyPair();
    const root = bytes(0x31);
    const keyring = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_room"),
    ).human;
    const envelope = sealNamespaceKeyring({
      crypto,
      domainRoot: root,
      keyring,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(2),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    let temporaryPlaintext: Uint8Array | null = null;
    const originalOpen = crypto.aeadOpen.bind(crypto);
    crypto.aeadOpen = (...args) => {
      temporaryPlaintext = originalOpen(...args);
      return temporaryPlaintext;
    };

    const opened = openNamespaceKeyring({
      crypto,
      domainRoot: root,
      envelope,
      resolveHistoricalCommitter: () => signing.publicKey,
    });
    expect(opened).toEqual(keyring);
    expect(temporaryPlaintext).not.toBeNull();
    expect(
      temporaryPlaintext!.every((byte) => byte === 0),
    ).toBe(true);
  });

  test("zeroizes encoded keyring plaintext when AEAD sealing throws", () => {
    const crypto = new LatticeCrypto(seededRng(0x1236));
    const signing = crypto.generateSigningKeyPair();
    const root = bytes(0x31);
    const keyring = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_seal_failure"),
    ).human;
    const callerKey = keyring.generations[0]!.key.slice();
    const callerRoot = root.slice();
    const callerPrivateKey = signing.privateKey.slice();
    let encodedPlaintext: Uint8Array | null = null;
    crypto.aeadSeal = (_key, plaintext) => {
      encodedPlaintext = plaintext;
      throw new Error("injected AEAD failure");
    };

    expect(() =>
      sealNamespaceKeyring({
        crypto,
        domainRoot: root,
        keyring,
        metadata: {
          domainId: cryptoDomainId("domain_ab"),
          domainEpoch: domainEpoch(2),
          previousBindingHash: null,
          committerDeviceId: cryptoDeviceId("device_alice"),
        },
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => signing.publicKey,
      })
    ).toThrow("injected AEAD failure");
    expect(encodedPlaintext).not.toBeNull();
    expect(
      encodedPlaintext!.every((byte) => byte === 0),
    ).toBe(true);
    expect(keyring.generations[0]!.key).toEqual(callerKey);
    expect(root).toEqual(callerRoot);
    expect(signing.privateKey).toEqual(callerPrivateKey);
  });

  test("owns Namespace envelope ciphertext returned by the crypto provider", () => {
    const crypto = new LatticeCrypto(seededRng(0x1237));
    const signing = crypto.generateSigningKeyPair();
    const providerCiphertext = Buffer.alloc(40, 0xc7);
    crypto.aeadSeal = () => providerCiphertext;
    const keyring = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_provider_ciphertext"),
    ).human;

    const envelope = sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x31),
      keyring,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(2),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });

    expect(envelope.ciphertext).not.toBe(providerCiphertext);
    expect(Buffer.isBuffer(envelope.ciphertext)).toBe(false);
    providerCiphertext.fill(0);
    expect(envelope.ciphertext).toEqual(new Uint8Array(40).fill(0xc7));
  });

  test("rejects a correctly signed envelope with mismatched inner metadata", () => {
    const crypto = new LatticeCrypto(seededRng(0x4567));
    const signing = crypto.generateSigningKeyPair();
    const root = bytes(0x61);
    const initialKeyrings = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_actual"),
    );
    const actualKeyring = initialKeyrings.human;
    const outer: NamespaceKeyringEnvelopeV2 = {
      formatVersion: 2,
      namespaceId: namespaceId("ns_claimed"),
      keyClass: "human",
      domainId: cryptoDomainId("domain_ab"),
      domainEpoch: domainEpoch(0),
      accessRevision: accessRevision(0),
      currentGeneration: namespaceGeneration(0),
      previousBindingHash: null,
      ciphertext: bytes(0, 40),
      committerDeviceId: cryptoDeviceId("device_alice"),
      signature: bytes(0, 64),
    };
    const ciphertext = crypto.aeadSeal(
      root,
      encodeNamespaceKeyring(actualKeyring),
      namespaceKeyringEnvelopeAad(outer),
    );
    const withCiphertext = { ...outer, ciphertext };
    const malformed: NamespaceKeyringEnvelopeV2 = {
      ...withCiphertext,
      signature: crypto.sign(
        signing.privateKey,
        namespaceKeyringEnvelopeSigningBytes(withCiphertext),
      ),
    };
    const originalOpen = crypto.aeadOpen.bind(crypto);
    crypto.aeadOpen = (...args) => {
      const plaintext = originalOpen(...args);
      return plaintext === null ? null : Buffer.from(plaintext);
    };
    const failedOpen = captureZeroizedBytes(() =>
      expect(() => openNamespaceKeyring({
        crypto,
        domainRoot: root,
        envelope: malformed,
        resolveHistoricalCommitter: () => signing.publicKey,
      })).toThrow("inner and outer")
    );
    const rejectedDecodedKeys = failedOpen.zeroized.filter(
      (value) => value.length === 32,
    );
    expect(rejectedDecodedKeys).toHaveLength(5);
    expect(
      rejectedDecodedKeys.every((value) =>
        value.every((byte) => byte === 0)
      ),
    ).toBe(true);

    const mismatches: readonly [
      NamespaceKeyringPlaintextV2,
      Partial<NamespaceKeyringEnvelopeV2>,
    ][] = [
      [initialKeyrings.ai, { namespaceId: namespaceId("ns_actual") }],
      [
        { ...actualKeyring, accessRevision: accessRevision(1) },
        { namespaceId: namespaceId("ns_actual") },
      ],
      [
        actualKeyring,
        {
          namespaceId: namespaceId("ns_actual"),
          currentGeneration: namespaceGeneration(1),
        },
      ],
    ];
    for (const [inner, overrides] of mismatches) {
      const unsignedOuter: NamespaceKeyringEnvelopeV2 = {
        ...outer,
        ...overrides,
      };
      const innerCiphertext = crypto.aeadSeal(
        root,
        encodeNamespaceKeyring(inner),
        namespaceKeyringEnvelopeAad(unsignedOuter),
      );
      const unsigned = { ...unsignedOuter, ciphertext: innerCiphertext };
      const signed = {
        ...unsigned,
        signature: crypto.sign(
          signing.privateKey,
          namespaceKeyringEnvelopeSigningBytes(unsigned),
        ),
      };
      expect(() =>
        openNamespaceKeyring({
          crypto,
          domainRoot: root,
          envelope: signed,
          resolveHistoricalCommitter: () => signing.publicKey,
        })
      ).toThrow("inner and outer");
    }
  });

  test("refuses an unauthorized current committer before sealing", () => {
    const crypto = new LatticeCrypto(seededRng(8));
    const signing = crypto.generateSigningKeyPair();
    const otherSigning = crypto.generateSigningKeyPair();
    const keyring = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_room"),
    ).ai;
    expect(() =>
      sealNamespaceKeyring({
        crypto,
        domainRoot: bytes(0x41),
        keyring,
        metadata: {
          domainId: cryptoDomainId("domain_ab"),
          domainEpoch: domainEpoch(0),
          previousBindingHash: null,
          committerDeviceId: cryptoDeviceId("revoked_device"),
        },
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => null,
      })
    ).toThrow("current committer");
    expect(() =>
      sealNamespaceKeyring({
        crypto,
        domainRoot: bytes(0x41),
        keyring,
        metadata: {
          domainId: cryptoDomainId("domain_ab"),
          domainEpoch: domainEpoch(0),
          previousBindingHash: null,
          committerDeviceId: cryptoDeviceId("device_alice"),
        },
        committerSigningPrivateKey: signing.privateKey,
        resolveCurrentCommitter: () => otherSigning.publicKey,
      })
    ).toThrow("does not match");
  });

  test("reseals complete history and optionally rotates independently", () => {
    const crypto = new LatticeCrypto(seededRng(0x3344));
    const oldSigning = crypto.generateSigningKeyPair();
    const initial = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_room"),
    ).human;
    const oldEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x51),
      keyring: initial,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(1),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: oldSigning.privateKey,
      resolveCurrentCommitter: () => oldSigning.publicKey,
    });

    const nextEnvelope = resealNamespaceKeyring({
      crypto,
      oldDomainRoot: bytes(0x51),
      oldEnvelope,
      resolveHistoricalCommitter: () => oldSigning.publicKey,
      newDomainRoot: bytes(0x52),
      newMetadata: {
        domainId: cryptoDomainId("domain_abc"),
        domainEpoch: domainEpoch(4),
        accessRevision: accessRevision(1),
        previousBindingHash: bytes(0xa1),
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      newCommitterSigningPrivateKey: oldSigning.privateKey,
      resolveSourceCommitter: () => oldSigning.publicKey,
      resolveCurrentCommitter: () => oldSigning.publicKey,
      rotateGeneration: true,
    });
    const opened = openNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x52),
      envelope: nextEnvelope,
      resolveHistoricalCommitter: () => oldSigning.publicKey,
    });

    expect(opened.generations).toHaveLength(2);
    expect(Number(opened.generations[0]!.generation)).toBe(0);
    expect(Number(opened.generations[1]!.generation)).toBe(1);
    expect(opened.generations[0]!.key).toEqual(initial.generations[0]!.key);
    expect(Number(opened.accessRevision)).toBe(1);
  });

  test("wipes opened and revised keyring generations after resealing", () => {
    const crypto = new LatticeCrypto(seededRng(0x3345));
    const signing = crypto.generateSigningKeyPair();
    const oldRoot = bytes(0x51);
    const newRoot = bytes(0x52);
    const initial = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_reseal_wipe"),
    ).human;
    const oldEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: oldRoot,
      keyring: initial,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(1),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const callerKey = initial.generations[0]!.key.slice();
    const zeroizedKeys: Array<{
      readonly before: Uint8Array;
      readonly target: Uint8Array;
    }> = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      const before = this.slice();
      const result = originalFill.call(this, value, start, end);
      if (value === 0 && this.length === 32) {
        zeroizedKeys.push({ before, target: this });
      }
      return result;
    };
    let nextEnvelope: NamespaceKeyringEnvelopeV2;
    try {
      nextEnvelope = resealNamespaceKeyring({
        crypto,
        oldDomainRoot: oldRoot,
        oldEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
        newDomainRoot: newRoot,
        newMetadata: {
          domainId: cryptoDomainId("domain_abc"),
          domainEpoch: domainEpoch(2),
          accessRevision: accessRevision(1),
          previousBindingHash: bytes(0xa1),
          committerDeviceId: cryptoDeviceId("device_alice"),
        },
        newCommitterSigningPrivateKey: signing.privateKey,
        resolveSourceCommitter: () => signing.publicKey,
        resolveCurrentCommitter: () => signing.publicKey,
        rotateGeneration: true,
      });
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }

    // The decoded key, appended-keyring clone, retained revision
    // intermediate, and final revision are four distinct owned copies.
    expect(
      zeroizedKeys.filter(({ before }) =>
        before.every((byte, index) => byte === callerKey[index])
      ),
    ).toHaveLength(4);
    expect(
      zeroizedKeys.every(({ target }) =>
        target.every((byte) => byte === 0)
      ),
    ).toBe(true);
    expect(initial.generations[0]!.key).toEqual(callerKey);
    expect(oldRoot).toEqual(bytes(0x51));
    expect(newRoot).toEqual(bytes(0x52));
    expect(signing.privateKey.some((byte) => byte !== 0)).toBe(true);
    expect(
      openNamespaceKeyring({
        crypto,
        domainRoot: newRoot,
        envelope: nextEnvelope,
        resolveHistoricalCommitter: () => signing.publicKey,
      }).generations,
    ).toHaveLength(2);
  });

  test("rejects an unauthorized reseal before consuming rotation randomness", () => {
    let rngCalls = 0;
    const rng: Rng = {
      bytes(length) {
        rngCalls++;
        return new Uint8Array(length).fill(rngCalls);
      },
    };
    const crypto = new LatticeCrypto(rng);
    const oldSigning = crypto.generateSigningKeyPair();
    const newSigning = crypto.generateSigningKeyPair();
    const initial = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_room"),
    ).human;
    const oldEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x71),
      keyring: initial,
      metadata: {
        domainId: cryptoDomainId("domain_ab"),
        domainEpoch: domainEpoch(0),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_alice"),
      },
      committerSigningPrivateKey: oldSigning.privateKey,
      resolveCurrentCommitter: () => oldSigning.publicKey,
    });
    const callsBeforeReseal = rngCalls;

    expect(() =>
      resealNamespaceKeyring({
        crypto,
        oldDomainRoot: bytes(0x71),
        oldEnvelope,
        resolveHistoricalCommitter: () => oldSigning.publicKey,
        newDomainRoot: bytes(0x72),
        newMetadata: {
          domainId: cryptoDomainId("domain_abc"),
          domainEpoch: domainEpoch(1),
          accessRevision: accessRevision(1),
          previousBindingHash: bytes(0x81),
          committerDeviceId: cryptoDeviceId("revoked_device"),
        },
        newCommitterSigningPrivateKey: newSigning.privateKey,
        resolveSourceCommitter: () => newSigning.publicKey,
        resolveCurrentCommitter: () => null,
        rotateGeneration: true,
      })
    ).toThrow("current committer");
    expect(rngCalls).toBe(callsBeforeReseal);

    expect(() =>
      resealNamespaceKeyring({
        crypto,
        oldDomainRoot: bytes(0x71),
        oldEnvelope,
        resolveHistoricalCommitter: () => oldSigning.publicKey,
        newDomainRoot: bytes(0x72),
        newMetadata: {
          domainId: cryptoDomainId("domain_abc"),
          domainEpoch: domainEpoch(1),
          accessRevision: accessRevision(1),
          previousBindingHash: bytes(0x81),
          committerDeviceId: cryptoDeviceId("target_only_device"),
        },
        newCommitterSigningPrivateKey: newSigning.privateKey,
        resolveSourceCommitter: () => null,
        resolveCurrentCommitter: () => newSigning.publicKey,
        rotateGeneration: true,
      })
    ).toThrow("source context");
    expect(rngCalls).toBe(callsBeforeReseal);
  });

  test("owns every retained key buffer and reports random-key width exactly", () => {
    const issued: Uint8Array[] = [];
    const crypto = new LatticeCrypto({
      bytes(length) {
        const value = bytes(issued.length + 1, length);
        issued.push(value);
        return value;
      },
    });
    const initial = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_owned"),
    );
    const humanKey = initial.human.generations[0]!.key.slice();
    const aiKey = initial.ai.generations[0]!.key.slice();
    issued[0]!.fill(0);
    issued[1]!.fill(0);
    expect(initial.human.generations[0]!.key).toEqual(humanKey);
    expect(initial.ai.generations[0]!.key).toEqual(aiKey);

    const appended = appendNamespaceGeneration(crypto, initial.human);
    const retained = appended.generations[0]!.key.slice();
    const fresh = appended.generations[1]!.key.slice();
    initial.human.generations[0]!.key.fill(0);
    issued[2]!.fill(0);
    expect(appended.generations[0]!.key).toEqual(retained);
    expect(appended.generations[1]!.key).toEqual(fresh);

    const shortRandom = new LatticeCrypto(seededRng(0x9130));
    shortRandom.randomBytes = () => new Uint8Array(31);
    expect(() =>
      createInitialNamespaceKeyrings(
        shortRandom,
        namespaceId("ns_short_initial"),
      )
    ).toThrow("Random Namespace key must contain exactly 32 bytes");
    expect(() =>
      appendNamespaceGeneration(shortRandom, fixtureKeyring())
    ).toThrow("Random Namespace key must contain exactly 32 bytes");
  });

  test("binds exact current-committer context and validates seal key material", () => {
    const crypto = new LatticeCrypto(seededRng(0x9123));
    const signing = crypto.generateSigningKeyPair();
    const keyring = fixtureKeyring();
    const previousBindingHash = bytes(0x91);
    const seen: unknown[] = [];
    const input = {
      crypto,
      domainRoot: bytes(0x51),
      keyring,
      metadata: {
        domainId: cryptoDomainId("domain_context"),
        domainEpoch: domainEpoch(8),
        previousBindingHash,
        committerDeviceId: cryptoDeviceId("device_context"),
      },
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter(context: unknown) {
        seen.push(context);
        return signing.publicKey;
      },
    } as const;
    const envelope = sealNamespaceKeyring(input);

    expect(seen).toEqual([{
      purpose: "namespace-keyring-envelope",
      namespaceId: keyring.namespaceId,
      domainId: input.metadata.domainId,
      domainEpoch: input.metadata.domainEpoch,
      accessRevision: keyring.accessRevision,
      committerDeviceId: input.metadata.committerDeviceId,
      previousBindingHash: bytes(0x91),
    }]);
    previousBindingHash.fill(0);
    expect(envelope.previousBindingHash).toEqual(bytes(0x91));

    for (const domainRoot of [null as never, bytes(1, 31)]) {
      expect(() =>
        sealNamespaceKeyring({ ...input, domainRoot })
      ).toThrow("Domain root must contain exactly 32 bytes");
    }
    for (const committerSigningPrivateKey of [
      null as never,
      bytes(1, V2_LIMITS.signingPrivateKeyBytes - 1),
    ]) {
      expect(() =>
        sealNamespaceKeyring({
          ...input,
          committerSigningPrivateKey,
        })
      ).toThrow(
        `Committer signing private key must contain exactly ${V2_LIMITS.signingPrivateKeyBytes} bytes`,
      );
    }
    expect(() =>
      sealNamespaceKeyring({
        ...input,
        metadata: {
          ...input.metadata,
          previousBindingHash: bytes(1, 31),
        },
        resolveCurrentCommitter: () => {
          throw new Error("resolver must not run");
        },
      })
    ).toThrow("Previous binding hash must contain exactly 32 bytes");
    expect(() =>
      sealNamespaceKeyring({
        ...input,
        resolveCurrentCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      "Current committer signing public key must contain exactly 32 bytes",
    );

    const sharedSignatureCrypto = new SharedSignatureCrypto(
      seededRng(0x9124),
    );
    const sharedSigning = sharedSignatureCrypto.generateSigningKeyPair();
    const detachedEnvelope = sealNamespaceKeyring({
      ...input,
      crypto: sharedSignatureCrypto,
      committerSigningPrivateKey: sharedSigning.privateKey,
      resolveCurrentCommitter: () => sharedSigning.publicKey,
    });
    const expectedSignature = detachedEnvelope.signature.slice();
    sharedSignatureCrypto.issuedSignature!.fill(0);
    expect(detachedEnvelope.signature).toEqual(expectedSignature);
  });

  test("prepares exactly one detached revision and compares every keyring field", () => {
    const crypto = new LatticeCrypto(seededRng(0x9234));
    const base = fixtureKeyring();
    const unchangedGeneration = prepareNamespaceKeyringRevision(
      crypto,
      base,
      4,
      false,
    );
    expect(Number(unchangedGeneration.accessRevision)).toBe(4);
    expect(unchangedGeneration.currentGeneration).toBe(
      base.currentGeneration,
    );
    expect(unchangedGeneration.generations).toEqual(base.generations);
    expect(unchangedGeneration.generations).not.toBe(base.generations);
    expect(unchangedGeneration.generations[0]!.key).not.toBe(
      base.generations[0]!.key,
    );
    for (const revision of [3, 5]) {
      expect(() =>
        prepareNamespaceKeyringRevision(
          crypto,
          base,
          revision,
          false,
        )
      ).toThrow(
        "Namespace keyring reseal must advance access revision exactly once",
      );
    }

    expect(namespaceKeyringsEqual(base, structuredClone(base))).toBe(true);
    const variants: NamespaceKeyringPlaintextV2[] = [
      { ...base, namespaceId: namespaceId("ns_other") },
      { ...base, keyClass: "ai" },
      { ...base, accessRevision: accessRevision(4) },
      {
        ...base,
        currentGeneration: namespaceGeneration(0),
      },
      {
        ...base,
        generations: [base.generations[0]!],
      },
      {
        ...base,
        generations: [
          ...base.generations,
          {
            generation: namespaceGeneration(2),
            key: bytes(0x33),
          },
        ],
      },
      {
        ...base,
        generations: [
          { ...base.generations[0]!, generation: namespaceGeneration(7) },
          base.generations[1]!,
        ],
      },
      {
        ...base,
        generations: [
          { ...base.generations[0]!, key: bytes(0x99) },
          base.generations[1]!,
        ],
      },
      {
        ...base,
        generations: [
          { ...base.generations[0]!, key: bytes(0x11, 31) },
          base.generations[1]!,
        ],
      },
    ];
    for (const variant of variants) {
      expect(namespaceKeyringsEqual(base, variant)).toBe(false);
    }
    const shorterLeft: NamespaceKeyringPlaintextV2 = {
      ...base,
      generations: [
        { ...base.generations[0]!, key: bytes(0x11, 31) },
        base.generations[1]!,
      ],
    };
    expect(namespaceKeyringsEqual(shorterLeft, base)).toBe(false);
    const partlyDifferentKey = base.generations[0]!.key.slice();
    partlyDifferentKey[partlyDifferentKey.length - 1] =
      partlyDifferentKey[partlyDifferentKey.length - 1]! ^ 1;
    expect(namespaceKeyringsEqual(base, {
      ...base,
      generations: [
        { ...base.generations[0]!, key: partlyDifferentKey },
        base.generations[1]!,
      ],
    })).toBe(false);
  });

  test("binds exact source and target reseal authority and rejects key mismatch", () => {
    const crypto = new LatticeCrypto(seededRng(0x9345));
    const signing = crypto.generateSigningKeyPair();
    const otherSigning = crypto.generateSigningKeyPair();
    const initial = createInitialNamespaceKeyrings(
      crypto,
      namespaceId("ns_reseal_context"),
    ).human;
    const oldEnvelope = sealNamespaceKeyring({
      crypto,
      domainRoot: bytes(0x61),
      keyring: initial,
      metadata: {
        domainId: cryptoDomainId("domain_old"),
        domainEpoch: domainEpoch(3),
        previousBindingHash: null,
        committerDeviceId: cryptoDeviceId("device_context"),
      },
      committerSigningPrivateKey: signing.privateKey,
      resolveCurrentCommitter: () => signing.publicKey,
    });
    const previousBindingHash = bytes(0x92);
    const sourceContexts: unknown[] = [];
    const targetContexts: unknown[] = [];
    const resealInput = {
      crypto,
      oldDomainRoot: bytes(0x61),
      oldEnvelope,
      resolveHistoricalCommitter: () => signing.publicKey,
      newDomainRoot: bytes(0x62),
      newMetadata: {
        domainId: cryptoDomainId("domain_new"),
        domainEpoch: domainEpoch(9),
        accessRevision: accessRevision(1),
        previousBindingHash,
        committerDeviceId: cryptoDeviceId("device_context"),
      },
      newCommitterSigningPrivateKey: signing.privateKey,
      resolveSourceCommitter(context: unknown) {
        sourceContexts.push(context);
        return signing.publicKey;
      },
      resolveCurrentCommitter(context: unknown) {
        targetContexts.push(context);
        return signing.publicKey;
      },
      rotateGeneration: false,
    } as const;
    resealNamespaceKeyring(resealInput);

    expect(sourceContexts).toEqual([{
      purpose: "namespace-keyring-envelope",
      namespaceId: initial.namespaceId,
      domainId: oldEnvelope.domainId,
      domainEpoch: oldEnvelope.domainEpoch,
      accessRevision: oldEnvelope.accessRevision,
      committerDeviceId: resealInput.newMetadata.committerDeviceId,
      previousBindingHash: bytes(0x92),
    }]);
    expect(targetContexts).toEqual([{
      purpose: "namespace-keyring-envelope",
      namespaceId: initial.namespaceId,
      domainId: resealInput.newMetadata.domainId,
      domainEpoch: resealInput.newMetadata.domainEpoch,
      accessRevision: resealInput.newMetadata.accessRevision,
      committerDeviceId: resealInput.newMetadata.committerDeviceId,
      previousBindingHash: bytes(0x92),
    }]);
    previousBindingHash.fill(0);
    expect(
      (
        sourceContexts[0] as {
          readonly previousBindingHash: Uint8Array;
        }
      ).previousBindingHash,
    ).toEqual(bytes(0x92));
    expect(
      (
        targetContexts[0] as {
          readonly previousBindingHash: Uint8Array;
        }
      ).previousBindingHash,
    ).toEqual(bytes(0x92));

    expect(() =>
      resealNamespaceKeyring({
        ...resealInput,
        resolveSourceCommitter: () => signing.publicKey,
        resolveCurrentCommitter: () => otherSigning.publicKey,
      })
    ).toThrow(
      "Namespace keyring transition committer differs between source and target contexts",
    );
    expect(() =>
      resealNamespaceKeyring({
        ...resealInput,
        resolveSourceCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      "Source committer signing public key must contain exactly 32 bytes",
    );
    expect(() =>
      resealNamespaceKeyring({
        ...resealInput,
        resolveCurrentCommitter: () => bytes(1, 31),
      })
    ).toThrow(
      "Current committer signing public key must contain exactly 32 bytes",
    );
    expect(() =>
      resealNamespaceKeyring({
        ...resealInput,
        newMetadata: {
          ...resealInput.newMetadata,
          previousBindingHash: null,
        },
      })
    ).toThrow(
      "Previous binding hash must be empty only at access revision zero",
    );
  });
});

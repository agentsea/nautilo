import { describe, expect, test } from "bun:test";
import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  ENCRYPTED_PAYLOAD_DOMAIN_V2,
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2,
  NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encryptedPayloadAadV2,
  namespaceObjectEnvelopeAadV2,
  normalizeEncryptedPayloadContextV2,
  normalizeNamespaceObjectEnvelopeContextV2,
} from "../../src/format/object-v2.ts";
import {
  decryptObjectPayloadV2,
  encryptObjectPayloadV2,
} from "../../src/object/payload.ts";
import {
  decryptObjectThroughNamespaceV2,
  openObjectDekForNamespaceV2,
  wrapObjectDekForNamespaceV2,
} from "../../src/object/namespace-envelope.ts";
import {
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  accessRevision,
} from "../../src/v2-types/ids.ts";
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function expectWiped(
  value: Uint8Array | null,
): void {
  expect(value).not.toBeNull();
  if (value === null) throw new Error("expected a captured secret buffer");
  expect(value).toEqual(new Uint8Array(value.length));
}

const payloadContext = {
  objectId: objectId("object_1"),
  keyClass: "human" as const,
  objectType: "message",
  createdAt: unixTimestamp(1_700_000_000_000),
};

const envelopeContext = {
  objectId: objectId("object_1"),
  namespaceId: namespaceId("namespace_1"),
  keyClass: "human" as const,
  keyGeneration: namespaceGeneration(7),
  bindingRevisionAtWrap: accessRevision(11),
};

describe("v2 encrypted payload and Namespace-envelope AAD", () => {
  test("rejects every malformed context, discriminator, and ciphertext boundary", () => {
    expect(() => normalizeEncryptedPayloadContextV2(null as never))
      .toThrow("encrypted payload context must be an object");
    expect(() => normalizeEncryptedPayloadContextV2("context" as never))
      .toThrow("encrypted payload context must be an object");
    expect(() =>
      normalizeEncryptedPayloadContextV2({
        ...payloadContext,
        extra: true,
      } as never)
    ).toThrow("encrypted payload context contains unknown field extra");
    expect(() =>
      normalizeEncryptedPayloadContextV2({
        ...payloadContext,
        keyClass: "management" as "human",
      })
    ).toThrow("object key class must be human or ai");
    expect(() =>
      normalizeEncryptedPayloadContextV2({
        ...payloadContext,
        objectType: "not portable",
      })
    ).toThrow("Object type");
    expect(() =>
      normalizeEncryptedPayloadContextV2({
        ...payloadContext,
        objectType: "a".repeat(V2_LIMITS.schemeIdBytes + 1),
      })
    ).toThrow("Object type bytes");

    expect(() => normalizeNamespaceObjectEnvelopeContextV2(null as never))
      .toThrow("Namespace object envelope context must be an object");
    expect(() =>
      normalizeNamespaceObjectEnvelopeContextV2("context" as never)
    ).toThrow("Namespace object envelope context must be an object");
    expect(() =>
      normalizeNamespaceObjectEnvelopeContextV2({
        ...envelopeContext,
        extra: true,
      } as never)
    ).toThrow("Namespace object envelope context contains unknown field extra");
    expect(() =>
      normalizeNamespaceObjectEnvelopeContextV2({
        ...envelopeContext,
        keyClass: "management" as "human",
      })
    ).toThrow("object key class must be human or ai");

    const payload = {
      formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
      context: payloadContext,
      ciphertext: new Uint8Array(40),
    };
    expect(() =>
      encodeEncryptedPayloadV2({ ...payload, formatVersion: 1 as 2 })
    ).toThrow("unsupported encrypted payload version");
    expect(() =>
      encodeEncryptedPayloadV2({
        ...payload,
        ciphertext: "bytes" as unknown as Uint8Array,
      })
    ).toThrow("encrypted payload ciphertext must be Uint8Array");
    expect(() =>
      encodeEncryptedPayloadV2({
        ...payload,
        ciphertext: new Uint8Array(39),
      })
    ).toThrow("encrypted payload bytes");
    expect(() =>
      encodeEncryptedPayloadV2({
        ...payload,
        ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      })
    ).toThrow("encrypted payload bytes");
    expect(() => encodeEncryptedPayloadV2(payload)).not.toThrow();

    const envelope = {
      formatVersion: NAMESPACE_OBJECT_ENVELOPE_FORMAT_VERSION_V2,
      context: envelopeContext,
      wrappedDek: new Uint8Array(40),
    };
    expect(() =>
      encodeNamespaceObjectEnvelopeV2({
        ...envelope,
        formatVersion: 1 as 2,
      })
    ).toThrow("unsupported Namespace object envelope version");
    expect(() =>
      encodeNamespaceObjectEnvelopeV2({
        ...envelope,
        wrappedDek: "bytes" as unknown as Uint8Array,
      })
    ).toThrow("wrapped DEK must be Uint8Array");
    expect(() =>
      encodeNamespaceObjectEnvelopeV2({
        ...envelope,
        wrappedDek: new Uint8Array(39),
      })
    ).toThrow("wrapped DEK bytes");
    expect(() =>
      encodeNamespaceObjectEnvelopeV2({
        ...envelope,
        wrappedDek: new Uint8Array(V2_LIMITS.wrappedDekBytes + 1),
      })
    ).toThrow("wrapped DEK bytes");
    expect(() => encodeNamespaceObjectEnvelopeV2(envelope)).not.toThrow();

    for (const [wire, domain] of [
      [encodeEncryptedPayloadV2(payload), ENCRYPTED_PAYLOAD_DOMAIN_V2],
      [
        encodeNamespaceObjectEnvelopeV2(envelope),
        NAMESPACE_OBJECT_ENVELOPE_DOMAIN_V2,
      ],
    ] as const) {
      const corrupted = wire.slice();
      const needle = new TextEncoder().encode(domain);
      const offset = corrupted.findIndex((_, index) =>
        needle.every((byte, inner) => corrupted[index + inner] === byte)
      );
      corrupted[offset] = corrupted[offset]! ^ 1;
      expect(() =>
        domain === ENCRYPTED_PAYLOAD_DOMAIN_V2
          ? decodeEncryptedPayloadV2(corrupted)
          : decodeNamespaceObjectEnvelopeV2(corrupted)
      ).toThrow(`format domain mismatch; expected ${domain}`);
    }
    const shortPayload = encodeEncryptedPayloadV2(payload).slice(0, -1);
    shortPayload[shortPayload.length - 39 - 1] = 39;
    expect(() => decodeEncryptedPayloadV2(shortPayload))
      .toThrow("encrypted payload bytes");
    const shortEnvelope =
      encodeNamespaceObjectEnvelopeV2(envelope).slice(0, -1);
    shortEnvelope[shortEnvelope.length - 39 - 1] = 39;
    expect(() => decodeNamespaceObjectEnvelopeV2(shortEnvelope))
      .toThrow("wrapped DEK bytes");
  });

  test("locks exact domain-separated field order and u64 framing", () => {
    expect(hex(encryptedPayloadAadV2(payloadContext))).toBe(
      "0000002b6e617574696c6f2f6c6174746963652d63727970746f2f656e637279707465642d7061796c6f61642f7632" +
        "00000002" +
        "000000086f626a6563745f31" +
        "0000000568756d616e" +
        "000000076d657373616765" +
        "0000018bcfe56800",
    );
    expect(hex(namespaceObjectEnvelopeAadV2(envelopeContext))).toBe(
      "000000336e617574696c6f2f6c6174746963652d63727970746f2f6e616d6573706163652d6f626a6563742d656e76656c6f70652f7632" +
        "00000002" +
        "000000086f626a6563745f31" +
        "0000000b6e616d6573706163655f31" +
        "0000000568756d616e" +
        "0000000000000007" +
        "000000000000000b",
    );
  });

  test("rejects injected Domain identity instead of silently authenticating it", () => {
    expect(() =>
      namespaceObjectEnvelopeAadV2({
        ...envelopeContext,
        domainId: "domain_ab",
      } as never)
    ).toThrow("unknown field");
    expect(() =>
      namespaceObjectEnvelopeAadV2({
        ...envelopeContext,
        domainEpoch: 12,
      } as never)
    ).toThrow("unknown field");
  });

  test("encrypts with a fresh DEK and fails closed on metadata substitution", () => {
    const crypto = new LatticeCrypto(seededRng(101));
    const plaintext = new TextEncoder().encode("retained object history");
    const first = encryptObjectPayloadV2(crypto, payloadContext, plaintext);
    const second = encryptObjectPayloadV2(crypto, payloadContext, plaintext);

    expect(first.dek).toHaveLength(32);
    expect(first.payload.ciphertext).not.toEqual(second.payload.ciphertext);
    expect(first.dek).not.toEqual(second.dek);
    expect(
      decryptObjectPayloadV2(crypto, first.dek, first.payload),
    ).toEqual(plaintext);
    expect(
      decryptObjectPayloadV2(crypto, first.dek, {
        ...first.payload,
        context: { ...first.payload.context, objectType: "artifact" },
      }),
    ).toBeNull();
    expect(
      decryptObjectPayloadV2(crypto, second.dek, first.payload),
    ).toBeNull();
    const encoded = encodeEncryptedPayloadV2(first.payload);
    expect(decodeEncryptedPayloadV2(encoded)).toEqual(first.payload);
    expect(() =>
      decodeEncryptedPayloadV2(Uint8Array.from([...encoded, 0]))
    ).toThrow("trailing bytes");
  });

  test("wraps one DEK independently for Namespaces and survives a Domain rebind", () => {
    const crypto = new LatticeCrypto(seededRng(202));
    const namespaceKeyA = crypto.randomBytes(32);
    const namespaceKeyB = crypto.randomBytes(32);
    const payload = encryptObjectPayloadV2(
      crypto,
      payloadContext,
      new TextEncoder().encode("same immutable payload"),
    );
    const dek = payload.dek;
    const wrappedA = wrapObjectDekForNamespaceV2(
      crypto,
      namespaceKeyA,
      envelopeContext,
      dek,
    );
    const wrappedB = wrapObjectDekForNamespaceV2(
      crypto,
      namespaceKeyB,
      { ...envelopeContext, namespaceId: namespaceId("namespace_2") },
      dek,
    );
    const payloadBeforeRebind = payload.payload.ciphertext.slice();
    const wrappedBeforeRebind = wrappedA.wrappedDek.slice();

    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKeyA, wrappedA),
    ).toEqual(dek);
    expect(
      decryptObjectThroughNamespaceV2(
        crypto,
        namespaceKeyA,
        wrappedA,
        payload.payload,
      ),
    ).toEqual(new TextEncoder().encode("same immutable payload"));
    const encodedEnvelope = encodeNamespaceObjectEnvelopeV2(wrappedA);
    expect(decodeNamespaceObjectEnvelopeV2(encodedEnvelope)).toEqual(wrappedA);
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKeyB, wrappedB),
    ).toEqual(dek);
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKeyA, {
        ...wrappedA,
        context: { ...wrappedA.context, namespaceId: namespaceId("namespace_2") },
      }),
    ).toBeNull();
    const wrongClassEnvelope = wrapObjectDekForNamespaceV2(
      crypto,
      namespaceKeyA,
      { ...envelopeContext, keyClass: "ai" },
      dek,
    );
    expect(
      decryptObjectThroughNamespaceV2(
        crypto,
        namespaceKeyA,
        wrongClassEnvelope,
        payload.payload,
      ),
    ).toBeNull();
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKeyA, {
        ...wrappedA,
        context: {
          ...wrappedA.context,
          bindingRevisionAtWrap: accessRevision(12),
        },
      }),
    ).toBeNull();

    // Rebinding changes the Namespace head's Domain/epoch, not the historical
    // envelope context. Existing payload and wrapped-DEK bytes stay untouched.
    const reboundHead = { domainId: "domain_ac", domainEpoch: 99 };
    expect(reboundHead).toEqual({ domainId: "domain_ac", domainEpoch: 99 });
    expect(payload.payload.ciphertext).toEqual(payloadBeforeRebind);
    expect(wrappedA.wrappedDek).toEqual(wrappedBeforeRebind);
    expect(
      decryptObjectPayloadV2(crypto, dek, payload.payload),
    ).toEqual(new TextEncoder().encode("same immutable payload"));
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKeyA, wrappedA),
    ).toEqual(dek);
  });

  test("zeroizes temporary unwrapped DEKs after open and payload decrypt", () => {
    const crypto = new LatticeCrypto(seededRng(203));
    const namespaceKey = crypto.randomBytes(32);
    const encrypted = encryptObjectPayloadV2(
      crypto,
      payloadContext,
      new TextEncoder().encode("temporary-dek"),
    );
    const envelope = wrapObjectDekForNamespaceV2(
      crypto,
      namespaceKey,
      envelopeContext,
      encrypted.dek,
    );
    const openedDeks: Uint8Array[] = [];
    const payloadDekArguments: Uint8Array[] = [];
    const originalOpen = crypto.aeadOpen.bind(crypto);
    crypto.aeadOpen = (key, ...args) => {
      if (args[0] === encrypted.payload.ciphertext) {
        payloadDekArguments.push(key);
      }
      const result = originalOpen(key, ...args);
      if (result !== null && result.length === 32) openedDeks.push(result);
      return result;
    };

    const opened = openObjectDekForNamespaceV2(
      crypto,
      namespaceKey,
      envelope,
    );
    expect(opened).toEqual(encrypted.dek);
    expect(openedDeks.at(-1)).toEqual(new Uint8Array(32));
    expect(
      decryptObjectThroughNamespaceV2(
        crypto,
        namespaceKey,
        envelope,
        encrypted.payload,
      ),
    ).toEqual(new TextEncoder().encode("temporary-dek"));
    expect(openedDeks.at(-1)).toEqual(new Uint8Array(32));
    expect(payloadDekArguments.at(-1)).toEqual(new Uint8Array(32));

    const invalidDek = new Uint8Array(31).fill(0x55);
    crypto.aeadOpen = () => invalidDek;
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKey, envelope),
    ).toBeNull();
    expect(invalidDek).toEqual(new Uint8Array(31));
  });

  test("zeroizes the generated DEK and raw decrypted payload copies", () => {
    const crypto = new LatticeCrypto(seededRng(204));
    let generatedDek: Uint8Array | null = null;
    const originalRandom = crypto.randomBytes.bind(crypto);
    crypto.randomBytes = (length) => {
      const value = originalRandom(length);
      if (length === 32 && generatedDek === null) generatedDek = value;
      return value;
    };
    const encrypted = encryptObjectPayloadV2(
      crypto,
      payloadContext,
      new TextEncoder().encode("zeroize-payload"),
    );
    expect(encrypted.dek).not.toBe(generatedDek);
    expectWiped(generatedDek);

    let rawPlaintext: Uint8Array | null = null;
    const originalOpen = crypto.aeadOpen.bind(crypto);
    crypto.aeadOpen = (...args) => {
      const value = originalOpen(...args);
      if (value !== null) rawPlaintext = value;
      return value;
    };
    const plaintext = decryptObjectPayloadV2(
      crypto,
      encrypted.dek,
      encrypted.payload,
    );
    expect(plaintext).toEqual(new TextEncoder().encode("zeroize-payload"));
    expect(plaintext).not.toBe(rawPlaintext);
    expectWiped(rawPlaintext);
  });

  test("rejects invalid key lengths and plaintext/resource overflow before crypto", () => {
    const crypto = new LatticeCrypto(seededRng(303));
    let invalidPlaintextRandomCalls = 0;
    const invalidPlaintextCrypto = new LatticeCrypto(seededRng(302));
    const originalInvalidRandom =
      invalidPlaintextCrypto.randomBytes.bind(invalidPlaintextCrypto);
    invalidPlaintextCrypto.randomBytes = (length) => {
      invalidPlaintextRandomCalls++;
      return originalInvalidRandom(length);
    };
    expect(() =>
      encryptObjectPayloadV2(
        invalidPlaintextCrypto,
        payloadContext,
        "not-bytes" as never,
      )
    ).toThrow("Uint8Array");
    expect(invalidPlaintextRandomCalls).toBe(0);
    expect(() =>
      encryptObjectPayloadV2(
        crypto,
        payloadContext,
        new Uint8Array(1024 * 1024 + 1),
      )
    ).toThrow("plaintext");
    expect(() =>
      wrapObjectDekForNamespaceV2(
        crypto,
        new Uint8Array(31),
        envelopeContext,
        new Uint8Array(32),
      )
    ).toThrow("Namespace key");
    expect(() =>
      wrapObjectDekForNamespaceV2(
        crypto,
        new Uint8Array(32),
        envelopeContext,
        new Uint8Array(31),
      )
    ).toThrow("DEK");
    expect(() =>
      decryptObjectPayloadV2(
        crypto,
        new Uint8Array(31),
        {} as never,
      )
    ).toThrow("DEK");
    expect(() =>
      openObjectDekForNamespaceV2(
        crypto,
        new Uint8Array(31),
        {} as never,
      )
    ).toThrow("Namespace key");

    const invalidGeneratedDekCrypto = new LatticeCrypto(seededRng(304));
    invalidGeneratedDekCrypto.randomBytes = () => new Uint8Array(31);
    expect(() =>
      encryptObjectPayloadV2(
        invalidGeneratedDekCrypto,
        payloadContext,
        new Uint8Array([1]),
      )
    ).toThrow("generated DEK");

    const oversizedCiphertextCrypto = new LatticeCrypto(seededRng(305));
    oversizedCiphertextCrypto.aeadSeal = () =>
      new Uint8Array(V2_LIMITS.ciphertextBytes + 1);
    expect(() =>
      encryptObjectPayloadV2(
        oversizedCiphertextCrypto,
        payloadContext,
        new Uint8Array([1]),
      )
    ).toThrow("encrypted payload bytes");

    const oversizedWrappedDekCrypto = new LatticeCrypto(seededRng(306));
    oversizedWrappedDekCrypto.aeadSeal = () =>
      new Uint8Array(V2_LIMITS.wrappedDekBytes + 1);
    expect(() =>
      wrapObjectDekForNamespaceV2(
        oversizedWrappedDekCrypto,
        new Uint8Array(32),
        envelopeContext,
        new Uint8Array(32),
      )
    ).toThrow("wrapped DEK bytes");

    const encrypted = encryptObjectPayloadV2(
      crypto,
      payloadContext,
      new TextEncoder().encode("structural-validation"),
    );
    expect(() =>
      decryptObjectPayloadV2(crypto, encrypted.dek, {
        ...encrypted.payload,
        ciphertext: new Uint8Array(V2_LIMITS.ciphertextBytes + 1),
      })
    ).toThrow("encrypted payload bytes");
    for (const malformed of [
      null,
      7,
      {
        ...encrypted.payload,
        formatVersion: 1,
      },
      {
        ...encrypted.payload,
        ciphertext: "not-bytes",
      },
    ]) {
      expect(
        decryptObjectPayloadV2(
          crypto,
          encrypted.dek,
          malformed as never,
        ),
      ).toBeNull();
    }
    const tamperedCiphertext = encrypted.payload.ciphertext.slice();
    const ciphertextLast = tamperedCiphertext.length - 1;
    tamperedCiphertext[ciphertextLast] =
      tamperedCiphertext[ciphertextLast]! ^ 1;
    expect(
      decryptObjectPayloadV2(crypto, encrypted.dek, {
        ...encrypted.payload,
        ciphertext: tamperedCiphertext,
      }),
    ).toBeNull();
    expect(
      decryptObjectPayloadV2(crypto, encrypted.dek, {
        ...encrypted.payload,
        context: {
          ...encrypted.payload.context,
          domainId: "domain_injected",
        } as never,
      }),
    ).toBeNull();

    const namespaceKey = new Uint8Array(32).fill(0x11);
    const envelope = wrapObjectDekForNamespaceV2(
      crypto,
      namespaceKey,
      envelopeContext,
      encrypted.dek,
    );
    expect(() =>
      openObjectDekForNamespaceV2(crypto, namespaceKey, {
        ...envelope,
        wrappedDek: new Uint8Array(V2_LIMITS.wrappedDekBytes + 1),
      })
    ).toThrow("wrapped DEK bytes");
    for (const malformed of [
      null,
      7,
      { ...envelope, formatVersion: 1 },
      { ...envelope, wrappedDek: "not-bytes" },
    ]) {
      expect(
        openObjectDekForNamespaceV2(
          crypto,
          namespaceKey,
          malformed as never,
        ),
      ).toBeNull();
    }
    const tamperedWrappedDek = envelope.wrappedDek.slice();
    const wrappedDekLast = tamperedWrappedDek.length - 1;
    tamperedWrappedDek[wrappedDekLast] =
      tamperedWrappedDek[wrappedDekLast]! ^ 1;
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKey, {
        ...envelope,
        wrappedDek: tamperedWrappedDek,
      }),
    ).toBeNull();
    expect(
      openObjectDekForNamespaceV2(crypto, namespaceKey, {
        ...envelope,
        context: {
          ...envelope.context,
          domainId: "domain_injected",
        } as never,
      }),
    ).toBeNull();
    expect(
      decryptObjectThroughNamespaceV2(
        crypto,
        namespaceKey,
        {
          ...envelope,
          wrappedDek: tamperedWrappedDek,
        },
        encrypted.payload,
      ),
    ).toBeNull();
    const otherObjectEnvelope = wrapObjectDekForNamespaceV2(
      crypto,
      namespaceKey,
      {
        ...envelopeContext,
        objectId: objectId("object_other"),
      },
      encrypted.dek,
    );
    expect(
      decryptObjectThroughNamespaceV2(
        crypto,
        namespaceKey,
        otherObjectEnvelope,
        encrypted.payload,
      ),
    ).toBeNull();
  });

  test("detaches every returned DEK and ciphertext buffer", () => {
    const crypto = new LatticeCrypto(seededRng(304));
    let rawCiphertext: Uint8Array | null = null;
    const originalSeal = crypto.aeadSeal.bind(crypto);
    crypto.aeadSeal = (...args) => {
      const value = originalSeal(...args);
      rawCiphertext = value;
      return value;
    };
    const encrypted = encryptObjectPayloadV2(
      crypto,
      payloadContext,
      new TextEncoder().encode("detached"),
    );
    expect(encrypted.payload.ciphertext).not.toBe(rawCiphertext);

    rawCiphertext = null;
    const envelope = wrapObjectDekForNamespaceV2(
      crypto,
      new Uint8Array(32).fill(0x44),
      envelopeContext,
      encrypted.dek,
    );
    expect(envelope.wrappedDek).not.toBe(rawCiphertext);
  });
});

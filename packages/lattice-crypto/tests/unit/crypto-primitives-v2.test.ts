import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  manualClock,
  seededRng,
  systemClock,
  systemRng,
  type Rng,
} from "../../src/crypto/index.ts";
import {
  concat,
  encodeJson,
  fromHex,
  fromUtf8,
  readU16,
  toHex,
  u16,
  utf8,
} from "../../src/util/bytes.ts";

describe("shared crypto primitive foundations", () => {
  test("pins the deterministic RNG stream, including the zero-seed fallback", () => {
    const fallback = seededRng(0);
    expect(toHex(fallback.bytes(12))).toBe("193e3ab51f37d0bf39b8eeb4");
    expect(toHex(fallback.bytes(4))).toBe("d33cb85f");
    expect(fallback.bytes(0)).toEqual(new Uint8Array());

    const nonzero = seededRng(1);
    expect(toHex(nonzero.bytes(16))).toBe(
      "2101c54fd1d01ab22574cb378aaef5b1",
    );
  });

  test("pins manual clock advancement, reset, and crypto injection", () => {
    const clock = manualClock(10);
    const crypto = new LatticeCrypto(seededRng(1), clock);
    expect(crypto.clock.now()).toBe(10);
    clock.advance(7);
    expect(crypto.clock.now()).toBe(17);
    clock.advance(-2);
    expect(crypto.clock.now()).toBe(15);
    clock.set(41);
    expect(crypto.clock.now()).toBe(41);
    expect(manualClock().now()).toBe(0);
  });

  test("provides working production RNG and clock defaults", () => {
    const before = Date.now();
    const random = systemRng.bytes(32);
    const now = systemClock.now();
    const after = Date.now();

    expect(random).toBeInstanceOf(Uint8Array);
    expect(random).toHaveLength(32);
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  test("takes ownership of injected random-byte provider output", () => {
    const calls: number[] = [];
    const provided = Buffer.from([9, 8, 7]);
    const rng: Rng = {
      bytes(length) {
        calls.push(length);
        return provided;
      },
    };
    const crypto = new LatticeCrypto(rng);
    const random = crypto.randomBytes(3);
    expect(random).toEqual(Uint8Array.of(9, 8, 7));
    expect(random).not.toBe(provided);
    expect(Buffer.isBuffer(random)).toBe(false);
    expect(provided).toEqual(Buffer.alloc(3));
    expect(random).toEqual(Uint8Array.of(9, 8, 7));
    expect(calls).toEqual([3]);

    const invalid = Buffer.from([1, 2]);
    expect(() =>
      new LatticeCrypto({
        bytes: () => invalid,
      }).randomBytes(3)
    ).toThrow("RNG returned 2 bytes for a 3-byte request");
    expect(invalid).toEqual(Buffer.alloc(2));
    expect(() =>
      new LatticeCrypto({
        bytes: () => "not-bytes" as never,
      }).randomBytes(3)
    ).toThrow("RNG returned invalid bytes for a 3-byte request");
  });

  test("pins SHA-256 and domain-separated HKDF output", () => {
    const crypto = new LatticeCrypto(seededRng(123));
    expect(toHex(crypto.hash(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(toHex(crypto.deriveKey(utf8("ikm"), "label", 42))).toBe(
      "25a8793cb62d819dc4dd5e0558f16c089fceaed533c6a98f888c03339b79790030af42f80c6448d0a915",
    );
    expect(crypto.deriveKey(utf8("ikm"), "label")).toHaveLength(32);
    expect(crypto.deriveKey(utf8("ikm"), "other-label")).not.toEqual(
      crypto.deriveKey(utf8("ikm"), "label"),
    );
  });

  test("pins AEAD framing and rejects every tested authenticity failure", () => {
    const crypto = new LatticeCrypto(seededRng(123));
    const key = new Uint8Array(32).fill(7);
    const plaintext = utf8("plaintext");
    const aad = utf8("aad");
    const sealed = crypto.aeadSeal(key, plaintext, aad);

    expect(toHex(sealed)).toBe(
      "fcb24a9c96a649b6cfcf2805e8a1a6ba632172b4679898371a43b182f91de18dafa9b26a674c3ce722655862bf5132854c",
    );
    expect(sealed).toHaveLength(24 + plaintext.length + 16);
    expect(crypto.aeadOpen(key, sealed, aad)).toEqual(plaintext);
    expect(crypto.aeadOpen(key, sealed, utf8("wrong"))).toBeNull();
    expect(
      crypto.aeadOpen(new Uint8Array(32).fill(8), sealed, aad),
    ).toBeNull();
    expect(crypto.aeadOpen(key, new Uint8Array(23), aad)).toBeNull();
    expect(crypto.aeadOpen(key, new Uint8Array(24), aad)).toBeNull();

    const tampered = sealed.slice();
    const tamperedIndex = tampered.length - 1;
    tampered[tamperedIndex] = tampered[tamperedIndex]! ^ 1;
    expect(crypto.aeadOpen(key, tampered, aad)).toBeNull();

    const withoutAad = crypto.aeadSeal(key, plaintext);
    expect(crypto.aeadOpen(key, withoutAad)).toEqual(plaintext);
    expect(crypto.aeadOpen(key, withoutAad, aad)).toBeNull();
  });

  test("generates deterministic Ed25519 material and fails verification closed", () => {
    const first = new LatticeCrypto(seededRng(77));
    const second = new LatticeCrypto(seededRng(77));
    const firstPair = first.generateSigningKeyPair();
    const secondPair = second.generateSigningKeyPair();
    const message = utf8("signed");
    const signature = first.sign(firstPair.privateKey, message);

    expect(firstPair).toEqual(secondPair);
    expect(firstPair.privateKey).toHaveLength(32);
    expect(firstPair.publicKey).toHaveLength(32);
    expect(first.verify(firstPair.publicKey, message, signature)).toBe(true);
    expect(first.verify(firstPair.publicKey, utf8("changed"), signature)).toBe(
      false,
    );
    expect(first.verify(new Uint8Array(1), message, signature)).toBe(false);
    expect(first.verify(firstPair.publicKey, message, new Uint8Array(1))).toBe(
      false,
    );
  });

  test("derives recovery and HPKE keys from exactly the supplied byte view", async () => {
    const crypto = new LatticeCrypto(seededRng(78));
    const backing = new Uint8Array(34).fill(0xee);
    backing.set(new Uint8Array(32).fill(0x41), 1);
    const view = backing.subarray(1, 33);
    const exact = view.slice();
    const fromView = await crypto.deriveEncryptionKeyPair(view);
    const fromExact = await crypto.deriveEncryptionKeyPair(exact);

    expect(fromView).toEqual(fromExact);
    expect(fromView.publicKey).toHaveLength(65);
    expect(fromView.privateKey).toHaveLength(32);

    backing.fill(0x11);
    expect(await crypto.deriveEncryptionKeyPair(exact)).toEqual(fromExact);

    const shortScalarIkm = new Uint8Array(32);
    new DataView(shortScalarIkm.buffer).setUint32(28, 345);
    const padded = await crypto.deriveEncryptionKeyPair(shortScalarIkm);
    expect(padded.privateKey).toHaveLength(32);
    expect(padded.privateKey[0]).toBe(0);

    const kitCrypto = new LatticeCrypto(seededRng(5));
    const kit = await kitCrypto.createRecoveryKit();
    const restored = await kitCrypto.deriveEncryptionKeyPair(kit.secret);
    expect(kit.formatVersion).toBe(1);
    expect(kit.secret).toHaveLength(32);
    expect(kit.publicKey).toEqual(restored.publicKey);
    expect(kit.keyId).toBe(
      `recovery_${toHex(kitCrypto.hash(kit.publicKey).subarray(0, 16))}`,
    );
  });

  test("wipes temporary HPKE private material without changing caller-owned keys", async () => {
    const crypto = new LatticeCrypto(seededRng(79));
    const ikm = Buffer.alloc(32, 0x71);
    const expectedIkm = Uint8Array.from(ikm);
    const wipedSnapshots: Uint8Array[] = [];
    const originalFill = Uint8Array.prototype.fill;
    Uint8Array.prototype.fill = function (
      value: number,
      start?: number,
      end?: number,
    ): Uint8Array {
      if (value === 0 && start === undefined && end === undefined) {
        wipedSnapshots.push(Uint8Array.from(this));
      }
      return originalFill.call(this, value, start, end);
    };

    try {
      const generated = await crypto.generateEncryptionKeyPair();
      const derived = await crypto.deriveEncryptionKeyPair(ikm);
      const sealed = await crypto.sealTo(derived.publicKey, utf8("secret"));
      expect(await crypto.openSealed(derived.privateKey, sealed)).toEqual(
        utf8("secret"),
      );
      expect(
        await crypto.openSealed(derived.privateKey, new Uint8Array()),
      ).toBeNull();

      expect(Uint8Array.from(ikm)).toEqual(expectedIkm);
      expect(derived.privateKey).not.toEqual(new Uint8Array(32));
      expect(generated.privateKey).not.toEqual(new Uint8Array(32));
      expect(
        wipedSnapshots.some((snapshot) =>
          toHex(snapshot) === toHex(expectedIkm)
        ),
      ).toBe(true);
      expect(
        wipedSnapshots.some((snapshot) =>
          toHex(snapshot) === toHex(derived.privateKey)
        ),
      ).toBe(true);
      expect(
        wipedSnapshots.some((snapshot) =>
          toHex(snapshot) === toHex(generated.privateKey)
        ),
      ).toBe(true);
      expect(
        wipedSnapshots.filter((snapshot) =>
          toHex(snapshot) === toHex(derived.privateKey)
        ).length,
      ).toBeGreaterThanOrEqual(2);
    } finally {
      Uint8Array.prototype.fill = originalFill;
    }
  });

  test("wipes the exact HPKE buffers owned by each primitive", async () => {
    const crypto = new LatticeCrypto(seededRng(791));
    interface SenderHarness {
      seal(...args: unknown[]): Promise<unknown>;
    }
    interface SuiteHarness {
      kem: {
        serializePrivateKey(...args: unknown[]): Promise<ArrayBuffer>;
        deserializePrivateKey(...args: unknown[]): Promise<unknown>;
      };
      createSenderContext(...args: unknown[]): Promise<SenderHarness>;
    }
    const suite = (crypto as unknown as { suite: SuiteHarness }).suite;
    const originalSerializePrivateKey =
      suite.kem.serializePrivateKey.bind(suite.kem);
    const originalDeserializePrivateKey =
      suite.kem.deserializePrivateKey.bind(suite.kem);
    const originalCreateSenderContext =
      suite.createSenderContext.bind(suite);

    let serializedPrivate: Uint8Array | undefined;
    let openedPrivate: Uint8Array | undefined;
    let sealedPlaintext: Uint8Array | undefined;
    suite.kem.serializePrivateKey = async (...args: unknown[]) => {
      const serialized = await originalSerializePrivateKey(...args);
      serializedPrivate = new Uint8Array(serialized);
      return serialized;
    };
    suite.kem.deserializePrivateKey = async (...args: unknown[]) => {
      const serialized = args[0];
      if (!(serialized instanceof ArrayBuffer)) {
        throw new TypeError("serialized private key must be an ArrayBuffer");
      }
      openedPrivate = new Uint8Array(serialized);
      return originalDeserializePrivateKey(...args);
    };
    suite.createSenderContext = async (...args: unknown[]) => {
      const sender = await originalCreateSenderContext(...args);
      const originalSeal = sender.seal.bind(sender);
      sender.seal = async (...sealArgs: unknown[]) => {
        const plaintext = sealArgs[0];
        if (!(plaintext instanceof Uint8Array)) {
          throw new TypeError("HPKE plaintext must be bytes");
        }
        sealedPlaintext = plaintext;
        return originalSeal(...sealArgs);
      };
      return sender;
    };

    const derived = await crypto.deriveEncryptionKeyPair(
      new Uint8Array(32).fill(0x71),
    );
    expect(serializedPrivate).toBeDefined();
    expect(serializedPrivate!.every((byte) => byte === 0)).toBe(true);

    const sealed = await crypto.sealTo(
      derived.publicKey,
      utf8("owned plaintext"),
    );
    expect(sealedPlaintext).toBeDefined();
    expect(sealedPlaintext!.every((byte) => byte === 0)).toBe(true);

    expect(await crypto.openSealed(derived.privateKey, sealed)).toEqual(
      utf8("owned plaintext"),
    );
    expect(openedPrivate).toBeDefined();
    expect(openedPrivate!.every((byte) => byte === 0)).toBe(true);
  });

  test("wipes the recovery-kit derivation private key on success", async () => {
    const crypto = new LatticeCrypto(seededRng(792));
    const privateKey = new Uint8Array(32).fill(0x72);
    crypto.deriveEncryptionKeyPair = async () => ({
      publicKey: new Uint8Array(65).fill(0x73),
      privateKey,
    });

    const kit = await crypto.createRecoveryKit();

    expect(kit.secret.some((byte) => byte !== 0)).toBe(true);
    expect(privateKey).toEqual(new Uint8Array(32));
  });

  test("wipes a newly generated recovery secret when key derivation fails", async () => {
    const provided = Buffer.alloc(32, 0x72);
    const crypto = new LatticeCrypto({
      bytes: () => provided,
    });
    const generatedSecret = crypto.randomBytes(32);
    crypto.deriveEncryptionKeyPair = async () => {
      throw new Error("injected derivation failure");
    };

    const originalRandomBytes = crypto.randomBytes.bind(crypto);
    crypto.randomBytes = () => generatedSecret;
    try {
      let failure: unknown;
      try {
        await crypto.createRecoveryKit();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toBe("injected derivation failure");
      expect(generatedSecret).toEqual(new Uint8Array(32));
      expect(provided).toEqual(Buffer.alloc(32));
    } finally {
      crypto.randomBytes = originalRandomBytes;
    }
  });

  test("round-trips HPKE and rejects truncation, wrong keys, and tampering", async () => {
    const crypto = new LatticeCrypto(seededRng(80));
    const recipient = await crypto.deriveEncryptionKeyPair(
      new Uint8Array(32).fill(0x51),
    );
    const wrongRecipient = await crypto.deriveEncryptionKeyPair(
      new Uint8Array(32).fill(0x52),
    );
    const plaintext = utf8("sealed");
    const sealed = await crypto.sealTo(recipient.publicKey, plaintext);

    expect(readU16(sealed, 0)).toBe(65);
    expect(await crypto.openSealed(recipient.privateKey, sealed)).toEqual(
      plaintext,
    );
    expect(await crypto.openSealed(wrongRecipient.privateKey, sealed)).toBeNull();
    expect(await crypto.openSealed(recipient.privateKey, new Uint8Array()))
      .toBeNull();
    expect(
      await crypto.openSealed(recipient.privateKey, Uint8Array.of(0)),
    ).toBeNull();
    expect(
      await crypto.openSealed(
        recipient.privateKey,
        Uint8Array.of(0xff, 0xff, 1),
      ),
    ).toBeNull();

    const tampered = sealed.slice();
    const tamperedIndex = tampered.length - 1;
    tampered[tamperedIndex] = tampered[tamperedIndex]! ^ 1;
    expect(await crypto.openSealed(recipient.privateKey, tampered)).toBeNull();
  });

  test("rejects malformed HPKE frames before private-key deserialization", async () => {
    const crypto = new LatticeCrypto(seededRng(801));
    const suite = (crypto as unknown as {
      suite: {
        kem: {
          deserializePrivateKey(...args: unknown[]): Promise<unknown>;
        };
      };
    }).suite;
    const originalDeserializePrivateKey =
      suite.kem.deserializePrivateKey.bind(suite.kem);
    let deserializeCalls = 0;
    suite.kem.deserializePrivateKey = async (...args: unknown[]) => {
      deserializeCalls++;
      return originalDeserializePrivateKey(...args);
    };
    const privateKey = new Uint8Array(32).fill(0x51);

    expect(
      await crypto.openSealed(
        privateKey,
        new Uint8Array(2 + 1 + 16).fill(1).map((byte, index) =>
          index === 0 ? 0 : index === 1 ? 1 : byte
        ),
      ),
    ).toBeNull();
    expect(
      await crypto.openSealed(
        privateKey,
        new Uint8Array(2 + 65 + 15).fill(1).map((byte, index) =>
          index === 0 ? 0 : index === 1 ? 65 : byte
        ),
      ),
    ).toBeNull();
    expect(deserializeCalls).toBe(0);

    expect(
      await crypto.openSealed(
        privateKey,
        new Uint8Array(2 + 65 + 16).fill(1).map((byte, index) =>
          index === 0 ? 0 : index === 1 ? 65 : byte
        ),
      ),
    ).toBeNull();
    expect(deserializeCalls).toBe(1);
  });

  test("snapshots HPKE plaintext and ciphertext before the first await", async () => {
    const crypto = new LatticeCrypto(seededRng(81));
    const recipient = await crypto.deriveEncryptionKeyPair(
      new Uint8Array(32).fill(0x61),
    );
    const plaintext = Buffer.from(utf8("stable plaintext"));
    const expectedPlaintext = Uint8Array.from(plaintext);

    const pendingSeal = crypto.sealTo(recipient.publicKey, plaintext);
    plaintext.fill(0);
    const sealed = await pendingSeal;
    expect(await crypto.openSealed(recipient.privateKey, sealed)).toEqual(
      expectedPlaintext,
    );

    const mutableSealed = Buffer.from(sealed);
    const pendingOpen = crypto.openSealed(
      recipient.privateKey,
      mutableSealed,
    );
    mutableSealed.fill(0);
    expect(await pendingOpen).toEqual(expectedPlaintext);
  });
});

describe("shared byte primitives", () => {
  test("pins UTF-8, concatenation, integer, hex, and JSON byte contracts", () => {
    expect(toHex(utf8("Aπ"))).toBe("41cf80");
    expect(fromUtf8(fromHex("41cf80"))).toBe("Aπ");

    const source = Uint8Array.of(2, 3);
    const joined = concat(Uint8Array.of(1), source, new Uint8Array());
    source[0] = 9;
    expect(joined).toEqual(Uint8Array.of(1, 2, 3));
    expect(concat()).toEqual(new Uint8Array());

    expect(toHex(u16(0x0102))).toBe("0102");
    expect(toHex(u16(0x1_2345))).toBe("2345");
    expect(readU16(Uint8Array.of(9, 0x12, 0x34, 8), 1)).toBe(0x1234);
    expect(readU16(Uint8Array.of(0x12), 0)).toBe(0x1200);
    expect(readU16(new Uint8Array(), 0)).toBe(0);

    expect(toHex(fromHex("0001ff"))).toBe("0001ff");
    expect(fromHex("01020304")).toEqual(Uint8Array.of(1, 2, 3, 4));
    const longHexFixture = Uint8Array.from(
      { length: 32 },
      (_, index) => index,
    );
    expect(fromHex(toHex(longHexFixture))).toEqual(longHexFixture);
    expect(fromHex("")).toEqual(new Uint8Array());
    for (const invalid of ["0", "0g", "AA", "abc"]) {
      expect(() => fromHex(invalid)).toThrow(
        "hex input must be lowercase, even-length hexadecimal",
      );
    }

    expect(fromUtf8(encodeJson({ b: 2, a: "x" }))).toBe(
      '{"b":2,"a":"x"}',
    );
  });
});

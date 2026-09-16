import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2,
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2,
  HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2,
  MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2,
  decodeHumanMemoryExactAccessRequestV2,
  encodeHumanMemoryExactAccessRequestV2,
  humanMemoryExactAccessRequestSigningBytesV2,
  prepareHumanMemoryExactAccessRequestV2,
  verifyHumanMemoryExactAccessRequestV2,
  type HumanMemoryExactAccessRequestEntryV2,
  type PrepareHumanMemoryExactAccessRequestInputV2,
} from "../../src/memory/exact-access-request-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NS_A = "11111111-1111-4111-8111-111111111111";
const NS_B = "22222222-2222-4222-8222-222222222222";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function entry(
  id: string,
  marker: number,
): HumanMemoryExactAccessRequestEntryV2 {
  return {
    namespaceId: namespaceId(id),
    keyGeneration: marker + 2,
    namespaceAccessRevision: marker,
    headDigest: hash(marker),
    publicationDigest: hash(marker + 1),
    publicationSetDigest: hash(marker + 2),
    audienceFingerprint: hash(marker + 3),
    envelopeHash: hash(marker + 10),
  };
}

function authorityEntry(value: HumanMemoryExactAccessRequestEntryV2) {
  const { envelopeHash: _envelopeHash, ...authority } = value;
  return authority;
}

function fixture(seed = 2_500): Readonly<{
  crypto: LatticeCrypto;
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>;
  input: PrepareHumanMemoryExactAccessRequestInputV2;
}> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const signer = crypto.generateSigningKeyPair();
  return {
    crypto,
    signer,
    input: {
      subjectHumanId: humanId("human-alice"),
      operationId: "memory-access-operation-1",
      memoryId: MEMORY_ID,
      cryptoObjectId: objectId("memory:v1:object-1"),
      payloadHash: hash(1),
      expectedContentRevision: 4,
      expectedAccessRevision: 7,
      nextAccessRevision: 8,
      currentManifestHash: hash(2),
      nextManifestHash: hash(3),
      currentEntries: [entry(NS_A, 1)],
      targetEntries: [entry(NS_A, 1), entry(NS_B, 2)],
      currentAuthorityEntries: [authorityEntry(entry(NS_A, 1))],
      targetAuthorityEntries: [authorityEntry(entry(NS_A, 1)),
        authorityEntry(entry(NS_B, 2))],
      issuedAt: unixTimestamp(1_000_000),
      deadlineAt: unixTimestamp(1_020_000),
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(9),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  };
}

describe("HumanMemoryExactAccessRequestV2", () => {
  test("round-trips four complete maximum-size authority inventories", () => {
    const state = fixture(2_509);
    const maximumId = (index: number) => {
      const prefix = `namespace-${String(index).padStart(3, "0")}-`;
      return `${prefix}${"x".repeat(128 - prefix.length)}`;
    };
    const maximumEntries = Array.from(
      { length: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2 },
      (_, index) => entry(maximumId(index), index + 1),
    );
    const created = prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      subjectHumanId: humanId(maximumId(900)),
      operationId: maximumId(901),
      cryptoObjectId: objectId(maximumId(902)),
      committerDeviceId: cryptoDeviceId(maximumId(903)),
      currentEntries: maximumEntries,
      targetEntries: maximumEntries,
      currentAuthorityEntries: maximumEntries.map(authorityEntry),
      targetAuthorityEntries: maximumEntries.map(authorityEntry),
    });
    expect(created.bytes).toHaveLength(
      MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2,
    );
    expect(decodeHumanMemoryExactAccessRequestV2(created.bytes))
      .toEqual(created.request);
  });

  test("round-trips and verifies one exact operation-bound request", () => {
    const state = fixture();
    const created = prepareHumanMemoryExactAccessRequestV2(
      state.crypto,
      state.input,
    );
    expect(createHash("sha256").update(created.bytes).digest("hex")).toBe(
      "97c2a31d224f2ecce65e98d821b5ad4879fed3e3c26e3cbd5187b8993e33a2a5",
    );
    expect(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_DOMAIN_V2).toBe(
      "nautilo/lattice-crypto/human-memory-exact-access-request/v2",
    );
    expect(HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2).toBe(30_000);
    expect(decodeHumanMemoryExactAccessRequestV2(created.bytes))
      .toEqual(created.request);
    expect(encodeHumanMemoryExactAccessRequestV2(created.request))
      .toEqual(created.bytes);

    const contexts: unknown[] = [];
    const verified = verifyHumanMemoryExactAccessRequestV2(state.crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_010_000),
      resolveCurrentAuthority: (context) => {
        contexts.push(context);
        return state.signer.publicKey;
      },
    });
    expect(verified).toEqual(created.request);
    expect(contexts).toEqual([{
      purpose: "human-memory-exact-access-verify",
      subjectHumanId: "human-alice",
      operationId: "memory-access-operation-1",
      committerDeviceId: "device-alice-1",
      hostAuthorizationRevision: 9,
    }]);

    const { signature: _, ...unsigned } = created.request;
    const signingBytes = humanMemoryExactAccessRequestSigningBytesV2(unsigned);
    expect(state.crypto.verify(
      state.signer.publicKey,
      signingBytes,
      created.request.signature,
    )).toBeTrue();
    signingBytes.fill(0);
  });

  test("permits an empty exact target but requires a nonempty current set", () => {
    const state = fixture(2_501);
    const created = prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      targetEntries: [],
      targetAuthorityEntries: [],
    });
    expect(created.request.targetEntries).toEqual([]);
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      currentEntries: [],
      currentAuthorityEntries: [],
    })).toThrow("current entry inventory");
  });

  test("rejects partial, reordered, duplicate, and oversized exact sets", () => {
    const state = fixture(2_502);
    const a = entry(NS_A, 1);
    const b = entry(NS_B, 2);
    for (const targetEntries of [
      [b, a],
      [a, { ...a, envelopeHash: hash(99) }],
      [{ ...a, headDigest: new Uint8Array(31) }],
      Array.from({ length: 257 }, (_, index) => entry(
        `namespace-${String(index).padStart(3, "0")}`,
        index + 1,
      )),
    ]) {
      expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
        ...state.input,
        targetEntries,
      })).toThrow();
    }
  });

  test("signature binds product, crypto, exact-set, time, device, and Human facts", () => {
    const state = fixture(2_503);
    const created = prepareHumanMemoryExactAccessRequestV2(state.crypto, state.input);
    const substitutions = [
      { subjectHumanId: humanId("human-bob") },
      { operationId: "memory-access-operation-2" },
      { memoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { cryptoObjectId: objectId("memory:v1:other") },
      { payloadHash: hash(99) },
      { expectedContentRevision: 5 },
      { expectedAccessRevision: 8, nextAccessRevision: 9 },
      { currentManifestHash: hash(99) },
      { nextManifestHash: hash(99) },
      { currentEntries: [{ ...created.request.currentEntries[0]!, envelopeHash: hash(99) }] },
      { targetEntries: created.request.targetEntries.map((value, index) =>
        index === 1 ? { ...value, publicationSetDigest: hash(99) } : value) },
      { currentAuthorityEntries: created.request.currentAuthorityEntries.map(
        (value) => ({ ...value, keyGeneration: value.keyGeneration + 1 })),
      },
      { targetAuthorityEntries: created.request.targetAuthorityEntries.map(
        (value, index) => index === 1
          ? { ...value, headDigest: hash(99) } : value),
      },
      { issuedAt: unixTimestamp(1_000_001) },
      { deadlineAt: unixTimestamp(1_020_001) },
      { committerDeviceId: cryptoDeviceId("device-alice-2") },
      { hostAuthorizationRevision: authorizationRevision(10) },
    ];
    for (const patch of substitutions) {
      const bytes = encodeHumanMemoryExactAccessRequestV2({
        ...created.request,
        ...patch,
      });
      expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
        requestBytes: bytes,
        now: unixTimestamp(1_010_000),
        resolveCurrentAuthority: () => state.signer.publicKey,
      })).toThrow("signature");
      bytes.fill(0);
    }
  });

  test("fails closed for stale time or absent/substituted current authority", () => {
    const state = fixture(2_504);
    const created = prepareHumanMemoryExactAccessRequestV2(state.crypto, state.input);
    for (const now of [999_999, 1_020_000]) {
      expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
        requestBytes: created.bytes,
        now: unixTimestamp(now),
        resolveCurrentAuthority: () => state.signer.publicKey,
      })).toThrow("not currently valid");
    }
    expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_010_000),
      resolveCurrentAuthority: () => null,
    })).toThrow("authority is unavailable");
    const other = state.crypto.generateSigningKeyPair();
    expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_010_000),
      resolveCurrentAuthority: () => other.publicKey,
    })).toThrow("signature");
  });

  test("rejects malformed revisions, deadlines, hashes, and field sets", () => {
    const state = fixture(2_505);
    for (const patch of [
      { nextAccessRevision: 9 },
      { expectedContentRevision: -1 },
      { payloadHash: new Uint8Array(31) },
      { deadlineAt: unixTimestamp(1_030_001) },
      { issuedAt: unixTimestamp(1_020_000), deadlineAt: unixTimestamp(1_020_000) },
    ]) {
      expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
        ...state.input,
        ...patch,
      } as never)).toThrow();
    }
    expect(() => humanMemoryExactAccessRequestSigningBytesV2({
      ...prepareHumanMemoryExactAccessRequestV2(state.crypto, state.input).request,
      extra: true,
    } as never)).toThrow("invalid field set");
  });

  test("validates every top-level identity, revision, hash, and time boundary exactly", () => {
    const state = fixture(2_506);
    const failures: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ operationId: "" }, "Human Memory exact-access operation id must be 1-128 ASCII bytes using the portable identifier grammar"],
      [{ memoryId: 1 }, "Human Memory exact-access Memory ID is invalid"],
      [{ memoryId: { toString: () => MEMORY_ID } }, "Human Memory exact-access Memory ID is invalid"],
      [{ memoryId: `x${MEMORY_ID}` }, "Human Memory exact-access Memory ID is invalid"],
      [{ memoryId: `${MEMORY_ID}x` }, "Human Memory exact-access Memory ID is invalid"],
      [{ expectedContentRevision: -1 }, "Human Memory exact-access content revision must be a non-negative safe integer"],
      [{ expectedAccessRevision: -1 }, "Human Memory expected access revision must be a non-negative safe integer"],
      [{ nextAccessRevision: 9 }, "Human Memory access revision must advance exactly once"],
      [{ expectedAccessRevision: Number.MAX_SAFE_INTEGER, nextAccessRevision: Number.MAX_SAFE_INTEGER }, "Human Memory access revision must advance exactly once"],
      [{ payloadHash: new Uint8Array(31) }, "Human Memory exact-access payload hash must be exactly 32 bytes"],
      [{ currentManifestHash: new Uint8Array(31) }, "Human Memory exact-access current manifest hash must be exactly 32 bytes"],
      [{ nextManifestHash: new Uint8Array(31) }, "Human Memory exact-access next manifest hash must be exactly 32 bytes"],
      [{ deadlineAt: state.input.issuedAt }, "Human Memory exact-access deadline is invalid"],
      [{ deadlineAt: unixTimestamp(Number(state.input.issuedAt) + HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2 + 1) }, "Human Memory exact-access deadline is invalid"],
    ];
    for (const [patch, message] of failures) {
      expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
        ...state.input,
        ...patch,
      } as never)).toThrow(message);
    }

    expect(() => humanMemoryExactAccessRequestSigningBytesV2(null as never))
      .toThrow("Human Memory exact-access request must be an object");
    expect(() => humanMemoryExactAccessRequestSigningBytesV2([] as never))
      .toThrow("Human Memory exact-access request must be an object");
    expect(() => humanMemoryExactAccessRequestSigningBytesV2(1 as never))
      .toThrow("Human Memory exact-access request must be an object");
    const { signature: _, ...unsigned } =
      prepareHumanMemoryExactAccessRequestV2(state.crypto, state.input).request;
    expect(() => humanMemoryExactAccessRequestSigningBytesV2({
      ...unsigned,
      formatVersion: 2,
    } as never)).toThrow("Human Memory exact-access request kind is invalid");
    expect(() => humanMemoryExactAccessRequestSigningBytesV2({
      ...unsigned,
      purpose: "future-purpose",
    } as never)).toThrow("Human Memory exact-access request kind is invalid");
    const substitutedFields = { ...unsigned } as Record<string, unknown>;
    delete substitutedFields["purpose"];
    substitutedFields["futurePurpose"] = "memory.exact_access_update";
    expect(() => humanMemoryExactAccessRequestSigningBytesV2(
      substitutedFields as never,
    )).toThrow("Human Memory exact-access request has an invalid field set");
    const missingTailField = { ...unsigned } as Record<string, unknown>;
    delete missingTailField["targetEntries"];
    expect(() => humanMemoryExactAccessRequestSigningBytesV2(
      missingTailField as never,
    )).toThrow("Human Memory exact-access request has an invalid field set");
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      expectedAccessRevision: Number.MAX_SAFE_INTEGER,
      nextAccessRevision: Number.MAX_SAFE_INTEGER + 1,
    } as never)).toThrow("Human Memory access revision must advance exactly once");
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      deadlineAt: unixTimestamp(
        Number(state.input.issuedAt)
          + HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V2,
      ),
    })).not.toThrow();
  });

  test("validates exact entry structure, ordering, counters, and byte fields", () => {
    const state = fixture(2_507);
    const valid = entry(NS_A, 1);
    const failures: ReadonlyArray<readonly [unknown, string]> = [
      [null, "Human Memory current entry must be an object"],
      [[valid], "Human Memory current entry must be an object"],
      [{ ...valid, extra: true }, "Human Memory current entry has an invalid field set"],
      [{ ...valid, namespaceAccessRevision: -1 }, "Human Memory current Namespace access revision must be a non-negative safe integer"],
      [{ ...valid, keyGeneration: -1 }, "Human Memory current key generation must be a non-negative safe integer"],
      [{ ...valid, headDigest: new Uint8Array(31) }, "Human Memory current head digest must be exactly 32 bytes"],
      [{ ...valid, publicationDigest: new Uint8Array(31) }, "Human Memory current publication digest must be exactly 32 bytes"],
      [{ ...valid, publicationSetDigest: new Uint8Array(31) }, "Human Memory current publication-set digest must be exactly 32 bytes"],
      [{ ...valid, audienceFingerprint: new Uint8Array(31) }, "Human Memory current audience fingerprint must be exactly 32 bytes"],
      [{ ...valid, envelopeHash: new Uint8Array(31) }, "Human Memory current envelope hash must be exactly 32 bytes"],
    ];
    for (const [invalid, message] of failures) {
      expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
        ...state.input,
        currentEntries: [invalid] as never,
      })).toThrow(message);
    }
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      currentEntries: [valid, valid],
    })).toThrow("Human Memory current entries must be unique and canonically sorted");
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      currentEntries: [entry(NS_B, 2), valid],
    })).toThrow("Human Memory current entries must be unique and canonically sorted");
    const maximumEntries = Array.from(
      { length: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2 },
      (_, index) => entry(`namespace-${String(index).padStart(3, "0")}`, index + 1),
    );
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      currentEntries: maximumEntries,
      currentAuthorityEntries: maximumEntries.map(authorityEntry),
      targetEntries: [],
      targetAuthorityEntries: [],
    })).not.toThrow();
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      targetEntries: [{ ...valid, headDigest: new Uint8Array(31) }],
    })).toThrow("Human Memory target head digest must be exactly 32 bytes");
    const { signature: _, ...unsigned } =
      prepareHumanMemoryExactAccessRequestV2(state.crypto, state.input).request;
    expect(() => humanMemoryExactAccessRequestSigningBytesV2({
      ...unsigned,
      targetEntries: Array.from(
        { length: HUMAN_MEMORY_EXACT_ACCESS_REQUEST_MAX_ENTRIES_V2 + 1 },
        (_, index) => entry(`namespace-${String(index).padStart(3, "0")}`, index + 1),
      ),
    })).toThrow("Human Memory target entry inventory is not bounded");
  });

  test("rejects malformed wire and signing authority at their exact boundaries", () => {
    const state = fixture(2_508);
    expect(() => decodeHumanMemoryExactAccessRequestV2(null as never))
      .toThrow("Human Memory exact-access request bytes must be Uint8Array");
    expect(() => decodeHumanMemoryExactAccessRequestV2(
      new Uint8Array(MAX_HUMAN_MEMORY_EXACT_ACCESS_REQUEST_WIRE_BYTES_V2 + 1),
    )).toThrow("Human Memory exact-access request exceeds its wire limit");
    const createdForShape = prepareHumanMemoryExactAccessRequestV2(
      state.crypto,
      state.input,
    );
    expect(() => encodeHumanMemoryExactAccessRequestV2(null as never))
      .toThrow("Human Memory exact-access request must be an object");
    expect(() => encodeHumanMemoryExactAccessRequestV2({
      ...createdForShape.request,
      extra: true,
    } as never)).toThrow("Human Memory exact-access request has an invalid field set");
    expect(() => encodeHumanMemoryExactAccessRequestV2({
      ...createdForShape.request,
      signature: new Uint8Array(63),
    })).toThrow("Human Memory exact-access signature must be exactly 64 bytes");
    const wrongDomain = createdForShape.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => decodeHumanMemoryExactAccessRequestV2(wrongDomain))
      .toThrow("Human Memory exact-access request domain mismatch");
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      committerSigningPublicKey: new Uint8Array(31),
    })).toThrow("Human Memory exact-access signing public key must be exactly 32 bytes");
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      committerSigningPrivateKey: new Uint8Array(31),
    })).toThrow("Human Memory exact-access signing private key must be exactly 32 bytes");
    const other = state.crypto.generateSigningKeyPair();
    expect(() => prepareHumanMemoryExactAccessRequestV2(state.crypto, {
      ...state.input,
      committerSigningPublicKey: other.publicKey,
    })).toThrow("Human Memory exact-access signing keys do not match");

    const created = prepareHumanMemoryExactAccessRequestV2(state.crypto, state.input);
    expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => new Uint8Array(31),
    })).toThrow("Human Memory exact-access authority public key must be exactly 32 bytes");
    expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => state.signer.publicKey,
    })).not.toThrow();
  });

  test("wipes owned signing and verification material on success and failure", () => {
    const state = fixture(2_509);
    const captured: Uint8Array[] = [];
    const originalSign = state.crypto.sign.bind(state.crypto);
    const originalVerify = state.crypto.verify.bind(state.crypto);
    state.crypto.sign = (privateKey, message) => {
      captured.push(privateKey, message);
      return originalSign(privateKey, message);
    };
    state.crypto.verify = (publicKey, message, signature) => {
      captured.push(publicKey, message, signature);
      return originalVerify(publicKey, message, signature);
    };
    const created = prepareHumanMemoryExactAccessRequestV2(
      state.crypto,
      state.input,
    );
    expect(captured).not.toHaveLength(0);
    expect(captured.every((value) => value.every((byte) => byte === 0)))
      .toBeTrue();

    captured.length = 0;
    expect(() => verifyHumanMemoryExactAccessRequestV2(state.crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_010_000),
      resolveCurrentAuthority: () => new Uint8Array(32).fill(0xff),
    })).toThrow("signature");
    expect(captured.every((value) => value.every((byte) => byte === 0)))
      .toBeTrue();
  });
});

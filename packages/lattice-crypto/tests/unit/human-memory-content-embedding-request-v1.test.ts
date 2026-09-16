import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2,
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2,
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2,
  HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2,
  MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2,
  decodeHumanMemoryContentEmbeddingRequestV2,
  encodeHumanMemoryContentEmbeddingRequestV2,
  humanMemoryContentEmbeddingRequestSigningBytesV2,
  prepareHumanMemoryContentEmbeddingRequestV2,
  verifyHumanMemoryContentEmbeddingRequestV2,
  type HumanMemoryContentEmbeddingRequestUnsignedV2,
  type HumanMemoryContentEmbeddingRequestV2,
  type PrepareHumanMemoryContentEmbeddingRequestInputV2,
} from "../../src/memory/content-embedding-request-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const NS_A = "11111111-1111-4111-8111-111111111111";
const NS_B = "22222222-2222-4222-8222-222222222222";
const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function fixture(seed = 2_430): Readonly<{
  crypto: LatticeCrypto;
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>;
  input: PrepareHumanMemoryContentEmbeddingRequestInputV2;
}> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const signer = crypto.generateSigningKeyPair();
  return {
    crypto,
    signer,
    input: {
      subjectHumanId: humanId("human-alice"),
      requestId: "memory-embedding-request-1",
      memoryId: MEMORY_ID,
      expectedProductRevision: 2,
      nextProductRevision: 3,
      cryptoObjectId: objectId("memory:v1:object-3"),
      ciphertextPayloadHash: hash(1),
      genesisManifestHash: hash(2),
      namespaceEnvelopes: [
        { namespaceId: namespaceId(NS_A), envelopeHash: hash(4) },
        { namespaceId: namespaceId(NS_B), envelopeHash: hash(5) },
      ],
      type: "preference",
      content: "Prefers concise answers 🧡",
      importance: 0.75,
      requestedProvider: "openai",
      requestedModel: "text-embedding-3-small",
      dimensions: 1536,
      processorContractVersion: 1,
      issuedAt: unixTimestamp(1_000_000),
      deadlineAt: unixTimestamp(1_020_000),
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(7),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  };
}

function unsigned(
  request: HumanMemoryContentEmbeddingRequestV2,
): Omit<HumanMemoryContentEmbeddingRequestV2, "signature"> {
  const { signature: _, ...value } = request;
  return value;
}

function unsignedInput(
  input: PrepareHumanMemoryContentEmbeddingRequestInputV2,
): HumanMemoryContentEmbeddingRequestUnsignedV2 {
  const {
    committerSigningPublicKey: _publicKey,
    committerSigningPrivateKey: _privateKey,
    ...value
  } = input;
  void _publicKey;
  void _privateKey;
  return {
    ...value,
    formatVersion: 2,
    purpose: "memory.content_embedding",
  };
}

describe("HumanMemoryContentEmbeddingRequestV2", () => {
  test("round-trips Venice disclosure and rejects changing its signed provider", () => {
    const state = fixture();
    const created = prepareHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      ...state.input,
      requestedProvider: "venice",
    });
    expect(decodeHumanMemoryContentEmbeddingRequestV2(created.bytes).requestedProvider)
      .toBe("venice");
    expect(verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_010_000),
    }).requestedProvider).toBe("venice");
    const tampered = encodeHumanMemoryContentEmbeddingRequestV2({
      ...created.request,
      requestedProvider: "openai",
    });
    expect(() => verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: tampered,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_010_000),
    })).toThrow();
  });

  test("locks the domain, format, content, deadline, and wire bounds", () => {
    expect(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2).toBe(
      "nautilo/lattice-crypto/human-memory-content-embedding-request/v2",
    );
    expect(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_FORMAT_VERSION_V2).toBe(2);
    expect(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2)
      .toBe(64 * 1024);
    expect(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_TTL_MS_V2).toBe(30_000);
    expect(MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2)
      .toBe(160 * 1024);
  });

  test("prepares, strictly round-trips, and verifies an exact signed request", () => {
    const state = fixture();
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    );
    expect(createHash("sha256").update(created.bytes).digest("hex")).toBe(
      "c13b10abbac77cfd72f9a57bc3feedbef269cc8e83f2b55f3e8d51b1d4a31fa5",
    );
    const decoded = decodeHumanMemoryContentEmbeddingRequestV2(created.bytes);

    expect(decoded).toEqual(created.request);
    expect(encodeHumanMemoryContentEmbeddingRequestV2(decoded))
      .toEqual(created.bytes);
    expect(verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_010_000),
    })).toEqual(created.request);
    expect(decoded.purpose).toBe("memory.content_embedding");
    expect(decoded.content).toBe(state.input.content);
    expect(decoded.namespaceEnvelopes.map((entry) => entry.namespaceId))
      .toEqual([namespaceId(NS_A), namespaceId(NS_B)]);

    const signingBytes = humanMemoryContentEmbeddingRequestSigningBytesV2(
      unsigned(decoded),
    );
    expect(signingBytes).toEqual(created.bytes.slice(0, -68));
    signingBytes.fill(0);
  });

  test("accepts exact create revision zero-to-one without widening updates", () => {
    const state = fixture(2_437);
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      {
        ...state.input,
        expectedProductRevision: 0,
        nextProductRevision: 1,
      },
    );
    expect(decodeHumanMemoryContentEmbeddingRequestV2(created.bytes))
      .toEqual(created.request);
    expect(created.request.expectedProductRevision).toBe(0);
    expect(created.request.nextProductRevision).toBe(1);

    for (const revisions of [
      { expectedProductRevision: -1, nextProductRevision: 0 },
      { expectedProductRevision: 0, nextProductRevision: 2 },
      { expectedProductRevision: 1, nextProductRevision: 1 },
      { expectedProductRevision: 2_147_483_647, nextProductRevision: 2_147_483_648 },
    ]) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
        state.crypto,
        { ...state.input, ...revisions },
      )).toThrow();
    }
  });

  test("signature covers every field and rejects a different device key", () => {
    const state = fixture(2_431);
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    );
    const substitutions: HumanMemoryContentEmbeddingRequestV2[] = [
      { ...created.request, subjectHumanId: humanId("human-bob") },
      { ...created.request, requestId: "memory-embedding-request-2" },
      { ...created.request, memoryId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      { ...created.request, expectedProductRevision: 3, nextProductRevision: 4 },
      { ...created.request, cryptoObjectId: objectId("memory:v1:other") },
      { ...created.request, ciphertextPayloadHash: hash(9) },
      { ...created.request, genesisManifestHash: hash(9) },
      {
        ...created.request,
        namespaceEnvelopes: created.request.namespaceEnvelopes.map(
          (entry, index) => index === 0
            ? { ...entry, envelopeHash: hash(9) }
            : entry,
        ),
      },
      {
        ...created.request,
        namespaceEnvelopes: created.request.namespaceEnvelopes.map(
          (entry, index) => index === 0
            ? {
              ...entry,
              namespaceId: namespaceId(
                "00000000-0000-4000-8000-000000000001",
              ),
            }
            : entry,
        ),
      },
      { ...created.request, type: "goal" },
      { ...created.request, content: "different plaintext" },
      { ...created.request, importance: 0.5 },
      { ...created.request, requestedProvider: "openrouter" },
      { ...created.request, requestedModel: "other/model" },
      { ...created.request, issuedAt: unixTimestamp(1_000_001) },
      { ...created.request, deadlineAt: unixTimestamp(1_020_001) },
      { ...created.request, committerDeviceId: cryptoDeviceId("device-alice-2") },
      {
        ...created.request,
        hostAuthorizationRevision: authorizationRevision(8),
      },
    ];
    for (const substituted of substitutions) {
      const bytes = encodeHumanMemoryContentEmbeddingRequestV2(substituted);
      expect(() => verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
        requestBytes: bytes,
        committerSigningPublicKey: state.signer.publicKey,
        now: unixTimestamp(1_010_000),
      })).toThrow("signature");
    }
    const other = state.crypto.generateSigningKeyPair();
    expect(() => verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: other.publicKey,
      now: unixTimestamp(1_010_000),
    })).toThrow("signature");
  });

  test("accepts only the signed request's transient validity window", () => {
    const state = fixture(2_436);
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    );
    for (const now of [999_999, 1_020_000, 1_020_001]) {
      expect(() => verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
        requestBytes: created.bytes,
        committerSigningPublicKey: state.signer.publicKey,
        now: unixTimestamp(now),
      })).toThrow("not currently valid");
    }
    expect(verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_000_000),
    }).requestId).toBe(state.input.requestId);
  });

  test("requires one canonical exact Namespace and envelope-hash inventory", () => {
    const state = fixture(2_432);
    for (const namespaceEnvelopes of [
      [],
      [...state.input.namespaceEnvelopes].reverse(),
      [
        state.input.namespaceEnvelopes[0]!,
        { ...state.input.namespaceEnvelopes[0]!, envelopeHash: hash(8) },
      ],
      [{ ...state.input.namespaceEnvelopes[0]!, envelopeHash: hash(1).slice(1) }],
    ]) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
        state.crypto,
        { ...state.input, namespaceEnvelopes },
      )).toThrow();
    }
    expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      {
        ...state.input,
        namespaceEnvelopes: Array.from(
          { length: 257 },
          (_, index) => ({
            namespaceId: namespaceId(`ns-${String(index).padStart(3, "0")}`),
            envelopeHash: hash(index),
          }),
        ),
      },
    )).toThrow();
  });

  test("enforces raw plaintext, revision, provider, model, and deadline bounds", () => {
    const state = fixture(2_433);
    for (const patch of [
      { content: "" },
      { content: "x".repeat(64 * 1024 + 1) },
      { type: "" },
      { type: "x".repeat(257) },
      { importance: -0.01 },
      { importance: 1.01 },
      { importance: Number.NaN },
      { nextProductRevision: 4 },
      { requestedProvider: "other" },
      { requestedModel: "" },
      { dimensions: 1 },
      { processorContractVersion: 2 },
      { issuedAt: 1_020_000, deadlineAt: 1_020_000 },
      { deadlineAt: 1_030_001 },
    ]) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
        state.crypto,
        { ...state.input, ...patch } as never,
      )).toThrow();
    }
  });

  test("canonically distinguishes omitted importance from an explicit value", () => {
    const state = fixture(2_446);
    const { importance: _importance, ...withoutImportance } = state.input;
    const omitted = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      withoutImportance,
    );
    expect(omitted.request).not.toHaveProperty("importance");
    expect(prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    ).request.importance).toBe(0.75);
  });

  test("rejects every malformed unsigned field at the signing-byte boundary", () => {
    const state = fixture(2_443);
    const value = unsignedInput(state.input);
    const invalidPatches: readonly Record<string, unknown>[] = [
      { expectedProductRevision: 1.5, nextProductRevision: 2.5 },
      { expectedProductRevision: -1, nextProductRevision: 0 },
      {
        expectedProductRevision: 2_147_483_647,
        nextProductRevision: 2_147_483_648,
      },
      { ciphertextPayloadHash: new Uint8Array(31) },
      { genesisManifestHash: new Uint8Array(31) },
      { namespaceEnvelopes: [] },
      {
        namespaceEnvelopes: Array.from(
          { length: 257 },
          (_, index) => ({
            namespaceId: namespaceId(
              `namespace-${String(index).padStart(3, "0")}`,
            ),
            envelopeHash: hash(index),
          }),
        ),
      },
      { content: "" },
      {
        content: "x".repeat(
          HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2 + 1,
        ),
      },
      { requestedProvider: "other" },
      { dimensions: 1 },
      { processorContractVersion: 2 },
      { issuedAt: unixTimestamp(1_020_000), deadlineAt: unixTimestamp(1_020_000) },
      { deadlineAt: unixTimestamp(1_030_001) },
    ];
    for (const patch of invalidPatches) {
      expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
        ...value,
        ...patch,
      } as never)).toThrow();
    }
  });

  test("reports the unsigned boundary responsible for malformed input", () => {
    const value = unsignedInput(fixture(2_445).input);
    const cases: readonly [Record<string, unknown>, string][] = [
      [
        { expectedProductRevision: -1, nextProductRevision: 0 },
        "expected product revision is invalid",
      ],
      [
        { expectedProductRevision: 2, nextProductRevision: 4 },
        "must advance exactly once",
      ],
      [
        { ciphertextPayloadHash: new Uint8Array(31) },
        "payload hash must be exactly 32 bytes",
      ],
      [
        { namespaceEnvelopes: [] },
        "Namespace envelope inventory is not bounded",
      ],
      [
        { content: "" },
        "plaintext is outside its byte bound",
      ],
      [
        { requestedProvider: "other" },
        "provider is unsupported",
      ],
    ];
    for (const [patch, message] of cases) {
      expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
        ...value,
        ...patch,
      } as never)).toThrow(message);
    }
  });

  test("rejects malformed top-level and nested request shapes before signing", () => {
    const state = fixture(2_438);
    const unsignedValue = unsignedInput(state.input);
    for (const value of [null, [], "request", 1]) {
      expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2(
        value as never,
      )).toThrow("must be an object");
    }
    expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
      ...unsignedValue,
      extra: true,
    } as never)).toThrow("invalid field set");
    const { content: omittedContent, ...missingContent } = unsignedValue;
    expect(omittedContent).toBe(state.input.content);
    expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2(
      missingContent as never,
    )).toThrow("invalid field set");
    for (const namespaceEnvelopes of [
      [null],
      [[namespaceId(NS_A), hash(1)]],
      [{
        namespaceId: namespaceId(NS_A),
        envelopeHash: hash(1),
        extra: true,
      }],
    ]) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
        state.crypto,
        { ...state.input, namespaceEnvelopes } as never,
      )).toThrow();
    }
  });

  test("rejects isolated canonical-shape and scalar substitutions", () => {
    const state = fixture(2_440);
    const value = unsignedInput(state.input);
    const { content: _, ...withoutContent } = value;
    expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
      ...withoutContent,
      contents: value.content,
    } as never)).toThrow("invalid field set");

    for (const memoryId of [`x${MEMORY_ID}`, `${MEMORY_ID}x`]) {
      expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
        ...value,
        memoryId,
      })).toThrow("Memory ID is invalid");
    }
    for (const patch of [
      { formatVersion: 1 },
      { purpose: "memory.other" },
      { expectedProductRevision: 2_147_483_647, nextProductRevision: 2_147_483_648 },
    ]) {
      expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
        ...value,
        ...patch,
      } as never)).toThrow();
    }
    expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
      ...value,
      content: "x",
    })).not.toThrow();

    const maximumNamespaceSet = Array.from(
      { length: 256 },
      (_, index) => ({
        namespaceId: namespaceId(`namespace-${String(index).padStart(3, "0")}`),
        envelopeHash: hash(index),
      }),
    );
    expect(() => humanMemoryContentEmbeddingRequestSigningBytesV2({
      ...value,
      namespaceEnvelopes: maximumNamespaceSet,
    })).not.toThrow();
  });

  test("enforces exact scalar, byte, UUID, and inclusive upper boundaries", () => {
    const state = fixture(2_439);
    const invalidPatches: readonly Record<string, unknown>[] = [
      { memoryId: `x${MEMORY_ID}` },
      { memoryId: `${MEMORY_ID}x` },
      { memoryId: MEMORY_ID.toUpperCase() },
      { memoryId: 7 },
      { expectedProductRevision: 1.5, nextProductRevision: 2.5 },
      { expectedProductRevision: "2", nextProductRevision: 3 },
      { expectedProductRevision: 2_147_483_648, nextProductRevision: 2_147_483_649 },
      { ciphertextPayloadHash: hash(1).slice(1) },
      { ciphertextPayloadHash: Array.from(hash(1)) },
      { genesisManifestHash: hash(2).slice(1) },
      { content: 7 },
      { requestedProvider: "OPENAI" },
      { requestedModel: "model with spaces" },
      { dimensions: 1535 },
      { processorContractVersion: 0 },
      { committerSigningPublicKey: state.signer.publicKey.slice(1) },
      { committerSigningPrivateKey: state.signer.privateKey.slice(1) },
    ];
    for (const patch of invalidPatches) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
        state.crypto,
        { ...state.input, ...patch } as never,
      )).toThrow();
    }

    for (const accepted of [
      { expectedProductRevision: 2_147_483_646, nextProductRevision: 2_147_483_647 },
      { content: "x".repeat(HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_MAX_CONTENT_BYTES_V2) },
      { requestedProvider: "openrouter" },
      { deadlineAt: unixTimestamp(1_030_000) },
    ] as const) {
      expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
        state.crypto,
        { ...state.input, ...accepted },
      )).not.toThrow();
    }
  });

  test("rejects noncanonical, truncated, trailing, and oversized wire bytes", () => {
    const state = fixture(2_434);
    const bytes = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    ).bytes;
    const badVersion = bytes.slice();
    // First field is a framed domain; the following u32 is the version.
    const versionOffset = 4 + new TextEncoder().encode(
      HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_DOMAIN_V2,
    ).length;
    badVersion[versionOffset + 3] = 1;
    const badDomain = bytes.slice();
    badDomain[4] = badDomain[4]! ^ 1;
    for (const candidate of [
      bytes.slice(0, -1),
      Uint8Array.from([...bytes, 0]),
      badVersion,
      badDomain,
      new Uint8Array(
        MAX_HUMAN_MEMORY_CONTENT_EMBEDDING_REQUEST_WIRE_BYTES_V2 + 1,
      ),
    ]) {
      expect(() => decodeHumanMemoryContentEmbeddingRequestV2(candidate))
        .toThrow();
    }
    expect(() => decodeHumanMemoryContentEmbeddingRequestV2(
      Array.from(bytes) as never,
    )).toThrow("must be Uint8Array");
  });

  test("snapshots caller-owned hashes and key inputs without retaining secrets", () => {
    const state = fixture(2_435);
    const payloadHash = state.input.ciphertextPayloadHash.slice();
    const privateKey = state.input.committerSigningPrivateKey.slice();
    const input = {
      ...state.input,
      ciphertextPayloadHash: payloadHash,
      committerSigningPrivateKey: privateKey,
    };
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      input,
    );
    payloadHash.fill(0xff);
    privateKey.fill(0xff);
    expect(created.request.ciphertextPayloadHash).toEqual(hash(1));
    expect(verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_010_000),
    }).content).toBe(state.input.content);
  });

  test("rejects a mismatched signing-key pair during preparation", () => {
    const state = fixture(2_441);
    const other = state.crypto.generateSigningKeyPair();
    expect(() => prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      {
        ...state.input,
        committerSigningPrivateKey: other.privateKey,
      },
    )).toThrow("signing keys do not match");
  });

  test("wipes every temporary key and signing buffer exposed to crypto", () => {
    const state = fixture(2_442);
    const prepareBuffers: Uint8Array[] = [];
    const originalSign = state.crypto.sign.bind(state.crypto);
    const originalVerify = state.crypto.verify.bind(state.crypto);
    state.crypto.sign = (privateKey, message) => {
      prepareBuffers.push(privateKey, message);
      return originalSign(privateKey, message);
    };
    state.crypto.verify = (publicKey, message, signature) => {
      prepareBuffers.push(publicKey, message, signature);
      return originalVerify(publicKey, message, signature);
    };
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    );
    for (const buffer of prepareBuffers) {
      expect(buffer.every((byte) => byte === 0)).toBeTrue();
    }

    const verifyBuffers: Uint8Array[] = [];
    state.crypto.verify = (publicKey, message, signature) => {
      verifyBuffers.push(publicKey, message);
      return originalVerify(publicKey, message, signature);
    };
    expect(verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_010_000),
    }).requestId).toBe(state.input.requestId);
    for (const buffer of verifyBuffers) {
      expect(buffer.every((byte) => byte === 0)).toBeTrue();
    }
  });

  test("destroys the decoded request and verifier temporaries on signature failure", () => {
    const state = fixture(2_444);
    const created = prepareHumanMemoryContentEmbeddingRequestV2(
      state.crypto,
      state.input,
    );
    const observed: Uint8Array[] = [];
    state.crypto.verify = (publicKey, message, signature) => {
      observed.push(publicKey, message, signature);
      return false;
    };
    expect(() => verifyHumanMemoryContentEmbeddingRequestV2(state.crypto, {
      requestBytes: created.bytes,
      committerSigningPublicKey: state.signer.publicKey,
      now: unixTimestamp(1_010_000),
    })).toThrow("signature is invalid");
    for (const buffer of observed) {
      expect(buffer.every((byte) => byte === 0)).toBeTrue();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1,
  HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_TTL_MS_V1,
  MAX_HUMAN_ARTIFACT_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  decodeHumanArtifactPublicationRequestV1,
  encodeHumanArtifactPublicationRequestV1,
  humanArtifactPublicationRequestSigningBytesV1,
  prepareHumanArtifactPublicationRequestV1,
  verifyHumanArtifactPublicationRequestV1,
  type HumanArtifactPublicationRequestEntryV1,
  type PrepareHumanArtifactPublicationRequestInputV1,
} from "../../src/artifact/publication-request-v1.ts";
import {
  ARTIFACT_BLOB_MAX_CHUNKS_V1,
  ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
} from "../../src/artifact/blob-v1.ts";
import {
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  humanId,
  namespaceId,
  objectId,
  unixTimestamp,
} from "../../src/v2-types/ids.ts";

const ARTIFACT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BLOB_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NS_A = "11111111-1111-4111-8111-111111111111";
const NS_B = "22222222-2222-4222-8222-222222222222";

function hash(marker: number): Uint8Array {
  return new Uint8Array(32).fill(marker);
}

function entry(id: string, marker: number): HumanArtifactPublicationRequestEntryV1 {
  return {
    namespaceId: namespaceId(id),
    domainId: cryptoDomainId(`domain-${marker}`),
    expectedNamespaceAccessRevision: marker,
    expectedPolicyRevision: marker + 1,
    bindingHash: hash(marker),
    keyGeneration: marker + 2,
    bindingRevisionAtWrap: marker,
    envelopeHash: hash(marker + 10),
  };
}

function fixture(seed = 4_100): Readonly<{
  crypto: LatticeCrypto;
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>;
  input: PrepareHumanArtifactPublicationRequestInputV1;
}> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const signer = crypto.generateSigningKeyPair();
  return {
    crypto,
    signer,
    input: {
      operation: "create",
      lifecycleAction: "activate",
      subjectHumanId: humanId("human-alice"),
      operationId: "artifact-publication-1",
      planDigest: new Uint8Array(32).fill(0x15),
      artifactRowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      artifactId: ARTIFACT_ID,
      anchorNamespaceId: namespaceId(NS_A),
      cryptoObjectId: objectId(`artifact:v1:${"a".repeat(64)}`),
      expectedArtifactRevision: 0,
      nextArtifactRevision: 1,
      expectedAccessRevision: 0,
      resultAccessRevision: 0,
      expectedBlobGeneration: 0,
      resultBlobGeneration: 1,
      expectedBlobId: null,
      resultBlobId: BLOB_ID,
      controlPayloadHash: hash(1),
      accessManifestHash: hash(2),
      entries: [entry(NS_A, 1), entry(NS_B, 2)],
      ciphertextLength: 1_048_741,
      ciphertextSha256: hash(3),
      chunkPlaintextBytes: 1_048_576,
      chunkCount: 2,
      mimeClass: "document",
      sizeBucket: "le_10_mib",
      issuedAt: unixTimestamp(1_000_000),
      deadlineAt: unixTimestamp(1_020_000),
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(9),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  };
}

describe("HumanArtifactPublicationRequestV1", () => {
  test("round-trips and verifies exact product, blob, crypto, and audience facts", () => {
    const state = fixture();
    const created = prepareHumanArtifactPublicationRequestV1(state.crypto, state.input);
    expect(createHash("sha256").update(created.bytes).digest("hex"))
      .toBe("0ab668d77b204d28c16e60389056eeed62cf02d2fa402e2291d62e7778345e3e");
    expect(decodeHumanArtifactPublicationRequestV1(created.bytes)).toEqual(created.request);
    expect(encodeHumanArtifactPublicationRequestV1(created.request)).toEqual(created.bytes);
    const contexts: unknown[] = [];
    expect(verifyHumanArtifactPublicationRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_010_000),
      resolveCurrentAuthority: (context) => {
        contexts.push(context);
        return state.signer.publicKey;
      },
    })).toEqual(created.request);
    expect(contexts).toEqual([{
      purpose: "human-artifact-publication-verify",
      subjectHumanId: "human-alice",
      operationId: "artifact-publication-1",
      committerDeviceId: "device-alice-1",
      hostAuthorizationRevision: 9,
    }]);
    const { signature: _, ...unsigned } = created.request;
    const signingBytes = humanArtifactPublicationRequestSigningBytesV1(unsigned);
    expect(state.crypto.verify(state.signer.publicKey, signingBytes, created.request.signature)).toBeTrue();
    signingBytes.fill(0);
  });

  test("enforces create, content-replacement, and no-copy control coordinates", () => {
    const state = fixture(4_101);
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      operation: "replace_content",
    })).toThrow("content replacement");
    expect(prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      operation: "replace_content",
      expectedArtifactRevision: 4,
      nextArtifactRevision: 5,
      expectedAccessRevision: 3,
      expectedBlobGeneration: 7,
      resultBlobGeneration: 8,
      expectedBlobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }).request.resultBlobGeneration).toBe(8);
    expect(prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      operation: "revise_control",
      lifecycleAction: "archive",
      expectedArtifactRevision: 4,
      nextArtifactRevision: 5,
      expectedAccessRevision: 3,
      expectedBlobGeneration: 7,
      resultBlobGeneration: 7,
      expectedBlobId: BLOB_ID,
    }).request.resultBlobId).toBe(BLOB_ID);
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      lifecycleAction: "archive",
    })).toThrow("lifecycle action");
  });

  test("rejects every invalid replacement and control-revision coordinate independently", () => {
    const state = fixture(4_109);
    const replacement = {
      ...state.input,
      operation: "replace_content" as const,
      expectedArtifactRevision: 4,
      nextArtifactRevision: 5,
      expectedAccessRevision: 3,
      expectedBlobGeneration: 7,
      resultBlobGeneration: 8,
      expectedBlobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    for (const patch of [
      { expectedArtifactRevision: 0, nextArtifactRevision: 1 },
      { expectedBlobGeneration: 0, resultBlobGeneration: 1 },
      { expectedBlobId: null },
      { resultBlobGeneration: 7 },
      { resultBlobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    ]) {
      expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...replacement,
        ...patch,
      })).toThrow("content replacement coordinates");
    }

    const controlRevision = {
      ...replacement,
      operation: "revise_control" as const,
      lifecycleAction: "archive" as const,
      resultBlobGeneration: 7,
      resultBlobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    for (const patch of [
      { expectedArtifactRevision: 0, nextArtifactRevision: 1 },
      { expectedBlobGeneration: 0, resultBlobGeneration: 0 },
      { expectedBlobId: null },
      { resultBlobGeneration: 8 },
      { resultBlobId: BLOB_ID },
    ]) {
      expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...controlRevision,
        ...patch,
      })).toThrow("control revision coordinates");
    }
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...replacement,
      expectedArtifactRevision: 1,
      nextArtifactRevision: 2,
      expectedBlobGeneration: 1,
      resultBlobGeneration: 2,
    })).not.toThrow();
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...controlRevision,
      expectedArtifactRevision: 1,
      nextArtifactRevision: 2,
      expectedBlobGeneration: 1,
      resultBlobGeneration: 1,
    })).not.toThrow();
  });

  test("rejects noncanonical audience inventories and invalid ciphertext bounds", () => {
    const state = fixture(4_102);
    for (const input of [
      { entries: [] },
      { entries: [entry(NS_B, 2), entry(NS_A, 1)] },
      { entries: [entry(NS_A, 1), entry(NS_A, 2)] },
      { ciphertextLength: 0 },
      { chunkCount: 0 },
      { resultAccessRevision: 1 },
      { mimeClass: "plaintext" },
      { sizeBucket: "huge" },
    ] as readonly Readonly<Record<string, unknown>>[]) {
      expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...state.input,
        ...input,
      } as unknown as PrepareHumanArtifactPublicationRequestInputV1)).toThrow();
    }
  });

  test("rejects mutation, wrong signer, early use, and expiry", () => {
    const state = fixture(4_103);
    const created = prepareHumanArtifactPublicationRequestV1(state.crypto, state.input);
    const tampered = created.bytes.slice();
    tampered[Math.floor(tampered.length / 2)]! ^= 1;
    for (const [bytes, now, key] of [
      [tampered, 1_010_000, state.signer.publicKey],
      [created.bytes, 999_999, state.signer.publicKey],
      [created.bytes, 1_020_000, state.signer.publicKey],
      [created.bytes, 1_010_000, fixture(4_104).signer.publicKey],
    ] as const) {
      expect(() => verifyHumanArtifactPublicationRequestV1(state.crypto, {
        requestBytes: bytes,
        now: unixTimestamp(now),
        resolveCurrentAuthority: () => key,
      })).toThrow();
    }
  });

  test("signature binds every product, crypto, audience, time, and authority fact", () => {
    const state = fixture(4_105);
    const created = prepareHumanArtifactPublicationRequestV1(state.crypto, state.input);
    const substitutions: ReadonlyArray<Record<string, unknown>> = [
      { operation: "replace_content" },
      { lifecycleAction: "archive" },
      { subjectHumanId: humanId("human-bob") },
      { operationId: "artifact-publication-2" },
      { planDigest: hash(99) },
      { artifactRowId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
      { artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { anchorNamespaceId: namespaceId(NS_B) },
      { cryptoObjectId: objectId(`artifact:v1:${"b".repeat(64)}`) },
      { expectedArtifactRevision: 1, nextArtifactRevision: 2 },
      { expectedAccessRevision: 1 },
      { expectedBlobGeneration: 1, resultBlobGeneration: 2 },
      { expectedBlobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { resultBlobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { controlPayloadHash: hash(99) },
      { accessManifestHash: hash(99) },
      { entries: [entry(NS_A, 1), { ...entry(NS_B, 2), envelopeHash: hash(99) }] },
      { ciphertextLength: 1_048_742 },
      { ciphertextSha256: hash(99) },
      { chunkCount: 3 },
      { mimeClass: "binary" },
      { sizeBucket: "le_100_mib" },
      { issuedAt: unixTimestamp(1_000_001) },
      { deadlineAt: unixTimestamp(1_020_001) },
      { committerDeviceId: cryptoDeviceId("device-alice-2") },
      { hostAuthorizationRevision: authorizationRevision(10) },
    ];
    for (const patch of substitutions) {
      let bytes: Uint8Array | undefined;
      try {
        bytes = encodeHumanArtifactPublicationRequestV1({
          ...created.request,
          ...patch,
        } as never);
      } catch {
        // Some single-coordinate substitutions intentionally violate the
        // request's cross-field invariants before signature verification.
        continue;
      }
      expect(() => verifyHumanArtifactPublicationRequestV1(state.crypto, {
        requestBytes: bytes,
        now: unixTimestamp(1_010_000),
        resolveCurrentAuthority: () => state.signer.publicKey,
      })).toThrow("signature");
      bytes.fill(0);
    }
  });

  test("validates exact request shape, identifiers, hashes, counters, and deadlines", () => {
    const state = fixture(4_106);
    const failures: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ operation: "copy" }, "kind"],
      [{ lifecycleAction: "delete" }, "lifecycle action"],
      [{ operationId: "" }, "operation id"],
      [{ planDigest: new Uint8Array(31) }, "plan digest"],
      [{ artifactRowId: 1 }, "canonical UUID"],
      [{ artifactRowId: `x${state.input.artifactRowId}` }, "canonical UUID"],
      [{ artifactRowId: { toString: () => state.input.artifactRowId } }, "canonical UUID"],
      [{ artifactId: `${ARTIFACT_ID}x` }, "canonical UUID"],
      [{ expectedArtifactRevision: -1 }, "Expected Artifact revision"],
      [{ nextArtifactRevision: 2 }, "advance exactly once"],
      [{ expectedArtifactRevision: 1, nextArtifactRevision: 2 }, "create coordinates"],
      [{ expectedAccessRevision: -1 }, "access revision"],
      [{ expectedAccessRevision: 1 }, "create coordinates"],
      [{ resultAccessRevision: 1 }, "access revision zero"],
      [{ expectedBlobGeneration: -1 }, "blob generation"],
      [{ expectedBlobGeneration: 1 }, "create coordinates"],
      [{ resultBlobGeneration: 2 }, "create coordinates"],
      [{ expectedBlobId: BLOB_ID }, "create coordinates"],
      [{ resultBlobId: 1 }, "canonical UUID"],
      [{ controlPayloadHash: new Uint8Array(31) }, "control payload hash"],
      [{ accessManifestHash: new Uint8Array(31) }, "access manifest hash"],
      [{ ciphertextLength: 0 }, "ciphertext coordinates"],
      [{ ciphertextLength: Number.MAX_SAFE_INTEGER }, "ciphertext coordinates"],
      [{ ciphertextSha256: new Uint8Array(31) }, "ciphertext hash"],
      [{ chunkPlaintextBytes: 1 }, "ciphertext coordinates"],
      [{ chunkCount: Number.MAX_SAFE_INTEGER }, "ciphertext coordinates"],
      [{ mimeClass: "plaintext" }, "MIME class"],
      [{ sizeBucket: "huge" }, "size bucket"],
      [{ deadlineAt: state.input.issuedAt }, "deadline"],
      [{
        deadlineAt: unixTimestamp(
          Number(state.input.issuedAt)
            + HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_TTL_MS_V1 + 1,
        ),
      }, "deadline"],
      [{ committerSigningPublicKey: new Uint8Array(31) }, "signing public key"],
      [{ committerSigningPrivateKey: new Uint8Array(31) }, "signing private key"],
    ];
    for (const [patch, message] of failures) {
      expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...state.input,
        ...patch,
      } as never)).toThrow(message);
    }
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      deadlineAt: unixTimestamp(
        Number(state.input.issuedAt)
          + HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_TTL_MS_V1,
      ),
    })).not.toThrow();
    const created = prepareHumanArtifactPublicationRequestV1(state.crypto, state.input);
    const { signature: _, ...unsigned } = created.request;
    expect(() => humanArtifactPublicationRequestSigningBytesV1(null as never))
      .toThrow("must be an object");
    const decoratedFunction = Object.assign(() => undefined, unsigned);
    expect(() => humanArtifactPublicationRequestSigningBytesV1(
      decoratedFunction as never,
    )).toThrow("must be an object");
    expect(() => humanArtifactPublicationRequestSigningBytesV1({
      ...unsigned,
      extra: true,
    } as never)).toThrow("invalid field set");
    expect(() => humanArtifactPublicationRequestSigningBytesV1({
      ...unsigned,
      formatVersion: 2,
    } as never)).toThrow("kind is invalid");
    expect(() => humanArtifactPublicationRequestSigningBytesV1({
      ...unsigned,
      purpose: "future-purpose",
    } as never)).toThrow("kind is invalid");
    const replacedField = { ...unsigned } as Record<string, unknown>;
    delete replacedField["purpose"];
    replacedField["futurePurpose"] = "artifact.publish";
    expect(() => humanArtifactPublicationRequestSigningBytesV1(replacedField as never))
      .toThrow("invalid field set");
    expect(() => encodeHumanArtifactPublicationRequestV1({
      ...created.request,
      signature: new Uint8Array(63),
    })).toThrow("signature");
  });

  test("accepts every closed MIME/size value and exact ciphertext maxima", () => {
    const state = fixture(4_110);
    for (const mimeClass of [
      "text", "image", "audio", "video", "document", "archive", "binary",
    ] as const) {
      expect(prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...state.input,
        mimeClass,
      }).request.mimeClass).toBe(mimeClass);
    }
    for (const sizeBucket of [
      "empty", "le_64_kib", "le_1_mib", "le_10_mib", "le_100_mib",
    ] as const) {
      expect(prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...state.input,
        sizeBucket,
      }).request.sizeBucket).toBe(sizeBucket);
    }
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      ciphertextLength: 1,
      chunkCount: 1,
    })).not.toThrow();
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      ciphertextLength: ARTIFACT_BLOB_MAX_FILE_BYTES_V1,
      chunkCount: ARTIFACT_BLOB_MAX_CHUNKS_V1,
    })).not.toThrow();
  });

  test("validates every entry field, ordering rule, and inventory bound", () => {
    const state = fixture(4_107);
    const valid = entry(NS_A, 1);
    const failures: ReadonlyArray<readonly [unknown, string]> = [
      [null, "entry must be an object"],
      [[valid], "entry must be an object"],
      [{ ...valid, extra: true }, "invalid field set"],
      [{ ...valid, expectedNamespaceAccessRevision: -1 }, "access revision"],
      [{ ...valid, expectedPolicyRevision: -1 }, "policy revision"],
      [{ ...valid, keyGeneration: -1 }, "key generation"],
      [{ ...valid, bindingRevisionAtWrap: -1 }, "binding revision"],
      [{ ...valid, bindingHash: new Uint8Array(31) }, "binding hash"],
      [{ ...valid, envelopeHash: new Uint8Array(31) }, "envelope hash"],
    ];
    for (const [invalid, message] of failures) {
      expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
        ...state.input,
        entries: [invalid] as never,
      })).toThrow(message);
    }
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      entries: Array.from(
        { length: HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1 + 1 },
        (_, index) => entry(
          `namespace-${String(index).padStart(3, "0")}`,
          index + 1,
        ),
      ),
    })).toThrow("not bounded");
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      entries: Array.from(
        { length: HUMAN_ARTIFACT_PUBLICATION_REQUEST_MAX_ENTRIES_V1 },
        (_, index) => entry(
          `namespace-${String(index).padStart(3, "0")}`,
          index + 1,
        ),
      ),
    })).not.toThrow();
  });

  test("rejects malformed wire and unavailable or malformed authority", () => {
    const state = fixture(4_108);
    expect(() => decodeHumanArtifactPublicationRequestV1(null as never))
      .toThrow("must be Uint8Array");
    expect(() => decodeHumanArtifactPublicationRequestV1(
      new Uint8Array(MAX_HUMAN_ARTIFACT_PUBLICATION_REQUEST_WIRE_BYTES_V1 + 1),
    )).toThrow("wire limit");
    const created = prepareHumanArtifactPublicationRequestV1(state.crypto, state.input);
    const wrongDomain = created.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => decodeHumanArtifactPublicationRequestV1(wrongDomain))
      .toThrow("domain mismatch");
    expect(() => verifyHumanArtifactPublicationRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => null,
    })).toThrow("authority is unavailable");
    expect(() => verifyHumanArtifactPublicationRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => new Uint8Array(31),
    })).toThrow("authority public key");
    expect(() => verifyHumanArtifactPublicationRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => state.signer.publicKey,
    })).not.toThrow();
    const other = state.crypto.generateSigningKeyPair();
    expect(() => prepareHumanArtifactPublicationRequestV1(state.crypto, {
      ...state.input,
      committerSigningPublicKey: other.publicKey,
    })).toThrow("signing keys do not match");
  });
});

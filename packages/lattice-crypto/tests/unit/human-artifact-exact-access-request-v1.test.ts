import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import {
  HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V1,
  MAX_HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_WIRE_BYTES_V1,
  decodeHumanArtifactExactAccessRequestV1,
  encodeHumanArtifactExactAccessRequestV1,
  fingerprintHumanArtifactAccessInventoryV1,
  prepareHumanArtifactExactAccessRequestV1,
  verifyHumanArtifactExactAccessRequestV1,
  type HumanArtifactAccessInventoryEntryV1,
  type PrepareHumanArtifactExactAccessRequestInputV1,
} from "../../src/artifact/exact-access-request-v1.ts";
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

function entry(id: string, marker: number): HumanArtifactAccessInventoryEntryV1 {
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

function fixture(seed = 5_100): Readonly<{
  crypto: LatticeCrypto;
  signer: ReturnType<LatticeCrypto["generateSigningKeyPair"]>;
  input: PrepareHumanArtifactExactAccessRequestInputV1;
}> {
  const crypto = new LatticeCrypto(seededRng(seed));
  const signer = crypto.generateSigningKeyPair();
  return {
    crypto,
    signer,
    input: {
      subjectHumanId: humanId("human-alice"),
      operationId: "artifact-access-1",
      artifactId: ARTIFACT_ID,
      artifactRevision: 4,
      cryptoObjectId: objectId(`artifact:v1:${"a".repeat(64)}`),
      blobId: BLOB_ID,
      blobGeneration: 3,
      payloadHash: hash(1),
      expectedAccessRevision: 2,
      nextAccessRevision: 3,
      currentManifestHash: hash(2),
      nextManifestHash: hash(3),
      currentInventoryHash: fingerprintHumanArtifactAccessInventoryV1([
        entry(NS_A, 1),
      ]),
      targetInventoryHash: fingerprintHumanArtifactAccessInventoryV1([
        entry(NS_A, 1), entry(NS_B, 2),
      ]),
      issuedAt: unixTimestamp(1_000_000),
      deadlineAt: unixTimestamp(1_020_000),
      committerDeviceId: cryptoDeviceId("device-alice-1"),
      hostAuthorizationRevision: authorizationRevision(9),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    },
  };
}

describe("HumanArtifactExactAccessRequestV1", () => {
  test("round-trips and verifies exact Artifact, blob, access, and inventory facts", () => {
    const state = fixture();
    const created = prepareHumanArtifactExactAccessRequestV1(
      state.crypto,
      state.input,
    );
    expect(createHash("sha256").update(created.bytes).digest("hex"))
      .toBe("8f7589342555d4709190ea0790874ad56693929c0245cec74dc6627644c3468a");
    expect(decodeHumanArtifactExactAccessRequestV1(created.bytes))
      .toEqual(created.request);
    expect(encodeHumanArtifactExactAccessRequestV1(created.request))
      .toEqual(created.bytes);
    expect(verifyHumanArtifactExactAccessRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: unixTimestamp(1_010_000),
      resolveCurrentAuthority: (context) => {
        expect(context).toEqual({
          purpose: "human-artifact-exact-access-verify",
          subjectHumanId: humanId("human-alice"),
          operationId: "artifact-access-1",
          committerDeviceId: cryptoDeviceId("device-alice-1"),
          hostAuthorizationRevision: authorizationRevision(9),
        });
        return state.signer.publicKey;
      },
    })).toEqual(created.request);
  });

  test("fingerprints exact canonical inventories, including the empty target", () => {
    expect(fingerprintHumanArtifactAccessInventoryV1([])).toHaveLength(32);
    expect(fingerprintHumanArtifactAccessInventoryV1([entry(NS_A, 1)]))
      .toEqual(fingerprintHumanArtifactAccessInventoryV1([entry(NS_A, 1)]));
    expect(() => fingerprintHumanArtifactAccessInventoryV1([
      entry(NS_B, 2), entry(NS_A, 1),
    ])).toThrow("sorted");
    expect(() => fingerprintHumanArtifactAccessInventoryV1([
      entry(NS_A, 1), entry(NS_A, 2),
    ])).toThrow("duplicate");
  });

  test("rejects coordinate mutation, wrong authority, early use, and expiry", () => {
    const state = fixture(5_101);
    const created = prepareHumanArtifactExactAccessRequestV1(
      state.crypto,
      state.input,
    );
    const tampered = created.bytes.slice();
    tampered[Math.floor(tampered.length / 2)]! ^= 1;
    for (const [bytes, now, key] of [
      [tampered, 1_010_000, state.signer.publicKey],
      [created.bytes, 999_999, state.signer.publicKey],
      [created.bytes, 1_020_000, state.signer.publicKey],
      [created.bytes, 1_010_000, fixture(5_102).signer.publicKey],
    ] as const) {
      expect(() => verifyHumanArtifactExactAccessRequestV1(state.crypto, {
        requestBytes: bytes,
        now: unixTimestamp(now),
        resolveCurrentAuthority: () => key,
      })).toThrow();
    }
    expect(() => prepareHumanArtifactExactAccessRequestV1(state.crypto, {
      ...state.input,
      nextAccessRevision: state.input.expectedAccessRevision + 2,
    })).toThrow("advance once");
  });

  test("binds every Artifact, blob, access, time, device, and Human coordinate", () => {
    const state = fixture(5_103);
    const created = prepareHumanArtifactExactAccessRequestV1(state.crypto, state.input);
    const substitutions: ReadonlyArray<Record<string, unknown>> = [
      { subjectHumanId: humanId("human-bob") },
      { operationId: "artifact-access-2" },
      { artifactId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { artifactRevision: 5 },
      { cryptoObjectId: objectId(`artifact:v1:${"b".repeat(64)}`) },
      { blobId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      { blobGeneration: 4 },
      { payloadHash: hash(99) },
      { expectedAccessRevision: 3, nextAccessRevision: 4 },
      { currentManifestHash: hash(99) },
      { nextManifestHash: hash(99) },
      { currentInventoryHash: hash(99) },
      { targetInventoryHash: hash(99) },
      { issuedAt: unixTimestamp(1_000_001) },
      { deadlineAt: unixTimestamp(1_020_001) },
      { committerDeviceId: cryptoDeviceId("device-alice-2") },
      { hostAuthorizationRevision: authorizationRevision(10) },
    ];
    for (const patch of substitutions) {
      const bytes = encodeHumanArtifactExactAccessRequestV1({
        ...created.request,
        ...patch,
      });
      expect(() => verifyHumanArtifactExactAccessRequestV1(state.crypto, {
        requestBytes: bytes,
        now: unixTimestamp(1_010_000),
        resolveCurrentAuthority: () => state.signer.publicKey,
      })).toThrow("signature");
      bytes.fill(0);
    }
  });

  test("validates every revision, identifier, hash, deadline, and key boundary", () => {
    const state = fixture(5_104);
    const failures: ReadonlyArray<readonly [Record<string, unknown>, string]> = [
      [{ operationId: "" }, "operation id"],
      [{ artifactId: 1 }, "canonical UUID"],
      [{ artifactId: `x${ARTIFACT_ID}` }, "canonical UUID"],
      [{ artifactId: { toString: () => ARTIFACT_ID } }, "canonical UUID"],
      [{ artifactRevision: 0 }, "revision"],
      [{ blobId: 1 }, "canonical UUID"],
      [{ blobId: `${BLOB_ID}x` }, "canonical UUID"],
      [{ blobGeneration: 0 }, "blob generation"],
      [{ expectedAccessRevision: -1 }, "expected access revision"],
      [{ nextAccessRevision: 4 }, "advance once"],
      [{ payloadHash: new Uint8Array(31) }, "payload hash"],
      [{ currentManifestHash: new Uint8Array(31) }, "Current Artifact manifest hash"],
      [{ nextManifestHash: new Uint8Array(31) }, "Next Artifact manifest hash"],
      [{ currentInventoryHash: new Uint8Array(31) }, "Current Artifact inventory hash"],
      [{ targetInventoryHash: new Uint8Array(31) }, "Target Artifact inventory hash"],
      [{ deadlineAt: state.input.issuedAt }, "deadline"],
      [{
        deadlineAt: unixTimestamp(
          Number(state.input.issuedAt)
            + HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V1 + 1,
        ),
      }, "deadline"],
      [{ committerSigningPublicKey: new Uint8Array(31) }, "signing public key"],
      [{ committerSigningPrivateKey: new Uint8Array(31) }, "signing private key"],
    ];
    for (const [patch, message] of failures) {
      expect(() => prepareHumanArtifactExactAccessRequestV1(state.crypto, {
        ...state.input,
        ...patch,
      } as never)).toThrow(message);
    }
    expect(() => prepareHumanArtifactExactAccessRequestV1(state.crypto, {
      ...state.input,
      deadlineAt: unixTimestamp(
        Number(state.input.issuedAt)
          + HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_MAX_TTL_MS_V1,
      ),
    })).not.toThrow();
    expect(() => prepareHumanArtifactExactAccessRequestV1(state.crypto, {
      ...state.input,
      artifactRevision: 1,
      blobGeneration: 1,
    })).not.toThrow();
    const other = state.crypto.generateSigningKeyPair();
    expect(() => prepareHumanArtifactExactAccessRequestV1(state.crypto, {
      ...state.input,
      committerSigningPublicKey: other.publicKey,
    })).toThrow("signing keys do not match");
  });

  test("validates exact inventory entry structure, ordering, counters, and bytes", () => {
    const valid = entry(NS_A, 1);
    const invalidEntries: ReadonlyArray<readonly [unknown, string]> = [
      [{ ...valid, expectedNamespaceAccessRevision: -1 }, "access revision"],
      [{ ...valid, expectedPolicyRevision: -1 }, "policy revision"],
      [{ ...valid, keyGeneration: -1 }, "key generation"],
      [{ ...valid, bindingRevisionAtWrap: -1 }, "binding revision"],
      [{ ...valid, bindingHash: new Uint8Array(31) }, "binding hash"],
      [{ ...valid, envelopeHash: new Uint8Array(31) }, "envelope hash"],
    ];
    for (const [invalid, message] of invalidEntries) {
      expect(() => fingerprintHumanArtifactAccessInventoryV1([invalid] as never))
        .toThrow(message);
    }
    expect(() => fingerprintHumanArtifactAccessInventoryV1(
      Array.from({ length: 257 }, (_, index) => entry(
        `namespace-${String(index).padStart(3, "0")}`,
        index + 1,
      )),
    )).toThrow("unbounded");
    expect(() => fingerprintHumanArtifactAccessInventoryV1(
      Array.from({ length: 256 }, (_, index) => entry(
        `namespace-${String(index).padStart(3, "0")}`,
        index + 1,
      )),
    )).not.toThrow();
  });

  test("rejects malformed wire and unavailable or malformed authority", () => {
    const state = fixture(5_105);
    expect(() => decodeHumanArtifactExactAccessRequestV1(null as never))
      .toThrow("bytes are invalid");
    expect(() => decodeHumanArtifactExactAccessRequestV1(
      new Uint8Array(MAX_HUMAN_ARTIFACT_EXACT_ACCESS_REQUEST_WIRE_BYTES_V1 + 1),
    )).toThrow("bytes are invalid");
    const created = prepareHumanArtifactExactAccessRequestV1(state.crypto, state.input);
    expect(() => encodeHumanArtifactExactAccessRequestV1({
      ...created.request,
      signature: new Uint8Array(63),
    })).toThrow("signature");
    const wrongDomain = created.bytes.slice();
    wrongDomain[4] = wrongDomain[4]! ^ 1;
    expect(() => decodeHumanArtifactExactAccessRequestV1(wrongDomain))
      .toThrow("domain mismatch");
    expect(() => verifyHumanArtifactExactAccessRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => null,
    })).toThrow("authority is unavailable");
    expect(() => verifyHumanArtifactExactAccessRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => new Uint8Array(31),
    })).toThrow("authority public key");
    expect(() => verifyHumanArtifactExactAccessRequestV1(state.crypto, {
      requestBytes: created.bytes,
      now: state.input.issuedAt,
      resolveCurrentAuthority: () => state.signer.publicKey,
    })).not.toThrow();
    expect(() => encodeHumanArtifactExactAccessRequestV1({
      ...created.request,
      formatVersion: 2,
    } as never)).toThrow("kind is invalid");
    expect(() => encodeHumanArtifactExactAccessRequestV1({
      ...created.request,
      purpose: "future-purpose",
    } as never)).toThrow("kind is invalid");
  });
});

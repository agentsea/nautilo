import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanObjectAccessManifestGenesisSet,
  type Rng,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  ARTIFACT_CONTROL_VERSION_V1,
  assertPreparedArtifactCryptoRevision,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type PreparedArtifactCryptoRevision,
} from "../../src/artifact/artifact-repository.ts";
import {
  createPreparedArtifactCryptoRevision,
  readPreparedArtifactCryptoRevisionSnapshot,
} from "../../src/artifact/artifact-prepared-revision.ts";

const artifactId = "11111111-1111-4111-8111-111111111111";
const namespaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const namespaceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const output = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        output[index] = state & 0xff;
      }
      return output;
    },
  };
}

describe("Artifact repository contract", () => {
  test("derives one stable control object identity per Artifact revision", () => {
    const first = deriveArtifactControlObjectIdV1({
      artifactId,
      artifactRevision: 1,
    });
    expect(first).toMatch(/^artifact:v1:[0-9a-f]{64}$/);
    expect(deriveArtifactControlObjectIdV1({
      artifactId,
      artifactRevision: 1,
    })).toBe(first);
    expect(deriveArtifactControlObjectIdV1({
      artifactId,
      artifactRevision: 2,
    })).not.toBe(first);
  });

  test("fingerprints only canonical exact nonempty Namespace sets", () => {
    const fingerprint = fingerprintRequiredArtifactNamespaces([
      namespaceA,
      namespaceB,
    ]);
    expect(fingerprint).toHaveLength(32);
    expect(fingerprintRequiredArtifactNamespaces([
      namespaceA,
      namespaceB,
    ])).toEqual(fingerprint);
    expect(() => fingerprintRequiredArtifactNamespaces([])).toThrow("bounded");
    expect(() => fingerprintRequiredArtifactNamespaces([
      namespaceB,
      namespaceA,
    ])).toThrow("sorted");
    expect(() => fingerprintRequiredArtifactNamespaces([
      namespaceA,
      namespaceA,
    ])).toThrow("unique");
  });

  test("authenticates complete control/blob/revision coordinates", () => {
    const prepared: PreparedArtifactCryptoRevision = Object.freeze({
      artifactId,
      artifactRevision: 2,
      blobGeneration: 1,
      objectId: deriveArtifactControlObjectIdV1({
        artifactId,
        artifactRevision: 2,
      }),
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      controlVersion: ARTIFACT_CONTROL_VERSION_V1,
      blobId: "22222222-2222-4222-8222-222222222222",
      plaintextLength: 17,
      ciphertextLength: 211,
      ciphertextSha256: new Uint8Array(32).fill(0x22),
      chunkPlaintextBytes: 1_048_576,
      chunkCount: 1,
      requiredNamespaceIds: Object.freeze([namespaceA]),
    });
    expect(prepared.objectId).toBe(
      deriveArtifactControlObjectIdV1(prepared),
    );
    expect(prepared.objectType).toBe("nautilo-artifact-control-v1");
    expect(() => assertPreparedArtifactCryptoRevision(prepared)).not.toThrow();
    expect(() => assertPreparedArtifactCryptoRevision({
      ...prepared,
      artifactRevision: 3,
    })).toThrow("coordinates");
    expect(() => assertPreparedArtifactCryptoRevision({
      ...prepared,
      chunkCount: 2,
    })).toThrow("chunk count");
    expect(() => readPreparedArtifactCryptoRevisionSnapshot(prepared)).toThrow(
      "not prepared",
    );
  });

  test("seals one authentic Human common-v5 prepared revision and rejects clones", () => {
    const crypto = new LatticeCrypto(seededRng(0x261));
    const signer = crypto.generateSigningKeyPair();
    const revision: PreparedArtifactCryptoRevision = Object.freeze({
      artifactId,
      artifactRevision: 1,
      blobGeneration: 1,
      objectId: deriveArtifactControlObjectIdV1({ artifactId, artifactRevision: 1 }),
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      controlVersion: ARTIFACT_CONTROL_VERSION_V1,
      blobId: "22222222-2222-4222-8222-222222222222",
      plaintextLength: 17,
      ciphertextLength: 211,
      ciphertextSha256: new Uint8Array(32).fill(0x22),
      chunkPlaintextBytes: 1_048_576,
      chunkCount: 1,
      requiredNamespaceIds: Object.freeze([namespaceA, namespaceB]),
    });
    const encrypted = encryptObjectPayload(crypto, {
      objectId: objectId(revision.objectId),
      keyClass: "ai",
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      createdAt: unixTimestamp(1_800_000_000_000),
    }, new TextEncoder().encode("encrypted control"));
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopes = [namespaceA, namespaceB].map((id, index) =>
      encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
        crypto,
        new Uint8Array(32).fill(index + 1),
        {
          objectId: objectId(revision.objectId),
          namespaceId: namespaceId(id),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(1),
          bindingRevisionAtWrap: accessRevision(0),
        },
        encrypted.dek,
      ))
    );
    const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
      objectId: objectId(revision.objectId),
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: envelopes,
      sourceAuthorized: true,
      targetAuthorized: true,
      subjectHumanId: "artifact-human",
      committerDeviceId: cryptoDeviceId("artifact-device"),
      hostAuthorizationRevision: authorizationRevision(2),
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    });
    const substituted = encryptObjectPayload(crypto, {
      objectId: objectId(revision.objectId),
      keyClass: "ai",
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      createdAt: unixTimestamp(1_800_000_000_000),
    }, new TextEncoder().encode("substituted encrypted control"));
    expect(() => createPreparedArtifactCryptoRevision({
      revision,
      object: encryptedObjectWriteRecord(encodeEncryptedPayloadV2(
        substituted.payload,
      )),
      access,
      resolveCurrentAuthorization: (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: signer.publicKey,
      }),
    })).toThrow("coordinates disagree");
    substituted.dek.fill(0);
    const prepared = createPreparedArtifactCryptoRevision({
      revision,
      object: encryptedObjectWriteRecord(payloadBytes),
      access,
      resolveCurrentAuthorization: (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: signer.publicKey,
      }),
    });
    const snapshot = readPreparedArtifactCryptoRevisionSnapshot(prepared);
    expect(snapshot.revision.requiredNamespaceIds).toEqual([namespaceA, namespaceB]);
    expect(snapshot.access.envelopeBytes).toHaveLength(2);
    expect(() => readPreparedArtifactCryptoRevisionSnapshot({
      ...prepared,
    })).toThrow("not prepared");
    snapshot.object.payloadBytes.ciphertext[0] =
      snapshot.object.payloadBytes.ciphertext[0]! ^ 0xff;
    expect(() => readPreparedArtifactCryptoRevisionSnapshot(prepared)).toThrow(
      "mutated",
    );
    encrypted.dek.fill(0);
  });
});

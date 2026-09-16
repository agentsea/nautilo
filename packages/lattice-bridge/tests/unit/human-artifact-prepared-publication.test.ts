import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanObjectAccessManifestGenesisSet,
  prepareHumanArtifactPublicationRequest,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import { seededRng } from "@nautilo/lattice-crypto/testing";

import {
  authenticateHumanArtifactPublication,
  readAuthenticatedHumanArtifactPublication,
} from "../../src/server/artifact/human-artifact-prepared-publication.ts";
import {
  PostgresHumanArtifactCryptoCompletion,
} from "../../src/server/artifact/postgres-human-artifact-crypto-completion.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresTransaction,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  deriveArtifactControlObjectIdV1,
} from "../../src/artifact/artifact-repository.ts";
import type { ProtectedArtifactPreparedPublicationRequestV1 } from "@nautilo/api-client";

const ARTIFACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ROW = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BLOB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const NS = "11111111-1111-4111-8111-111111111111";
const HUMAN = "human-alice";

function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

class ScriptedCryptoConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: CryptoPostgresTransaction) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }

  assertExhausted(): void {
    expect(this.#results).toEqual([]);
  }
}

function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x2621));
  const signer = crypto.generateSigningKeyPair();
  const object = deriveArtifactControlObjectIdV1({ artifactId: ARTIFACT, artifactRevision: 1 });
  const encrypted = encryptObjectPayload(crypto, {
    objectId: objectId(object), keyClass: "ai",
    objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
    createdAt: unixTimestamp(1_800_000_000_000),
  }, new TextEncoder().encode("confidential control canary"));
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
    crypto,
    new Uint8Array(32).fill(7),
    {
      objectId: objectId(object), namespaceId: namespaceId(NS), keyClass: "ai",
      keyGeneration: namespaceGeneration(3), bindingRevisionAtWrap: accessRevision(2),
    },
    encrypted.dek,
  ));
  const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(object), payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes], sourceAuthorized: true, targetAuthorized: true,
    subjectHumanId: humanId(HUMAN),
    committerDeviceId: cryptoDeviceId("device-alice"),
    hostAuthorizationRevision: authorizationRevision(4),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const ciphertextSha256 = crypto.hash(new TextEncoder().encode("ciphertext"));
  const signed = prepareHumanArtifactPublicationRequest(crypto, {
    operation: "create", lifecycleAction: "activate",
    subjectHumanId: humanId(HUMAN), operationId: "artifact-op-1",
    planDigest: new Uint8Array(32).fill(0x15),
    artifactRowId: ROW, artifactId: ARTIFACT, anchorNamespaceId: namespaceId(NS),
    cryptoObjectId: objectId(object), expectedArtifactRevision: 0,
    nextArtifactRevision: 1, expectedAccessRevision: 0, resultAccessRevision: 0,
    expectedBlobGeneration: 0, resultBlobGeneration: 1,
    expectedBlobId: null, resultBlobId: BLOB,
    controlPayloadHash: crypto.hash(payloadBytes),
    accessManifestHash: crypto.hash(access.manifestBytes),
    entries: [{
      namespaceId: namespaceId(NS), domainId: cryptoDomainId("domain-a"),
      expectedNamespaceAccessRevision: 2, expectedPolicyRevision: 5,
      bindingHash: new Uint8Array(32).fill(8), keyGeneration: 3,
      bindingRevisionAtWrap: 2, envelopeHash: crypto.hash(envelopeBytes),
    }],
    ciphertextLength: 10, ciphertextSha256, chunkPlaintextBytes: 1_048_576,
    chunkCount: 1, mimeClass: "document", sizeBucket: "le_64_kib",
    issuedAt: unixTimestamp(1_800_000_000_000),
    deadlineAt: unixTimestamp(1_800_000_020_000),
    committerDeviceId: cryptoDeviceId("device-alice"),
    hostAuthorizationRevision: authorizationRevision(4),
    committerSigningPublicKey: signer.publicKey,
    committerSigningPrivateKey: signer.privateKey,
  });
  const prepared: ProtectedArtifactPreparedPublicationRequestV1 = {
    requestVersion: 1, operationId: "artifact-op-1", operation: "create",
    planDigestBase64url: toBase64url(new Uint8Array(32).fill(0x15)),
    lifecycleAction: "activate", artifactRowId: ROW, artifactId: ARTIFACT,
    anchorNamespaceId: NS, cryptoObjectId: object,
    expectedArtifactRevision: 0, nextArtifactRevision: 1,
    expectedCryptoAccessRevision: 0, resultCryptoAccessRevision: 0,
    expectedBlobGeneration: 0, resultBlobGeneration: 1,
    expectedBlobId: null, resultBlobId: BLOB, requiredNamespaceIds: [NS],
    encryptedControlPayloadBytesBase64url: toBase64url(payloadBytes),
    accessManifestBytesBase64url: toBase64url(access.manifestBytes),
    namespaceEnvelopes: [{ namespaceId: NS, envelopeBytesBase64url: toBase64url(envelopeBytes) }],
    signedPublicationRequestBytesBase64url: toBase64url(signed.bytes),
    ciphertextLength: 10,
    ciphertextSha256Base64url: toBase64url(ciphertextSha256),
    chunkPlaintextBytes: 1_048_576, chunkCount: 1,
    mimeClass: "document", sizeBucket: "le_64_kib",
  };
  return { crypto, signer, prepared, ciphertextSha256, signed, payloadBytes, envelopeBytes };
}

describe("authenticated Human Artifact publication", () => {
  test("authenticates signed product/blob/control/access facts behind an opaque handle", async () => {
    const state = fixture();
    const contexts: unknown[] = [];
    const authenticated = await authenticateHumanArtifactPublication({
      crypto: state.crypto, expectedHumanId: HUMAN, prepared: state.prepared,
      blob: {
        artifactId: ARTIFACT, blobId: BLOB, blobGeneration: 1,
        plaintextLength: 7, ciphertextLength: 10,
        ciphertextSha256: state.ciphertextSha256,
        chunkPlaintextBytes: 1_048_576, chunkCount: 1,
      },
      now: 1_800_000_010_000,
      resolveAuthority: (context) => {
        contexts.push(context);
        return Promise.resolve({ context, committerSigningPublicKey: state.signer.publicKey.slice() });
      },
    });
    const snapshot = readAuthenticatedHumanArtifactPublication(authenticated);
    expect(snapshot.plan).toMatchObject({
      operationId: "artifact-op-1", artifactRowId: ROW,
      operationType: "create", expectedArtifactRevision: 0,
    });
    expect(snapshot.lifecycleAction).toBe("activate");
    expect(snapshot.revision.plaintextLength).toBe(7);
    expect(contexts).toHaveLength(1);
    expect(JSON.stringify(contexts)).not.toContain("confidential control canary");
    snapshot.payloadBytes[0] = snapshot.payloadBytes[0]! ^ 0xff;
    expect(readAuthenticatedHumanArtifactPublication(authenticated).payloadBytes)
      .toEqual(state.payloadBytes);
  });

  test("rejects unsigned outer substitutions and forged handles", async () => {
    const state = fixture();
    const run = (prepared: ProtectedArtifactPreparedPublicationRequestV1) =>
      authenticateHumanArtifactPublication({
        crypto: state.crypto, expectedHumanId: HUMAN, prepared,
        blob: {
          artifactId: ARTIFACT, blobId: BLOB, blobGeneration: 1,
          plaintextLength: 7, ciphertextLength: 10,
          ciphertextSha256: state.ciphertextSha256,
          chunkPlaintextBytes: 1_048_576, chunkCount: 1,
        },
        now: 1_800_000_010_000,
        resolveAuthority: (context) => Promise.resolve({
          context, committerSigningPublicKey: state.signer.publicKey.slice(),
        }),
      });
    expect(run({ ...state.prepared, artifactRowId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }))
      .rejects.toThrow("Signed Artifact");
    expect(run({ ...state.prepared, lifecycleAction: "archive" }))
      .rejects.toThrow("Signed Artifact");
    expect(() => readAuthenticatedHumanArtifactPublication({
      operationId: "artifact-op-1", artifactId: ARTIFACT, artifactRevision: 1,
    })).toThrow("not bridge-authenticated");
  });

  test("persists exact authenticated crypto bytes and revalidates current authority", async () => {
    const state = fixture();
    const resolveAuthority = (context: Parameters<
      typeof authenticateHumanArtifactPublication
    >[0]["resolveAuthority"] extends (context: infer Context) => unknown
      ? Context : never) => Promise.resolve({
        context,
        committerSigningPublicKey: state.signer.publicKey.slice(),
      });
    const authenticated = await authenticateHumanArtifactPublication({
      crypto: state.crypto,
      expectedHumanId: HUMAN,
      prepared: state.prepared,
      blob: {
        artifactId: ARTIFACT, blobId: BLOB, blobGeneration: 1,
        plaintextLength: 7, ciphertextLength: 10,
        ciphertextSha256: state.ciphertextSha256,
        chunkPlaintextBytes: 1_048_576, chunkCount: 1,
      },
      now: 1_800_000_010_000,
      resolveAuthority,
    });
    const snapshot = readAuthenticatedHumanArtifactPublication(authenticated);
    const connection = new ScriptedCryptoConnection([
      [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
      [], [], [],
      [], [], [], [],
      [{
        object_id: snapshot.revision.objectId,
        payload_hash: snapshot.payloadHash,
        payload_bytes: snapshot.payloadBytes,
      }],
      [{
        object_id: snapshot.revision.objectId,
        access_revision: 0,
        manifest_hash: snapshot.manifestHash,
        previous_manifest_hash: null,
        payload_hash: snapshot.payloadHash,
        manifest_bytes: snapshot.manifestBytes,
      }],
      snapshot.envelopes.map((entry, ordinal) => ({
        object_id: snapshot.revision.objectId,
        access_revision: 0,
        namespace_id: entry.namespaceId,
        ordinal,
        envelope_hash: entry.envelopeHash,
        envelope_bytes: entry.envelopeBytes,
      })),
    ]);
    const completion = new PostgresHumanArtifactCryptoCompletion({
      handle: await verifyCryptoPostgresHandle(connection),
      crypto: state.crypto,
      resolveCurrentAuthority: resolveAuthority,
      resolveHistoricalSigner: () => Promise.resolve(null),
    });
    const completed = await completion.complete(authenticated);
    expect(completed.status).toBe("created");
    expect(completed.verified).toMatchObject({
      artifactId: ARTIFACT,
      artifactRevision: 1,
      objectId: snapshot.revision.objectId,
      accessRevision: 0,
      requiredNamespaceIds: [NS],
    });
    expect(connection.statements.join("\n")).not.toContain(
      "confidential control canary",
    );
    connection.assertExhausted();
  });
});

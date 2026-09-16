import { describe, expect, test } from "bun:test";

import {
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
} from "../../src/artifact/artifact-repository.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import { PostgresHumanArtifactProtectedProductRoute } from "../../src/server/artifact/postgres-human-artifact-protected-product-route.ts";

const ROW = "82000000-0000-4000-8000-000000000301";
const ARTIFACT = "82000000-0000-4000-8000-000000000302";
const BLOB = "82000000-0000-4000-8000-000000000303";
const NS = "82000000-0000-4000-8000-000000000304";
const OBJECT = deriveArtifactControlObjectIdV1({ artifactId: ARTIFACT,
  artifactRevision: 1 });

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: unknown[][];
  constructor(results: unknown[][]) { this.#results = [...results]; }
  query<Row>(statement: string): Promise<readonly Row[]> {
    this.statements.push(statement);
    const rows = this.#results.shift();
    if (rows === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(rows as Row[]);
  }
  transaction<Result>(callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>) {
    return callback(this);
  }
}

const authority = Object.freeze({
  userId: "user:alice", subjectHumanId: "human:alice", actorId: "actor:alice",
  agentId: null, readableNamespaceIds: Object.freeze([NS]),
  mutableNamespaceIds: Object.freeze([NS]), writableNamespaceIds: Object.freeze([NS]),
});

function productRow() {
  return { artifact_row_id: ROW, artifact_id: ARTIFACT, revision: 1,
    crypto_object_id: OBJECT, crypto_access_revision: 0,
    crypto_required_namespace_fingerprint: fingerprintRequiredArtifactNamespaces([NS]),
    blob_id: BLOB, blob_generation: 1, ciphertext_length: 220,
    ciphertext_sha256: new Uint8Array(32).fill(0x30), mime_class: "text",
    size_bucket: "le_64_kib", crypto_lifecycle_state: "active" };
}

function blobPort() {
  return {
    inspectStored: () => Promise.resolve({ status: "exact" as const, reference: {
      artifactId: ARTIFACT, blobId: BLOB, blobGeneration: 1,
      plaintextLength: 3, ciphertextLength: 220,
      ciphertextSha256: new Uint8Array(32).fill(0x30),
      chunkPlaintextBytes: 1_048_576 as const, chunkCount: 1,
    } }),
    readCiphertextRange: async <Value>(input: Readonly<{
      consume(range: Readonly<{
        header: { formatVersion: 1; artifactId: string; blobId: string;
          blobGeneration: number; plaintextLength: number;
          chunkPlaintextBytes: 1_048_576; chunkCount: number };
        firstChunkIndex: number;
        sealedChunks: readonly Uint8Array[];
      }>): Value | PromiseLike<Value>;
    }>) => ({ status: "opened" as const, value: await input.consume({
      header: { formatVersion: 1, artifactId: ARTIFACT, blobId: BLOB,
        blobGeneration: 1, plaintextLength: 3,
        chunkPlaintextBytes: 1_048_576, chunkCount: 1 },
      firstChunkIndex: 0,
      sealedChunks: [new Uint8Array(43).fill(0x44)],
    }) }),
  };
}

describe("Postgres Human Artifact protected product reads", () => {
  test("opens only authenticated ciphertext after an exact fresh product snapshot", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [productRow()], [{ namespace_id: NS }],
      [productRow()], [{ namespace_id: NS }],
    ]);
    const payload = new Uint8Array([1, 2, 3]);
    const manifest = new Uint8Array([4, 5, 6]);
    const envelope = new Uint8Array([7, 8, 9]);
    const route = new PostgresHumanArtifactProtectedProductRoute({
      handle: await verifyConversationProductPostgresHandle(connection),
      crypto: { read: () => Promise.resolve({
        verified: { artifactId: ARTIFACT, artifactRevision: 1, objectId: OBJECT,
          accessRevision: 0, requiredNamespaceIds: [NS],
          requiredNamespaceFingerprint: fingerprintRequiredArtifactNamespaces([NS]) },
        encryptedControlPayloadBytes: payload,
        accessManifestBytes: manifest,
        accessManifestProofBytes: [],
        accessSignerEvidence: [],
        namespaceEnvelopes: [{ namespaceId: NS, envelopeBytes: envelope }],
      }) },
      blobs: blobPort(),
    });
    const result = await route.detail({ authority, artifactId: ARTIFACT });
    expect(result).toMatchObject({ status: "encrypted", artifactId: ARTIFACT,
      requiredNamespaceIds: [NS], blobId: BLOB, chunkCount: 1,
      canManageAccess: true });
    const sql = connection.statements.join("\n");
    expect(sql).not.toContain(" mime_type");
    expect(sql).not.toContain(" storage_uri");
    expect(sql).not.toMatch(/(?:SELECT|,)\s+path(?:\s|,)/iu);
    expect(sql).not.toMatch(/(?:SELECT|,)\s+size(?:\s|,)/iu);
    expect(payload).toEqual(new Uint8Array(3));
    expect(manifest).toEqual(new Uint8Array(3));
    expect(envelope).toEqual(new Uint8Array(3));
  });

  test("wipes opened bytes and fails closed when the post-open product mapping changes", async () => {
    const stale = { ...productRow(), blob_generation: 2 };
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [productRow()], [{ namespace_id: NS }], [stale], [{ namespace_id: NS }],
    ]);
    const payload = new Uint8Array([1, 2, 3]);
    const route = new PostgresHumanArtifactProtectedProductRoute({
      handle: await verifyConversationProductPostgresHandle(connection),
      crypto: { read: () => Promise.resolve({
        verified: { artifactId: ARTIFACT, artifactRevision: 1, objectId: OBJECT,
          accessRevision: 0, requiredNamespaceIds: [NS],
          requiredNamespaceFingerprint: fingerprintRequiredArtifactNamespaces([NS]) },
        encryptedControlPayloadBytes: payload, accessManifestBytes: new Uint8Array([4]),
        accessManifestProofBytes: [], accessSignerEvidence: [],
        namespaceEnvelopes: [{ namespaceId: NS,
          envelopeBytes: new Uint8Array([5]) }],
      }) },
      blobs: blobPort(),
    });
    expect(await route.detail({ authority, artifactId: ARTIFACT })).toEqual({
      dtoVersion: 1, status: "unavailable", reason: "stale_revision",
    });
    expect(payload).toEqual(new Uint8Array(3));
  });

  test("returns only complete encrypted chunks after exact product revalidation", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [productRow()], [{ namespace_id: NS }],
      [productRow()], [{ namespace_id: NS }],
    ]);
    const route = new PostgresHumanArtifactProtectedProductRoute({
      handle: await verifyConversationProductPostgresHandle(connection),
      crypto: { read: () => Promise.resolve(null) },
      blobs: blobPort(),
    });
    const result = await route.ciphertextRange({
      authority, artifactId: ARTIFACT, start: 0, endExclusive: 3,
    });
    expect(result).toMatchObject({ status: "encrypted_chunks", artifactId: ARTIFACT,
      blobId: BLOB, firstChunkIndex: 0, returnedChunkCount: 1 });
    if (result.status !== "encrypted_chunks") throw new Error("range unavailable");
    expect(result.body.length).toBe(47);
    expect(new DataView(result.body.buffer, result.body.byteOffset, 4).getUint32(0, false))
      .toBe(43);
  });
});

import { describe, expect, test } from "bun:test";

import {
  ARTIFACT_CONTROL_OBJECT_TYPE_V1,
  ARTIFACT_CONTROL_VERSION_V1,
  artifactPublicationRequestDigest,
  deriveArtifactControlObjectIdV1,
  fingerprintRequiredArtifactNamespaces,
  type ArtifactPublicationPlanInput,
} from "../../src/artifact/artifact-repository.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresHandle,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import { PostgresArtifactProductPublication } from "../../src/server/artifact/postgres-artifact-product-publication.ts";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: readonly unknown[][] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
    this.statements.push(statement);
    (this.parameters as unknown[][]).push([...parameters]);
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    _options: Readonly<{ isolationLevel: ConversationProductPostgresIsolationLevel }>,
  ): Promise<Result> {
    return callback(this);
  }

  assertExhausted(): void {
    expect(this.#results).toEqual([]);
  }
}

const artifactId = "11111111-1111-4111-8111-111111111111";
const blobId = "22222222-2222-4222-8222-222222222222";
const replacementBlobId = "22222222-2222-4222-8222-222222222223";
const rowId = "33333333-3333-4333-8333-333333333333";
const namespaceA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const namespaceB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ciphertextHash = new Uint8Array(32).fill(0x26);

function planWithoutDigest() {
  return Object.freeze({
    operationId: "artifact-create:test",
    artifactRowId: rowId,
    anchorNamespaceId: namespaceA,
    operationType: "create" as const,
    expectedArtifactRevision: 0,
    expectedAccessRevision: 0,
    expectedBlobGeneration: 0,
    expectedBlobId: null,
    expectedRequiredNamespaceFingerprint: null,
    revision: Object.freeze({
      artifactId,
      artifactRevision: 1,
      blobGeneration: 1,
      objectId: deriveArtifactControlObjectIdV1({ artifactId, artifactRevision: 1 }),
      objectType: ARTIFACT_CONTROL_OBJECT_TYPE_V1,
      controlVersion: ARTIFACT_CONTROL_VERSION_V1,
      blobId,
      plaintextLength: 73,
      ciphertextLength: 220,
      ciphertextSha256: ciphertextHash,
      chunkPlaintextBytes: 1_048_576 as const,
      chunkCount: 1,
      requiredNamespaceIds: Object.freeze([namespaceA, namespaceB]),
    }),
    blob: Object.freeze({
      artifactId,
      blobId,
      blobGeneration: 1,
      storageRef: `${blobId}.artifact-blob-v1`,
      ciphertextLength: 220,
      ciphertextSha256: ciphertextHash,
    }),
    mimeClass: "text" as const,
    sizeBucket: "le_64_kib" as const,
    requiredNamespaceFingerprint:
      fingerprintRequiredArtifactNamespaces([namespaceA, namespaceB]),
  });
}

function plan(): ArtifactPublicationPlanInput {
  const value = planWithoutDigest();
  return Object.freeze({
    ...value,
    requestDigest: artifactPublicationRequestDigest(value),
    allocationRequestDigest: artifactPublicationRequestDigest(value),
  });
}

function controlPlan(): ArtifactPublicationPlanInput {
  const requiredNamespaceFingerprint =
    fingerprintRequiredArtifactNamespaces([namespaceA, namespaceB]);
  const value = Object.freeze({
    ...planWithoutDigest(),
    operationId: "artifact-control:test",
    operationType: "control" as const,
    expectedArtifactRevision: 1,
    expectedBlobGeneration: 1,
    expectedBlobId: blobId,
    expectedRequiredNamespaceFingerprint: requiredNamespaceFingerprint,
    revision: Object.freeze({
      ...planWithoutDigest().revision,
      artifactRevision: 2,
      objectId: deriveArtifactControlObjectIdV1({
        artifactId,
        artifactRevision: 2,
      }),
    }),
    requiredNamespaceFingerprint,
  });
  return Object.freeze({
    ...value,
    requestDigest: artifactPublicationRequestDigest(value),
    allocationRequestDigest: artifactPublicationRequestDigest(value),
  });
}

function contentPlan(): ArtifactPublicationPlanInput {
  const requiredNamespaceFingerprint =
    fingerprintRequiredArtifactNamespaces([namespaceA, namespaceB]);
  const value = Object.freeze({
    ...planWithoutDigest(),
    operationId: "artifact-content:test",
    operationType: "content" as const,
    expectedArtifactRevision: 1,
    expectedBlobGeneration: 1,
    expectedBlobId: blobId,
    expectedRequiredNamespaceFingerprint: requiredNamespaceFingerprint,
    revision: Object.freeze({
      ...planWithoutDigest().revision,
      artifactRevision: 2,
      blobGeneration: 2,
      blobId: replacementBlobId,
      objectId: deriveArtifactControlObjectIdV1({
        artifactId,
        artifactRevision: 2,
      }),
    }),
    blob: Object.freeze({
      ...planWithoutDigest().blob,
      blobId: replacementBlobId,
      blobGeneration: 2,
      storageRef: `${replacementBlobId}.artifact-blob-v1`,
    }),
    requiredNamespaceFingerprint,
  });
  return Object.freeze({
    ...value,
    requestDigest: artifactPublicationRequestDigest(value),
    allocationRequestDigest: artifactPublicationRequestDigest(value),
  });
}

function durableRow(value: ArtifactPublicationPlanInput) {
  return {
    operation_id: value.operationId,
    artifact_row_id: value.artifactRowId,
    artifact_id: value.revision.artifactId,
    anchor_namespace_id: value.anchorNamespaceId,
    operation_type: value.operationType,
    expected_artifact_revision: value.expectedArtifactRevision,
    result_artifact_revision: value.revision.artifactRevision,
    expected_access_revision: value.expectedAccessRevision,
    expected_blob_generation: value.expectedBlobGeneration,
    result_blob_generation: value.revision.blobGeneration,
    expected_blob_id: value.expectedBlobId,
    result_blob_id: value.revision.blobId,
    request_digest: value.requestDigest,
    allocation_request_digest: value.allocationRequestDigest,
    expected_required_namespace_fingerprint:
      value.expectedRequiredNamespaceFingerprint,
    target_required_namespace_fingerprint: value.requiredNamespaceFingerprint,
    completion: "pending",
    disposition: "active",
    attempt_count: 0,
    failure_code: null,
    crypto_object_id: value.revision.objectId,
    mime_class: value.mimeClass,
    size_bucket: value.sizeBucket,
    storage_ref: value.blob.storageRef,
    ciphertext_length: value.blob.ciphertextLength,
    ciphertext_sha256: value.blob.ciphertextSha256,
  };
}

function completeDurableRow(value: ArtifactPublicationPlanInput) {
  return {
    ...durableRow(value),
    completion: "complete",
    disposition: "complete",
  };
}

describe("Postgres Artifact product publication", () => {
  test("durably reserves the server plan before signed publication admission", async () => {
    const value = plan();
    const reservation = Object.freeze({
      operationId: value.operationId,
      artifactRowId: value.artifactRowId,
      artifactId: value.revision.artifactId,
      anchorNamespaceId: value.anchorNamespaceId,
      operationType: value.operationType,
      expectedArtifactRevision: value.expectedArtifactRevision,
      resultArtifactRevision: value.revision.artifactRevision,
      expectedAccessRevision: value.expectedAccessRevision,
      resultAccessRevision: 0 as const,
      expectedBlobGeneration: value.expectedBlobGeneration,
      resultBlobGeneration: value.revision.blobGeneration,
      expectedBlobId: value.expectedBlobId,
      resultBlobId: value.revision.blobId,
      expectedRequiredNamespaceFingerprint:
        value.expectedRequiredNamespaceFingerprint,
      targetRequiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      planDigest: value.requestDigest,
    });
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [], [], [], [], // plan lookup, product/blob checks, operation insert
      [], // admitted lifecycle absent
      [durableRow(value)], // exact durable plan reservation
      [], [], // fresh product and blob checks
      [], [], // blob and signed revision inserts
    ]);
    const product = new PostgresArtifactProductPublication(
      await verifyConversationProductPostgresHandle(connection),
    );
    expect(await product.reservePlan(reservation)).toMatchObject({
      status: "allocated",
    });
    expect((await product.reserve(value)).status).toBe("allocated");
    expect(connection.statements.filter((sql) =>
      sql.includes('insert into "artifact_crypto_operations"')
    )).toHaveLength(1);
    expect(connection.parameters.flat()).toContain(
      value.allocationRequestDigest,
    );
    connection.assertExhausted();
  });

  test("reserves content-free coordinates and maps only verified ciphertext", async () => {
    const value = plan();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [], // existing operation
      [], // existing plan reservation
      [], // product identity collision
      [], // blob identity collision
      [], [], [], // operation, blob, revision inserts
      [durableRow(value)], // locked publication
      [{ id: rowId }], // protected Artifact mapping
      [], [], // exact Namespace edges
      [], [], [], // blob, revision, operation complete
    ]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = new PostgresArtifactProductPublication(handle);
    const reserved = await product.reserve(value);
    expect(reserved.status).toBe("allocated");
    if (reserved.status !== "allocated") throw new Error("expected allocation");
    expect(await product.publish({
      lifecycle: reserved.lifecycle,
      targetLifecycleState: "active",
      verified: {
        artifactId,
        artifactRevision: 1,
        objectId: value.revision.objectId,
        accessRevision: 0,
        requiredNamespaceIds: [namespaceA, namespaceB],
        requiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      },
    })).toBe("applied");
    const sql = connection.statements.join("\n");
    const artifactInsert = connection.statements.findIndex((statement) =>
      statement.includes('insert into "artifacts"')
    );
    expect(artifactInsert).toBeGreaterThan(-1);
    expect(connection.parameters[artifactInsert]?.slice(2, 6)).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(connection.parameters[artifactInsert]).toContain("verified");
    expect(sql).not.toMatch(/plaintext_length|logical_path/);
    expect(connection.parameters.flat()).not.toContain(73);
    connection.assertExhausted();
  });

  test("rejects forged and Agent-role handles", async () => {
    expect(() => new PostgresArtifactProductPublication(
      Object.freeze({ role: "nautilo" }) as unknown as
        ConversationProductPostgresHandle,
    )).toThrow("verified ordinary product");
    const connection = new ScriptedConnection([[{
      current_user: "nautilo_agent",
      session_user: "nautilo_agent",
    }]]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    expect(() => new PostgresArtifactProductPublication(handle)).toThrow(
      "direct nautilo",
    );
  });

  test("reuses a published blob for control-only revision under exact audience CAS", async () => {
    const value = controlPlan();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [], // existing operation
      [], // existing plan reservation
      [{ exists: 1 }], // exact active protected Artifact source
      [{ exists: 1 }], // exact retained published blob
      [], [], // operation and revision inserts
      [durableRow(value)], // locked publication
      [{ namespace_id: namespaceA }, { namespace_id: namespaceB }],
      [{ id: rowId }], // exact product CAS
      [], [], // revision and operation complete
    ]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    const product = new PostgresArtifactProductPublication(handle);
    const reserved = await product.reserve(value);
    expect(reserved.status).toBe("allocated");
    if (reserved.status !== "allocated") throw new Error("expected allocation");
    expect(await product.publish({
      lifecycle: reserved.lifecycle,
      targetLifecycleState: "active",
      verified: {
        artifactId,
        artifactRevision: 2,
        objectId: value.revision.objectId,
        accessRevision: 0,
        requiredNamespaceIds: [namespaceA, namespaceB],
        requiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      },
    })).toBe("applied");
    const sql = connection.statements.join("\n");
    expect(sql).toContain("crypto_lifecycle_state = 'active'");
    expect(sql).toContain('"crypto_mapping_state" = $');
    expect(connection.parameters.flat()).toContain("verified");
    expect(sql).toContain("crypto_required_namespace_fingerprint = $8");
    expect(sql).toContain('"crypto_required_namespace_fingerprint" = $');
    expect(sql).not.toContain('insert into "artifact_crypto_blobs"');
    expect(connection.parameters.flat()).toContain(
      value.expectedRequiredNamespaceFingerprint,
    );
    connection.assertExhausted();
  });

  test("publishes content replacement with a fresh immutable blob generation", async () => {
    const value = contentPlan();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [], // existing operation
      [], // existing plan reservation
      [{ exists: 1 }], // exact active protected Artifact source
      [], // fresh replacement blob identity
      [], [], [], // reservation, blob, and revision inserts
      [durableRow(value)], // locked publication
      [{ namespace_id: namespaceA }, { namespace_id: namespaceB }],
      [{ id: rowId }], // exact product CAS
      [], [], [], // blob, revision, and operation completion
    ]);
    const product = new PostgresArtifactProductPublication(
      await verifyConversationProductPostgresHandle(connection),
    );
    const reserved = await product.reserve(value);
    expect(reserved.status).toBe("allocated");
    if (reserved.status !== "allocated") throw new Error("expected allocation");
    expect(await product.publish({
      lifecycle: reserved.lifecycle,
      targetLifecycleState: "active",
      verified: {
        artifactId,
        artifactRevision: 2,
        objectId: value.revision.objectId,
        accessRevision: 0,
        requiredNamespaceIds: [namespaceA, namespaceB],
        requiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      },
    })).toBe("applied");
    expect(value.revision.blobId).toBe(replacementBlobId);
    expect(value.revision.blobId).not.toBe(value.expectedBlobId);
    expect(value.revision.blobGeneration).toBe(value.expectedBlobGeneration + 1);
    expect(connection.statements.join("\n")).toContain(
      'insert into "artifact_crypto_blobs"',
    );
    connection.assertExhausted();
  });

  test("archives through a no-copy control revision", async () => {
    const value = controlPlan();
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [], // existing operation
      [], // existing plan reservation
      [{ exists: 1 }], // exact active protected Artifact source
      [{ exists: 1 }], // exact retained published blob
      [], [], // operation and revision inserts
      [durableRow(value)], // locked publication
      [{ namespace_id: namespaceA }, { namespace_id: namespaceB }],
      [{ id: rowId }], // exact product CAS
      [], [], // revision and operation completion
    ]);
    const product = new PostgresArtifactProductPublication(
      await verifyConversationProductPostgresHandle(connection),
    );
    const reserved = await product.reserve(value);
    expect(reserved.status).toBe("allocated");
    if (reserved.status !== "allocated") throw new Error("expected allocation");
    expect(await product.publish({
      lifecycle: reserved.lifecycle,
      targetLifecycleState: "archived",
      verified: {
        artifactId,
        artifactRevision: 2,
        objectId: value.revision.objectId,
        accessRevision: 0,
        requiredNamespaceIds: [namespaceA, namespaceB],
        requiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      },
    })).toBe("applied");
    const sql = connection.statements.join("\n");
    expect(sql).toContain('"deleted_at" = CURRENT_TIMESTAMP');
    expect(sql).not.toContain('insert into "artifact_crypto_blobs"');
    expect(connection.parameters.flat()).toContain("archived");
    connection.assertExhausted();
  });

  test("replays completion only while the exact protected mapping remains active", async () => {
    const value = plan();
    const postgresCompleteRow = {
      ...completeDurableRow(value),
      ciphertext_length: String(value.blob.ciphertextLength),
    };
    const exactConnection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [postgresCompleteRow],
      [postgresCompleteRow],
      [{ exists: 1 }],
    ]);
    const exact = new PostgresArtifactProductPublication(
      await verifyConversationProductPostgresHandle(exactConnection),
    );
    const reserved = await exact.reserve(value);
    expect(reserved.status).toBe("replayed");
    if (reserved.status !== "replayed") throw new Error("expected replay");
    expect(await exact.publish({
      lifecycle: reserved.lifecycle,
      targetLifecycleState: "active",
      verified: {
        artifactId,
        artifactRevision: 1,
        objectId: value.revision.objectId,
        accessRevision: 0,
        requiredNamespaceIds: [namespaceA, namespaceB],
        requiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      },
    })).toBe("duplicate");
    exactConnection.assertExhausted();

    const quarantinedConnection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [completeDurableRow(value)],
      [completeDurableRow(value)],
      [],
    ]);
    const quarantined = new PostgresArtifactProductPublication(
      await verifyConversationProductPostgresHandle(quarantinedConnection),
    );
    const quarantinedReserved = await quarantined.reserve(value);
    expect(quarantinedReserved.status).toBe("replayed");
    if (quarantinedReserved.status !== "replayed") {
      throw new Error("expected replay");
    }
    expect(await quarantined.publish({
      lifecycle: quarantinedReserved.lifecycle,
      targetLifecycleState: "active",
      verified: {
        artifactId,
        artifactRevision: 1,
        objectId: value.revision.objectId,
        accessRevision: 0,
        requiredNamespaceIds: [namespaceA, namespaceB],
        requiredNamespaceFingerprint: value.requiredNamespaceFingerprint,
      },
    })).toBe("conflict");
    quarantinedConnection.assertExhausted();
  });
});

import { describe, expect, test } from "bun:test";

import {
  fingerprintHumanArtifactExactAccessTarget,
} from "../../src/server/artifact/human-artifact-exact-access.ts";
import {
  PostgresHumanArtifactExactAccessProduct,
  type HumanArtifactExactAccessCryptoReceipt,
} from "../../src/server/artifact/postgres-human-artifact-exact-access-product.ts";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresScalar,
} from "../../src/server/message/postgres-conversation-product-store.ts";

const USER = "11000000-0000-4000-8000-000000000001";
const ROW = "22000000-0000-4000-8000-000000000001";
const ARTIFACT = "22000000-0000-4000-8000-000000000002";
const BLOB = "22000000-0000-4000-8000-000000000003";
const ALICE = "33000000-0000-4000-8000-000000000001";
const BOB = "33000000-0000-4000-8000-000000000002";
const CHARLIE = "33000000-0000-4000-8000-000000000003";
const OBJECT = `artifact:v1:${"a".repeat(64)}`;
const REQUEST_DIGEST = new Uint8Array(32).fill(0x44);

type Operation = { id: string; anchor: string; digest: Uint8Array;
  expectedAccess: number; target: Uint8Array; complete: boolean };

class Connection implements ConversationProductPostgresConnection {
  namespaceIds = [ALICE, BOB];
  accessRevision = 2;
  fingerprint = fingerprintHumanArtifactExactAccessTarget(this.namespaceIds);
  operation: Operation | null = null;
  readonly statements: string[] = [];
  query<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) return Promise.resolve([
      { current_user: "nautilo", session_user: "nautilo" },
    ] as unknown as Row[]);
    throw new Error(`outside transaction: ${statement}`);
  }
  transaction<Result>(callback: (connection: this) => Promise<Result>): Promise<Result> {
    return callback(this);
  }
  async run<Row extends ConversationProductDatabaseRow = ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    const normalized = statement.toLowerCase();
    if (statement.includes("app_current_user_id")) return [
      { current_user_id: USER, current_agent_id: null },
    ] as unknown as Row[];
    if (statement.includes("lock-product")) return [{ artifact_row_id: ROW,
      artifact_id: ARTIFACT, revision: 4, crypto_access_revision: this.accessRevision,
      crypto_object_id: OBJECT, blob_id: BLOB, blob_generation: 3,
      crypto_required_namespace_fingerprint: this.fingerprint,
      crypto_lifecycle_state: "active", namespace_ids: JSON.stringify(this.namespaceIds),
    }] as unknown as Row[];
    if (
      statement.includes("FROM artifact_crypto_operations")
      || normalized.includes('from "artifact_crypto_operations"')
    ) {
      if (this.operation === null) return [];
      return [{ operation_id: this.operation.id, artifact_row_id: ROW,
        artifact_id: ARTIFACT, anchor_namespace_id: this.operation.anchor,
        operation_type: "access", expected_artifact_revision: 4,
        result_artifact_revision: 4, expected_access_revision: this.operation.expectedAccess,
        result_access_revision: this.operation.expectedAccess + 1,
        expected_blob_generation: 3, result_blob_generation: 3,
        expected_blob_id: BLOB, result_blob_id: BLOB,
        request_digest: this.operation.digest,
        expected_required_namespace_fingerprint:
          fingerprintHumanArtifactExactAccessTarget([ALICE, BOB]),
        target_required_namespace_fingerprint: this.operation.target,
        completion: this.operation.complete ? "complete" : "pending",
        disposition: this.operation.complete ? "complete" : "active",
      }] as unknown as Row[];
    }
    if (
      statement.includes("INSERT INTO artifact_crypto_operations")
      || normalized.startsWith('insert into "artifact_crypto_operations"')
    ) {
      this.operation = { id: parameters[0] as string, anchor: parameters[3] as string,
        expectedAccess: parameters[7] as number,
        digest: (parameters[13] as Uint8Array).slice(),
        target: (parameters[15] as Uint8Array).slice(), complete: false };
      return [];
    }
    if (
      statement.startsWith("DELETE FROM artifact_namespaces")
      || normalized.startsWith('delete from "artifact_namespaces"')
    ) {
      const id = parameters[1] as string;
      this.namespaceIds = this.namespaceIds.filter((value) => value !== id);
      return [{ namespace_id: id }] as unknown as Row[];
    }
    if (
      statement.startsWith("INSERT INTO artifact_namespaces")
      || normalized.startsWith('insert into "artifact_namespaces"')
    ) {
      const id = parameters[1] as string;
      this.namespaceIds = [...this.namespaceIds, id].sort();
      return [{ namespace_id: id }] as unknown as Row[];
    }
    if (
      statement.startsWith("UPDATE artifacts SET")
      || normalized.startsWith('update "artifacts"')
    ) {
      this.accessRevision = normalized.startsWith('update "artifacts"')
        ? parameters[0] as number
        : parameters[2] as number;
      this.fingerprint = ((normalized.startsWith('update "artifacts"')
        ? parameters[1]
        : parameters[3]) as Uint8Array).slice();
      return [{ artifact_id: ARTIFACT }] as unknown as Row[];
    }
    if (
      statement.startsWith("UPDATE artifact_crypto_operations SET")
      || normalized.startsWith('update "artifact_crypto_operations"')
    ) {
      if (this.operation === null) return [];
      this.operation.complete = true;
      return [{ operation_id: this.operation.id }] as unknown as Row[];
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }
}

function wire(connection: Connection): ConversationProductPostgresConnection {
  return { query: connection.query.bind(connection),
    transaction: (callback) => connection.transaction(async () => callback({
      query: connection.run.bind(connection),
    })) };
}

const authority = { userId: USER, subjectHumanId: "human-1", actorId: "actor-1",
  agentId: null, readableNamespaceIds: [BOB], mutableNamespaceIds: [BOB],
  writableNamespaceIds: [BOB, CHARLIE] } as const;

async function fixture() {
  const connection = new Connection();
  let ready = true;
  const product = new PostgresHumanArtifactExactAccessProduct({
    handle: await verifyConversationProductPostgresHandle(wire(connection)),
    resolveCryptoAuthority: async ({ change }) => ready ? {
      currentBindings: change.currentNamespaceIds.map((namespaceId) => ({ namespaceId,
        domainId: "domain-ab", expectedAccessRevision: 4,
        expectedPolicyRevision: 3, bindingHash: new Uint8Array(32).fill(0x41) })),
      targetBindings: change.targetNamespaceIds.map((namespaceId) => ({ namespaceId,
        domainId: "domain-ab", expectedAccessRevision: 4,
        expectedPolicyRevision: 3, bindingHash: new Uint8Array(32).fill(0x41) })),
      sourceAuthorized: true, targetAuthorized: true,
    } : null,
  });
  return { connection, product, setReady(value: boolean) { ready = value; } };
}

describe("Postgres Human Artifact exact access product", () => {
  test("no-op writes nothing and deletion preserves inaccessible Alice", async () => {
    const state = await fixture();
    expect(await state.product.plan({ authority, operationId: "access:no-op",
      artifactId: ARTIFACT,
      target: { kind: "replace_exact", namespaceIds: [BOB, ALICE] } }))
      .toMatchObject({ status: "unchanged" });
    expect(state.connection.operation).toBeNull();
    expect(await state.product.plan({ authority, operationId: "access:delete",
      artifactId: ARTIFACT, target: { kind: "delete_authorized_view" } }))
      .toMatchObject({ status: "prepared", targetNamespaceIds: [ALICE],
        removedNamespaceIds: [BOB] });
  });

  test("returns pending before reservation when target encryption is unavailable", async () => {
    const state = await fixture();
    state.setReady(false);
    expect(await state.product.plan({ authority, operationId: "access:add",
      artifactId: ARTIFACT,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] } }))
      .toEqual({ status: "unavailable", reason: "target_encryption_not_ready" });
    expect(state.connection.operation).toBeNull();
  });

  test("reserves, commits edge delta, and replays durable result", async () => {
    const state = await fixture();
    const planned = await state.product.plan({ authority, operationId: "access:add",
      artifactId: ARTIFACT,
      target: { kind: "replace_exact", namespaceIds: [ALICE, BOB, CHARLIE] } });
    if (planned.status !== "prepared") throw new Error("expected plan");
    await state.product.reserve({ authority, plan: planned,
      signedRequestDigest: REQUEST_DIGEST });
    const receipt: HumanArtifactExactAccessCryptoReceipt = {
      operationId: planned.operationId, artifactId: ARTIFACT, objectId: OBJECT,
      artifactRevision: 4, blobId: BLOB, blobGeneration: 3,
      expectedAccessRevision: 2, resultAccessRevision: 3,
      currentManifestHash: new Uint8Array(32), resultManifestHash: new Uint8Array(32),
      targetRequiredNamespaceFingerprint: planned.targetRequiredNamespaceFingerprint,
      requestDigest: REQUEST_DIGEST, currentNamespaceIds: [ALICE, BOB],
      targetNamespaceIds: [ALICE, BOB, CHARLIE], status: "applied",
    };
    expect(await state.product.commit({ authority, plan: planned, receipt }))
      .toMatchObject({ status: "updated", cryptoAccessRevision: 3 });
    expect((await state.product.lookupReplay({ authority, operationId: "access:add",
      artifactId: ARTIFACT, signedRequestDigest: REQUEST_DIGEST })))
      .toMatchObject({ status: "completed", cryptoAccessRevision: 3,
        requiredNamespaceIds: [ALICE, BOB, CHARLIE] });
  });
});

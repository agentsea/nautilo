import { describe, expect, test } from "bun:test";

import {
  verifyConversationProductPostgresHandle,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
} from "../../src/server/message/postgres-conversation-product-store.ts";
import {
  PostgresHumanArtifactProductRoute,
} from "../../src/server/artifact/postgres-human-artifact-product-route.ts";

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(statement: string, parameters: readonly unknown[] = []): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.parameters.push([...parameters]);
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

const NS = "11111111-1111-4111-8111-111111111111";
const ROW = "22222222-2222-4222-8222-222222222222";
const ARTIFACT = "33333333-3333-4333-8333-333333333333";
const BLOB = "44444444-4444-4444-8444-444444444444";
const OP = "55555555-5555-4555-8555-555555555555";

const authority = Object.freeze({
  userId: "user-alice",
  subjectHumanId: "human-alice",
  actorId: "actor-alice",
  agentId: null,
  readableNamespaceIds: Object.freeze([NS]),
  mutableNamespaceIds: Object.freeze([NS]),
  writableNamespaceIds: Object.freeze([NS]),
});

describe("Postgres Human Artifact product route", () => {
  test("reserves a content-free create plan before ciphertext or signed bytes exist", async () => {
    const connection = new ScriptedConnection([
      [{ current_user: "nautilo", session_user: "nautilo" }],
      [], [], [], [], // reservation lookup, product/blob collision, insert
    ]);
    const ids = [ROW, ARTIFACT, BLOB, OP];
    const route = new PostgresHumanArtifactProductRoute({
      handle: await verifyConversationProductPostgresHandle(connection),
      createUuid: () => ids.shift()!,
      now: () => 10_000,
      resolveBindings: ({ namespaceIds }) => Promise.resolve(namespaceIds.map(
        (namespaceId) => ({
          namespaceId,
          domainId: "domain-human-alice",
          expectedAccessRevision: 2,
          expectedPolicyRevision: 3,
          bindingHash: new Uint8Array(32).fill(0x17),
        }),
      )),
    });
    const result = await route.plan({
      authority,
      request: {
        requestVersion: 1,
        operation: "create",
        lifecycleAction: "activate",
        artifactId: null,
        anchorNamespaceId: NS,
        expectedArtifactRevision: 0,
        expectedCryptoAccessRevision: 0,
        expectedBlobGeneration: 0,
        expectedBlobId: null,
        mimeClass: "document",
        sizeBucket: "le_10_mib",
      },
    });
    expect(result).toMatchObject({
      status: "planned",
      artifactRowId: ROW,
      artifactId: ARTIFACT,
      resultBlobId: BLOB,
      operationId: `artifact-publication:${OP}`,
      requiredNamespaceIds: [NS],
      deadlineAt: 40_000,
    });
    if (result.status !== "planned") throw new Error("expected plan");
    expect(result.planDigestBase64url).toHaveLength(43);
    expect(connection.statements.join("\n")).toContain(
      'insert into "artifact_crypto_operations"',
    );
    expect(connection.statements.join("\n")).not.toMatch(
      /crypto_objects|payload_bytes|manifest_bytes|plaintext/i,
    );
    connection.assertExhausted();
  });

  test("returns typed pending before reserving when exact target bindings are unavailable", async () => {
    const connection = new ScriptedConnection([[
      { current_user: "nautilo", session_user: "nautilo" },
    ]]);
    const route = new PostgresHumanArtifactProductRoute({
      handle: await verifyConversationProductPostgresHandle(connection),
      createUuid: () => { throw new Error("must not allocate"); },
      now: () => 10_000,
      resolveBindings: () => Promise.resolve(null),
    });
    expect(await route.plan({
      authority,
      request: {
        requestVersion: 1,
        operation: "create",
        lifecycleAction: "activate",
        artifactId: null,
        anchorNamespaceId: NS,
        expectedArtifactRevision: 0,
        expectedCryptoAccessRevision: 0,
        expectedBlobGeneration: 0,
        expectedBlobId: null,
        mimeClass: "document",
        sizeBucket: "le_10_mib",
      },
    })).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "target_encryption_not_ready",
    });
    connection.assertExhausted();
  });
});

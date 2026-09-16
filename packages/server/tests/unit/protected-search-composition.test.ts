import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import type { ReflectionSemanticOperationPort } from "@nautilo/lattice-bridge/server";
import { encodeRecordPayloadV1 } from "@nautilo/reflection/payload";
import { RECORD_SEARCH_POLICY_V1 } from "@nautilo/reflection/search";
import type {
  RecordProductPostgresConnection,
  RecordProductPostgresExecutor,
  RecordProductPostgresRow,
  RecordProductPostgresScalar,
} from "@nautilo/reflection-bridge/server";

import { createProductionProtectedReflectionSearchComposition } from
  "../../src/reflection/protected-search-composition";

const RECORD = "record:protected-search";
const NAMESPACE = "66000000-0000-4000-8000-000000000001";
const claim = {
  recordRef: RECORD,
  logicalObjectRef: RECORD,
  generation: 4,
  changeReason: "created" as const,
  stage: "search_projection" as const,
  leaseToken: "lease:protected-search",
};
const provenance = {
  provider: "openai" as const,
  canonicalModel: "text-embedding-3-small",
  dimensions: 1_536 as const,
  contractVersion: 1 as const,
};

function connectionFor(input: Readonly<{
  calls: string[];
  duplicateMetadata?: boolean;
}>): RecordProductPostgresConnection {
  const connection: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      _parameters?: readonly RecordProductPostgresScalar[],
    ): Promise<readonly Row[]> {
      input.calls.push(statement);
      if (statement.includes("current_user AS current_role")) {
        return [{
          current_role: "nautilo",
          session_role: "nautilo",
        }] as unknown as readonly Row[];
      }
      if (statement.includes('"reflection_record_payload_representation_heads"')) {
        const row = {
          record_id: RECORD,
          processing_generation: 2,
          producer_policy_version: "policy:v1",
          lifecycle: "current",
          disposition: "available",
          representation_generation: 3,
          crypto_object_id: "crypto:record:3",
          processing_state: "current",
          access_namespace_id: NAMESPACE,
        };
        return (input.duplicateMetadata ? [row, row] : [row]) as unknown as readonly Row[];
      }
      if (
        statement.includes('from "reflection_record_search_projections"')
        && !statement.includes("FOR UPDATE")
      ) return [];
      if (statement.includes('from "reflection_record_semantic_work"')) {
        return [{
          record_id: RECORD,
          lease_expires_at: new Date("2099-01-01T00:00:00.000Z"),
        }] as unknown as readonly Row[];
      }
      if (statement.includes("FROM reflection_record_search_projections")) return [];
      if (statement.includes("FROM reflection_records")) {
        return [{ accepted: 1 }] as unknown as readonly Row[];
      }
      if (statement.includes("INSERT INTO reflection_record_search_projections")) return [];
      throw new Error(`Unexpected query: ${statement}`);
    },
    transaction<Result>(
      use: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
    ): Promise<Result> {
      return use(connection);
    },
  };
  return connection;
}

function semanticOperation(input: Readonly<{
  product: RecordProductPostgresConnection;
  events: string[];
}>): ReflectionSemanticOperationPort["runSemantic"] {
  return async request => {
    input.events.push("gate");
    const signal = request.signal ?? new AbortController().signal;
    const plaintext = encodeRecordPayloadV1({
      formatVersion: 1,
      posture: "derived",
      observedContentFingerprint: "fingerprint",
      sourceOwnedKind: null,
      observedLogicalObjectRef: null,
      observedRevision: null,
      statement: "Protected launch is Tuesday.",
      sourceDependencies: [],
      anchors: [],
      childRecordIds: [],
      producer: { producerRef: "reflection", policyVersion: "policy:v1" },
      terminalAuthorityLeafHandles: [NAMESPACE],
    });
    const opened = {
      objectId: "crypto:record:3",
      namespaceId: NAMESPACE,
      objectType: "nautilo.reflection.record.v1" as const,
      plaintext,
      signal,
    };
    try {
      await request.validateInput(opened);
      const output = await request.execute([opened], undefined, signal, async () => {});
      await request.attach({
        output,
        claimId: "crypto-claim",
        held: {
          executor: { query: async () => [] },
          product: input.product,
          issuerSigningPublicKey: new Uint8Array(32),
        },
        signal,
        authorizeCommit: async () => {
          input.events.push("authorize");
          return Date.now();
        },
      });
      return { status: "executed" };
    } finally {
      plaintext.fill(0);
    }
  };
}

describe("production protected Reflection search composition", () => {
  test("embeds one granted payload and publishes under held claim and source fences", async () => {
    const sql: string[] = [];
    const events: string[] = [];
    const product = connectionFor({ calls: sql });
    const semantic = await createProductionProtectedReflectionSearchComposition({
      db: {} as DirectDatabase,
      commitmentKey: new Uint8Array(32).fill(7),
      runSemantic: semanticOperation({ product, events }),
      embedding: {
        embed: async request => {
          events.push("embed");
          expect(request.plaintext).toBe("Protected launch is Tuesday.");
          return {
            status: "available",
            embedding: {
              provenance,
              vector: new Array<number>(
                RECORD_SEARCH_POLICY_V1.embeddingDimensions,
              ).fill(0.25),
            },
          };
        },
      },
    }, {
      connect: () => product,
      configuredEmbedding: () => provenance,
    });

    expect(await semantic.ensureSearchProjection(claim)).toEqual({ status: "ready" });
    expect(events).toEqual(["gate", "embed", "authorize"]);
    expect(sql.some(statement => statement.includes("plaintext_payload_bytes")))
      .toBe(false);
    const claimFence = sql.findIndex(statement =>
      statement.includes('from "reflection_record_semantic_work"'));
    const insert = sql.findIndex(statement =>
      statement.includes("INSERT INTO reflection_record_search_projections"));
    expect(claimFence).toBeGreaterThan(-1);
    expect(insert).toBeGreaterThan(claimFence);
  });

  test("rejects non-exact protected access metadata before opening a payload", async () => {
    const sql: string[] = [];
    const events: string[] = [];
    const product = connectionFor({ calls: sql, duplicateMetadata: true });
    const semantic = await createProductionProtectedReflectionSearchComposition({
      db: {} as DirectDatabase,
      commitmentKey: new Uint8Array(32).fill(8),
      runSemantic: semanticOperation({ product, events }),
      embedding: {
        embed: async () => {
          throw new Error("embedding must remain unreachable");
        },
      },
    }, {
      connect: () => product,
      configuredEmbedding: () => provenance,
    });

    expect(await semantic.ensureSearchProjection(claim)).toEqual({
      status: "unavailable",
      failureCode: "record_unavailable",
    });
    expect(events).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";

import type { RecordEmbeddingV1 } from "@nautilo/reflection/search";

import {
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  verifyRecordProductPostgresHandle,
} from "../../src/server/product-postgres";
import { PostgresAuthorityFilteredRecordSearchStore } from "../../src/server/postgres-record-search-store";

const HUMAN = "11111111-1111-4111-8111-111111111111";

function embedding(): RecordEmbeddingV1 {
  return {
    provenance: {
      provider: "openai",
      canonicalModel: "text-embedding-3-small",
      dimensions: 1_536,
      contractVersion: 1,
    },
    vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(0.25))),
  };
}

const EMPTY_CORPUS_ROW: RecordProductPostgresRow = {
  record_id: null,
  corpus_count: "0",
  corpus_hash_one: "0",
  corpus_hash_two: "0",
};

async function searchStore(input: Readonly<{
  rows?: readonly RecordProductPostgresRow[];
  error?: unknown;
}> = {}) {
  const queries: string[] = [];
  const queryParameters: (readonly unknown[] | undefined)[] = [];
  const executor: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly unknown[],
    ) {
      if (statement.startsWith("SELECT current_user")) {
        return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
      }
      queries.push(statement);
      queryParameters.push(parameters);
      if (statement.includes("WITH eligible_coordinates") && input.error !== undefined) {
        throw input.error instanceof Error
          ? input.error
          : Object.assign(new Error("synthetic database failure"), input.error);
      }
      return (statement.includes("WITH eligible_coordinates")
        ? input.rows ?? [EMPTY_CORPUS_ROW]
        : []) as readonly Row[];
    },
    async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
      return callback(executor);
    },
  };
  return {
    store: new PostgresAuthorityFilteredRecordSearchStore(
      await verifyRecordProductPostgresHandle(executor),
    ),
    queries,
    queryParameters,
  };
}

describe("authority-filtered exact Record search SQL", () => {
  test("materializes eligibility before vector access and encodes exact authority rules", async () => {
    const value = await searchStore();
    expect(await value.store.search({
      embedding: embedding(),
      invocationAudience: {
        humanRefs: [HUMAN],
        includesPublicBoundary: false,
      },
      selection: { selectedRepresentation: "protected", migrationGeneration: 2 },
      limit: 10,
    })).toEqual({
      status: "available",
      coordinates: [],
      corpusStateCoordinate: "0:0:0",
      hasMore: false,
    });

    expect(value.queries[0]).toBe("SET TRANSACTION READ ONLY");
    expect(value.queries[1]).toBe("SET LOCAL jit = off");
    expect(value.queries[2]).toBe("SET LOCAL statement_timeout = '5000ms'");
    const sql = value.queries[3]!;
    const eligibility = sql.slice(
      sql.indexOf("eligible_coordinates AS MATERIALIZED"),
      sql.indexOf("compatible_projections AS MATERIALIZED"),
    );
    expect(eligibility).not.toContain("embedding");
    expect(eligibility).not.toContain("<=>");
    expect(sql.indexOf("eligible_coordinates AS MATERIALIZED")).toBeLessThan(
      sql.indexOf("compatible_projections AS MATERIALIZED"),
    );
    expect(sql).toContain("record.lifecycle <> 'sunset'");
    expect(sql).toContain("eligible_authority.alternative_count_valid");
    expect(sql).toContain("eligible_authority.mappings_complete IS TRUE");
    expect(sql).toContain("FROM actors AS human_actor");
    expect(sql).toContain("human_actor.kind = 'user'");
    expect(sql).toContain("eligible_authority.invocation_eligible IS TRUE");
    expect(sql).toContain("NOT $7::boolean");
    expect(sql).toContain("alternative.includes_public_boundary");
    expect(sql).toContain("ORDER BY score DESC, structural_height DESC, record_id ASC");
    expect(value.queryParameters[3]?.[12]).toBe(false);
  });

  test("structural selection prefers a protected head while reusing its search projection", async () => {
    const value = await searchStore({ rows: [{
      record_id: "record:protected-only",
      structural_height: 0,
      processing_generation: 1,
      authority_projection_generation: 2,
      payload_representation_generation: 2,
      projection_generation: 1,
      score: 0.9,
      corpus_count: "1",
      corpus_hash_one: "11",
      corpus_hash_two: "12",
    }] });

    expect(await value.store.search({
      embedding: embedding(),
      invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      preferProtectedHead: true,
      limit: 1,
    })).toMatchObject({
      status: "available",
      coordinates: [{
        recordRef: "record:protected-only",
        payloadRepresentationGeneration: 2,
        projectionGeneration: 1,
      }],
    });
    const sql = value.queries[3]!;
    expect(sql).toContain("JOIN LATERAL (");
    expect(sql).toContain("candidate_head.representation = 'protected' THEN 0");
    expect(sql).toContain("candidate_head.representation = $8");
    expect(value.queryParameters[3]?.[7]).toBe("ordinary");
    expect(value.queryParameters[3]?.[12]).toBe(true);
  });

  test("requires the complete bounded alternative set to resolve before any OR-branch can qualify", async () => {
    const value = await searchStore();
    await value.store.search({
      embedding: embedding(),
      invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: true },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      limit: 1,
    });
    const sql = value.queries[3]!;
    expect(sql).toContain("count(*) BETWEEN 1 AND 256 AS alternative_count_valid");
    expect(sql).toContain("bool_and(");
    expect(sql).toContain("mapped.mapping_count = 1");
    expect(sql).toContain("mapped.mapping_valid IS TRUE");
    expect(sql).toContain("bool_or(");
    expect(sql).toContain("mapped.audience_eligible IS TRUE");
  });

  test("returns a typed whole-scan timeout with no partial rows", async () => {
    const value = await searchStore({ error: { code: "57014" } });
    expect(await value.store.search({
      embedding: embedding(),
      invocationAudience: { humanRefs: [HUMAN], includesPublicBoundary: false },
      selection: { selectedRepresentation: "ordinary", migrationGeneration: 1 },
      limit: 1,
    })).toEqual({ status: "unavailable", reason: "timeout" });
  });
});

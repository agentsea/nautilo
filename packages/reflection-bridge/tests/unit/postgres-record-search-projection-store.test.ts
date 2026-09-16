import { describe, expect, test } from "bun:test";

import type { RecordSearchProjectionV1 } from "@nautilo/reflection/search";

import {
  type RecordProductPostgresConnection,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
  verifyRecordProductPostgresHandle,
} from "../../src/server/product-postgres";
import { PostgresRecordSearchProjectionStore } from "../../src/server/postgres-record-search-projection-store";

type Query = Readonly<{
  statement: string;
  parameters?: readonly RecordProductPostgresScalar[];
}>;

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("Expected promise to reject");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function projection(generation = 1, value = 0.25): RecordSearchProjectionV1 {
  return {
    recordRef: "record-one",
    recordProcessingGeneration: 1,
    projectionVersion: 1,
    projectionGeneration: generation,
    embedding: {
      provenance: {
        provider: "openai",
        canonicalModel: "text-embedding-3-small",
        dimensions: 1_536,
        contractVersion: 1,
      },
      vector: Object.freeze(Array.from({ length: 1_536 }, () => Math.fround(value))),
    },
  };
}

async function storeWithResponses(responses: readonly (readonly RecordProductPostgresRow[])[]) {
  const queries: Query[] = [];
  let response = 0;
  const executor: RecordProductPostgresConnection = {
    async query<Row extends RecordProductPostgresRow>(
      statement: string,
      parameters?: readonly RecordProductPostgresScalar[],
    ) {
      if (statement.startsWith("SELECT current_user")) {
        return [{ current_role: "nautilo", session_role: "nautilo" }] as unknown as readonly Row[];
      }
      queries.push({ statement, ...(parameters === undefined ? {} : { parameters }) });
      return (responses[response++] ?? []) as readonly Row[];
    },
    async transaction<Result>(callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>) {
      return callback(executor);
    },
  };
  return {
    store: new PostgresRecordSearchProjectionStore(
      await verifyRecordProductPostgresHandle(executor),
    ),
    queries,
  };
}

describe("PostgreSQL Record search projection store", () => {
  test("reads the current compatibility coordinate without vector bytes", async () => {
    const value = await storeWithResponses([[{
      record_id: "record-one",
      record_processing_generation: 3,
      projection_version: 1,
      projection_generation: 4,
      embedding_provider: "openai",
      embedding_canonical_model: "text-embedding-3-small",
      embedding_dimensions: 1_536,
      embedding_contract_version: 1,
    }]]);
    expect(await value.store.readCurrent("record-one")).toEqual({
      recordRef: "record-one",
      recordProcessingGeneration: 3,
      projectionVersion: 1,
      projectionGeneration: 4,
      embeddingProvider: "openai",
      embeddingCanonicalModel: "text-embedding-3-small",
      embeddingDimensions: 1_536,
      embeddingContractVersion: 1,
    });
    expect(value.queries[0]?.statement).not.toContain("embedding,");
  });

  test("opens the existing vector only through the explicit Organizer reuse path", async () => {
    const expected = projection(4);
    const value = await storeWithResponses([[{
      record_id: expected.recordRef,
      record_processing_generation: expected.recordProcessingGeneration,
      projection_version: expected.projectionVersion,
      projection_generation: expected.projectionGeneration,
      embedding_provider: expected.embedding.provenance.provider,
      embedding_canonical_model: expected.embedding.provenance.canonicalModel,
      embedding_dimensions: expected.embedding.provenance.dimensions,
      embedding_contract_version: expected.embedding.provenance.contractVersion,
      embedding: JSON.stringify(expected.embedding.vector),
    }]]);

    expect(await value.store.readCurrentEmbedding(expected.recordRef)).toEqual(expected);
    expect(value.queries[0]?.statement).toContain('"embedding"');
  });

  test("rejects malformed or oversized returned vector text", async () => {
    const base = {
      record_id: "record-one",
      record_processing_generation: 1,
      projection_version: 1,
      projection_generation: 1,
      embedding_provider: "openai",
      embedding_canonical_model: "text-embedding-3-small",
      embedding_dimensions: 1_536,
      embedding_contract_version: 1,
    };
    const malformed = await storeWithResponses([[(
      { ...base, embedding: "not-a-vector" }
    )]]);
    expect(await rejectionMessage(malformed.store.readCurrentEmbedding("record-one"))).toBe(
      "Invalid Record search projection vector",
    );
    const oversized = await storeWithResponses([[(
      { ...base, embedding: `[${"1,".repeat(40_000)}1]` }
    )]]);
    expect(await rejectionMessage(oversized.store.readCurrentEmbedding("record-one"))).toBe(
      "Invalid Record search projection vector",
    );
  });

  test("publishes a validated first projection", async () => {
    const value = await storeWithResponses([[], [{ accepted: 1 }], []]);
    expect(await value.store.publish(projection())).toBe("published");
    expect(value.queries.at(-1)?.statement).toContain(
      "INSERT INTO reflection_record_search_projections",
    );
  });

  test("persists and reads back Venice embedding provenance and vector bytes", async () => {
    const expected: RecordSearchProjectionV1 = {
      ...projection(),
      embedding: {
        provenance: {
          provider: "venice",
          canonicalModel: "text-embedding-3-small",
          dimensions: 1_536,
          contractVersion: 1,
        },
        vector: Object.freeze(Array.from(
          { length: 1_536 },
          (_entry, index) => Math.fround((index + 1) / 1_536),
        )),
      },
    };
    const published = await storeWithResponses([[], [{ accepted: 1 }], []]);

    expect(await published.store.publish(expected)).toBe("published");
    const parameters = published.queries.at(-1)?.parameters;
    expect(parameters?.slice(4, 8)).toEqual([
      "venice",
      "text-embedding-3-small",
      1_536,
      1,
    ]);
    const [
      recordId,
      recordProcessingGeneration,
      projectionVersion,
      projectionGeneration,
      embeddingProvider,
      embeddingCanonicalModel,
      embeddingDimensions,
      embeddingContractVersion,
      embedding,
    ] = parameters ?? [];
    if (
      typeof recordId !== "string"
      || typeof recordProcessingGeneration !== "number"
      || typeof projectionVersion !== "number"
      || typeof projectionGeneration !== "number"
      || typeof embeddingProvider !== "string"
      || typeof embeddingCanonicalModel !== "string"
      || typeof embeddingDimensions !== "number"
      || typeof embeddingContractVersion !== "number"
      || typeof embedding !== "string"
    ) throw new Error("expected persisted projection parameters");

    const read = await storeWithResponses([[{
      record_id: recordId,
      record_processing_generation: recordProcessingGeneration,
      projection_version: projectionVersion,
      projection_generation: projectionGeneration,
      embedding_provider: embeddingProvider,
      embedding_canonical_model: embeddingCanonicalModel,
      embedding_dimensions: embeddingDimensions,
      embedding_contract_version: embeddingContractVersion,
      embedding,
    }]]);
    expect(await read.store.readCurrentEmbedding(expected.recordRef)).toEqual(expected);
  });

  test("exact replay is idempotent and differing bytes conflict", async () => {
    const replay = await storeWithResponses([[{
      projection_generation: 1,
      exact_match: true,
    }]]);
    expect(await replay.store.publish(projection())).toBe("replayed");

    const conflict = await storeWithResponses([[{
      projection_generation: 1,
      exact_match: false,
    }]]);
    expect(await conflict.store.publish(projection())).toBe("conflict");
  });

  test("replacement requires the exact current generation", async () => {
    const stale = await storeWithResponses([[{
      projection_generation: 1,
      exact_match: false,
    }], [{ accepted: 1 }], []]);
    expect(await stale.store.replace({
      expectedProjectionGeneration: 1,
      projection: projection(2, 0.5),
    })).toBe("replaced");

    const conflict = await storeWithResponses([[{
      projection_generation: 2,
      exact_match: false,
    }]]);
    expect(await conflict.store.replace({
      expectedProjectionGeneration: 1,
      projection: projection(2, 0.5),
    })).toBe("conflict");
  });

  test("removes the exact current projection through the typed table", async () => {
    const value = await storeWithResponses([
      [{ projection_generation: 2 }],
      [],
    ]);

    expect(await value.store.remove({
      recordRef: "record-one",
      expectedProjectionGeneration: 2,
    })).toBe("removed");
    expect(value.queries.at(-1)?.statement)
      .toContain('delete from "reflection_record_search_projections"');
    expect(value.queries.at(-1)?.parameters).toEqual(["record-one"]);
  });
});

import {
  assertCanonicalRecordEmbeddingV1,
  canonicalizeRecordEmbeddingV1,
  validateRecordSearchProjectionV1,
  type RecordEmbeddingV1,
  type RecordSearchProjectionV1,
} from "@nautilo/reflection/search";
import { eq, reflectionRecordSearchProjections } from "@nautilo/db";

import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";

export type RecordSearchProjectionPublicationResult =
  | "published"
  | "replayed"
  | "record_unavailable"
  | "conflict";

export type RecordSearchProjectionReplacementResult =
  | "replaced"
  | "replayed"
  | "record_unavailable"
  | "stale"
  | "conflict";

export type RecordSearchProjectionRemovalResult =
  | "removed"
  | "replayed"
  | "stale";

export interface CurrentRecordSearchProjectionCoordinate {
  readonly recordRef: string;
  readonly recordProcessingGeneration: number;
  readonly projectionVersion: 1;
  readonly projectionGeneration: number;
  readonly embeddingProvider: "openai" | "openrouter" | "venice";
  readonly embeddingCanonicalModel: string;
  readonly embeddingDimensions: number;
  readonly embeddingContractVersion: 1;
}

const SERIALIZATION_FAILURE = "40001";
const DEADLOCK_FAILURE = "40P01";
const MAX_TRANSACTION_ATTEMPTS = 3;
const MAX_VECTOR_TEXT_BYTES = 64 * 1_024;

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === SERIALIZATION_FAILURE || error.code === DEADLOCK_FAILURE);
}

function rowInteger(row: RecordProductPostgresRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("Invalid Record search projection generation");
  }
  return value as number;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function returnedVector(value: unknown): readonly number[] {
  if (Array.isArray(value)) return canonicalizeRecordEmbeddingV1(value);
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_VECTOR_TEXT_BYTES
  ) throw new TypeError("Invalid Record search projection vector");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid Record search projection vector");
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Invalid Record search projection vector");
  }
  return canonicalizeRecordEmbeddingV1(parsed);
}

function projectionParameters(
  projection: RecordSearchProjectionV1,
): readonly (string | number)[] {
  return [
    projection.recordRef,
    projection.recordProcessingGeneration,
    projection.projectionVersion,
    projection.projectionGeneration,
    projection.embedding.provenance.provider,
    projection.embedding.provenance.canonicalModel,
    projection.embedding.provenance.dimensions,
    projection.embedding.provenance.contractVersion,
    vectorLiteral(projection.embedding.vector),
  ];
}

async function exactExisting(
  transaction: RecordProductPostgresExecutor,
  projection: RecordSearchProjectionV1,
): Promise<Readonly<{ generation: number; exact: boolean }> | null> {
  const rows = await transaction.query(
    `SELECT projection_generation,
            record_processing_generation = $2
              AND projection_version = $3
              AND projection_generation = $4
              AND embedding_provider = $5
              AND embedding_canonical_model = $6
              AND embedding_dimensions = $7
              AND embedding_contract_version = $8
              AND embedding = $9::vector AS exact_match
       FROM reflection_record_search_projections
      WHERE record_id = $1
      FOR UPDATE`,
    projectionParameters(projection),
  );
  if (rows.length > 1) throw new Error("Duplicate Record search projection");
  const row = rows[0];
  return row === undefined
    ? null
    : {
        generation: rowInteger(row, "projection_generation"),
        exact: row["exact_match"] === true,
      };
}

async function recordAcceptsProjection(
  transaction: RecordProductPostgresExecutor,
  projection: RecordSearchProjectionV1,
): Promise<boolean> {
  const rows = await transaction.query(
    `SELECT 1 AS accepted
       FROM reflection_records
      WHERE record_id = $1
        AND processing_generation = $2
        AND disposition = 'available'
        AND lifecycle <> 'sunset'
      FOR SHARE`,
    [projection.recordRef, projection.recordProcessingGeneration],
  );
  if (rows.length > 1) throw new Error("Duplicate Record identity");
  return rows.length === 1;
}

/** Product-role-only publication of the deliberately plaintext search vector. */
export class PostgresRecordSearchProjectionStore {
  constructor(private readonly handle: RecordProductPostgresHandle) {
    assertVerifiedRecordProductPostgresHandle(handle);
  }

  async readCurrent(
    recordRef: string,
  ): Promise<CurrentRecordSearchProjectionCoordinate | null> {
    if (recordRef.length === 0) {
      throw new TypeError("Record search projection read requires a Record");
    }
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecordSearchProjections.recordId,
        record_processing_generation:
          reflectionRecordSearchProjections.recordProcessingGeneration,
        projection_version: reflectionRecordSearchProjections.projectionVersion,
        projection_generation: reflectionRecordSearchProjections.projectionGeneration,
        embedding_provider: reflectionRecordSearchProjections.embeddingProvider,
        embedding_canonical_model:
          reflectionRecordSearchProjections.embeddingCanonicalModel,
        embedding_dimensions: reflectionRecordSearchProjections.embeddingDimensions,
        embedding_contract_version:
          reflectionRecordSearchProjections.embeddingContractVersion,
      })
        .from(reflectionRecordSearchProjections)
        .where(eq(reflectionRecordSearchProjections.recordId, recordRef)));
    if (rows.length > 1) throw new Error("Duplicate Record search projection");
    const row = rows[0];
    if (row === undefined) return null;
    const projectionVersion = rowInteger(row, "projection_version");
    const embeddingContractVersion = rowInteger(
      row,
      "embedding_contract_version",
    );
    const provider = row["embedding_provider"];
    const canonicalModel = row["embedding_canonical_model"];
    if (
      projectionVersion !== 1
      || embeddingContractVersion !== 1
      || (provider !== "openai" && provider !== "openrouter" && provider !== "venice")
      || typeof canonicalModel !== "string"
      || canonicalModel.length === 0
    ) throw new TypeError("Invalid Record search projection row");
    return {
      recordRef,
      recordProcessingGeneration: rowInteger(row, "record_processing_generation"),
      projectionVersion: 1,
      projectionGeneration: rowInteger(row, "projection_generation"),
      embeddingProvider: provider,
      embeddingCanonicalModel: canonicalModel,
      embeddingDimensions: rowInteger(row, "embedding_dimensions"),
      embeddingContractVersion: 1,
    };
  }

  /**
   * Server-local reuse path for Organizer queries. The vector is already the
   * deliberately plaintext, rebuildable projection; this avoids embedding the
   * same immutable statement again for every organization attempt.
   */
  async readCurrentEmbedding(
    recordRef: string,
  ): Promise<RecordSearchProjectionV1 | null> {
    if (recordRef.length === 0) {
      throw new TypeError("Record search projection read requires a Record");
    }
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecordSearchProjections.recordId,
        record_processing_generation:
          reflectionRecordSearchProjections.recordProcessingGeneration,
        projection_version: reflectionRecordSearchProjections.projectionVersion,
        projection_generation: reflectionRecordSearchProjections.projectionGeneration,
        embedding_provider: reflectionRecordSearchProjections.embeddingProvider,
        embedding_canonical_model:
          reflectionRecordSearchProjections.embeddingCanonicalModel,
        embedding_dimensions: reflectionRecordSearchProjections.embeddingDimensions,
        embedding_contract_version:
          reflectionRecordSearchProjections.embeddingContractVersion,
        embedding: reflectionRecordSearchProjections.embedding,
      })
        .from(reflectionRecordSearchProjections)
        .where(eq(reflectionRecordSearchProjections.recordId, recordRef)));
    if (rows.length > 1) throw new Error("Duplicate Record search projection");
    const row = rows[0];
    if (row === undefined) return null;
    const provider = row["embedding_provider"];
    const canonicalModel = row["embedding_canonical_model"];
    const vector = row["embedding"];
    const returnedRecordRef = row["record_id"];
    if (
      typeof provider !== "string"
      || typeof canonicalModel !== "string"
      || typeof returnedRecordRef !== "string"
      || returnedRecordRef !== recordRef
    ) throw new TypeError("Invalid Record search projection row");
    const dimensions = rowInteger(row, "embedding_dimensions");
    const contractVersion = rowInteger(row, "embedding_contract_version");
    const projectionVersion = rowInteger(row, "projection_version");
    if (dimensions !== 1_536 || contractVersion !== 1 || projectionVersion !== 1) {
      throw new TypeError("Invalid Record search projection row");
    }
    const embedding: RecordEmbeddingV1 = {
      provenance: {
        provider,
        canonicalModel,
        dimensions,
        contractVersion,
      },
      vector: returnedVector(vector),
    };
    assertCanonicalRecordEmbeddingV1(embedding);
    const projection: RecordSearchProjectionV1 = {
      recordRef: returnedRecordRef,
      recordProcessingGeneration: rowInteger(row, "record_processing_generation"),
      projectionVersion,
      projectionGeneration: rowInteger(row, "projection_generation"),
      embedding,
    };
    validateRecordSearchProjectionV1(projection);
    return projection;
  }

  publish(
    projection: RecordSearchProjectionV1,
  ): Promise<RecordSearchProjectionPublicationResult> {
    validateRecordSearchProjectionV1(projection);
    return this.#serializable(async (transaction) => {
      const current = await exactExisting(transaction, projection);
      if (current !== null) return current.exact ? "replayed" : "conflict";
      if (!(await recordAcceptsProjection(transaction, projection))) {
        return "record_unavailable";
      }
      await transaction.query(
        `INSERT INTO reflection_record_search_projections (
           record_id, record_processing_generation, projection_version,
           projection_generation, embedding_provider,
           embedding_canonical_model, embedding_dimensions,
           embedding_contract_version, embedding
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::vector)`,
        projectionParameters(projection),
      );
      return "published";
    });
  }

  replace(input: Readonly<{
    expectedProjectionGeneration: number;
    projection: RecordSearchProjectionV1;
  }>): Promise<RecordSearchProjectionReplacementResult> {
    validateRecordSearchProjectionV1(input.projection);
    if (
      !Number.isSafeInteger(input.expectedProjectionGeneration)
      || input.expectedProjectionGeneration < 1
      || input.projection.projectionGeneration
        !== input.expectedProjectionGeneration + 1
    ) {
      throw new RangeError("Record search projection replacement generation is invalid");
    }
    return this.#serializable(async (transaction) => {
      const current = await exactExisting(transaction, input.projection);
      if (current === null) return "stale";
      if (current.generation === input.projection.projectionGeneration) {
        return current.exact ? "replayed" : "conflict";
      }
      if (current.generation !== input.expectedProjectionGeneration) return "stale";
      if (!(await recordAcceptsProjection(transaction, input.projection))) {
        return "record_unavailable";
      }
      await transaction.query(
        `UPDATE reflection_record_search_projections
            SET record_processing_generation = $2,
                projection_version = $3,
                projection_generation = $4,
                embedding_provider = $5,
                embedding_canonical_model = $6,
                embedding_dimensions = $7,
                embedding_contract_version = $8,
                embedding = $9::vector,
                updated_at = now()
          WHERE record_id = $1`,
        projectionParameters(input.projection),
      );
      return "replaced";
    });
  }

  remove(input: Readonly<{
    recordRef: string;
    expectedProjectionGeneration?: number;
  }>): Promise<RecordSearchProjectionRemovalResult> {
    if (input.recordRef.length === 0) {
      throw new TypeError("Record search projection removal requires a Record");
    }
    if (
      input.expectedProjectionGeneration !== undefined
      && (
        !Number.isSafeInteger(input.expectedProjectionGeneration)
        || input.expectedProjectionGeneration < 1
      )
    ) throw new RangeError("Record search projection removal generation is invalid");
    return this.#serializable(async (transaction) => {
      const rows = await transaction.query(
        `SELECT projection_generation
           FROM reflection_record_search_projections
          WHERE record_id = $1
          FOR UPDATE`,
        [input.recordRef],
      );
      if (rows.length > 1) throw new Error("Duplicate Record search projection");
      const row = rows[0];
      if (row === undefined) return "replayed";
      if (
        input.expectedProjectionGeneration !== undefined
        && rowInteger(row, "projection_generation")
          !== input.expectedProjectionGeneration
      ) return "stale";
      await executeTypedRecordProductQuery(transaction, recordProductTypedDb
        .delete(reflectionRecordSearchProjections)
        .where(eq(reflectionRecordSearchProjections.recordId, input.recordRef)));
      return "removed";
    });
  }

  async #serializable<Result>(
    callback: (transaction: RecordProductPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.handle.transaction(callback, {
          isolationLevel: "serializable",
        });
      } catch (error) {
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    }
    throw new Error("Unreachable Record search projection transaction state");
  }
}

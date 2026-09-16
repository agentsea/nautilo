import {
  RECORD_SEARCH_POLICY_V1,
  assertCanonicalRecordEmbeddingV1,
  assertRankedRecordCoordinate,
  canonicalizeCosineScore,
  type RankedRecordCoordinate,
  type RecordEmbeddingV1,
} from "@nautilo/reflection/search";
import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";

import type { RecordRepositorySelection } from "./contracts";
import {
  assertVerifiedRecordProductPostgresHandle,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface RecordSearchRankCursor {
  readonly score: number;
  readonly structuralHeight: number;
  readonly recordRef: string;
}

export type RecordSearchStoreResult =
  | {
      readonly status: "available";
      readonly coordinates: readonly RankedRecordCoordinate[];
      readonly corpusStateCoordinate: string;
      readonly hasMore: boolean;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "timeout" | "storage_unavailable";
    };

function canonicalHumanActorIds(
  audience: EffectiveAudienceAlternative,
): readonly string[] {
  if (audience.humanRefs.length < 1) {
    throw new TypeError("Record search invocation audience is empty");
  }
  if (
    audience.humanRefs.length > 256
    || audience.humanRefs.some((value) => !UUID.test(value))
    || audience.humanRefs.some((value, index) =>
      index > 0 && audience.humanRefs[index - 1]! >= value
    )
  ) throw new TypeError("Record search invocation audience is not canonical");
  if (typeof audience.includesPublicBoundary !== "boolean") {
    throw new TypeError("Record search invocation public boundary is invalid");
  }
  return Object.freeze([...audience.humanRefs]);
}

function uuidArrayLiteral(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function rowNumber(row: RecordProductPostgresRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Invalid Record search numeric row");
  }
  return value;
}

function rowInteger(row: RecordProductPostgresRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : rowNumber(row, field);
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("Invalid Record search generation row");
  }
  return value;
}

function rowString(row: RecordProductPostgresRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError("Invalid Record search row");
  return value;
}

function isStatementTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "57014";
}

function assertSelection(selection: RecordRepositorySelection): void {
  if (
    (selection.selectedRepresentation !== "ordinary"
      && selection.selectedRepresentation !== "protected")
    || !Number.isSafeInteger(selection.migrationGeneration)
    || selection.migrationGeneration < 1
  ) throw new TypeError("Record search repository selection is invalid");
}

function assertCursor(cursor: RecordSearchRankCursor | undefined): void {
  if (cursor === undefined) return;
  canonicalizeCosineScore(cursor.score);
  if (!Number.isSafeInteger(cursor.structuralHeight) || cursor.structuralHeight < 0) {
    throw new RangeError("Record search cursor height is invalid");
  }
  if (cursor.recordRef.length < 1 || cursor.recordRef.length > 128) {
    throw new TypeError("Record search cursor reference is invalid");
  }
}

/**
 * One snapshot-consistent product query. The first MATERIALIZED relation owns
 * all M258 lifecycle, block, projection, and access-Room eligibility. Only the
 * second relation can name the plaintext vector or cosine operator.
 */
export class PostgresAuthorityFilteredRecordSearchStore {
  constructor(private readonly handle: RecordProductPostgresHandle) {
    assertVerifiedRecordProductPostgresHandle(handle);
  }

  async search(input: Readonly<{
    embedding: RecordEmbeddingV1;
    invocationAudience: EffectiveAudienceAlternative;
    selection: RecordRepositorySelection;
    /** Body-free foreground selection prefers the current protected head and
     * falls back to ordinary metadata while forward repair is still needed. */
    preferProtectedHead?: boolean;
    limit: number;
    after?: RecordSearchRankCursor;
  }>): Promise<RecordSearchStoreResult> {
    assertCanonicalRecordEmbeddingV1(input.embedding);
    const humanActorIds = canonicalHumanActorIds(input.invocationAudience);
    assertSelection(input.selection);
    assertCursor(input.after);
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < RECORD_SEARCH_POLICY_V1.resultPageMinimum
      || input.limit > RECORD_SEARCH_POLICY_V1.resultPageMaximum
    ) throw new RangeError("Record search result limit is outside V1 policy");

    try {
      const rows = await this.handle.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY");
        // This authority-first query has a deliberately complex plan. Even for
        // the measured 498-projection corpus, PostgreSQL's estimate crossed
        // jit_above_cost and spent hundreds of milliseconds compiling a scan
        // that executed in tens of milliseconds. Keep the decision local to
        // this transaction; server-wide JIT remains intact.
        await transaction.query("SET LOCAL jit = off");
        await transaction.query(
          `SET LOCAL statement_timeout = '${RECORD_SEARCH_POLICY_V1.exactScanStatementTimeoutMilliseconds}ms'`,
        );
        return transaction.query(
          `WITH eligible_coordinates AS MATERIALIZED (
             SELECT record.record_id,
                    record.structural_height,
                    record.processing_generation,
                    authority.projection_generation AS authority_projection_generation,
                    representation_head.current_representation_generation
                      AS payload_representation_generation
               FROM reflection_records AS record
               JOIN reflection_record_authority_projections AS authority
                 ON authority.record_id = record.record_id
                AND authority.current = true
               JOIN LATERAL (
                 SELECT candidate_head.current_representation_generation
                   FROM reflection_record_payload_representation_heads
                        AS candidate_head
                  WHERE candidate_head.record_id = record.record_id
                    AND (
                      (
                        $13::boolean
                        AND candidate_head.representation
                          IN ('protected', 'ordinary')
                      )
                      OR (
                        NOT $13::boolean
                        AND candidate_head.representation = $8
                      )
                    )
                  ORDER BY CASE
                    WHEN $13::boolean
                      AND candidate_head.representation = 'protected' THEN 0
                    WHEN candidate_head.representation = $8 THEN 1
                    ELSE 2
                  END,
                  candidate_head.representation ASC
                  LIMIT 1
               ) AS representation_head ON true
               JOIN LATERAL (
                 SELECT count(*) BETWEEN 1 AND 256 AS alternative_count_valid,
                        bool_and(
                          mapped.mapping_count = 1
                          AND mapped.mapping_valid IS TRUE
                        ) AS mappings_complete,
                        bool_or(
                          mapped.mapping_count = 1
                          AND mapped.mapping_valid IS TRUE
                          AND mapped.audience_eligible IS TRUE
                          AND (
                            NOT $7::boolean
                            OR alternative.includes_public_boundary
                          )
                        ) AS invocation_eligible
                   FROM reflection_record_authority_alternatives AS alternative
                   JOIN LATERAL (
                     SELECT count(*) AS mapping_count,
                            bool_and(
                              access_room.kind = 'access'
                              AND cardinality(access_room.human_actor_ids)
                                  BETWEEN 1 AND 256
                              AND cardinality(access_room.human_actor_ids) = (
                                SELECT count(DISTINCT human_id)
                                  FROM unnest(access_room.human_actor_ids)
                                       AS human_id
                              )
                              AND access_room.human_actor_ids = ARRAY(
                                SELECT human_id
                                  FROM unnest(access_room.human_actor_ids)
                                       AS human_id
                                 ORDER BY human_id
                              )
                              AND cardinality(access_room.human_actor_ids) = (
                                SELECT count(*)
                                  FROM actors AS human_actor
                                 WHERE human_actor.id
                                   = ANY(access_room.human_actor_ids)
                                   AND human_actor.kind = 'user'
                              )
                            ) AS mapping_valid,
                            bool_or(
                              access_room.kind = 'access'
                              AND access_room.human_actor_ids @> $6::uuid[]
                            ) AS audience_eligible
                       FROM rooms AS access_room
                      WHERE access_room.namespace_id = alternative.access_namespace_id
                   ) AS mapped ON true
                  WHERE alternative.record_id = record.record_id
                    AND alternative.projection_generation
                      = authority.projection_generation
               ) AS eligible_authority
                 ON eligible_authority.alternative_count_valid
                AND eligible_authority.mappings_complete IS TRUE
                AND eligible_authority.invocation_eligible IS TRUE
              WHERE record.disposition = 'available'
                AND record.lifecycle <> 'sunset'
                AND authority.processing_state NOT IN ('unavailable', 'purged')
                AND NOT EXISTS (
                  SELECT 1
                    FROM reflection_record_authority_blocks AS direct_block
                   WHERE direct_block.record_id = record.record_id
                      OR (
                        direct_block.terminal_leaf_handle IS NOT NULL
                        AND EXISTS (
                          SELECT 1
                            FROM reflection_record_authority_closure AS closure
                           WHERE closure.record_id = record.record_id
                             AND closure.closure_generation = authority.projection_generation
                             AND closure.terminal_leaf_handle
                               = direct_block.terminal_leaf_handle
                        )
                      )
                )
           ), compatible_projections AS MATERIALIZED (
             SELECT eligible.record_id,
                    eligible.structural_height,
                    eligible.processing_generation,
                    eligible.authority_projection_generation,
                    eligible.payload_representation_generation,
                    search_projection.projection_generation,
                    (1 - (search_projection.embedding <=> $1::vector))::real AS score
               FROM eligible_coordinates AS eligible
               JOIN reflection_record_search_projections AS search_projection
                 ON search_projection.record_id = eligible.record_id
                AND search_projection.record_processing_generation
                  = eligible.processing_generation
              WHERE search_projection.projection_version = 1
                AND search_projection.embedding_provider = $2
                AND search_projection.embedding_canonical_model = $3
                AND search_projection.embedding_dimensions = $4
                AND search_projection.embedding_contract_version = $5
           ), corpus_state AS (
             SELECT count(*)::text AS corpus_count,
                    coalesce(bit_xor(hashtextextended(
                      record_id || ':' || processing_generation::text || ':'
                      || authority_projection_generation::text || ':'
                      || payload_representation_generation::text || ':'
                      || projection_generation::text, 0
                    )), 0)::text AS corpus_hash_one,
                    coalesce(bit_xor(hashtextextended(
                      record_id || ':' || processing_generation::text || ':'
                      || authority_projection_generation::text || ':'
                      || payload_representation_generation::text || ':'
                      || projection_generation::text, 911
                    )), 0)::text AS corpus_hash_two
               FROM compatible_projections
           )
           SELECT ranked.record_id, ranked.structural_height,
                  ranked.processing_generation,
                  ranked.authority_projection_generation,
                  ranked.payload_representation_generation,
                  ranked.projection_generation, ranked.score,
                  corpus_state.corpus_count, corpus_state.corpus_hash_one,
                  corpus_state.corpus_hash_two
             FROM corpus_state
             LEFT JOIN LATERAL (
               SELECT * FROM compatible_projections
                WHERE $10::real IS NULL
                   OR score < $10::real
               OR (
                 score = $10::real
                 AND structural_height < $11::integer
               )
               OR (
                 score = $10::real
                 AND structural_height = $11::integer
                 AND record_id > $12::text
               )
                ORDER BY score DESC, structural_height DESC, record_id ASC
                LIMIT $9
             ) AS ranked ON true
            ORDER BY ranked.score DESC, ranked.structural_height DESC,
                     ranked.record_id ASC`,
          [
            vectorLiteral(input.embedding.vector),
            input.embedding.provenance.provider,
            input.embedding.provenance.canonicalModel,
            input.embedding.provenance.dimensions,
            input.embedding.provenance.contractVersion,
            uuidArrayLiteral(humanActorIds),
            input.invocationAudience.includesPublicBoundary,
            input.selection.selectedRepresentation,
            input.limit + 1,
            input.after?.score ?? null,
            input.after?.structuralHeight ?? null,
            input.after?.recordRef ?? null,
            input.preferProtectedHead === true,
          ],
        );
      }, { isolationLevel: "serializable" });
      const corpus = rows[0];
      if (corpus === undefined) throw new Error("Record search corpus state is absent");
      const candidates = rows.filter((row) => typeof row["record_id"] === "string");
      const hasMore = candidates.length > input.limit;
      const coordinates = candidates.slice(0, input.limit).map((row): RankedRecordCoordinate => {
        const coordinate = Object.freeze({
          recordRef: rowString(row, "record_id"),
          score: canonicalizeCosineScore(rowNumber(row, "score")),
          structuralHeight: rowInteger(row, "structural_height"),
          recordProcessingGeneration: rowInteger(row, "processing_generation"),
          projectionGeneration: rowInteger(row, "projection_generation"),
          payloadRepresentationGeneration: rowInteger(
            row,
            "payload_representation_generation",
          ),
          authorityProjectionGeneration: rowInteger(
            row,
            "authority_projection_generation",
          ),
        });
        assertRankedRecordCoordinate(coordinate);
        return coordinate;
      });
      return Object.freeze({
        status: "available" as const,
        coordinates: Object.freeze(coordinates),
        corpusStateCoordinate: [
          rowString(corpus, "corpus_count"),
          rowString(corpus, "corpus_hash_one"),
          rowString(corpus, "corpus_hash_two"),
        ].join(":"),
        hasMore,
      });
    } catch (error) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: isStatementTimeout(error) ? "timeout" as const : "storage_unavailable" as const,
      });
    }
  }
}

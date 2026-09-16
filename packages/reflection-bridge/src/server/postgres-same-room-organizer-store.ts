import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";
import {
  CANDIDATE_POLICY_V1,
  DURABLE_SLEEP_WORK_INTENT_POLICY_V1,
  normalizeOrganizerCurrentParents,
} from "@nautilo/reflection";
import {
  RECORD_SEARCH_POLICY_V1,
  assertCanonicalRecordEmbeddingV1,
  assertRankedRecordCoordinate,
  canonicalizeCosineScore,
  type RankedRecordCoordinate,
  type RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import type { RecordRepositorySelection } from "./contracts";
import {protectedRecordCurrentHeadOriginJoinSql} from "./postgres-current-record-publication-binding";
import {
  assertVerifiedRecordProductPostgresHandle,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";

function publicationCohortJoin(selection: RecordRepositorySelection, representationParameter: 4 | 8, originBindingParameter: 5 | 9): string {
  if (selection.selectedRepresentation === "protected") return protectedRecordCurrentHeadOriginJoinSql({representationParameter, originBindingParameter});
  return `JOIN reflection_record_publications AS publication
                 ON publication.record_id = record.record_id
                AND publication.representation = $${representationParameter}
                AND publication.representation_generation
                  = representation_head.current_representation_generation
                AND publication.state = 'complete'
                AND publication.publication_binding_ref = $${originBindingParameter}`;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const SAME_ROOM_ORGANIZER_QUERY_POLICY_V1 = Object.freeze({
  version: "same-room-organizer-query-v1",
  measuredOverfetchOptions: Object.freeze([8, 16, 32] as const),
  selectedOverfetch: 16,
  overfetchMaximum: 32,
  directParentMaximum: 32,
  topologyWorkMaximum: RECORD_SEARCH_POLICY_V1.traversalWorkMaximum,
  statementTimeoutMilliseconds:
    RECORD_SEARCH_POLICY_V1.exactScanStatementTimeoutMilliseconds,
} as const);

export type SameRoomOrganizerQueryIntent = "attachment" | "promotion";

export interface SameRoomOrganizerTopology {
  readonly directParents: readonly RankedRecordCoordinate[];
  /**
   * A ranked candidate is suppressed when its effective Record closure
   * overlaps the changed Record or an earlier-ranked candidate.
   */
  readonly redundantRecordRefs: readonly string[];
  readonly traversalWork: number;
  readonly normalizedCoordinates: readonly RankedRecordCoordinate[];
  readonly normalizedRecordRefs: ReadonlyMap<string, string>;
  /**
   * Seeds whose unique current-parent path leaves this exact publication
   * binding. They are not corrupt and must be resolved by the authority-aware
   * partition instead of poisoning the whole same-binding candidate batch.
   */
  readonly authorityParentRecordRefs: readonly string[];
  readonly changedAlreadyParented: boolean;
}

export type SameRoomOrganizerStoreUnavailableReason =
  | "timeout"
  | "storage_unavailable"
  | "topology_capacity_exceeded";

export type SameRoomOrganizerRankResult =
  | {
      readonly status: "available";
      readonly coordinates: readonly RankedRecordCoordinate[];
      readonly rowsConsidered: number;
    }
  | {
      readonly status: "unavailable";
      readonly reason: SameRoomOrganizerStoreUnavailableReason;
    };

export type SameRoomOrganizerTopologyResult =
  | { readonly status: "available"; readonly topology: SameRoomOrganizerTopology }
  | {
      readonly status: "unavailable";
      readonly reason: SameRoomOrganizerStoreUnavailableReason;
    };

export type SameRoomOrganizerFenceResult =
  | { readonly status: "current" }
  | { readonly status: "stale" }
  | {
      readonly status: "unavailable";
      readonly reason: SameRoomOrganizerStoreUnavailableReason;
    };

function canonicalHumanActorIds(
  audience: EffectiveAudienceAlternative,
): readonly string[] {
  if (audience.humanRefs.length < 1) {
    throw new TypeError("Organizer invocation audience is empty");
  }
  if (
    audience.humanRefs.length > 256
    || audience.humanRefs.some((value) => !UUID.test(value))
    || audience.humanRefs.some((value, index) =>
      index > 0 && audience.humanRefs[index - 1]! >= value
    )
  ) throw new TypeError("Organizer invocation audience is not canonical");
  if (typeof audience.includesPublicBoundary !== "boolean") {
    throw new TypeError("Organizer invocation public boundary is invalid");
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
    throw new TypeError("Invalid Organizer numeric row");
  }
  return value;
}

function rowInteger(row: RecordProductPostgresRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : rowNumber(row, field);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid Organizer integer row");
  }
  return value;
}

function rowString(row: RecordProductPostgresRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError("Invalid Organizer row");
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
  ) throw new TypeError("Organizer repository selection is invalid");
}

function assertPortable(value: string, label: string): void {
  if (
    Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
}

function coordinate(row: RecordProductPostgresRow): RankedRecordCoordinate {
  const value = Object.freeze({
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
  assertRankedRecordCoordinate(value);
  return value;
}

function audienceEligibilitySql(parameterOffset: number): string {
  const audienceParameter = `$${parameterOffset}`;
  const publicParameter = `$${parameterOffset + 1}`;
  return `JOIN LATERAL (
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
                            NOT ${publicParameter}::boolean
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
                              AND access_room.human_actor_ids
                                  @> ${audienceParameter}::uuid[]
                            ) AS audience_eligible
                       FROM rooms AS access_room
                      WHERE access_room.namespace_id
                        = alternative.access_namespace_id
                   ) AS mapped ON true
                  WHERE alternative.record_id = record.record_id
                    AND alternative.projection_generation
                      = authority.projection_generation
               ) AS eligible_authority
                 ON eligible_authority.alternative_count_valid
                AND eligible_authority.mappings_complete IS TRUE
                AND eligible_authority.invocation_eligible IS TRUE`;
}

function eligibleWhereSql(): string {
  return `record.disposition = 'available'
                AND record.lifecycle = 'current'
                AND authority.processing_state = 'current'
                AND NOT EXISTS (
                  SELECT 1
                    FROM reflection_record_successors AS successor
                   WHERE successor.predecessor_record_id = record.record_id
                )
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
                             AND closure.closure_generation
                               = authority.projection_generation
                             AND closure.terminal_leaf_handle
                               = direct_block.terminal_leaf_handle
                        )
                      )
                )`;
}

/**
 * Exact-Room background candidate access. This is deliberately not the
 * continuation-bearing interactive Record search store.
 */
export class PostgresSameRoomOrganizerStore {
  constructor(private readonly handle: RecordProductPostgresHandle) {
    assertVerifiedRecordProductPostgresHandle(handle);
  }

  async rank(input: Readonly<{
    embedding: RecordEmbeddingV1;
    invocationAudience: EffectiveAudienceAlternative;
    selection: RecordRepositorySelection;
    publicationBindingRef: string;
    changedRecordRef: string;
    intent: SameRoomOrganizerQueryIntent;
    limit?: 8 | 16 | 32;
  }>): Promise<SameRoomOrganizerRankResult> {
    assertCanonicalRecordEmbeddingV1(input.embedding);
    const humanActorIds = canonicalHumanActorIds(input.invocationAudience);
    assertSelection(input.selection);
    assertPortable(input.publicationBindingRef, "Organizer publication binding");
    assertPortable(input.changedRecordRef, "Organizer changed Record");
    if (input.intent !== "attachment" && input.intent !== "promotion") {
      throw new TypeError("Organizer query intent is invalid");
    }
    const limit = input.limit ?? SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.selectedOverfetch;
    if (!SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.measuredOverfetchOptions.includes(limit)) {
      throw new RangeError("Organizer overfetch limit is outside V1 policy");
    }

    try {
      const rows = await this.handle.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY");
        await transaction.query("SET LOCAL jit = off");
        await transaction.query(
          `SET LOCAL statement_timeout = '${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.statementTimeoutMilliseconds}ms'`,
        );
        return transaction.query(
          `WITH eligible_exact_room AS MATERIALIZED (
             SELECT record.record_id,
                    record.structural_height,
                    record.processing_generation,
                    authority.projection_generation
                      AS authority_projection_generation,
                    representation_head.current_representation_generation
                      AS payload_representation_generation
               FROM reflection_records AS record
               JOIN reflection_record_authority_projections AS authority
                 ON authority.record_id = record.record_id
                AND authority.current = true
               JOIN reflection_record_payload_representation_heads
                    AS representation_head
                 ON representation_head.record_id = record.record_id
                AND representation_head.representation = $8
               ${publicationCohortJoin(input.selection, 8, 9)}
               ${audienceEligibilitySql(6)}
              WHERE ${eligibleWhereSql()}
                AND record.record_id <> $10
                AND (
                  NOT $11::boolean
                  OR (
                    record.structural_height > 0
                    AND record.created_at <= now()
                      - ($14::integer * interval '1 millisecond')
                  )
                )
           ), compatible_projections AS MATERIALIZED (
             SELECT eligible.record_id,
                    eligible.structural_height,
                    eligible.processing_generation,
                    eligible.authority_projection_generation,
                    eligible.payload_representation_generation,
                    search_projection.projection_generation,
                    (1 - (search_projection.embedding <=> $1::vector))::real
                      AS score
               FROM eligible_exact_room AS eligible
               JOIN reflection_record_search_projections AS search_projection
                 ON search_projection.record_id = eligible.record_id
                AND search_projection.record_processing_generation
                  = eligible.processing_generation
              WHERE search_projection.projection_version = 1
                AND search_projection.embedding_provider = $2
                AND search_projection.embedding_canonical_model = $3
                AND search_projection.embedding_dimensions = $4
                AND search_projection.embedding_contract_version = $5
           )
           SELECT record_id, structural_height, processing_generation,
                  authority_projection_generation,
                  payload_representation_generation, projection_generation,
                  score, count(*) OVER ()::integer AS rows_considered
             FROM compatible_projections
            WHERE score >= $12::real
            ORDER BY score DESC, structural_height DESC, record_id ASC
            LIMIT $13`,
          [
            vectorLiteral(input.embedding.vector),
            input.embedding.provenance.provider,
            input.embedding.provenance.canonicalModel,
            input.embedding.provenance.dimensions,
            input.embedding.provenance.contractVersion,
            uuidArrayLiteral(humanActorIds),
            input.invocationAudience.includesPublicBoundary,
            input.selection.selectedRepresentation,
            input.publicationBindingRef,
            input.changedRecordRef,
            input.intent === "promotion",
            CANDIDATE_POLICY_V1.semanticMinimumScore,
            limit,
            DURABLE_SLEEP_WORK_INTENT_POLICY_V1.promotionDelayMilliseconds,
          ],
        );
      }, { isolationLevel: "serializable" });
      return Object.freeze({
        status: "available" as const,
        coordinates: Object.freeze(rows.map(coordinate)),
        rowsConsidered: rows[0] === undefined
          ? 0
          : rowInteger(rows[0], "rows_considered"),
      });
    } catch (error) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: isStatementTimeout(error)
          ? "timeout" as const
          : "storage_unavailable" as const,
      });
    }
  }

  async topology(input: Readonly<{
    invocationAudience: EffectiveAudienceAlternative;
    selection: RecordRepositorySelection;
    publicationBindingRef: string;
    changedRecordRef: string;
    intent: SameRoomOrganizerQueryIntent;
    rankedCoordinates: readonly RankedRecordCoordinate[];
  }>): Promise<SameRoomOrganizerTopologyResult> {
    const humanActorIds = canonicalHumanActorIds(input.invocationAudience);
    assertSelection(input.selection);
    assertPortable(input.publicationBindingRef, "Organizer publication binding");
    assertPortable(input.changedRecordRef, "Organizer changed Record");
    if (
      input.rankedCoordinates.length
        > SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.overfetchMaximum
    ) throw new RangeError("Organizer topology input exceeds V1 policy");
    input.rankedCoordinates.forEach(assertRankedRecordCoordinate);

    try {
      const result = await this.handle.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY");
        await transaction.query(
          `SET LOCAL statement_timeout = '${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.statementTimeoutMilliseconds}ms'`,
        );
        const rows = await transaction.query(
          `WITH RECURSIVE candidate_input AS (
             SELECT candidate_id, ordinal::integer
               FROM unnest($1::text[]) WITH ORDINALITY
                    AS candidate(candidate_id, ordinal)
           ), direct_parents AS MATERIALIZED (
             SELECT record.record_id,
                    record.structural_height,
                    record.processing_generation,
                    authority.projection_generation
                      AS authority_projection_generation,
                    representation_head.current_representation_generation
                      AS payload_representation_generation,
                    search_projection.projection_generation,
                    0::real AS score
               FROM reflection_record_dependencies AS direct_dependency
               JOIN reflection_records AS record
                 ON record.record_id = direct_dependency.parent_record_id
               JOIN reflection_record_authority_projections AS authority
                 ON authority.record_id = record.record_id
                AND authority.current = true
               JOIN reflection_record_payload_representation_heads
                    AS representation_head
                 ON representation_head.record_id = record.record_id
                AND representation_head.representation = $4
               ${publicationCohortJoin(input.selection, 4, 5)}
               JOIN reflection_record_search_projections AS search_projection
                 ON search_projection.record_id = record.record_id
                AND search_projection.record_processing_generation
                  = record.processing_generation
               ${audienceEligibilitySql(2)}
              WHERE ${eligibleWhereSql()}
                AND direct_dependency.child_record_id = $6
              ORDER BY direct_dependency.parent_record_id ASC
              LIMIT ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.directParentMaximum + 1}
           ), graph_seed(root_record_id, node_record_id, path) AS (
             SELECT candidate_id, candidate_id, ARRAY[candidate_id]::text[]
               FROM candidate_input
             UNION ALL
             SELECT $6::text, $6::text, ARRAY[$6::text]::text[]
           ), graph_walk(root_record_id, node_record_id, path) AS (
             SELECT root_record_id, node_record_id, path
               FROM graph_seed
             UNION ALL
             SELECT walk.root_record_id,
                    dependency.child_record_id,
                    walk.path || dependency.child_record_id
               FROM graph_walk AS walk
               JOIN reflection_record_dependencies AS dependency
                 ON dependency.parent_record_id = walk.node_record_id
              WHERE cardinality(walk.path)
                      <= ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}
                AND NOT dependency.child_record_id = ANY(walk.path)
           -- LIMIT is deliberately inside the sole graph_walk consumer and
           -- has no ORDER/window above graph_walk. PostgreSQL can therefore
           -- stop recursive production at max + 1; that extra row is the
           -- fail-closed overflow proof consumed below.
           ), bounded_walk AS MATERIALIZED (
             SELECT root_record_id, node_record_id
               FROM graph_walk
              LIMIT ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1}
           ), topology_state AS (
             SELECT count(*)::integer AS traversal_work,
                    (SELECT count(*)::integer FROM direct_parents)
                      AS direct_parent_count,
                    (
                      count(*)
                        > ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}
                      OR (SELECT count(*) FROM direct_parents)
                        > ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.directParentMaximum}
                    ) AS overflowed
               FROM bounded_walk
           ), redundant AS (
             SELECT DISTINCT later.candidate_id AS record_id
               FROM candidate_input AS earlier
               JOIN candidate_input AS later
                 ON later.ordinal > earlier.ordinal
              WHERE EXISTS (
                      SELECT 1
                        FROM bounded_walk AS walk
                       WHERE walk.root_record_id = earlier.candidate_id
                         AND walk.node_record_id = later.candidate_id
                    )
                 OR EXISTS (
                      SELECT 1
                        FROM bounded_walk AS walk
                       WHERE walk.root_record_id = later.candidate_id
                         AND walk.node_record_id = earlier.candidate_id
                    )
                 OR EXISTS (
                      SELECT 1
                        FROM bounded_walk AS earlier_walk
                        JOIN bounded_walk AS later_walk
                          ON later_walk.node_record_id
                           = earlier_walk.node_record_id
                       WHERE $7::boolean
                         AND earlier_walk.root_record_id = earlier.candidate_id
                         AND later_walk.root_record_id = later.candidate_id
                         AND earlier_walk.node_record_id <> earlier.candidate_id
                         AND later_walk.node_record_id <> later.candidate_id
                    )
             UNION
             SELECT candidate.candidate_id
               FROM candidate_input AS candidate
              WHERE EXISTS (
                      SELECT 1
                        FROM bounded_walk AS candidate_walk
                       WHERE candidate_walk.root_record_id = candidate.candidate_id
                         AND candidate_walk.node_record_id = $6
                    )
                 OR EXISTS (
                      SELECT 1
                        FROM bounded_walk AS changed_walk
                       WHERE changed_walk.root_record_id = $6
                         AND changed_walk.node_record_id = candidate.candidate_id
                    )
                 OR EXISTS (
                      SELECT 1
                        FROM bounded_walk AS candidate_walk
                        JOIN bounded_walk AS changed_walk
                          ON changed_walk.node_record_id
                           = candidate_walk.node_record_id
                       WHERE $7::boolean
                         AND candidate_walk.root_record_id = candidate.candidate_id
                         AND changed_walk.root_record_id = $6
                         AND candidate_walk.node_record_id <> candidate.candidate_id
                         AND changed_walk.node_record_id <> $6
                    )
           )
           SELECT 'state'::text AS row_kind, NULL::text AS record_id,
                  NULL::integer AS structural_height,
                  NULL::integer AS processing_generation,
                  NULL::integer AS authority_projection_generation,
                  NULL::integer AS payload_representation_generation,
                  NULL::integer AS projection_generation, NULL::real AS score,
                  state.traversal_work, state.direct_parent_count,
                  state.overflowed
             FROM topology_state AS state
           UNION ALL
           SELECT 'parent', parent.record_id, parent.structural_height,
                  parent.processing_generation,
                  parent.authority_projection_generation,
                  parent.payload_representation_generation,
                  parent.projection_generation, parent.score,
                  NULL::integer, NULL::integer, NULL::boolean
             FROM direct_parents AS parent
           UNION ALL
           SELECT 'redundant', redundant.record_id, NULL, NULL, NULL, NULL,
                  NULL, NULL, NULL, NULL, NULL
             FROM redundant
            ORDER BY row_kind, record_id NULLS FIRST`,
          [
            input.rankedCoordinates.map((entry) => entry.recordRef),
            uuidArrayLiteral(humanActorIds),
            input.invocationAudience.includesPublicBoundary,
            input.selection.selectedRepresentation,
            input.publicationBindingRef,
            input.changedRecordRef,
            input.intent === "promotion",
          ],
        );
        const seedRecordRefs = [
          input.changedRecordRef,
          ...input.rankedCoordinates.map((entry) => entry.recordRef),
        ];
        const parentRows = await transaction.query(
          `WITH RECURSIVE parent_walk(
             root_record_id, child_record_id, parent_record_id, path,
             depth, cycle, structural_height, processing_generation,
             authority_projection_generation,
             payload_representation_generation, projection_generation,
             current_parent_count
           ) AS (
             SELECT seed.record_id, NULL::text, seed.record_id,
                    ARRAY[seed.record_id]::text[], 0, false,
                    NULL::integer, NULL::integer, NULL::integer,
                    NULL::integer, NULL::integer,
                    (
                      SELECT count(*)::integer
                        FROM reflection_record_dependencies AS direct_edge
                        JOIN reflection_records AS current_parent
                          ON current_parent.record_id = direct_edge.parent_record_id
                       WHERE direct_edge.child_record_id = seed.record_id
                         AND current_parent.lifecycle = 'current'
                         AND current_parent.disposition = 'available'
                    )
               FROM unnest($1::text[]) AS seed(record_id)
             UNION ALL
             SELECT walk.root_record_id, walk.parent_record_id,
                    record.record_id, walk.path || record.record_id,
                    walk.depth + 1, record.record_id = ANY(walk.path),
                    record.structural_height, record.processing_generation,
                    authority.projection_generation,
                    representation_head.current_representation_generation,
                    search_projection.projection_generation,
                    (
                      SELECT count(*)::integer
                        FROM reflection_record_dependencies AS direct_edge
                        JOIN reflection_records AS current_parent
                          ON current_parent.record_id = direct_edge.parent_record_id
                       WHERE direct_edge.child_record_id = record.record_id
                         AND current_parent.lifecycle = 'current'
                         AND current_parent.disposition = 'available'
                    )
               FROM parent_walk AS walk
               JOIN reflection_record_dependencies AS dependency
                 ON dependency.child_record_id = walk.parent_record_id
               JOIN reflection_records AS record
                 ON record.record_id = dependency.parent_record_id
               JOIN reflection_record_authority_projections AS authority
                 ON authority.record_id = record.record_id
                AND authority.current = true
               JOIN reflection_record_payload_representation_heads
                    AS representation_head
                 ON representation_head.record_id = record.record_id
                AND representation_head.representation = $4
               ${publicationCohortJoin(input.selection, 4, 5)}
               JOIN reflection_record_search_projections AS search_projection
                 ON search_projection.record_id = record.record_id
                AND search_projection.record_processing_generation
                  = record.processing_generation
               ${audienceEligibilitySql(2)}
              WHERE ${eligibleWhereSql()}
                AND NOT walk.cycle
                AND cardinality(walk.path)
                      <= ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}
           ), bounded_parent_walk AS MATERIALIZED (
             SELECT * FROM parent_walk
              LIMIT ${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1}
           )
           SELECT * FROM bounded_parent_walk
            ORDER BY root_record_id, depth, parent_record_id`,
          [
            seedRecordRefs,
            uuidArrayLiteral(humanActorIds),
            input.invocationAudience.includesPublicBoundary,
            input.selection.selectedRepresentation,
            input.publicationBindingRef,
          ],
        );
        return { rows, parentRows, seedRecordRefs };
      }, { isolationLevel: "serializable" });
      const { rows, parentRows, seedRecordRefs } = result;
      const state = rows.find((row) => row["row_kind"] === "state");
      if (state === undefined) throw new Error("Organizer topology state is absent");
      if (state["overflowed"] === true) {
        return { status: "unavailable", reason: "topology_capacity_exceeded" };
      }
      if (
        parentRows.length > SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum
        || parentRows.some((row) => row["cycle"] === true)
      ) return { status: "unavailable", reason: "topology_capacity_exceeded" };
      const qualifiedParentCounts = new Map<string, number>();
      for (const row of parentRows) {
        const child = row["child_record_id"];
        if (typeof child !== "string") continue;
        const key = `${rowString(row, "root_record_id")}\u0000${child}`;
        qualifiedParentCounts.set(key, (qualifiedParentCounts.get(key) ?? 0) + 1);
      }
      const authorityParentRecordRefs = new Set<string>();
      for (const row of parentRows) {
        const currentParentCount = rowInteger(row, "current_parent_count");
        const qualifiedParentCount = qualifiedParentCounts.get(
          `${rowString(row, "root_record_id")}\u0000${rowString(row, "parent_record_id")}`,
        ) ?? 0;
        // More than one current parent is real graph corruption. A single
        // parent omitted by this exact-binding query is the normal shape of a
        // cross-binding parent and is delegated per root below.
        if (currentParentCount > 1 || qualifiedParentCount > currentParentCount) {
          return { status: "unavailable", reason: "topology_capacity_exceeded" };
        }
        if (currentParentCount === 1 && qualifiedParentCount === 0) {
          authorityParentRecordRefs.add(rowString(row, "root_record_id"));
        }
      }
      const parentEdges = parentRows.flatMap((row) => {
        if (authorityParentRecordRefs.has(rowString(row, "root_record_id"))) return [];
        const child = row["child_record_id"];
        return typeof child === "string"
          ? [{ childRecordRef: child, parentRecordRef: rowString(row, "parent_record_id") }]
          : [];
      });
      const normalizationSeeds = seedRecordRefs.filter(
        (recordRef) => !authorityParentRecordRefs.has(recordRef),
      );
      const normalized = normalizeOrganizerCurrentParents({
        seedRecordRefs: normalizationSeeds,
        currentParentEdges: parentEdges,
        maxTraversalWork: SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum,
      });
      if (normalized.status !== "complete") {
        return { status: "unavailable", reason: "topology_capacity_exceeded" };
      }
      const normalizedCoordinates = parentRows.flatMap((row) =>
        row["child_record_id"] === null
          || authorityParentRecordRefs.has(rowString(row, "root_record_id"))
          ? []
          : [coordinate({
              ...row,
              record_id: rowString(row, "parent_record_id"),
              score: 0,
            })]
      ).filter((entry, index, all) =>
        all.findIndex((candidate) => candidate.recordRef === entry.recordRef) === index
      );
      const directParents = rows
        .filter((row) => row["row_kind"] === "parent")
        .map(coordinate);
      const redundantRecordRefs = rows
        .filter((row) => row["row_kind"] === "redundant")
        .map((row) => rowString(row, "record_id"));
      const normalizedRecordRefs = new Map(
        seedRecordRefs.map((recordRef) => [recordRef, recordRef] as const),
      );
      for (const [recordRef, representativeRef] of normalized.representatives) {
        normalizedRecordRefs.set(recordRef, representativeRef);
      }
      return Object.freeze({
        status: "available" as const,
        topology: Object.freeze({
          directParents: Object.freeze(directParents),
          redundantRecordRefs: Object.freeze(redundantRecordRefs),
          traversalWork: rowInteger(state, "traversal_work")
            + normalized.traversalWork,
          normalizedCoordinates: Object.freeze(normalizedCoordinates),
          normalizedRecordRefs,
          authorityParentRecordRefs: Object.freeze(
            seedRecordRefs.filter((recordRef) => authorityParentRecordRefs.has(recordRef)),
          ),
          changedAlreadyParented:
            authorityParentRecordRefs.has(input.changedRecordRef)
            || normalized.representatives.get(input.changedRecordRef)
              !== input.changedRecordRef,
        }),
      });
    } catch (error) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: isStatementTimeout(error)
          ? "timeout" as const
          : "storage_unavailable" as const,
      });
    }
  }

  async fence(input: Readonly<{
    invocationAudience: EffectiveAudienceAlternative;
    selection: RecordRepositorySelection;
    publicationBindingRef: string;
    coordinates: readonly RankedRecordCoordinate[];
  }>): Promise<SameRoomOrganizerFenceResult> {
    const humanActorIds = canonicalHumanActorIds(input.invocationAudience);
    assertSelection(input.selection);
    assertPortable(input.publicationBindingRef, "Organizer publication binding");
    if (input.coordinates.length > 8) {
      throw new RangeError("Organizer final fence exceeds selected-input policy");
    }
    input.coordinates.forEach(assertRankedRecordCoordinate);
    if (input.coordinates.length === 0) return { status: "current" };

    try {
      const rows = await this.handle.transaction(async (transaction) => {
        await transaction.query("SET TRANSACTION READ ONLY");
        await transaction.query(
          `SET LOCAL statement_timeout = '${SAME_ROOM_ORGANIZER_QUERY_POLICY_V1.statementTimeoutMilliseconds}ms'`,
        );
        return transaction.query(
          `WITH requested AS (
             SELECT *
               FROM unnest(
                 $1::text[], $2::integer[], $3::integer[], $4::integer[],
                 $5::integer[]
               ) AS coordinate(
                 record_id, processing_generation,
                 authority_projection_generation,
                 payload_representation_generation, projection_generation
               )
           ), eligible_exact_room AS MATERIALIZED (
             SELECT record.record_id,
                    record.processing_generation,
                    authority.projection_generation
                      AS authority_projection_generation,
                    representation_head.current_representation_generation
                      AS payload_representation_generation,
                    search_projection.projection_generation
               FROM requested
               JOIN reflection_records AS record
                 ON record.record_id = requested.record_id
               JOIN reflection_record_authority_projections AS authority
                 ON authority.record_id = record.record_id
                AND authority.current = true
               JOIN reflection_record_payload_representation_heads
                    AS representation_head
                 ON representation_head.record_id = record.record_id
                AND representation_head.representation = $8
               ${publicationCohortJoin(input.selection, 8, 9)}
               JOIN reflection_record_search_projections AS search_projection
                 ON search_projection.record_id = record.record_id
                AND search_projection.record_processing_generation
                  = record.processing_generation
               ${audienceEligibilitySql(6)}
              WHERE ${eligibleWhereSql()}
                AND record.processing_generation
                  = requested.processing_generation
                AND authority.projection_generation
                  = requested.authority_projection_generation
                AND representation_head.current_representation_generation
                  = requested.payload_representation_generation
                AND search_projection.projection_generation
                  = requested.projection_generation
           )
           SELECT count(*)::integer AS matched_count
             FROM eligible_exact_room`,
          [
            input.coordinates.map((entry) => entry.recordRef),
            input.coordinates.map((entry) => entry.recordProcessingGeneration),
            input.coordinates.map((entry) => entry.authorityProjectionGeneration),
            input.coordinates.map((entry) => entry.payloadRepresentationGeneration),
            input.coordinates.map((entry) => entry.projectionGeneration),
            uuidArrayLiteral(humanActorIds),
            input.invocationAudience.includesPublicBoundary,
            input.selection.selectedRepresentation,
            input.publicationBindingRef,
          ],
        );
      }, { isolationLevel: "serializable" });
      const matched = rows[0] === undefined ? -1 : rowInteger(rows[0], "matched_count");
      return matched === input.coordinates.length
        ? { status: "current" }
        : { status: "stale" };
    } catch (error) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: isStatementTimeout(error)
          ? "timeout" as const
          : "storage_unavailable" as const,
      });
    }
  }
}

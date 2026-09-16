import type { EffectiveAudienceAlternative } from "@nautilo/reflection/authority";
import {
  CANDIDATE_POLICY_V1,
  normalizeOrganizerCurrentParents,
} from "@nautilo/reflection";
import {
  RECORD_SEARCH_POLICY_V1,
  assertCanonicalRecordEmbeddingV1,
  canonicalizeCosineScore,
  type RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import type { RecordRepositorySelection } from "./contracts";
import { protectedRecordCurrentHeadOriginJoinSql } from "./postgres-current-record-publication-binding";
import {
  assertVerifiedRecordProductPostgresHandle,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
  type RecordProductPostgresScalar,
} from "./product-postgres";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MEMORY_LOGICAL_REF =
  /^memory:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/u;

/**
 * The overfetch values are the already measured same-Room values. M284 keeps
 * the cross-Room bound at two and deliberately does not introduce another
 * tuning axis before Wave 11's populated-instance latency work.
 */
export const CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1 = Object.freeze({
  version: "cross-room-organizer-query-v1",
  crossRoomBound: CANDIDATE_POLICY_V1.crossRoomBound,
  measuredOverfetchOptions: Object.freeze([8, 16, 32] as const),
  selectedOverfetch: 16,
  overfetchMaximum: 32,
  authorityAttachmentMaximum: 256,
  authorityParentSeedMaximum: CANDIDATE_POLICY_V1.sameRoomBound * 2,
  topologyWorkMaximum: RECORD_SEARCH_POLICY_V1.traversalWorkMaximum,
  statementTimeoutMilliseconds:
    RECORD_SEARCH_POLICY_V1.exactScanStatementTimeoutMilliseconds,
} as const);

export type CrossRoomOrganizerOverfetch =
  (typeof CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.measuredOverfetchOptions)[number];

interface CrossRoomCandidateBase {
  readonly score: number;
  readonly audience: EffectiveAudienceAlternative;
  /** Namespace through which the selected ordinary payload is opened. */
  readonly readNamespaceRef: string;
  readonly readBindingRef: string;
}

export interface CrossRoomRecordCandidate extends CrossRoomCandidateBase {
  readonly kind: "record";
  readonly recordRef: string;
  readonly structuralHeight: number;
  readonly recordProcessingGeneration: number;
  readonly searchProjectionGeneration: number;
  readonly payloadRepresentationGeneration: number;
  readonly authorityProjectionGeneration: number;
  /** The sole current authority alternative, distinct from the read binding. */
  readonly authorityAccessNamespaceRef: string;
}

export type CrossRoomChangedRecordCoordinate = Readonly<Omit<
  CrossRoomRecordCandidate,
  "score"
>>;

export interface CrossRoomMemoryCandidate extends CrossRoomCandidateBase {
  readonly kind: "memory";
  readonly memoryRef: string;
  readonly logicalSourceRef: `memory:${string}`;
  readonly contentRevision: number;
  readonly embeddingRevision: number;
  readonly embeddingProvenance: RecordEmbeddingV1["provenance"];
  readonly updatedAtCoordinate: string;
  /** Canonical complete attachment set, including a coherent scope origin. */
  readonly authorityNamespaceRefs: readonly string[];
  /** Exact current protected mapping; absent for ordinary discovery. */
  readonly protectedCryptoObjectId?: string;
  readonly protectedCryptoAccessRevision?: number;
}

export type CrossRoomOrganizerCandidate =
  | CrossRoomRecordCandidate
  | CrossRoomMemoryCandidate;

export interface CrossRoomAuthorityParentSeed {
  readonly recordRef: string;
  readonly score: number;
}

export type CrossRoomOrganizerStoreUnavailableReason =
  | "timeout"
  | "storage_unavailable"
  | "changed_input_stale"
  | "topology_capacity_exceeded";

export type CrossRoomOrganizerDiscoveryResult =
  | {
      readonly status: "available";
      readonly changed: CrossRoomChangedRecordCoordinate;
      readonly candidates: readonly CrossRoomOrganizerCandidate[];
      readonly metrics: Readonly<{
        readonly recordRowsConsidered: number;
        readonly memoryRowsConsidered: number;
        readonly rowsSelected: number;
        readonly unsupportedAuthorityShapes: number;
        readonly authorityParentsResolved: number;
        readonly authorityParentsSkipped: number;
        readonly topologyWork: number;
      }>;
    }
  | {
      readonly status: "unavailable";
      readonly reason: CrossRoomOrganizerStoreUnavailableReason;
    };

export type CrossRoomOrganizerFenceResult =
  | { readonly status: "current" }
  | { readonly status: "stale" }
  | {
      readonly status: "unavailable";
      readonly reason: Exclude<
        CrossRoomOrganizerStoreUnavailableReason,
        "topology_capacity_exceeded" | "changed_input_stale"
      >;
    };

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateIdentity(candidate: CrossRoomOrganizerCandidate): string {
  return candidate.kind === "record"
    ? `record\0${candidate.recordRef}`
    : `memory\0${candidate.memoryRef}`;
}

function compareCandidates(
  left: CrossRoomOrganizerCandidate,
  right: CrossRoomOrganizerCandidate,
): number {
  return right.score - left.score
    || (right.kind === "record" ? right.structuralHeight : 0)
      - (left.kind === "record" ? left.structuralHeight : 0)
    || compareStrings(candidateIdentity(left), candidateIdentity(right));
}

function canonicalHumanActorIds(
  audience: EffectiveAudienceAlternative,
): readonly string[] {
  if (
    audience.humanRefs.length < 1
    || audience.humanRefs.length > 256
    || audience.humanRefs.some((value) => !UUID.test(value))
    || audience.humanRefs.some((value, index) =>
      index > 0 && audience.humanRefs[index - 1]! >= value
    )
    || typeof audience.includesPublicBoundary !== "boolean"
  ) throw new TypeError("cross-Room invocation audience is not canonical");
  return Object.freeze([...audience.humanRefs]);
}

function assertSelection(selection: RecordRepositorySelection): void {
  if (
    (selection.selectedRepresentation !== "ordinary"
      && selection.selectedRepresentation !== "protected")
    || !Number.isSafeInteger(selection.migrationGeneration)
    || selection.migrationGeneration < 1
  ) throw new TypeError("cross-Room repository selection is invalid");
}

function assertPortable(value: string, label: string): void {
  if (
    Buffer.byteLength(value, "utf8") < 1
    || Buffer.byteLength(value, "utf8") > 128
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(value)
  ) throw new TypeError(`${label} is invalid`);
}

function uuidArrayLiteral(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}

function booleanArrayLiteral(values: readonly boolean[]): string {
  return `{${values.map(String).join(",")}}`;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.join(",")}]`;
}

function rowNumber(row: RecordProductPostgresRow, field: string): number {
  const raw = row[field];
  const value = typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("Invalid cross-Room numeric row");
  }
  return value;
}

function rowInteger(
  row: RecordProductPostgresRow,
  field: string,
  minimum = 0,
): number {
  const raw = row[field];
  const value = typeof raw === "bigint" ? Number(raw) : rowNumber(row, field);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError("Invalid cross-Room integer row");
  }
  return value;
}

function rowString(row: RecordProductPostgresRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new TypeError("Invalid cross-Room row");
  return value;
}

function rowBoolean(row: RecordProductPostgresRow, field: string): boolean {
  const value = row[field];
  if (typeof value !== "boolean") throw new TypeError("Invalid cross-Room row");
  return value;
}

function parseUuidArray(value: unknown, label: string): readonly string[] {
  const parsed: readonly unknown[] | null = typeof value === "string"
    ? value === "{}"
      ? []
      : value.slice(1, -1).split(",")
    : Array.isArray(value)
      ? value
      : null;
  if (
    parsed === null
    || parsed.some((entry) => typeof entry !== "string" || !UUID.test(entry))
  ) throw new TypeError(`${label} is invalid`);
  const strings = parsed.map((entry) => String(entry));
  if (strings.some((entry, index) => index > 0 && strings[index - 1]! >= entry)) {
    throw new TypeError(`${label} is invalid`);
  }
  return Object.freeze(strings);
}

function parseAudience(row: RecordProductPostgresRow): EffectiveAudienceAlternative {
  const humanRefs = parseUuidArray(row["human_actor_ids"], "cross-Room audience");
  if (humanRefs.length < 1) throw new TypeError("cross-Room audience is empty");
  return Object.freeze({
    humanRefs,
    includesPublicBoundary: rowBoolean(row, "includes_public_boundary"),
  });
}

function parseReadNamespace(bindingRef: string): string {
  const parts = bindingRef.split(":");
  const namespaceRef = parts.length === 5 && parts[0] === "journal"
    && parts[1] === "namespace"
    ? parts[2]
    : undefined;
  if (namespaceRef === undefined || !UUID.test(namespaceRef)) {
    throw new TypeError("cross-Room publication binding is invalid");
  }
  return namespaceRef;
}

function recordCandidate(row: RecordProductPostgresRow): CrossRoomRecordCandidate {
  const readBindingRef = rowString(row, "publication_binding_ref");
  const authorityAccessNamespaceRef = rowString(
    row,
    "access_namespace_id",
  );
  if (!UUID.test(authorityAccessNamespaceRef)) {
    throw new TypeError("cross-Room Record authority Namespace is invalid");
  }
  return Object.freeze({
    kind: "record" as const,
    recordRef: rowString(row, "record_id"),
    score: canonicalizeCosineScore(rowNumber(row, "score")),
    structuralHeight: rowInteger(row, "structural_height"),
    recordProcessingGeneration: rowInteger(row, "processing_generation", 1),
    searchProjectionGeneration: rowInteger(row, "projection_generation", 1),
    payloadRepresentationGeneration: rowInteger(
      row,
      "payload_representation_generation",
      1,
    ),
    authorityProjectionGeneration: rowInteger(
      row,
      "authority_projection_generation",
      1,
    ),
    audience: parseAudience(row),
    authorityAccessNamespaceRef,
    readNamespaceRef: parseReadNamespace(readBindingRef),
    readBindingRef,
  });
}

function changedRecordCoordinate(
  row: RecordProductPostgresRow,
): CrossRoomChangedRecordCoordinate {
  const candidate = recordCandidate({ ...row, score: 1 });
  const { score: _score, ...coordinate } = candidate;
  return Object.freeze(coordinate);
}

function memoryCandidate(
  row: RecordProductPostgresRow,
  selection: RecordRepositorySelection,
): CrossRoomMemoryCandidate {
  const memoryRef = rowString(row, "memory_id");
  const readNamespaceRef = rowString(row, "read_namespace_id");
  if (!UUID.test(memoryRef) || !UUID.test(readNamespaceRef)) {
    throw new TypeError("cross-Room Memory coordinate is invalid");
  }
  const updatedAtCoordinate = rowString(row, "updated_at_coordinate");
  if (!Number.isFinite(new Date(updatedAtCoordinate).getTime())) {
    throw new TypeError("cross-Room Memory update coordinate is invalid");
  }
  const dimensions = rowInteger(row, "embedding_dimensions", 1);
  const contractVersion = rowInteger(row, "embedding_contract_version", 1);
  if (dimensions !== 1_536 || contractVersion !== 1) {
    throw new TypeError("cross-Room Memory embedding provenance is invalid");
  }
  const protectedCoordinates = selection.selectedRepresentation === "protected"
    ? {
        protectedCryptoObjectId: rowString(row, "crypto_object_id"),
        protectedCryptoAccessRevision: rowInteger(
          row,
          "crypto_access_revision",
        ),
      }
    : {};
  if (
    protectedCoordinates.protectedCryptoObjectId !== undefined
    && !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(
      protectedCoordinates.protectedCryptoObjectId,
    )
  ) throw new TypeError("cross-Room Memory crypto object is invalid");
  return Object.freeze({
    kind: "memory" as const,
    memoryRef,
    logicalSourceRef: `memory:${memoryRef}` as const,
    score: canonicalizeCosineScore(rowNumber(row, "score")),
    contentRevision: rowInteger(row, "content_revision"),
    embeddingRevision: rowInteger(row, "embedding_revision"),
    embeddingProvenance: Object.freeze({
      provider: rowString(row, "embedding_provider"),
      canonicalModel: rowString(row, "embedding_model"),
      dimensions,
      contractVersion,
    }),
    updatedAtCoordinate,
    audience: parseAudience(row),
    authorityNamespaceRefs: parseUuidArray(
      row["authority_namespace_ids"],
      "cross-Room Memory attachment coordinate",
    ),
    readNamespaceRef,
    readBindingRef:
      `journal:namespace:${readNamespaceRef}:${selection.selectedRepresentation}:v${selection.migrationGeneration}`,
    ...protectedCoordinates,
  });
}

function assertRecordCoordinate(
  coordinate: CrossRoomRecordCandidate | CrossRoomChangedRecordCoordinate,
): void {
  assertPortable(coordinate.recordRef, "cross-Room Record coordinate");
  for (const generation of [
    coordinate.recordProcessingGeneration,
    coordinate.searchProjectionGeneration,
    coordinate.payloadRepresentationGeneration,
    coordinate.authorityProjectionGeneration,
  ]) {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new TypeError("cross-Room Record generation is invalid");
    }
  }
  canonicalHumanActorIds(coordinate.audience);
  if (!UUID.test(coordinate.authorityAccessNamespaceRef)) {
    throw new TypeError("cross-Room Record authority Namespace is invalid");
  }
  if (parseReadNamespace(coordinate.readBindingRef) !== coordinate.readNamespaceRef) {
    throw new TypeError("cross-Room Record read coordinate is invalid");
  }
}

function assertMemoryCoordinate(
  coordinate: CrossRoomMemoryCandidate,
  selection: RecordRepositorySelection,
): void {
  canonicalizeCosineScore(coordinate.score);
  canonicalHumanActorIds(coordinate.audience);
  const match = MEMORY_LOGICAL_REF.exec(coordinate.logicalSourceRef);
  if (
    !UUID.test(coordinate.memoryRef)
    || match?.[1] !== coordinate.memoryRef
    || !Number.isSafeInteger(coordinate.contentRevision)
    || coordinate.contentRevision < 0
    || coordinate.embeddingRevision !== coordinate.contentRevision
    || !Number.isFinite(new Date(coordinate.updatedAtCoordinate).getTime())
    || coordinate.authorityNamespaceRefs.length < 1
    || coordinate.authorityNamespaceRefs.length
      > CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.authorityAttachmentMaximum
  ) throw new TypeError("cross-Room Memory coordinate is invalid");
  parseUuidArray(
    coordinate.authorityNamespaceRefs,
    "cross-Room Memory attachment coordinate",
  );
  if (!coordinate.authorityNamespaceRefs.includes(coordinate.readNamespaceRef)) {
    throw new TypeError("cross-Room Memory read Namespace is invalid");
  }
  assertPortable(
    coordinate.embeddingProvenance.provider,
    "cross-Room Memory embedding provider",
  );
  assertPortable(
    coordinate.embeddingProvenance.canonicalModel,
    "cross-Room Memory embedding model",
  );
  if (
    coordinate.embeddingProvenance.dimensions !== 1_536
    || coordinate.embeddingProvenance.contractVersion !== 1
    || coordinate.readBindingRef
      !== `journal:namespace:${coordinate.readNamespaceRef}:${selection.selectedRepresentation}:v${selection.migrationGeneration}`
  ) throw new TypeError("cross-Room Memory provenance or binding is invalid");
  if (selection.selectedRepresentation === "protected") {
    if (
      coordinate.protectedCryptoObjectId === undefined
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u.test(
        coordinate.protectedCryptoObjectId,
      )
      || !Number.isSafeInteger(coordinate.protectedCryptoAccessRevision)
      || coordinate.protectedCryptoAccessRevision! < 0
      || coordinate.contentRevision < 1
    ) throw new TypeError("cross-Room Memory protected coordinate is invalid");
  } else if (
    coordinate.protectedCryptoObjectId !== undefined
    || coordinate.protectedCryptoAccessRevision !== undefined
  ) {
    throw new TypeError("ordinary cross-Room Memory has protected coordinates");
  }
}

function isStatementTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && error.code === "57014";
}

const VALID_HUMAN_ARRAY_SQL = `cardinality(candidate_room.human_actor_ids)
                                  BETWEEN 1 AND 256
                                AND cardinality(candidate_room.human_actor_ids) = (
                                  SELECT count(DISTINCT human_id)
                                    FROM unnest(candidate_room.human_actor_ids)
                                         AS human_id
                                )
                                AND candidate_room.human_actor_ids = ARRAY(
                                  SELECT human_id
                                    FROM unnest(candidate_room.human_actor_ids)
                                         AS human_id
                                   ORDER BY human_id
                                )
                                AND cardinality(candidate_room.human_actor_ids) = (
                                  SELECT count(*)
                                    FROM actors AS human_actor
                                   WHERE human_actor.id
                                     = ANY(candidate_room.human_actor_ids)
                                     AND human_actor.kind = 'user'
                                )`;

const ORDINARY_SELECTION: RecordRepositorySelection = Object.freeze({
  selectedRepresentation: "ordinary",
  migrationGeneration: 1,
});

function publicationCohortJoin(
  selection: RecordRepositorySelection,
  input: Readonly<{
    representationParameter: 8 | 9 | 10;
    originBindingParameter?: 8;
    originBindingExpression?: "requested.binding_ref";
    representationHeadAlias: "head" | "representation_head";
  }>,
): string {
  if (selection.selectedRepresentation === "protected") {
    return protectedRecordCurrentHeadOriginJoinSql(input);
  }
  const bindingPredicate = input.originBindingExpression !== undefined
    ? `\n               AND publication.publication_binding_ref = ${input.originBindingExpression}`
    : input.originBindingParameter === undefined
      ? ""
      : `\n               AND publication.publication_binding_ref = $${input.originBindingParameter}`;
  return `JOIN reflection_record_publications AS publication
                ON publication.record_id = record.record_id
               AND publication.representation = $${input.representationParameter}
               AND publication.representation_generation
                 = ${input.representationHeadAlias}.current_representation_generation
               AND publication.state = 'complete'${bindingPredicate}`;
}

function recordRankSql(
  selection: RecordRepositorySelection = ORDINARY_SELECTION,
): string {
  return `WITH authority_first AS MATERIALIZED (
            SELECT record.record_id, record.structural_height,
                   record.processing_generation,
                   authority.projection_generation
                     AS authority_projection_generation,
                   representation_head.current_representation_generation
                     AS payload_representation_generation,
                   publication.publication_binding_ref,
                   single_authority.access_namespace_id,
                   single_authority.human_actor_ids,
                   single_authority.includes_public_boundary
              FROM reflection_records AS record
              JOIN reflection_record_authority_projections AS authority
                ON authority.record_id = record.record_id
               AND authority.current = true
              JOIN reflection_record_payload_representation_heads
                   AS representation_head
                ON representation_head.record_id = record.record_id
               AND representation_head.representation = $8
              ${publicationCohortJoin(selection, {
                representationParameter: 8,
                representationHeadAlias: "representation_head",
              })}
              JOIN LATERAL (
                SELECT alternative.access_namespace_id::text,
                       candidate_room.human_actor_ids,
                       alternative.includes_public_boundary
                  FROM reflection_record_authority_alternatives AS alternative
                  JOIN rooms AS candidate_room
                    ON candidate_room.namespace_id
                     = alternative.access_namespace_id
                   AND candidate_room.kind = 'access'
                 WHERE alternative.record_id = record.record_id
                   AND alternative.projection_generation
                     = authority.projection_generation
                   AND ${VALID_HUMAN_ARRAY_SQL}
                   AND candidate_room.human_actor_ids && $6::uuid[]
                   AND (
                     NOT $7::boolean
                     OR alternative.includes_public_boundary
                   )
                   AND (
                     SELECT count(*)
                       FROM rooms AS exact_access_room
                      WHERE exact_access_room.namespace_id
                        = alternative.access_namespace_id
                        AND exact_access_room.kind = 'access'
                   ) = 1
                   AND (
                     SELECT count(*)
                       FROM reflection_record_authority_alternatives AS exact_alt
                      WHERE exact_alt.record_id = record.record_id
                        AND exact_alt.projection_generation
                          = authority.projection_generation
                   ) = 1
              ) AS single_authority ON true
             WHERE record.disposition = 'available'
               AND record.lifecycle = 'current'
               AND authority.processing_state = 'current'
               AND record.record_id <> $9
               AND publication.publication_binding_ref <> $10
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
               )
          ), provenance_first AS MATERIALIZED (
            SELECT eligible.*, projection.projection_generation,
                   projection.embedding
              FROM authority_first AS eligible
              JOIN reflection_record_search_projections AS projection
                ON projection.record_id = eligible.record_id
               AND projection.record_processing_generation
                 = eligible.processing_generation
             WHERE projection.projection_version = 1
               AND projection.embedding_provider = $2
               AND projection.embedding_canonical_model = $3
               AND projection.embedding_dimensions = $4
               AND projection.embedding_contract_version = $5
          ), ranked AS MATERIALIZED (
            SELECT provenance_first.*,
                   (1 - (embedding <=> $1::vector))::real AS score
              FROM provenance_first
          )
          SELECT record_id, structural_height, processing_generation,
                 authority_projection_generation,
                 payload_representation_generation, projection_generation,
                 publication_binding_ref, access_namespace_id,
                 human_actor_ids, includes_public_boundary, score,
                 count(*) OVER ()::integer AS rows_considered
            FROM ranked
           WHERE score >= $11::real
           ORDER BY score DESC, structural_height DESC, record_id ASC
           LIMIT $12`;
}

function changedCoordinateSql(
  selection: RecordRepositorySelection = ORDINARY_SELECTION,
): string {
  const validAccessAudience = VALID_HUMAN_ARRAY_SQL.replaceAll(
    "candidate_room",
    "access_room",
  );
  return `WITH authority_first AS MATERIALIZED (
            SELECT record.record_id, record.structural_height,
                   record.processing_generation,
                   authority.projection_generation
                     AS authority_projection_generation,
                   head.current_representation_generation
                     AS payload_representation_generation,
                   publication.publication_binding_ref,
                   alternative.access_namespace_id::text,
                   access_room.human_actor_ids,
                   alternative.includes_public_boundary
              FROM reflection_records AS record
              JOIN reflection_record_authority_projections AS authority
                ON authority.record_id = record.record_id
               AND authority.current = true
               AND authority.processing_state = 'current'
              JOIN reflection_record_payload_representation_heads AS head
                ON head.record_id = record.record_id
               AND head.representation = $9
              ${publicationCohortJoin(selection, {
                representationParameter: 9,
                originBindingParameter: 8,
                representationHeadAlias: "head",
              })}
              JOIN reflection_record_authority_alternatives AS alternative
                ON alternative.record_id = record.record_id
               AND alternative.projection_generation
                 = authority.projection_generation
              JOIN rooms AS access_room
                ON access_room.namespace_id = alternative.access_namespace_id
               AND access_room.kind = 'access'
             WHERE record.record_id = $7
               AND record.disposition = 'available'
               AND record.lifecycle = 'current'
               AND ${validAccessAudience}
               AND access_room.human_actor_ids = $5::uuid[]
               AND alternative.includes_public_boundary = $6::boolean
               AND NOT EXISTS (
                 SELECT 1
                   FROM reflection_record_authority_alternatives AS extra
                  WHERE extra.record_id = record.record_id
                    AND extra.projection_generation
                      = authority.projection_generation
                    AND extra.alternative_ordinal
                      <> alternative.alternative_ordinal
               )
               AND NOT EXISTS (
                 SELECT 1 FROM reflection_record_successors AS successor
                  WHERE successor.predecessor_record_id = record.record_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM reflection_record_authority_blocks AS block
                  WHERE block.record_id = record.record_id
                     OR (
                       block.terminal_leaf_handle IS NOT NULL
                       AND EXISTS (
                         SELECT 1
                           FROM reflection_record_authority_closure AS closure
                          WHERE closure.record_id = record.record_id
                            AND closure.closure_generation
                              = authority.projection_generation
                            AND closure.terminal_leaf_handle
                              = block.terminal_leaf_handle
                       )
                     )
               )
               AND (
                 SELECT count(*) FROM rooms AS exact_access_room
                  WHERE exact_access_room.namespace_id
                    = alternative.access_namespace_id
                    AND exact_access_room.kind = 'access'
               ) = 1
          ), provenance_first AS MATERIALIZED (
            SELECT eligible.*, projection.projection_generation
              FROM authority_first AS eligible
              JOIN reflection_record_search_projections AS projection
                ON projection.record_id = eligible.record_id
               AND projection.record_processing_generation
                 = eligible.processing_generation
             WHERE projection.projection_version = 1
               AND projection.embedding_provider = $1
               AND projection.embedding_canonical_model = $2
               AND projection.embedding_dimensions = $3
               AND projection.embedding_contract_version = $4
          )
          SELECT * FROM provenance_first LIMIT 2`;
}

/**
 * Memory authority is the disjunction of every canonical attachment path.
 * The SQL normalizes duplicate Namespace paths, rejects incomplete mappings,
 * and dominance-prunes alternatives before admitting only one maximal result.
 * It never names `memories.content`.
 */
function memoryRankSql(
  selection: RecordRepositorySelection = ORDINARY_SELECTION,
): string {
  const protectedMappingProjection = selection.selectedRepresentation === "protected"
    ? ", memory.crypto_object_id, memory.crypto_access_revision,\n                   memory.crypto_required_namespace_fingerprint"
    : "";
  const protectedMappingPredicate = selection.selectedRepresentation === "protected"
    ? `
               AND memory.crypto_mapping_state = 'verified'
               AND memory.crypto_object_id IS NOT NULL
               AND memory.crypto_required_namespace_fingerprint IS NOT NULL
               AND EXISTS (
                 SELECT 1 FROM memory_crypto_revisions AS crypto_revision
                  WHERE crypto_revision.memory_id = memory.id
                    AND crypto_revision.content_revision = memory.content_revision
                    AND crypto_revision.crypto_object_id = memory.crypto_object_id
                    AND crypto_revision.required_namespace_fingerprint
                      = memory.crypto_required_namespace_fingerprint
                    AND crypto_revision.completion = 'complete'
                    AND crypto_revision.disposition = 'mapped'
               )`
    : "";
  const protectedAuthorityProjection = selection.selectedRepresentation === "protected"
    ? ", memory.crypto_object_id, memory.crypto_access_revision"
    : "";
  const protectedResultProjection = selection.selectedRepresentation === "protected"
    ? ", crypto_object_id, crypto_access_revision"
    : "";
  return `WITH memory_base AS MATERIALIZED (
            SELECT memory.id AS memory_id, memory.content_revision,
                   memory.embedding_revision, memory.embedding_provider,
                   memory.embedding_model, memory.embedding_dimensions,
                   memory.embedding_contract_version, memory.updated_at,
                   memory.scope_origin_namespace_id, memory.embedding${protectedMappingProjection}
              FROM memories AS memory
             WHERE memory.tier <= 2
               AND memory.embedding IS NOT NULL
               AND memory.embedding_revision = memory.content_revision
               AND memory.embedding_provider = $2
               AND memory.embedding_model = $3
               AND memory.embedding_dimensions = $4
               AND memory.embedding_contract_version = $5${protectedMappingPredicate}
          ), scope_state AS MATERIALIZED (
            SELECT memory.memory_id,
                   count(*) FILTER (WHERE scope.origin = 'scope')::integer
                     AS scope_origin_count,
                   memory.scope_origin_namespace_id
              FROM memory_base AS memory
              LEFT JOIN memory_scopes AS scope
                ON scope.memory_id = memory.memory_id
             GROUP BY memory.memory_id, memory.scope_origin_namespace_id
          ), required_namespace AS MATERIALIZED (
            SELECT edge.memory_id, edge.namespace_id
              FROM memory_namespaces AS edge
              JOIN memory_base AS memory ON memory.memory_id = edge.memory_id
            UNION
            SELECT state.memory_id, state.scope_origin_namespace_id
              FROM scope_state AS state
             WHERE state.scope_origin_count = 1
               AND state.scope_origin_namespace_id IS NOT NULL
          ), bounded_attachment_state AS MATERIALIZED (
            SELECT memory.memory_id,
                   count(required.namespace_id)::integer AS attachment_count,
                   array_agg(required.namespace_id ORDER BY required.namespace_id)
                     FILTER (WHERE required.namespace_id IS NOT NULL)
                     AS authority_namespace_ids
              FROM memory_base AS memory
              LEFT JOIN required_namespace AS required
                ON required.memory_id = memory.memory_id
             GROUP BY memory.memory_id
            HAVING count(required.namespace_id) BETWEEN 1 AND ${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.authorityAttachmentMaximum}
          ), namespace_audience AS MATERIALIZED (
            SELECT required.memory_id, required.namespace_id,
                   candidate_room.human_actor_ids,
                   EXISTS (
                     SELECT 1 FROM rooms AS public_room
                      WHERE public_room.namespace_id = required.namespace_id
                        AND public_room.kind = 'open'
                   ) AS includes_public_boundary
              FROM required_namespace AS required
              JOIN LATERAL (
                SELECT room.human_actor_ids
                  FROM rooms AS room
                 WHERE room.namespace_id = required.namespace_id
                   AND room.kind <> 'task'
                   AND cardinality(room.human_actor_ids) BETWEEN 1 AND 256
                 ORDER BY room.id
                 LIMIT 1
              ) AS candidate_room ON true
             WHERE ${VALID_HUMAN_ARRAY_SQL}
               AND NOT EXISTS (
                 SELECT 1 FROM rooms AS inconsistent_room
                  WHERE inconsistent_room.namespace_id = required.namespace_id
                    AND inconsistent_room.kind <> 'task'
                    AND inconsistent_room.human_actor_ids
                      <> candidate_room.human_actor_ids
               )
          ), complete_memory AS MATERIALIZED (
            SELECT memory.*, attachments.authority_namespace_ids
              FROM memory_base AS memory
              JOIN bounded_attachment_state AS attachments
                ON attachments.memory_id = memory.memory_id
              JOIN scope_state AS scope ON scope.memory_id = memory.memory_id
             WHERE (
               (scope.scope_origin_count = 0
                 AND scope.scope_origin_namespace_id IS NULL)
               OR (scope.scope_origin_count = 1
                 AND scope.scope_origin_namespace_id IS NOT NULL)
             )
               AND NOT ($6::uuid = ANY(attachments.authority_namespace_ids))
               AND attachments.attachment_count = (
                 SELECT count(*) FROM namespace_audience AS mapped
                  WHERE mapped.memory_id = memory.memory_id
               )
          ), normalized_alternative AS MATERIALIZED (
            SELECT DISTINCT memory_id, human_actor_ids,
                   includes_public_boundary
              FROM namespace_audience
          ), maximal_alternative AS MATERIALIZED (
            SELECT candidate.memory_id, candidate.human_actor_ids,
                   candidate.includes_public_boundary
              FROM normalized_alternative AS candidate
             WHERE NOT EXISTS (
               SELECT 1
                 FROM normalized_alternative AS wider
                WHERE wider.memory_id = candidate.memory_id
                  AND candidate.human_actor_ids <@ wider.human_actor_ids
                  AND (
                    NOT candidate.includes_public_boundary
                    OR wider.includes_public_boundary
                  )
                  AND (
                    candidate.human_actor_ids <> wider.human_actor_ids
                    OR candidate.includes_public_boundary
                      <> wider.includes_public_boundary
                  )
             )
          ), authority_first AS MATERIALIZED (
            SELECT memory.memory_id, memory.content_revision,
                   memory.embedding_revision, memory.embedding_provider,
                   memory.embedding_model, memory.embedding_dimensions,
                   memory.embedding_contract_version,
                   to_char(memory.updated_at AT TIME ZONE 'UTC',
                     'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_coordinate,
                   memory.authority_namespace_ids,
                   alternative.human_actor_ids,
                   alternative.includes_public_boundary,
                   (
                     SELECT mapped.namespace_id::text
                       FROM namespace_audience AS mapped
                      WHERE mapped.memory_id = memory.memory_id
                        AND mapped.human_actor_ids = alternative.human_actor_ids
                        AND mapped.includes_public_boundary
                          = alternative.includes_public_boundary
                      ORDER BY mapped.namespace_id
                      LIMIT 1
                   ) AS read_namespace_id,
                   memory.embedding${protectedAuthorityProjection}
              FROM complete_memory AS memory
              JOIN maximal_alternative AS alternative
                ON alternative.memory_id = memory.memory_id
             WHERE (
               SELECT count(*) FROM maximal_alternative AS counted
                WHERE counted.memory_id = memory.memory_id
             ) = 1
               AND alternative.human_actor_ids && $7::uuid[]
               AND (NOT $8::boolean OR alternative.includes_public_boundary)
          ), ranked AS MATERIALIZED (
            SELECT authority_first.*,
                   (1 - (embedding <=> $1::vector))::real AS score
              FROM authority_first
          )
          SELECT memory_id, content_revision, embedding_revision,
                 embedding_provider, embedding_model, embedding_dimensions,
                 embedding_contract_version,
                 updated_at_coordinate, authority_namespace_ids,
                 human_actor_ids, includes_public_boundary,
                 read_namespace_id, score${protectedResultProjection},
                 count(*) OVER ()::integer AS rows_considered,
                 (
                   SELECT count(*)::integer
                     FROM complete_memory AS candidate
                    WHERE (
                      SELECT count(*) FROM maximal_alternative AS counted
                       WHERE counted.memory_id = candidate.memory_id
                    ) <> 1
                 ) AS unsupported_authority_shapes
            FROM ranked
           WHERE score >= $9::real
           ORDER BY score DESC, memory_id ASC
           LIMIT $10`;
}

function topologySql(recordCount: number): string {
  if (recordCount === 0) {
    return "SELECT 0::integer AS traversal_work, false AS overflowed, NULL::text AS redundant_record_id";
  }
  return `WITH RECURSIVE candidate_input AS (
            SELECT candidate_id, ordinal::integer
              FROM unnest($1::text[]) WITH ORDINALITY
                   AS candidate(candidate_id, ordinal)
          ), graph_seed(root_record_id, node_record_id, path) AS (
            SELECT candidate_id, candidate_id, ARRAY[candidate_id]::text[]
              FROM candidate_input
            UNION ALL
            SELECT $2::text, $2::text, ARRAY[$2::text]::text[]
          ), graph_walk(root_record_id, node_record_id, path) AS (
            SELECT root_record_id, node_record_id, path FROM graph_seed
            UNION ALL
            SELECT walk.root_record_id, dependency.child_record_id,
                   walk.path || dependency.child_record_id
              FROM graph_walk AS walk
              JOIN reflection_record_dependencies AS dependency
                ON dependency.parent_record_id = walk.node_record_id
             WHERE cardinality(walk.path)
                     <= ${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}
               AND NOT dependency.child_record_id = ANY(walk.path)
          ), bounded_walk AS MATERIALIZED (
            SELECT root_record_id, node_record_id FROM graph_walk
             LIMIT ${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1}
          ), state AS (
            SELECT count(*)::integer AS traversal_work,
                   count(*) > ${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}
                     AS overflowed
              FROM bounded_walk
          ), redundant AS (
            SELECT DISTINCT later.candidate_id AS record_id
              FROM candidate_input AS earlier
              JOIN candidate_input AS later ON later.ordinal > earlier.ordinal
             WHERE EXISTS (
               SELECT 1 FROM bounded_walk AS earlier_walk
                WHERE earlier_walk.root_record_id = earlier.candidate_id
                  AND earlier_walk.node_record_id = later.candidate_id
             ) OR EXISTS (
               SELECT 1 FROM bounded_walk AS later_walk
                WHERE later_walk.root_record_id = later.candidate_id
                  AND later_walk.node_record_id = earlier.candidate_id
             ) OR EXISTS (
               SELECT 1
                 FROM bounded_walk AS earlier_walk
                 JOIN bounded_walk AS later_walk
                   ON later_walk.node_record_id = earlier_walk.node_record_id
                WHERE earlier_walk.root_record_id = earlier.candidate_id
                  AND later_walk.root_record_id = later.candidate_id
                  AND earlier_walk.node_record_id <> earlier.candidate_id
                  AND later_walk.node_record_id <> later.candidate_id
             )
            UNION
            SELECT candidate.candidate_id
              FROM candidate_input AS candidate
             WHERE EXISTS (
               SELECT 1 FROM bounded_walk AS candidate_walk
                WHERE candidate_walk.root_record_id = candidate.candidate_id
                  AND candidate_walk.node_record_id = $2
             ) OR EXISTS (
               SELECT 1 FROM bounded_walk AS changed_walk
                WHERE changed_walk.root_record_id = $2
                  AND changed_walk.node_record_id = candidate.candidate_id
             ) OR EXISTS (
               SELECT 1
                 FROM bounded_walk AS candidate_walk
                 JOIN bounded_walk AS changed_walk
                   ON changed_walk.node_record_id = candidate_walk.node_record_id
                WHERE candidate_walk.root_record_id = candidate.candidate_id
                  AND changed_walk.root_record_id = $2
                  AND candidate_walk.node_record_id <> candidate.candidate_id
                  AND changed_walk.node_record_id <> $2
             )
          )
          SELECT state.traversal_work, state.overflowed,
                 redundant.record_id AS redundant_record_id
            FROM state LEFT JOIN redundant ON true
           ORDER BY redundant.record_id`;
}

function currentParentPathsSql(
  selection: RecordRepositorySelection = ORDINARY_SELECTION,
): string {
  return `WITH RECURSIVE parent_walk(
            root_record_id, child_record_id, parent_record_id, path, depth,
            cycle, seed_score, structural_height, processing_generation,
            authority_projection_generation,
            payload_representation_generation, projection_generation,
            publication_binding_ref, access_namespace_id, human_actor_ids,
            includes_public_boundary, current_parent_count
          ) AS (
            SELECT seed.record_id, NULL::text, seed.record_id,
                   ARRAY[seed.record_id]::text[], 0, false, seed.score,
                   NULL::integer, NULL::integer, NULL::integer,
                   NULL::integer, NULL::integer, NULL::text, NULL::text,
                   NULL::uuid[], NULL::boolean,
                   (
                     SELECT count(*)::integer
                       FROM reflection_record_dependencies AS direct_edge
                       JOIN reflection_records AS current_parent
                         ON current_parent.record_id = direct_edge.parent_record_id
                      WHERE direct_edge.child_record_id = seed.record_id
                        AND current_parent.lifecycle = 'current'
                        AND current_parent.disposition = 'available'
                   )
              FROM unnest($1::text[], $2::real[])
                   AS seed(record_id, score)
            UNION ALL
            SELECT walk.root_record_id, walk.parent_record_id,
                   record.record_id, walk.path || record.record_id,
                   walk.depth + 1, record.record_id = ANY(walk.path),
                   walk.seed_score, record.structural_height,
                   record.processing_generation,
                   authority.projection_generation,
                   head.current_representation_generation,
                   projection.projection_generation,
                   publication.publication_binding_ref,
                   single_authority.access_namespace_id,
                   single_authority.human_actor_ids,
                   single_authority.includes_public_boundary,
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
               AND authority.processing_state = 'current'
              JOIN reflection_record_payload_representation_heads AS head
                ON head.record_id = record.record_id
               AND head.representation = $9
              ${publicationCohortJoin(selection, {
                representationParameter: 9,
                representationHeadAlias: "head",
              })}
              JOIN reflection_record_search_projections AS projection
                ON projection.record_id = record.record_id
               AND projection.record_processing_generation
                 = record.processing_generation
               AND projection.projection_version = 1
               AND projection.embedding_provider = $3
               AND projection.embedding_canonical_model = $4
               AND projection.embedding_dimensions = $5
               AND projection.embedding_contract_version = $6
              JOIN LATERAL (
                SELECT alternative.access_namespace_id::text,
                       candidate_room.human_actor_ids,
                       alternative.includes_public_boundary
                  FROM reflection_record_authority_alternatives AS alternative
                  JOIN rooms AS candidate_room
                    ON candidate_room.namespace_id
                     = alternative.access_namespace_id
                   AND candidate_room.kind = 'access'
                 WHERE alternative.record_id = record.record_id
                   AND alternative.projection_generation
                     = authority.projection_generation
                   AND ${VALID_HUMAN_ARRAY_SQL}
                   AND candidate_room.human_actor_ids && $7::uuid[]
                   AND (NOT $8::boolean OR alternative.includes_public_boundary)
                   AND (
                     SELECT count(*)
                       FROM reflection_record_authority_alternatives AS exact_alt
                      WHERE exact_alt.record_id = record.record_id
                        AND exact_alt.projection_generation
                          = authority.projection_generation
                   ) = 1
                   AND (
                     SELECT count(*) FROM rooms AS exact_access_room
                      WHERE exact_access_room.namespace_id
                        = alternative.access_namespace_id
                        AND exact_access_room.kind = 'access'
                   ) = 1
              ) AS single_authority ON true
             WHERE record.disposition = 'available'
               AND record.lifecycle = 'current'
               AND NOT walk.cycle
               AND cardinality(walk.path)
                     <= ${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum}
               AND NOT EXISTS (
                 SELECT 1 FROM reflection_record_successors AS successor
                  WHERE successor.predecessor_record_id = record.record_id
               )
               AND NOT EXISTS (
                 SELECT 1 FROM reflection_record_authority_blocks AS block
                  WHERE block.record_id = record.record_id
               )
          ), bounded_parent_walk AS MATERIALIZED (
            SELECT * FROM parent_walk
             LIMIT ${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum + 1}
          )
          SELECT root_record_id, child_record_id, parent_record_id, depth,
                 cycle, seed_score AS score, structural_height,
                 processing_generation, authority_projection_generation,
                 payload_representation_generation, projection_generation,
                 publication_binding_ref, access_namespace_id,
                 human_actor_ids, includes_public_boundary,
                 current_parent_count
            FROM bounded_parent_walk`;
}

function recordFenceSql(
  selection: RecordRepositorySelection = ORDINARY_SELECTION,
): string {
  return `WITH requested AS (
            SELECT coordinate.record_id, coordinate.processing_generation,
                   coordinate.authority_generation,
                   coordinate.representation_generation,
                   coordinate.search_generation, coordinate.binding_ref,
                   coordinate.access_namespace_id,
                   ARRAY(
                     SELECT jsonb_array_elements_text(
                       ($8::text)::jsonb
                         -> (coordinate.ordinality - 1)::integer
                     )
                   )::uuid[] AS human_actor_ids,
                   ($9::boolean[])[coordinate.ordinality]
                     AS includes_public_boundary
              FROM unnest(
                $1::text[], $2::integer[], $3::integer[], $4::integer[],
                $5::integer[], $6::text[], $7::uuid[]
              ) WITH ORDINALITY AS coordinate(
              record_id, processing_generation, authority_generation,
              representation_generation, search_generation, binding_ref,
              access_namespace_id, ordinality
            )
          )
          SELECT count(*)::integer AS matched_count
            FROM requested
            JOIN reflection_records AS record
              ON record.record_id = requested.record_id
             AND record.processing_generation
               = requested.processing_generation
             AND record.disposition = 'available'
             AND record.lifecycle = 'current'
            JOIN reflection_record_authority_projections AS authority
              ON authority.record_id = record.record_id
             AND authority.current = true
             AND authority.processing_state = 'current'
             AND authority.projection_generation
               = requested.authority_generation
            JOIN reflection_record_payload_representation_heads AS head
              ON head.record_id = record.record_id
             AND head.representation = $10
             AND head.current_representation_generation
               = requested.representation_generation
            ${publicationCohortJoin(selection, {
              representationParameter: 10,
              originBindingExpression: "requested.binding_ref",
              representationHeadAlias: "head",
            })}
            JOIN reflection_record_search_projections AS projection
              ON projection.record_id = record.record_id
             AND projection.record_processing_generation
               = requested.processing_generation
             AND projection.projection_generation = requested.search_generation
            JOIN reflection_record_authority_alternatives AS alternative
              ON alternative.record_id = record.record_id
             AND alternative.projection_generation
               = requested.authority_generation
             AND alternative.access_namespace_id
               = requested.access_namespace_id
             AND alternative.includes_public_boundary
               = requested.includes_public_boundary
            JOIN rooms AS access_room
              ON access_room.namespace_id = alternative.access_namespace_id
             AND access_room.kind = 'access'
             AND access_room.human_actor_ids = requested.human_actor_ids
           WHERE NOT EXISTS (
             SELECT 1 FROM reflection_record_authority_alternatives AS extra
              WHERE extra.record_id = record.record_id
                AND extra.projection_generation = requested.authority_generation
                AND extra.alternative_ordinal <> alternative.alternative_ordinal
           )
             AND NOT EXISTS (
               SELECT 1 FROM reflection_record_successors AS successor
                WHERE successor.predecessor_record_id = record.record_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM reflection_record_authority_blocks AS block
                WHERE block.record_id = record.record_id
                   OR (
                     block.terminal_leaf_handle IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM reflection_record_authority_closure AS closure
                        WHERE closure.record_id = record.record_id
                          AND closure.closure_generation
                            = authority.projection_generation
                          AND closure.terminal_leaf_handle
                            = block.terminal_leaf_handle
                     )
                   )
             )
             AND ${VALID_HUMAN_ARRAY_SQL.replaceAll("candidate_room", "access_room")}
             AND (
               SELECT count(*) FROM rooms AS exact_access_room
                WHERE exact_access_room.namespace_id
                  = alternative.access_namespace_id
                  AND exact_access_room.kind = 'access'
             ) = 1`;
}

function memoryFenceSql(
  selection: RecordRepositorySelection = ORDINARY_SELECTION,
): string {
  const protectedRequestedProjection = selection.selectedRepresentation === "protected"
    ? `,
                   coordinate.protected_crypto_object_id,
                   coordinate.protected_crypto_access_revision`
    : "";
  const protectedUnnestArguments = selection.selectedRepresentation === "protected"
    ? `,
                $13::text[], $14::integer[]`
    : "";
  const protectedCoordinateNames = selection.selectedRepresentation === "protected"
    ? `,
              protected_crypto_object_id, protected_crypto_access_revision`
    : "";
  const protectedMappingFence = selection.selectedRepresentation === "protected"
    ? `
             AND memory.crypto_object_id = requested.protected_crypto_object_id
             AND memory.crypto_access_revision
               = requested.protected_crypto_access_revision
             AND memory.crypto_mapping_state = 'verified'
             AND memory.crypto_required_namespace_fingerprint IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM memory_crypto_revisions AS crypto_revision
                WHERE crypto_revision.memory_id = memory.id
                  AND crypto_revision.content_revision = memory.content_revision
                  AND crypto_revision.crypto_object_id = memory.crypto_object_id
                  AND crypto_revision.required_namespace_fingerprint
                    = memory.crypto_required_namespace_fingerprint
                  AND crypto_revision.completion = 'complete'
                  AND crypto_revision.disposition = 'mapped'
             )`
    : "";
  return `WITH requested AS (
            SELECT coordinate.memory_id, coordinate.content_revision,
                   coordinate.embedding_revision,
                   coordinate.embedding_provider,
                   coordinate.embedding_model,
                   coordinate.embedding_dimensions,
                   coordinate.embedding_contract_version,
                   coordinate.updated_at_coordinate,
                   ARRAY(
                     SELECT jsonb_array_elements_text(
                       ($5::text)::jsonb
                         -> (coordinate.ordinality - 1)::integer
                     )
                   )::uuid[] AS authority_namespace_ids,
                   coordinate.read_namespace_id,
                   ARRAY(
                     SELECT jsonb_array_elements_text(
                       ($7::text)::jsonb
                         -> (coordinate.ordinality - 1)::integer
                     )
                   )::uuid[] AS human_actor_ids,
                   ($8::boolean[])[coordinate.ordinality]
                     AS includes_public_boundary${protectedRequestedProjection}
              FROM unnest(
                $1::uuid[], $2::integer[], $3::integer[], $4::text[],
                $6::uuid[], $9::text[], $10::text[], $11::integer[],
                $12::integer[]${protectedUnnestArguments}
              ) WITH ORDINALITY AS coordinate(
              memory_id, content_revision, embedding_revision,
              updated_at_coordinate, read_namespace_id, embedding_provider,
              embedding_model, embedding_dimensions,
              embedding_contract_version${protectedCoordinateNames}, ordinality
            )
          ), current_required AS (
            SELECT requested.memory_id, edge.namespace_id
              FROM requested
              JOIN memory_namespaces AS edge
                ON edge.memory_id = requested.memory_id
            UNION
            SELECT requested.memory_id, memory.scope_origin_namespace_id
              FROM requested
              JOIN memories AS memory ON memory.id = requested.memory_id
             WHERE memory.scope_origin_namespace_id IS NOT NULL
               AND (
                 SELECT count(*) FROM memory_scopes AS scope
                  WHERE scope.memory_id = memory.id AND scope.origin = 'scope'
               ) = 1
          ), namespace_audience AS (
            SELECT required.memory_id, required.namespace_id,
                   candidate_room.human_actor_ids,
                   EXISTS (
                     SELECT 1 FROM rooms AS public_room
                      WHERE public_room.namespace_id = required.namespace_id
                        AND public_room.kind = 'open'
                   ) AS includes_public_boundary
              FROM current_required AS required
              JOIN LATERAL (
                SELECT room.human_actor_ids
                  FROM rooms AS room
                 WHERE room.namespace_id = required.namespace_id
                   AND room.kind <> 'task'
                   AND cardinality(room.human_actor_ids) BETWEEN 1 AND 256
                 ORDER BY room.id
                 LIMIT 1
              ) AS candidate_room ON true
             WHERE ${VALID_HUMAN_ARRAY_SQL}
               AND NOT EXISTS (
                 SELECT 1 FROM rooms AS inconsistent_room
                  WHERE inconsistent_room.namespace_id = required.namespace_id
                    AND inconsistent_room.kind <> 'task'
                    AND inconsistent_room.human_actor_ids
                      <> candidate_room.human_actor_ids
               )
          ), normalized_alternative AS (
            SELECT DISTINCT memory_id, human_actor_ids,
                   includes_public_boundary
              FROM namespace_audience
          ), maximal_alternative AS (
            SELECT candidate.memory_id, candidate.human_actor_ids,
                   candidate.includes_public_boundary
              FROM normalized_alternative AS candidate
             WHERE NOT EXISTS (
               SELECT 1 FROM normalized_alternative AS wider
                WHERE wider.memory_id = candidate.memory_id
                  AND candidate.human_actor_ids <@ wider.human_actor_ids
                  AND (
                    NOT candidate.includes_public_boundary
                    OR wider.includes_public_boundary
                  )
                  AND (
                    candidate.human_actor_ids <> wider.human_actor_ids
                    OR candidate.includes_public_boundary
                      <> wider.includes_public_boundary
                  )
             )
          ), attachment_state AS (
            SELECT requested.memory_id,
                   array_agg(required.namespace_id ORDER BY required.namespace_id)
                     AS authority_namespace_ids,
                   count(*)::integer AS attachment_count
              FROM requested
              JOIN current_required AS required
                ON required.memory_id = requested.memory_id
             GROUP BY requested.memory_id
          )
          SELECT count(*)::integer AS matched_count
            FROM requested
            JOIN memories AS memory
              ON memory.id = requested.memory_id
             AND memory.tier <= 2
             AND memory.content_revision = requested.content_revision
             AND memory.embedding_revision = requested.embedding_revision
             AND memory.embedding_provider = requested.embedding_provider
             AND memory.embedding_model = requested.embedding_model
             AND memory.embedding_dimensions = requested.embedding_dimensions
             AND memory.embedding_contract_version
               = requested.embedding_contract_version
             ${protectedMappingFence}
             AND to_char(memory.updated_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               = requested.updated_at_coordinate
             AND memory.embedding IS NOT NULL
            JOIN attachment_state AS attachment
              ON attachment.memory_id = requested.memory_id
             AND attachment.authority_namespace_ids
               = requested.authority_namespace_ids
            JOIN maximal_alternative AS alternative
              ON alternative.memory_id = requested.memory_id
             AND alternative.human_actor_ids = requested.human_actor_ids
             AND alternative.includes_public_boundary
               = requested.includes_public_boundary
           WHERE requested.read_namespace_id
                   = ANY(requested.authority_namespace_ids)
             AND attachment.attachment_count = (
               SELECT count(*) FROM namespace_audience AS mapped
                WHERE mapped.memory_id = requested.memory_id
             )
             AND (
               SELECT count(*) FROM maximal_alternative AS counted
                WHERE counted.memory_id = requested.memory_id
             ) = 1
             AND EXISTS (
               SELECT 1 FROM namespace_audience AS readable
                WHERE readable.memory_id = requested.memory_id
                  AND readable.namespace_id = requested.read_namespace_id
                  AND readable.human_actor_ids = requested.human_actor_ids
                  AND readable.includes_public_boundary
                    = requested.includes_public_boundary
             )
             AND (
               (memory.scope_origin_namespace_id IS NULL AND (
                 SELECT count(*) FROM memory_scopes AS scope
                  WHERE scope.memory_id = memory.id AND scope.origin = 'scope'
               ) = 0)
               OR (memory.scope_origin_namespace_id IS NOT NULL AND (
                 SELECT count(*) FROM memory_scopes AS scope
                  WHERE scope.memory_id = memory.id AND scope.origin = 'scope'
               ) = 1)
             )`;
}

async function queryInReadTransaction(
  handle: RecordProductPostgresHandle,
  callback: (transaction: RecordProductPostgresExecutor) => Promise<void>,
): Promise<void> {
  await handle.transaction(async (transaction) => {
    await transaction.query("SET TRANSACTION READ ONLY");
    await transaction.query("SET LOCAL jit = off");
    await transaction.query(
      `SET LOCAL statement_timeout = '${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.statementTimeoutMilliseconds}ms'`,
    );
    await callback(transaction);
  }, { isolationLevel: "serializable" });
}

/**
 * Bounded cross-Room discovery. Every authority and current-head
 * predicate is materialized before either query names vector distance, and no
 * payload column is selected or opened.
 */
export class PostgresCrossRoomOrganizerStore {
  constructor(private readonly handle: RecordProductPostgresHandle) {
    assertVerifiedRecordProductPostgresHandle(handle);
  }

  async discover(input: Readonly<{
    embedding: RecordEmbeddingV1;
    invocationAudience: EffectiveAudienceAlternative;
    selection: RecordRepositorySelection;
    changedRecordRef: string;
    changedPublicationBindingRef: string;
    authorityParentSeeds?: readonly CrossRoomAuthorityParentSeed[];
    overfetch?: CrossRoomOrganizerOverfetch;
  }>): Promise<CrossRoomOrganizerDiscoveryResult> {
    assertCanonicalRecordEmbeddingV1(input.embedding);
    const humanActorIds = canonicalHumanActorIds(input.invocationAudience);
    assertSelection(input.selection);
    assertPortable(input.changedRecordRef, "cross-Room changed Record");
    assertPortable(
      input.changedPublicationBindingRef,
      "cross-Room changed publication binding",
    );
    const changedNamespaceRef = parseReadNamespace(
      input.changedPublicationBindingRef,
    );
    const authorityParentSeeds = input.authorityParentSeeds ?? [];
    if (
      authorityParentSeeds.length
        > CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.authorityParentSeedMaximum
      || new Set(authorityParentSeeds.map((seed) => seed.recordRef)).size
        !== authorityParentSeeds.length
    ) {
      throw new RangeError("cross-Room authority-parent seeds exceed the bounded policy");
    }
    for (const seed of authorityParentSeeds) {
      assertPortable(seed.recordRef, "cross-Room authority-parent seed");
      canonicalizeCosineScore(seed.score);
      if (seed.recordRef === input.changedRecordRef) {
        throw new TypeError("changed Record cannot be an authority-parent seed");
      }
    }
    const overfetch = input.overfetch
      ?? CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.selectedOverfetch;
    if (!CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.measuredOverfetchOptions.includes(overfetch)) {
      throw new RangeError("cross-Room overfetch is outside measured policy");
    }

    try {
      let changedRows: readonly RecordProductPostgresRow[] = [];
      let recordRows: readonly RecordProductPostgresRow[] = [];
      let memoryRows: readonly RecordProductPostgresRow[] = [];
      let topologyRows: readonly RecordProductPostgresRow[] = [];
      let parentRows: readonly RecordProductPostgresRow[] = [];
      await queryInReadTransaction(this.handle, async (transaction) => {
        const provenance = input.embedding.provenance;
        changedRows = await transaction.query(changedCoordinateSql(input.selection), [
          provenance.provider,
          provenance.canonicalModel,
          provenance.dimensions,
          provenance.contractVersion,
          uuidArrayLiteral(humanActorIds),
          input.invocationAudience.includesPublicBoundary,
          input.changedRecordRef,
          input.changedPublicationBindingRef,
          input.selection.selectedRepresentation,
        ]);
        recordRows = await transaction.query(recordRankSql(input.selection), [
          vectorLiteral(input.embedding.vector),
          provenance.provider,
          provenance.canonicalModel,
          provenance.dimensions,
          provenance.contractVersion,
          uuidArrayLiteral(humanActorIds),
          input.invocationAudience.includesPublicBoundary,
          input.selection.selectedRepresentation,
          input.changedRecordRef,
          input.changedPublicationBindingRef,
          CANDIDATE_POLICY_V1.semanticMinimumScore,
          overfetch,
        ]);
        memoryRows = await transaction.query(memoryRankSql(input.selection), [
              vectorLiteral(input.embedding.vector),
              provenance.provider,
              provenance.canonicalModel,
              provenance.dimensions,
              provenance.contractVersion,
              changedNamespaceRef,
              uuidArrayLiteral(humanActorIds),
              input.invocationAudience.includesPublicBoundary,
              CANDIDATE_POLICY_V1.semanticMinimumScore,
              overfetch,
            ]);
        const rankedRecordRefs = recordRows.map((row) => rowString(row, "record_id"));
        const topologyRootRefs = [
          ...authorityParentSeeds.map((seed) => seed.recordRef),
          ...rankedRecordRefs.filter((recordRef) =>
            !authorityParentSeeds.some((seed) => seed.recordRef === recordRef)
          ),
        ];
        topologyRows = await transaction.query(
          topologySql(topologyRootRefs.length),
          topologyRootRefs.length === 0
            ? []
            : [topologyRootRefs, input.changedRecordRef],
        );
        const seedScores = new Map([
          ...recordRows.map((row) => [
            rowString(row, "record_id"),
            rowNumber(row, "score"),
          ] as const),
          ...authorityParentSeeds.map((seed) => [seed.recordRef, seed.score] as const),
        ]);
        parentRows = topologyRootRefs.length === 0 ? [] : await transaction.query(
          currentParentPathsSql(input.selection),
          [
            topologyRootRefs,
            topologyRootRefs.map((recordRef) => seedScores.get(recordRef)!),
            provenance.provider,
            provenance.canonicalModel,
            provenance.dimensions,
            provenance.contractVersion,
            uuidArrayLiteral(humanActorIds),
            input.invocationAudience.includesPublicBoundary,
            input.selection.selectedRepresentation,
          ],
        );
      });

      if (changedRows.length !== 1) {
        return { status: "unavailable", reason: "changed_input_stale" };
      }
      const changed = changedRecordCoordinate(changedRows[0]!);

      const state = topologyRows[0];
      if (state === undefined) throw new Error("cross-Room topology state is absent");
      if (rowBoolean(state, "overflowed")) {
        return { status: "unavailable", reason: "topology_capacity_exceeded" };
      }
      const redundantRecordRefs = new Set(topologyRows.flatMap((row) =>
        typeof row["redundant_record_id"] === "string"
          ? [row["redundant_record_id"]]
          : []
      ));
      const records = recordRows.map(recordCandidate);
      if (
        parentRows.length > CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum
        || parentRows.some((row) => row["cycle"] === true)
      ) return { status: "unavailable", reason: "topology_capacity_exceeded" };
      const qualifiedParentCounts = new Map<string, number>();
      for (const row of parentRows) {
        const child = row["child_record_id"];
        if (typeof child !== "string") continue;
        const key = `${rowString(row, "root_record_id")}\u0000${child}`;
        qualifiedParentCounts.set(key, (qualifiedParentCounts.get(key) ?? 0) + 1);
      }
      const authorityParentsUnavailable = new Set<string>();
      for (const row of parentRows) {
        const currentParentCount = rowInteger(row, "current_parent_count");
        const qualifiedParentCount = qualifiedParentCounts.get(
          `${rowString(row, "root_record_id")}\u0000${rowString(row, "parent_record_id")}`,
        ) ?? 0;
        if (currentParentCount > 1 || qualifiedParentCount > currentParentCount) {
          return { status: "unavailable", reason: "topology_capacity_exceeded" };
        }
        if (currentParentCount === 1 && qualifiedParentCount === 0) {
          authorityParentsUnavailable.add(rowString(row, "root_record_id"));
        }
      }
      const parentEdges = parentRows.flatMap((row) =>
        typeof row["child_record_id"] === "string"
          && !authorityParentsUnavailable.has(rowString(row, "root_record_id"))
          ? [{
              childRecordRef: rowString(row, "child_record_id"),
              parentRecordRef: rowString(row, "parent_record_id"),
            }]
          : []
      );
      const normalized = normalizeOrganizerCurrentParents({
        seedRecordRefs: [
          ...records.map((candidate) => candidate.recordRef),
          ...authorityParentSeeds.map((seed) => seed.recordRef),
        ].filter((recordRef, index, all) =>
          all.indexOf(recordRef) === index
          && !authorityParentsUnavailable.has(recordRef)
        ),
        currentParentEdges: parentEdges,
        maxTraversalWork: CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.topologyWorkMaximum,
      });
      if (normalized.status !== "complete") {
        return { status: "unavailable", reason: "topology_capacity_exceeded" };
      }
      const parentCoordinates = new Map(parentRows.flatMap((row) =>
        row["child_record_id"] === null
          ? []
          : [[
              rowString(row, "parent_record_id"),
              recordCandidate({
                ...row,
                record_id: rowString(row, "parent_record_id"),
              }),
            ] as const]
      ));
      const normalizedRecords = records.flatMap((candidate) => {
        if (
          redundantRecordRefs.has(candidate.recordRef)
          || authorityParentsUnavailable.has(candidate.recordRef)
        ) return [];
        const representativeRef = normalized.representatives.get(candidate.recordRef)
          ?? candidate.recordRef;
        if (representativeRef === input.changedRecordRef) return [];
        const representative = representativeRef === candidate.recordRef
          ? candidate
          : parentCoordinates.get(representativeRef);
        return representative === undefined
          ? []
          : [{ ...representative, score: candidate.score }];
      }).filter((candidate, index, all) =>
        all.findIndex((entry) => entry.recordRef === candidate.recordRef) === index
      );
      const authorityParentRecords = [...authorityParentSeeds]
        .sort((left, right) =>
          right.score - left.score || compareStrings(left.recordRef, right.recordRef)
        )
        .flatMap((seed) => {
          if (
            redundantRecordRefs.has(seed.recordRef)
            || authorityParentsUnavailable.has(seed.recordRef)
          ) return [];
          const representativeRef = normalized.representatives.get(seed.recordRef);
          if (
            representativeRef === undefined
            || representativeRef === seed.recordRef
            || representativeRef === input.changedRecordRef
          ) return [];
          const representative = parentCoordinates.get(representativeRef);
          return representative === undefined
            ? []
            : [{ ...representative, score: canonicalizeCosineScore(seed.score) }];
        })
        .filter((candidate, index, all) =>
          all.findIndex((entry) => entry.recordRef === candidate.recordRef) === index
        );
      const memories = memoryRows.map((row) => memoryCandidate(row, input.selection));
      const authorityParentIdentities = new Set(
        authorityParentRecords.map(candidateIdentity),
      );
      const selectedCrossRoom = [...normalizedRecords, ...memories]
        .filter((candidate) => !authorityParentIdentities.has(candidateIdentity(candidate)))
        .sort(compareCandidates)
        .slice(0, CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.crossRoomBound);
      const selected = [...authorityParentRecords, ...selectedCrossRoom];
      const recordRowsConsidered = recordRows[0] === undefined
        ? 0
        : rowInteger(recordRows[0], "rows_considered");
      const memoryRowsConsidered = memoryRows[0] === undefined
        ? 0
        : rowInteger(memoryRows[0], "rows_considered");
      const unsupportedAuthorityShapes = memoryRows[0] === undefined
        ? 0
        : rowInteger(memoryRows[0], "unsupported_authority_shapes");
      return Object.freeze({
        status: "available" as const,
        changed,
        candidates: Object.freeze(selected),
        metrics: Object.freeze({
          recordRowsConsidered,
          memoryRowsConsidered,
          rowsSelected: selected.length,
          unsupportedAuthorityShapes,
          authorityParentsResolved: authorityParentRecords.length,
          authorityParentsSkipped:
            authorityParentSeeds.length - authorityParentRecords.length
            + records.filter((candidate) =>
              authorityParentsUnavailable.has(candidate.recordRef)
            ).length,
          topologyWork: rowInteger(state, "traversal_work")
            + normalized.traversalWork,
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

  /** Final all-or-nothing generation and attachment fence before any open. */
  async fence(input: Readonly<{
    selection: RecordRepositorySelection;
    changed?: CrossRoomChangedRecordCoordinate;
    candidates: readonly CrossRoomOrganizerCandidate[];
  }>, held?: RecordProductPostgresExecutor): Promise<CrossRoomOrganizerFenceResult> {
    assertSelection(input.selection);
    if (input.changed !== undefined) assertRecordCoordinate(input.changed);
    for (const candidate of input.candidates) {
      if (candidate.kind === "record") {
        canonicalizeCosineScore(candidate.score);
        assertRecordCoordinate(candidate);
      } else {
        assertMemoryCoordinate(candidate, input.selection);
      }
    }
    if (
      input.candidates.length
        > CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.crossRoomBound
          + CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.authorityParentSeedMaximum
    ) {
      throw new RangeError("cross-Room final fence exceeds selected bound");
    }
    if (
      new Set(input.candidates.map(candidateIdentity)).size
        !== input.candidates.length
    ) throw new TypeError("cross-Room final fence contains duplicate candidates");
    if (input.candidates.length === 0 && input.changed === undefined) {
      return { status: "current" };
    }

    try {
      const candidateRecords = input.candidates.filter(
          (candidate): candidate is CrossRoomRecordCandidate =>
            candidate.kind === "record",
        );
      const records: readonly (
        CrossRoomRecordCandidate | CrossRoomChangedRecordCoordinate
      )[] = [
        ...(input.changed === undefined ? [] : [input.changed]),
        ...candidateRecords,
      ];
      if (new Set(records.map((entry) => entry.recordRef)).size !== records.length) {
        throw new TypeError("cross-Room fence Record coordinates are not unique");
      }
      const memories = input.candidates.filter(
        (candidate): candidate is CrossRoomMemoryCandidate =>
          candidate.kind === "memory",
      );
      let recordMatched = 0;
      let memoryMatched = 0;
      const check = async (transaction: RecordProductPostgresExecutor) => {
        if (records.length > 0) {
          const rows = await transaction.query(recordFenceSql(input.selection), [
            records.map((entry) => entry.recordRef),
            records.map((entry) => entry.recordProcessingGeneration),
            records.map((entry) => entry.authorityProjectionGeneration),
            records.map((entry) => entry.payloadRepresentationGeneration),
            records.map((entry) => entry.searchProjectionGeneration),
            records.map((entry) => entry.readBindingRef),
            records.map((entry) => entry.authorityAccessNamespaceRef),
            JSON.stringify(records.map((entry) => entry.audience.humanRefs)),
            booleanArrayLiteral(
              records.map((entry) => entry.audience.includesPublicBoundary),
            ),
            input.selection.selectedRepresentation,
          ]);
          recordMatched = rows[0] === undefined
            ? -1
            : rowInteger(rows[0], "matched_count");
        }
        if (memories.length > 0) {
          const memoryFenceParameters: RecordProductPostgresScalar[] = [
            memories.map((entry) => entry.memoryRef),
            memories.map((entry) => entry.contentRevision),
            memories.map((entry) => entry.embeddingRevision),
            memories.map((entry) => entry.updatedAtCoordinate),
            JSON.stringify(memories.map((entry) => entry.authorityNamespaceRefs)),
            memories.map((entry) => entry.readNamespaceRef),
            JSON.stringify(memories.map((entry) => entry.audience.humanRefs)),
            booleanArrayLiteral(
              memories.map((entry) => entry.audience.includesPublicBoundary),
            ),
            memories.map((entry) => entry.embeddingProvenance.provider),
            memories.map((entry) => entry.embeddingProvenance.canonicalModel),
            memories.map((entry) => entry.embeddingProvenance.dimensions),
            memories.map((entry) => entry.embeddingProvenance.contractVersion),
          ];
          if (input.selection.selectedRepresentation === "protected") {
            memoryFenceParameters.push(
              memories.map((entry) => entry.protectedCryptoObjectId!),
              memories.map((entry) => entry.protectedCryptoAccessRevision!),
            );
          }
          const rows = await transaction.query(
            memoryFenceSql(input.selection),
            memoryFenceParameters,
          );
          memoryMatched = rows[0] === undefined
            ? -1
            : rowInteger(rows[0], "matched_count");
        }
      };
      // Publication already holds a writable transaction; do not open another
      // snapshot or change its transaction mode for the final freshness check.
      if (held === undefined) await queryInReadTransaction(this.handle, check);
      else {
        await held.query("SET LOCAL jit = off");
        await held.query(
          `SET LOCAL statement_timeout = '${CROSS_ROOM_ORGANIZER_QUERY_POLICY_V1.statementTimeoutMilliseconds}ms'`,
        );
        await check(held);
      }
      return recordMatched === records.length && memoryMatched === memories.length
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

/** Public only for focused parser tests; product callers use `discover`. */
export const __crossRoomOrganizerStoreTesting = Object.freeze({
  changedCoordinateSql,
  currentParentPathsSql,
  memoryRankSql,
  recordRankSql,
  topologySql,
  recordFenceSql,
  memoryFenceSql,
  memoryLogicalRefIsValid(value: string): boolean {
    return MEMORY_LOGICAL_REF.test(value);
  },
});

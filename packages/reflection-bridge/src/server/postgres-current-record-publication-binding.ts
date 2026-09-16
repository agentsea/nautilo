import {
  and,
  asc,
  eq,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityProjections,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecords,
  sql,
} from "@nautilo/db";

import type { RecordRepositorySelection } from "./contracts";
import {
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresHandle,
  type RecordProductPostgresExecutor,
} from "./product-postgres";

export interface CurrentRecordPublicationBinding {
  /** Immutable logical-publication coordinate used to identify provenance. */
  readonly originPublicationBindingRef: string;
  /** Exact current access coordinates for the selected payload head. */
  readonly currentAccessBindingRefs: readonly string[];
  readonly representationGeneration: number;
  /** Null only while an initial complete publication precedes authority readiness. */
  readonly authorityProjectionGeneration: number | null;
}

export interface CurrentRecordPublicationBindingPort {
  read(recordRef: string): Promise<CurrentRecordPublicationBinding | null>;
  /** Immutable provenance only; does not require any selected payload head. */
  readOrigin?(recordRef: string): Promise<string | null>;
}

function bindingRef(namespaceId: string, selection: RecordRepositorySelection): string {
  return `journal:namespace:${namespaceId}:${selection.selectedRepresentation}:v${selection.migrationGeneration}`;
}

const PUBLICATION_BINDING =
  /^journal:namespace:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(ordinary|protected):v[1-9][0-9]*$/iu;

function publicationBindingNamespace(binding: unknown): string | null {
  return typeof binding === "string"
    ? PUBLICATION_BINDING.exec(binding)?.[1]?.toLowerCase() ?? null
    : null;
}

/**
 * Correlated metadata join for the bounded protected Organizer queries. The
 * aliases are fixed by that query owner. Keep origin/tie and current-head proof
 * semantics identical to readImmutableOrigin/read below; no origin envelope is
 * selected, and an authority reprojection is not a new logical publication.
 */
export function protectedRecordCurrentHeadOriginJoinSql(input: Readonly<{
  representationParameter: 4 | 8 | 9 | 10;
  originBindingParameter?: 5 | 8 | 9;
  originBindingExpression?: "requested.binding_ref";
  representationHeadAlias?: "head" | "representation_head";
}>): string {
  const representation = `$${input.representationParameter}`;
  const representationHead = input.representationHeadAlias ?? "representation_head";
  if (
    input.originBindingParameter !== undefined
    && input.originBindingExpression !== undefined
  ) throw new TypeError("protected Record origin predicate is ambiguous");
  const originPredicate = input.originBindingExpression !== undefined
    ? `publication.publication_binding_ref = ${input.originBindingExpression}`
    : input.originBindingParameter === undefined
      ? "true"
      : `publication.publication_binding_ref = $${input.originBindingParameter}`;
  return `JOIN reflection_record_payload_representations AS current_payload
      ON current_payload.record_id = ${representationHead}.record_id
     AND current_payload.representation = ${representationHead}.representation
     AND current_payload.representation_generation
       = ${representationHead}.current_representation_generation
    JOIN LATERAL (
      SELECT coalesce(origin.origin_publication_binding_ref,
                      origin.publication_binding_ref) AS publication_binding_ref,
             origin.created_at
        FROM reflection_record_publications AS origin
       WHERE origin.record_id = record.record_id AND origin.state = 'complete'
       ORDER BY origin.created_at, origin.publication_id
       LIMIT 1
    ) AS publication ON ${originPredicate}
     AND publication.publication_binding_ref ~* '${PUBLICATION_BINDING.source}'
     AND NOT EXISTS (
       SELECT 1 FROM reflection_record_publications AS origin_sibling
        WHERE origin_sibling.record_id = record.record_id
          AND origin_sibling.state = 'complete'
          AND origin_sibling.created_at = publication.created_at
          AND coalesce(origin_sibling.origin_publication_binding_ref,
                       origin_sibling.publication_binding_ref) !~*
            ('^journal:namespace:' || lower(split_part(publication.publication_binding_ref, ':', 3))
              || ':(ordinary|protected):v[1-9][0-9]*$')
     )
    JOIN LATERAL (
      SELECT count(*) AS publication_count FROM (
        SELECT 1 FROM reflection_record_publications AS current_publication
         WHERE current_publication.record_id = record.record_id
           AND current_publication.representation = ${representation}
           AND current_publication.representation_generation
             = ${representationHead}.current_representation_generation
           AND current_publication.state = 'complete'
         LIMIT 2
      ) AS current_publications
    ) AS current_proof ON current_proof.publication_count = 1 OR (
      current_proof.publication_count = 0 AND current_payload.crypto_object_id IS NOT NULL
      AND (SELECT count(*) FROM (
        SELECT 1 FROM reflection_record_authority_reconciliations AS native_receipt
         WHERE native_receipt.record_id = record.record_id
           AND native_receipt.expected_projection_generation = authority.projection_generation - 1
           AND native_receipt.source_change_generation = authority.source_change_generation
           AND native_receipt.target_representation_generation
             = ${representationHead}.current_representation_generation
           AND native_receipt.target_crypto_object_id = current_payload.crypto_object_id
           AND native_receipt.state = 'complete'
         LIMIT 2
      ) AS native_receipts) = 1
    )`;
}

async function readImmutableOrigin(
  tx: RecordProductPostgresExecutor,
  recordRef: string,
): Promise<string | null> {
  const originRows = await executeTypedRecordProductQuery(tx,
    recordProductTypedDb.select({
      publication_binding_ref: sql<string>`coalesce(
        ${reflectionRecordPublications.originPublicationBindingRef},
        ${reflectionRecordPublications.publicationBindingRef}
      )`.as("publication_binding_ref"),
    })
      .from(reflectionRecordPublications)
      .where(and(
        eq(reflectionRecordPublications.recordId, recordRef),
        eq(reflectionRecordPublications.state, "complete"),
      ))
      .orderBy(
        asc(reflectionRecordPublications.createdAt),
        asc(reflectionRecordPublications.publicationId),
      )
      .limit(1));
  if (originRows.length !== 1) return null;
  const origin = originRows[0]!;
  const originNamespace = publicationBindingNamespace(origin.publication_binding_ref);
  if (typeof origin.publication_binding_ref !== "string" || originNamespace === null) {
    return null;
  }
  const matchingOriginBindingPattern =
    `^journal:namespace:${originNamespace}:(ordinary|protected):v[1-9][0-9]*$`;
  const earliestCompletePublication = recordProductTypedDb.select({
    createdAt: reflectionRecordPublications.createdAt,
  })
    .from(reflectionRecordPublications)
    .where(and(
      eq(reflectionRecordPublications.recordId, recordRef),
      eq(reflectionRecordPublications.state, "complete"),
    ))
    .orderBy(
      asc(reflectionRecordPublications.createdAt),
      asc(reflectionRecordPublications.publicationId),
    )
    .limit(1)
    .as("earliest_complete_publication");
  const conflictingOriginRows = await executeTypedRecordProductQuery(tx,
    recordProductTypedDb.select({
      publication_id: reflectionRecordPublications.publicationId,
    })
      .from(reflectionRecordPublications)
      .innerJoin(earliestCompletePublication, eq(
        reflectionRecordPublications.createdAt,
        earliestCompletePublication.createdAt,
      ))
      .where(and(
        eq(reflectionRecordPublications.recordId, recordRef),
        eq(reflectionRecordPublications.state, "complete"),
        sql<boolean>`coalesce(
          ${reflectionRecordPublications.originPublicationBindingRef},
          ${reflectionRecordPublications.publicationBindingRef}
        )
          !~* ${matchingOriginBindingPattern}`,
      ))
      .limit(1));
  return conflictingOriginRows.length === 0 ? origin.publication_binding_ref : null;
}

/**
 * Resolves immutable publication provenance separately from the selected head's
 * current access coordinates. It never treats an authority reprojection as a
 * second logical publication.
 */
export class PostgresCurrentRecordPublicationBinding
implements CurrentRecordPublicationBindingPort {
  constructor(
    private readonly handle: RecordProductPostgresHandle,
    private readonly selection: RecordRepositorySelection,
  ) {}

  async readOrigin(recordRef: string): Promise<string | null> {
    return this.handle.transaction(
      (tx) => readImmutableOrigin(tx, recordRef),
      { isolationLevel: "serializable" },
    );
  }

  async read(recordRef: string): Promise<CurrentRecordPublicationBinding | null> {
    return this.handle.transaction(async (tx) => {
      const [headRows, originPublicationBindingRef] = await Promise.all([
        executeTypedRecordProductQuery(tx,
          recordProductTypedDb.select({
            current_representation_generation:
              reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
            crypto_object_id: reflectionRecordPayloadRepresentations.cryptoObjectId,
            disposition: reflectionRecords.disposition,
          })
            .from(reflectionRecordPayloadRepresentationHeads)
            .innerJoin(reflectionRecords, eq(
              reflectionRecords.recordId,
              reflectionRecordPayloadRepresentationHeads.recordId,
            ))
            .innerJoin(reflectionRecordPayloadRepresentations, and(
              eq(
                reflectionRecordPayloadRepresentations.recordId,
                reflectionRecordPayloadRepresentationHeads.recordId,
              ),
              eq(
                reflectionRecordPayloadRepresentations.representation,
                reflectionRecordPayloadRepresentationHeads.representation,
              ),
              eq(
                reflectionRecordPayloadRepresentations.representationGeneration,
                reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
              ),
            ))
            .where(and(
              eq(reflectionRecordPayloadRepresentationHeads.recordId, recordRef),
              eq(
                reflectionRecordPayloadRepresentationHeads.representation,
                this.selection.selectedRepresentation,
              ),
            ))
            .limit(2)),
        readImmutableOrigin(tx, recordRef),
      ]);
      if (headRows.length !== 1 || originPublicationBindingRef === null) return null;
      const head = headRows[0]!;
      if (
        head.disposition !== "available"
        || typeof head.current_representation_generation !== "number"
        || !Number.isSafeInteger(head.current_representation_generation)
      ) return null;

      const representationGeneration = head.current_representation_generation;
      const currentPublications = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          publication_binding_ref: reflectionRecordPublications.publicationBindingRef,
        })
          .from(reflectionRecordPublications)
          .where(and(
            eq(reflectionRecordPublications.recordId, recordRef),
            eq(
              reflectionRecordPublications.representation,
              this.selection.selectedRepresentation,
            ),
            eq(
              reflectionRecordPublications.representationGeneration,
              representationGeneration,
            ),
            eq(reflectionRecordPublications.state, "complete"),
          ))
          .limit(2));
      const currentPublicationBinding = currentPublications.length === 1
        && typeof currentPublications[0]!.publication_binding_ref === "string"
        ? currentPublications[0]!.publication_binding_ref
        : null;
      if (currentPublications.length !== 0 && currentPublicationBinding === null) return null;

      const projections = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          projection_generation:
            reflectionRecordAuthorityProjections.projectionGeneration,
          source_change_generation:
            reflectionRecordAuthorityProjections.sourceChangeGeneration,
          processing_state: reflectionRecordAuthorityProjections.processingState,
        })
          .from(reflectionRecordAuthorityProjections)
          .where(and(
            eq(reflectionRecordAuthorityProjections.recordId, recordRef),
            eq(reflectionRecordAuthorityProjections.current, true),
          ))
          .limit(2));
      const projection = projections.length === 1 ? projections[0]! : null;
      if (
        projection === null
        || projection.processing_state !== "current"
        || typeof projection.projection_generation !== "number"
        || !Number.isSafeInteger(projection.projection_generation)
        || typeof projection.source_change_generation !== "number"
        || !Number.isSafeInteger(projection.source_change_generation)
      ) {
        return currentPublicationBinding === null
          ? null
          : Object.freeze({
              originPublicationBindingRef,
              currentAccessBindingRefs: Object.freeze([currentPublicationBinding]),
              representationGeneration,
              authorityProjectionGeneration: null,
            });
      }

      const alternatives = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          access_namespace_id: reflectionRecordAuthorityAlternatives.accessNamespaceId,
        })
          .from(reflectionRecordAuthorityAlternatives)
          .where(and(
            eq(reflectionRecordAuthorityAlternatives.recordId, recordRef),
            eq(
              reflectionRecordAuthorityAlternatives.projectionGeneration,
              projection.projection_generation,
            ),
          ))
          .orderBy(asc(reflectionRecordAuthorityAlternatives.alternativeOrdinal)));
      if (alternatives.length < 1) return null;
      if (currentPublicationBinding === null) {
        if (
          this.selection.selectedRepresentation !== "protected"
          || typeof head.crypto_object_id !== "string"
        ) return null;
        const receipts = await executeTypedRecordProductQuery(tx,
          recordProductTypedDb.select({
            reconciliation_id: reflectionRecordAuthorityReconciliations.reconciliationId,
          })
            .from(reflectionRecordAuthorityReconciliations)
            .where(and(
              eq(reflectionRecordAuthorityReconciliations.recordId, recordRef),
              eq(
                reflectionRecordAuthorityReconciliations.expectedProjectionGeneration,
                projection.projection_generation - 1,
              ),
              eq(
                reflectionRecordAuthorityReconciliations.sourceChangeGeneration,
                projection.source_change_generation,
              ),
              eq(
                reflectionRecordAuthorityReconciliations.targetRepresentationGeneration,
                representationGeneration,
              ),
              eq(
                reflectionRecordAuthorityReconciliations.targetCryptoObjectId,
                head.crypto_object_id,
              ),
              eq(reflectionRecordAuthorityReconciliations.state, "complete"),
            ))
            .limit(2));
        if (receipts.length !== 1) return null;
      }
      const namespaceIds = alternatives.map((row) => row.access_namespace_id);
      if (
        namespaceIds.some((namespaceId) => typeof namespaceId !== "string")
        || new Set(namespaceIds).size !== namespaceIds.length
      ) return null;
      return Object.freeze({
        originPublicationBindingRef,
        currentAccessBindingRefs: Object.freeze(
          namespaceIds.map((namespaceId) => bindingRef(namespaceId, this.selection)),
        ),
        representationGeneration,
        authorityProjectionGeneration: projection.projection_generation,
      });
    }, { isolationLevel: "serializable" });
  }
}

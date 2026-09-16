import {
  and,
  eq,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityProjections,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordSearchProjections,
  reflectionRecords,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { DurableSleepClaim } from "@nautilo/reflection/durable";
import type { RecordEmbeddingProvenanceV1 } from "@nautilo/reflection/search";

import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
} from "../storage/postgres-lattice-storage.ts";
import type { ProtectedReflectionSearchMetadata } from
  "./protected-search-projection.ts";

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** Content-free protected Record metadata for the search-projection gate. */
export class PostgresProtectedReflectionSearchMetadata {
  constructor(private readonly ports: Readonly<{
    product: Pick<PostgresJsBridgeConnection, "query">;
    configuredEmbedding(): RecordEmbeddingProvenanceV1;
  }>) {}

  async resolve(
    claim: DurableSleepClaim,
    signal?: AbortSignal,
  ): Promise<ProtectedReflectionSearchMetadata | null> {
    signal?.throwIfAborted();
    const rows = await executeTypedCryptoQuery(
      this.ports.product,
      cryptoTypedDb.select({
        recordId: reflectionRecords.recordId,
        processingGeneration: reflectionRecords.processingGeneration,
        producerPolicyVersion: reflectionRecords.producerPolicyVersion,
        lifecycle: reflectionRecords.lifecycle,
        disposition: reflectionRecords.disposition,
        representationGeneration:
          reflectionRecordPayloadRepresentations.representationGeneration,
        cryptoObjectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
        authorityState: reflectionRecordAuthorityProjections.processingState,
        accessNamespaceId: reflectionRecordAuthorityAlternatives.accessNamespaceId,
      })
        .from(reflectionRecords)
        .innerJoin(
          reflectionRecordPayloadRepresentationHeads,
          and(
            eq(
              reflectionRecordPayloadRepresentationHeads.recordId,
              reflectionRecords.recordId,
            ),
            eq(
              reflectionRecordPayloadRepresentationHeads.representation,
              "protected",
            ),
          ),
        )
        .innerJoin(
          reflectionRecordPayloadRepresentations,
          and(
            eq(
              reflectionRecordPayloadRepresentations.recordId,
              reflectionRecords.recordId,
            ),
            eq(reflectionRecordPayloadRepresentations.representation, "protected"),
            eq(
              reflectionRecordPayloadRepresentations.representationGeneration,
              reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
            ),
          ),
        )
        .innerJoin(
          reflectionRecordAuthorityProjections,
          and(
            eq(
              reflectionRecordAuthorityProjections.recordId,
              reflectionRecords.recordId,
            ),
            eq(reflectionRecordAuthorityProjections.current, true),
          ),
        )
        .innerJoin(
          reflectionRecordAuthorityAlternatives,
          and(
            eq(
              reflectionRecordAuthorityAlternatives.recordId,
              reflectionRecords.recordId,
            ),
            eq(
              reflectionRecordAuthorityAlternatives.projectionGeneration,
              reflectionRecordAuthorityProjections.projectionGeneration,
            ),
          ),
        )
        .where(eq(reflectionRecords.recordId, claim.recordRef))
        .limit(2),
    );
    signal?.throwIfAborted();
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || row.record_id !== claim.recordRef
      || row.lifecycle !== "current"
      || row.disposition !== "available"
      || row.processing_state !== "current"
      || typeof row.producer_policy_version !== "string"
      || row.producer_policy_version.length === 0
      || typeof row.crypto_object_id !== "string"
      || row.crypto_object_id.length === 0
      || typeof row.access_namespace_id !== "string"
      || row.access_namespace_id.length === 0
      || !positiveInteger(row.processing_generation)
      || !positiveInteger(row.representation_generation)
    ) return null;

    const projectionRows = await executeTypedCryptoQuery(
      this.ports.product,
      cryptoTypedDb.select({
        recordId: reflectionRecordSearchProjections.recordId,
        recordProcessingGeneration:
          reflectionRecordSearchProjections.recordProcessingGeneration,
        projectionVersion: reflectionRecordSearchProjections.projectionVersion,
        projectionGeneration: reflectionRecordSearchProjections.projectionGeneration,
        embeddingProvider: reflectionRecordSearchProjections.embeddingProvider,
        embeddingCanonicalModel:
          reflectionRecordSearchProjections.embeddingCanonicalModel,
        embeddingDimensions: reflectionRecordSearchProjections.embeddingDimensions,
        embeddingContractVersion:
          reflectionRecordSearchProjections.embeddingContractVersion,
      })
        .from(reflectionRecordSearchProjections)
        .where(eq(reflectionRecordSearchProjections.recordId, claim.recordRef))
        .limit(2),
    );
    signal?.throwIfAborted();
    if (projectionRows.length > 1) return null;
    const projection = projectionRows[0];
    const currentProjection = projection === undefined
      ? null
      : (
          projection.record_id === claim.recordRef
          && positiveInteger(projection.record_processing_generation)
          && projection.projection_version === 1
          && positiveInteger(projection.projection_generation)
          && (
            projection.embedding_provider === "openai"
            || projection.embedding_provider === "openrouter"
            || projection.embedding_provider === "venice"
          )
          && typeof projection.embedding_canonical_model === "string"
          && projection.embedding_canonical_model.length > 0
          && projection.embedding_dimensions === 1_536
          && projection.embedding_contract_version === 1
            ? Object.freeze({
                recordRef: claim.recordRef,
                recordProcessingGeneration:
                  projection.record_processing_generation,
                projectionVersion: 1,
                projectionGeneration: projection.projection_generation,
                embeddingProvider: projection.embedding_provider,
                embeddingCanonicalModel: projection.embedding_canonical_model,
                embeddingDimensions: 1_536,
                embeddingContractVersion: 1,
              })
            : null
        );
    if (projection !== undefined && currentProjection === null) return null;
    return Object.freeze({
      recordRef: claim.recordRef,
      processingGeneration: row.processing_generation,
      representationGeneration: row.representation_generation,
      producerPolicyVersion: row.producer_policy_version,
      lifecycle: "current" as const,
      inputBinding: Object.freeze({
        objectId: row.crypto_object_id,
        namespaceId: row.access_namespace_id,
        objectType: "nautilo.reflection.record.v1" as const,
      }),
      expectedEmbeddingProvenance: this.ports.configuredEmbedding(),
      currentProjection,
    });
  }
}

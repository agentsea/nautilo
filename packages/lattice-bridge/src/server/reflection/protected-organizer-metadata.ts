import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  lte,
  memories,
  memoryNamespaces,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityProjections,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  sql,
  type PostgresJsBridgeConnection,
} from "@nautilo/db";
import type { BackgroundReflectionSemanticInputBindingV2 } from
  "@nautilo/lattice-crypto/background";
import { CANDIDATE_POLICY_V1 } from "@nautilo/reflection";
import {
  assertCanonicalRecordEmbeddingV1,
  assertRankedRecordCoordinate,
  canonicalizeCosineScore,
  type RankedRecordCoordinate,
  type RecordEmbeddingV1,
} from "@nautilo/reflection/search";

import {
  cryptoTypedDb,
  executeTypedCryptoQuery,
} from "../storage/postgres-lattice-storage.ts";

export interface ProtectedOrganizerRoomBindingPort {
  resolveRoom(roomAnchorRef: string): Promise<Readonly<{
    roomId: string;
    namespaceId: string;
  }> | null>;
}

export interface ProtectedOrganizerRecordMetadata {
  readonly recordRef: string;
  readonly structuralHeight: number;
  readonly processingGeneration: number;
  readonly representationGeneration: number;
  readonly authorityProjectionGeneration: number;
  readonly producerPolicyVersion: string;
  readonly lifecycle: "current" | "stale";
  readonly authorityNamespaceId: string;
  readonly inputBinding: BackgroundReflectionSemanticInputBindingV2;
}

export interface ProtectedOrganizerMemoryMetadata {
  readonly memoryRef: string;
  readonly logicalSourceRef: `memory:${string}`;
  readonly contentRevision: number;
  readonly cryptoAccessRevision: number;
  readonly inputBinding: BackgroundReflectionSemanticInputBindingV2;
}

export interface ProtectedOrganizerRankedMemoryMetadata
  extends ProtectedOrganizerMemoryMetadata {
  readonly score: number;
}

export type ProtectedOrganizerMemoryMetadataResult =
  | Readonly<{
      status: "available";
      candidates: readonly ProtectedOrganizerRankedMemoryMetadata[];
    }>
  | Readonly<{ status: "unavailable" }>;

export type ProtectedOrganizerMemoryDependencyMetadataResult =
  | Readonly<{
      status: "available";
      metadata: ProtectedOrganizerMemoryMetadata;
    }>
  | Readonly<{
      status: "missing" | "changed" | "waiting" | "unavailable";
    }>;

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/**
 * Content-free protected Organizer lookup. Exact payload and Namespace-head
 * validation remains with the Reflection semantic source plan before a grant.
 */
export class PostgresProtectedOrganizerMetadata {
  constructor(private readonly ports: Readonly<{
    product: Pick<PostgresJsBridgeConnection, "query">;
    rooms: ProtectedOrganizerRoomBindingPort;
  }>) {}

  async resolveRecord(input: Readonly<{
    recordRef: string;
    namespaceId: string;
    expected?: RankedRecordCoordinate;
    allowStale?: boolean;
    signal?: AbortSignal;
  }>): Promise<ProtectedOrganizerRecordMetadata | null> {
    input.signal?.throwIfAborted();
    if (input.expected !== undefined) {
      assertRankedRecordCoordinate(input.expected);
      if (input.expected.recordRef !== input.recordRef) return null;
    }
    const rows = await executeTypedCryptoQuery(
      this.ports.product,
      cryptoTypedDb.select({
        recordId: reflectionRecords.recordId,
        structuralHeight: reflectionRecords.structuralHeight,
        processingGeneration: reflectionRecords.processingGeneration,
        producerPolicyVersion: reflectionRecords.producerPolicyVersion,
        lifecycle: reflectionRecords.lifecycle,
        disposition: reflectionRecords.disposition,
        representationGeneration:
          reflectionRecordPayloadRepresentations.representationGeneration,
        cryptoObjectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
        authorityGeneration:
          reflectionRecordAuthorityProjections.projectionGeneration,
        authorityState: reflectionRecordAuthorityProjections.processingState,
        accessNamespaceId:
          reflectionRecordAuthorityAlternatives.accessNamespaceId,
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
            eq(
              reflectionRecordPayloadRepresentations.representation,
              "protected",
            ),
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
        .where(eq(reflectionRecords.recordId, input.recordRef))
        .limit(2),
    );
    input.signal?.throwIfAborted();
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || row.record_id !== input.recordRef
      || (row.lifecycle !== "current"
        && (input.allowStale !== true || row.lifecycle !== "stale"))
      || row.disposition !== "available"
      || row.processing_state !== "current"
      || typeof row.producer_policy_version !== "string"
      || row.producer_policy_version.length === 0
      || row.access_namespace_id !== input.namespaceId
      || row.crypto_object_id === null
      || !nonnegativeInteger(row.structural_height)
      || !positiveInteger(row.processing_generation)
      || !positiveInteger(row.representation_generation)
      || !positiveInteger(row.projection_generation)
      || (input.expected !== undefined && (
        row.structural_height !== input.expected.structuralHeight
        || row.processing_generation
          !== input.expected.recordProcessingGeneration
        || row.representation_generation
          !== input.expected.payloadRepresentationGeneration
        || row.projection_generation
          !== input.expected.authorityProjectionGeneration
      ))
    ) return null;
    return Object.freeze({
      recordRef: row.record_id,
      structuralHeight: row.structural_height,
      processingGeneration: row.processing_generation,
      representationGeneration: row.representation_generation,
      authorityProjectionGeneration: row.projection_generation,
      producerPolicyVersion: row.producer_policy_version,
      lifecycle: row.lifecycle,
      authorityNamespaceId: row.access_namespace_id,
      inputBinding: Object.freeze({
        objectId: row.crypto_object_id,
        namespaceId: input.namespaceId,
        objectType: "nautilo.reflection.record.v1" as const,
      }),
    });
  }

  async resolveMemory(input: Readonly<{
    memoryRef: string;
    namespaceId: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedOrganizerMemoryMetadata | null> {
    return this.#resolveMemory({
      lookup: { kind: "memory", memoryRef: input.memoryRef },
      namespaceId: input.namespaceId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async resolveMemoryObject(input: Readonly<{
    objectId: string;
    namespaceId: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedOrganizerMemoryMetadata | null> {
    return this.#resolveMemory({
      lookup: { kind: "object", objectId: input.objectId },
      namespaceId: input.namespaceId,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  }

  async resolveMemoryDependency(input: Readonly<{
    memoryRef: string;
    namespaceId: string;
    observedRevision?: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedOrganizerMemoryDependencyMetadataResult> {
    input.signal?.throwIfAborted();
    const observedRevision = input.observedRevision === undefined
      ? undefined
      : /^(?:0|[1-9][0-9]*)$/.test(input.observedRevision)
        ? Number(input.observedRevision)
        : Number.NaN;
    if (
      observedRevision !== undefined
      && (!Number.isSafeInteger(observedRevision) || observedRevision < 1)
    ) return { status: "unavailable" };
    const rows = await executeTypedCryptoQuery(
      this.ports.product,
      cryptoTypedDb.select({
        memoryId: memories.id,
        tier: memories.tier,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        cryptoMappingState: memories.cryptoMappingState,
      })
        .from(memories)
        .innerJoin(
          memoryNamespaces,
          and(
            eq(memoryNamespaces.memoryId, memories.id),
            eq(memoryNamespaces.namespaceId, input.namespaceId),
          ),
        )
        .where(eq(memories.id, input.memoryRef))
        .limit(2),
    );
    input.signal?.throwIfAborted();
    if (rows.length === 0) return { status: "missing" };
    if (rows.length !== 1) return { status: "unavailable" };
    const row = rows[0]!;
    if (
      row.id !== input.memoryRef
      || !Number.isSafeInteger(row.tier)
      || row.tier < 1
    ) return { status: "unavailable" };
    if (row.tier > 2) return { status: "missing" };
    if (row.crypto_mapping_state === "unmapped") {
      return row.crypto_object_id === null
        ? { status: "waiting" }
        : { status: "unavailable" };
    }
    if (row.crypto_mapping_state === "stale") {
      return typeof row.crypto_object_id === "string"
        && positiveInteger(row.content_revision)
        && nonnegativeInteger(row.crypto_access_revision)
        ? { status: "waiting" }
        : { status: "unavailable" };
    }
    if (row.crypto_mapping_state !== "verified") {
      return { status: "unavailable" };
    }
    if (
      typeof row.crypto_object_id !== "string"
      || !positiveInteger(row.content_revision)
      || !nonnegativeInteger(row.crypto_access_revision)
    ) return { status: "unavailable" };
    if (
      observedRevision !== undefined
      && row.content_revision !== observedRevision
    ) return { status: "changed" };
    return {
      status: "available",
      metadata: Object.freeze({
        memoryRef: row.id,
        logicalSourceRef: `memory:${row.id}`,
        contentRevision: row.content_revision,
        cryptoAccessRevision: row.crypto_access_revision,
        inputBinding: Object.freeze({
          objectId: row.crypto_object_id,
          namespaceId: input.namespaceId,
          objectType: "nautilo-memory-v1" as const,
        }),
      }),
    };
  }

  async #resolveMemory(input: Readonly<{
    lookup:
      | Readonly<{ kind: "memory"; memoryRef: string }>
      | Readonly<{ kind: "object"; objectId: string }>;
    namespaceId: string;
    signal?: AbortSignal;
  }>): Promise<ProtectedOrganizerMemoryMetadata | null> {
    input.signal?.throwIfAborted();
    const rows = await executeTypedCryptoQuery(
      this.ports.product,
      cryptoTypedDb.select({
        memoryId: memories.id,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
      })
        .from(memories)
        .innerJoin(
          memoryNamespaces,
          and(
            eq(memoryNamespaces.memoryId, memories.id),
            eq(memoryNamespaces.namespaceId, input.namespaceId),
          ),
        )
        .where(and(
          input.lookup.kind === "memory"
            ? eq(memories.id, input.lookup.memoryRef)
            : eq(memories.cryptoObjectId, input.lookup.objectId),
          lte(memories.tier, 2),
          eq(memories.cryptoMappingState, "verified"),
          isNotNull(memories.cryptoObjectId),
        ))
        .limit(2),
    );
    input.signal?.throwIfAborted();
    const row = rows[0];
    if (
      rows.length !== 1
      || row === undefined
      || typeof row.crypto_object_id !== "string"
      || (input.lookup.kind === "memory" && row.id !== input.lookup.memoryRef)
      || (input.lookup.kind === "object"
        && row.crypto_object_id !== input.lookup.objectId)
      || !positiveInteger(row.content_revision)
      || !nonnegativeInteger(row.crypto_access_revision)
    ) return null;
    return Object.freeze({
      memoryRef: row.id,
      logicalSourceRef: `memory:${row.id}`,
      contentRevision: row.content_revision,
      cryptoAccessRevision: row.crypto_access_revision,
      inputBinding: Object.freeze({
        objectId: row.crypto_object_id,
        namespaceId: input.namespaceId,
        objectType: "nautilo-memory-v1" as const,
      }),
    });
  }

  async searchMemories(input: Readonly<{
    roomAnchorRef: string;
    embedding: RecordEmbeddingV1;
    limit: number;
    signal?: AbortSignal;
  }>): Promise<ProtectedOrganizerMemoryMetadataResult> {
    input.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > CANDIDATE_POLICY_V1.sameRoomBound
    ) return { status: "unavailable" };
    assertCanonicalRecordEmbeddingV1(input.embedding);
    const room = await this.ports.rooms.resolveRoom(input.roomAnchorRef);
    input.signal?.throwIfAborted();
    if (room === null || room.roomId !== input.roomAnchorRef) {
      return { status: "unavailable" };
    }
    const provenance = input.embedding.provenance;
    if (
      provenance.provider !== "openai"
      && provenance.provider !== "openrouter"
      && provenance.provider !== "venice"
    ) return { status: "unavailable" };
    const vector = `[${input.embedding.vector.join(",")}]`;
    const score = sql<number>`1 - (${memories.embedding} <=> ${vector}::vector)`;
    const rows = await executeTypedCryptoQuery(
      this.ports.product,
      cryptoTypedDb.select({
        memoryId: memories.id,
        contentRevision: memories.contentRevision,
        cryptoAccessRevision: memories.cryptoAccessRevision,
        cryptoObjectId: memories.cryptoObjectId,
        score: score.as("score"),
      })
        .from(memories)
        .innerJoin(
          memoryNamespaces,
          and(
            eq(memoryNamespaces.memoryId, memories.id),
            eq(memoryNamespaces.namespaceId, room.namespaceId),
          ),
        )
        .where(and(
          lte(memories.tier, 2),
          isNotNull(memories.embedding),
          eq(memories.embeddingRevision, memories.contentRevision),
          eq(memories.embeddingProvider, provenance.provider),
          eq(memories.embeddingModel, provenance.canonicalModel),
          eq(memories.embeddingDimensions, provenance.dimensions),
          eq(memories.embeddingContractVersion, provenance.contractVersion),
          eq(memories.cryptoMappingState, "verified"),
          isNotNull(memories.cryptoObjectId),
        ))
        .orderBy(desc(score), asc(memories.id))
        .limit(input.limit),
    );
    input.signal?.throwIfAborted();
    const candidates: ProtectedOrganizerRankedMemoryMetadata[] = [];
    for (const row of rows) {
      if (
        typeof row.id !== "string"
        || typeof row.crypto_object_id !== "string"
        || !positiveInteger(row.content_revision)
        || !nonnegativeInteger(row.crypto_access_revision)
        || typeof row.score !== "number"
        || !Number.isFinite(row.score)
      ) return { status: "unavailable" };
      candidates.push(Object.freeze({
        score: canonicalizeCosineScore(row.score),
        memoryRef: row.id,
        logicalSourceRef: `memory:${row.id}`,
        contentRevision: row.content_revision,
        cryptoAccessRevision: row.crypto_access_revision,
        inputBinding: Object.freeze({
          objectId: row.crypto_object_id,
          namespaceId: room.namespaceId,
          objectType: "nautilo-memory-v1" as const,
        }),
      }));
    }
    return Object.freeze({
      status: "available" as const,
      candidates: Object.freeze(candidates),
    });
  }
}

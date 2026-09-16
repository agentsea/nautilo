import {
  and,
  acquireEncryptionPublicationFence,
  asc,
  eq,
  isNull,
  or,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityProjections,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecordPublications,
  reflectionRecords,
  roomEventRollups,
  roomJournalState,
  rooms,
  roomEvents,
  sql,
} from "@nautilo/db";

import { encodeRoomEventPayloadV1 } from
  "../../journal/room-event-payload-v1.ts";
import { encodeRoomEventRollupPayloadV1 } from
  "../../journal/room-event-rollup-payload-v1.ts";
import type {
  ForegroundJournalSelectedEvent,
  ForegroundJournalSelectedRollup,
  ForegroundJournalSelectionSnapshot,
} from "../../journal/foreground-journal-selection.ts";
import {
  ForegroundAuthorityConvergingError,
  ForegroundProductChangedError,
} from "../foreground-product-changed.ts";
import {
  conversationProductTypedDb,
  executeTypedConversationProductQuery,
  type ConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionRunner,
} from "../message/postgres-conversation-product-store.ts";

export const FOREGROUND_JOURNAL_EVENT_OBJECT_TYPE = "room_event";
export const FOREGROUND_JOURNAL_ROLLUP_OBJECT_TYPE = "room_event_rollup";
export const FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE =
  "nautilo.reflection.record.v1";

export type ForegroundJournalRepairSource = Readonly<{
  representationMode?: "ordinary-and-protected" | "protected-only";
  kind: "event" | "rollup";
  logicalId: string;
  objectType: string;
  existingObjectId: string | null;
  createdAt: number;
  plaintextBytes: Uint8Array | null;
  accessNamespaceIds: readonly string[];
  representationGeneration: number;
  ordinaryRepresentationGeneration: number | null;
  authorityProjectionGeneration: number | null;
  ordinaryText: string | null;
  selection: ForegroundJournalSelectedEvent | ForegroundJournalSelectedRollup;
}> & (
  | Readonly<{kind: "event"; authorityKind: "journal_source"}>
  | Readonly<{kind: "rollup"; authorityKind?: "journal_source"}>
);

export type ForegroundRecordRepairSource = Readonly<{
  authorityKind?: "record_projection";
  recordRef: string;
  expectedStatement: string | null;
  representationMode?: "ordinary-and-protected" | "protected-only";
  lifecycle: "current" | "stale" | "superseded" | "resolved";
  structuralHeight: number;
  processingGeneration: number;
  existingObjectId: string | null;
  accessNamespaceIds: readonly string[];
  ordinaryRepresentationGeneration: number;
  representationGeneration: number;
  authorityProjectionGeneration: number;
  createdAt: number;
  plaintextBytes: Uint8Array | null;
}>;

type ProductTransaction = Parameters<
  Parameters<ConversationProductPostgresHandle["transaction"]>[0]
>[0];

type RecordAuthoritySnapshot = Readonly<{
  projectionGeneration: number;
  accessNamespaceIds: readonly string[];
  representationGeneration: number;
  existingObjectId: string | null;
}>;

function exactDate(value: unknown): number {
  const result = value instanceof Date ? value.getTime()
    : typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(result)) throw new TypeError("Product timestamp is invalid");
  return result;
}

function equalBytes(left: unknown, right: Uint8Array): boolean {
  return left instanceof Uint8Array
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function equalStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function equalNumbers(left: unknown, right: readonly number[]): boolean {
  const values = Array.isArray(left) ? left : [];
  return values.length === right.length
    && values.every((value, index) => value === right[index]);
}

async function recordProductStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  source: Readonly<{
    recordRef: string;
    lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
    structuralHeight: number;
    processingGeneration: number;
    ordinaryRepresentationGeneration: number;
    plaintextBytes: Uint8Array;
  }>;
}>): Promise<boolean> {
  const rows = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      lifecycle: reflectionRecords.lifecycle,
      structuralHeight: reflectionRecords.structuralHeight,
      processingGeneration: reflectionRecords.processingGeneration,
      disposition: reflectionRecords.disposition,
      generation:
        reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
      payloadBytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
    }).from(reflectionRecords).innerJoin(
      reflectionRecordPayloadRepresentationHeads,
      and(
        eq(
          reflectionRecordPayloadRepresentationHeads.recordId,
          reflectionRecords.recordId,
        ),
        eq(
          reflectionRecordPayloadRepresentationHeads.representation,
          "ordinary",
        ),
      ),
    ).innerJoin(reflectionRecordPayloadRepresentations, and(
      eq(
        reflectionRecordPayloadRepresentations.recordId,
        reflectionRecordPayloadRepresentationHeads.recordId,
      ),
      eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
      eq(
        reflectionRecordPayloadRepresentations.representationGeneration,
        reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
      ),
    )).where(eq(reflectionRecords.recordId, input.source.recordRef)).limit(2));
  const row = rows[0];
  return rows.length === 1
    && row !== undefined
    && row.lifecycle === input.source.lifecycle
    && row.structural_height === input.source.structuralHeight
    && row.processing_generation === input.source.processingGeneration
    && row.disposition === "available"
    && row.current_representation_generation
      === input.source.ordinaryRepresentationGeneration
    && equalBytes(row.plaintext_payload_bytes, input.source.plaintextBytes);
}

/** Journal authority follows its source Room, independently of Record projections. */
async function journalScopeStillCurrent(
  tx: ProductTransaction,
  selected: ForegroundJournalSelectedEvent | ForegroundJournalSelectedRollup,
): Promise<boolean> {
  const rows = await executeTypedConversationProductQuery(tx,
    conversationProductTypedDb.select({
      namespaceId: rooms.namespaceId,
      rebuildGeneration: roomJournalState.rebuildGeneration,
      rebuildRequestedAt: roomJournalState.rebuildRequestedAt,
      rebuildTargetMessageId: roomJournalState.rebuildTargetMessageId,
    }).from(roomJournalState).innerJoin(rooms, eq(rooms.id, roomJournalState.roomId))
      .where(eq(roomJournalState.roomId, selected.binding.roomId)).limit(2)
      .for("share"));
  return rows.length === 1
    && rows[0]?.namespace_id === selected.binding.namespaceId
    && rows[0]?.rebuild_generation === selected.rebuildGeneration
    && rows[0]?.rebuild_requested_at === null
    && rows[0]?.rebuild_target_message_id === null;
}

async function loadNativeJournalAuthority(input: Readonly<{
  tx: ProductTransaction;
  selected: ForegroundJournalSelectedEvent;
}>): Promise<Pick<RecordAuthoritySnapshot, "representationGeneration" | "existingObjectId" | "accessNamespaceIds">> {
  const selected = input.selected;
  if (selected.payload.kind !== "reflection_record"
    || selected.payload.recordId !== selected.binding.eventId
    || !await journalScopeStillCurrent(input.tx, selected)) {
    throw new ForegroundProductChangedError("Native Journal source authority changed");
  }
  const rows = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      lifecycle: reflectionRecords.lifecycle,
      structuralHeight: reflectionRecords.structuralHeight,
      processingGeneration: reflectionRecords.processingGeneration,
      producerPolicyVersion: reflectionRecords.producerPolicyVersion,
      payloadVersion: reflectionRecords.payloadVersion,
      disposition: reflectionRecords.disposition,
    }).from(reflectionRecords).where(eq(reflectionRecords.recordId, selected.payload.recordId))
      .limit(2).for("share"));
  const row = rows[0];
  if (rows.length !== 1 || row === undefined
    || row.lifecycle !== selected.payload.lifecycle
    || row.structural_height !== selected.payload.structuralHeight
    || row.processing_generation !== selected.payload.processingGeneration
    || row.producer_policy_version !== selected.binding.extractorVersion
    || row.payload_version !== 1 || row.disposition !== "available") {
    throw new ForegroundProductChangedError("Native Journal Record metadata changed");
  }
  const mapping = await loadProtectedRecordMapping({
    tx: input.tx, recordRef: selected.payload.recordId, journalSource: true,
  });
  if (mapping.existingObjectId === null) {
    const generation = selected.payload.ordinaryRepresentationGeneration;
    const completed = generation === null ? [] : await executeTypedConversationProductQuery(input.tx,
      conversationProductTypedDb.select({publicationId: reflectionRecordPublications.publicationId})
        .from(reflectionRecordPublications).where(and(
          eq(reflectionRecordPublications.recordId, selected.payload.recordId),
          eq(reflectionRecordPublications.representation, "ordinary"),
          eq(reflectionRecordPublications.representationGeneration, generation),
          eq(reflectionRecordPublications.state, "complete"),
        )).limit(1));
    if (completed.length !== 1) {
      throw new ForegroundProductChangedError("Native Journal ordinary publication is incomplete");
    }
  }
  return Object.freeze({...mapping,
    accessNamespaceIds: mapping.reconciledAccessNamespaceIds ?? Object.freeze([selected.binding.namespaceId])});
}

async function nativeJournalSourceStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  source: ForegroundJournalRepairSource;
  targetObjectId: string;
}>): Promise<boolean> {
  const {source} = input;
  if (source.authorityKind !== "journal_source" || source.selection.kind !== "event"
    || source.selection.payload.kind !== "reflection_record"
    || source.logicalId !== source.selection.payload.recordId
    || source.authorityProjectionGeneration !== null
    || !await journalEventStillCurrent(input)) return false;
  const authority = await loadNativeJournalAuthority({tx: input.tx, selected: source.selection});
  return equalStrings(authority.accessNamespaceIds, source.accessNamespaceIds)
    && authority.representationGeneration === source.representationGeneration
    && (authority.existingObjectId === source.existingObjectId
      || (source.existingObjectId === null && authority.existingObjectId === input.targetObjectId));
}

async function journalRollupStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  source: ForegroundJournalRepairSource;
  targetObjectId: string;
}>): Promise<boolean> {
  if (input.source.selection.kind !== "rollup"
    || !await journalScopeStillCurrent(input.tx, input.source.selection)) return false;
  const selected = input.source.selection;
  const rows = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      roomId: roomEventRollups.roomId,
      throughEventSequence: roomEventRollups.throughEventSequence,
      ...(input.source.representationMode === "protected-only"
        ? {}
        : { content: roomEventRollups.content }),
      sourceEventCount: roomEventRollups.sourceEventCount,
      modelId: roomEventRollups.modelId,
      compactorVersion: roomEventRollups.compactorVersion,
      cryptoObjectId: roomEventRollups.cryptoObjectId,
      createdAt: roomEventRollups.createdAt,
    }).from(roomEventRollups).where(eq(
      roomEventRollups.id,
      selected.binding.rollupId,
    )).limit(2));
  const row = rows[0];
  return rows.length === 1
    && row !== undefined
    && row.room_id === selected.binding.roomId
    && row.through_event_sequence === selected.binding.throughEventSequence
    && (
      input.source.representationMode === "protected-only"
      || row.content === input.source.ordinaryText
    )
    && row.source_event_count === selected.binding.sourceEventCount
    && row.model_id === selected.binding.modelId
    && row.compactor_version === selected.binding.compactorVersion
    && (
      row.crypto_object_id === input.source.existingObjectId
      || (
        input.source.existingObjectId === null
        && row.crypto_object_id === input.targetObjectId
      )
    )
    && exactDate(row.created_at) === input.source.createdAt;
}

async function journalEventStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  source: ForegroundJournalRepairSource;
  targetObjectId: string;
}>): Promise<boolean> {
  if (input.source.selection.kind !== "event"
    || !await journalScopeStillCurrent(input.tx, input.source.selection)) return false;
  const selected = input.source.selection;
  const binding = selected.binding;
  const rows = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      roomId: roomEvents.roomId,
      sequence: roomEvents.sequence,
      kind: roomEvents.kind,
      ...(input.source.representationMode === "protected-only"
        ? {}
        : { statement: roomEvents.statement }),
      status: roomEvents.status,
      supersedesEventId: roomEvents.supersedesEventId,
      resolvesEventId: roomEvents.resolvesEventId,
      sourceMessageIds: roomEvents.sourceMessageIds,
      sourceBatchId: roomEvents.sourceBatchId,
      batchLocalOrdinal: roomEvents.batchLocalOrdinal,
      extractorVersion: roomEvents.extractorVersion,
      projectionKind: roomEvents.projectionKind,
      recordId: roomEvents.recordId,
      cryptoObjectId: roomEvents.cryptoObjectId,
      createdAt: roomEvents.createdAt,
    }).from(roomEvents).where(eq(roomEvents.id, binding.eventId)).limit(2).for("share"));
  const row = rows[0];
  const legacy = selected.payload.kind === "legacy_event";
  return rows.length === 1
    && row !== undefined
    && row.room_id === binding.roomId
    && row.sequence === binding.sequence
    && row.kind === binding.kind
    && (
      input.source.representationMode === "protected-only"
      || row.statement === (legacy ? input.source.ordinaryText : null)
    )
    && row.status === selected.status
    && row.supersedes_event_id === binding.supersedesEventId
    && row.resolves_event_id === binding.resolvesEventId
    && equalNumbers(row.source_message_ids, binding.sourceMessageIds)
    && row.source_batch_id === binding.sourceBatchId
    && row.batch_local_ordinal === binding.batchLocalOrdinal
    && row.extractor_version === binding.extractorVersion
    && row.projection_kind === (legacy ? "legacy" : "native")
    && row.record_id === (legacy ? null : selected.payload.recordId)
    && row.crypto_object_id === (
      legacy
        ? input.source.existingObjectId ?? input.targetObjectId
        : null
    )
    && exactDate(row.created_at) === Date.parse(binding.createdAt);
}

async function loadRecordAuthoritySnapshot(input: Readonly<{
  tx: ProductTransaction;
  recordRef: string;
}>): Promise<RecordAuthoritySnapshot> {
  const projections = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      projectionGeneration:
        reflectionRecordAuthorityProjections.projectionGeneration,
      processingState: reflectionRecordAuthorityProjections.processingState,
      disposition: reflectionRecords.disposition,
    }).from(reflectionRecordAuthorityProjections)
      .innerJoin(
        reflectionRecords,
        eq(reflectionRecords.recordId, reflectionRecordAuthorityProjections.recordId),
      )
      .where(and(
        eq(reflectionRecordAuthorityProjections.recordId, input.recordRef),
        eq(reflectionRecordAuthorityProjections.current, true),
      )).limit(2));
  if (projections.length === 0) {
    throw new ForegroundAuthorityConvergingError(
      "Reflection Record authority is not materialized",
    );
  }
  if (projections.length !== 1) {
    throw new ForegroundProductChangedError(
      "Reflection Record authority is duplicated",
    );
  }
  const projection = projections[0]!;
  if (
    projection.processing_state === "dirty"
    || projection.processing_state === "reconciling"
  ) throw new ForegroundAuthorityConvergingError(
    "Reflection Record authority is converging",
  );
  if (
    projection.processing_state !== "current"
    || projection.disposition !== "available"
  ) throw new ForegroundProductChangedError(
    "Reflection Record authority is unavailable",
  );
  const alternatives = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      namespaceId: reflectionRecordAuthorityAlternatives.accessNamespaceId,
    }).from(reflectionRecordAuthorityAlternatives)
      .where(and(
        eq(reflectionRecordAuthorityAlternatives.recordId, input.recordRef),
        eq(
          reflectionRecordAuthorityAlternatives.projectionGeneration,
          projection.projection_generation,
        ),
      )).orderBy(asc(
        reflectionRecordAuthorityAlternatives.alternativeOrdinal,
      )));
  const accessNamespaceIds = alternatives.map((row) => row.access_namespace_id);
  const canonical = [...new Set(accessNamespaceIds)].sort();
  if (
    canonical.length < 1
    || canonical.length !== accessNamespaceIds.length
  ) throw new ForegroundProductChangedError(
    "Reflection Record authority is incomplete",
  );
  const mapping = await loadProtectedRecordMapping(input);
  return Object.freeze({
    projectionGeneration: projection.projection_generation,
    accessNamespaceIds: Object.freeze(canonical),
    ...mapping,
  });
}

async function loadProtectedRecordMapping(input: Readonly<{
  tx: ProductTransaction;
  recordRef: string;
  journalSource?: boolean;
}>): Promise<Pick<RecordAuthoritySnapshot, "representationGeneration" | "existingObjectId"> & Readonly<{
  reconciledAccessNamespaceIds?: readonly string[];
}>> {
  const protectedRows = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      generation:
        reflectionRecordPayloadRepresentations.representationGeneration,
      objectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
    }).from(reflectionRecordPayloadRepresentations)
      .innerJoin(reflectionRecordPayloadRepresentationHeads, and(
        eq(
          reflectionRecordPayloadRepresentationHeads.recordId,
          reflectionRecordPayloadRepresentations.recordId,
        ),
        eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
        eq(
          reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
          reflectionRecordPayloadRepresentations.representationGeneration,
        ),
      )).where(and(
        eq(reflectionRecordPayloadRepresentations.recordId, input.recordRef),
        eq(reflectionRecordPayloadRepresentations.representation, "protected"),
      )).limit(2));
  if (protectedRows.length > 1) throw new ForegroundProductChangedError(
    "Reflection Record protected head is duplicated",
  );
  const protectedRow = protectedRows[0];
  const existingObjectId = protectedRow?.crypto_object_id ?? null;
  if (protectedRow !== undefined && existingObjectId === null) {
    throw new ForegroundProductChangedError(
      "Reflection Record protected head is incomplete",
    );
  }
  let reconciledAccessNamespaceIds: readonly string[] | undefined;
  if (protectedRow !== undefined) {
    const completed = await executeTypedConversationProductQuery(input.tx,
      conversationProductTypedDb.select({
        publicationId: reflectionRecordPublications.publicationId,
      }).from(reflectionRecordPublications).where(and(
        eq(reflectionRecordPublications.recordId, input.recordRef),
        eq(reflectionRecordPublications.representation, "protected"),
        eq(
          reflectionRecordPublications.representationGeneration,
          protectedRow.representation_generation,
        ),
        eq(reflectionRecordPublications.cryptoObjectId, existingObjectId!),
        eq(reflectionRecordPublications.state, "complete"),
      )).limit(1));
    const reconciled = completed.length > 0
      ? []
      : await executeTypedConversationProductQuery(input.tx,
          conversationProductTypedDb.select({
            reconciliationId:
              reflectionRecordAuthorityReconciliations.reconciliationId,
            targetAccessNamespaceIds: reflectionRecordAuthorityReconciliations.targetAccessNamespaceIds,
          }).from(reflectionRecordAuthorityReconciliations).where(and(
            eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
            eq(
              reflectionRecordAuthorityReconciliations.targetRepresentationGeneration,
              protectedRow.representation_generation,
            ),
            eq(
              reflectionRecordAuthorityReconciliations.targetCryptoObjectId,
              existingObjectId!,
            ),
            eq(reflectionRecordAuthorityReconciliations.state, "complete"),
            isNull(reflectionRecordAuthorityReconciliations.targetCryptoRetiredAt),
          )).limit(2));
    if (reconciled.length > 1) throw new ForegroundProductChangedError("Record reconciliation binding is ambiguous");
    if (input.journalSource === true && reconciled.length === 1) {
      // Journal admission stays bound to its source Room. Reprojection changes
      // only the encrypted representation's exact Namespace set; the entity
      // opener independently checks current authority for that set.
      const namespaces = reconciled[0]!.target_access_namespace_ids;
      if (!Array.isArray(namespaces) || namespaces.length === 0
        || namespaces.some(namespace => typeof namespace !== "string" || namespace.length === 0)
        || !equalStrings(namespaces, [...new Set(namespaces)].sort())) {
        throw new ForegroundProductChangedError("Journal Record reconciliation binding is incomplete");
      }
      reconciledAccessNamespaceIds = Object.freeze([...namespaces]);
    }
    if (completed.length === 0 && reconciled.length === 0) {
      throw new ForegroundProductChangedError(
        "Reflection Record protected publication is incomplete",
      );
    }
  }
  return Object.freeze({
    representationGeneration: protectedRow?.representation_generation ?? 1,
    existingObjectId,
    ...(reconciledAccessNamespaceIds === undefined ? {} : {reconciledAccessNamespaceIds}),
  });
}

async function authorityStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  recordRef: string;
  projectionGeneration: number;
  accessNamespaceIds: readonly string[];
}>): Promise<boolean> {
  const current = await loadRecordAuthoritySnapshot(input);
  return current.projectionGeneration === input.projectionGeneration
    && current.accessNamespaceIds.length === input.accessNamespaceIds.length
    && current.accessNamespaceIds.every(
      (namespaceId, index) => namespaceId === input.accessNamespaceIds[index],
    );
}

/** Load bytes only for the exact content-free Journal snapshot. */
export async function loadPostgresForegroundJournalRepairSources(input: Readonly<{
  product: ConversationProductPostgresHandle;
  snapshot: ForegroundJournalSelectionSnapshot;
  representationMode?: "ordinary-and-protected" | "protected-only";
}>): Promise<readonly ForegroundJournalRepairSource[]> {
  return input.product.transaction(tx => loadPostgresForegroundJournalRepairSourcesWithinTransaction(tx, input),
    { isolationLevel: "serializable" });
}

/** Same confidential loader under the caller's current policy/Room locks. */
export async function loadPostgresForegroundJournalRepairSourcesWithinTransaction(
  tx: ProductTransaction,
  input: Omit<Parameters<typeof loadPostgresForegroundJournalRepairSources>[0], "product">,
): Promise<readonly ForegroundJournalRepairSource[]> {
  const representationMode = input.representationMode
    ?? "ordinary-and-protected";
    const sources: ForegroundJournalRepairSource[] = [];
    for (const selected of [input.snapshot.rollup, ...input.snapshot.events]) {
      if (selected === null) continue;
      if (selected.binding.roomId !== input.snapshot.roomId
        || selected.binding.namespaceId !== input.snapshot.namespaceId
        || selected.rebuildGeneration !== input.snapshot.rebuildGeneration
        || !await journalScopeStillCurrent(tx, selected)) {
        throw new ForegroundProductChangedError("Selected Journal Room changed");
      }
    }
    try {
      if (input.snapshot.rollup !== null) {
        const selected = input.snapshot.rollup;
        const rows = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            ...(representationMode === "ordinary-and-protected"
              ? { content: roomEventRollups.content }
              : {}),
            createdAt: roomEventRollups.createdAt,
            cryptoObjectId: roomEventRollups.cryptoObjectId,
            sourceEventCount: roomEventRollups.sourceEventCount,
            modelId: roomEventRollups.modelId,
            compactorVersion: roomEventRollups.compactorVersion,
          }).from(roomEventRollups).where(and(
            eq(roomEventRollups.id, selected.binding.rollupId),
            eq(roomEventRollups.roomId, input.snapshot.roomId),
            eq(
              roomEventRollups.throughEventSequence,
              selected.binding.throughEventSequence,
            ),
          )).limit(2));
        const row = rows[0];
        if (
          rows.length !== 1
          || row === undefined
          || exactDate(row.created_at) !== Date.parse(selected.binding.createdAt)
          || row.source_event_count !== selected.binding.sourceEventCount
          || row.model_id !== selected.binding.modelId
          || row.compactor_version !== selected.binding.compactorVersion
        ) throw new ForegroundProductChangedError("Selected Journal rollup changed");
        const ordinaryContent = typeof row.content === "string" ? row.content : null;
        sources.push(Object.freeze({
            authorityKind: "journal_source" as const,
          representationMode,
          kind: "rollup" as const,
          logicalId: selected.binding.rollupId,
          objectType: FOREGROUND_JOURNAL_ROLLUP_OBJECT_TYPE,
          existingObjectId: row.crypto_object_id,
          createdAt: exactDate(row.created_at),
          plaintextBytes: representationMode === "protected-only" || ordinaryContent === null ? null
            : encodeRoomEventRollupPayloadV1({
            ...selected.binding,
            content: ordinaryContent,
          }),
          accessNamespaceIds: Object.freeze([input.snapshot.namespaceId]),
          representationGeneration: input.snapshot.rebuildGeneration,
          ordinaryRepresentationGeneration: null,
          authorityProjectionGeneration: null,
          ordinaryText: representationMode === "protected-only" ? null : ordinaryContent,
          selection: selected,
        }));
      }
      for (const selected of input.snapshot.events) {
        const rows = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            ...(representationMode === "ordinary-and-protected"
              ? { statement: roomEvents.statement }
              : {}),
            createdAt: roomEvents.createdAt,
            cryptoObjectId: roomEvents.cryptoObjectId,
            kind: roomEvents.kind,
            status: roomEvents.status,
            projectionKind: roomEvents.projectionKind,
            recordId: roomEvents.recordId,
            supersedesEventId: roomEvents.supersedesEventId,
            resolvesEventId: roomEvents.resolvesEventId,
            sourceMessageIds: roomEvents.sourceMessageIds,
            sourceBatchId: roomEvents.sourceBatchId,
            batchLocalOrdinal: roomEvents.batchLocalOrdinal,
            extractorVersion: roomEvents.extractorVersion,
          }).from(roomEvents).where(and(
            eq(roomEvents.id, selected.binding.eventId),
            eq(roomEvents.roomId, input.snapshot.roomId),
            eq(roomEvents.sequence, selected.binding.sequence),
          )).limit(2));
        const row = rows[0];
        const binding = selected.binding;
        if (
          rows.length !== 1
          || row === undefined
          || exactDate(row.created_at) !== Date.parse(binding.createdAt)
          || row.kind !== binding.kind
          || row.status !== selected.status
          || row.supersedes_event_id !== binding.supersedesEventId
          || row.resolves_event_id !== binding.resolvesEventId
          || row.source_batch_id !== binding.sourceBatchId
          || row.batch_local_ordinal !== binding.batchLocalOrdinal
          || row.extractor_version !== binding.extractorVersion
          || !equalNumbers(row.source_message_ids, binding.sourceMessageIds)
        ) throw new ForegroundProductChangedError("Selected Journal event changed");
        if (selected.payload.kind === "legacy_event") {
          if (row.projection_kind !== "legacy" || row.record_id !== null) {
            throw new ForegroundProductChangedError(
              "Selected legacy Journal event changed",
            );
          }
          const ordinaryStatement = typeof row.statement === "string" ? row.statement : null;
          sources.push(Object.freeze({
            authorityKind: "journal_source" as const,
            representationMode,
            kind: "event" as const,
            logicalId: binding.eventId,
            objectType: FOREGROUND_JOURNAL_EVENT_OBJECT_TYPE,
            existingObjectId: row.crypto_object_id,
            createdAt: exactDate(row.created_at),
            plaintextBytes: representationMode === "protected-only" || ordinaryStatement === null ? null
              : encodeRoomEventPayloadV1({
              ...binding,
              statement: ordinaryStatement,
            }),
            accessNamespaceIds: Object.freeze([input.snapshot.namespaceId]),
            representationGeneration: input.snapshot.rebuildGeneration,
            ordinaryRepresentationGeneration: null,
            authorityProjectionGeneration: null,
            ordinaryText: representationMode === "protected-only" ? null : ordinaryStatement,
            selection: selected,
          }));
          continue;
        }
        if (
          row.projection_kind !== "native"
          || row.crypto_object_id !== null
          || (representationMode === "ordinary-and-protected" && row.statement !== null)
          || row.record_id !== selected.payload.recordId
        ) throw new ForegroundProductChangedError(
          "Selected native Journal event changed",
        );
        if (representationMode === "protected-only") {
          const recordRows = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.select({
              lifecycle: reflectionRecords.lifecycle,
              structuralHeight: reflectionRecords.structuralHeight,
              processingGeneration: reflectionRecords.processingGeneration,
              disposition: reflectionRecords.disposition,
              createdAt: reflectionRecords.createdAt,
            }).from(reflectionRecords).where(eq(
              reflectionRecords.recordId,
              selected.payload.recordId,
            )).limit(2));
          const record = recordRows[0];
          if (
            recordRows.length !== 1
            || record === undefined
            || record.lifecycle !== selected.payload.lifecycle
            || record.structural_height !== selected.payload.structuralHeight
            || record.processing_generation !== selected.payload.processingGeneration
            || record.disposition !== "available"
          ) throw new ForegroundProductChangedError(
            "Selected Journal Record changed",
          );
          const authority = await loadNativeJournalAuthority({tx, selected});
          if (
            selected.payload.protectedMapping.status === "mapped"
              ? authority.existingObjectId
                  !== selected.payload.protectedMapping.cryptoObjectId
                || authority.representationGeneration
                  !== selected.payload.protectedMapping.representationGeneration
              : authority.existingObjectId !== null
          ) throw new ForegroundProductChangedError(
            "Selected Journal Record protected head changed",
          );
          sources.push(Object.freeze({
            authorityKind: "journal_source" as const,
            representationMode,
            kind: "event" as const,
            logicalId: selected.payload.recordId,
            objectType: FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
            existingObjectId: authority.existingObjectId,
            createdAt: exactDate(record.created_at),
            plaintextBytes: null,
            accessNamespaceIds: authority.accessNamespaceIds,
            representationGeneration: authority.representationGeneration,
            // Protected-only selection must not manufacture an ordinary head
            // coordinate for a native Record that has never had one.
            ordinaryRepresentationGeneration: null,
            authorityProjectionGeneration: null,
            ordinaryText: null,
            selection: selected,
          }));
          continue;
        }
        const payloadRows = selected.payload.ordinaryRepresentationGeneration === null
          ? []
          : await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            payloadBytes:
              reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
            createdAt: reflectionRecordPayloadRepresentations.createdAt,
            lifecycle: reflectionRecords.lifecycle,
            structuralHeight: reflectionRecords.structuralHeight,
            processingGeneration: reflectionRecords.processingGeneration,
            disposition: reflectionRecords.disposition,
            currentGeneration:
              reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
          }).from(reflectionRecordPayloadRepresentations).innerJoin(
            reflectionRecordPayloadRepresentationHeads,
            and(
              eq(
                reflectionRecordPayloadRepresentationHeads.recordId,
                reflectionRecordPayloadRepresentations.recordId,
              ),
              eq(
                reflectionRecordPayloadRepresentationHeads.representation,
                "ordinary",
              ),
            ),
          ).innerJoin(reflectionRecords, eq(
            reflectionRecords.recordId,
            reflectionRecordPayloadRepresentations.recordId,
          )).where(and(
            eq(
              reflectionRecordPayloadRepresentations.recordId,
              selected.payload.recordId,
            ),
            eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
            eq(
              reflectionRecordPayloadRepresentations.representationGeneration,
              selected.payload.ordinaryRepresentationGeneration,
            ),
          )).limit(2));
        const bytes = payloadRows[0]?.plaintext_payload_bytes;
        const payloadRow = payloadRows[0];
        if (
          payloadRows.length === 0
          && selected.payload.ordinaryRepresentationGeneration === null
          && selected.payload.protectedMapping.status === "mapped"
        ) {
          const recordRows = await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.select({
              lifecycle: reflectionRecords.lifecycle,
              structuralHeight: reflectionRecords.structuralHeight,
              processingGeneration: reflectionRecords.processingGeneration,
              disposition: reflectionRecords.disposition,
              createdAt: reflectionRecords.createdAt,
            }).from(reflectionRecords).where(eq(
              reflectionRecords.recordId, selected.payload.recordId,
            )).limit(2));
          const record = recordRows[0];
          if (recordRows.length !== 1 || record === undefined
            || record.lifecycle !== selected.payload.lifecycle
            || record.structural_height !== selected.payload.structuralHeight
            || record.processing_generation !== selected.payload.processingGeneration
            || record.disposition !== "available") throw new ForegroundProductChangedError(
              "Selected Journal Record changed",
            );
          const authority = await loadNativeJournalAuthority({tx, selected});
          if (authority.existingObjectId
            !== selected.payload.protectedMapping.cryptoObjectId
            || authority.representationGeneration !== selected.payload.protectedMapping.representationGeneration) {
            throw new ForegroundProductChangedError(
              "Selected Journal Record protected head changed",
            );
          }
          sources.push(Object.freeze({
            authorityKind: "journal_source" as const,
            representationMode,
            kind: "event" as const,
            logicalId: selected.payload.recordId,
            objectType: FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
            existingObjectId: authority.existingObjectId,
            createdAt: exactDate(record.created_at),
            plaintextBytes: null,
            accessNamespaceIds: authority.accessNamespaceIds,
            representationGeneration: authority.representationGeneration,
            ordinaryRepresentationGeneration: null,
            authorityProjectionGeneration: null,
            ordinaryText: null,
            selection: selected,
          }));
          continue;
        }
        if (
          payloadRows.length !== 1
          || payloadRow === undefined
          || !(bytes instanceof Uint8Array)
          || payloadRow.current_representation_generation
            !== selected.payload.ordinaryRepresentationGeneration
          || payloadRow.lifecycle !== selected.payload.lifecycle
          || payloadRow.structural_height !== selected.payload.structuralHeight
          || payloadRow.processing_generation
            !== selected.payload.processingGeneration
          || payloadRow.disposition !== "available"
        ) {
          throw new ForegroundProductChangedError(
            "Selected Journal Record plaintext changed",
          );
        }
        const authority = await loadNativeJournalAuthority({tx, selected});
        if (
          selected.payload.protectedMapping.status === "mapped"
            ? authority.existingObjectId !== selected.payload.protectedMapping.cryptoObjectId
              || authority.representationGeneration !== selected.payload.protectedMapping.representationGeneration
            : authority.existingObjectId !== null
        ) throw new ForegroundProductChangedError(
          "Selected Journal Record protected head changed",
        );
        sources.push(Object.freeze({
            authorityKind: "journal_source" as const,
          representationMode,
          kind: "event" as const,
          logicalId: selected.payload.recordId,
          objectType: FOREGROUND_REFLECTION_RECORD_OBJECT_TYPE,
          existingObjectId: authority.existingObjectId,
          createdAt: exactDate(payloadRow.created_at),
          plaintextBytes: Uint8Array.from(bytes),
          accessNamespaceIds: authority.accessNamespaceIds,
          representationGeneration: authority.representationGeneration,
          ordinaryRepresentationGeneration:
            selected.payload.ordinaryRepresentationGeneration,
          authorityProjectionGeneration: null,
          ordinaryText: null,
          selection: selected,
        }));
      }
      return Object.freeze(sources);
    } catch (error) {
      sources.forEach((source) => source.plaintextBytes?.fill(0));
      throw error;
    }
}

/** Resolve exact ordinary bytes and current authority for selected Records. */
export async function loadPostgresForegroundRecordRepairSources(input: Readonly<{
  product: ConversationProductPostgresHandle;
  records: readonly Readonly<{
    recordRef: string;
    lifecycle?: "current" | "stale" | "superseded" | "resolved";
    structuralHeight: number;
    statement?: string;
  }>[];
  representationMode?: "ordinary-and-protected" | "protected-only";
}>): Promise<readonly ForegroundRecordRepairSource[]> {
  const representationMode = input.representationMode
    ?? "ordinary-and-protected";
  return input.product.transaction(async (tx) => {
    const sources: ForegroundRecordRepairSource[] = [];
    for (const expected of input.records) {
      if (representationMode === "protected-only" || !("statement" in expected)) {
        const rows = await executeTypedConversationProductQuery(tx,
          conversationProductTypedDb.select({
            lifecycle: reflectionRecords.lifecycle,
            structuralHeight: reflectionRecords.structuralHeight,
            processingGeneration: reflectionRecords.processingGeneration,
            disposition: reflectionRecords.disposition,
            createdAt: reflectionRecords.createdAt,
          }).from(reflectionRecords).where(eq(
            reflectionRecords.recordId,
            expected.recordRef,
          )).limit(2));
        const row = rows[0];
        if (
          rows.length !== 1
          || row === undefined
          || row.lifecycle === "sunset"
          || (
            expected.lifecycle !== undefined
            && row.lifecycle !== expected.lifecycle
          )
          || row.structural_height !== expected.structuralHeight
          || row.disposition !== "available"
        ) throw new ForegroundProductChangedError(
          "Selected Reflection Record changed",
        );
        const authority = await loadRecordAuthoritySnapshot({
          tx,
          recordRef: expected.recordRef,
        });
        const ordinaryRows = representationMode === "protected-only" ? []
          : await executeTypedConversationProductQuery(tx,
            conversationProductTypedDb.select({
              generation: reflectionRecordPayloadRepresentations.representationGeneration,
              bytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
            }).from(reflectionRecordPayloadRepresentations).innerJoin(
              reflectionRecordPayloadRepresentationHeads, and(
                eq(reflectionRecordPayloadRepresentationHeads.recordId,
                  reflectionRecordPayloadRepresentations.recordId),
                eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
                eq(reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
                  reflectionRecordPayloadRepresentations.representationGeneration),
              ),
            ).where(and(
              eq(reflectionRecordPayloadRepresentations.recordId, expected.recordRef),
              eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
            )).limit(2));
        if (ordinaryRows.length > 1) throw new ForegroundProductChangedError(
          "Selected Reflection Record ordinary head is duplicated",
        );
        const ordinary = ordinaryRows[0];
        if (ordinary !== undefined && !(ordinary.plaintext_payload_bytes instanceof Uint8Array)) {
          throw new ForegroundProductChangedError(
            "Selected Reflection Record ordinary payload is incomplete",
          );
        }
        sources.push(Object.freeze({
          authorityKind: "record_projection" as const,
          recordRef: expected.recordRef,
          expectedStatement: null,
          representationMode,
          lifecycle: row.lifecycle,
          structuralHeight: expected.structuralHeight,
          processingGeneration: row.processing_generation,
          existingObjectId: authority.existingObjectId,
          accessNamespaceIds: authority.accessNamespaceIds,
          ordinaryRepresentationGeneration:
            ordinary?.representation_generation ?? authority.representationGeneration,
          representationGeneration: authority.representationGeneration,
          authorityProjectionGeneration: authority.projectionGeneration,
          createdAt: exactDate(row.created_at),
          plaintextBytes: ordinary?.plaintext_payload_bytes instanceof Uint8Array
            ? ordinary.plaintext_payload_bytes.slice() : null,
        }));
        continue;
      }
      const heads = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          generation:
            reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
          lifecycle: reflectionRecords.lifecycle,
          structuralHeight: reflectionRecords.structuralHeight,
          processingGeneration: reflectionRecords.processingGeneration,
        }).from(reflectionRecordPayloadRepresentationHeads)
          .innerJoin(reflectionRecords, eq(
            reflectionRecords.recordId,
            reflectionRecordPayloadRepresentationHeads.recordId,
          )).where(and(
            eq(
              reflectionRecordPayloadRepresentationHeads.recordId,
              expected.recordRef,
            ),
            eq(
              reflectionRecordPayloadRepresentationHeads.representation,
              "ordinary",
            ),
          )).limit(2));
      const head = heads[0];
      if (
        heads.length !== 1
        || head === undefined
        || head.lifecycle === "sunset"
        || (
          expected.lifecycle !== undefined
          && head.lifecycle !== expected.lifecycle
        )
        || head.structural_height !== expected.structuralHeight
      ) throw new ForegroundProductChangedError(
        "Selected Reflection Record ordinary head changed",
      );
      const rows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({
          payloadBytes:
            reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
          createdAt: reflectionRecordPayloadRepresentations.createdAt,
        }).from(reflectionRecordPayloadRepresentations).where(and(
          eq(
            reflectionRecordPayloadRepresentations.recordId,
            expected.recordRef,
          ),
          eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
          eq(
            reflectionRecordPayloadRepresentations.representationGeneration,
            head.current_representation_generation,
          ),
        )).limit(2));
      const bytes = rows[0]?.plaintext_payload_bytes;
      if (rows.length !== 1 || !(bytes instanceof Uint8Array)) {
        throw new ForegroundProductChangedError(
          "Selected Reflection Record plaintext changed",
        );
      }
      const authority = await loadRecordAuthoritySnapshot({
        tx,
        recordRef: expected.recordRef,
      });
      if (expected.statement === undefined) throw new ForegroundProductChangedError(
        "Selected Reflection Record ordinary statement is unavailable",
      );
      sources.push(Object.freeze({
          authorityKind: "record_projection" as const,
        recordRef: expected.recordRef,
        expectedStatement: expected.statement,
        representationMode,
        lifecycle: head.lifecycle,
        structuralHeight: expected.structuralHeight,
        processingGeneration: head.processing_generation,
        existingObjectId: authority.existingObjectId,
        accessNamespaceIds: authority.accessNamespaceIds,
        ordinaryRepresentationGeneration:
          head.current_representation_generation,
        representationGeneration: authority.representationGeneration,
        authorityProjectionGeneration: authority.projectionGeneration,
        createdAt: exactDate(rows[0]!.created_at),
        plaintextBytes: bytes.slice(),
      }));
    }
    return Object.freeze(sources);
  }, { isolationLevel: "serializable" });
}

async function recordRepairSourceStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  source: Readonly<{
    recordRef: string;
    lifecycle: "current" | "stale" | "superseded" | "resolved" | "sunset";
    structuralHeight: number;
    processingGeneration: number;
    existingObjectId: string | null;
    accessNamespaceIds: readonly string[];
    ordinaryRepresentationGeneration: number;
    representationGeneration: number;
    authorityProjectionGeneration: number;
    plaintextBytes: Uint8Array;
  }>;
  objectId: string;
}>): Promise<boolean> {
  if (
    input.source.existingObjectId === null
    || input.source.existingObjectId !== input.objectId
    || !await recordProductStillCurrent({ tx: input.tx, source: input.source })
  ) return false;
  const authority = await loadRecordAuthoritySnapshot({
    tx: input.tx,
    recordRef: input.source.recordRef,
  });
  return authority.projectionGeneration
      === input.source.authorityProjectionGeneration
    && authority.representationGeneration
      === input.source.representationGeneration
    && authority.existingObjectId === input.objectId
    && authority.accessNamespaceIds.length
      === input.source.accessNamespaceIds.length
    && authority.accessNamespaceIds.every(
      (namespaceId, index) =>
        namespaceId === input.source.accessNamespaceIds[index],
    );
}

async function protectedRecordProductStillCurrent(input: Readonly<{
  tx: ProductTransaction;
  source: Omit<ForegroundRecordRepairSource, "ordinaryRepresentationGeneration">;
  objectId: string;
}>): Promise<boolean> {
  if (input.source.existingObjectId !== input.objectId) return false;
  const rows = await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.select({
      lifecycle: reflectionRecords.lifecycle,
      structuralHeight: reflectionRecords.structuralHeight,
      processingGeneration: reflectionRecords.processingGeneration,
      disposition: reflectionRecords.disposition,
    }).from(reflectionRecords).where(eq(
      reflectionRecords.recordId,
      input.source.recordRef,
    )).limit(2));
  return rows.length === 1
    && rows[0]?.lifecycle === input.source.lifecycle
    && rows[0]?.structural_height === input.source.structuralHeight
    && rows[0]?.processing_generation === input.source.processingGeneration
    && rows[0]?.disposition === "available"
    && await authorityStillCurrent({
      tx: input.tx,
      recordRef: input.source.recordRef,
      projectionGeneration: input.source.authorityProjectionGeneration,
      accessNamespaceIds: input.source.accessNamespaceIds,
    });
}

/** Recheck a standalone reused Record after crypto open and before consumption. */
export async function validatePostgresForegroundRecordRepairSource(input: Readonly<{
  product: ConversationProductPostgresHandle;
  source: ForegroundRecordRepairSource;
  objectId: string;
}>): Promise<boolean> {
  if (input.source.plaintextBytes === null) {
    return input.product.transaction(
      (tx) => protectedRecordProductStillCurrent({ tx, ...input }),
      { isolationLevel: "serializable" },
    );
  }
  const source = input.source as ForegroundRecordRepairSource & Readonly<{
    plaintextBytes: Uint8Array;
  }>;
  return input.product.transaction(
    (tx) => recordRepairSourceStillCurrent({
      tx,
      source,
      objectId: input.objectId,
    }),
    { isolationLevel: "serializable" },
  );
}

/** Recheck a reused Journal object after crypto open and before consumption. */
export async function validatePostgresForegroundJournalRepairSource(input: Readonly<{
  product: ConversationProductPostgresHandle;
  source: ForegroundJournalRepairSource;
  objectId: string;
}>): Promise<boolean> {
  if (
    input.source.existingObjectId === null
    || input.source.existingObjectId !== input.objectId
  ) return false;
  return input.product.transaction(async (tx) => {
    if (input.source.kind === "rollup") {
      return journalRollupStillCurrent({
        tx,
        source: input.source,
        targetObjectId: input.objectId,
      });
    }
    if (!await journalEventStillCurrent({
      tx,
      source: input.source,
      targetObjectId: input.objectId,
    })) return false;
    if (input.source.selection.kind !== "event") return false;
    if (input.source.selection.payload.kind === "legacy_event") return true;
    if (!await nativeJournalSourceStillCurrent({tx, source: input.source, targetObjectId: input.objectId})) return false;
    if (input.source.plaintextBytes === null) return true;
    if (input.source.ordinaryRepresentationGeneration === null) return false;
    return recordProductStillCurrent({tx, source: {
      recordRef: input.source.selection.payload.recordId,
      lifecycle: input.source.selection.payload.lifecycle,
      structuralHeight: input.source.selection.payload.structuralHeight,
      processingGeneration: input.source.selection.payload.processingGeneration,
      ordinaryRepresentationGeneration: input.source.ordinaryRepresentationGeneration,
      plaintextBytes: input.source.plaintextBytes,
    }});
  }, { isolationLevel: "serializable" });
}

async function restoreRecordOrdinaryInTransaction(input: Readonly<{
  tx: Parameters<Parameters<ConversationProductCanonicalTransactionRunner["transaction"]>[0]>[0];
  source: Omit<ForegroundRecordRepairSource, "authorityProjectionGeneration"> & {authorityProjectionGeneration: number | null};
  objectId: string;
  payloadBytes: Uint8Array;
  journalSource?: Readonly<{source: ForegroundJournalRepairSource; executor: ProductTransaction}>;
}>): Promise<"restored" | "replayed" | "conflict"> {
  const records = await input.tx.select({
    lifecycle: reflectionRecords.lifecycle,
    structuralHeight: reflectionRecords.structuralHeight,
    processingGeneration: reflectionRecords.processingGeneration,
    disposition: reflectionRecords.disposition,
  }).from(reflectionRecords).where(eq(
    reflectionRecords.recordId, input.source.recordRef,
  )).limit(2);
  const record = records[0];
  if (
    records.length !== 1 || record === undefined
    || record.lifecycle !== input.source.lifecycle
    || record.structuralHeight !== input.source.structuralHeight
    || record.processingGeneration !== input.source.processingGeneration
    || record.disposition !== "available"
  ) return "conflict";
  const protectedRows = await input.tx.select({
    generation: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
    objectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
  }).from(reflectionRecordPayloadRepresentationHeads).innerJoin(
    reflectionRecordPayloadRepresentations, and(
      eq(reflectionRecordPayloadRepresentations.recordId,
        reflectionRecordPayloadRepresentationHeads.recordId),
      eq(reflectionRecordPayloadRepresentations.representation, "protected"),
      eq(reflectionRecordPayloadRepresentations.representationGeneration,
        reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration),
    ),
  ).where(and(
    eq(reflectionRecordPayloadRepresentationHeads.recordId, input.source.recordRef),
    eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
  )).limit(2);
  if (
    protectedRows.length !== 1
    || protectedRows[0]?.generation !== input.source.representationGeneration
    || protectedRows[0]?.objectId !== input.objectId
  ) return "conflict";
  if (input.journalSource !== undefined) {
    if (!await nativeJournalSourceStillCurrent({tx: input.journalSource.executor,
      source: input.journalSource.source, targetObjectId: input.objectId})) return "conflict";
  } else {
    if (input.source.authorityProjectionGeneration === null) return "conflict";
    const projections = await input.tx.select({
      generation: reflectionRecordAuthorityProjections.projectionGeneration,
      state: reflectionRecordAuthorityProjections.processingState,
    }).from(reflectionRecordAuthorityProjections).where(and(
      eq(reflectionRecordAuthorityProjections.recordId, input.source.recordRef),
      eq(reflectionRecordAuthorityProjections.current, true),
    )).limit(2);
    if (
      projections.length !== 1
      || projections[0]?.generation !== input.source.authorityProjectionGeneration
      || projections[0]?.state !== "current"
    ) return "conflict";
    const alternatives = await input.tx.select({
      namespaceId: reflectionRecordAuthorityAlternatives.accessNamespaceId,
    }).from(reflectionRecordAuthorityAlternatives).where(and(
      eq(reflectionRecordAuthorityAlternatives.recordId, input.source.recordRef),
      eq(reflectionRecordAuthorityAlternatives.projectionGeneration,
        input.source.authorityProjectionGeneration),
    )).orderBy(asc(reflectionRecordAuthorityAlternatives.alternativeOrdinal));
    if (!equalStrings(
      [...new Set(alternatives.map((row) => row.namespaceId))].sort(),
      input.source.accessNamespaceIds,
    )) return "conflict";
  }
  const ordinary = await input.tx.select({
    generation: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
    bytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
  }).from(reflectionRecordPayloadRepresentationHeads).innerJoin(
    reflectionRecordPayloadRepresentations, and(
      eq(reflectionRecordPayloadRepresentations.recordId,
        reflectionRecordPayloadRepresentationHeads.recordId),
      eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
      eq(reflectionRecordPayloadRepresentations.representationGeneration,
        reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration),
    ),
  ).where(and(
    eq(reflectionRecordPayloadRepresentationHeads.recordId, input.source.recordRef),
    eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
  )).limit(2);
  if (ordinary.length > 0) {
    return ordinary.length === 1
        && ordinary[0]?.generation === input.source.representationGeneration
        && ordinary[0]?.bytes instanceof Uint8Array
        && equalBytes(ordinary[0].bytes, input.payloadBytes)
      ? "replayed" : "conflict";
  }
  await input.tx.insert(reflectionRecordPayloadRepresentations).values({
    recordId: input.source.recordRef,
    representation: "ordinary",
    representationGeneration: input.source.representationGeneration,
    payloadVersion: 1,
    plaintextPayloadBytes: input.payloadBytes,
    cryptoObjectId: null,
    createdAt: new Date(input.source.createdAt),
  }).onConflictDoNothing();
  await input.tx.insert(reflectionRecordPayloadRepresentationHeads).values({
    recordId: input.source.recordRef,
    representation: "ordinary",
    currentRepresentationGeneration: input.source.representationGeneration,
  }).onConflictDoNothing();
  const restored = await input.tx.select({
    bytes: reflectionRecordPayloadRepresentations.plaintextPayloadBytes,
  }).from(reflectionRecordPayloadRepresentations).innerJoin(
    reflectionRecordPayloadRepresentationHeads, and(
      eq(reflectionRecordPayloadRepresentationHeads.recordId,
        reflectionRecordPayloadRepresentations.recordId),
      eq(reflectionRecordPayloadRepresentationHeads.representation, "ordinary"),
      eq(reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
        reflectionRecordPayloadRepresentations.representationGeneration),
    ),
  ).where(and(
    eq(reflectionRecordPayloadRepresentations.recordId, input.source.recordRef),
    eq(reflectionRecordPayloadRepresentations.representation, "ordinary"),
    eq(reflectionRecordPayloadRepresentations.representationGeneration,
      input.source.representationGeneration),
  )).limit(2);
  return restored.length === 1 && restored[0]?.bytes instanceof Uint8Array
      && equalBytes(restored[0].bytes, input.payloadBytes)
    ? "restored" : "conflict";
}

export async function restorePostgresForegroundRecordOrdinary(input: Readonly<{
  canonical: ConversationProductCanonicalTransactionRunner;
  source: ForegroundRecordRepairSource;
  objectId: string;
  payloadBytes: Uint8Array;
  expectedPolicyRevision: number;
}>): Promise<"restored" | "replayed" | "conflict"> {
  if (input.source.plaintextBytes !== null || input.source.existingObjectId !== input.objectId) {
    return "conflict";
  }
  return input.canonical.transaction(async (tx) => {
    await acquireEncryptionPublicationFence(tx, {
      expectedRevision: input.expectedPolicyRevision,
      representation: "ordinary_and_protected",
    });
    return restoreRecordOrdinaryInTransaction({ tx, ...input });
  }, { isolationLevel: "serializable" });
}

/** Attach a verified standalone Reflection Record through its authority CAS. */
export async function attachPostgresForegroundRecordRepair(input: Readonly<{
  product: ConversationProductPostgresHandle;
  source: ForegroundRecordRepairSource;
  objectId: string;
  publicationId: string;
  requestCommitment: Uint8Array;
  publicationBindingRef: string;
}>): Promise<"attached" | "replayed" | "conflict"> {
  if (input.source.plaintextBytes === null) return "conflict";
  const source = input.source as ForegroundRecordRepairSource & Readonly<{
    plaintextBytes: Uint8Array;
  }>;
  return input.product.transaction(async (tx) => {
    if (
      !await recordProductStillCurrent({ tx, source })
      || !await authorityStillCurrent({
        tx,
        recordRef: input.source.recordRef,
        projectionGeneration: input.source.authorityProjectionGeneration,
        accessNamespaceIds: input.source.accessNamespaceIds,
      })
    ) return "conflict";
    await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.insert(reflectionRecordPayloadRepresentations)
        .values({
          recordId: input.source.recordRef,
          representation: "protected",
          representationGeneration: input.source.representationGeneration,
          payloadVersion: 1,
          plaintextPayloadBytes: null,
          cryptoObjectId: input.objectId,
        }).onConflictDoNothing());
    await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.insert(reflectionRecordPayloadRepresentationHeads)
        .values({
          recordId: input.source.recordRef,
          representation: "protected",
          currentRepresentationGeneration: input.source.representationGeneration,
        }).onConflictDoNothing());
    await insertRecordPublication({
      tx,
      recordRef: input.source.recordRef,
      representationGeneration: input.source.representationGeneration,
      objectId: input.objectId,
      publicationId: input.publicationId,
      requestCommitment: input.requestCommitment,
      publicationBindingRef: input.publicationBindingRef,
    });
    const rows = await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.select({
        objectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
        publication_object_id:
          sql<string>`${reflectionRecordPublications.cryptoObjectId}`
            .as("publication_object_id"),
        publicationState: reflectionRecordPublications.state,
        requestCommitment: reflectionRecordPublications.requestCommitment,
        publicationBindingRef: reflectionRecordPublications.publicationBindingRef,
      }).from(reflectionRecordPayloadRepresentations)
        .innerJoin(reflectionRecordPayloadRepresentationHeads, and(
          eq(
            reflectionRecordPayloadRepresentationHeads.recordId,
            reflectionRecordPayloadRepresentations.recordId,
          ),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
          eq(
            reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
            reflectionRecordPayloadRepresentations.representationGeneration,
          ),
        )).innerJoin(reflectionRecordPublications, and(
          eq(
            reflectionRecordPublications.recordId,
            reflectionRecordPayloadRepresentations.recordId,
          ),
          eq(reflectionRecordPublications.representation, "protected"),
          eq(
            reflectionRecordPublications.representationGeneration,
            reflectionRecordPayloadRepresentations.representationGeneration,
          ),
        )).where(and(
          eq(
            reflectionRecordPayloadRepresentations.recordId,
            input.source.recordRef,
          ),
          eq(reflectionRecordPayloadRepresentations.representation, "protected"),
          or(
            eq(reflectionRecordPublications.publicationId, input.publicationId),
            eq(reflectionRecordPublications.cryptoObjectId, input.objectId),
          ),
        )).limit(2));
    const row = rows[0];
    return rows.length === 1
        && row !== undefined
        && row.crypto_object_id === input.objectId
        && row.publication_object_id === input.objectId
        && row.state === "complete"
        && equalBytes(row.request_commitment, input.requestCommitment)
        && row.publication_binding_ref === input.publicationBindingRef
      ? "attached"
      : "conflict";
  }, { isolationLevel: "serializable" });
}

async function insertRecordPublication(input: Readonly<{
  tx: ProductTransaction;
  recordRef: string;
  representationGeneration: number;
  objectId: string;
  publicationId: string;
  requestCommitment: Uint8Array;
  publicationBindingRef: string;
}>): Promise<void> {
  await executeTypedConversationProductQuery(input.tx,
    conversationProductTypedDb.insert(reflectionRecordPublications).values({
      publicationId: input.publicationId,
      recordId: input.recordRef,
      representation: "protected",
      representationGeneration: input.representationGeneration,
      payloadVersion: 1,
      requestCommitment: input.requestCommitment,
      publicationBindingRef: input.publicationBindingRef,
      cryptoObjectId: input.objectId,
      state: "complete",
      attemptCount: 0,
      cryptoCompletedAt: sql`now()`,
      productAttachedAt: sql`now()`,
      completedAt: sql`now()`,
    }).onConflictDoNothing());
}

export async function restorePostgresForegroundJournalOrdinary(input: Readonly<{
  canonical: ConversationProductCanonicalTransactionRunner;
  source: ForegroundJournalRepairSource;
  objectId: string;
  ordinaryText?: string;
  payloadBytes?: Uint8Array;
  expectedPolicyRevision: number;
}>): Promise<"restored" | "replayed" | "conflict"> {
  if (input.source.plaintextBytes !== null || input.source.existingObjectId !== input.objectId) {
    return "conflict";
  }
  return input.canonical.transaction(async (tx, executor) => {
    await acquireEncryptionPublicationFence(tx, {
      expectedRevision: input.expectedPolicyRevision,
      representation: "ordinary_and_protected",
    });
    if (!await journalScopeStillCurrent(executor, input.source.selection)) return "conflict";
    if (input.source.kind === "rollup") {
      if (input.ordinaryText === undefined) return "conflict";
      const selected = input.source.selection as ForegroundJournalSelectedRollup;
      const rows = await tx.select({
        roomId: roomEventRollups.roomId,
        through: roomEventRollups.throughEventSequence,
        content: roomEventRollups.content,
        objectId: roomEventRollups.cryptoObjectId,
      }).from(roomEventRollups).where(eq(roomEventRollups.id, selected.binding.rollupId)).limit(2);
      const row = rows[0];
      if (rows.length !== 1 || row?.roomId !== selected.binding.roomId
        || row.through !== selected.binding.throughEventSequence
        || row.objectId !== input.objectId) return "conflict";
      if (row.content !== null) return row.content === input.ordinaryText ? "replayed" : "conflict";
      const updated = await tx.update(roomEventRollups).set({ content: input.ordinaryText })
        .where(and(
          eq(roomEventRollups.id, selected.binding.rollupId),
          eq(roomEventRollups.roomId, selected.binding.roomId),
          eq(roomEventRollups.cryptoObjectId, input.objectId),
          isNull(roomEventRollups.content),
        )).returning({ id: roomEventRollups.id });
      return updated.length === 1 ? "restored" : "conflict";
    }
    const selected = input.source.selection as ForegroundJournalSelectedEvent;
    if (selected.payload.kind === "legacy_event") {
      if (input.ordinaryText === undefined) return "conflict";
      const rows = await tx.select({
        roomId: roomEvents.roomId,
        sequence: roomEvents.sequence,
        projectionKind: roomEvents.projectionKind,
        statement: roomEvents.statement,
        objectId: roomEvents.cryptoObjectId,
      }).from(roomEvents).where(eq(roomEvents.id, selected.binding.eventId)).limit(2);
      const row = rows[0];
      if (rows.length !== 1 || row?.roomId !== selected.binding.roomId
        || row.sequence !== selected.binding.sequence || row.projectionKind !== "legacy"
        || row.objectId !== input.objectId) return "conflict";
      if (row.statement !== null) return row.statement === input.ordinaryText ? "replayed" : "conflict";
      const updated = await tx.update(roomEvents).set({ statement: input.ordinaryText })
        .where(and(
          eq(roomEvents.id, selected.binding.eventId),
          eq(roomEvents.roomId, selected.binding.roomId),
          eq(roomEvents.sequence, selected.binding.sequence),
          eq(roomEvents.projectionKind, "legacy"),
          eq(roomEvents.cryptoObjectId, input.objectId),
          isNull(roomEvents.statement),
        )).returning({ id: roomEvents.id });
      return updated.length === 1 ? "restored" : "conflict";
    }
    if (selected.payload.lifecycle === "sunset" || input.payloadBytes === undefined
      || input.source.authorityKind !== "journal_source"
      || !await nativeJournalSourceStillCurrent({tx: executor, source: input.source, targetObjectId: input.objectId})) return "conflict";
    return restoreRecordOrdinaryInTransaction({
      tx,
      journalSource: {source: input.source, executor},
      objectId: input.objectId,
      payloadBytes: input.payloadBytes,
      source: {
        recordRef: selected.payload.recordId,
        expectedStatement: null,
        lifecycle: selected.payload.lifecycle,
        structuralHeight: selected.payload.structuralHeight,
        processingGeneration: selected.payload.processingGeneration,
        existingObjectId: input.source.existingObjectId,
        accessNamespaceIds: input.source.accessNamespaceIds,
        ordinaryRepresentationGeneration: input.source.ordinaryRepresentationGeneration ?? 0,
        representationGeneration: input.source.representationGeneration,
        authorityProjectionGeneration: input.source.authorityProjectionGeneration,
        createdAt: input.source.createdAt,
        plaintextBytes: null,
      },
    });
  }, { isolationLevel: "serializable" });
}

/** Attach only after durable authentication, decrypt, and byte parity. */
export async function attachPostgresForegroundJournalRepair(input: Readonly<{
  product: ConversationProductPostgresHandle;
  source: ForegroundJournalRepairSource;
  objectId: string;
  publicationId: string;
  requestCommitment: Uint8Array;
  publicationBindingRef: string;
}>): Promise<"attached" | "replayed" | "conflict"> {
  return input.product.transaction(tx => attachPostgresForegroundJournalRepairWithinTransaction(tx, input),
    { isolationLevel: "serializable" });
}

/** Lend the existing product transaction so a batch attaches atomically under its current grant. */
export async function attachPostgresForegroundJournalRepairWithinTransaction(
  tx: ProductTransaction,
  input: Omit<Parameters<typeof attachPostgresForegroundJournalRepair>[0], "product">,
): Promise<"attached" | "replayed" | "conflict"> {
  if (input.source.plaintextBytes === null) return "conflict";
  const plaintextBytes = input.source.plaintextBytes;
    if (input.source.kind === "rollup") {
      const selected = input.source.selection as ForegroundJournalSelectedRollup;
      if (!await journalRollupStillCurrent({
        tx,
        source: input.source,
        targetObjectId: input.objectId,
      })) {
        return "conflict";
      }
      const updated = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.update(roomEventRollups)
          .set({ cryptoObjectId: input.objectId }).where(and(
            eq(roomEventRollups.id, selected.binding.rollupId),
            eq(roomEventRollups.roomId, selected.binding.roomId),
            isNull(roomEventRollups.cryptoObjectId),
          )).returning({ objectId: roomEventRollups.cryptoObjectId }));
      if (updated.length === 1) return "attached";
      const rows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({ objectId: roomEventRollups.cryptoObjectId })
          .from(roomEventRollups)
          .where(eq(roomEventRollups.id, selected.binding.rollupId)).limit(2));
      return rows.length === 1 && rows[0]!.crypto_object_id === input.objectId
        ? "replayed"
        : "conflict";
    }
    const selected = input.source.selection as ForegroundJournalSelectedEvent;
    if (!await journalEventStillCurrent({
      tx,
      source: input.source,
      targetObjectId: input.objectId,
    })) {
      return "conflict";
    }
    if (selected.payload.kind === "legacy_event") {
      const updated = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.update(roomEvents)
          .set({ cryptoObjectId: input.objectId }).where(and(
            eq(roomEvents.id, selected.binding.eventId),
            eq(roomEvents.roomId, selected.binding.roomId),
            eq(roomEvents.projectionKind, "legacy"),
            isNull(roomEvents.cryptoObjectId),
          )).returning({ objectId: roomEvents.cryptoObjectId }));
      if (updated.length === 1) return "attached";
      const rows = await executeTypedConversationProductQuery(tx,
        conversationProductTypedDb.select({ objectId: roomEvents.cryptoObjectId })
          .from(roomEvents)
          .where(eq(roomEvents.id, selected.binding.eventId)).limit(2));
      return rows.length === 1 && rows[0]!.crypto_object_id === input.objectId
        ? "replayed"
        : "conflict";
    }
    if (
      !await nativeJournalSourceStillCurrent({tx, source: input.source, targetObjectId: input.objectId})
      || input.source.ordinaryRepresentationGeneration === null
      || !await recordProductStillCurrent({
        tx,
        source: {
          recordRef: selected.payload.recordId,
          lifecycle: selected.payload.lifecycle,
          structuralHeight: selected.payload.structuralHeight,
          processingGeneration: selected.payload.processingGeneration,
          ordinaryRepresentationGeneration:
            input.source.ordinaryRepresentationGeneration,
          plaintextBytes,
        },
      })
    ) return "conflict";
    await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.insert(reflectionRecordPayloadRepresentations)
        .values({
          recordId: selected.payload.recordId,
          representation: "protected",
          representationGeneration: input.source.representationGeneration,
          payloadVersion: 1,
          plaintextPayloadBytes: null,
          cryptoObjectId: input.objectId,
        }).onConflictDoNothing());
    await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.insert(reflectionRecordPayloadRepresentationHeads)
        .values({
          recordId: selected.payload.recordId,
          representation: "protected",
          currentRepresentationGeneration: input.source.representationGeneration,
        }).onConflictDoNothing());
    await insertRecordPublication({
      tx,
      recordRef: selected.payload.recordId,
      representationGeneration: input.source.representationGeneration,
      objectId: input.objectId,
      publicationId: input.publicationId,
      requestCommitment: input.requestCommitment,
      publicationBindingRef: input.publicationBindingRef,
    });
    const rows = await executeTypedConversationProductQuery(tx,
      conversationProductTypedDb.select({
        generation:
          reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
        objectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
        publication_object_id:
          sql<string>`${reflectionRecordPublications.cryptoObjectId}`
            .as("publication_object_id"),
        publicationState: reflectionRecordPublications.state,
        requestCommitment: reflectionRecordPublications.requestCommitment,
        publicationBindingRef: reflectionRecordPublications.publicationBindingRef,
      }).from(reflectionRecordPayloadRepresentationHeads)
        .innerJoin(reflectionRecordPayloadRepresentations, and(
          eq(
            reflectionRecordPayloadRepresentations.recordId,
            reflectionRecordPayloadRepresentationHeads.recordId,
          ),
          eq(reflectionRecordPayloadRepresentations.representation, "protected"),
          eq(
            reflectionRecordPayloadRepresentations.representationGeneration,
            reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
          ),
        )).innerJoin(reflectionRecordPublications, and(
          eq(
            reflectionRecordPublications.recordId,
            reflectionRecordPayloadRepresentations.recordId,
          ),
          eq(reflectionRecordPublications.representation, "protected"),
          eq(
            reflectionRecordPublications.representationGeneration,
            reflectionRecordPayloadRepresentations.representationGeneration,
          ),
        )).where(and(
          eq(
            reflectionRecordPayloadRepresentationHeads.recordId,
            selected.payload.recordId,
          ),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
          or(
            eq(reflectionRecordPublications.publicationId, input.publicationId),
            eq(reflectionRecordPublications.cryptoObjectId, input.objectId),
          ),
        )).limit(2));
    const row = rows[0];
    return rows.length === 1
        && row !== undefined
        && row.current_representation_generation
          === input.source.representationGeneration
        && row.crypto_object_id === input.objectId
        && row.publication_object_id === input.objectId
        && row.state === "complete"
        && equalBytes(row.request_commitment, input.requestCommitment)
        && row.publication_binding_ref === input.publicationBindingRef
      ? "attached"
      : "conflict";
}

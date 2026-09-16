import {
  alias,
  and,
  asc,
  eq,
  gt,
  isNotNull,
  isNull,
  ne,
  or,
  reflectionRecordAuthorityAlternatives,
  reflectionRecordAuthorityBlocks,
  reflectionRecordAuthorityChanges,
  reflectionRecordAuthorityClosure,
  reflectionRecordAuthorityProjections,
  reflectionRecordDependencies,
  reflectionRecordPublications,
  roomEvents,
  roomJournalBatches,
  rooms,
  reflectionRecordAuthorityReconciliations,
  reflectionRecordPayloadRepresentationHeads,
  reflectionRecordPayloadRepresentations,
  reflectionRecords,
  sql,
} from "@nautilo/db";
import type {
  AuthorityReconciliationFailureCode,
  AuthorityProjectionCasInput,
  AuthorityProtectedReconciliationReceipt,
  AuthorityProjectionStorePort,
  CurrentAuthorityProjection,
  MaterializedAuthorityAlternative,
} from "./authority-contracts";
import type { RecordRepositorySelection } from "./contracts";
import {
  assertVerifiedRecordProductPostgresHandle,
  executeTypedRecordProductQuery,
  recordProductTypedDb,
  type RecordProductPostgresExecutor,
  type RecordProductPostgresHandle,
  type RecordProductPostgresRow,
} from "./product-postgres";

const MAX_TRANSACTION_ATTEMPTS = 3;
const DEFAULT_AUTHORITY_REPOSITORY_SELECTION: RecordRepositorySelection =
  Object.freeze({ selectedRepresentation: "protected", migrationGeneration: 1 });
const selectedRepresentationHeads = alias(
  reflectionRecordPayloadRepresentationHeads,
  "selected_representation_head",
);

function rowString(row: RecordProductPostgresRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new TypeError("Invalid authority product row");
  return value;
}

function rowInteger(row: RecordProductPostgresRow, key: string): number {
  const raw = row[key];
  const value = typeof raw === "bigint" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError("Invalid authority product generation");
  }
  return value;
}

function rowBytes(row: RecordProductPostgresRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new TypeError("Invalid authority commitment");
  return value;
}

function processingState(value: string): CurrentAuthorityProjection["processingState"] {
  if (!["current", "dirty", "reconciling", "unavailable", "purged"].includes(value)) {
    throw new TypeError("Invalid authority processing state");
  }
  return value as CurrentAuthorityProjection["processingState"];
}

function recordLifecycle(value: string): CurrentAuthorityProjection["recordLifecycle"] {
  if (!["current", "stale", "superseded", "resolved", "sunset"].includes(value)) {
    throw new TypeError("Invalid authority Record lifecycle");
  }
  return value as CurrentAuthorityProjection["recordLifecycle"];
}

function recordDisposition(value: string): CurrentAuthorityProjection["recordDisposition"] {
  if (!["available", "blocked", "purged"].includes(value)) {
    throw new TypeError("Invalid authority Record disposition");
  }
  return value as CurrentAuthorityProjection["recordDisposition"];
}

function equalBytes(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function retryable(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error.code === "40001" || error.code === "40P01");
}

/** Called by a source-owned verified producer or a completed canonical closure traversal, on its held transaction. */
export async function installInitialAuthorityClosureWithinTransaction(tx: RecordProductPostgresExecutor, input: Readonly<{
  recordRef: string; closureGeneration: number; terminalAuthorityLeafHandles: readonly string[];
}>): Promise<"installed" | "replayed" | "conflict"> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended(lock_id, 0))
    FROM (SELECT DISTINCT lock_id FROM unnest($1::text[]) AS lock_id ORDER BY lock_id) locks`, [[input.recordRef]]);
  const rows = await tx.query(
    `SELECT terminal_leaf_handle
       FROM reflection_record_authority_closure
      WHERE record_id = $1 AND closure_generation = $2
      ORDER BY terminal_leaf_handle
      FOR SHARE`,
    [input.recordRef, input.closureGeneration],
  );
  const handles = [...new Set(input.terminalAuthorityLeafHandles)].sort();
  if (rows.length > 0) {
    return JSON.stringify(rows.map((row) => rowString(row, "terminal_leaf_handle")))
        === JSON.stringify(handles)
      ? "replayed"
      : "conflict";
  }
  if (handles.length > 0) {
    await executeTypedRecordProductQuery(tx, recordProductTypedDb
      .insert(reflectionRecordAuthorityClosure)
      .values(handles.map((terminalLeafHandle) => ({
        recordId: input.recordRef,
        terminalLeafHandle,
        closureGeneration: input.closureGeneration,
      }))));
  }
  await executeTypedRecordProductQuery(tx, recordProductTypedDb
    .insert(reflectionRecordAuthorityProjections)
    .values({
      recordId: input.recordRef,
      projectionGeneration: input.closureGeneration,
      sourceChangeGeneration: input.closureGeneration,
      processingState: "dirty",
      current: true,
      dirtySince: sql`now()`,
    })
    .onConflictDoNothing({
      target: [
        reflectionRecordAuthorityProjections.recordId,
        reflectionRecordAuthorityProjections.projectionGeneration,
      ],
    }));
  return "installed";
}

/** Dormant product-role authority projection persistence. */
export class PostgresAuthorityProjectionStore implements AuthorityProjectionStorePort {
  private readonly selection: RecordRepositorySelection;

  constructor(
    private readonly handle: RecordProductPostgresHandle,
    selection: RecordRepositorySelection = DEFAULT_AUTHORITY_REPOSITORY_SELECTION,
  ) {
    assertVerifiedRecordProductPostgresHandle(handle);
    if (
      (selection.selectedRepresentation !== "ordinary"
        && selection.selectedRepresentation !== "protected")
      || !Number.isSafeInteger(selection.migrationGeneration)
      || selection.migrationGeneration < 1
    ) throw new TypeError("Authority repository selection is invalid");
    this.selection = Object.freeze({ ...selection });
  }

  async readCurrent(recordRef: string): Promise<CurrentAuthorityProjection | null> {
    const projections = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecordAuthorityProjections.recordId,
        lifecycle: reflectionRecords.lifecycle,
        disposition: reflectionRecords.disposition,
        projection_generation:
          reflectionRecordAuthorityProjections.projectionGeneration,
        source_change_generation:
          reflectionRecordAuthorityProjections.sourceChangeGeneration,
        processing_state: reflectionRecordAuthorityProjections.processingState,
        audience_set_commitment: reflectionRecordAuthorityProjections.audienceSetCommitment,
        unavailable_reason:
          reflectionRecordAuthorityProjections.unavailableReason,
        selected_representation_generation: sql<number | null>`${
          selectedRepresentationHeads.currentRepresentationGeneration
        }`.as("selected_representation_generation"),
        current_representation_generation:
          reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
        crypto_object_id: reflectionRecordPayloadRepresentations.cryptoObjectId,
      })
        .from(reflectionRecordAuthorityProjections)
        .innerJoin(reflectionRecords, eq(
          reflectionRecords.recordId,
          reflectionRecordAuthorityProjections.recordId,
        ))
        .leftJoin(selectedRepresentationHeads, and(
          eq(
            selectedRepresentationHeads.recordId,
            reflectionRecordAuthorityProjections.recordId,
          ),
          eq(
            selectedRepresentationHeads.representation,
            this.selection.selectedRepresentation,
          ),
        ))
        .leftJoin(reflectionRecordPayloadRepresentationHeads, and(
          eq(
            reflectionRecordPayloadRepresentationHeads.recordId,
            reflectionRecordAuthorityProjections.recordId,
          ),
          eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
        ))
        .leftJoin(reflectionRecordPayloadRepresentations, and(
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
          eq(reflectionRecordAuthorityProjections.recordId, recordRef),
          eq(reflectionRecordAuthorityProjections.current, true),
        ))
        .limit(1));
    const row = projections[0];
    if (row === undefined) return null;
    const projectionGeneration = rowInteger(row, "projection_generation");
    const [alternativeRows, closureRows] = await Promise.all([
      executeTypedRecordProductQuery(this.handle,
        recordProductTypedDb.select({
          access_namespace_id:
            reflectionRecordAuthorityAlternatives.accessNamespaceId,
          includes_public_boundary:
            reflectionRecordAuthorityAlternatives.includesPublicBoundary,
          alternative_commitment:
            reflectionRecordAuthorityAlternatives.alternativeCommitment,
        })
          .from(reflectionRecordAuthorityAlternatives)
          .where(and(
            eq(reflectionRecordAuthorityAlternatives.recordId, recordRef),
            eq(
              reflectionRecordAuthorityAlternatives.projectionGeneration,
              projectionGeneration,
            ),
          ))
          .orderBy(asc(reflectionRecordAuthorityAlternatives.alternativeOrdinal))),
      executeTypedRecordProductQuery(this.handle,
        recordProductTypedDb.select({
          terminal_leaf_handle: reflectionRecordAuthorityClosure.terminalLeafHandle,
        })
          .from(reflectionRecordAuthorityClosure)
          .where(and(
            eq(reflectionRecordAuthorityClosure.recordId, recordRef),
            eq(
              reflectionRecordAuthorityClosure.closureGeneration,
              projectionGeneration,
            ),
          ))
          .orderBy(asc(reflectionRecordAuthorityClosure.terminalLeafHandle))),
    ]);
    const alternatives: MaterializedAuthorityAlternative[] = alternativeRows.map((entry) => ({
      accessNamespaceId: rowString(entry, "access_namespace_id"),
      includesPublicBoundary: entry["includes_public_boundary"] === true,
      alternativeCommitment: rowBytes(entry, "alternative_commitment"),
    }));
    const state = processingState(rowString(row, "processing_state"));
    const unavailableReason = typeof row["unavailable_reason"] === "string"
      ? row["unavailable_reason"] as CurrentAuthorityProjection["unavailableReason"]
      : undefined;
    const receipt = await this.readProtectedReconciliation({recordRef, sourceChangeGeneration: rowInteger(row, "source_change_generation")});
    const protectedAuthorityCurrent = state === "current" && receipt?.state === "complete"
      && receipt.expectedProjectionGeneration + 1 === projectionGeneration
      && receipt.targetCryptoRetiredAt === null && receipt.targetCryptoObjectId !== null
      && receipt.targetCryptoObjectId === row["crypto_object_id"]
      && receipt.targetRepresentationGeneration === row["current_representation_generation"]
      && equalBytes(receipt.targetAudienceSetCommitment, rowBytes(row, "audience_set_commitment"))
      && JSON.stringify(receipt.targetAccessNamespaceIds) === JSON.stringify(alternatives.map(entry => entry.accessNamespaceId).sort());
    return {
      ...(row["audience_set_commitment"] == null ? {} : {audienceSetCommitment: rowBytes(row, "audience_set_commitment")}), protectedAuthorityCurrent,
      recordRef: rowString(row, "record_id"),
      recordLifecycle: recordLifecycle(rowString(row, "lifecycle")),
      recordDisposition: recordDisposition(rowString(row, "disposition")),
      projectionGeneration,
      sourceChangeGeneration: rowInteger(row, "source_change_generation"),
      processingState: state,
      alternatives,
      ...(unavailableReason === undefined ? {} : { unavailableReason }),
      terminalAuthorityLeafHandles: closureRows.map((entry) =>
        rowString(entry, "terminal_leaf_handle")
      ),
      representationGeneration:
        row["selected_representation_generation"] === null
          ? 1
          : rowInteger(row, "selected_representation_generation"),
      ...(row["current_representation_generation"] == null
        ? {}
        : { protectedRepresentationGeneration: rowInteger(row, "current_representation_generation") }),
      ...(typeof row["crypto_object_id"] === "string"
        ? { protectedCryptoObjectId: row["crypto_object_id"] }
        : {}),
    };
  }

  readProtectedReconciliation(input: Readonly<{recordRef: string; sourceChangeGeneration: number}>): Promise<AuthorityProtectedReconciliationReceipt | null> {
    return this.#readReceipt(this.handle, input);
  }

  async #readReceipt(tx: RecordProductPostgresExecutor, input: Readonly<{recordRef: string; sourceChangeGeneration: number}>): Promise<AuthorityProtectedReconciliationReceipt | null> {
    const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select().from(reflectionRecordAuthorityReconciliations).where(and(
      eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
      eq(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, input.sourceChangeGeneration),
    )));
    const row = rows[0];
    if (row === undefined) return null;
    return {receiptId: row.reconciliation_id, recordRef: row.record_id,
      expectedProjectionGeneration: row.expected_projection_generation, sourceChangeGeneration: row.source_change_generation,
      state: row.state, completedAt: row.completed_at,
      targetRepresentationGeneration: row.target_representation_generation, targetCryptoObjectId: row.target_crypto_object_id,
      targetAccessNamespaceIds: row.target_access_namespace_ids === null ? null : [...row.target_access_namespace_ids],
      targetAudienceSetCommitment: row.target_audience_set_commitment === null ? null : Uint8Array.from(row.target_audience_set_commitment),
      targetCryptoRetiredAt: row.target_crypto_retired_at, formerCryptoObjectId: row.former_crypto_object_id, formerCryptoRetiredAt: row.former_crypto_retired_at};
  }

  async #readHead(tx: RecordProductPostgresExecutor, recordRef: string) {
    const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({
      generation: reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration,
      objectId: reflectionRecordPayloadRepresentations.cryptoObjectId,
    }).from(reflectionRecordPayloadRepresentationHeads).innerJoin(reflectionRecordPayloadRepresentations, and(
      eq(reflectionRecordPayloadRepresentations.recordId, reflectionRecordPayloadRepresentationHeads.recordId),
      eq(reflectionRecordPayloadRepresentations.representation, reflectionRecordPayloadRepresentationHeads.representation),
      eq(reflectionRecordPayloadRepresentations.representationGeneration, reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration),
    )).where(and(eq(reflectionRecordPayloadRepresentationHeads.recordId, recordRef), eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"))));
    const row = rows[0];
    return row === undefined ? null : {generation: row.current_representation_generation, objectId: row.crypto_object_id};
  }

  async #readProjection(tx: RecordProductPostgresExecutor, recordRef: string) {
    const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select().from(reflectionRecordAuthorityProjections).where(and(
      eq(reflectionRecordAuthorityProjections.recordId, recordRef), eq(reflectionRecordAuthorityProjections.current, true),
    )).for("update"));
    const row = rows[0];
    return row === undefined ? null : {projectionGeneration: row.projection_generation, sourceChangeGeneration: row.source_change_generation,
      processingState: row.processing_state, audienceSetCommitment: row.audience_set_commitment};
  }

  async #newerSource(tx: RecordProductPostgresExecutor, input: Readonly<{recordRef: string; sourceChangeGeneration: number}>) {
    const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({found: sql<number>`1`.as("found")})
      .from(reflectionRecordAuthorityReconciliations).where(and(eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
        gt(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, input.sourceChangeGeneration))).limit(1));
    return rows.length > 0;
  }

  async #blocked(tx: RecordProductPostgresExecutor, recordRef: string, projectionGeneration: number) {
    const records = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({disposition: reflectionRecords.disposition}).from(reflectionRecords).where(eq(reflectionRecords.recordId, recordRef)));
    if (records[0]?.disposition !== "available") return true;
    const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({found: sql<number>`1`.as("found")}).from(reflectionRecordAuthorityBlocks).where(or(
      eq(reflectionRecordAuthorityBlocks.recordId, recordRef), sql`${reflectionRecordAuthorityBlocks.terminalLeafHandle} in (
        select ${reflectionRecordAuthorityClosure.terminalLeafHandle} from ${reflectionRecordAuthorityClosure}
        where ${reflectionRecordAuthorityClosure.recordId} = ${recordRef} and ${reflectionRecordAuthorityClosure.closureGeneration} = ${projectionGeneration}
      )`,
    )).limit(1));
    return rows.length > 0;
  }

  async isImmediatelyBlocked(input: Readonly<{
    recordRef: string;
    terminalAuthorityLeafHandles?: readonly string[];
  }>): Promise<"blocked" | "purged" | null> {
    const rows = await this.handle.query(
      `SELECT disposition
         FROM reflection_record_authority_blocks
        WHERE record_id = $1
           OR terminal_leaf_handle = ANY($2::text[])
        ORDER BY CASE disposition WHEN 'purged' THEN 0 ELSE 1 END
        LIMIT 1`,
      [input.recordRef, input.terminalAuthorityLeafHandles ?? []],
    );
    return rows.length === 0
      ? null
      : rowString(rows[0]!, "disposition") as "blocked" | "purged";
  }

  installInitialClosure(input: Readonly<{recordRef: string; closureGeneration: number; terminalAuthorityLeafHandles: readonly string[]}>): Promise<"installed" | "replayed" | "conflict"> {
    return this.#serializable(tx => installInitialAuthorityClosureWithinTransaction(tx, input));
  }

  /** Source-owned native Stenographer metadata is the only body-free bootstrap exception. */
  bootstrapNativeStenographerAuthority(recordRef: string): Promise<"installed" | "replayed" | "unavailable" | "conflict"> {
    return this.#serializable(async tx => {
      await this.#lock(tx, [recordRef]);
      const current = await this.#readProjection(tx, recordRef);
      if (current !== null) return "replayed";
      const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({
        record_id: reflectionRecords.recordId, namespace_id: rooms.namespaceId,
        publication_id: reflectionRecordPublications.publicationId, publication_binding_ref: reflectionRecordPublications.publicationBindingRef,
        representation: reflectionRecordPublications.representation,
        source_batch_id: roomEvents.sourceBatchId, batch_local_ordinal: roomEvents.batchLocalOrdinal,
      }).from(roomEvents).innerJoin(rooms, eq(rooms.id, roomEvents.roomId))
        .innerJoin(roomJournalBatches, and(eq(roomJournalBatches.id, roomEvents.sourceBatchId), eq(roomJournalBatches.roomId, roomEvents.roomId)))
        .innerJoin(reflectionRecords, eq(reflectionRecords.recordId, roomEvents.recordId))
        .innerJoin(reflectionRecordPayloadRepresentationHeads, and(eq(reflectionRecordPayloadRepresentationHeads.recordId, reflectionRecords.recordId), eq(reflectionRecordPayloadRepresentationHeads.representation, "protected")))
        .innerJoin(reflectionRecordPayloadRepresentations, and(eq(reflectionRecordPayloadRepresentations.recordId, reflectionRecords.recordId), eq(reflectionRecordPayloadRepresentations.representation, "protected"), eq(reflectionRecordPayloadRepresentations.representationGeneration, reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration)))
        .innerJoin(reflectionRecordPublications, and(eq(reflectionRecordPublications.recordId, reflectionRecords.recordId),
          eq(reflectionRecordPublications.representationGeneration, 1), eq(reflectionRecordPublications.state, "complete"),
          or(and(eq(reflectionRecordPublications.representation, "protected"), eq(reflectionRecordPublications.cryptoObjectId, reflectionRecordPayloadRepresentations.cryptoObjectId)),
            and(eq(reflectionRecordPublications.representation, "ordinary"), isNull(reflectionRecordPublications.cryptoObjectId)))))
        .where(and(eq(reflectionRecords.recordId, recordRef), eq(roomEvents.projectionKind, "native"), sql`${roomEvents.id}::text = ${roomEvents.recordId}`,
          eq(reflectionRecords.structuralHeight, 0), eq(reflectionRecords.disposition, "available"), eq(reflectionRecords.lifecycle, "current"), eq(roomEvents.status, "active"),
          eq(reflectionRecords.producerPolicyVersion, roomEvents.extractorVersion), isNotNull(roomEvents.nativeAttachedAt), isNull(roomEvents.statement), isNull(roomEvents.cryptoObjectId), isNull(rooms.archivedAt),
          eq(reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration, 1), eq(reflectionRecordPayloadRepresentations.payloadVersion, 1), isNotNull(reflectionRecordPayloadRepresentations.cryptoObjectId),
          sql`not exists (select 1 from ${reflectionRecordDependencies} where ${reflectionRecordDependencies.parentRecordId} = ${reflectionRecords.recordId})`,
        )).limit(2));
      // A repaired protected sibling keeps the repair request's receipt. Its
      // original ordinary publication still proves native journal provenance.
      // The schema permits at most one initial row per representation; never
      // infer source ownership from the repair request or the origin alone.
      if (new Set(rows.map(row => row.representation)).size !== rows.length) return "unavailable";
      const row = rows.find(candidate => {
        const representation = candidate.representation;
        const expectedId = `journal:${candidate.source_batch_id}:${candidate.batch_local_ordinal}`;
        return (representation === "ordinary" || representation === "protected")
          && (candidate.publication_id === expectedId
            || (representation === "ordinary" && candidate.publication_id === `${expectedId}:ordinary`))
          && candidate.publication_binding_ref === `journal:namespace:${candidate.namespace_id}:${representation}:v1`;
      });
      if (row === undefined) return "unavailable";
      return installInitialAuthorityClosureWithinTransaction(tx, {recordRef, closureGeneration: 1, terminalAuthorityLeafHandles: [row.namespace_id]});
    });
  }

  admitSourceChange(input: Readonly<{
    changeRef: string;
    terminalAuthorityLeafHandle: string;
    sourceChangeGeneration: number;
  }>): Promise<Readonly<{ dirtyRecordCount: number; replayed: boolean }>> {
    return this.#serializable(async (tx) => {
      await this.#lock(tx, [input.changeRef, input.terminalAuthorityLeafHandle]);
      const existing = await tx.query(
        `SELECT terminal_leaf_handle, source_change_generation
           FROM reflection_record_authority_changes
          WHERE change_id = $1 FOR UPDATE`,
        [input.changeRef],
      );
      if (existing.length > 0) {
        const replayed = rowString(existing[0]!, "terminal_leaf_handle")
            === input.terminalAuthorityLeafHandle
          && rowInteger(existing[0]!, "source_change_generation")
            === input.sourceChangeGeneration;
        if (!replayed) throw new Error("Authority change idempotency conflict");
        return { dirtyRecordCount: 0, replayed: true };
      }
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .insert(reflectionRecordAuthorityChanges)
        .values({
          changeId: input.changeRef,
          terminalLeafHandle: input.terminalAuthorityLeafHandle,
          sourceChangeGeneration: input.sourceChangeGeneration,
        }));
      const dirtyRows = await tx.query(
        `WITH affected AS (
           SELECT DISTINCT closure.record_id
             FROM reflection_record_authority_closure AS closure
             JOIN reflection_record_authority_projections AS projection
               ON projection.record_id = closure.record_id
              AND projection.projection_generation = closure.closure_generation
              AND projection.current = true
            WHERE closure.terminal_leaf_handle = $1
         ), updated AS (
          UPDATE reflection_record_authority_projections AS projection
              SET processing_state = 'dirty',
                  unavailable_reason = NULL,
                  dirty_since = COALESCE(projection.dirty_since, now()),
                  updated_at = now()
             FROM affected
            WHERE projection.record_id = affected.record_id
              AND projection.current = true
              AND projection.processing_state <> 'purged'
           RETURNING projection.record_id, projection.projection_generation
         ), superseded AS (
           UPDATE reflection_record_authority_reconciliations AS receipt
              SET state = 'quarantined', failure_code = 'mapping_conflict',
                  next_attempt_at = NULL, updated_at = now()
             FROM updated
            WHERE receipt.record_id = updated.record_id
              AND receipt.source_change_generation < $2::integer
              AND receipt.state = 'pending'
           RETURNING receipt.reconciliation_id
         )
         INSERT INTO reflection_record_authority_reconciliations (
           reconciliation_id, record_id, expected_projection_generation,
           source_change_generation, state
         )
         SELECT 'authority-work:' || md5(updated.record_id || ':' || ($2::integer)::text),
                updated.record_id, updated.projection_generation, $2::integer, 'pending'
           FROM updated
         ON CONFLICT (record_id, source_change_generation) DO NOTHING
         RETURNING record_id`,
        [input.terminalAuthorityLeafHandle, input.sourceChangeGeneration],
      );
      return { dirtyRecordCount: dirtyRows.length, replayed: false };
    });
  }

  applyProjectionCas(input: AuthorityProjectionCasInput): Promise<"applied" | "stale" | "blocked"> {
    input = {...input, audienceSetCommitment: Uint8Array.from(input.audienceSetCommitment),
      terminalAuthorityLeafHandles: [...input.terminalAuthorityLeafHandles],
      alternatives: input.alternatives.map(entry => ({...entry, alternativeCommitment: Uint8Array.from(entry.alternativeCommitment)})),
      ...(input.protectedTransition === undefined ? {} : {protectedTransition: {...input.protectedTransition}})};
    return this.#serializable(async tx => {
      await this.#lock(tx, [input.recordRef]);
      const current = await this.#readProjection(tx, input.recordRef);
      if (current === null) return "stale";
      const receipt = await this.#readReceipt(tx, input);
      const transition = input.protectedTransition;
      const head = transition === undefined ? null : await this.#readHead(tx, input.recordRef);
      const attachOnly = current.projectionGeneration === input.expectedProjectionGeneration + 1
        && current.sourceChangeGeneration === input.sourceChangeGeneration && current.processingState === "current"
        && equalBytes(current.audienceSetCommitment, input.audienceSetCommitment);
      if (transition !== undefined) {
        if (receipt === null || receipt.expectedProjectionGeneration !== input.expectedProjectionGeneration
          || receipt.targetRepresentationGeneration !== transition.representationGeneration || receipt.targetCryptoObjectId !== transition.cryptoObjectId
          || JSON.stringify(receipt.targetAccessNamespaceIds) !== JSON.stringify(input.alternatives.map(entry => entry.accessNamespaceId).sort())
          || !equalBytes(receipt.targetAudienceSetCommitment, input.audienceSetCommitment)) throw new TypeError("Protected projection does not match its completed crypto receipt");
        if (receipt.state === "quarantined" || receipt.targetCryptoRetiredAt !== null) return "stale";
        if (receipt.state !== "crypto_complete" && receipt.state !== "complete") return "stale";
        // Actual object identity, not generation alone, makes lost replies harmless.
        if (receipt.state === "complete" && attachOnly && head?.generation === transition.representationGeneration && head.objectId === transition.cryptoObjectId) {
          if (await this.#newerSource(tx, input)) return "stale";
          if (await this.#blocked(tx, input.recordRef, current.projectionGeneration)) return "blocked";
          const at = await transition.authorizeCommit();
          if (!Number.isSafeInteger(at) || at < 0) throw new TypeError("Protected commit fence returned an invalid time");
          return "applied";
        }
        if (typeof transition.authorizeCommit !== "function") throw new TypeError("Protected projection requires a current commit fence");
      }
      if (current.projectionGeneration !== input.expectedProjectionGeneration && !(transition !== undefined && attachOnly)) return "stale";
      if (await this.#newerSource(tx, input)) return "stale";
      if (await this.#blocked(tx, input.recordRef, current.projectionGeneration)) return "blocked";
      if (transition !== undefined && (head === null || head.generation + 1 !== transition.representationGeneration
        || head.objectId === transition.cryptoObjectId || receipt?.formerCryptoObjectId !== head.objectId)) return "stale";
      if (attachOnly && transition !== undefined) {
        const alternatives = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select().from(reflectionRecordAuthorityAlternatives)
          .where(and(eq(reflectionRecordAuthorityAlternatives.recordId, input.recordRef), eq(reflectionRecordAuthorityAlternatives.projectionGeneration, current.projectionGeneration)))
          .orderBy(asc(reflectionRecordAuthorityAlternatives.alternativeOrdinal)));
        const closure = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({handle: reflectionRecordAuthorityClosure.terminalLeafHandle})
          .from(reflectionRecordAuthorityClosure).where(and(eq(reflectionRecordAuthorityClosure.recordId, input.recordRef), eq(reflectionRecordAuthorityClosure.closureGeneration, current.projectionGeneration)))
          .orderBy(asc(reflectionRecordAuthorityClosure.terminalLeafHandle)));
        if (alternatives.length !== input.alternatives.length || alternatives.some((entry, index) => {
          const expected = input.alternatives[index]!;
          return entry.access_namespace_id !== expected.accessNamespaceId || entry.includes_public_boundary !== expected.includesPublicBoundary
            || !equalBytes(entry.alternative_commitment, expected.alternativeCommitment);
        }) || JSON.stringify(closure.map(entry => entry.terminal_leaf_handle)) !== JSON.stringify([...input.terminalAuthorityLeafHandles].sort())) return "stale";
      }
      if (transition !== undefined) {
        const checkedAt = await transition.authorizeCommit();
        if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new TypeError("Protected commit fence returned an invalid time");
      }
      const nextGeneration = attachOnly ? current.projectionGeneration : input.expectedProjectionGeneration + 1;
      if (!attachOnly) {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb.update(reflectionRecordAuthorityProjections).set({current: false, updatedAt: sql`now()`})
          .where(and(eq(reflectionRecordAuthorityProjections.recordId, input.recordRef), eq(reflectionRecordAuthorityProjections.current, true))));
        await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityProjections).values({recordId: input.recordRef,
          projectionGeneration: nextGeneration, sourceChangeGeneration: input.sourceChangeGeneration,
          processingState: input.unavailableReason === undefined ? "current" : "unavailable", unavailableReason: input.unavailableReason ?? null,
          audienceSetCommitment: input.audienceSetCommitment, current: true, computedAt: sql`now()`, updatedAt: sql`now()`}));
        if (input.terminalAuthorityLeafHandles.length > 0) await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityClosure)
          .values(input.terminalAuthorityLeafHandles.map(terminalLeafHandle => ({recordId: input.recordRef, terminalLeafHandle, closureGeneration: nextGeneration}))));
        if (input.alternatives.length > 0) await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityAlternatives)
          .values(input.alternatives.map((entry, alternativeOrdinal) => ({recordId: input.recordRef, projectionGeneration: nextGeneration, alternativeOrdinal,
            accessNamespaceId: entry.accessNamespaceId, includesPublicBoundary: entry.includesPublicBoundary, alternativeCommitment: entry.alternativeCommitment}))));
      }
      if (transition !== undefined) {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordPayloadRepresentations).values({recordId: input.recordRef,
          representation: "protected", representationGeneration: transition.representationGeneration, payloadVersion: 1, cryptoObjectId: transition.cryptoObjectId}));
        const changed = await executeTypedRecordProductQuery(tx, recordProductTypedDb.update(reflectionRecordPayloadRepresentationHeads)
          .set({currentRepresentationGeneration: transition.representationGeneration, updatedAt: sql`now()`})
          .where(and(eq(reflectionRecordPayloadRepresentationHeads.recordId, input.recordRef), eq(reflectionRecordPayloadRepresentationHeads.representation, "protected"),
            eq(reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration, transition.representationGeneration - 1))).returning({recordId: reflectionRecordPayloadRepresentationHeads.recordId}));
        if (changed.length !== 1) throw new Error("Protected authority head CAS failed");
      }
      const state = transition === undefined && receipt?.targetCryptoObjectId !== null && receipt?.targetCryptoObjectId !== undefined ? receipt.state : "complete";
      await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityReconciliations).values({
        reconciliationId: sql`'authority-work:' || md5(${input.recordRef} || ':' || (${input.sourceChangeGeneration}::integer)::text)`,
        recordId: input.recordRef, expectedProjectionGeneration: input.expectedProjectionGeneration, sourceChangeGeneration: input.sourceChangeGeneration,
        state, sealedCheckpoint: input.sealedRepairState ?? null, completedAt: sql`now()`,
      }).onConflictDoUpdate({target: [reflectionRecordAuthorityReconciliations.recordId, reflectionRecordAuthorityReconciliations.sourceChangeGeneration], set: {
        state, completedAt: sql`coalesce(${reflectionRecordAuthorityReconciliations.completedAt}, now())`, updatedAt: sql`now()`,
        sealedCheckpoint: input.sealedRepairState ?? null, leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null,
      }}));
      return "applied";
    });
  }

  recordProtectedCryptoComplete(input: Parameters<AuthorityProjectionStorePort["recordProtectedCryptoComplete"]>[0]): Promise<"recorded" | "replayed" | "stale" | "blocked"> {
    input = {...input, targetAccessNamespaceIds: [...input.targetAccessNamespaceIds], targetAudienceSetCommitment: Uint8Array.from(input.targetAudienceSetCommitment)};
    if (input.targetAccessNamespaceIds.length < 1 || input.targetAccessNamespaceIds.length > 256
      || input.targetAccessNamespaceIds.some((id, index) => typeof id !== "string" || id.length < 1 || new TextEncoder().encode(id).length > 128
        || (index > 0 && input.targetAccessNamespaceIds[index - 1]! >= id)) || input.targetAudienceSetCommitment.length !== 32) throw new TypeError("Protected authority target access is invalid");
    return this.#serializable(async tx => {
      await this.#lock(tx, [input.recordRef]);
      const current = await this.#readProjection(tx, input.recordRef);
      const receipt = await this.#readReceipt(tx, input);
      const head = await this.#readHead(tx, input.recordRef);
      if (receipt !== null && (receipt.expectedProjectionGeneration !== input.expectedProjectionGeneration
        || (receipt.targetCryptoObjectId !== null && (receipt.targetCryptoObjectId !== input.targetCryptoObjectId
          || receipt.targetRepresentationGeneration !== input.targetRepresentationGeneration)))) return "stale";
      if (receipt?.targetAccessNamespaceIds != null && (JSON.stringify(receipt.targetAccessNamespaceIds) !== JSON.stringify(input.targetAccessNamespaceIds)
        || !equalBytes(receipt.targetAudienceSetCommitment, input.targetAudienceSetCommitment))) throw new TypeError("Protected authority target access conflicts with its receipt");
      if (receipt?.state === "quarantined" || receipt?.targetCryptoRetiredAt != null) return "stale";
      const logicalApplied = current !== null && current.projectionGeneration === input.expectedProjectionGeneration + 1
        && current.sourceChangeGeneration === input.sourceChangeGeneration && current.processingState === "current"
        && receipt?.completedAt !== null && receipt?.completedAt !== undefined && equalBytes(current.audienceSetCommitment, input.targetAudienceSetCommitment);
      if (receipt?.state === "complete" && receipt.targetCryptoObjectId === input.targetCryptoObjectId
        && head?.objectId === input.targetCryptoObjectId && head.generation === input.targetRepresentationGeneration) return "replayed";
      if (receipt?.state === "complete" && receipt.targetCryptoObjectId !== null) return "stale";
      const blocked = current !== null && await this.#blocked(tx, input.recordRef, current.projectionGeneration);
      const stale = current === null || (current.projectionGeneration !== input.expectedProjectionGeneration && !logicalApplied)
        || await this.#newerSource(tx, input) || head === null || head.generation + 1 !== input.targetRepresentationGeneration || head.objectId === input.targetCryptoObjectId;
      const obsolete = blocked || stale;
      if (receipt?.state === "crypto_complete" && !obsolete) return "replayed";
      const target = {state: obsolete ? "quarantined" as const : "crypto_complete" as const, failureCode: obsolete ? "mapping_conflict" : null,
        targetRepresentationGeneration: input.targetRepresentationGeneration, targetCryptoObjectId: input.targetCryptoObjectId,
        targetAccessNamespaceIds: [...input.targetAccessNamespaceIds], targetAudienceSetCommitment: input.targetAudienceSetCommitment,
        formerCryptoObjectId: receipt?.formerCryptoObjectId ?? head?.objectId ?? null,
        leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null, updatedAt: sql`now()`};
      await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityReconciliations).values({
        reconciliationId: sql`'authority-work:' || md5(${input.recordRef} || ':' || (${input.sourceChangeGeneration}::integer)::text)`,
        recordId: input.recordRef, expectedProjectionGeneration: input.expectedProjectionGeneration, sourceChangeGeneration: input.sourceChangeGeneration, ...target,
      }).onConflictDoUpdate({target: [reflectionRecordAuthorityReconciliations.recordId, reflectionRecordAuthorityReconciliations.sourceChangeGeneration], set: target}));
      return blocked ? "blocked" : stale ? "stale" : "recorded";
    });
  }

  claimDueReconciliations(
    limit: number,
    exact?: Parameters<AuthorityProjectionStorePort["claimDueReconciliations"]>[1],
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Authority reconciliation claim limit must be 1..256");
    }
    if (
      exact !== undefined
      && (
        exact.recordRef.trim().length === 0
        || !Number.isSafeInteger(exact.sourceChangeGeneration)
        || exact.sourceChangeGeneration < 1
      )
    ) {
      throw new TypeError("Exact authority reconciliation claim is invalid");
    }
    return this.handle.transaction(async (tx) => {
      if (exact !== undefined) {
        const projection = reflectionRecordAuthorityProjections;
        await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityReconciliations).select(
          recordProductTypedDb.select({
            reconciliationId: sql<string>`'authority-work:' || md5(${projection.recordId} || ':' || (${exact.sourceChangeGeneration}::integer)::text)`.as("reconciliation_id"),
            recordId: projection.recordId,
            expectedProjectionGeneration: projection.projectionGeneration,
            sourceChangeGeneration: projection.sourceChangeGeneration,
            state: sql<"pending">`'pending'`.as("state"),
            sealedCheckpoint: sql<null>`null`.as("sealed_checkpoint"),
            attemptCount: sql<number>`0`.as("attempt_count"),
            leaseToken: sql<null>`null`.as("lease_token"),
            leaseExpiresAt: sql<null>`null`.as("lease_expires_at"),
            nextAttemptAt: sql<null>`null`.as("next_attempt_at"),
            failureCode: sql<null>`null`.as("failure_code"),
            targetRepresentationGeneration: sql<null>`null`.as("target_representation_generation"),
            targetCryptoObjectId: sql<null>`null`.as("target_crypto_object_id"),
            targetAccessNamespaceIds: sql<null>`null`.as("target_access_namespace_ids"),
            targetAudienceSetCommitment: sql<null>`null`.as("target_audience_set_commitment"),
            targetCryptoRetiredAt: sql<null>`null`.as("target_crypto_retired_at"),
            formerCryptoObjectId: sql<null>`null`.as("former_crypto_object_id"),
            formerCryptoRetiredAt: sql<null>`null`.as("former_crypto_retired_at"),
            createdAt: sql<Date>`now()`.as("created_at"),
            updatedAt: sql<Date>`now()`.as("updated_at"),
            completedAt: sql<null>`null`.as("completed_at"),
          }).from(projection).where(and(eq(projection.recordId, exact.recordRef), eq(projection.current, true),
            eq(projection.sourceChangeGeneration, exact.sourceChangeGeneration),
            or(eq(projection.processingState, "dirty"), eq(projection.processingState, "reconciling"))))
        ).onConflictDoNothing({target: [reflectionRecordAuthorityReconciliations.recordId, reflectionRecordAuthorityReconciliations.sourceChangeGeneration]}));
      }
      const rows = await tx.query(
        `WITH candidates AS (
           SELECT receipt.reconciliation_id
             FROM reflection_record_authority_reconciliations AS receipt
             JOIN reflection_record_authority_projections AS projection
               ON projection.record_id = receipt.record_id
              AND projection.current = true
              AND projection.projection_generation = receipt.expected_projection_generation
            WHERE receipt.state IN ('pending', 'leased')
              AND ($2::text IS NULL OR (
                receipt.record_id = $2
                AND receipt.source_change_generation = $3
              ))
              AND receipt.attempt_count < 8
              AND (receipt.next_attempt_at IS NULL OR receipt.next_attempt_at <= now())
              AND (receipt.lease_expires_at IS NULL OR receipt.lease_expires_at <= now())
            ORDER BY receipt.created_at, receipt.reconciliation_id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE reflection_record_authority_reconciliations AS receipt
            SET state = 'leased',
                attempt_count = receipt.attempt_count + 1,
                lease_token = gen_random_uuid(),
                lease_expires_at = now() + interval '2 minutes',
                updated_at = now()
           FROM candidates
          WHERE receipt.reconciliation_id = candidates.reconciliation_id
        RETURNING receipt.record_id, receipt.expected_projection_generation,
                  receipt.source_change_generation, receipt.lease_token,
                  receipt.attempt_count, receipt.sealed_checkpoint`,
        [
          limit,
          exact?.recordRef ?? null,
          exact?.sourceChangeGeneration ?? null,
        ],
      );
      if (rows.length > 0) {
        await tx.query(
          `UPDATE reflection_record_authority_projections
              SET processing_state = 'reconciling', updated_at = now()
            WHERE current = true
              AND processing_state = 'dirty'
              AND record_id = ANY($1::text[])`,
          [[...new Set(rows.map((row) => rowString(row, "record_id")))]],
        );
      }
      return rows.map((row) => ({
        recordRef: rowString(row, "record_id"),
        expectedProjectionGeneration: rowInteger(
          row,
          "expected_projection_generation",
        ),
        sourceChangeGeneration: rowInteger(row, "source_change_generation"),
        leaseToken: rowString(row, "lease_token"),
        attemptCount: rowInteger(row, "attempt_count"),
        ...(row["sealed_checkpoint"] instanceof Uint8Array
          ? { sealedCheckpoint: row["sealed_checkpoint"] }
          : {}),
      }));
    }, { isolationLevel: "read committed" });
  }

  deferReconciliation(input: Readonly<{
    recordRef: string;
    sourceChangeGeneration: number;
    leaseToken: string;
    sealedCheckpoint?: Uint8Array;
    failureCode?: AuthorityReconciliationFailureCode;
    nextAttemptAt: Date;
    terminal: boolean;
  }>): Promise<"deferred" | "retry_exhausted" | "quarantined" | "conflict"> {
    return this.#serializable(async (tx) => {
      if (!Number.isFinite(input.nextAttemptAt.getTime())) return "conflict";
      const checkpointOnly = input.sealedCheckpoint !== undefined
        && input.failureCode === undefined
        && !input.terminal;
      await this.#lock(tx, [input.recordRef, input.leaseToken]);
      const rows = await tx.query(
        `SELECT state, attempt_count, lease_token
           FROM reflection_record_authority_reconciliations
          WHERE record_id = $1 AND source_change_generation = $2
          FOR UPDATE`,
        [input.recordRef, input.sourceChangeGeneration],
      );
      if (
        rows.length !== 1
        || rowString(rows[0]!, "state") !== "leased"
        || rowString(rows[0]!, "lease_token") !== input.leaseToken
      ) return "conflict";
      const exhausted = !checkpointOnly
        && rowInteger(rows[0]!, "attempt_count") >= 8;
      const quarantined = input.terminal || exhausted;
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordAuthorityReconciliations)
        .set({
          state: quarantined ? "quarantined" : "pending",
          sealedCheckpoint: input.sealedCheckpoint ?? null,
          failureCode: input.failureCode ?? null,
          nextAttemptAt: input.nextAttemptAt,
          leaseToken: null,
          leaseExpiresAt: null,
          ...(checkpointOnly
            ? {
                attemptCount: sql`greatest(${
                  reflectionRecordAuthorityReconciliations.attemptCount
                } - 1, 0)`,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(and(
          eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
          eq(
            reflectionRecordAuthorityReconciliations.sourceChangeGeneration,
            input.sourceChangeGeneration,
          ),
        )));
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordAuthorityProjections)
        .set({ processingState: "dirty", updatedAt: sql`now()` })
        .where(and(
          eq(reflectionRecordAuthorityProjections.recordId, input.recordRef),
          eq(reflectionRecordAuthorityProjections.current, true),
          eq(
            reflectionRecordAuthorityProjections.processingState,
            "reconciling",
          ),
        )));
      return input.terminal
        ? "quarantined"
        : exhausted
          ? "retry_exhausted"
          : "deferred";
    });
  }

  async #objectIsCurrent(tx: RecordProductPostgresExecutor, cryptoObjectId: string) {
    const rows = await executeTypedRecordProductQuery(tx, recordProductTypedDb.select({found: sql<number>`1`.as("found")})
      .from(reflectionRecordPayloadRepresentationHeads).innerJoin(reflectionRecordPayloadRepresentations, and(
        eq(reflectionRecordPayloadRepresentations.recordId, reflectionRecordPayloadRepresentationHeads.recordId),
        eq(reflectionRecordPayloadRepresentations.representation, reflectionRecordPayloadRepresentationHeads.representation),
        eq(reflectionRecordPayloadRepresentations.representationGeneration, reflectionRecordPayloadRepresentationHeads.currentRepresentationGeneration),
      )).where(eq(reflectionRecordPayloadRepresentations.cryptoObjectId, cryptoObjectId)).limit(1));
    return rows.length > 0;
  }

  /** Verified saved A output can outlive its product work without ever attaching.
   * Only obsolete, unreachable targets enter the existing retirement receipt. */
  quarantineUnattachedProtectedTarget(input: Readonly<{
    recordRef: string; sourceChangeGeneration: number; expectedProjectionGeneration: number;
    targetRepresentationGeneration: number; targetCryptoObjectId: string;
  }>): Promise<"quarantined" | "replayed" | "conflict"> {
    if (!Number.isSafeInteger(input.sourceChangeGeneration) || input.sourceChangeGeneration < 1
      || !Number.isSafeInteger(input.expectedProjectionGeneration) || input.expectedProjectionGeneration < 1
      || !Number.isSafeInteger(input.targetRepresentationGeneration) || input.targetRepresentationGeneration < 2
      || input.recordRef.length === 0 || input.targetCryptoObjectId.length === 0) throw new TypeError("Invalid obsolete Reflection target");
    return this.#serializable(async tx => {
      await this.#lock(tx, [input.recordRef, input.targetCryptoObjectId]);
      if (await this.#objectIsCurrent(tx, input.targetCryptoObjectId)) return "conflict";
      const receipt = await this.#readReceipt(tx, input);
      if (receipt !== null && (receipt.expectedProjectionGeneration !== input.expectedProjectionGeneration
        || (receipt.targetCryptoObjectId !== null && (receipt.targetCryptoObjectId !== input.targetCryptoObjectId
          || receipt.targetRepresentationGeneration !== input.targetRepresentationGeneration)))) return "conflict";
      if (receipt?.state === "quarantined" && receipt.targetCryptoObjectId === input.targetCryptoObjectId) return "replayed";
      if (receipt?.state === "complete" && receipt.targetCryptoObjectId !== null) return "conflict";
      const current = await this.#readProjection(tx, input.recordRef);
      const head = await this.#readHead(tx, input.recordRef);
      // A logical ordinary catch-up at expected+1 is still eligible for its
      // protected attachment. Mere generation difference is not abandonment.
      const logicalCatchup = current?.projectionGeneration === input.expectedProjectionGeneration + 1
        && current.sourceChangeGeneration === input.sourceChangeGeneration && receipt?.completedAt != null;
      const obsolete = current === null || head === null
        || current.sourceChangeGeneration > input.sourceChangeGeneration
        || (current.projectionGeneration !== input.expectedProjectionGeneration && !logicalCatchup)
        || head.generation + 1 !== input.targetRepresentationGeneration
        || await this.#newerSource(tx, input)
        || await this.#blocked(tx, input.recordRef, current.projectionGeneration);
      if (!obsolete) return "conflict";
      const target = {state: "quarantined" as const, failureCode: "mapping_conflict",
        targetRepresentationGeneration: input.targetRepresentationGeneration, targetCryptoObjectId: input.targetCryptoObjectId,
        leaseToken: null, leaseExpiresAt: null, nextAttemptAt: null, updatedAt: sql`now()`};
      await executeTypedRecordProductQuery(tx, recordProductTypedDb.insert(reflectionRecordAuthorityReconciliations).values({
        reconciliationId: sql`'authority-work:' || md5(${input.recordRef} || ':' || (${input.sourceChangeGeneration}::integer)::text)`,
        recordId: input.recordRef, expectedProjectionGeneration: input.expectedProjectionGeneration,
        sourceChangeGeneration: input.sourceChangeGeneration, ...target,
      }).onConflictDoUpdate({target: [reflectionRecordAuthorityReconciliations.recordId, reflectionRecordAuthorityReconciliations.sourceChangeGeneration], set: target}));
      return "quarantined";
    });
  }

  withProtectedRetirementFence(input: Readonly<{recordRef: string; sourceChangeGeneration: number; cryptoObjectId: string; kind: "former" | "target"}>, retire: () => Promise<void>): Promise<"completed" | "replayed" | "conflict"> {
    return this.#serializable(async tx => {
      await this.#lock(tx, [input.recordRef, input.cryptoObjectId]);
      const receipt = await this.#readReceipt(tx, input);
      if (receipt === null || (input.kind === "target"
        ? receipt.state !== "quarantined" || receipt.targetCryptoObjectId !== input.cryptoObjectId
        : receipt.state !== "complete" || receipt.formerCryptoObjectId !== input.cryptoObjectId)) return "conflict";
      if (await this.#objectIsCurrent(tx, input.cryptoObjectId)) return "conflict";
      if ((input.kind === "target" ? receipt.targetCryptoRetiredAt : receipt.formerCryptoRetiredAt) !== null) return "replayed";
      await retire();
      await executeTypedRecordProductQuery(tx, recordProductTypedDb.update(reflectionRecordAuthorityReconciliations)
        .set({...input.kind === "target" ? {targetCryptoRetiredAt: sql`now()`} : {formerCryptoRetiredAt: sql`now()`}, updatedAt: sql`now()`})
        .where(and(eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef), eq(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, input.sourceChangeGeneration))));
      return "completed";
    });
  }

  async listDueProtectedRetirements(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Authority retirement limit must be 1..256");
    }
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecordAuthorityReconciliations.recordId,
        source_change_generation:
          reflectionRecordAuthorityReconciliations.sourceChangeGeneration,
        former_crypto_object_id:
          reflectionRecordAuthorityReconciliations.formerCryptoObjectId,
      })
        .from(reflectionRecordAuthorityReconciliations)
        .where(and(
          eq(reflectionRecordAuthorityReconciliations.state, "complete"),
          isNotNull(reflectionRecordAuthorityReconciliations.formerCryptoObjectId),
          isNull(reflectionRecordAuthorityReconciliations.formerCryptoRetiredAt),
          sql`not exists (
            select 1 from ${reflectionRecordPayloadRepresentationHeads} as head
            join ${reflectionRecordPayloadRepresentations} as payload on payload.record_id = head.record_id
              and payload.representation = head.representation and payload.representation_generation = head.current_representation_generation
            where payload.crypto_object_id = ${reflectionRecordAuthorityReconciliations.formerCryptoObjectId}
          )`,
        ))
        .orderBy(
          asc(reflectionRecordAuthorityReconciliations.completedAt),
          asc(reflectionRecordAuthorityReconciliations.reconciliationId),
        )
        .limit(limit));
    return rows.map((row) => ({
      recordRef: rowString(row, "record_id"),
      sourceChangeGeneration: rowInteger(row, "source_change_generation"),
      formerCryptoObjectId: rowString(row, "former_crypto_object_id"),
    }));
  }

  /** Completed crypto that lost product authority still has durable cleanup. */
  async listDueProtectedTargetRetirements(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new RangeError("Authority retirement limit must be 1..256");
    }
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        record_id: reflectionRecordAuthorityReconciliations.recordId,
        source_change_generation: reflectionRecordAuthorityReconciliations.sourceChangeGeneration,
        target_crypto_object_id: reflectionRecordAuthorityReconciliations.targetCryptoObjectId,
      }).from(reflectionRecordAuthorityReconciliations).where(and(
        or(eq(reflectionRecordAuthorityReconciliations.state, "quarantined"), and(
          or(eq(reflectionRecordAuthorityReconciliations.state, "crypto_complete"), eq(reflectionRecordAuthorityReconciliations.state, "attached")),
          sql`(exists (select 1 from ${reflectionRecordAuthorityReconciliations} as newer
              where newer.record_id = ${reflectionRecordAuthorityReconciliations.recordId}
                and newer.source_change_generation > ${reflectionRecordAuthorityReconciliations.sourceChangeGeneration})
            or exists (select 1 from ${reflectionRecords} as record
              where record.record_id = ${reflectionRecordAuthorityReconciliations.recordId} and record.disposition <> 'available')
            or exists (select 1 from ${reflectionRecordAuthorityBlocks} as block
              where block.record_id = ${reflectionRecordAuthorityReconciliations.recordId}
                or block.terminal_leaf_handle in (select closure.terminal_leaf_handle from ${reflectionRecordAuthorityClosure} as closure
                  join ${reflectionRecordAuthorityProjections} as projection on projection.record_id = closure.record_id
                    and projection.projection_generation = closure.closure_generation and projection.current = true
                  where closure.record_id = ${reflectionRecordAuthorityReconciliations.recordId})))`,
        )),
        isNotNull(reflectionRecordAuthorityReconciliations.targetCryptoObjectId),
        isNull(reflectionRecordAuthorityReconciliations.targetCryptoRetiredAt),
        sql`not exists (
          select 1 from ${reflectionRecordPayloadRepresentationHeads} as head
          join ${reflectionRecordPayloadRepresentations} as payload
            on payload.record_id = head.record_id and payload.representation = head.representation
            and payload.representation_generation = head.current_representation_generation
          where payload.crypto_object_id = ${reflectionRecordAuthorityReconciliations.targetCryptoObjectId}
        )`,
      )).orderBy(asc(reflectionRecordAuthorityReconciliations.updatedAt), asc(reflectionRecordAuthorityReconciliations.reconciliationId))
        .limit(limit));
    const due: {recordRef: string; sourceChangeGeneration: number; targetCryptoObjectId: string}[] = [];
    for (const row of rows) {
      const candidate = {recordRef: rowString(row, "record_id"), sourceChangeGeneration: rowInteger(row, "source_change_generation"), targetCryptoObjectId: rowString(row, "target_crypto_object_id")};
      const retained = await this.#serializable(async tx => {
        await this.#lock(tx, [candidate.recordRef, candidate.targetCryptoObjectId]);
        const receipt = await this.#readReceipt(tx, candidate);
        if (receipt === null || receipt.targetCryptoObjectId !== candidate.targetCryptoObjectId || receipt.targetCryptoRetiredAt !== null
          || await this.#objectIsCurrent(tx, candidate.targetCryptoObjectId)) return false;
        if (receipt.state === "quarantined") return true;
        if (receipt.state !== "crypto_complete" && receipt.state !== "attached") return false;
        const current = await this.#readProjection(tx, candidate.recordRef);
        if (!await this.#newerSource(tx, candidate) && current !== null && !await this.#blocked(tx, candidate.recordRef, current.projectionGeneration)) return false;
        await executeTypedRecordProductQuery(tx, recordProductTypedDb.update(reflectionRecordAuthorityReconciliations)
          .set({state: "quarantined", failureCode: "mapping_conflict", updatedAt: sql`now()`})
          .where(and(eq(reflectionRecordAuthorityReconciliations.recordId, candidate.recordRef), eq(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, candidate.sourceChangeGeneration))));
        return true;
      });
      if (retained) due.push(candidate);
    }
    return due;
  }

  completeProtectedTargetRetirement(input: Readonly<{
    recordRef: string; sourceChangeGeneration: number; targetCryptoObjectId: string;
  }>): Promise<"completed" | "replayed" | "conflict"> {
    return this.#serializable(async tx => {
      await this.#lock(tx, [input.recordRef, input.targetCryptoObjectId]);
      const rows = await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.select({
          state: reflectionRecordAuthorityReconciliations.state,
          target_crypto_object_id: reflectionRecordAuthorityReconciliations.targetCryptoObjectId,
          target_crypto_retired_at: reflectionRecordAuthorityReconciliations.targetCryptoRetiredAt,
        }).from(reflectionRecordAuthorityReconciliations).where(and(
          eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
          eq(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, input.sourceChangeGeneration),
        )).for("update"));
      const receipt = rows[0];
      if (rows.length !== 1 || receipt === undefined || receipt.state !== "quarantined"
        || receipt.target_crypto_object_id !== input.targetCryptoObjectId) return "conflict";
      if (await this.#objectIsCurrent(tx, input.targetCryptoObjectId)) return "conflict";
      if (receipt.target_crypto_retired_at !== null) return "replayed";
      await executeTypedRecordProductQuery(tx,
        recordProductTypedDb.update(reflectionRecordAuthorityReconciliations)
          .set({targetCryptoRetiredAt: sql`now()`, updatedAt: sql`now()`})
          .where(and(eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
            eq(reflectionRecordAuthorityReconciliations.sourceChangeGeneration, input.sourceChangeGeneration))));
      return "completed";
    });
  }

  completeProtectedRetirement(input: Readonly<{
    recordRef: string;
    sourceChangeGeneration: number;
    formerCryptoObjectId: string;
  }>): Promise<"completed" | "replayed" | "conflict"> {
    return this.#serializable(async (tx) => {
      await this.#lock(tx, [input.recordRef, input.formerCryptoObjectId]);
      const rows = await tx.query(
        `SELECT former_crypto_object_id, former_crypto_retired_at
           FROM reflection_record_authority_reconciliations
          WHERE record_id = $1 AND source_change_generation = $2
          FOR UPDATE`,
        [input.recordRef, input.sourceChangeGeneration],
      );
      if (
        rows.length !== 1
        || typeof rows[0]!["former_crypto_object_id"] !== "string"
        || rows[0]!["former_crypto_object_id"] !== input.formerCryptoObjectId
      ) return "conflict";
      if (await this.#objectIsCurrent(tx, input.formerCryptoObjectId)) return "conflict";
      if (rows[0]!["former_crypto_retired_at"] instanceof Date) return "replayed";
      await executeTypedRecordProductQuery(tx, recordProductTypedDb
        .update(reflectionRecordAuthorityReconciliations)
        .set({ formerCryptoRetiredAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(
          eq(reflectionRecordAuthorityReconciliations.recordId, input.recordRef),
          eq(
            reflectionRecordAuthorityReconciliations.sourceChangeGeneration,
            input.sourceChangeGeneration,
          ),
        )));
      return "completed";
    });
  }

  block(input: Readonly<{
    blockRef: string;
    recordRef?: string;
    terminalAuthorityLeafHandle?: string;
    disposition: "blocked" | "purged";
  }>): Promise<"applied" | "replayed" | "conflict"> {
    return this.#serializable(async (tx) => {
      if ((input.recordRef === undefined) === (input.terminalAuthorityLeafHandle === undefined)) {
        return "conflict";
      }
      await this.#lock(tx, [input.blockRef, input.recordRef ?? input.terminalAuthorityLeafHandle!]);
      const rows = await tx.query(
        `SELECT block_id, record_id, terminal_leaf_handle, disposition
           FROM reflection_record_authority_blocks
          WHERE block_id = $1
             OR ($2::text IS NOT NULL AND record_id = $2)
             OR ($3::text IS NOT NULL AND terminal_leaf_handle = $3)
          FOR UPDATE`,
        [input.blockRef, input.recordRef ?? null, input.terminalAuthorityLeafHandle ?? null],
      );
      if (rows.length > 0) {
        const row = rows[0]!;
        if (
          rowString(row, "block_id") !== input.blockRef
          || row["record_id"] !== (input.recordRef ?? null)
          || row["terminal_leaf_handle"] !== (input.terminalAuthorityLeafHandle ?? null)
        ) return "conflict";
        const existing = rowString(row, "disposition");
        if (existing === input.disposition) return "replayed";
        if (existing !== "blocked" || input.disposition !== "purged") return "conflict";
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecordAuthorityBlocks)
          .set({ disposition: "purged" })
          .where(eq(reflectionRecordAuthorityBlocks.blockId, input.blockRef)));
      } else {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .insert(reflectionRecordAuthorityBlocks)
          .values({
            blockId: input.blockRef,
            recordId: input.recordRef ?? null,
            terminalLeafHandle: input.terminalAuthorityLeafHandle ?? null,
            disposition: input.disposition,
          }));
      }
      if (input.recordRef !== undefined) {
        await executeTypedRecordProductQuery(tx, recordProductTypedDb
          .update(reflectionRecords)
          .set({ disposition: input.disposition, updatedAt: sql`now()` })
          .where(and(
            eq(reflectionRecords.recordId, input.recordRef),
            ne(reflectionRecords.disposition, "purged"),
          )));
      }
      return "applied";
    });
  }

  async readContentFreeHealth(
    representation: "ordinary" | "protected",
  ) {
    const rows = await executeTypedRecordProductQuery(this.handle,
      recordProductTypedDb.select({
        current_count: sql<number>`count(distinct ${
          reflectionRecordAuthorityProjections.recordId
        }) filter (where ${
          reflectionRecordAuthorityProjections.processingState
        } = 'current')::integer`.as("current_count"),
        dirty_count: sql<number>`count(distinct ${
          reflectionRecordAuthorityProjections.recordId
        }) filter (where ${
          reflectionRecordAuthorityProjections.processingState
        } = 'dirty')::integer`.as("dirty_count"),
        reconciling_count: sql<number>`count(distinct ${
          reflectionRecordAuthorityProjections.recordId
        }) filter (where ${
          reflectionRecordAuthorityProjections.processingState
        } = 'reconciling')::integer`.as("reconciling_count"),
        unavailable_count: sql<number>`count(distinct ${
          reflectionRecordAuthorityProjections.recordId
        }) filter (where ${
          reflectionRecordAuthorityProjections.processingState
        } = 'unavailable')::integer`.as("unavailable_count"),
        purged_count: sql<number>`count(distinct ${
          reflectionRecordAuthorityProjections.recordId
        }) filter (where ${
          reflectionRecordAuthorityProjections.processingState
        } = 'purged')::integer`.as("purged_count"),
        oldest_dirty_at: sql<Date | null>`min(${reflectionRecordAuthorityProjections.dirtySince})`
          .as("oldest_dirty_at"),
        maximum_attempt_count: sql<number>`coalesce(max(${
          reflectionRecordAuthorityReconciliations.attemptCount
        }), 0)::integer`.as("maximum_attempt_count"),
        retry_exhausted_count: sql<number>`count(distinct ${
          reflectionRecordAuthorityReconciliations.reconciliationId
        }) filter (where ${
          reflectionRecordAuthorityReconciliations.state
        } = 'quarantined' and ${
          reflectionRecordAuthorityReconciliations.attemptCount
        } >= 8)::integer`.as("retry_exhausted_count"),
      })
        .from(reflectionRecordAuthorityProjections)
        .leftJoin(reflectionRecordAuthorityReconciliations, and(
          eq(
            reflectionRecordAuthorityReconciliations.recordId,
            reflectionRecordAuthorityProjections.recordId,
          ),
          sql`${reflectionRecordAuthorityReconciliations.sourceChangeGeneration}
            >= ${reflectionRecordAuthorityProjections.sourceChangeGeneration}`,
        ))
        .where(eq(reflectionRecordAuthorityProjections.current, true)));
    const row = rows[0];
    if (row === undefined) throw new TypeError("Authority health row is missing");
    return {
      selectedRepresentation: representation,
      currentCount: rowInteger(row, "current_count"),
      dirtyCount: rowInteger(row, "dirty_count"),
      reconcilingCount: rowInteger(row, "reconciling_count"),
      unavailableCount: rowInteger(row, "unavailable_count"),
      purgedCount: rowInteger(row, "purged_count"),
      oldestDirtyAt: row["oldest_dirty_at"] instanceof Date
        ? row["oldest_dirty_at"]
        : null,
      maximumAttemptCount: rowInteger(row, "maximum_attempt_count"),
      retryExhaustedCount: rowInteger(row, "retry_exhausted_count"),
    };
  }

  async #lock(tx: RecordProductPostgresExecutor, ids: readonly string[]): Promise<void> {
    await tx.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(lock_id, 0))
         FROM (SELECT DISTINCT lock_id FROM unnest($1::text[]) AS lock_id ORDER BY lock_id) locks`,
      [[...new Set(ids)]],
    );
  }

  async #serializable<Result>(
    callback: (tx: RecordProductPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.handle.transaction(callback, { isolationLevel: "serializable" });
      } catch (error) {
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    }
    throw new Error("Unreachable authority transaction state");
  }
}

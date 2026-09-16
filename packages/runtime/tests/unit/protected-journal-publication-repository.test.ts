import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  verifyConversationProductPostgresHandle,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";
import { encodeRoomEventRollupPayloadV1, encodeStenographerOutputRepairPlan } from "@nautilo/lattice-bridge";
import {
  buildStenographerRecordPublication,
  createHmacProtectedStenographerRecordCommitmentPort,
  encodeDurableRecordEnvelope,
} from "@nautilo/reflection-bridge/server";

import {
  PROTECTED_JOURNAL_CONTENT_SENTINEL,
  encodeProtectedJournalAttachmentPlanV1,
  type ProtectedJournalAttachmentPlanV1,
} from "../../src/stenographer/protected-journal-output-planner";
import {
  PostgresProtectedJournalPublicationRepository,
  ProtectedJournalPublicationConflictError,
  type ReserveCurrentProtectedJournalPublicationInput,
  type ProtectedJournalPublicationRecord,
  type ReserveProtectedJournalPublicationInput,
} from "../../src/stenographer/protected-publication-repository";
import {
  fingerprintProtectedStenographerCoveredRange,
  type ProtectedStenographerSourceMetadata,
} from "../../src/stenographer/protected-batch-planner";
import {
  fingerprintProtectedStenographerSourceBindings,
  type ProtectedStenographerSourceBinding,
} from "../../src/stenographer/protected-source-loader";

const NOW = new Date("2026-08-04T10:00:00.000Z");
const LEASE_EXPIRES = new Date(NOW.getTime() + 120_000);
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ID = "44444444-4444-4444-8444-444444444444";
const PRIOR_EVENT_ID = "88888888-8888-4888-8888-888888888888";
const ROLLUP_ID = "55555555-5555-4555-8555-555555555555";
const RECEIPT_LEASE = "66666666-6666-4666-8666-666666666666";
const SOURCE_LEASE = "77777777-7777-4777-8777-777777777777";
const EVENT_OBJECT = "journal/event/work-1/slot-000";
const ROLLUP_OBJECT = "journal/rollup/work-2/slot-000";
const MESSAGE_OBJECT = "message/work-1/source-041";
const PARTICIPANT_ID = "99999999-9999-4999-8999-999999999999";
const HUMAN_ONLY_OBJECT = "message/work-1/source-042-human";
const RECORD_COMMITMENT = createHmacProtectedStenographerRecordCommitmentPort(
  new Uint8Array(32).fill(0x67),
);

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

class ScriptedProductConnection
  implements ConversationProductPostgresConnection
{
  readonly statements: string[] = [];
  readonly parameters: ConversationProductPostgresScalar[][] = [];
  readonly parameterSnapshots: ConversationProductPostgresScalar[][] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly committedTransactionStatements: string[] = [];
  readonly rolledBackTransactionStatements: string[] = [];
  transactions = 0;
  transactionFailures = 0;
  #activeTransactionStatements: string[] | null = null;
  readonly #results: Array<readonly unknown[] | Error>;

  constructor(results: readonly (readonly unknown[] | Error)[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.#activeTransactionStatements?.push(statement);
    this.parameters.push([...parameters]);
    this.parameterSnapshots.push(parameters.map((parameter) =>
      parameter instanceof Uint8Array ? parameter.slice() : parameter
    ));
    const result = this.#results.shift() ?? [];
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result as readonly Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
    options: Readonly<{
      isolationLevel: ConversationProductPostgresIsolationLevel;
    }>,
  ): Promise<Result> {
    if (this.#activeTransactionStatements !== null) {
      throw new Error("nested product transaction");
    }
    this.transactions += 1;
    this.isolationLevels.push(options.isolationLevel);
    const staged: string[] = [];
    this.#activeTransactionStatements = staged;
    try {
      const result = await callback(this);
      this.committedTransactionStatements.push(...staged);
      return result;
    } catch (error) {
      this.transactionFailures += 1;
      this.rolledBackTransactionStatements.push(...staged);
      throw error;
    } finally {
      this.#activeTransactionStatements = null;
    }
  }
}

function hash(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(bytes).digest());
}

function extractionPlan(): ProtectedJournalAttachmentPlanV1 {
  return {
    kind: "extraction",
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    rebuildGeneration: 3,
    sourceBatchId: BATCH_ID,
    statusUpdates: [],
    events: [{
      eventId: EVENT_ID,
      objectId: EVENT_OBJECT,
      sequence: 9,
      kind: "decision",
      status: "active",
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [41, 42],
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: 0,
      extractorVersion: "m241-v1",
      createdAt: NOW.toISOString(),
    }],
    foldedBatchLocalOrdinals: [],
    rollup: null,
  };
}

function emptyExtractionPlan(): ProtectedJournalAttachmentPlanV1 {
  return {
    kind: "extraction",
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    rebuildGeneration: 3,
    sourceBatchId: BATCH_ID,
    statusUpdates: [],
    events: [],
    foldedBatchLocalOrdinals: [],
    rollup: null,
  };
}

function rollupPlan(): ProtectedJournalAttachmentPlanV1 {
  return {
    kind: "rollup",
    roomId: ROOM_ID,
    namespaceId: NAMESPACE_ID,
    rebuildGeneration: 3,
    sourceBatchId: null,
    statusUpdates: [],
    events: [],
    foldedBatchLocalOrdinals: [],
    rollup: {
      rollupId: ROLLUP_ID,
      objectId: ROLLUP_OBJECT,
      throughEventSequence: 200,
      sourceEventCount: 180,
      modelId: "compact-model",
      compactorVersion: "m241-v1",
      createdAt: NOW.toISOString(),
    },
  };
}

function reservation(
  plan: ProtectedJournalAttachmentPlanV1 = extractionPlan(),
): ReserveProtectedJournalPublicationInput {
  const attachmentPlanBytes =
    encodeProtectedJournalAttachmentPlanV1(plan);
  return {
    publicationId: plan.kind === "extraction"
      ? "publication-extraction-1"
      : "publication-rollup-1",
    requestId: plan.kind === "extraction"
      ? "request-extraction-1"
      : "request-rollup-1",
    workId: plan.kind === "extraction"
      ? "work-extraction-1"
      : "work-rollup-1",
    workIdentityHash: new Uint8Array(32).fill(
      plan.kind === "extraction" ? 0x11 : 0x12,
    ),
    descriptorHash: new Uint8Array(32).fill(
      plan.kind === "extraction" ? 0x21 : 0x22,
    ),
    attachmentPlanHash: hash(attachmentPlanBytes),
    attachmentPlanBytes,
    now: NOW,
  };
}

function currentReservation(): ReserveCurrentProtectedJournalPublicationInput {
  const bindings: readonly ProtectedStenographerSourceBinding[] = [{
    kind: "message",
    objectId: MESSAGE_OBJECT,
    source: "current",
    messageId: 41,
    editRevision: 2,
    createdAt: NOW,
    participantId: PARTICIPANT_ID,
    role: "user",
    conversationalBoundary: true,
  }];
  return {
    ...reservation(),
    publicationLeaseToken: RECEIPT_LEASE,
    sourceLeaseToken: SOURCE_LEASE,
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings(bindings),
    sourceBindings: bindings,
    source: {
      kind: "extraction",
      lane: "live",
      fromMessageIdExclusive: 40,
      throughMessageIdInclusive: 42,
      extractorVersion: "m241-v1",
      coveredRangeFingerprint:
        fingerprintProtectedStenographerCoveredRange({
          fromMessageIdExclusive: 40,
          throughMessageIdInclusive: 42,
          rows: coveredRangeMetadata(),
        }),
    },
  };
}

function compactionCurrentReservation():
  ReserveCurrentProtectedJournalPublicationInput {
  const bindings: readonly ProtectedStenographerSourceBinding[] = [{
    kind: "event",
    objectId: "journal/event/source-1",
    status: "active",
    binding: {
      eventId: PRIOR_EVENT_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      sequence: 1,
      kind: "fact",
      supersedesEventId: null,
      resolvesEventId: null,
      sourceMessageIds: [41],
      sourceBatchId: BATCH_ID,
      batchLocalOrdinal: 0,
      extractorVersion: "m241-v1",
      createdAt: NOW.toISOString(),
    },
  }];
  return {
    ...reservation(rollupPlan()),
    publicationLeaseToken: RECEIPT_LEASE,
    sourceLeaseToken: SOURCE_LEASE,
    sourceBindingFingerprint:
      fingerprintProtectedStenographerSourceBindings(bindings),
    sourceBindings: bindings,
    source: {
      kind: "compaction",
      activeEventCount: 1,
      selectedEventCount: 1,
      hasDeferredMiddle: false,
    },
  };
}

function coveredRangeMetadata(): readonly ProtectedStenographerSourceMetadata[] {
  return [{
    messageId: 41,
    editRevision: 2,
    createdAt: NOW,
    role: "user",
    fingerprint: null,
    transcriptOrigin: "main",
    originatedBy: null,
    excludedFromEvidence: false,
    keyClass: "ai",
    cryptoObjectId: MESSAGE_OBJECT,
    cryptoCompletion: "complete",
  }, {
    messageId: 42,
    editRevision: 0,
    createdAt: NOW,
    role: "user",
    fingerprint: null,
    transcriptOrigin: "main",
    originatedBy: null,
    excludedFromEvidence: true,
    keyClass: "human",
    cryptoObjectId: HUMAN_ONLY_OBJECT,
    cryptoCompletion: "complete",
  }];
}

function coveredRangeRows(
  overrides: Partial<ConversationProductDatabaseRow> = {},
): readonly ConversationProductDatabaseRow[] {
  return coveredRangeMetadata().map((metadata) => ({
    message_id: metadata.messageId,
    edit_revision: metadata.editRevision,
    created_at: metadata.createdAt,
    role: metadata.role,
    fingerprint: metadata.fingerprint,
    transcript_origin: metadata.transcriptOrigin,
    originated_by: metadata.originatedBy,
    excluded_from_evidence: metadata.excludedFromEvidence,
    key_class: metadata.keyClass,
    crypto_object_id: metadata.cryptoObjectId,
    crypto_completion: metadata.cryptoCompletion,
    ...(metadata.messageId === 42 ? overrides : {}),
  }));
}

function attachmentInput(record: ProtectedJournalPublicationRecord) {
  const source = currentReservation();
  return {
    publicationId: record.publicationId,
    leaseToken: RECEIPT_LEASE,
    sourceLeaseToken: SOURCE_LEASE,
    sourceBindingFingerprint: source.sourceBindingFingerprint,
    sourceBindings: source.sourceBindings,
    source: source.source,
    now: NOW,
  };
}

function extractionCoordinateRow(
  rebuildGeneration = 3,
): ConversationProductDatabaseRow {
  return {
    namespace_id: NAMESPACE_ID,
    rebuild_generation: rebuildGeneration,
    rebuild_requested_at: null,
    lease_token: SOURCE_LEASE,
    lease_expires_at: LEASE_EXPIRES,
    compaction_lease_token: null,
    compaction_lease_expires_at: null,
  };
}

function extractionSourceRecheckResults() {
  return [
    [extractionCoordinateRow()],
    [{
      id: BATCH_ID,
      from_message_id_exclusive: 40,
      through_message_id_inclusive: 42,
      extractor_version: "m241-v1",
      lane: "live",
      status: "running",
    }],
    [{
      crypto_object_id: MESSAGE_OBJECT,
      message_id: 41,
      edit_revision: 2,
      created_at: NOW,
      role: "user",
      participant_id: PARTICIPANT_ID,
    }],
    coveredRangeRows(),
  ] as const;
}

function compactionSourceRecheckResults() {
  return [
    [{
      namespace_id: NAMESPACE_ID,
      rebuild_generation: 3,
      rebuild_requested_at: null,
      lease_token: null,
      lease_expires_at: null,
      compaction_lease_token: SOURCE_LEASE,
      compaction_lease_expires_at: LEASE_EXPIRES,
    }],
    [],
    [{ active_event_count: 0 }],
    [],
  ] as const;
}

function initialNativeAuthorityClosureResults() {
  return [
    [], // advisory lock
    [], // no existing closure rows
    [], // terminal Namespace leaf insert
    [], // initial dirty authority projection insert
  ] as const;
}

function publication(
  overrides: Partial<ProtectedJournalPublicationRecord> = {},
  plan: ProtectedJournalAttachmentPlanV1 = extractionPlan(),
): ProtectedJournalPublicationRecord {
  const input = reservation(plan);
  return {
    publicationId: input.publicationId,
    requestId: input.requestId,
    roomId: plan.roomId,
    namespaceIdAtAllocation: plan.namespaceId,
    workId: input.workId,
    sourceBatchId: plan.sourceBatchId,
    rebuildGeneration: plan.rebuildGeneration,
    workIdentityHash: input.workIdentityHash,
    descriptorHash: input.descriptorHash,
    attachmentPlanVersion: 1,
    attachmentPlanHash: input.attachmentPlanHash,
    attachmentPlanBytes: input.attachmentPlanBytes,
    outputObjectCount: plan.kind === "extraction" ? plan.events.length : 1,
    state: "reserved",
    leaseToken: null,
    leaseExpiresAt: null,
    retryCount: 0,
    maximumAttempts: 8,
    failureCode: null,
    lastFailureAt: null,
    cryptoCommittedAt: null,
    attachedAt: null,
    tombstoneRequestedAt: null,
    tombstonedAt: null,
    lastAuditedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function row(record: ProtectedJournalPublicationRecord) {
  return {
    publication_id: record.publicationId,
    request_id: record.requestId,
    room_id: record.roomId,
    namespace_id_at_allocation: record.namespaceIdAtAllocation,
    work_id: record.workId,
    source_batch_id: record.sourceBatchId,
    rebuild_generation: record.rebuildGeneration,
    work_identity_hash: record.workIdentityHash,
    descriptor_hash: record.descriptorHash,
    attachment_plan_version: record.attachmentPlanVersion,
    attachment_plan_hash: record.attachmentPlanHash,
    attachment_plan_bytes: record.attachmentPlanBytes,
    output_object_count: record.outputObjectCount,
    state: record.state,
    lease_token: record.leaseToken,
    lease_expires_at: record.leaseExpiresAt,
    retry_count: record.retryCount,
    maximum_attempts: record.maximumAttempts,
    failure_code: record.failureCode,
    last_failure_at: record.lastFailureAt,
    crypto_committed_at: record.cryptoCommittedAt,
    attached_at: record.attachedAt,
    tombstone_requested_at: record.tombstoneRequestedAt,
    tombstoned_at: record.tombstonedAt,
    last_audited_at: record.lastAuditedAt,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

async function setup(results: readonly (readonly unknown[] | Error)[]) {
  const connection = new ScriptedProductConnection([
    [{ current_user: "nautilo", session_user: "nautilo" }],
    ...results,
  ]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    handle,
    repository: new PostgresProtectedJournalPublicationRepository(
      handle,
      RECORD_COMMITMENT,
    ),
  };
}

function attachWithOrdinarySiblings(
  postgres: Awaited<ReturnType<typeof setup>>,
  value: Parameters<PostgresProtectedJournalPublicationRepository["attachWithOrdinarySiblings"]>[1],
  outputs: Parameters<PostgresProtectedJournalPublicationRepository["attachWithOrdinarySiblings"]>[2],
) {
  return postgres.handle.transaction(
    (transaction) => postgres.repository.attachWithOrdinarySiblings(
      transaction,
      value,
      outputs,
    ),
    {isolationLevel: "serializable"},
  );
}

function ordinaryExtractionOutput(
  plan: ProtectedJournalAttachmentPlanV1 = extractionPlan(),
  index = 0,
) {
  if (plan.kind !== "extraction") {
    throw new TypeError("fixture must be an extraction");
  }
  const event = plan.events[index]!;
  const built = buildStenographerRecordPublication({
    eventId: event.eventId,
    roomId: plan.roomId,
    namespaceId: plan.namespaceId,
    kind: event.kind,
    statement: `Ordinary statement ${event.batchLocalOrdinal}`,
    sources: event.sourceMessageIds.map((messageId) => ({
      messageId,
      editRevision: messageId === 41 ? 2 : 0,
      observedContentFingerprint: `sha256:message-${messageId}`,
    })),
    sourceBatchId: event.sourceBatchId,
    batchLocalOrdinal: event.batchLocalOrdinal,
    extractorVersion: event.extractorVersion,
    rebuildGeneration: plan.rebuildGeneration,
    transition: {operation: "append"},
    publicationBindingRef:
      `journal:namespace:${plan.namespaceId}:protected:v1`,
  });
  return {
    objectId: event.objectId,
    plaintext: encodeDurableRecordEnvelope(built.record),
  };
}

function twoEventExtractionPlan(): ProtectedJournalAttachmentPlanV1 {
  const first = extractionPlan();
  if (first.kind !== "extraction") throw new TypeError("fixture must extract");
  return {
    ...first,
    events: [first.events[0]!, {
      ...first.events[0]!,
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      objectId: "journal/event/work-1/slot-001",
      sequence: 10,
      sourceMessageIds: [41],
      batchLocalOrdinal: 1,
    }],
  };
}

function ordinaryRollupOutput() {
  const plan = rollupPlan();
  if (plan.kind !== "rollup") throw new TypeError("fixture must compact");
  const rollup = plan.rollup;
  if (rollup === null) throw new TypeError("fixture rollup is missing");
  return {
    objectId: rollup.objectId,
    plaintext: encodeRoomEventRollupPayloadV1({
      rollupId: rollup.rollupId,
      roomId: plan.roomId,
      namespaceId: plan.namespaceId,
      throughEventSequence: rollup.throughEventSequence,
      content: "Canonical ordinary rollup content.",
      sourceEventCount: rollup.sourceEventCount,
      modelId: rollup.modelId,
      compactorVersion: rollup.compactorVersion,
      createdAt: rollup.createdAt,
    }),
  };
}

function committed(
  plan: ProtectedJournalAttachmentPlanV1 = extractionPlan(),
): ProtectedJournalPublicationRecord {
  return publication({
    state: "crypto_committed",
    leaseToken: RECEIPT_LEASE,
    leaseExpiresAt: LEASE_EXPIRES,
    cryptoCommittedAt: NOW,
    updatedAt: NOW,
  }, plan);
}

describe("protected journal publication repository", () => {
  test("pre-Room validation locks only the exact publication receipt", async () => {
    const current = committed();
    const postgres = await setup([[row(current)]]);
    expect(await postgres.repository.validateCurrentPublicationReceipt(
      postgres.connection, current.publicationId, current,
    )).toBeTrue();
    const statements = postgres.connection.statements.slice(1);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("room_journal_crypto_publications");
    expect(statements[0]).toContain("FOR UPDATE");
    expect(statements[0]).not.toContain("JOIN rooms");

    const stale = await setup([[row(current)]]);
    expect(await stale.repository.validateCurrentPublicationReceipt(
      stale.connection, current.publicationId, {...current, descriptorHash: new Uint8Array(32)},
    )).toBeFalse();
  });

  test.each([false, true])("atomically rechecks current product sources before claiming a content-free receipt (raw timestamps: %s)", async raw => {
    const claimed = publication({
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
    });
    const postgres = await setup([
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        rebuild_requested_at: null,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      [{
        id: BATCH_ID,
        from_message_id_exclusive: 40,
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
        lane: "live",
        status: "running",
      }],
      [{
        crypto_object_id: MESSAGE_OBJECT,
        message_id: 41,
        edit_revision: 2,
        created_at: NOW,
        role: "user",
        participant_id: PARTICIPANT_ID,
      }],
      coveredRangeRows(),
      [row(claimed)],
    ].map(rows => rows.map(item => Object.fromEntries(Object.entries(item).map(([key, value]) =>
      [key, raw && value instanceof Date ? value.toISOString().replace("T", " ").replace("Z", "+00") : value])))));

    expect(
      await postgres.repository.reserveCurrentSourceAndClaim(
        currentReservation(),
      ),
    ).toEqual({ status: "claimed", record: claimed });
    expect(postgres.connection.isolationLevels).toEqual(["serializable"]);
    const productProjection = postgres.connection.statements
      .slice(1)
      .join("\n");
    expect(productProjection).not.toMatch(
      /\b(message\.content|event\.statement|rollup\.content|display_name|handle)\b/iu,
    );
    expect(productProjection).toContain("rebuild_requested_at");
    expect(productProjection).toContain("message.edit_revision");
    expect(normalizedSql(productProjection)).toContain("on conflict do nothing");
  });

  test("requires the exact prepared rebuild target while reusing live batches", async () => {
    const base = currentReservation();
    if (base.source.kind !== "extraction") throw new Error("fixture must extract");
    const source = {...base.source, rebuildTargetMessageId: 45};
    const claimed = publication({leaseToken: RECEIPT_LEASE, leaseExpiresAt: LEASE_EXPIRES});
    const coordinate = {...extractionCoordinateRow(), rebuild_requested_at: NOW.toISOString(),
      rebuild_target_message_id: 45, last_processed_message_id: 40};
    const following = extractionSourceRecheckResults().slice(1);
    const valid = await setup([[coordinate], ...following, [row(claimed)]]);
    expect(await valid.repository.reserveCurrentSourceAndClaim({...base, source}))
      .toEqual({status: "claimed", record: claimed});
    for (const changed of [
      {...coordinate, rebuild_target_message_id: 46},
      {...coordinate, rebuild_requested_at: null},
      {...coordinate, last_processed_message_id: 41},
      {...coordinate, rebuild_generation: 4},
    ]) {
      const stale = await setup([[changed]]);
      expect(await stale.repository.reserveCurrentSourceAndClaim({...base, source}))
        .toEqual({status: "stale"});
    }
    const ordinary = await setup([[coordinate]]);
    expect(await ordinary.repository.reserveCurrentSourceAndClaim(base)).toEqual({status: "stale"});
  });

  test.each([null, "invalid", 0, NOW.toISOString()])("rejects malformed or expired raw source lease %s", async expiry => {
    const postgres = await setup([[{...extractionCoordinateRow(), lease_expires_at: expiry}]]);
    expect(await postgres.repository.reserveCurrentSourceAndClaim(currentReservation())).toEqual({status: "stale"});
  });

  test("does not reserve when the source lease or exact mapped revision is stale", async () => {
    const staleLease = await setup([[
      {
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        rebuild_requested_at: null,
        lease_token: SOURCE_LEASE,
        lease_expires_at: NOW,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      },
    ]]);
    expect(
      await staleLease.repository.reserveCurrentSourceAndClaim(
        currentReservation(),
      ),
    ).toEqual({ status: "stale" });
    expect(staleLease.connection.statements).toHaveLength(2);

    const staleRevision = await setup([
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        rebuild_requested_at: null,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      [{
        id: BATCH_ID,
        from_message_id_exclusive: 40,
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
        lane: "live",
        status: "running",
      }],
      [{
        crypto_object_id: MESSAGE_OBJECT,
        message_id: 41,
        edit_revision: 3,
        created_at: NOW,
        role: "user",
        participant_id: PARTICIPANT_ID,
      }],
      coveredRangeRows(),
    ]);
    expect(
      await staleRevision.repository.reserveCurrentSourceAndClaim(
        currentReservation(),
      ),
    ).toEqual({ status: "stale" });
    expect(staleRevision.connection.statements.at(-1))
      .not.toContain("room_journal_crypto_publications");
  });

  test("rejects covered-range and compaction-selection changes before receipt creation", async () => {
    const clearedDeafWindow = await setup([
      [extractionCoordinateRow()],
      extractionSourceRecheckResults()[1],
      extractionSourceRecheckResults()[2],
      coveredRangeRows({ excluded_from_evidence: false }),
    ]);
    expect(
      await clearedDeafWindow.repository.reserveCurrentSourceAndClaim(
        currentReservation(),
      ),
    ).toEqual({ status: "stale" });
    expect(clearedDeafWindow.connection.statements.at(-1))
      .not.toContain("room_journal_crypto_publications");

    const compactionSelectionChanged = await setup([
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        rebuild_requested_at: null,
        lease_token: null,
        lease_expires_at: null,
        compaction_lease_token: SOURCE_LEASE,
        compaction_lease_expires_at: LEASE_EXPIRES,
      }],
      [{
        crypto_object_id: "journal/event/source-1",
        event_id: PRIOR_EVENT_ID,
        room_id: ROOM_ID,
        namespace_id: NAMESPACE_ID,
        sequence: 1,
        kind: "fact",
        status: "active",
        supersedes_event_id: null,
        resolves_event_id: null,
        source_message_ids: [41],
        source_batch_id: BATCH_ID,
        batch_local_ordinal: 0,
        extractor_version: "m241-v1",
        created_at: NOW,
      }],
      [],
      [{ active_event_count: 2 }],
    ]);
    expect(
      await compactionSelectionChanged.repository
        .reserveCurrentSourceAndClaim(compactionCurrentReservation()),
    ).toEqual({ status: "stale" });
    expect(compactionSelectionChanged.connection.statements.map(normalizedSql).join(" "))
      .toContain("room_events.id as event_id");
  });

  test("reserves an exact content-free receipt and replays only identical work", async () => {
    const input = reservation();
    const created = publication();
    const postgres = await setup([[row(created)]]);

    expect(await postgres.repository.reserve(input)).toEqual({
      status: "created",
      record: created,
    });
    const insert = postgres.connection.statements.at(-1)!;
    expect(insert).toContain("room_journal_crypto_publications");
    expect(insert).toContain("on conflict do nothing");
    expect(insert).not.toMatch(/\b(statement|content|ciphertext|credential)\b/iu);

    const replay = await setup([[], [row(created)]]);
    expect(await replay.repository.reserve(input)).toEqual({
      status: "existing",
      record: created,
    });

    const conflict = await setup([[], [row({
      ...created,
      descriptorHash: new Uint8Array(32).fill(0x7f),
    })]]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(conflict.repository.reserve(input)).rejects.toBeInstanceOf(
      ProtectedJournalPublicationConflictError,
    );
  });

  test("claims bounded reconciliation work and commits only the exact planned output prefix", async () => {
    const claimed = publication({
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
      updatedAt: NOW,
    });
    const claim = await setup([[row(claimed)]]);
    expect(await claim.repository.claim({
      publicationId: claimed.publicationId,
      leaseToken: RECEIPT_LEASE,
      now: NOW,
    })).toEqual({ status: "claimed", record: claimed });
    expect(claim.connection.statements.at(-1)).toContain(
      '"lease_expires_at" <= $',
    );

    const committedRecord = committed();
    const mark = await setup([
      [row(claimed)],
      [row(committedRecord)],
    ]);
    expect(await mark.repository.markCryptoCommitted({
      publicationId: claimed.publicationId,
      leaseToken: RECEIPT_LEASE,
      descriptorHash: claimed.descriptorHash,
      attachmentPlanHash: claimed.attachmentPlanHash,
      outputObjectIds: [EVENT_OBJECT],
      now: NOW,
    })).toEqual({ status: "committed", record: committedRecord });
    expect(mark.connection.statements.at(-1)).toContain('set "state" = $');
    expect(mark.connection.parameters.at(-1)).toContain("crypto_committed");

    const duplicate = await setup([[row(committedRecord)]]);
    expect(await duplicate.repository.markCryptoCommitted({
      publicationId: claimed.publicationId,
      leaseToken: RECEIPT_LEASE,
      descriptorHash: claimed.descriptorHash,
      attachmentPlanHash: claimed.attachmentPlanHash,
      outputObjectIds: [EVENT_OBJECT],
      now: NOW,
    })).toEqual({ status: "duplicate", record: committedRecord });
    expect(duplicate.connection.statements).toHaveLength(2);

    const wrongPrefix = await setup([[row(claimed)]]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(wrongPrefix.repository.markCryptoCommitted({
      publicationId: claimed.publicationId,
      leaseToken: RECEIPT_LEASE,
      descriptorHash: claimed.descriptorHash,
      attachmentPlanHash: claimed.attachmentPlanHash,
      outputObjectIds: ["journal/event/foreign"],
      now: NOW,
    })).rejects.toThrow("mapping_conflict");
    expect(wrongPrefix.connection.statements).toHaveLength(2);
  });

  test("abandons only an exact leased reserved receipt after crypto publication can no longer race", async () => {
    const reserved = publication({
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
    });
    const superseded = publication({
      state: "superseded",
      leaseToken: null,
      leaseExpiresAt: null,
      failureCode: "crypto_publication_failed",
      lastFailureAt: NOW,
    });
    const postgres = await setup([[row(superseded)]]);

    expect(await postgres.repository.abandonReserved({
      publicationId: reserved.publicationId,
      leaseToken: RECEIPT_LEASE,
      descriptorHash: reserved.descriptorHash,
      now: NOW,
    })).toEqual({ status: "abandoned", record: superseded });
    const sql = postgres.connection.statements.at(-1)!;
    expect(sql).toContain('set "state" = $');
    expect(sql).toContain('"crypto_committed_at" is null');
    expect(sql).toContain('"descriptor_hash" =');
    expect(postgres.connection.parameters.at(-1)).toContain("superseded");
    expect(postgres.connection.parameters.at(-1)).toContain("reserved");
    expect(sql).not.toMatch(/\b(statement|content|ciphertext|credential)\b/iu);
  });

  test("reactivates an abandoned receipt in place for the next exact recipient generation", async () => {
    const superseded = publication({
      state: "superseded",
      failureCode: "crypto_publication_failed",
      lastFailureAt: NOW,
    });
    const nextDescriptorHash = new Uint8Array(32).fill(0x55);
    const next = {
      ...currentReservation(),
      descriptorHash: nextDescriptorHash,
    };
    const reactivated = publication({
      descriptorHash: nextDescriptorHash,
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
    });
    const postgres = await setup([
      ...extractionSourceRecheckResults(),
      [],
      [row(superseded)],
      [row(reactivated)],
    ]);

    expect(
      await postgres.repository.reserveCurrentSourceAndClaim(next),
    ).toEqual({ status: "claimed", record: reactivated });
    const sql = postgres.connection.statements.at(-1)!;
    const parameters = postgres.connection.parameters.at(-1)!;
    expect(normalizedSql(sql)).toContain("state = $");
    expect(normalizedSql(sql)).toContain("failure_code = $");
    expect(normalizedSql(sql)).toContain("work_identity_hash = $");
    expect(parameters).toContain("superseded");
    expect(parameters).toContain("reserved");
    expect(parameters).toContain("crypto_publication_failed");
  });

  test("commits and attaches a valid empty extraction without product content rows", async () => {
    const plan = emptyExtractionPlan();
    const reserved = publication({
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
      updatedAt: NOW,
    }, plan);
    const committedRecord = publication({
      state: "crypto_committed",
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
      cryptoCommittedAt: NOW,
      updatedAt: NOW,
    }, plan);
    const attached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    }, plan);

    const reserve = await setup([[row(reserved)]]);
    expect(await reserve.repository.reserve(reservation(plan))).toEqual({
      status: "created",
      record: reserved,
    });

    const mark = await setup([
      [row(reserved)],
      [row(committedRecord)],
    ]);
    expect(await mark.repository.markCryptoCommitted({
      publicationId: reserved.publicationId,
      leaseToken: RECEIPT_LEASE,
      descriptorHash: reserved.descriptorHash,
      attachmentPlanHash: reserved.attachmentPlanHash,
      outputObjectIds: [],
      now: NOW,
    })).toEqual({ status: "committed", record: committedRecord });

    const attach = await setup([
      [row(committedRecord)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES.toISOString(),
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [],
      [{ id: BATCH_ID }],
      [{ room_id: ROOM_ID }],
      [row(attached)],
    ]);
    expect(await attach.repository.attach(
      attachmentInput(committedRecord),
    )).toEqual({ status: "attached", record: attached });
    expect(
      attach.connection.statements.some((statement) =>
        statement.includes("INSERT INTO room_events")
      ),
    ).toBeFalse();
  });

  test("attaches extraction crypto-first in one ordered product transaction and replays exactly", async () => {
    const current = committed();
    const attached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    });
    const postgres = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [],
      [],
      [],
      [],
      [],
      [{ id: EVENT_ID, record_id: EVENT_ID }],
      ...initialNativeAuthorityClosureResults(),
      [],
      [{ id: BATCH_ID }],
      [{ room_id: ROOM_ID }],
      [row(attached)],
    ]);

    expect(await postgres.repository.attach(
      attachmentInput(current),
    )).toEqual({ status: "attached", record: attached });
    expect(postgres.connection.transactions).toBe(1);
    expect(postgres.connection.isolationLevels).toEqual(["serializable"]);
    const transactionSql = postgres.connection.statements.slice(1);
    expect(transactionSql[0]).toContain("FOR UPDATE");
    const mappingCheckIndex = transactionSql.findIndex((statement) =>
      statement.includes("crypto_object_id = ANY")
    );
    const eventInsertTransactionIndex = transactionSql.findIndex((statement) =>
      normalizedSql(statement).includes("insert into room_events")
    );
    const attachedCasIndex = transactionSql.findIndex((statement) =>
      normalizedSql(statement).includes("set state = 'attached'")
    );
    expect(eventInsertTransactionIndex).toBeGreaterThan(mappingCheckIndex);
    expect(attachedCasIndex).toBeGreaterThan(eventInsertTransactionIndex);
    const eventInsertIndex = postgres.connection.statements.findIndex(
      (statement) => normalizedSql(statement).includes("insert into room_events"),
    );
    expect(postgres.connection.parameters[eventInsertIndex]).not.toContain(
      PROTECTED_JOURNAL_CONTENT_SENTINEL,
    );
    expect(postgres.connection.parameters[eventInsertIndex]?.[12]).toBe("native");
    expect(postgres.connection.parameters[eventInsertIndex]?.[13]).toBe(EVENT_ID);
    expect(postgres.connection.parameters[eventInsertIndex]?.[14]).toBeNull();
    const authorityClosureIndex = postgres.connection.statements.findIndex(
      (statement) => normalizedSql(statement).includes(
        "insert into reflection_record_authority_closure",
      ),
    );
    expect(authorityClosureIndex).toBeGreaterThan(eventInsertIndex);
    expect(postgres.connection.parameters[authorityClosureIndex]).toContain(EVENT_ID);
    expect(postgres.connection.parameters[authorityClosureIndex]).toContain(NAMESPACE_ID);
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).includes(
        "insert into reflection_record_authority_projections",
      )
    )).toBeTrue();
    const recordReceiptIndex = postgres.connection.statements.findIndex(
      (statement) => normalizedSql(statement).includes(
        "insert into reflection_record_publications",
      ),
    );
    const recordRequestCommitment =
      postgres.connection.parameters[recordReceiptIndex]?.[5];
    expect(recordRequestCommitment).toBeInstanceOf(Uint8Array);
    expect(recordRequestCommitment).not.toEqual(current.descriptorHash);
    for (const [index, statement] of postgres.connection.statements.entries()) {
      if (normalizedSql(statement).includes("insert into room_events")) continue;
      expect(statement, `statement ${index}`).not.toMatch(
        /\b(statement|content|ciphertext|credential)\b/iu,
      );
    }

    const replay = await setup([[row(attached)]]);
    expect(await replay.repository.attach(
      attachmentInput(attached),
    )).toEqual({ status: "duplicate", record: attached });
    expect(replay.connection.statements).toHaveLength(2);

    const reserved = publication({
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
    });
    const forbidden = await setup([[row(reserved)]]);
    expect(await forbidden.repository.attach(
      attachmentInput(reserved),
    )).toEqual({ status: "crypto_not_committed", record: reserved });
    expect(forbidden.connection.statements).toHaveLength(2);

    const wrongLease = await setup([[row(current)]]);
    expect(await wrongLease.repository.attach({
      ...attachmentInput(current),
      leaseToken: "99999999-9999-4999-8999-999999999999",
    })).toEqual({ status: "lease_lost", record: current });
    expect(wrongLease.connection.statements).toHaveLength(2);
  });

  test("attaches the supplied canonical Record as the same-object ordinary sibling and wipes only its owned copy", async () => {
    const current = committed();
    const attached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    });
    const output = ordinaryExtractionOutput();
    const borrowedBytes = output.plaintext.slice();
    const postgres = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      [{id: EVENT_ID, record_id: EVENT_ID}],
      ...initialNativeAuthorityClosureResults(),
      [],
      [{id: BATCH_ID}],
      [{room_id: ROOM_ID}],
      [row(attached)],
    ]);
    expect(await attachWithOrdinarySiblings(
      postgres,
      attachmentInput(current),
      [output],
    )).toEqual({status: "attached", record: attached});
    expect(output.plaintext).toEqual(borrowedBytes);
    expect(postgres.connection.transactions).toBe(1);
    expect(postgres.connection.isolationLevels).toEqual(["serializable"]);
    expect(postgres.connection.committedTransactionStatements.some(
      (statement) => normalizedSql(statement).includes(
        "insert into reflection_record_payload_representations",
      ),
    )).toBeTrue();
    const ordinaryIndex = postgres.connection.statements.findIndex(
      (statement, index) => normalizedSql(statement).includes(
        "insert into reflection_record_payload_representations",
      ) && postgres.connection.parameterSnapshots[index]?.includes("ordinary"),
    );
    expect(ordinaryIndex).toBeGreaterThan(0);
    expect(postgres.connection.parameterSnapshots[ordinaryIndex]).toContain(
      EVENT_ID,
    );
    expect(output.objectId).toBe(EVENT_OBJECT);
    const storedBytes = postgres.connection.parameterSnapshots[ordinaryIndex]
      ?.find((parameter) => parameter instanceof Uint8Array);
    const releasedBytes = postgres.connection.parameters[ordinaryIndex]
      ?.find((parameter) => parameter instanceof Uint8Array);
    expect(storedBytes).toEqual(borrowedBytes);
    expect(releasedBytes).toBeInstanceOf(Uint8Array);
    expect((releasedBytes as Uint8Array).every((byte) => byte === 0)).toBeTrue();
    const ordinaryReceiptIndex = postgres.connection.statements.findIndex(
      (statement, index) => normalizedSql(statement).includes(
        "insert into reflection_record_publications",
      ) && postgres.connection.parameterSnapshots[index]?.includes("ordinary"),
    );
    expect(ordinaryReceiptIndex).toBeGreaterThan(ordinaryIndex);
    expect(postgres.connection.parameterSnapshots[ordinaryReceiptIndex]).toContain(
      `journal:${BATCH_ID}:0:ordinary`,
    );
    expect(postgres.connection.parameterSnapshots[ordinaryReceiptIndex]).toContain(
      `journal:namespace:${NAMESPACE_ID}:ordinary:v1`,
    );
    expect(postgres.connection.parameterSnapshots[ordinaryReceiptIndex]).toContain(null);
  });

  test("rejects missing and swapped committed output sets before ordinary writes", async () => {
    const plan = twoEventExtractionPlan();
    const current = committed(plan);
    const first = ordinaryExtractionOutput(plan, 0);
    const second = ordinaryExtractionOutput(plan, 1);
    for (const outputs of [[first], [second, first]]) {
      const postgres = await setup([[row(current)]]);
      const error = await attachWithOrdinarySiblings(
        postgres,
        attachmentInput(current),
        outputs,
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("committed output set");
      expect(postgres.connection.statements).toHaveLength(2);
      expect(postgres.connection.statements.some((statement) =>
        normalizedSql(statement).includes(
          "insert into reflection_record_payload_representations",
        )
      )).toBeFalse();
    }
  });

  test("accepts an attached duplicate only when its ordinary Record bytes are present and equal", async () => {
    const attached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    });
    const output = ordinaryExtractionOutput();
    const exact = await setup([
      [row(attached)],
      [{plaintext_payload_bytes: output.plaintext.slice()}],
    ]);
    expect(await attachWithOrdinarySiblings(
      exact,
      attachmentInput(attached),
      [output],
    )).toEqual({status: "duplicate", record: attached});

    for (const representationRows of [
      [],
      [{plaintext_payload_bytes: new Uint8Array([1, 2, 3])}],
    ]) {
      const conflict = await setup([[row(attached)], representationRows]);
      const error = await attachWithOrdinarySiblings(
        conflict,
        attachmentInput(attached),
        [output],
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("missing or conflicts");
    }
  });

  test("validates and writes the supplied canonical rollup content", async () => {
    const plan = rollupPlan();
    const current = committed(plan);
    const attached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    }, plan);
    const output = ordinaryRollupOutput();
    const borrowedBytes = output.plaintext.slice();
    const postgres = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: null,
        lease_expires_at: null,
        compaction_lease_token: SOURCE_LEASE,
        compaction_lease_expires_at: LEASE_EXPIRES,
      }],
      ...compactionSourceRecheckResults(),
      [],
      [{id: ROLLUP_ID, crypto_object_id: ROLLUP_OBJECT}],
      [{room_id: ROOM_ID}],
      [row(attached)],
    ]);

    expect(await attachWithOrdinarySiblings(postgres, {
      ...attachmentInput(current),
      sourceBindingFingerprint:
        fingerprintProtectedStenographerSourceBindings([]),
      sourceBindings: [],
      source: {
        kind: "compaction",
        activeEventCount: 0,
        selectedEventCount: 0,
        hasDeferredMiddle: false,
      },
    }, [output])).toEqual({status: "attached", record: attached});
    expect(output.plaintext).toEqual(borrowedBytes);
    const insertIndex = postgres.connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("insert into room_event_rollups")
    );
    expect(postgres.connection.parameters[insertIndex]).toContain(
      "Canonical ordinary rollup content.",
    );
    expect(postgres.connection.parameters[insertIndex]).not.toContain(
      PROTECTED_JOURNAL_CONTENT_SENTINEL,
    );
  });

  test("rolls back staged writes and wipes its copy when the held product transaction fails", async () => {
    const current = committed();
    const output = ordinaryExtractionOutput();
    const borrowedBytes = output.plaintext.slice();
    const failure = Object.assign(new Error("ordinary insert failed"), {
      code: "XX001",
    });
    const postgres = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [],
      [],
      [],
      [],
      failure,
    ]);
    const error = await attachWithOrdinarySiblings(
      postgres,
      attachmentInput(current),
      [output],
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ordinary insert failed");
    expect(output.plaintext).toEqual(borrowedBytes);
    expect(postgres.connection.transactions).toBe(1);
    expect(postgres.connection.transactionFailures).toBe(1);
    expect(postgres.connection.committedTransactionStatements).toEqual([]);
    expect(postgres.connection.rolledBackTransactionStatements.some(
      (statement) => normalizedSql(statement).includes(
        "insert into reflection_record_payload_representations",
      ),
    )).toBeTrue();
    const failedInsert = postgres.connection.statements.findIndex((statement, index) =>
      normalizedSql(statement).includes(
        "insert into reflection_record_payload_representations",
      ) && postgres.connection.parameterSnapshots[index]?.includes("ordinary")
    );
    expect(failedInsert).toBeGreaterThan(0);
    const snapshot = postgres.connection.parameterSnapshots[failedInsert]
      ?.find((parameter) => parameter instanceof Uint8Array);
    const released = postgres.connection.parameters[failedInsert]
      ?.find((parameter) => parameter instanceof Uint8Array);
    expect(snapshot).toEqual(borrowedBytes);
    expect((released as Uint8Array).every((byte) => byte === 0)).toBeTrue();
  });

  test("attaches exact supersede transitions before inserting their protected replacement", async () => {
    const plan: ProtectedJournalAttachmentPlanV1 = {
      ...extractionPlan(),
      statusUpdates: [{
        eventId: PRIOR_EVENT_ID,
        fromStatus: "active",
        toStatus: "superseded",
      }],
      events: [{
        ...extractionPlan().events[0]!,
        supersedesEventId: PRIOR_EVENT_ID,
      }],
    };
    const current = committed(plan);
    const attached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    }, plan);
    const postgres = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [{
        id: PRIOR_EVENT_ID,
        status: "active",
        projection_kind: "native",
        record_id: PRIOR_EVENT_ID,
      }],
      [],
      [{ id: PRIOR_EVENT_ID }],
      [{ record_id: PRIOR_EVENT_ID }],
      [],
      [],
      [],
      [],
      [],
      [{ id: EVENT_ID, record_id: EVENT_ID }],
      ...initialNativeAuthorityClosureResults(),
      [],
      [{ id: BATCH_ID }],
      [{ room_id: ROOM_ID }],
      [row(attached)],
    ]);

    expect(await postgres.repository.attach(
      attachmentInput(current),
    )).toEqual({ status: "attached", record: attached });
    const transitionIndex = postgres.connection.statements.findIndex(
      (statement) => {
        const normalized = normalizedSql(statement);
        return normalized.startsWith("update room_events")
          && normalized.includes("set status");
      },
    );
    const insertIndex = postgres.connection.statements.findIndex(
      (statement) => normalizedSql(statement).includes("insert into room_events"),
    );
    expect(transitionIndex).toBeGreaterThan(0);
    expect(insertIndex).toBeGreaterThan(transitionIndex);
    expect(postgres.connection.parameters[transitionIndex]).toContain(
      "superseded",
    );
  });

  test("post-crypto stale rebuild requests exact tombstoning and mapping conflict quarantines", async () => {
    const current = committed();
    const stale = publication({
      state: "tombstone_pending",
      cryptoCommittedAt: NOW,
      tombstoneRequestedAt: NOW,
      failureCode: "rebuild_superseded",
      lastFailureAt: NOW,
      updatedAt: NOW,
    });
    const staleRun = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 4,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      [row(stale)],
    ]);
    expect(await staleRun.repository.attach(
      attachmentInput(current),
    )).toEqual({ status: "stale_reconcile", record: stale });
    expect(staleRun.connection.statements.at(-1)).toContain(
      "state = 'tombstone_pending'",
    );

    const quarantined = publication({
      state: "quarantined",
      cryptoCommittedAt: NOW,
      failureCode: "mapping_conflict",
      lastFailureAt: NOW,
      updatedAt: NOW,
    });
    const conflict = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [{ id: EVENT_ID, crypto_object_id: "journal/event/other" }],
      [row(quarantined)],
    ]);
    expect(await conflict.repository.attach(
      attachmentInput(current),
    )).toEqual({ status: "quarantined", record: quarantined });
    expect(
      conflict.connection.statements.some((statement) =>
        statement.includes("INSERT INTO room_events")
      ),
    ).toBeFalse();
  });

  test("rechecks the full source inventory after crypto commit and before attachment", async () => {
    const current = committed();
    const pending = publication({
      state: "tombstone_pending",
      cryptoCommittedAt: NOW,
      tombstoneRequestedAt: NOW,
      failureCode: "stale_authority",
      lastFailureAt: NOW,
      updatedAt: NOW,
    });
    const postgres = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      [extractionCoordinateRow()],
      extractionSourceRecheckResults()[1],
      extractionSourceRecheckResults()[2],
      coveredRangeRows({ excluded_from_evidence: false }),
      [row(pending)],
    ]);
    expect(await postgres.repository.attach(
      attachmentInput(current),
    )).toEqual({ status: "stale_reconcile", record: pending });
    expect(
      postgres.connection.statements.some((statement) =>
        statement.includes("INSERT INTO room_events")
        || statement.includes("INSERT INTO room_event_rollups")
        || statement.includes("UPDATE room_journal_state")
      ),
    ).toBeFalse();
  });

  test("generic attachment failure rolls back and rollup attachment writes only the sentinel", async () => {
    const current = committed();
    const failure = Object.assign(new Error("insert failed"), {
      code: "XX001",
    });
    const rollback = await setup([
      [row(current)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: SOURCE_LEASE,
        lease_expires_at: LEASE_EXPIRES,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
      }],
      ...extractionSourceRecheckResults(),
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        status: "running",
        lane: "live",
        through_message_id_inclusive: 42,
        extractor_version: "m241-v1",
      }],
      [],
      failure,
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(rollback.repository.attach(
      attachmentInput(current),
    )).rejects.toThrow("insert failed");
    expect(rollback.connection.transactionFailures).toBe(1);
    expect(
      rollback.connection.statements.some((statement) =>
        statement.includes("state = 'attached'")
      ),
    ).toBeFalse();

    const rollupCurrent = committed(rollupPlan());
    const rollupAttached = publication({
      state: "attached",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      updatedAt: NOW,
    }, rollupPlan());
    const rollup = await setup([
      [row(rollupCurrent)],
      [{
        namespace_id: NAMESPACE_ID,
        rebuild_generation: 3,
        lease_token: null,
        lease_expires_at: null,
        compaction_lease_token: SOURCE_LEASE,
        compaction_lease_expires_at: LEASE_EXPIRES,
      }],
      ...compactionSourceRecheckResults(),
      [],
      [{ id: ROLLUP_ID, crypto_object_id: ROLLUP_OBJECT }],
      [{ room_id: ROOM_ID }],
      [row(rollupAttached)],
    ]);
    expect(await rollup.repository.attach({
      ...attachmentInput(rollupCurrent),
      sourceBindingFingerprint:
        fingerprintProtectedStenographerSourceBindings([]),
      sourceBindings: [],
      source: {
        kind: "compaction",
        activeEventCount: 0,
        selectedEventCount: 0,
        hasDeferredMiddle: false,
      },
    })).toEqual({ status: "attached", record: rollupAttached });
    const rollupInsert = rollup.connection.statements.findIndex(
      (statement) =>
        normalizedSql(statement).includes("insert into room_event_rollups"),
    );
    expect(rollup.connection.parameters[rollupInsert]).toContain(
      PROTECTED_JOURNAL_CONTENT_SENTINEL,
    );
  });

  test("failures, bounded listing, and tombstone lifecycle are typed and leased", async () => {
    const reserved = publication({
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
    });
    const superseded = publication({
      state: "superseded",
      retryCount: 1,
      failureCode: "rebuild_superseded",
      lastFailureAt: NOW,
      updatedAt: NOW,
    });
    const failed = await setup([[row(superseded)]]);
    expect(await failed.repository.fail({
      publicationId: reserved.publicationId,
      leaseToken: RECEIPT_LEASE,
      failureCode: "rebuild_superseded",
      now: NOW,
    })).toEqual({ status: "terminal", record: superseded });

    const retryRecord = publication({
      state: "reserved",
      retryCount: 1,
      failureCode: "crypto_publication_failed",
      lastFailureAt: NOW,
      updatedAt: NOW,
    });
    const retry = await setup([[row(retryRecord)]]);
    expect(await retry.repository.fail({
      publicationId: reserved.publicationId,
      leaseToken: RECEIPT_LEASE,
      failureCode: "crypto_publication_failed",
      now: NOW,
    })).toEqual({ status: "retry", record: retryRecord });

    const eligible = await setup([[row(publication())]]);
    expect(await eligible.repository.listReconciliation({
      now: NOW,
      limit: 32,
    })).toHaveLength(1);
    expect(eligible.connection.statements.at(-1)).toContain(
      'order by "room_journal_crypto_publications"."updated_at", '
        + '"room_journal_crypto_publications"."publication_id"',
    );
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(eligible.repository.listReconciliation({
      now: NOW,
      limit: 257,
    })).rejects.toThrow("limit");

    const pending = publication({
      state: "tombstone_pending",
      cryptoCommittedAt: NOW,
      tombstoneRequestedAt: NOW,
      leaseToken: RECEIPT_LEASE,
      leaseExpiresAt: LEASE_EXPIRES,
      updatedAt: NOW,
    });
    const tombstoned = publication({
      state: "tombstoned",
      cryptoCommittedAt: NOW,
      tombstoneRequestedAt: NOW,
      tombstonedAt: NOW,
      updatedAt: NOW,
    });
    const request = await setup([[row(pending)]]);
    expect(await request.repository.requestTombstone({
      publicationId: committed().publicationId,
      now: NOW,
    })).toEqual({ status: "requested", record: pending });

    const mark = await setup([[row(tombstoned)]]);
    expect(await mark.repository.markTombstoned({
      publicationId: pending.publicationId,
      leaseToken: RECEIPT_LEASE,
      now: NOW,
    })).toEqual({ status: "tombstoned", record: tombstoned });

    const attachedPending = publication({
      state: "tombstone_pending",
      cryptoCommittedAt: NOW,
      attachedAt: NOW,
      tombstoneRequestedAt: NOW,
      updatedAt: NOW,
    });
    const retainedAttachment = await setup([[row(attachedPending)]]);
    expect(await retainedAttachment.repository.get(
      attachedPending.publicationId,
    )).toEqual(attachedPending);

    const attachedRequest = await setup([[row(attachedPending)]]);
    expect(await attachedRequest.repository.requestTombstone({
      publicationId: attachedPending.publicationId,
      now: NOW,
    })).toEqual({ status: "requested", record: attachedPending });
    const requestParameters = attachedRequest.connection.parameters.at(-1);
    expect(requestParameters).toContain("crypto_committed");
    expect(requestParameters).toContain("attached");
    expect(requestParameters).toContain("quarantined");
  });

  test("rejects unknown DTO fields before issuing product SQL", async () => {
    const postgres = await setup([]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(postgres.repository.reserve({
      ...reservation(),
      secret: new Uint8Array([1]),
    } as unknown as ReserveProtectedJournalPublicationInput)).rejects.toThrow(
      "field set",
    );
    expect(postgres.connection.statements).toHaveLength(1);

    const corrupt = committed();
    const corruptPlanHash = await setup([[row({
      ...corrupt,
      attachmentPlanHash: new Uint8Array(32).fill(0xff),
    })]]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(corruptPlanHash.repository.attach(
      attachmentInput(corrupt),
    )).rejects.toThrow("attachment plan hash is invalid");
    expect(corruptPlanHash.connection.transactions).toBe(1);
    expect(corruptPlanHash.connection.transactionFailures).toBe(1);
    expect(corruptPlanHash.connection.statements).toHaveLength(2);

    const corruptRow = await setup([[{
      ...row(publication()),
      secret: "forbidden",
    }]]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(corruptRow.repository.get(
      publication().publicationId,
    )).rejects.toThrow("field set");

    const agentConnection = new ScriptedProductConnection([[
      {
        current_user: "nautilo_agent",
        session_user: "nautilo_agent",
      },
    ]]);
    const agentHandle =
      await verifyConversationProductPostgresHandle(agentConnection);
    expect(() =>
      new PostgresProtectedJournalPublicationRepository(
        agentHandle,
        RECORD_COMMITMENT,
      )
    ).toThrow("nautilo product role");
  });
});


describe("completed-result repair receipt reuse", () => {
  function repairReceipt(overrides: Partial<ProtectedJournalPublicationRecord> = {}) {
    const binding = {rollupId: ROLLUP_ID, roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
      throughEventSequence: 200, sourceEventCount: 180, modelId: "compact-model", compactorVersion: "m241-v1", createdAt: NOW.toISOString()};
    const bytes = encodeStenographerOutputRepairPlan({version: 2, binding: {
      receipt: {kind: "compaction", id: ROLLUP_ID, roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
        rebuildGeneration: 3, fallbackReason: "device", ordinaryOutputFingerprint: new Uint8Array(32).fill(9)},
      outputs: [{logicalId: ROLLUP_ID, objectId: ROLLUP_OBJECT, objectType: "room_event_rollup", createdAt: NOW.getTime(),
        disposition: "create", representationGeneration: 3, ordinaryRepresentationGeneration: null}]},
      snapshot: {roomId: ROOM_ID, namespaceId: NAMESPACE_ID, rebuildGeneration: 3, events: [],
        rollup: {kind: "rollup", rebuildGeneration: 3, binding, protectedMapping: {status: "missing"}}}});
    return publication({publicationId: "repair-request", requestId: "repair-request", workId: "repair-work",
      sourceBatchId: null, attachmentPlanVersion: 2, attachmentPlanBytes: bytes,
      attachmentPlanHash: Uint8Array.from(createHash("sha256").update(bytes).digest()), ...overrides});
  }
  test("only a proven uncommitted abandonment can accept a new recipient descriptor", async () => {
    const previous = repairReceipt({state: "superseded", failureCode: "crypto_publication_failed", lastFailureAt: NOW});
    const next = repairReceipt({descriptorHash: new Uint8Array(32).fill(44), leaseToken: RECEIPT_LEASE, leaseExpiresAt: LEASE_EXPIRES});
    const postgres = await setup([[], [row(previous)], [row(next)]]);
    const input = {...next, leaseToken: RECEIPT_LEASE, now: NOW};
    expect(await postgres.repository.reserveOutputRepairWithinTransaction(postgres.connection, input)).toEqual(next);
    const update = normalizedSql(postgres.connection.statements.at(-1)!);
    expect(update).toContain("crypto_committed_at is null");
    expect(update).toContain("attached_at is null");
    expect(update).toContain("descriptor_hash =");
  });
  test.each(["reserved", "crypto_committed", "attached"] as const)("never overwrites a %s predecessor with a different descriptor", async state => {
    const previous = repairReceipt({state, ...(state === "crypto_committed" || state === "attached" ? {cryptoCommittedAt: NOW} : {}),
      ...(state === "attached" ? {attachedAt: NOW} : {})});
    const next = repairReceipt({descriptorHash: new Uint8Array(32).fill(44), leaseToken: RECEIPT_LEASE, leaseExpiresAt: LEASE_EXPIRES});
    const postgres = await setup([[], [row(previous)]]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(postgres.repository.reserveOutputRepairWithinTransaction(postgres.connection,
      {...next, leaseToken: RECEIPT_LEASE, now: NOW})).rejects.toThrow("mapping_conflict");
    expect(postgres.connection.statements.some(statement => normalizedSql(statement).startsWith("update "))).toBe(false);
  });
});

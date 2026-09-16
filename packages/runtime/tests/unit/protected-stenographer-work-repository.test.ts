import { describe, expect, test } from "bun:test";
import {
  bindConversationProductCanonicalTransactionRunner,
  verifyConversationProductPostgresHandle,
  type ConversationProductCanonicalTransactionConnection,
  type ConversationProductDatabaseRow,
  type ConversationProductPostgresConnection,
  type ConversationProductPostgresIsolationLevel,
  type ConversationProductPostgresScalar,
} from "@nautilo/lattice-bridge/server";
import type { CanonicalTranscriptTx } from "@nautilo/trust";

import {
  PostgresProtectedStenographerWorkRepository,
  PROTECTED_STENOGRAPHER_WORK_LEASE_MS,
} from "../../src/stenographer/protected-stenographer-work-repository";

const NOW = new Date("2026-08-04T13:00:00.000Z");
const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const NAMESPACE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const PARTICIPANT_ID = "44444444-4444-4444-8444-444444444444";
const BATCH_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_TOKEN = "66666666-6666-4666-8666-666666666666";

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim().toLowerCase();
}

class ScriptedConnection implements ConversationProductPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: ConversationProductPostgresScalar[][] = [];
  readonly isolationLevels: ConversationProductPostgresIsolationLevel[] = [];
  readonly #results: Array<readonly unknown[] | Error>;

  constructor(results: readonly (readonly unknown[] | Error)[]) {
    this.#results = [...results];
  }

  query<Row extends ConversationProductDatabaseRow>(
    statement: string,
    parameters: readonly ConversationProductPostgresScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.parameters.push([...parameters]);
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
    this.isolationLevels.push(options.isolationLevel);
    return callback(this);
  }
}

class PolicyCanonicalConnection
  implements ConversationProductCanonicalTransactionConnection
{
  transactionFailures = 0;

  constructor(private readonly executor: ScriptedConnection) {}

  async transaction<Result>(
    callback: (
      transaction: CanonicalTranscriptTx,
      executor: ScriptedConnection,
    ) => Promise<Result>,
  ): Promise<Result> {
    let identityPending = true;
    type PolicyQuery = Readonly<{
      from(): PolicyQuery;
      where(): Promise<readonly Readonly<{
        mode: "shadow_encryption";
        revision: 7;
      }>[]>;
    }>;
    const query: PolicyQuery = {
      from: () => query,
      where: () => Promise.resolve([{
        mode: "shadow_encryption",
        revision: 7,
      }]),
    };
    const tx = {
      execute: () => {
        if (!identityPending) return Promise.resolve([]);
        identityPending = false;
        return Promise.resolve([{
          current_user: "nautilo",
          session_user: "nautilo",
        }]);
      },
      select: () => query,
    } as unknown as CanonicalTranscriptTx;
    try {
      return await callback(tx, this.executor);
    } catch (error) {
      this.transactionFailures += 1;
      throw error;
    }
  }
}

function state(overrides: Record<string, unknown> = {}) {
  return {
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    owner_id: OWNER_ID,
    room_kind: "private",
    suspended_at: null,
    has_agent: true,
    last_processed_message_id: 0,
    historical_backfill_status: "not_needed",
    historical_backfill_cursor_message_id: null,
    historical_backfill_target_message_id: null,
    lease_token: null,
    lease_expires_at: null,
    extraction_retry_after: null,
    extraction_failure_count: 0,
    rebuild_generation: 3,
    rebuild_requested_at: null,
    rebuild_target_message_id: null,
    upper_bound_message_id: 5,
    retry_fixed_range: false,
    prior_context_floor_message_id: 0,
    prior_context_limit: 10,
    compaction_due_at: null,
    compaction_lease_token: null,
    compaction_lease_expires_at: null,
    compaction_retry_after: null,
    compaction_failure_count: 0,
    ...overrides,
  };
}

function source(messageId: number, overrides: Record<string, unknown> = {}) {
  return {
    message_id: messageId,
    edit_revision: 0,
    created_at: new Date(NOW.getTime() - 120_000),
    role: "user",
    fingerprint: null,
    transcript_origin: "main",
    originated_by: null,
    excluded_from_evidence: false,
    key_class: "ai",
    crypto_object_id: `conversation/message/${messageId}`,
    crypto_completion: "complete",
    participant_id: PARTICIPANT_ID,
    ...overrides,
  };
}

async function setup(
  results: readonly (readonly unknown[] | Error)[],
  role: "nautilo" | "nautilo_agent" = "nautilo",
) {
  const connection = new ScriptedConnection([
    [{ current_user: role, session_user: role }],
    ...results,
  ]);
  const handle = await verifyConversationProductPostgresHandle(connection);
  return {
    connection,
    handle,
    repository: new PostgresProtectedStenographerWorkRepository(handle, {
      leaseToken: () => LEASE_TOKEN,
    }),
  };
}

function canonical(postgres: Awaited<ReturnType<typeof setup>>) {
  const connection = new PolicyCanonicalConnection(postgres.connection);
  return {
    connection,
    runner: bindConversationProductCanonicalTransactionRunner(
      postgres.handle,
      connection,
    ),
  };
}

function extractionResults(
  stateRow = state(),
  sourceRows = [1, 2, 3, 4, 5].map((id) => source(id)),
) {
  return [
    [stateRow],
    sourceRows,
    [],
    [],
    [],
    [{ room_id: ROOM_ID }],
    [{ id: BATCH_ID, attempt_count: 1, created_at: NOW.toISOString() }],
  ] as const;
}

function assertMetadataOnly(statements: readonly string[]): void {
  for (const statement of statements.slice(1)) {
    expect(statement).not.toMatch(
      /\b(sm\.content|statement|rollup\.content|display_name|handle|tool_calls)\b/iu,
    );
  }
}

async function extractionClaim() {
  const claimed = await setup(extractionResults());
  const result = await claimed.repository.claimExtraction({
    roomId: ROOM_ID,
    lane: "live",
    now: NOW,
  });
  if (result.status !== "claimed") {
    throw new Error("extraction fixture did not claim");
  }
  return result.claim;
}

function compactionEvent() {
  return {
    event_id: "70000000-0000-4000-8000-000000000001",
    crypto_object_id: "journal/event/1",
    room_id: ROOM_ID,
    namespace_id: NAMESPACE_ID,
    sequence: 1,
    kind: "fact",
    status: "active",
    supersedes_event_id: null,
    resolves_event_id: null,
    source_message_ids_csv: "1",
    source_batch_id: BATCH_ID,
    batch_local_ordinal: 0,
    extractor_version: "m241-v1",
    projection_kind: "legacy",
    record_lifecycle: null,
    record_structural_height: null,
    record_processing_generation: null,
    created_at: NOW.toISOString(),
  };
}

async function compactionClaim() {
  const claimed = await setup([
    [state({
      upper_bound_message_id: null,
      compaction_due_at: NOW,
    })],
    [],
    [{active_event_count: 1}],
    [compactionEvent()],
    [{room_id: ROOM_ID}],
  ]);
  const result = await claimed.repository.claimCompaction({
    roomId: ROOM_ID,
    now: NOW,
  });
  if (result.status !== "claimed") {
    throw new Error("compaction fixture did not claim");
  }
  return result.claim;
}

function extractionBatch(
  claim: Awaited<ReturnType<typeof extractionClaim>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: claim.sourceBatchId,
    room_id: claim.roomId,
    from_message_id_exclusive: claim.fromMessageIdExclusive,
    through_message_id_inclusive: claim.throughMessageIdInclusive,
    extractor_version: claim.extractorVersion,
    lane: claim.lane,
    status: "running",
    attempt_count: claim.attemptCount,
    created_at: claim.createdAt,
    ...overrides,
  };
}

function claimedState(
  claim:
    | Awaited<ReturnType<typeof extractionClaim>>
    | Awaited<ReturnType<typeof compactionClaim>>,
  overrides: Record<string, unknown> = {},
) {
  return state({
    rebuild_generation: claim.rebuildGeneration,
    ...(claim.kind === "extraction"
      ? {
        last_processed_message_id: claim.fromMessageIdExclusive,
        lease_token: claim.leaseToken,
        lease_expires_at: claim.leaseExpiresAt,
      }
      : {
        upper_bound_message_id: null,
        compaction_due_at: NOW,
        compaction_lease_token: claim.leaseToken,
        compaction_lease_expires_at: claim.leaseExpiresAt,
      }),
    ...overrides,
  });
}

describe("protected Stenographer product work repository", () => {
  test("keeps an exact unstarted extraction claim when cancellation loses the acceptance race", async () => {
    const claim = await extractionClaim();
    const postgres = await setup([
      [claimedState(claim)],
      [extractionBatch(claim)],
      [],
    ]);
    const bound = canonical(postgres);
    let cancellations = 0;

    expect(await postgres.repository.releaseUnstartedClaimForFallback(
      claim,
      {
        canonical: bound.runner,
        expectedPolicyRevision: 7,
        cancel: () => {
          cancellations += 1;
          return Promise.resolve(false);
        },
      },
    )).toBeFalse();
    expect(cancellations).toBe(1);
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).startsWith("update ")
    )).toBeFalse();
    expect(postgres.connection.isolationLevels).toEqual([]);
  });

  test("does not cancel or release a replacement extraction lease", async () => {
    const claim = await extractionClaim();
    const postgres = await setup([[
      claimedState(claim, {
        lease_token: "77777777-7777-4777-8777-777777777777",
      }),
    ]]);
    const bound = canonical(postgres);
    let cancellations = 0;

    expect(await postgres.repository.releaseUnstartedClaimForFallback(
      claim,
      {
        canonical: bound.runner,
        expectedPolicyRevision: 7,
        cancel: () => {
          cancellations += 1;
          return Promise.resolve(true);
        },
      },
    )).toBeFalse();
    expect(cancellations).toBe(0);
    expect(postgres.connection.statements).toHaveLength(2);
  });

  test("does not cancel a claim after any durable publication receipt exists", async () => {
    const claim = await extractionClaim();
    const postgres = await setup([
      [claimedState(claim)],
      [extractionBatch(claim)],
      [{publication_id: "reserved-publication"}],
    ]);
    const bound = canonical(postgres);
    let cancellations = 0;

    expect(await postgres.repository.releaseUnstartedClaimForFallback(
      claim,
      {
        canonical: bound.runner,
        expectedPolicyRevision: 7,
        cancel: () => {
          cancellations += 1;
          return Promise.resolve(true);
        },
      },
    )).toBeFalse();
    expect(cancellations).toBe(0);
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).includes(
        "from room_journal_crypto_publications",
      )
    )).toBeTrue();
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).startsWith("update ")
    )).toBeFalse();
  });

  test("releases only the exact extraction lease and returns its running batch to pending", async () => {
    const claim = await extractionClaim();
    const postgres = await setup([
      [claimedState(claim)],
      [extractionBatch(claim)],
      [],
      [{id: claim.sourceBatchId}],
      [{room_id: claim.roomId}],
    ]);
    const bound = canonical(postgres);
    let cancellations = 0;

    expect(await postgres.repository.releaseUnstartedClaimForFallback(
      claim,
      {
        canonical: bound.runner,
        expectedPolicyRevision: 7,
        cancel: () => {
          cancellations += 1;
          return Promise.resolve(true);
        },
      },
    )).toBeTrue();
    expect(cancellations).toBe(1);
    const updates = postgres.connection.statements.map(normalizedSql)
      .filter((statement) => statement.startsWith("update "));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toContain("update room_journal_batches set status");
    expect(updates[0]!.split(" where ")[0]).not.toMatch(
      /attempt_count|last_error|completed_at|started_at/,
    );
    expect(updates[1]).toContain("update room_journal_state set lease_token");
    expect(updates[1]!.split(" where ")[0]).not.toMatch(
      /last_processed|historical_backfill|retry|failure|rebuild|compaction_due/,
    );
  });

  test("releases exact compaction metadata while preserving its due work", async () => {
    const claim = await compactionClaim();
    const postgres = await setup([
      [claimedState(claim)],
      [],
      [{room_id: claim.roomId}],
    ]);
    const bound = canonical(postgres);
    let cancellations = 0;

    expect(await postgres.repository.releaseUnstartedClaimForFallback(
      claim,
      {
        canonical: bound.runner,
        expectedPolicyRevision: 7,
        cancel: () => {
          cancellations += 1;
          return Promise.resolve(true);
        },
      },
    )).toBeTrue();
    expect(cancellations).toBe(1);
    const update = normalizedSql(postgres.connection.statements.at(-1) ?? "");
    expect(update).toContain(
      "update room_journal_state set compaction_lease_token",
    );
    expect(update.split(" where ")[0]).not.toMatch(
      /compaction_due_at|retry|failure/,
    );
  });

  test("throws on post-cancellation CAS loss so the product transaction retains its claim", async () => {
    const claim = await extractionClaim();
    const postgres = await setup([
      [claimedState(claim)],
      [extractionBatch(claim)],
      [],
      [],
    ]);
    const bound = canonical(postgres);
    let cancellations = 0;

    expect(postgres.repository.releaseUnstartedClaimForFallback(
      claim,
      {
        canonical: bound.runner,
        expectedPolicyRevision: 7,
        cancel: () => {
          cancellations += 1;
          return Promise.resolve(true);
        },
      },
    )).rejects.toThrow("lost its exact claim");
    expect(cancellations).toBe(1);
    expect(bound.connection.transactionFailures).toBe(1);
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).includes(
        "update room_journal_state set lease_token",
      )
    )).toBeFalse();
  });

  test("claims ordinary extraction with exact content-free bindings and deterministic output slots", async () => {
    const first = await setup(extractionResults());
    const result = await first.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "live",
      now: NOW,
    });

    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      kind: "extraction",
      workKind: "stenographer.extraction",
      workId: BATCH_ID,
      sourceBatchId: BATCH_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      ownerId: OWNER_ID,
      rebuildGeneration: 3,
      lane: "live",
      leaseToken: LEASE_TOKEN,
      leaseExpiresAt: new Date(
        NOW.getTime() + PROTECTED_STENOGRAPHER_WORK_LEASE_MS,
      ),
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: 5,
      requiresContentRecheck: false,
      participantIds: [PARTICIPANT_ID],
      inputObjectIds: [
        "conversation/message/1",
        "conversation/message/2",
        "conversation/message/3",
        "conversation/message/4",
        "conversation/message/5",
      ],
    });
    expect(result.claim.bindings).toHaveLength(5);
    expect(result.claim.sourceBindingFingerprint).toHaveLength(32);
    expect(result.claim.coveredRangeFingerprint).toHaveLength(32);
    expect(result.claim.outputSlots).toHaveLength(5);
    expect(new Set(result.claim.outputSlots.map((slot) => slot.eventId)).size)
      .toBe(5);
    expect(new Set(result.claim.outputSlots.map((slot) => slot.objectId)).size)
      .toBe(5);
    expect(first.connection.isolationLevels).toEqual(["serializable"]);
    expect(normalizedSql(first.connection.statements.at(-1) ?? ""))
      .toContain("insert into room_journal_batches");
    const leaseStatement = first.connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("set lease_token")
    );
    const batchStatement = first.connection.statements.findIndex((statement) =>
      normalizedSql(statement).includes("insert into room_journal_batches")
    );
    expect(leaseStatement).toBeGreaterThan(0);
    expect(batchStatement).toBeGreaterThan(leaseStatement);
    expect(normalizedSql(first.connection.statements[leaseStatement] ?? ""))
      .toContain("rebuild_requested_at is null");
    assertMetadataOnly(first.connection.statements);

    const replay = await setup(extractionResults());
    const replayed = await replay.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "live",
      now: NOW,
    });
    expect(replayed.status).toBe("claimed");
    if (replayed.status !== "claimed") return;
    expect(replayed.claim.outputSlots).toEqual(result.claim.outputSlots);
    expect(replayed.claim.sourceBindingFingerprint)
      .toEqual(result.claim.sourceBindingFingerprint);
  });

  test("supports historical extraction without changing the fixed source range", async () => {
    const postgres = await setup(extractionResults(state({
      historical_backfill_status: "pending",
      historical_backfill_cursor_message_id: 10,
      historical_backfill_target_message_id: 12,
      upper_bound_message_id: 12,
      retry_fixed_range: true,
    }), [
      source(11),
      source(12, { role: "tool" }),
    ]));

    const result = await postgres.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "historical",
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "claimed",
      claim: {
        workKind: "stenographer.historical",
        lane: "historical",
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 12,
      },
    });
    assertMetadataOnly(postgres.connection.statements);
  });

  test("claims only the exact prepared rebuild target on the persisted live lane", async () => {
    const prepared = state({
      rebuild_requested_at: NOW,
      rebuild_target_message_id: 5,
    });
    const postgres = await setup(extractionResults(prepared));
    const result = await postgres.repository.claimRebuildExtraction({
      roomId: ROOM_ID,
      rebuildGeneration: 3,
      targetMessageId: 5,
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "claimed",
      claim: {
        lane: "live",
        workKind: "stenographer.rebuild",
        rebuildGeneration: 3,
        rebuildTargetMessageId: 5,
        fromMessageIdExclusive: 0,
        throughMessageIdInclusive: 5,
      },
    });
    expect(normalizedSql(postgres.connection.statements.at(-2) ?? ""))
      .toContain("rebuild_target_message_id");
    assertMetadataOnly(postgres.connection.statements);

    for (const mismatch of [
      { rebuildGeneration: 4, targetMessageId: 5 },
      { rebuildGeneration: 3, targetMessageId: 6 },
    ]) {
      const stale = await setup([[prepared]]);
      expect(await stale.repository.claimRebuildExtraction({
        roomId: ROOM_ID,
        ...mismatch,
        now: NOW,
      })).toEqual({ status: "unavailable", reason: "stale" });
      expect(stale.connection.statements).toHaveLength(2);
    }
  });

  test("acknowledges an excluded live range by exact metadata CAS without work", async () => {
    const rows = [1, 2].map((id) => source(id, {
      excluded_from_evidence: true,
    }));
    const postgres = await setup([
      [state({ upper_bound_message_id: 2 })],
      rows,
      rows,
      [{ room_id: ROOM_ID }],
    ]);
    const result = await postgres.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "live",
      now: NOW,
    });
    expect(result).toMatchObject({
      status: "completed",
      completion: "excluded_range_acknowledged",
      workKind: "stenographer.extraction",
      lane: "live",
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: 2,
    });
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).includes("insert into room_journal_batches")
      || normalizedSql(statement).includes("set lease_token")
    )).toBe(false);
    const acknowledgement = normalizedSql(
      postgres.connection.statements.at(-1) ?? "",
    );
    expect(acknowledgement).toContain("last_processed_message_id");
    expect(acknowledgement).toContain("rebuild_generation");
    expect(normalizedSql(postgres.connection.statements.at(-2) ?? ""))
      .toContain("for share of sm");
    assertMetadataOnly(postgres.connection.statements);

    const changedRows = [
      source(1, { excluded_from_evidence: true, edit_revision: 1 }),
      rows[1]!,
    ];
    const changed = await setup([
      [state({ upper_bound_message_id: 2 })],
      rows,
      changedRows,
    ]);
    expect(await changed.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "live",
      now: NOW,
    })).toEqual({ status: "unavailable", reason: "stale" });
    expect(changed.connection.statements.some((statement) =>
      normalizedSql(statement).startsWith("update room_journal_state")
    )).toBe(false);
  });

  test("completes excluded historical and rebuild ranges at their exact targets", async () => {
    const rows = [11, 12].map((id) => source(id, {
      excluded_from_evidence: true,
    }));
    const historical = await setup([
      [state({
        historical_backfill_status: "pending",
        historical_backfill_cursor_message_id: 10,
        historical_backfill_target_message_id: 12,
        upper_bound_message_id: 12,
      })],
      rows,
      rows,
      [{ room_id: ROOM_ID }],
    ]);
    expect(await historical.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "historical",
      now: NOW,
    })).toMatchObject({
      status: "completed",
      completion: "excluded_range_acknowledged",
      workKind: "stenographer.historical",
      throughMessageIdInclusive: 12,
    });
    expect(normalizedSql(historical.connection.statements.at(-1) ?? ""))
      .toContain("historical_backfill_status");

    const rebuildRows = [1, 2].map((id) => source(id, {
      excluded_from_evidence: true,
    }));
    const rebuild = await setup([
      [state({
        rebuild_requested_at: NOW,
        rebuild_target_message_id: 2,
        upper_bound_message_id: 2,
      })],
      rebuildRows,
      rebuildRows,
      [{ room_id: ROOM_ID }],
    ]);
    expect(await rebuild.repository.claimRebuildExtraction({
      roomId: ROOM_ID,
      rebuildGeneration: 3,
      targetMessageId: 2,
      now: NOW,
    })).toMatchObject({
      status: "completed",
      completion: "excluded_range_acknowledged",
      workKind: "stenographer.rebuild",
      rebuildGeneration: 3,
      throughMessageIdInclusive: 2,
    });
    const rebuildAcknowledgement = normalizedSql(
      rebuild.connection.statements.at(-1) ?? "",
    );
    expect(rebuildAcknowledgement).toContain("rebuild_requested_at");
    expect(rebuildAcknowledgement).toContain("rebuild_target_message_id");
    assertMetadataOnly([
      ...historical.connection.statements,
      ...rebuild.connection.statements,
    ]);
  });

  test("recovers an exact durable extraction using its current metadata-only lease", async () => {
    const createdAt = new Date(NOW.getTime() - 30_000).toISOString();
    const postgres = await setup([
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        from_message_id_exclusive: 0,
        through_message_id_inclusive: 5,
        extractor_version: "m241-v1",
        lane: "live",
        status: "running",
        attempt_count: 3,
        created_at: createdAt,
        current_running_batch_id: BATCH_ID,
      }],
      [{ id: BATCH_ID }],
      [state({
        lease_token: LEASE_TOKEN,
        lease_expires_at: new Date(NOW.getTime() + 60_000),
      })],
      [1, 2, 3, 4, 5].map((id) => source(id)),
      [],
      [],
      [],
    ]);

    const result = await postgres.repository.recoverExtraction({
      workId: BATCH_ID,
      now: NOW,
    });
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      workId: BATCH_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 3,
      createdAt,
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: 5,
    });
    expect(result.claim.coveredRangeFingerprint).toHaveLength(32);
    expect(postgres.connection.statements.some((statement) =>
      statement.includes("SET lease_token")
    )).toBe(false);
    expect(postgres.connection.statements.some((statement) =>
      statement.includes("sm.content")
      || statement.includes("rollup.content")
      || statement.includes("event.statement")
    )).toBe(false);
    assertMetadataOnly(postgres.connection.statements);
  });

  test("recovers an exact durable extraction from PostgreSQL timestamp strings", async () => {
    const createdAt = new Date(NOW.getTime() - 30_000).toISOString();
    const postgres = await setup([
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        from_message_id_exclusive: 0,
        through_message_id_inclusive: 5,
        extractor_version: "m241-v1",
        lane: "live",
        status: "running",
        attempt_count: 3,
        created_at: createdAt,
        current_running_batch_id: BATCH_ID,
      }],
      [{ id: BATCH_ID }],
      [state({
        lease_token: LEASE_TOKEN,
        lease_expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
      })],
      [1, 2, 3, 4, 5].map((id) => source(id, {
        created_at: new Date(NOW.getTime() - 120_000).toISOString(),
      })),
      [],
      [],
      [],
    ]);

    const result = await postgres.repository.recoverExtraction({
      workId: BATCH_ID,
      now: NOW,
    });
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      workId: BATCH_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 3,
      createdAt,
      fromMessageIdExclusive: 0,
      throughMessageIdInclusive: 5,
    });
    expect(result.claim.coveredRangeFingerprint).toHaveLength(32);
    expect(postgres.connection.statements.some((statement) =>
      statement.includes("SET lease_token")
    )).toBe(false);
    expect(postgres.connection.statements.some((statement) =>
      statement.includes("sm.content")
      || statement.includes("rollup.content")
      || statement.includes("event.statement")
    )).toBe(false);
    assertMetadataOnly(postgres.connection.statements);
  });

  test("recovers a durable rebuild batch only against its still-prepared target", async () => {
    const createdAt = new Date(NOW.getTime() - 30_000).toISOString();
    const postgres = await setup([
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        from_message_id_exclusive: 0,
        through_message_id_inclusive: 5,
        extractor_version: "m241-v1",
        lane: "live",
        status: "running",
        attempt_count: 2,
        created_at: createdAt,
      }],
      [{ id: BATCH_ID }],
      [state({
        rebuild_requested_at: NOW,
        rebuild_target_message_id: 5,
        lease_token: LEASE_TOKEN,
        lease_expires_at: new Date(NOW.getTime() + 60_000),
      })],
      [1, 2, 3, 4, 5].map((id) => source(id)),
      [],
      [],
      [],
    ]);
    expect(await postgres.repository.recoverExtraction({
      workId: BATCH_ID,
      now: NOW,
    })).toMatchObject({
      status: "claimed",
      claim: {
        workKind: "stenographer.rebuild",
        lane: "live",
        rebuildGeneration: 3,
        rebuildTargetMessageId: 5,
        throughMessageIdInclusive: 5,
      },
    });
    assertMetadataOnly(postgres.connection.statements);
  });

  test("reacquires an expired exact extraction lease without changing its durable creation identity", async () => {
    const createdAt = new Date(NOW.getTime() - 30_000).toISOString();
    const postgres = await setup([
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        from_message_id_exclusive: 0,
        through_message_id_inclusive: 5,
        extractor_version: "m241-v1",
        lane: "live",
        status: "failed",
        attempt_count: 3,
        created_at: createdAt,
        current_running_batch_id: null,
      }],
      [],
      [state({
        lease_token: "77777777-7777-4777-8777-777777777777",
        lease_expires_at: new Date(NOW.getTime() - 1),
      })],
      [1, 2, 3, 4, 5].map((id) => source(id)),
      [],
      [],
      [],
      [{ room_id: ROOM_ID }],
      [{ id: BATCH_ID, attempt_count: 4, created_at: createdAt }],
    ]);

    const result = await postgres.repository.recoverExtraction({
      workId: BATCH_ID,
      now: NOW,
    });
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      leaseToken: LEASE_TOKEN,
      attemptCount: 4,
      createdAt,
    });
    expect(normalizedSql(postgres.connection.statements.at(-1) ?? ""))
      .toContain("update room_journal_batches");
    assertMetadataOnly(postgres.connection.statements);
  });

  test("does not reuse a live extraction lease owned by another running batch", async () => {
    const otherBatch = "77777777-7777-4777-8777-777777777777";
    const postgres = await setup([
      [{
        id: BATCH_ID,
        room_id: ROOM_ID,
        from_message_id_exclusive: 0,
        through_message_id_inclusive: 5,
        extractor_version: "m241-v1",
        lane: "live",
        status: "running",
        attempt_count: 3,
        created_at: NOW.toISOString(),
        current_running_batch_id: otherBatch,
      }],
      [{ id: otherBatch }],
      [state({
        lease_token: LEASE_TOKEN,
        lease_expires_at: new Date(NOW.getTime() + 60_000),
      })],
      [1, 2, 3, 4, 5].map((id) => source(id)),
      [],
      [],
      [],
    ]);
    expect(await postgres.repository.recoverExtraction({
      workId: BATCH_ID,
      now: NOW,
    })).toEqual({ status: "unavailable", reason: "leased" });
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).includes("update room_journal_batches")
    )).toBe(false);
  });

  test("does not claim while protected rebuild cleanup is pending", async () => {
    const postgres = await setup([[
      state({ rebuild_requested_at: NOW }),
    ]]);
    expect(await postgres.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "live",
      now: NOW,
    })).toEqual({ status: "unavailable", reason: "rebuild_pending" });
    expect(postgres.connection.statements).toHaveLength(2);

    const historical = await setup([[
      state({
        rebuild_requested_at: NOW,
        rebuild_target_message_id: 5,
        historical_backfill_status: "pending",
        historical_backfill_cursor_message_id: 0,
        historical_backfill_target_message_id: 5,
      }),
    ]]);
    expect(await historical.repository.claimExtraction({
      roomId: ROOM_ID,
      lane: "historical",
      now: NOW,
    })).toEqual({ status: "unavailable", reason: "rebuild_pending" });
  });

  test("claims compaction from encrypted event and rollup metadata only", async () => {
    const events = Array.from({ length: 80 }, (_, index) => {
      const sequence = index + 2;
      return {
        event_id:
          `70000000-0000-4000-8000-${sequence.toString().padStart(12, "0")}`,
        crypto_object_id: `journal/event/${sequence}`,
        room_id: ROOM_ID,
        namespace_id: NAMESPACE_ID,
        sequence,
        kind: "fact",
        status: "active",
        supersedes_event_id: null,
        resolves_event_id: null,
        source_message_ids_csv: String(sequence),
        source_batch_id: BATCH_ID,
        batch_local_ordinal: index,
        extractor_version: "m241-v1",
        projection_kind: "legacy",
        record_lifecycle: null,
        record_structural_height: null,
        record_processing_generation: null,
        created_at: NOW.toISOString(),
      };
    });
    const postgres = await setup([
      [state({
        upper_bound_message_id: null,
        compaction_due_at: NOW,
      })],
      [{
        rollup_id: "77777777-7777-4777-8777-777777777777",
        crypto_object_id: "journal/rollup/1",
        room_id: ROOM_ID,
        namespace_id: NAMESPACE_ID,
        through_event_sequence: 1,
        source_event_count: 1,
        model_id: "model-v1",
        compactor_version: "m241-v1",
        created_at: NOW.toISOString(),
      }],
      [{ active_event_count: 80 }],
      events,
      [{ room_id: ROOM_ID }],
    ]);

    const result = await postgres.repository.claimCompaction({
      roomId: ROOM_ID,
      now: NOW,
    });
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      kind: "compaction",
      workKind: "stenographer.compaction",
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      rebuildGeneration: 3,
      leaseToken: LEASE_TOKEN,
      inputObjectIds: [
        "journal/rollup/1",
        ...events.map((row) => row.crypto_object_id),
      ],
      activeEventCount: 80,
    });
    expect(result.claim.sourceBindingFingerprint).toHaveLength(32);
    expect(result.claim.outputSlot.objectId).toContain("journal/rollup/");
    expect(result.claim.outputSlot.rollupId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(postgres.connection.isolationLevels).toEqual(["serializable"]);
    assertMetadataOnly(postgres.connection.statements);
  });

  test("recovers exact compaction selection using the current durable lease", async () => {
    const createdAt = new Date(NOW.getTime() - 30_000).toISOString();
    const event = {
      event_id: "70000000-0000-4000-8000-000000000001",
      crypto_object_id: "journal/event/1",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      sequence: 1,
      kind: "fact",
      status: "active",
      supersedes_event_id: null,
      resolves_event_id: null,
      source_message_ids_csv: "1",
      source_batch_id: BATCH_ID,
      batch_local_ordinal: 0,
      extractor_version: "m241-v1",
      projection_kind: "legacy",
      record_lifecycle: null,
      record_structural_height: null,
      record_processing_generation: null,
      created_at: NOW.toISOString(),
    };
    const postgres = await setup([
      [state({
        upper_bound_message_id: null,
        compaction_due_at: NOW,
        compaction_lease_token: LEASE_TOKEN,
        compaction_lease_expires_at:
          new Date(NOW.getTime() + 60_000),
      })],
      [],
      [{ active_event_count: 1 }],
      [event],
    ]);
    const workId = `stenographer-compaction/${ROOM_ID}/3/1`;
    const result = await postgres.repository.recoverCompaction({
      workId,
      createdAt,
      now: NOW,
    });
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      workId,
      leaseToken: LEASE_TOKEN,
      createdAt,
      inputObjectIds: ["journal/event/1"],
      activeEventCount: 1,
      selectedEventCount: 1,
      hasDeferredMiddle: false,
    });
    expect(postgres.connection.statements.some((statement) =>
      normalizedSql(statement).includes("set compaction_lease_token")
    )).toBe(false);
    assertMetadataOnly(postgres.connection.statements);
  });

  test("reacquires an expired exact compaction lease", async () => {
    const event = {
      event_id: "70000000-0000-4000-8000-000000000001",
      crypto_object_id: "journal/event/1",
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      sequence: 1,
      kind: "fact",
      status: "active",
      supersedes_event_id: null,
      resolves_event_id: null,
      source_message_ids_csv: "1",
      source_batch_id: BATCH_ID,
      batch_local_ordinal: 0,
      extractor_version: "m241-v1",
      projection_kind: "legacy",
      record_lifecycle: null,
      record_structural_height: null,
      record_processing_generation: null,
      created_at: NOW.toISOString(),
    };
    const postgres = await setup([
      [state({
        upper_bound_message_id: null,
        compaction_due_at: NOW,
        compaction_lease_token:
          "77777777-7777-4777-8777-777777777777",
        compaction_lease_expires_at:
          new Date(NOW.getTime() - 1),
      })],
      [],
      [{ active_event_count: 1 }],
      [event],
      [{ room_id: ROOM_ID }],
    ]);
    const workId = `stenographer-compaction/${ROOM_ID}/3/1`;
    const result = await postgres.repository.recoverCompaction({
      workId,
      createdAt: NOW.toISOString(),
      now: NOW,
    });
    expect(result.status).toBe("claimed");
    if (result.status !== "claimed") return;
    expect(result.claim).toMatchObject({
      workId,
      leaseToken: LEASE_TOKEN,
      leaseExpiresAt:
        new Date(NOW.getTime() + PROTECTED_STENOGRAPHER_WORK_LEASE_MS),
    });
    expect(normalizedSql(postgres.connection.statements.at(-1) ?? ""))
      .toContain("set compaction_lease_token");
    assertMetadataOnly(postgres.connection.statements);
  });

  test("requires a verified direct nautilo product-role handle", async () => {
    const connection = new ScriptedConnection([[
      {
        current_user: "nautilo_agent",
        session_user: "nautilo_agent",
      },
    ]]);
    const handle = await verifyConversationProductPostgresHandle(connection);
    expect(() =>
      new PostgresProtectedStenographerWorkRepository(handle)
    ).toThrow();
  });
});


describe("unstarted current-plan product fence", () => {
  test("locks current Room/source and retains exact lease without spending another attempt", async () => {
    const claim = await extractionClaim();
    const sources = [1, 2, 3, 4, 5].map(id => source(id));
    const postgres = await setup([[{id: ROOM_ID}], [claimedState(claim)], [extractionBatch(claim)], [], sources, sources]);
    const bound = canonical(postgres); let committed = 0;
    expect(await postgres.repository.supersedeUnstartedClaim(claim, {canonical: bound.runner,
      expectedPolicyRevision: 7, now: NOW, supersede: () => {committed++; return Promise.resolve(true);}})).toBe(true);
    expect(committed).toBe(1);
    const statements = postgres.connection.statements.map(normalizedSql);
    expect(statements[1]).toContain("for update");
    expect(statements.some(sql => sql.startsWith("update "))).toBe(false);
    expect(statements.some(sql => sql.includes("from sessions as session"))).toBe(true);
    assertMetadataOnly(postgres.connection.statements);
  });
  test.each(["publication", "lease", "source"] as const)("a changed %s cannot supersede any request", async reason => {
    const claim = await extractionClaim();
    const results = [[{id: ROOM_ID}], [claimedState(claim, reason === "lease"
      ? {lease_token: "77777777-7777-4777-8777-777777777777"} : {})], [extractionBatch(claim)],
      reason === "publication" ? [{publication_id: "committed-or-uncertain"}] : [], []];
    const postgres = await setup(results);
    const bound = canonical(postgres); let committed = 0;
    expect(await postgres.repository.supersedeUnstartedClaim(claim, {canonical: bound.runner,
      expectedPolicyRevision: 7, now: NOW, supersede: () => {committed++; return Promise.resolve(true);}})).toBe(false);
    expect(committed).toBe(0);
    expect(postgres.connection.statements.some(sql => normalizedSql(sql).startsWith("update "))).toBe(false);
  });
});


describe("obsolete unstarted queue retirement", () => {
  test.each([false, true])("only publication-free work retires without modifying a product lease (%s)", async published => {
    const postgres = await setup([[{id: ROOM_ID}], [{room_id: ROOM_ID}], published ? [{id: "retained-publication"}] : []]);
    const bound = canonical(postgres); let retired = 0;
    expect(await postgres.repository.retireObsoleteUnstartedRequest({roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
      workId: "old-work", canonical: bound.runner, retire: () => {retired++; return Promise.resolve(true);}})).toBe(!published);
    expect(retired).toBe(published ? 0 : 1);
    const statements = postgres.connection.statements.map(normalizedSql);
    expect(statements.filter(statement => statement.includes("for update"))).toHaveLength(3);
    expect(statements.some(statement => statement.startsWith("update "))).toBe(false);
    assertMetadataOnly(postgres.connection.statements);
  });
});


test("an obsolete repair with a proved uncommitted abandoned receipt may retire without touching its retained history", async () => {
  const postgres = await setup([[{id: ROOM_ID}], [{room_id: ROOM_ID}], [{id: "uncommitted-repair", state: "superseded",
    failure_code: "crypto_publication_failed", crypto_committed_at: null, attached_at: null}]]);
  const bound = canonical(postgres); let retired = 0;
  expect(await postgres.repository.retireObsoleteUnstartedRequest({roomId: ROOM_ID, namespaceId: NAMESPACE_ID,
    workId: "repair-work", canonical: bound.runner, retire: () => {retired++; return Promise.resolve(true);}})).toBe(true);
  expect(retired).toBe(1);
  expect(postgres.connection.statements.some(statement => normalizedSql(statement).startsWith("update "))).toBe(false);
});

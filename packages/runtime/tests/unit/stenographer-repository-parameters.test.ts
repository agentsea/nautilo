import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  roomEventRollups,
  roomEvents,
  roomJournalBatches,
  type SQL,
} from "@nautilo/db";
import {
  encodeRoomEventRollupPayloadV1,
  stenographerOrdinaryOutputFingerprint,
} from "@nautilo/lattice-bridge";
import {
  claimNextCompaction,
  claimNextExtraction,
  claimNextHistoricalExtraction,
  initializeHistoricalBackfills,
  prepareNextJournalRebuild,
  publishCompaction,
  type CompactionClaim,
  type ExtractionClaim,
} from "../../src/stenographer";
import {
  tryClaimCompactionRoom,
  tryClaimRoom,
} from "../../src/stenographer/repository";
import {
  publishLegacyExtractionBeforeRecordCutoverForTests,
} from "../support/legacy-stenographer-writer";

const NOW = new Date("2026-07-27T12:00:00.000Z");

function recordingDb() {
  const queries: SQL[] = [];
  let typedSelects = 0;
  return {
    db: {
      execute: async (query: SQL) => {
        queries.push(query);
        return [];
      },
      select: () => {
        typedSelects += 1;
        return resultBuilder(() => []);
      },
    },
    queries,
    typedSelects: () => typedSelects,
  };
}

function resultBuilder(
  result: () => unknown,
  onValues?: (value: unknown) => void,
) {
  const builder: object = new Proxy({}, {
    get: (_target, property) => {
      if (property === "then") {
        return (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve(result()).then(resolve, reject);
      }
      return (value: unknown) => {
        if (property === "values") onValues?.(value);
        return builder;
      };
    },
  });
  return builder;
}

function scriptedSelect(results: unknown[][]) {
  return () => resultBuilder(() => results.shift() ?? []);
}

function parameterValues(query: SQL): unknown[] {
  const values: unknown[] = [];
  const visit = (chunk: unknown): void => {
    if (!chunk || typeof chunk !== "object") return;
    const record = chunk as {
      constructor?: { name?: string };
      queryChunks?: unknown[];
      value?: unknown;
    };
    if (record.constructor?.name === "Param") {
      values.push(record.value);
      return;
    }
    record.queryChunks?.forEach((child) => {
      if (child === null || typeof child !== "object") {
        values.push(child);
        return;
      }
      visit(child);
    });
  };
  visit(query);
  return values;
}

function queryText(query: SQL): string {
  const parts: string[] = [];
  const visit = (chunk: unknown): void => {
    if (typeof chunk === "string") {
      parts.push(chunk);
      return;
    }
    if (!chunk || typeof chunk !== "object") return;
    const record = chunk as {
      queryChunks?: unknown[];
      value?: unknown;
    };
    if (Array.isArray(record.value) && record.value.every((value) => typeof value === "string")) {
      parts.push(record.value.join(""));
    }
    record.queryChunks?.forEach(visit);
  };
  visit(query);
  return parts.join("");
}

describe("stenographer postgres-js parameters", () => {
  test.each([
    [
      "new fallback winner",
      true,
      "Losing attempted rollup.",
      "attempted:model",
      NOW,
    ],
    [
      "existing Plain conflict winner",
      false,
      "Persisted winning rollup.",
      "persisted:model",
      new Date("2026-07-27T11:00:00.000Z"),
    ],
  ] as const)("compaction fallback preserves the %s publication provenance", async (
    _scenario,
    insertedByTransaction,
    winnerContent,
    winnerModelId,
    winnerCreatedAt,
  ) => {
    const roomId = "44444444-4444-4444-8444-444444444444";
    const namespaceId = "55555555-5555-4555-8555-555555555555";
    const rollupId = "66666666-6666-4666-8666-666666666666";
    const selectedEvent = {
      id: "77777777-7777-4777-8777-777777777777",
      sequence: 9,
      statement: "Persist this decision.",
      status: "active" as const,
    };
    const claim = {
      roomId,
      ownerId: "owner-1",
      leaseToken: "88888888-8888-4888-8888-888888888888",
      attemptCount: 1,
      modelOperationId: "operation-1",
      plan: {
        selectedEvents: [selectedEvent],
        throughEventSequence: 9,
        previousRollup: null,
      },
    } as unknown as CompactionClaim;
    const inserted: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const executed: SQL[] = [];
    const selectResponses = [
      [{
        compactionLeaseToken: claim.leaseToken,
        suspendedAt: null,
        namespaceId,
        rebuildGeneration: 4,
        hasAgent: true,
      }],
      [selectedEvent],
      [{
        id: rollupId,
        roomId,
        throughEventSequence: 9,
        content: winnerContent,
        sourceEventCount: 1,
        modelId: winnerModelId,
        compactorVersion: "m219-v1",
        createdAt: winnerCreatedAt,
        ordinaryFallbackReason: null,
        ordinaryFallbackRebuildGeneration: null,
        ordinaryOutputFingerprint: null,
      }],
    ];
    const select = scriptedSelect(selectResponses);
    let selectBuilds = 0;
    const tx = {
      execute: async (query: SQL) => {
        executed.push(query);
        return [];
      },
      select: () => {
        selectBuilds += 1;
        return select();
      },
      insert: () => resultBuilder(
        () => (insertedByTransaction ? [{ id: rollupId }] : []),
        (values) => {
          inserted.push(values as Record<string, unknown>);
        },
      ),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updated.push({
            ...values,
            ordinaryOutputFingerprint:
              values["ordinaryOutputFingerprint"] instanceof Uint8Array
                ? Uint8Array.from(values["ordinaryOutputFingerprint"])
                : values["ordinaryOutputFingerprint"],
          });
          return resultBuilder(() => [{ id: rollupId }]);
        },
      }),
    };
    const db = {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };

    expect(await publishCompaction({
      claim,
      content: "Losing attempted rollup.",
      modelId: "attempted:model",
      ordinaryFallbackReason: "authority",
      now: NOW,
      db: db as never,
    })).toBeTrue();

    expect(inserted[0]).toMatchObject({
      content: "Losing attempted rollup.",
      modelId: "attempted:model",
    });
    expect(selectBuilds).toBe(4);
    expect(executed).toHaveLength(2);
    expect(queryText(executed[0]!)).toContain("SELECT id FROM rooms");
    expect(queryText(executed[1]!)).toContain("WITH remaining");
    if (!insertedByTransaction) {
      expect(updated).toEqual([]);
      return;
    }
    const payloadBytes = encodeRoomEventRollupPayloadV1({
      rollupId,
      roomId,
      namespaceId,
      throughEventSequence: 9,
      content: winnerContent,
      sourceEventCount: 1,
      modelId: winnerModelId,
      compactorVersion: "m219-v1",
      createdAt: winnerCreatedAt.toISOString(),
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toEqual({
      ordinaryFallbackReason: "authority",
      ordinaryFallbackRebuildGeneration: 4,
      ordinaryOutputFingerprint: stenographerOrdinaryOutputFingerprint({
        kind: "compaction",
        receiptId: rollupId,
        roomId,
        namespaceId,
        rebuildGeneration: 4,
        fallbackReason: "authority",
        outputs: [{
          logicalId: rollupId,
          objectType: "room_event_rollup",
          createdAt: winnerCreatedAt.getTime(),
          payloadBytes,
        }],
      }),
    });
  });

  test.each(["live", "historical"] as const)(
    "serializes the %s replay completion timestamp through its column encoder",
    async (lane) => {
      const roomId = "44444444-4444-4444-8444-444444444444";
      const updates: Record<string, unknown>[] = [];
      const state = {
        room_id: roomId,
        owner_id: "55555555-5555-4555-8555-555555555555",
        kind: "private",
        last_processed_message_id: 10,
        suspended_at: null,
        lease_token: null,
        lease_expires_at: null,
        extraction_retry_after: null,
        historical_backfill_status: lane === "historical" ? "pending" : "not_needed",
        historical_backfill_cursor_message_id: lane === "historical" ? 10 : null,
        historical_backfill_target_message_id: lane === "historical" ? 20 : null,
        stenographer_prior_conversation_limit: 10,
        prior_context_floor_message_id: 0,
        rebuild_generation: 0,
        rebuild_requested_at: null,
        rebuild_target_message_id: null,
        has_agent: true,
        upper_bound_message_id: 15,
        replay_batch_status: "completed",
        replay_through_message_id: 15,
      };
      let executes = 0;
      const tx = {
        execute: async () => (++executes === 1 ? [] : [state]),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            updates.push(values);
            return { where: async () => [] };
          },
        }),
      };
      const db = {
        transaction: async <T>(run: (executor: typeof tx) => Promise<T>) => run(tx),
      };

      expect(await tryClaimRoom(db as never, roomId, NOW, 120_000, lane)).toBeNull();
      const expression = updates[0]?.["lastExtractionCompletedAt"] as SQL;
      const compiled = new PgDialect().sqlToQuery(expression);
      expect(compiled.params).toContain(NOW.toISOString());
      expect(compiled.params.some((value) => value instanceof Date)).toBe(false);
    },
  );

  test("does not reclaim extraction after an uncertain provider outcome", async () => {
    const roomId = "44444444-4444-4444-8444-444444444444";
    let executes = 0;
    const tx = {
      execute: async () => (++executes === 1 ? [] : [{
        room_id: roomId,
        owner_id: "55555555-5555-4555-8555-555555555555",
        kind: "private",
        last_processed_message_id: 10,
        suspended_at: null,
        lease_token: null,
        lease_expires_at: null,
        extraction_retry_after: null,
        historical_backfill_status: "not_needed",
        historical_backfill_cursor_message_id: null,
        historical_backfill_target_message_id: null,
        stenographer_prior_conversation_limit: 10,
        prior_context_floor_message_id: 0,
        rebuild_generation: 0,
        rebuild_requested_at: null,
        rebuild_target_message_id: null,
        has_agent: true,
        upper_bound_message_id: 11,
        replay_batch_status: "failed",
        replay_batch_error_code: "provider_outcome_unknown",
        replay_through_message_id: 11,
      }]),
    };
    const db = {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };

    expect(await tryClaimRoom(db as never, roomId, NOW)).toBeNull();
    expect(executes).toBe(2);
  });

  test("does not reclaim compaction after an uncertain provider outcome", async () => {
    const roomId = "44444444-4444-4444-8444-444444444444";
    let executes = 0;
    const tx = {
      execute: async () => (++executes === 1 ? [] : [{
        owner_id: "55555555-5555-4555-8555-555555555555",
        kind: "private",
        suspended_at: null,
        has_agent: true,
        compaction_due_at: NOW,
        compaction_lease_token: null,
        compaction_lease_expires_at: null,
        compaction_retry_after: null,
        compaction_failure_count: 0,
        last_compaction_error_code: "provider_outcome_unknown",
      }]),
    };
    const db = {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };

    expect(await tryClaimCompactionRoom(db as never, roomId, NOW)).toBeNull();
    expect(executes).toBe(2);
  });

  test("bodyless protected source defers without claiming or advancing", async () => {
    const roomId = "44444444-4444-4444-8444-444444444444";
    const writes: string[] = [];
    const executeResponses: unknown[] = [
      [],
      [{
        room_id: roomId,
        owner_id: "55555555-5555-4555-8555-555555555555",
        kind: "private",
        last_processed_message_id: 10,
        suspended_at: null,
        lease_token: null,
        lease_expires_at: null,
        extraction_retry_after: null,
        historical_backfill_status: "not_needed",
        historical_backfill_cursor_message_id: null,
        historical_backfill_target_message_id: null,
        stenographer_prior_conversation_limit: 10,
        prior_context_floor_message_id: 0,
        rebuild_generation: 0,
        rebuild_requested_at: null,
        rebuild_target_message_id: null,
        has_agent: true,
        upper_bound_message_id: 11,
        replay_batch_status: null,
        replay_through_message_id: null,
      }],
      [{
        id: 11,
        created_at: NOW,
        role: "user",
        content: null,
        fingerprint: null,
        transcript_origin: "main",
        originated_by: null,
        display_name: "Alice",
        handle: "alice",
        excluded_from_evidence: false,
      }],
    ];
    const tx = {
      execute: async () => executeResponses.shift() ?? [],
      selectDistinct: () => resultBuilder(() => []),
      insert: () => {
        writes.push("insert");
        return resultBuilder(() => []);
      },
      update: () => {
        writes.push("update");
        return resultBuilder(() => []);
      },
    };
    const db = {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };

    expect(await tryClaimRoom(db as never, roomId, NOW)).toBeNull();
    expect(writes).toEqual([]);
    expect(executeResponses).toEqual([]);
  });

  test("historical initialization casts its nullable completion timestamp", async () => {
    const historical = recordingDb();

    await initializeHistoricalBackfills({
      db: historical.db as never,
      now: NOW,
    });

    expect(historical.queries).toHaveLength(1);
    const initialization = queryText(historical.queries[0]!);
    expect(initialization).toContain(
      "THEN 2026-07-27T12:00:00.000Z::timestamptz",
    );
    expect(parameterValues(historical.queries[0]!)).toContain(
      NOW.toISOString(),
    );
  });

  test("dirty rebuild preparation captures privacy-bounded cursors exactly once", async () => {
    const roomId = "44444444-4444-4444-8444-444444444444";
    const queries: SQL[] = [];
    const deletedTables: unknown[] = [];
    const updatedValues: Record<string, unknown>[] = [];
    const executeResponses: unknown[] = [
      [],
      [],
      [{
        rebuild_generation: 3,
        rebuild_requested_at: NOW.toISOString(),
        rebuild_target_message_id: null,
      }],
    ];
    const selectResponses: unknown[][] = [
      [{ joined_at: NOW }],
      [{ start_cursor: 10, target_cursor: 25 }],
      [{ lastProcessedMessageId: 10 }],
    ];
    const tx = {
      execute: async (query: SQL) => {
        queries.push(query);
        return executeResponses.shift() ?? [];
      },
      delete: (table: unknown) => {
        deletedTables.push(table);
        return { where: async () => [] };
      },
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updatedValues.push(values);
          return { where: async () => [] };
        },
      }),
      select: scriptedSelect(selectResponses),
    };
    const db = {
      select: scriptedSelect([[{ room_id: roomId }]]),
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };

    expect(
      await prepareNextJournalRebuild({ db: db as never, now: NOW }),
    ).toBe(roomId);

    expect(selectResponses).toEqual([]);
    expect(updatedValues).toHaveLength(1);
    expect(updatedValues[0]?.["lastProcessedMessageId"]).toBe(10);
    expect(updatedValues[0]?.["rebuildTargetMessageId"]).toBe(25);
    expect(updatedValues[0]?.["updatedAt"]).toBe(NOW);
    expect(deletedTables).toEqual([
      roomEventRollups,
      roomEvents,
      roomJournalBatches,
    ]);
  });

  test("candidate scans use typed builders while historical initialization stays parameter-safe", async () => {
    const extraction = recordingDb();
    const historical = recordingDb();
    const compaction = recordingDb();

    await claimNextExtraction({
      db: extraction.db as never,
      now: NOW,
    });
    await claimNextCompaction({
      db: compaction.db as never,
      now: NOW,
    });
    await claimNextHistoricalExtraction({
      db: historical.db as never,
      now: NOW,
    });

    expect(extraction.typedSelects()).toBeGreaterThan(0);
    expect(historical.typedSelects()).toBeGreaterThan(0);
    expect(compaction.typedSelects()).toBeGreaterThan(0);
    expect(extraction.queries).toEqual([]);
    expect(historical.queries).toHaveLength(1);
    expect(compaction.queries).toEqual([]);
    const initializationParams = parameterValues(historical.queries[0]!);
    expect(initializationParams).toContain(NOW.toISOString());
    expect(initializationParams.some((param) => param instanceof Date)).toBe(false);
  });

  test("event inserts expand source message IDs as typed integer-array elements", async () => {
    const queries: SQL[] = [];
    const responses: unknown[] = [
      [],
      [{
        lease_token: "11111111-1111-4111-8111-111111111111",
        suspended_at: null,
        has_agent: true,
      }],
      [{ id: 101 }, { id: 102 }],
      [],
      [{ id: "22222222-2222-4222-8222-222222222222" }],
      [],
      [],
    ];
    const tx = {
      execute: async (query: SQL) => {
        queries.push(query);
        return responses.shift() ?? [];
      },
    };
    const db = {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };
    const claim: ExtractionClaim = {
      batchId: "33333333-3333-4333-8333-333333333333",
      roomId: "44444444-4444-4444-8444-444444444444",
      ownerId: "55555555-5555-4555-8555-555555555555",
      leaseToken: "11111111-1111-4111-8111-111111111111",
      attemptCount: 1,
      lane: "live",
      plan: {
        fromMessageIdExclusive: 100,
        throughMessageIdInclusive: 102,
        trigger: "count",
        sourceRows: [],
        coveredMessageIds: [101, 102],
        conversationalMessageCount: 2,
        newestEligibleSourceAt: NOW,
      },
      sourceRows: [],
      priorContextRows: [],
      latestRollup: null,
      visibleEvents: [],
    };

    await publishLegacyExtractionBeforeRecordCutoverForTests({
      claim,
      operations: [{
        op: "append",
        kind: "fact",
        statement: "A durable synthetic fact.",
        sourceMessageIds: [101, 102],
      }],
      modelId: "test:model",
      now: NOW,
      db: db as never,
    });

    const insertParams = queries
      .map(parameterValues)
      .find((params) => params.includes("A durable synthetic fact."));
    expect(insertParams).toBeDefined();
    expect(insertParams).toContain(101);
    expect(insertParams).toContain(102);
    expect(
      insertParams?.some((param) => Array.isArray(param)),
    ).toBe(false);
  });

  test("historical claims use their own durable cursor and lane", async () => {
    const roomId = "44444444-4444-4444-8444-444444444444";
    const queries: SQL[] = [];
    const executeResponses: unknown[] = [
      [],
      [{
        room_id: roomId,
        owner_id: "55555555-5555-4555-8555-555555555555",
        kind: "private",
        last_processed_message_id: 100,
        suspended_at: null,
        lease_token: null,
        lease_expires_at: null,
        extraction_retry_after: null,
        historical_backfill_status: "pending",
        historical_backfill_cursor_message_id: 10,
        historical_backfill_target_message_id: 20,
        stenographer_prior_conversation_limit: 10,
        prior_context_floor_message_id: 0,
        has_agent: true,
        upper_bound_message_id: 20,
        replay_batch_status: null,
        replay_through_message_id: null,
      }],
      [{
        id: 11,
        created_at: "2026-07-27T11:00:00.000Z",
        role: "user",
        content: "An old decision.",
        fingerprint: null,
        transcript_origin: "main",
        originated_by: null,
        display_name: "Alice",
        handle: "alice",
        excluded_from_evidence: false,
      }],
      [{
        id: 9,
        created_at: "2026-07-27T10:59:00.000Z",
        role: "assistant",
        content: "Earlier context.",
        fingerprint: null,
        transcript_origin: "main",
        originated_by: null,
        display_name: "Ada",
        handle: "ada",
        excluded_from_evidence: false,
      }],
    ];
    const selectResponses: unknown[][] = [
      [],
      [],
      [],
    ];
    const insertedValues: unknown[] = [];
    const tx = {
      execute: async (query: SQL) => {
        queries.push(query);
        return executeResponses.shift() ?? [];
      },
      select: scriptedSelect(selectResponses),
      selectDistinct: scriptedSelect(selectResponses),
      insert: () => resultBuilder(
        () => [{
          id: "33333333-3333-4333-8333-333333333333",
          attempt_count: 1,
        }],
        (value) => insertedValues.push(value),
      ),
      update: () => ({
        set: () => ({ where: async () => [] }),
      }),
    };
    const db = {
      execute: async (query: SQL) => {
        queries.push(query);
        return [];
      },
      select: scriptedSelect([[{ room_id: roomId }]]),
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };

    const claimed = await claimNextHistoricalExtraction({
      db: db as never,
      now: NOW,
    });
    expect(claimed?.lane).toBe("historical");
    expect(claimed?.plan.fromMessageIdExclusive).toBe(10);
    expect(claimed?.plan.throughMessageIdInclusive).toBe(11);
    expect(claimed?.sourceRows[0]?.text).toBe("An old decision.");
    expect(claimed?.priorContextRows[0]?.text).toBe("Earlier context.");
    const stateQuery = queries.map(queryText).find((text) =>
      text.includes("stenographer_prior_conversation_limit")
    );
    expect(stateQuery).toContain("stenographer_prior_conversation_limit");
    expect(stateQuery).toContain("prior_batch.lane =");
    expect(insertedValues).toEqual([expect.objectContaining({
      roomId,
      extractorVersion: "m219-v1",
      lane: "historical",
    })]);
  });

  test("historical publish advances and completes only the historical cursor", async () => {
    const queries: SQL[] = [];
    const leaseToken = "11111111-1111-4111-8111-111111111111";
    const responses: unknown[] = [
      [],
      [{ lease_token: leaseToken, suspended_at: null, has_agent: true }],
      [],
      [],
      [],
    ];
    const tx = {
      execute: async (query: SQL) => {
        queries.push(query);
        return responses.shift() ?? [];
      },
    };
    const db = {
      transaction: async <T>(run: (executor: typeof tx) => Promise<T>) =>
        run(tx),
    };
    const claim: ExtractionClaim = {
      batchId: "33333333-3333-4333-8333-333333333333",
      roomId: "44444444-4444-4444-8444-444444444444",
      ownerId: "55555555-5555-4555-8555-555555555555",
      leaseToken,
      attemptCount: 1,
      lane: "historical",
      plan: {
        fromMessageIdExclusive: 10,
        throughMessageIdInclusive: 20,
        trigger: "silence",
        sourceRows: [],
        coveredMessageIds: [],
        conversationalMessageCount: 0,
        newestEligibleSourceAt: null,
      },
      sourceRows: [],
      priorContextRows: [],
      latestRollup: null,
      visibleEvents: [],
    };

    const result = await publishLegacyExtractionBeforeRecordCutoverForTests({
      claim,
      operations: [],
      modelId: "test:model",
      now: NOW,
      db: db as never,
    });

    expect(result).toEqual({ published: true, eventsWritten: 0 });
    const stateUpdate = queries.map(queryText).find((text) =>
      text.includes("WITH latest_rollup"),
    );
    expect(stateUpdate).toContain(
      "historical_backfill_cursor_message_id = GREATEST",
    );
    expect(stateUpdate).toContain("historical_backfill_status = CASE");
    expect(stateUpdate).not.toContain(
      "last_processed_message_id = GREATEST",
    );
  });
});

test("compaction discovery excludes ineligible Rooms before applying the candidate page", async () => {
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { compactionCandidateRooms } = await import("../../src/stenographer/repository");
  const statements: string[] = [];
  const mockDb = drizzle.mock({ logger: { logQuery: (query: string) => { statements.push(query); } } });
  // drizzle.mock has no client. It compiles/logs the real query before rejecting
  // execution, so this checks SQL without starting or connecting to a database.
  try { await compactionCandidateRooms(mockDb as never, NOW, 20); } catch { /* no mock client */ }
  expect(statements).toHaveLength(1);
  const query = statements[0]!;
  expect(query).toContain('"rooms"."kind" not in');
  expect(query).toContain('"room_journal_state"."suspended_at" is null');
  expect(query).toContain('exists (select');
  expect(query).toContain('"actors"."kind" =');
  expect(query.indexOf('"actors"."kind" =')).toBeLessThan(query.indexOf(" limit "));
});

import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  buildStenographerRecentFailuresQuery,
  buildStenographerRollingStatusQuery,
  queryStenographerAdminStatus,
} from "../../src/queries/stenographer-status";

const NOW = new Date("2026-07-27T12:00:00.000Z");
const SINCE = new Date("2026-07-26T12:00:00.000Z");

describe("stenographer status postgres-js parameters", () => {
  test("serializes every status-window timestamp", async () => {
    const queries: SQL[] = [];
    const results = [
      [
        {
          eligible_rooms: 0,
          caught_up_rooms: 0,
          accumulating_rooms: 0,
          processing_rooms: 0,
          retrying_rooms: 0,
          due_rooms: 0,
          stale_leases: 0,
          oldest_overdue_ms: 0,
          maximum_failure_count: 0,
          rebuilding_rooms: 1,
          historical_pending_rooms: 0,
          historical_completed_rooms: 0,
        },
      ],
      [
        {
          completed_extraction_batches: 2,
          extraction_batches_with_errors: 1,
          retried_extraction_batches: 1,
          zero_event_extraction_batches: 0,
          events_written: 3,
          extraction_duration_p50_ms: 125,
          extraction_duration_p95_ms: "250",
        },
      ],
      [
        {
          projected_body_code_points_p50: null,
          projected_body_code_points_p95: null,
          projected_body_code_points_max: null,
          awaiting_rooms: 0,
          processing_rooms: 0,
          retrying_rooms: 0,
          stale_leases: 0,
          oldest_overdue_ms: 0,
          maximum_failure_count: 0,
          last_completed_at: null,
        },
      ],
      [
        {
          stage: "compaction",
          error_code: "timeout",
          occurred_at: NOW,
          attempt_count: 2,
          model_id: "test-model",
        },
      ],
    ];
    const executeResultIndexes = [0, 2] as const;
    let selectCalls = 0;
    const db = {
      execute: async (query: SQL) => {
        queries.push(query);
        return results[executeResultIndexes[queries.length - 1]!];
      },
      select: ((() => {
        selectCalls += 1;
        if (selectCalls === 1) {
          return { from: async () => results[1] };
        }
        if (selectCalls === 2) {
          return {
            from: () => ({
              where: () => ({
                unionAll: () => ({
                  orderBy: () => ({ limit: async () => results[3] }),
                }),
              }),
            }),
          };
        }
        return { from: () => ({ where: () => ({}) }) };
      }) as unknown) as DirectDatabase["select"],
    } as unknown as DirectDatabase;

    const status = await queryStenographerAdminStatus(
      { now: NOW, since: SINCE, until: NOW },
      db,
    );

    expect(status.health).toBe("delayed");
    expect(status.current.rebuildingRooms).toBe(1);
    expect(status.last24h).toEqual({
      completedExtractionBatches: 2,
      extractionBatchesWithErrors: 1,
      retriedExtractionBatches: 1,
      zeroEventExtractionBatches: 0,
      eventsWritten: 3,
      extractionDurationP50Ms: 125,
      extractionDurationP95Ms: 250,
    });
    expect(status.recentFailures).toEqual([
      {
        stage: "compaction",
        errorCode: "timeout",
        occurredAt: NOW.toISOString(),
        attemptCount: 2,
        modelId: "test-model",
      },
    ]);
    expect(queries).toHaveLength(2);
    const parameterSets = queries.map(
      (query) => new PgDialect().sqlToQuery(query).params,
    );
    for (const params of parameterSets) {
      expect(params.some((param) => param instanceof Date)).toBe(false);
    }
    expect(parameterSets[0]).toContain(NOW.toISOString());
    expect(parameterSets[1]).toContain(NOW.toISOString());

    const offlineDb = drizzle.mock() as unknown as DirectDatabase;
    const rolling = buildStenographerRollingStatusQuery(
      { since: SINCE, until: NOW },
      offlineDb,
    ).toSQL();
    const rollingSql = rolling.sql.toLowerCase();
    expect(rollingSql).toContain('from "room_journal_batches"');
    expect(rollingSql).toContain('from "room_events"');
    expect(rolling.params.some((param) => param instanceof Date)).toBe(false);
    expect(rolling.params).toContain(SINCE.toISOString());
    expect(rolling.params).toContain(NOW.toISOString());

    const recentFailures = buildStenographerRecentFailuresQuery(
      { since: SINCE, until: NOW },
      offlineDb,
    ).toSQL();
    const recentFailuresSql = recentFailures.sql.toLowerCase();
    expect(recentFailuresSql).toContain('from "room_journal_batches"');
    expect(recentFailuresSql).toContain("union all");
    expect(recentFailuresSql).toContain('from "room_journal_state"');
    expect(recentFailuresSql).toContain('order by "last_error_at" desc');
    expect(recentFailures.params.some((param) => param instanceof Date)).toBe(
      false,
    );
    expect(recentFailures.params.filter((param) => param === SINCE.toISOString()))
      .toHaveLength(2);
    expect(recentFailures.params.filter((param) => param === NOW.toISOString()))
      .toHaveLength(2);
  });
});

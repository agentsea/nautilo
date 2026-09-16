import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { EMPTY_REFLECTION_SEMANTIC_LATENCY } from "@nautilo/types";
import type { DirectDatabase } from "../../src/config/direct-database";
import {
  classifyReflectionHealth,
  queryReflectionAdminStatus,
} from "../../src/queries/reflection-status";

const NOW = new Date("2026-08-14T12:00:00.000Z");
const SINCE = new Date("2026-08-13T12:00:00.000Z");

describe("Reflection admin health", () => {
  test("classifies delay and degradation from content-free durable signals", () => {
    expect(classifyReflectionHealth({
      deferred: 0, quarantined: 0, staleLeases: 0,
      maximumAttempts: 0, oldestOverdueMs: 0, currentParentViolations: 0,
    })).toBe("healthy");
    expect(classifyReflectionHealth({
      deferred: 1, quarantined: 0, staleLeases: 0,
      maximumAttempts: 1, oldestOverdueMs: 0, currentParentViolations: 0,
    })).toBe("delayed");
    expect(classifyReflectionHealth({
      deferred: 0, quarantined: 1, staleLeases: 0,
      maximumAttempts: 1, oldestOverdueMs: 0, currentParentViolations: 0,
    })).toBe("degraded");
    expect(classifyReflectionHealth({
      deferred: 0, quarantined: 0, staleLeases: 0,
      maximumAttempts: 1, oldestOverdueMs: 0, currentParentViolations: 1,
    })).toBe("degraded");
  });

  test("reports queue, projection, completion, and typed failure state", async () => {
    const queries: SQL[] = [];
    let selectedFailures = false;
    const db = {
      execute: async (query: SQL) => {
        queries.push(query);
        return [{
          total_records: 20, backlog: 4, due: 1, claimed: 1,
          checkpointed: 1, deferred: 1, complete: 15, quarantined: 1,
          recovery_eligible: 1, maximum_recovery_round: 2,
          stale_leases: 0, maximum_attempts: 2,
          current_parent_violations: 3,
          oldest_overdue_at: "2026-08-14T11:58:00.000Z",
          authority_projection: 2, search_projection: 3, organization: 15,
          available_records: 19, current_projections: 17,
          pending_projections: 1, incompatible_projections: 1,
          completed_work: 9, synthetic_parents_created: 2,
          last_completed_at: "2026-08-14T11:59:00.000Z",
          next_recovery_at: "2026-08-14T12:15:00.000Z",
        }];
      },
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: async () => {
                selectedFailures = true;
                return [{
                  stage: "organization",
                  failureCode: "invalid_model_output",
                  updatedAt: new Date("2026-08-14T11:59:30.000Z"),
                  attemptCount: 2,
                }];
              },
            }),
          }),
        }),
      }),
    } as unknown as DirectDatabase;

    const status = await queryReflectionAdminStatus(
      {
        now: NOW,
        since: SINCE,
        until: NOW,
        scheduler: {
          state: "disabled",
          pauseReason: null,
          recoveryIntervalMs: 15_000,
          nextEligiblePollAt: null,
          lastPoll: null,
          window: { polls: 0, admitted: 0, completed: 0, created: 0 },
          backlog: { size: 0, oldestAgeMs: 0 },
          latency: EMPTY_REFLECTION_SEMANTIC_LATENCY,
          amplification: "normal",
        },
      },
      db,
    );
    expect(status.health).toBe("degraded");
    expect(status.current).toMatchObject({
      backlog: 4,
      deferred: 1,
      recoveryEligible: 1,
      maximumRecoveryRound: 2,
      oldestOverdueMs: 120_000,
      currentParentViolations: 3,
    });
    expect(status.scheduler).toMatchObject({
      state: "disabled",
      backlog: { size: 4, oldestAgeMs: 120_000 },
    });
    expect(status.nextRecoveryAt).toBe("2026-08-14T12:15:00.000Z");
    expect(status.projections).toEqual({
      availableRecords: 19, current: 17, pending: 1, incompatible: 1,
    });
    expect(status.last24h).toEqual({ completedWork: 9, syntheticParentsCreated: 2 });
    expect(status.currentFailures[0]).toMatchObject({
      stage: "organization", errorCode: "invalid_model_output", attemptCount: 2,
    });
    expect(queries).toHaveLength(1);
    expect(selectedFailures).toBe(true);
    const params = queries.flatMap((query) => new PgDialect().sqlToQuery(query).params);
    expect(params.some((param) => param instanceof Date)).toBe(false);
    expect(params).toContain(NOW.toISOString());
    expect(params).toContain(SINCE.toISOString());
    const queryText = new PgDialect().sqlToQuery(queries[0]!).sql;
    expect(queryText.match(/record\.lifecycle = 'current'/gu)).toHaveLength(4);
  });
});

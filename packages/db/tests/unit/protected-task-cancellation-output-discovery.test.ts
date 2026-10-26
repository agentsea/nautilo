import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { DirectDatabase } from "../../src/config/direct-database";
import {
  listProtectedTaskCancellationOutputCandidates,
} from "../../src/queries/protected-task-cancellation-output";

const throughTime = new Date("2026-10-12T09:00:00.000Z");
const terminalAt = new Date("2026-10-12T08:00:00.000Z");
const taskId = "10000000-0000-4000-8000-000000000001";
const runIds = [
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  "20000000-0000-4000-8000-000000000003",
] as const;

type DiscoveryRow = Readonly<{
  taskId: string;
  taskRunId: string;
  jobId: string | null;
  terminalAt: Date;
  bindingRevision: number | null;
  resultRevision: number;
}>;

function discoveryHarness(rows: readonly DiscoveryRow[]) {
  let condition: SQL | undefined;
  let requestedLimit: number | undefined;
  const joins: unknown[] = [];
  const query = {
    innerJoin: (table: unknown, _on: unknown) => {
      joins.push(table);
      return query;
    },
    leftJoin: (table: unknown, _on: unknown) => {
      joins.push(table);
      return query;
    },
    where: (value: SQL) => {
      condition = value;
      return query;
    },
    orderBy: (..._values: unknown[]) => query,
    limit: async (value: number) => {
      requestedLimit = value;
      return rows.slice(0, value);
    },
  };
  const db = {
    select: (_projection: unknown) => ({
      from: (_table: unknown) => query,
    }),
  } as unknown as DirectDatabase;
  return {
    db,
    evidence: () => {
      if (!condition) throw new Error("Expected discovery predicate");
      return {
        joins,
        requestedLimit,
        compiled: new PgDialect().sqlToQuery(condition),
      };
    },
  };
}

describe("protected Task cancellation output discovery", () => {
  test("pages a stable same-time keyset without starving a Jobless run", async () => {
    const first = discoveryHarness([
      {
        taskId,
        taskRunId: runIds[0],
        jobId: null,
        terminalAt,
        bindingRevision: null,
        resultRevision: 0,
      },
      {
        taskId,
        taskRunId: runIds[1],
        jobId: "30000000-0000-4000-8000-000000000001",
        terminalAt,
        bindingRevision: 2,
        resultRevision: 2,
      },
      {
        taskId,
        taskRunId: runIds[2],
        jobId: "30000000-0000-4000-8000-000000000002",
        terminalAt,
        bindingRevision: 1,
        resultRevision: 0,
      },
    ]);
    const firstPage = await listProtectedTaskCancellationOutputCandidates(
      first.db,
      { limit: 2, throughTime },
    );
    expect(first.evidence().requestedLimit).toBe(3);
    expect(firstPage.candidates).toEqual([
      {
        taskId,
        taskRunId: runIds[0],
        jobId: null,
        terminalAt,
        bindingState: "missing",
        resultState: "unmapped",
      },
      {
        taskId,
        taskRunId: runIds[1],
        jobId: "30000000-0000-4000-8000-000000000001",
        terminalAt,
        bindingState: "cancellation",
        resultState: "mapped",
      },
    ]);
    expect(firstPage.next).toEqual({
      throughTime,
      terminalAt,
      taskRunId: runIds[1],
    });

    const second = discoveryHarness([{
      taskId,
      taskRunId: runIds[2],
      jobId: "30000000-0000-4000-8000-000000000002",
      terminalAt,
      bindingRevision: 1,
      resultRevision: 0,
    }]);
    const secondPage = await listProtectedTaskCancellationOutputCandidates(
      second.db,
      { limit: 2, throughTime, cursor: firstPage.next! },
    );
    expect(secondPage.candidates.map((candidate) => candidate.taskRunId))
      .toEqual([runIds[2]]);
    expect(secondPage.next).toBeNull();
    const secondSql = second.evidence().compiled;
    expect(secondSql.sql).toContain('"task_runs"."completed_at" >');
    expect(secondSql.sql).toContain('"task_runs"."id" >');
    expect(secondSql.params).toContain(runIds[1]);
  });

  test("filters Plain, completion winners, delivered and malformed bindings in SQL", async () => {
    const fixture = discoveryHarness([]);
    expect(await listProtectedTaskCancellationOutputCandidates(fixture.db, {
      limit: 8,
      throughTime,
    })).toEqual({ candidates: [], next: null });
    const { compiled, joins, requestedLimit } = fixture.evidence();
    expect(requestedLimit).toBe(9);
    expect(joins).toHaveLength(2);
    for (const expected of [
      "cancelled",
      "protected",
      "dual",
      "ordinary",
      "unmapped",
      "verified",
      "Task cancelled",
      0,
      1,
      2,
      throughTime.toISOString(),
    ]) expect(compiled.params).toContain(expected);
    expect(compiled.sql).toContain('"task_runs"."completed_at" <=');
    expect(compiled.sql).toContain('"tasks"."cancelled_at"');
    expect(compiled.sql).toContain(
      '"protected_task_run_output_bindings"."completed_at" is null',
    );
    expect(compiled.sql).toContain("task-run-result:");
    expect(compiled.sql).toContain("task-run-cancelled-result:");
    expect(compiled.sql).toContain("result_crypto_mapping_state");
    expect(compiled.sql).toContain('"result_attached_at" is null');
  });

  test("rejects a changed snapshot cursor and malformed limits", async () => {
    const fixture = discoveryHarness([]);
    expect(listProtectedTaskCancellationOutputCandidates(fixture.db, {
      limit: -1,
      throughTime,
    })).rejects.toThrow("discovery page is malformed");
    expect(listProtectedTaskCancellationOutputCandidates(fixture.db, {
      limit: Number.MAX_SAFE_INTEGER,
      throughTime,
    })).rejects.toThrow("discovery page is malformed");
    expect(listProtectedTaskCancellationOutputCandidates(fixture.db, {
      limit: 1,
      throughTime,
      cursor: {
        throughTime: new Date(throughTime.getTime() + 1),
        terminalAt,
        taskRunId: runIds[0],
      },
    })).rejects.toThrow("discovery cursor is malformed");
    expect(await listProtectedTaskCancellationOutputCandidates(fixture.db, {
      limit: 0,
      throughTime,
    })).toEqual({ candidates: [], next: null });
  });
});

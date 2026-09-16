import { describe, expect, test } from "bun:test";
import {
  POSTGRES_INIT_COMPLETE_MARKER,
  waitForFinalPostgres,
} from "../../scripts/postgres-integration-readiness";

describe("disposable Postgres integration readiness", () => {
  test("does not accept the temporary bootstrap server as final readiness", async () => {
    const snapshots = [
      {
        logs: "database system is ready to accept connections",
        queryable: true,
        status: "healthy",
      },
      {
        logs:
          `received fast shutdown request\n${POSTGRES_INIT_COMPLETE_MARKER}`,
        queryable: false,
        status: "starting",
      },
      {
        logs: POSTGRES_INIT_COMPLETE_MARKER,
        queryable: false,
        status: "healthy",
      },
      {
        logs:
          `${POSTGRES_INIT_COMPLETE_MARKER}\n`
          + "database system is ready to accept connections",
        queryable: true,
        status: "healthy",
      },
    ] as const;
    let cycle = 0;
    let queryAttempts = 0;

    await waitForFinalPostgres({
      canQuery: () => {
        queryAttempts += 1;
        return snapshots[cycle]!.queryable;
      },
      inspectStatus: () => snapshots[cycle]!.status,
      now: () => cycle * 100,
      readLogs: () => snapshots[cycle]!.logs,
      sleep: async () => {
        cycle += 1;
      },
    }, {
      pollIntervalMs: 0,
      timeoutMs: 1_000,
    });

    expect(cycle).toBe(3);
    expect(queryAttempts).toBe(2);
  });

  test("fails immediately when the disposable container exits", async () => {
    expect(waitForFinalPostgres({
      canQuery: () => false,
      inspectStatus: () => "exited",
      now: () => 0,
      readLogs: () => "",
      sleep: async () => {},
    })).rejects.toThrow(
      "disposable lattice Postgres exited during bootstrap",
    );
  });
});

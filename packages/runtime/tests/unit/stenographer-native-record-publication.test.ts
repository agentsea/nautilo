import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import {
  PostgresSemanticWorkStore,
  createHmacRecordSemanticCommitmentPort,
  verifyRecordProductPostgresHandle,
} from "@nautilo/reflection-bridge/server";

import {
  createRecordProductPostgresConnection,
} from "../../src/stenographer/native-record-publication";

describe("native Stenographer Record PostgreSQL transport", () => {
  test("serializes Date parameters before the raw postgres-js boundary", async () => {
    const calls: unknown[][] = [];
    const db = {
      $client: {
        unsafe: (_statement: string, parameters: unknown[]) => {
          calls.push(parameters);
          return Promise.resolve([]);
        },
      },
    } as unknown as DirectDatabase;
    const connection = createRecordProductPostgresConnection(db);
    const timestamp = new Date("2026-08-14T12:00:00.000Z");

    await connection.query("SELECT $1::timestamptz", [timestamp]);

    expect(calls).toEqual([[timestamp.toISOString()]]);
  });

  test("normalizes postgres-js timestamp strings across the production adapter", async () => {
    const db = {
      $client: {
        unsafe: (statement: string) => {
          if (statement.includes("current_user")) {
            return Promise.resolve([{
              current_role: "nautilo",
              session_role: "nautilo",
            }]);
          }
          if (statement.includes("count(*) filter")) {
            return Promise.resolve([{
              backlog: "893",
              ready: "125",
              claimed: "1",
              quarantined: "62",
              maximum_attempts: 8,
              oldest_due_at: "2026-08-14 09:00:00+00",
            }]);
          }
          throw new Error("unexpected query");
        },
      },
    } as unknown as DirectDatabase;
    const handle = await verifyRecordProductPostgresHandle(
      createRecordProductPostgresConnection(db),
    );
    const store = new PostgresSemanticWorkStore({
      handle,
      commitments: createHmacRecordSemanticCommitmentPort(new Uint8Array(32).fill(7)),
    });

    expect(await store.health()).toEqual({
      backlog: 893,
      ready: 125,
      claimed: 1,
      quarantined: 62,
      maximumAttempts: 8,
      oldestDueAt: new Date("2026-08-14T09:00:00.000Z"),
    });
  });
});

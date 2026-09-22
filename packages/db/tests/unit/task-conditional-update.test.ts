import { describe, expect, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import type { DirectDatabase } from "../../src/config/direct-database";
import { updateTaskIfCurrent } from "../../src/queries/tasks";

describe("conditional Task update", () => {
  test("fences owner, lifecycle status, timestamp, and content revision", async () => {
    let whereSql: Parameters<PgDialect["sqlToQuery"]>[0] | undefined;
    const returned = { id: "task" };
    const db = {
      update: () => ({
        set: () => ({
          where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
            whereSql = condition;
            return { returning: async () => [returned] };
          },
        }),
      }),
    } as unknown as DirectDatabase;
    const at = new Date("2026-09-22T12:00:00.000Z");
    const result = await updateTaskIfCurrent(db, {
      id: "10000000-0000-4000-8000-000000000001",
      ownerId: "20000000-0000-4000-8000-000000000002",
      expectedStatus: "paused",
      expectedUpdatedAt: at,
      expectedContentRevision: 7,
    }, { timezone: "UTC" });
    expect(result?.id).toBe(returned.id);
    const query = new PgDialect().sqlToQuery(whereSql!);
    for (const column of ["id", "owner_id", "status", "updated_at", "content_revision"]) {
      expect(query.sql).toContain(`"tasks"."${column}" =`);
    }
    expect(query.params).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "paused",
      at.toISOString(),
      7,
    ]);
  });
});

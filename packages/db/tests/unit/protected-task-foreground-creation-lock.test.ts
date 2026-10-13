import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { lockProtectedTaskForegroundCreationIdentity } from
  "../../src/queries/protected-task-foreground-creation-lock";

const TASK_ID = "8f46dca1-2ab3-8c4d-9e5f-1029384756ab";

function fixture(rows: readonly Readonly<{ taskId: string }>[] = []) {
  const calls: string[] = [];
  let lockStatement: SQL | null = null;
  const transaction = {
    execute: (statement: SQL) => {
      calls.push("advisory");
      lockStatement = statement;
      return Promise.resolve([]);
    },
    select: () => {
      calls.push("select");
      return {
        from: () => ({
          where: () => ({
            for: (mode: string) => {
              calls.push(`row:${mode}`);
              return {
                limit: (limit: number) => {
                  calls.push(`limit:${limit}`);
                  return Promise.resolve(rows);
                },
              };
            },
          }),
        }),
      };
    },
  };
  return {
    calls,
    transaction,
    renderLock() {
      if (lockStatement === null) throw new Error("Creation lock was not acquired");
      return new PgDialect().sqlToQuery(lockStatement);
    },
  };
}

describe("protected Task foreground creation identity lock", () => {
  test("takes the namespaced advisory lock before the exact Task row lock", async () => {
    const value = fixture();
    expect(await lockProtectedTaskForegroundCreationIdentity(
      value.transaction as never,
      TASK_ID,
    )).toEqual({ status: "absent" });
    expect(value.calls).toEqual([
      "advisory",
      "select",
      "row:update",
      "limit:2",
    ]);
    const query = value.renderLock();
    expect(query.sql.toLowerCase()).toContain(
      "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
    );
    expect(query.params).toEqual([
      `protected-task-foreground-creation:${TASK_ID}`,
    ]);
  });

  test("reports the exact committed identity for replay adoption", async () => {
    const value = fixture([{ taskId: TASK_ID }]);
    expect(await lockProtectedTaskForegroundCreationIdentity(
      value.transaction as never,
      TASK_ID,
    )).toEqual({ status: "existing", taskId: TASK_ID });
  });

  test("rejects malformed identities before entering the transaction", async () => {
    const value = fixture();
    await Promise.resolve(expect(lockProtectedTaskForegroundCreationIdentity(
      value.transaction as never,
      TASK_ID.toUpperCase(),
    )).rejects.toThrow("creation identity is invalid"));
    expect(value.calls).toEqual([]);
  });

  test("rejects an impossible non-exact or duplicate row result", async () => {
    const wrong = fixture([{ taskId: "11111111-1111-1111-1111-111111111111" }]);
    await Promise.resolve(expect(lockProtectedTaskForegroundCreationIdentity(
      wrong.transaction as never,
      TASK_ID,
    )).rejects.toThrow("identity is not unique"));
    const duplicate = fixture([{ taskId: TASK_ID }, { taskId: TASK_ID }]);
    await Promise.resolve(expect(lockProtectedTaskForegroundCreationIdentity(
      duplicate.transaction as never,
      TASK_ID,
    )).rejects.toThrow("identity is not unique"));
  });
});

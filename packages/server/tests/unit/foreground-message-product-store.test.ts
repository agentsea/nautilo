import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { createForegroundMessageProductStore } from
  "../../src/routes/foreground-message-product-store.ts";

function fixture(role = "nautilo_agent") {
  const observed: string[][] = [];
  let poolQueries = 0;
  const pool = Object.assign(() => undefined, {
    options: { parsers: {}, serializers: {} },
    unsafe: async () => { poolQueries += 1; throw new Error("unscoped pool query"); },
    begin: async (...args: unknown[]) => {
      const run = args.at(-1) as (tx: unknown) => Promise<unknown>;
      let scope: string[] | null = null;
      return run({
        unsafe: async (statement: string, parameters: unknown[] = []) => {
          if (statement.includes("set_config")) {
            scope = parameters.map(String);
            return [];
          }
          expect(scope).not.toBeNull();
          observed.push([...scope!]);
          return statement.includes("current_user")
            ? [{ current_user: role, session_user: role }]
            : [];
        },
      });
    },
  });
  // Real Drizzle SQL generation; the fixture has no relational schema/pool.
  // This cast is confined to that hermetic transport boundary.
  const database = Object.assign(drizzle(pool as never), {
    end: () => Promise.resolve(),
  }) as unknown as Parameters<
    typeof createForegroundMessageProductStore
  >[1];
  return { database, observed, poolQueries: () => poolQueries };
}

describe("foreground Message repair product connection", () => {
  test("every repair query uses the authenticated Agent and causal Human in one transaction", async () => {
    const f = fixture();
    const context = {
      userId: "00000000-0000-4000-8000-000000000001",
      agentId: "00000000-0000-4000-8000-000000000002",
    };
    const store = await createForegroundMessageProductStore(context, f.database);
    expect(await store.getRevision(42, 0)).toBeNull();
    expect(f.observed.length).toBeGreaterThan(1);
    expect(f.observed.every((scope) =>
      scope[0] === context.userId && scope[1] === context.agentId
    )).toBe(true);
    expect(f.poolQueries()).toBe(0);
  });

  test("an ordinary server handle cannot silently impersonate Agent repair", async () => {
    const f = fixture("nautilo");
    const store = await createForegroundMessageProductStore({
      userId: "00000000-0000-4000-8000-000000000001",
      agentId: "00000000-0000-4000-8000-000000000002",
    }, f.database);
    expect(store.allocateExistingRepresentation({
      publisher: { kind: "foreground_runtime", agentId: "00000000-0000-4000-8000-000000000002" },
      sessionId: "00000000-0000-4000-8000-000000000003",
      messageId: 42,
      revision: 0,
      operationId: "repair-test",
      expectedNamespaceId: "00000000-0000-4000-8000-000000000004",
      expectedAuthorRole: "user",
      expectedAuthorHumanTurnId: null,
      expectedSessionAgentId: null,
      requestDigest: new Uint8Array(32),
      repairIdentityDigest: new Uint8Array(32),
    })).rejects.toThrow("requires the nautilo_agent role");
  });
});

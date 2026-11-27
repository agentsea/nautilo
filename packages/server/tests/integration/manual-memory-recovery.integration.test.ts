import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDirectDb, eq, inArray, memoryRecoveryRuns } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { createManualMemoryRecovery } from "../../src/lib/manual-memory-recovery";

let db: ReturnType<typeof createDirectDb>;
beforeAll(() => { bootstrapTestDbInstance(); db = createDirectDb(4); });
afterAll(async () => { await db?.end(); });

test("a failed lane rolls back its changes, other lanes finish, and concurrent or restarted requests return one receipt", async () => {
  const input = { requestId: randomUUID(), authorizedBy: randomUUID(), now: new Date() };
  const rollbackMarker = randomUUID();
  let reflectionAvailable = false;
  const calls = { stenographer: 0, memory: 0, reflection: 0 };
  const createService = () => createManualMemoryRecovery({
    db: () => db, assertAvailable: async () => {}, onError: () => {},
    recover: {
      stenographer: async ({ observedThrough }) => {
        expect(observedThrough.toISOString()).toBe(input.now.toISOString());
        calls.stenographer++;
        return { state: "assessed", queued: 2, held: 0 };
      },
      reflection: async ({ executor }) => {
        calls.reflection++;
        if (reflectionAvailable) return { state: "assessed", queued: 3, held: 0 };
        const insert = db.insert(memoryRecoveryRuns).values({
          id: rollbackMarker, authorizedBy: input.authorizedBy, observedThrough: input.now,
        }).toSQL();
        await executor.query(insert.sql, insert.params);
        throw new Error("injected admission failure");
      },
      memory: async () => { calls.memory++; return { state: "assessed", queued: 1, held: 0 }; },
    },
  });
  try {
    const [first, duplicate] = await Promise.all([createService().request(input), createService().request(input)]);
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({ stenographer: { state: "assessed", queued: 2, held: 0 },
      reflection: { state: "unavailable" }, memory: { state: "assessed", queued: 1, held: 0 } });
    reflectionAvailable = true;
    const resumed = await createService().request({ ...input, now: new Date(input.now.getTime() + 1000) });
    expect(resumed).toEqual({ ...first, reflection: { state: "assessed", queued: 3, held: 0 } });
    expect(await createService().request(input)).toEqual(resumed);
    expect(calls.memory).toBe(1);
    expect(calls.stenographer).toBe(1);
    expect(await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, rollbackMarker))).toHaveLength(0);
  } finally {
    await db.delete(memoryRecoveryRuns).where(inArray(memoryRecoveryRuns.id, [input.requestId, rollbackMarker]));
  }
});

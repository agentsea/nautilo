import { desc, eq, createPostgresJsCanonicalBridgeConnection, memoryRecoveryRuns, type DirectDatabase, type PostgresJsBridgeExecutor } from "@nautilo/db";
import type { MemoryRecoveryLaneResult, MemoryRecoveryRun } from "@nautilo/types";

const processors = ["stenographer", "reflection", "memory"] as const;
type Processor = typeof processors[number];
type RunRow = typeof memoryRecoveryRuns.$inferSelect;
type Transaction = Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];
type Recover = (input: {
  db: Transaction; executor: PostgresJsBridgeExecutor; authorizedBy: string; now: Date; observedThrough: Date;
}) => Promise<MemoryRecoveryLaneResult>;

function report(row: RunRow): MemoryRecoveryRun {
  return { requestId: row.id, observedThrough: row.observedThrough.toISOString(),
    stenographer: row.stenographer, reflection: row.reflection, memory: row.memory };
}

export function createManualMemoryRecovery(options: {
  db: () => DirectDatabase;
  assertAvailable(): Promise<void>;
  recover: Record<Processor, Recover>;
  onError(processor: Processor): void;
}) {
  return {
    async latest(): Promise<MemoryRecoveryRun | null> {
      const [row] = await options.db().select().from(memoryRecoveryRuns)
        .orderBy(desc(memoryRecoveryRuns.observedThrough), desc(memoryRecoveryRuns.id)).limit(1);
      return row ? report(row) : null;
    },
    async request(input: { requestId: string; authorizedBy: string; now: Date }): Promise<MemoryRecoveryRun> {
      await options.assertAvailable();
      const db = options.db();
      await db.insert(memoryRecoveryRuns).values({
        id: input.requestId, authorizedBy: input.authorizedBy, observedThrough: input.now,
      }).onConflictDoNothing({ target: memoryRecoveryRuns.id });
      const connection = createPostgresJsCanonicalBridgeConnection(db);
      for (const processor of processors) {
        await connection.transaction(async (tx, executor) => {
          const [row] = await tx.select().from(memoryRecoveryRuns)
            .where(eq(memoryRecoveryRuns.id, input.requestId)).for("update");
          if (!row) throw new Error("Recovery request unavailable");
          if (row[processor] !== null && row[processor].state !== "unavailable") return;
          // Roll back this lane if admission fails. Commit its error receipt on
          // the outer transaction while still holding the request lock.
          let result: MemoryRecoveryLaneResult;
          try {
            result = await tx.transaction(savepoint => options.recover[processor]({
              db: savepoint, executor, authorizedBy: row.authorizedBy,
              now: new Date(), observedThrough: row.observedThrough,
            }));
          } catch {
            options.onError(processor);
            result = { state: "unavailable" };
          }
          await tx.update(memoryRecoveryRuns).set({ [processor]: result }).where(eq(memoryRecoveryRuns.id, row.id));
        });
      }
      const [row] = await db.select().from(memoryRecoveryRuns).where(eq(memoryRecoveryRuns.id, input.requestId));
      if (!row) throw new Error("Recovery request unavailable");
      return report(row);
    },
  };
}

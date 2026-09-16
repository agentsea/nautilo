import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDirectDb } from "../../src/config/direct-database";
import { queryMemoryReviewStatus, retryFailedMemoryReviews } from "../../src/queries/memory-review-status";
import { sql, eq } from "drizzle-orm";
import { memoryReviewTurns } from "../../src/schema/memory-review";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;
beforeAll(() => {
  bootstrapTestDbInstance();
  // Use an already-migrated instance; fixtures below live only in temporary tables.
  db = createDirectDb();
});
afterAll(async () => { await db?.end(); });

test("Postgres resolves variadic status projection parameters and returns the public contract", async () => {
  const now = new Date("2026-09-05T12:00:00.000Z");
  const since = new Date("2026-09-04T12:00:00.000Z");
  for (const enabled of [true, false]) {
    const status = await queryMemoryReviewStatus(db, {
      now, since, until: now, enabled, threshold: 10,
      model: { id: null, provider: null, source: "conductor", available: false },
      encryption: { mode: "ordinary", available: true },
    });
    expect(status.generatedAt).toBe(now.toISOString());
    expect(status.window).toEqual({ since: since.toISOString(), until: now.toISOString() });
    expect(status.enabled).toBe(enabled);
    expect(status.health).toBe(enabled ? "unavailable" : "paused");
    expect(status.model.id).toBeNull();
  }
});


test("failed work with a cleared lease remains safely retryable without touching other work", async () => {
  await db.transaction(async (tx) => {
    // Exact production column types, with session-local tables so retry cannot
    // touch existing work on a populated QA instance. Commit drops both tables.
    await tx.execute(sql`CREATE TEMP TABLE memory_review_turns (LIKE public.memory_review_turns INCLUDING DEFAULTS) ON COMMIT DROP`);
    await tx.execute(sql`CREATE TEMP TABLE memory_review_receipts (LIKE public.memory_review_receipts INCLUDING DEFAULTS) ON COMMIT DROP`);
    const now = new Date();
    const id = crypto.randomUUID();
    await tx.insert(memoryReviewTurns).values({
      id, sessionId: crypto.randomUUID(), agentId: crypto.randomUUID(), roomId: crypto.randomUUID(),
      ownerId: crypto.randomUUID(), actorId: crypto.randomUUID(), accessScope: "namespace",
      threadId: "isolated-retry-regression", checkpointThreadId: "isolated-retry-regression", turnId: "failed-turn",
      sourceIds: [1], firstMessageId: 1, hasHuman: 10, state: "completed", completedAt: now,
      attemptId: crypto.randomUUID(), leaseUntil: null, failureCode: "provider_failed", failurePhase: "model",
      retryAt: new Date(now.getTime() - 1),
    });
    const input = {
      now, since: now, until: now, enabled: false, threshold: 10,
      model: { id: null, provider: null, source: "conductor" as const, available: false },
      encryption: { mode: "ordinary" as const, available: true },
    };
    const failed = await queryMemoryReviewStatus(tx, input);
    expect(failed.current.processing).toBe(0);
    expect(failed.current.safelyRetryable).toBe(1);
    expect(await retryFailedMemoryReviews(tx, now)).toEqual({ requested: 1 });
    expect(await retryFailedMemoryReviews(tx, now)).toEqual({ requested: 0 });
    expect((await queryMemoryReviewStatus(tx, input)).current.safelyRetryable).toBe(0);
    await tx.update(memoryReviewTurns).set({ failureCode: "provider_failed", leaseUntil: new Date(now.getTime() + 1) }).where(eq(memoryReviewTurns.id, id));
    expect((await queryMemoryReviewStatus(tx, input)).current.safelyRetryable).toBe(0);
    expect(await retryFailedMemoryReviews(tx, now)).toEqual({ requested: 0 });
    await tx.update(memoryReviewTurns).set({ failureCode: "publication_uncertain", leaseUntil: null }).where(eq(memoryReviewTurns.id, id));
    expect((await queryMemoryReviewStatus(tx, input)).current.safelyRetryable).toBe(0);
    expect(await retryFailedMemoryReviews(tx, now)).toEqual({ requested: 0 });
  });
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { __resetSharedDirectDbForTests, ensureDatabase, eq, getSharedDirectDb,
  moderationActions, moderationSubjects, sql, users } from "@nautilo/db";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import { recoverModerationEffects } from "@nautilo/trust";
import { createModerationAuditSink, createModerationEffectRecovery, createPostgresModerationRecoveryStore, type ModerationRecoveryCursor } from "../../src/lib/moderation-recovery";
import { readSecurityAuditLog } from "../../src/lib/security-audit-log";

const dir = mkdtempSync(join(tmpdir(), "moderation-recovery-"));
beforeAll(async () => {
  bootstrapTestDbInstance(); process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  await ensureDatabase();
}, 120_000);
afterAll(async () => { await __resetSharedDirectDbForTests(); rmSync(dir, { recursive: true, force: true }); });

async function receipt(createdAt?: string) {
  const db = getSharedDirectDb();
  const [user] = await db.insert(users).values({ name: "Recovery fixture", externalId: randomUUID() }).returning();
  const [subject] = await db.insert(moderationSubjects).values({ userId: user!.id }).returning();
  const operationId = randomUUID();
  await db.insert(moderationActions).values({ operationId, requestDigest: "0".repeat(64),
    requesterUserId: null, subjectId: subject!.id, roomId: null, action: "kick",
    reason: "private fixture reason", privateNote: "private fixture note",
    ...(createdAt === undefined ? {} : { createdAt: sql`${createdAt}::timestamptz` }),
  });
  return operationId;
}

async function until(done: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (done()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Recovery did not finish");
}

describe("moderation durable recovery with the production audit sink", () => {
  test("lost checkpoint after fsync is recovered once by a newly started worker", async () => {
    const operationId = await receipt();
    const path = join(dir, "audit.log");
    const sink = createModerationAuditSink(path);
    const failed = await recoverModerationEffects(operationId, {
      appendAudit: async event => { await sink(event); throw new Error("process lost before database checkpoint"); },
    });
    expect(failed).toEqual({ auditRecorded: false, converged: false });
    expect(readSecurityAuditLog(path, { correlationId: operationId }).events).toHaveLength(1);
    // Restrict the lifecycle fixture to this test's one receipt so
    // unrelated scratch history cannot become part of this recovery fixture.
    const store = createPostgresModerationRecoveryStore();
    const db = getSharedDirectDb();
    const [cursor] = await db.select({ createdAt: sql<string>`${moderationActions.createdAt}::text`, operationId: moderationActions.operationId })
      .from(moderationActions).where(eq(moderationActions.operationId, operationId));
    let finished = false;
    const recovery = createModerationEffectRecovery({
      store: { snapshotMaximum: async () => cursor!, nextPending: async after => after === null ? cursor! : null },
      effects: { appendAudit: sink },
      deliver: async (id, effects) => { const result = await recoverModerationEffects(id, effects); finished = true; return result; },
    });
    recovery.start(); await until(() => finished); await recovery.stop();
    const [row] = await db.select().from(moderationActions).where(eq(moderationActions.operationId, operationId));
    expect(row?.auditRecordedAt).not.toBeNull();
    expect(row?.convergedAt).toBeNull();
    expect(readSecurityAuditLog(path, { correlationId: operationId }).events).toHaveLength(1);
    expect(await store.snapshotMaximum()).not.toBeNull();
  });

  test("keyset traversal keeps microsecond precision, tied timestamps, and pending convergence", async () => {
    // Future timestamps isolate this keyset from existing scratch history.
    const low = await receipt("2100-01-01 00:00:00.000122+00");
    const tied = [await receipt("2100-01-01 00:00:00.000123+00"), await receipt("2100-01-01 00:00:00.000123+00")].sort();
    const high = await receipt("2100-01-01 00:00:00.000124+00");
    const store = createPostgresModerationRecoveryStore();
    let cursor: ModerationRecoveryCursor = { createdAt: "2100-01-01 00:00:00.000122+00", operationId: low };
    const maximum = { createdAt: "2100-01-01 00:00:00.000124+00", operationId: high };
    const traversed: string[] = [];
    while (true) {
      const next = await store.nextPending(cursor, maximum);
      if (next === null) break;
      traversed.push(next.operationId); cursor = next;
    }
    expect(traversed).toEqual([...tied, high]);
    const path = join(dir, "keyset-audit.log");
    await recoverModerationEffects(tied[0]!, { appendAudit: createModerationAuditSink(path), converge: async () => "pending" });
    expect((await store.nextPending({ createdAt: "2100-01-01 00:00:00.000122+00", operationId: low }, maximum))?.operationId).toBe(tied[0]);
    await recoverModerationEffects(tied[0]!, { appendAudit: createModerationAuditSink(path), converge: async () => {} });
    expect((await store.nextPending({ createdAt: "2100-01-01 00:00:00.000122+00", operationId: low }, maximum))?.operationId).toBe(tied[1]);
    // Finish only our fixture receipts, leaving no new pending startup work.
    for (const id of [low, tied[1]!, high]) await recoverModerationEffects(id, {
      appendAudit: createModerationAuditSink(path), converge: async () => {},
    });
  });
});

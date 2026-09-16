import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  compareAndSwapEncryptionTransitionPolicy,
  createDirectDb,
  encryptionTransitionBoundaryHealth,
  ensureDatabase,
  getEncryptionTransitionPolicy,
  readStrictShadowBoundaryHealth,
  recordStrictShadowBoundaryHealth,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

describe("M302 durable Strict Shadow policy and boundary health", () => {
  let db: ReturnType<typeof createDirectDb> | undefined;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    db = createDirectDb(1);
  });

  afterAll(async () => {
    await db?.end();
  });

  test("survives a new DB handle and keeps one latest signal per boundary", async () => {
    if (db === undefined) throw new Error("M302 integration DB is unavailable");
    const original = await getEncryptionTransitionPolicy(db);
    let active = original;
    try {
      active = await compareAndSwapEncryptionTransitionPolicy(db, {
        expectedRevision: original.revision,
        targetMode: "shadow_encryption",
        targetShadowBehavior: "strict",
        now: new Date("2026-09-01T12:00:00.000Z"),
      });
      expect(active).toMatchObject({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: original.revision + 1,
      });

      await db.end();
      db = createDirectDb(1);
      expect(await getEncryptionTransitionPolicy(db)).toMatchObject({
        mode: "shadow_encryption",
        shadowBehavior: "strict",
        revision: active.revision,
      });

      const common = {
        policyRevision: active.revision,
        boundaryId: "conversation.write.foreground",
        family: "message",
        operation: "write",
        actorClass: "human" as const,
      };
      await recordStrictShadowBoundaryHealth(db, {
        ...common,
        state: "waiting_for_authority",
        reason: "domain_authority_converging",
        retryable: true,
        observedAt: new Date("2026-09-01T12:01:00.000Z"),
      });
      await recordStrictShadowBoundaryHealth(db, {
        ...common,
        state: "verified",
        reason: "none",
        retryable: false,
        observedAt: new Date("2026-09-01T12:02:00.000Z"),
      });
      // A slower earlier observation must increase the bounded count without
      // rolling current health backward after the verified result arrived.
      await recordStrictShadowBoundaryHealth(db, {
        ...common,
        state: "failed",
        reason: "publication_failure",
        retryable: false,
        observedAt: new Date("2026-09-01T12:01:30.000Z"),
      });

      expect(await readStrictShadowBoundaryHealth(db, active.revision)).toEqual([
        expect.objectContaining({
          ...common,
          state: "verified",
          reason: "none",
          retryable: false,
          occurrenceCount: 3n,
          firstObservedAt: new Date("2026-09-01T12:01:00.000Z"),
          lastObservedAt: new Date("2026-09-01T12:02:00.000Z"),
        }),
      ]);
    } finally {
      if (db !== undefined) {
        await db.delete(encryptionTransitionBoundaryHealth);
        const current = await getEncryptionTransitionPolicy(db);
        if (
          current.mode !== original.mode
          || current.shadowBehavior !== original.shadowBehavior
        ) {
          await compareAndSwapEncryptionTransitionPolicy(db, {
            expectedRevision: current.revision,
            targetMode: original.mode,
            targetShadowBehavior: original.shadowBehavior,
            now: new Date("2026-09-01T12:03:00.000Z"),
          });
        }
      }
    }
  });
});

import { describe, expect, test } from "bun:test";

import {
  EncryptionTransitionPolicyConflictError,
  compareAndSwapEncryptionTransitionPolicy,
  getEncryptionTransitionPolicy,
  UnsupportedEncryptionTransitionStateError,
  assertLiveShadowEncryptionTransitionMode,
  observationBoundsFromPolicyRow,
  projectLiveShadowEncryptionTransitionPolicy,
} from "../../src/utils/encryption-transition-queries";

describe("M274 encryption transition policy", () => {
  test("projects only live Shadow modes", () => {
    const createdAt = new Date("2026-08-14T06:00:00.000Z");
    const updatedAt = new Date("2026-08-14T06:00:01.000Z");
    expect(projectLiveShadowEncryptionTransitionPolicy({
      id: "server",
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 7,
      shadowEncryptionStartedAt: null,
      observationBoundsRevision: 1,
      observationBucketWidthMs: 3_600_000,
      observationRetentionMs: 2_592_000_000,
      observationStorageLimitRows: 10_000,
      observationLatencyUpperBoundsMs: [
        50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
      ],
      observationBoundsConfiguredAt: createdAt,
      createdAt,
      updatedAt,
    })).toEqual({
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 7,
      shadowEncryptionStartedAt: null,
      updatedAt,
    });
    expect(assertLiveShadowEncryptionTransitionMode("shadow_encryption"))
      .toBe("shadow_encryption");
  });

  test("fresh server can enter shadow writes with the reviewed v1 bounds", async () => {
    const createdAt = new Date("2026-08-15T00:00:00.000Z");
    const transitionAt = new Date("2026-08-15T01:00:00.000Z");
    let row: Record<string, unknown> | undefined = {
      id: "server",
      mode: "plaintext_only",
      shadowBehavior: "fallback",
      revision: 0,
      shadowEncryptionStartedAt: null,
      observationBoundsRevision: 1,
      observationBucketWidthMs: 3_600_000,
      observationRetentionMs: 2_592_000_000,
      observationStorageLimitRows: 10_000,
      observationLatencyUpperBoundsMs: [
        50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
      ],
      observationBoundsConfiguredAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    };
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => row === undefined ? [] : [row] }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => ({
            returning: async () => {
              row = { ...row, ...values };
              return [row];
            },
          }),
        }),
      }),
    } as unknown as Parameters<typeof compareAndSwapEncryptionTransitionPolicy>[0];

    // The canonical CAS now owns a short transaction shared with publication
    // fences. This hermetic fixture models that transaction, not a live DB.
    Object.assign(db, {
      execute: () => Promise.resolve([]),
      transaction: (run: (tx: typeof db) => Promise<unknown>) => run(db),
    });

    expect(await compareAndSwapEncryptionTransitionPolicy(db, {
      expectedRevision: 0,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "fallback",
      now: transitionAt,
    })).toMatchObject({
      mode: "shadow_encryption",
      revision: 1,
      shadowEncryptionStartedAt: transitionAt,
    });

    const strictAt = new Date("2026-08-15T02:00:00.000Z");
    expect(await compareAndSwapEncryptionTransitionPolicy(db, {
      expectedRevision: 1,
      targetMode: "shadow_encryption",
      targetShadowBehavior: "strict",
      now: strictAt,
    })).toMatchObject({
      mode: "shadow_encryption",
      shadowBehavior: "strict",
      revision: 2,
      shadowEncryptionStartedAt: transitionAt,
      updatedAt: strictAt,
    });
    expect(await compareAndSwapEncryptionTransitionPolicy(db, {
      expectedRevision: 2,
      targetMode: "encrypted_only",
      targetShadowBehavior: "strict",
      now: strictAt,
    })).toMatchObject({
      mode: "encrypted_only", revision: 3,
      shadowEncryptionStartedAt: transitionAt,
    });
  });

  test("reads the migration-seeded singleton without a foreground write", async () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    let selected = 0;
    const db = {
      select: () => {
        selected += 1;
        return {
          from: () => ({ where: () => ({ limit: async () => [{
            id: "server",
            mode: "plaintext_only",
            shadowBehavior: "fallback",
            revision: 0,
            shadowEncryptionStartedAt: null,
            observationBoundsRevision: 1,
            observationBucketWidthMs: 3_600_000,
            observationRetentionMs: 2_592_000_000,
            observationStorageLimitRows: 10_000,
            observationLatencyUpperBoundsMs: [
              50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
            ],
            observationBoundsConfiguredAt: now,
            createdAt: now,
            updatedAt: now,
          }] }) }),
        };
      },
      update: () => {
        throw new Error("policy read attempted a write");
      },
    } as unknown as Parameters<typeof getEncryptionTransitionPolicy>[0];
    expect(await getEncryptionTransitionPolicy(db)).toMatchObject({
      mode: "plaintext_only",
      revision: 0,
    });
    expect(selected).toBe(1);
  });

  test("fails closed instead of accepting caller-selected observation bounds", () => {
    const now = new Date("2026-08-15T00:00:00.000Z");
    const row = {
      id: "server",
      mode: "plaintext_only" as const,
      shadowBehavior: "fallback" as const,
      revision: 0,
      shadowEncryptionStartedAt: null,
      observationBoundsRevision: 1,
      observationBucketWidthMs: 1_000,
      observationRetentionMs: 2_592_000_000,
      observationStorageLimitRows: 10_000,
      observationLatencyUpperBoundsMs: [
        50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
      ],
      observationBoundsConfiguredAt: now,
      createdAt: now,
      updatedAt: now,
    };
    expect(() => observationBoundsFromPolicyRow(row)).toThrow(
      "observation bounds are incoherent",
    );
  });

  test("fails closed for reserved and unknown durable modes", () => {
    expect(assertLiveShadowEncryptionTransitionMode("encrypted_only"))
      .toBe("encrypted_only");
    for (const mode of ["shadow_reads", "corrupt"]) {
      expect(() => assertLiveShadowEncryptionTransitionMode(mode))
        .toThrow(UnsupportedEncryptionTransitionStateError);
    }
  });

  test("exposes a typed exact-revision conflict", () => {
    const error = new EncryptionTransitionPolicyConflictError(4, 5);
    expect(error.expectedRevision).toBe(4);
    expect(error.actualRevision).toBe(5);
    expect(error.message).toContain("revision 4");
  });
});

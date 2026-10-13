import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1 } from "../../src/schema/encryption-transition";
import { compareAndSwapValidatedEncryptionTransitionPolicy } from "../../src/utils/encryption-transition-queries";

function fixture(revision = 3) {
  const events: string[] = [];
  const now = new Date("2030-01-01T00:00:00.000Z");
  const bounds = ENCRYPTION_TRANSITION_OBSERVATION_POLICY_V1;
  let row = { id: "server", mode: "shadow_encryption", shadowBehavior: "strict", revision,
    shadowEncryptionStartedAt: now, observationBoundsRevision: bounds.revision,
    observationBucketWidthMs: bounds.bucketWidthMs, observationRetentionMs: bounds.retentionMs,
    observationStorageLimitRows: bounds.storageLimitRows, observationLatencyUpperBoundsMs: [...bounds.latencyUpperBoundsMs],
    observationBoundsConfiguredAt: now, createdAt: now, updatedAt: now };
  const transaction = {
    execute: async () => { events.push("exclusive-policy-fence"); return []; },
    select: () => ({ from: () => ({ where: () => ({ limit: async () => { events.push("current-policy"); return [{ ...row }]; } }) }) }),
    update: () => ({ set: (values: Partial<typeof row>) => ({ where: () => ({ returning: async () => {
      events.push("policy-update"); row = { ...row, ...values }; return [{ ...row }];
    } }) }) }),
  };
  const db = { transaction: async (use: (tx: typeof transaction) => Promise<unknown>) => {
    events.push("begin"); const value = await use(transaction); events.push("commit"); return value;
  } } as unknown as Parameters<typeof compareAndSwapValidatedEncryptionTransitionPolicy>[0];
  return { db, transaction, events, row: () => row };
}
const request = { expectedRevision: 3, targetMode: "encrypted_only" as const, targetShadowBehavior: "strict" as const };

test("fresh readiness is evaluated on the same transaction under the exclusive fence before Full CAS", async () => {
  const f = fixture();
  const result = await compareAndSwapValidatedEncryptionTransitionPolicy(f.db, request, async input => {
    expect(Object.is(input.transaction, f.transaction)).toBeTrue();
    expect(input.current).toMatchObject({ mode: "shadow_encryption", revision: 3 });
    expect(input.requested).toBe(request);
    f.events.push("current-readiness");
  });
  expect(result).toMatchObject({ mode: "encrypted_only", revision: 4 });
  expect(f.events).toEqual(["begin", "exclusive-policy-fence", "current-policy", "current-readiness", "current-policy", "policy-update", "commit"]);
});

test("failed current readiness cannot advance policy or commit a detached old receipt", async () => {
  const f = fixture();
  await rejects(compareAndSwapValidatedEncryptionTransitionPolicy(f.db, request, async () => {
    throw new Error("Task staging remains");
  }), /Task staging remains/u);
  expect(f.row().mode).toBe("shadow_encryption");
  expect(f.row().revision).toBe(3);
  expect(f.events).not.toContain("policy-update");
  expect(f.events).not.toContain("commit");
});

test("a stale requested revision is rejected before current readiness executes", async () => {
  const f = fixture(4);
  await rejects(compareAndSwapValidatedEncryptionTransitionPolicy(f.db, request, async () => {
    throw new Error("Unexpected readiness");
  }), /revision 3 is stale/u);
  expect(f.events).toEqual(["begin", "exclusive-policy-fence", "current-policy"]);
});

test("invalid revision or reserved mode cannot invoke the readiness callback or open a transaction", async () => {
  const f = fixture();
  await rejects(compareAndSwapValidatedEncryptionTransitionPolicy(f.db, { ...request, expectedRevision: -1 }, async () => {}), /non-negative safe integer/u);
  await rejects(compareAndSwapValidatedEncryptionTransitionPolicy(f.db, { ...request, targetMode: "reserved" as never }, async () => {}), /not supported/u);
  expect(f.events).toEqual([]);
});

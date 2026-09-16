import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import type { DirectDatabase } from "@nautilo/db";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  ConnectedWebAccountStoreError,
  createConnectedWebAccountStore,
  parseConnectedWebOperationProviderReferences,
  parseConnectedWebOperationSafeActivity,
  parseConnectedWebOperationSafeReceipt,
} from "../../src/connected-web-accounts/store";
import { ConnectedWebOperationSecrets } from "../../src/connected-web-accounts/operation-secrets";

const operationSecrets = new ConnectedWebOperationSecrets({
  stableServerSecret: "a stable server-only test secret that is never persisted",
});
const secretContext = {
  operationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
};
const sealedRunRef = operationSecrets.sealProviderReferences({
  context: secretContext,
  coordinates: { runId: "run-private" },
}).runRef!;
const sealedOldRunRef = operationSecrets.sealProviderReferences({
  context: secretContext,
  coordinates: { runId: "old-run-private" },
}).runRef!;
const sealedNewRunRef = operationSecrets.sealProviderReferences({
  context: secretContext,
  coordinates: { runId: "new-run-private" },
}).runRef!;
const sealedDirectRefs = operationSecrets.sealProviderReferences({
  context: secretContext,
  coordinates: { runId: "run-private", browserId: "browser-private" },
});

const safeActivity = {
  version: 1 as const,
  phase: "working" as const,
  code: "BROWSER_READY",
  summary: "Browser is ready for the requested work.",
};

const admission = {
  id: secretContext.operationId,
  ownerUserId: "11111111-1111-4111-8111-111111111111",
  accountId: "22222222-2222-4222-8222-222222222222",
  initiatingAgentId: "33333333-3333-4333-8333-333333333333",
  initiatingRoomId: "44444444-4444-4444-8444-444444444444",
  initiatingThreadId: "thread-1",
  initiatingLane: "foreground",
  deliveryId: "delivery-1",
  requestDigest: "a".repeat(64),
  sealedIntent: operationSecrets.sealIntent({ context: secretContext, intent: "Read the connected website." }),
  safeActivity,
  remainingBudgetUsdMicros: Number.MAX_SAFE_INTEGER,
};

function rendered(condition: SQL): { readonly sql: string; readonly params: readonly unknown[] } {
  return new PgDialect().sqlToQuery(condition);
}

function operationUpdateStore(capture: { condition: SQL | null }) {
  const db = {
    transaction: async (run: (tx: DirectDatabase) => Promise<unknown>) => run(db),
    update: () => ({
      set: () => ({
        where: (condition: SQL) => {
          capture.condition = condition;
          return { returning: async () => [] };
        },
      }),
    }),
  } as unknown as DirectDatabase;
  return createConnectedWebAccountStore(db);
}

describe("D568 connected website operation store boundary", () => {
  for (const checkpointExists of [true, false]) {
    test(`steering updates account and operation run references in one transaction (checkpoint ${checkpointExists ? "present" : "missing"})`, async () => {
      let committed = false;
      const writes: Array<{ values: Record<string, unknown>; condition: SQL }> = [];
      const tx = {
        update: () => ({ set: (values: Record<string, unknown>) => ({ where: (condition: SQL) => {
          writes.push({ values, condition });
          return { returning: async () => writes.length === 1
            ? [{ controlEpoch: 9, accountId: secretContext.accountId }]
            : checkpointExists ? [{ id: secretContext.accountId }] : [] };
        } }) }),
      };
      const store = createConnectedWebAccountStore({ transaction: async (run: (connection: typeof tx) => Promise<unknown>) => {
        const result = await run(tx);
        committed = true;
        return result;
      } } as never);
      const result = await store.rotateOperationProviderRunByControl({
        operationId: secretContext.operationId, ownerUserId: secretContext.ownerUserId,
        workerId: "steer", now: new Date(), expectedControlEpoch: 8,
        expectedRunRef: sealedOldRunRef, sealedProviderRefs: { version: 1, runRef: sealedNewRunRef },
        expectedOpaqueExecutionRef: "old-run", opaqueExecutionRef: "new-run",
        safeActivity, nextCheckAt: new Date(), cumulativeCostUsdMicros: 50, remainingBudgetUsdMicros: 50,
      }).catch((error: unknown) => error);
      expect(writes).toHaveLength(2);
      expect(rendered(writes[1]!.condition).params).toContain("old-run");
      expect(rendered(writes[1]!.values['executionCheckpoint'] as SQL).params).toContain("new-run");
      expect(committed).toBe(checkpointExists);
      if (checkpointExists) expect(result).toBe(9);
      else expect(result).toBeInstanceOf(ConnectedWebAccountStoreError);
    });
  }

  test("a requested Genie wake does not postpone ordinary provider observation", async () => {
    let written: Record<string, unknown> = {};
    const db = { update: () => ({ set: (value: Record<string, unknown>) => {
      written = value;
      return { where: () => ({ returning: async () => [{ id: secretContext.operationId }] }) };
    } }) } as unknown as DirectDatabase;
    const now = new Date("2026-09-05T12:00:00Z");
    const dueAt = new Date("2026-09-05T12:01:00Z");
    expect(await createConnectedWebAccountStore(db).scheduleOperationCheck({
      operationId: secretContext.operationId, expectedControlEpoch: 1,
      now, dueAt, requestedWakeAt: dueAt, safeActivity,
    })).toBe(true);
    expect(written['nextCheckAt']).toEqual(now);
    expect(written['requestedWakeAt']).toEqual(dueAt);
  });

  test("failed admission retains known sealed session custody for immediate browser cleanup", async () => {
    const writes: Record<string, unknown>[] = [];
    const refs = operationSecrets.sealProviderReferences({ context: secretContext, coordinates: { runId: "cancelled-run", sessionId: "known-session" } });
    const db = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
      update: () => ({ set: (values: Record<string, unknown>) => {
        writes.push(values);
        return { where: () => ({ returning: async () => [{ id: secretContext.operationId }] }) };
      } }),
    } as unknown as DirectDatabase;
    const now = new Date("2026-09-04T10:00:00.000Z");
    const failed = await createConnectedWebAccountStore(db).failAdmittedReadOperation({
      ...secretContext, reservationToken: "exact-reservation", now,
      receipt: { version: 1, outcome: "cancelled", code: "provider_activation_failed", summary: "Could not activate work." },
      sealedProviderRefs: refs,
    });
    expect(failed).toBe(true);
    expect(writes[0]).toMatchObject({ lifecycle: "terminal", sealedProviderRefs: refs, browserIdleUntil: now });
    expect(writes[1]).toMatchObject({ status: "connected", executionCheckpoint: null });
  });

  test("rejects raw provider capabilities and raw activity before persistence", () => {
    const refs = operationSecrets.sealProviderReferences({ context: secretContext, coordinates: { runId: "run-private" } });
    expect(parseConnectedWebOperationProviderReferences(refs)).toEqual(refs);
    expect(parseConnectedWebOperationProviderReferences({ version: 1, runRef: "sealed:run" })).toBeNull();
    expect(parseConnectedWebOperationProviderReferences({ version: 1, runRef: "https://live.example" })).toBeNull();
    expect(parseConnectedWebOperationProviderReferences({ version: 1, cdpUrl: "sealed" })).toBeNull();
    expect(parseConnectedWebOperationSafeActivity(safeActivity)).toEqual(safeActivity);
    expect(parseConnectedWebOperationSafeActivity({ ...safeActivity, rawEvent: "no" })).toBeNull();
    expect(parseConnectedWebOperationSafeReceipt({ version: 1, outcome: "completed", code: "DONE", summary: "Completed safely." })).toEqual({ version: 1, outcome: "completed", code: "DONE", summary: "Completed safely." });
    expect(parseConnectedWebOperationSafeReceipt({ version: 1, outcome: "completed", code: "DONE", summary: "https://provider.example/token" })).toBeNull();
  });

  test("does not admit a foreign or absent account UUID before writing an operation", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [] }),
        }),
      }),
    } as unknown as DirectDatabase;
    const store = createConnectedWebAccountStore(db);
    let caught: unknown = null;
    try {
      await store.admitOperation(admission);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "ConnectedWebAccountStoreError",
      kind: "not_found",
    } satisfies Partial<ConnectedWebAccountStoreError>);
  });

  test("requires a trusted pre-minted UUID before the operation store can admit", async () => {
    const db = {} as DirectDatabase;
    const store = createConnectedWebAccountStore(db);
    let caught: unknown = null;
    try {
      await store.admitOperation({ ...admission, id: "not-a-uuid" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "ConnectedWebAccountStoreError",
      kind: "conflict",
    } satisfies Partial<ConnectedWebAccountStoreError>);
  });

  test("inserts the trusted pre-minted UUID instead of minting a second operation identity", async () => {
    const insertCapture: { values: Record<string, unknown> | null } = { values: null };
    const inserted = new Error("insert captured");
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ id: admission.accountId }] }),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertCapture.values = values;
          return {
            onConflictDoNothing: () => ({
              returning: async () => { throw inserted; },
            }),
          };
        },
      }),
    } as unknown as DirectDatabase;
    let caught: unknown = null;
    try {
      await createConnectedWebAccountStore(db).admitOperation(admission);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(inserted);
    expect(insertCapture.values?.["id"]).toBe(admission.id);
  });

  test("does not let a second worker steal due work while the first lease remains live", async () => {
    const capture: { condition: SQL | null } = { condition: null };
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        select: () => ({
          from: () => ({
            where: (condition: SQL) => {
              capture.condition = condition;
              return { orderBy: () => ({ limit: () => ({ for: async () => [] }) }) };
            },
          }),
        }),
      }),
    } as unknown as DirectDatabase;
    await createConnectedWebAccountStore(db).claimDueOperations({
      workerId: "worker-two", now: new Date("2026-09-03T10:00:00.000Z"), leaseMs: 60_000,
    });
    expect(capture.condition).not.toBeNull();
    const query = rendered(capture.condition!);
    expect(query.sql).toContain('"next_check_at" <= $1');
    expect(query.sql).toContain('("connected_web_operations"."supervisor_claim_expires_at" is null or "connected_web_operations"."supervisor_claim_expires_at" <= $2)');
    expect(query.sql).not.toContain('"next_check_at" <= $1 or "connected_web_operations"."supervisor_claim_expires_at" <= $2');
    // Durable read intent is not an active run until atomic activation stores
    // sealed refs plus the matching account checkpoint.
    expect(query.sql).not.toContain("'admitted'");
    expect(query.sql).toContain("'running', 'attention'");
  });

  test("fences the supervisor before direct takeover and leaves an expiry-backed recovery claim", async () => {
    const captured: { values: Record<string, unknown> | null; condition: SQL | null } = { values: null, condition: null };
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: (condition: SQL) => {
            captured.values = values;
            captured.condition = condition;
            return { returning: async () => [{ controlEpoch: 8 }] };
          },
        }),
      }),
    } as unknown as DirectDatabase;
    const claimedAt = new Date("2026-09-03T10:00:00.000Z");
    const result = await createConnectedWebAccountStore(db).claimOperationForControl({
      operationId: secretContext.operationId,
      ownerUserId: secretContext.ownerUserId,
      expectedControlEpoch: 7,
      expectedRunRef: sealedRunRef,
      workerId: "direct-takeover:private",
      now: claimedAt,
      leaseMs: 300_000,
      safeActivity,
    });

    expect(result).toBe(8);
    expect(captured.values).toMatchObject({
      driver: "checking",
      lifecycle: "running",
      controlEpoch: 8,
      safeActivity,
      nextCheckAt: claimedAt,
      supervisorClaimOwner: "direct-takeover:private",
      supervisorClaimExpiresAt: new Date("2026-09-03T10:05:00.000Z"),
      wakeFingerprint: null,
      wakeClaimOwner: null,
      wakeClaimExpiresAt: null,
      wakeDeliveredAt: null,
    });
    const query = rendered(captured.condition!);
    expect(query.sql).toContain('"connected_web_operations"."owner_user_id" = $2');
    expect(query.sql).toContain('"connected_web_operations"."control_epoch" = $3');
    expect(query.sql).toContain('"connected_web_operations"."sealed_provider_refs"->>\'runRef\' = $4');
    expect(query.sql).toContain('"connected_web_operations"."action_operation_id" is null');
    expect(query.sql).toContain('"connected_web_operations"."effect_idempotency_key" is null');
  });

  test("fences stale wake completion and release to the claimed fingerprint", async () => {
    const completionCapture: { condition: SQL | null } = { condition: null };
    const completion = await operationUpdateStore(completionCapture).completeOperationWake({
      operationId: "55555555-5555-4555-8555-555555555555",
      workerId: "wake-worker",
      expectedWakeFingerprint: "checkpoint-before-navigation",
      now: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(completion).toBe(false);
    expect(rendered(completionCapture.condition!).sql).toContain('"connected_web_operations"."wake_fingerprint" = $3');

    const releaseCapture: { condition: SQL | null } = { condition: null };
    const released = await operationUpdateStore(releaseCapture).releaseOperationWakeClaim({
      operationId: "55555555-5555-4555-8555-555555555555",
      workerId: "wake-worker",
      expectedWakeFingerprint: "checkpoint-before-navigation",
      now: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(released).toBe(false);
    expect(rendered(releaseCapture.condition!).sql).toContain('"connected_web_operations"."wake_fingerprint" = $3');
  });

  test("terminalizes a read and releases only its exact active run in one transaction", async () => {
    const conditions: SQL[] = [];
    const values: Array<Record<string, unknown>> = [];
    const tx = {
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: (condition: SQL) => {
            values.push(value);
            conditions.push(condition);
            return { returning: async () => [{ id: "ok" }] };
          },
        }),
      }),
    };
    const db = { transaction: async (callback: (inner: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as DirectDatabase;
    const completed = await createConnectedWebAccountStore(db).terminalizeReadOperationAndCompleteExecution({
      cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 2_000_000, safeActivity, wakeFingerprint: "terminal-read",
      operationId: secretContext.operationId,
      ownerUserId: secretContext.ownerUserId,
      accountId: secretContext.accountId,
      expectedControlEpoch: 1,
      expectedRunRef: sealedRunRef,
      opaqueExecutionRef: "run-private",
      now: new Date("2026-09-03T10:00:00.000Z"),
      receipt: { version: 1, outcome: "completed", code: "provider_completed", summary: "Connected website work completed." },
      terminalReadResult: {
        version: 1,
        account: { id: secretContext.accountId, label: "Example", service: "example", origin: "https://example.com" },
        page: { ref: secretContext.accountId, title: "Example", origin: "https://example.com" },
        read: null,
        cost: { currency: "USD", amountUsd: 0, state: "actual" },
        outputs: [],
        outputsTruncated: false,
      },
    });
    expect(completed).toBe(true);
    expect(conditions).toHaveLength(2);
    expect(values[0]).toMatchObject({ lifecycle: "terminal", terminalReadResult: { version: 1, read: null } });
    expect(values[1]).toMatchObject({ status: "connected", executionCheckpoint: null });
    expect(rendered(conditions[0]!).sql).toContain('"connected_web_operations"."sealed_provider_refs"->>\'runRef\' = $5');
    expect(rendered(conditions[1]!).sql).toContain('"connected_web_accounts"."execution_checkpoint"->>\'opaqueExecutionRef\' = $4');
  });

  test("atomically takes over an exact active hosted read while retaining its writer fence and invalidating the old wake", async () => {
    const values: Array<Record<string, unknown>> = [];
    const conditions: SQL[] = [];
    const tx = {
      update: () => ({ set: (value: Record<string, unknown>) => ({ where: (condition: SQL) => {
        values.push(value); conditions.push(condition); return { returning: async () => [{ controlEpoch: 8 }] };
      } }) }),
      select: () => ({ from: () => ({ where: (condition: SQL) => {
        conditions.push(condition);
        return { limit: () => ({ for: async () => [{ id: secretContext.accountId }] }) };
      } }) }),
    };
    const db = { transaction: async (callback: (inner: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as DirectDatabase;
    const result = await createConnectedWebAccountStore(db).takeOverReadOperationForDirect({
      ownerUserId: secretContext.ownerUserId, accountId: secretContext.accountId, operationId: secretContext.operationId,
      expectedControlEpoch: 7, expectedRunRef: sealedRunRef, opaqueExecutionRef: "run-private",
      sealedProviderRefs: sealedDirectRefs, now: new Date("2026-09-03T10:00:00.000Z"), safeActivity,
    });
    expect(result).toMatchObject({ controlEpoch: 8 });
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ driver: "direct", lifecycle: "running", controlEpoch: 8, sealedProviderRefs: sealedDirectRefs,
      nextCheckAt: null, supervisorClaimOwner: null, supervisorClaimExpiresAt: null,
      wakeFingerprint: null, wakeClaimOwner: null, wakeClaimExpiresAt: null, wakeDeliveredAt: null });
    const operationSql = rendered(conditions[0]!).sql;
    expect(operationSql).toContain('"connected_web_operations"."owner_user_id" = $2');
    expect(operationSql).toContain('"connected_web_operations"."account_id" = $3');
    expect(operationSql).toContain('"connected_web_operations"."control_epoch" = $4');
    expect(operationSql).toContain('"connected_web_operations"."sealed_provider_refs"->>\'runRef\' = $5');
    // Account is only selected/locked: the read reservation survives direct control.
    expect(rendered(conditions[1]!).sql).toMatch(/"connected_web_accounts"\."execution_checkpoint"->>'opaqueExecutionRef' = \$\d+/u);
  });

  test("rolls back takeover when the exact busy read checkpoint is gone", async () => {
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ controlEpoch: 8 }] }) }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => ({ for: async () => [] }) }) }) }),
    };
    const db = { transaction: async (callback: (inner: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as DirectDatabase;
    const error = await createConnectedWebAccountStore(db).takeOverReadOperationForDirect({
      ownerUserId: secretContext.ownerUserId, accountId: secretContext.accountId, operationId: secretContext.operationId,
      expectedControlEpoch: 7, expectedRunRef: sealedRunRef, opaqueExecutionRef: "wrong-run",
      sealedProviderRefs: sealedDirectRefs, now: new Date("2026-09-03T10:00:00.000Z"), safeActivity,
    }).then(() => null, (cause: unknown) => cause);
    expect(error).toMatchObject({ kind: "conflict" });
  });

  test("moves an authenticated read to Human attention while releasing the exact run", async () => {
    const values: Array<Record<string, unknown>> = [];
    const tx = {
      update: () => ({
        set: (value: Record<string, unknown>) => ({
          where: () => {
            values.push(value);
            return { returning: async () => [{ id: "ok" }] };
          },
        }),
      }),
    };
    const db = { transaction: async (callback: (inner: typeof tx) => Promise<unknown>) => callback(tx) } as unknown as DirectDatabase;
    expect(await createConnectedWebAccountStore(db).terminalizeReadOperationAndCompleteExecution({
      cumulativeCostUsdMicros: 0, remainingBudgetUsdMicros: 2_000_000, safeActivity, wakeFingerprint: "terminal-auth",
      operationId: secretContext.operationId,
      ownerUserId: secretContext.ownerUserId,
      accountId: secretContext.accountId,
      expectedControlEpoch: 1,
      expectedRunRef: sealedRunRef,
      opaqueExecutionRef: "run-private",
      now: new Date("2026-09-03T10:00:00.000Z"),
      receipt: { version: 1, outcome: "attention_required", code: "authentication_required", summary: "Connected website sign-in needs Human attention." },
      terminalReadResult: null,
      authenticationRequired: "mfa",
    })).toBe(true);
    expect(values[0]).toMatchObject({
      lifecycle: "attention",
      driver: "human",
      safeActivity: { phase: "attention", code: "authentication_mfa" },
      terminalReceipt: null,
      terminalReadResult: null,
      terminalAt: null,
    });
    expect(values[1]).toMatchObject({ status: "attention_needed", executionCheckpoint: null });
  });

  test("discovers only unclaimed or expired-fingerprint wakes with skip-locked worker selection", async () => {
    const capture: { condition: SQL | null } = { condition: null };
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({
        select: () => ({
          from: () => ({
            where: (condition: SQL) => {
              capture.condition = condition;
              return { orderBy: () => ({ limit: () => ({ for: async () => [] }) }) };
            },
          }),
        }),
      }),
    } as unknown as DirectDatabase;
    await createConnectedWebAccountStore(db).claimDueOperationWakes({
      workerId: "wake-worker", now: new Date("2026-09-03T10:00:00.000Z"), leaseMs: 60_000, batch: 4,
    });
    expect(capture.condition).not.toBeNull();
    const query = rendered(capture.condition!);
    expect(query.sql).toContain('"connected_web_operations"."wake_fingerprint" is not null');
    expect(query.sql).toContain('"connected_web_operations"."wake_delivered_at" is null');
    expect(query.sql).toContain('"connected_web_operations"."requested_wake_at" <= $1');
    expect(query.sql).toContain('("connected_web_operations"."wake_claim_expires_at" is null or "connected_web_operations"."wake_claim_expires_at" <= $2)');
  });

  test("a due requested check becomes a durable wake without any provider event", async () => {
    const now = new Date("2026-09-05T12:01:00Z");
    let row: Record<string, unknown> = {
      ...admission, id: admission.id, lifecycle: "running", driver: "checking", controlEpoch: 1,
      eventCursor: 0, cumulativeCostUsdMicros: 0, sealedProviderRefs: { version: 1, runRef: sealedRunRef },
      terminalReceipt: null, terminalReadResult: null, terminalAt: null,
      requestedWakeAt: now, wakeFingerprint: null, wakeDeliveredAt: null,
    };
    const db = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({
        for: async () => row['requestedWakeAt'] === null ? [] : [row],
      }) }) }) }) }),
      update: () => ({ set: (values: Record<string, unknown>) => ({ where: () => ({ returning: async () => {
        row = { ...row, ...values }; return [row];
      } }) }) }),
    } as unknown as DirectDatabase;
    const store = createConnectedWebAccountStore(db);
    const claimed = await store.claimDueOperationWakes({ workerId: "wake", now, leaseMs: 60_000 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.wakeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(row['requestedWakeAt']).toBeNull();
    expect(row['wakeDeliveredAt']).toBeNull();
    expect(row['wakeClaimOwner']).toBe("wake");
    expect(await store.claimDueOperationWakes({ workerId: "other", now, leaseMs: 60_000 })).toEqual([]);
  });

  test("rejects a checkpoint or replacement run that increases total authorized budget", async () => {
    const checkpointCapture: { condition: SQL | null } = { condition: null };
    const checkpoint = await operationUpdateStore(checkpointCapture).recordOperationCheckpoint({
      operationId: "55555555-5555-4555-8555-555555555555",
      workerId: "worker-one",
      now: new Date("2026-09-03T10:00:00.000Z"),
      expectedControlEpoch: 1,
      expectedEventCursor: 0,
      expectedRunRef: null,
      sealedProviderRefs: { version: 1, runRef: sealedRunRef },
      eventCursor: 1,
      safeActivity,
      nextCheckAt: new Date("2026-09-03T10:01:00.000Z"),
      cumulativeCostUsdMicros: 20,
      remainingBudgetUsdMicros: 90,
    });
    expect(checkpoint).toBe(false);
    const checkpointQuery = rendered(checkpointCapture.condition!);
    expect(checkpointQuery.sql).toMatch(/\$\d+::bigint \+ \$\d+::bigint <= "connected_web_operations"\."cumulative_cost_usd_micros" \+ "connected_web_operations"\."remaining_budget_usd_micros"/u);

    const rotateCapture: { condition: SQL | null } = { condition: null };
    const rotation = await operationUpdateStore(rotateCapture).rotateOperationProviderRun({
      operationId: "55555555-5555-4555-8555-555555555555",
      workerId: "worker-one",
      now: new Date("2026-09-03T10:00:00.000Z"),
      expectedControlEpoch: 1,
      expectedRunRef: sealedOldRunRef,
      sealedProviderRefs: { version: 1, runRef: sealedNewRunRef },
      safeActivity,
      nextCheckAt: new Date("2026-09-03T10:01:00.000Z"),
      cumulativeCostUsdMicros: 20,
      remainingBudgetUsdMicros: 90,
    });
    expect(rotation).toBeNull();
    const rotateQuery = rendered(rotateCapture.condition!);
    expect(rotateQuery.sql).toMatch(/\$\d+::bigint \+ \$\d+::bigint <= "connected_web_operations"\."cumulative_cost_usd_micros" \+ "connected_web_operations"\."remaining_budget_usd_micros"/u);
  });

  test("fences an interactive replacement to the exact owner, old run, and epoch", async () => {
    const capture: { condition: SQL | null } = { condition: null };
    const rotated = await operationUpdateStore(capture).rotateOperationProviderRunByControl({
      workerId: "steer-worker",
      expectedOpaqueExecutionRef: "old-run-private", opaqueExecutionRef: "new-run-private",
      operationId: secretContext.operationId,
      ownerUserId: secretContext.ownerUserId,
      now: new Date("2026-09-03T10:00:00.000Z"),
      expectedControlEpoch: 7,
      expectedRunRef: sealedOldRunRef,
      sealedProviderRefs: { version: 1, runRef: sealedNewRunRef },
      safeActivity,
      nextCheckAt: new Date("2026-09-03T10:00:00.000Z"),
      cumulativeCostUsdMicros: 20,
      remainingBudgetUsdMicros: 80,
    });
    expect(rotated).toBeNull();
    const query = rendered(capture.condition!);
    expect(query.sql).toContain('"connected_web_operations"."id" = $1');
    expect(query.sql).toContain('"connected_web_operations"."owner_user_id" = $2');
    expect(query.sql).toContain('"connected_web_operations"."control_epoch" = $3');
    expect(query.sql).toContain('"connected_web_operations"."sealed_provider_refs"->>\'runRef\' is not distinct from $4');
    expect(query.sql).toContain('"connected_web_operations"."lifecycle" <> \'terminal\'');
  });

  test("records coarse direct activity only on the exact owner/direct epoch without rotating it", async () => {
    const capture: { condition: SQL | null } = { condition: null };
    const recorded = await operationUpdateStore(capture).recordDirectOperationActivity({
      operationId: secretContext.operationId,
      ownerUserId: secretContext.ownerUserId,
      expectedControlEpoch: 7,
      now: new Date("2026-09-03T10:00:00.000Z"),
      safeActivity: { version: 1, phase: "working", code: "direct_text_entered", summary: "Moxie entered text on the connected website." },
    });
    expect(recorded).toBe(false);
    const query = rendered(capture.condition!);
    expect(query.sql).toContain('"connected_web_operations"."id" = $1');
    expect(query.sql).toContain('"connected_web_operations"."owner_user_id" = $2');
    expect(query.sql).toContain('"connected_web_operations"."control_epoch" = $3');
    expect(query.sql).toContain('"connected_web_operations"."driver" = $4');
    expect(query.sql).toContain('"connected_web_operations"."lifecycle" <> \'terminal\'');
    expect(query.sql).not.toContain('control_epoch = $3 + 1');
  });
});

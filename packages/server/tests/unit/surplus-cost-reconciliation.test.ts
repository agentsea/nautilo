import { describe, expect, test } from "bun:test";
import type { SurplusPendingAttempt } from "@nautilo/db";
import { surplusCredentialFingerprint } from "@nautilo/agent";
import { createSurplusCostRecovery } from "../../src/lib/surplus-cost-reconciliation";

const key = "synthetic-surplus-key";
const row: SurplusPendingAttempt = {
  id: "11111111-1111-4111-8111-111111111111", occurredAt: new Date(0), updatedAt: new Date(1),
  updatedAtToken: "1970-01-01T00:00:00.001000Z",
  userId: null, roomId: null, taskId: null, callType: "capability_probe", provider: "venice",
  model: "venice:openai-gpt-55", providerRequestId: "request-1", endpoint: "/v1/chat/completions",
  servingProvider: "venice", attemptOutcome: "cancelled", costState: "pending", fundingKind: "service",
  recoveryState: "pending", payerHumanId: null, credentialId: null, credentialRevision: null,
  failureCode: null,
  metadata: {
    surplusModelId: "gpt-5.5", surplusProviderPin: "venice", surplusCredentialFingerprint: surplusCredentialFingerprint(key),
  },
};

const available = (apiKey = key) => ({
  status: "available" as const,
  apiKey,
  receiptReadStatus: "available" as const,
});

function createRecovery(
  overrides: Parameters<typeof createSurplusCostRecovery>[0],
) {
  return createSurplusCostRecovery({
    resolveServerCredential: () => null,
    requeueBlockedDecisions: async () => 0,
    ...overrides,
  });
}

describe("Surplus automatic financial recovery", () => {
  test("restart uses durable request binding and settles the same row once", async () => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const seen: unknown[] = [];
    let remaining = true;
    const recovery = createRecovery({
      now: () => 120_000, resolveCredential: () => available(),
      list: async () => remaining ? [row] : [],
      fetchCost: async (input) => {
        expect(input.binding).toEqual({ requestId: "request-1", surplusModelId: "gpt-5.5", providerPin: "venice" });
        return { status: "settled", costMicro: 283 };
      },
      settle: async (input) => { seen.push(input); remaining = false; resolveSettled(); return true; },
    });
    recovery.start();
    await settled;
    await recovery.stop();
    recovery.wake();
    expect(seen).toEqual([{
      attemptId: row.id, providerRequestId: "request-1",
      expectedUpdatedAtToken: row.updatedAtToken, actualCostUsd: 0.000283,
    }]);
  });

  test("recovers a Google attempt using its persisted Surplus provider spelling", async () => {
    let reads = 0;
    const writes: unknown[] = [];
    const recovery = createRecovery({
      resolveCredential: () => available(),
      list: async () => [{ ...row, provider: "google", model: "google:gemini-3.8-pro", metadata: {
        ...row.metadata, catalogModelId: "google:gemini-3.8-pro",
        surplusModelId: "gemini-3.8-pro", surplusProviderPin: "google-ai-studio",
      } }],
      fetchCost: async (input) => {
        reads++;
        expect(input.binding.providerPin).toBe("google-ai-studio");
        return { status: "settled", costMicro: 283 };
      },
      settle: async (input) => { writes.push(input); return true; },
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(reads).toBe(1);
    expect(writes).toHaveLength(1);
  });

  test("recovers a decision receipt through the same exact-request binding", async () => {
    let reads = 0;
    const writes: unknown[] = [];
    const decision = {
      ...row,
      callType: "other",
      provider: "openrouter",
      model: "openrouter:typesafe/jev-1.13",
      endpoint: "/v1/decisions",
      metadata: {
        ...row.metadata,
        catalogModelId: "openrouter:typesafe/jev-1.13",
        surplusModelId: "typesafe/jev-1.13",
        surplusProviderPin: "openrouter",
      },
    } satisfies SurplusPendingAttempt;
    const recovery = createRecovery({
      list: async () => [decision],
      resolveCredential: () => available(),
      fetchCost: async (input) => {
        reads++;
        expect(input.binding).toEqual({
          requestId: decision.providerRequestId!,
          surplusModelId: "typesafe/jev-1.13",
          providerPin: "openrouter",
        });
        return { status: "settled", costMicro: 41 };
      },
      settle: async (input) => { writes.push(input); return true; },
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(reads).toBe(1);
    expect(writes).toEqual([{
      attemptId: decision.id,
      providerRequestId: decision.providerRequestId,
      expectedUpdatedAtToken: decision.updatedAtToken,
      actualCostUsd: 0.000041,
    }]);
  });

  test("keeps other endpoint protocols blocked without a receipt read", async () => {
    let reads = 0;
    let classified: unknown;
    const recovery = createRecovery({
      list: async () => [{ ...row, endpoint: "/v1/images/generations" }],
      resolveCredential: () => available(),
      fetchCost: async () => { reads++; return { status: "settled", costMicro: 0 }; },
      classify: async (input) => { classified = input; return true; },
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(reads).toBe(0);
    expect(classified).toMatchObject({
      recoveryState: "blocked_repair",
      failureCode: "receipt_endpoint_unsupported",
    });
  });

  test("requeues formerly blocked decision receipts once per recovery lifecycle", async () => {
    let requeues = 0;
    const recovery = createRecovery({
      requeueBlockedDecisions: async () => { requeues++; return 1; },
      list: async () => [],
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(requeues).toBe(1);
  });

  test("classifies unbound and unauthorized personal credentials without guessing zero", async () => {
    let reads = 0;
    let writes = 0;
    const classifications: unknown[] = [];
    const recovery = createRecovery({
      resolveCredential: () => available("rotated-key"),
      list: async () => [{
        ...row,
        fundingKind: "personal",
        payerHumanId: "payer-a",
        credentialId: "credential-a",
        credentialRevision: 1,
      }, { ...row, providerRequestId: null }, { ...row, metadata: null }],
      fetchCost: async () => { reads++; return { status: "settled", costMicro: 0 }; },
      settle: async () => { writes++; return true; },
      classify: async (input) => { classifications.push(input); return true; },
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(reads).toBe(0);
    expect(writes).toBe(0);
    expect(classifications).toHaveLength(3);
  });

  test("reads a payer-owned replacement's exact receipt despite unavailable list scope", async () => {
    for (const outcome of ["settled", "blocked_repair", "retryable"] as const) {
      let reads = 0;
      const writes: unknown[] = [];
      const classifications: unknown[] = [];
      const personalRow = { ...row, fundingKind: "personal" as const,
        payerHumanId: "payer-a", credentialId: "original-credential", credentialRevision: 1 };
      const recovery = createRecovery({
        list: async () => [personalRow],
        resolveCredential: () => ({ ...available("replacement-key"), replacement: true, receiptReadStatus: "unavailable" }),
        fetchCost: async (input) => {
          reads++;
          expect(input.apiKey).toBe("replacement-key");
          expect(input.binding.requestId).toBe(row.providerRequestId!);
          return outcome === "settled" ? { status: outcome, costMicro: 283 }
            : outcome === "blocked_repair" ? { status: outcome, failureCode: "receipt_read_unauthorized" }
            : { status: outcome, failureCode: "receipt_not_found" };
        },
        settle: async (input) => { writes.push(input); return true; },
        classify: async (input) => { classifications.push(input); return true; },
      });
      recovery.wake();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await recovery.stop();
      expect(reads).toBe(1);
      expect(writes).toHaveLength(outcome === "settled" ? 1 : 0);
      expect(classifications).toHaveLength(outcome === "settled" ? 0 : 1);
      if (outcome === "retryable") expect(classifications[0]).toMatchObject({
        recoveryState: "blocked_repair", failureCode: "receipt_account_unproven",
      });
      if (outcome === "settled") expect(writes[0]).toEqual({
        attemptId: row.id, providerRequestId: row.providerRequestId,
        expectedUpdatedAtToken: row.updatedAtToken, actualCostUsd: 0.000283,
      });
    }
  });

  test("list denial does not block the creating key's exact receipt", async () => {
    let reads = 0;
    const recovery = createRecovery({
      list: async () => [row],
      resolveCredential: () => ({ ...available(), receiptReadStatus: "unavailable" }),
      fetchCost: async () => { reads++; return { status: "settled", costMicro: 0 }; },
      settle: async () => true,
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(reads).toBe(1);
  });

  test("a bounded fair-ranked page reaches a later account receipt", async () => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const fairPage = [
      ...Array.from({ length: 99 }, (_, index) => ({
        ...row, id: String(index), providerRequestId: null,
      })),
      row,
    ];
    let lists = 0;
    const recovery = createRecovery({
      resolveCredential: () => available(),
      list: async (input) => {
        lists++;
        expect(input.limit).toBe(100);
        return fairPage;
      },
      fetchCost: async () => ({ status: "settled", costMicro: 0 }),
      settle: async (input) => { expect(input.actualCostUsd).toBe(0); resolveSettled(); return true; },
      classify: async () => true,
    });
    recovery.wake();
    await settled;
    await recovery.stop();
    expect(lists).toBe(1);
  });

  test("keeps a transient credential lookup failure retryable", async () => {
    let classified: unknown;
    const recovery = createRecovery({
      list: async () => [row],
      resolveCredential: () => { throw new Error("database unavailable"); },
      classify: async (input) => { classified = input; return true; },
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(classified).toMatchObject({
      attemptId: row.id,
      recoveryState: "retryable",
      failureCode: "credential_lookup_failed",
    });
  });

  test("shutdown cancels an active request-detail read and never settles afterward", async () => {
    let resolveReading!: () => void;
    const reading = new Promise<void>((resolve) => { resolveReading = resolve; });
    let writes = 0;
    const recovery = createRecovery({
      resolveCredential: () => available(), list: async () => [row],
      fetchCost: async (input) => new Promise((resolve) => {
        input.signal.addEventListener("abort", () => resolve({
          status: "retryable",
          failureCode: "receipt_service_unavailable",
        }), { once: true });
        resolveReading();
      }),
      settle: async () => { writes++; return true; },
    });
    recovery.wake();
    await reading;
    await recovery.stop();
    expect(writes).toBe(0);
  });

  test("wakes blocked server receipts once at startup and once per changed current key", async () => {
    let currentKey: string | null = key;
    const requeues: string[] = [];
    const recovery = createRecovery({
      resolveServerCredential: () => currentKey,
      requeueBlockedServer: async () => {
        requeues.push(currentKey ?? "missing");
        return 0;
      },
      list: async () => [],
    });

    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    currentKey = "replacement-key";
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    currentKey = null;
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    currentKey = "replacement-key";
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();

    expect(requeues).toEqual([key, "replacement-key", "replacement-key"]);
  });

  test("server replacement must prove its exact receipt before settlement", async () => {
    for (const outcome of ["settled", "blocked_repair", "retryable"] as const) {
      let reads = 0;
      const writes: unknown[] = [];
      const classifications: unknown[] = [];
      const recovery = createRecovery({
        list: async () => [row],
        resolveCredential: () => available("replacement-key"),
        fetchCost: async () => {
          reads++;
          return outcome === "settled" ? { status: outcome, costMicro: 283 }
            : outcome === "blocked_repair" ? { status: outcome, failureCode: "receipt_read_unauthorized" }
            : { status: outcome, failureCode: "receipt_not_found" };
        },
        settle: async (input) => { writes.push(input); return true; },
        classify: async (input) => { classifications.push(input); return true; },
      });
      recovery.wake();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await recovery.stop();
      expect(reads).toBe(1);
      expect(writes).toHaveLength(outcome === "settled" ? 1 : 0);
      if (outcome === "retryable") expect(classifications[0]).toMatchObject({
        recoveryState: "blocked_repair",
        failureCode: "receipt_account_unproven",
      });
    }
  });
});

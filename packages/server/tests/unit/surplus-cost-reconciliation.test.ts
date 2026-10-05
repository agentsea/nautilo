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

describe("Surplus automatic financial recovery", () => {
  test("restart uses durable request binding and settles the same row once", async () => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const seen: unknown[] = [];
    let remaining = true;
    const recovery = createSurplusCostRecovery({
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
    const recovery = createSurplusCostRecovery({
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

  test("classifies unbound and rotated credentials without guessing zero", async () => {
    let reads = 0;
    let writes = 0;
    const classifications: unknown[] = [];
    const recovery = createSurplusCostRecovery({
      resolveCredential: () => available("rotated-key"),
      list: async () => [row, { ...row, providerRequestId: null }, { ...row, metadata: null }],
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
    const recovery = createSurplusCostRecovery({
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
    const recovery = createSurplusCostRecovery({
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
    const recovery = createSurplusCostRecovery({
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
});

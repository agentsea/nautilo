import { describe, expect, test } from "bun:test";
import type { SurplusPendingAttempt } from "@nautilo/db";
import { surplusCredentialFingerprint } from "@nautilo/agent";
import { createSurplusCostRecovery } from "../../src/lib/surplus-cost-reconciliation";

const key = "synthetic-surplus-key";
const row: SurplusPendingAttempt = {
  id: "11111111-1111-4111-8111-111111111111", occurredAt: new Date(0), updatedAt: new Date(1),
  userId: null, roomId: null, taskId: null, callType: "capability_probe", provider: "venice",
  model: "venice:openai-gpt-55", providerRequestId: "request-1", endpoint: "/v1/chat/completions",
  servingProvider: "venice", attemptOutcome: "cancelled", costState: "pending", fundingKind: "service",
  metadata: {
    surplusModelId: "gpt-5.5", surplusProviderPin: "venice", surplusCredentialFingerprint: surplusCredentialFingerprint(key),
  },
};

describe("Surplus automatic financial recovery", () => {
  test("restart uses durable request binding and settles the same row once", async () => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const seen: unknown[] = [];
    let remaining = true;
    const recovery = createSurplusCostRecovery({
      now: () => 120_000, resolveKey: () => key,
      list: async () => remaining ? [row] : [],
      fetchCost: async (input) => {
        expect(input.binding).toEqual({ requestId: "request-1", surplusModelId: "gpt-5.5", providerPin: "venice" });
        return 283;
      },
      settle: async (input) => { seen.push(input); remaining = false; resolveSettled(); return true; },
    });
    recovery.start();
    await settled;
    await recovery.stop();
    recovery.wake();
    expect(seen).toEqual([{
      attemptId: row.id, providerRequestId: "request-1", expectedUpdatedAt: row.updatedAt, actualCostUsd: 0.000283,
    }]);
  });

  test("skips unbound/rotated credentials and missing request ids without guessing zero", async () => {
    let reads = 0;
    let writes = 0;
    const recovery = createSurplusCostRecovery({
      resolveKey: () => "rotated-key",
      list: async () => [row, { ...row, providerRequestId: null }, { ...row, metadata: null }],
      fetchCost: async () => { reads++; return 0; },
      settle: async () => { writes++; return true; },
    });
    recovery.wake();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await recovery.stop();
    expect(reads).toBe(0);
    expect(writes).toBe(0);
  });

  test("an unresolved page cannot starve a later receipt", async () => {
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const firstPage = Array.from({ length: 100 }, (_, index) => ({ ...row, id: String(index), providerRequestId: null }));
    let lists = 0;
    const recovery = createSurplusCostRecovery({
      resolveKey: () => key,
      list: async (input) => {
        lists++;
        if (!input.after) return firstPage;
        expect(input.after).toEqual({ updatedAt: row.updatedAt, id: "99" });
        return [row];
      },
      fetchCost: async () => 0,
      settle: async (input) => { expect(input.actualCostUsd).toBe(0); resolveSettled(); return true; },
    });
    recovery.wake();
    await settled;
    await recovery.stop();
    expect(lists).toBe(2);
  });

  test("shutdown cancels an active request-detail read and never settles afterward", async () => {
    let resolveReading!: () => void;
    const reading = new Promise<void>((resolve) => { resolveReading = resolve; });
    let writes = 0;
    const recovery = createSurplusCostRecovery({
      resolveKey: () => key, list: async () => [row],
      fetchCost: async (input) => new Promise<number | null>((resolve) => {
        input.signal.addEventListener("abort", () => resolve(null), { once: true });
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

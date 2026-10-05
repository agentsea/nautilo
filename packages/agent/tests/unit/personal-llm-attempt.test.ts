import { describe, expect, test } from "bun:test";
import { runPersonalLlmAttempt, PersonalAttemptLedgerUnavailableError } from "../../src/usage/personal-llm-attempt";
import { getUsageContext, runWithUsageContext } from "../../src/usage/usage-context";
import type { BeginPersonalLlmAttemptInput, SettlePersonalLlmAttemptInput } from "@nautilo/db";

const funding = { kind: "personal" as const, humanUserId: "10000000-0000-4000-8000-000000000001",
  payerHumanId: "10000000-0000-4000-8000-000000000001", providerRoute: "openai",
  credentialId: "20000000-0000-4000-8000-000000000002", credentialRevision: 4 };
function harness() {
  const begun: BeginPersonalLlmAttemptInput[] = [];
  const settled: SettlePersonalLlmAttemptInput[] = [];
  return { begun, settled, deps: { begin: async (row: BeginPersonalLlmAttemptInput) => { begun.push(row); },
    settle: async (row: SettlePersonalLlmAttemptInput) => { settled.push(row); } } };
}
const scope = <T>(fn: () => T) => runWithUsageContext({ callType: "chat", funding, metadata: { turnId: "synthetic-turn" } }, fn);
const modelId = "openai:gpt-5.6-luna";

describe("durable personal direct attempts", () => {
  test("begins before the wire and settles one frozen estimate from callback evidence", async () => {
    const h = harness();
    const answer = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => {
      expect(h.begun).toHaveLength(1);
      expect(h.begun[0]).toMatchObject({ userId: funding.humanUserId, credentialRevision: 4, providerRoute: "openai" });
      const context = getUsageContext()!;
      expect(context.trackedAttemptId).toBe(h.begun[0]!.id);
      context.onAttemptUsage!({ inputTokens: 100, outputTokens: 20, reasoningTokens: 0, cachedInputTokens: 0,
        cacheCreationTokens: 0, actualCostUsd: null });
      return "answer";
    } }, h.deps));
    expect(answer).toBe("answer");
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ attemptId: h.begun[0]!.id, outcome: "succeeded", costState: "estimated", inputTokens: 100 });
    expect(h.settled[0]!.estimatedCostUsd).toBeGreaterThan(0);
    expect(h.settled[0]!.pricingVersion).toBeTruthy();
  });
  test("a successful answer without usage remains unknown instead of zero", async () => {
    const h = harness();
    await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => "answer" }, h.deps));
    expect(h.settled[0]).toMatchObject({ outcome: "succeeded", costState: "unknown" });
    expect(h.settled[0]!.actualCostUsd).toBeUndefined();
    expect(h.settled[0]!.estimatedCostUsd).toBeUndefined();
  });
  test("observed provider zero cost is actual evidence", async () => {
    const h = harness();
    await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => {
      getUsageContext()!.onAttemptUsage!({ inputTokens: 1, outputTokens: 1, reasoningTokens: 0,
        cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0 }); return "answer";
    } }, h.deps));
    expect(h.settled[0]).toMatchObject({ costState: "actual", actualCostUsd: 0 });
  });
  test("late usage settles financial evidence without changing the cancelled outcome", async () => {
    const h = harness();
    const cancellation = new AbortController();
    let callback: NonNullable<ReturnType<typeof getUsageContext>>["onAttemptUsage"];
    try {
      await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", signal: cancellation.signal,
        invoke: async () => {
          callback = getUsageContext()!.onAttemptUsage;
          cancellation.abort();
          throw new Error("cancelled");
        } }, h.deps));
    } catch { /* The cancelled inference must stay cancelled. */ }
    expect(h.settled[0]).toMatchObject({ outcome: "cancelled", costState: "unknown" });
    callback!({ inputTokens: 10, outputTokens: 3, reasoningTokens: 0,
      cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0.001 });
    expect(h.settled[1]).toMatchObject({ attemptId: h.begun[0]!.id,
      outcome: "cancelled", costState: "actual", actualCostUsd: 0.001, preserveOutcome: true });
    await Promise.resolve();
    callback!({ inputTokens: 10, outputTokens: 3, reasoningTokens: 0,
      cachedInputTokens: 0, cacheCreationTokens: 0, actualCostUsd: 0.001 });
    expect(h.settled).toHaveLength(2);
  });
  test("a cancelled or failed wire still has the original payer record", async () => {
    const h = harness(); const cancellation = new AbortController();
    expect(scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", signal: cancellation.signal,
      invoke: async () => { cancellation.abort(); throw new Error("cancelled"); } }, h.deps))).rejects.toThrow("cancelled");
    expect(h.begun[0]).toMatchObject({ userId: funding.humanUserId, credentialId: funding.credentialId });
    expect(h.settled[0]).toMatchObject({ outcome: "cancelled", costState: "unknown" });
  });
  test("ledger admission failure prevents paid work; post-answer settlement failure never repeats it", async () => {
    let calls = 0;
    expect(scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => { calls++; } },
      { begin: async () => { throw new Error("database unavailable"); }, settle: async () => {} }))).rejects.toBeInstanceOf(PersonalAttemptLedgerUnavailableError);
    expect(calls).toBe(0);
    const h = harness();
    const answer = await scope(() => runPersonalLlmAttempt({ modelId, endpoint: "/v1/chat/completions", invoke: async () => { calls++; return "answer"; } },
      { ...h.deps, settle: async () => { throw new Error("settlement unavailable"); } }));
    expect(answer).toBe("answer"); expect(calls).toBe(1); expect(h.begun).toHaveLength(1);
  });
});

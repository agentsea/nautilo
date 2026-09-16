/**
 * ISSUE-M217 — recordLlmUsage pricing provenance + metadata merge.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const insertCalls: Array<Record<string, unknown>> = [];
const warnings: string[] = [];
let insertRejection: Error | null = null;

mock.module("@nautilo/db", () => ({
  insertLlmUsageEvent: async (input: Record<string, unknown>) => {
    insertCalls.push(input);
    if (insertRejection) throw insertRejection;
  },
  getCachedServerModelConfigRow: () => null,
  kickServerModelConfigRefresh: () => {},
}));

mock.module("@nautilo/logger", () => ({
  warn: (message: string) => {
    warnings.push(message);
  },
  log: () => {},
  debug: () => {},
  setLogLevel: () => {},
}));

const { recordLlmUsage } = await import("../../src/usage/record-usage");

async function settleFireAndForget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("recordLlmUsage pricing provenance (ISSUE-M217)", () => {
  beforeEach(() => {
    insertCalls.length = 0;
    warnings.length = 0;
    insertRejection = null;
  });

  afterEach(async () => {
    await settleFireAndForget();
    insertRejection = null;
  });

  test("persists explicit pricing source without losing caller metadata", async () => {
    recordLlmUsage({
      model: "openai:gpt-5.6-terra",
      callType: "chat",
      inputTokens: 100,
      outputTokens: 20,
      metadata: { agentId: "agent-1", turnId: "turn-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(insertCalls).toHaveLength(1);
    const row = insertCalls[0]!;
    expect(row["metadata"]).toEqual({
      agentId: "agent-1",
      turnId: "turn-1",
      usagePricingSource: "explicit",
    });
    expect(row["actualCostUsd"]).toBeNull();
    expect(row["estimatedCostUsd"]).toBeGreaterThan(0);
  });

  test("provider actualCostUsd remains stored alongside pricing source", async () => {
    recordLlmUsage({
      model: "openrouter:some/unlisted-model",
      callType: "chat",
      inputTokens: 50,
      outputTokens: 10,
      actualCostUsd: 0.0099,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = insertCalls[0]!;
    expect(row["actualCostUsd"]).toBeCloseTo(0.0099, 8);
    expect((row["metadata"] as Record<string, unknown>)["usagePricingSource"]).toBe(
      "baseline_default",
    );
  });

  test("D462 — freezes canonical/effective Kimi serving metadata and selected-path cost", async () => {
    recordLlmUsage({
      model: "fireworks:accounts/fireworks/models/kimi-k3", callType: "chat", inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000,
      modelControl: {
        canonicalModelId: "fireworks:accounts/fireworks/models/kimi-k3", effectiveModelId: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
        requestedReasoningEffort: "off", effectiveReasoningEffort: "off", servingProfileId: "fast", servingSelector: "model-override:fireworks:accounts/fireworks/routers/kimi-k3-fast",
      },
    });
    await settleFireAndForget();
    expect(insertCalls[0]?.["model"]).toBe("fireworks:accounts/fireworks/models/kimi-k3");
    expect(insertCalls[0]?.["estimatedCostUsd"]).toBeCloseTo(22.95, 8);
    expect(insertCalls[0]?.["metadata"]).toEqual({
      usagePricingSource: "serving_profile", canonicalModelId: "fireworks:accounts/fireworks/models/kimi-k3", effectiveModelId: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
      requestedReasoningEffort: "off", effectiveReasoningEffort: "off", servingProfileId: "fast", servingSelector: "model-override:fireworks:accounts/fireworks/routers/kimi-k3-fast",
    });
  });

  test("passes null for blank room attribution and preserves a valid room id", async () => {
    recordLlmUsage({
      model: "openai:gpt-5.6-luna",
      callType: "subagent",
      roomId: "",
      inputTokens: 10,
      outputTokens: 2,
    });
    recordLlmUsage({
      model: "anthropic:claude-sonnet-4-6",
      callType: "subagent",
      roomId: "00000000-0000-0000-0000-000000000101",
      inputTokens: 10,
      outputTokens: 2,
    });
    await settleFireAndForget();

    expect(insertCalls).toHaveLength(2);
    expect(insertCalls.map((row) => row["roomId"])).toEqual([
      null,
      "00000000-0000-0000-0000-000000000101",
    ]);
  });

  test("image rows persist image_default source and imageCount metadata", async () => {
    recordLlmUsage({
      model: "unknown:image-model",
      callType: "image_gen",
      imageCount: 2,
      metadata: { requestId: "req-1" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const row = insertCalls[0]!;
    expect(row["metadata"]).toEqual({
      requestId: "req-1",
      usagePricingSource: "image_default",
      imageCount: 2,
    });
  });

  test("swallows insert rejection and emits one warning", async () => {
    insertRejection = new Error("database unavailable");

    expect(() =>
      recordLlmUsage({
        model: "openai:gpt-5.6-terra",
        callType: "chat",
        inputTokens: 100,
        outputTokens: 20,
      }),
    ).not.toThrow();
    await settleFireAndForget();

    expect(insertCalls).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "[nautilo/usage] failed to record LLM usage for openai:gpt-5.6-terra: database unavailable",
    );
  });
});

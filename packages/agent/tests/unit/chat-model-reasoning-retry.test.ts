import { describe, expect, test } from "bun:test";
import {
  messageImpliesThinkingConfigRejection,
  planChatModelInvokeRetry,
} from "../../src/utils/chat-model-invocation";
import { classifyError } from "../../src/utils/errors";
import {
  resolveModelAttemptPolicy,
  TEMPORARY_LEGACY_FIRST_PROGRESS_MS,
  TEMPORARY_LEGACY_REASONING_FIRST_PROGRESS_MS,
} from "../../src/utils/model-attempt-policy";

describe("thinking-config rejection (D331)", () => {
  test("messageImpliesThinkingConfigRejection matches thinking invalid_request wording", () => {
    expect(
      messageImpliesThinkingConfigRejection("Invalid request: thinking type is not supported"),
    ).toBe(true);
    expect(
      messageImpliesThinkingConfigRejection("budget_tokens must be at least 1024"),
    ).toBe(false);
    expect(messageImpliesThinkingConfigRejection("Rate limit exceeded")).toBe(false);
    expect(
      messageImpliesThinkingConfigRejection("Invalid request: unsupported reasoning_effort"),
    ).toBe(true);
  });

  test("planChatModelInvokeRetry retries same model once on thinking-config INVALID_REQUEST", () => {
    const err = new Error("Invalid request: unsupported thinking configuration") as Error & {
      status?: number;
    };
    err.status = 400;
    const classified = classifyError(err);
    expect(planChatModelInvokeRetry(classified, false)).toBe("retry_same_model_no_reasoning");
    expect(planChatModelInvokeRetry(classified, true)).toBe("fallback_or_throw");
  });

  test("planChatModelInvokeRetry does not retry unrelated INVALID_REQUEST", () => {
    const err = new Error("Invalid request: unknown tool name") as Error & { status?: number };
    err.status = 400;
    const classified = classifyError(err);
    expect(planChatModelInvokeRetry(classified, false)).toBe("fallback_or_throw");
  });
});

describe("reasoning-aware first-token timeout (D331)", () => {
  test("uses the longer first-token budget for reasoning-capable GPT models", () => {
    expect(resolveModelAttemptPolicy("openai:gpt-5.5-2026-04-23").firstProgressMs).toBe(
      TEMPORARY_LEGACY_REASONING_FIRST_PROGRESS_MS,
    );
  });

  test("uses the longer first-token budget for Kimi K3 on Fireworks and Venice", () => {
    for (const modelId of [
      "fireworks:accounts/fireworks/models/kimi-k3",
      "venice:kimi-k3",
    ]) {
      expect(resolveModelAttemptPolicy(modelId).firstProgressMs).toBe(
        TEMPORARY_LEGACY_REASONING_FIRST_PROGRESS_MS,
      );
    }
  });

  test("keeps the short first-token budget for non-reasoning models", () => {
    expect(resolveModelAttemptPolicy("openai:gpt-4.1-mini").firstProgressMs).toBe(
      TEMPORARY_LEGACY_FIRST_PROGRESS_MS,
    );
  });
});

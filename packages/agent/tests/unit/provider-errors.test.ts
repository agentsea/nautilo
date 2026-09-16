import { describe, expect, test } from "bun:test";
import {
  ProviderTimeoutError,
  isProviderTimeoutError,
  formatProviderError,
  DEFAULT_PROVIDER_TIMEOUT_MS,
} from "../../src/providers/errors";
import { classifyError } from "../../src/utils/errors";

describe("ProviderTimeoutError", () => {
  test("carries modelId and timeoutMs and is matched by isProviderTimeoutError", () => {
    const err = new ProviderTimeoutError("openai:gpt-5", 50);
    expect(err).toBeInstanceOf(Error);
    expect(err.modelId).toBe("openai:gpt-5");
    expect(err.timeoutMs).toBe(50);
    expect(err.code).toBe("NAUTILO_PROVIDER_TIMEOUT");
    expect(isProviderTimeoutError(err)).toBe(true);
    expect(isProviderTimeoutError(new Error("nope"))).toBe(false);
  });

  test("classifies as TIMEOUT and is retryable", () => {
    const err = new ProviderTimeoutError("anthropic:claude-4", 50);
    const classified = classifyError(err);
    expect(classified.category).toBe("TIMEOUT");
    expect(classified.retryable).toBe(true);
  });

  test("default timeout is 120s", () => {
    expect(DEFAULT_PROVIDER_TIMEOUT_MS).toBe(120_000);
  });
});

describe("formatProviderError", () => {
  test("logs local timeout diagnostics without arbitrary metadata or reasoning", () => {
    const error = new ProviderTimeoutError("openrouter:z-ai/glm-5.3", 180_000, {
      kind: "progress_idle_timeout", attemptId: "attempt-safe", elapsedMs: 720_000,
      partialState: true, visibleOutput: false, abortRequested: true, safeToFallback: true,
      policyProvenance: { untrusted: "DO_NOT_LOG_REASONING" },
    });
    const line = formatProviderError(error);
    expect(line).toContain("timeoutKind=progress_idle_timeout");
    expect(line).toContain("elapsedMs=720000");
    expect(line).toContain("partialState=true");
    expect(line).not.toContain("DO_NOT_LOG_REASONING");
  });
  test("extracts OpenAI-shape APIError fields", () => {
    const apiError = {
      status: 400,
      message: "400 \"Invalid request parameters\"",
      headers: {
        "x-request-id": "req_abc123",
        "set-cookie": "should-not-leak=1",
      },
      error: {
        type: "invalid_request_error",
        code: "model_not_found",
        param: "model",
        message: "Model 'venice:gemma-4' does not exist",
      },
    };
    const out = formatProviderError(apiError);
    expect(out).toContain("status=400");
    expect(out).toContain("type=invalid_request_error");
    expect(out).toContain("code=model_not_found");
    expect(out).toContain("param=model");
    expect(out).toContain("Model 'venice:gemma-4' does not exist");
    expect(out).toContain("x-request-id=req_abc123");
    expect(out).not.toContain("should-not-leak");
  });

  test("falls back gracefully on plain Error", () => {
    const out = formatProviderError(new Error("boom"));
    expect(out).toContain("boom");
  });

  test("handles null/undefined", () => {
    expect(formatProviderError(null)).toContain("unknown");
    expect(formatProviderError(undefined)).toContain("unknown");
  });

  test("handles strings and primitives", () => {
    expect(formatProviderError("oops")).toBe("oops");
    expect(formatProviderError(42)).toBe("42");
  });

  test("handles Anthropic-shape error", () => {
    const out = formatProviderError({
      status: 529,
      error: { type: "overloaded_error", message: "Anthropic is overloaded" },
      headers: { "anthropic-request-id": "req_xyz" },
    });
    expect(out).toContain("status=529");
    expect(out).toContain("type=overloaded_error");
    expect(out).toContain("Anthropic is overloaded");
    expect(out).toContain("anthropic-request-id=req_xyz");
  });

  test("preserves Headers-instance allowlisted entries only", () => {
    const headers = new Headers({
      "x-request-id": "rid",
      "retry-after": "10",
      authorization: "Bearer secret",
    });
    const out = formatProviderError({ status: 429, headers, message: "Too many requests" });
    expect(out).toContain("x-request-id=rid");
    expect(out).toContain("retry-after=10");
    expect(out).not.toContain("Bearer");
  });
});

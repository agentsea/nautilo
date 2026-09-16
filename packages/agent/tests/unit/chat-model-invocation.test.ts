import { describe, expect, test } from "bun:test";
import { classifyError } from "../../src/utils/errors";
import {
  shouldFallbackToNextModel,
  modelFallbackModeFromExactSelection,
  isStrictNoChain,
} from "../../src/utils/chat-model-invocation";

describe("shouldFallbackToNextModel", () => {
  test("rate limit and timeouts imply fallback", () => {
    expect(shouldFallbackToNextModel(classifyError({ status: 429 }))).toBe(true);
    expect(shouldFallbackToNextModel(classifyError(new Error("Model invocation timeout after 45000ms for x")))).toBe(true);
  });

  test("auth errors do not fallback", () => {
    expect(shouldFallbackToNextModel(classifyError({ status: 401 }))).toBe(false);
  });

  test("token limit implies fallback", () => {
    expect(shouldFallbackToNextModel(classifyError(new Error("context length exceeded")))).toBe(true);
  });

  test("generic invalid request does not fallback", () => {
    expect(shouldFallbackToNextModel(classifyError({ status: 400, message: "bad request" }))).toBe(false);
  });

  test("capability mismatch invalid request implies fallback", () => {
    expect(
      shouldFallbackToNextModel(
        classifyError(new Error("400 This model does not support image inputs")),
      ),
    ).toBe(true);
  });
});

// D429 Phase 4 — explicit fallback-mode representation. The conversion from
// the Phase-3 `exactModelSelection` job flag to `modelFallbackMode` is the
// single source of truth for strict / no-chain semantics; `taskRunExecutor`
// mirrors it (the runtime cannot import this helper through the package
// barrel, so the union `"agent_chain" | "none"` is duplicated there and kept
// in lock-step here).
describe("modelFallbackModeFromExactSelection / isStrictNoChain", () => {
  test("exact selection → strict no-chain mode", () => {
    expect(modelFallbackModeFromExactSelection(true)).toBe("none");
  });

  test("non-exact selection → agent_chain mode (default)", () => {
    expect(modelFallbackModeFromExactSelection(false)).toBe("agent_chain");
  });

  test("isStrictNoChain is true only for none", () => {
    expect(isStrictNoChain("none")).toBe(true);
    expect(isStrictNoChain("agent_chain")).toBe(false);
    // undefined (foreground callers that omit the field) stays on the chain.
    expect(isStrictNoChain(undefined)).toBe(false);
  });
});

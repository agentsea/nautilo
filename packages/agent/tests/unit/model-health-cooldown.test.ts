import { afterEach, describe, expect, test } from "bun:test";

import {
  clearHealthCache,
  isModelHealthy,
  markModelInvokeFailure,
  modelInvokeCooldownRemainingMs,
} from "../../src/utils/model-health";

describe("model invocation cooldown", () => {
  afterEach(() => clearHealthCache());

  test("exposes the remaining cooldown and permits one probe after expiry", () => {
    const modelId = "test:reflection-model";
    markModelInvokeFailure(modelId, "fixed-test-failure");
    const markedAt = Date.now();

    const remaining = modelInvokeCooldownRemainingMs(modelId, markedAt);
    expect(remaining).toBeGreaterThan(89_000);
    expect(remaining).toBeLessThanOrEqual(90_000);
    expect(isModelHealthy(modelId)).toBe(false);

    expect(modelInvokeCooldownRemainingMs(modelId, markedAt + 100_000)).toBe(0);
  });
});

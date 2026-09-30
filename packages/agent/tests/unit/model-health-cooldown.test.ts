import { afterEach, describe, expect, test } from "bun:test";

import {
  checkModelHealth,
  clearHealthCache,
  isModelHealthy,
  markModelInvokeFailure,
  modelInvokeCooldownRemainingMs,
  type PersonalModelHealthScope,
} from "../../src/utils/model-health";

const PERSONAL_A: PersonalModelHealthScope = {
  kind: "personal",
  humanUserId: "human-a",
  credentialId: "credential-a",
  credentialRevision: 1,
};

const PERSONAL_B: PersonalModelHealthScope = {
  kind: "personal",
  humanUserId: "human-b",
  credentialId: "credential-b",
  credentialRevision: 4,
};

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

  test("a personal failure does not affect another Human or the server lane", () => {
    const modelId = "openai:shared-model";

    markModelInvokeFailure(modelId, "personal-a-failure", PERSONAL_A);

    expect(isModelHealthy(modelId, PERSONAL_A)).toBe(true);
    expect(isModelHealthy(modelId, PERSONAL_B)).toBe(true);
    expect(isModelHealthy(modelId)).toBe(true);
    expect(modelInvokeCooldownRemainingMs(modelId, Date.now(), PERSONAL_A)).toBe(0);
    expect(modelInvokeCooldownRemainingMs(modelId, Date.now(), PERSONAL_B)).toBe(0);
    expect(modelInvokeCooldownRemainingMs(modelId)).toBe(0);
  });

  test("a server failure does not spill into either personal lane", () => {
    const modelId = "anthropic:shared-model";

    markModelInvokeFailure(modelId, "server-failure");

    expect(isModelHealthy(modelId)).toBe(false);
    expect(modelInvokeCooldownRemainingMs(modelId)).toBeGreaterThan(0);
    expect(isModelHealthy(modelId, PERSONAL_A)).toBe(true);
    expect(isModelHealthy(modelId, PERSONAL_B)).toBe(true);
    expect(modelInvokeCooldownRemainingMs(modelId, Date.now(), PERSONAL_A)).toBe(0);
    expect(modelInvokeCooldownRemainingMs(modelId, Date.now(), PERSONAL_B)).toBe(0);

    markModelInvokeFailure(modelId, "personal-b-failure", PERSONAL_B);
    expect(isModelHealthy(modelId)).toBe(false);
    expect(modelInvokeCooldownRemainingMs(modelId)).toBeGreaterThan(0);
  });

  test("personal health reads never launch a server-funded probe", async () => {
    const modelId = "personal-only:uncatalogued-model";

    expect(await checkModelHealth(modelId, true, PERSONAL_A)).toBe(true);
    expect(isModelHealthy(modelId)).toBe(true);
    expect(modelInvokeCooldownRemainingMs(modelId)).toBe(0);
  });

  test("clearing a personal scope cannot erase the server cooldown", () => {
    const modelId = "google:shared-model";
    markModelInvokeFailure(modelId, "server-failure");

    clearHealthCache(PERSONAL_A);

    expect(isModelHealthy(modelId)).toBe(false);
    expect(isModelHealthy(modelId, PERSONAL_A)).toBe(true);
  });
});

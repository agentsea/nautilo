import { describe, expect, test } from "bun:test";
import { createFireworks } from "../../src/providers/factory";
import {
  FIREWORKS_KIMI_K3_FAST_ROUTER_ID,
  FIREWORKS_KIMI_K3_MODEL_ID,
  resolveFireworksKimiK3ServingProfile,
} from "../../src/providers/serving-profile";
import { createUniversalModel } from "../../src/providers/universal";

function fields(llm: unknown): Record<string, unknown> {
  return llm as Record<string, unknown>;
}

function modelKwargs(llm: unknown): Record<string, unknown> {
  return (fields(llm)["modelKwargs"] ?? {}) as Record<string, unknown>;
}

function invocationParams(llm: unknown): Record<string, unknown> {
  const invocationParams = fields(llm)["invocationParams"];
  if (typeof invocationParams !== "function") {
    throw new Error("Expected Fireworks model to expose invocationParams");
  }
  return invocationParams.call(llm, {}) as Record<string, unknown>;
}

describe("closed Fireworks Kimi K3 serving resolution", () => {
  test.each([
    ["standard", FIREWORKS_KIMI_K3_MODEL_ID, undefined],
    ["priority", FIREWORKS_KIMI_K3_MODEL_ID, { service_tier: "priority" }],
    ["fast", FIREWORKS_KIMI_K3_FAST_ROUTER_ID, undefined],
  ] as const)("resolves %s to only its reviewed Fireworks shape", (profileId, effectiveModelId, requestModelKwargs) => {
    expect(resolveFireworksKimiK3ServingProfile(FIREWORKS_KIMI_K3_MODEL_ID, profileId)).toEqual({
      canonicalModelId: FIREWORKS_KIMI_K3_MODEL_ID,
      effectiveModelId,
      profileId,
      ...(requestModelKwargs === undefined ? {} : { requestModelKwargs }),
    });
  });

  test.each([
    ["malicious selector", FIREWORKS_KIMI_K3_MODEL_ID, "../../other-provider"],
    ["stale profile", FIREWORKS_KIMI_K3_MODEL_ID, "turbo"],
    ["cross-model profile", "fireworks:accounts/fireworks/models/glm-5p3", "fast"],
  ])("rejects %s before constructing a provider request", (_name, modelId, profileId) => {
    expect(() => resolveFireworksKimiK3ServingProfile(modelId, profileId)).toThrow();
  });

  test("Standard emits no selector", async () => {
    const llm = await createFireworks({
      modelId: FIREWORKS_KIMI_K3_MODEL_ID,
      apiKey: "test-key",
      maxTokens: 8192,
      fireworksServingProfileId: "standard",
    });
    expect(fields(llm)["model"]).toBe("accounts/fireworks/models/kimi-k3");
    expect(modelKwargs(llm)["service_tier"]).toBeUndefined();
  });

  test("Priority emits exactly service_tier: priority", async () => {
    const llm = await createFireworks({
      modelId: FIREWORKS_KIMI_K3_MODEL_ID,
      apiKey: "test-key",
      maxTokens: 8192,
      fireworksServingProfileId: "priority",
    });
    expect(fields(llm)["model"]).toBe("accounts/fireworks/models/kimi-k3");
    expect(modelKwargs(llm)).toEqual({ service_tier: "priority" });
  });

  test("Fast invokes the verified router while retaining the resolver's canonical base identity", async () => {
    const llm = await createFireworks({
      modelId: FIREWORKS_KIMI_K3_MODEL_ID,
      apiKey: "test-key",
      maxTokens: 8192,
      fireworksServingProfileId: "fast",
    });
    expect(fields(llm)["model"]).toBe("accounts/fireworks/routers/kimi-k3-fast");
    expect(modelKwargs(llm)["service_tier"]).toBeUndefined();
  });

  test.each(["standard", "priority", "fast"] as const)(
    "%s streaming requests include the Fireworks usage trailer",
    async (fireworksServingProfileId) => {
      const llm = await createFireworks({
        modelId: FIREWORKS_KIMI_K3_MODEL_ID,
        apiKey: "test-key",
        maxTokens: 8192,
        fireworksServingProfileId,
      });

      expect(fields(llm)["streamUsage"]).toBe(true);
      expect(invocationParams(llm)).toMatchObject({
        stream: true,
        stream_options: { include_usage: true },
      });
      // The corrective adapter remains ChatFireworks, whose request boundary
      // strips parameters Fireworks does not support.
      expect((fields(llm)["_llmType"] as (() => string)).call(llm)).toBe("fireworks");
    },
  );

  test("universal input rejects a stale or cross-model profile rather than forwarding raw serving state", async () => {
    for (const [modelId, servingProfileId, message] of [
      [FIREWORKS_KIMI_K3_MODEL_ID, "unreviewed-route", "Unsupported Fireworks Kimi K3 serving profile"],
      ["fireworks:accounts/fireworks/models/glm-5p3", "fast", "Serving profiles are not available"],
    ] as const) {
      try {
        await createUniversalModel(modelId, { apiKey: "test-key", servingProfileId });
        throw new Error("Expected invalid serving profile to reject");
      } catch (error) {
        expect(error).toHaveProperty("message", expect.stringContaining(message));
      }
    }
  });
});

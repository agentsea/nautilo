import { describe, expect, test } from "bun:test";
import { createUniversalModel } from "../../src/providers/universal";

const MODEL = "fireworks:accounts/fireworks/models/deepseek-v4p1-flash";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";

function defaultHeaders(model: unknown): Record<string, string> | undefined {
  return (model as { clientConfig?: { defaultHeaders?: Record<string, string> } })
    .clientConfig?.defaultHeaders;
}

describe("Fireworks cache affinity", () => {
  test("projects only a valid opaque Room UUID as x-session-affinity", async () => {
    const model = await createUniversalModel(MODEL, {
      apiKey: "test-key",
      maxTokens: 8192,
      fireworksSessionAffinityId: ROOM_ID,
    });

    expect(defaultHeaders(model)).toEqual({ "x-session-affinity": ROOM_ID });
  });

  test("omits mutable or invalid affinity content", async () => {
    const model = await createUniversalModel(MODEL, {
      apiKey: "test-key",
      maxTokens: 8192,
      fireworksSessionAffinityId: "Room title or mutable content",
    });

    expect(defaultHeaders(model)).toBeUndefined();
  });

  test("does not widen the Fireworks option onto another provider", async () => {
    const model = await createUniversalModel("openai:gpt-5.6-luna", {
      apiKey: "test-key",
      maxTokens: 8192,
      fireworksSessionAffinityId: ROOM_ID,
    });

    expect(defaultHeaders(model)).toBeUndefined();
  });
});

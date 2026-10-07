import { describe, expect, test } from "bun:test";
import { orderProviderKeys } from "./provider-key-display";

describe("orderProviderKeys", () => {
  test("uses the Server Admin order and preserves registry order for fallback providers", () => {
    const providers = [
      { id: "anthropic" },
      { id: "tavily" },
      { id: "openai" },
      { id: "xai" },
      { id: "gateway" },
      { id: "nautilo-gateway" },
      { id: "custom" },
      { id: "surplus" },
      { id: "openrouter" },
      { id: "venice" },
    ];

    expect(orderProviderKeys(providers).map(({ id }) => id)).toEqual([
      "venice",
      "openrouter",
      "surplus",
      "openai",
      "anthropic",
      "tavily",
      "xai",
      "custom",
      "gateway",
      "nautilo-gateway",
    ]);
    expect(providers.map(({ id }) => id)).toEqual([
      "anthropic",
      "tavily",
      "openai",
      "xai",
      "gateway",
      "nautilo-gateway",
      "custom",
      "surplus",
      "openrouter",
      "venice",
    ]);
  });
});

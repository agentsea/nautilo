import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createUniversalModel } from "../../src/providers/universal";
import { resetRuntimeModelCatalog } from "../../src/config/model-catalog/runtime-catalog";
import { activateModelCatalogForTests } from "../helpers/activate-model-catalog";

const MODEL_ID = "openai:gpt-5.6-luna";
const OPENROUTER_MODEL_ID = "openrouter:minimax/minimax-m3";
beforeAll(async () => activateModelCatalogForTests([MODEL_ID, OPENROUTER_MODEL_ID]));
afterAll(() => resetRuntimeModelCatalog());

describe("explicit provider retry ownership", () => {
  test("a service-owned attempt can disable SDK retries without changing the wire", async () => {
    const model = await createUniversalModel(MODEL_ID, { apiKey: "synthetic-service-key", maxRetries: 0 });
    const sdk = model as unknown as { caller: { maxRetries: number }; modelKwargs?: Record<string, unknown> };
    expect(sdk.caller.maxRetries).toBe(0);
    expect(sdk.modelKwargs).not.toHaveProperty("maxRetries");
  });

  test("invalid retry counts fail before constructing a provider", async () => {
    for (const maxRetries of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
      await Promise.resolve(expect(createUniversalModel(MODEL_ID, { apiKey: "synthetic-service-key", maxRetries }))
        .rejects.toThrow("Provider retry count must be a nonnegative integer."));
    }
  });

  test("OpenRouter preserves explicit retry ownership through its separate factory options", async () => {
    const model = await createUniversalModel(OPENROUTER_MODEL_ID, {
      apiKey: "synthetic-service-key", maxRetries: 0,
    });
    const sdk = model as unknown as { caller: { maxRetries: number }; modelKwargs?: Record<string, unknown> };
    expect(sdk.caller.maxRetries).toBe(0);
    expect(sdk.modelKwargs).not.toHaveProperty("maxRetries");
  });

  test("a caller cannot restore SDK retries for an admitted personal credential", async () => {
    const model = await createUniversalModel(MODEL_ID, {
      personalCredential: { apiKey: "synthetic-personal-key" }, maxRetries: 3,
    });
    expect((model as unknown as { caller: { maxRetries: number } }).caller.maxRetries).toBe(0);
  });
});

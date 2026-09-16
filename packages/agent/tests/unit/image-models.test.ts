import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDefaultImageModel, getImageModel } from "../../src/config/image-models";

describe("catalog-owned image models (D113)", () => {
  const prevEnv = process.env["NAUTILO_IMAGE_MODEL"];
  const prevVenice = process.env["VENICE_API_KEY"];
  const prevSkipRefresh = process.env["NAUTILO_SKIP_VENICE_REFRESH"];

  beforeEach(() => {
    process.env["NAUTILO_SKIP_VENICE_REFRESH"] = "1";
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env["NAUTILO_IMAGE_MODEL"];
    else process.env["NAUTILO_IMAGE_MODEL"] = prevEnv;
    if (prevVenice === undefined) delete process.env["VENICE_API_KEY"];
    else process.env["VENICE_API_KEY"] = prevVenice;
    if (prevSkipRefresh === undefined) delete process.env["NAUTILO_SKIP_VENICE_REFRESH"];
    else process.env["NAUTILO_SKIP_VENICE_REFRESH"] = prevSkipRefresh;
  });

  test("every released image row resolves without a private model allowlist", () => {
    expect(getImageModel("venice:seedream-v5-pro", { VENICE_API_KEY: "vk" })).toMatchObject({
      id: "venice:seedream-v5-pro",
      apiModel: "seedream-v5-pro",
      provider: "venice",
      enabled: true,
    });
    expect(getImageModel("venice:grok-imagine-image-quality", { VENICE_API_KEY: "vk" })).toBeDefined();
    expect(getImageModel("venice:gpt-image-2", { VENICE_API_KEY: "vk" })).toBeDefined();
  });

  test("default selection intersects policy with selectable catalog rows", () => {
    expect(getDefaultImageModel({ VENICE_API_KEY: "vk" }).id).toBe("venice:gpt-image-2");
  });

  test("does not resolve non-image or unknown catalog ids", () => {
    expect(getImageModel("venice:claude-sonnet-4-6", { VENICE_API_KEY: "vk" })).toBeUndefined();
    expect(getImageModel("venice:not-real", { VENICE_API_KEY: "vk" })).toBeUndefined();
  });

  test("an explicit route without its provider credential is not silently substituted", () => {
    process.env["NAUTILO_IMAGE_MODEL"] = "venice:seedream-v5-pro";
    delete process.env["VENICE_API_KEY"];
    expect(() => getDefaultImageModel()).toThrow("Venice credential is not configured");
  });
});

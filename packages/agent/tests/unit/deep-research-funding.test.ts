import { expect, test } from "bun:test";
import type { Configuration } from "../../src/subagents/deep-research/shared/config";

const { createModel } = await import("../../src/subagents/deep-research/providers/router");
const { buildSearchTool } = await import("../../src/subagents/deep-research/search/factory");

const configuration = {
  search_api: "tavily",
  search_max_results: 5,
  search_depth: "basic",
  anthropic_long_context_beta: false,
  base_url_overrides: null,
} as Configuration;

test("deep research denies model creation when the initiating Human is missing", async () => {
  const denial = await createModel("openai:test", configuration)
    .catch((error: unknown) => error);
  expect(denial).toMatchObject({
    code: "server_provider_credentials_required",
    humanUserId: "",
  });
});

test("deep research denies Tavily before constructing or invoking the provider when identity is missing", async () => {
  const denial = await buildSearchTool(configuration)("must not spend")
    .catch((error: unknown) => error);
  expect(denial).toMatchObject({
    code: "server_provider_credentials_required",
    humanUserId: "",
  });
});
